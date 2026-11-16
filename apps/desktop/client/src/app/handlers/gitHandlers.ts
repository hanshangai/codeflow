import type { OrchestrationId, WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import * as gitService from "../../git/gitService.js";
import { wrapGitError } from "../../git/gitHelpers.js";
import { logger } from "../../logger.js";
import {
  collectCodeAttributionCommit,
  CodeAttributionCommitServiceError,
} from "../../orchestration/codeAttributionCommitService.js";
import { CodeAttributionOutboxRepoError } from "../../db/repos/codeAttributionOutboxRepo.js";
import { createHash } from "node:crypto";

/** Git子进程等待在许可外，读取后的诊断和归因持久化分别取得短许可。 */
function withGitDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 仅三个可信桌面读取沿已解析工作区绑定日志能力，不保存请求可变 body。 */
function gitReadLogContext(ctx: ApiHandlerContext, req: ApiRequestMessage, workspaceId: WorkspaceId): gitService.GitStatusLogContext | undefined {
  if (ctx.localWorkspaceOnly !== true || !["git.status", "git.diff", "git.diffFiles"].includes(req.method)) return undefined;
  return { workspaceId, requestId: req.id, clientId: ctx.clientId, method: req.method,
    writeWorkspaceLog: entry => withGitDatabase(ctx, req.id, () => ctx.db.writeWorkspaceLog(workspaceId, entry)) };
}

/** 桌面读取只描述自有 data，任意对象/访问器不做隐式转换。 */
function describeGitReadFailure(error: unknown): { code: unknown; message: string; rootCause: Record<string, unknown> } {
  const fields: Record<string, unknown> = {}, type = error === null ? "null" : typeof error;
  if (error !== null && (type === "object" || type === "function")) {
    for (const key of ["code", "message"]) { const item = Object.getOwnPropertyDescriptor(error, key); if (item && "value" in item) fields[key] = item.value; }
  }
  const text = typeof fields.message === "string" ? fields.message : ["string", "number", "boolean", "undefined", "bigint"].includes(type) ? String(error) : type;
  const message = text.replace(/\n+/g, " ").slice(0, 500);
  return { code: fields.code, message, rootCause: { type,
    code: typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(fields.code) ? fields.code : undefined,
    fingerprint: createHash("sha256").update(text).digest("hex") } };
}

/** 同步 send 或明确拒绝只尝试一次；保留已发生的读取失败及原投递值。 */
function sendGitReadResponse(ctx: ApiHandlerContext, response: Parameters<ApiHandlerContext["send"]>[0], original?: { error: unknown }): void {
  try {
    const dispatch = ctx.send(response);
    if (dispatch?.accepted === false) throw dispatch;
  } catch (failure) {
    const errors = original ? [original.error, failure] : [failure];
    throw Object.assign(new AggregateError(errors, "GIT_READ_RESPONSE_FAILED", { cause: errors[0] }), { code: "GIT_READ_RESPONSE_FAILED" });
  }
}

/** Git 读取失败由原 API 边界单次记录并保留共享请求关联。 */
async function sendGitReadError(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown, context?: gitService.GitStatusLogContext): Promise<void> {
  if (context) {
    let response: Parameters<ApiHandlerContext["send"]>[0];
    let metadataFailure = false;
    try {
      const details = describeGitReadFailure(error);
      if (error instanceof AggregateError && details.code === "GIT_STATUS_METADATA_LOG_FAILED") { metadataFailure = true; throw error; }
      const code = details.code === "FILE_TRANSFER_PATH_INVALID" ? details.code : "INTERNAL_ERROR", status = code === "FILE_TRANSFER_PATH_INVALID" ? 400 : 500;
      await withGitDatabase(ctx, req.id, () => ctx.db.writeWorkspaceLog(context.workspaceId as WorkspaceId, { level: status >= 500 ? "error" : "warn", tag: "git", message: "git read request failed", data: {
        code, errorCode: code, event: { category: "git", action: context.method, outcome: "fail" }, requestId: context.requestId,
        workspaceId: context.workspaceId, clientId: context.clientId, method: context.method, rootCause: details.rootCause,
        ...(typeof details.code === "number" ? { exitCode: details.code } : {}),
      } }));
      response = { t: "api.res", id: context.requestId, status, body: { ok: false, code, message: details.message } };
    } catch (failure) {
      if (metadataFailure) throw error;
      throw Object.assign(new AggregateError([error, failure], "GIT_READ_REQUEST_LOG_FAILED", { cause: error }), { code: "GIT_READ_REQUEST_LOG_FAILED" });
    }
    ctx.onApiFailureLogged?.();
    sendGitReadResponse(ctx, response, { error });
    return;
  }
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code = rawCode === "FILE_TRANSFER_PATH_INVALID" ? rawCode : "INTERNAL_ERROR";
  const status = code === "FILE_TRANSFER_PATH_INVALID" ? 400 : 500;
  const message = wrapGitError(error);
  logger[status >= 500 ? "error" : "warn"]("git", "git read request failed", {
    code, requestId: req.id, workspaceId: (req.body as any)?.workspaceId, clientId: ctx.clientId,
    method: req.method, rootCause: message,
    ...(typeof rawCode === "number" ? { exitCode: rawCode } : {}), ...ctx.sharedFileRequestContext,
  });
  ctx.onApiFailureLogged?.();
  ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, code, message } });
}

/** 从请求中解析 workspace 和可选 Git 仓库路径，统一处理基础参数错误。 */
function extractWorkspacePath(ctx: ApiHandlerContext, req: ApiRequestMessage): { workspaceId: WorkspaceId; workspacePath: string; repositoryPath: string | null } | null {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return null;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return null;
  }
  const repositoryPathRaw = (req.body as { repositoryPath?: unknown })?.repositoryPath;
  const repositoryPath = repositoryPathRaw == null ? null : String(repositoryPathRaw).trim();
  return { workspaceId, workspacePath, repositoryPath };
}

/** Git 状态沿原服务读取，工作区边界由服务统一校验。 */
export async function handleGitStatus(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const context = gitReadLogContext(ctx, req, ws.workspaceId);
  let result: Awaited<ReturnType<typeof gitService.status>>;
  try {
    result = await gitService.status(ws.workspacePath, ws.repositoryPath, context);
    if (!context) { ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } }); return; }
  } catch (e) {
    await sendGitReadError(ctx, req, e, context); return;
  }
  if (context) sendGitReadResponse(ctx, { t: "api.res", id: context.requestId, status: 200, body: { ok: true, ...result } });
}

/** 单文件 patch 复用原 Git 服务及失败边界。 */
export async function handleGitDiff(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const filePath = String((req.body as any)?.path ?? "").trim();
  if (!filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：path" } });
    return;
  }
  const staged = Boolean((req.body as any)?.staged);
  const context = gitReadLogContext(ctx, req, ws.workspaceId);
  let diff: string;
  try {
    diff = await gitService.diff(ws.workspacePath, filePath, staged, ws.repositoryPath);
    if (!context) { ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, path: filePath, diff } }); return; }
  } catch (e) {
    await sendGitReadError(ctx, req, e, context); return;
  }
  if (context) sendGitReadResponse(ctx, { t: "api.res", id: context.requestId, status: 200, body: { ok: true, path: filePath, diff } });
}

/** 文件内容读取沿原工作区边界执行，失败不返回正文。 */
export async function handleGitDiffFiles(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const filePath = String((req.body as any)?.path ?? "").trim();
  if (!filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：path" } });
    return;
  }
  const staged = Boolean((req.body as any)?.staged);
  const context = gitReadLogContext(ctx, req, ws.workspaceId);
  let result: Awaited<ReturnType<typeof gitService.diffFiles>>;
  try {
    result = await gitService.diffFiles(ws.workspacePath, filePath, staged, ws.repositoryPath);
    if (!context) { ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, path: filePath, ...result } }); return; }
  } catch (e) {
    await sendGitReadError(ctx, req, e, context); return;
  }
  if (context) sendGitReadResponse(ctx, { t: "api.res", id: context.requestId, status: 200, body: { ok: true, path: filePath, ...result } });
}

/** 处理 `git.stage` */
export async function handleGitStage(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const paths = Array.isArray((req.body as any)?.paths) ? ((req.body as any).paths as string[]) : [];
  if (!paths.length) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：paths" } });
    return;
  }
  try {
    await gitService.stage(ws.workspacePath, paths, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: wrapGitError(e) } });
  }
}

/** 处理 `git.unstage` */
export async function handleGitUnstage(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const paths = Array.isArray((req.body as any)?.paths) ? ((req.body as any).paths as string[]) : [];
  if (!paths.length) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：paths" } });
    return;
  }
  try {
    await gitService.unstage(ws.workspacePath, paths, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: wrapGitError(e) } });
  }
}

/** 处理 `git.discard` */
export async function handleGitDiscard(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const paths = Array.isArray((req.body as any)?.paths) ? ((req.body as any).paths as string[]) : [];
  if (!paths.length) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：paths" } });
    return;
  }
  try {
    await gitService.discard(ws.workspacePath, paths, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: wrapGitError(e) } });
  }
}

/** 处理 `git.commit` */
export async function handleGitCommit(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const message = String((req.body as any)?.message ?? "").trim();
  if (!message) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：message" } });
    return;
  }
  const amend = Boolean((req.body as any)?.amend);
  try {
    const result = await gitService.commit(ws.workspacePath, message, amend, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: wrapGitError(e) } });
  }
}

/** 处理显式 commit/实例代码归因采集，不改变普通 `git.commit` 合同。 */
export async function handleGitCodeAttributionCollect(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const instanceId = String(body.instanceId ?? "").trim();
  const commitSha = String(body.commitSha ?? "").trim();
  try {
    const db = await withGitDatabase(ctx, req.id, () => ctx.db.forWorkspace(ws.workspaceId));
    const result = await collectCodeAttributionCommit(db, {
      workspaceId: ws.workspaceId,
      repositoryPath: ws.repositoryPath,
      commitSha,
      instanceId: instanceId as OrchestrationId,
      associationId: String(body.associationId ?? ""),
      associationExpiresAt: Number(body.associationExpiresAt),
    }, { withDatabase: operation => withGitDatabase(ctx, req.id, operation) });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (error) {
    const response = codeAttributionErrorResponse(error);
    logger.error("code-attribution", "commit attribution collection failed", {
      errorCode: response.errorCode,
      requestId: req.id,
      workspaceId: String(ws.workspaceId),
      instanceId: instanceId || null,
      commitSha: commitSha || null,
      errorName: error instanceof Error ? error.name : "Error",
      rootCause: response.errorCode,
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: response.status,
      body: { ok: false, code: response.errorCode, message: response.message },
    });
  }
}

/** 将内部归因错误翻译为稳定且不泄露本地路径的 Client RPC 错误。 */
function codeAttributionErrorResponse(error: unknown): { status: number; errorCode: string; message: string } {
  if (error instanceof CodeAttributionCommitServiceError) {
    if (error.code === "CODE_ATTRIBUTION_COMMIT_INPUT_INVALID") return { status: 400, errorCode: error.code, message: error.message };
    if (error.code === "CODE_ATTRIBUTION_COMMIT_WORKSPACE_NOT_FOUND" || error.code === "CODE_ATTRIBUTION_COMMIT_INSTANCE_NOT_FOUND") {
      return { status: 404, errorCode: error.code, message: error.message };
    }
    if (error.code === "CODE_ATTRIBUTION_COMMIT_ASSOCIATION_MISMATCH" || error.code === "CODE_ATTRIBUTION_COMMIT_ASSOCIATION_EXPIRED") {
      return { status: 409, errorCode: error.code, message: error.message };
    }
    return { status: 422, errorCode: error.code, message: error.message };
  }
  if (error instanceof CodeAttributionOutboxRepoError) {
    if (error.code === "CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID") return { status: 400, errorCode: error.code, message: "代码归因批次内容无效。" };
    if (error.code === "CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID") {
      return { status: 500, errorCode: error.code, message: "本地代码归因数据异常，请联系管理员处理。" };
    }
    if (error.code === "CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED") {
      return { status: 409, errorCode: error.code, message: "实例关联凭证已过期，请刷新后重试。" };
    }
    return { status: 409, errorCode: error.code, message: "该提交的代码归因批次状态已变化，请刷新后重试。" };
  }
  return { status: 500, errorCode: "CODE_ATTRIBUTION_COMMIT_INTERNAL_ERROR", message: "代码贡献证据采集失败，请稍后重试。" };
}

/** 从所选工作区仓库读取提交元信息。 */
export async function handleGitLog(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const maxCount = Math.min(Math.max(Number((req.body as any)?.maxCount) || 20, 1), 100);
  const skip = Math.max(Number((req.body as any)?.skip) || 0, 0);
  try {
    const result = await gitService.log(ws.workspacePath, maxCount, skip, ws.repositoryPath, (req.body as { headCommit?: string | null })?.headCommit);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    await sendGitReadError(ctx, req, e);
  }
}

/** 历史详情沿原服务返回所选提交的文件和 patch。 */
export async function handleGitShow(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const hash = String((req.body as any)?.hash ?? "").trim();
  if (!hash) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：hash" } });
    return;
  }
  try {
    const result = await gitService.show(ws.workspacePath, hash, ws.repositoryPath, (req.body as { includeDiff?: boolean })?.includeDiff !== false);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    await sendGitReadError(ctx, req, e);
  }
}

/** 读取所选工作区仓库的分支。 */
export async function handleGitBranchList(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  try {
    const branches = await gitService.branchList(ws.workspacePath, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, branches } });
  } catch (e) {
    await sendGitReadError(ctx, req, e);
  }
}

/** 处理 `git.branch.create` */
export async function handleGitBranchCreate(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const name = String((req.body as any)?.name ?? "").trim();
  if (!name) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：name" } });
    return;
  }
  const startPoint = ((req.body as any)?.startPoint ?? "").trim() || undefined;
  try {
    await gitService.branchCreate(ws.workspacePath, name, startPoint, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, name } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: wrapGitError(e) } });
  }
}

/** 处理 `git.branch.switch` */
export async function handleGitBranchSwitch(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const name = String((req.body as any)?.name ?? "").trim();
  if (!name) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：name" } });
    return;
  }
  try {
    await gitService.branchSwitch(ws.workspacePath, name, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, name } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: wrapGitError(e) } });
  }
}

/** 处理 `git.branch.delete` */
export async function handleGitBranchDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const name = String((req.body as any)?.name ?? "").trim();
  if (!name) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：name" } });
    return;
  }
  const force = Boolean((req.body as any)?.force);
  try {
    await gitService.branchDelete(ws.workspacePath, name, force, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, name } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: wrapGitError(e) } });
  }
}

/** 历史文件读取沿原仓库路径校验返回前后内容。 */
export async function handleGitShowFileDiff(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const ws = extractWorkspacePath(ctx, req);
  if (!ws) return;
  const hash = String((req.body as any)?.hash ?? "").trim();
  if (!hash) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：hash" } });
    return;
  }
  const filePath = String((req.body as any)?.path ?? "").trim();
  if (!filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：path" } });
    return;
  }
  try {
    const result = await gitService.showFileDiff(ws.workspacePath, hash, filePath, ws.repositoryPath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, path: filePath, ...result } });
  } catch (e) {
    await sendGitReadError(ctx, req, e);
  }
}

