import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);

/**
 * 退回徽标的节点名索引必须来自本次快照。
 * 构建节点卡片时 editorNodes 还没被赋值，若索引从它推导，徽标会整片退化成显示 id。
 */
test("the rework badge resolves node names from the incoming snapshot", () => {
  assert.ok(
    editor.includes("const nodeLabels = buildWorkflowNodeLabelIndex(source.nodes);"),
    "快照构建必须自带节点名索引",
  );
  assert.ok(
    editor.includes("source.nodes.map((node) => toFlowNode(node, nodeLabels))"),
    "索引要传给节点卡片构建",
  );
  assert.ok(
    !editor.includes("editorNodes.value.find((item) => item.id === nodeId)?.data?.workflowNode?.label"),
    "不得再依赖正在构建中的 editorNodes 解析节点名",
  );
});
