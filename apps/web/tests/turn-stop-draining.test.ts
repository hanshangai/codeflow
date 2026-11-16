import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "../src/store/chat.ts";

test("停止后draining权威阶段与回放同一turn合并，不丢失保存中状态", () => {
  setActivePinia(createPinia());
  const chat = useChatStore(), threadId = "thread" as never;
  chat.applyThreadRunningState(threadId, { runningTurnId: "turn", runningTurnStartedAt: 1 });
  chat.setThreadRunningHint(threadId, { runningTurnId: "turn", runningTurnStartedAt: 1, phase: "draining", runningSource: "runtime" });
  assert.equal(chat.threadDisplayRunningStateForThread(threadId)?.phase, "draining");
  assert.equal(chat.threadDisplayRunningStateForThread(threadId)?.runningTurnId, "turn");
  chat.setThreadRunningHint(threadId, { runningTurnId: "turn", runningTurnStartedAt: 1, phase: "failed", failureCode: "TURN_EVENT_FLUSH_FAILED" });
  assert.equal(chat.threadDisplayRunningStateForThread(threadId)?.phase, "failed");
  assert.equal(chat.threadDisplayRunningStateForThread(threadId)?.failureCode, "TURN_EVENT_FLUSH_FAILED");
  chat.applyThreadRunningState(threadId, null);
  chat.setThreadRunningHint(threadId, null);
  assert.equal(chat.threadDisplayRunningStateForThread(threadId), null);
});
