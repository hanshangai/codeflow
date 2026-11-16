import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { handleApiRequest, isWorkspaceApiRequestFailure, getWorkspaceApiRequestFailureDetails, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { waitForOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.js";
import { openClientDb } from "../src/db/clientDb.js";
import { createLocalEventPersistence } from "../src/runtime/localEventPersistence.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { logger } from "../src/logger.js";
import { RequirementAnalysisService } from "../src/orchestration/requirementAnalysisService.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";

/** 精确provider边界用于验证API受理后的完整原owner。 */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 真实W库和事件持久化，仅provider和通知可控。 */
function fixture(t: test.TestContext) {
  initializeLocalEngineModelCatalog();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-ordinary-log-"));
  const directory = path.join(root, "workspace"); fs.mkdirSync(directory);
  const app = openClientDb({ dbPath: path.join(root, "app.db"), localCanonicalEvents: true });
  const scope = { workspaceId: `ordinary:${path.basename(root)}` as WorkspaceId, threadId: "thread" as ThreadId, turnId: "turn" as TurnId };
  app.workspaces.upsert({ id: scope.workspaceId, title: "普通会话", path: directory });
  const db = app.forWorkspace(scope.workspaceId), threads = new ThreadStore();
  db.threads.create({ id: scope.threadId, workspaceId: scope.workspaceId, engine: "claude", title: "普通", threadType: "orchestration", threadSubtype: "node-discussion" });
  const entered = deferred<void>(), sending = deferred<{ responseText: string }>();
  const session = { engine: "claude", resolvePlatformToolTransport: () => "none", hasActiveTurn: () => false,
    async sendMessage() { entered.resolve(); return sending.promise; },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; } };
  let operations = 0;
  const sessions = { hasActiveTurn: () => false, getActiveTurnId: () => null, getOrCreate: () => session,
    beginThreadOperation() { operations++; return () => { operations--; }; } };
  const persistence = createLocalEventPersistence({ db, applyRaw() {}, applyConversation(event) {
    if (event.type === "turn.started") db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
      turnId: event.payload.turnId, startedAt: event.ts, startEventSeq: event.seq });
    if (event.type === "turn.completed" || event.type === "turn.error") db.turns.setEnded(event.payload.turnId!, {
      status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: event.seq });
  } });
  const responses: any[] = [];
  const ctx = { db, threads, sessions, clientId: "ordinary-client", workspaces: new Map([[scope.workspaceId, directory]]),
    orchEngine: { forWorkspace() { return this; }, buildManagedServiceToolRegistry: () => null },
    send(message: unknown) { responses.push(message); }, onBeforeEmitConversationEvent(event: any) { persistence.persist({ t: "conversation.event", event }); },
  } as unknown as ApiHandlerContext;
  t.after(() => { app.close(); resetEngineModelCatalogRuntimeForTest(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, ctx, scope, sending, entered, session, sessions, responses, operations: () => operations,
    request() { return handleApiRequest(ctx, { t: "api.req", id: "ordinary-log-request", method: "threads.sendMessage", path: "/send",
      body: { ...scope, text: "普通回合", model: "claude-sonnet-4-6", effort: "medium" } }); },
    wait() { return waitForOrdinaryTurnExecution(sessions, scope); },
    logs() { return fs.readdirSync(path.join(directory, ".codeflowai")).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(directory, ".codeflowai", name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); },
  };
}

test("本机发送校验与相邻受理事件复用短连接，ACK不等待provider完成", async t => {
  const f = fixture(t);
  f.ctx.clientId = "ordinary";
  f.db.db.prepare("UPDATE threads SET thread_type='chat',thread_subtype=NULL WHERE id=?").run(f.scope.threadId);
  const prototype = Object.getPrototypeOf(f.db.applicationDb), close = prototype.close;
  let closes = 0;
  t.mock.method(prototype, "close", function (this: typeof f.db.applicationDb) { closes++; return close.call(this); });
  const result = await executeDesktopApiRequest(f.ctx, { method: "threads.sendMessage", body: {
    ...f.scope, text: "本机发送", model: "claude-sonnet-4-6", effort: "medium",
  } }, { requestId: "desktop-acceptance", clientVersion: "test", startedAt: 1 });
  const acceptanceCloses = closes;
  f.sending.resolve({ responseText: "done" });
  await f.wait();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.ok(acceptanceCloses <= 12, `受理前连接开关过多：${acceptanceCloses}`);
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "completed");
});

test("普通provider失败只落所属W，owner保持原拒绝值且200不重发", async t => {
  const f = fixture(t), business = new Error("PRIVATE_PROVIDER_CONTEXT"), appLog = t.mock.method(logger, "error", () => {});
  await f.request(); await f.entered.promise;
  const rejected = assert.rejects(f.wait(), error => error === business); f.sending.reject(business); await rejected;
  assert.equal(f.logs().length, 1); assert.equal(f.logs()[0].requestId, "ordinary-log-request");
  assert.equal(f.logs()[0].workspaceId, f.scope.workspaceId); assert.equal(appLog.mock.callCount(), 0);
  assert.equal(JSON.stringify(f.logs()).includes("PRIVATE_PROVIDER_CONTEXT"), false);
  assert.equal(f.responses.filter(message => message.t === "api.res").length, 1); assert.equal(f.operations(), 0);
});

test("普通provider和W日志双错保falsy首因，停止终态副作用并交原owner", async t => {
  const f = fixture(t), business = false, logging = null;
  await f.request(); await f.entered.promise;
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  const rejected = assert.rejects(f.wait(), error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.deepEqual(error.errors, [business, logging]); return true;
  }); f.sending.reject(business); await rejected;
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "started");
  assert.equal(f.responses.filter(message => message.t === "api.res").length, 1); assert.equal(f.operations(), 0);
});

test("普通终态已提交后通知及W诊断双错保因，不重新改写业务终态", async t => {
  const f = fixture(t), notification = new Error("queue notification"), logging = false;
  f.ctx.queueDispatcher = { notifyTurnTerminal() { throw notification; } } as any;
  await f.request(); await f.entered.promise;
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  const rejected = assert.rejects(f.wait(), error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.deepEqual(error.errors, [notification, logging]); return true;
  }); f.sending.resolve({ responseText: "已完成" }); await rejected;
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "completed");
  assert.equal(f.responses.filter(message => message.t === "api.res").length, 1); assert.equal(f.operations(), 0);
});

test("普通准备与W诊断双错必须拒绝请求和owner，不能无响应伪完成", async t => {
  const f = fixture(t), business = new Error("session preparation"), logging = undefined;
  f.sessions.getOrCreate = () => { throw business; };
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  const failure = (error: unknown) => isWorkspaceApiRequestFailure(error) && error.errors[0] === business && error.errors[1] === logging;
  const result = await f.request().then(() => ({ ok: true } as const), error => ({ ok: false, error } as const));
  assert.equal(result.ok, false, JSON.stringify(f.responses));
  assert.ok(!result.ok && failure(result.error)); await assert.rejects(f.wait(), failure);
  assert.equal(f.responses.filter(message => message.t === "api.res" && message.status === 200).length, 0);
  assert.equal(f.operations(), 0);
});

test("需求分析业务完成后队列通知失败只通知一次，由原回合owner返回失败", async t => {
  const f = fixture(t), notification = new Error("analysis terminal notification"), started = deferred<void>(), complete = deferred<void>();
  f.db.db.prepare("UPDATE threads SET thread_type = 'chat', thread_subtype = 'requirement-analysis' WHERE id = ?").run(f.scope.threadId);
  t.mock.method(RequirementAnalysisService.prototype, "sendMessage", async () => { started.resolve(); await complete.promise; return { responseText: "done" }; });
  let notifications = 0;
  f.ctx.queueDispatcher = { notifyTurnTerminal() { notifications++; throw notification; } } as any;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([f.request(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`RA_REQUEST_NOT_SETTLED:${JSON.stringify(f.responses)}`)), 2_000); })]);
  } finally { if (timeout) clearTimeout(timeout); }
  assert.equal(f.responses.find(message => message.t === "api.res")?.status, 200);
  assert.equal(notifications, 0);
  try { await Promise.race([started.promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`RA_SERVICE_NOT_STARTED:${JSON.stringify(f.responses)}`)), 2_000); })]); }
  finally { if (timeout) clearTimeout(timeout); }
  const rejected = assert.rejects(f.wait(), error => error === notification); complete.resolve(); await rejected;
  assert.equal(notifications, 1); assert.equal(f.operations(), 0);
});

test("压缩已受理后的provider失败保留原owner且不吞异常", async t => {
  const f = fixture(t), business = new Error("compact provider failed"), started = deferred<void>(), complete = deferred<void>();
  f.db.db.prepare("UPDATE threads SET engine = 'codex' WHERE id = ?").run(f.scope.threadId);
  Object.assign(f.session, { engine: "codex", async compactThread() { started.resolve(); await complete.promise; throw business; } });
  await handleApiRequest(f.ctx, { t: "api.req", id: "compact", method: "threads.compact", path: "/compact", body: { ...f.scope } });
  await started.promise; const rejected = assert.rejects(f.wait(), error => error === business); complete.resolve(); await rejected;
  assert.equal(f.operations(), 0); assert.equal(f.db.turns.get(f.scope.turnId)?.status, "error");
});

test("压缩provider与W诊断双错保真实请求方法和已受理事实", async t => {
  const f = fixture(t), business = false, logging = null, started = deferred<void>(), complete = deferred<void>();
  f.db.db.prepare("UPDATE threads SET engine = 'codex' WHERE id = ?").run(f.scope.threadId);
  Object.assign(f.session, { engine: "codex", async compactThread() { started.resolve(); await complete.promise; throw business; } });
  await handleApiRequest(f.ctx, { t: "api.req", id: "compact-log", method: "threads.compact", path: "/compact", body: { ...f.scope } });
  await started.promise; t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  const rejected = assert.rejects(f.wait(), error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.deepEqual(error.errors, [business, logging]);
    const details = getWorkspaceApiRequestFailureDetails(error)!;
    assert.equal(details.method, "threads.compact"); assert.equal(details.requestId, "compact-log");
    assert.equal(details.responseDelivered, true); return true;
  }); complete.resolve(); await rejected;
  assert.equal(f.operations(), 0); assert.equal(f.db.turns.get(f.scope.turnId)?.status, "started");
});
