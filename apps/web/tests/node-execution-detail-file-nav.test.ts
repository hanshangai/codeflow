import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const detailSource = readFileSync(
  new URL("../src/features/orchestration/components/node-execution-detail.vue", import.meta.url),
  "utf8",
);

test("文件区 Git 状态指示不占用交付物列表的文档流", () => {
  // 状态提示曾经以 v-if 插在列表上方，打开节点详情时会先顶下去再弹回，形成跳闪。
  assert.match(detailSource, /node-detail__file-nav-head-main/u);
  assert.match(detailSource, /node-detail__file-nav-status/u);
  assert.doesNotMatch(detailSource, /node-detail__file-nav-note/u);
});
