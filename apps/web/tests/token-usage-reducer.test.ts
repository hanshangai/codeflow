import test from "node:test";
import assert from "node:assert/strict";

import type { EngineEventEnvelope } from "@codeflowai/shared";

import type { ThreadConversationState } from "../src/features/chat/chatTypes.ts";
import { createConversationState as createBaseConversationState } from "../../../tests/support/conversation-fixture.ts";
import { applyEngineEventToConversation } from "../src/features/chat/engineEventReducer.ts";

function createConversationState(): ThreadConversationState {
  return createBaseConversationState({ threadId: "thread-token-usage" });
}

function buildUsageEvent(
  seq: number,
  tokenUsage: Record<string, unknown>,
  cumulativeMode?: "snapshot" | "delta",
): EngineEventEnvelope {
  return {
    schema: 1,
    seq,
    ts: seq,
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-token-usage" as any,
    engine: "claude",
    type: "tokenUsage.updated",
    payload: {
      source: "cumulative",
      tokenUsage,
      ...(cumulativeMode ? { cumulativeMode } : {}),
    },
  } as EngineEventEnvelope;
}

test("GLM cumulative delta 会累加多轮本轮 usage", () => {
  const state = createConversationState();
  applyEngineEventToConversation(state, buildUsageEvent(1, {
    inputTokens: 23_668,
    outputTokens: 92,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    modelContextWindow: null,
  }, "delta"));
  applyEngineEventToConversation(state, buildUsageEvent(2, {
    inputTokens: 4_000,
    outputTokens: 30,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
    modelContextWindow: null,
  }, "delta"));

  assert.deepEqual(state.tokenUsage?.cumulative, {
    inputTokens: 27_668,
    outputTokens: 122,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
    totalTokens: null,
    reasoningOutputTokens: null,
  });
});

test("Claude cumulative snapshot 仍保持覆盖语义", () => {
  const state = createConversationState();
  applyEngineEventToConversation(state, buildUsageEvent(1, {
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 20,
    cacheCreationInputTokens: 5,
    modelContextWindow: null,
  }, "snapshot"));
  applyEngineEventToConversation(state, buildUsageEvent(2, {
    inputTokens: 150,
    outputTokens: 12,
    cachedInputTokens: 30,
    cacheCreationInputTokens: 7,
    modelContextWindow: null,
  }));

  assert.deepEqual(state.tokenUsage?.cumulative, {
    inputTokens: 150,
    outputTokens: 12,
    cachedInputTokens: 30,
    cacheCreationInputTokens: 7,
    totalTokens: null,
    reasoningOutputTokens: null,
  });
});
