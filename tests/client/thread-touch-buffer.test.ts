import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { createThreadTouchBuffer } from "../../apps/desktop/client/src/diagnostics/threadTouchBuffer.ts";

test("thread touch buffer coalesces repeated touches and keeps latest timestamp", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-touch-buffer-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-thread-touch" as any;
    const threadId = "thread-touch" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "tmp" });

    const buffer = createThreadTouchBuffer(db, { flushDelayMs: 10 });
    buffer.enqueue(threadId, 100);
    buffer.enqueue(threadId, 200);
    buffer.enqueue(threadId, 150);
    await new Promise((resolve) => setTimeout(resolve, 30));
    buffer.flush();

    const thread = db.threads.get(threadId);
    assert.ok(thread);
    assert.equal(thread?.updatedAt, 200);
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread touch buffer dispose drains pending touch immediately", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-touch-buffer-dispose-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-thread-touch-dispose" as any;
    const threadId = "thread-touch-dispose" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "tmp" });

    const buffer = createThreadTouchBuffer(db, { flushDelayMs: 10_000 });
    buffer.enqueue(threadId, 100);
    buffer.enqueue(threadId, 200);
    buffer.dispose();

    const thread = db.threads.get(threadId);
    assert.ok(thread);
    assert.equal(thread?.updatedAt, 200);
    assert.equal(buffer.getPendingCount(), 0);
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread touch buffer strict flush keeps failed rows out of automatic retries", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-touch-failure-"));
  const app = openClientDb({ dbPath: path.join(directory, "client.db") });
  const workspaceId = "touch:strict", first = "thread-strict", second = "thread-strict-next";
  app.workspaces.upsert({ id: workspaceId, title: "strict", path: directory });
  const db = app.forWorkspace(workspaceId);
  for (const threadId of [first, second]) db.threads.create({ id: threadId, workspaceId, engine: "codex", title: threadId });
  const before = [first, second].map(threadId => db.threads.get(threadId)!.updatedAt);
  const original = new Error("THREAD_TOUCH_TEST_WRITE_FAILED");
  const write = t.mock.method(db.threads, "touchMany", () => { throw original; });
  const single = t.mock.method(db.threads, "touch", () => { assert.fail("must not retry individual rows"); });
  const buffer = createThreadTouchBuffer(app, { flushDelayMs: 50 });
  t.after(() => { write.mock.restore(); single.mock.restore(); buffer.dispose(); app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  buffer.enqueue(first, 300, { workspaceId });
  assert.throws(() => buffer.flush(), error => (error as Error).cause === original);
  assert.equal(buffer.getPendingCount(), 1);
  buffer.enqueue(second, 400, { workspaceId });
  t.mock.timers.tick(80);
  assert.equal(buffer.getPendingCount(), 2);
  assert.throws(() => buffer.assertNoFailure(workspaceId), error => (error as Error).cause === original);
  assert.deepEqual([first, second].map(threadId => db.threads.get(threadId)!.updatedAt), before);
  assert.equal(write.mock.callCount(), 1);
  assert.equal(single.mock.callCount(), 0);
  write.mock.restore();
  buffer.flush();
  assert.equal(buffer.getPendingCount(), 0);
  assert.doesNotThrow(() => buffer.assertNoFailure(workspaceId));
  assert.deepEqual([first, second].map(threadId => db.threads.get(threadId)!.updatedAt), [300, 400]);
});
