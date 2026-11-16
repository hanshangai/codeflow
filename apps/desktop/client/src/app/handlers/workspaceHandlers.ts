import fs from "node:fs";
import path from "node:path";
import { workspacePathIndexDatabasePath } from "../../fs/workspacePathIndexConfig.js";

import {
  validateWorkspaceExecutionProfileText,
  type ExecutionProfileScopeType,
  isSharedWorkspaceSelectionId,
  prefixLocalWorkspaceId,
  type OrchestrationStatus,
  type ThreadId,
  type WorkspaceExecutionProfileScope,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { interruptTurnBestEffort } from "../turnInterrupt.js";
import {
  toWorkspaceDirectoryMigrationIndexState,
  toWorkspaceDirectoryMigrationSummary,
} from "../../workspace-migration/workspaceMigrationView.js";
import { logger } from "../../logger.js";
import {
  assertWorkspaceRootAvailable,
  WorkspaceRootConflictError,
} from "../../fs/workspaceRootOwnership.js";

/** 工作区同步仓储段共用唯一准入，文件和运行资源异步等待在许可外。 */
function withWorkspaceDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 处理 `workspaces.list`：列出 Client SQLite 中的所有 workspace。 */
export function handleWorkspacesList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const activeByWorkspace = new Map(
    ctx.db.workspaceDirectoryMigrations.listActive().map((operation) => [
      operation.workspaceId,
      toWorkspaceDirectoryMigrationSummary(operation),
    ]),
  );
  const indexByWorkspace = new Map(
    ctx.db.workspaceDirectoryMigrations.listDirectoryMigrationIndexStates().map((operation) => [
      operation.workspaceId,
      toWorkspaceDirectoryMigrationIndexState(operation),
    ]),
  );
  const workspaces = ctx.db.workspaces.list().map((workspace) => ({
    ...workspace,
    activeDirectoryMigration: activeByWorkspace.get(workspace.id) ?? null,
    directoryMigrationIndexState: indexByWorkspace.get(workspace.id) ?? null,
  }));
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, workspaces } });
}

/** 处理 `workspaces.upsert`：创建或更新 workspace，并写回运行态映射。 */
export async function handleWorkspacesUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const rawId = String((req.body as any)?.workspaceId ?? "").trim();
  const title = String((req.body as any)?.title ?? "").trim();
  const p = String((req.body as any)?.path ?? "").trim();
  if (!rawId || !title || !p) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/title/path" } });
    return;
  }
  if (!isExistingDir(p)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: `路径不存在或非目录：${p}` } });
    return;
  }

  if (isSharedWorkspaceSelectionId(rawId)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "共享工作区选择 ID 不能写入本地 workspace" } });
    return;
  }

  const workspaceId = prefixLocalWorkspaceId(ctx.clientId, rawId) as WorkspaceId;
  const registered = await withWorkspaceDatabase(ctx, req.id, () => registerWorkspace(ctx, req, workspaceId, title, p));
  if (!registered) return;
  const { existing, workspace } = registered;
  await withWorkspaceDatabase(ctx, req.id, () => ctx.workspacePathIndex?.upsertWorkspace(workspaceId, workspace.path, { requestId: req.id }));
  try {
    await ctx.onWorkspacesChanged?.(existing ? "update" : "create");
  } catch (error) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false,
      message: `工作区已创建，但本地内置资产安装失败：${error instanceof Error ? error.message : String(error)}` } });
    return;
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, workspace } });
}

/** 根目录核验、注册和运行映射在同一同步段完成，避免并发创建复用物理根。 */
function registerWorkspace(ctx: ApiHandlerContext, req: ApiRequestMessage, workspaceId: WorkspaceId, title: string, p: string) {
  const existing = ctx.db.workspaces.get(workspaceId);
  if (existing && !isSameWorkspacePath(existing.path, p)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "工作区目录创建后不可修改，请新建工作区" } });
    return;
  }

  try {
    const rootOwners = new Map(ctx.workspaces);
    for (const persisted of ctx.db.workspaces.list()) rootOwners.set(persisted.id, persisted.path);
    assertWorkspaceRootAvailable(rootOwners, workspaceId, p);
  } catch (error) {
    if (error instanceof WorkspaceRootConflictError) {
      logger.warn("workspace-index", "workspace root registration rejected", {
        code: "workspace_path_already_registered",
        requestId: req.id,
        workspaceId,
        conflictingWorkspaceIds: error.conflictingWorkspaceIds,
        workspaceRootKey: error.workspaceRootKey,
        generation: null,
        indexPath: path.normalize(workspacePathIndexDatabasePath(error.workspaceRoot)),
        rootCause: error.message,
      });
      ctx.onApiFailureLogged?.();
      ctx.send({
        t: "api.res",
        id: req.id,
        status: error.status,
        body: { ok: false, code: error.code, message: error.message },
      });
      return;
    }
    const rootCause = error instanceof Error ? error.message : String(error);
    logger.warn("workspace-index", "workspace root registration validation failed", {
      code: "workspace_root_registration_validation_failed",
      requestId: req.id,
      workspaceId,
      generation: null,
      indexPath: path.normalize(workspacePathIndexDatabasePath(path.resolve(p))),
      rootCause,
    });
    ctx.onApiFailureLogged?.();
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: `无法确认工作区物理路径：${rootCause}` },
    });
    return;
  }

  const workspace = ctx.db.workspaces.upsert({ id: workspaceId, title, path: p });
  ctx.workspaces.set(workspaceId, workspace.path);
  return { existing, workspace };
}

/** 处理 `workspaces.delete`：先显式收敛运行态，再软删除 workspace。 */
export async function handleWorkspacesDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }

  const existing = await withWorkspaceDatabase(ctx, req.id, () => ctx.db.workspaces.get(workspaceId));
  if (!existing) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "workspace 不存在" } });
    return;
  }

  await cancelWorkspaceActiveOrchestrations(ctx, workspaceId, req.id);
  await interruptWorkspaceRunningTurns(ctx, workspaceId, req.id);

  const { threads } = await withWorkspaceDatabase(ctx, req.id, () => ctx.db.forWorkspace(workspaceId).threads.listByWorkspace(workspaceId, { includeArchived: true }));
  for (const t of threads) {
    await withWorkspaceDatabase(ctx, req.id, () => cancelThreadActiveQueue({ ...ctx, db: ctx.db.forWorkspace(workspaceId) }, workspaceId, t.id));
    await ctx.sessions.disposeThreadWithOptions(t.id, { flushActiveTurn: false });
    ctx.threads.delete(t.id);
  }
  await ctx.flushLocalEvents?.(workspaceId);

  await withWorkspaceDatabase(ctx, req.id, () => ctx.db.workspaces.delete(workspaceId));
  ctx.workspaces.delete(workspaceId);
  await withWorkspaceDatabase(ctx, req.id, () => ctx.workspacePathIndex?.deleteWorkspace(workspaceId));
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
  await ctx.onWorkspacesChanged?.("delete");
}

/** 读取当前用户在指定工作区范围内的执行 Profile。 */
export function handleWorkspaceExecutionProfileGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const parsed = readWorkspaceExecutionProfileRequest(ctx, req);
  if (!parsed.ok) {
    ctx.send({ t: "api.res", id: req.id, status: parsed.status, body: { ok: false, message: parsed.message } });
    return;
  }

  const profile = ctx.db.withWorkspaceExecutionProfiles(parsed.workspaceId, repo => repo.get(parsed.scope, parsed.userId)) ?? {
    scope: parsed.scope,
    userId: parsed.userId,
    profileText: "",
    source: "missing" as const,
    profileHash: null,
    updatedAt: null,
  };
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, profile } });
}

/** 保存当前用户在指定工作区范围内的执行 Profile。 */
export function handleWorkspaceExecutionProfileUpdate(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const parsed = readWorkspaceExecutionProfileRequest(ctx, req);
  if (!parsed.ok) {
    ctx.send({ t: "api.res", id: req.id, status: parsed.status, body: { ok: false, message: parsed.message } });
    return;
  }

  const validation = validateWorkspaceExecutionProfileText((req.body as any)?.profileText);
  if (!validation.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: validation.message, code: validation.code } });
    return;
  }

  const profile = ctx.db.withWorkspaceExecutionProfiles(parsed.workspaceId, repo => repo.upsert({
    scope: parsed.scope,
    userId: parsed.userId,
    profileText: validation.text,
  }));
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, profile } });
}

/** 查询指定用户集合的 Profile 状态；不返回 Profile 全文。 */
export function handleWorkspaceExecutionProfileStatus(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const parsed = readWorkspaceExecutionProfileRequest(ctx, req);
  if (!parsed.ok) {
    ctx.send({ t: "api.res", id: req.id, status: parsed.status, body: { ok: false, message: parsed.message } });
    return;
  }

  const rawUserIds = Array.isArray((req.body as any)?.userIds) ? (req.body as any).userIds as unknown[] : [];
  const userIds = rawUserIds.length
    ? rawUserIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [parsed.userId];
  const statuses = ctx.db.withWorkspaceExecutionProfiles(parsed.workspaceId, repo => repo.listStatuses(parsed.scope, userIds));
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, statuses } });
}

/** 取消 workspace 下所有未终态编排实例，避免软删除后仍可继续推进。 */
async function cancelWorkspaceActiveOrchestrations(ctx: ApiHandlerContext, workspaceId: WorkspaceId, requestId: string): Promise<void> {
  const engine = await withWorkspaceDatabase(ctx, requestId, () => ctx.orchEngine.forWorkspace(workspaceId));
  const instances = await withWorkspaceDatabase(ctx, requestId, () => ctx.db.forWorkspace(workspaceId).orchInstances
    .listByWorkspace(workspaceId)
    .filter((instance) => !isTerminalOrchestrationStatus(instance.status)));
  for (const instance of instances) {
    await engine.cancelAndWait(instance.id, { requestId });
  }
}

/** 将 workspace 下仍处于 started 的普通 turn 显式落为 manual interrupt 终态。 */
async function interruptWorkspaceRunningTurns(ctx: ApiHandlerContext, workspaceId: WorkspaceId, requestId: string): Promise<void> {
  const scoped = await withWorkspaceDatabase(ctx, requestId, () => ({ ...ctx, db: ctx.db.forWorkspace(workspaceId) }));
  const runningByThreadId = await withWorkspaceDatabase(ctx, requestId, () => scoped.db.turns.listRunningByWorkspace(workspaceId));
  for (const [rawThreadId, running] of Object.entries(runningByThreadId)) {
    await interruptTurnBestEffort(scoped, {
      workspaceId,
      threadId: rawThreadId as ThreadId,
      turnId: running.runningTurnId,
    }, { ensureTerminalEvent: true });
  }
}

/** 取消尚未消费完的队列项，防止恢复同路径工作区后自动发送旧输入。 */
function cancelThreadActiveQueue(ctx: ApiHandlerContext, workspaceId: WorkspaceId, threadId: ThreadId): void {
  const cancelled = ctx.db.threadMessageQueue.cancelActiveByThread(
    threadId,
    "workspace_removed",
    "workspace removed by user",
  );
  if (cancelled > 0) {
    ctx.db.threadQueueStates.pause(threadId, workspaceId, "user_stop");
  }
}

function readWorkspaceExecutionProfileRequest(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
): { ok: true; workspaceId: WorkspaceId; scope: WorkspaceExecutionProfileScope; userId: string } | { ok: false; status: number; message: string } {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const userId = String((req.body as any)?.userId ?? "").trim();
  if (!workspaceId || !userId) {
    return { ok: false, status: 400, message: "参数错误：workspaceId/userId" };
  }
  if (!ctx.workspaces.has(workspaceId) && !ctx.db.workspaces.get(workspaceId)) {
    return { ok: false, status: 404, message: "workspace 不存在或未被当前 Client 承载" };
  }

  const scopeType = normalizeExecutionProfileScopeType((req.body as any)?.profileScopeType);
  if (!scopeType) {
    return { ok: false, status: 400, message: "参数错误：profileScopeType" };
  }
  const explicitScopeId = String((req.body as any)?.profileScopeId ?? "").trim();
  const scopeId = scopeType === "shared_workspace" ? explicitScopeId : workspaceId;
  if (!scopeId) {
    return { ok: false, status: 400, message: "参数错误：profileScopeId" };
  }

  return {
    ok: true,
    workspaceId,
    scope: { scopeType, scopeId },
    userId,
  };
}

function normalizeExecutionProfileScopeType(value: unknown): ExecutionProfileScopeType | null {
  const raw = String(value ?? "").trim();
  return raw === "local_workspace" || raw === "shared_workspace" ? raw : null;
}

/** 判断编排实例是否已不可继续推进。 */
function isTerminalOrchestrationStatus(status: OrchestrationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isExistingDir(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false;
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 判断两个目录字符串是否指向同一个工作区路径，用于允许编辑名称但锁定目录。 */
function isSameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value.trim());
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}
