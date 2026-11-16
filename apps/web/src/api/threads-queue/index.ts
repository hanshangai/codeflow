import type {
  ApiResult,
  ThreadQueueAppendRequestBody,
  ThreadQueueAppendResponseBody,
  ThreadQueueClearRequestBody,
  ThreadQueueClearResponseBody,
  ThreadQueueListRequestBody,
  ThreadQueueListResponseBody,
  ThreadQueueMoveRequestBody,
  ThreadQueueMoveResponseBody,
  ThreadQueuePauseRequestBody,
  ThreadQueuePauseResponseBody,
  ThreadQueueRemoveRequestBody,
  ThreadQueueRemoveResponseBody,
  ThreadQueueResumeRequestBody,
  ThreadQueueResumeResponseBody,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../request";
import { requestJson } from "../request";

/** 入队（运行中或空闲都可；编排子类型由 server 端拒绝）。 */
export function appendThreadQueueItem(
  ctx: ApiRequestContext,
  body: ThreadQueueAppendRequestBody,
): Promise<ApiResult<ThreadQueueAppendResponseBody>> {
  return requestJson<ThreadQueueAppendResponseBody>(ctx, { method: "POST", path: "/api/threads/queue/append", body });
}

/** 拉取 thread 当前队列快照（活跃项 + 暂停状态）。多端只读。 */
export function listThreadQueue(
  ctx: ApiRequestContext,
  body: ThreadQueueListRequestBody,
): Promise<ApiResult<ThreadQueueListResponseBody>> {
  return requestJson<ThreadQueueListResponseBody>(ctx, { method: "POST", path: "/api/threads/queue/list", body });
}

/** 上移/下移单项（与相邻活跃项交换 position）。 */
export function moveThreadQueueItem(
  ctx: ApiRequestContext,
  body: ThreadQueueMoveRequestBody,
): Promise<ApiResult<ThreadQueueMoveResponseBody>> {
  return requestJson<ThreadQueueMoveResponseBody>(ctx, { method: "POST", path: "/api/threads/queue/move", body });
}

/** 删除单项（attachment 通过外键 cascade 自动清理）。 */
export function removeThreadQueueItem(
  ctx: ApiRequestContext,
  body: ThreadQueueRemoveRequestBody,
): Promise<ApiResult<ThreadQueueRemoveResponseBody>> {
  return requestJson<ThreadQueueRemoveResponseBody>(ctx, { method: "POST", path: "/api/threads/queue/remove", body });
}

/** 清空 thread 全部活跃项。 */
export function clearThreadQueue(
  ctx: ApiRequestContext,
  body: ThreadQueueClearRequestBody,
): Promise<ApiResult<ThreadQueueClearResponseBody>> {
  return requestJson<ThreadQueueClearResponseBody>(ctx, { method: "POST", path: "/api/threads/queue/clear", body });
}

/** 恢复（清暂停 + 立即触发消费下一条）。 */
export function resumeThreadQueue(
  ctx: ApiRequestContext,
  body: ThreadQueueResumeRequestBody,
): Promise<ApiResult<ThreadQueueResumeResponseBody>> {
  return requestJson<ThreadQueueResumeResponseBody>(ctx, { method: "POST", path: "/api/threads/queue/resume", body });
}

/** 暂停（用户主动）。 */
export function pauseThreadQueue(
  ctx: ApiRequestContext,
  body: ThreadQueuePauseRequestBody,
): Promise<ApiResult<ThreadQueuePauseResponseBody>> {
  return requestJson<ThreadQueuePauseResponseBody>(ctx, { method: "POST", path: "/api/threads/queue/pause", body });
}
