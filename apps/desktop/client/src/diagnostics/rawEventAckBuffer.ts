import type { ClientDb } from "../db/clientDb.js";
import crypto from "node:crypto";
import type { RawEngineEventEnvelope, WorkspaceId } from "@codeflowai/shared";
import { recordWorkspaceEventSeqFloor } from "../db/repos/eventRepo.js";

/** 原始 trace ACK 按工作区原子提交，失败时保留整组与后续组。 */
export function createRawEventAckBuffer(db: ClientDb, opts?: { maxBatchSize?: number; flushDelayMs?: number; onError?: (error: unknown) => void;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T> }) {
  const maxBatchSize = Math.max(10, Math.floor(opts?.maxBatchSize ?? 200));
  const flushDelayMs = Math.max(5, Math.floor(opts?.flushDelayMs ?? 25));
  const queue: RawEngineEventEnvelope[] = [];
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;
  let coordinatedFlush: Promise<void> | null = null;
  let disposed = false;
  let strictFailurePending: { error: unknown; workspaceId: WorkspaceId | null } | null = null;

  /** 原始trace不进入诊断；仅自有message data参与不可逆指纹。 */
  const describeFailure = (error: unknown) => {
    const type = error === null ? "null" : typeof error;
    const message = error !== null && (type === "object" || type === "function") ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
    return { type, fingerprint: crypto.createHash("sha256").update(message && "value" in message && typeof message.value === "string" ? message.value : type).digest("hex") };
  };

  /** 同步冲刷接管等待中的计时器。 */
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 首个失败工作区之后停止提交，禁止逐条补写使同组部分生效。 */
  const flushOnce = (): boolean => {
    if (flushing || queue.length === 0) return false;
    flushing = true;
    clearTimer();
    const batch = queue.splice(0, maxBatchSize);
    const committed = new Set<WorkspaceId>();
    let workspaceId: WorkspaceId | null = null;
    try {
      const groups = new Map<WorkspaceId, RawEngineEventEnvelope[]>();
      for (const envelope of batch) {
        const group = groups.get(envelope.workspaceId);
        if (group) group.push(envelope);
        else groups.set(envelope.workspaceId, [envelope]);
      }
      for (const [scope, envelopes] of groups) {
        workspaceId = scope;
        const scoped = db.forWorkspace(scope);
        scoped.db.transaction(() => {
          scoped.rawEvents.appendEnvelopes(envelopes);
          recordWorkspaceEventSeqFloor(scoped.db, envelopes.reduce((floor, event) => Math.max(floor, event.seq), 0));
        })();
        committed.add(scope);
      }
    } catch (cause) {
      queue.unshift(...batch.filter(event => !committed.has(event.workspaceId)));
      const details = { code: "RAW_EVENT_ACK_FLUSH_FAILED", requestId: `raw-ack:${workspaceId}:${batch[0]?.seq}`, workspaceId };
      let failure: unknown = Object.assign(new Error(details.code, { cause }), details);
      try {
        if (!workspaceId) throw new Error("RAW_EVENT_ACK_WORKSPACE_MISSING");
        db.writeWorkspaceLog(workspaceId, { level: "error", tag: "raw-events", message: "workspace ACK batch flush failed", data: {
          ...details,
          workspaceId, batchSize: batch.length, pendingCount: queue.length,
          threadIds: [...new Set(batch.filter(event => event.workspaceId === workspaceId).map(event => event.threadId))],
          rootCause: describeFailure(cause),
        } });
      } catch (loggingError) {
        failure = Object.assign(new AggregateError([cause, loggingError], "RAW_EVENT_ACK_FLUSH_LOG_FAILED", { cause }), { ...details, code: "RAW_EVENT_ACK_FLUSH_LOG_FAILED" });
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
      do { written = await opts!.withLegacyDatabase!(`raw-ack:${queue[0]?.workspaceId ?? null}`, flushOnce); }
      while (all && written);
    })();
    coordinatedFlush = work;
    void work.then(() => { if (coordinatedFlush === work) coordinatedFlush = null; }, cause => {
      if (coordinatedFlush === work) coordinatedFlush = null;
      if (!strictFailurePending) strictFailurePending = { error: cause, workspaceId: queue[0]?.workspaceId ?? null };
    });
    return work;
  };

  /** 后台错误交给原运行边界；没有处理器时显式抛出。 */
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
        strictFailurePending = { workspaceId: scope, error: Object.assign(new AggregateError([error, notificationError], "RAW_EVENT_ACK_OWNER_NOTIFICATION_FAILED", { cause: error }), {
          code: "RAW_EVENT_ACK_OWNER_NOTIFICATION_FAILED", workspaceId: scope, requestId: `raw-ack:${scope}`,
        }) };
      }
  };

  /** 严格排空，错误立即中止关闭步骤且保留队列。 */
  const drain = (): void | Promise<void> => {
    clearTimer();
    strictFailurePending = null;
    if (opts?.withLegacyDatabase) return flushCoordinated(true);
    while (flushOnce()) { /* 同步排空，失败立即中止。 */ }
  };

  /** 大批量立即冲刷，失败后的重试由原 owner 显式触发。 */
  const scheduleImmediateFlush = () => {
    if (disposed || timer || strictFailurePending) return;
    timer = setTimeout(() => {
      timer = null;
      flushScheduled();
    }, 0);
    timer.unref?.();
  };

  /** 小批量只安排一个等待中的冲刷。 */
  const scheduleDelayedFlush = () => {
    if (disposed || timer || strictFailurePending) return;
    timer = setTimeout(() => {
      timer = null;
      flushScheduled();
    }, flushDelayMs);
    timer.unref?.();
  };

  return {
    /** 关闭后新输入显式失败，禁止丢失迟到 trace。 */
    enqueue(event: RawEngineEventEnvelope): void {
      if (disposed) throw new Error("RAW_EVENT_ACK_BUFFER_DISPOSED");
      queue.push(event);
      if (queue.length >= maxBatchSize) {
        scheduleImmediateFlush();
      } else {
        scheduleDelayedFlush();
      }
    },
    flush,
    /** 按原失败W观察，不消费记录或阻断其他工作区的独立入口。 */
    assertNoFailure(workspaceId?: WorkspaceId): void {
      if (strictFailurePending && (workspaceId === undefined || strictFailurePending.workspaceId === workspaceId)) throw strictFailurePending.error;
    },
    /** 最终owner仅按当前原记录识别，外部同code异常不获隔离身份。 */
    isFailure(error: unknown): boolean {
      return strictFailurePending !== null && strictFailurePending.error === error;
    },
    /** 禁止新输入并严格提交剩余 trace。 */
    dispose(): void | Promise<void> {
      disposed = true;
      return drain();
    },
    /** 返回包括失败批次在内的待提交数量。 */
    getPendingCount(): number {
      return queue.length;
    },
  };
}
