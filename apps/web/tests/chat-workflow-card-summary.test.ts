import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url), "utf8");

/** 折叠行模板块：从摘要容器类名到包住完整卡片的 <template v-else>。 */
function summaryBlock(): string {
  const start = source.indexOf('<div v-if="isFolded(view)" class="chat-workflow__summary"');
  const end = source.indexOf("<template v-else>", start);
  assert.ok(start >= 0 && end > start, "未找到折叠行模板块");
  return source.slice(start, end);
}

test("模板改读可见列表，折叠行取代完整卡片", () => {
  assert.match(source, /<section v-if="visibleTasks\.length \|\| error" class="chat-workflow"/u);
  assert.match(source, /<article v-for="view in visibleTasks" :key="view\.task\.id"/u);
  // 流程级动作仍是 3 处：折叠行与「收起」按钮不得掺进 startRework（会话框表达不了返工）。
  assert.equal(source.match(/@click="startRework\(view\)"/gu)?.length, 3);
});

test("折叠行只放状态标签、标题、工作流名与展开 / 隐藏", () => {
  const block = summaryBlock();
  assert.match(block, /v-if="isFolded\(view\)"/u);
  // 状态标签必须保留：折叠后「验收通过」等终态文案仍要可见。
  assert.match(block, /<a-tag :color="labelColor\(view\)">\{\{ label\(view\) \}\}<\/a-tag>/u);
  assert.match(block, /\{\{ view\.task\.title \}\}/u);
  assert.match(block, /\{\{ view\.task\.workflow\.name \}\}/u);
  assert.match(block, /aria-expanded="false"/u);
  assert.match(block, /toggleCardExpanded\(view\.task\.id\)/u);
  // 不得复用待办提示类名（那条样式有独立断言，且语义不同）。
  assert.doesNotMatch(block, /chat-workflow__todo-hint/u);
});

test("隐藏入口仅只读会话之外渲染，函数内再做一次守卫", () => {
  assert.match(summaryBlock(), /<a-popconfirm v-if="!readOnly"[\s\S]*?@confirm="hideCard\(view\.task\.id\)"/u);
  assert.match(
    source,
    /function hideCard\(taskId: string\): void \{\s*if \(props\.readOnly\) return;\s*hideChatWorkflowCard\(props\.threadId, taskId\);\s*\}/u,
  );
});

test("展开态用写时复制，且随会话切换复位", () => {
  assert.match(source, /const expandedTaskIds = ref<Set<string>>\(new Set\(\)\);/u);
  assert.match(source, /const next = new Set\(expandedTaskIds\.value\);[\s\S]*?expandedTaskIds\.value = next;/u);
  // 复位块：:key 重挂载覆盖不到「key 未变而 threadId 变」的场景。
  assert.match(source, /watch\(\(\) => \[props\.workspaceId, props\.threadId\][\s\S]*?expandedTaskIds\.value = new Set\(\);/u);
});

test("判定用的原始快照不被隐藏过滤污染", () => {
  // 接管判定必须读未过滤的 snapshot：读 visibleTasks 会让被隐藏卡上的待办漏算。
  assert.match(source, /const composerInputKey = computed\(\(\) => \{\s*const candidates = snapshot\.value\.tasks\.flatMap\(/u);
  assert.match(source, /const composerApprovalKey = computed\(\(\) => \{\s*const candidates = snapshot\.value\.tasks\.flatMap\(/u);
  // 失败分支改为抛带 code 的结构化错误（createApiResultError），快照只接成功结果。
  assert.match(source, /if \(!result\.ok\) throw createApiResultError\(result\);\s*snapshot\.value = result;/u);
  assert.doesNotMatch(source, /snapshot\.value = [^\n]*visibleTasks/u);
});

test("折叠行样式不引入滚动盒、断点与保留类名", () => {
  const rules = [...source.matchAll(/\.chat-workflow__summary[^{]*\{([^}]*)\}/gu)];
  assert.ok(rules.length >= 2, "未找到折叠行样式规则");
  for (const rule of rules) assert.doesNotMatch(rule[1], /overflow/u, "折叠行不得新增滚动盒（会连带改滚动条分组断言）");
  assert.match(source, /\.chat-workflow__summary :deep\(\.ant-btn\)/u);
  // 折叠行不得新增断点：目前只允许无障碍降级与既有移动端断点各一条。
  assert.deepEqual(
    [...source.matchAll(/@media[^{]*/gu)].map((match) => match[0].trim()),
    ["@media (prefers-reduced-motion: reduce)", "@media (max-width: 767px)"],
  );
  assert.doesNotMatch(source, /chat-workflow__toggle|chat-workflow__toolbar|chat-workflow__icon|刷新工作流状态/u);
});
