import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ManagedServiceSnapshot, ThreadId, WorkspaceId } from "../../packages/shared/src/index.ts";
import { OrchestrationEngine } from "../../apps/desktop/client/src/orchestration/orchestrationEngine.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";
import { WorkspaceOperationGate } from "../../apps/desktop/client/src/workspace-migration/workspaceOperationGate.ts";

/** 公开消费者使用真实 SQLite 和物理 A/B；退出清理只回收本例创建的 child。 */
function workspaceServiceFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-workspace-"));
  const gate = new WorkspaceOperationGate(), db = openClientDb({ dbPath: path.join(root, "application.db"), workspaceOperationGate: gate });
  const a = path.join(root, "A"), b = path.join(root, "B");
  fs.mkdirSync(a); fs.mkdirSync(b);
  const workspaceA = "managed-A" as WorkspaceId, workspaceB = "managed-B" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceA, title: "物理 A", path: a });
  db.workspaces.upsert({ id: workspaceB, title: "物理 B", path: b });
  const threadA = "managed-thread-A" as ThreadId, threadB = "managed-thread-B" as ThreadId;
  for (const [id, workspaceId] of [[threadA, workspaceA], [threadB, workspaceB]] as const) db.threads.create({ id, workspaceId, engine: "codex", title: "托管中文😀" });
  const fallback: string[] = [];
  const engine = new OrchestrationEngine({ db, threads: new ThreadStore(), workspaces: new Map([[workspaceA, a], [workspaceB, b]]),
    sessions: { listEngineManagedServices: () => [], stopEngineManagedService: async (_thread: ThreadId, serviceId: string) => { fallback.push(serviceId); return true; } } as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {} });
  const children: import("node:child_process").ChildProcess[] = [];
  let closeFailureExpected = false;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("managed test cleanup timeout")), 3000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
        if (!Reflect.apply(Object.getPrototypeOf(child).kill, child, [])) reject(new Error("managed test cleanup signal refused"));
      });
    }
    if (closeFailureExpected) assert.throws(() => db.close(), (error: any) => error.message === "CLIENT_DB_CLOSE_FAILED" && error.errors[0].code === "WORKSPACE_LOG_CLOSE_UNCONFIRMED");
    else db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  /** 所有启动均经过 engine 公开入口，脚本在真实启动时计数一次。 */
  const ensure = async (threadId = threadA, workspacePath = a, serviceId = "svc") => {
    const result = await engine.executeManagedServiceToolForThread({ threadId, workspacePath, toolId: "runtime.manageBackgroundService", accessMode: "current",
      toolInput: { action: "ensure", serviceId, command: process.execPath, args: ["-e", "require('node:fs').appendFileSync('runs.txt', '1');setInterval(() => {},1000)"], ready: { delayMs: 100 } } });
    const record = (engine as any).managedServiceRuntime.servicesByThread.get(threadId)?.get(serviceId);
    if (record?.child && !children.includes(record.child)) children.push(record.child);
    return { result, record };
  };
  /** 读取真实工作区日志，不用 logger mock 替代落盘断言。 */
  const logs = (directory: string) => fs.existsSync(path.join(directory, ".codeflowai")) ? fs.readdirSync(path.join(directory, ".codeflowai")).filter(name => name.endsWith(".log")).flatMap(name => fs.readFileSync(path.join(directory, ".codeflowai", name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))) : [];
  return { db, gate, engine, a, b, workspaceA, workspaceB, threadA, threadB, ensure, logs, fallback, children, expectCloseFailure: () => { closeFailureExpected = true; } };
}

test("managed workspace public engine stop writes only trusted A with safe structured roots", async t => {
  const f = workspaceServiceFixture(t), application: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { application.push(args); });
  const { result, record } = await f.ensure();
  assert.equal(result.ok, true, JSON.stringify(result));
  const cause = new Error("停止中文😀 token=managed-private", { cause: new Error("root password=managed-private") });
  const kill = record.child.kill.bind(record.child);
  record.child.kill = () => { throw cause; };
  await assert.rejects(f.engine.stopManagedServiceForThread(f.threadA, "svc"), { code: "MANAGED_SERVICE_KILL_FAILED", cause });
  const entries = f.logs(f.a);
  assert.equal(entries.length, 1, "托管错误必须同步落所属物理 A");
  assert.equal(f.logs(f.b).length, 0);
  assert.equal(application.length, 0, "同条不得补写应用日志");
  const entry = entries[0]!;
  assert.equal(entry.workspaceId, f.workspaceA);
  assert.equal(entry.threadId, f.threadA);
  assert.equal(entry.serviceId, "svc");
  assert.equal(entry.errorCode, "MANAGED_SERVICE_KILL_FAILED");
  assert.deepEqual(entry.event, { category: "managed-service", action: "manual-stop", outcome: "fail" });
  assert.ok(entry.requestId);
  assert.ok(JSON.stringify(entry).includes("停止中文😀"));
  assert.equal(JSON.stringify(entry).includes("managed-private"), false);
  record.child.kill = kill;
  assert.equal(await f.engine.stopManagedServiceForThread(f.threadA, "svc"), true);
  assert.equal(await f.engine.stopManagedServiceForThread(f.threadA, "engine:normal"), true);
  assert.deepEqual(f.fallback, ["engine:normal"]);
});

for (const logging of [undefined, null, false, 0, -0, "", new Error("log-root")] as const) test(`managed workspace diagnostic ${String(logging)} survives cleanup deletion and repeated public consumers`, async t => {
  const f = workspaceServiceFixture(t), { record } = await f.ensure(), child = record.child;
  const business = new Error("kill-original"), kill = child.kill.bind(child);
  let writes = 0, failure: any;
  child.kill = () => { throw business; };
  t.mock.method(f.db, "writeWorkspaceLog", () => { writes++; throw logging; });
  await assert.rejects(f.engine.stopManagedServiceForThread(f.threadA, "svc"), (error: any) => {
    failure = error;
    assert.equal(error.code, "MANAGED_SERVICE_FAILURE_LOG_FAILED");
    assert.equal(error.errors[0].cause, business);
    assert.ok(Object.is(error.errors[1], logging));
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
  assert.throws(() => f.engine.listManagedServicesForThread(f.threadA), error => error === failure);
  const again = await f.ensure();
  assert.equal(again.result.ok, false);
  assert.equal(fs.readFileSync(path.join(f.a, "runs.txt"), "utf8"), "1");
  child.kill = kill;
  const results = await Promise.allSettled([f.engine.stopManagedServiceForThread(f.threadA, "svc"), f.engine.stopManagedServiceForThread(f.threadA, "svc"), f.engine.disposeManagedServicesForThread(f.threadA)]);
  for (const result of results) { assert.equal(result.status, "rejected"); if (result.status === "rejected") assert.equal(result.reason, failure); }
  assert.notEqual(child.exitCode ?? child.signalCode, null, "诊断失败也必须实际清理 child");
  f.db.threads.delete(f.threadA);
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.throws(() => f.engine.listManagedServicesForThread(f.threadA), error => error === failure);
    await assert.rejects(f.engine.stopManagedServiceForThread(f.threadA, "svc"), error => error === failure);
    await assert.rejects(f.engine.disposeManagedServicesForThread(f.threadA), error => error === failure);
  }
  assert.equal(writes, 1);
  assert.deepEqual(f.fallback, []);
  assert.equal((await f.ensure()).result.ok, false, "新 ensure 不得借旧 record 重建父 thread");
});

test("managed workspace error emitter retains diagnosis through real exit and both prune limits", async t => {
  const f = workspaceServiceFixture(t), { record } = await f.ensure(), child = record.child;
  const logging = new Error("runtime-log-root"), business = new Error("runtime-original");
  let writes = 0;
  t.mock.method(f.db, "writeWorkspaceLog", () => { writes++; throw logging; });
  assert.doesNotThrow(() => child.emit("error", business));
  let failure: any;
  assert.throws(() => f.engine.listManagedServicesForThread(f.threadA), (error: any) => { failure = error; assert.equal(error.errors[0].cause, business); assert.equal(error.errors[1], logging); return true; });
  await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("exit timeout")), 3000); child.once("exit", () => { clearTimeout(timeout); resolve(); }); child.kill(); });
  t.mock.method(Date, "now", () => record.startedAt + 26 * 60 * 60_000);
  const runtime = (f.engine as any).managedServiceRuntime;
  for (let index = 0; index < 210; index++) {
    const thread = index < 25 ? f.threadA : `terminal-${index}`;
    let bucket = runtime.servicesByThread.get(thread); if (!bucket) { bucket = new Map(); runtime.servicesByThread.set(thread, bucket); }
    bucket.set(`terminal-${index}`, { ...record, processFailure: null, serviceId: `terminal-${index}`, threadId: thread, startedAt: Date.now(), exitedAt: Date.now(), status: "stopped" });
  }
  for (const thread of runtime.servicesByThread.keys()) {
    if (thread === f.threadA) assert.throws(() => runtime.listThreadServices(thread), error => error === failure);
    else runtime.listThreadServices(thread);
  }
  assert.throws(() => f.engine.listManagedServicesForThread(f.threadA), error => error === failure);
  await assert.rejects(f.engine.stopManagedServiceForThread(f.threadA, "svc"), error => error === failure);
  assert.equal(writes, 1);
});

test("managed workspace validates current identity and paths before any spawn", async t => {
  const f = workspaceServiceFixture(t);
  assert.equal((await f.ensure(f.threadA, f.b)).result.ok, false);
  f.db.threads.delete(f.threadA);
  assert.equal((await f.ensure()).result.ok, false);
  assert.equal(fs.existsSync(path.join(f.a, "runs.txt")), false);
  const other = await f.ensure(f.threadB, f.b);
  assert.equal(other.result.ok, true);
  assert.equal(await f.engine.stopManagedServiceForThread(f.threadB, "svc"), true);
});

for (const mode of ["migration", "unsafe-root", "close-unconfirmed"] as const) test(`managed workspace ${mode} fixed writer refuses A while B remains usable`, async t => {
  const f = workspaceServiceFixture(t), { record } = await f.ensure(), child = record.child, kill = child.kill.bind(child), business = new Error("gate-kill-root");
  const application: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { application.push(args); });
  let release: (() => void) | undefined, unclosed: number | undefined;
  if (mode === "migration") release = await f.gate.acquireMigration(f.workspaceA, "managed-test-migration");
  if (mode === "unsafe-root") fs.writeFileSync(path.join(f.a, ".codeflow"), "unsafe");
  if (mode === "close-unconfirmed") {
    f.expectCloseFailure();
    const open = fs.openSync, close = fs.closeSync;
    t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => { const fd = open(...args); if (String(args[0]).endsWith(".log")) unclosed = fd; return fd; }) as typeof fs.openSync);
    t.mock.method(fs, "closeSync", (fd: number) => { if (fd === unclosed) throw new Error("managed-close-root"); close(fd); });
  }
  child.kill = () => { throw business; };
  let failure: unknown;
  const expectedFailureCode = mode === "unsafe-root" ? "MANAGED_SERVICE_KILL_FAILED" : "MANAGED_SERVICE_FAILURE_LOG_FAILED";
  await assert.rejects(f.engine.stopManagedServiceForThread(f.threadA, "svc"), (error: any) => {
    failure = error;
    assert.equal(error.code, expectedFailureCode);
    if (mode !== "unsafe-root") assert.equal(error.errors[0].cause, business);
    return true;
  });
  release?.();
  t.mock.restoreAll();
  if (unclosed !== undefined) fs.closeSync(unclosed);
  child.kill = kill;
  if (mode === "unsafe-root") await f.engine.disposeManagedServicesForThread(f.threadA);
  else await assert.rejects(f.engine.disposeManagedServicesForThread(f.threadA), error => error === failure);
  const other = await f.ensure(f.threadB, f.b);
  assert.equal(other.result.ok, true);
  assert.equal(await f.engine.stopManagedServiceForThread(f.threadB, "svc"), true);
  assert.equal(application.length, 0);
});

function createHarness() {
  const stopCalls: Array<{ threadId: ThreadId; serviceId: string }> = [];
  const listCalls: Array<ThreadId> = [];
  const sessions = {
    listEngineManagedServices(threadId: ThreadId): ManagedServiceSnapshot[] {
      listCalls.push(threadId);
      return [];
    },
    async stopEngineManagedService(threadId: ThreadId, serviceId: string): Promise<boolean> {
      stopCalls.push({ threadId, serviceId });
      return false;
    },
  };

  const engine = new OrchestrationEngine({
    db: {
      threads: {
        get(threadId: ThreadId) {
          return {
            id: threadId,
            workspaceId: "client-a:ws-demo" as WorkspaceId,
            threadType: "chat",
            threadSubtype: null,
          };
        },
      },
      orchInstances: {
        get() {
          return null;
        },
      },
    } as any,
    threads: {} as any,
    sessions: sessions as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  return { engine, sessions, stopCalls, listCalls };
}

test("OrchestrationEngine merges platform and engine process items for the current chat window", () => {
  const { engine, listCalls } = createHarness();
  const threadId = "thread-managed-services-demo" as ThreadId;
  const runtime = (engine as any).managedServiceRuntime;

  runtime.listThreadServices = () => [{
    serviceId: "platform-svc",
    displayName: "platform-svc",
    source: "platform",
    stopSupported: true,
    status: "ready",
    pid: 2001,
    command: "node",
    args: ["server.js"],
    workingDirectory: "Z:/code/aidt-code",
    startupTimeoutMs: 1_000,
    readySummary: "ready",
    startedAt: 100,
    readyAt: 120,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
  }] satisfies ManagedServiceSnapshot[];

  (engine as any).ctx.sessions.listEngineManagedServices = () => [{
    serviceId: "engine-svc",
    displayName: "engine-svc",
    source: "engine",
    stopSupported: true,
    status: "ready",
    pid: 3001,
    command: "powershell",
    args: ["-Command", "Start-Sleep 60"],
    workingDirectory: "Z:/code/aidt-code",
    startupTimeoutMs: 0,
    readySummary: "后台运行中",
    startedAt: 200,
    readyAt: 210,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
  }] satisfies ManagedServiceSnapshot[];

  const items = engine.listManagedServicesForThread(threadId);

  assert.deepEqual(listCalls, []);
  assert.deepEqual(items.map((item) => item.serviceId), ["engine-svc", "platform-svc"]);
  assert.deepEqual(items.map((item) => item.source), ["engine", "platform"]);
});

test("OrchestrationEngine falls back to engine process stop when the platform process runtime has no matching item", async () => {
  const { engine, stopCalls } = createHarness();
  const threadId = "thread-managed-services-stop" as ThreadId;
  const runtime = (engine as any).managedServiceRuntime;
  runtime.stopThreadService = async () => false;
  (engine as any).ctx.sessions.stopEngineManagedService = async (capturedThreadId: ThreadId, serviceId: string) => {
    stopCalls.push({ threadId: capturedThreadId, serviceId });
    return true;
  };

  const stopped = await engine.stopManagedServiceForThread(threadId, "engine:codex:40431");

  assert.equal(stopped, true);
  assert.deepEqual(stopCalls, [{
    threadId,
    serviceId: "engine:codex:40431",
  }]);
});


