import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editorSource = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);
const graphViewSource = readFileSync(
  new URL("../src/features/orchestration/components/workflow-graph-view.vue", import.meta.url),
  "utf8",
);

/** 编辑器的开始/结束是纯配置态：只留居中节点名，类型徽标与节点名重复，不再展示。 */
test("编辑器把开始/结束渲染成圆形，且只保留居中节点名", () => {
  assert.match(editorSource, /'wf-editor__node--terminal': isWorkflowTerminalNodeType\(nodeProps\.data\.workflowNode\.type\)/u);
  assert.match(editorSource, /class="wf-editor__node-terminal-label"/u);
  // 类型徽标与指标块必须落在非终止符分支里，否则圆内会重新长出重复内容。
  assert.match(editorSource, /<template v-else>\s*<div class="wf-editor__node-head">/u);
});

/**
 * 运行画布上的开始/结束有真实节点状态（实例 node_states_json 含 start/end），
 * 而「结束」的类型色与「失败」同为 danger，只靠颜色区分不出来，因此运行态必须给出状态文字。
 */
test("运行画布的开始/结束保留运行态状态文字", () => {
  // 配置态不展示：类型名与节点名重复。
  assert.match(graphViewSource, /terminalStatusLabel: null,/u);
  // 运行态把工作台状态文案交给圆内小字。
  assert.match(graphViewSource, /terminalStatusLabel: terminal \? workbench\.statusLabel : null,/u);
  // 模板必须真的渲染它，并且和 terminal 绑定。
  assert.match(
    graphViewSource,
    /v-if="nodeProps\.data\.terminal && nodeProps\.data\.terminalStatusLabel"/u,
  );
});
