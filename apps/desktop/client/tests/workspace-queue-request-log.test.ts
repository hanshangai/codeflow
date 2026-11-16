import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientToServerMessage, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { emitQueueChanged, onThreadQueueAppend, QueueChangeNotificationError } from "../src/app/handleThreadQueueRequest.js";
import { isWorkspaceApiRequestFailure, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { logger } from "../src/logger.js";

/** 实际W库与原队列handler共享可信身份，只替换外部传输。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-queue-log-"));
  const app = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaceId = "queue-log:workspace" as WorkspaceId, threadId = "thread" as ThreadId;
  const workspacePath = path.join(root, "workspace"); fs.mkdirSync(workspacePath);
  app.workspaces.upsert({ id: workspaceId, title: "queue", path: workspacePath });
  const db = app.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "会话" });
  const sent: ClientToServerMessage[] = [];
  const ctx = { db, workspaces: new Map([[workspaceId, workspacePath]]), sessions: { hasActiveTurn: () => false },
    send(message: ClientToServerMessage) { sent.push(message); } } as unknown as ApiHandlerContext;
  t.after(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ctx, db, workspaceId, threadId, sent,
    /** 读取实际固定日志，应用logger不充当工作区writer替身。 */
    rows() { return fs.readdirSync(path.join(workspacePath, ".codeflowai")).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(workspacePath, ".codeflowai", name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); },
  };
}

test("队列通知失败只写所属W并保原拒绝值，暂停后显式失败", t => {
  const f = fixture(t), rejection = { accepted: false, reason: "closed" }, appLog = t.mock.method(logger, "error", () => {});
  f.ctx.send = () => rejection as any;
  assert.throws(() => emitQueueChanged(f.ctx, f.workspaceId, f.threadId, "appended", { requestId: "notify" }), error => {
    assert.ok(error instanceof QueueChangeNotificationError); assert.equal(error.isolated, true); assert.equal(error.cause, rejection); return true;
  });
  assert.equal(f.db.threadQueueStates.getState(f.threadId).pausedReason, "send_failed");
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].requestId, "notify");
  assert.equal(appLog.mock.callCount(), 0);
});

test("通知隔离后W诊断再失败保双因，不能伪装成可吞的isolated异常", t => {
  const f = fixture(t), business = new Error("notification"), logging = false;
  f.ctx.send = () => { throw business; };
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  assert.throws(() => emitQueueChanged(f.ctx, f.workspaceId, f.threadId, "appended"), error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.ok(error.errors[0] instanceof QueueChangeNotificationError);
    assert.equal(error.errors[0].cause, business); assert.equal(error.errors[1], logging); return true;
  });
  assert.equal(f.db.threadQueueStates.getState(f.threadId).paused, true);
});

test("入队已提交后的W日志失败停止kick和200，重试不重复追加", async t => {
  const f = fixture(t), logging = new Error("log unavailable"); let kicks = 0;
  f.ctx.queueDispatcher = { kickIfIdle() { kicks++; } } as any;
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  const request = { t: "api.req" as const, id: "append", method: "threads.queue.append", path: "/queue", body: {
    workspaceId: f.workspaceId, threadId: f.threadId, text: "保留已提交", clientItemId: "stable",
    sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null } } };
  await assert.rejects(onThreadQueueAppend(f.ctx, request), error => isWorkspaceApiRequestFailure(error) && error.errors[0] === logging);
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
  assert.equal(kicks, 0); assert.equal(f.sent.filter(message => message.t === "api.res").length, 0);
  t.mock.restoreAll();
  await onThreadQueueAppend(f.ctx, request);
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
});
