import test from "node:test";
import assert from "node:assert/strict";

import { AssistantLifecycleTracker } from "../../apps/desktop/client/src/engines/assistantLifecycle.ts";

test("AssistantLifecycleTracker tracks pending and completed assistant items by turn", () => {
  const tracker = new AssistantLifecycleTracker();
  tracker.startTurn("turn-1" as any);

  const record = tracker.ensureStarted({
    itemId: "msg-1",
    engineMessageId: "engine-msg-1",
    turnId: "turn-1" as any,
    phase: "commentary",
  });
  tracker.appendDelta("msg-1", "hello");

  assert.equal(record.text, "hello");
  assert.equal(tracker.listPendingTerminalization("turn-1" as any).length, 1);

  tracker.markCompleted({
    itemId: "msg-1",
    text: "hello world",
    revision: 1,
    phase: "commentary",
    completionSource: "provider",
  });

  assert.equal(tracker.listPendingTerminalization("turn-1" as any).length, 0);
  assert.equal(tracker.latestText("turn-1" as any), "hello world");
});

test("AssistantLifecycleTracker latestText 优先返回 final_answer / structured_result，并支持 retireTurn", () => {
  const tracker = new AssistantLifecycleTracker();
  tracker.startTurn("turn-2" as any);

  tracker.ensureStarted({
    itemId: "msg-commentary",
    engineMessageId: "engine-commentary",
    turnId: "turn-2" as any,
    phase: "commentary",
  });
  tracker.appendDelta("msg-commentary", "draft commentary");
  tracker.markCompleted({
    itemId: "msg-commentary",
    text: "draft commentary",
    revision: 1,
    phase: "commentary",
    completionSource: "provider",
  });

  tracker.ensureCompleted({
    itemId: "msg-final",
    engineMessageId: "engine-final",
    turnId: "turn-2" as any,
    text: "final answer",
    revision: 1,
    phase: "final_answer",
    completionSource: "snapshot_reconcile",
  });

  assert.equal(tracker.latestText("turn-2" as any), "final answer");

  tracker.retireTurn("turn-2" as any);
  assert.equal(tracker.activeTurn(), null);
  assert.equal(tracker.isTurnRetired("turn-2" as any), true);
});

test("AssistantLifecycleTracker 在 completed 后保持单调收敛，late delta/snapshot 不再回写", () => {
  const tracker = new AssistantLifecycleTracker();
  tracker.startTurn("turn-3" as any);
  tracker.ensureCompleted({
    itemId: "msg-immutable",
    engineMessageId: "engine-immutable",
    turnId: "turn-3" as any,
    text: "final text",
    revision: 2,
    phase: "final_answer",
    completionSource: "provider",
  });

  tracker.appendDelta("msg-immutable", " late");
  tracker.applySnapshot({
    itemId: "msg-immutable",
    text: "older snapshot",
    revision: 1,
    phase: "commentary",
  });

  const record = tracker.get("msg-immutable");
  assert.equal(record?.text, "final text");
  assert.equal(record?.revision, 2);
  assert.equal(record?.phase, "final_answer");
});

test("AssistantLifecycleTracker latestText 在同 phase 多 item 时选择最后更新的 authoritative item", () => {
  const tracker = new AssistantLifecycleTracker();
  tracker.startTurn("turn-4" as any);

  tracker.ensureCompleted({
    itemId: "msg-final-a",
    engineMessageId: "engine-final-a",
    turnId: "turn-4" as any,
    text: "first final",
    revision: 1,
    phase: "final_answer",
    completionSource: "provider",
  });
  tracker.ensureCompleted({
    itemId: "msg-final-b",
    engineMessageId: "engine-final-b",
    turnId: "turn-4" as any,
    text: "second final",
    revision: 1,
    phase: "final_answer",
    completionSource: "provider",
  });

  assert.equal(tracker.latestText("turn-4" as any), "second final");
});

test("AssistantLifecycleTracker duplicate completed 不会让旧 item 抢回 latestText", () => {
  const tracker = new AssistantLifecycleTracker();
  tracker.startTurn("turn-5" as any);

  tracker.ensureCompleted({
    itemId: "msg-a",
    engineMessageId: "engine-a",
    turnId: "turn-5" as any,
    text: "first final",
    revision: 1,
    phase: "final_answer",
    completionSource: "provider",
  });
  tracker.ensureCompleted({
    itemId: "msg-b",
    engineMessageId: "engine-b",
    turnId: "turn-5" as any,
    text: "second final",
    revision: 1,
    phase: "final_answer",
    completionSource: "provider",
  });
  tracker.markCompleted({
    itemId: "msg-a",
    text: "first final",
    revision: 1,
    phase: "commentary",
    completionSource: "provider",
  });

  assert.equal(tracker.latestText("turn-5" as any), "second final");
  assert.equal(tracker.get("msg-a")?.phase, "final_answer");
});
