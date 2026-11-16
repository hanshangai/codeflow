import type {
  ApiResult,
  CancelWorkspaceDirectoryMigrationRequest,
  PrepareWorkspaceDirectoryMigrationRequest,
  StartWorkspaceDirectoryMigrationRequest,
  WorkspaceDirectoryMigrationOperation,
  WorkspaceDirectoryMigrationOperationResponse,
  WorkspaceId,
} from "@codeflowai/shared";

import { requestDesktopApi } from "../../services/desktop";
import { createBrowserUuid } from "../../utils/browserUuid";

/** 桌面单机模式直连内置 Client，不经过 Server 会话。 */
export function prepareLocalWorkspaceDirectoryMigration(
  workspaceId: WorkspaceId,
  body: PrepareWorkspaceDirectoryMigrationRequest,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestDesktopApi({ method: "workspaceDirectoryMigration.prepare", body: { ...body, workspaceId } });
}

export function getLocalWorkspaceDirectoryMigration(
  workspaceId: WorkspaceId,
  operationId: string,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestDesktopApi({ method: "workspaceDirectoryMigration.get", body: { workspaceId, operationId } });
}

export function cancelLocalWorkspaceDirectoryMigration(
  workspaceId: WorkspaceId,
  operationId: string,
  body: CancelWorkspaceDirectoryMigrationRequest = {},
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestDesktopApi({ method: "workspaceDirectoryMigration.cancel", body: { workspaceId, operationId, reason: body.reason } });
}

export function recoverLocalWorkspaceDirectoryMigration(
  workspaceId: WorkspaceId,
  operationId: string,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  return requestDesktopApi({ method: "workspaceDirectoryMigration.recover", body: { workspaceId, operationId } });
}

const RUNNING_MIGRATION_STATES = new Set<WorkspaceDirectoryMigrationOperation["state"]>([
  "preparing", "copying", "verifying", "publish_intent", "target_ready", "path_committed", "finalizing",
]);

/** 已接受或正在执行的迁移不应重复启动。 */
function isAcceptedOrRunning(operation: WorkspaceDirectoryMigrationOperation): boolean {
  return operation.startDisposition === "accepted" || RUNNING_MIGRATION_STATES.has(operation.state);
}

/** 按 Client 原 prepareStart → executeStart 协议启动，并在结果未知时按权威状态收敛。 */
export async function startLocalWorkspaceDirectoryMigration(
  workspaceId: WorkspaceId,
  operationId: string,
  body: StartWorkspaceDirectoryMigrationRequest,
): Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>> {
  const startAttemptId = createBrowserUuid();
  const prepared = await requestDesktopApi<WorkspaceDirectoryMigrationOperationResponse>({
    method: "workspaceDirectoryMigration.prepareStart",
    body: {
      workspaceId, operationId, startAttemptId,
      externalWritesPausedConfirmed: body.externalWritesPausedConfirmed === true,
      targetNotSyncManagedConfirmed: body.targetNotSyncManagedConfirmed === true,
    },
  });
  if (!prepared.ok) return prepared;
  if (prepared.operation.startDisposition !== "prepared" || prepared.operation.startAttemptId !== startAttemptId) {
    return { ok: false, code: "WORKSPACE_MIGRATION_STATE_CONFLICT", message: "Client 未返回匹配的 prepared start attempt" };
  }
  try {
    return await requestDesktopApi<WorkspaceDirectoryMigrationOperationResponse>({
      method: "workspaceDirectoryMigration.executeStart",
      body: { workspaceId, operationId, startAttemptId, expectedStateVersion: prepared.operation.stateVersion },
    });
  } catch (error) {
    const current = await requestDesktopApi<WorkspaceDirectoryMigrationOperationResponse>({
      method: "workspaceDirectoryMigration.get",
      body: { workspaceId, operationId },
    });
    if (current.ok && isAcceptedOrRunning(current.operation)) return current;
    if (current.ok && current.operation.startDisposition === "prepared" && current.operation.startAttemptId === startAttemptId) {
      await requestDesktopApi({
        method: "workspaceDirectoryMigration.fenceStart",
        body: { workspaceId, operationId, startAttemptId, expectedStateVersion: current.operation.stateVersion },
      });
      return { ok: false, code: "WORKSPACE_MIGRATION_STATE_CONFLICT", message: "启动结果已完成 fencing，请重试开始迁移" };
    }
    throw error;
  }
}
