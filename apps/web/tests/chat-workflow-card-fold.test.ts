import test from "node:test";
import assert from "node:assert/strict";

import { CHAT_WORKFLOW_ACTIVE_STATUS_LIST, type ChatWorkflowView } from "@codeflowai/shared";

import {
  isChatWorkflowCardFoldable,
  isChatWorkflowCardFolded,
  visibleChatWorkflowCards,
} from "../src/features/chat/chatWorkflowCardFold.ts";

/** 构造判定所需的最小视图；未列出的字段不参与折叠判定，给空值即可。 */
function makeView(options: {
  id?: string;
  status?: ChatWorkflowView["status"];
  accepted?: boolean;
  todos?: number;
  rework?: boolean;
} = {}): ChatWorkflowView {
  const { id = "task-1", status = null, accepted = false, todos = 0, rework = false } = options;
  return {
    task: {
      id,
      rework: rework ? { nodeId: "node-1", reason: "重做", affectedNodeIds: [], resultVersion: "v1" } : null,
    },
    status,
    accepted,
    todos: Array.from({ length: todos }, (_, index) => ({
      nodeId: `node-${index}`,
      label: "方案设计",
      version: "v1",
      status: "waiting-feedback",
      summary: "",
      question: "请补充",
      actions: [],
      branches: [],
    })),
  } as unknown as ChatWorkflowView;
}

test("白名单折叠：只有已验收、失败、已终止三种终态才折叠", () => {
  for (const status of CHAT_WORKFLOW_ACTIVE_STATUS_LIST) {
    for (const accepted of [false, true]) {
      assert.equal(isChatWorkflowCardFoldable(makeView({ status, accepted })), false, `${status} (accepted=${accepted}) 不得折叠`);
    }
  }
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: "completed", accepted: false })), false);
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: "completed", accepted: true })), true);
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: "failed" })), true);
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: "cancelled" })), true);
});

test("保底：status 为空（推荐卡 / 交接卡 / 启动中 / 实例被清理）一律不折叠", () => {
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: null })), false);
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: null, accepted: true })), false);
});

test("人工信号优先：有待办或待确认返工时永不折叠", () => {
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: "completed", accepted: true, todos: 1 })), false);
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: "completed", accepted: true, rework: true })), false);
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: "failed", rework: true })), false);
  assert.equal(isChatWorkflowCardFoldable(makeView({ status: "cancelled", todos: 2 })), false);
});

test("折叠态 = 可折叠 且 用户未手动展开", () => {
  const accepted = makeView({ id: "accepted", status: "completed", accepted: true });
  assert.equal(isChatWorkflowCardFolded(accepted, new Set()), true);
  assert.equal(isChatWorkflowCardFolded(accepted, new Set(["accepted"])), false);
  // 展开集合只记「点开过」，不决定可折叠性：不可折叠的卡即使残留其中也不得被当成折叠态。
  const running = makeView({ id: "running", status: "running" });
  assert.equal(isChatWorkflowCardFolded(running, new Set()), false);
  assert.equal(isChatWorkflowCardFolded(running, new Set(["running"])), false);
});

test("隐藏过滤带安全阀：不可折叠的卡即使命中隐藏也重新出现，且保序", () => {
  const views = [
    makeView({ id: "accepted", status: "completed", accepted: true }),
    makeView({ id: "running", status: "running" }),
    makeView({ id: "todos", status: "completed", accepted: true, todos: 1 }),
    makeView({ id: "rework", status: "failed", rework: true }),
    makeView({ id: "fresh", status: "cancelled" }),
  ];
  assert.deepEqual(
    visibleChatWorkflowCards(views, new Set(["accepted", "running", "todos", "rework"])).map(view => view.task.id),
    ["running", "todos", "rework", "fresh"],
  );
  assert.deepEqual(
    visibleChatWorkflowCards(views, new Set()).map(view => view.task.id),
    ["accepted", "running", "todos", "rework", "fresh"],
  );
});

test("口径漂移守卫：活跃态白名单每个成员都不可折叠", () => {
  const folded = CHAT_WORKFLOW_ACTIVE_STATUS_LIST.filter(status => isChatWorkflowCardFoldable(makeView({ status, accepted: true })));
  assert.deepEqual(folded, [], "活跃态一旦被折叠，暂停 / 终止等入口就点不到了");
  assert.equal(CHAT_WORKFLOW_ACTIVE_STATUS_LIST.length, 6);
});
