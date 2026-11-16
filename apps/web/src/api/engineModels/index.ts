import type {
  DeleteEngineCustomModelRequestBody,
  EngineCustomModelEntry,
  ListEngineCustomModelsResponseBody,
  UpsertEngineCustomModelRequestBody,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

/** 列出当前 Client 的自定义模型目录。 */
export function listEngineCustomModels(ctx: ApiRequestContext, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<ListEngineCustomModelsResponseBody>(ctx, { method: "GET", path: `/api/engine-keys/models${qs}` });
}

/** 新增或更新当前 Client 的自定义模型。 */
export function upsertEngineCustomModel(ctx: ApiRequestContext, body: UpsertEngineCustomModelRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<{ ok: boolean; model?: EngineCustomModelEntry }>(ctx, { method: "POST", path: `/api/engine-keys/models${qs}`, body });
}

/** 删除当前 Client 的自定义模型。 */
export function deleteEngineCustomModel(ctx: ApiRequestContext, body: DeleteEngineCustomModelRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<{ ok: boolean }>(ctx, { method: "POST", path: `/api/engine-keys/models/delete${qs}`, body });
}
