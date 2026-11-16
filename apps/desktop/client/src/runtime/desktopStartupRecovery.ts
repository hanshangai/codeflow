import { snapshotDesktopStartupMode, type DesktopStartupMode } from "@codeflowai/shared";

export type DesktopStartupOperation = {
  requestId: string;
  signal: AbortSignal;
  fail(cause: unknown, stage: "scheduled_tasks" | "queue" | "orchestration"): void;
};
export type DesktopStartupHooks = { recoverLocalEvents?(): Promise<void>; recover(operation: DesktopStartupOperation): void };

/** 启动环境必须完整且规范；未知模式或半空身份不能自动放行。 */
export function readDesktopStartupMode(mode: string | undefined, continuationId: string | undefined): DesktopStartupMode {
  if ((mode === undefined || mode === "automatic") && continuationId === undefined) return { mode: "automatic" };
  return snapshotDesktopStartupMode({ mode, continuationId });
}

/** 只登记既有恢复owner，不等待长期业务结束，也不保存另一份执行状态。 */
export function createDesktopStartupRecovery(input: {
  scheduler: {
    start(operation?: { requestId: string; fail(cause: unknown): void }): void;
    syncAndTick(reason: string, requestId?: string): Promise<void>;
    isIsolatedLocalConfigScanFailure(error: unknown): boolean;
    isIsolatedAccountRequestScanFailure?(error: unknown): boolean;
  };
  recoverLocalEvents?(): Promise<void>;
  recoverQueue(): void | Promise<void>;
  recoverOrchestrations(): Promise<void>;
}): DesktopStartupHooks {
  return {
    recoverLocalEvents: input.recoverLocalEvents,
    /** 只隔离原调度器已明确失败的安全扫描，其余拒绝交同一生命周期关闭。 */
    recover(operation) {
      operation.signal.throwIfAborted();
      input.scheduler.start({ requestId: operation.requestId, fail: cause => operation.fail(cause, "scheduled_tasks") });
      void input.scheduler.syncAndTick("desktop.ready", operation.requestId).then(undefined, cause => {
        // 仅隔离已安全记录的本机坏配置或桌面账号请求；原timer后续重新扫描。
        if (!input.scheduler.isIsolatedLocalConfigScanFailure(cause) && !input.scheduler.isIsolatedAccountRequestScanFailure?.(cause)) operation.fail(cause, "scheduled_tasks");
      });
      operation.signal.throwIfAborted();
      /** 队列准入可能等待Writer；它完成前不能启动后续编排恢复。 */
      const recoverOrchestrations = (): void => {
        operation.signal.throwIfAborted();
        void input.recoverOrchestrations().then(undefined, cause => operation.fail(cause, "orchestration"));
      };
      const queue = input.recoverQueue();
      if (queue) void queue.then(recoverOrchestrations, cause => operation.fail(cause, "queue"))
        .then(undefined, cause => operation.fail(cause, "orchestration"));
      else recoverOrchestrations();
    },
  };
}
