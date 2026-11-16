import test from "node:test";
import assert from "node:assert/strict";

import type { EngineEventEnvelope } from "@codeflowai/shared";

import type { ThreadConversationState } from "../src/features/chat/chatTypes.ts";
import { createConversationState as createBaseConversationState } from "../../../tests/support/conversation-fixture.ts";
import { applyEngineEventToConversation } from "../src/features/chat/engineEventReducer.ts";

function createConversationState(): ThreadConversationState {
  return createBaseConversationState({ threadId: "thread-test-1" });
}

function buildEvent(type: EngineEventEnvelope["type"], seq: number, payload: Record<string, unknown>): EngineEventEnvelope {
  return {
    schema: 1,
    seq,
    ts: seq,
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-test-1" as any,
    engine: "codex",
    type,
    payload,
  } as EngineEventEnvelope;
}

test("历史 Codex session.invalidated 提示不会把可恢复会话锁成只读", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("system.notice", 1, {
    level: "error",
    text: "历史会话失效提示",
    action: "session.invalidated",
  }));

  assert.equal(state.invalidated, false);
});

test("非 Codex session.invalidated 仍保持永久失效语义", () => {
  const state = createConversationState();
  const event = {
    ...buildEvent("system.notice", 1, {
      level: "error",
      text: "Claude 会话文件已失效",
      action: "session.invalidated",
    }),
    engine: "claude",
  } as EngineEventEnvelope;

  applyEngineEventToConversation(state, event);

  assert.equal(state.invalidated, true);
});

test("turn.engineBound 会投影非空 engineSessionId 且不会被空值覆盖", () => {
  const state = createConversationState();
  state.engineSessionId = "engine-session-old";

  applyEngineEventToConversation(state, buildEvent("turn.engineBound", 1, {
    turnId: "turn-bound",
    engineTurnId: "engine-turn-bound",
    engineSessionId: "  engine-session-new  ",
  }));
  assert.equal(state.engineSessionId, "engine-session-new");

  applyEngineEventToConversation(state, buildEvent("turn.engineBound", 2, {
    turnId: "turn-bound",
    engineTurnId: "engine-turn-bound-2",
    engineSessionId: "   ",
  }));
  assert.equal(state.engineSessionId, "engine-session-new");
});

test("startup/interruption transient warnings are cleared after a later successful turn", () => {
  const state = createConversationState();
  const events: EngineEventEnvelope[] = [
    buildEvent("turn.error", 1, {
      turnId: "turn-old-1",
      code: "client_restarted",
      error: "CodeFlow 重启前的回合未完成，已按中断收尾。",
      terminationKind: "transient_cleanup",
    }),
    buildEvent("turn.started", 2, { turnId: "turn-old-2" }),
    buildEvent("item.userMessage.created", 3, { itemId: "user-old-2", turnId: "turn-old-2", text: "不用回我任何消息" }),
    buildEvent("turn.error", 4, {
      turnId: "turn-old-2",
      error: "turn interrupted",
      code: "turn_interrupted",
      terminationKind: "manual_interrupt",
    }),
    buildEvent("turn.started", 5, { turnId: "turn-new-1" }),
    buildEvent("item.userMessage.created", 6, { itemId: "user-new-1", turnId: "turn-new-1", text: "hi" }),
    buildEvent("item.agentMessage.completed", 7, { itemId: "assistant-new-1", text: "hi", revision: 0 }),
    buildEvent("turn.completed", 8, { turnId: "turn-new-1", result: { responseText: "hi" } }),
  ];

  for (const event of events) {
    applyEngineEventToConversation(state, event);
  }

  assert.equal(state.invalidated, false);
  assert.deepEqual(
    state.items
      .filter((item) => item.kind === "systemMessage")
      .map((item) => item.text),
    [],
  );
  assert.deepEqual(
    state.items
      .filter((item) => item.kind === "message")
      .map((item) => ({ role: item.role, text: item.text })),
    [
      { role: "user", text: "不用回我任何消息" },
      { role: "user", text: "hi" },
      { role: "assistant", text: "hi" },
    ],
  );
});

test("restart reconcile pending notice keeps the turn running without claiming completion", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-old-1",
  }));
  applyEngineEventToConversation(state, buildEvent("system.notice", 2, {
    level: "warning",
    text: "Codex 上一条请求的终态仍未确认；本地回合保持待处理。",
  }));

  assert.equal(state.invalidated, false);
  assert.equal(state.runningTurnId, "turn-old-1");
  assert.equal(state.completedTurnIds["turn-old-1"], undefined);
  assert.equal(state.items.length, 1);
  assert.deepEqual(state.items[0], {
    kind: "systemMessage",
    id: "sys_2",
    type: "warning",
    text: "Codex 上一条请求的终态仍未确认；本地回合保持待处理。",
  });
});

test("terminationKind manual_interrupt overrides mismatched code and message", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.error", 1, {
    turnId: "turn-manual-1",
    code: "codex_cancelled",
    error: "request cancelled by user",
    terminationKind: "manual_interrupt",
  }));

  assert.equal(state.items.length, 1);
  assert.deepEqual(state.items[0], {
    kind: "systemMessage",
    id: "sys_1",
    type: "warning",
    turnId: "turn-manual-1",
    code: "codex_cancelled",
    transient: true,
    text: "刚才那次请求已中止，可继续发送消息。",
  });
});

test("terminationKind error is not overridden by legacy interrupt text", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.error", 1, {
    turnId: "turn-error-1",
    error: "turn interrupted",
    terminationKind: "error",
  }));

  assert.deepEqual(state.items[0], {
    kind: "systemMessage",
    id: "sys_1",
    type: "error",
    turnId: "turn-error-1",
    code: undefined,
    transient: undefined,
    text: "错误：turn interrupted",
  });
});

test("unstructured interrupt text does not claim that the turn stopped", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.error", 1, {
    turnId: "turn-unstructured-interrupt-1",
    error: "turn interrupted",
  }));

  assert.deepEqual(state.items[0], {
    kind: "systemMessage",
    id: "sys_1",
    type: "error",
    turnId: "turn-unstructured-interrupt-1",
    code: undefined,
    transient: undefined,
    text: "错误：turn interrupted",
  });
});

test("shared workspace duplicate manual_interrupt terminal events render one warning", () => {
  const state = createConversationState();
  const withSharedWorkspace = (event: EngineEventEnvelope): EngineEventEnvelope => ({
    ...event,
    workspaceId: "shared:sw-demo" as any,
  });

  applyEngineEventToConversation(state, withSharedWorkspace(buildEvent("turn.started", 1, {
    turnId: "turn-shared-stop-1",
  })));
  applyEngineEventToConversation(state, withSharedWorkspace(buildEvent("turn.error", 2, {
    turnId: "turn-shared-stop-1",
    error: "turn interrupted",
    code: "turn_interrupted",
    terminationKind: "manual_interrupt",
  })));
  applyEngineEventToConversation(state, withSharedWorkspace(buildEvent("turn.error", 3, {
    turnId: "turn-shared-stop-1",
    error: "turn interrupted",
    code: "turn_interrupted",
    terminationKind: "manual_interrupt",
  })));

  assert.deepEqual(
    state.items
      .filter((item) => item.kind === "systemMessage")
      .map((item) => item.text),
    ["刚才那次请求已中止，可继续发送消息。"],
  );
});

test("turn.error 在 error 为空时会展示 additionalDetails 而不是未知错误", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.error", 1, {
    turnId: "turn-empty-1",
    error: "",
    additionalDetails: "relay rejected request",
    providerErrorInfo: "other",
  }));

  assert.equal(state.items.length, 1);
  assert.deepEqual(state.items[0], {
    kind: "systemMessage",
    id: "sys_1",
    type: "error",
    turnId: "turn-empty-1",
    code: undefined,
    transient: undefined,
    text: "错误：relay rejected request",
  });
});

test("turn.error 在只有 providerErrorInfo 时会展示引擎返回的错误类别", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.error", 1, {
    turnId: "turn-empty-2",
    error: "",
    providerErrorInfo: "other",
  }));

  assert.equal(state.items.length, 1);
  assert.deepEqual(state.items[0], {
    kind: "systemMessage",
    id: "sys_1",
    type: "error",
    turnId: "turn-empty-2",
    code: undefined,
    transient: undefined,
    text: "错误：引擎返回了错误类型是其他，但未提供更多细节。",
  });
});

test("迟到的 item.agentMessage.started 不会把已完成 assistant 打回 streaming", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-live-1",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 2, {
    itemId: "assistant-live-1",
    engineMessageId: "assistant-live-1",
    text: "final answer",
    revision: 1,
    phase: "final_answer",
    completionSource: "provider",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.started", 3, {
    itemId: "assistant-live-1",
    engineMessageId: "assistant-live-1",
    phase: "commentary",
  }));

  assert.deepEqual(
    state.items.filter((item) => item.kind === "message"),
    [{
      kind: "message",
      id: "assistant-live-1",
      role: "assistant",
      createdAt: 2,
      engineMessageId: "assistant-live-1",
      text: "final answer",
      format: "markdown",
      streamState: "completed",
      revision: 1,
      phase: "final_answer",
      completionSource: "provider",
      structuredPayloadJson: null,
    }],
  );
});

test("迟到的 item.agentMessage.snapshot 不会回写已完成 assistant 的正文与 phase", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 1, {
    itemId: "assistant-live-2",
    engineMessageId: "assistant-live-2",
    text: "final answer",
    revision: 2,
    phase: "final_answer",
    completionSource: "provider",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.snapshot", 2, {
    itemId: "assistant-live-2",
    engineMessageId: "assistant-live-2",
    text: "older snapshot",
    revision: 1,
    phase: "commentary",
  }));

  assert.deepEqual(
    state.items.filter((item) => item.kind === "message"),
    [{
      kind: "message",
      id: "assistant-live-2",
      role: "assistant",
      createdAt: 1,
      engineMessageId: "assistant-live-2",
      text: "final answer",
      format: "markdown",
      streamState: "completed",
      revision: 2,
      phase: "final_answer",
      completionSource: "provider",
      structuredPayloadJson: null,
    }],
  );
});

test("迟到的低优先级 item.agentMessage.completed 不会回写已完成 assistant", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 1, {
    itemId: "assistant-live-3",
    engineMessageId: "assistant-live-3",
    text: "final structured result",
    revision: 3,
    phase: "structured_result",
    completionSource: "synthetic_structured_result",
    structuredPayloadJson: "{\"schemaVersion\":\"requirement-analysis-assistant/v1\"}",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 2, {
    itemId: "assistant-live-3",
    engineMessageId: "assistant-live-3",
    text: "older completed",
    revision: 2,
    phase: "commentary",
    completionSource: "provider",
  }));

  assert.deepEqual(
    state.items.filter((item) => item.kind === "message"),
    [{
      kind: "message",
      id: "assistant-live-3",
      role: "assistant",
      createdAt: 1,
      engineMessageId: "assistant-live-3",
      text: "final structured result",
      format: "markdown",
      streamState: "completed",
      revision: 3,
      phase: "structured_result",
      completionSource: "synthetic_structured_result",
      structuredPayloadJson: "{\"schemaVersion\":\"requirement-analysis-assistant/v1\"}",
    }],
  );
});

test("same revision same phase 的 duplicate completed 不会把已完成 assistant 回写成另一份正文", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 1, {
    itemId: "assistant-live-4",
    engineMessageId: "assistant-live-4",
    text: "authoritative text",
    revision: 2,
    phase: "final_answer",
    completionSource: "provider",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 2, {
    itemId: "assistant-live-4",
    engineMessageId: "assistant-live-4",
    text: "duplicate stale text",
    revision: 2,
    phase: "final_answer",
    completionSource: "provider",
  }));

  assert.deepEqual(
    state.items.filter((item) => item.kind === "message"),
    [{
      kind: "message",
      id: "assistant-live-4",
      role: "assistant",
      createdAt: 1,
      engineMessageId: "assistant-live-4",
      text: "authoritative text",
      format: "markdown",
      streamState: "completed",
      revision: 2,
      phase: "final_answer",
      completionSource: "provider",
      structuredPayloadJson: null,
    }],
  );
});

test("same revision same phase 的 duplicate completed 不会静默回写 structuredPayloadJson", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 1, {
    itemId: "assistant-live-5",
    engineMessageId: "assistant-live-5",
    text: "same text",
    revision: 2,
    phase: "structured_result",
    completionSource: "synthetic_structured_result",
    structuredPayloadJson: "{\"schemaVersion\":\"requirement-analysis-assistant/v1\",\"version\":1}",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 2, {
    itemId: "assistant-live-5",
    engineMessageId: "assistant-live-5",
    text: "same text",
    revision: 2,
    phase: "structured_result",
    completionSource: "synthetic_structured_result",
    structuredPayloadJson: "{\"schemaVersion\":\"requirement-analysis-assistant/v1\",\"version\":0}",
  }));

  assert.deepEqual(
    state.items.filter((item) => item.kind === "message"),
    [{
      kind: "message",
      id: "assistant-live-5",
      role: "assistant",
      createdAt: 1,
      engineMessageId: "assistant-live-5",
      text: "same text",
      format: "markdown",
      streamState: "completed",
      revision: 2,
      phase: "structured_result",
      completionSource: "synthetic_structured_result",
      structuredPayloadJson: "{\"schemaVersion\":\"requirement-analysis-assistant/v1\",\"version\":1}",
    }],
  );
});

test("Codex 同一 turn 下多个 raw assistant item 保持独立可见 transcript 消息", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-codex-collapse-1",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.started", 2, {
    itemId: "codex-commentary-1",
    engineMessageId: "codex-commentary-1",
    turnId: "turn-codex-collapse-1",
    phase: "commentary",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.delta", 3, {
    itemId: "codex-commentary-1",
    engineMessageId: "codex-commentary-1",
    turnId: "turn-codex-collapse-1",
    delta: "第一段说明",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 4, {
    itemId: "codex-commentary-1",
    engineMessageId: "codex-commentary-1",
    turnId: "turn-codex-collapse-1",
    text: "第一段说明",
    revision: 0,
    phase: "commentary",
    completionSource: "provider",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.started", 5, {
    itemId: "codex-commentary-2",
    engineMessageId: "codex-commentary-2",
    turnId: "turn-codex-collapse-1",
    phase: "commentary",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.delta", 6, {
    itemId: "codex-commentary-2",
    engineMessageId: "codex-commentary-2",
    turnId: "turn-codex-collapse-1",
    delta: "第二段说明",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 7, {
    itemId: "codex-commentary-2",
    engineMessageId: "codex-commentary-2",
    turnId: "turn-codex-collapse-1",
    text: "第二段说明",
    revision: 0,
    phase: "commentary",
    completionSource: "provider",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.started", 8, {
    itemId: "codex-final-1",
    engineMessageId: "codex-final-1",
    turnId: "turn-codex-collapse-1",
    phase: "final_answer",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.delta", 9, {
    itemId: "codex-final-1",
    engineMessageId: "codex-final-1",
    turnId: "turn-codex-collapse-1",
    delta: "最终答案",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 10, {
    itemId: "codex-final-1",
    engineMessageId: "codex-final-1",
    turnId: "turn-codex-collapse-1",
    text: "最终答案",
    revision: 0,
    phase: "final_answer",
    completionSource: "provider",
  }));

  assert.deepEqual(
    state.items.filter((item) => item.kind === "message"),
    [
      {
        kind: "message",
        id: "codex-commentary-1",
        role: "assistant",
        createdAt: 2,
        engineMessageId: "codex-commentary-1",
        turnId: "turn-codex-collapse-1",
        text: "第一段说明",
        format: "markdown",
        revision: 0,
        streamState: "completed",
        phase: "commentary",
        completionSource: "provider",
        structuredPayloadJson: null,
      },
      {
        kind: "message",
        id: "codex-commentary-2",
        role: "assistant",
        createdAt: 5,
        engineMessageId: "codex-commentary-2",
        turnId: "turn-codex-collapse-1",
        text: "第二段说明",
        format: "markdown",
        revision: 0,
        streamState: "completed",
        phase: "commentary",
        completionSource: "provider",
        structuredPayloadJson: null,
      },
      {
        kind: "message",
        id: "codex-final-1",
        role: "assistant",
        createdAt: 8,
        engineMessageId: "codex-final-1",
        turnId: "turn-codex-collapse-1",
        text: "最终答案",
        format: "markdown",
        revision: 0,
        streamState: "completed",
        phase: "final_answer",
        completionSource: "provider",
        structuredPayloadJson: null,
      },
    ],
  );
});

test("Codex completed-only 恢复事件会按 raw itemId 生成多条 assistant", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 1, {
    itemId: "codex-recover-commentary",
    engineMessageId: "codex-recover-commentary",
    turnId: "turn-codex-recover-1",
    text: "恢复出的说明",
    revision: 1,
    phase: "commentary",
    completionSource: "snapshot_reconcile",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 2, {
    itemId: "codex-recover-final",
    engineMessageId: "codex-recover-final",
    turnId: "turn-codex-recover-1",
    text: "恢复出的最终答案",
    revision: 2,
    phase: "final_answer",
    completionSource: "snapshot_reconcile",
  }));

  assert.deepEqual(
    state.items.filter((item) => item.kind === "message"),
    [
      {
        kind: "message",
        id: "codex-recover-commentary",
        role: "assistant",
        createdAt: 1,
        engineMessageId: "codex-recover-commentary",
        turnId: "turn-codex-recover-1",
        text: "恢复出的说明",
        format: "markdown",
        revision: 1,
        streamState: "completed",
        phase: "commentary",
        completionSource: "snapshot_reconcile",
        structuredPayloadJson: null,
      },
      {
        kind: "message",
        id: "codex-recover-final",
        role: "assistant",
        createdAt: 2,
        engineMessageId: "codex-recover-final",
        turnId: "turn-codex-recover-1",
        text: "恢复出的最终答案",
        format: "markdown",
        revision: 2,
        streamState: "completed",
        phase: "final_answer",
        completionSource: "snapshot_reconcile",
        structuredPayloadJson: null,
      },
    ],
  );
});

test("Codex 低优先级的迟到 raw item 不会覆盖另一条已完成 final_answer", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 1, {
    itemId: "codex-final-authoritative",
    engineMessageId: "codex-final-authoritative",
    turnId: "turn-codex-late-1",
    text: "权威最终答案",
    revision: 1,
    phase: "final_answer",
    completionSource: "provider",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.started", 2, {
    itemId: "codex-commentary-late",
    engineMessageId: "codex-commentary-late",
    turnId: "turn-codex-late-1",
    phase: "commentary",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.delta", 3, {
    itemId: "codex-commentary-late",
    engineMessageId: "codex-commentary-late",
    turnId: "turn-codex-late-1",
    delta: "迟到说明",
  }));

  assert.deepEqual(
    state.items.filter((item) => item.kind === "message"),
    [
      {
        kind: "message",
        id: "codex-final-authoritative",
        role: "assistant",
        createdAt: 1,
        engineMessageId: "codex-final-authoritative",
        turnId: "turn-codex-late-1",
        text: "权威最终答案",
        format: "markdown",
        revision: 1,
        streamState: "completed",
        phase: "final_answer",
        completionSource: "provider",
        structuredPayloadJson: null,
      },
      {
        kind: "message",
        id: "codex-commentary-late",
        role: "assistant",
        createdAt: 2,
        engineMessageId: "codex-commentary-late",
        turnId: "turn-codex-late-1",
        text: "迟到说明",
        format: "plain",
        revision: 0,
        streamState: "streaming",
        phase: "commentary",
      },
    ],
  );
});

test("真实时间线下，运行中遇到新的 tool/diff/interaction 卡片时不会被重排到 assistantText 前面", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-codex-live-order-1",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 2, {
    itemId: "codex-commentary-live-1",
    engineMessageId: "codex-commentary-live-1",
    turnId: "turn-codex-live-order-1",
    text: "当前真实验证拿到了更扎实的阻断证据。",
    revision: 1,
    phase: "commentary",
    completionSource: "provider",
  }));
  applyEngineEventToConversation(state, buildEvent("item.tool.started", 3, {
    itemId: "tool-late-1",
    toolName: "chrome-devtools",
    input: { action: "take_screenshot" },
  }));
  applyEngineEventToConversation(state, buildEvent("item.diff.created", 4, {
    itemId: "diff-late-1",
    title: "Diff",
    diff: "diff --git a/a b/a",
  }));
  applyEngineEventToConversation(state, buildEvent("approval.request", 5, {
    requestId: "approval-late-1",
    toolName: "exec_command",
    message: "需要执行命令",
    input: { cmd: "git status" },
    approvalKind: "exec",
    options: [],
  }));
  applyEngineEventToConversation(state, buildEvent("userInput.requested", 6, {
    request: {
      requestId: "user-input-late-1",
      params: {
        itemId: "user-input-item-late-1",
        workspaceId: "client-a:ws-demo",
        threadId: "thread-test-1",
        questions: [],
      },
    },
  }));

  assert.deepEqual(
    state.items.map((item) => ({ kind: item.kind, id: item.id })),
    [
      { kind: "message", id: "codex-commentary-live-1" },
      { kind: "tool", id: "tool-late-1" },
      { kind: "diff", id: "diff-late-1" },
      { kind: "approvalRequest", id: "approval_approval-late-1" },
      { kind: "userInputRequest", id: "user-input-item-late-1" },
    ],
  );
});

test("真实时间线下，tool.outputDelta 先于 tool.started 到达时不会把 assistantText 压到后面", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-codex-live-order-2",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 2, {
    itemId: "codex-commentary-live-2",
    engineMessageId: "codex-commentary-live-2",
    turnId: "turn-codex-live-order-2",
    text: "第一段说明",
    revision: 1,
    phase: "commentary",
    completionSource: "provider",
  }));
  applyEngineEventToConversation(state, buildEvent("item.tool.outputDelta", 3, {
    itemId: "tool-output-first-1",
    toolName: "commandExecution",
    delta: "stdout",
  }));

  assert.deepEqual(
    state.items.map((item) => ({ kind: item.kind, id: item.id })),
    [
      { kind: "message", id: "codex-commentary-live-2" },
      { kind: "tool", id: "tool-output-first-1" },
    ],
  );
});

test("真实时间线会保留 reasoning / tool / reasoning / assistant 的交错顺序", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-real-timeline-1",
  }));
  applyEngineEventToConversation(state, buildEvent("item.reasoning.summaryDelta", 2, {
    itemId: "reasoning-1",
    delta: "先想第一段",
  }));
  applyEngineEventToConversation(state, buildEvent("item.tool.started", 3, {
    itemId: "tool-1",
    toolName: "commandExecution",
    input: { cmd: "rg foo" },
  }));
  applyEngineEventToConversation(state, buildEvent("item.reasoning.summaryDelta", 4, {
    itemId: "reasoning-2",
    delta: "再想第二段",
  }));
  applyEngineEventToConversation(state, buildEvent("item.agentMessage.completed", 5, {
    itemId: "assistant-1",
    engineMessageId: "assistant-1",
    turnId: "turn-real-timeline-1",
    text: "最后给一句说明",
    revision: 1,
    phase: "commentary",
    completionSource: "provider",
  }));

  assert.deepEqual(
    state.items.map((item) => ({ kind: item.kind, id: item.id })),
    [
      { kind: "reasoning", id: "reasoning-1" },
      { kind: "tool", id: "tool-1" },
      { kind: "reasoning", id: "reasoning-2" },
      { kind: "message", id: "assistant-1" },
    ],
  );
});

test("Claude thinking start 会先创建 reasoning placeholder，并在 tool 到来前填补空白", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-thinking-placeholder-1",
  }));
  applyEngineEventToConversation(state, buildEvent("item.reasoning.started", 2, {
    itemId: "reasoning-thinking-1",
  }));

  assert.deepEqual(
    state.items,
    [{
      kind: "reasoning",
      id: "reasoning-thinking-1",
      summary: undefined,
      content: "",
      placeholder: true,
    }],
  );
});

test("空 reasoning placeholder 会在首个其他可见节点到来时清掉，不进入最终历史", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-thinking-placeholder-2",
  }));
  applyEngineEventToConversation(state, buildEvent("item.reasoning.started", 2, {
    itemId: "reasoning-thinking-2",
  }));
  applyEngineEventToConversation(state, buildEvent("item.tool.started", 3, {
    itemId: "tool-thinking-2",
    toolName: "Read",
    input: { filePath: "README.md" },
  }));
  applyEngineEventToConversation(state, buildEvent("turn.completed", 4, {
    turnId: "turn-thinking-placeholder-2",
    result: { responseText: "" },
  }));

  assert.deepEqual(
    state.items.map((item) => ({ kind: item.kind, id: item.id })),
    [
      { kind: "tool", id: "tool-thinking-2" },
    ],
  );
});

test("reasoning placeholder 收到真实文本后会转成正常 reasoning 卡片", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildEvent("turn.started", 1, {
    turnId: "turn-thinking-placeholder-3",
  }));
  applyEngineEventToConversation(state, buildEvent("item.reasoning.started", 2, {
    itemId: "reasoning-thinking-3",
  }));
  applyEngineEventToConversation(state, buildEvent("item.reasoning.delta", 3, {
    itemId: "reasoning-thinking-3",
    delta: "先分析一下上下文",
  }));
  applyEngineEventToConversation(state, buildEvent("item.tool.started", 4, {
    itemId: "tool-thinking-3",
    toolName: "Read",
    input: { filePath: "README.md" },
  }));

  assert.deepEqual(
    state.items.map((item) => (
      item.kind === "reasoning"
        ? {
          kind: item.kind,
          id: item.id,
          content: item.content,
          placeholder: item.placeholder ?? false,
        }
        : {
          kind: item.kind,
          id: item.id,
          toolType: item.kind === "tool" ? item.toolType : undefined,
          title: item.kind === "tool" ? item.title : undefined,
          detail: item.kind === "tool" ? item.detail : undefined,
          status: item.kind === "tool" ? item.status : undefined,
          isTodolist: item.kind === "tool" ? item.isTodolist : undefined,
        }
    )),
    [
      {
        kind: "reasoning",
        id: "reasoning-thinking-3",
        content: "先分析一下上下文",
        placeholder: false,
      },
      {
        kind: "tool",
        id: "tool-thinking-3",
        toolType: "Read",
        title: "Read",
        detail: "{\n  \"filePath\": \"README.md\"\n}",
        status: "started",
        isTodolist: false,
      },
    ],
  );
});
