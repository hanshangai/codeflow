import { createHash, randomUUID } from "node:crypto";
import type {
  ConversationEventEnvelope, ConversationEventInput, RawEngineEventEnvelope, RawEngineEventInput, ThreadId,
} from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import { reserveClientEventSeqs, readWorkspaceEventSeqFloor, recordWorkspaceEventSeqFloor } from "../db/repos/eventRepo.js";
import { persistFrozenFileAfterSnapshot, persistFrozenFileBeforeSnapshot,
  type FrozenFileAfterSnapshot, type FrozenFileBeforeSnapshot } from "../eventIndex/fileChangeSnapshots.js";

export type LocalEventInput =
  | { t: "conversation.event"; event: ConversationEventInput; beforeSnapshots?: FrozenFileBeforeSnapshot[]; afterSnapshots?: FrozenFileAfterSnapshot[] }
  | { t: "raw.event"; event: RawEngineEventInput };
export type LocalEventMessage =
  | { t: "conversation.event"; event: ConversationEventEnvelope }
  | { t: "raw.event"; event: RawEngineEventEnvelope };

export type LocalEventBatch = {
  batchId: string;
  writerEpoch?: string;
  batchOrdinal?: number;
  workspaceId: ConversationEventInput["workspaceId"];
  ownerGeneration: number;
  turnId?: string | null;
  events: LocalEventInput[];
};
export type LocalEventCommitReceipt = {
  batchId: string;
  digest: string;
  messages: LocalEventMessage[];
  indexedCount: number;
  indexedThroughSeq: number;
  localThreadIds?: ThreadId[];
};
type StoredReceipt = { digest: string; seqs: number[]; indexedCount: number; ownerGeneration: number;
  kinds: LocalEventInput["t"][]; threadId: string; turnId?: string | null; pendingEvents?: LocalEventInput[]; databaseIndexed?: boolean;
  writerEpoch?: string; batchOrdinal?: number; confirmed?: boolean };
const RECEIPT_PREFIX = "local_event_batch:";
const PENDING_BATCH = "local_event_batch_pending";
const READY_SEQ = "local_event_ready_seq";
const RECEIPT_RETIREMENT = "local_event_receipt_retirement";
const RETAINED_RECEIPTS = 128;
type ReceiptRetirement = { writerEpoch: string; retiredThrough: number; ranges: Array<[number, number]> };

/** 同一启动epoch按W派生批次命名空间，避免Writer全局batch映射混合不同工作区的ordinal。 */
export function scopeLocalEventWriterEpoch(epoch: string, workspaceId: string): string {
  return `${epoch}-${createHash("sha256").update(workspaceId).digest("hex")}`;
}

/** 退休区间只表示已经确认且回收的批次，不能用于推进事件序号或跳过未确认批次。 */
function readReceiptRetirement(db: ClientDb): ReceiptRetirement | null {
  const row = db.db.prepare("SELECT value FROM meta WHERE key=?").get(RECEIPT_RETIREMENT) as { value: string } | undefined;
  if (!row) return null;
  const value = JSON.parse(row.value) as ReceiptRetirement;
  if (typeof value.writerEpoch !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(value.writerEpoch)
    || !Number.isSafeInteger(value.retiredThrough) || value.retiredThrough < 0
    || !Array.isArray(value.ranges) || value.ranges.length > RETAINED_RECEIPTS
    || value.ranges.some(range => !Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0])
      || !Number.isSafeInteger(range[1]) || range[0] <= value.retiredThrough || range[1] < range[0])) throw new Error("LOCAL_EVENT_RECEIPT_RETIREMENT_INVALID");
  return value;
}

/** 合并乱序确认留下的稀疏区间；区间过多时显式阻断，禁止无界增长。 */
function retireReceiptOrdinal(state: ReceiptRetirement, ordinal: number): void {
  const ranges = [...state.ranges, [ordinal, ordinal] as [number, number]].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    if (range[1] <= state.retiredThrough) continue;
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  while (merged[0]?.[0] === state.retiredThrough + 1) state.retiredThrough = merged.shift()![1];
  if (merged.length > RETAINED_RECEIPTS) throw new Error("LOCAL_EVENT_RECEIPT_RETIREMENT_CAPACITY_EXCEEDED");
  state.ranges = merged;
}

/** 回执只保存身份与序号；正文继续由原事件仓储持有。 */
function readReceipt(db: ClientDb, batchId: string): StoredReceipt | null {
  const row = db.db.prepare("SELECT value FROM meta WHERE key=?").get(RECEIPT_PREFIX + batchId) as { value: string } | undefined;
  if (!row) return null;
  const value = JSON.parse(row.value) as StoredReceipt;
  if (typeof value.digest !== "string" || !Array.isArray(value.seqs) || !value.seqs.length
    || value.seqs.some(seq => !Number.isSafeInteger(seq) || seq <= 0)
    || !Array.isArray(value.kinds) || value.kinds.length !== value.seqs.length || !value.threadId
    || value.kinds.some(kind => kind !== "raw.event" && kind !== "conversation.event")
    || !Number.isSafeInteger(value.indexedCount) || value.indexedCount < 0 || value.indexedCount > value.seqs.length
    || !Number.isSafeInteger(value.ownerGeneration) || value.ownerGeneration < 0
    || value.confirmed !== undefined && typeof value.confirmed !== "boolean"
    || (value.writerEpoch !== undefined || value.batchOrdinal !== undefined)
      && (!/^[A-Za-z0-9-]{1,128}$/u.test(value.writerEpoch ?? "") || !Number.isSafeInteger(value.batchOrdinal) || value.batchOrdinal! < 1)) throw new Error("LOCAL_EVENT_BATCH_RECEIPT_INVALID");
  return value;
}

/** 重试从原正文读回，已裁剪/删除的事件只报失效，不能凭请求副本复活。 */
function readReceiptMessages(db: ClientDb, stored: StoredReceipt): LocalEventMessage[] {
  return stored.seqs.map((seq, index) => {
    const kind = stored.kinds[index]!;
    const table = kind === "raw.event" ? "raw_engine_events" : "conversation_events";
    const row = db.db.prepare(`SELECT event_json FROM ${table} WHERE seq=? AND thread_id=?`).get(seq, stored.threadId) as { event_json: string } | undefined;
    if (!row) throw new Error("LOCAL_EVENT_BATCH_REVOKED");
    const persisted = JSON.parse(row.event_json) as LocalEventMessage["event"];
    const event = stored.pendingEvents?.[index]
      ? { ...stored.pendingEvents[index]!.event, schema: 1, seq } as LocalEventMessage["event"]
      : kind === "conversation.event" ? db.conversationEvents.getEnvelopeBySeq(stored.threadId, seq) : persisted;
    if (!event) throw new Error("LOCAL_EVENT_BATCH_REVOKED");
    if (event.seq !== seq || event.threadId !== stored.threadId || event.workspaceId !== db.workspaceId) throw new Error("LOCAL_EVENT_BATCH_RECEIPT_INVALID");
    return { t: kind, event } as LocalEventMessage;
  });
}

type PipelineWriter = {
  createBatchIdentity?(workspaceId: LocalEventBatch["workspaceId"]): Pick<LocalEventBatch, "batchId" | "writerEpoch" | "batchOrdinal">;
  confirmBatch?(workspaceId: LocalEventBatch["workspaceId"], batchId: string): Promise<void>;
  submit(batch: LocalEventBatch): Promise<LocalEventCommitReceipt>;
  indexDatabase?(workspaceId: LocalEventBatch["workspaceId"], batchId: string): Promise<void | { localThreadIds?: ThreadId[] }>;
  completeIndexes(workspaceId: LocalEventBatch["workspaceId"], batchId: string, indexedCount: number): Promise<number>;
  withLegacyDatabase<T>(requestId: string, operation: () => T): Promise<T>;
  failIndexes(workspaceId: LocalEventBatch["workspaceId"], batchId: string, cause: unknown): void;
};
type PipelineBatch = { batch: LocalEventBatch; bytes: number; done: Promise<void>; resolve(): void; reject(cause: unknown): void };

/** 原事件入口的有界组批与提交屏障；同步入队仅准入，flush才确认正文和索引。 */
export function createLocalEventPipeline(input: {
  writer: PipelineWriter;
  apply(message: LocalEventMessage): void;
  applyBatch?(receipt: LocalEventCommitReceipt, workspaceId: LocalEventBatch["workspaceId"]): Promise<void>;
  publish(message: LocalEventMessage): void;
  publishBatch?(messages: LocalEventMessage[], workspaceId: LocalEventBatch["workspaceId"], batchId: string): Promise<void>;
  onFailure(cause: unknown, batch: LocalEventBatch): void;
}) {
  const queued = new Map<string, PipelineBatch>();
  const pending = new Set<PipelineBatch>();
  const tails = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let closing = false, totalEvents = 0, totalBytes = 0;

  /** 发布后解除同回合顺序尾链；原批次仍持有确认，flush/close等待完整done。 */
  const run = async (item: PipelineBatch, onPublished?: () => void): Promise<void> => {
    let receipt: LocalEventCommitReceipt | undefined, indexesCompleted = false;
    try {
      if (failures.has(item.batch.workspaceId)) throw failures.get(item.batch.workspaceId);
      receipt = await input.writer.submit(item.batch);
      if (failures.has(item.batch.workspaceId)) throw failures.get(item.batch.workspaceId);
      if (input.writer.indexDatabase) {
        const indexed = await input.writer.indexDatabase(item.batch.workspaceId, item.batch.batchId);
        if (indexed?.localThreadIds) receipt.localThreadIds = indexed.localThreadIds;
      }
      if (failures.has(item.batch.workspaceId)) throw failures.get(item.batch.workspaceId);
      if (input.applyBatch) {
        await input.applyBatch(receipt, item.batch.workspaceId);
        await input.writer.completeIndexes(item.batch.workspaceId, item.batch.batchId, receipt.messages.length);
      } else {
        for (let index = receipt.indexedCount; index < receipt.messages.length; index++) {
          await input.writer.withLegacyDatabase(`event-index:${item.batch.batchId}:${index}`, () => input.apply(receipt!.messages[index]!));
          await input.writer.completeIndexes(item.batch.workspaceId, item.batch.batchId, index + 1);
        }
      }
      indexesCompleted = true;
      if (failures.has(item.batch.workspaceId)) throw failures.get(item.batch.workspaceId);
      if (input.publishBatch) await input.publishBatch(receipt.messages, item.batch.workspaceId, item.batch.batchId);
      else await input.writer.withLegacyDatabase(`event-publish:${item.batch.batchId}`, () => {
        for (const message of receipt!.messages) input.publish(message);
      });
      onPublished?.();
      if (input.writer.confirmBatch) await input.writer.confirmBatch(item.batch.workspaceId, item.batch.batchId);
      item.resolve();
      pending.delete(item);
    } catch (cause) {
      let failure = cause;
      if (receipt && !indexesCompleted) {
        try { input.writer.failIndexes(item.batch.workspaceId, item.batch.batchId, cause); }
        catch (error) { failure = new AggregateError([cause, error], "LOCAL_EVENT_PIPELINE_FAILURE_RECORD_FAILED", { cause }); }
      }
      if (!failures.has(item.batch.workspaceId)) {
        failures.set(item.batch.workspaceId, failure);
        try { input.onFailure(failure, item.batch); }
        catch (error) { failure = new AggregateError([failure, error], "LOCAL_EVENT_PIPELINE_DIAGNOSTIC_FAILED", { cause: failure }); failures.set(item.batch.workspaceId, failure); }
      }
      item.reject(failure);
      pending.delete(item);
    } finally {
      totalEvents -= item.batch.events.length; totalBytes -= item.bytes;
      onPublished?.();
    }
  };

  /** tails只串行到发布；确认的完整任务由pending中的原批次done持有。 */
  const dispatch = (key: string, item: PipelineBatch, full = false): void => {
    if (tails.has(key) && !full) return;
    queued.delete(key);
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.then(() => new Promise<void>(resolve => { void run(item, resolve); }));
    tails.set(key, next);
    void next.then(() => {
      if (tails.get(key) === next) { tails.delete(key); flushQueued(); }
    });
  };
  /** 下一轮事件循环封批；不把普通数据等待延迟加到控制命令上。 */
  const flushQueued = (): void => {
    if (scheduled) clearImmediate(scheduled);
    scheduled = undefined;
    for (const [key, item] of queued) dispatch(key, item);
  };
  /** 以接收时的固定待提交集合建立屏障，迟到事件不会改变本次等待目标。 */
  const flush = async (workspaceId?: string, threadId?: string): Promise<void> => {
    flushQueued();
    await Promise.all([...pending].filter(item => (!workspaceId || item.batch.workspaceId === workspaceId)
      && (!threadId || item.batch.events[0]!.event.threadId === threadId)).map(item => item.done));
    if (workspaceId && failures.has(workspaceId)) throw failures.get(workspaceId);
    if (!workspaceId && failures.size) throw failures.values().next().value;
  };
  return {
    /** 恢复读取尚未取得batch时冻结所属W；日志由调用边界负责，保留首次失败根因。 */
    failWorkspace(workspaceId: string, cause: unknown): void { if (!failures.has(workspaceId)) failures.set(workspaceId, cause); },
    /** 失败属于原W owner，后续请求不能把未就绪数据当可用快照。 */
    assertNoFailure(workspaceId: string): void { if (failures.has(workspaceId)) throw failures.get(workspaceId); },
    /** 高水位等待已接收批次释放容量；其他W的失败仍由其onFailure/flush负责，不转嫁给调用W。 */
    waitForCapacity(workspaceId: string): Promise<void> | undefined {
      if (closing) throw new Error("LOCAL_EVENT_PIPELINE_CLOSING");
      if (failures.has(workspaceId)) throw failures.get(workspaceId);
      if (totalEvents < 2048 && totalBytes < 32 * 1024 * 1024) return undefined;
      flushQueued();
      return Promise.allSettled([...pending].map(item => item.done)).then(() => {
        if (failures.has(workspaceId)) throw failures.get(workspaceId);
      });
    },
    /** 启动恢复必须使用耐久原batchId和原载荷，不能为已提交事件重新分号。 */
    async recover(batch: LocalEventBatch): Promise<void> {
      if (closing || queued.size || pending.size) throw new Error("LOCAL_EVENT_RECOVERY_NOT_IDLE");
      const bytes = Buffer.byteLength(JSON.stringify(batch), "utf8");
      if (bytes > 128 * 1024 * 1024 || batch.events.length > 8192) throw new Error("LOCAL_EVENT_PIPELINE_CAPACITY_EXCEEDED");
      let resolve!: () => void, reject!: (cause: unknown) => void;
      const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void done.then(undefined, () => undefined);
      const item = { batch, bytes, done, resolve, reject };
      totalBytes += bytes; totalEvents += batch.events.length; pending.add(item);
      await run(item); await done;
    },
    /** 原调用方同步得到准入或明确超限；不修改事件载荷，批次归属固定。 */
    enqueue(message: LocalEventInput, turnId: string | null, ownerGeneration: number): void {
      if (closing) throw new Error("LOCAL_EVENT_PIPELINE_CLOSING");
      const workspaceId = message.event.workspaceId;
      if (failures.has(workspaceId)) throw failures.get(workspaceId);
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (totalEvents >= 8192 || totalBytes + bytes > 128 * 1024 * 1024) throw new Error("LOCAL_EVENT_PIPELINE_CAPACITY_EXCEEDED");
      const key = JSON.stringify([workspaceId, message.event.threadId, turnId, ownerGeneration]);
      let item = queued.get(key);
      if (item && (item.batch.events.length >= 64 || Buffer.byteLength(JSON.stringify({ ...item.batch, events: [...item.batch.events, message] }), "utf8") > 256 * 1024)) {
        dispatch(key, item, true); item = undefined;
      }
      if (!item) {
        let resolve!: () => void, reject!: (cause: unknown) => void;
        const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        // 失败由onFailure与flush/close共同拥有，屏障安装前不产生全局拒绝。
        void done.then(undefined, () => undefined);
        const identity = input.writer.createBatchIdentity?.(workspaceId) ?? { batchId: randomUUID() };
        item = { batch: { ...identity, workspaceId, ownerGeneration, turnId, events: [] }, bytes: 0, done, resolve, reject };
        queued.set(key, item); pending.add(item);
      }
      item.batch.events.push(structuredClone(message)); item.bytes += bytes; totalEvents++; totalBytes += bytes;
      if (!scheduled) scheduled = setImmediate(flushQueued);
    },
    flush,
    /** 关闭停止新准入并等待所有提交及索引；失败不能当作清空成功。 */
    async close(): Promise<void> { closing = true; await flush(); },
  };
}

/** 对相同输入生成稳定回执，禁止跨工作区和混合线程的批次。 */
function describeBatch(batch: LocalEventBatch): string {
  if (!batch.batchId || batch.batchId.length > 200 || !Number.isSafeInteger(batch.ownerGeneration) || batch.ownerGeneration < 0
    || !batch.events.length || batch.events.length > 8192) throw new Error("LOCAL_EVENT_BATCH_INVALID");
  if ((batch.writerEpoch !== undefined || batch.batchOrdinal !== undefined)
    && (!/^[A-Za-z0-9-]{1,128}$/u.test(batch.writerEpoch ?? "") || !Number.isSafeInteger(batch.batchOrdinal) || batch.batchOrdinal! < 1
      || batch.batchId !== `${batch.writerEpoch}:${batch.batchOrdinal}`)) throw new Error("LOCAL_EVENT_BATCH_IDENTITY_INVALID");
  const threadId = batch.events[0]!.event.threadId;
  for (const message of batch.events) {
    if (!["raw.event", "conversation.event"].includes(message.t) || message.event.workspaceId !== batch.workspaceId
      || message.event.threadId !== threadId) throw new Error("LOCAL_EVENT_BATCH_SCOPE_INVALID");
  }
  return createHash("sha256").update(JSON.stringify({ batchId: batch.batchId, workspaceId: batch.workspaceId,
    ownerGeneration: batch.ownerGeneration, turnId: batch.turnId ?? null, events: batch.events })).digest("hex");
}

/** 桌面事件先取得 W 写锁，再耐久预留应用序号；正文与 W 下界提交后才运行原索引。 */
export function createLocalEventPersistence(input: {
  db: ClientDb;
  writerEpoch?: string;
  applyConversation(event: ConversationEventEnvelope): void;
  applyRaw(event: RawEngineEventEnvelope): void;
}) {
  const writerEpoch = input.writerEpoch ?? randomUUID();
  const synchronousOrdinals = new Map<string, number>();
  const activatedWorkspaces = new Set<string>();
  /** 在一个W事务写正文与回执；A预留独立提交，重试读取原批次。 */
  const commitBatch = (batch: LocalEventBatch): LocalEventCommitReceipt => {
    const digest = describeBatch(batch);
    const workspace = input.db.forWorkspace(batch.workspaceId);
    return workspace.withWorkspaceCoreRepos(batch.workspaceId, () => {
      const stored = workspace.db.transaction(() => {
        const existing = readReceipt(workspace, batch.batchId);
        if (existing) {
          if (existing.digest !== digest) throw new Error("LOCAL_EVENT_BATCH_CONFLICT");
          return existing;
        }
        let retirement = readReceiptRetirement(workspace);
        if (batch.writerEpoch) {
          if (batch.writerEpoch !== writerEpoch && batch.writerEpoch !== scopeLocalEventWriterEpoch(writerEpoch, batch.workspaceId)) throw new Error("LOCAL_EVENT_BATCH_RETIRED");
          if (retirement?.writerEpoch !== batch.writerEpoch) {
            if (activatedWorkspaces.has(batch.workspaceId)) throw new Error("LOCAL_EVENT_WRITER_EPOCH_RETIRED");
            retirement = { writerEpoch: batch.writerEpoch, retiredThrough: 0, ranges: [] };
            workspace.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
              .run(RECEIPT_RETIREMENT, JSON.stringify(retirement));
          }
          if (batch.batchOrdinal! <= retirement.retiredThrough
            || retirement.ranges.some(([from, to]) => batch.batchOrdinal! >= from && batch.batchOrdinal! <= to)) throw new Error("LOCAL_EVENT_BATCH_RETIRED");
        } else if (retirement) throw new Error("LOCAL_EVENT_BATCH_RETIRED");
        const pending = workspace.db.prepare("SELECT value FROM meta WHERE key=?").get(PENDING_BATCH) as { value: string } | undefined;
        if (pending) throw new Error("LOCAL_EVENT_INDEX_PENDING");
        const seqs = reserveClientEventSeqs(input.db.applicationDb, batch.events.length, {
          requireOutermost: true, minimumSeqExclusive: readWorkspaceEventSeqFloor(workspace.db),
        });
        for (let index = 0; index < batch.events.length; index++) {
          const message = batch.events[index]!;
          if (message.t === "conversation.event") for (const frozen of message.beforeSnapshots ?? []) {
            if (frozen.workspaceId !== batch.workspaceId || frozen.threadId !== message.event.threadId || frozen.turnId !== batch.turnId) throw new Error("LOCAL_EVENT_SNAPSHOT_SCOPE_INVALID");
            persistFrozenFileBeforeSnapshot(workspace, frozen);
          }
          if (message.t === "conversation.event") workspace.conversationEvents.appendEnvelope({ ...message.event, schema: 1, seq: seqs[index]! }, { requireInsert: true });
          else workspace.rawEvents.appendEnvelope({ ...message.event, schema: 1, seq: seqs[index]! }, { requireInsert: true });
        }
        recordWorkspaceEventSeqFloor(workspace.db, seqs[seqs.length - 1]!);
        const receipt: StoredReceipt = { digest, seqs, indexedCount: 0, ownerGeneration: batch.ownerGeneration,
          writerEpoch: batch.writerEpoch, batchOrdinal: batch.batchOrdinal, confirmed: false,
          kinds: batch.events.map(message => message.t), threadId: batch.events[0]!.event.threadId,
          pendingEvents: batch.events,
          ...(batch.turnId !== undefined ? { turnId: batch.turnId } : {}) };
        workspace.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(RECEIPT_PREFIX + batch.batchId, JSON.stringify(receipt));
        workspace.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(PENDING_BATCH, batch.batchId);
        return receipt;
      }, { mode: "immediate", requireOutermost: true })();
      if (stored.writerEpoch === writerEpoch || stored.writerEpoch === scopeLocalEventWriterEpoch(writerEpoch, batch.workspaceId)) activatedWorkspaces.add(batch.workspaceId);
      return { batchId: batch.batchId, digest, indexedCount: stored.indexedCount,
        indexedThroughSeq: stored.indexedCount ? stored.seqs[stored.indexedCount - 1]! : 0,
        messages: readReceiptMessages(workspace, stored),
      };
    });
  };
  /** 仅发布owner确认后回收完整回执；旧未确认记录保留，旧ID命中退休标记即失败。 */
  const confirmBatch = (workspaceId: LocalEventBatch["workspaceId"], batchId: string): void => {
    const workspace = input.db.forWorkspace(workspaceId);
    workspace.withWorkspaceCoreRepos(workspaceId, () => workspace.db.transaction(() => {
      const stored = readReceipt(workspace, batchId);
      if (!stored) throw new Error("LOCAL_EVENT_BATCH_RETIRED");
      if (stored.indexedCount !== stored.seqs.length) throw new Error("LOCAL_EVENT_CONFIRM_BEFORE_INDEX");
      stored.confirmed = true;
      delete stored.pendingEvents;
      workspace.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(stored), RECEIPT_PREFIX + batchId);
      const confirmed = (workspace.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'local_event_batch:%' AND json_extract(value,'$.confirmed')=1 ORDER BY CAST(json_extract(value,'$.seqs[#-1]') AS INTEGER) DESC").all() as Array<{ key: string; value: string }>);
      const retirement = readReceiptRetirement(workspace);
      for (const row of confirmed.slice(RETAINED_RECEIPTS)) {
        const receipt = JSON.parse(row.value) as StoredReceipt;
        if (!retirement) continue;
        if (receipt.writerEpoch === retirement.writerEpoch) retireReceiptOrdinal(retirement, receipt.batchOrdinal!);
        workspace.db.prepare("DELETE FROM meta WHERE key=?").run(row.key);
      }
      if (retirement) workspace.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(retirement), RECEIPT_RETIREMENT);
    }, { mode: "immediate", requireOutermost: true })());
  };
  /** 索引owner完成后原子推进本批进度；未完成批次阻止该W后续发布。 */
  const completeBatchIndexes = (workspaceId: LocalEventBatch["workspaceId"], batchId: string, indexedCount: number, inTransaction = false): number => {
    const workspace = input.db.forWorkspace(workspaceId);
    return workspace.withWorkspaceCoreRepos(workspaceId, () => workspace.db.transaction(() => {
      const stored = readReceipt(workspace, batchId);
      if (!stored || !Number.isSafeInteger(indexedCount) || indexedCount < stored.indexedCount || indexedCount > stored.seqs.length) {
        throw new Error("LOCAL_EVENT_INDEX_PROGRESS_INVALID");
      }
      stored.indexedCount = indexedCount;
      workspace.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(stored), RECEIPT_PREFIX + batchId);
      if (indexedCount === stored.seqs.length) {
        const ready = stored.seqs[indexedCount - 1]!;
        workspace.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(meta.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)")
          .run(READY_SEQ, String(ready));
        workspace.db.prepare("DELETE FROM meta WHERE key=? AND value=?").run(PENDING_BATCH, batchId);
      }
      return indexedCount ? stored.seqs[indexedCount - 1]! : 0;
    }, inTransaction ? undefined : { mode: "immediate", requireOutermost: true })());
  };
  /** 显式旧批次保留幂等回执且不自动确认；生产pipeline和单条persist使用epoch与有界确认。 */
  const persistBatch = (batch: LocalEventBatch): LocalEventCommitReceipt => {
    const workspace = input.db.forWorkspace(batch.workspaceId);
    return workspace.withWorkspaceCoreRepos(batch.workspaceId, () => {
      const receipt = commitBatch(batch);
      for (let index = receipt.indexedCount; index < receipt.messages.length; index++) {
        const message = receipt.messages[index]!;
        if (message.t === "conversation.event") input.applyConversation(message.event);
        else input.applyRaw(message.event);
        receipt.indexedThroughSeq = completeBatchIndexes(batch.workspaceId, batch.batchId, index + 1);
        receipt.indexedCount = index + 1;
      }
      // 无epoch旧同步合同以回调完成为完成；新pipeline的确认仍由发布owner持有。
      if (!batch.writerEpoch) confirmBatch(batch.workspaceId, batch.batchId);
      return receipt;
    });
  };
  return {
    commitBatch,
    persistBatch,
    completeBatchIndexes,
    confirmBatch,
    /** 后置数据库索引及阶段回执同事务，正文已提交的证据不会因索引失败回滚。 */
    indexDatabase(workspaceId: LocalEventBatch["workspaceId"], batchId: string, apply: (db: ClientDb, message: LocalEventMessage) => void): LocalEventMessage[] {
      const workspace = input.db.forWorkspace(workspaceId);
      return workspace.withWorkspaceCoreRepos(workspaceId, () => workspace.db.transaction(() => {
        const stored = readReceipt(workspace, batchId);
        if (!stored) throw new Error("LOCAL_EVENT_BATCH_RECEIPT_INVALID");
        const messages = readReceiptMessages(workspace, stored);
        if (stored.databaseIndexed) return messages;
        for (const message of messages) apply(workspace, message);
        stored.databaseIndexed = true;
        workspace.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(stored), RECEIPT_PREFIX + batchId);
        return messages;
      }, { mode: "immediate", requireOutermost: true })());
    },
    /** 原证据与进度同事务；调用方已取得最外层排他锁时复用其事务，不二次获取写锁。 */
    applyBatchEffects(workspaceId: LocalEventBatch["workspaceId"], batchId: string, apply: (message: LocalEventMessage) => void, inTransaction = false): void {
      const workspace = input.db.forWorkspace(workspaceId);
      workspace.withWorkspaceCoreRepos(workspaceId, () => workspace.db.transaction(() => {
        const stored = readReceipt(workspace, batchId);
        if (!stored) throw new Error("LOCAL_EVENT_BATCH_RECEIPT_INVALID");
        const messages = readReceiptMessages(workspace, stored);
        for (let index = stored.indexedCount; index < messages.length; index++) {
          const message = messages[index]!;
          if (message.t === "conversation.event") {
            const event = message.event;
            const completion = event.type === "item.tool.completed" ? event.payload
              : event.type === "item.subagent.childEvent" && event.payload.innerEventType === "item.tool.completed" ? event.payload.innerPayload : null;
            if (completion) {
              const original = stored.pendingEvents?.[index];
              const snapshots = original?.t === "conversation.event" ? original.afterSnapshots : undefined;
              if (!snapshots) throw new Error("LOCAL_EVENT_FILE_EFFECT_EVIDENCE_MISSING");
              const itemId = `${event.type === "item.subagent.childEvent" ? "sub_" : ""}${String((completion as { itemId?: unknown }).itemId ?? "")}`;
              for (const frozen of snapshots) {
                if (frozen.workspaceId !== workspaceId || frozen.threadId !== event.threadId
                  || frozen.turnId !== stored.turnId || frozen.itemId !== itemId) throw new Error("LOCAL_EVENT_SNAPSHOT_SCOPE_INVALID");
                const turn = workspace.turns.get(frozen.turnId);
                if (!turn || turn.workspaceId !== workspaceId || turn.threadId !== event.threadId
                  || turn.engine !== event.engine) throw new Error("LOCAL_EVENT_SNAPSHOT_TURN_INVALID");
                persistFrozenFileAfterSnapshot(workspace, frozen);
              }
            }
          }
          apply(message);
        }
        completeBatchIndexes(workspaceId, batchId, messages.length, true);
      }, inTransaction ? undefined : { mode: "immediate", requireOutermost: true })());
    },
    /** 按正文提交顺序恢复未确认批次，包括索引完成但尚未发布的批次。 */
    readPendingBatch(workspaceId: LocalEventBatch["workspaceId"]): LocalEventBatch | null {
      const workspace = input.db.forWorkspace(workspaceId);
      return workspace.withWorkspaceCoreRepos(workspaceId, () => {
        const indexedPending = workspace.db.prepare("SELECT value FROM meta WHERE key=?").get(PENDING_BATCH) as { value: string } | undefined;
        if (indexedPending && !readReceipt(workspace, indexedPending.value)) throw new Error("LOCAL_EVENT_BATCH_RECEIPT_INVALID");
        const pending = workspace.db.prepare("SELECT key FROM meta WHERE key LIKE 'local_event_batch:%' AND (json_extract(value,'$.confirmed')=0 OR key=?) ORDER BY CAST(json_extract(value,'$.seqs[0]') AS INTEGER) ASC LIMIT 1")
          .get(indexedPending ? RECEIPT_PREFIX + indexedPending.value : "") as { key: string } | undefined;
        if (!pending) return null;
        const batchId = pending.key.slice(RECEIPT_PREFIX.length);
        const stored = readReceipt(workspace, batchId);
        if (!stored) throw new Error("LOCAL_EVENT_BATCH_RECEIPT_INVALID");
        const identity = stored.writerEpoch ? { writerEpoch: stored.writerEpoch, batchOrdinal: stored.batchOrdinal } : {};
        if (stored.pendingEvents) return { batchId, ...identity, workspaceId, ownerGeneration: stored.ownerGeneration,
          ...(stored.turnId !== undefined ? { turnId: stored.turnId } : {}), events: structuredClone(stored.pendingEvents) };
        return { batchId, ...identity, workspaceId, ownerGeneration: stored.ownerGeneration,
          ...(stored.turnId !== undefined ? { turnId: stored.turnId } : {}),
          events: readReceiptMessages(workspace, stored).map(message => {
            const { seq: _seq, schema: _schema, ...event } = message.event;
            return { t: message.t, event } as LocalEventInput;
          }),
        };
      });
    },
    /** 普通读取只认业务索引已完成的水位；未确认批次不得被快照越过。 */
    readReadyThroughSeq(workspaceId: LocalEventBatch["workspaceId"]): number {
      const workspace = input.db.forWorkspace(workspaceId);
      return workspace.withWorkspaceCoreRepos(workspaceId, () => {
        if (workspace.db.prepare("SELECT 1 FROM meta WHERE key=?").get(PENDING_BATCH)) throw new Error("LOCAL_EVENT_INDEX_PENDING");
        return readWorkspaceEventSeqFloor(workspace.db);
      });
    },
    /** 提交和提交后索引共用同步短连接；返回前完成关闭，远程投递仍由原边界确认。 */
    persist(message: LocalEventInput): LocalEventMessage {
      const workspaceId = message.event.workspaceId;
      const batchOrdinal = (synchronousOrdinals.get(workspaceId) ?? 0) + 1;
      synchronousOrdinals.set(workspaceId, batchOrdinal);
      const batchId = `${writerEpoch}:${batchOrdinal}`;
      return input.db.withWorkspaceCoreRepos(workspaceId, () => {
        const receipt = persistBatch({ batchId, writerEpoch, batchOrdinal, workspaceId, ownerGeneration: 0, events: [message] });
        confirmBatch(workspaceId, batchId);
        return receipt.messages[0]!;
      });
    },
  };
}
