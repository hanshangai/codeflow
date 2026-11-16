import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const detail = readFileSync(
  new URL("../src/features/orchestration/components/node-execution-detail.vue", import.meta.url),
  "utf8",
);
const chatPanel = readFileSync(
  new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url),
  "utf8",
);
const monitor = readFileSync(
  new URL("../src/features/orchestration/components/orchestration-monitor.vue", import.meta.url),
  "utf8",
);

/** 会话卡片的外层弹窗已经有节点名，内部标题必须可关闭，否则同一个名字出现两次。 */
test("node detail can hide its inline headline title", () => {
  assert.ok(detail.includes("hideHeadlineTitle?: boolean;"), "组件需要提供隐藏内部标题的开关");
  assert.ok(detail.includes('<h4 v-if="!hideHeadlineTitle">'), "内部标题要受开关控制");
});

/** 会话卡片传开关；编排监控是分栏面板、没有别的标题来源，必须保持显示。 */
test("only the chat card hides the inline headline title", () => {
  assert.ok(chatPanel.includes("hide-headline-title"), "会话卡片应关闭内部标题");
  assert.ok(!monitor.includes("hide-headline-title"), "编排监控需保留内部标题，不得被一起关掉");
});

/** 标题旁还有「版本规则说明」按钮：隐藏标题时不能连它一起消失。 */
test("hiding the headline keeps the revision help button", () => {
  assert.ok(
    detail.includes("!hideHeadlineTitle || selectedOutputRevisionCaption || canReviseSelectedOutputArtifact"),
    "容器条件需保证只剩说明按钮时仍然渲染",
  );
  assert.ok(
    detail.includes('<a-popover v-if="selectedOutputRevisionCaption || canReviseSelectedOutputArtifact"'),
    "说明按钮保持原有显示条件",
  );
});
