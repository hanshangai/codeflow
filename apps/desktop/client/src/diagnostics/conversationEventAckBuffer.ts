import { compressConversationEvents } from "@codeflowai/shared";
import crypto from "node:crypto";
import type { ConversationEventEnvelope, WorkspaceId } from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import { recordWorkspaceEventSeqFloor } from "../db/repos/eventRepo.js";

/** canonical ACK 按可信工作区分组提交，失败组及后续组保留到显式重试。 */
export function createConversationEventAckBuffer(db: ClientDb, opts?: { maxBatchSize?: number; flushDelayMs?: number; onError?: (error: unknown) => void;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T> }) {
  const maxBatchSize = Math.max(10, Math.floor(opts?.maxBatchSize ?? 200));
  const flushDelayMs = Math.max(5, Math.floor(opts?.flushDelayMs ?? 25));
  const queue: ConversationEventEnvelope[] = [];
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;
  let coordinatedFlush: Promise<void> | null = null;
  let disposed = false;
  let strictFailurePending: { error: unknown; workspaceId: WorkspaceId | null } | null = null;

  /** 只读取自有message data生成指纹，不把事件正文或未知getter写入诊断。 */
  const describeFailure = (error: unknown) => {
    const type = error === null ? "null" : typeof error;
    const message = error !== null && (type === "object" || type === "function") ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
    return { type, fingerprint: crypto.createHash("sha256").update(message && "value" in message && typeof message.value === "string" ? message.value : type).digest("hex") };
  };

  /** 同步冲刷接管当前等待，避免失败后仍有旧计时器自动重试。 */
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 同工作区整组原子提交；任一组失败即停，禁止逐条补写改变事务边界。 */
  const flushOnce = (): boolean => {
    if (flushing || queue.length === 0) return false;
    flushing = true;
    clearTimer();
    const batch = queue.splice(0, maxBatchSize);
    const committed = new Set<WorkspaceId>();
    let workspaceId: WorkspaceId | null = null;
    try {
      const groups = new Map<WorkspaceId, ConversationEventEnvelope[]>();
      for (const envelope of batch) {
        const group = groups.get(envelope.workspaceId);
        if (group) group.push(envelope);
        else groups.set(envelope.workspaceId, [envelope]);
      }
      for (const [scope, envelopes] of groups) {
        workspaceId = scope;
        const scoped = db.forWorkspace(scope);
        scoped.db.transaction(() => {
          scoped.conversationEvents.appendEnvelopes(envelopes);
          recordWorkspaceEventSeqFloor(scoped.db, envelopes.reduce((floor, event) => Math.max(floor, event.seq), 0));
        })();
        committed.add(scope);
      }
    } catch (cause) {
      queue.unshift(...batch.filter(event => !committed.has(event.workspaceId)));
      const details = { code: "CONVERSATION_EVENT_ACK_FLUSH_FAILED", requestId: `canonical-ack:${workspaceId}:${batch[0]?.seq}`, workspaceId };
      let failure: unknown = Object.assign(new Error(details.code, { cause }), details);
      try {
        if (!workspaceId) throw new Error("CONVERSATION_EVENT_ACK_WORKSPACE_MISSING");
        db.writeWorkspaceLog(workspaceId, { level: "error", tag: "conversation-events", message: "workspace ACK batch flush failed", data: {
          ...details,
          workspaceId, batchSize: batch.length, pendingCount: queue.length,
          threadIds: [...new Set(batch.filter(event => event.workspaceId === workspaceId).map(event => event.threadId))],
          rootCause: describeFailure(cause),
        } });
      } catch (loggingError) {
        failure = Object.assign(new AggregateError([cause, loggingError], "CONVERSATION_EVENT_ACK_FLUSH_LOG_FAILED", { cause }), { ...details, code: "CONVERSATION_EVENT_ACK_FLUSH_LOG_FAILED" });
      }
      strictFailurePending = { error: failure, workspaceId };
      throw failure;
    } finally {
      flushing = false;
      if (!disposed && !strictFailurePending && queue.length > 0) scheduleImmediateFlush();
    }
    return true;
  };

  /** 显式冲刷一个批次，任一工作区失败都保留未提交组并抛出。 */
  const flush = (): void | Promise<void> => {
    strictFailurePending = null;
    if (opts?.withLegacyDatabase) return flushCoordinated(false);
    flushOnce();
  };

  /** 每批单独申请同步许可，返回 Promise 保留准入/落库失败供原 owner 消费。 */
  const flushCoordinated = (all: boolean): Promise<void> => {
    if (coordinatedFlush) return all ? coordinatedFlush.then(() => flushCoordinated(true)) : coordinatedFlush;
    clearTimer();
    const work = (async () => {
      let written: boolean;
      do { written = await opts!.withLegacyDatabase!(`canonical-ack:${queue[0]?.workspaceId ?? null}`, flushOnce); }
      while (all && written);
    })();
    coordinatedFlush = work;
    void work.then(() => { if (coordinatedFlush === work) coordinatedFlush = null; }, cause => {
      if (coordinatedFlush === work) coordinatedFlush = null;
      if (!strictFailurePending) strictFailurePending = { error: cause, workspaceId: queue[0]?.workspaceId ?? null };
    });
    return work;
  };

  /** 定时故障交原运行边界，失败队列不会继续自动调度。 */
  const flushScheduled = (): void => {
    if (opts?.withLegacyDatabase) {
      void flushCoordinated(false).then(undefined, notifyFailure);
      return;
    }
    try { flushOnce(); }
    catch (error) { notifyFailure(error); }
  };

  /** 定时失败只交原 owner，原队列保留并停止自动重试。 */
  const notifyFailure = (error: unknown): void => {
      try { opts?.onError?.(error); }
      catch (notificationError) {
        const scope = strictFailurePending?.workspaceId ?? null;
        strictFailurePending = { workspaceId: scope, error: Object.assign(new AggregateError([error, notificationError], "CONVERSATION_EVENT_ACK_OWNER_NOTIFICATION_FAILED", { cause: error }), {
          code: "CONVERSATION_EVENT_ACK_OWNER_NOTIFICATION_FAILED", workspaceId: scope, requestId: `canonical-ack:${scope}`,
        }) };
      }
  };

  /** 关闭前严格排空；失败保留未提交事件并向关闭 owner 抛出。 */
  const drain = (): void | Promise<void> => {
    clearTimer();
    strictFailurePending = null;
    if (opts?.withLegacyDatabase) return flushCoordinated(true);
    while (flushOnce()) { /* 同步排空，失败立即中止。 */ }
  };

  /** 达到批量阈值后尽快冲刷，显式失败后等待人工或原 owner 重试。 */
  const scheduleImmediateFlush = () => {
    if (disposed || timer || strictFailurePending) return;
    timer = setTimeout(() => {
      timer = null;
      flushScheduled();
    }, 0);
    timer.unref?.();
  };

  /** 小批量合并等待期间只保留一个计时器。 */
  const scheduleDelayedFlush = () => {
    if (disposed || timer || strictFailurePending) return;
    timer = setTimeout(() => {
      timer = null;
      flushScheduled();
    }, flushDelayMs);
    timer.unref?.();
  };

  return {
    /** 只合并同工作区同会话事件；关闭后的新事件必须显式失败。 */
    enqueue(event: ConversationEventEnvelope): void {
      if (disposed) throw new Error("CONVERSATION_EVENT_ACK_BUFFER_DISPOSED");
      const prev = queue.length > 0 ? queue[queue.length - 1] : null;
      if (prev && prev.workspaceId === event.workspaceId && prev.threadId === event.threadId) {
        const merged = compressConversationEvents([prev, event]);
        if (merged.length === 1) {
          queue[queue.length - 1] = merged[0]!;
        } else {
          queue.push(event);
        }
      } else {
        queue.push(event);
      }
      if (queue.length >= maxBatchSize) {
        scheduleImmediateFlush();
      } else {
        scheduleDelayedFlush();
      }
    },
    flush,
    /** 只观察已失败分组；指定W不会把单W故障扩散给其他工作区。 */
    assertNoFailure(workspaceId?: WorkspaceId): void {
      if (strictFailurePending && (workspaceId === undefined || strictFailurePending.workspaceId === workspaceId)) throw strictFailurePending.error;
    },
    /** 只识别原失败记录的当前身份，供最终owner隔离所属工作区。 */
    isFailure(error: unknown): boolean {
      return strictFailurePending !== null && strictFailurePending.error === error;
    },
    /** 先禁止新输入，再严格提交剩余事件。 */
    dispose(): void | Promise<void> {
      disposed = true;
      return drain();
    },
    /** 返回仍未提交的事件数，包含失败后等待重试的事件。 */
    getPendingCount(): number {
      return queue.length;
    },
  };
}
