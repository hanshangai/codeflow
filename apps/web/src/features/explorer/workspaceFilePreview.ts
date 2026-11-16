import type { FsReadFileResponseBody, FsSpreadsheetPreviewResponseBody, WorkspaceId } from "@codeflowai/shared";

import { fetchFsDocumentPreview, fetchFsReadFile, fetchFsSpreadsheetPreview } from "../../api/fs";
import type { ApiRequestContext } from "../../api/request";

export type WorkspaceFilePreviewType = "code" | "image" | "markdown" | "html" | "spreadsheet" | "pdf" | "word" | "presentation" | "binary" | "none";

export type WorkspaceFilePreviewResult = {
  preview: FsReadFileResponseBody | null;
  spreadsheet: FsSpreadsheetPreviewResponseBody | null;
  previewType: WorkspaceFilePreviewType;
};

const SPREADSHEET_EXTS = new Set(["xlsx", "xlsm", "xls", "csv", "tsv"]);
const DOCUMENT_EXTS = new Set(["pdf", "docx", "pptx"]);

/** 判断工作区路径是否应走结构化表格预览。 */
export function isSpreadsheetPreviewPath(filePath: string): boolean {
  const ext = String(filePath ?? "").split(".").pop()?.toLowerCase() ?? "";
  return SPREADSHEET_EXTS.has(ext);
}

/** 判断工作区路径是否应走结构化文档预览。 */
export function isDocumentPreviewPath(filePath: string): boolean {
  const ext = String(filePath ?? "").split(".").pop()?.toLowerCase() ?? "";
  return DOCUMENT_EXTS.has(ext);
}

/** 根据普通文件读取响应推断前端预览组件类型。 */
export function detectPreviewType(data: FsReadFileResponseBody): WorkspaceFilePreviewType {
  if (data.base64 && data.mimeType?.startsWith("image/")) return "image";
  if (data.isBinary) return "binary";
  if (data.content == null) return "none";

  const ext = data.path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return "code";
}

/** 统一加载工作区文件预览；表格文件走结构化接口，其余文件沿用 readFile。 */
export async function loadWorkspaceFilePreview(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  filePath: string,
  opts?: { maxBytes?: number | null; sheetName?: string | null; maxRows?: number | null; maxColumns?: number | null; signal?: AbortSignal },
): Promise<WorkspaceFilePreviewResult> {
  if (isSpreadsheetPreviewPath(filePath)) {
    const res = await fetchFsSpreadsheetPreview(ctx, {
      workspaceId,
      path: filePath,
      sheetName: opts?.sheetName,
      maxRows: opts?.maxRows,
      maxColumns: opts?.maxColumns,
    }, { signal: opts?.signal });
    if (!res.ok) throw new Error(res.message);
    return { preview: null, spreadsheet: res, previewType: "spreadsheet" };
  }

  if (isDocumentPreviewPath(filePath)) {
    const res = await fetchFsDocumentPreview(ctx, { workspaceId, path: filePath }, { signal: opts?.signal });
    if (!res.ok) throw new Error(res.message);
    return {
      preview: {
        path: res.path,
        content: res.content ?? null,
        isBinary: res.kind !== "word",
        size: res.size,
        base64: res.base64 ?? null,
        mimeType: res.mimeType ?? null,
      },
      spreadsheet: null,
      previewType: res.kind,
    };
  }

  const res = await fetchFsReadFile(ctx, {
    workspaceId,
    path: filePath,
    maxBytes: opts?.maxBytes,
  }, { signal: opts?.signal });
  if (!res.ok) throw new Error(res.message);
  return { preview: res, spreadsheet: null, previewType: detectPreviewType(res) };
}
