import test from "node:test";
import assert from "node:assert/strict";

import { AssistantLifecycleTracker } from "../src/engines/assistantLifecycle.ts";
import { applyClaudeStreamLine, createClaudeStreamProcessorState } from "../src/engines/claude/claudeStreamProcessor.ts";
import { createToolState } from "../src/engines/claude/claudeTools.ts";
import { logger } from "../src/logger.ts";

/** 构造 Claude stream processor 测试上下文，便于断言 emit 事件。 */
function createProcessorHarness(turnId: string) {
  const emitted: any[] = [];
  const assistantLifecycle = new AssistantLifecycleTracker();
  assistantLifecycle.startTurn(turnId as any);
  const state = createClaudeStreamProcessorState();
  const tool = createToolState();
  return {
    emitted,
    state,
    base: {
      workspacePath: "Z:/code/aidt-code",
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread-demo",
      input: {
        turnId,
        assistantItemId: "assistant-turn-1",
        reasoningItemId: "reasoning-turn-1",
      } as any,
      tool,
      state,
      assistantLifecycle,
      emit: (event: any) => emitted.push(event),
      onSessionId() {},
    },
  };
}

test("Claude stream text_delta 在拿到真实 message id 前只缓冲，不生成 fallback assistant transcript", () => {
  const emitted: any[] = [];
  const assistantLifecycle = new AssistantLifecycleTracker();
  assistantLifecycle.startTurn("turn-claude-buffer-1" as any);
  const state = createClaudeStreamProcessorState();
  const tool = createToolState();
  const base = {
    workspacePath: "Z:/code/aidt-code",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo",
    input: {
      turnId: "turn-claude-buffer-1",
      assistantItemId: "assistant-turn-1",
      reasoningItemId: "reasoning-turn-1",
    } as any,
    tool,
    state,
    assistantLifecycle,
    emit: (event: any) => emitted.push(event),
    onSessionId() {},
  };

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hel" },
      },
    },
  });

  assert.equal(emitted.some((event) => String(event?.type ?? "").startsWith("item.agentMessage")), false);
  assert.equal(state.pendingAssistantText, "Hel");

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { role: "assistant", id: "msg-real-1" },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "lo" },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: { type: "message_stop" },
    },
  });

  const assistantEvents = emitted.filter((event) => String(event?.type ?? "").startsWith("item.agentMessage"));
  assert.deepEqual(
    assistantEvents.map((event) => ({
      type: event.type,
      itemId: event.payload.itemId,
      engineMessageId: event.payload.engineMessageId,
      delta: event.payload.delta ?? null,
      text: event.payload.text ?? null,
    })),
    [
      {
        type: "item.agentMessage.started",
        itemId: "assistant_msg-real-1",
        engineMessageId: "msg-real-1",
        delta: null,
        text: null,
      },
      {
        type: "item.agentMessage.delta",
        itemId: "assistant_msg-real-1",
        engineMessageId: "msg-real-1",
        delta: "Hel",
        text: null,
      },
      {
        type: "item.agentMessage.delta",
        itemId: "assistant_msg-real-1",
        engineMessageId: "msg-real-1",
        delta: "lo",
        text: null,
      },
      {
        type: "item.agentMessage.completed",
        itemId: "assistant_msg-real-1",
        engineMessageId: "msg-real-1",
        delta: null,
        text: "Hello",
      },
    ],
  );
  assert.equal(assistantLifecycle.latestText("turn-claude-buffer-1" as any), "Hello");
  assert.equal(
    assistantEvents.some((event) => String(event?.payload?.engineMessageId ?? "").includes("cycle_")),
    false,
  );
});

test("Claude subagent assistant usage 不更新主线程 tokenUsage", () => {
  const { emitted, state, base } = createProcessorHarness("turn-claude-subagent-usage");
  state.activeModelId = "claude-opus-4-7";

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "assistant",
      parent_tool_use_id: "toolu_parent_agent",
      session_id: "session-1",
      uuid: "uuid-subagent-assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        id: "msg-subagent-1",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "子任务结果" }],
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 44_678,
          cache_creation_input_tokens: 250,
          output_tokens: 1,
        },
      },
    },
  });

  assert.equal(emitted.some((event) => event.type === "tokenUsage.updated"), false);
  assert.equal(emitted.some((event) => event.type === "item.subagent.childEvent"), true);
  assert.equal(state.activeModelId, "claude-opus-4-7");
});

test("Claude 顶层 assistant usage 继续更新主线程 tokenUsage", () => {
  const { emitted, state, base } = createProcessorHarness("turn-claude-top-usage");

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "uuid-top-assistant",
      message: {
        model: "claude-opus-4-7",
        id: "msg-top-1",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "主线程回复" }],
        usage: {
          input_tokens: 6,
          cache_read_input_tokens: 35_358,
          cache_creation_input_tokens: 399_225,
          output_tokens: 8,
        },
      },
    },
  });

  const usageEvent = emitted.find((event) => event.type === "tokenUsage.updated");
  assert.ok(usageEvent);
  assert.equal(usageEvent.payload.source, "current");
  assert.deepEqual(usageEvent.payload.tokenUsage, {
    inputTokens: 6,
    cachedInputTokens: 35_358,
    cacheCreationInputTokens: 399_225,
    outputTokens: 8,
    modelContextWindow: null,
  });
  assert.equal(state.activeModelId, "claude-opus-4-7");
});

test("GLM 嵌套末条 usage 能覆盖首条零值并更新最近一次请求", () => {
  const { emitted, state, base } = createProcessorHarness("turn-glm-stream-usage");
  base.input.model = "GLM-5.3-Flash[1m]";

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          model: "GLM-5.3-Flash[1m]",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: { input_tokens: 23_668, output_tokens: 92 },
      },
    },
  });

  const usageEvents = emitted.filter((event) => event.type === "tokenUsage.updated");
  assert.equal(state.activeModelId, "GLM-5.3-Flash[1m]");
  assert.equal(usageEvents.length, 3);
  assert.equal(usageEvents[0]?.payload.usagePhase, "intermediate");
  assert.equal(usageEvents[1]?.payload.usagePhase, "final");
  assert.equal(usageEvents[2]?.payload.source, "cumulative");
  assert.equal(usageEvents[2]?.payload.cumulativeMode, "delta");
  assert.deepEqual(usageEvents[1]?.payload.tokenUsage, {
    inputTokens: 23_668,
    outputTokens: 92,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    modelContextWindow: null,
  });

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "result",
      subtype: "success",
      is_error: true,
      errors: ["GLM result error"],
      usage: { input_tokens: 23_668, output_tokens: 92 },
    },
  });
  assert.equal(emitted.filter((event) => event.type === "tokenUsage.updated").length, 3);
  assert.equal(state.errorFromEvent, "GLM result error");
});

test("GLM result usage 同步最近一次请求并按 delta 累计，重复末条不重复入账", () => {
  const { emitted, base } = createProcessorHarness("turn-glm-result-usage");
  base.input.model = "glm-5.3-flash";

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 23_668, output_tokens: 92 },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 23_668, output_tokens: 92 },
    },
  });

  const usageEvents = emitted.filter((event) => event.type === "tokenUsage.updated");
  assert.equal(usageEvents.filter((event) => event.payload.source === "current").length, 1);
  assert.equal(usageEvents.filter((event) => event.payload.source === "cumulative").length, 1);
  assert.equal(usageEvents.at(-1)?.payload.cumulativeMode, "delta");
});

test("GLM 不同 result 调用即使 token 相同也按 uuid 分别计量", () => {
  const { emitted, state, base } = createProcessorHarness("turn-glm-same-token-calls");
  base.input.model = "glm-5.3-flash";
  // 模拟已有 assistant transcript，确认 result 去重优先使用自身 uuid，而不是旧 message id。
  state.currentAssistant = {
    itemId: "assistant-existing",
    engineMessageId: "message-existing",
    text: "",
    revision: 0,
    completed: false,
  };
  const usage = { input_tokens: 100, output_tokens: 10 };

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: { type: "result", subtype: "success", is_error: false, uuid: "result-call-1", usage },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: { type: "result", subtype: "success", is_error: false, uuid: "result-call-2", usage },
  });

  const usageEvents = emitted.filter((event) => event.type === "tokenUsage.updated");
  assert.equal(usageEvents.filter((event) => event.payload.source === "current").length, 2);
  assert.equal(usageEvents.filter((event) => event.payload.source === "cumulative").length, 2);
});

test("GLM 新 provider 消息开始后不会被上一消息的 final usage 全局状态吞掉", () => {
  const { emitted, base } = createProcessorHarness("turn-glm-message-boundary");
  base.input.model = "glm-5.3-flash";
  const usage = { input_tokens: 100, output_tokens: 10 };

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: { type: "message_start", message: { id: "glm-message-1", model: "glm-5.3-flash", usage: { input_tokens: 0, output_tokens: 0 } } },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: { type: "stream_event", event: { type: "message_delta", usage } },
  });

  // 第二个 provider 消息只有首条零 usage，真实值在 result 中返回；必须重新计入本轮累计。
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: { type: "message_start", message: { id: "glm-message-2", model: "glm-5.3-flash", usage: { input_tokens: 0, output_tokens: 0 } } },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: { type: "result", subtype: "success", is_error: false, usage },
  });

  const usageEvents = emitted.filter((event) => event.type === "tokenUsage.updated");
  assert.equal(usageEvents.filter((event) => event.payload.source === "current" && event.payload.usagePhase === "final").length, 2);
  assert.equal(usageEvents.filter((event) => event.payload.source === "cumulative").length, 2);
});

test("Claude synthetic assistant 和空错误 result 不清零主线程 tokenUsage", () => {
  const { emitted, state, base } = createProcessorHarness("turn-claude-empty-error-usage");
  state.activeModelId = "claude-opus-4-7";

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "uuid-synthetic-error",
      error: "unknown",
      message: {
        model: "<synthetic>",
        id: "msg-synthetic-error",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "API Error: 上游 SSE 在 60s 内无任何输出" }],
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  });

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "session-1",
      uuid: "uuid-empty-error-result",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
      modelUsage: {
        "claude-opus-4-7": {
          contextWindow: 200_000,
        },
      },
    },
  });

  assert.equal(emitted.some((event) => event.type === "tokenUsage.updated"), false);
  assert.equal(state.activeModelId, "claude-opus-4-7");
});

test("Claude 非空错误 result 仍保留累计 tokenUsage", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-nonempty-error-usage");

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "uuid-main-model",
      message: {
        model: "claude-opus-4-7[1m]",
        id: "msg-main-model",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "主线程模型确认" }],
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          output_tokens: 1,
        },
      },
    },
  });
  emitted.length = 0;

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "session-1",
      uuid: "uuid-nonempty-error-result",
      usage: {
        input_tokens: 1_748,
        cache_read_input_tokens: 20_952_032,
        cache_creation_input_tokens: 393_102,
        output_tokens: 49_398,
      },
      modelUsage: {
        "claude-opus-4-7[1m]": {
          contextWindow: 1_000_000,
        },
      },
    },
  });

  const usageEvent = emitted.find((event) => event.type === "tokenUsage.updated");
  assert.ok(usageEvent);
  assert.equal(usageEvent.payload.source, "cumulative");
  assert.equal(usageEvent.payload.tokenUsage.inputTokens, 1_748);
  assert.equal(usageEvent.payload.tokenUsage.cachedInputTokens, 20_952_032);
  assert.equal(usageEvent.payload.tokenUsage.cacheCreationInputTokens, 393_102);
  assert.equal(usageEvent.payload.tokenUsage.outputTokens, 49_398);
  assert.equal(usageEvent.payload.tokenUsage.modelContextWindow, 1_000_000);
});

test("Claude 普通 local_bash task lifecycle 不映射为 subagent，也不进入后台进程", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-local-bash-task");
  const backgroundStarted: any[] = [];
  const backgroundCompleted: any[] = [];
  const withBackgroundCallbacks = {
    ...base,
    onBackgroundShellTaskStarted: (task: any) => backgroundStarted.push(task),
    onBackgroundShellTaskCompleted: (task: any) => backgroundCompleted.push(task),
  };

  applyClaudeStreamLine({
    ...withBackgroundCallbacks,
    line: "",
    parsed: {
      type: "assistant",
      session_id: "session-1",
      uuid: "uuid-bash-tool-use",
      message: {
        id: "msg_bash_ordinary",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_bash_1",
            name: "Bash",
            input: {
              command: "pnpm -C apps/desktop/client typecheck",
              description: "运行 vue-tsc 类型检查",
            },
          },
        ],
      },
    },
  });

  applyClaudeStreamLine({
    ...withBackgroundCallbacks,
    line: "",
    parsed: {
      type: "system",
      subtype: "task_started",
      task_id: "bc7oo1vf2",
      tool_use_id: "toolu_bash_1",
      description: "运行 vue-tsc 类型检查",
      task_type: "local_bash",
      session_id: "session-1",
      uuid: "uuid-bash-started",
    },
  });

  applyClaudeStreamLine({
    ...withBackgroundCallbacks,
    line: "",
    parsed: {
      type: "system",
      subtype: "task_notification",
      task_id: "bc7oo1vf2",
      tool_use_id: "toolu_bash_1",
      status: "completed",
      output_file: "",
      summary: "运行 vue-tsc 类型检查",
      session_id: "session-1",
      uuid: "uuid-bash-completed",
    },
  });

  applyClaudeStreamLine({
    ...withBackgroundCallbacks,
    line: "",
    parsed: {
      type: "user",
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "uuid-bash-result",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_bash_1",
            content: "typecheck ok",
            is_error: false,
          },
        ],
      },
      tool_use_result: { stdout: "typecheck ok", stderr: "", interrupted: false },
    },
  });

  assert.equal(emitted.some((event) => String(event.type).startsWith("item.subagent.")), false);
  assert.equal(emitted.some((event) => event.type === "item.tool.completed"), true);
  assert.deepEqual(backgroundStarted, []);
  assert.deepEqual(backgroundCompleted, []);
});

test("Claude 显式后台 Bash task lifecycle 进入后台进程", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-background-bash-task");
  const backgroundStarted: any[] = [];
  const backgroundCompleted: any[] = [];
  const withBackgroundCallbacks = {
    ...base,
    onBackgroundShellTaskStarted: (task: any) => backgroundStarted.push(task),
    onBackgroundShellTaskCompleted: (task: any) => backgroundCompleted.push(task),
  };

  applyClaudeStreamLine({
    ...withBackgroundCallbacks,
    line: "",
    parsed: {
      type: "assistant",
      session_id: "session-1",
      uuid: "uuid-background-bash-tool-use",
      message: {
        id: "msg_bash_background",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_bash_background",
            name: "Bash",
            input: {
              command: "pnpm dev",
              description: "启动前端开发服务",
              run_in_background: true,
            },
          },
        ],
      },
    },
  });

  applyClaudeStreamLine({
    ...withBackgroundCallbacks,
    line: "",
    parsed: {
      type: "system",
      subtype: "task_started",
      task_id: "bdevserver1",
      tool_use_id: "toolu_bash_background",
      description: "启动前端开发服务",
      task_type: "local_bash",
      session_id: "session-1",
      uuid: "uuid-background-bash-started",
    },
  });

  applyClaudeStreamLine({
    ...withBackgroundCallbacks,
    line: "",
    parsed: {
      type: "system",
      subtype: "task_notification",
      task_id: "bdevserver1",
      tool_use_id: "toolu_bash_background",
      status: "completed",
      output_file: "",
      summary: "启动前端开发服务",
      session_id: "session-1",
      uuid: "uuid-background-bash-completed",
    },
  });

  assert.equal(emitted.some((event) => String(event.type).startsWith("item.subagent.")), false);
  assert.deepEqual(
    backgroundStarted.map((task) => ({
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      description: task.description,
      command: task.command,
    })),
    [
      {
        taskId: "bdevserver1",
        toolUseId: "toolu_bash_background",
        description: "启动前端开发服务",
        command: "pnpm dev",
      },
    ],
  );
  assert.deepEqual(
    backgroundCompleted.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      summary: task.summary,
    })),
    [
      {
        taskId: "bdevserver1",
        status: "completed",
        summary: "启动前端开发服务",
      },
    ],
  );
});

test("Claude local_agent task lifecycle 继续映射为 subagent", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-local-agent-task");

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "system",
      subtype: "task_started",
      task_id: "a2153cd13b37e8c19",
      tool_use_id: "toolu_agent_1",
      description: "查找聊天队列 effort 显示位置",
      task_type: "local_agent",
      session_id: "session-1",
      uuid: "uuid-agent-started",
    },
  });

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "system",
      subtype: "task_progress",
      task_id: "a2153cd13b37e8c19",
      tool_use_id: "toolu_agent_1",
      description: "Reading thread-queue-bar.vue",
      usage: { total_tokens: 100, tool_uses: 2, duration_ms: 3000 },
      last_tool_name: "Read",
      session_id: "session-1",
      uuid: "uuid-agent-progress",
    },
  });

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "system",
      subtype: "task_notification",
      task_id: "a2153cd13b37e8c19",
      tool_use_id: "toolu_agent_1",
      status: "completed",
      output_file: "",
      summary: "查找聊天队列 effort 显示位置",
      usage: { total_tokens: 120, tool_uses: 3, duration_ms: 4000 },
      session_id: "session-1",
      uuid: "uuid-agent-completed",
    },
  });

  assert.deepEqual(
    emitted
      .filter((event) => String(event.type).startsWith("item.subagent."))
      .map((event) => event.type),
    ["item.subagent.started", "item.subagent.progress", "item.subagent.completed"],
  );
});

test("Claude thinking_tokens 不生成会话事件或 WARN，真正未知 system subtype 仍告警", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-thinking-tokens");
  const warnings: Array<{ tag: string; message: string }> = [];
  const originalWarn = logger.warn;
  logger.warn = (tag, message) => warnings.push({ tag, message });

  try {
    applyClaudeStreamLine({
      ...base,
      line: "",
      parsed: {
        type: "system",
        subtype: "thinking_tokens",
        thinking_tokens: 128,
      },
    });

    assert.deepEqual(emitted, []);
    assert.deepEqual(warnings, []);

    applyClaudeStreamLine({
      ...base,
      line: "",
      parsed: { type: "system", subtype: "background_tasks_changed" },
    });
    applyClaudeStreamLine({
      ...base,
      line: "",
      parsed: { type: "system", subtype: "task_updated", task_id: "agent-1", status: "completed" },
    });

    assert.deepEqual(emitted, []);
    assert.deepEqual(warnings, []);

    applyClaudeStreamLine({
      ...base,
      line: "",
      parsed: {
        type: "system",
        subtype: "future_unknown_subtype",
      },
    });

    assert.deepEqual(emitted, []);
    assert.deepEqual(warnings, [
      { tag: "claude", message: 'unhandled system subtype="future_unknown_subtype"' },
    ]);
  } finally {
    logger.warn = originalWarn;
  }
});

test("Claude system.local_command_output 映射为完整 assistant 消息", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-local-output");

  applyClaudeStreamLine({
    ...base,
    providerSlash: true,
    line: "",
    parsed: {
      type: "system",
      subtype: "local_command_output",
      uuid: "local-output-1",
      content: "command output",
    },
  });

  assert.deepEqual(
    emitted
      .filter((event) => String(event.type).startsWith("item.agentMessage."))
      .map((event) => ({ type: event.type, text: event.payload.delta ?? event.payload.text ?? null })),
    [
      { type: "item.agentMessage.started", text: null },
      { type: "item.agentMessage.delta", text: "command output" },
      { type: "item.agentMessage.completed", text: "command output" },
    ],
  );
});

test("Claude tagged local output 与同文 synthetic assistant 精确去重", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-local-dedupe");

  applyClaudeStreamLine({
    ...base,
    providerSlash: true,
    line: "",
    parsed: {
      type: "user",
      uuid: "local-output-user-1",
      message: {
        role: "user",
        content: "<local-command-stdout>same output</local-command-stdout>",
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    providerSlash: true,
    line: "",
    parsed: {
      type: "assistant",
      uuid: "synthetic-output-1",
      message: {
        id: "msg-synthetic-output-1",
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "same output" }],
      },
    },
  });

  assert.deepEqual(
    emitted
      .filter((event) => event.type === "item.agentMessage.completed")
      .map((event) => event.payload.text),
    ["same output"],
  );
  assert.equal(
    emitted.some((event) => event.payload?.engineMessageId === "msg-synthetic-output-1"),
    false,
  );
});

test("Claude 普通消息忽略 local command 兼容事件", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-ordinary-local-output");

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "system",
      subtype: "local_command_output",
      uuid: "ordinary-local-output",
      content: "must stay hidden",
    },
  });

  assert.deepEqual(emitted, []);
});

test("Claude local output 与异文 synthetic assistant 都保留", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-local-distinct");

  applyClaudeStreamLine({
    ...base,
    providerSlash: true,
    line: "",
    parsed: {
      type: "system",
      subtype: "local_command_output",
      uuid: "local-output-2",
      content: "local output",
    },
  });
  applyClaudeStreamLine({
    ...base,
    providerSlash: true,
    line: "",
    parsed: {
      type: "assistant",
      uuid: "synthetic-output-2",
      message: {
        id: "msg-synthetic-output-2",
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "synthetic output" }],
      },
    },
  });

  assert.deepEqual(
    emitted
      .filter((event) => event.type === "item.agentMessage.completed")
      .map((event) => event.payload.text),
    ["local output"],
  );
  assert.equal(
    emitted.some((event) => (
      event.type === "item.agentMessage.snapshot"
      && event.payload.text === "synthetic output"
    )),
    true,
  );
});

test("Claude thinking block start 会先发 reasoning.started，占位等待真实 reasoning 文本", () => {
  const emitted: any[] = [];
  const assistantLifecycle = new AssistantLifecycleTracker();
  assistantLifecycle.startTurn("turn-claude-thinking-1" as any);
  const state = createClaudeStreamProcessorState();
  const tool = createToolState();
  const base = {
    workspacePath: "Z:/code/aidt-code",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo",
    input: {
      turnId: "turn-claude-thinking-1",
      assistantItemId: "assistant-turn-1",
      reasoningItemId: "reasoning-turn-1",
    } as any,
    tool,
    state,
    assistantLifecycle,
    emit: (event: any) => emitted.push(event),
    onSessionId() {},
  };

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { role: "assistant", id: "msg-think-1" },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "先看一下上下文" },
      },
    },
  });

  assert.deepEqual(
    emitted
      .filter((event) => event.type === "item.reasoning.started" || event.type === "item.reasoning.delta")
      .map((event) => ({
        type: event.type,
        itemId: event.payload.itemId,
        delta: event.payload.delta ?? null,
      })),
    [
      {
        type: "item.reasoning.started",
        itemId: "reasoning_msg-think-1",
        delta: null,
      },
      {
        type: "item.reasoning.delta",
        itemId: "reasoning_msg-think-1",
        delta: "先看一下上下文",
      },
    ],
  );
});

test("Claude TaskCreate/TaskUpdate 工具族会归一为 todolistItems", () => {
  const { emitted, base } = createProcessorHarness("turn-claude-task-todo-1");

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_create_1", name: "TaskCreate", input: {}, caller: { type: "direct" } },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            subject: "读取上游需求与代码上下文",
            description: "读取 REQ 和评审文档",
            activeForm: "读取上下文中",
          }),
        },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_create_1", content: "Created task #1" }],
      },
      tool_use_result: { task: { id: "1", subject: "读取上游需求与代码上下文" } },
    },
  });

  assert.equal(emitted.some((event) => event.type === "item.tool.started" && event.payload.toolName === "TaskCreate"), false);
  assert.deepEqual(latestTodolistItems(emitted), [{ step: "读取上游需求与代码上下文", status: "pending" }]);

  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_update_1", name: "TaskUpdate", input: {}, caller: { type: "direct" } },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ taskId: "1", status: "in_progress" }) },
      },
    },
  });
  applyClaudeStreamLine({
    ...base,
    line: "",
    parsed: {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_update_1", content: "Updated task #1 status" }],
      },
      tool_use_result: {
        success: true,
        taskId: "1",
        updatedFields: ["status"],
        statusChange: { from: "pending", to: "in_progress" },
      },
    },
  });

  const todoEvents = emitted.filter((event) => event.type === "item.tool.completed" && event.payload.toolName === "todowrite");
  assert.equal(todoEvents.length, 2);
  assert.equal(todoEvents[0].payload.itemId, todoEvents[1].payload.itemId);
  assert.deepEqual(latestTodolistItems(emitted), [{ step: "读取上游需求与代码上下文", status: "in_progress" }]);
});

/** 读取测试事件流中最新的结构化 todolist。 */
function latestTodolistItems(events: any[]): Array<{ step: string; status: string }> | undefined {
  return events
    .filter((event) => event.type === "item.tool.completed" && event.payload.toolName === "todowrite")
    .at(-1)?.payload.todolistItems;
}
