import type { ThreadId, WorkspaceId } from "@codeflowai/shared";
import crypto from "node:crypto";

import type { ClientDb } from "../db/clientDb.js";

/** touch 的幂等维度包含物理工作区，同名会话不会合并。 */
export function createThreadTouchBuffer(db: ClientDb, opts?: { flushDelayMs?: number; onError?: (error: unknown) => void;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T> }) {
  const flushDelayMs = Math.max(50, Math.floor(opts?.flushDelayMs ?? 1_000));
  const pending = new Map<string, { workspaceId: WorkspaceId; threadId: ThreadId; updatedAt: number }>();
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;
  let coordinatedFlush: Promise<void> | null = null;
  let disposed = false;
  let strictFailurePending: { error: unknown; workspaceId: WorkspaceId | null } | null = null;

  /** 活动诊断仅保自有message指纹，未知getter或正文不能进入日志。 */
  const describeFailure = (error: unknown) => {
    const type = error === null ? "null" : typeof error;
    const message = error !== null && (type === "object" || type === "function") ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
    return { type, fingerprint: crypto.createHash("sha256").update(message && "value" in message && typeof message.value === "string" ? message.value : type).digest("hex") };
  };

  /** 同步冲刷接管当前延迟任务。 */
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 每个工作区整组写入，某组失败则保留该组与后续组。 */
  const flushOnce = (): boolean => {
    if (flushing || pending.size === 0) return false;
    flushing = true;
    clearTimer();
    const rows = [...pending.entries()];
    let workspaceId: WorkspaceId | null = null;
    try {
      const groups = new Map<WorkspaceId, typeof rows>();
      for (const entry of rows) {
        const group = groups.get(entry[1].workspaceId);
        if (group) group.push(entry);
        else groups.set(entry[1].workspaceId, [entry]);
      }
      for (const [scope, entries] of groups) {
        workspaceId = scope;
        const scoped = db.forWorkspace(scope);
        scoped.db.transaction(() => scoped.threads.touchMany(entries.map(([, row]) => row)))();
        for (const [key, row] of entries) if (pending.get(key) === row) pending.delete(key);
      }
    } catch (cause) {
      const details = { code: "THREAD_TOUCH_FLUSH_FAILED", requestId: `thread-touch:${workspaceId}`, workspaceId };
      let failure: unknown = Object.assign(new Error(details.code, { cause }), details);
      try {
        if (!workspaceId) throw new Error("THREAD_TOUCH_WORKSPACE_MISSING");
        db.writeWorkspaceLog(workspaceId, { level: "error", tag: "thread-touch", message: "workspace touch batch flush failed", data: {
          ...details,
          workspaceId, batchSize: rows.length, pendingCount: pending.size,
          threadIds: rows.filter(([, row]) => row.workspaceId === workspaceId).map(([, row]) => row.threadId),
          rootCause: describeFailure(cause),
        } });
      } catch (loggingError) {
        failure = Object.assign(new AggregateError([cause, loggingError], "THREAD_TOUCH_FLUSH_LOG_FAILED", { cause }), { ...details, code: "THREAD_TOUCH_FLUSH_LOG_FAILED" });
      }
      strictFailurePending = { error: failure, workspaceId };
      throw failure;
    } finally {
      flushing = false;
      if (!disposed && !strictFailurePending && pending.size > 0) scheduleDelayedFlush();
    }
    return true;
  };

  /** 显式严格冲刷；任何未落库项都会保留并抛错。 */
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
      do { written = await opts!.withLegacyDatabase!(`thread-touch:${pending.values().next().value?.workspaceId ?? null}`, flushOnce); }
      while (all && written);
    })();
    coordinatedFlush = work;
    void work.then(() => { if (coordinatedFlush === work) coordinatedFlush = null; }, cause => {
      if (coordinatedFlush === work) coordinatedFlush = null;
      if (!strictFailurePending) strictFailurePending = { error: cause, workspaceId: pending.values().next().value?.workspaceId ?? null };
    });
    return work;
  };

  /** 定时故障交原运行边界，保留失败队列等待显式重试。 */
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
        strictFailurePending = { workspaceId: scope, error: Object.assign(new AggregateError([error, notificationError], "THREAD_TOUCH_OWNER_NOTIFICATION_FAILED", { cause: error }), {
          code: "THREAD_TOUCH_OWNER_NOTIFICATION_FAILED", workspaceId: scope, requestId: `thread-touch:${scope}`,
        }) };
      }
  };

  /** 关闭前严格排空，失败立即交回关闭 owner。 */
  const drain = (): void | Promise<void> => {
    clearTimer();
    strictFailurePending = null;
    if (opts?.withLegacyDatabase) return flushCoordinated(true);
    while (flushOnce()) { /* 同步排空，失败立即中止。 */ }
  };

  /** 关键活动立即合并冲刷，只允许一个等待任务。 */
  const scheduleImmediateFlush = () => {
    if (disposed || timer || strictFailurePending) return;
    timer = setTimeout(() => {
      timer = null;
      flushScheduled();
    }, 0);
    timer.unref?.();
  };

  /** 普通活动延迟合并，失败后停止自动重试。 */
  const scheduleDelayedFlush = () => {
    if (disposed || timer || strictFailurePending) return;
    timer = setTimeout(() => {
      timer = null;
      flushScheduled();
    }, flushDelayMs);
    timer.unref?.();
  };

  return {
    /** root 调用必须携可信工作区；固定视图可以沿其物理作用域入队。 */
    enqueue(threadId: ThreadId, updatedAt: number, opts?: { urgent?: boolean; workspaceId?: WorkspaceId }): void {
      if (disposed) throw new Error("THREAD_TOUCH_BUFFER_DISPOSED");
      const workspaceId = opts?.workspaceId ?? db.workspaceId;
      if (!workspaceId) throw new Error("THREAD_TOUCH_WORKSPACE_SCOPE_REQUIRED");
      if (db.workspaceId && db.workspaceId !== workspaceId) throw new Error("THREAD_TOUCH_WORKSPACE_SCOPE_MISMATCH");
      const nextUpdatedAt = Number(updatedAt ?? Date.now());
      if (!Number.isSafeInteger(nextUpdatedAt) || nextUpdatedAt < 0) throw new Error("THREAD_TOUCH_TIMESTAMP_INVALID");
      const key = JSON.stringify([workspaceId, threadId]);
      const previous = pending.get(key)?.updatedAt ?? 0;
      pending.set(key, { workspaceId, threadId, updatedAt: Math.max(previous, nextUpdatedAt) });
      if (opts?.urgent) {
        scheduleImmediateFlush();
      } else {
        scheduleDelayedFlush();
      }
    },
    flush,
    /** 保留原分组失败供入口观察；显式flush成功才清除。 */
    assertNoFailure(workspaceId?: WorkspaceId): void {
      if (strictFailurePending && (workspaceId === undefined || strictFailurePending.workspaceId === workspaceId)) throw strictFailurePending.error;
    },
    /** 与原失败记录比身份，不反射异常或创建并行状态。 */
    isFailure(error: unknown): boolean {
      return strictFailurePending !== null && strictFailurePending.error === error;
    },
    /** 关闭后不接新活动，剩余活动必须全部持久化。 */
    dispose(): void | Promise<void> {
      disposed = true;
      return drain();
    },
    /** 统计未提交的工作区与会话组合数。 */
    getPendingCount(): number {
      return pending.size;
    },
  };
}
