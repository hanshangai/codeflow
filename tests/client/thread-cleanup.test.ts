import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClientToServerMessage, ClientDbStorageSummary, ThreadId, WorkspaceId } from "../../packages/shared/src/index.ts";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../../apps/desktop/client/src/app/handleApiRequest.ts";
import { ClientDbCleanupService } from "../../apps/desktop/client/src/db/clientDbCleanupService.ts";
import { openClientDb, type ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ThreadSessionManager } from "../../apps/desktop/client/src/engines/threadSessionManager.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";

const CLEANUP_CLIENT_ID = "client-cleanup-test";

type CleanupHarness = {
  db: ClientDb;
  directory: string;
  workspaceId: WorkspaceId;
  otherWorkspaceId: WorkspaceId;
};

/** 创建两个工作区的临时 Client DB，供筛选和删除隔离测试使用。 */
function createCleanupHarness(): CleanupHarness {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-cleanup-"));
  const workspaceId = "ws-cleanup-main" as WorkspaceId;
  const otherWorkspaceId = "ws-cleanup-other" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  fs.mkdirSync(path.join(directory, "other"), { recursive: true });
  db.workspaces.upsert({ id: workspaceId, title: "main", path: directory });
  db.workspaces.upsert({ id: otherWorkspaceId, title: "other", path: path.join(directory, "other") });
  return { db, directory, workspaceId, otherWorkspaceId };
}

/** 关闭并删除本测试创建的临时 DB 目录。 */
function disposeCleanupHarness(harness: CleanupHarness): void {
  harness.db.close();
  fs.rmSync(harness.directory, { recursive: true, force: true });
}

/** 创建 thread，并将时间改成测试指定值。 */
function createThread(
  harness: CleanupHarness,
  id: string,
  opts: {
    workspaceId?: WorkspaceId;
    createdAt?: number;
    updatedAt?: number;
    threadType?: "chat" | "orchestration";
    threadSubtype?: "requirement-analysis" | "master" | "node" | "node-discussion" | "asset-draft" | null;
    shared?: boolean;
  } = {},
): ThreadId {
  const threadId = id as ThreadId;
  const workspaceId = opts.workspaceId ?? harness.workspaceId;
  harness.db.threads.create({
    id: threadId,
    workspaceId,
    engine: "codex",
    title: id,
    threadType: opts.threadType ?? "chat",
    threadSubtype: opts.threadSubtype ?? null,
    sharedAcl: opts.shared
      ? {
          sharedWorkspaceId: "shared-cleanup" as any,
          ownerUserId: "owner-cleanup",
          participantUserIds: [],
        }
      : null,
  });
  harness.db.db
    .prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(opts.createdAt ?? 100, opts.updatedAt ?? 200, id);
  return threadId;
}

test("thread deletion lease blocks new turn starts until deletion finishes", () => {
  const workspaceId = "ws-deletion-lease" as WorkspaceId;
  const threadId = "thread-deletion-lease" as ThreadId;
  const threadStore = new ThreadStore();
  const runtime = threadStore.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "deletion lease",
  });
  const sessions = new ThreadSessionManager({
    workspaces: new Map(),
    threads: threadStore,
    sessionIdleCleanup: { enabled: false },
  });
  const release = sessions.beginThreadDeletion([threadId]);
  assert.throws(() => sessions.assertThreadAvailable(threadId), /正在删除/);
  assert.throws(() => sessions.beginThreadDeletion([threadId]), /正在删除/);
  release();
  const finishOperation = sessions.beginThreadOperation(threadId);
  assert.throws(() => sessions.beginThreadDeletion([threadId]), (error: any) => {
    assert.equal(error?.code, "thread_operation_in_progress");
    return true;
  });
  finishOperation();
  const releaseAfterOperation = sessions.beginThreadDeletion([threadId]);
  releaseAfterOperation();

  threadStore.delete(threadId);
  assert.throws(
    () => sessions.assertThreadAvailable(threadId, runtime),
    (error: any) => error?.code === "thread_runtime_stale",
  );
  assert.throws(
    () => sessions.getOrCreate(runtime),
    (error: any) => error?.code === "thread_runtime_stale",
  );
});

test("thread deletion lease rejects a concurrent queue append before it writes user data", async () => {
  const harness = createCleanupHarness();
  const threadId = createThread(harness, "thread-queue-during-delete");
  const runtimeStore = new ThreadStore();
  runtimeStore.create({
    threadId,
    workspaceId: harness.workspaceId,
    engine: "codex",
    title: "queue during delete",
  });
  const sessions = new ThreadSessionManager({
    workspaces: new Map([[harness.workspaceId, harness.directory]]),
    threads: runtimeStore,
    sessionIdleCleanup: { enabled: false },
  });
  const sent: ClientToServerMessage[] = [];
  const releaseDeletion = sessions.beginThreadDeletion([threadId]);
  try {
    await handleApiRequest({
      db: harness.db,
      workspaces: new Map([[harness.workspaceId, harness.directory]]),
      clientId: "client-cleanup-test",
      threads: runtimeStore,
      sessions,
      send(message: ClientToServerMessage) {
        sent.push(message);
      },
    } as unknown as ApiHandlerContext, {
      t: "api.req",
      id: "queue-during-delete",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: harness.workspaceId,
        threadId,
        text: "must not be queued",
        sendOptions: { workMode: "general" },
      },
    } as ApiRequestMessage);
    const response = sent.find((message) => message.t === "api.res" && message.id === "queue-during-delete") as any;
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "thread_deletion_in_progress");
    assert.deepEqual(harness.db.threadMessageQueue.listActiveByThread(threadId), []);
  } finally {
    releaseDeletion();
    disposeCleanupHarness(harness);
  }
});


/** 当前清理接口测试使用真实服务和临时数据库，不恢复已退役的批量删会话接口。 */
function createCurrentCleanupHarness(harness: CleanupHarness) {
  let flushCount = 0;
  const notices: string[] = [];
  const released: string[] = [];
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: path.join(harness.directory, "client.db"),
    batchSize: 2,
    batchDelayMs: 1,
    flushEventPersistence() { flushCount += 1; },
    async beginThreadCleanup({ threadId }) { return () => { released.push(threadId); }; },
    onThreadHistoryCleaned({ threadId }) { notices.push(threadId); },
  });
  const messages: ClientToServerMessage[] = [];
  const ctx = {
    db: harness.db,
    dbCleanup: service,
    clientId: CLEANUP_CLIENT_ID,
    workspaces: new Map([[harness.workspaceId, harness.directory]]),
    send(message: ClientToServerMessage) { messages.push(message); },
  } as unknown as ApiHandlerContext;
  return {
    service, ctx, notices, released,
    get flushCount() { return flushCount; },
    async call(method: string, body: Record<string, unknown> = {}) {
      const id = `cleanup-${messages.length}`;
      await handleApiRequest(ctx, {
        t: "api.req", id, method, path: `/${method}`, body: { clientId: CLEANUP_CLIENT_ID, ...body },
      } as ApiRequestMessage);
      const message = messages.find((item) => item.t === "api.res" && item.id === id);
      assert.ok(message && message.t === "api.res");
      assert.ok(message.body && typeof message.body === "object");
      return { ...message, body: message.body as { ok: boolean; code?: string; storage?: ClientDbStorageSummary } };
    },
    close() { service.dispose(); disposeCleanupHarness(harness); },
  };
}

test("history cleanup paging uses a strict activity cutoff across workspaces and thread types", () => {
  const harness = createCleanupHarness();
  try {
    const old = createThread(harness, "old", { updatedAt: 199 });
    createThread(harness, "boundary", { updatedAt: 300 });
    const other = createThread(harness, "other", { workspaceId: harness.otherWorkspaceId, updatedAt: 220 });
    const master = createThread(harness, "master", { threadType: "orchestration", threadSubtype: "master", updatedAt: 230 });
    const shared = createThread(harness, "shared", { shared: true, updatedAt: 240 });
    harness.db.workspaces.delete(harness.otherWorkspaceId);
    const first = harness.db.threads.listHistoryCleanupTargetPage({ inactiveBefore: 300, limit: 1 });
    assert.deepEqual(first.items.map((item) => item.threadId), [old]);
    assert.equal(first.hasMore, true);
    const rest = harness.db.threads.listHistoryCleanupTargetPage({ inactiveBefore: 300, cursor: first.nextCursor, limit: 50 });
    assert.deepEqual(new Set(rest.items.map((item) => item.threadId)), new Set([other, master, shared]));
    assert.equal(rest.items.find((item) => item.threadId === other)?.workspaceId, harness.otherWorkspaceId);
    assert.equal(rest.items.find((item) => item.threadId === shared)?.sharedWorkspaceId, "shared-cleanup");
    assert.equal(rest.hasMore, false);
    assert.throws(() => harness.db.threads.listHistoryCleanupTargetPage({ inactiveBefore: 0 }), /Invalid/);
  } finally { disposeCleanupHarness(harness); }
});

test("retired thread cleanup and compaction RPCs fail without deleting any data", async () => {
  const harness = createCleanupHarness();
  const threadId = createThread(harness, "retained");
  const runtime = createCurrentCleanupHarness(harness);
  try {
    for (const method of ["threads.cleanup.preview", "threads.cleanup.validate", "threads.cleanup.delete", "clientDb.compact.start"]) {
      const response = await runtime.call(method, { threadIds: [threadId] });
      assert.equal(response.status, 404);
      assert.equal(response.body.code, "UNKNOWN_METHOD");
    }
    assert.ok(harness.db.threads.get(threadId));
    assert.equal(runtime.flushCount, 0);
  } finally { runtime.close(); }
});

test("current cleanup validates client identity, cutoff and service availability before scheduling", async () => {
  const runtime = createCurrentCleanupHarness(createCleanupHarness());
  try {
    for (const method of ["clientDb.cleanup.status", "clientDb.cleanup.start"]) {
      assert.equal((await runtime.call(method, { clientId: "" })).status, 400);
      const forbidden = await runtime.call(method, { clientId: "another-client" });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.code, "db_cleanup_client_mismatch");
    }
    for (const inactiveBefore of [0, -1, 1.5, "100", null, Date.now() + 60_000]) {
      const invalid = await runtime.call("clientDb.cleanup.start", { inactiveBefore });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.code, "db_cleanup_invalid_cutoff");
    }
    assert.equal(runtime.flushCount, 0);
    runtime.ctx.dbCleanup = undefined;
    for (const method of ["clientDb.cleanup.status", "clientDb.cleanup.start"]) {
      const unavailable = await runtime.call(method, { inactiveBefore: 300 });
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.code, "db_cleanup_unavailable");
    }
  } finally { runtime.close(); }
});

test("current cleanup returns queued, deduplicates repeated start and completes real event cleanup without deleting threads", { timeout: 15000 }, async () => {
  const harness = createCleanupHarness();
  const threadId = createThread(harness, "old-history", { updatedAt: 100 });
  const recentId = createThread(harness, "recent-history", { updatedAt: 500 });
  const runtime = createCurrentCleanupHarness(harness);
  try {
    for (const [seq, id] of [[1, threadId], [2, recentId]] as const) {
      const event = { schema: 1, seq, ts: seq, workspaceId: harness.workspaceId, threadId: id, engine: "codex", type: "system.notice", payload: { level: "info", text: "cleanup fixture" } };
      harness.db.db.prepare("INSERT INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts) VALUES (?, ?, ?, 'codex', 'system.notice', ?, ?)")
        .run(seq, id, harness.workspaceId, JSON.stringify(event), seq);
    }
    const started = await runtime.call("clientDb.cleanup.start", { inactiveBefore: 300 });
    assert.equal(started.status, 202);
    assert.equal(started.body.storage?.cleanup.status, "queued");
    const retry = await runtime.call("clientDb.cleanup.start", { inactiveBefore: 300 });
    assert.equal(retry.body.storage?.cleanup.jobId, started.body.storage?.cleanup.jobId);
    const conflict = await runtime.call("clientDb.cleanup.start", { inactiveBefore: 400 });
    assert.equal(conflict.status, 409);
    assert.equal(runtime.flushCount, 1);
    const deadline = Date.now() + 10000;
    while (runtime.service.getStorageSummary().cleanup.status !== "completed" && Date.now() < deadline) {
      const snapshot = runtime.service.getStorageSummary().cleanup;
      assert.notEqual(snapshot.status, "failed", JSON.stringify(snapshot.error));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = await runtime.call("clientDb.cleanup.status");
    assert.equal(status.status, 200);
    assert.equal(status.body.storage?.cleanup.status, "completed");
    assert.equal(status.body.storage?.cleanup.deletedConversationEventCount, 1);
    assert.equal(harness.db.conversationEvents.listByThread(threadId, { limit: 10 }).length, 0);
    assert.equal(harness.db.conversationEvents.listByThread(recentId, { limit: 10 }).length, 1);
    assert.ok(harness.db.threads.get(threadId));
    assert.ok(harness.db.threads.get(recentId));
    assert.deepEqual(runtime.notices, [threadId]);
    assert.deepEqual(runtime.released, [threadId]);
  } finally { runtime.close(); }
});
