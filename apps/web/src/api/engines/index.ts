import type { GetEnginesStatusResponseBody } from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

/** 获取引擎状态（Claude/Codex 安装、版本、模型提示）。 */
export function getEnginesStatus(ctx: ApiRequestContext, workspaceId?: string, opts?: { signal?: AbortSignal }) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<GetEnginesStatusResponseBody>(ctx, { method: "GET", path: `/api/engines/status${qs}`, signal: opts?.signal });
}


