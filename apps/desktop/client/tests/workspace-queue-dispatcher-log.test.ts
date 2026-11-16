import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { isWorkspaceApiRequestFailure, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { QueueChangeNotificationError } from "../src/app/handleThreadQueueRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.js";
import { logger } from "../src/logger.js";

const OPTIONS = { workMode: "general" as const, planMode: false, accessMode: null, model: null, effort: null,
  contextWindow: null, autoCompactPct: null, serviceTier: null, forceNewTurn: false };

/** 真实W状态、ACK屏障和日志配合可控provider；同名主键不依赖应用库反查。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-dispatcher-log-"));
  const app = openClientDb({ dbPath: path.join(root, "app.db") });
  const workspaceId = "queue:workspace" as WorkspaceId, threadId = "same-thread" as ThreadId, turnId = "turn" as TurnId;
  const directory = path.join(root, "workspace"); fs.mkdirSync(directory);
  app.workspaces.upsert({ id: workspaceId, title: "queue", path: directory });
  const db = app.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "queue" });
  db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: 1 });
  const messages: any[] = [], calls = { business: 0 };
  const ctx = { db, workspaces: new Map([[workspaceId, directory]]),
    sessions: { hasActiveTurn: () => true, canAppendInput: () => true,
      async appendInput() { calls.business++; return { engineCall: null }; } },
    getActiveThreadTurn: () => ({ turnId, execution: OPTIONS }),
    send(message: unknown) { messages.push(message); },
  } as unknown as ApiHandlerContext;
  const dispatcher = new ThreadQueueDispatcher(ctx);
  t.after(() => {
    for (const timer of (dispatcher as any).scheduledKickTimers.values()) clearTimeout(timer);
    app.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, db, ctx, dispatcher, workspaceId, threadId, turnId, directory, messages, calls,
    /** 持久队列项与实际消费入口使用同一W仓储。 */
    append() { return db.threadMessageQueue.appendItem({ workspaceId, threadId, text: "input", images: [], files: [],
      pathReferences: [], sendOptions: OPTIONS, clientItemId: "stable" }).item; },
    /** 读取固定W文件，不以应用logger替代实际writer。 */
    logs() { return fs.readdirSync(path.join(directory, ".codeflowai")).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(directory, ".codeflowai", name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); },
  };
}

test("调度诊断只写所属W，原应用logger不接收副本", t => {
  const f = fixture(t), appLog = t.mock.method(logger, "info", () => {});
  f.append(); f.dispatcher.kickIfIdle(f.threadId);
  assert.equal(f.logs().length, 1); assert.equal(f.logs()[0].workspaceId, f.workspaceId);
  assert.equal(appLog.mock.callCount(), 0); assert.equal(f.calls.business, 0);
});

test("claim后的W日志失败停止业务并释放运行占用，队列不被伪消费", t => {
  const f = fixture(t), logging = false; f.append();
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  assert.throws(() => f.dispatcher.kickAtActiveTurnBoundary(f.threadId), error => isWorkspaceApiRequestFailure(error) && error.errors[0] === logging);
  assert.equal(f.calls.business, 0); assert.equal(f.dispatcher.hasInFlightWork(), false);
  assert.notEqual(f.db.threadMessageQueue.listActiveByThread(f.threadId)[0]?.status, "sent");
});

test("ACK后诊断失败保留sent与消费指针，原在途结果由等待入口显式消费", async t => {
  const f = fixture(t), logging = new Error("workspace logger unavailable"), item = f.append();
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", (workspaceId, entry) => {
    if (entry.message === "active turn queue append acknowledged") throw logging;
    write(workspaceId, entry);
  });
  assert.equal(typeof (f.dispatcher as any).waitForIdle, "function");
  f.dispatcher.kickAtActiveTurnBoundary(f.threadId);
  const result = await f.dispatcher.waitForIdle().then(() => ({ ok: true } as const), error => ({ ok: false, error } as const));
  assert.equal(f.calls.business, 1, JSON.stringify(f.logs()));
  assert.equal(result.ok, false, "日志失败必须沿原等待入口拒绝");
  assert.ok(!result.ok && isWorkspaceApiRequestFailure(result.error) && result.error.errors[0] === logging);
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "sent");
  assert.equal(f.db.threadQueueStates.getState(f.threadId).lastConsumedQueueId, item.id);
  assert.equal(f.calls.business, 1); assert.equal(f.dispatcher.hasInFlightWork(), false);
  assert.equal(f.messages.filter(message => message.t === "thread.queue.changed" && message.reason === "failed").length, 0);
});

test("ACK后的通知与W日志双错不再进入业务失败收尾", async t => {
  const f = fixture(t), logging = null, notification = new Error("closed"), item = f.append();
  const write = f.db.writeWorkspaceLog.bind(f.db);
  f.ctx.send = message => { if (message.t === "thread.queue.changed" && message.reason === "consumed") throw notification; };
  t.mock.method(f.db, "writeWorkspaceLog", (workspaceId, entry) => {
    if (entry.message === "thread queue change notification failed") throw logging;
    write(workspaceId, entry);
  });
  f.db.threadMessageQueue.claimNextPendingForDispatch(f.threadId);
  await assert.rejects((f.dispatcher as any).executeActiveTurnAppend(f.db.threadMessageQueue.getById(item.id), f.workspaceId, f.threadId, f.turnId), error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.equal(error.errors[1], logging);
    assert.ok(error.errors[0] instanceof QueueChangeNotificationError); assert.equal(error.errors[0].cause, notification); return true;
  });
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "sent");
  assert.equal(f.db.threadQueueStates.getState(f.threadId).lastConsumedQueueId, item.id);
  assert.equal(f.calls.business, 1);
});

test("定时kick的诊断失败存入原在途结果并通知最终owner", async t => {
  const f = fixture(t), logging = false;
  assert.equal(typeof (f.dispatcher as any).waitForIdle, "function");
  let notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  const dispatcher = new ThreadQueueDispatcher(f.ctx, undefined, (workspaceId, threadId) => {
    assert.equal(workspaceId, f.workspaceId); assert.equal(threadId, f.threadId); notify();
  });
  f.append(); t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  (dispatcher as any).scheduleKickIfIdle(f.threadId);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([notified, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("QUEUE_OWNER_NOT_NOTIFIED")), 2_000); })]); }
  finally { if (timeout) clearTimeout(timeout); }
  assert.equal(dispatcher.hasInFlightWork(), true);
  assert.throws(() => dispatcher.assertNoFailure(), error => isWorkspaceApiRequestFailure(error) && error.errors[0] === logging);
  assert.equal(dispatcher.hasInFlightWork(), true);
  await assert.rejects(dispatcher.waitForIdle(), error => isWorkspaceApiRequestFailure(error) && error.errors[0] === logging);
  assert.doesNotThrow(() => dispatcher.assertNoFailure());
  assert.equal(dispatcher.hasInFlightWork(), false); assert.equal(f.calls.business, 0);
});

test("业务与W诊断双错保留falsy首因，多个在途等待者都观察原失败", async t => {
  const f = fixture(t), business = false, logging = undefined, item = f.append();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.ctx.sessions.appendInput = async () => { f.calls.business++; await wait; throw business; };
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", (workspaceId, entry) => {
    if (entry.message === "active turn queue append failed") throw logging;
    write(workspaceId, entry);
  });
  f.dispatcher.kickAtActiveTurnBoundary(f.threadId);
  const results = [f.dispatcher.waitForIdle(), f.dispatcher.waitForIdle()]; release();
  for (const result of results) await assert.rejects(result, error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.deepEqual(error.errors, [business, logging]);
    assert.equal(error.cause, business); return true;
  });
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "failed");
  assert.equal(f.dispatcher.hasInFlightWork(), false); assert.equal(f.calls.business, 1);
});

test("投递前诊断失败退回原attempt认领，不遗留sending或重复调用provider", async t => {
  const f = fixture(t), logging = false, item = f.append(), write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", (workspaceId, entry) => {
    if (entry.message === "active turn queue append started") throw logging;
    write(workspaceId, entry);
  });
  f.dispatcher.kickAtActiveTurnBoundary(f.threadId);
  await assert.rejects(f.dispatcher.waitForIdle(), error => isWorkspaceApiRequestFailure(error) && error.errors[0] === logging);
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "pending");
  assert.equal(f.db.threadQueueStates.getState(f.threadId).pausedReason, "send_failed");
  assert.equal(f.calls.business, 0); assert.equal(f.dispatcher.hasInFlightWork(), false);
});
