import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationId, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { ManagedServiceRuntime } from "../src/orchestration/managedServiceRuntime.ts";
import { openClientDb } from "../src/db/clientDb.js";
import type { WorkspaceLogEntry } from "../src/logger.js";

const scopes = new WeakMap<ManagedServiceRuntime, { db: ReturnType<typeof openClientDb>; root: string; workspaceId: WorkspaceId; instanceId: OrchestrationId }>();

/** 原公开 Runtime 使用真实 SQLite 归属，所有文件留在测试临时根。 */
function createRuntime(t: test.TestContext, options: Omit<ConstructorParameters<typeof ManagedServiceRuntime>[0], "db"> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-runtime-")), db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaceId = "runtime-workspace" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "服务", path: root });
  const instance = db.orchInstances.create({ workspaceId, workflowId: "runtime-workflow" as any,
    workflowSnapshot: { id: "runtime-workflow", workspaceId, name: "服务", nodes: [], edges: [] } as any,
    intakeSnapshot: { id: "runtime-intake", workspaceId, title: "服务", goal: "服务", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } } as any });
  const runtime = new ManagedServiceRuntime({ db, ...options });
  scopes.set(runtime, { db, root, workspaceId, instanceId: instance.id });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return runtime;
}

/** 持久 thread 与真实 instance 先建好，再给原公开执行入口传上下文。 */
function runtimeContext(runtime: ManagedServiceRuntime, threadId: ThreadId, instanceId: OrchestrationId | null = null) {
  const scope = scopes.get(runtime)!;
  if (!scope.db.threads.get(threadId)) scope.db.threads.create({ id: threadId, workspaceId: scope.workspaceId, engine: "codex", title: "服务" });
  return { workspacePath: scope.root, threadId, instanceId };
}

/** 只返回本例已经持久化的实例身份。 */
function runtimeInstance(runtime: ManagedServiceRuntime): OrchestrationId { return scopes.get(runtime)!.instanceId; }

test("Client关闭释放全部已持有线程的托管服务，无需重新查询线程列表", async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime), children = captureStartedProcesses(t, runtime);
  const threads = ["shutdown-first", "shutdown-second"] as ThreadId[];
  for (const threadId of threads) await runtime.executeBuiltinTool(tool, {
    action: "ensure", serviceId: "background", command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 },
  }, runtimeContext(runtime, threadId));
  assert.equal(children.length, 2);
  await runtime.disposeAllServices("client-shutdown");
  for (const child of children) assert.notEqual(child.exitCode ?? child.signalCode, null);
  for (const threadId of threads) assert.deepEqual(runtime.listThreadServices(threadId), []);
});

test("N1 线程释放复用已含停止诊断的最终启动对象且重复消费稳定", async t => {
  const startup = new Error("N1-startup"), notification = new Error("N1-terminal-notify"), logging = new Error("N1-terminal-log");
  const runtime = createRuntime(t, { onChanged: event => { if (event.status === "stopped") throw notification; } }), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "n1-disposal" as ThreadId), children = captureStartedProcesses(t, runtime);
  let entered!: () => void, rejectProbe!: (error: unknown) => void, firstLogged!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; }), probe = new Promise<string>((_resolve, reject) => { rejectProbe = reject; }), logged = new Promise<void>(resolve => { firstLogged = resolve; });
  t.mock.method(runtime as any, "checkReady", async () => { entered(); return probe; });
  const db = scopes.get(runtime)!.db, write = db.writeWorkspaceLog.bind(db);
  let writes = 0;
  t.mock.method(db, "writeWorkspaceLog", ((...args: Parameters<typeof write>) => { if (++writes === 1) { write(...args); firstLogged(); return; } throw logging; }) as typeof db.writeWorkspaceLog);
  const input = { action: "ensure", serviceId: "n1", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } };
  const starting = runtime.executeBuiltinTool(tool, input, ctx), started = Promise.allSettled([starting]);
  await probing;
  const child = children[0]!, kill = child.kill.bind(child);
  child.kill = () => true;
  const firstDisposal = runtime.disposeThreadServices(ctx.threadId), concurrentDisposal = runtime.disposeThreadServices(ctx.threadId), disposed = Promise.allSettled([firstDisposal, concurrentDisposal]);
  await new Promise<void>(resolve => setImmediate(resolve));
  rejectProbe(startup); await logged; await new Promise<void>(resolve => setImmediate(resolve));
  child.kill = kill;
  const exited = new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("N1 exit timeout")), 3000); child.once("close", () => { clearTimeout(timeout); resolve(); }); });
  assert.equal(kill(), true);
  await exited;
  const startResult = (await started)[0]!, disposalResults = await disposed;
  assert.equal(startResult.status, "rejected");
  if (startResult.status !== "rejected") throw new Error("N1 expected startup failure");
  const final = startResult.reason;
  for (const result of disposalResults) { assert.equal(result.status, "rejected"); if (result.status === "rejected") assert.equal(result.reason, final, "释放不能重复包装最终启动链已包含的停止诊断"); }
  assert.equal(final.message, "MANAGED_SERVICE_STARTUP_CLEANUP_FAILED"); assert.equal(final.code, "MANAGED_SERVICE_FAILURE_LOG_FAILED");
  assert.equal(final.errors.length, 2); assert.equal(final.errors[0], startup); assert.equal(final.cause, startup);
  const diagnosis = final.errors[1]; assert.equal(diagnosis.errors.length, 2); assert.equal(diagnosis.errors[0], notification); assert.equal(diagnosis.errors[1], logging); assert.equal(diagnosis.cause, notification);
  assert.throws(() => runtime.listThreadServices(ctx.threadId), error => error === final);
  await assert.rejects(runtime.executeBuiltinTool(tool, { action: "status", serviceId: "n1" }, ctx), error => error === final);
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "n1"), error => error === final);
  await assert.rejects(runtime.disposeThreadServices(ctx.threadId), error => error === final);
  await assert.rejects(runtime.executeBuiltinTool(tool, input, ctx), error => error === final);
  assert.equal(writes, 2); assert.equal(children.length, 1); assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test("F1 线程释放收齐在途启动最终诊断并保留原公开消费者", async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "f1-dispose-startup" as ThreadId), children = captureStartedProcesses(t, runtime);
  let entered!: () => void, release!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(runtime as any, "checkReady", async () => { entered(); await gate; return "late-ready"; });
  const logging = new Error("F1-late-startup-log"), input = { action: "ensure", serviceId: "f1", command: process.execPath, args: ["-e", "require('node:fs').appendFileSync('runs.txt','1');setInterval(()=>{},1000)"], ready: { delayMs: 100 } };
  let writes = 0;
  t.mock.method(scopes.get(runtime)!.db, "writeWorkspaceLog", () => { writes++; throw logging; });
  const starting = runtime.executeBuiltinTool(tool, input, ctx), started = Promise.allSettled([starting]);
  await probing;
  const child = children[0]!, closed = new Promise<void>(resolve => child.once("close", resolve));
  let disposalSettled = false;
  const disposal = runtime.disposeThreadServices(ctx.threadId), disposed = Promise.allSettled([disposal]).then(value => { disposalSettled = true; return value; });
  await closed; await new Promise<void>(resolve => setImmediate(resolve));
  const settledBeforeProbe = disposalSettled;
  release();
  const [startResult, disposalResult] = [(await started)[0]!, (await disposed)[0]!];
  assert.equal(settledBeforeProbe, false, "物理退出后仍须等待原启动尾链");
  assert.equal(startResult.status, "rejected"); assert.equal(disposalResult.status, "rejected");
  if (startResult.status !== "rejected" || disposalResult.status !== "rejected") throw new Error("F1 expected both failures");
  const failure = startResult.reason;
  assert.equal(disposalResult.reason, failure);
  assert.equal(failure.errors[0].code, "MANAGED_SERVICE_STARTUP_INTERRUPTED"); assert.equal(failure.errors[1], logging);
  assert.throws(() => runtime.listThreadServices(ctx.threadId), error => error === failure);
  await assert.rejects(runtime.executeBuiltinTool(tool, { action: "status", serviceId: "f1" }, ctx), error => error === failure);
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "f1"), error => error === failure);
  await assert.rejects(runtime.executeBuiltinTool(tool, input, ctx), error => error === failure);
  assert.equal(children.length, 1); assert.equal(writes, 1);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

for (const firstLog of [undefined, false, -0] as const) test(`F2 停止在途收齐迟到启动诊断 ${String(firstLog)} 并共享稳定最终尾链`, async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "f2-stop-startup" as ThreadId), children = captureStartedProcesses(t, runtime);
  const startup = new Error("F2-startup-root"), cleanup = new Error("F2-stop-root"), secondLog = new Error("F2-second-log");
  let entered!: () => void, rejectProbe!: (error: unknown) => void, logged!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; }), probe = new Promise<string>((_resolve, reject) => { rejectProbe = reject; }), firstLogged = new Promise<void>(resolve => { logged = resolve; });
  t.mock.method(runtime as any, "checkReady", async () => { entered(); return probe; });
  let writes = 0;
  t.mock.method(scopes.get(runtime)!.db, "writeWorkspaceLog", () => { if (++writes === 1) { logged(); throw firstLog; } throw secondLog; });
  const input = { action: "ensure", serviceId: "f2", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } };
  const starting = runtime.executeBuiltinTool(tool, input, ctx), started = Promise.allSettled([starting]);
  await probing;
  const child = children[0]!, kill = child.kill.bind(child);
  child.kill = () => true;
  const stopping = runtime.stopThreadService(ctx.threadId, "f2"), secondStop = runtime.stopThreadService(ctx.threadId, "f2"), stopped = Promise.allSettled([stopping, secondStop]);
  await new Promise<void>(resolve => setImmediate(resolve));
  rejectProbe(startup); await firstLogged; await new Promise<void>(resolve => setImmediate(resolve));
  let first: any;
  assert.throws(() => runtime.listThreadServices(ctx.threadId), (error: any) => { first = error; assert.equal(error.errors[0], startup); assert.ok(Object.is(error.errors[1], firstLog)); return true; });
  child.emit("error", cleanup);
  const outcomes = [(await started)[0]!, ...(await stopped)];
  child.kill = kill;
  const cleaned = await Promise.allSettled([runtime.stopThreadService(ctx.threadId, "f2")]);
  assert.ok(outcomes.every(result => result.status === "rejected"));
  const final = (outcomes[0] as PromiseRejectedResult).reason;
  assert.equal(final.errors[0].errors?.[0], first, "停止结算不得用开始时旧快照覆盖在途新增诊断");
  assert.equal(final.errors[0].errors[1].cause, cleanup); assert.equal(final.errors[1], secondLog);
  assert.equal(final.cause, final.errors[0]); assert.equal(final.errors[0].cause, first);
  for (const result of outcomes) if (result.status === "rejected") assert.equal(result.reason, final);
  assert.equal((cleaned[0] as PromiseRejectedResult).reason, final);
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "f2"), error => error === final);
  await assert.rejects(runtime.disposeThreadServices(ctx.threadId), error => error === final);
  await assert.rejects(runtime.executeBuiltinTool(tool, input, ctx), error => error === final);
  assert.equal(writes, 2); assert.equal(children.length, 1); assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test("启动探针在途日志失败保留到原启动 Promise 并实际回收进程", async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "startup-diagnostic" as ThreadId), children = captureStartedProcesses(t, runtime);
  let release!: () => void, entered!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = (runtime as any).checkReady.bind(runtime);
  t.mock.method(runtime as any, "checkReady", async (...args: unknown[]) => { entered(); await gate; return original(...args); });
  const logging = new Error("startup-log-root"), business = new Error("startup-process-root");
  t.mock.method(scopes.get(runtime)!.db, "writeWorkspaceLog", () => { throw logging; });
  const starting = runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "probe", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } }, ctx);
  const observed = Promise.allSettled([starting]);
  await probing;
  const child = children[0]!;
  assert.doesNotThrow(() => child.emit("error", business));
  let failure: unknown;
  assert.throws(() => runtime.listThreadServices(ctx.threadId), (error: any) => { failure = error; assert.equal(error.errors[0].cause, business); assert.equal(error.errors[1], logging); return true; });
  release();
  const result = (await observed)[0]!;
  assert.equal(result.status, "rejected"); if (result.status === "rejected") assert.equal(result.reason, failure);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "probe"), error => error === failure);
});

test("运行诊断后清理新错与再次日志错按顺序保全且清理成功后稳定", async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "cleanup-diagnostic" as ThreadId), children = captureStartedProcesses(t, runtime);
  await runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "cleanup", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } }, ctx);
  const child = children[0]!, kill = child.kill.bind(child), original = new Error("process-root"), firstLog = new Error("log-one"), cleanup = new Error("cleanup-root"), secondLog = new Error("log-two");
  let writes = 0, first: any, final: any;
  t.mock.method(scopes.get(runtime)!.db, "writeWorkspaceLog", () => { throw ++writes === 1 ? firstLog : secondLog; });
  child.emit("error", original);
  assert.throws(() => runtime.listThreadServices(ctx.threadId), (error: any) => { first = error; return true; });
  child.kill = () => { throw cleanup; };
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "cleanup"), (error: any) => {
    final = error; assert.equal(error.errors[0].errors[0], first); assert.equal(error.errors[0].errors[1].cause, cleanup); assert.equal(error.errors[1], secondLog); return true;
  });
  child.kill = kill;
  await assert.rejects(runtime.disposeThreadServices(ctx.threadId), error => error === final);
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "cleanup"), error => error === final);
  assert.throws(() => runtime.listThreadServices(ctx.threadId), error => error === final);
  assert.equal(writes, 2);
});

test("启动诊断与清理再诊断不得重复包装同一原因", async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "startup-three" as ThreadId), children = captureStartedProcesses(t, runtime);
  const startup = new Error("startup-three-root"), cleanup = new Error("startup-three-cleanup"), firstLog = new Error("startup-three-log-one"), secondLog = new Error("startup-three-log-two");
  let first: any, final: any, writes = 0, kill!: import("node:child_process").ChildProcess["kill"];
  t.mock.method((runtime as any), "checkReady", async (record: any) => { kill = record.child.kill.bind(record.child); record.child.kill = () => { throw cleanup; }; throw startup; });
  t.mock.method(scopes.get(runtime)!.db, "writeWorkspaceLog", () => { if (++writes === 2) { assert.throws(() => runtime.listThreadServices(ctx.threadId), error => { first = error; return true; }); throw secondLog; } throw firstLog; });
  await assert.rejects(runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "three", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, ctx), (error: any) => {
    final = error;
    assert.equal(error.message, "MANAGED_SERVICE_FAILURE_LOG_FAILED", "启动 catch 不得再次嵌入已经包含启动诊断的清理尾链");
    assert.equal(error.errors[0].errors[0].errors[0], startup);
    assert.equal(error.errors[0].errors[0].errors[1], firstLog);
    assert.equal(error.errors[0].errors[1].cause, cleanup);
    assert.equal(error.errors[1], secondLog);
    return true;
  });
  assert.ok(first);
  children[0]!.kill = kill;
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "three"), error => error === final);
  assert.equal(writes, 2);
});

test("自然退出通知与日志双错不逃 emitter且真实终态不回滚", async t => {
  const notification = new Error("natural-notify-root"), logging = new Error("natural-log-root"), changes: string[] = [];
  const runtime = createRuntime(t, { onChanged: event => { changes.push(event.reason); if (event.reason === "process-exit") throw notification; } }), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "natural-diagnostic" as ThreadId), children = captureStartedProcesses(t, runtime);
  await runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "natural", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } }, ctx);
  t.mock.method(scopes.get(runtime)!.db, "writeWorkspaceLog", () => { throw logging; });
  const child = children[0]!;
  await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("natural exit timeout")), 3000); child.once("exit", () => { clearTimeout(timeout); resolve(); }); child.kill(); });
  let failure: unknown;
  assert.throws(() => runtime.listThreadServices(ctx.threadId), (error: any) => { failure = error; assert.equal(error.errors[0], notification); assert.equal(error.errors[1], logging); return true; });
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "natural"), error => error === failure);
  assert.deepEqual(changes, ["starting", "ready", "process-exit"]);
});

test("普通运行错误日志成功后自然退出仍按原语义恢复终态快照", async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "ordinary-exit" as ThreadId), children = captureStartedProcesses(t, runtime);
  await runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "ordinary", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } }, ctx);
  const child = children[0]!;
  child.emit("error", new Error("ordinary-process-root"));
  assert.throws(() => runtime.listThreadServices(ctx.threadId), { code: "MANAGED_SERVICE_PROCESS_FAILED" });
  await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("ordinary exit timeout")), 3000); child.once("exit", () => { clearTimeout(timeout); resolve(); }); child.kill(); });
  assert.equal(runtime.listThreadServices(ctx.threadId)[0]?.status, "exited");
});

test("退出通知的反射 Proxy 副错留在原 record 且不逃事件边界", async t => {
  const reflection = new Error("exit-proxy-reflection"), notification = new Proxy({}, { getPrototypeOf() { throw reflection; }, getOwnPropertyDescriptor() { throw reflection; } });
  const runtime = createRuntime(t, { onChanged: event => { if (event.reason === "process-exit") throw notification; } }), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "exit-proxy" as ThreadId), children = captureStartedProcesses(t, runtime);
  await runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "proxy", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } }, ctx);
  const child = children[0]!, escaped: unknown[] = [], emit = child.emit.bind(child);
  /** 测试边界记录任何全局逃逸；Runtime 必须把同一原因交回公开查询。 */
  child.emit = ((...args: Parameters<typeof child.emit>) => { try { return emit(...args); } catch (error) { escaped.push(error); return false; } }) as typeof child.emit;
  await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("proxy exit timeout")), 3000); child.once("close", () => { clearTimeout(timeout); resolve(); }); child.kill(); });
  assert.deepEqual(escaped, []);
  assert.throws(() => runtime.listThreadServices(ctx.threadId), (error: any) => { assert.equal(error.errors[0], notification); assert.equal(error.errors[1], reflection); return true; });
});

test("停止在途 error与日志双错由原 stop Promise 收齐", async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime), ctx = runtimeContext(runtime, "stop-inflight" as ThreadId), children = captureStartedProcesses(t, runtime);
  await runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "stopping", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } }, ctx);
  const child = children[0]!, kill = child.kill.bind(child), business = new Error("stop-event-root"), logging = new Error("stop-event-log-root");
  child.kill = () => true;
  t.mock.method(scopes.get(runtime)!.db, "writeWorkspaceLog", () => { throw logging; });
  const stopped = runtime.stopThreadService(ctx.threadId, "stopping"), result = Promise.allSettled([stopped]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => child.emit("error", business));
  const settlement = (await result)[0]!;
  assert.equal(settlement.status, "rejected");
  if (settlement.status !== "rejected") throw new Error("stop should fail");
  assert.equal(settlement.reason.errors[0].cause, business); assert.equal(settlement.reason.errors[1], logging);
  child.kill = kill;
  await assert.rejects(runtime.stopThreadService(ctx.threadId, "stopping"), error => error === settlement.reason);
});

test("安全 descriptor 反射失败保留未知原对象且不调用 getter或toString", async t => {
  const f = stopFixture(t), reflection = new Error("descriptor-root");
  let getter = 0, stringified = 0;
  const unknown = new Proxy({}, { getOwnPropertyDescriptor() { throw reflection; }, get() { getter++; throw new Error("getter forbidden"); } });
  f.child.kill = () => { throw unknown; };
  let failure: any;
  await assert.rejects(f.runtime.stopThreadService(f.threadId, f.record.serviceId), (error: any) => { failure = error; assert.equal(error.errors[0].cause, unknown); assert.equal(error.errors[1], reflection); return true; });
  assert.equal(getter, 0);
  f.child.kill = () => { f.child.exitCode = 0; f.child.emit("exit", 0, null); return true; };
  await assert.rejects(f.runtime.stopThreadService(f.threadId, f.record.serviceId), error => error === failure);
  const safe = stopFixture(t), cause = Object.defineProperties({ toString() { stringified++; return "secret"; } }, { message: { get() { getter++; return "secret"; } }, cause: { value: false } });
  safe.child.kill = () => { throw cause; };
  await assert.rejects(safe.runtime.stopThreadService(safe.threadId, safe.record.serviceId));
  assert.equal(getter, 0); assert.equal(stringified, 0); assert.equal(safe.logs[0].rootCause.cause.cause.message, "false");
});

function getBuiltinTool(runtime: ManagedServiceRuntime) {
  const tool = runtime.buildBuiltinTools()[0];
  assert.ok(tool, "expected managed service builtin tool");
  return tool;
}

/** 只替换操作系统进程边界，所有停止与快照逻辑仍经过真实 Runtime。 */
function stopFixture(t: test.TestContext) {
  const logs: any[] = [];
  const runtime = createRuntime(t), scope = scopes.get(runtime)!;
  t.mock.method(scope.db, "writeWorkspaceLog", (_workspaceId: WorkspaceId, entry: WorkspaceLogEntry) => { logs.push(entry.data); });
  const child = Object.assign(new EventEmitter(), {
    pid: 32109, exitCode: null as number | null, signalCode: null as string | null, killed: false,
    signals: [] as Array<string | undefined>,
    kill(signal?: string): boolean { this.signals.push(signal); this.killed = true; return true; },
  });
  const threadId = "thread-stop" as ThreadId, instanceId = runtimeInstance(runtime);
  runtimeContext(runtime, threadId, instanceId);
  const record = { workspaceId: scope.workspaceId, instanceId, threadId, serviceId: "service-stop", fingerprint: "same", command: "node", args: [], workingDirectory: scope.root, env: {}, startupTimeoutMs: 1000, ready: { kind: "delay", delayMs: 100 }, status: "ready", pid: child.pid, startedAt: Date.now(), readyAt: Date.now(), exitedAt: null, exitCode: null, exitSignal: null, readySummary: "ready", readinessStdoutTail: "", readinessStderrTail: "", startPromise: null, child, stopRequested: false };
  (runtime as any).servicesByThread.set(threadId, new Map([[record.serviceId, record]]));
  (runtime as any).threadIdsByInstance.set(instanceId, new Set([threadId]));
  return { runtime, child, record, threadId, instanceId, logs };
}

/** 回归使用真实进程并记录全部创建结果，即使断言失败也清理未进入服务表的进程。 */
function captureStartedProcesses(t: test.TestContext, runtime: ManagedServiceRuntime) {
  const children: Array<import("node:child_process").ChildProcess> = [];
  const waitUntilReady = (runtime as any).waitUntilReady.bind(runtime);
  t.mock.method(runtime as any, "waitUntilReady", (record: any) => { children.push(record.child); return waitUntilReady(record); });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode != null || child.signalCode != null) continue;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`测试进程 ${child.pid} 清理超时`)), 3000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
        if (!Reflect.apply(Object.getPrototypeOf(child).kill, child, [])) { clearTimeout(timeout); reject(new Error(`测试进程 ${child.pid} 未接受停止信号`)); }
      });
    }
  });
  return children;
}

for (const action of ["stop", "dispose-thread", "dispose-instance", "startup"] as const) test(`并发 ensure 在 ${action} 等待后重读唯一服务和归属`, async t => {
  const f = stopFixture(t), children = captureStartedProcesses(t, f.runtime), tool = getBuiltinTool(f.runtime);
  let releaseStart!: () => void;
  if (action === "startup") {
    (f.record as any).startPromise = new Promise<void>(resolve => { releaseStart = () => { (f.record as any).startPromise = null; resolve(); }; });
  }
  const stopping = action === "dispose-thread" ? f.runtime.disposeThreadServices(f.threadId)
    : action === "dispose-instance" ? f.runtime.disposeInstanceServices(f.instanceId)
    : action === "startup" ? Promise.resolve() : f.runtime.stopThreadService(f.threadId, f.record.serviceId);
  const input = { action: "ensure", serviceId: f.record.serviceId, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], ready: { delayMs: 100 } };
  const context = runtimeContext(f.runtime, f.threadId, f.instanceId);
  const first = f.runtime.executeBuiltinTool(tool, input, context), second = f.runtime.executeBuiltinTool(tool, input, context);
  if (action === "startup") releaseStart();
  await new Promise<void>(resolve => setImmediate(resolve));
  f.child.exitCode = 0; f.child.emit("exit", 0, null);
  await Promise.all([stopping, first, second]);
  assert.equal(children.length, 1, "等待后只能创建一个替代进程");
  const services = f.runtime.listThreadServices(f.threadId);
  assert.equal(services.length, 1);
  assert.equal(services[0]?.pid, children[0]?.pid);
  assert.ok((f.runtime as any).threadIdsByInstance.get(f.instanceId)?.has(f.threadId), "新进程保留实例归属");
  await f.runtime.disposeInstanceServices(f.instanceId);
  assert.ok(children.every(child => child.exitCode != null || child.signalCode != null));
});

test("迟到就绪探针不能把已停止服务恢复为 ready", async t => {
  const changes: string[] = [], runtime = createRuntime(t, { onChanged: event => { changes.push(event.status); } });
  let releaseProbe!: () => void, probeStarted!: () => void;
  const probing = new Promise<void>(resolve => { probeStarted = resolve; });
  const probe = new Promise<string>(resolve => { releaseProbe = () => resolve("late-ready"); });
  t.mock.method(runtime as any, "checkReady", async () => { probeStarted(); return probe; });
  const threadId = "late-ready-thread" as ThreadId, tool = getBuiltinTool(runtime);
  const starting = runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "late-ready", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, runtimeContext(runtime, threadId));
  const result = Promise.allSettled([starting]);
  await probing;
  await runtime.stopThreadService(threadId, "late-ready");
  releaseProbe();
  assert.equal((await result)[0]?.status, "rejected");
  assert.deepEqual(changes, ["starting", "stopped"]);
  assert.equal(runtime.listThreadServices(threadId)[0]?.status, "stopped");
});

test("停止失败后迟到的运行错误不能丢弃活进程，查询和复用显式失败", async t => {
  const runtime = createRuntime(t), children = captureStartedProcesses(t, runtime), tool = getBuiltinTool(runtime);
  const logs: any[] = [];
  t.mock.method(scopes.get(runtime)!.db, "writeWorkspaceLog", (_workspaceId: WorkspaceId, entry: WorkspaceLogEntry) => { logs.push(entry.data); });
  const threadId = "late-error-thread" as ThreadId, ctx = runtimeContext(runtime, threadId);
  const input = { action: "ensure", serviceId: "late-error", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], ready: { delayMs: 100 } };
  await runtime.executeBuiltinTool(tool, input, ctx);
  const child = children[0]!, record = (runtime as any).servicesByThread.get(threadId).get(input.serviceId);
  const originalKill = child.kill.bind(child), killFailure = new Error("kill-failed");
  try {
    child.kill = () => { throw killFailure; };
    await assert.rejects(runtime.stopThreadService(threadId, input.serviceId), { code: "MANAGED_SERVICE_KILL_FAILED" });
    const cause = new Error("late-process-error token=d09j-late-private");
    child.emit("error", cause);
    assert.equal(record.child, child);
    assert.equal(record.pid, child.pid);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.notEqual(record.status, "stopped");
    await assert.rejects(runtime.executeBuiltinTool(tool, { action: "status", serviceId: input.serviceId }, ctx), { code: "MANAGED_SERVICE_PROCESS_FAILED", cause });
    await assert.rejects(runtime.executeBuiltinTool(tool, input, ctx), { code: "MANAGED_SERVICE_PROCESS_FAILED", cause });
    assert.equal(children.length, 1);
    assert.equal(logs.length, 2);
    assert.equal(JSON.stringify(logs).includes("d09j-late-private"), false);
  } finally { child.kill = originalKill; }
  await runtime.stopThreadService(threadId, input.serviceId);
  assert.equal((await runtime.executeBuiltinTool(tool, { action: "status", serviceId: input.serviceId }, ctx) as any).status, "stopped");
});

test("托管服务发出停止信号后仍等待真实退出，并发调用共享结果", async t => {
  const f = stopFixture(t);
  let finished = false;
  const first = f.runtime.stopThreadService(f.threadId, f.record.serviceId).then(() => { finished = true; });
  const second = f.runtime.stopThreadService(f.threadId, f.record.serviceId);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(f.record.child, f.child);
  assert.equal(f.record.pid, f.child.pid);
  assert.deepEqual(f.child.signals, [undefined]);
  f.child.emit("exit", 0, null);
  await Promise.all([first, second]);
  assert.equal(f.record.child, null);
  assert.equal(f.record.pid, null);
  assert.equal(f.child.listenerCount("exit"), 0);
});

for (const mode of ["throw", "false"] as const) test(`托管服务 kill ${mode} 显式失败，保留原进程并允许重试`, async t => {
  const f = stopFixture(t), cause = new Error("kill denied token=d09j-synthetic-secret-token");
  f.child.kill = () => { if (mode === "throw") throw cause; return false; };
  await assert.rejects(f.runtime.stopThreadService(f.threadId, f.record.serviceId), { code: "MANAGED_SERVICE_KILL_FAILED" });
  assert.equal(f.record.child, f.child);
  assert.equal(f.record.pid, f.child.pid);
  assert.equal(f.record.status, "ready");
  assert.equal(f.child.listenerCount("exit"), 0);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].threadId, f.threadId);
  assert.equal(f.logs[0].serviceId, f.record.serviceId);
  assert.ok(f.logs[0].requestId);
  assert.equal(JSON.stringify(f.logs).includes("d09j-synthetic-secret-token"), false);
  f.child.kill = () => { f.child.emit("exit", 0, null); return true; };
  assert.equal(await f.runtime.stopThreadService(f.threadId, f.record.serviceId), true);
});

test("托管服务停止超时失败保留已发信号的进程，重试仍等待退出", async t => {
  const f = stopFixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopping = assert.rejects(f.runtime.stopThreadService(f.threadId, f.record.serviceId), { code: "MANAGED_SERVICE_EXIT_TIMEOUT" });
  await Promise.resolve();
  t.mock.timers.tick(2001);
  await stopping;
  assert.equal(f.record.child, f.child);
  assert.equal(f.record.pid, f.child.pid);
  assert.equal(f.child.killed, true);
  assert.equal(f.child.listenerCount("exit"), 0);
  const retry = f.runtime.stopThreadService(f.threadId, f.record.serviceId);
  await Promise.resolve();
  assert.equal(f.record.child, f.child);
  f.child.emit("exit", 0, null);
  await retry;
});

test("实例服务清理在首个停止失败时中止并保留归属", async t => {
  const f = stopFixture(t), bucket = (f.runtime as any).servicesByThread.get(f.threadId);
  const later = { ...f.record, serviceId: "later", child: { ...f.child } };
  bucket.set(later.serviceId, later);
  f.child.kill = () => { throw new Error("first-stop-failed"); };
  await assert.rejects(f.runtime.disposeInstanceServices(f.instanceId));
  assert.equal(later.stopRequested, false);
  assert.ok((f.runtime as any).threadIdsByInstance.get(f.instanceId).has(f.threadId));
});

test("并发停止共同观察同一失败，临时资源释放后可以重试", async t => {
  const f = stopFixture(t), cause = new Error("shared-stop-failure");
  f.child.kill = () => { throw cause; };
  const results = await Promise.allSettled([
    f.runtime.stopThreadService(f.threadId, f.record.serviceId),
    f.runtime.stopThreadService(f.threadId, f.record.serviceId),
    f.runtime.disposeThreadServices(f.threadId),
  ]);
  assert.ok(results.every(result => result.status === "rejected"));
  const errors = results.map(result => (result as PromiseRejectedResult).reason);
  assert.equal(errors[0], errors[1]);
  assert.equal(errors[0], errors[2]);
  assert.equal(errors[0].cause, cause);
  assert.equal(f.logs.length, 1);
  assert.equal(f.child.listenerCount("exit"), 0);
  assert.equal(f.child.listenerCount("error"), 0);
  assert.ok((f.runtime as any).servicesByThread.has(f.threadId));
});

test("托管停止聚合异常日志保留各项根因并脱敏", async t => {
  const f = stopFixture(t);
  const cause = new AggregateError([new Error("kill-root authorization=Bearer d09j-private-token"), new Error("native-root password=d09j-private-password", { cause: new Error("nested-root apiKey=d09j-private-key") })], "native-aggregate");
  f.child.kill = () => { throw cause; };
  await assert.rejects(f.runtime.stopThreadService(f.threadId, f.record.serviceId), { code: "MANAGED_SERVICE_KILL_FAILED", cause });
  const text = JSON.stringify(f.logs);
  for (const root of ["kill-root", "native-root", "nested-root"]) assert.ok(text.includes(root));
  assert.equal(text.includes("d09j-private"), false);
});

for (const mode of ["throw", "false", "error-event"] as const) test(`升级停止信号 ${mode} 不能被超时成功覆盖`, async t => {
  const f = stopFixture(t), cause = new Error("escalation-failure");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.child.kill = signal => {
    f.child.signals.push(signal);
    if (signal === "SIGKILL") {
      if (mode === "throw") throw cause;
      if (mode === "error-event") f.child.emit("error", cause);
      return false;
    }
    return true;
  };
  const stopping = assert.rejects(f.runtime.stopThreadService(f.threadId, f.record.serviceId), { code: "MANAGED_SERVICE_KILL_FAILED" });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await stopping;
  assert.equal(f.record.child, f.child);
  assert.equal(f.record.pid, f.child.pid);
  assert.equal(f.record.status, "ready");
  t.mock.timers.tick(5000);
  assert.deepEqual(f.child.signals, [undefined, "SIGKILL"]);
  assert.equal(f.logs.length, 1);
});

test("停止结束立即清理计时器，不能在退出后发送升级信号", async t => {
  const f = stopFixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopping = f.runtime.stopThreadService(f.threadId, f.record.serviceId);
  await Promise.resolve();
  f.child.emit("exit", 0, null);
  await stopping;
  t.mock.timers.tick(5000);
  assert.deepEqual(f.child.signals, [undefined]);
});

test("同步退出不能隐藏随后抛出的 kill 错误", async t => {
  const f = stopFixture(t), cause = new Error("native-kill-after-exit");
  f.child.kill = () => { f.child.emit("exit", 0, null); throw cause; };
  await assert.rejects(f.runtime.stopThreadService(f.threadId, f.record.serviceId), { code: "MANAGED_SERVICE_KILL_FAILED", cause });
  assert.equal(f.logs.length, 1);
});

test("停止执行前自然退出不能被误报 kill 失败", async t => {
  const f = stopFixture(t);
  f.child.kill = () => false;
  const stopping = f.runtime.stopThreadService(f.threadId, f.record.serviceId);
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  await stopping;
  assert.equal(f.record.child, null);
  assert.equal(f.logs.length, 0);
});

test("真实服务的停止通知失败必须返回原错并释放临时监听", async t => {
  const cause = new Error("stop-change-persistence-failed");
  const runtime = createRuntime(t, { onChanged: event => { if (event.status === "stopped") throw cause; } });
  const tool = getBuiltinTool(runtime), threadId = "notice-failure" as ThreadId;
  await runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "notice-failure", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], ready: { delayMs: 100 } }, runtimeContext(runtime, threadId));
  const record = (runtime as any).servicesByThread.get(threadId).get("notice-failure"), child = record.child;
  const received: unknown[] = [];
  /** 在测试边界接住进程事件异常，验证 Runtime 必须通过停止 Promise 交付错误。 */
  const emit = child.emit.bind(child);
  child.emit = (...args: unknown[]) => { try { return emit(...args); } catch (error) { received.push(error); return false; } };
  await assert.rejects(runtime.stopThreadService(threadId, "notice-failure"), error => error === cause);
  assert.deepEqual(received, []);
  assert.equal(child.listenerCount("exit"), 1);
  t.mock.method((runtime as any).options, "onChanged", () => {});
  assert.equal(record.child, null, "通知失败不能回滚真实退出或阻止资源释放");
  await runtime.stopThreadService(threadId, "notice-failure");
  assert.equal(record.child, null);
});

test("已退出进程终态通知失败仍经停止边界记录并保留失败", async t => {
  const f = stopFixture(t), cause = new Error("exited-notification-root");
  f.child.exitCode = 0;
  (f.runtime as any).options.onChanged = () => { throw cause; };
  await assert.rejects(f.runtime.stopThreadService(f.threadId, f.record.serviceId), error => error === cause);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].rootCause.message, cause.message);
  assert.equal(f.record.child, null);
});

test("服务正在停止时不能被 ensure 复用", async t => {
  const f = stopFixture(t);
  const tool = getBuiltinTool(f.runtime);
  const args = { action: "ensure", serviceId: f.record.serviceId, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], ready: { delayMs: 100 } };
  const parsed = (f.runtime as any).parseInput(args, scopes.get(f.runtime)!.root);
  f.record.fingerprint = JSON.stringify({ args: parsed.args, command: parsed.command, env: parsed.env, ready: { delayMs: 100, kind: "delay" }, startupTimeoutMs: parsed.startupTimeoutMs, workingDirectory: parsed.workingDirectory });
  let done = false;
  const stopping = f.runtime.stopThreadService(f.threadId, f.record.serviceId);
  const ensuring = f.runtime.executeBuiltinTool(tool, args, runtimeContext(f.runtime, f.threadId, f.instanceId)).then(value => { done = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  try { assert.equal(done, false); }
  finally {
    f.child.emit("exit", 0, null);
    await stopping;
    await ensuring;
    await f.runtime.disposeThreadServices(f.threadId);
  }
});

test("启动失败和停止清理失败同时保留根因", async t => {
  const runtime = createRuntime(t), tool = getBuiltinTool(runtime);
  const startup = new Error("startup-root"), cleanup = new Error("startup-cleanup-root");
  const originalStop = (runtime as any).stopProcess.bind(runtime);
  t.mock.method(runtime as any, "waitUntilReady", async () => { throw startup; });
  t.mock.method(runtime as any, "stopProcess", async (...args: unknown[]) => { await originalStop(...args); throw cleanup; });
  await assert.rejects(runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "startup-failure", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, runtimeContext(runtime, "startup-thread" as ThreadId)), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [startup, cleanup]);
    return true;
  });
});

test("managed service runtime emits lifecycle changes and keeps stopped snapshot", async t => {
  const changes: Array<{ reason: string; status: string }> = [];
  const runtime = createRuntime(t, {
    onChanged: (event) => {
      changes.push({ reason: event.reason, status: event.status });
    },
  });
  const tool = getBuiltinTool(runtime);
  const instanceId = runtimeInstance(runtime);
  const threadId = "thread-managed-runtime-1" as ThreadId;

  await runtime.executeBuiltinTool(
    tool,
    {
      action: "ensure",
      serviceId: "svc-ready-stop",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      startupTimeoutMs: 3_000,
      ready: { delayMs: 100 },
    },
    runtimeContext(runtime, threadId, instanceId),
  );

  const readyItems = runtime.listThreadServices(threadId);
  assert.equal(readyItems.length, 1);
  assert.equal(readyItems[0]?.status, "ready");

  await runtime.executeBuiltinTool(
    tool,
    { action: "stop", serviceId: "svc-ready-stop" },
    runtimeContext(runtime, threadId, instanceId),
  );

  const stoppedItems = runtime.listThreadServices(threadId);
  assert.equal(stoppedItems.length, 1);
  assert.equal(stoppedItems[0]?.status, "stopped");
  assert.equal(stoppedItems[0]?.pid, null);
  assert.ok(!("logPath" in (stoppedItems[0] ?? {})));
  assert.ok(!("stdoutTail" in (stoppedItems[0] ?? {})));
  assert.ok(!("stderrTail" in (stoppedItems[0] ?? {})));
  assert.deepEqual(
    changes.map((item) => item.reason),
    ["starting", "ready", "stopped"],
  );
});

test("managed service runtime supports thread-owned services without orchestration instance", async t => {
  const runtime = createRuntime(t);
  const tool = getBuiltinTool(runtime);
  const threadId = "thread-managed-runtime-standalone" as ThreadId;

  const ensureResult = await runtime.executeBuiltinTool(
    tool,
    {
      action: "ensure",
      serviceId: "svc-standalone",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      startupTimeoutMs: 3_000,
      ready: { delayMs: 100 },
    },
    runtimeContext(runtime, threadId),
  ) as Record<string, unknown>;

  assert.equal(ensureResult.status, "ready");
  assert.equal(runtime.listThreadServices(threadId)[0]?.serviceId, "svc-standalone");

  await runtime.disposeThreadServices(threadId);

  assert.equal(runtime.listThreadServices(threadId).length, 0);
});

test("managed service runtime scopes same serviceId by thread", async t => {
  const runtime = createRuntime(t);
  const tool = getBuiltinTool(runtime);
  const instanceId = runtimeInstance(runtime);
  const threadA = "thread-managed-runtime-a" as ThreadId;
  const threadB = "thread-managed-runtime-b" as ThreadId;

  await runtime.executeBuiltinTool(
    tool,
    {
      action: "ensure",
      serviceId: "shared-service-id",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      startupTimeoutMs: 3_000,
      ready: { delayMs: 100 },
    },
    runtimeContext(runtime, threadA, instanceId),
  );

  await runtime.executeBuiltinTool(
    tool,
    {
      action: "ensure",
      serviceId: "shared-service-id",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      startupTimeoutMs: 3_000,
      ready: { delayMs: 100 },
    },
    runtimeContext(runtime, threadB, instanceId),
  );

  const threadAItems = runtime.listThreadServices(threadA);
  const threadBItems = runtime.listThreadServices(threadB);
  assert.equal(threadAItems.length, 1);
  assert.equal(threadBItems.length, 1);
  assert.notEqual(threadAItems[0]?.pid, threadBItems[0]?.pid);

  await runtime.disposeInstanceServices(instanceId);

  assert.equal(runtime.listThreadServices(threadA)[0]?.status, "stopped");
  assert.equal(runtime.listThreadServices(threadB)[0]?.status, "stopped");
});

test("managed service runtime prunes expired and overflow stopped snapshots", t => {
  const runtime = createRuntime(t);
  const instanceId = "orch-managed-runtime-2" as OrchestrationId;
  const threadId = "thread-managed-runtime-2" as ThreadId;
  const internals = runtime as any;
  const bucket = new Map<string, any>();
  const now = Date.now();

  for (let index = 0; index < 25; index += 1) {
    const exitedAt = index < 2
      ? now - (25 * 60 * 60_000) - index * 1_000
      : now - index * 1_000;
    bucket.set(`svc-${index}`, {
      instanceId,
      threadId,
      serviceId: `svc-${index}`,
      fingerprint: "",
      command: process.execPath,
      args: [],
      workingDirectory: process.cwd(),
      env: {},
      startupTimeoutMs: 1_000,
      ready: { kind: "delay", delayMs: 100 },
      status: "stopped",
      pid: null,
      startedAt: exitedAt - 1_000,
      readyAt: null,
      exitedAt,
      exitCode: 0,
      exitSignal: null,
      readySummary: "stopped",
      readinessStdoutTail: "",
      readinessStderrTail: "",
      startPromise: null,
      child: null,
      stopRequested: true,
    });
  }

  internals.servicesByThread.set(threadId, bucket);

  const items = runtime.listThreadServices(threadId);
  assert.equal(items.length, 20);
  assert.ok(!items.some((item) => item.serviceId === "svc-0" || item.serviceId === "svc-1"));
  assert.ok(!items.some((item) => item.serviceId === "svc-22" || item.serviceId === "svc-23" || item.serviceId === "svc-24"));
  assert.ok(items.some((item) => item.serviceId === "svc-2"));
  assert.ok(items.some((item) => item.serviceId === "svc-21"));
});
