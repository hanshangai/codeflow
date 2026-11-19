import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { prepareCodexImagesForTurn } from "../src/engines/codex/codexImageInput.js";
import { ThreadSessionManager } from "../src/engines/threadSessionManager.js";
import { CodexAppServerManager } from "../src/engines/codex-app-server/codexAppServerManager.js";
import { CodexAppServerThreadSession } from "../src/engines/codex-app-server/codexAppServerThreadSession.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { logger } from "../src/logger.js";
import { isEngineWorkspaceLogFailure } from "../src/engines/threadSession.js";

/** 两个注册根和真实固定writer；无provider、安装或网络动作。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-workspace-log-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaces = new Map<WorkspaceId, string>();
  for (const id of ["engine:a", "engine:b"] as WorkspaceId[]) {
    const directory = path.join(root, id.replace(":", "-")); fs.mkdirSync(directory); workspaces.set(id, directory);
    db.workspaces.upsert({ id, title: id, path: directory });
  }
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, workspaces };
}

test("Codex图片准备与释放使用可信W固定日志，图片正文不进入日志", t => {
  const f = fixture(t), workspaceId = "engine:b" as WorkspaceId, directory = f.workspaces.get(workspaceId)!;
  const prepared = prepareCodexImagesForTurn(["data:image/png;base64,cHJpdmF0ZS1pbWFnZS1ib2R5"], {
    workspaceId, workspacePath: directory, threadId: "image-thread", clientTurnId: "image-turn", operation: "turn/start",
    writeWorkspaceLog: f.db.writeWorkspaceLog,
  });
  prepared.cleanup("test-complete");
  const files = fs.readdirSync(path.join(directory, ".codeflowai"));
  const logs = files.filter(name => name.endsWith(".log")).map(name => fs.readFileSync(path.join(directory, ".codeflowai", name), "utf8")).join("");
  assert.match(logs, /codex_image_input_prepared/);
  assert.equal(logs.includes("cHJpdmF0ZS1pbWFnZS1ib2R5"), false);
  assert.equal(logs.includes("private-image-body"), false);
  assert.equal(fs.existsSync(path.join(f.workspaces.get("engine:a" as WorkspaceId)!, ".codeflowai")), false);
});

test("idle资格检查失败沿原W显式拒绝，不伪装无可释放资源", async t => {
  const f = fixture(t), workspaceId = "engine:a" as WorkspaceId, failure = new Error("idle-eligibility-failed");
  const manager = new ThreadSessionManager({ workspaces: f.workspaces, threads: new ThreadStore(), writeWorkspaceLog: f.db.writeWorkspaceLog,
    sessionIdleCleanup: { enabled: true, idleMs: 1, scanMs: 60_000 } });
  const records = (manager as unknown as { sessions: Map<ThreadId, unknown> }).sessions;
  records.set("idle-thread" as ThreadId, { lastUsedAt: 0, session: { engine: "claude", workspaceId, threadId: "idle-thread",
    hasActiveTurn: () => false, canIdleDispose() { throw failure; }, async dispose() {} } });
  try { await assert.rejects(manager.disposeIdleSessions(100), error => error === failure || error instanceof AggregateError && error.errors.some(item => item === failure || item.cause === failure)); }
  finally { records.clear(); await manager.stopAndDrain(); }
});

test("idle定时失败保留在原manager，关闭消费失败且不逃逸全局Promise", async t => {
  const f = fixture(t), workspaceId = "engine:a" as WorkspaceId, failure = new Error("idle-dispose-failed");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const manager = new ThreadSessionManager({ workspaces: f.workspaces, threads: new ThreadStore(), writeWorkspaceLog: f.db.writeWorkspaceLog,
    sessionIdleCleanup: { enabled: true, idleMs: 1, scanMs: 1, now: () => 100 } });
  const records = (manager as unknown as { sessions: Map<ThreadId, unknown> }).sessions;
  records.set("idle-thread" as ThreadId, { lastUsedAt: 0, session: { engine: "claude", workspaceId, threadId: "idle-thread",
    hasActiveTurn: () => false, canIdleDispose: () => true, async dispose() { throw failure; } } });
  t.mock.timers.tick(10_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  records.clear();
  await assert.rejects(manager.stopAndDrain());
});

test("Codex独占进程诊断按构造W落盘，payload不能改写日志归属", async t => {
  const f = fixture(t), workspaceId = "engine:b" as WorkspaceId;
  const manager = new CodexAppServerManager({ writeWorkspaceLog: f.db.writeWorkspaceLog,
    clientInfo: { name: "test", title: "test", version: "0" } });
  const workspace = manager.forThread("engine-log-thread" as ThreadId).getOrCreate(workspaceId, f.workspaces.get(workspaceId)!);
  const callbacks = (workspace as any).opts;
  callbacks.onRequestTimeout({ requestId: 42, method: "thread/read", elapsedMs: 500, timeoutMs: 500,
    processGeneration: 1, pendingMethods: [], workspaceId: "engine:a" });
  callbacks.onProcessFault({ code: "codex_app_server_process_error", message: "provider failed", requestId: "process:42" });
  await manager.killAllWorkspaces();
  const directory = path.join(f.workspaces.get(workspaceId)!, ".codeflowai");
  const logs = fs.readdirSync(directory).filter(name => name.endsWith(".log")).map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("");
  assert.match(logs, /process fault/);
  assert.match(logs, /request timeout/);
  assert.equal(fs.existsSync(path.join(f.workspaces.get("engine:a" as WorkspaceId)!, ".codeflowai")), false);
});

test("Codex晚回调日志失败不阻止新请求、idle检查或正常dispose", async () => {
  let killed = 0, sent = 0;
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog() { throw undefined; },
    manager: { getOrCreate() { sent += 1; throw new Error("must not send"); }, getExisting() { return { async kill() { killed += 1; } }; } } as any,
    workspacePath: "D:/isolated", workspaceId: "engine:b" as WorkspaceId, threadId: "late-thread", initialSessionId: null,
    initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  (session as any).trackStartingTurnLateSettlement({ providerOwnershipConflict: new Error("fenced"), clientTurnId: "late-turn" },
    Promise.resolve({ status: "fulfilled", value: {} }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => session.canIdleDispose());
  await assert.rejects(session.sendMessage({ turnId: "new-turn", userItemId: "user", text: "", images: [], assistantItemId: "assistant", reasoningItemId: "reasoning" },
    { conversation() {}, raw() {} }));
  assert.equal(sent, 1);
  await session.dispose();
  assert.equal(killed, 0);
  assert.equal((session as any).disposed, true);
});

test("Codex活动回合日志失败不拒绝活动owner或关闭超时控制", async () => {
  const writeFailure = { failure: "writer" };
  let stopped = 0, rejected: unknown;
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog() { throw writeFailure; }, manager: {} as any,
    workspacePath: "D:/isolated", workspaceId: "engine:b" as WorkspaceId, threadId: "active-thread", initialSessionId: null,
    initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  (session as any).active = { clientTurnId: "active-turn", codexTurnId: "provider-turn", timeoutController: { stop() { stopped += 1; } }, reject(cause: unknown) { rejected = cause; } };
  assert.doesNotThrow(() => (session as any).log("warn", () => ({ message: "diagnostic", data: { code: "test" } }), { reason: undefined }));
  assert.equal(rejected, undefined);
  assert.equal(stopped, 0);
});

test("Codex异步事件失败保留原始错误并停止owner，不能误标为日志失败", async () => {
  const failure = Object.assign(new Error("LOCAL_EVENT_PIPELINE_CAPACITY_EXCEEDED"), { code: "event-storage-failed" });
  let rejected: unknown, stopped = 0;
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog() {}, manager: {} as any,
    workspacePath: "D:/isolated", workspaceId: "engine:b" as WorkspaceId, threadId: "event-failure-thread", initialSessionId: null,
    initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  (session as any).active = { timeoutController: { stop() { stopped++; } }, reject(cause: unknown) { rejected = cause; } };
  (session as any).observeDiagnosticTask(async () => { throw failure; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(rejected, failure);
  assert.equal(stopped, 1);
  assert.throws(() => session.canIdleDispose(), error => error === failure);
  await assert.rejects(session.sendMessage({ turnId: "new-turn", userItemId: "user", text: "", images: [], assistantItemId: "assistant", reasoningItemId: "reasoning" },
    { conversation() {}, raw() {} }), error => error === failure);
});

test("Codex真实ownership到期timer日志失败不锁死会话且其他W日志可用", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100 });
  const failure = new Error("expiry-log-failed"), logs: string[] = [];
  const makeSession = (workspaceId: WorkspaceId) => new CodexAppServerThreadSession({
    writeWorkspaceLog(wid) { if (wid === "engine:b") throw failure; logs.push(wid); }, manager: {} as any,
    workspacePath: "D:/isolated", workspaceId, threadId: "timer-thread", initialSessionId: null, initialSessionCapabilities: null,
    onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  const broken = makeSession("engine:b" as WorkspaceId), healthy = makeSession("engine:a" as WorkspaceId);
  const starting = { clientTurnId: "timer-turn", clientUserMessageId: "user", providerThreadId: "provider-thread",
    ownershipRecoveryExpiresAt: 101, ownershipRecoveryExpiryTimer: null };
  (broken as any).pendingInterruptedStartingTurns.set("timer-turn", starting);
  (broken as any).armStartingTurnOwnershipExpiryTimer(starting);
  assert.doesNotThrow(() => t.mock.timers.tick(2));
  assert.doesNotThrow(() => broken.canIdleDispose());
  (healthy as any).log("info", () => ({ message: "healthy", data: { code: "healthy" } }));
  assert.deepEqual(logs, ["engine:a"]);
});

test("Codex会话日志不读取未知异常getter或toString", () => {
  let reads = 0;
  const cause = Object.create(null, { message: { get() { reads += 1; throw new Error("must not read"); } },
    toString: { get() { reads += 1; throw new Error("must not convert"); } } });
  const logs: unknown[] = [];
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog(_workspaceId, entry) { logs.push(entry); }, manager: {} as any,
    workspacePath: "D:/isolated", workspaceId: "engine:b" as WorkspaceId, threadId: "safe-thread", initialSessionId: null,
    initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  (session as any).handleProviderRequestResponseFailure({}, "tool/response", 42, null, cause);
  assert.equal(reads, 0);
  assert.equal(logs.length, 1);
});

test("Codex工作区日志和应用告警双失败后资源清理仍可重试", async t => {
  const f = fixture(t), workspaceId = "engine:b" as WorkspaceId, threadId = "dispose-retry-thread" as ThreadId;
  const manager = new ThreadSessionManager({ workspaces: f.workspaces, threads: new ThreadStore(),
    writeWorkspaceLog: f.db.writeWorkspaceLog, sessionIdleCleanup: { enabled: false } });
  let kills = 0, closes = 0, unregisters = 0;
  const diagnostic = new Error("diagnostic-failed"), resetFailure = new Error("unregister-failed");
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog() { throw diagnostic; },
    manager: { getExisting() { return { async kill() { kills++; } }; }, async drainMessages() {} } as any,
    workspacePath: f.workspaces.get(workspaceId)!, workspaceId, threadId, initialSessionId: null,
    initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {},
    onSessionBindingDropped() {}, onStartAttempt() {} });
  t.mock.method(logger, "warn", () => { throw new Error("application-warning-failed"); });
  assert.throws(() => (session as any).log("error", () => ({ message: "injected" })));
  const leases = (session as any).providerInputImageLeases as Set<unknown>;
  const lease = { close() { closes++; if (closes === 1) throw undefined; leases.delete(lease); }, getError() { return null; } };
  leases.add(lease);
  (session as any).unregister = () => { unregisters++; if (unregisters === 1) throw resetFailure; };
  const records = (manager as any).sessions as Map<ThreadId, unknown>;
  const record = { session, lastUsedAt: 0 };
  records.set(threadId, record);
  await assert.rejects(manager.disposeThread(threadId));
  assert.equal((session as any).disposed, true);
  assert.equal(records.get(threadId), record);
  assert.equal(leases.has(lease), true);
  await assert.rejects(manager.disposeThread(threadId));
  assert.equal(records.get(threadId), record);
  assert.equal(leases.size, 0);
  assert.equal(kills, 2);
  assert.equal(closes, 2);
  assert.equal(unregisters, 2);
  records.clear();
  await manager.stopAndDrain();
});

test("Codex故障回收成功仍保留真实日志双失败，不能伪造release成功", async t => {
  const manager = new CodexAppServerManager({ writeWorkspaceLog() { throw new Error("workspace-log-failed"); },
    clientInfo: { name: "test", title: "test", version: "0" } });
  const threadId = "fault-log-failure-thread" as ThreadId;
  const workspace = manager.forThread(threadId).getOrCreate("engine:b" as WorkspaceId, "D:/isolated");
  const child = { pid: 42, exitCode: null, signalCode: null };
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  (workspace as any).opts.terminateProcessTree = async () => {};
  t.mock.method(logger, "warn", () => { throw new Error("application-log-failed"); });
  (workspace as any).failWorkspace(Object.assign(new Error("process-failed"), { code: "codex_app_server_process_error" }), {
    child, processGeneration: 1, notifyThreads: false, killChild: true,
  });
  await assert.rejects(manager.releaseThread(threadId), error => isEngineWorkspaceLogFailure(error));
});

test("Codex配置退订日志失败只告警且保留原业务值，不读取异常getter", async () => {
  let reads = 0;
  const business = Object.create(null, { code: { get() { reads++; throw new Error("must not read"); } },
    toString: { get() { reads++; throw new Error("must not convert"); } } });
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog() { throw undefined; }, manager: {} as any,
    workspacePath: "D:/isolated", workspaceId: "engine:b" as WorkspaceId, threadId: "safe-unsubscribe-thread",
    initialSessionId: "provider-thread" as never, initialSessionCapabilities: null,
    onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  await assert.rejects((session as any).unloadThreadForConfigRefresh({ async request() { throw business; } }), error => {
    assert.equal(error, business);
    return true;
  });
  assert.equal(reads, 0);
});

test("Codex迟到退订失败在日志失败时仍保留provider原异常", async () => {
  let reads = 0;
  const business = new Error("private-provider-message");
  Object.defineProperty(business, "message", { get() { reads++; throw new Error("must not read"); } });
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog() { throw undefined; }, manager: {} as any,
    workspacePath: "D:/isolated", workspaceId: "engine:b" as WorkspaceId, threadId: "late-unsubscribe-thread",
    initialSessionId: "provider-thread" as never, initialSessionCapabilities: null,
    onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  (session as any).pendingConfigRefreshUnsubscribe = { sessionId: "provider-thread",
    settlement: Promise.resolve({ status: "rejected", kind: "process_fault", reason: business }) };
  await assert.rejects((session as any).unloadThreadForConfigRefresh({}), error => {
    assert.equal((error as Error).cause, business);
    return true;
  });
  assert.equal(reads, 0);
});
