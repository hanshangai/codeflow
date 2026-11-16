import type {
  ApiResult,
  CancelWorkspaceDirectoryMigrationRequest,
  DeleteWorkspaceRequestBody,
  GetWorkspaceExecutionProfileResponseBody,
  GetWorkspaceExecutionProfileStatusResponseBody,
  ListWorkspacesResponseBody,
  PrepareWorkspaceDirectoryMigrationRequest,
  StartWorkspaceDirectoryMigrationRequest,
  UpdateWorkspaceExecutionProfileRequestBody,
  UpdateWorkspaceExecutionProfileResponseBody,
  UpsertWorkspaceRequestBody,
  UpsertWorkspaceResponseBody,
  WorkspaceDirectoryMigrationOperationResponse,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../request";
import { requestJson } from "../request";
import { getDesktopBridge } from "../../services/desktop";

/** 离线读取本机目录，联网合并账号权威入口；currentWorkspaceId 保留服务端离线占位语义。 */
export async function listWorkspaces(
  ctx: ApiRequestContext,
  opts?: { signal?: AbortSignal; currentWorkspaceId?: string | null; localOnly?: boolean },
): Promise<ApiResult<ListWorkspacesResponseBody>> {
  const currentWorkspaceId = String(opts?.currentWorkspaceId ?? "").trim();
  const query = currentWorkspaceId ? `?currentWorkspaceId=${encodeURIComponent(currentWorkspaceId)}` : "";
  const request = { method: "GET" as const, path: `/api/workspaces${query}`, signal: opts?.signal };
  const desktop = Boolean(getDesktopBridge());
  const local = await requestJson<ListWorkspacesResponseBody>(ctx, request);
  if (!desktop || !local.ok || opts?.localOnly || !ctx.sessionToken?.trim() || !ctx.webSessionId) return local;
  const account = await requestJson<ListWorkspacesResponseBody>(ctx, { ...request, serverOnly: true });
  if (!account.ok) return account;
  const workspaces = new Map(local.workspaces.map(workspace => [workspace.id, workspace]));
  for (const workspace of account.workspaces) workspaces.set(workspace.id, workspace);
  return { ...account, workspaces: [...workspaces.values()] };
}

export function upsertWorkspace(
  ctx: ApiRequestContext,
  body: UpsertWorkspaceRequestBody,
): Promise<ApiResult<UpsertWorkspaceResponseBody>> {
  return requestJson<UpsertWorkspaceResponseBody>(ctx, { method: "POST", path: "/api/workspaces/upsert", body });
}

export function deleteWorkspace(ctx: ApiRequestContext, body: DeleteWorkspaceRequestBody): Promise<ApiResult<{}>> {
  return requestJson<{}>(ctx, { method: "POST", path: "/api/workspaces/delete", body });
}

/** 创建或复用目录迁移预检操作；Server 返回 202 时仍按统一 ApiResult 处理。 */
export function prepareWorkspaceDirectoryMigration(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  body: PrepareWorkspaceDirectoryMigrationRequest,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestJson<WorkspaceDirectoryMigrationOperationResponse>(ctx, {
    method: "POST",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/directory-migrations`,
    body,
  });
}

/** 查询 Client 权威迁移详情，用于重开弹窗和重连后的状态收敛。 */
export function getWorkspaceDirectoryMigration(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  operationId: string,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestJson<WorkspaceDirectoryMigrationOperationResponse>(ctx, {
    method: "GET",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/directory-migrations/${encodeURIComponent(operationId)}`,
  });
}

/** 请求开始目录迁移；Server 负责共享保留、权威复检和 start fencing。 */
export function startWorkspaceDirectoryMigration(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  operationId: string,
  body: StartWorkspaceDirectoryMigrationRequest,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestJson<WorkspaceDirectoryMigrationOperationResponse>(ctx, {
    method: "POST",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/directory-migrations/${encodeURIComponent(operationId)}/start`,
    body,
  });
}

/** 取消提交点前的迁移；成功响应表示 Worker 与临时目录已安全收敛。 */
export function cancelWorkspaceDirectoryMigration(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  operationId: string,
  body: CancelWorkspaceDirectoryMigrationRequest,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestJson<WorkspaceDirectoryMigrationOperationResponse>(ctx, {
    method: "POST",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/directory-migrations/${encodeURIComponent(operationId)}/cancel`,
    body,
  });
}

/** 触发 recovery_required 的证据复核；不允许 Web 指定前滚或回源方向。 */
export function recoverWorkspaceDirectoryMigration(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  operationId: string,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestJson<WorkspaceDirectoryMigrationOperationResponse>(ctx, {
    method: "POST",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/directory-migrations/${encodeURIComponent(operationId)}/recover`,
    body: {},
  });
}

/** 读取当前工作区我的执行 Profile。 */
export function getWorkspaceExecutionProfile(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
): Promise<ApiResult<GetWorkspaceExecutionProfileResponseBody>> {
  return requestJson<GetWorkspaceExecutionProfileResponseBody>(ctx, {
    method: "GET",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/me/execution-profile`,
  });
}

/** 保存当前工作区我的执行 Profile。 */
export function updateWorkspaceExecutionProfile(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  body: UpdateWorkspaceExecutionProfileRequestBody,
): Promise<ApiResult<UpdateWorkspaceExecutionProfileResponseBody>> {
  return requestJson<UpdateWorkspaceExecutionProfileResponseBody>(ctx, {
    method: "POST",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/me/execution-profile`,
    body,
  });
}

/** 查询当前工作区成员 Profile 状态；不返回 Profile 全文。 */
export function getWorkspaceExecutionProfileStatus(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  userIds?: string[],
): Promise<ApiResult<GetWorkspaceExecutionProfileStatusResponseBody>> {
  const query = userIds?.length ? `?userIds=${encodeURIComponent(userIds.join(","))}` : "";
  return requestJson<GetWorkspaceExecutionProfileStatusResponseBody>(ctx, {
    method: "GET",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/execution-profile-status${query}`,
  });
}
