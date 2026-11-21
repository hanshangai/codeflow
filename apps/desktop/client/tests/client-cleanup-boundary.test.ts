import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { runClientAsyncCleanupStep, runClientCleanupStep } from "../src/runtime/clientCleanup.js";

test("同步关闭忽略诊断故障，仍保留真实清理失败", () => {
  let released = false;
  const business = new Error("CLOSE_FAILED");
  assert.throws(() => runClientCleanupStep(() => { released = true; throw business; }, phase => {
    if (phase === "start") throw undefined;
    throw 0;
  }), error => {
    assert.equal(error, business); return true;
  });
  assert.equal(released, true);
});

test("异步释放等待真实收口，诊断再错保持业务原对象", async () => {
  let release!: () => void, done = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const business = Object.freeze(new Error("SESSION_CLOSE_FAILED"));
  const result = runClientAsyncCleanupStep(async () => { await pending; done = true; throw business; }, phase => {
    if (phase === "fail") throw false;
  });
  const rejected = assert.rejects(result, error => {
    assert.equal(error, business); return true;
  });
  await Promise.resolve(); assert.equal(done, false);
  release(); await rejected; assert.equal(done, true);
});

test("健康关闭保start/success顺序，单一清理错误保持身份", () => {
  const phases: string[] = [];
  runClientCleanupStep(() => phases.push("cleanup"), phase => phases.push(phase));
  assert.deepEqual(phases, ["start", "cleanup", "success"]);
  const original = Object.freeze(new Error("CLOSE_FAILED"));
  assert.throws(() => runClientCleanupStep(() => { throw original; }, () => {}), error => error === original);
});

/** 运行启动入口的真实关闭函数，仅替换资源和进程退出，不启动 Client。 */
function shutdownFixture(failStep: string, configure?: (dependencies: Record<string, any>) => void) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let declaration: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "shutdownAndExit") declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const released: string[] = [];
  const resource = (name: string) => ({ stop() {}, dispose() { released.push(name); },
    async stopAndDrain() { released.push(name); }, async close() { released.push(name); } });
  const buffer = () => ({ getPendingCount: () => 0, dispose() {} });
  const dependencies = {
    config: { clientId: "client" }, process: Object.assign(new EventEmitter(), { pid: 1, connected: false }), logger: { info() {} },
    workspaces: new Map(), eventPipeline: null, databaseWriter: null,
    runClientCleanupStep, runClientAsyncCleanupStep,
    describeWorkspaceApiFailure: (error: unknown) => ({ rootCause: { type: typeof error } }),
    describeClientErrorTree: (error: unknown) => ({ type: typeof error }),
    logClientStep: (_level: string, step: string) => { if (step === failStep) throw 0; },
    workspaceMigrationService: resource("migration"), conversationEventAckBuffer: buffer(), rawEventAckBuffer: buffer(), threadTouchBuffer: buffer(),
    lastEventLoopLagSnapshot: null, desktopLifecycle: null, hostRpcHttpTransport: resource("http"), transport: resource("transport"),
    localEventRelay: resource("relay"), scheduledTaskScheduler: resource("scheduler"),
    orchEngine: { ...resource("engine"), async disposeManagedServices() {} },
    eventFlowMonitor: resource("monitor"), dbCleanup: null, stopEventLoopLagMonitor() {}, rawEventRetention: resource("retention"),
    pendingReminderDirtyWorkspaces: new Set(), desktopCloudAccount: null,
    queueDispatcher: { async waitForIdle() {} }, sessions: resource("sessions"),
    runtime: { async waitForIdle() {} },
    drainOrdinaryTurnExecutions: async (_sessions: object) => {},
    retiredCredentialDrains: [], retiredCredentialFailures: [], workspaceMigrationIndexCoordinator: resource("migrationIndex"),
    workspacePathIndex: resource("pathIndex"), codeAttributionSyncWorker: null, codeAttributionRetentionWorker: null,
    openedClientDbReader: resource("reader"), controlledExperiments: resource("experiments"), terminalManager: resource("terminal"),
    db: { close() { released.push("database"); } }, clientProcessLock: { release() { released.push("lock"); } },
    exitAfterLogFlush: async (exitCode: number) => exitCode,
  };
  configure?.(dependencies);
  const run = new Function(...Object.keys(dependencies), `let shutdownRequested = false, rawEventRetentionStartTimer = null,
    rawEventRetentionTimer = null, reminderDirtyTimer = null;
    ${code}\nreturn shutdownAndExit;`)(...Object.values(dependencies));
  return { run: run as (reason: string, code: number) => Promise<number>, released, dependencies };
}

test("关闭在原会话及编排尾链停止生产后再等待事件索引，避免迟到通知越过DB关闭", async () => {
  let finished = false, ordinaryFinished = false;
  const f = shutdownFixture("none", dependencies => {
    dependencies.drainOrdinaryTurnExecutions = async (sessions: object) => {
      assert.equal(sessions, dependencies.sessions); assert.equal(finished, true); ordinaryFinished = true;
    };
  });
  f.dependencies.sessions.stopAndDrain = async () => { await Promise.resolve(); finished = true; };
  f.dependencies.runtime.waitForIdle = async () => { assert.equal(ordinaryFinished, true); };
  assert.equal(await f.run("test", 0), 0);
});

for (const owner of ["desktop", "migration", "pathIndex"]) {
  test(`${owner}排空失败仍释放其它独立资源，未确认前不主动关库或释放进程锁`, async () => {
    const failure = new Error("RESOURCE_DRAIN_FAILED");
    const f = shutdownFixture("none", dependencies => {
      if (owner === "desktop") dependencies.desktopLifecycle = { async drainRequests() { throw failure; } };
    });
    if (owner === "migration") f.dependencies.workspaceMigrationService.stopAndDrain = async () => { throw failure; };
    if (owner === "pathIndex") f.dependencies.workspacePathIndex.dispose = () => { throw failure; };
    assert.equal(await f.run("test", 0), 1);
    for (const name of ["sessions", "reader", "terminal"]) assert.ok(f.released.includes(name), name);
    assert.equal(f.released.includes("database"), false); assert.equal(f.released.includes("lock"), false);
  });
}

test("数据库关闭失败保留进程锁，避免未退出时允许第二个writer进入", async () => {
  const f = shutdownFixture("none");
  f.dependencies.db.close = () => { throw 0; };
  assert.equal(await f.run("test", 0), 1);
  assert.equal(f.released.includes("lock"), false);
});

test("终端物理释放未确认时仍保留数据库和进程锁，避免旧PTY越过关闭边界", async () => {
  const f = shutdownFixture("none");
  f.dependencies.terminalManager.dispose = () => { throw false; };
  assert.equal(await f.run("test", 0), 1);
  assert.equal(f.released.includes("database"), false); assert.equal(f.released.includes("lock"), false);
});

for (const step of ["shutdown.begin", "shutdown.complete"]) {
  test(`真实关闭入口 ${step} 诊断失败只告警，仍正常释放资源并退出`, async () => {
    const f = shutdownFixture(step);
    assert.equal(await f.run("test", 0), 0);
    for (const name of ["sessions", "engine", "reader", "database", "lock"]) assert.ok(f.released.includes(name), name);
  });
}

test("普通关闭等待托管服务真实停止，再排空事件和关闭数据库", async () => {
  let enter!: () => void, release!: () => void, serviceStopped = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = shutdownFixture("none", dependencies => {
    dependencies.orchEngine.disposeManagedServices = async (reason: string) => {
      assert.equal(reason, "client-shutdown"); enter(); await pending; serviceStopped = true;
    };
    dependencies.runtime.waitForIdle = async () => { assert.equal(serviceStopped, true); };
  });
  const stopping = f.run("desktop_exit", 0);
  await Promise.race([entered, stopping.then(() => { throw new Error("MANAGED_SERVICES_NOT_DRAINED"); })]);
  assert.equal(f.released.includes("database"), false);
  release(); assert.equal(await stopping, 0);
  assert.equal(f.released.includes("database"), true);
});

test("托管服务释放失败保留数据库，已连接桌面等待宿主强杀而不先丢失父链", async () => {
  const f = shutdownFixture("none", dependencies => {
    dependencies.process.connected = true;
    dependencies.desktopLifecycle = { async drainRequests() {} };
    dependencies.orchEngine.disposeManagedServices = async () => { throw new Error("SERVICE_STOP_FAILED"); };
  });
  let settled = false;
  const stopping = f.run("desktop_exit", 0).then(code => { settled = true; return code; });
  await new Promise(setImmediate);
  assert.equal(f.released.includes("reader"), true);
  assert.equal(f.released.includes("database"), false);
  assert.equal(f.released.includes("lock"), false);
  assert.equal(settled, false);
  f.dependencies.process.connected = false;
  f.dependencies.process.emit("disconnect");
  assert.equal(await Promise.race([stopping, new Promise(resolve => setImmediate(() => resolve("STILL_WAITING_FOR_DEAD_PARENT")))]), 1);
});
