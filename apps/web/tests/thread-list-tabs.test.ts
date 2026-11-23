import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("会话列表不再提供规格 tab，历史选择静默回退到普通会话", () => {
  const source = readFileSync(new URL("../src/features/threads/components/thread-list.vue", import.meta.url), "utf8");
  assert.doesNotMatch(source, /title: "规格会话"/u);
  assert.match(source, /title: "普通会话"/u);
  assert.match(source, /title: "流程会话"/u);
  assert.match(source, /title: "归档会话"/u);
  assert.match(source, /ui\.threadFilterTab = "current"/u);
});
