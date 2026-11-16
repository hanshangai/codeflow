import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("apps/web/src/features/chat/components/chat-workflow-panel.vue", "utf8");

/** 判定块区间：从待办稳定键到下一个顶层声明，只覆盖本次新增的三个函数。 */
function judgmentBlock(): string {
  const start = source.indexOf("function todoKey(");
  const end = source.indexOf('type ChatWorkflowStage = ChatWorkflowView["stages"][number];');
  assert.ok(start >= 0 && end > start, "未找到会话框接管的判定块区间");
  return source.slice(start, end);
}

test("接管判定数全局待办，且要求唯一与活跃两项成立", () => {
  const block = judgmentBlock();
  // 必须读 snapshot.value.tasks：模板的 tasks 会剔掉 superseded 与已丢弃的 dismissed，用它计数会把「实际 2 个」误判为唯一。
  assert.match(block, /snapshot\.value\.tasks\.flatMap\(/u);
  assert.doesNotMatch(block, /\btasks\.value\b/u);
  assert.match(block, /todo\.actions\.some\(a => a\.action === "resume_with_input"\)/u);
  assert.match(block, /if \(candidates\.length !== 1\) return "";/u);
  assert.match(block, /return isActive\(view\) \? todoKey\(view, todo\) : "";/u);
  assert.match(block, /return !props\.readOnly && composerInputKey\.value !== ""/u);
  // 待审核同构：判据换成 approve，唯一与活跃两个条件必须同样生效。
  assert.match(block, /const composerApprovalKey = computed\(\(\) => \{[\s\S]*?todo\.actions\.some\(a => a\.action === "approve"\)/u);
  assert.match(block, /const composerApprovalKey = computed\(\(\) => \{[\s\S]*?if \(candidates\.length !== 1\) return "";[\s\S]*?return isActive\(view\) \? todoKey\(view, todo\) : "";/u);
  assert.match(block, /function isComposerApproval\([\s\S]*?return !props\.readOnly && composerApprovalKey\.value !== ""/u);
});

test("模板按接管结果二选一，提示与流程级动作留在原位", () => {
  assert.match(source, /<template v-if="isComposerInput\(view, todo\)">/u);
  assert.match(source, /<p class="chat-workflow__todo-hint">请在下方会话框输入补充说明并发送<\/p>/u);
  // 待审核只叠加提示并隐藏 textarea：批准/提出修改按钮与分支选择必须在 v-else 分支里原样保留。
  assert.match(source, /<p v-if="isComposerApproval\(view, todo\)" class="chat-workflow__todo-hint">可在下方会话框输入「审核通过：审核意见」提交；要打回重跑请点「提出修改」<\/p>/u);
  assert.match(source, /<a-textarea v-else v-model:value="feedback\[todo\.nodeId\]"/u);
  assert.match(source, /todo\.actions\.some\(a => a\.action === 'choose_branch'\)/u);
  // 未接管分支必须原样保留：placeholder 是 e2e 契约，startRework 是流程级动作，会话框表达不了。
  assert.match(source, /placeholder="审核意见或补充内容"/u);
  assert.equal(source.match(/@click="startRework\(view\)"/gu)?.length, 3);
  assert.match(source, /:key="`\$\{todo\.nodeId\}:\$\{todo\.version\}`"/u);
  assert.match(source, /<pre v-if="todo\.summary">/u);
});

test("提示样式不声明 overflow，不新增滚动容器", () => {
  const rule = source.match(/\.chat-workflow__todo-hint \{[^}]*\}/u);
  assert.ok(rule, "未找到提示类名的样式规则");
  assert.doesNotMatch(rule[0], /overflow/u);
  assert.match(rule[0], /color: var\(--app-muted\);/u);
  // 两条提示共用同一个类名，不得为待审核另起样式（新增滚动盒会连带改滚动条分组断言）。
  assert.equal(source.match(/\.chat-workflow__todo-hint \{/gu)?.length, 1);
  assert.equal(source.match(/class="chat-workflow__todo-hint"/gu)?.length, 2);
});
