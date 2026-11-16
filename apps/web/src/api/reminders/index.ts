import type {
  ApiResult,
  IgnoreReminderItemsRequestBody,
  IgnoreReminderItemsResponseBody,
  ListWorkspaceReminderItemsResponseBody,
  ListWorkspaceReminderSummariesResponseBody,
  MarkReminderReadRequestBody,
  MarkReminderReadResponseBody,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../request";
import { requestJson } from "../request";

export function listWorkspaceReminderSummaries(
  ctx: ApiRequestContext,
  opts?: { signal?: AbortSignal },
): Promise<ApiResult<ListWorkspaceReminderSummariesResponseBody>> {
  return requestJson<ListWorkspaceReminderSummariesResponseBody>(ctx, {
    method: "GET",
    path: "/api/reminders/workspaces",
    signal: opts?.signal,
  });
}

export function listWorkspaceReminderItems(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  opts?: { signal?: AbortSignal },
): Promise<ApiResult<ListWorkspaceReminderItemsResponseBody>> {
  return requestJson<ListWorkspaceReminderItemsResponseBody>(ctx, {
    method: "POST",
    path: "/api/reminders/items",
    body: { workspaceId },
    signal: opts?.signal,
  });
}

export function markReminderRead(
  ctx: ApiRequestContext,
  body: MarkReminderReadRequestBody,
): Promise<ApiResult<MarkReminderReadResponseBody>> {
  return requestJson<MarkReminderReadResponseBody>(ctx, {
    method: "POST",
    path: "/api/reminders/mark-read",
    body,
  });
}

export function ignoreReminderItems(
  ctx: ApiRequestContext,
  body: IgnoreReminderItemsRequestBody,
): Promise<ApiResult<IgnoreReminderItemsResponseBody>> {
  return requestJson<IgnoreReminderItemsResponseBody>(ctx, {
    method: "POST",
    path: "/api/reminders/ignore",
    body,
  });
}
