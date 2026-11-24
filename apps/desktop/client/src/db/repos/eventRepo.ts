import crypto from "node:crypto";

import { compressConversationEvents, getConversationMessageItemId } from "@codeflowai/shared";
import type { ConversationEventEnvelope, ConversationRelayScope, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import type { RawEngineEventEnvelope } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import { ConversationPresentationStore, type ProcessReadOptions } from "../conversationPresentation.js";
import type { ThreadPresentation, ThreadProcessDetails } from "@codeflowai/shared";
import { THREAD_DELETION_META_PREFIX } from "./threadRepo.js";

const REPLAY_READ_BATCH_SIZE = 256;
const RELAY_SCOPE_PREFIX = "conversation_relay:scope:";
const RELAY_INVALIDATION_PREFIX = "conversation_relay:invalidation:";

type RelayProgress = { serverOrigin: string; scope: ConversationRelayScope; cursor: number };
export type ConversationRelayInvalidation = { invalidationId: string; workspaceId: WorkspaceId; threadId: ThreadId;
  sharedWorkspaceId: string | null; throughSeq: number };

/** 规范 Server 来源并隔离账号、绑定及本机；重连 epoch 和 Key 轮换不重置进度。 */
export function conversationRelayScopeKey(serverUrl: string, scope: ConversationRelayScope): string {
  const origin = conversationRelayServerOrigin(serverUrl);
  if (scope.kind === "personal") {
    for (const value of [scope.userId, scope.clientId, scope.workspaceId]) {
      if (typeof value !== "string" || !value || value !== value.trim()) throw new Error("CONVERSATION_RELAY_SCOPE_INVALID");
    }
    if (scope.enterpriseId !== null && (typeof scope.enterpriseId !== "string" || !scope.enterpriseId || scope.enterpriseId !== scope.enterpriseId.trim())) {
      throw new Error("CONVERSATION_RELAY_SCOPE_INVALID");
    }
    return crypto.createHash("sha256").update(JSON.stringify(["personal", origin, scope.userId,
      scope.enterpriseId, scope.clientId, scope.workspaceId])).digest("hex");
  }
  for (const value of [scope.userId, scope.enterpriseId, scope.clientId, scope.bindingId, scope.workspaceId, scope.sharedWorkspaceId]) {
    if (typeof value !== "string" || !value || value !== value.trim()) throw new Error("CONVERSATION_RELAY_SCOPE_INVALID");
  }
  if (!Number.isSafeInteger(scope.hostScopeEpoch) || scope.hostScopeEpoch < 0) throw new Error("CONVERSATION_RELAY_SCOPE_INVALID");
  return crypto.createHash("sha256").update(JSON.stringify([origin, scope.userId, scope.enterpriseId,
    scope.clientId, scope.bindingId, scope.workspaceId, scope.sharedWorkspaceId])).digest("hex");
}

/** WS 与 HTTP 入口共用 Server 来源，忽略业务路径并拒绝 URL 中的凭据。 */
function conversationRelayServerOrigin(serverUrl: string): string {
  const server = new URL(serverUrl);
  if (!["https:", "http:", "wss:", "ws:"].includes(server.protocol) || server.username || server.password) {
    throw new Error("CONVERSATION_RELAY_SERVER_INVALID");
  }
  return `${server.protocol.replace("ws", "http")}//${server.host}`;
}

/** 应用库唯一 allocator；耐久预留入口要求真实外层提交，兼容调用保留原嵌套语义。 */
export function allocateClientEventSeq(db: SqliteDb, options?: { requireOutermost?: boolean; minimumSeqExclusive?: number }): number {
  return reserveClientEventSeqs(db, 1, options)[0]!;
}

/** 一次耐久预留本批实际序号；未写入正文的已预留号码不得回收。 */
export function reserveClientEventSeqs(db: SqliteDb, count: number, options?: { requireOutermost?: boolean; minimumSeqExclusive?: number }): number[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 8192) throw new Error("LOCAL_EVENT_BATCH_COUNT_INVALID");
  return db.transaction(() => {
    const metadata = db.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get() as { value?: unknown } | undefined;
    if (typeof metadata?.value !== "string" || !/^(0|[1-9]\d*)$/u.test(metadata.value)) {
      throw new Error("本地事件序号元数据损坏：meta.event_seq");
    }
    const counter = Number(metadata.value);
    const maxima = db.prepare(`
      SELECT (SELECT MAX(seq) FROM conversation_events) AS canonicalSeq,
             (SELECT MAX(seq) FROM raw_engine_events) AS rawSeq
    `).get() as { canonicalSeq: number | null; rawSeq: number | null };
    const now = Date.now();
    const minimum = options?.minimumSeqExclusive ?? 0;
    const watermarks = [counter, maxima.canonicalSeq ?? 0, maxima.rawSeq ?? 0, minimum, now];
    if (watermarks.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("本地事件序号高水位或时钟无效");
    }
    const next = Math.max(counter + 1, (maxima.canonicalSeq ?? 0) + 1, (maxima.rawSeq ?? 0) + 1, minimum + 1, now);
    const last = next + count - 1;
    if (!Number.isSafeInteger(next) || next <= 0 || !Number.isSafeInteger(last)) throw new Error("本地事件序号超出安全整数范围");
    db.prepare("UPDATE meta SET value = ? WHERE key = 'event_seq'").run(String(last));
    return Array.from({ length: count }, (_, index) => next + index);
  }, options?.requireOutermost ? { requireOutermost: true, mode: "immediate" } : undefined)();
}

/** 读取工作区已提交下界及现存正文高水位；它不是第二个序号分配器。 */
export function readWorkspaceEventSeqFloor(db: SqliteDb): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get() as { value?: unknown } | undefined;
  if (row && (typeof row.value !== "string" || !/^(0|[1-9]\d*)$/u.test(row.value))) {
    throw new Error("WORKSPACE_EVENT_SEQ_FLOOR_INVALID");
  }
  const maxima = db.prepare(`SELECT (SELECT MAX(seq) FROM conversation_events) AS canonicalSeq,
    (SELECT MAX(seq) FROM raw_engine_events) AS rawSeq`).get() as { canonicalSeq: number | null; rawSeq: number | null };
  const values = [Number(row?.value ?? 0), maxima.canonicalSeq ?? 0, maxima.rawSeq ?? 0];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("WORKSPACE_EVENT_SEQ_FLOOR_INVALID");
  return Math.max(...values);
}

/** 与正文同一工作区事务保存提交下界，删除或回滚历史不降低这个已提交事实。 */
export function recordWorkspaceEventSeqFloor(db: SqliteDb, seq: number): void {
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error("WORKSPACE_EVENT_SEQ_FLOOR_INVALID");
  const floor = readWorkspaceEventSeqFloor(db);
  db.prepare("INSERT INTO meta(key, value) VALUES ('event_seq_floor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(Math.max(seq, floor)));
}

/** 会话事件仓储：持久化 canonical conversation 事件（用于渲染/回放/索引）。 */
export class ConversationEventRepo {
  private readonly presentation: ConversationPresentationStore;
  private readonly presentationBuilds = new Map<ThreadId, Promise<void>>();
  private readonly insertStmt;
  private readonly insertOneTx;
  private readonly insertManyTx;
  private readonly latestSeqStmt;
  private readonly latestSeqByThreadStmt;
  private readonly upsertDiffSnapshotStmt;
  private readonly readEventByThreadSeqStmt;
  private readonly readDiffSnapshotByEventSeqStmt;
  private readonly deleteByThreadThroughSeqBatchStmt;
  private readonly messageDeletedStmt;

  /** 准备 canonical 仓储；屏障通知仅排队，最终投递必须在事务结束后复核 SQL。 */
  constructor(private readonly db: SqliteDb, private readonly options?: { localCanonicalEvents?: boolean; onRelayInvalidation?: (scopeKey: string) => void }) {
    this.presentation = new ConversationPresentationStore(db);
    this.messageDeletedStmt = this.db.prepare(
      "SELECT 1 FROM conversation_message_deletions WHERE thread_id = ? AND item_id = ?",
    );
    this.insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.upsertDiffSnapshotStmt = this.db.prepare(`
      INSERT INTO conversation_diff_snapshots (
        thread_id, diff_key, event_seq, diff_text, diff_sha256, diff_bytes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, diff_key) DO UPDATE SET
        event_seq = excluded.event_seq,
        diff_text = excluded.diff_text,
        diff_sha256 = excluded.diff_sha256,
        diff_bytes = excluded.diff_bytes,
        updated_at = excluded.updated_at
    `);
    this.readEventByThreadSeqStmt = this.db.prepare(
      "SELECT event_json FROM conversation_events WHERE thread_id = ? AND seq = ?",
    );
    this.readDiffSnapshotByEventSeqStmt = this.db.prepare(`
      SELECT diff_text, diff_sha256, diff_bytes
      FROM conversation_diff_snapshots
      WHERE thread_id = ? AND event_seq = ?
    `);
    this.latestSeqStmt = this.db.prepare("SELECT MAX(seq) AS latestSeq FROM conversation_events");
    this.latestSeqByThreadStmt = this.db.prepare(
      "SELECT MAX(seq) AS latestSeq FROM conversation_events WHERE thread_id = ?",
    );
    this.deleteByThreadThroughSeqBatchStmt = this.db.prepare(
      `DELETE FROM conversation_events
       WHERE seq IN (
         SELECT seq FROM conversation_events
         WHERE thread_id = ? AND seq <= ?
         ORDER BY seq ASC LIMIT ?
       )`,
    );
    this.insertManyTx = this.db.transaction((envelopes: ConversationEventEnvelope[]) => {
      for (const envelope of envelopes) {
        this.insertNormalizedEnvelope(envelope);
      }
    });
    this.insertOneTx = this.db.transaction((envelope: ConversationEventEnvelope, requireInsert: boolean) => {
      if (!this.insertNormalizedEnvelope(envelope) && requireInsert) {
        throw new Error(`Canonical event 未写入：threadId=${envelope.threadId}, seq=${envelope.seq}`);
      }
    });
  }

  /** 默认幂等追加；本地新事件可要求必须写入，零写入时在事务内显式失败。 */
  appendEnvelope(envelope: ConversationEventEnvelope, opts?: { requireInsert?: boolean }): void {
    this.insertOneTx(envelope, opts?.requireInsert === true);
  }

  appendEnvelopes(envelopes: ConversationEventEnvelope[]): void {
    if (!Array.isArray(envelopes) || envelopes.length === 0) return;
    this.insertManyTx(envelopes);
  }

  getLatestSeq(): number {
    const row = this.latestSeqStmt.get() as { latestSeq?: number | null } | undefined;
    const latestSeq = Number(row?.latestSeq ?? 0);
    return Number.isFinite(latestSeq) && latestSeq > 0 ? latestSeq : 0;
  }

  /** 返回指定会话当前最大的 canonical 事件 seq；无事件时返回 0。 */
  getLatestSeqByThread(threadId: ThreadId): number {
    const row = this.latestSeqByThreadStmt.get(String(threadId)) as { latestSeq?: number | null } | undefined;
    const latestSeq = Number(row?.latestSeq ?? 0);
    return Number.isSafeInteger(latestSeq) && latestSeq > 0 ? latestSeq : 0;
  }

  /** 标准化并写入 canonical 事件，返回是否产生新记录。 */
  private insertNormalizedEnvelope(envelope: ConversationEventEnvelope): boolean {
    const seq = Number((envelope as any)?.seq ?? 0);
    const ts = Number((envelope as any)?.ts ?? Date.now());
    if (!Number.isFinite(seq) || seq <= 0) throw new Error("Invalid conversation event.seq");

    const itemId = getConversationMessageItemId(envelope);
    if (itemId && envelope.type !== "item.message.deleted" && this.isMessageDeleted(envelope.threadId, itemId)) return false;

    const prepared = prepareConversationEventStorage(envelope);
    const result = this.insertStmt.run(
      seq,
      String(envelope.threadId),
      String(envelope.workspaceId),
      String(envelope.engine),
      String(envelope.type),
      JSON.stringify(prepared.envelope),
      ts,
    );
    if (Number(result.changes ?? 0) <= 0) return false;
    if (prepared.diffSnapshot) this.upsertDiffSnapshotStmt.run(
      prepared.diffSnapshot.threadId,
      prepared.diffSnapshot.diffKey,
      prepared.diffSnapshot.eventSeq,
      prepared.diffSnapshot.diffText,
      prepared.diffSnapshot.diffSha256,
      prepared.diffSnapshot.diffBytes,
      prepared.diffSnapshot.updatedAt,
    );
    this.presentation.append(envelope, this.getSupersededPresentationDiffIds(envelope));
    return true;
  }

  /** 判断展示索引是否可热读，不查询 canonical 或过程正文。 */
  isPresentationReady(threadId: ThreadId): boolean {
    return this.db.transaction(() => this.presentation.isReady(threadId))();
  }

  /** 冷构建复用一次diff保留快照，实时追加超过读取水位时才重新准备元数据。 */
  async ensurePresentation(threadId: ThreadId, opts?: { withDatabase?: <T>(operation: () => T) => Promise<T> }): Promise<void> {
    const pending = this.presentationBuilds.get(threadId);
    if (pending) return await pending;
    let diffs: { throughSeq: number; retained: Set<number>; rows: Array<{ seq: number; item_id: string; turn_id: string | null; engine_turn_id: string | null }> } | undefined;
    /** 所属构建事务内读取，复用已有turn规则；不跨请求缓存历史事实。 */
    const diffSnapshot = (seq: number) => {
      if (!diffs || seq > diffs.throughSeq) {
        const latest = this.db.prepare("SELECT MAX(seq) AS seq FROM conversation_events WHERE thread_id = ?").get(threadId) as { seq: number };
        const rows = this.db.prepare(`SELECT seq, json_extract(event_json, '$.payload.itemId') AS item_id,
          json_extract(event_json, '$.payload.turnId') AS turn_id, json_extract(event_json, '$.payload.engineTurnId') AS engine_turn_id
          FROM conversation_events WHERE thread_id = ? AND type = 'item.diff.created' ORDER BY seq`).all(threadId) as NonNullable<typeof diffs>["rows"];
        diffs = { throughSeq: latest.seq, rows, retained: resolveRetainedReplayDiffSeqs(this.db, threadId, rows.map(row => ({ seq: row.seq, type: "item.diff.created" }))) };
      }
      return diffs;
    };
    const build = this.presentation.rebuild(threadId, event => {
      return this.hydratePresentationEvent(event, event.type === "item.diff.created" ? diffSnapshot(event.seq).retained : undefined);
    }, event => {
      if (event.type !== "item.diff.created") return [];
      const snapshot = diffSnapshot(event.seq), key = resolveConversationDiffKey(event.payload);
      return [...new Set(snapshot.rows.filter(row => row.seq <= event.seq && row.item_id !== String(event.payload.itemId)
        && (!snapshot.retained.has(row.seq) || key && resolveConversationDiffKey({ itemId: row.item_id, turnId: row.turn_id, engineTurnId: row.engine_turn_id } as any) === key))
        .map(row => row.item_id))];
    }, opts);
    this.presentationBuilds.set(threadId, build);
    try { await build; }
    finally { this.presentationBuilds.delete(threadId); }
  }

  /** 从持久化轻量展示读取首屏。 */
  readPresentation(threadId: ThreadId): ThreadPresentation {
    return this.db.transaction(() => this.presentation.read(threadId))();
  }

  /** 按可见消息窗口读取首屏投影；更早窗口由前端携带 beforePosition 补充。 */
  readPresentationPage(threadId: ThreadId, options: { messageLimit: number; beforePosition?: number | null }): ThreadPresentation {
    return this.db.transaction(() => this.presentation.readPage(threadId, options))();
  }

  /** 展开时才按过程成员读取完整条目快照。 */
  readProcess(threadId: ThreadId, processId: string, options?: ProcessReadOptions): ThreadProcessDetails {
    return this.db.transaction(() => this.presentation.readProcess(threadId, processId, options))();
  }

  /** 旧 aggregate 正文可被后续快照替换；最新引用缺失或校验不符必须中止构建。 */
  private hydratePresentationEvent(event: ConversationEventEnvelope, retainedDiffSeqs?: ReadonlySet<number>): ConversationEventEnvelope | null {
    if (event.type === "item.diff.created" && !(retainedDiffSeqs ?? resolveRetainedReplayDiffSeqs(this.db, event.threadId, [{ seq: event.seq, type: event.type }])).has(event.seq)) return null;
    if (event.type === "item.diff.created" && event.payload.diffRef?.kind === "client_latest_snapshot") {
      const key = resolveConversationDiffKey(event.payload);
      const snapshot = this.db.prepare("SELECT event_seq FROM conversation_diff_snapshots WHERE thread_id = ? AND diff_key = ?")
        .get(event.threadId, key) as { event_seq: number } | undefined;
      if (!snapshot || snapshot.event_seq < event.seq) throw new Error(`THREAD_PRESENTATION_DIFF_SNAPSHOT_MISSING: threadId=${event.threadId}, seq=${event.seq}`);
      const hydrated = this.decodeStoredEnvelope(JSON.stringify(event), { requireDiffSnapshot: snapshot.event_seq === event.seq });
      if (snapshot.event_seq === event.seq && hydrated.type === "item.diff.created"
        && (Buffer.byteLength(hydrated.payload.diff, "utf8") !== event.payload.diffRef.bytes
          || crypto.createHash("sha256").update(hydrated.payload.diff).digest("hex") !== event.payload.diffRef.sha256)) {
        throw new Error(`THREAD_PRESENTATION_DIFF_SNAPSHOT_CORRUPTED: threadId=${event.threadId}, seq=${event.seq}`);
      }
      return hydrated;
    }
    return event;
  }

  /** 复用既有 turn 保留规则和 diffKey，让异 ID aggregate 只保留当前快照。 */
  private getSupersededPresentationDiffIds(event: ConversationEventEnvelope): string[] {
    if (event.type !== "item.diff.created") return [];
    const key = resolveConversationDiffKey(event.payload);
    const rows = this.db.prepare(`SELECT seq, json_extract(event_json, '$.payload.itemId') AS item_id,
      json_extract(event_json, '$.payload.turnId') AS turn_id, json_extract(event_json, '$.payload.engineTurnId') AS engine_turn_id
      FROM conversation_events WHERE thread_id = ? AND type = 'item.diff.created' AND seq <= ?`)
      .all(event.threadId, event.seq) as Array<{ seq: number; item_id: string; turn_id: string | null; engine_turn_id: string | null }>;
    const retained = resolveRetainedReplayDiffSeqs(this.db, event.threadId, rows.map(row => ({ seq: row.seq, type: "item.diff.created" })));
    return [...new Set(rows.filter(row => row.item_id !== String(event.payload.itemId)
      && (!retained.has(row.seq) || (key && resolveConversationDiffKey({ itemId: row.item_id, turnId: row.turn_id, engineTurnId: row.engine_turn_id } as any) === key)))
      .map(row => row.item_id))];
  }

  /** 按 seq 升序读取某 thread 的 canonical 事件。 */
  listByThread(threadId: ThreadId, opts?: { limit?: number }): ConversationEventEnvelope[] {
    const limit = Math.max(1, Math.min(200_000, Math.floor(Number(opts?.limit ?? 10_000))));
    const rows = this.db
      .prepare("SELECT event_json FROM conversation_events WHERE thread_id = ? ORDER BY seq DESC LIMIT ?")
      .all(String(threadId), limit) as Array<{ event_json: string }>;
    const events: ConversationEventEnvelope[] = [];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      try {
        events.push(this.decodeStoredEnvelope(String(rows[index]?.event_json ?? "")));
      } catch {
        // skip broken row
      }
    }
    return events;
  }

  /** 按事件类型读取会话最近历史，避免恢复逻辑把无关大事件载入内存。 */
  listByThreadType(
    threadId: ThreadId,
    type: ConversationEventEnvelope["type"],
    opts?: { limit?: number },
  ): ConversationEventEnvelope[] {
    const limit = Math.max(1, Math.min(5_000, Math.floor(Number(opts?.limit ?? 500))));
    const rows = this.db
      .prepare("SELECT event_json FROM conversation_events WHERE thread_id = ? AND type = ? ORDER BY seq DESC LIMIT ?")
      .all(String(threadId), String(type), limit) as Array<{ event_json: string }>;

    const out: ConversationEventEnvelope[] = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      try {
        out.push(this.decodeStoredEnvelope(String(rows[i]?.event_json ?? "")));
      } catch {
        // skip broken row
      }
    }
    return out;
  }

  /** 按主会话分页；同步短事务内定位和解码每批，释放连接后让出事件循环。 */
  async listByThreadForReplay(
    threadId: ThreadId,
    opts?: { limit?: number; beforeSeq?: number | null; withDatabase?: <T>(operation: () => T) => Promise<T> },
  ): Promise<{
    events: ConversationEventEnvelope[];
    hasMore: boolean;
    rawEventCount: number;
    oldestSeq: number | null;
    latestSeq: number | null;
  }> {
    /** 每批独立取得许可；未启用异步 writer 的调用方仍使用原同步事务。 */
    const read = <T>(operation: () => T): Promise<T> => opts?.withDatabase ? opts.withDatabase(operation) : Promise.resolve(operation());
    const limit = Math.max(1, Math.min(200_000, Math.floor(Number(opts?.limit ?? 10_000))));
    const beforeSeq = Number(opts?.beforeSeq ?? 0);
    const hasBefore = Number.isFinite(beforeSeq) && beforeSeq > 0;

    const { thread, rowRefs } = await read(() => this.db.transaction(() => {
      const thread = this.db.prepare("SELECT workspace_id, engine FROM threads WHERE id = ?").get(String(threadId)) as { workspace_id: string; engine: string } | undefined;
      const rowRefs = (hasBefore
        ? this.db
            .prepare(`
              SELECT seq, type
              FROM (
                SELECT seq, type
                FROM conversation_events
                WHERE thread_id = ? AND seq < ?
                ORDER BY seq DESC
                LIMIT ?
              )
              ORDER BY seq ASC
            `)
            .all(String(threadId), beforeSeq, limit)
        : this.db
            .prepare(`
              SELECT seq, type
              FROM (
                SELECT seq, type
                FROM conversation_events
                WHERE thread_id = ?
                ORDER BY seq DESC
                LIMIT ?
              )
              ORDER BY seq ASC
            `)
            .all(String(threadId), limit)) as Array<{ seq?: number; type?: string }>;
      return { thread, rowRefs };
    })());
    let oldestSeq = normalizeReplaySeq(rowRefs[0]?.seq);
    const latestSeq = normalizeReplaySeq(rowRefs.at(-1)?.seq);
    if (latestSeq != null && rowRefs.some(row => row.type === "item.subagent.childEvent")) {
      const earlierRefsStmt = await read(() => this.db.prepare(`
        SELECT seq, type FROM conversation_events
        WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?
      `));
      let mainEventCount = rowRefs.filter(row => row.type !== "item.subagent.childEvent").length;
      while (oldestSeq != null && mainEventCount < limit) {
        await new Promise<void>(resolve => setImmediate(resolve));
        const earlier = await read(() => earlierRefsStmt.all(String(threadId), oldestSeq, REPLAY_READ_BATCH_SIZE) as Array<{ seq: number; type: string }>);
        if (earlier.length === 0) break;
        for (const row of earlier) {
          oldestSeq = row.seq;
          if (row.type !== "item.subagent.childEvent" && ++mainEventCount === limit) break;
        }
      }
    }
    const replay: Array<ConversationEventEnvelope | null> = [];
    const latestDiffIndexByItemId = new Map<string, number>();
    const batchRefsStmt = await read(() => this.db.prepare(`
      SELECT seq, type FROM conversation_events
      WHERE thread_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT ?
    `));
    let cursor = oldestSeq;
    let rawEventCount = 0;
    /** 正文及 diff 快照共享本批连接，异步暂停前提交并关闭。 */
    const readBatch = this.db.transaction((firstSeq: number, lastSeq: number): number | null => {
      const refs = batchRefsStmt.all(String(threadId), firstSeq, lastSeq, REPLAY_READ_BATCH_SIZE) as Array<{ seq: number; type: string }>;
      if (refs.length === 0) return null;
      rawEventCount += refs.length;
      const batchLastSeq = refs.at(-1)!.seq;
      const retainedDiffSeqs = [...resolveRetainedReplayDiffSeqs(this.db, threadId, refs)];
      const diffFilter = retainedDiffSeqs.length ? `OR seq IN (${retainedDiffSeqs.map(() => "?").join(",")})` : "";
      const rows = this.db.prepare(`
        SELECT seq, workspace_id, engine, event_json FROM conversation_events
        WHERE thread_id = ? AND seq >= ? AND seq <= ?
          AND (type <> 'item.diff.created' ${diffFilter}) ORDER BY seq ASC
      `).all(String(threadId), firstSeq, batchLastSeq, ...retainedDiffSeqs) as Array<{ seq: number; workspace_id: string; engine: string; event_json: string }>;
      let rowIndex = 0;
      for (const ref of refs) {
        if (ref.type === "item.diff.created" && !retainedDiffSeqs.includes(ref.seq)) {
          // 省略旧快照正文时仍保留事件边界，避免压缩子事件跨越下一次分页起点。
          if (replay.at(-1) != null) replay.push(null);
          continue;
        }
        const row = rows[rowIndex++];
        if (!row || row.seq !== ref.seq) throw new Error(`会话历史记录缺失：threadId=${threadId}, seq=${ref.seq}`);
        let event: ConversationEventEnvelope;
        try {
          event = this.decodeStoredEnvelope(row.event_json);
          if (!event || typeof event !== "object" || Array.isArray(event) || event.schema !== 1
            || !Number.isSafeInteger(event.seq) || event.seq <= 0 || event.seq !== row.seq || event.threadId !== threadId
            || typeof event.workspaceId !== "string" || !event.workspaceId.trim() || event.workspaceId !== row.workspace_id
            || (event.engine !== "codex" && event.engine !== "claude") || event.engine !== row.engine) {
            throw new Error("会话事件信封身份与记录不符");
          }
          if (!thread || row.workspace_id !== thread.workspace_id || row.engine !== thread.engine) {
            throw new Error("会话事件记录与父会话归属不符");
          }
          if (!Number.isSafeInteger(event.ts) || event.ts < 0 || typeof event.type !== "string" || !event.type.trim()
            || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
            throw new Error("会话事件基础信封损坏");
          }
        } catch (cause) {
          throw new Error(`会话历史读取失败：threadId=${threadId}, seq=${row.seq}`, { cause });
        }
        appendCompactedReplayEvent(replay, latestDiffIndexByItemId, event);
      }
      return batchLastSeq;
    });
    while (cursor != null && latestSeq != null && cursor <= latestSeq) {
      const firstSeq = cursor;
      const batchLastSeq = await read(() => readBatch(firstSeq, latestSeq));
      if (batchLastSeq == null) break;
      cursor = batchLastSeq + 1;
      if (cursor <= latestSeq) await new Promise<void>(resolve => setImmediate(resolve));
    }
    const hasMore = oldestSeq != null && await read(() => Boolean(
      this.db
        .prepare("SELECT 1 AS found FROM conversation_events WHERE thread_id = ? AND seq < ? LIMIT 1")
        .get(String(threadId), oldestSeq),
    ));
    return {
      events: replay.filter((event): event is ConversationEventEnvelope => event != null),
      hasMore,
      rawEventCount,
      oldestSeq,
      latestSeq,
    };
  }

  /** 读取某 workspace 下仍在运行中的 turns。 */
  listRunningTurnsByWorkspace(workspaceId: WorkspaceId): Record<string, { runningTurnId: TurnId; runningTurnStartedAt: number }> {
    const wid = String(workspaceId);

    const endRows = this.db
      .prepare(
        "SELECT thread_id AS threadId, MAX(seq) AS endSeq FROM conversation_events WHERE workspace_id = ? AND type IN ('turn.completed','turn.error') GROUP BY thread_id",
      )
      .all(wid) as Array<{ threadId: string; endSeq: number }>;
    const endSeqByThreadId = new Map<string, number>();
    for (const r of endRows) {
      const id = String(r.threadId ?? "").trim();
      const seq = Number(r.endSeq ?? 0);
      if (!id || !Number.isFinite(seq)) continue;
      endSeqByThreadId.set(id, seq);
    }

    const startRows = this.db
      .prepare(
        [
          "SELECT e.thread_id AS threadId, e.seq AS startSeq, e.ts AS startedAt, e.event_json AS eventJson",
          "FROM conversation_events e",
          "JOIN (",
          "  SELECT thread_id, MAX(seq) AS seq",
          "  FROM conversation_events",
          "  WHERE workspace_id = ? AND type = 'turn.started'",
          "  GROUP BY thread_id",
          ") s ON e.thread_id = s.thread_id AND e.seq = s.seq",
        ].join("\n"),
      )
      .all(wid) as Array<{ threadId: string; startSeq: number; startedAt: number; eventJson: string }>;

    const out: Record<string, { runningTurnId: TurnId; runningTurnStartedAt: number }> = {};
    for (const r of startRows) {
      const threadId = String(r.threadId ?? "").trim();
      const startSeq = Number(r.startSeq ?? 0);
      const startedAt = Number(r.startedAt ?? 0);
      if (!threadId || !Number.isFinite(startSeq) || startSeq <= 0 || !Number.isFinite(startedAt) || startedAt <= 0) continue;

      const endSeq = endSeqByThreadId.get(threadId) ?? 0;
      if (startSeq <= endSeq) continue;

      let turnId: TurnId | null = null;
      try {
        const env = JSON.parse(String(r.eventJson ?? "")) as { payload?: { turnId?: unknown } };
        const t = String(env?.payload?.turnId ?? "").trim();
        if (t) turnId = t as TurnId;
      } catch {
        // ignore
      }
      if (!turnId) continue;
      out[threadId] = { runningTurnId: turnId, runningTurnStartedAt: startedAt };
    }
    return out;
  }

  /** 按 seq 升序读取某 thread 在指定 seq 之后的 canonical 事件。 */
  listByThreadFromSeq(threadId: ThreadId, opts: { fromSeqInclusive: number; limit?: number }): ConversationEventEnvelope[] {
    const fromSeq = Math.max(1, Math.floor(Number(opts.fromSeqInclusive ?? 0)));
    const limit = Math.max(1, Math.min(5_000, Math.floor(Number(opts.limit ?? 500))));

    const rows = this.db
      .prepare("SELECT event_json FROM conversation_events WHERE thread_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?")
      .all(String(threadId), fromSeq, limit) as Array<{ event_json: string }>;

    const out: ConversationEventEnvelope[] = [];
    for (const r of rows) {
      try {
        out.push(this.decodeStoredEnvelope(String(r.event_json ?? "")));
      } catch {
        // skip broken row
      }
    }
    return out;
  }

  /** 按精确 seq 读取并水合 Codex aggregate diff，供回滚证据校验。 */
  getDiffEventBySeq(
    threadId: ThreadId,
    seq: number,
  ): Extract<ConversationEventEnvelope, { type: "item.diff.created" }> | null {
    const event = this.readStoredEnvelope(threadId, seq, { requireDiffSnapshot: true });
    return event?.type === "item.diff.created" ? event : null;
  }

  /** 读取 turn 边界内最新 aggregate diff，并水合正文。 */
  findLatestDiffEventInRange(
    threadId: ThreadId,
    startSeq: number,
    endSeq: number,
  ): Extract<ConversationEventEnvelope, { type: "item.diff.created" }> | null {
    const row = this.db
      .prepare(
        "SELECT seq FROM conversation_events WHERE thread_id = ? AND type = 'item.diff.created' AND seq >= ? AND seq <= ? ORDER BY seq DESC LIMIT 1",
      )
      .get(String(threadId), startSeq, endSeq) as { seq?: number } | undefined;
    const seq = normalizeReplaySeq(row?.seq);
    if (seq == null) return null;
    return this.getDiffEventBySeq(threadId, seq);
  }

  /** 提交回执恢复复用原水合入口，外置diff不得被当作空正文直接发布。 */
  getEnvelopeBySeq(threadId: ThreadId, seq: number): ConversationEventEnvelope | null {
    return this.readStoredEnvelope(threadId, seq);
  }

  private readStoredEnvelope(
    threadId: ThreadId,
    seq: number,
    opts?: { requireDiffSnapshot?: boolean },
  ): ConversationEventEnvelope | null {
    const row = this.readEventByThreadSeqStmt.get(String(threadId), seq) as { event_json?: string } | undefined;
    if (!row) return null;
    const event = this.decodeStoredEnvelope(String(row.event_json ?? ""), opts);
    return String(event.threadId) === String(threadId) && Number(event.seq) === Number(seq) ? event : null;
  }

  private decodeStoredEnvelope(
    eventJson: string,
    opts?: { requireDiffSnapshot?: boolean },
  ): ConversationEventEnvelope {
    const event = JSON.parse(String(eventJson ?? "")) as ConversationEventEnvelope;
    if (event.type !== "item.diff.created" || event.payload.diffRef?.kind !== "client_latest_snapshot") {
      return event;
    }
    const snapshot = this.readDiffSnapshotByEventSeqStmt.get(
      String(event.threadId),
      Number(event.seq),
    ) as { diff_text?: string; diff_sha256?: string; diff_bytes?: number } | undefined;
    if (!snapshot) {
      if (opts?.requireDiffSnapshot) throw new Error(`aggregate diff snapshot missing: seq=${String(event.seq)}`);
      return event;
    }
    if (
      String(snapshot.diff_sha256 ?? "") !== String(event.payload.diffRef.sha256)
      || Number(snapshot.diff_bytes ?? -1) !== Number(event.payload.diffRef.bytes)
    ) {
      throw new Error(`aggregate diff snapshot metadata mismatch: seq=${String(event.seq)}`);
    }
    return {
      ...event,
      payload: {
        ...event.payload,
        diff: String(snapshot.diff_text ?? ""),
      },
    };
  }

  /** 查询持久删除事实；同时保护迟到 ACK 与后续流式正文。 */
  isMessageDeleted(threadId: ThreadId, itemId: string): boolean {
    return Boolean(this.messageDeletedStmt.get(String(threadId), itemId));
  }

  /** 返回整个会话的删除 ID，不受本次历史分页窗口限制。 */
  listDeletedMessageIds(threadId: ThreadId): string[] {
    return (this.db.prepare(
      "SELECT item_id FROM conversation_message_deletions WHERE thread_id = ? ORDER BY item_id",
    ).all(String(threadId)) as Array<{ item_id: string }>).map((row) => row.item_id);
  }

  /** 仅收到 Server 授权后登记投递范围；保存身份和 cursor，不保存事件正文。 */
  registerRelayScope(serverUrl: string, scope: ConversationRelayScope): string {
    this.requireLocalCanonicalEvents();
    const key = conversationRelayScopeKey(serverUrl, scope);
    const existing = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(RELAY_SCOPE_PREFIX + key) as { value: string } | undefined;
    const progress = existing ? this.decodeRelayProgress(existing.value) : { serverOrigin: conversationRelayServerOrigin(serverUrl), scope, cursor: 0 };
    if (conversationRelayScopeKey(serverUrl, progress.scope) !== key) throw new Error("CONVERSATION_RELAY_SCOPE_METADATA_MISMATCH");
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(RELAY_SCOPE_PREFIX + key, JSON.stringify({ serverOrigin: progress.serverOrigin, scope, cursor: progress.cursor }));
    return key;
  }

  /** 新需求只安装可见水位H，不读取或重新投递无人订阅期间的历史正文。 */
  beginRelayDemand(serverUrl: string, scope: ConversationRelayScope, readyThroughSeq: number): string {
    return this.db.transaction(() => {
      const key = this.registerRelayScope(serverUrl, scope);
      const { cursor } = this.readRelayProgress(key);
      this.advanceRelayCursor(key, cursor, readyThroughSeq);
      return key;
    })();
  }

  /** 只读授权共享线程的有界 canonical 批次，已替换 diff 仍推进扫描边界。 */
  readRelayBatch(scopeKey: string, limit = 128): { cursor: number; throughSeq: number; events: ConversationEventEnvelope[] } {
    const progress = this.readRelayProgress(scopeKey);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error("CONVERSATION_RELAY_LIMIT_INVALID");
    const personal = progress.scope.kind === "personal";
    const sharedWorkspaceId = progress.scope.kind === "personal" ? null : progress.scope.sharedWorkspaceId;
    const rows = (personal
      ? this.db.prepare(`
        SELECT e.seq, e.thread_id, e.workspace_id, e.engine, e.event_json, t.engine AS parent_engine
        FROM conversation_events e JOIN threads t ON t.id = e.thread_id
        WHERE e.seq > ? AND t.workspace_id = ? AND t.shared_workspace_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM meta WHERE key = '${THREAD_DELETION_META_PREFIX}' || t.id)
        ORDER BY e.seq ASC LIMIT ?
      `).all(progress.cursor, progress.scope.workspaceId, limit)
      : this.db.prepare(`
        SELECT e.seq, e.thread_id, e.workspace_id, e.engine, e.event_json, t.engine AS parent_engine
        FROM conversation_events e JOIN threads t ON t.id = e.thread_id
        WHERE e.seq > ? AND t.workspace_id = ? AND t.shared_workspace_id = ?
          AND NOT EXISTS (SELECT 1 FROM meta WHERE key = '${THREAD_DELETION_META_PREFIX}' || t.id)
        ORDER BY e.seq ASC LIMIT ?
      `).all(progress.cursor, progress.scope.workspaceId, sharedWorkspaceId, limit)) as Array<{
      seq: number; thread_id: string; workspace_id: string; engine: string; parent_engine: string; event_json: string;
    }>;
    const events: ConversationEventEnvelope[] = [];
    for (const row of rows) {
      try {
        const event = this.decodeStoredEnvelope(row.event_json);
        if (!event || typeof event !== "object" || Array.isArray(event) || event.schema !== 1
          || !Number.isSafeInteger(event.seq) || event.seq <= 0 || event.seq !== row.seq || event.threadId !== row.thread_id
          || event.workspaceId !== row.workspace_id || row.workspace_id !== progress.scope.workspaceId
          || event.engine !== row.engine || row.engine !== row.parent_engine
          || (event.engine !== "codex" && event.engine !== "claude") || !Number.isSafeInteger(event.ts) || event.ts < 0
          || typeof event.type !== "string" || !event.type || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
          throw new Error("canonical envelope identity or structure mismatch");
        }
        if (event.type === "item.diff.created" && event.payload.diffRef?.kind === "client_latest_snapshot") {
          const snapshot = this.db.prepare("SELECT event_seq FROM conversation_diff_snapshots WHERE thread_id = ? AND diff_key = ?")
            .get(row.thread_id, resolveConversationDiffKey(event.payload)) as { event_seq: number } | undefined;
          if (snapshot && snapshot.event_seq > row.seq) continue;
          if (!snapshot || snapshot.event_seq !== row.seq) throw new Error(`aggregate diff snapshot missing: seq=${row.seq}`);
          if (Buffer.byteLength(event.payload.diff, "utf8") !== event.payload.diffRef.bytes
            || crypto.createHash("sha256").update(event.payload.diff).digest("hex") !== event.payload.diffRef.sha256) {
            throw new Error(`aggregate diff snapshot body mismatch: seq=${row.seq}`);
          }
        }
        events.push(event);
      } catch (cause) {
        throw new Error(`relay event read failed: scopeKey=${scopeKey}, threadId=${row.thread_id}, seq=${row.seq}`, { cause });
      }
    }
    return { cursor: progress.cursor, throughSeq: rows.at(-1)?.seq ?? progress.cursor, events };
  }

  /** 只在完整投递确认后推进已有 cursor；并发或倒退必须显式失败。 */
  advanceRelayCursor(scopeKey: string, expectedCursor: number, throughSeq: number): void {
    this.db.transaction(() => {
      const progress = this.readRelayProgress(scopeKey);
      if (!Number.isSafeInteger(throughSeq) || throughSeq < expectedCursor || progress.cursor !== expectedCursor) {
        throw new Error("CONVERSATION_RELAY_CURSOR_CONFLICT");
      }
      this.db.prepare("UPDATE meta SET value = ? WHERE key = ?")
        .run(JSON.stringify({ ...progress, cursor: throughSeq }), RELAY_SCOPE_PREFIX + scopeKey);
    })();
  }

  /** 返回一个耐久清理屏障；与新增投递分别确认，重启也不遗忘删除。 */
  readRelayInvalidation(scopeKey: string): ConversationRelayInvalidation | null {
    const { scope } = this.readRelayProgress(scopeKey);
    const row = this.db.prepare("SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key LIMIT 1")
      .get(`${RELAY_INVALIDATION_PREFIX}${scopeKey}:%`) as { key: string; value: string } | undefined;
    return row ? this.decodeScopedRelayInvalidation(row, scopeKey, scope) : null;
  }

  /** 精确删除本次确认的屏障；旧 ACK 不得清除后来产生的同线程删除。 */
  acknowledgeRelayInvalidation(scopeKey: string, invalidationId: string): boolean {
    const { scope } = this.readRelayProgress(scopeKey);
    const rows = this.db.prepare("SELECT key, value FROM meta WHERE key LIKE ?")
      .all(`${RELAY_INVALIDATION_PREFIX}${scopeKey}:%`) as Array<{ key: string; value: string }>;
    for (const row of rows) {
      if (this.decodeScopedRelayInvalidation(row, scopeKey, scope).invalidationId !== invalidationId) continue;
      return Number(this.db.prepare("DELETE FROM meta WHERE key = ? AND value = ?").run(row.key, row.value).changes) === 1;
    }
    return false;
  }

  /** 读取 scope 元数据，损坏或未授权登记时禁止扫描历史。 */
  private readRelayProgress(scopeKey: string): RelayProgress {
    this.requireLocalCanonicalEvents();
    if (!/^[a-f0-9]{64}$/u.test(scopeKey)) throw new Error("CONVERSATION_RELAY_SCOPE_KEY_INVALID");
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(RELAY_SCOPE_PREFIX + scopeKey) as { value: string } | undefined;
    if (!row) throw new Error("CONVERSATION_RELAY_SCOPE_NOT_REGISTERED");
    const progress = this.decodeRelayProgress(row.value);
    if (conversationRelayScopeKey(progress.serverOrigin, progress.scope) !== scopeKey) throw new Error("CONVERSATION_RELAY_SCOPE_METADATA_MISMATCH");
    return progress;
  }

  /** 持久元数据只保留已确认 cursor 与身份，不能被当作当前 Server 授权。 */
  private decodeRelayProgress(value: string): RelayProgress {
    const progress = JSON.parse(value) as RelayProgress;
    if (!progress || !Number.isSafeInteger(progress.cursor) || progress.cursor < 0 || !progress.scope) {
      throw new Error("CONVERSATION_RELAY_PROGRESS_INVALID");
    }
    conversationRelayScopeKey(progress.serverOrigin, progress.scope);
    return progress;
  }

  /** 清理记录损坏必须停止恢复，不能返回默认空记录。 */
  private decodeRelayInvalidation(value: string): ConversationRelayInvalidation {
    const entry = JSON.parse(value) as ConversationRelayInvalidation;
    if (!entry || typeof entry.invalidationId !== "string" || !entry.invalidationId
      || typeof entry.workspaceId !== "string" || !entry.workspaceId || typeof entry.threadId !== "string" || !entry.threadId
      || (entry.sharedWorkspaceId !== null && (typeof entry.sharedWorkspaceId !== "string" || !entry.sharedWorkspaceId))
      || !Number.isSafeInteger(entry.throughSeq) || entry.throughSeq <= 0) throw new Error("CONVERSATION_RELAY_INVALIDATION_INVALID");
    return entry;
  }

  /** 父会话硬删除后仍按持久 scope 和 meta key 核对目标，拒绝跨范围串改。 */
  private decodeScopedRelayInvalidation(row: { key: string; value: string }, scopeKey: string,
    scope: ConversationRelayScope): ConversationRelayInvalidation {
    const expectedSharedWorkspaceId = scope.kind === "personal" ? null : scope.sharedWorkspaceId;
    const entry = this.decodeRelayInvalidation(row.value);
    if (entry.workspaceId !== scope.workspaceId || entry.sharedWorkspaceId !== expectedSharedWorkspaceId
      || row.key !== `${RELAY_INVALIDATION_PREFIX}${scopeKey}:${encodeURIComponent(entry.threadId)}`) {
      throw new Error("CONVERSATION_RELAY_INVALIDATION_SCOPE_MISMATCH");
    }
    return entry;
  }

  /** 仅桌面本地编号模式提供耐久 relay，不改变普通 Server 编号 Client。 */
  private requireLocalCanonicalEvents(): void {
    if (!this.options?.localCanonicalEvents) throw new Error("LOCAL_CANONICAL_EVENTS_REQUIRED");
  }

  /** 逻辑删除与标记同事务失效远端历史，不必等待全部正文物理清理。 */
  invalidateDeletedThread(threadId: ThreadId): void {
    this.recordRelayInvalidations(threadId, this.getLatestSeqByThread(threadId));
  }

  /** 与真实删除同事务记录已关联范围屏障；通知仅排队，提交或回滚后由 SQL 决定投递。 */
  private recordRelayInvalidations(threadId: ThreadId, throughSeq: number): void {
    if (!this.options?.localCanonicalEvents || throughSeq <= 0) return;
    const scopes = this.db.prepare("SELECT key, value FROM meta WHERE key LIKE ?").all(RELAY_SCOPE_PREFIX + "%") as Array<{ key: string; value: string }>;
    if (!scopes.length) return;
    const thread = this.db.prepare("SELECT workspace_id, shared_workspace_id FROM threads WHERE id = ?").get(String(threadId)) as
      { workspace_id: string; shared_workspace_id: string | null } | undefined;
    if (!thread) throw new Error(`CONVERSATION_RELAY_PARENT_MISSING: threadId=${threadId}`);
    for (const entry of scopes) {
      const scopeKey = entry.key.slice(RELAY_SCOPE_PREFIX.length);
      const { scope } = this.readRelayProgress(scopeKey);
      const scopeSharedWorkspaceId = scope.kind === "personal" ? null : scope.sharedWorkspaceId;
      if (scope.workspaceId !== thread.workspace_id || scopeSharedWorkspaceId !== thread.shared_workspace_id) continue;
      const key = `${RELAY_INVALIDATION_PREFIX}${scopeKey}:${encodeURIComponent(threadId)}`;
      const previous = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      const pending: ConversationRelayInvalidation = { invalidationId: crypto.randomUUID(), workspaceId: scope.workspaceId,
        threadId, sharedWorkspaceId: scopeSharedWorkspaceId,
        throughSeq: Math.max(throughSeq, previous ? this.decodeScopedRelayInvalidation({ key, value: previous.value }, scopeKey, scope).throughSeq : 0) };
      this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, JSON.stringify(pending));
      this.options.onRelayInvalidation?.(scopeKey);
    }
  }

  /** 原子删除单条聊天正文，保留执行输入、引擎历史、回合终态和工具证据。 */
  deleteMessage(threadId: ThreadId, itemId: string): void {
    this.db.transaction(() => {
      const throughSeq = this.getLatestSeqByThread(threadId);
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_message_deletions (thread_id, item_id, deleted_at) VALUES (?, ?, ?)",
      ).run(String(threadId), itemId, Date.now());
      const deleted = this.db.prepare(`
        DELETE FROM conversation_events WHERE thread_id = ?
          AND type IN ('item.userMessage.created', 'item.userMessage.engineCall.created',
            'item.agentMessage.started', 'item.agentMessage.delta', 'item.agentMessage.snapshot', 'item.agentMessage.completed')
          AND json_extract(event_json, '$.payload.itemId') = ?
      `).run(String(threadId), itemId);
      if (Number(deleted.changes) > 0) this.recordRelayInvalidations(threadId, throughSeq);
      this.presentation.invalidate(threadId);
    })();
  }

  /** 按工作区删除时先逐线程记录屏障，全部变更同事务提交。 */
  deleteByWorkspace(workspaceId: WorkspaceId): number {
    return this.db.transaction(() => {
      const threads = this.db.prepare("SELECT thread_id, MAX(seq) AS through_seq FROM conversation_events WHERE workspace_id = ? GROUP BY thread_id")
        .all(String(workspaceId)) as Array<{ thread_id: ThreadId; through_seq: number }>;
      for (const thread of threads) this.recordRelayInvalidations(thread.thread_id, thread.through_seq);
      for (const thread of threads) this.presentation.delete(thread.thread_id);
      return Number(this.db.prepare("DELETE FROM conversation_events WHERE workspace_id = ?").run(String(workspaceId)).changes);
    })();
  }

  /** 清空历史与耐久缓存失效同事务，审批续跑沿用此入口。 */
  deleteByThread(threadId: ThreadId): number {
    return this.db.transaction(() => {
      this.recordRelayInvalidations(threadId, this.getLatestSeqByThread(threadId));
      this.presentation.delete(threadId);
      return Number(this.db.prepare("DELETE FROM conversation_events WHERE thread_id = ?").run(String(threadId)).changes);
    })();
  }

  /** 回滚裁剪后失效旧高水位内缓存，保留真实 SQL 历史作为唯一事实。 */
  deleteAfterSeq(threadId: ThreadId, boundarySeq: number): number {
    const seq = Number(boundarySeq ?? 0);
    if (!Number.isFinite(seq) || seq <= 0) return 0;
    return this.db.transaction(() => {
      const highWater = this.getLatestSeqByThread(threadId);
      const res = this.db.prepare("DELETE FROM conversation_events WHERE thread_id = ? AND seq > ?").run(String(threadId), seq);
      if (Number(res.changes) > 0) {
        this.recordRelayInvalidations(threadId, highWater);
        this.presentation.invalidate(threadId);
      }
      return Number(res.changes ?? 0);
    })();
  }

  /** 按会话和任务高水位限量删除 canonical 事件。 */
  deleteByThreadThroughSeq(threadId: ThreadId, throughSeq: number, limit: number): number {
    const seq = normalizeCleanupSeq(throughSeq);
    if (seq === 0) return 0;
    return this.db.transaction(() => {
      const result = this.deleteByThreadThroughSeqBatchStmt.run(String(threadId), seq, normalizeCleanupBatchSize(limit));
      if (Number(result.changes) > 0) {
        this.recordRelayInvalidations(threadId, seq);
        this.presentation.invalidate(threadId);
      }
      return Number(result.changes ?? 0);
    })();
  }
}

type ConversationDiffSnapshotWrite = {
  threadId: string;
  diffKey: string;
  eventSeq: number;
  diffText: string;
  diffSha256: string;
  diffBytes: number;
  updatedAt: number;
};

/** 将可替换的 aggregate diff 正文外置，canonical 行仅保存稳定引用。 */
function prepareConversationEventStorage(envelope: ConversationEventEnvelope): {
  envelope: ConversationEventEnvelope;
  diffSnapshot: ConversationDiffSnapshotWrite | null;
} {
  if (envelope.type !== "item.diff.created") return { envelope, diffSnapshot: null };
  const diffKey = resolveConversationDiffKey(envelope.payload);
  if (!diffKey) return { envelope, diffSnapshot: null };

  const diffText = String(envelope.payload.diff ?? "");
  const diffSha256 = crypto.createHash("sha256").update(diffText).digest("hex");
  const diffBytes = Buffer.byteLength(diffText, "utf8");
  return {
    envelope: {
      ...envelope,
      payload: {
        ...envelope.payload,
        diff: "",
        diffRef: {
          kind: "client_latest_snapshot",
          sha256: diffSha256,
          bytes: diffBytes,
        },
      },
    },
    diffSnapshot: {
      threadId: String(envelope.threadId),
      diffKey,
      eventSeq: Number(envelope.seq),
      diffText,
      diffSha256,
      diffBytes,
      updatedAt: Number(envelope.ts ?? Date.now()),
    },
  };
}

function resolveConversationDiffKey(payload: Extract<ConversationEventEnvelope, { type: "item.diff.created" }>["payload"]): string | null {
  const turnId = String(payload.turnId ?? "").trim();
  if (turnId) return `turn:${turnId}`;
  const engineTurnId = String(payload.engineTurnId ?? "").trim();
  if (engineTurnId) return `engine:${engineTurnId}`;
  const itemId = String(payload.itemId ?? "").trim();
  return itemId ? `item:${itemId}` : null;
}

type ReplayRowRef = { seq?: number; type?: string };
type ReplayTurnRange = { startSeq: number; nextStartSeq: number | null };

/** 只保留每个本地 turn 的全局最新 aggregate diff，避免读取同一大 diff 的历史快照。 */
function resolveRetainedReplayDiffSeqs(db: SqliteDb, threadId: ThreadId, rows: ReplayRowRef[]): Set<number> {
  const selectedDiffSeqs = rows
    .filter((row) => row.type === "item.diff.created")
    .map((row) => normalizeReplaySeq(row.seq))
    .filter((seq): seq is number => seq != null);
  if (selectedDiffSeqs.length === 0) return new Set();

  const starts = (db.prepare(`
    SELECT start_event_seq
    FROM thread_turns
    WHERE thread_id = ? AND start_event_seq IS NOT NULL
    ORDER BY start_event_seq ASC
  `).all(String(threadId)) as Array<{ start_event_seq?: number }>)
    .map((row) => normalizeReplaySeq(row.start_event_seq))
    .filter((seq): seq is number => seq != null);
  const ranges: ReplayTurnRange[] = starts.map((startSeq, index) => ({
    startSeq,
    nextStartSeq: starts[index + 1] ?? null,
  }));
  const selectedByRange = new Map<ReplayTurnRange, Set<number>>();
  const retained = new Set<number>();
  for (const seq of selectedDiffSeqs) {
    const range = findReplayTurnRange(ranges, seq);
    if (!range) {
      retained.add(seq);
      continue;
    }
    const selected = selectedByRange.get(range) ?? new Set<number>();
    selected.add(seq);
    selectedByRange.set(range, selected);
  }

  for (const [range, selected] of selectedByRange) {
    const row = (range.nextStartSeq == null
      ? db.prepare(`
          SELECT MAX(seq) AS latest_seq
          FROM conversation_events
          WHERE thread_id = ? AND type = 'item.diff.created' AND seq >= ?
        `).get(String(threadId), range.startSeq)
      : db.prepare(`
          SELECT MAX(seq) AS latest_seq
          FROM conversation_events
          WHERE thread_id = ? AND type = 'item.diff.created' AND seq >= ? AND seq < ?
        `).get(String(threadId), range.startSeq, range.nextStartSeq)) as { latest_seq?: number } | undefined;
    const latestSeq = normalizeReplaySeq(row?.latest_seq);
    if (latestSeq != null && selected.has(latestSeq)) retained.add(latestSeq);
  }
  return retained;
}

/** 将事件 seq 映射到最后一个不晚于它的 turn 起点。 */
function findReplayTurnRange(ranges: ReplayTurnRange[], seq: number): ReplayTurnRange | null {
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    if (seq < range.startSeq) continue;
    if (range.nextStartSeq != null && seq >= range.nextStartSeq) continue;
    return range;
  }
  return null;
}

function normalizeReplaySeq(value: unknown): number | null {
  const seq = Number(value ?? 0);
  return Number.isFinite(seq) && seq > 0 ? seq : null;
}

/** 流式压缩回放；aggregate diff 只保留同 item 最新快照，其余 delta 保持相邻合并规则。 */
function appendCompactedReplayEvent(
  replay: Array<ConversationEventEnvelope | null>,
  latestDiffIndexByItemId: Map<string, number>,
  event: ConversationEventEnvelope,
): void {
  if (event.type === "item.diff.created") {
    const itemId = String(event.payload.itemId ?? "").trim();
    const previousIndex = itemId ? latestDiffIndexByItemId.get(itemId) : undefined;
    if (previousIndex != null) replay[previousIndex] = null;
    if (itemId) latestDiffIndexByItemId.set(itemId, replay.length);
    replay.push(event);
    return;
  }

  const lastIndex = replay.length - 1;
  const previous = lastIndex >= 0 ? replay[lastIndex] : null;
  if (previous) {
    const compressed = compressConversationEvents([previous, event]);
    if (compressed.length === 1) {
      replay[lastIndex] = compressed[0]!;
      return;
    }
  }
  replay.push(event);
}

/** 原始引擎事件仓储：仅用于 Inspector/排障。 */
export class RawEngineEventRepo {
  private readonly insertStmt;
  private readonly insertOneTx;
  private readonly insertManyTx;
  private readonly deleteBeforeSeqBatchStmt;
  private readonly deleteByThreadThroughSeqBatchStmt;
  private readonly latestSeqByThreadStmt;
  private readonly runtimeTimestampStmt;
  private readonly runtimeToolStmt;

  /** 准备 raw 仓储语句，严格单条写入在事务内校验实际插入结果。 */
  constructor(private readonly db: SqliteDb) {
    this.insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO raw_engine_events (seq, thread_id, workspace_id, engine, source, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.insertOneTx = this.db.transaction((envelope: RawEngineEventEnvelope, requireInsert: boolean) => {
      if (!this.insertNormalizedEnvelope(envelope) && requireInsert) {
        throw new Error(`Raw event 未写入：threadId=${envelope.threadId}, seq=${envelope.seq}`);
      }
    });
    this.insertManyTx = this.db.transaction((envelopes: RawEngineEventEnvelope[]) => {
      for (const envelope of envelopes) {
        this.insertNormalizedEnvelope(envelope);
      }
    });
    this.deleteBeforeSeqBatchStmt = this.db.prepare(
      "DELETE FROM raw_engine_events WHERE seq IN (SELECT seq FROM raw_engine_events WHERE seq < ? ORDER BY seq ASC LIMIT ?)",
    );
    this.deleteByThreadThroughSeqBatchStmt = this.db.prepare(
      `DELETE FROM raw_engine_events
       WHERE seq IN (
         SELECT seq FROM raw_engine_events
         WHERE thread_id = ? AND seq <= ?
         ORDER BY seq ASC LIMIT ?
       )`,
    );
    this.latestSeqByThreadStmt = this.db.prepare(
      "SELECT MAX(seq) AS latestSeq FROM raw_engine_events WHERE thread_id = ?",
    );
    // 复用运行证据查询语句，配合迁移索引避免每个节点线程重复编译 SQL。
    this.runtimeTimestampStmt = this.db.prepare(
      "SELECT ts FROM raw_engine_events WHERE thread_id = ? ORDER BY seq ASC",
    );
    this.runtimeToolStmt = this.db.prepare(
      `SELECT ts, event_json FROM raw_engine_events
       WHERE thread_id = ?
         AND (event_json LIKE '%\"tool_use\"%' OR event_json LIKE '%\"tool_result\"%')
       ORDER BY seq ASC`,
    );
  }

  /** 默认幂等追加；严格模式必须新写入，供编号与原始事件一同提交。 */
  appendEnvelope(envelope: RawEngineEventEnvelope, opts?: { requireInsert?: boolean }): void {
    this.insertOneTx(envelope, opts?.requireInsert === true);
  }

  appendEnvelopes(envelopes: RawEngineEventEnvelope[]): void {
    if (!Array.isArray(envelopes) || envelopes.length === 0) return;
    this.insertManyTx(envelopes);
  }

  /** 返回指定会话当前最大的原始事件 seq；无事件时返回 0。 */
  getLatestSeqByThread(threadId: ThreadId): number {
    const row = this.latestSeqByThreadStmt.get(String(threadId)) as { latestSeq?: number | null } | undefined;
    const latestSeq = Number(row?.latestSeq ?? 0);
    return Number.isSafeInteger(latestSeq) && latestSeq > 0 ? latestSeq : 0;
  }

  /** 写入原始事件并返回是否产生新记录，不改变旧批量调用的幂等语义。 */
  private insertNormalizedEnvelope(envelope: RawEngineEventEnvelope): boolean {
    const seq = Number((envelope as any)?.seq ?? 0);
    const ts = Number((envelope as any)?.ts ?? Date.now());
    if (!Number.isFinite(seq) || seq <= 0) throw new Error("Invalid raw event.seq");

    const result = this.insertStmt.run(
      seq,
      String(envelope.threadId),
      String(envelope.workspaceId),
      String(envelope.engine),
      String(envelope.source),
      JSON.stringify(envelope),
      ts,
    );
    return Number(result.changes ?? 0) > 0;
  }

  /** 按 seq 倒序读取 raw 并核对父会话归属；损坏记录显式失败。 */
  pageByThread(
    threadId: ThreadId,
    opts?: { beforeSeq?: number | null; limit?: number | null },
  ): { events: RawEngineEventEnvelope[]; nextBeforeSeq: number | null } {
    const limit = Math.max(1, Math.min(2_000, Number(opts?.limit ?? 200)));
    const beforeSeq = Number(opts?.beforeSeq ?? 0);
    const hasBefore = Number.isFinite(beforeSeq) && beforeSeq > 0;

    const thread = this.db.prepare("SELECT workspace_id, engine FROM threads WHERE id = ?").get(String(threadId)) as { workspace_id: string; engine: string } | undefined;
    const rows = (hasBefore
      ? this.db
          .prepare("SELECT seq, workspace_id, engine, event_json FROM raw_engine_events WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
          .all(String(threadId), beforeSeq, limit)
      : this.db
          .prepare("SELECT seq, workspace_id, engine, event_json FROM raw_engine_events WHERE thread_id = ? ORDER BY seq DESC LIMIT ?")
          .all(String(threadId), limit)) as Array<{ seq: number; workspace_id: string; engine: string; event_json: string }>;

    const events: RawEngineEventEnvelope[] = [];
    for (const r of rows) {
      try {
        const event = JSON.parse(String(r.event_json ?? "")) as RawEngineEventEnvelope | null;
        if (!event || typeof event !== "object" || Array.isArray(event) || event.schema !== 1
          || !Number.isSafeInteger(event.seq) || event.seq <= 0 || event.seq !== r.seq || event.threadId !== threadId
          || typeof event.workspaceId !== "string" || !event.workspaceId.trim() || event.workspaceId !== r.workspace_id
          || (event.engine !== "codex" && event.engine !== "claude") || event.engine !== r.engine) {
          throw new Error("原始事件信封身份与记录不符");
        }
        if (!thread || r.workspace_id !== thread.workspace_id || r.engine !== thread.engine) {
          throw new Error("原始事件记录与父会话归属不符");
        }
        if (!Number.isSafeInteger(event.ts) || event.ts < 0 || typeof event.source !== "string" || !event.source.trim()
          || !Object.prototype.hasOwnProperty.call(event, "data") || typeof event.handled !== "boolean"
          || !["mapped", "ignored", "unhandled", "parseError"].includes(event.action)
          || !Array.isArray(event.emittedTypes) || event.emittedTypes.some((type) => typeof type !== "string" || !type.trim())) {
          throw new Error("原始事件基础信封损坏");
        }
        events.push(event);
      } catch (cause) {
        throw new Error(`原始事件读取失败：threadId=${threadId}, seq=${r.seq}`, { cause });
      }
    }
    const nextBeforeSeq = rows.length ? Number(rows[rows.length - 1]!.seq ?? 0) || null : null;
    return { events, nextBeforeSeq };
  }

  /** 按 seq 升序读取某 thread 在指定 seq 之后的 raw 事件。 */
  listByThreadFromSeq(threadId: ThreadId, opts: { fromSeqInclusive: number; limit?: number }): RawEngineEventEnvelope[] {
    const fromSeq = Math.max(1, Math.floor(Number(opts.fromSeqInclusive ?? 0)));
    const limit = Math.max(1, Math.min(5_000, Math.floor(Number(opts.limit ?? 500))));
    const rows = this.db
      .prepare("SELECT event_json FROM raw_engine_events WHERE thread_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?")
      .all(String(threadId), fromSeq, limit) as Array<{ event_json: string }>;

    const out: RawEngineEventEnvelope[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(String(r.event_json ?? "")) as RawEngineEventEnvelope);
      } catch {
        // skip broken row
      }
    }
    return out;
  }

  /**
   * 读取一个线程的运行事实：全部事件时间戳 + 仅工具调用/结果的事件正文。
   * 供节点耗时分解聚合使用；不读取其它事件正文，避免把大体积流式增量拉进内存。
   */
  readThreadRuntimeFacts(threadId: ThreadId): { eventTimestamps: number[]; toolEvents: Array<{ ts: number; json: string }> } {
    const timestampRows = this.runtimeTimestampStmt.all(String(threadId)) as Array<{ ts: unknown }>;
    const toolRows = this.runtimeToolStmt.all(String(threadId)) as Array<{ ts: unknown; event_json: unknown }>;
    return {
      eventTimestamps: timestampRows.map((row) => Number(row.ts)).filter((ts) => Number.isFinite(ts) && ts > 0),
      toolEvents: toolRows.map((row) => ({ ts: Number(row.ts), json: String(row.event_json ?? "") })),
    };
  }

  deleteByWorkspace(workspaceId: WorkspaceId): number {
    const res = this.db.prepare("DELETE FROM raw_engine_events WHERE workspace_id = ?").run(String(workspaceId));
    return Number(res.changes ?? 0);
  }

  deleteByThread(threadId: ThreadId): number {
    const res = this.db.prepare("DELETE FROM raw_engine_events WHERE thread_id = ?").run(String(threadId));
    return Number(res.changes ?? 0);
  }

  deleteAfterSeq(threadId: ThreadId, boundarySeq: number): number {
    const seq = Number(boundarySeq ?? 0);
    if (!Number.isFinite(seq) || seq <= 0) return 0;
    const res = this.db.prepare("DELETE FROM raw_engine_events WHERE thread_id = ? AND seq > ?").run(String(threadId), seq);
    return Number(res.changes ?? 0);
  }

  /** 按会话和任务高水位限量删除原始引擎事件。 */
  deleteByThreadThroughSeq(threadId: ThreadId, throughSeq: number, limit: number): number {
    const seq = normalizeCleanupSeq(throughSeq);
    if (seq === 0) return 0;
    const result = this.deleteByThreadThroughSeqBatchStmt.run(
      String(threadId),
      seq,
      normalizeCleanupBatchSize(limit),
    );
    return Number(result.changes ?? 0);
  }

  /** 按服务端接收时间语义的 seq 主键限量删除，避免扫描和长事务阻塞事件循环。 */
  deleteBeforeSeq(cutoffSeqExclusive: number, limit: number): number {
    const cutoffSeq = Math.floor(Number(cutoffSeqExclusive ?? 0));
    if (!Number.isFinite(cutoffSeq) || cutoffSeq <= 0) return 0;
    const batchSize = Math.max(1, Math.min(1_000, Math.floor(Number(limit ?? 0))));
    const res = this.deleteBeforeSeqBatchStmt.run(cutoffSeq, batchSize);
    return Number(res.changes ?? 0);
  }
}

/** 规整清理高水位；非正安全整数不触发删除。 */
function normalizeCleanupSeq(raw: unknown): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** 限制单条清理语句的行数，避免调用方制造长事务。 */
function normalizeCleanupBatchSize(raw: unknown): number {
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid event cleanup batch size: ${String(raw)}`);
  return Math.min(1_000, value);
}
