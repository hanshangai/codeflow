import type {
  FsTreeRequestBody, FsTreeResponseBody,
  ExtractDocumentAttachmentRequestBody, ExtractDocumentAttachmentResponseBody,
  FsSearchRequestBody, FsSearchResponseBody,
  FsReindexRequestBody, FsReindexResponseBody,
  FsReadFileRequestBody, FsReadFileResponseBody,
  FsWriteFileRequestBody, FsWriteFileResponseBody,
  FsDocumentPreviewRequestBody, FsDocumentPreviewResponseBody,
  FsDownloadFileRequestBody, FsDownloadFileResponseBody,
  FsDownloadRequestBody,
  FsUploadResponseBody,
  FsUploadBeginResponseBody, FsUploadChunkResponseBody, FsUploadCompleteResponseBody,
  FsSpreadsheetPreviewRequestBody, FsSpreadsheetPreviewResponseBody,
  FsStatRequestBody, FsStatResponseBody,
  WorkspaceId,
} from "@codeflowai/shared";
import { createApiResultError, requestBinaryJson, requestBlob, requestJson, throwIfRequestCancelled, type ApiRequestContext } from "../request";
import { getDesktopBridge, resolveDesktopApiRequest } from "../../services/desktop";

type FsRequestOptions = { signal?: AbortSignal };

/** 上传文档用于提取文字；会话附件沿用提取结果，不写入工作区文件。 */
export async function extractDocumentAttachment(ctx: ApiRequestContext, body: ExtractDocumentAttachmentRequestBody, options?: FsRequestOptions) {
  return requestJson<ExtractDocumentAttachmentResponseBody>(ctx, { method: "POST", path: "/api/fs/extractAttachment", body, signal: options?.signal });
}

export async function fetchFsTree(ctx: ApiRequestContext, body: FsTreeRequestBody, options?: FsRequestOptions) {
  return requestJson<FsTreeResponseBody>(ctx, { method: "POST", path: "/api/fs/tree", body, signal: options?.signal });
}

export async function fetchFsSearch(ctx: ApiRequestContext, body: FsSearchRequestBody, options?: FsRequestOptions) {
  return requestJson<FsSearchResponseBody>(ctx, { method: "POST", path: "/api/fs/search", body, signal: options?.signal });
}

/** 手工触发 workspace 文件索引重建，重建在 Client 后台执行。 */
export async function rebuildFsIndex(ctx: ApiRequestContext, body: FsReindexRequestBody, options?: FsRequestOptions) {
  return requestJson<FsReindexResponseBody>(ctx, { method: "POST", path: "/api/fs/reindex", body, signal: options?.signal });
}

export async function fetchFsReadFile(ctx: ApiRequestContext, body: FsReadFileRequestBody, options?: FsRequestOptions) {
  return requestJson<FsReadFileResponseBody>(ctx, { method: "POST", path: "/api/fs/readFile", body, signal: options?.signal });
}

/** 保存工作区文本文件；冲突由 Client 按打开时的大小/修改时间拒绝。 */
export async function fetchFsWriteFile(ctx: ApiRequestContext, body: FsWriteFileRequestBody, options?: FsRequestOptions) {
  return requestJson<FsWriteFileResponseBody>(ctx, { method: "POST", path: "/api/fs/writeFile", body, signal: options?.signal });
}

/** 下载 workspace 内原始文件，响应以 base64 承载文件内容。 */
export async function fetchFsDownloadFile(ctx: ApiRequestContext, body: FsDownloadFileRequestBody, options?: FsRequestOptions) {
  return requestJson<FsDownloadFileResponseBody>(ctx, { method: "POST", path: "/api/fs/downloadFile", body, signal: options?.signal });
}

export async function fetchFsSpreadsheetPreview(ctx: ApiRequestContext, body: FsSpreadsheetPreviewRequestBody, options?: FsRequestOptions) {
  return requestJson<FsSpreadsheetPreviewResponseBody>(ctx, { method: "POST", path: "/api/fs/spreadsheetPreview", body, signal: options?.signal });
}

export async function fetchFsDocumentPreview(ctx: ApiRequestContext, body: FsDocumentPreviewRequestBody, options?: FsRequestOptions) {
  return requestJson<FsDocumentPreviewResponseBody>(ctx, { method: "POST", path: "/api/fs/documentPreview", body, signal: options?.signal });
}

export async function fetchFsStat(ctx: ApiRequestContext, body: FsStatRequestBody, options?: FsRequestOptions) {
  return requestJson<FsStatResponseBody>(ctx, { method: "POST", path: "/api/fs/stat", body, signal: options?.signal });
}

/** 本机下载复用已校验文件读取；远端仍走权限、限速和传输审计。 */
export async function downloadWorkspaceFile(ctx: ApiRequestContext, body: FsDownloadRequestBody, options?: FsRequestOptions) {
  if (getDesktopBridge() && resolveDesktopApiRequest({ method: "POST", path: "/api/fs/downloadFile", body }, ctx.desktopClientId)) {
    const result = await fetchFsDownloadFile(ctx, body, options);
    if (!result.ok) return result;
    /** 只处理本层发现的响应损坏，保留工作区和文件上下文并显式失败。 */
    const invalidDownload = (rootCause: string): never => {
      const code = "DESKTOP_DOWNLOAD_RESPONSE_INVALID";
      console.error("[fs.desktop_download.invalid]", { code, requestId: `download:${Date.now()}`, workspaceId: body.workspaceId, path: body.path, rootCause });
      throw Object.assign(new Error(rootCause), { code });
    };
    if (typeof result.base64 !== "string" || typeof result.fileName !== "string" || !result.fileName
      || !Number.isSafeInteger(result.size) || result.size < 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(result.base64)) {
      invalidDownload("下载文件响应无效");
    }
    const decoded = atob(result.base64), bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    if (bytes.byteLength !== result.size) invalidDownload("下载文件大小不一致");
    throwIfRequestCancelled(options?.signal);
    return { ok: true as const, blob: new Blob([bytes], { type: result.mimeType || "application/octet-stream" }),
      filename: result.fileName, contentType: result.mimeType ?? null };
  }
  return requestBlob(ctx, { method: "POST", path: "/api/fs/download", body, signal: options?.signal });
}

/** 本机上传复用 Client 分片服务；共享及远端继续使用 Server 传输入口。 */
export async function uploadWorkspaceFile(
  ctx: ApiRequestContext,
  input: {
    workspaceId: WorkspaceId;
    targetDir?: string | null;
    file: File;
    overwrite?: boolean | null;
  },
  options?: FsRequestOptions,
) {
  const local = resolveDesktopApiRequest({ method: "POST", path: "/api/fs/uploadBegin", body: { workspaceId: input.workspaceId } }, ctx.desktopClientId);
  if (getDesktopBridge() && local) return uploadDesktopWorkspaceFile(ctx, input, options);
  const query = new URLSearchParams();
  query.set("workspaceId", input.workspaceId);
  query.set("fileName", input.file.name);
  query.set("sizeBytes", String(input.file.size));
  if (input.targetDir) query.set("targetDir", input.targetDir);
  if (input.file.type) query.set("mimeType", input.file.type);
  if (input.overwrite) query.set("overwrite", "true");
  return requestBinaryJson<FsUploadResponseBody>(ctx, {
    method: "POST",
    path: `/api/fs/upload?${query.toString()}`,
    body: input.file,
    contentType: "application/octet-stream",
    signal: options?.signal,
  });
}

/** 分片失败立即停止，取消临时文件；清理失败与原错误一同抛出。 */
async function uploadDesktopWorkspaceFile(ctx: ApiRequestContext, input: { workspaceId: WorkspaceId; targetDir?: string | null; file: File; overwrite?: boolean | null }, options?: FsRequestOptions) {
  throwIfRequestCancelled(options?.signal);
  // 创建期间先取得上传 ID，取消后才能可靠清理本机临时文件。
  const begin = await requestJson<FsUploadBeginResponseBody>(ctx, { method: "POST", path: "/api/fs/uploadBegin",
    body: { workspaceId: input.workspaceId, targetDir: input.targetDir, fileName: input.file.name, sizeBytes: input.file.size, mimeType: input.file.type, overwrite: input.overwrite } });
  if (!begin.ok) return begin;
  const { uploadId, chunkSizeBytes } = begin;
  try {
    throwIfRequestCancelled(options?.signal);
    if (!uploadId || !Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) throw new Error("DESKTOP_UPLOAD_RESPONSE_INVALID");
    for (let offset = 0; offset < input.file.size;) {
      throwIfRequestCancelled(options?.signal);
      const bytes = new Uint8Array(await input.file.slice(offset, offset + Math.min(chunkSizeBytes, 256 * 1024)).arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const chunk = await requestJson<FsUploadChunkResponseBody>(ctx, { method: "POST", path: "/api/fs/uploadChunk", signal: options?.signal,
        body: { workspaceId: input.workspaceId, uploadId, offset, base64: btoa(binary) } });
      if (!chunk.ok) throw createApiResultError(chunk);
      offset += bytes.length;
      if (chunk.receivedBytes !== offset) throw new Error("DESKTOP_UPLOAD_OFFSET_INVALID");
    }
    const complete = await requestJson<FsUploadCompleteResponseBody>(ctx, { method: "POST", path: "/api/fs/uploadComplete", signal: options?.signal, body: { workspaceId: input.workspaceId, uploadId } });
    if (!complete.ok) throw createApiResultError(complete);
    return { ...complete, transferId: uploadId };
  } catch (error) {
    try {
      const cancelled = await requestJson(ctx, { method: "POST", path: "/api/fs/uploadCancel", body: { workspaceId: input.workspaceId, uploadId } });
      if (!cancelled.ok) throw createApiResultError(cancelled);
    } catch (cleanupError) { throw new AggregateError([error, cleanupError], "上传失败且临时文件清理失败", { cause: error }); }
    throw error;
  }
}
