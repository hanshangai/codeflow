import type {
  ActivateEngineKeyRequestBody,
  DeactivateEngineKeyRequestBody,
  DeleteEngineKeyRequestBody,
  EngineKeyEntry,
  ListEngineKeysResponseBody,
  TestEngineKeyRequestBody,
  TestEngineKeyResponseBody,
  UpsertEngineKeyRequestBody,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "./request";

/** 列出所有引擎 Key。 */
export function listEngineKeys(ctx: ApiRequestContext, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<ListEngineKeysResponseBody>(ctx, { method: "GET", path: `/api/engine-keys${qs}` });
}

/** 新增或更新引擎 Key。 */
export function upsertEngineKey(ctx: ApiRequestContext, body: UpsertEngineKeyRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<{ ok: boolean; key?: EngineKeyEntry }>(ctx, { method: "POST", path: `/api/engine-keys${qs}`, body });
}

/** 使用待保存的 Key 配置做一次最小模型请求，验证凭据和 Base URL。 */
export function testEngineKey(ctx: ApiRequestContext, body: TestEngineKeyRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<TestEngineKeyResponseBody>(ctx, { method: "POST", path: `/api/engine-keys/test${qs}`, body });
}

/** 删除引擎 Key。 */
export function deleteEngineKey(ctx: ApiRequestContext, body: DeleteEngineKeyRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<{ ok: boolean }>(ctx, { method: "POST", path: `/api/engine-keys/delete${qs}`, body });
}

/** 激活引擎 Key（切换当前使用的 Key）。 */
export function activateEngineKey(ctx: ApiRequestContext, body: ActivateEngineKeyRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<{ ok: boolean; key?: EngineKeyEntry }>(ctx, { method: "POST", path: `/api/engine-keys/activate${qs}`, body });
}

/** 停用引擎 Key（取消当前默认）。 */
export function deactivateEngineKey(ctx: ApiRequestContext, body: DeactivateEngineKeyRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<{ ok: boolean; key?: EngineKeyEntry }>(ctx, { method: "POST", path: `/api/engine-keys/deactivate${qs}`, body });
}

