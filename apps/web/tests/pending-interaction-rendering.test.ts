import test from "node:test";
import assert from "node:assert/strict";

import type { ConversationItem } from "@codeflowai/shared";

import { buildAssistantRenderNodes } from "../src/features/messages/assistantRenderNodes.ts";
import { prepareConversationItemsForDisplay, type DisplayConversationItem } from "../src/features/messages/prepareConversationItems.ts";
import type { ThreadConversationState } from "../src/features/chat/chatTypes.ts";
import { getConversationItemsForMessageList, getPendingInteractionItems, getPendingInteractionState, getPendingUserInputItems } from "../src/features/chat/chatTypes.ts";
import { createConversationState as createBaseConversationState } from "../../../tests/support/conversation-fixture.ts";

function createConversationState(items: ConversationItem[] = [], runningTurnId: string | null = "turn-test-1"): ThreadConversationState {
  return createBaseConversationState({ items, runningTurnId, runningTurnStartedAt: runningTurnId ? 1 : null });
}

function createToolItem(input: Partial<Extract<ConversationItem, { kind: "tool" }>> & { id: string; toolType: string }): Extract<ConversationItem, { kind: "tool" }> {
  return {
    kind: "tool",
    id: input.id as any,
    toolType: input.toolType,
    title: input.title ?? input.toolType,
    detail: input.detail ?? "",
    status: input.status ?? "completed",
    output: input.output,
    summary: input.summary,
    changes: input.changes,
    todolistItems: input.todolistItems,
    isTodolist: input.isTodolist,
  };
}

test("approvalRequest 和 userInputRequest 不再被卷进过程折叠", () => {
  const items: DisplayConversationItem[] = [
    {
      kind: "reasoning",
      id: "reasoning-1" as any,
      content: "先分析一下",
    },
    {
      kind: "tool",
      id: "tool-1" as any,
      toolType: "commandExecution",
      title: "commandExecution",
      detail: "",
      status: "completed",
    },
    {
      kind: "diff",
      id: "diff-1" as any,
      title: "Diff",
      diff: "diff --git a/a b/a",
    },
    {
      kind: "approvalRequest",
      id: "approval-1" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "approval-1",
      toolName: "exec_command",
      message: "需要执行命令",
      state: "pending",
    },
    {
      kind: "userInputRequest",
      id: "user-input-1" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "user-input-1",
      header: "需要您补充输入",
      prompt: "请先补充信息。",
      questions: [],
      state: "pending",
    },
    {
      kind: "explore",
      id: "explore-1" as any,
      status: "explored",
      entries: [{ kind: "read", label: "README.md" }],
    },
  ];

  const nodes = buildAssistantRenderNodes(items);

  assert.deepEqual(
    nodes.map((node) => (
      node.kind === "process-batch"
        ? { kind: node.kind, itemKinds: node.entries.map((entry) => entry.item.kind) }
        : { kind: node.kind, itemKind: node.item.kind }
    )),
    [
      { kind: "process-batch", itemKinds: ["reasoning", "tool"] },
      { kind: "item", itemKind: "approvalRequest" },
      { kind: "item", itemKind: "userInputRequest" },
      { kind: "item", itemKind: "explore" },
    ],
  );
});

test("pending interaction helper 只返回当前 pending 项，并按最新 pending 决定状态标签", () => {
  const items: ConversationItem[] = [
    {
      kind: "approvalRequest",
      id: "approval-accepted" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "approval-accepted",
      toolName: "exec_command",
      state: "accepted",
    },
    {
      kind: "userInputRequest",
      id: "user-input-pending" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "user-input-pending",
      header: "需要您补充输入",
      prompt: "请先补充信息。",
      questions: [],
      state: "pending",
    },
    {
      kind: "approvalRequest",
      id: "approval-pending" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "approval-pending",
      toolName: "exec_command",
      state: "pending",
    },
  ];

  const state = createConversationState(items);

  assert.deepEqual(
    getPendingInteractionItems(state).map((item) => ({ kind: item.kind, id: item.id })),
    [
      { kind: "userInputRequest", id: "user-input-pending" },
      { kind: "approvalRequest", id: "approval-pending" },
    ],
  );
  assert.equal(getPendingInteractionState(state), "approval");
  assert.deepEqual(
    getPendingUserInputItems(state).map((item) => ({ kind: item.kind, id: item.id })),
    [
      { kind: "userInputRequest", id: "user-input-pending" },
    ],
  );
});

test("没有运行中的 turn 时不展示顶部待处理区", () => {
  const items: ConversationItem[] = [
    {
      kind: "approvalRequest",
      id: "approval-pending" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "approval-pending",
      toolName: "exec_command",
      state: "pending",
    },
  ];

  const state = createConversationState(items, null);

  assert.deepEqual(getPendingInteractionItems(state), []);
  assert.equal(getPendingInteractionState(state), null);
});

test("assistant-helper 作为 pending owner 时，消息流隐藏 pending 但保留已收口历史", () => {
  const items: ConversationItem[] = [
    {
      kind: "approvalRequest",
      id: "approval-pending" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "approval-pending",
      toolName: "exec_command",
      state: "pending",
    },
    {
      kind: "approvalRequest",
      id: "approval-accepted" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "approval-accepted",
      toolName: "exec_command",
      state: "accepted",
    },
    {
      kind: "userInputRequest",
      id: "user-input-pending" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "user-input-pending",
      header: "需要您补充输入",
      prompt: "请先补充信息。",
      questions: [],
      state: "pending",
    },
    {
      kind: "userInputRequest",
      id: "user-input-submitted" as any,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-test-1" as any,
      requestId: "user-input-submitted",
      header: "需要您补充输入",
      prompt: "请先补充信息。",
      questions: [],
      state: "submitted",
      submittedAnswers: { q_0: { answers: ["已回答"] } },
    },
    {
      kind: "message",
      id: "assistant-1" as any,
      role: "assistant",
      text: "历史说明",
      format: "markdown",
    },
  ];

  const state = createConversationState(items);

  assert.deepEqual(
    getConversationItemsForMessageList(state, { pendingInteractionOwner: "assistant-helper" }).map((item) => ({
      kind: item.kind,
      id: item.id,
    })),
    [
      { kind: "approvalRequest", id: "approval-accepted" },
      { kind: "userInputRequest", id: "user-input-submitted" },
      { kind: "message", id: "assistant-1" },
    ],
  );

  assert.deepEqual(
    getConversationItemsForMessageList(state, { pendingInteractionOwner: "timeline" }).map((item) => ({
      kind: item.kind,
      id: item.id,
    })),
    [
      { kind: "approvalRequest", id: "approval-pending" },
      { kind: "approvalRequest", id: "approval-accepted" },
      { kind: "userInputRequest", id: "user-input-pending" },
      { kind: "userInputRequest", id: "user-input-submitted" },
      { kind: "message", id: "assistant-1" },
    ],
  );
});

test("Grep/Glob/Read/Bash ls 会归并为 explore，Agent 和任务工具保持独立", () => {
  const displayItems = prepareConversationItemsForDisplay([
    createToolItem({
      id: "bash-list",
      toolType: "Bash",
      detail: JSON.stringify({ command: "ls src/features" }),
    }),
    createToolItem({
      id: "grep-search",
      toolType: "Grep",
      detail: JSON.stringify({ pattern: "provide", path: "src" }),
    }),
    createToolItem({
      id: "glob-search",
      toolType: "Glob",
      detail: JSON.stringify({ pattern: "src/**/*.ts", path: "src" }),
    }),
    createToolItem({
      id: "read-file",
      toolType: "Read",
      detail: JSON.stringify({ file_path: "src/api/personal-package.ts" }),
    }),
    createToolItem({
      id: "agent-tool",
      toolType: "Agent",
      detail: JSON.stringify({ description: "Explore checkout files", subagent_type: "Explore" }),
    }),
    createToolItem({
      id: "todo-tool",
      toolType: "todowrite",
      detail: JSON.stringify({ todos: [] }),
      isTodolist: true,
    }),
  ]);

  assert.equal(displayItems.length, 3);
  assert.equal(displayItems[0]?.kind, "explore");
  assert.deepEqual(
    displayItems[0]?.kind === "explore" ? displayItems[0].entries.map((entry) => ({ kind: entry.kind, label: entry.label })) : [],
    [
      { kind: "list", label: "src/features" },
      { kind: "search", label: "provide in src" },
      { kind: "search", label: "src/**/*.ts in src" },
      { kind: "read", label: "personal-package.ts" },
    ],
  );
  assert.deepEqual(
    displayItems.slice(1).map((item) => item.kind === "tool" ? item.toolType : item.kind),
    ["Agent", "todowrite"],
  );
});

test("reasoning + explore 合并进过程，Agent 与子任务同样并入过程，任务工具保持独立", () => {
  const items: DisplayConversationItem[] = [
    {
      kind: "reasoning",
      id: "reasoning-1" as any,
      content: "先梳理一下结构",
    },
    {
      kind: "explore",
      id: "explore-1" as any,
      status: "explored",
      entries: [{ kind: "read", label: "billing.ts" }],
    },
    createToolItem({
      id: "agent-tool",
      toolType: "Agent",
      detail: JSON.stringify({ description: "Explore checkout files", subagent_type: "Explore" }),
    }),
    {
      kind: "subagent",
      id: "subagent-1" as any,
      taskId: "task-1",
      description: "读取 apps/server/src/index.ts",
      taskType: "local_agent",
      status: "completed",
      usage: { totalTokens: 128, toolUses: 4, durationMs: 1500 },
      children: [],
    },
    createToolItem({
      id: "todo-tool",
      toolType: "todowrite",
      detail: JSON.stringify({ todos: [] }),
      isTodolist: true,
    }),
  ];

  const nodes = buildAssistantRenderNodes(items);

  assert.deepEqual(
    nodes.map((node) => (
      node.kind === "process-batch"
        ? { kind: node.kind, itemKinds: node.entries.map((entry) => entry.item.kind) }
        : { kind: node.kind, itemKind: node.item.kind }
    )),
    [
      { kind: "process-batch", itemKinds: ["reasoning", "explore", "tool", "subagent"] },
      { kind: "item", itemKind: "tool" },
    ],
  );
});

test("连续 Agent 工具与子任务并入过程组，状态计数与预览覆盖子任务", () => {
  const nodes = buildAssistantRenderNodes([
    createToolItem({
      id: "agent-tool-1",
      toolType: "Agent",
      summary: "[Explore] 检查结账流程",
    }),
    createToolItem({
      id: "agent-tool-2",
      toolType: "Agent",
      summary: "[Explore] 检查定价流程",
    }),
    {
      kind: "subagent",
      id: "subagent-running" as any,
      taskId: "task-running",
      description: "读取 apps/server/src/index.ts",
      taskType: "local_agent",
      status: "running",
      children: [],
    },
  ]);

  assert.deepEqual(
    nodes.map((node) => (
      node.kind === "process-batch"
        ? {
          kind: node.kind,
          itemKinds: node.entries.map((entry) => entry.item.kind),
          statusCounts: node.statusCounts,
          preview: node.preview,
        }
        : { kind: node.kind, itemKind: node.item.kind }
    )),
    [
      {
        kind: "process-batch",
        itemKinds: ["tool", "tool", "subagent"],
        statusCounts: { done: 2, running: 1, warning: 0, failed: 0 },
        preview: "[Explore] 检查结账流程",
      },
    ],
  );

  const subagentOnly = buildAssistantRenderNodes([
    {
      kind: "subagent",
      id: "subagent-done" as any,
      taskId: "task-done",
      description: "统计用例数量",
      taskType: "local_agent",
      status: "completed",
      children: [],
    },
    {
      kind: "subagent",
      id: "subagent-failed" as any,
      taskId: "task-failed",
      description: "跑冒烟用例",
      taskType: "local_agent",
      status: "failed",
      children: [],
    },
  ]);

  assert.deepEqual(
    subagentOnly.map((node) => (
      node.kind === "process-batch"
        ? { kind: node.kind, statusCounts: node.statusCounts, preview: node.preview }
        : { kind: node.kind }
    )),
    [{ kind: "process-batch", statusCounts: { done: 1, running: 0, warning: 0, failed: 1 }, preview: "统计用例数量" }],
  );
});

test("过程分别统计成功和失败，混合结果不受条目顺序影响", () => {
  const items = Array.from({ length: 20 }, (_, index) => createToolItem({
    id: `tool-${index}`,
    toolType: "commandExecution",
    status: index === 19 ? "failed" : "completed",
  }));

  for (const orderedItems of [items, [...items].reverse()]) {
    const [node] = buildAssistantRenderNodes(orderedItems);
    assert.equal(node?.kind, "process-batch");
    if (node?.kind !== "process-batch") assert.fail("应生成过程分组");
    assert.equal(node.entries.length, 20);
    assert.deepEqual(node.statusCounts, { done: 19, running: 0, warning: 0, failed: 1 });
  }
});

test("过程区分全部成功、全部失败、进行中、未知和收尾缺失", () => {
  const cases = [
    { status: "completed", counts: { done: 2, running: 0, warning: 0, failed: 0 } },
    { status: "failed", counts: { done: 0, running: 0, warning: 0, failed: 2 } },
    { status: "started", counts: { done: 0, running: 2, warning: 0, failed: 0 } },
    { status: "unknown", counts: { done: 0, running: 2, warning: 0, failed: 0 } },
    { status: "incomplete", counts: { done: 0, running: 0, warning: 2, failed: 0 } },
  ] as const;
  for (const { status, counts } of cases) {
    const [node] = buildAssistantRenderNodes([0, 1].map((index) => createToolItem({
      id: `${status}-${index}`,
      toolType: "commandExecution",
      status,
    })));
    assert.equal(node?.kind, "process-batch");
    if (node?.kind !== "process-batch") assert.fail("应生成过程分组");
    assert.deepEqual(node.statusCounts, counts, status);
  }
});

test("失败与进行中同时计数，差异和推理不冒充成功，子任务停止与明细失败图标一致", () => {
  const [node] = buildAssistantRenderNodes([
    createToolItem({ id: "tool-failed", toolType: "Edit", status: "failed" }),
    { kind: "diff", id: "merged-diff" as any, title: "修改", diff: "" },
    createToolItem({ id: "tool-running", toolType: "commandExecution", status: "started" }),
    { kind: "reasoning", id: "reasoning" as any, content: "分析" },
    { kind: "diff", id: "diff" as any, title: "差异", diff: "" },
    { kind: "explore", id: "exploring" as any, status: "exploring", entries: [] },
    { kind: "explore", id: "explored" as any, status: "explored", entries: [] },
    { kind: "review", id: "review-started" as any, state: "started", text: "审查中" },
    { kind: "review", id: "review-completed" as any, state: "completed", text: "审查完成" },
    { kind: "subagent", id: "subagent-stopped" as any, taskId: "stopped", description: "已停止", status: "stopped" },
  ]);
  assert.equal(node?.kind, "process-batch");
  if (node?.kind !== "process-batch") assert.fail("应生成过程分组");
  assert.equal(node.entries.length, 9);
  assert.equal(node.entries[0]?.diff?.id, "merged-diff");
  assert.deepEqual(node.statusCounts, { done: 2, running: 3, warning: 0, failed: 2 });

  const [plainNode] = buildAssistantRenderNodes([
    { kind: "reasoning", id: "plain-reasoning" as any, content: "分析" },
    { kind: "diff", id: "plain-diff" as any, title: "差异", diff: "" },
  ]);
  assert.equal(plainNode?.kind, "process-batch");
  if (plainNode?.kind !== "process-batch") assert.fail("应生成过程分组");
  assert.deepEqual(plainNode.statusCounts, { done: 0, running: 0, warning: 0, failed: 0 });
});

test("单个 Agent 工具仍独立显示，todolist 工具始终不进过程组", () => {
  const nodes = buildAssistantRenderNodes([
    createToolItem({
      id: "agent-tool-single",
      toolType: "Agent",
      summary: "[Explore] 检查结账流程",
    }),
    createToolItem({
      id: "todo-tool-1",
      toolType: "todowrite",
      detail: JSON.stringify({ todos: [] }),
      isTodolist: true,
    }),
    createToolItem({
      id: "todo-tool-2",
      toolType: "update_plan",
      detail: JSON.stringify({ plan: [] }),
      isTodolist: true,
    }),
  ]);

  assert.deepEqual(
    nodes.map((node) => (
      node.kind === "process-batch"
        ? { kind: node.kind }
        : { kind: node.kind, itemKind: node.item.kind, id: node.item.id }
    )),
    [
      { kind: "item", itemKind: "tool", id: "agent-tool-single" },
      { kind: "item", itemKind: "tool", id: "todo-tool-1" },
      { kind: "item", itemKind: "tool", id: "todo-tool-2" },
    ],
  );
});

test("普通工具 + explore 组合仍进过程，单个 explore 独立显示", () => {
  const batched = buildAssistantRenderNodes([
    createToolItem({
      id: "edit-tool",
      toolType: "Edit",
      detail: JSON.stringify({ file_path: "src/a.ts" }),
      summary: "a.ts",
    }),
    {
      kind: "explore",
      id: "explore-1" as any,
      status: "explored",
      entries: [{ kind: "search", label: "provide in src" }],
    },
  ]);

  assert.deepEqual(
    batched.map((node) => (
      node.kind === "process-batch"
        ? { kind: node.kind, itemKinds: node.entries.map((entry) => entry.item.kind) }
        : { kind: node.kind, itemKind: node.item.kind }
    )),
    [
      { kind: "process-batch", itemKinds: ["tool", "explore"] },
    ],
  );

  const singleExplore = buildAssistantRenderNodes([
    {
      kind: "explore",
      id: "explore-single" as any,
      status: "explored",
      entries: [{ kind: "read", label: "README.md" }],
    },
  ]);

  assert.deepEqual(
    singleExplore.map((node) => node.kind === "item" ? { kind: node.kind, itemKind: node.item.kind } : { kind: node.kind }),
    [
      { kind: "item", itemKind: "explore" },
    ],
  );
});

test("空 assistant message 不再打断连续 explore 的过程合并", () => {
  const nodes = buildAssistantRenderNodes([
    {
      kind: "message",
      id: "assistant-empty-1" as any,
      role: "assistant",
      text: "",
      format: "plain",
    },
    {
      kind: "explore",
      id: "explore-1" as any,
      status: "explored",
      entries: [{ kind: "read", label: "billing.ts" }],
    },
    {
      kind: "message",
      id: "assistant-empty-2" as any,
      role: "assistant",
      text: "",
      format: "plain",
    },
    {
      kind: "explore",
      id: "explore-2" as any,
      status: "explored",
      entries: [{ kind: "read", label: "pricing-page.vue" }],
    },
  ]);

  assert.deepEqual(
    nodes.map((node) => (
      node.kind === "process-batch"
        ? { kind: node.kind, itemKinds: node.entries.map((entry) => entry.item.kind) }
        : { kind: node.kind, itemKind: node.item.kind }
    )),
    [
      { kind: "process-batch", itemKinds: ["explore", "explore"] },
    ],
  );
});
