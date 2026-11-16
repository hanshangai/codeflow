import type {
  ApiResult,
  BindSharedWorkspaceHostRequestBody,
  BindSharedWorkspaceHostResponseBody,
  CreateSharedWorkspaceRequestBody,
  CreateSharedWorkspaceResponseBody,
  DeleteSharedWorkspaceResponseBody,
  InviteSharedWorkspaceMembersRequestBody,
  InviteSharedWorkspaceMembersResponseBody,
  LeaveSharedWorkspaceResponseBody,
  RemoveSharedWorkspaceMemberResponseBody,
  SharedWorkspaceCloneToPrivateRequestBody,
  SharedWorkspaceAssetMaintenancePolicyResponseBody,
  SharedWorkspaceFileTransfersResponseBody,
  SharedWorkspaceFileTransferPolicyResponseBody,
  SharedWorkspaceFileTransfersQuery,
  SharedWorkspaceInviteCandidatesResponseBody,
  SharedWorkspaceListResponseBody,
  SharedWorkspaceMembersResponseBody,
  UnbindSharedWorkspaceHostResponseBody,
  UpdateSharedWorkspaceAssetMaintenancePolicyRequestBody,
  UpdateSharedWorkspaceFileTransferPolicyRequestBody,
  UpdateSharedWorkspaceRequestBody,
  UpdateSharedWorkspaceResponseBody,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "./request";

function withQuery(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value == null || value === "") return;
    params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

const basePath = "/api/account/enterprise/shared-workspaces";

export function listSharedWorkspaces(
  ctx: ApiRequestContext,
  query?: Record<string, string | number | boolean | undefined | null>,
): Promise<ApiResult<SharedWorkspaceListResponseBody>> {
  return requestJson<SharedWorkspaceListResponseBody>(ctx, {
    method: "GET",
    path: withQuery(basePath, query),
  });
}

export function createSharedWorkspace(
  ctx: ApiRequestContext,
  body: CreateSharedWorkspaceRequestBody,
): Promise<ApiResult<CreateSharedWorkspaceResponseBody>> {
  return requestJson<CreateSharedWorkspaceResponseBody>(ctx, {
    method: "POST",
    path: basePath,
    body,
  });
}

/** 修改共享工作区名称。 */
export function updateSharedWorkspace(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  body: UpdateSharedWorkspaceRequestBody,
  query?: Record<string, string | number | boolean | undefined | null>,
): Promise<ApiResult<UpdateSharedWorkspaceResponseBody>> {
  return requestJson<UpdateSharedWorkspaceResponseBody>(ctx, {
    method: "PATCH",
    path: withQuery(`${basePath}/${encodeURIComponent(sharedWorkspaceId)}`, query),
    body,
  });
}

/** 删除共享关系；query 用于让超管请求保留企业管理作用域。 */
export function deleteSharedWorkspace(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): Promise<ApiResult<DeleteSharedWorkspaceResponseBody>> {
  return requestJson<DeleteSharedWorkspaceResponseBody>(ctx, {
    method: "DELETE",
    path: withQuery(`${basePath}/${encodeURIComponent(sharedWorkspaceId)}`, query),
  });
}

export function bindSharedWorkspaceHost(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  body: BindSharedWorkspaceHostRequestBody,
): Promise<ApiResult<BindSharedWorkspaceHostResponseBody>> {
  return requestJson<BindSharedWorkspaceHostResponseBody>(ctx, {
    method: "POST",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/host/bind`,
    body,
  });
}

/** 请求服务端取消共享工作区 Host 绑定；不会删除 Host 本地资料。 */
export function unbindSharedWorkspaceHost(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
): Promise<ApiResult<UnbindSharedWorkspaceHostResponseBody>> {
  return requestJson<UnbindSharedWorkspaceHostResponseBody>(ctx, {
    method: "POST",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/host/unbind`,
  });
}

export function listSharedWorkspaceMembers(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
): Promise<ApiResult<SharedWorkspaceMembersResponseBody>> {
  return requestJson<SharedWorkspaceMembersResponseBody>(ctx, {
    method: "GET",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/members`,
  });
}

export function listSharedWorkspaceInviteCandidates(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): Promise<ApiResult<SharedWorkspaceInviteCandidatesResponseBody>> {
  return requestJson<SharedWorkspaceInviteCandidatesResponseBody>(ctx, {
    method: "GET",
    path: withQuery(`${basePath}/${encodeURIComponent(sharedWorkspaceId)}/invite-candidates`, query),
  });
}

export function inviteSharedWorkspaceMembers(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  body: InviteSharedWorkspaceMembersRequestBody,
): Promise<ApiResult<InviteSharedWorkspaceMembersResponseBody>> {
  return requestJson<InviteSharedWorkspaceMembersResponseBody>(ctx, {
    method: "POST",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/invites`,
    body,
  });
}

export function leaveSharedWorkspace(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
): Promise<ApiResult<LeaveSharedWorkspaceResponseBody>> {
  return requestJson<LeaveSharedWorkspaceResponseBody>(ctx, {
    method: "POST",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/leave`,
  });
}

/** 请求移除共享工作区普通成员；服务端会保留历史记录并撤销成员访问。 */
export function removeSharedWorkspaceMember(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  memberId: string,
): Promise<ApiResult<RemoveSharedWorkspaceMemberResponseBody>> {
  return requestJson<RemoveSharedWorkspaceMemberResponseBody>(ctx, {
    method: "POST",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/members/${encodeURIComponent(memberId)}/remove`,
  });
}

export function cloneSharedWorkspaceAssetToPrivate(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  body: SharedWorkspaceCloneToPrivateRequestBody,
): Promise<ApiResult<never>> {
  return requestJson<never>(ctx, {
    method: "POST",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/assets/clone-to-private`,
    body,
  });
}

export function getSharedWorkspaceFileTransferPolicy(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
): Promise<ApiResult<SharedWorkspaceFileTransferPolicyResponseBody>> {
  return requestJson<SharedWorkspaceFileTransferPolicyResponseBody>(ctx, {
    method: "GET",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/file-transfer-policy`,
  });
}

export function updateSharedWorkspaceFileTransferPolicy(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  body: UpdateSharedWorkspaceFileTransferPolicyRequestBody,
): Promise<ApiResult<SharedWorkspaceFileTransferPolicyResponseBody>> {
  return requestJson<SharedWorkspaceFileTransferPolicyResponseBody>(ctx, {
    method: "PUT",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/file-transfer-policy`,
    body,
  });
}

export function getSharedWorkspaceAssetMaintenancePolicy(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
): Promise<ApiResult<SharedWorkspaceAssetMaintenancePolicyResponseBody>> {
  return requestJson<SharedWorkspaceAssetMaintenancePolicyResponseBody>(ctx, {
    method: "GET",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/asset-maintenance-policy`,
  });
}

export function updateSharedWorkspaceAssetMaintenancePolicy(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  body: UpdateSharedWorkspaceAssetMaintenancePolicyRequestBody,
): Promise<ApiResult<SharedWorkspaceAssetMaintenancePolicyResponseBody>> {
  return requestJson<SharedWorkspaceAssetMaintenancePolicyResponseBody>(ctx, {
    method: "PUT",
    path: `${basePath}/${encodeURIComponent(sharedWorkspaceId)}/asset-maintenance-policy`,
    body,
  });
}

export function listSharedWorkspaceFileTransfers(
  ctx: ApiRequestContext,
  sharedWorkspaceId: string,
  query?: SharedWorkspaceFileTransfersQuery,
): Promise<ApiResult<SharedWorkspaceFileTransfersResponseBody>> {
  return requestJson<SharedWorkspaceFileTransfersResponseBody>(ctx, {
    method: "GET",
    path: withQuery(`${basePath}/${encodeURIComponent(sharedWorkspaceId)}/file-transfers`, query),
  });
}
