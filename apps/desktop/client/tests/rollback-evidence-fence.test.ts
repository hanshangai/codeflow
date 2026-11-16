import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLLBACK_EVIDENCE_FENCE_SOURCE,
  type RawEngineEventEnvelope,
  type ThreadId,
  type WorkspaceId,
} from "@codeflowai/shared";

import {
  createRollbackEvidenceFence,
  waitForPostReconcileEventDurability,
} from "../src/app/rollbackEvidenceFence.ts";
import type { ClientToServerMessage } from "../src/protocol/messages.ts";

const WORKSPACE_ID = "client-test:rollback-fence" as WorkspaceId;
const THREAD_ID = "thread-rollback-fence" as ThreadId;

/** 将 fence 请求转换成对应的 Server raw ACK。 */
function buildFenceAck(message: ClientToServerMessage, seq: number): RawEngineEventEnvelope {
  assert.equal(message.t, "raw.event");
  return {
    ...message.event,
    schema: 1,
    seq,
  } as RawEngineEventEnvelope;
}

test("rollback evidence fence resolves only after its raw ACK", async () => {
  const sent: ClientToServerMessage[] = [];
  const fence = createRollbackEvidenceFence({
    send(message) {
      sent.push(message);
      return { accepted: true };
    },
  });

  const pending = fence.request({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex" });
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as any).event.source, ROLLBACK_EVIDENCE_FENCE_SOURCE);
  assert.equal(fence.acceptAck(buildFenceAck(sent[0]!, 42)), true);
  assert.equal(await pending, 42);
});

test("rollback evidence fence rejects a transport failure explicitly", async () => {
  const fence = createRollbackEvidenceFence({
    send() {
      return { accepted: false, reason: "socket closed" };
    },
  });

  await assert.rejects(
    fence.request({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex" }),
    /socket closed/,
  );
});

test("rollback evidence fence rejects the matching waiter when ACK persistence fails", async () => {
  let sent!: ClientToServerMessage;
  const fence = createRollbackEvidenceFence({
    send(message) {
      sent = message;
      return { accepted: true };
    },
  });

  const pending = fence.request({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex" });
  assert.equal(fence.rejectAck(buildFenceAck(sent, 43), new Error("raw ACK write failed")), true);
  await assert.rejects(pending, /raw ACK write failed/);
});

test("post-reconcile durability waits for the fence before strict flush", async () => {
  const calls: string[] = [];
  let releaseFence!: () => void;
  const fenceGate = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  const pending = waitForPostReconcileEventDurability({
    rollbackReconciled: true,
    scope: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex" },
    async fence() {
      calls.push("fence-start");
      await fenceGate;
      calls.push("fence-ack");
      return 99;
    },
    flush() {
      calls.push("flush");
    },
  });

  await Promise.resolve();
  assert.deepEqual(calls, ["fence-start"]);
  releaseFence();
  await pending;
  assert.deepEqual(calls, ["fence-start", "fence-ack", "flush"]);
});

test("post-reconcile durability does not add a fence to ordinary sends", async () => {
  let called = false;
  await waitForPostReconcileEventDurability({
    rollbackReconciled: false,
    scope: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex" },
    async fence() {
      called = true;
      return 1;
    },
    flush() {
      called = true;
    },
  });
  assert.equal(called, false);
});

test("post-reconcile严格等待异步flush，失败保原因且不返回成功", async () => {
  let release!: () => void, finished = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cause = new Error("ASYNC_ROLLBACK_FLUSH_FAILED");
  const pending = waitForPostReconcileEventDurability({ rollbackReconciled: true,
    scope: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex" }, fence: async () => 99,
    async flush() { await gate; throw cause; },
  }).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await assert.rejects(pending, error => error === cause);
});
