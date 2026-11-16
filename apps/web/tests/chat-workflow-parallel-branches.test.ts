import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(
  new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url),
  "utf8",
);

/** 并行分支之间是并列关系，用箭头会被读成先后顺序，因此分支起点前改用 ∥。 */
test("并行分支首项前用 ∥ 连接，替代先后箭头", () => {
  assert.match(panel, /'chat-workflow__arrow--parallel': stage\.parallelLink/u, "箭头要按 parallelLink 切换样式");
  // 起点必须取服务端按展示顺序标出的 isBranchStart，不能靠相邻分支号比较（分支可能交错）。
  assert.match(panel, /parallelLink: stage\.isBranchStart === true/u, "起点由服务端标注，不做相邻比较");
  assert.match(panel, /\.chat-workflow__arrow--parallel::before \{\s*content: "∥"/u, "∥ 由样式绘制");
  assert.match(panel, /\.chat-workflow__arrow--parallel::after \{ content: none; \}/u, "并行处不再画箭头");
});

/** 分支内每个节点都带序号，否则后续节点看不出自己属于哪一支。 */
test("并行分支成员都带带圈序号", () => {
  assert.match(panel, /<span v-if="stage\.branchBadge" class="chat-workflow__stage-branch">/u, "chip 里要渲染序号");
  assert.match(panel, /const BRANCH_BADGES = \["①"/u, "序号从 ① 开始");
  assert.match(panel, /branchBadge: branchIndex === null \? null : \(BRANCH_BADGES\[branchIndex\] \?\? `#\$\{branchIndex \+ 1\}`\)/u, "超出范围退回 #n");
});
