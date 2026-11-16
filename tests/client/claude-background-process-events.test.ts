import test from "node:test";
import assert from "node:assert/strict";

import { applyClaudeStreamLine, createClaudeStreamProcessorState } from "../../apps/desktop/client/src/engines/claude/claudeStreamProcessor.ts";
import { AssistantLifecycleTracker } from "../../apps/desktop/client/src/engines/assistantLifecycle.ts";
import { createToolState } from "../../apps/desktop/client/src/engines/claude/claudeTools.ts";

test("Claude local_bash task_notification can bootstrap background process without falling into subagent flow", () => {
  const tool = createToolState();
  const state = createClaudeStreamProcessorState();
  const assistantLifecycle = new AssistantLifecycleTracker();
  const events: Array<{ type: string }> = [];
  const started: Array<{ taskId: string; command: string }> = [];
  const completed: Array<{ taskId: string; status: string; summary: string }> = [];

  tool.toolNameById.set("tool-bash", "Bash");
  tool.toolInputById.set("tool-bash", JSON.stringify({
    command: "python -m http.server 40421",
    run_in_background: true,
  }));

  applyClaudeStreamLine({
    line: "",
    parsed: {
      type: "system",
      subtype: "task_notification",
      task_id: "task-bg-1",
      tool_use_id: "tool-bash",
      status: "completed",
      summary: "done",
    },
    workspacePath: "Z:/code/aidt-code",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo",
    input: {
      turnId: "turn-demo" as any,
      userItemId: "item-user" as any,
      text: "",
      images: [],
      assistantItemId: "item-assistant",
      reasoningItemId: "item-reasoning",
    } as any,
    tool,
    state,
    assistantLifecycle,
    emit: (event) => events.push({ type: event.type }),
    onSessionId() {},
    onBackgroundShellTaskStarted(meta) {
      started.push({ taskId: meta.taskId, command: meta.command });
    },
    onBackgroundShellTaskCompleted(meta) {
      completed.push({ taskId: meta.taskId, status: meta.status, summary: meta.summary });
    },
  });

  assert.deepEqual(started, [{ taskId: "task-bg-1", command: "python -m http.server 40421" }]);
  assert.deepEqual(completed, [{ taskId: "task-bg-1", status: "completed", summary: "done" }]);
  assert.equal(events.some((event) => event.type.startsWith("item.subagent.")), false);
  assert.equal(tool.backgroundShellMetaByTaskId.get("task-bg-1")?.taskId, "task-bg-1");

  applyClaudeStreamLine({
    line: "",
    parsed: {
      type: "system",
      subtype: "task_started",
      task_id: "task-bg-1",
      task_type: "local_bash",
      tool_use_id: "tool-bash",
      description: "python -m http.server 40421",
    },
    workspacePath: "Z:/code/aidt-code",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo",
    input: {
      turnId: "turn-demo" as any,
      userItemId: "item-user" as any,
      text: "",
      images: [],
      assistantItemId: "item-assistant",
      reasoningItemId: "item-reasoning",
    } as any,
    tool,
    state,
    assistantLifecycle,
    emit: (event) => events.push({ type: event.type }),
    onSessionId() {},
    onBackgroundShellTaskStarted(meta) {
      started.push({ taskId: meta.taskId, command: meta.command });
    },
    onBackgroundShellTaskCompleted(meta) {
      completed.push({ taskId: meta.taskId, status: meta.status, summary: meta.summary });
    },
  });

  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(events.some((event) => event.type.startsWith("item.subagent.")), false);
});

test("Claude local_bash task without explicit run_in_background should not enter process tracking", () => {
  const tool = createToolState();
  const state = createClaudeStreamProcessorState();
  const assistantLifecycle = new AssistantLifecycleTracker();
  const started: Array<{ taskId: string; command: string }> = [];
  const completed: Array<{ taskId: string; status: string; summary: string }> = [];

  tool.toolNameById.set("tool-bash", "Bash");
  tool.toolInputById.set("tool-bash", JSON.stringify({
    command: "python -m http.server 40422",
  }));

  applyClaudeStreamLine({
    line: "",
    parsed: {
      type: "system",
      subtype: "task_started",
      task_id: "task-fg-1",
      task_type: "local_bash",
      tool_use_id: "tool-bash",
      description: "python -m http.server 40422",
    },
    workspacePath: "Z:/code/aidt-code",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo",
    input: {
      turnId: "turn-demo" as any,
      userItemId: "item-user" as any,
      text: "",
      images: [],
      assistantItemId: "item-assistant",
      reasoningItemId: "item-reasoning",
    } as any,
    tool,
    state,
    assistantLifecycle,
    emit() {},
    onSessionId() {},
    onBackgroundShellTaskStarted(meta) {
      started.push({ taskId: meta.taskId, command: meta.command });
    },
    onBackgroundShellTaskCompleted(meta) {
      completed.push({ taskId: meta.taskId, status: meta.status, summary: meta.summary });
    },
  });

  applyClaudeStreamLine({
    line: "",
    parsed: {
      type: "system",
      subtype: "task_notification",
      task_id: "task-fg-1",
      task_type: "local_bash",
      tool_use_id: "tool-bash",
      status: "completed",
      summary: "done",
    },
    workspacePath: "Z:/code/aidt-code",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo",
    input: {
      turnId: "turn-demo" as any,
      userItemId: "item-user" as any,
      text: "",
      images: [],
      assistantItemId: "item-assistant",
      reasoningItemId: "item-reasoning",
    } as any,
    tool,
    state,
    assistantLifecycle,
    emit() {},
    onSessionId() {},
    onBackgroundShellTaskStarted(meta) {
      started.push({ taskId: meta.taskId, command: meta.command });
    },
    onBackgroundShellTaskCompleted(meta) {
      completed.push({ taskId: meta.taskId, status: meta.status, summary: meta.summary });
    },
  });

  assert.deepEqual(started, []);
  assert.deepEqual(completed, []);
  assert.equal(tool.backgroundShellMetaByTaskId.has("task-fg-1"), false);
});
