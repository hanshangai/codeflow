import test from "node:test";
import assert from "node:assert/strict";

import { createCodexProviderTurnMappingConflictError } from "../../apps/desktop/client/src/db/repos/codexProviderTurnMapping.ts";
import {
  decideTransportMessageFailureDisposition,
  prepareTransportMessageFailure,
} from "../../apps/desktop/client/src/transport/transportMessageFailurePolicy.ts";

test("未知 raw event ACK 索引失败仍关闭 Client", () => {
  assert.equal(decideTransportMessageFailureDisposition({
    messageType: "raw.eventAck",
    error: new Error("raw index failed"),
    event: null,
    turn: null,
  }), "shutdown_client");
});

test("旧终态 Codex turn 的结构化 engineBound 冲突只隔离该映射", () => {
  const mappingConflict = createCodexProviderTurnMappingConflictError("session mismatch", {
    kind: "session_mismatch",
    clientTurnId: "turn-old",
    existingSessionId: "session-b",
    incomingSessionId: "session-a",
    existingProviderTurnId: null,
    incomingProviderTurnId: "provider-a",
  });
  assert.equal(decideTransportMessageFailureDisposition({
    messageType: "conversation.eventAck",
    error: new Error("Conversation event ACK 索引失败", { cause: mappingConflict }),
    event: {
      type: "turn.engineBound",
      engine: "codex",
      workspaceId: "ws",
      threadId: "thread",
      payload: { turnId: "turn-old" },
    },
    turn: {
      turnId: "turn-old",
      workspaceId: "ws",
      threadId: "thread",
      engine: "codex",
      status: "error",
    },
  }), "isolate_terminal_turn_mapping");
});

test("active、跨 scope 与未知 conversation ACK 故障仍关闭 Client", () => {
  const mappingConflict = createCodexProviderTurnMappingConflictError("mapping conflict", {
    kind: "turn_mismatch",
    clientTurnId: "turn-1",
    existingSessionId: "session-a",
    incomingSessionId: "session-a",
    existingProviderTurnId: "provider-a",
    incomingProviderTurnId: "provider-b",
  });
  const base = {
    messageType: "conversation.eventAck",
    error: mappingConflict,
    event: {
      type: "turn.engineBound",
      engine: "codex",
      workspaceId: "ws",
      threadId: "thread",
      payload: { turnId: "turn-1" },
    },
  } as const;
  assert.equal(decideTransportMessageFailureDisposition({
    ...base,
    turn: { turnId: "turn-1", workspaceId: "ws", threadId: "thread", engine: "codex", status: "started" },
  }), "shutdown_client");
  assert.equal(decideTransportMessageFailureDisposition({
    ...base,
    turn: { turnId: "turn-1", workspaceId: "other", threadId: "thread", engine: "codex", status: "error" },
  }), "shutdown_client");
  assert.equal(decideTransportMessageFailureDisposition({
    ...base,
    error: new Error("database is closed"),
    turn: { turnId: "turn-1", workspaceId: "ws", threadId: "thread", engine: "codex", status: "error" },
  }), "shutdown_client");
  assert.equal(decideTransportMessageFailureDisposition({
    messageType: "api.req",
    error: mappingConflict,
    event: null,
    turn: null,
  }), "shutdown_client");
});

test("旧终态 Codex turn 的结构化 raw 映射冲突只严格落库 raw 证据", () => {
  const mappingConflict = createCodexProviderTurnMappingConflictError("raw mapping mismatch", {
    kind: "turn_mismatch",
    clientTurnId: "turn-old",
    existingSessionId: "session-a",
    incomingSessionId: "session-a",
    existingProviderTurnId: "provider-a",
    incomingProviderTurnId: "provider-b",
  });
  let rawFlushes = 0;
  const prepared = prepareTransportMessageFailure({
    messageType: "raw.eventAck",
    error: mappingConflict,
    event: {
      type: "turn/started",
      engine: "codex",
      workspaceId: "ws",
      threadId: "thread",
      clientTurnId: "turn-old",
      payload: { turnId: "turn-old" },
    },
    loadTurn: () => ({
      turnId: "turn-old",
      workspaceId: "ws",
      threadId: "thread",
      engine: "codex",
      status: "error",
    }),
    flushConversationEvidence: () => {
      throw new Error("raw ACK 不应排空 canonical 队列");
    },
    flushRawEvidence: () => {
      rawFlushes += 1;
    },
  });

  assert.equal(prepared.disposition, "isolate_raw_event");
  assert.equal(rawFlushes, 1);
});

test("终态映射冲突只严格落库 canonical 证据", () => {
  const mappingConflict = createCodexProviderTurnMappingConflictError("session mismatch", {
    kind: "session_mismatch",
    clientTurnId: "turn-old",
    existingSessionId: "session-b",
    incomingSessionId: "session-a",
    existingProviderTurnId: null,
    incomingProviderTurnId: "provider-a",
  });
  let canonicalFlushes = 0;
  const prepared = prepareTransportMessageFailure({
    messageType: "conversation.eventAck",
    error: mappingConflict,
    event: {
      type: "turn.engineBound",
      engine: "codex",
      workspaceId: "ws",
      threadId: "thread",
      payload: { turnId: "turn-old" },
    },
    loadTurn: () => ({
      turnId: "turn-old",
      workspaceId: "ws",
      threadId: "thread",
      engine: "codex",
      status: "error",
    }),
    flushConversationEvidence: () => {
      canonicalFlushes += 1;
    },
    flushRawEvidence: () => {
      throw new Error("canonical 隔离不应排空 raw 队列");
    },
  });

  assert.equal(prepared.disposition, "isolate_terminal_turn_mapping");
  assert.equal(canonicalFlushes, 1);
});

test("隔离证据落库失败或 turn 快照读取失败时仍受控关闭 Client", () => {
  const mappingConflict = createCodexProviderTurnMappingConflictError("session mismatch", {
    kind: "session_mismatch",
    clientTurnId: "turn-old",
    existingSessionId: "session-b",
    incomingSessionId: "session-a",
    existingProviderTurnId: null,
    incomingProviderTurnId: "provider-a",
  });
  const event = {
    type: "turn.engineBound",
    engine: "codex",
    workspaceId: "ws",
    threadId: "thread",
    payload: { turnId: "turn-old" },
  } as const;
  const turn = {
    turnId: "turn-old",
    workspaceId: "ws",
    threadId: "thread",
    engine: "codex",
    status: "error",
  } as const;

  const flushFailed = prepareTransportMessageFailure({
    messageType: "conversation.eventAck",
    error: mappingConflict,
    event,
    loadTurn: () => turn,
    flushConversationEvidence: () => {
      throw new Error("database is closed");
    },
    flushRawEvidence: () => undefined,
  });
  assert.equal(flushFailed.disposition, "shutdown_client");
  assert.ok(flushFailed.effectiveError instanceof AggregateError);

  let flushCalls = 0;
  const lookupFailed = prepareTransportMessageFailure({
    messageType: "conversation.eventAck",
    error: mappingConflict,
    event,
    loadTurn: () => {
      throw new Error("database is closed");
    },
    flushConversationEvidence: () => {
      flushCalls += 1;
    },
    flushRawEvidence: () => {
      flushCalls += 1;
    },
  });
  assert.equal(lookupFailed.disposition, "shutdown_client");
  assert.equal(flushCalls, 0);
  assert.ok(lookupFailed.effectiveError instanceof AggregateError);
});
