import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { handleThreadsDelete, resumeThreadDeletions } from "../src/app/handlers/threadHandlers.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import { handleSharedWorkspaceCommand } from "../src/app/handlers/sharedWorkspaceHandlers.js";
import { resolveSharedWorkspaceEffectiveOperationPolicy, type SharedWorkspaceCommandEnvelope } from "@codeflowai/shared";
import { logger } from "../src/logger.js";

/** 真实临时工作区隔离删除标记与物理清理，不读取用户数据库。 */
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread-deletion-"));
  const dbPath = path.join(directory, "app.db");
  const root = path.join(directory, "project");
  fs.mkdirSync(root);
  const workspaceOperationGate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath, localCanonicalEvents: true, workspaceOperationGate });
  const workspaceId = "delete-client:workspace" as WorkspaceId;
  const threadId = "large-history" as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: "删除验证", path: root });
  const scoped = db.forWorkspace(workspaceId);
  scoped.threads.create({ id: threadId, workspaceId, engine: "codex", title: "大历史会话" });
  scoped.conversationEvents.appendEnvelope({ schema: 1, seq: 1, ts: 1, workspaceId, threadId,
    engine: "codex", type: "thread.started", payload: {} });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, scoped, dbPath, root, workspaceId, threadId, workspaceOperationGate };
}

test("持久删除标记立即隐藏会话，历史留给后台清理且不能同 ID 重建", t => {
  const f = fixture(t);
  const otherId = "untouched" as ThreadId;
  f.scoped.threads.create({ id: otherId, workspaceId: f.workspaceId, engine: "codex", title: "保留" });
  const task = f.scoped.threads.markDeleted(f.threadId, "delete-request");
  assert.equal(task.requestId, "delete-request");
  assert.equal(task.status, "queued");
  assert.equal(f.scoped.threads.get(f.threadId), null);
  assert.ok(f.scoped.threads.get(f.threadId, { includeDeleted: true }));
  assert.equal(f.scoped.conversationEvents.getLatestSeqByThread(f.threadId), 1);
  assert.deepEqual(f.scoped.threads.listByWorkspace(f.workspaceId).threads.map(thread => thread.id), [otherId]);
  assert.equal(f.scoped.threads.listByWorkspace(f.workspaceId, { search: "大历史" }).threads.length, 0);
  assert.equal(f.scoped.threads.isHistoryCleanupTargetEligible({ threadId: f.threadId,
    workspaceId: f.workspaceId, inactiveBefore: Date.now() + 1000 }), false);
  assert.throws(() => f.scoped.threads.create({ id: f.threadId, workspaceId: f.workspaceId,
    engine: "codex", title: "不能复活" }), /thread_deleted/);
});

test("删除任务跨连接保留原 requestId，失败和完成仍隐藏会话", t => {
  const f = fixture(t);
  f.scoped.threads.markDeleted(f.threadId, "original-request");
  const reopened = openClientDb({ dbPath: f.dbPath, localCanonicalEvents: true });
  try {
    const threads = reopened.forWorkspace(f.workspaceId).threads;
    assert.equal(threads.get(f.threadId), null);
    assert.deepEqual(threads.listQueuedDeletions().map(task => task.threadId), [f.threadId]);
    assert.equal(threads.markDeleted(f.threadId, "duplicate-request").requestId, "original-request");
    threads.setDeletionState(f.threadId, { status: "failed", phase: "raw_engine_events", error: "disk error" });
    assert.equal(threads.getDeletion(f.threadId)?.error, "disk error");
    assert.equal(threads.listQueuedDeletions().length, 0);
    assert.equal(threads.get(f.threadId), null);
  } finally { reopened.close(); }
});

/** 后台尾链使用真实 Promise，外部引擎只提供本测试不运行的资源边界。 */
function handlerFixture(t: test.TestContext) {
  const f = fixture(t);
  const tails: Promise<void>[] = [];
  const responses: any[] = [];
  let fenced = false;
  const ctx = { db: f.scoped, clientId: "delete-client", threads: new ThreadStore(),
    workspaces: new Map([[f.workspaceId, f.root]]),
    sessions: { beginThreadDeletion() {
      assert.equal(fenced, false); fenced = true;
      return () => { fenced = false; };
    }, async disposeThreadWithOptions() {} },
    orchEngine: { forWorkspace() { return this; }, async disposeManagedServicesForThread() {} },
    workspaceOperationGate: f.workspaceOperationGate,
    async flushLocalEvents() {},
    async flushEventPersistence() { throw new Error("删除不能排空其他会话"); },
    send(message: unknown) { responses.push(message); },
    trackApiTail(work: Promise<void>) { void work.then(undefined, () => undefined); tails.push(work); },
  } as unknown as ApiHandlerContext;
  const request: ApiRequestMessage = { t: "api.req", id: "delete-request", method: "threads.delete",
    path: "/test", body: { workspaceId: f.workspaceId, threadId: f.threadId } };
  return { ...f, ctx, request, tails, responses, get fenced() { return fenced; } };
}

test("删除确认先于历史清理，保留门禁直至被跟踪的物理删除完成", async t => {
  const f = handlerFixture(t);
  await handleThreadsDelete(f.ctx, f.request);
  assert.equal(f.responses.at(-1)?.status, 200);
  assert.equal(f.scoped.threads.get(f.threadId), null);
  assert.equal(f.scoped.conversationEvents.getLatestSeqByThread(f.threadId), 1, "响应不等待物理删除");
  assert.equal(f.fenced, true);
  assert.equal(f.tails.length, 1);
  await Promise.all(f.tails);
  assert.equal(f.fenced, false);
  assert.equal(f.scoped.threads.get(f.threadId, { includeDeleted: true }), null);
  assert.equal(f.scoped.threads.getDeletion(f.threadId)?.status, "completed");
  await handleThreadsDelete(f.ctx, f.request);
  assert.equal(f.responses.at(-1)?.status, 200, "已完成删除的重试幂等");
  assert.equal(f.tails.length, 1);
});

test("删除标记提交失败不隐藏会话、不启动清理", async t => {
  const f = handlerFixture(t);
  f.scoped.db.exec(`CREATE TRIGGER reject_deletion BEFORE INSERT ON meta
    WHEN NEW.key LIKE 'thread_deletion:%' BEGIN SELECT RAISE(ABORT, 'marker disk failure'); END`);
  await handleThreadsDelete(f.ctx, f.request);
  assert.equal(f.responses.at(-1)?.status, 500);
  assert.match(f.responses.at(-1)?.body.message ?? "", /marker disk failure/);
  assert.ok(f.scoped.threads.get(f.threadId));
  assert.equal(f.scoped.conversationEvents.getLatestSeqByThread(f.threadId), 1);
  assert.equal(f.tails.length, 0);
  assert.equal(f.fenced, false);
});

test("后台 SQL 失败记录原请求和失败阶段，停止后续删除且不复活", async t => {
  const f = handlerFixture(t);
  f.scoped.db.exec(`CREATE TRIGGER reject_event_delete BEFORE DELETE ON conversation_events
    BEGIN SELECT RAISE(ABORT, 'event disk failure'); END`);
  await handleThreadsDelete(f.ctx, f.request);
  assert.equal(f.responses.at(-1)?.status, 200);
  await assert.rejects(Promise.all(f.tails), /event disk failure/);
  const task = f.scoped.threads.getDeletion(f.threadId);
  assert.equal(task?.status, "failed");
  assert.equal(task?.phase, "conversation_events");
  assert.equal(task?.requestId, "delete-request");
  assert.match(task?.error ?? "", /event disk failure/);
  assert.equal(f.scoped.threads.get(f.threadId), null);
  assert.ok(f.scoped.threads.get(f.threadId, { includeDeleted: true }));
  assert.equal(f.fenced, false);
  await handleThreadsDelete(f.ctx, f.request);
  assert.equal(f.responses.at(-1)?.status, 500, "失败任务不得伪装清理成功");
});

test("删除确认后 relay 不再传输该会话历史并保存失效屏障", async t => {
  const f = handlerFixture(t);
  const scopeKey = f.scoped.conversationEvents.registerRelayScope("http://localhost:39280", {
    kind: "personal", userId: "user", enterpriseId: null, clientId: "delete-client", workspaceId: f.workspaceId,
  });
  assert.equal(f.scoped.conversationEvents.readRelayBatch(scopeKey).events.length, 1);
  await handleThreadsDelete(f.ctx, f.request);
  assert.equal(f.scoped.conversationEvents.readRelayBatch(scopeKey).events.length, 0);
  assert.ok(f.scoped.db.prepare("SELECT 1 FROM meta WHERE key LIKE 'conversation_relay:invalidation:%'").get());
  await Promise.all(f.tails);
});

test("重启恢复已提交删除，恢复入口不等待物理清理", async t => {
  const f = handlerFixture(t);
  f.scoped.threads.markDeleted(f.threadId, "before-crash");
  await resumeThreadDeletions(f.ctx);
  assert.equal(f.scoped.threads.get(f.threadId), null);
  assert.equal(f.scoped.conversationEvents.getLatestSeqByThread(f.threadId), 1);
  assert.equal(f.tails.length, 1);
  await Promise.all(f.tails);
  assert.equal(f.scoped.threads.getDeletion(f.threadId)?.status, "completed");
  assert.equal(f.scoped.threads.getDeletion(f.threadId)?.requestId, "before-crash");
});

test("事件排空失败保持会话可见，运行中的会话不能先隐藏", async t => {
  const f = handlerFixture(t);
  f.ctx.flushLocalEvents = async () => { throw new Error("target persistence failed"); };
  await handleThreadsDelete(f.ctx, f.request);
  assert.equal(f.responses.at(-1)?.status, 500);
  assert.ok(f.scoped.threads.get(f.threadId));
  assert.equal(f.scoped.threads.getDeletion(f.threadId), null);
  f.ctx.getActiveThreadTurn = () => ({ turnId: "running" as any, startedAt: Date.now(), source: "runtime" });
  await handleThreadsDelete(f.ctx, f.request);
  assert.equal(f.responses.at(-1)?.status, 409);
  assert.ok(f.scoped.threads.get(f.threadId));
  assert.equal(f.tails.length, 0);
});

test("后台清理登记工作区活动，迁移等待全部批次结束而不打断清理", async t => {
  const f = handlerFixture(t);
  await handleThreadsDelete(f.ctx, f.request);
  assert.ok(f.workspaceOperationGate.listActivities(f.workspaceId).some(item => item.resourceId === f.threadId));
  const migration = f.workspaceOperationGate.acquireMigration(f.workspaceId, "during-delete", { drainTimeoutMs: 10000 });
  await Promise.all(f.tails);
  const release = await migration;
  release();
  assert.equal(f.scoped.threads.getDeletion(f.threadId)?.status, "completed");
  assert.equal(f.workspaceOperationGate.listActivities(f.workspaceId).length, 0);
});

test("真实桌面入口重复删除 queued/completed 幂等，failed 保留真实错误", async t => {
  const f = handlerFixture(t);
  const call = () => executeDesktopApiRequest(f.ctx, { method: "threads.delete",
    body: { workspaceId: f.workspaceId, threadId: f.threadId } },
  { requestId: "desktop-delete", startedAt: 1, clientVersion: "test" });
  const first = await call();
  assert.equal(first.status, 200, JSON.stringify(first));
  const queued = await call();
  assert.equal(queued.status, 200, JSON.stringify(queued));
  await Promise.all(f.tails);
  assert.equal((await call()).status, 200);
  f.scoped.threads.setDeletionState(f.threadId, { status: "failed", phase: "finalize", error: "cleanup failed" });
  const failed = await call();
  assert.equal(failed.status, 500);
  assert.equal((failed.body as any).code, "thread_delete_cleanup_failed");
});

test("共享删除重试不把失败任务伪装为 alreadyAbsent 成功", async t => {
  const f = handlerFixture(t);
  f.scoped.db.prepare("UPDATE threads SET shared_workspace_id = ?, owner_user_id = ? WHERE id = ?")
    .run("shared", "owner", f.threadId);
  f.scoped.threads.markDeleted(f.threadId, "original-shared-delete");
  f.scoped.threads.setDeletionState(f.threadId, { status: "failed", phase: "raw_engine_events", error: "shared disk failure" });
  const operationKey = "context.thread.delete";
  const payload = { threadId: f.threadId };
  const envelope = { operationId: "shared-retry", routeEventId: "shared-retry", localWorkspaceId: f.workspaceId,
    sharedWorkspaceId: "shared", actorUserId: "owner", hostUserId: "owner", hostBindingId: "binding", actorRemoteSessionId: null,
    operationKey, policy: resolveSharedWorkspaceEffectiveOperationPolicy(operationKey, payload),
    authorization: { actorAssetRole: "workspace_admin", authorizationResult: "allowed", authorizationReason: "test",
      assetType: "unknown", assetId: "", assetAction: "delete" }, lockToken: "lock", lockVersion: 1, payload, createdAt: 1,
  } as SharedWorkspaceCommandEnvelope;
  await handleSharedWorkspaceCommand(f.ctx, envelope);
  const result = f.responses.find(message => message.t === "sharedWorkspace.route.result")?.message;
  assert.equal(result?.status, "failed");
  assert.equal(result?.result, undefined);
  assert.equal(f.scoped.threads.getDeletion(f.threadId)?.status, "failed");
});

test("删除日志关联原请求，区分确认等待与各表物理清理耗时", async t => {
  const f = handlerFixture(t);
  const records: Record<string, any>[] = [];
  t.mock.method(logger, "info", (...args: Parameters<typeof logger.info>) => { records.push(args[2] ?? {}); });
  await handleThreadsDelete(f.ctx, f.request);
  await Promise.all(f.tails);
  const confirmed = records.find(record => record.code === "THREAD_DELETE_CONFIRMED");
  assert.ok(confirmed);
  for (const field of ["durationMs", "flushBeforeMs", "disposeMs", "flushAfterMs", "markDeletedMs"]) {
    assert.equal(typeof confirmed[field], "number", field);
    assert.ok(confirmed[field] >= 0, field);
  }
  assert.deepEqual(records.filter(record => record.code === "THREAD_DELETE_PHASE_COMPLETED").map(record => record.phase),
    ["conversation_events", "raw_engine_events"]);
  const completed = records.find(record => record.code === "THREAD_DELETE_COMPLETED");
  assert.equal(completed?.deletedRows, 1);
  for (const record of records.filter(record => record.code?.startsWith("THREAD_DELETE_"))) {
    assert.equal(record.requestId, "delete-request");
    assert.equal(record.threadId, f.threadId);
    assert.equal(record.workspaceId, f.workspaceId);
  }
});
