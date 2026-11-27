import { reactive } from "vue";
import type { FsWriteFileResponseBody, WorkspaceId } from "@codeflowai/shared";
import type { ApiRequestContext } from "../../api/request";
import { isSharedWorkspaceSelectionId } from "../../utils/workspaceId";

/** 与 Client 编辑上限及预览读取上限一致；更大的文件不进入编辑器。 */
export const FILE_EDIT_MAX_BYTES = 512 * 1024;

export type FileEditorSource = {
  content: string;
  mtimeMs?: number | null;
  size?: number | null;
  truncated?: boolean | null;
  encoding?: "utf8" | "gb18030" | null;
};

export type FileEditorDraft = {
  key: string;
  original: string;
  content: string;
  baseMtimeMs: number | null;
  baseSize: number | null;
  saving: boolean;
  error: string;
};

const drafts = reactive(new Map<string, FileEditorDraft>());

/** 内嵌预览按路径共享草稿；独立窗口使用各自作用域，避免关闭窗口丢弃别处编辑。 */
export function fileEditorKey(workspaceId: WorkspaceId, filePath: string, scope = "panel"): string {
  return `${workspaceId}\u0000${scope}\u0000${filePath}`;
}

type EditablePreviewFacts = Omit<FileEditorSource, "content"> & { content: string | null; isBinary?: boolean };

/** 只允许本地工作区的 UTF-8 文本/代码；Markdown 仅在原文模式可编辑。 */
export function canEditFilePreview(input: {
  workspaceId: WorkspaceId;
  previewType: string;
  preview: EditablePreviewFacts | null;
  rawMarkdown?: boolean;
}): boolean {
  if (isSharedWorkspaceSelectionId(input.workspaceId)) return false;
  const preview = input.preview;
  if (!preview || preview.content == null || preview.isBinary) return false;
  const editableType = input.previewType === "code" || (input.previewType === "markdown" && input.rawMarkdown === true);
  if (!editableType) return false;
  // 编码未知（旧窗口快照）不能假定 UTF-8，必须由读取结果明确确认。
  return preview.encoding === "utf8" && !preview.truncated
    && Number(preview.size ?? 0) <= FILE_EDIT_MAX_BYTES && preview.mtimeMs != null;
}

/** 读取共享草稿；未初始化时按当前预览建立基线。 */
export function ensureFileEditorDraft(workspaceId: WorkspaceId, filePath: string, source: FileEditorSource, scope = "panel"): FileEditorDraft {
  const key = fileEditorKey(workspaceId, filePath, scope);
  const existing = drafts.get(key);
  if (existing) {
    // 未修改时同步外部重新加载的内容；有草稿时保留用户输入与原基线用于冲突检测。
    if (!isFileEditorDirty(existing)) {
      existing.original = source.content;
      existing.content = source.content;
      existing.baseMtimeMs = source.mtimeMs ?? existing.baseMtimeMs;
      existing.baseSize = source.size ?? existing.baseSize;
      existing.error = "";
    }
    return existing;
  }
  drafts.set(key, { key, original: source.content, content: source.content,
    baseMtimeMs: source.mtimeMs ?? null, baseSize: source.size ?? null, saving: false, error: "" });
  return drafts.get(key)!;
}

export function getFileEditorDraft(workspaceId: WorkspaceId, filePath: string, scope = "panel"): FileEditorDraft | null {
  return drafts.get(fileEditorKey(workspaceId, filePath, scope)) ?? null;
}

/** 关闭独立窗口时移除其私有草稿；内嵌预览草稿不受影响。 */
export function removeFileEditorDraft(draft: FileEditorDraft): void {
  drafts.delete(draft.key);
}

export function isFileEditorDirty(draft: FileEditorDraft | null | undefined): boolean {
  return Boolean(draft && draft.content !== draft.original);
}

export function updateFileEditorContent(draft: FileEditorDraft, content: string): void {
  draft.content = content;
  draft.error = "";
}

/** 放弃本轮修改并恢复打开时内容。 */
export function discardFileEditorDraft(draft: FileEditorDraft): void {
  draft.content = draft.original;
  draft.error = "";
}

/** 保存成功后把当前内容作为新基线；冲突等失败保留草稿并返回原因。 */
export async function saveFileEditorDraft(ctx: ApiRequestContext, draft: FileEditorDraft,
  workspaceId: WorkspaceId, filePath: string): Promise<FsWriteFileResponseBody> {
  if (draft.saving) throw new Error("正在保存，请稍候");
  if (!isFileEditorDirty(draft)) throw new Error("没有需要保存的修改");
  draft.saving = true;
  draft.error = "";
  try {
    const { fetchFsWriteFile } = await import("../../api/fs");
    const result = await fetchFsWriteFile(ctx, { workspaceId, path: filePath, content: draft.content,
      expectedMtimeMs: draft.baseMtimeMs, expectedSize: draft.baseSize });
    if (!result.ok) throw new Error(result.message || "保存失败");
    draft.original = draft.content;
    draft.baseMtimeMs = result.mtimeMs;
    draft.baseSize = result.size;
    return result;
  } catch (error) {
    draft.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    draft.saving = false;
  }
}

/** 仅测试或退出登录时清空内存草稿。 */
export function clearFileEditorDrafts(): void {
  drafts.clear();
}
