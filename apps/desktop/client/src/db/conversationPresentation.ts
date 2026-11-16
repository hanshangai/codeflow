import { randomUUID } from "node:crypto";
import {
  applyEngineEventToConversation, buildThreadPresentation, createConversationItemStub, createConversationState,
  getConversationProcessGroups, restoreConversationState, snapshotConversationState,
} from "@codeflowai/shared";
import type { ConversationEventEnvelope, ConversationItem, ConversationStateSnapshot, ThreadId, ThreadPresentation, ThreadProcessDetails } from "@codeflowai/shared";
import type { SqliteDb } from "./sqliteTypes.js";

const PRESENTATION_SCHEMA_VERSION = 2;
type ProjectionRow = { version: number; ready: number; state_json: string; schema_version: number; build_id: string };
type ItemRow = { item_id: string; position: number; stub_json: string; updated_seq: number; process_id: string | null };
export type ProcessReadOptions = { afterSeq?: number; cursor?: string; throughSeq?: number; limit?: number };

/** 由既有 schema owner 原子补齐旧索引结构并失效缓存；读取入口绝不建表。 */
export function createConversationPresentationTables(db: SqliteDb): void {
  const marker = db.prepare("SELECT value FROM meta WHERE key = 'conversation_presentation_schema_version'").get() as { value: string } | undefined;
  if (marker) {
    if (marker.value !== "1" && marker.value !== String(PRESENTATION_SCHEMA_VERSION)) throw new Error("THREAD_PRESENTATION_SCHEMA_UNSUPPORTED");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_presentations', 'conversation_presentation_items')").all();
    if (tables.length !== 2) throw new Error("THREAD_PRESENTATION_SCHEMA_INVALID");
    if (marker.value === "1") db.transaction(() => {
      const columns = db.prepare("PRAGMA table_info(conversation_presentations)").all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === "build_id")) {
        db.exec("ALTER TABLE conversation_presentations ADD COLUMN build_id TEXT NOT NULL DEFAULT ''");
      }
      db.prepare("UPDATE conversation_presentations SET ready = 0, build_id = '', presentation_json = '{}'").run();
      db.prepare("UPDATE meta SET value = ? WHERE key = 'conversation_presentation_schema_version'").run(String(PRESENTATION_SCHEMA_VERSION));
    })();
    return;
  }
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_presentations (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0, 1)), schema_version INTEGER NOT NULL, build_id TEXT NOT NULL,
    state_json TEXT NOT NULL, presentation_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_presentation_items (
    thread_id TEXT NOT NULL REFERENCES conversation_presentations(thread_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL, position INTEGER NOT NULL, created_seq INTEGER NOT NULL, updated_seq INTEGER NOT NULL,
    process_id TEXT NULL, stub_json TEXT NOT NULL, item_json TEXT NOT NULL,
    PRIMARY KEY(thread_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_presentation_process
    ON conversation_presentation_items(thread_id, process_id, position);`);
    db.prepare("INSERT INTO meta(key, value) VALUES ('conversation_presentation_schema_version', ?)").run(String(PRESENTATION_SCHEMA_VERSION));
  })();
}

/** canonical 的可重建展示投影；正文与摘要始终在所属事件事务内一起更新。 */
export class ConversationPresentationStore {
  /** 复用 canonical 所在的事务连接，不持有额外连接。 */
  constructor(private readonly db: SqliteDb) {}

  /** 只查结构和轻量标记，支持旧库先走明确写入构建。 */
  isReady(threadId: ThreadId): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_presentations'").get()) return false;
    const row = this.db.prepare("SELECT ready, schema_version FROM conversation_presentations WHERE thread_id = ?").get(threadId) as Pick<ProjectionRow, "ready" | "schema_version"> | undefined;
    return row?.ready === 1 && row.schema_version === PRESENTATION_SCHEMA_VERSION;
  }

  /** 新会话立即增量维护；旧会话留给分批构建，乱序 ACK 显式使旧投影失效。 */
  append(event: ConversationEventEnvelope, supersededItemIds: readonly string[] = []): void {
    const row = this.getRow(event.threadId);
    if (!row) {
      const previous = this.db.prepare("SELECT 1 FROM conversation_events WHERE thread_id = ? AND seq <> ? LIMIT 1").get(event.threadId, event.seq);
      if (previous) return;
      this.initialize(event.threadId, true);
    } else if (!row.ready) {
      if (event.seq <= row.version) this.invalidate(event.threadId);
      return;
    } else if (event.seq <= row.version) { this.invalidate(event.threadId); return; }
    this.apply(event, supersededItemIds);
  }

  /** 首次构建分批提交并让出事件循环；失败保留未就绪状态，绝不返回空历史。 */
  async rebuild(threadId: ThreadId, hydrate: (event: ConversationEventEnvelope) => ConversationEventEnvelope | null,
    supersededItems: (event: ConversationEventEnvelope) => readonly string[], opts?: { withDatabase?: <T>(operation: () => T) => Promise<T> }): Promise<void> {
    /** 每次让出后重新申请同步写入许可，不把整个重建包进数据库锁。 */
    const write = <T>(operation: () => T): Promise<T> => opts?.withDatabase ? opts.withDatabase(operation) : Promise.resolve(operation());
    if (await write(() => this.isReady(threadId))) return;
    const buildId = await write(() => this.db.transaction(() => { this.initialize(threadId, false); return this.getRow(threadId)!.build_id; })());
    let cursor = 0;
    while (true) {
      const count = await write(() => this.db.transaction(() => {
        if (this.getRow(threadId)?.build_id !== buildId) throw new Error("THREAD_PRESENTATION_BUILD_INVALIDATED");
        const thread = this.db.prepare("SELECT workspace_id, engine FROM threads WHERE id = ?").get(threadId) as { workspace_id: string; engine: string } | undefined;
        if (!thread) throw new Error("THREAD_PRESENTATION_THREAD_NOT_FOUND");
        const rows = this.db.prepare("SELECT seq, workspace_id, engine, event_json FROM conversation_events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT 256")
          .all(threadId, cursor) as Array<{ seq: number; workspace_id: string; engine: string; event_json: string }>;
        for (const row of rows) {
          const event = JSON.parse(row.event_json) as ConversationEventEnvelope;
          if (!event || event.schema !== 1 || event.threadId !== threadId || event.seq !== row.seq || !Number.isSafeInteger(event.seq)
            || event.seq <= 0 || event.workspaceId !== row.workspace_id || event.workspaceId !== thread.workspace_id
            || event.engine !== row.engine || event.engine !== thread.engine || !Number.isSafeInteger(event.ts) || event.ts < 0
            || typeof event.type !== "string" || !event.type || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
            throw new Error(`THREAD_PRESENTATION_EVENT_INVALID: threadId=${threadId}, seq=${row.seq}`);
          }
          const hydrated = hydrate(event);
          if (hydrated) this.apply(hydrated, supersededItems(hydrated));
          cursor = event.seq;
        }
        if (rows.length && this.getRow(threadId)!.version < cursor) {
          this.db.prepare("UPDATE conversation_presentations SET version = ? WHERE thread_id = ?").run(cursor, threadId);
        }
        if (!rows.length) this.db.prepare("UPDATE conversation_presentations SET ready = 1 WHERE thread_id = ?").run(threadId);
        return rows.length;
      })());
      if (!count) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  /** 首屏组合非过程正文与过程 stub，不查询 canonical 或过程正文。 */
  read(threadId: ThreadId): ThreadPresentation {
    const row = this.getRow(threadId);
    if (!row?.ready || row.schema_version !== PRESENTATION_SCHEMA_VERSION) throw new Error("THREAD_PRESENTATION_NOT_READY");
    const rows = this.db.prepare("SELECT item_id, stub_json, updated_seq FROM conversation_presentation_items WHERE thread_id = ? ORDER BY position")
      .all(threadId) as Array<Pick<ItemRow, "item_id" | "stub_json" | "updated_seq">>;
    const full = this.db.prepare("SELECT item_id, item_json FROM conversation_presentation_items WHERE thread_id = ? AND process_id IS NULL")
      .all(threadId) as Array<{ item_id: string; item_json: string }>;
    const messages = new Map(full.map(item => [item.item_id, item.item_json]));
    const items = rows.map(item => JSON.parse(messages.get(item.item_id) ?? item.stub_json) as ConversationItem);
    const state = restoreConversationState(JSON.parse(row.state_json) as ConversationStateSnapshot, items);
    return buildThreadPresentation(state, row.version, new Map(rows.map(item => [item.item_id, item.updated_seq])));
  }

  /** 按可见消息窗口读取快照；窗口外消息由 beforePosition 向前增量读取。 */
  readPage(threadId: ThreadId, options: { messageLimit: number; beforePosition?: number | null }): ThreadPresentation {
    const row = this.getRow(threadId);
    if (!row?.ready || row.schema_version !== PRESENTATION_SCHEMA_VERSION) throw new Error("THREAD_PRESENTATION_NOT_READY");
    const messageLimit = Math.max(1, Math.min(200, Math.floor(Number(options.messageLimit))));
    const beforePosition = Number(options.beforePosition ?? 0);
    const hasBefore = Number.isFinite(beforePosition) && beforePosition > 0;
    const boundaries = (hasBefore
      ? this.db.prepare(`SELECT position FROM conversation_presentation_items
          WHERE thread_id = ? AND process_id IS NULL AND position < ? ORDER BY position DESC LIMIT ?`)
        .all(threadId, beforePosition, messageLimit)
      : this.db.prepare(`SELECT position FROM conversation_presentation_items
          WHERE thread_id = ? AND process_id IS NULL ORDER BY position DESC LIMIT ?`)
        .all(threadId, messageLimit)) as Array<{ position: number }>;
    let oldestPosition = boundaries.length ? boundaries[boundaries.length - 1]!.position : null;
    const snapshot = JSON.parse(row.state_json) as ConversationStateSnapshot;
    if (oldestPosition === null) {
      // 只有过程条目或消息已全部删除时保持全量投影，避免展示成空会话。
      return { ...this.read(threadId), hasMoreOlder: false, oldestPosition: 0 };
    }
    const hasMoreOlder = Boolean(this.db.prepare(`SELECT 1 AS found FROM conversation_presentation_items
      WHERE thread_id = ? AND process_id IS NULL AND position < ? LIMIT 1`).get(threadId, oldestPosition));
    // 首屏已覆盖最早消息时把窗口扩展到全部条目，避免更早的过程批次不可达。
    if (!hasBefore && !hasMoreOlder) oldestPosition = 0;
    /** 增量窗口必须截止到旧游标，避免上一页重复返回当前已加载的条目。 */
    const upper = hasBefore ? " AND position < ?" : "";
    const windowArgs = hasBefore ? [String(threadId), oldestPosition, beforePosition] : [String(threadId), oldestPosition];
    const rows = this.db.prepare(`SELECT item_id, stub_json, updated_seq FROM conversation_presentation_items
      WHERE thread_id = ? AND position >= ?${upper} ORDER BY position`).all(...windowArgs) as Array<Pick<ItemRow, "item_id" | "stub_json" | "updated_seq">>;
    const full = this.db.prepare(`SELECT item_id, item_json FROM conversation_presentation_items
      WHERE thread_id = ? AND position >= ?${upper} AND process_id IS NULL`).all(...windowArgs) as Array<{ item_id: string; item_json: string }>;
    const messages = new Map(full.map(item => [item.item_id, item.item_json]));
    const items = rows.map(item => JSON.parse(messages.get(item.item_id) ?? item.stub_json) as ConversationItem);
    return { ...buildThreadPresentation(restoreConversationState(snapshot, items), row.version, new Map(rows.map(item => [item.item_id, item.updated_seq]))),
      hasMoreOlder, oldestPosition };
  }

  /** 按稳定成员位置分页；已被并发更新的快照可重复返回，调用方按 ID 替换并用 afterSeq 追上。 */
  readProcess(threadId: ThreadId, processId: string, options: ProcessReadOptions = {}): ThreadProcessDetails {
    const row = this.getRow(threadId);
    if (!row?.ready || row.schema_version !== PRESENTATION_SCHEMA_VERSION) throw new Error("THREAD_PRESENTATION_NOT_READY");
    if (!processId.startsWith("process:") || !processId.slice(8)) throw new Error("THREAD_PROCESS_ID_INVALID");
    const afterSeq = options.afterSeq ?? 0, version = options.throughSeq ?? row.version;
    const limit = options.limit ?? 100;
    if ((options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor || options.cursor.length > 512)) || !Number.isSafeInteger(afterSeq) || afterSeq < 0
      || !Number.isSafeInteger(version) || version < 0 || version > row.version || afterSeq > version || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("THREAD_PROCESS_PAGE_INVALID");
    }
    const exists = this.db.prepare("SELECT 1 FROM conversation_presentation_items WHERE thread_id = ? AND process_id = ? LIMIT 1").get(threadId, processId);
    if (!exists) throw new Error("THREAD_PROCESS_NOT_FOUND");
    const cursorRow = options.cursor === undefined ? undefined : this.db.prepare(`SELECT position FROM conversation_presentation_items
      WHERE thread_id = ? AND process_id = ? AND item_id = ? AND created_seq <= ?`).get(threadId, processId, options.cursor, version) as { position: number } | undefined;
    if (options.cursor !== undefined && !cursorRow) throw new Error("THREAD_PROCESS_CURSOR_INVALIDATED");
    const cursor = cursorRow?.position ?? -1;
    const rows = this.db.prepare(`SELECT item_json, item_id FROM conversation_presentation_items
      WHERE thread_id = ? AND process_id = ? AND position > ? AND created_seq <= ? AND updated_seq > ?
      ORDER BY position LIMIT ?`).all(threadId, processId, cursor, version, afterSeq, limit + 1) as Array<{ item_json: string; item_id: string }>;
    const hasMore = rows.length > limit, page = rows.slice(0, limit);
    const members = this.db.prepare("SELECT item_id FROM conversation_presentation_items WHERE thread_id = ? AND process_id = ? ORDER BY position")
      .all(threadId, processId) as Array<{ item_id: string }>;
    return { items: page.map(item => JSON.parse(item.item_json) as ConversationItem), version,
      itemOrder: members.map(member => member.item_id), nextCursor: hasMore ? page.at(-1)!.item_id : null, hasMore };
  }

  /** 裁剪事实后保留显式未就绪标记，下一次读取按剩余 canonical 重建。 */
  invalidate(threadId: ThreadId): void {
    this.db.prepare("UPDATE conversation_presentations SET ready = 0, build_id = '' WHERE thread_id = ?").run(threadId);
  }

  /** 清空线程投影，关联条目由本机 FK 一并清理。 */
  delete(threadId: ThreadId): void {
    this.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(threadId);
  }

  /** 初始化只含删除事实的空 reducer 状态，旧正文不得因重建恢复。 */
  private initialize(threadId: ThreadId, ready: boolean): void {
    this.delete(threadId);
    const state = createConversationState(threadId);
    const deletions = this.db.prepare("SELECT item_id FROM conversation_message_deletions WHERE thread_id = ?").all(threadId) as Array<{ item_id: string }>;
    state.deletedMessageIds = new Set(deletions.map(row => row.item_id));
    this.db.prepare(`INSERT INTO conversation_presentations(thread_id, version, ready, schema_version, build_id, state_json, presentation_json)
      VALUES (?, 0, ?, ?, ?, ?, ?)`).run(threadId, ready ? 1 : 0, PRESENTATION_SCHEMA_VERSION, randomUUID(),
        JSON.stringify(snapshotConversationState(state)), "{}");
  }

  /** 稳定增量只恢复目标，结构变化用历史分组元数据归并，终态恢复运行及待输入条目。 */
  private apply(event: ConversationEventEnvelope, supersededItemIds: readonly string[] = []): void {
    const row = this.getRow(event.threadId);
    if (!row) throw new Error("THREAD_PRESENTATION_ROW_MISSING");
    if (!supersededItemIds.length && this.applyStableDelta(event, row)) return;
    const rows = this.db.prepare(`SELECT item_id, position, stub_json, updated_seq, process_id
      FROM conversation_presentation_items WHERE thread_id = ? ORDER BY position`).all(event.threadId) as ItemRow[];
    const items = rows.map(item => JSON.parse(item.stub_json) as ConversationItem);
    const payload = event.payload as Record<string, any>;
    const targets = new Set<string>([String(payload.itemId ?? ""), `approval_${String(payload.requestId ?? "")}`]);
    if (event.type === "userInput.requested") targets.add(String(payload.request.params.itemId));
    if (event.type.startsWith("userInput.")) for (const item of items) if (item.kind === "userInputRequest") targets.add(String(item.id));
    if (event.type === "turn.completed" || event.type === "turn.error") {
      for (const item of items) if ((item.kind === "tool" && (item.status === "started" || item.status === "unknown"))
        || (item.kind === "subagent" && item.status === "running")
        || (item.kind === "userInputRequest" && item.state === "pending")) targets.add(String(item.id));
    }
    for (let index = 0; index < items.length; index++) if (targets.has(String(items[index]!.id))) {
      const full = this.db.prepare("SELECT item_json FROM conversation_presentation_items WHERE thread_id = ? AND item_id = ?")
        .get(event.threadId, String(items[index]!.id)) as { item_json: string };
      items[index] = JSON.parse(full.item_json) as ConversationItem;
    }
    const state = restoreConversationState(JSON.parse(row.state_json) as ConversationStateSnapshot, items);
    if (supersededItemIds.length) {
      const superseded = new Set(supersededItemIds);
      state.items = state.items.filter(item => item.kind !== "diff" || !superseded.has(String(item.id)));
      for (const id of superseded) state._indexById.delete(id);
    }
    applyEngineEventToConversation(state, event);
    const previous = new Map(rows.map(item => [item.item_id, item]));
    const currentIds = new Set(state.items.map(item => String(item.id)));
    for (const old of rows) if (!currentIds.has(old.item_id)) this.db.prepare("DELETE FROM conversation_presentation_items WHERE thread_id = ? AND item_id = ?").run(event.threadId, old.item_id);
    const processIds = new Map<string, string>();
    for (const group of getConversationProcessGroups(state.items)) for (const item of group.items) processIds.set(String(item.id), group.processId);
    const changedProcesses = new Set<string>();
    for (const old of rows) {
      const next = processIds.get(old.item_id) ?? null;
      if (old.process_id === next && currentIds.has(old.item_id)) continue;
      if (old.process_id) changedProcesses.add(old.process_id);
      if (next) changedProcesses.add(next);
    }
    for (const [position, item] of state.items.entries()) {
      const id = String(item.id), old = previous.get(id), processId = processIds.get(id) ?? null;
      const stub = this.createStoredStub(item), stubJson = JSON.stringify(stub);
      const hydrated = targets.has(id) || !old;
      if (hydrated && (!old || targets.has(id) || stubJson !== old.stub_json)) {
        this.db.prepare(`INSERT INTO conversation_presentation_items(thread_id, item_id, position, created_seq, updated_seq, process_id, stub_json, item_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, item_id) DO UPDATE SET
          position=excluded.position, updated_seq=excluded.updated_seq, process_id=excluded.process_id, stub_json=excluded.stub_json, item_json=excluded.item_json`)
          .run(event.threadId, id, position, event.seq, event.seq, processId, stubJson, JSON.stringify(item));
      } else if (old && (processId !== old.process_id || position !== old.position
        || (processId && (changedProcesses.has(processId) || event.type === "item.message.deleted")))) {
        this.db.prepare("UPDATE conversation_presentation_items SET position = ?, process_id = ?, updated_seq = ? WHERE thread_id = ? AND item_id = ?")
          .run(position, processId, event.seq, event.threadId, id);
      }
    }
    this.db.prepare("UPDATE conversation_presentations SET version = ?, state_json = ? WHERE thread_id = ?")
      .run(event.seq, JSON.stringify(snapshotConversationState(state)), event.threadId);
  }

  /** 已存在且归属稳定的增量只恢复目标；类型或过程归属变化仍经完整 reducer 修复。 */
  private applyStableDelta(event: ConversationEventEnvelope, row: ProjectionRow): boolean {
    const reasoning = event.type === "item.reasoning.delta" || event.type === "item.reasoning.summaryDelta"
      || event.type === "item.reasoning.summaryBoundary";
    const toolOutput = event.type === "item.tool.outputDelta";
    if (!reasoning && !toolOutput && event.type !== "item.agentMessage.delta") return false;
    const itemId = String((event.payload as { itemId?: string }).itemId ?? "");
    const stored = this.db.prepare(`SELECT item_id, position, stub_json, updated_seq, process_id, item_json
      FROM conversation_presentation_items WHERE thread_id = ? AND item_id = ?`).get(event.threadId, itemId) as (ItemRow & { item_json: string }) | undefined;
    if (!stored) return false;
    const item = JSON.parse(stored.item_json) as ConversationItem;
    if ((reasoning && item.kind !== "reasoning") || (toolOutput && item.kind !== "tool")
      || (!reasoning && !toolOutput && (item.kind !== "message" || item.role !== "assistant"))) return false;
    const previousStub = JSON.parse(stored.stub_json) as ConversationItem;
    if (!reasoning) {
      if (toolOutput) {
        if (item.kind !== "tool" || previousStub.kind !== "tool" || stored.process_id === null
          || (event.payload.toolName !== undefined && event.payload.toolName !== item.toolType)
          || !getConversationProcessGroups([item]).length) return false;
      } else if (stored.process_id !== null || previousStub.kind !== "message" || !previousStub.text) return false;
      // 正文和工具增量都删除全局推理占位；存在占位时须完整重算归属。
      if (this.db.prepare(`SELECT 1 FROM conversation_presentation_items
        WHERE thread_id = ? AND process_id IS NOT NULL AND json_extract(stub_json, '$.placeholder') = 1 LIMIT 1`).get(event.threadId)) return false;
    }
    const state = restoreConversationState(JSON.parse(row.state_json) as ConversationStateSnapshot, [item]);
    applyEngineEventToConversation(state, event);
    const stub = this.createStoredStub(item);
    if (state.items.length !== 1 || state.items[0] !== item || String(item.id) !== stored.item_id
      || (!reasoning && !toolOutput && (previousStub as { text?: string }).text !== (stub as { text?: string }).text)
      || (toolOutput && (previousStub as { _display?: ConversationItem })._display?.kind !== (stub as { _display?: ConversationItem })._display?.kind)) return false;
    this.db.prepare(`UPDATE conversation_presentation_items SET updated_seq = ?, stub_json = ?, item_json = ?
      WHERE thread_id = ? AND item_id = ?`).run(event.seq, JSON.stringify(stub), JSON.stringify(item), event.threadId, itemId);
    this.db.prepare("UPDATE conversation_presentations SET version = ?, state_json = ? WHERE thread_id = ?")
      .run(event.seq, JSON.stringify(snapshotConversationState(state)), event.threadId);
    return true;
  }

  /** 消息 stub 只判断可见性和分组；完整正文及附件仅在所属条目读取时恢复。 */
  private createStoredStub(item: ConversationItem): ConversationItem {
    if (item.kind !== "message") return createConversationItemStub(item);
    return { kind: "message", id: item.id, role: item.role, turnId: item.turnId,
      text: item.text.trim() || item.images?.length || item.files?.length ? "…" : "" };
  }

  /** 内部增量只读取归并元数据，不读取聚合历史正文。 */
  private getRow(threadId: ThreadId): ProjectionRow | undefined {
    return this.db.prepare("SELECT version, ready, schema_version, build_id, state_json FROM conversation_presentations WHERE thread_id = ?")
      .get(threadId) as ProjectionRow | undefined;
  }
}
