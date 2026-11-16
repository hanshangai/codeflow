import {
  DOCUMENT_ATTACHMENT_LIMITS,
  type ClientDirectoryTreeRpcRequestBody,
  type ExtractDocumentAttachmentRequestBody,
  type FsDocumentPreviewRequestBody,
  type FsDownloadChunkRequestBody,
  type FsDownloadFileRequestBody,
  type FsDownloadStatRequestBody,
  type FsReindexRequestBody,
  type FsSpreadsheetPreviewRequestBody,
  type FsUploadBeginRequestBody,
  type FsUploadCancelRequestBody,
  type FsUploadChunkRequestBody,
  type FsUploadCompleteRequestBody,
  type WorkspaceId,
} from "@codeflowai/shared";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { WorkspaceApiRequestFailure, describeWorkspaceApiFailure, isWorkspaceApiRequestFailure } from "../handleApiRequest.js";
import * as fsService from "../../fs/fsService.js";
import { logger } from "../../logger.js";
import { extractDocumentAttachmentInWorker } from "../../fs/documentAttachmentWorkerClient.js";
import { WorkspacePathIndexPathError } from "../../fs/workspacePathIndexConfig.js";

/** 提取上传文档的完整文字，不写工作区；共享请求沿用 Host 工作区权限校验。 */
export async function handleFsExtractAttachment(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = (req.body ?? {}) as Partial<ExtractDocumentAttachmentRequestBody>;
  const workspace = resolveWorkspace(ctx, req, body.workspaceId);
  if (!workspace) return;
  const fileName = String(body.fileName ?? "").trim();
  // 文档源文件统一 20MB。
  const maxSourceBytes = DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes;
  let text: string;
  try {
    text = await extractDocumentAttachmentInWorker(fileName, body.base64 as string, maxSourceBytes);
  } catch (error) {
    sendFsError(ctx, req, error, { workspaceId: workspace.workspaceId, document: true });
    return;
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, text } });
}

/** 按原隐藏文件选项读取工作区目录树，路径错误显式响应。 */
export async function handleFsTree(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const dirPath = String((req.body as any)?.dirPath ?? "").trim();
  const depth = Math.min(Math.max(Number((req.body as any)?.depth) || 1, 1), 3);
  const showHidden = (req.body as any)?.showHidden === true;

  try {
    const nodes = await fsService.listTreeAsync(workspacePath, dirPath, depth, showHidden);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, nodes } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 处理 `fs.search`：搜索 workspace 内文件/目录，仅返回路径元信息。 */
export function handleFsSearch(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const query = String((req.body as any)?.query ?? "");
  const limit = (req.body as any)?.limit ?? null;
  const cursor = (req.body as any)?.cursor ?? null;
  const includeHidden = (req.body as any)?.includeHidden === true;
  const rawKind = String((req.body as any)?.kind ?? "all");
  const kind = rawKind === "file" || rawKind === "directory" ? rawKind : "all";

  try {
    const page = ctx.workspacePathIndex
      ? ctx.workspacePathIndex.search(workspaceId, workspacePath, query, { limit, cursor, includeHidden, kind }, { requestId: req.id })
      : fsService.searchPaths(workspacePath, query, { limit, cursor, includeHidden, kind });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...page } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 处理 `fs.reindex`：手工触发 workspace 文件路径索引重建。 */
export async function handleFsReindex(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = (req.body ?? {}) as Partial<FsReindexRequestBody>;
  const workspace = resolveWorkspace(ctx, req, body.workspaceId);
  if (!workspace) return;
  if (!ctx.workspacePathIndex) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, code: "FS_INDEX_DISABLED", message: "文件索引未启用" } });
    return;
  }

  try {
    const result = ctx.workspaceMigrationIndexCoordinator
      ? await ctx.workspaceMigrationIndexCoordinator.rebuildWorkspace(workspace.workspaceId, workspace.workspacePath, { requestId: req.id })
      : ctx.workspacePathIndex.rebuildWorkspace(workspace.workspaceId, workspace.workspacePath, { requestId: req.id });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 目录选择器异步探测本机根目录，保留一层懒加载和原失败响应。 */
export async function handleClientDirectoryTree(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = (req.body ?? {}) as ClientDirectoryTreeRpcRequestBody;
  const dirPath = typeof body.dirPath === "string" ? body.dirPath : "";
  const showHidden = body.showHidden === true;

  try {
    const nodes = await fsService.listClientDirectoryTreeAsync(dirPath, 1, showHidden);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, nodes } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 读取工作区内文件内容，真实路径校验由原文件服务完成。 */
export async function handleFsReadFile(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const filePath = String((req.body as any)?.path ?? "").trim();
  if (!workspaceId || !filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/path" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const maxBytes = (req.body as any)?.maxBytes ?? null;

  try {
    const result = await fsService.readFileAsync(workspacePath, filePath, maxBytes);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 下载原始内容；复用实际目标校验后才返回字节。 */
export function handleFsDownloadFile(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsDownloadFileRequestBody>;
  const workspaceId = String(body.workspaceId ?? "").trim() as WorkspaceId;
  const filePath = String(body.path ?? "").trim();
  if (!workspaceId || !filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/path" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  try {
    const result = fsService.readFileForDownload(workspacePath, filePath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 处理 `fs.uploadBegin`：在工作区内创建上传临时文件会话。 */
export function handleFsUploadBegin(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsUploadBeginRequestBody>;
  const workspace = resolveWorkspace(ctx, req, body.workspaceId);
  if (!workspace) return;
  try {
    const result = fsService.beginUpload(workspace.workspacePath, {
      targetDir: body.targetDir,
      fileName: String(body.fileName ?? ""),
      sizeBytes: Number(body.sizeBytes),
      mimeType: body.mimeType,
      overwrite: body.overwrite,
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 处理 `fs.uploadChunk`：顺序写入上传分片。 */
export function handleFsUploadChunk(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsUploadChunkRequestBody>;
  const uploadId = String(body.uploadId ?? "");
  const workspacePath = fsService.getUploadWorkspacePath(uploadId);
  const workspace = workspacePath ? resolveWorkspaceByPath(ctx, workspacePath) : null;
  let result: ReturnType<typeof fsService.writeUploadChunk>;
  try {
    result = fsService.writeUploadChunk({
      uploadId,
      offset: Number(body.offset),
      base64: String(body.base64 ?? ""),
    });
  } catch (e) {
    sendFsError(ctx, req, e, { workspaceId: workspace?.workspaceId ?? null });
    return;
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
}

/** 处理 `fs.uploadComplete`：完成上传并将临时文件移动到目标路径。 */
export function handleFsUploadComplete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsUploadCompleteRequestBody>;
  const uploadId = String(body.uploadId ?? "");
  const workspacePath = fsService.getUploadWorkspacePath(uploadId);
  let workspace = workspacePath ? resolveWorkspaceByPath(ctx, workspacePath) : null;
  let result: ReturnType<typeof fsService.completeUpload>;
  try {
    result = fsService.completeUpload(uploadId);
    workspace ??= resolveWorkspaceByPath(ctx, result.workspacePath);
    if (ctx.workspacePathIndex) {
      if (!workspace) throw new Error(`上传完成后无法定位 workspace：${result.workspacePath}`);
      ctx.workspacePathIndex.applyChanges(
        workspace.workspaceId,
        workspace.workspacePath,
        [{ type: "upsert", path: result.path }],
        { requestId: req.id },
      );
    }
  } catch (e) {
    sendFsError(ctx, req, e, { workspaceId: workspace?.workspaceId ?? null });
    return;
  }
  const { workspacePath: _workspacePath, ...publicResult } = result;
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...publicResult } });
}

/** 处理 `fs.uploadCancel`：取消上传并清理临时文件。 */
export function handleFsUploadCancel(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsUploadCancelRequestBody>;
  const uploadId = String(body.uploadId ?? "");
  const workspacePath = fsService.getUploadWorkspacePath(uploadId);
  const workspace = workspacePath ? resolveWorkspaceByPath(ctx, workspacePath) : null;
  let result: ReturnType<typeof fsService.cancelUpload>;
  try {
    result = fsService.cancelUpload(uploadId);
  } catch (e) {
    sendFsError(ctx, req, e, { workspaceId: workspace?.workspaceId ?? null });
    return;
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
}

/** 校验共享实际目标后返回下载元数据。 */
export function handleFsDownloadStat(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsDownloadStatRequestBody>;
  const workspace = resolveWorkspace(ctx, req, body.workspaceId);
  if (!workspace) return;
  try {
    const result = fsService.statFileForDownload(workspace.workspacePath, String(body.path ?? ""));
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 每片下载复核共享实际目标，再返回 base64 分片。 */
export function handleFsDownloadChunk(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsDownloadChunkRequestBody>;
  const workspace = resolveWorkspace(ctx, req, body.workspaceId);
  if (!workspace) return;
  try {
    const result = fsService.readFileChunkForDownload(workspace.workspacePath, {
      path: String(body.path ?? ""),
      offset: Number(body.offset),
      length: Number(body.length),
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 表格预览沿原服务复核共享实际目标与行列预算。 */
export function handleFsSpreadsheetPreview(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsSpreadsheetPreviewRequestBody>;
  const workspaceId = String(body.workspaceId ?? "").trim() as WorkspaceId;
  const filePath = String(body.path ?? "").trim();
  if (!workspaceId || !filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/path" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  try {
    const result = fsService.readSpreadsheetPreview(workspacePath, filePath, {
      sheetName: body.sheetName,
      maxRows: body.maxRows,
      maxColumns: body.maxColumns,
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 文档预览先复核共享实际目标，再沿原格式解析。 */
export function handleFsDocumentPreview(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<FsDocumentPreviewRequestBody>;
  const workspaceId = String(body.workspaceId ?? "").trim() as WorkspaceId;
  const filePath = String(body.path ?? "").trim();
  if (!workspaceId || !filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/path" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  try {
    const result = fsService.readDocumentPreview(workspacePath, filePath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 返回工作区文件元信息，路径错误和 I/O 失败均显式响应。 */
export function handleFsStat(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const filePath = String((req.body as any)?.path ?? "").trim();
  if (!workspaceId || !filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/path" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  try {
    const result = fsService.statPath(workspacePath, filePath);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (e) {
    sendFsError(ctx, req, e);
  }
}

/** 解析 workspaceId 对应的本地工作区路径，并直接向调用方返回参数错误。 */
function resolveWorkspace(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  workspaceIdValue: unknown,
): { workspaceId: WorkspaceId; workspacePath: string } | null {
  const workspaceId = String(workspaceIdValue ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, code: "BAD_REQUEST", message: "参数错误：workspaceId" } });
    return null;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, code: "NOT_FOUND", message: `未知 workspaceId：${workspaceId}` } });
    return null;
  }
  return { workspaceId, workspacePath };
}

/** 按上传会话保存的 workspacePath 找回 workspaceId，用于完成后更新本地索引。 */
function resolveWorkspaceByPath(ctx: ApiHandlerContext, workspacePath: string): { workspaceId: WorkspaceId; workspacePath: string } | null {
  for (const [workspaceId, currentPath] of ctx.workspaces.entries()) {
    if (currentPath === workspacePath) return { workspaceId, workspacePath: currentPath };
  }
  return null;
}

/** 文件失败单次记录；索引路径错误只输出安全原因码及本次真实上下文。 */
function sendFsError(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown,
  options?: { workspaceId: WorkspaceId | null; document?: boolean }): void {
  if (isWorkspaceApiRequestFailure(error)) throw error;
  const requestedWorkspace = options ? options.workspaceId : (typeof (req.body as any)?.workspaceId === "string" ? (req.body as any).workspaceId.trim() : ctx.db.workspaceId);
  const workspaceId = requestedWorkspace && ctx.workspaces.has(requestedWorkspace) ? requestedWorkspace as WorkspaceId : null;
  let status: number, errorCode: string, message: string;
  const details = { code: "WORKSPACE_API_REQUEST_LOG_FAILED", requestId: req.id, workspaceId, method: req.method };
  try {
    const description = describeWorkspaceApiFailure(error);
    const code = description.code ?? (options?.document ? "BAD_REQUEST" : "CLIENT_ERROR");
    status = options?.document ? code === "TIMEOUT" ? 504 : code === "RATE_LIMITED" ? 429 : code === "INTERNAL_ERROR" ? 500 : 400
      : code === "SHARED_WORKSPACE_FORBIDDEN" ? 403 : code === "FILE_ALREADY_EXISTS" ? 409 : code === "FILE_TRANSFER_PATH_INVALID" || code === "ENOTDIR" ? 400 : code === "ENOENT" ? 404 : 500;
    errorCode = code === "ENOTDIR" ? "BAD_REQUEST" : code === "ENOENT" ? "NOT_FOUND" : code;
    message = description.message;
    const indexError = error instanceof WorkspacePathIndexPathError ? error : null;
    const entry = { level: status >= 500 ? "error" as const : "warn" as const, tag: "fs",
      message: options?.document ? "document attachment extraction failed" : "file request failed", data: {
        code: indexError?.diagnosticCode ?? errorCode, requestId: req.id, clientId: ctx.clientId, method: req.method,
        workspaceId, rootCause: description.rootCause,
        ...(indexError ? { path: indexError.logicalPath, generation: indexError.generation, systemCode: indexError.systemCode } : {}),
        ...ctx.sharedFileRequestContext,
      } };
    if (workspaceId) ctx.db.writeWorkspaceLog(workspaceId, entry);
    else logger[entry.level](entry.tag, entry.message, entry.data);
    ctx.onApiFailureLogged?.();
  } catch (diagnosticError) {
    throw new WorkspaceApiRequestFailure([error, diagnosticError], details);
  }
  try {
    ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, code: errorCode, message } });
  } catch (deliveryError) {
    throw new WorkspaceApiRequestFailure([error, deliveryError], { ...details, code: "WORKSPACE_API_REQUEST_RESPONSE_FAILED", responseAttempted: true });
  }
}
