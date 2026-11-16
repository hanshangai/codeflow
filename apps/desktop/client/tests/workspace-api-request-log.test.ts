import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientToServerMessage, WorkspaceId } from "@codeflowai/shared";
import { handleApiRequest, WorkspaceApiRequestFailure, isWorkspaceApiRequestFailure, getWorkspaceApiRequestFailureDetails,
  type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { logger } from "../src/logger.js";
import { createEngineWorkspaceLogFailure } from "../src/engines/threadSession.js";
import { createConversationEventAckBuffer } from "../src/diagnostics/conversationEventAckBuffer.js";
import { ThreadStore } from "../src/threads/threadStore.js";

/** 两个真实物理工作区共享原请求入口；响应和日志都不接外部传输。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-api-log-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaceId = "api-log:first" as WorkspaceId, otherId = "api-log:second" as WorkspaceId;
  const workspaces = new Map<WorkspaceId, string>();
  for (const id of [workspaceId, otherId]) {
    const directory = path.join(root, id.split(":")[1]!);
    fs.mkdirSync(directory); workspaces.set(id, directory);
    db.workspaces.upsert({ id, title: id, path: directory });
    db.forWorkspace(id);
  }
  const sent: ClientToServerMessage[] = [];
  const ctx = { db, clientId: "api-log", workspaces, sessions: { beginThreadOperation: () => () => {} },
    send(message: ClientToServerMessage) { sent.push(message); } } as unknown as ApiHandlerContext;
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, ctx, workspaceId, otherId, sent,
    call(method = "orch.roles.list", body: Record<string, unknown> = { workspaceId }) {
      return handleApiRequest(ctx, { t: "api.req", id: "request-log", method, path: "/test", body } as ApiRequestMessage);
    },
    rows(id = workspaceId) {
      const directory = path.join(workspaces.get(id)!, ".codeflowai");
      return fs.readdirSync(directory).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name))
        .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    },
  };
}

/** 真实ACK失败记录用于验证原显式恢复入口，不改变线程权限或运行态校验。 */
function persistenceFixture(t: test.TestContext) {
  const f = fixture(t), threadId = "persistence-thread", db = f.db.forWorkspace(f.workspaceId);
  db.threads.create({ id: threadId, workspaceId: f.workspaceId, title: "恢复", engine: "claude" });
  const original = new Error("ACK_PERSISTENCE_FAILED");
  const batch = t.mock.method(db.conversationEvents, "appendEnvelopes", () => { throw original; });
  const buffer = createConversationEventAckBuffer(f.db, { flushDelayMs: 60_000 });
  buffer.enqueue({ schema: 1, seq: 1, ts: 1, workspaceId: f.workspaceId, threadId, engine: "claude", type: "system.notice", payload: { level: "info", text: "持久化证据" } });
  assert.throws(() => buffer.flush(), error => (error as Error).cause === original);
  let flushes = 0, checks = 0;
  f.ctx.assertWorkspacePersistenceAvailable = workspaceId => { checks++; buffer.assertNoFailure(workspaceId); };
  f.ctx.flushRollbackEvidence = f.ctx.flushEventPersistence = () => { flushes++; buffer.flush(); };
  f.ctx.threads = new ThreadStore();
  f.ctx.sessions = { beginThreadOperation: () => () => {}, beginThreadDeletion: () => () => {},
    async disposeThreadWithOptions() {}, hasActiveTurn: () => false, getActiveTurnId: () => null } as any;
  f.ctx.orchEngine = { forWorkspace() { return this; }, async disposeManagedServicesForThread() {} } as any;
  return { ...f, db, threadId, batch, buffer, flushes: () => flushes, checks: () => checks,
    cleanup() { t.mock.restoreAll(); buffer.dispose(); } };
}

test("中央API失败仅写已核W诊断，异W与应用不重复记录", async t => {
  const f = fixture(t), business = Object.assign(new Error("private provider body"), { code: "INJECTED_READ_FAILURE" });
  const app = t.mock.method(logger, "error", () => {});
  t.mock.method(f.db.forWorkspace(f.workspaceId).orchRoles, "listByWorkspace", () => { throw business; });
  await f.call();
  assert.equal((f.sent[0] as any).status, 500);
  const rows = f.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, "request-log"); assert.equal(rows[0].workspaceId, f.workspaceId);
  assert.equal(rows[0].errorCode, "ORCH_API_REQUEST_FAILED");
  assert.equal(JSON.stringify(rows).includes("private provider body"), false);
  assert.equal(f.rows(f.otherId).length, 0); assert.equal(app.mock.callCount(), 0);
});

test("已核W持久化准入失败阻止副作用，其他W仍由原入口完成请求", async t => {
  const f = fixture(t), persistenceFailure = new Error("WORKSPACE_PERSISTENCE_FAILED");
  const checked: WorkspaceId[] = [];
  f.ctx.assertWorkspacePersistenceAvailable = workspaceId => {
    checked.push(workspaceId);
    if (workspaceId === f.workspaceId) throw persistenceFailure;
  };
  await f.call("orch.intakes.create", { workspaceId: f.workspaceId, intake: { title: "不得创建" } });
  assert.equal((f.sent[0] as any).status, 500);
  assert.equal(f.db.forWorkspace(f.workspaceId).orchIntakes.listByWorkspace(f.workspaceId).length, 0);
  await f.call("orch.intakes.create", { workspaceId: f.otherId, intake: { title: "可独立创建" } });
  assert.equal((f.sent[1] as any).status, 200);
  assert.equal(f.db.forWorkspace(f.otherId).orchIntakes.listByWorkspace(f.otherId).length, 1);
  assert.deepEqual(checked, [f.workspaceId, f.otherId]);
  assert.equal(f.rows().length, 1); assert.equal(f.rows(f.otherId).length, 0);
});

test("失败W的普通发送不重试，显式删除沿目标flush恢复且B仍可用", async t => {
  const f = persistenceFixture(t);
  const deletionTails: Promise<void>[] = [];
  f.ctx.flushLocalEvents = async workspaceId => { assert.equal(workspaceId, f.workspaceId); await f.ctx.flushEventPersistence?.(); };
  f.ctx.trackApiTail = work => { void work.then(undefined, () => undefined); deletionTails.push(work); };
  try {
    await f.call("threads.sendMessage", { workspaceId: f.workspaceId, threadId: f.threadId, text: "不得派发" });
    assert.equal((f.sent[0] as any).status, 500); assert.equal(f.flushes(), 0);
    await f.call("orch.intakes.create", { workspaceId: f.otherId, intake: { title: "B独立可用" } });
    assert.equal((f.sent[1] as any).status, 200); assert.equal(f.flushes(), 0);
    f.batch.mock.restore();
    await f.call("threads.delete", { workspaceId: f.workspaceId, threadId: f.threadId });
    assert.equal((f.sent[2] as any).status, 200); assert.equal(f.flushes(), 2);
    assert.equal(f.db.threads.get(f.threadId), null); assert.equal(f.buffer.getPendingCount(), 0);
    await Promise.all(deletionTails);
    assert.doesNotThrow(() => f.buffer.assertNoFailure(f.workspaceId));
  } finally { f.cleanup(); }
});

for (const method of ["threads.rollback", "threads.rollback.preview"] as const) {
  test(`${method}仅在原线程校验后显式flush并重新检查W准入`, async t => {
    const f = persistenceFixture(t);
    for (const level of ["info", "warn", "error"] as const) t.mock.method(logger, level, () => {});
    try {
      await f.call(method, { workspaceId: f.workspaceId, threadId: "missing-thread", toTurnId: "missing-turn" });
      assert.equal((f.sent[0] as any).status, 404); assert.equal(f.flushes(), 0); assert.equal(f.checks(), 0);
      f.batch.mock.restore();
      await f.call(method, { workspaceId: f.workspaceId, threadId: f.threadId, toTurnId: "missing-turn" });
      assert.equal((f.sent[1] as any).status, 404); assert.equal(f.flushes(), 1); assert.equal(f.checks(), 1);
      assert.equal(f.buffer.getPendingCount(), 0);
    } finally { f.cleanup(); }
  });
}

test("API业务与W诊断双错保原值，日志失败前不发送失败响应", async t => {
  const f = fixture(t), business = new Error("business");
  t.mock.method(f.db.forWorkspace(f.workspaceId).orchRoles, "listByWorkspace", () => { throw business; });
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw false; });
  await assert.rejects(f.call(), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [business, false]);
    assert.equal(error.cause, business); return true;
  });
  assert.equal(f.sent.length, 0);
});

test("引擎自产工作区诊断失败沿原请求保因，不翻成已完成500响应", async t => {
  const f = fixture(t), engineFailure = createEngineWorkspaceLogFailure(false);
  t.mock.method(f.db.forWorkspace(f.workspaceId).orchRoles, "listByWorkspace", () => { throw engineFailure; });
  await assert.rejects(f.call(), error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.deepEqual(error.errors, [engineFailure]);
    const details = getWorkspaceApiRequestFailureDetails(error)!;
    assert.equal(details.workspaceId, f.workspaceId); assert.equal(details.responseAttempted, false);
    assert.equal(details.method, "orch.roles.list"); return true;
  });
  assert.equal(f.sent.length, 0);
});

test("中央API不执行错误message getter，仍返回明确失败并写安全根因", async t => {
  const f = fixture(t); let reads = 0;
  const business = Object.defineProperty(new Error("hidden"), "message", { get() { reads++; throw new Error("unsafe getter"); } });
  t.mock.method(f.db.forWorkspace(f.workspaceId).orchRoles, "listByWorkspace", () => { throw business; });
  await f.call();
  assert.equal(reads, 0); assert.equal((f.sent[0] as any).status, 500);
  assert.equal(f.rows().length, 1);
});

test("成功响应投递被拒后保已提交副作用，只尝试一次响应并显式拒绝", async t => {
  const f = fixture(t), rejection = { accepted: false, reason: "test transport rejected" };
  f.ctx.send = message => { f.sent.push(message); return rejection as any; };
  await assert.rejects(f.call("orch.intakes.create", { workspaceId: f.workspaceId, intake: { title: "只创建一次" } }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], rejection);
    assert.equal(getWorkspaceApiRequestFailureDetails(error)?.responseAttempted, true);
    assert.equal(getWorkspaceApiRequestFailureDetails(error)?.responseDelivered, false); return true;
  });
  assert.equal(f.sent.length, 1);
  assert.equal(f.db.forWorkspace(f.workspaceId).orchIntakes.listByWorkspace(f.workspaceId).length, 1);
  assert.equal(f.rows().length, 1);
});

test("桌面已核W的最终404只写工作区，写日志失败不返回伪完成", async t => {
  const f = fixture(t), app = t.mock.method(logger, "warn", () => {});
  const missing = await executeDesktopApiRequest(f.ctx, { method: "orch.instances.get", body: { workspaceId: f.workspaceId, instanceId: "missing-instance" } },
    { requestId: "desktop-failure", clientVersion: "1", startedAt: 1 });
  assert.equal(missing.status, 404);
  assert.equal(f.rows().filter(row => row.requestId === "desktop-failure").length, 1);
  assert.equal(app.mock.callCount(), 0);
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw false; });
  await assert.rejects(executeDesktopApiRequest(f.ctx, { method: "orch.instances.get", body: { workspaceId: f.workspaceId, instanceId: "missing-instance" } },
    { requestId: "desktop-log-failure", clientVersion: "1", startedAt: 1 }), error => error instanceof AggregateError && error.errors.includes(false));
});

test("最终owner识别私有品牌不触Proxy，外改code不伪造安全请求事实", () => {
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { assert.fail("不得反射未知异常"); }, getPrototypeOf() { assert.fail("不得检查未知原型"); } });
  assert.equal(isWorkspaceApiRequestFailure(hostile), false);
  assert.equal(getWorkspaceApiRequestFailureDetails(hostile), null);
  const own = new WorkspaceApiRequestFailure([false], { code: "WORKSPACE_API_REQUEST_LOG_FAILED", requestId: "own", workspaceId: null, method: "orch.roles.list" });
  Object.defineProperty(own, "code", { get() { assert.fail("不得读外部getter"); } });
  assert.equal(isWorkspaceApiRequestFailure(own), true);
  assert.equal(getWorkspaceApiRequestFailureDetails(own)?.code, "WORKSPACE_API_REQUEST_LOG_FAILED");
  assert.equal(own.cause, false);
});

test("API描述反射失败保业务与反射原对象，不发响应或应用替代日志", async t => {
  const f = fixture(t), reflection = new Error("reflection"), business = new Proxy({}, { getOwnPropertyDescriptor() { throw reflection; } });
  t.mock.method(f.db.forWorkspace(f.workspaceId).orchRoles, "listByWorkspace", () => { throw business; });
  await assert.rejects(f.call(), error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.equal(error.errors[0], business); assert.equal(error.errors[1], reflection); return true;
  });
  assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0);
});

test("请求两个release均收齐且失败写W，已投递400不重送响应", async t => {
  const f = fixture(t), threadFailure = new Error("thread release"), workspaceFailure = false;
  const released: string[] = [];
  f.ctx.sessions = { beginThreadOperation: () => () => { released.push("thread"); throw threadFailure; } } as any;
  f.ctx.workspaceOperationGate = { beginWrite: () => () => { released.push("workspace"); throw workspaceFailure; } } as any;
  await assert.rejects(f.call("orch.roles.upsert", { workspaceId: f.workspaceId, threadId: "thread", role: null }), error => {
    assert.ok(isWorkspaceApiRequestFailure(error)); assert.deepEqual(error.errors, [threadFailure, workspaceFailure]);
    assert.equal(getWorkspaceApiRequestFailureDetails(error)?.responseDelivered, true); return true;
  });
  assert.deepEqual(released, ["thread", "workspace"]); assert.equal(f.sent.length, 1);
  assert.equal((f.sent[0] as any).status, 400);
  assert.equal(f.rows().filter(row => row.errorCode === "WORKSPACE_API_REQUEST_CLEANUP_FAILED").length, 1);
});
