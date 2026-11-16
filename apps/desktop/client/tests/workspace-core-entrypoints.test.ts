import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientToServerMessage, DesktopApiRequest, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.js";
import { ThreadStore } from "../src/threads/threadStore.js";

/** 两个真实工作区复用相同会话主键，入口必须从已承载的工作区选择仓储。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-entrypoints-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const ids = ["entry-client:first", "entry-client:second"] as WorkspaceId[];
  const workspaces = new Map<WorkspaceId, string>();
  for (const id of ids) {
    const directory = path.join(root, id.split(":")[1]!);
    fs.mkdirSync(directory);
    workspaces.set(id, directory);
    db.workspaces.upsert({ id, title: id, path: directory });
  }
  initializeLocalEngineModelCatalog();
  const sent: ClientToServerMessage[] = [];
  const ctx = { db, clientId: "entry-client", workspaces, threads: new ThreadStore(),
    sessions: { beginThreadOperation: () => () => {}, hasActiveTurn: () => false },
    send: (message: ClientToServerMessage) => { sent.push(message); } } as unknown as ApiHandlerContext;
  t.after(() => { resetEngineModelCatalogRuntimeForTest(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let sequence = 0;
  return { db, ctx, sent, ids,
    /** 复用真实桌面适配器与中央处理器，不连接 provider。 */
    call(method: string, body: Record<string, unknown>) {
      return executeDesktopApiRequest(ctx, { method, body } as DesktopApiRequest,
        { requestId: `entry-${++sequence}`, startedAt: 1, clientVersion: "1.0.0" });
    },
  };
}

test("桌面创建、偏好、回放与同名会话请求只访问选定工作区", async t => {
  const f = fixture(t), workspaceId = f.ids[0]!, otherId = f.ids[1]!;
  const created = await f.call("threads.create", { workspaceId, title: "初始", engine: "codex" });
  assert.equal(created.status, 200, JSON.stringify(created));
  const threadId = (created.body as { threadId: ThreadId }).threadId;
  assert.equal(f.db.forWorkspace(workspaceId).threads.get(threadId)?.title, "初始");
  assert.equal(f.db.db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId), undefined);
  f.db.forWorkspace(otherId).threads.create({ id: threadId, workspaceId: otherId, title: "另一工作区", engine: "codex" });
  assert.equal((await f.call("threads.rename", { workspaceId, threadId, title: "更新后" })).status, 200);
  assert.equal((await f.call("threads.updatePrefs", { workspaceId, threadId, prefs: { planMode: true } })).status, 200);
  assert.equal(f.db.forWorkspace(otherId).threads.get(threadId)?.title, "另一工作区");
  assert.equal(f.db.forWorkspace(workspaceId).threads.get(threadId)?.planMode, true);
  const loaded = await f.call("threads.load", { workspaceId, threadId });
  assert.equal(loaded.status, 200, JSON.stringify(loaded));
  assert.equal((await f.call("threads.rename", { workspaceId: "entry-client:unknown", threadId, title: "拒绝" })).status, 404);
});

test("中央请求按可信承载工作区隔离同名会话", async t => {
  const f = fixture(t), threadId = "same-thread" as ThreadId;
  for (const workspaceId of f.ids) f.db.forWorkspace(workspaceId).threads.create({ id: threadId, workspaceId, engine: "codex", title: workspaceId });
  await handleApiRequest(f.ctx, { t: "api.req", id: "scoped-rename", method: "threads.rename", path: "/test",
    body: { workspaceId: f.ids[1], threadId, title: "第二个被修改" } });
  const response = f.sent.find(message => message.t === "api.res") as Extract<ClientToServerMessage, { t: "api.res" }>;
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(f.db.forWorkspace(f.ids[0]!).threads.get(threadId)?.title, f.ids[0]);
  assert.equal(f.db.forWorkspace(f.ids[1]!).threads.get(threadId)?.title, "第二个被修改");
});

test("中央请求规范化工作区空白后仅向选定W写入需求", async t => {
  const f = fixture(t), workspaceId = f.ids[1]!;
  await handleApiRequest(f.ctx, { t: "api.req", id: "trimmed-workspace-intake", method: "orch.intakes.create", path: "/test",
    body: { workspaceId: ` \t${workspaceId}\n `, intake: { title: "隔离需求" } } });
  const response = f.sent.find(message => message.t === "api.res") as Extract<ClientToServerMessage, { t: "api.res" }>;
  assert.equal(response.status, 200, JSON.stringify(response));
  const intakeId = (response.body as { intake: { id: string } }).intake.id;
  assert.equal(f.db.forWorkspace(workspaceId).orchIntakes.get(intakeId as any)?.title, "隔离需求");
  assert.equal(f.db.forWorkspace(f.ids[0]!).orchIntakes.get(intakeId as any), null);
  assert.equal(f.db.orchIntakes.get(intakeId as any), null);
});

test("工作区队列 ACK 屏障与消费指针失败时同事务回滚", async t => {
  const f = fixture(t), workspaceId = f.ids[0]!, threadId = "same-thread" as ThreadId;
  const scoped = f.db.forWorkspace(workspaceId);
  scoped.threads.create({ id: threadId, workspaceId, engine: "codex", title: "ACK" });
  const item = scoped.threadMessageQueue.appendItem({ threadId, workspaceId, text: "一次输入", images: [], files: [], originWebSessionId: null,
    sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null } }).item;
  const claim = scoped.threadMessageQueue.claimNextPendingForDispatch(threadId);
  assert.equal(claim?.kind, "claimed");
  if (claim?.kind !== "claimed") return;
  const code = "orchestration_feedback_post_ack_failed";
  assert.equal(scoped.threadMessageQueue.markPostAckPending(item.id, code, "待收尾", null, claim.item.attemptCount), true);
  const dispatcher = new ThreadQueueDispatcher(f.ctx).forWorkspace(workspaceId);
  t.mock.method(scoped.threadQueueStates, "setLastConsumed", () => { throw new Error("injected-pointer-failure"); });
  await assert.rejects(dispatcher.retryAcknowledgedFinalization(threadId, item.id));
  assert.equal(scoped.threadMessageQueue.getById(item.id)?.status, "failed");
  assert.equal(scoped.threadMessageQueue.getById(item.id)?.failureCode, code);
  assert.equal(scoped.threadQueueStates.getState(threadId).lastConsumedQueueId, null);
});

test("队列终态在消费指针失败时保留 turn 与队列认领且不发送完成通知", t => {
  const f = fixture(t), workspaceId = f.ids[0]!, threadId = "terminal-thread" as ThreadId;
  const scoped = f.db.forWorkspace(workspaceId);
  scoped.threads.create({ id: threadId, workspaceId, engine: "codex", title: "终态" });
  const turnId = "terminal-turn" as any;
  scoped.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: null });
  const turnBefore = scoped.turns.get(turnId);
  const item = scoped.threadMessageQueue.appendItem({ threadId, workspaceId, text: "输入", images: [], files: [], originWebSessionId: null,
    sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null } }).item;
  scoped.threadMessageQueue.claimNextPendingForDispatch(threadId);
  const dispatcher = new ThreadQueueDispatcher(f.ctx).forWorkspace(workspaceId);
  t.mock.method(scoped.threadQueueStates, "setLastConsumed", () => { throw new Error("injected-terminal-pointer-failure"); });
  assert.throws(() => dispatcher.notifyTurnTerminal({ workspaceId, threadId, turnId, source: "queue_consume", queueItemId: item.id, outcome: "completed" }));
  assert.deepEqual(scoped.turns.get(turnId), turnBefore);
  assert.equal(scoped.threadMessageQueue.getById(item.id)?.status, "sending");
  assert.equal(f.sent.some(message => message.t === "thread.queue.changed"), false);
});

test("根队列入口拒绝没有工作区的裸会话 ID", t => {
  const f = fixture(t), dispatcher = new ThreadQueueDispatcher(f.ctx);
  assert.throws(() => dispatcher.kickIfIdle("same-thread" as ThreadId), /QUEUE_WORKSPACE_SCOPE_REQUIRED/);
  assert.throws(() => dispatcher.forWorkspace("entry-client:unknown" as WorkspaceId), /QUEUE_WORKSPACE_NOT_HOSTED/);
});
