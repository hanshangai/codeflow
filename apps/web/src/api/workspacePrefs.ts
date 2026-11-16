import type {
  ApiResult,
  GetWorkspacePrefsResponseBody,
  SaveWorkspacePrefsRequestBody,
  SaveWorkspacePrefsResponseBody,
  WorkspacePref,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "./request";
import { requestJson } from "./request";

/** 获取工作区级偏好（workMode 等）。 */
export function getWorkspacePrefs(
  ctx: ApiRequestContext,
  workspaceId: string,
  opts?: { signal?: AbortSignal },
): Promise<ApiResult<GetWorkspacePrefsResponseBody>> {
  const q = encodeURIComponent(workspaceId);
  return requestJson<GetWorkspacePrefsResponseBody>(ctx, { method: "GET", path: `/api/workspaces/prefs?workspaceId=${q}`, signal: opts?.signal });
}

/** 保存工作区级偏好。 */
export function saveWorkspacePrefs(ctx: ApiRequestContext, body: SaveWorkspacePrefsRequestBody): Promise<ApiResult<SaveWorkspacePrefsResponseBody>> {
  return requestJson<SaveWorkspacePrefsResponseBody>(ctx, { method: "POST", path: "/api/workspaces/prefs", body });
}

