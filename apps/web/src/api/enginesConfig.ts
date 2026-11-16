import type { GetEnginesConfigResponseBody, SetEngineConfigRequestBody } from "@codeflowai/shared";
import { requestJson, type ApiRequestContext } from "./request";

/** 读取两个引擎的凭据配置（API Key / Base URL）。 */
export function getEnginesConfig(ctx: ApiRequestContext, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<GetEnginesConfigResponseBody>(ctx, { method: "GET", path: `/api/engines/config${qs}` });
}

/** 设置指定引擎的凭据配置。 */
export function setEngineConfig(ctx: ApiRequestContext, body: SetEngineConfigRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<{ ok: boolean }>(ctx, { method: "POST", path: `/api/engines/config${qs}`, body });
}

