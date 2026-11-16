import type { WorkspaceId } from "@codeflowai/shared";
import { workspaceIdsReferToSameWorkspace } from "@codeflowai/shared";

import type { ApiRequestContext } from "../api/request";

type ReminderRefreshStore = {
  refreshCurrentWorkspace(ctx: ApiRequestContext, workspaceId: WorkspaceId, opts?: { signal?: AbortSignal }): Promise<void>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

/** 合批当前工作区变更；异步失败必须交回调用者的错误边界。 */
export function createReminderRefreshCoordinator(input: {
  store: ReminderRefreshStore | null | undefined;
  getApiContext: () => ApiRequestContext;
  getCurrentWorkspaceId: () => WorkspaceId | string | null | undefined;
  onError?: (error: unknown, workspaceId: WorkspaceId | string | null | undefined) => void;
  delayMs?: number;
  schedule?: (cb: () => void, delayMs: number) => TimerHandle;
  clear?: (handle: TimerHandle) => void;
}) {
  const delayMs = Math.max(0, Math.floor(input.delayMs ?? 120));
  const schedule = input.schedule ?? ((cb, waitMs) => setTimeout(cb, waitMs));
  const clear = input.clear ?? ((handle) => clearTimeout(handle));

  let timer: TimerHandle | null = null;
  let inFlight: Promise<void> | null = null;
  let inFlightController: AbortController | null = null;
  let rerunRequested = false;
  const pendingWorkspaceIds = new Set<string>();

  /** 事件只刷新当前可见 workspace，避免单个变更触发账号下全量 workspace 扫描。 */
  const flush = async (): Promise<void> => {
    if (!input.store) {
      pendingWorkspaceIds.clear();
      rerunRequested = false;
      return;
    }

    const currentWorkspaceId = String(input.getCurrentWorkspaceId() ?? "").trim() as WorkspaceId | "";
    const shouldRefreshCurrentWorkspace = currentWorkspaceId
      ? Array.from(pendingWorkspaceIds).some((workspaceId) =>
        workspaceIdsReferToSameWorkspace(workspaceId as WorkspaceId, currentWorkspaceId))
      : false;
    pendingWorkspaceIds.clear();
    rerunRequested = false;

    if (shouldRefreshCurrentWorkspace && currentWorkspaceId) {
      await input.store.refreshCurrentWorkspace(input.getApiContext(), currentWorkspaceId, { signal: inFlightController?.signal });
    }
  };

  /** 自动刷新失败交给拥有 UI 和日志的边界，不伪装刷新成功。 */
  const run = (): void => {
    timer = null;
    if (inFlight || pendingWorkspaceIds.size === 0) return;

    const workspaceId = input.getCurrentWorkspaceId();
    inFlightController = new AbortController();
    inFlight = (async () => {
      try {
        await flush();
      } catch (error) {
        if (!input.onError) throw error;
        input.onError(error, workspaceId);
      } finally {
        inFlight = null;
        inFlightController = null;
        if (pendingWorkspaceIds.size > 0 || rerunRequested) {
          queue();
        }
      }
    })();
  };

  const queue = (): void => {
    if (timer || inFlight || pendingWorkspaceIds.size === 0) return;
    timer = schedule(run, delayMs);
  };

  const enqueue = (workspaceId: WorkspaceId | string | null | undefined): void => {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    if (!normalizedWorkspaceId) return;
    pendingWorkspaceIds.add(normalizedWorkspaceId);
    if (inFlight) {
      rerunRequested = true;
      return;
    }
    queue();
  };

  /** 最后需求离开时连同列表 HTTP 一起取消，迟到响应不得写回。 */
  const cancel = (): void => {
    inFlightController?.abort();
    pendingWorkspaceIds.clear();
    rerunRequested = false;
    if (timer) {
      clear(timer);
      timer = null;
    }
  };

  return {
    enqueue,
    cancel,
  };
}
