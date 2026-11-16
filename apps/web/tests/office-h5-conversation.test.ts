import test from "node:test";
import assert from "node:assert/strict";

import type { EngineEventEnvelope } from "@codeflowai/shared";

import { replayOfficeH5Conversation } from "../src/features/office-h5/officeH5Conversation.ts";

function event(seq: number, type: string, payload: Record<string, unknown>): EngineEventEnvelope {
  return {
    schema: 1,
    seq,
    ts: 1_700_000_000_000 + seq,
    workspaceId: "workspace-a" as any,
    threadId: "thread-a" as any,
    engine: "codex",
    type,
    payload,
  } as EngineEventEnvelope;
}

test("Office H5 replays complete user and assistant interaction in sequence order", () => {
  const snapshot = replayOfficeH5Conversation("thread-a" as any, [
    event(4, "item.agentMessage.completed", {
      itemId: "assistant-1",
      engineMessageId: "engine-message-1",
      turnId: "turn-1",
      text: "\u5b8c\u6574\u56de\u590d",
      revision: 1,
      phase: "final_answer",
    }),
    event(1, "item.userMessage.created", {
      itemId: "user-1",
      turnId: "turn-1",
      text: "\u8bf7\u6267\u884c\u4efb\u52a1",
    }),
    event(5, "turn.completed", { turnId: "turn-1" }),
    event(2, "item.agentMessage.started", {
      itemId: "assistant-1",
      engineMessageId: "engine-message-1",
      turnId: "turn-1",
    }),
    event(3, "item.agentMessage.delta", {
      itemId: "assistant-1",
      engineMessageId: "engine-message-1",
      turnId: "turn-1",
      delta: "\u5904\u7406\u4e2d",
    }),
  ]);

  assert.deepEqual(snapshot.messages.map((item) => [item.role, item.text, item.streaming]), [
    ["user", "\u8bf7\u6267\u884c\u4efb\u52a1", false],
    ["assistant", "\u5b8c\u6574\u56de\u590d", false],
  ]);
  assert.deepEqual(snapshot.completedTurnIds, ["turn-1"]);
});

test("Office H5 exposes streaming assistant text before the turn completes", () => {
  const snapshot = replayOfficeH5Conversation("thread-a" as any, [
    event(1, "item.userMessage.created", {
      itemId: "user-1",
      turnId: "turn-1",
      text: "\u7ee7\u7eed",
    }),
    event(2, "item.agentMessage.started", {
      itemId: "assistant-1",
      engineMessageId: "engine-message-1",
      turnId: "turn-1",
    }),
    event(3, "item.agentMessage.delta", {
      itemId: "assistant-1",
      engineMessageId: "engine-message-1",
      turnId: "turn-1",
      delta: "\u6b63\u5728\u56de\u590d",
    }),
  ]);

  assert.equal(snapshot.messages.at(-1)?.text, "\u6b63\u5728\u56de\u590d");
  assert.equal(snapshot.messages.at(-1)?.streaming, true);
  assert.deepEqual(snapshot.completedTurnIds, []);
});
