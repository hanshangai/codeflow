import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadWorkflowState } from "@codeflowai/shared";
import { resolveThreadRowStatusBadge } from "../src/features/threads/threadStatusBadge.ts";

const NO_SIGNAL = {
  reminder: null,
  pendingInteraction: null,
  conversationProcessing: false,
  hasRunningTurn: false,
  workflow: null,
} as const;

const ACTIVE_WORKFLOW: ThreadWorkflowState = { status: "running", instanceId: "instance-1", taskId: "task-1" };

test("无任何来源时不显示标签", () => {
  assert.equal(resolveThreadRowStatusBadge(NO_SIGNAL), null);
});

test("提醒覆盖其他一切来源", () => {
  assert.deepEqual(
    resolveThreadRowStatusBadge({
      ...NO_SIGNAL,
      reminder: { label: "待确认", tone: "info" },
      pendingInteraction: "userInput",
      hasRunningTurn: true,
      workflow: ACTIVE_WORKFLOW,
    }),
    { label: "待确认", tone: "info" },
  );
});

test("会话内 turn 待办优先于活跃工作流标签", () => {
  assert.deepEqual(
    resolveThreadRowStatusBadge({ ...NO_SIGNAL, pendingInteraction: "approval", workflow: ACTIVE_WORKFLOW }),
    { label: "待确认", tone: "info" },
  );
  assert.deepEqual(
    resolveThreadRowStatusBadge({ ...NO_SIGNAL, pendingInteraction: "userInput", workflow: ACTIVE_WORKFLOW }),
    { label: "待补充", tone: "warning" },
  );
});

test("运行中的会话有待补充输入时，列表优先提示待办", () => {
  assert.deepEqual(
    resolveThreadRowStatusBadge({ ...NO_SIGNAL, pendingInteraction: "userInput", hasRunningTurn: true, workflow: ACTIVE_WORKFLOW }),
    { label: "待补充", tone: "warning" },
  );
});

test("活跃工作流标签优先于 turn 运行中，与删除门禁口径同源", () => {
  assert.deepEqual(
    resolveThreadRowStatusBadge({ ...NO_SIGNAL, workflow: ACTIVE_WORKFLOW, conversationProcessing: true, hasRunningTurn: true }),
    { label: "运行中", tone: "running" },
  );
  assert.deepEqual(
    resolveThreadRowStatusBadge({ ...NO_SIGNAL, workflow: { ...ACTIVE_WORKFLOW, status: "waiting-approval" }, hasRunningTurn: true }),
    { label: "待确认", tone: "info" },
  );
});

test("turn 运行中在没有工作流时仍显示运行中", () => {
  assert.deepEqual(
    resolveThreadRowStatusBadge({ ...NO_SIGNAL, conversationProcessing: true }),
    { label: "运行中", tone: "running" },
  );
  assert.deepEqual(
    resolveThreadRowStatusBadge({ ...NO_SIGNAL, hasRunningTurn: true }),
    { label: "运行中", tone: "running" },
  );
});
