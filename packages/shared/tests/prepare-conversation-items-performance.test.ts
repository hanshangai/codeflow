import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationExplore, ConversationItem, ConversationReview, ConversationTool, ItemId } from "../src/index.ts";
import { prepareConversationItemsForDisplay } from "../src/conversation/prepareConversationItems.ts";

type ExploreEntry = ConversationExplore["entries"][number];

/** 模拟投影已生成的摘要，保留真实展示入口的复制与合并过程。 */
function projectedTool(id: string, display: ConversationExplore | ConversationReview): ConversationTool {
  return {
    kind: "tool", id: id as ItemId, toolType: "shell", title: "shell", detail: "", status: "completed",
    _display: display,
  } as ConversationTool;
}

/** 构造探索摘要；测试中的预期结果仍由字面量独立给出。 */
function explore(id: string, entries: ExploreEntry[], status: ConversationExplore["status"] = "explored"): ConversationExplore {
  return { kind: "explore", id: id as ItemId, status, entries };
}

test("连续探索合并只线性访问条目，并保留首次出现的顺序", () => {
  const count = 800;
  let labelReads = 0;
  const items = Array.from({ length: count }, (_, index) => projectedTool(`tool-${index}`, explore(`explore-${index}`, [{
    kind: "read",
    // 字段访问计数衡量真实合并工作量，避免机器速度影响性能断言。
    get label() { labelReads += 1; return `file-${index}.ts`; },
  }])));

  const result = prepareConversationItemsForDisplay(items);
  const mergeReads = labelReads;
  assert.equal(result.length, 1);
  const group = result[0] as ConversationExplore;
  assert.equal(group.id, "explore-0");
  assert.equal(group.entries.length, count);
  assert.equal(group.entries[0]?.label, "file-0.ts");
  assert.equal(group.entries.at(-1)?.label, "file-799.ts");
  assert.ok(mergeReads <= count * 3, `合并 ${count} 条探索访问 label ${mergeReads} 次，应保持线性`);
});

test("合并按 kind、label、detail 去重且不改动冻结的投影输入", () => {
  const first = explore("first", [
    { kind: "read", label: "源码.ts", detail: "src/源码.ts" },
    { kind: "read", label: "源码.ts", detail: "src/源码.ts" },
  ]);
  const second = explore("second", [
    { kind: "read", label: "源码.ts", detail: "src/源码.ts" },
    { kind: "read", label: "源码.ts", detail: "other/源码.ts" },
    { kind: "search", label: "源码.ts", detail: "src/源码.ts" },
    { kind: "list", label: "." },
    { kind: "list", label: ".", detail: "" },
  ]);
  Object.freeze(first.entries);
  Object.freeze(first);
  Object.freeze(second.entries);
  Object.freeze(second);

  const result = prepareConversationItemsForDisplay([projectedTool("a", first), projectedTool("b", second)]);
  assert.deepEqual(result, [explore("first", [
    { kind: "read", label: "源码.ts", detail: "src/源码.ts" },
    { kind: "read", label: "源码.ts", detail: "other/源码.ts" },
    { kind: "search", label: "源码.ts", detail: "src/源码.ts" },
    { kind: "list", label: "." },
  ])]);
  assert.equal(first.entries.length, 2);
  assert.equal(second.entries.length, 5);
});

test("状态、review 与非探索条目均中断探索分组", () => {
  const entry: ExploreEntry = { kind: "read", label: "a.ts" };
  const review: ConversationReview = { kind: "review", id: "review" as ItemId, state: "completed", text: "检查完成" };
  const message: ConversationItem = { kind: "message", id: "message" as ItemId, role: "user", text: "继续" };
  const items = [
    projectedTool("a", explore("done", [entry])),
    projectedTool("b", explore("running", [entry], "exploring")),
    projectedTool("c", explore("running-next", [entry, { kind: "read", label: "b.ts" }], "exploring")),
    projectedTool("review-tool", review),
    projectedTool("d", explore("after-review", [entry])),
    message,
    projectedTool("e", explore("after-message", [entry, entry])),
  ];

  assert.deepEqual(prepareConversationItemsForDisplay(items), [
    explore("done", [entry]),
    explore("running", [entry, { kind: "read", label: "b.ts" }], "exploring"),
    review,
    explore("after-review", [entry]),
    message,
    explore("after-message", [entry, entry]),
  ]);
});

test("原始探索条目作为合并起点时不修改输入对象", () => {
  const first = explore("original", [{ kind: "read", label: "a.ts" }]);
  Object.freeze(first.entries);
  Object.freeze(first);
  const result = prepareConversationItemsForDisplay([
    first,
    projectedTool("b", explore("next", [{ kind: "read", label: "b.ts" }])),
  ]);
  assert.deepEqual(result, [explore("original", [{ kind: "read", label: "a.ts" }, { kind: "read", label: "b.ts" }])]);
  assert.equal(first.entries.length, 1);
});
