import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { createConversationEventAckBuffer } from "../../apps/desktop/client/src/diagnostics/conversationEventAckBuffer.ts";

/** 构造 ACK buffer 测试使用的最小 canonical event。 */
function buildConversationEvent(seq = 1): any {
  return {
    schema: 1,
    seq,
    ts: seq,
    workspaceId: "ws-conv-strict",
    threadId: "thread-conv-strict",
    engine: "codex",
    type: "system.notice",
    payload: { level: "info", text: `event-${seq}` },
  };
}

/** 故障只注入真实W仓储，应用库仅保留注册职责。 */
function createFailureFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-conv-ack-failure-"));
  const app = openClientDb({ dbPath: path.join(root, "client.db") });
  app.workspaces.upsert({ id: "ws-conv-strict", title: "tmp", path: root });
  const db = app.forWorkspace("ws-conv-strict");
  db.threads.create({ id: "thread-conv-strict", workspaceId: "ws-conv-strict", engine: "codex", title: "tmp" });
  t.after(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, db };
}

test("conversation event ack buffer flushes queued events in batches", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-conv-ack-buffer-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-conv-ack" as any;
    const threadId = "thread-conv-ack" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "tmp" });

    const buffer = createConversationEventAckBuffer(db, { maxBatchSize: 3, flushDelayMs: 10 });
    for (let i = 1; i <= 5; i += 1) {
      buffer.enqueue({
        schema: 1,
        seq: i,
        ts: Date.now(),
        workspaceId,
        threadId,
        engine: "claude",
        type: "item.agentMessage.delta",
        payload: { itemId: `item-${i}` as any, engineMessageId: `engine-${i}`, delta: "x" },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
    buffer.flush();

    const replay = db.conversationEvents.listByThread(threadId, { limit: 10 });
    assert.equal(replay.length, 5);
    assert.deepEqual(
      replay.map((event) => event.seq),
      [1, 2, 3, 4, 5],
    );
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("conversation event ack buffer dispose drains queued events immediately", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-conv-ack-buffer-dispose-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-conv-ack-dispose" as any;
    const threadId = "thread-conv-ack-dispose" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "tmp" });

    const buffer = createConversationEventAckBuffer(db, { maxBatchSize: 3, flushDelayMs: 10_000 });
    for (let i = 1; i <= 5; i += 1) {
      buffer.enqueue({
        schema: 1,
        seq: i,
        ts: Date.now(),
        workspaceId,
        threadId,
        engine: "claude",
        type: "item.agentMessage.delta",
        payload: { itemId: `item-${i}` as any, engineMessageId: `engine-${i}`, delta: "x" },
      });
    }

    buffer.dispose();

    const replay = db.conversationEvents.listByThread(threadId, { limit: 10 });
    assert.equal(replay.length, 5);
    assert.equal(buffer.getPendingCount(), 0);
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("conversation event ack buffer merges adjacent delta events before persisting", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-conv-ack-buffer-merge-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-conv-ack-merge" as any;
    const threadId = "thread-conv-ack-merge" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "tmp" });

    const buffer = createConversationEventAckBuffer(db, { maxBatchSize: 10, flushDelayMs: 10_000 });
    buffer.enqueue({
        schema: 1,
      seq: 1,
      ts: 1,
      workspaceId,
      threadId,
      engine: "claude",
      type: "item.agentMessage.delta",
      payload: { itemId: "msg-1" as any, engineMessageId: "engine-1", delta: "您" },
    });
    buffer.enqueue({
        schema: 1,
      seq: 2,
      ts: 2,
      workspaceId,
      threadId,
      engine: "claude",
      type: "item.agentMessage.delta",
      payload: { itemId: "msg-1" as any, engineMessageId: "engine-1", delta: "好" },
    });
    buffer.enqueue({
        schema: 1,
      seq: 3,
      ts: 3,
      workspaceId,
      threadId,
      engine: "claude",
      type: "tokenUsage.updated",
      payload: { tokenUsage: { inputTokens: 1, outputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null, modelContextWindow: null }, source: "current" },
    });

    buffer.dispose();

    const replay = db.conversationEvents.listByThread(threadId, { limit: 10 });
    assert.equal(replay.length, 2);
    assert.equal(replay[0]?.type, "item.agentMessage.delta");
    assert.equal((replay[0]?.payload as any)?.delta, "您好");
    assert.equal(replay[0]?.seq, 2);
    assert.equal(replay[1]?.type, "tokenUsage.updated");
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("conversation event ack buffer strict flush retains batch failure without single fallback", t => {
  const f = createFailureFixture(t), original = new Error("conversation batch failed");
  const batch = t.mock.method(f.db.conversationEvents, "appendEnvelopes", () => { throw original; });
  const single = t.mock.method(f.db.conversationEvents, "appendEnvelope", () => { assert.fail("不得逐条补写"); });
  const buffer = createConversationEventAckBuffer(f.app, { flushDelayMs: 10_000 });
  buffer.enqueue(buildConversationEvent());

  assert.throws(() => buffer.flush(), error => (error as Error).cause === original);
  assert.equal(single.mock.callCount(), 0);
  assert.equal(buffer.getPendingCount(), 1);
  assert.throws(() => buffer.dispose(), error => (error as Error).cause === original);
  batch.mock.restore(); single.mock.restore();
  buffer.dispose();
  assert.equal(f.db.conversationEvents.listByThread("thread-conv-strict", { limit: 10 }).length, 1);
});

test("conversation event ack buffer strict flush preserves persistence and diagnostic failures for retry", t => {
  const f = createFailureFixture(t), original = new Error("conversation batch failed"), logging = false;
  const batch = t.mock.method(f.db.conversationEvents, "appendEnvelopes", () => { throw original; });
  const writer = t.mock.method(f.app, "writeWorkspaceLog", () => { throw logging; });
  const buffer = createConversationEventAckBuffer(f.app, { flushDelayMs: 10_000 });
  buffer.enqueue(buildConversationEvent());

  assert.throws(
    () => buffer.flush(),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === logging,
  );
  assert.equal(buffer.getPendingCount(), 1);

  batch.mock.restore(); writer.mock.restore();
  buffer.flush();
  assert.deepEqual(f.db.conversationEvents.listByThread("thread-conv-strict", { limit: 10 }).map(event => event.seq), [1]);
  assert.equal(buffer.getPendingCount(), 0);
  buffer.dispose();
});

test("conversation event ack buffer background failure remains visible until explicit retry", async t => {
  const f = createFailureFixture(t), original = new Error("conversation background batch failed");
  const batch = t.mock.method(f.db.conversationEvents, "appendEnvelopes", () => { throw original; });
  const buffer = createConversationEventAckBuffer(f.app, { flushDelayMs: 5 });
  buffer.enqueue(buildConversationEvent());

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.db.conversationEvents.listByThread("thread-conv-strict", { limit: 10 }).length, 0);
  assert.equal(buffer.getPendingCount(), 1);
  assert.throws(() => buffer.assertNoFailure(), error => (error as Error).cause === original);
  batch.mock.restore();
  buffer.dispose();
  assert.equal(buffer.getPendingCount(), 0);
});
