import type {
  GetCodeflowaiConfigResponseBody,
  SetCodeflowaiConfigRequestBody,
  SetCodeflowaiConfigResponseBody,
  WorkspaceId,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

/** 读取 codeflowai.json（由 Client 实际落盘）。 */
export function getCodeflowaiConfig(ctx: ApiRequestContext, workspaceId: WorkspaceId) {
  const q = encodeURIComponent(String(workspaceId));
  return requestJson<GetCodeflowaiConfigResponseBody>(ctx, { method: "GET", path: `/api/codeflowai/config?workspaceId=${q}` });
}

/** 写入 codeflowai.json（由 Client 实际落盘）。 */
export function setCodeflowaiConfig(ctx: ApiRequestContext, body: SetCodeflowaiConfigRequestBody) {
  return requestJson<SetCodeflowaiConfigResponseBody>(ctx, { method: "POST", path: "/api/codeflowai/config", body });
}


