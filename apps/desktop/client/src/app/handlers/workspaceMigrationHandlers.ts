import {
  WORKSPACE_DIRECTORY_MIGRATION_ERROR_HTTP_STATUS,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import {
  WorkspaceDirectoryMigrationRepoError,
} from "../../db/repos/workspaceDirectoryMigrationRepo.js";
import { WorkspaceMigrationServiceError } from "../../workspace-migration/workspaceMigrationService.js";
import { toWorkspaceDirectoryMigrationOperation } from "../../workspace-migration/workspaceMigrationView.js";
import { logger } from "../../logger.js";

/** 迁移请求只许可同步归属与响应投影，Worker与服务等待在许可外执行。 */
function withMigrationDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 处理迁移准备请求；返回扫描已排队的 operation。 */
export async function handleWorkspaceMigrationPrepare(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = String(body.workspaceId ?? "").trim() as WorkspaceId;
  const idempotencyKey = String(body.idempotencyKey ?? "").trim();
  const targetParentPath = String(body.targetParentPath ?? "").trim();
  const targetDirectoryName = String(body.targetDirectoryName ?? "").trim();
  if (!workspaceId || !idempotencyKey || !targetParentPath || !targetDirectoryName) {
    sendMigrationError(ctx, req, 400, "WORKSPACE_MIGRATION_TARGET_INVALID", "参数错误：workspaceId/idempotencyKey/targetParentPath/targetDirectoryName");
    return;
  }
  try {
    const service = requireService(ctx);
    const operation = await service.prepare({
      requestId: req.id,
      workspaceId,
      idempotencyKey,
      targetParentPath,
      targetDirectoryName,
    });
    await withMigrationDatabase(ctx, req.id, () => sendOperation(ctx, req, operation, 202));
  } catch (error) {
    sendMigrationFailure(ctx, req, error);
  }
}

/** 处理迁移事实查询；workspaceId 不匹配时按 not found 隔离。 */
export function handleWorkspaceMigrationGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const operationId = String(body.operationId ?? "").trim();
  const workspaceId = String(body.workspaceId ?? "").trim() as WorkspaceId;
  if (!operationId || !workspaceId) {
    sendMigrationError(ctx, req, 400, "WORKSPACE_MIGRATION_NOT_FOUND", "参数错误：workspaceId/operationId");
    return;
  }
  try {
    const operation = ctx.db.workspaceDirectoryMigrations.require(operationId);
    if (operation.workspaceId !== workspaceId) throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_NOT_FOUND", "迁移操作不属于当前工作区", { operationId, workspaceId });
    sendOperation(ctx, req, operation);
  } catch (error) {
    sendMigrationFailure(ctx, req, error);
  }
}

/** 原子登记 Server 生成的 prepared start attempt。 */
export function handleWorkspaceMigrationPrepareStart(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  try {
    const body = requireOperationBody(req);
    requireStartAttemptId(body);
    assertOperationWorkspace(ctx, body.operationId, body.workspaceId);
    const operation = requireService(ctx).prepareStartAttempt({
      operationId: body.operationId,
      startAttemptId: body.startAttemptId,
      externalWritesPausedConfirmed: body.externalWritesPausedConfirmed === true,
      targetNotSyncManagedConfirmed: body.targetNotSyncManagedConfirmed === true,
    });
    sendOperation(ctx, req, operation);
  } catch (error) {
    sendMigrationFailure(ctx, req, error);
  }
}

/** 接受 prepared attempt 并返回已进入 preparing 的权威 operation。 */
export function handleWorkspaceMigrationExecuteStart(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  try {
    const body = requireOperationBody(req);
    requireStartAttemptId(body);
    assertOperationWorkspace(ctx, body.operationId, body.workspaceId);
    const operation = requireService(ctx).executeStart({
      requestId: req.id,
      operationId: body.operationId,
      startAttemptId: body.startAttemptId,
      expectedStateVersion: requireVersion(body.expectedStateVersion),
    });
    sendOperation(ctx, req, operation);
  } catch (error) {
    sendMigrationFailure(ctx, req, error);
  }
}

/** fence 结果未知的 prepared attempt。 */
export function handleWorkspaceMigrationFenceStart(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  try {
    const body = requireOperationBody(req);
    requireStartAttemptId(body);
    assertOperationWorkspace(ctx, body.operationId, body.workspaceId);
    const operation = requireService(ctx).fenceStartAttempt({
      operationId: body.operationId,
      startAttemptId: body.startAttemptId,
      expectedStateVersion: requireVersion(body.expectedStateVersion),
    });
    sendOperation(ctx, req, operation);
  } catch (error) {
    sendMigrationFailure(ctx, req, error);
  }
}

/** 取消提交点前迁移并等待 Worker/临时目录收敛。 */
export async function handleWorkspaceMigrationCancel(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  try {
    const body = requireOperationBody(req);
    await withMigrationDatabase(ctx, req.id, () => assertOperationWorkspace(ctx, body.operationId, body.workspaceId));
    const operation = await requireService(ctx).cancel({
      requestId: req.id,
      operationId: body.operationId,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    await withMigrationDatabase(ctx, req.id, () => sendOperation(ctx, req, operation));
  } catch (error) {
    sendMigrationFailure(ctx, req, error);
  }
}

/** 重试 recovery_required 的证据复核；不接受 Web 强制选源/目标。 */
export async function handleWorkspaceMigrationRecover(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  try {
    const body = requireOperationBody(req);
    await withMigrationDatabase(ctx, req.id, () => assertOperationWorkspace(ctx, body.operationId, body.workspaceId));
    const operation = await requireService(ctx).recover({
      requestId: req.id,
      operationId: body.operationId,
    });
    await withMigrationDatabase(ctx, req.id, () => sendOperation(ctx, req, operation));
  } catch (error) {
    sendMigrationFailure(ctx, req, error);
  }
}

/** 统一读取迁移 operation body，避免不同 handler 对空字段静默降级。 */
function requireOperationBody(req: ApiRequestMessage): {
  operationId: string;
  startAttemptId: string;
  workspaceId: WorkspaceId;
  expectedStateVersion: unknown;
  externalWritesPausedConfirmed?: unknown;
  targetNotSyncManagedConfirmed?: unknown;
  reason?: unknown;
} {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const operationId = String(body.operationId ?? "").trim();
  const startAttemptId = String(body.startAttemptId ?? "").trim();
  const workspaceId = String(body.workspaceId ?? "").trim() as WorkspaceId;
  if (!operationId || !workspaceId) {
    throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_NOT_FOUND", "参数错误：workspaceId/operationId", { requestId: req.id });
  }
  return {
    operationId,
    startAttemptId,
    workspaceId,
    expectedStateVersion: body.expectedStateVersion,
    externalWritesPausedConfirmed: body.externalWritesPausedConfirmed,
    targetNotSyncManagedConfirmed: body.targetNotSyncManagedConfirmed,
    reason: body.reason,
  };
}

/** 只接受安全整数 stateVersion，拒绝默认值和字符串数字。 */
function requireVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_STATE_CONFLICT", "参数错误：expectedStateVersion", { expectedStateVersion: value });
  return Number(value);
}

/** start/fence 必须显式携带 attempt，避免空字符串落入 Repo 的通用异常。 */
function requireStartAttemptId(body: { startAttemptId: string }): void {
  if (body.startAttemptId) return;
  throw new WorkspaceMigrationServiceError(
    "WORKSPACE_MIGRATION_STATE_CONFLICT",
    "参数错误：startAttemptId",
    { field: "startAttemptId" },
  );
}

/** 要求生产态已完成 Service 装配。 */
function requireService(ctx: ApiHandlerContext) {
  if (!ctx.workspaceMigrationService) throw new Error("workspace migration service 未装配");
  return ctx.workspaceMigrationService;
}

/** 校验 Server 路由携带的 workspaceId 与 Client 本地 operation 完全一致。 */
function assertOperationWorkspace(ctx: ApiHandlerContext, operationId: string, workspaceId: WorkspaceId): void {
  const operation = ctx.db.workspaceDirectoryMigrations.require(operationId);
  if (operation.workspaceId !== workspaceId) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_NOT_FOUND",
      "迁移操作不属于当前工作区",
      { operationId, workspaceId, actualWorkspaceId: operation.workspaceId },
    );
  }
}

/** 将本地记录转换为 Client API operation 响应。 */
function sendOperation(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  operation: Parameters<typeof toWorkspaceDirectoryMigrationOperation>[0],
  status = 200,
): void {
  const view = toWorkspaceDirectoryMigrationOperation(operation, {
    db: ctx.db,
    workspaces: ctx.workspaces,
    activityInspector: ctx.workspaceMigrationActivityInspector,
  });
  ctx.send({ t: "api.res", id: req.id, status, body: { ok: true, operation: view } });
}

/** 将迁移业务异常转换为稳定 HTTP 错误，不把业务失败伪装成成功。 */
function sendMigrationFailure(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown): void {
  const code = readMigrationErrorCode(error);
  const status = code ? WORKSPACE_DIRECTORY_MIGRATION_ERROR_HTTP_STATUS[code] : 500;
  if (!code) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    logger.error("workspace-migration", "workspace migration API failed with unknown error", {
      code: "workspace_migration_api_unknown_error",
      requestId: req.id,
      operationId: String(body.operationId ?? "").trim() || null,
      workspaceId: String(body.workspaceId ?? "").trim() || null,
      method: req.method,
      rootCause: error instanceof Error ? { name: error.name, message: error.message } : { valueType: typeof error },
    });
  }
  const message = code
    ? (error instanceof Error ? error.message : String(error))
    : "目录迁移请求失败，请根据 requestId 查看 Client 日志";
  ctx.send({
    t: "api.res",
    id: req.id,
    status,
    body: {
      ok: false,
      ...(code ? { code } : {}),
      message,
      ...(error instanceof WorkspaceMigrationServiceError ? { details: error.details } : { requestId: req.id }),
    },
  });
}

/** 处理已知迁移错误码；未知错误由 API 边界返回 500。 */
function readMigrationErrorCode(error: unknown): keyof typeof WORKSPACE_DIRECTORY_MIGRATION_ERROR_HTTP_STATUS | null {
  if (error instanceof WorkspaceMigrationServiceError || error instanceof WorkspaceDirectoryMigrationRepoError) return error.code;
  return null;
}

/** 直接返回一条明确迁移错误。 */
function sendMigrationError(ctx: ApiHandlerContext, req: ApiRequestMessage, status: number, code: string, message: string): void {
  ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, code, message } });
}
