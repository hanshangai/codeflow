import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const threadListSource = readFileSync(
  new URL("../src/features/threads/components/thread-list.vue", import.meta.url),
  "utf8",
);

/** 桌面会话侧栏已下线「全部」分类：只保留 普通 / 流程 / 知识 / 归档 四个入口。 */
test("会话分类不再提供「全部」tab", () => {
  assert.ok(!threadListSource.includes('value: "all" as ThreadFilterTab'), "「全部会话」入口应已下线");
  assert.ok(
    threadListSource.includes('if (tab === "all") switchThreadFilter("current")'),
    "历史持久化的 all 需要回落到「普通」，否则会出现没有任何 tab 高亮",
  );
});

/** 顶部动作按钮固定为「+ 新建」：它点开的一直是新建会话弹框，文案不应随分类变化。 */
test("顶部动作按钮文案不随分类变化", () => {
  assert.ok(threadListSource.includes('@click="openCreate">+ 新建</a-button>'), "新建按钮应固定显示「+ 新建」");
  assert.ok(!threadListSource.includes("'知识库' : '+ 新建'"), "不应再按当前 tab 切换按钮文案");
});

/** 点击「+ 新建」始终打开新建会话弹框：知识分类下也不改成跳知识库页面。 */
test("新建按钮在知识分类下同样打开新建会话弹框", () => {
  const body = threadListSource.match(/const openCreate = \(\) => \{[\s\S]*?\n\};/u)?.[0] ?? "";
  assert.ok(body, "应有 openCreate 定义");
  assert.match(body, /createOpen\.value = true;/u, "点击后应打开新建会话弹框");
  assert.ok(!body.includes('router.push("/knowledge")'), "不应再把该点击改成跳知识库页面");
});

test("刷新图标旋转内层 SVG，避免小号按钮的 anticon 缩放覆盖旋转", () => {
  assert.match(threadListSource, /<Loading3QuartersOutlined v-if="refreshing" class="thread-list__refresh-spinner" \/>/u);
  assert.match(threadListSource, /\.thread-list__refresh-spinner :deep\(svg\) \{\s*animation: thread-list-refresh-spin 1s linear infinite;/u);
  assert.match(threadListSource, /@keyframes thread-list-refresh-spin \{\s*from \{ transform: rotate\(0deg\); \}\s*to \{ transform: rotate\(360deg\); \}/u);
});

test("刷新期间禁用按钮，停止转圈渲染后才显示成功提示", () => {
  assert.match(threadListSource, /:disabled="!canRead \|\| refreshing"\s*:aria-busy="refreshing"\s*aria-label="刷新列表"/u);
  const body = threadListSource.match(/async function refreshActiveThreadList\(\): Promise<void> \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(body, /if \(refreshing\.value\) return;/u);
  assert.match(body, /await holdRefreshFeedback\(startedAt\);\s*refreshing\.value = false;\s*await nextTick\(\);/u);
  assert.match(body, /if \(refreshed\) message\.success\("列表已刷新"\);/u);
});
