import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);

/** Delete 键必须与「删除选中」按钮走同一条删除路径，保持选中态与只读态口径一致。 */
test("workflow editor deletes the selected node or edge with the Delete key", () => {
  assert.match(editor, /if \(event\.key !== "Delete" && event\.key !== "Backspace"\) return;/u);
  assert.match(editor, /removeSelectedBinding\(\);/u);
  assert.match(editor, /window\.addEventListener\("keydown", handleGlobalKeydown\);/u);
});

/** 删除必须收敛到单一入口：VueFlow 内置删除键不检查只读态，会绕过对内置流程的保护。 */
test("workflow editor disables the built-in VueFlow delete key", () => {
  assert.match(editor, /:delete-key-code="null"/u);
});

/** 焦点在输入控件或 contenteditable 里按 Delete 必须让位给表单自身，不能误删画布节点。 */
test("workflow editor keeps the Delete key out of editable targets and the binding dialog", () => {
  assert.match(
    editor,
    /if \(bindingEditorOpen\.value \|\| isEditableKeyboardTarget\(event\.target\)\) return;/u,
  );
  assert.match(
    editor,
    /return tagName === "input" \|\| tagName === "textarea" \|\| tagName === "select" \|\| element\.isContentEditable;/u,
  );
  assert.match(editor, /if \(!hasSelectedBinding\.value \|\| isBuiltinReadonly\.value\) return;/u);
});

/** 方向键微调沿用同一套只读与焦点门禁，Shift 走大步。 */
test("workflow editor nudges the selected node with the arrow keys", () => {
  assert.match(editor, /const NODE_NUDGE_DIRECTIONS: Record<string, \{ x: number; y: number \}> = \{/u);
  assert.match(editor, /const nudgeDirection = NODE_NUDGE_DIRECTIONS\[event\.key\];/u);
  assert.match(editor, /if \(!selectedNodeId\.value \|\| isBuiltinReadonly\.value\) return;/u);
  assert.match(editor, /nudgeSelectedNode\(nudgeDirection, event\.shiftKey\);/u);
  assert.match(editor, /const step = fast \? NODE_NUDGE_STEP_FAST : NODE_NUDGE_STEP;/u);
});

/** 微调只改坐标，但必须同步 workflowNode 并让连线按新位置重算锚点与绕行。 */
test("workflow editor keeps nudged node positions in sync with edges", () => {
  assert.match(editor, /function nudgeSelectedNode\(direction: \{ x: number; y: number \}, fast: boolean\): void \{/u);
  assert.match(editor, /workflowNode\.position = position;/u);
  assert.match(editor, /scheduleRefreshEditorEdgeAnchorLayouts\(\);/u);
});
