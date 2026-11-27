import type { PreviewWindow } from "../../store/ui";
import { getFileEditorDraft, isFileEditorDirty, type FileEditorDraft } from "./fileEditorState";

/** 独立预览窗口的草稿作用域：与内嵌预览隔离，关闭窗口不会丢弃面板编辑。 */
export function previewWindowEditorScope(windowId: string): string {
  return `window:${windowId}`;
}

export function previewWindowEditorDraft(win: PreviewWindow): FileEditorDraft | null {
  if (!win.workspaceId || win.content == null) return null;
  return getFileEditorDraft(win.workspaceId, win.filePath, previewWindowEditorScope(win.id));
}

export function isDirtyPreviewWindow(win: PreviewWindow): boolean {
  return isFileEditorDirty(previewWindowEditorDraft(win));
}

export function hasDirtyPreviewWindows(windows: PreviewWindow[]): boolean {
  return windows.some(isDirtyPreviewWindow);
}
