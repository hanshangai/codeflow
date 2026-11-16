import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panelSource = readFileSync(
  new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url),
  "utf8",
);
const serviceSource = readFileSync(
  new URL("../../desktop/client/src/orchestration/chatWorkflowService.ts", import.meta.url),
  "utf8",
);

test("门禁待办在会话卡片上给出忽略入口，并由危险确认把关", () => {
  // 按钮文案由客户端视图给出（忽略门禁继续），卡片不硬编码文案。
  assert.match(serviceSource, /\{ action: "override", label: "忽略门禁继续", effect: "忽略门禁未通过结果/u);
  assert.match(serviceSource, /\{ action: "reevaluate_gates", label: "重新评估门禁"/u);
  assert.match(panelSource, /<a-popconfirm v-if="choice\.action === 'override'" title="确认忽略门禁并通过该节点？后续流程可能因缺少可靠结果而失败。" ok-text="确认忽略门禁" cancel-text="取消"/u);
  assert.match(panelSource, /<a-button danger :disabled="readOnly \|\| busy"><Check :size="14" \/>\{\{ choice\.label \}\}<\/a-button>/u);
  // 模板里不得硬编码按钮文案（注释与 <script> 说明不在模板范围内）。
  const template = panelSource.slice(panelSource.indexOf("<template>"));
  assert.doesNotMatch(template, /忽略门禁继续/u);
});

test("门禁待办不被会话框接管，避免动作按钮被一并隐藏", () => {
  assert.match(
    panelSource,
    /\.filter\(todo => todo\.actions\.some\(a => a\.action === "resume_with_input"\)\s*\n\s*&& !todo\.actions\.some\(a => a\.action === "override"\)\)/u,
  );
});

test("两条分支共用同一份提交负载，避免其中一路漏传 nodeVersion", () => {
  assert.match(panelSource, /function todoActionPayload\(todo: ChatWorkflowTodo\) \{[\s\S]*?feedback: feedback\.value\[todo\.nodeId\], targetNodeId: branches\.value\[todo\.nodeId\]/u);
  assert.equal(panelSource.split("{ ...todoActionPayload(todo), feedbackAction: choice.action }").length - 1, 2);
});
