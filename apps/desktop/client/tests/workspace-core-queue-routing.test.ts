import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientToServerMessage, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { onThreadQueueAppend, onThreadQueueClear, onThreadQueueList, onThreadQueuePause, onThreadQueueResume } from "../src/app/handleThreadQueueRequest.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { allocateClientEventSeq } from "../src/db/repos/eventRepo.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";

/** 工作区核心库路由夹具：只使用真实 ClientDb、工作区目录和队列 handler。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-core-queue-"));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const workspaceId = "core-client:workspace" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  db.workspaces.upsert({ id: workspaceId, title: "核心工作区", path: workspacePath });
  const sent: ClientToServerMessage[] = [];
  const ctx = {
    db,
    clientId: "core-client",
    workspaces: new Map([[workspaceId, workspacePath]]),
    sessions: { hasActiveTurn: () => false },
    send: (message: ClientToServerMessage) => { sent.push(message); },
  } as unknown as ApiHandlerContext;
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, workspaceId, workspacePath, threadId: "workspace-thread" as ThreadId, ctx, sent };
}

test("队列入口在真实Writer许可下处理同步读写，不跨重试等待持锁", async t => {
  const f = fixture(t);
  f.db.forWorkspace(f.workspaceId).threads.create({ id: f.threadId, workspaceId: f.workspaceId, engine: "claude", title: "队列准入" });
  const writer = new ClientDbWriterService({ db: f.db, dbPath: path.join(path.dirname(f.workspacePath), "application.db"), onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    f.ctx.withDatabase = (id, operation) => writer.withLegacyDatabase(id, operation);
    const body = { workspaceId: f.workspaceId, threadId: f.threadId };
    const request = { t: "api.req" as const, id: "queue-writer", method: "threads.queue.append", path: "/test", body: { ...body, text: "许可内入队", sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null } } };
    await onThreadQueueAppend(f.ctx, request);
    await onThreadQueueList(f.ctx, { ...request, body });
    await onThreadQueuePause(f.ctx, { ...request, body });
    await onThreadQueueResume(f.ctx, { ...request, body });
    await onThreadQueueClear(f.ctx, { ...request, body });
    assert.equal(f.sent.filter(message => message.t === "api.res" && message.status === 200).length, 5);
  } finally { await writer.close(); }
});

test("队列短段间出现新的暂停时，旧send_failed快照不得自动恢复它", async t => {
  const f = fixture(t), scoped = f.db.forWorkspace(f.workspaceId);
  scoped.threads.create({ id: f.threadId, workspaceId: f.workspaceId, engine: "claude", title: "暂停代次" });
  scoped.threadQueueStates.pause(f.threadId, f.workspaceId, "send_failed");
  let changed = false;
  f.ctx.withDatabase = async (_requestId, operation) => {
    const result = operation();
    if (!changed && (result as any)?.item?.text === "保留新暂停") {
      changed = true;
      scoped.threadQueueStates.pause(f.threadId, f.workspaceId, "user_stop");
    }
    return result;
  };
  await onThreadQueueAppend(f.ctx, { t: "api.req", id: "newer-pause", method: "threads.queue.append", path: "/test", body: {
    workspaceId: f.workspaceId, threadId: f.threadId, text: "保留新暂停", sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null },
  } });
  assert.equal(changed, true);
  assert.equal(scoped.threadQueueStates.getState(f.threadId).pausedReason, "user_stop");
});

test("显式工作区视图隔离同名主键、异步回放和跨仓储事务", async t => {
  const f = fixture(t);
  const otherId = "core-client:other" as WorkspaceId;
  const otherPath = path.join(path.dirname(f.workspacePath), "other");
  fs.mkdirSync(otherPath);
  f.db.workspaces.upsert({ id: otherId, title: "另一工作区", path: otherPath });
  const first = f.db.forWorkspace(f.workspaceId);
  const second = f.db.forWorkspace(otherId);
  for (const [db, workspaceId, title] of [[first, f.workspaceId, "甲"], [second, otherId, "乙"]] as const) {
    db.threads.create({ id: f.threadId, workspaceId, engine: "codex", title });
    db.conversationEvents.appendEnvelope({ schema: 1, seq: 100, ts: 100, workspaceId, threadId: f.threadId,
      engine: "codex", type: "turn.started", payload: { turnId: "same-turn" as TurnId } });
  }
  assert.equal(first.threads.get(f.threadId)?.title, "甲");
  assert.equal(second.threads.get(f.threadId)?.title, "乙");
  assert.equal((await first.conversationEvents.listByThreadForReplay(f.threadId)).events[0]?.workspaceId, f.workspaceId);
  assert.equal((await second.conversationEvents.listByThreadForReplay(f.threadId)).events[0]?.workspaceId, otherId);
  assert.throws(() => first.db.transaction(() => {
    first.threads.rename(f.threadId, "不应提交");
    first.threadQueueStates.pause(f.threadId, f.workspaceId, "user_pause");
    throw new Error("injected-transaction-failure");
  })(), /injected-transaction-failure/);
  assert.equal(first.threads.get(f.threadId)?.title, "甲");
  assert.equal(first.threadQueueStates.getState(f.threadId).paused, false);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS total FROM threads").get()?.total, 0);
});

test("固定工作区视图拒绝向另一物理工作区写入归属字段", t => {
  const f = fixture(t);
  const scoped = f.db.forWorkspace(f.workspaceId);
  assert.throws(() => scoped.threads.create({ id: f.threadId, workspaceId: "other" as WorkspaceId,
    engine: "codex", title: "错误归属" }), /WORKSPACE_CORE_SCOPE_MISMATCH/);
  assert.equal(scoped.threads.get(f.threadId), null);
});

test("未知工作区队列请求不回退操作应用库旧会话", async t => {
  const f = fixture(t);
  f.db.threads.create({ id: f.threadId, workspaceId: f.workspaceId, engine: "codex", title: "旧会话" });
  f.db.threadMessageQueue.appendItem({ workspaceId: f.workspaceId, threadId: f.threadId, text: "旧队列", images: [], files: [],
    pathReferences: [], sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null } });
  await onThreadQueueClear(f.ctx, { t: "api.req", id: "unknown-workspace", method: "threads.queue.clear", path: "/test",
    body: { workspaceId: "unknown", threadId: f.threadId } });
  assert.equal((f.sent.at(-1) as any).status, 404);
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
});

test("队列请求按 thread 所属工作区库持久化，应用库不产生副本", async t => {
  const f = fixture(t);
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => {
    repos.threads.create({ id: f.threadId, workspaceId: f.workspaceId, engine: "codex", title: "工作区会话" });
  });

  assert.equal(f.db.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(f.threadId), undefined);
  await onThreadQueueAppend(f.ctx, {
    t: "api.req",
    id: "queue-workspace-route",
    method: "threads.queue.append",
    path: "/threads/queue/append",
    body: {
      workspaceId: f.workspaceId,
      threadId: f.threadId,
      text: "写入工作区库",
      sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null },
    },
  } as ApiRequestMessage);

  const response = f.sent.find(message => message.t === "api.res") as Extract<ClientToServerMessage, { t: "api.res" }>;
  assert.equal(response.status, 200, JSON.stringify(response));
  const queueItemId = (response.body as { item: { id: string } }).item.id;
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => {
    assert.equal(repos.threads.get(f.threadId)?.workspaceId, f.workspaceId);
    assert.equal(repos.threadMessageQueue.getById(queueItemId)?.text, "写入工作区库");
  });
  assert.equal(f.db.forWorkspace(f.workspaceId).threads.get(f.threadId)?.workspaceId, f.workspaceId);
  assert.equal(f.db.forWorkspace(f.workspaceId).threadMessageQueue.getById(queueItemId)?.text, "写入工作区库");
  assert.deepEqual(f.db.forWorkspace(f.workspaceId).threadMessageQueue.listThreadsWithPending(), [f.threadId]);
  assert.equal(f.db.db.prepare("SELECT 1 FROM thread_message_queue WHERE id = ?").get(queueItemId), undefined);

  await onThreadQueueList(f.ctx, {
    t: "api.req", id: "queue-workspace-list", method: "threads.queue.list", path: "/threads/queue/list",
    body: { workspaceId: f.workspaceId, threadId: f.threadId },
  } as ApiRequestMessage);
  const listResponse = f.sent.find(message => message.t === "api.res" && message.id === "queue-workspace-list") as Extract<ClientToServerMessage, { t: "api.res" }>;
  assert.equal(listResponse.status, 200, JSON.stringify(listResponse));
  assert.equal((listResponse.body as { items: Array<{ id: string }> }).items[0]?.id, queueItemId);

  await onThreadQueuePause(f.ctx, {
    t: "api.req", id: "queue-workspace-pause", method: "threads.queue.pause", path: "/threads/queue/pause",
    body: { workspaceId: f.workspaceId, threadId: f.threadId, reason: "user_pause" },
  } as ApiRequestMessage);
  await onThreadQueueResume(f.ctx, {
    t: "api.req", id: "queue-workspace-resume", method: "threads.queue.resume", path: "/threads/queue/resume",
    body: { workspaceId: f.workspaceId, threadId: f.threadId },
  } as ApiRequestMessage);
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => assert.equal(repos.threadQueueStates.getState(f.threadId).paused, false));
  assert.equal(f.db.forWorkspace(f.workspaceId).threadQueueStates.getState(f.threadId).paused, false);
  assert.equal(f.db.db.prepare("SELECT 1 FROM thread_queue_states WHERE thread_id = ?").get(f.threadId), undefined);
});

test("工作区核心仓储回调禁止跨异步持有 SQLite 连接", t => {
  const f = fixture(t);
  assert.throws(
    () => f.db.withWorkspaceCoreRepos(f.workspaceId, () => Promise.resolve()),
    error => error instanceof Error && error.message === "WORKSPACE_PROFILE_CALLBACK_MUST_BE_SYNCHRONOUS",
  );
});

test("旧的不完整核心表不会被静默当成完整工作区闭包", t => {
  const f = fixture(t);
  f.db.withWorkspaceExecutionProfiles(f.workspaceId, () => undefined);
  const workspaceDb = openSqliteDb(path.join(f.workspacePath, ".codeflowai", "workspace.db"));
  workspaceDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  workspaceDb.close();
  assert.throws(
    () => f.db.withWorkspaceCoreRepos(f.workspaceId, () => undefined),
    error => error instanceof Error && error.message === "WORKSPACE_CORE_SCHEMA_INVALID:threads",
  );
});

test("核心事件和 turn 沿同一 workspace 路由，不在应用库复制", t => {
  const f = fixture(t);
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => {
    repos.threads.create({ id: f.threadId, workspaceId: f.workspaceId, engine: "codex", title: "事件工作区会话" });
  });
  const seq = allocateClientEventSeq(f.db.db);
  f.db.forWorkspace(f.workspaceId).conversationEvents.appendEnvelope({ schema: 1, seq, ts: 1, workspaceId: f.workspaceId, threadId: f.threadId, engine: "codex", type: "thread.started", payload: {} } as any);
  f.db.forWorkspace(f.workspaceId).rawEvents.appendEnvelope({ schema: 1, seq: seq + 1, ts: 2, workspaceId: f.workspaceId, threadId: f.threadId, engine: "codex", source: "workspace-test", data: {}, handled: true, action: "mapped", emittedTypes: ["thread.started"] });
  f.db.forWorkspace(f.workspaceId).turns.insertStarted({ workspaceId: f.workspaceId, threadId: f.threadId, engine: "codex", turnId: "workspace-turn" as any, startedAt: 3, startEventSeq: seq });

  assert.equal(f.db.forWorkspace(f.workspaceId).conversationEvents.getLatestSeqByThread(f.threadId), seq);
  assert.equal(f.db.forWorkspace(f.workspaceId).rawEvents.getLatestSeqByThread(f.threadId), seq + 1);
  assert.equal(f.db.forWorkspace(f.workspaceId).turns.listRunningByWorkspace(f.workspaceId)[f.threadId]?.runningTurnId, "workspace-turn");
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS count FROM conversation_events WHERE thread_id = ?").get(f.threadId)?.count, 0);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events WHERE thread_id = ?").get(f.threadId)?.count, 0);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS count FROM thread_turns WHERE thread_id = ?").get(f.threadId)?.count, 0);
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => {
    assert.equal(repos.conversationEvents.getLatestSeqByThread(f.threadId), seq);
    assert.equal(repos.rawEvents.getLatestSeqByThread(f.threadId), seq + 1);
    assert.equal(repos.turns.get("workspace-turn" as any)?.threadId, f.threadId);
  });
});

test("工作区核心表保留会话、队列、附件和事件的外键闭包", t => {
  const f = fixture(t);
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => {
    const foreignKeys = (table: string) => (repos.db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; to: string }>);
    assert.deepEqual(
      foreignKeys("thread_message_queue").map(key => [key.table, key.from, key.to]),
      [["threads", "thread_id", "id"]],
    );
    assert.deepEqual(
      foreignKeys("thread_message_queue_attachments").map(key => [key.table, key.from, key.to]).sort(),
      [["thread_message_queue", "queue_item_id", "id"]],
    );
    assert.deepEqual(
      foreignKeys("thread_queue_states").map(key => [key.table, key.from, key.to]),
      [["threads", "thread_id", "id"]],
    );
    assert.deepEqual(
      foreignKeys("turn_file_changes").map(key => [key.table, key.from, key.to]).sort(),
      [["thread_turns", "turn_id", "turn_id"]],
    );
  });
});

test("草稿、文件变更和回滚记录沿工作区 thread 路由", t => {
  const f = fixture(t);
  const turnId = "workspace-turn-files" as TurnId;
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => {
    repos.threads.create({ id: f.threadId, workspaceId: f.workspaceId, engine: "codex", title: "文件工作区会话" });
    repos.turns.insertStarted({ workspaceId: f.workspaceId, threadId: f.threadId, engine: "codex", turnId, startedAt: 4, startEventSeq: null });
  });
  f.db.forWorkspace(f.workspaceId).threadDrafts.save({ workspaceId: f.workspaceId, threadId: f.threadId, text: "草稿", images: [], files: [], pathReferences: [] });
  f.db.forWorkspace(f.workspaceId).fileChanges.captureBefore({ threadId: f.threadId, turnId, path: "a.txt", beforeExists: false, beforeBlobId: null, capturedAt: 5 });
  f.db.forWorkspace(f.workspaceId).fileChanges.captureAfter({ threadId: f.threadId, turnId, path: "a.txt", afterExists: true, afterBlobId: null, capturedAt: 6 });
  const rollbackId = f.db.forWorkspace(f.workspaceId).rollbacks.insert({ threadId: f.threadId, toTurnId: turnId, droppedTurnCount: 0, droppedEventSeqGt: 0, createdAt: 7, result: "pending", error: null });
  f.db.forWorkspace(f.workspaceId).rollbacks.updateResult(rollbackId, { result: "success", error: null });
  assert.equal(f.db.forWorkspace(f.workspaceId).threadDrafts.get(f.threadId)?.text, "草稿");
  assert.equal(f.db.forWorkspace(f.workspaceId).fileChanges.listByThread(f.threadId)[0]?.path, "a.txt");
  assert.equal(f.db.forWorkspace(f.workspaceId).rollbacks.listByThread(f.threadId)[0]?.result, "success");
  assert.equal(f.db.db.prepare("SELECT 1 FROM thread_drafts WHERE thread_id = ?").get(f.threadId), undefined);
});

test("工作区核心仓储可在同一连接事务内原子回滚", t => {
  const f = fixture(t);
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => {
    repos.threads.create({ id: f.threadId, workspaceId: f.workspaceId, engine: "codex", title: "事务工作区会话" });
    assert.throws(() => repos.db.transaction(() => {
      repos.threadMessageQueue.appendItem({
        workspaceId: f.workspaceId,
        threadId: f.threadId,
        text: "待回滚",
        images: [],
        files: [],
        pathReferences: [],
        sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null },
      });
      repos.threadQueueStates.pause(f.threadId, f.workspaceId, "user_pause");
      throw new Error("ROLLBACK_CORE_TRANSACTION");
    })());
  });
  f.db.withWorkspaceCoreRepos(f.workspaceId, repos => {
    assert.deepEqual(repos.threadMessageQueue.listActiveByThread(f.threadId), []);
    assert.equal(repos.threadQueueStates.getState(f.threadId).paused, false);
  });
});

