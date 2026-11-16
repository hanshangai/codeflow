import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);
const graph = readFileSync(
  new URL("../src/features/orchestration/components/workflow-graph-view.vue", import.meta.url),
  "utf8",
);

/** 编辑和只读画布关闭时都跳过解释性退回线，不影响各自的正常流程边。 */
test("editor and instance graphs both honor the rework edge preference", () => {
  for (const source of [editor, graph]) {
    assert.match(source, /showReworkEdges\.value\s*\? buildWorkflowReworkEdges\(/u);
    assert.ok(source.includes("useWorkflowReworkEdgeVisibility("), "画布必须接入统一偏好");
  }
  assert.ok(editor.includes("...editorEdges.value,"));
  assert.ok(graph.includes("...withWorkflowEdgeRouting("));
});

/** 实例使用快照中的工作流身份，不能按实例 ID 或当前选中的资产串用偏好。 */
test("editor and frozen instance workflow identities feed the shared preference", () => {
  assert.ok(editor.includes("useWorkflowReworkEdgeVisibility(() => props.workspaceId, () => props.workflowId)"));
  assert.ok(graph.includes("useWorkflowReworkEdgeVisibility(() => props.workflow?.workspaceId, () => props.workflow?.id)"));
  assert.ok(!editor.includes("codeflow-orch-rework-edges"), "存储键必须由统一入口管理");
});

/** 所有画布提供切换和失败后重试入口，存储失败不能伪装成成功。 */
test("both canvas toggles use the shared setter and expose preference errors", () => {
  for (const source of [editor, graph]) {
    assert.ok(source.includes("showReworkEdges ? \"隐藏退回线\" : \"显示退回线\""));
    assert.ok(source.includes("@click=\"setReworkEdgeVisibility(!showReworkEdges)\""));
    assert.ok(source.includes("v-if=\"reworkEdgePreferenceError\" type=\"error\""));
    assert.ok(source.includes("@click=\"reloadReworkEdgeVisibility\""));
  }
  assert.ok(!editor.includes("<span>显示退回线</span>"), "流程设置里不应再保留该开关");
});
