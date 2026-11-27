import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canEditFilePreview, clearFileEditorDrafts, discardFileEditorDraft, ensureFileEditorDraft, getFileEditorDraft,
  isFileEditorDirty, updateFileEditorContent,
} from "../src/features/explorer/fileEditorState.ts";

/** 读取实际组件，验证保存入口仍绑定共享草稿。 */
function source(path: string): string {
  return readFileSync(`apps/web/src/features/explorer/${path}`, "utf8");
}

function preview(overrides: Record<string, unknown> = {}) {
  return { content: "line\n", size: 5, mtimeMs: 1000, truncated: false, encoding: "utf8" as const, isBinary: false, ...overrides };
}

test("只有本地 UTF-8 文本/代码和 Markdown 原文可编辑", () => {
  const local = "workspace-1" as never;
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "code", preview: preview() }), true);
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "markdown", preview: preview(), rawMarkdown: true }), true);
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "markdown", preview: preview() }), false);
  assert.equal(canEditFilePreview({ workspaceId: "shared:abc" as never, previewType: "code", preview: preview() }), false);
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "html", preview: preview() }), false);
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "code", preview: preview({ encoding: "gb18030" }) }), false);
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "code", preview: preview({ truncated: true }) }), false);
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "code", preview: preview({ mtimeMs: null }) }), false);
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "code", preview: preview({ size: 6 * 1024 * 1024 }) }), false);
  assert.equal(canEditFilePreview({ workspaceId: local, previewType: "code", preview: preview({ isBinary: true }) }), false);
});

test("草稿在未保存、放弃和外部刷新之间保持正确基线", () => {
  clearFileEditorDrafts();
  const workspace = "workspace-1" as never;
  const draft = ensureFileEditorDraft(workspace, "src/a.ts", preview());
  updateFileEditorContent(draft, "changed\n");
  assert.equal(isFileEditorDirty(draft), true);
  // 有草稿时外部刷新不能覆盖用户输入或基线。
  ensureFileEditorDraft(workspace, "src/a.ts", preview({ content: "external\n", mtimeMs: 2000, size: 9 }));
  assert.equal(draft.content, "changed\n");
  assert.equal(draft.baseMtimeMs, 1000);
  discardFileEditorDraft(draft);
  assert.equal(draft.content, "line\n");
  assert.equal(isFileEditorDirty(draft), false);
  // 无修改时同步新一轮读取事实。
  ensureFileEditorDraft(workspace, "src/a.ts", preview({ content: "reloaded\n", mtimeMs: 3000, size: 9 }));
  assert.equal(draft.content, "reloaded\n");
  assert.equal(draft.baseMtimeMs, 3000);
  assert.equal(getFileEditorDraft(workspace, "src/a.ts"), draft);
});

test("预览窗口和内嵌面板都通过共享草稿保存并确认关闭", () => {
  const windowSource = source("components/explorer-preview-window.vue");
  assert.match(windowSource, /saveFileEditorDraft/u);
  assert.match(windowSource, /确认丢弃|有未保存的修改/u);
  assert.match(windowSource, /KeyCode\.KeyS|保存 \(Ctrl\+S\)/u);
  const panelSource = source("components/explorer-panel.vue");
  assert.match(panelSource, /savePreviewEdits/u);
  assert.match(panelSource, /@save="savePreviewEdits"/u);
  assert.match(source("components/code-preview.vue"), /editable/u);
});
