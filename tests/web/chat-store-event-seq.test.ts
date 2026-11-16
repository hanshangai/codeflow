import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "../support/web-pinia.ts";

import type { EngineEventEnvelope, ThreadId, WorkspaceId } from "../../packages/shared/src/index.ts";
import { useChatStore } from "../../apps/web/src/store/chat.ts";

/** 构造最小 canonical 事件，覆盖 Web store 的实时事件归并路径。 */
function createEvent(
  seq: number,
  threadId: ThreadId,
  type: EngineEventEnvelope["type"],
  payload: Record<string, unknown>,
): EngineEventEnvelope {
  return {
    schema: 1,
    seq,
    ts: seq,
    workspaceId: "ws-chat-seq" as WorkspaceId,
    threadId,
    engine: "codex",
    type,
    payload,
  } as EngineEventEnvelope;
}

test("chat store applies a late terminal event even when workspace seq already advanced", () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const runningThreadId = "thread-running-seq" as ThreadId;
  const otherThreadId = "thread-other-seq" as ThreadId;

  chat.applyEngineEvent(createEvent(100, runningThreadId, "turn.started", { turnId: "turn-running" }));
  assert.equal(chat.threadDisplayRunningStateForThread(runningThreadId)?.runningTurnId, "turn-running");

  chat.applyEngineEvent(createEvent(200, otherThreadId, "system.notice", {
    level: "info",
    text: "其他 thread 后到事件",
  }));
  assert.equal(chat.activeWorkspaceLastEventSeq, 200);

  chat.applyEngineEvent(createEvent(150, runningThreadId, "turn.completed", {
    turnId: "turn-running",
    result: { responseText: "done" },
  }));

  assert.equal(chat.threadDisplayRunningStateForThread(runningThreadId), null);
  assert.equal(chat.activeWorkspaceLastEventSeq, 200);
});
