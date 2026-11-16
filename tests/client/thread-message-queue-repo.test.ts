import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWorkspacePathReference, type ThreadId, type ThreadQueueSendOptions, type WorkspaceId } from "../../packages/shared/src/index.ts";
import { openClientDb, type ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

const sendOptions: ThreadQueueSendOptions = {
  workMode: "general",
  planMode: false,
  accessMode: null,
  model: null,
  effort: null,
  contextWindow: null,
  autoCompactPct: null,
  serviceTier: null,
};

/** 创建带 workspace/thread 的临时 DB，返回清理句柄。 */
function openQueueTestDb(): { db: ClientDb; workspacePath: string; workspaceId: WorkspaceId; threadId: ThreadId } {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-message-queue-"));
  const workspaceId = "ws-queue-repo" as WorkspaceId;
  const threadId = "thread-queue-repo" as ThreadId;
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "队列测试" });
  return { db, workspacePath, workspaceId, threadId };
}

/** 追加一条最小队列项，测试只关注队列状态机。 */
function appendQueueText(db: ClientDb, workspaceId: WorkspaceId, threadId: ThreadId, text: string) {
  return db.threadMessageQueue.appendItem({
    workspaceId,
    threadId,
    text,
    images: [],
    files: [],
    sendOptions,
    originWebSessionId: null,
  }).item;
}

test("thread message queue user mutations only affect pending items", () => {
  const { db, workspacePath, workspaceId, threadId } = openQueueTestDb();
  try {
    const first = appendQueueText(db, workspaceId, threadId, "first");
    const second = appendQueueText(db, workspaceId, threadId, "second");
    const third = appendQueueText(db, workspaceId, threadId, "third");

    const sending = db.threadMessageQueue.claimNextPending(threadId);
    assert.ok(sending);
    assert.equal(sending.id, first.id);
    assert.equal(sending.status, "sending");

    assert.equal(db.threadMessageQueue.moveDown(threadId, sending.id), false);
    assert.equal(db.threadMessageQueue.moveUp(threadId, sending.id), false);
    assert.equal(db.threadMessageQueue.remove(threadId, sending.id), false);

    assert.equal(db.threadMessageQueue.moveUp(threadId, third.id), true);
    assert.deepEqual(
      db.threadMessageQueue.listActiveByThread(threadId).map((item) => [item.id, item.status, item.text]),
      [
        [first.id, "sending", "first"],
        [third.id, "pending", "third"],
        [second.id, "pending", "second"],
      ],
    );

    assert.equal(db.threadMessageQueue.clear(threadId), 2);
    assert.deepEqual(
      db.threadMessageQueue.listActiveByThread(threadId).map((item) => [item.id, item.status]),
      [[first.id, "sending"]],
    );
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread message queue can cancel sending item and remove it from active list", () => {
  const { db, workspacePath, workspaceId, threadId } = openQueueTestDb();
  try {
    const pending = appendQueueText(db, workspaceId, threadId, "pending");
    assert.equal(db.threadMessageQueue.markCancelled(pending.id, "user_stop", "interrupted"), false);
    assert.equal(db.threadMessageQueue.getById(pending.id)?.status, "pending");

    const sending = db.threadMessageQueue.claimNextPending(threadId);
    assert.ok(sending);
    assert.equal(sending.id, pending.id);
    assert.equal(db.threadMessageQueue.markCancelled(pending.id, "user_stop", "interrupted"), true);

    const cancelled = db.threadMessageQueue.getById(pending.id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.failureCode, "user_stop");
    assert.equal(cancelled?.failureReason, "interrupted");
    assert.deepEqual(db.threadMessageQueue.listActiveByThread(threadId), []);
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread message queue removes sent item from active list immediately", () => {
  const { db, workspacePath, workspaceId, threadId } = openQueueTestDb();
  try {
    const first = appendQueueText(db, workspaceId, threadId, "first");
    const second = appendQueueText(db, workspaceId, threadId, "second");

    const sending = db.threadMessageQueue.claimNextPending(threadId);
    assert.ok(sending);
    assert.equal(sending.id, first.id);

    db.threadMessageQueue.markSent(first.id, "turn-first" as any);
    assert.deepEqual(
      db.threadMessageQueue.listActiveByThread(threadId).map((item) => [item.id, item.status, item.text]),
      [[second.id, "pending", "second"]],
    );
    assert.equal(db.threadMessageQueue.getById(first.id)?.sentTurnId, "turn-first");
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread message queue persists path references through list, get and claim", () => {
  const { db, workspacePath, workspaceId, threadId } = openQueueTestDb();
  try {
    const ref = createWorkspacePathReference({ path: "apps/web/src/store/chat.ts", kind: "file" });
    const appended = db.threadMessageQueue.appendItem({
      workspaceId,
      threadId,
      text: "check @apps/web/src/store/chat.ts",
      images: [],
      files: [],
      pathReferences: [ref],
      sendOptions,
      originWebSessionId: null,
    }).item;

    assert.deepEqual(appended.pathReferences.map((item) => item.path), ["apps/web/src/store/chat.ts"]);
    assert.deepEqual(db.threadMessageQueue.listActiveByThread(threadId)[0]?.pathReferences.map((item) => item.path), ["apps/web/src/store/chat.ts"]);
    assert.deepEqual(db.threadMessageQueue.getById(appended.id)?.pathReferences.map((item) => item.path), ["apps/web/src/store/chat.ts"]);
    assert.deepEqual(db.threadMessageQueue.claimNextPending(threadId)?.pathReferences.map((item) => item.path), ["apps/web/src/store/chat.ts"]);
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread message queue persists the fresh-turn model boundary", () => {
  const { db, workspacePath, workspaceId, threadId } = openQueueTestDb();
  try {
    const appended = db.threadMessageQueue.appendItem({
      workspaceId,
      threadId,
      text: "切换模型后从新 turn 继续",
      images: [],
      files: [],
      sendOptions: { ...sendOptions, model: "gpt-5.6-terra", forceNewTurn: true },
      originWebSessionId: null,
    }).item;

    assert.equal(appended.sendOptions.forceNewTurn, true);
    assert.equal(db.threadMessageQueue.claimNextPending(threadId)?.sendOptions.forceNewTurn, true);
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
