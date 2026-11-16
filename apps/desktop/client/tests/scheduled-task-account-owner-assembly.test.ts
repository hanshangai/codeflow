import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import ts from "typescript";
import { WebSocketServer } from "ws";
import type { ScheduledTask, WorkflowId, WorkspaceId } from "@codeflowai/shared";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "@codeflowai/shared/engine-model-catalog-seed";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { createDesktopCloudAccount, type DesktopCloudAccountOwner } from "../src/runtime/desktopCloudAccount.js";
import { createDesktopStartupRecovery } from "../src/runtime/desktopStartupRecovery.js";
import { openClientDb } from "../src/db/clientDb.js";
import { logger } from "../src/logger.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { listenLoopbackHttpServer } from "./helpers/listenLoopbackHttpServer.js";
import { createScheduledWorkflowInstance } from "../src/app/handlers/orchestrationHandlers.js";
import { OrchAssetAuthorityRuntimeReadService, createClientDbOrchAssetLegacyRuntimeReader } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { OrchAssetLaunchSnapshotService } from "../src/orchestration/orchAssetLaunchSnapshotService.js";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";

/** 执行原 index 中的完整装配函数，不复制 getter 或启动真实 Client 服务。 */
function assembly() {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let declaration: ts.FunctionDeclaration | undefined;
  let schedulerInput: ts.Expression | undefined, linked: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "captureScheduledTaskAccountContext") declaration = node;
    if (ts.isNewExpression(node) && node.expression.getText(tree) === "ScheduledTaskScheduler") schedulerInput = node.arguments?.[0];
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "createDesktopCloudAccount") {
      const input = node.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const property = input.properties.find(value => ts.isPropertyAssignment(value) && value.name.getText(tree) === "onLinked");
        if (property && ts.isPropertyAssignment(property)) linked = property.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(declaration, "index must wire the trusted account getter into the real scheduler");
  const code = ts.transpileModule(declaration.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const state = { shutdown: false, desktop: false, generation: 1, baseGeneration: 1 as number | null, current: true, ready: true,
    hello: { orchAssetAuthority: { assetContext: { kind: "personal", userId: "owner-1" } } } as any,
    config: { serverWsUrl: "wss://example.test/ws", clientId: "client-1", apiKey: "legacy-key-must-not-be-used" },
    cloud: undefined as ReturnType<typeof createDesktopCloudAccount> | undefined, scheduler: undefined as ScheduledTaskScheduler | undefined,
    desktopContext: {} as ApiHandlerContext, context: {} as ApiHandlerContext };
  const env = Object.defineProperties({ config: state.config, deviceIdentity: { deviceId: "device-1" },
    serverMessageHelloReadyFence: { isCurrent: () => state.current }, clientAssetAvailability: { snapshot: () => ({ ready: state.ready }) } }, {
    desktopLifecycle: { get: () => state.desktop ? { isTaskAdmissionPaused: () => false, publishEvent() {} } : undefined },
    desktopCloudAccount: { get: () => state.cloud }, desktopApiHandlerContext: { get: () => state.desktopContext },
    apiHandlerContext: { get: () => state.context }, scheduledTaskScheduler: { get: () => state.scheduler },
    shutdownRequested: { get: () => state.shutdown }, currentClientHello: { get: () => state.hello },
    serverMessageConnectionGeneration: { get: () => state.generation }, baseActivatedGeneration: { get: () => state.baseGeneration },
  });
  const getter = new Function("env", `with(env) { ${code}; return captureScheduledTaskAccountContext; }`)(env);
  Object.assign(env, { captureScheduledTaskAccountContext: getter, enableBuiltInRelayOnStartup: async () => ({ outcome: "skipped" }),
    db: {}, logger, desktopRequestId: "assembly", crypto: { randomUUID: () => "assembly" } });
  /** 直接执行真实装配表达式，测试不复制传输回调或关联完成接线。 */
  const evaluate = (expression: ts.Expression | undefined): any => {
    assert.ok(expression);
    const script = ts.transpileModule(`(${expression.getText(tree)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    return new Function("env", `with(env) { return ${script}; }`)(env);
  };
  return { state, getter, schedulerInput: () => evaluate(schedulerInput) as ConstructorParameters<typeof ScheduledTaskScheduler>[0], onLinked: () => evaluate(linked) as (owner: any) => Promise<void> };
}

test("index 从已激活 personal authority 装配 owner，刷新 hello 不改变同代身份", () => {
  const { state, getter } = assembly();
  const owner = getter();
  assert.equal(owner.ownerUserId, "owner-1"); assert.equal(owner.serverOrigin, "https://example.test");
  assert.equal(owner.clientId, "client-1"); assert.equal(owner.deviceId, "device-1");
  state.hello = { ...state.hello, orchAssetAuthority: { ...state.hello.orchAssetAuthority } };
  owner.assertCurrent();
});

for (const change of ["generation", "user", "origin", "close", "ready"] as const) test(`index 捕获 owner 后重核活连接：${change}`, () => {
  const { state, getter } = assembly(); const owner = getter();
  if (change === "generation") state.generation++;
  if (change === "user") state.hello.orchAssetAuthority.assetContext = { kind: "personal", userId: "other" };
  if (change === "origin") state.config.serverWsUrl = "wss://other.test/ws";
  if (change === "close") state.current = false;
  if (change === "ready") state.ready = false;
  assert.throws(() => owner.assertCurrent());
});

for (const change of ["ready", "base", "closed", "authority", "shutdown", "credentialOrigin"] as const) test(`index 不可信账号状态明确失败：${change}`, () => {
  const { state, getter } = assembly();
  if (change === "ready") state.ready = false;
  if (change === "base") state.baseGeneration = null;
  if (change === "closed") state.current = false;
  if (change === "authority") state.hello.orchAssetAuthority.assetContext = { kind: "shared", userId: "owner-1" };
  if (change === "shutdown") state.shutdown = true;
  if (change === "credentialOrigin") state.config.serverWsUrl = "wss://private:secret@example.test/ws";
  assert.throws(getter);
});

test("index 桌面未关联返回 null，普通 Client 保持原上下文和 Key 入口", () => {
  const f = assembly();
  assert.equal(f.schedulerInput().apiContext, f.state.context);
  assert.equal(f.schedulerInput().requestAccountTasks, undefined);
  f.state.desktop = true;
  assert.equal(f.getter(), null);
  assert.equal(f.schedulerInput().apiContext.localWorkspaceOnly, true);
  assert.equal(typeof f.schedulerInput().requestAccountTasks, "function");
});

test("index 桌面账号流程沿真实工作区落本机scope，账号任务不创造未知归属实例", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-flow-scope-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = "client-1:flow" as WorkspaceId, workflowId = "account-flow" as WorkflowId;
  t.after(() => { resetEngineModelCatalogRuntimeForTest(); db.close(); fs.rmSync(root, { recursive: true }); });
  db.workspaces.upsert({ id: workspaceId, title: "flow", path: root });
  const scoped = db.forWorkspace(workspaceId);
  scoped.orchWorkflows.upsert({ id: workflowId, workspaceId, family: "feature-dev", name: "flow", description: "scope", version: 1, kind: "custom",
    nodes: [{ id: "start", type: "start", label: "start", position: { x: 0, y: 0 } }, { id: "end", type: "end", label: "end", position: { x: 100, y: 0 } }],
    edges: [{ id: "start-end", sourceNodeId: "start", targetNodeId: "end", dataMappings: [] }], workflowKnowledgeBundleIds: [] });
  const reader = new OrchAssetAuthorityRuntimeReadService(createClientDbOrchAssetLegacyRuntimeReader(scoped, { requireCompleteDefinitions: true }), {
    listAssets() { throw new Error("PERSONAL_FLOW_MUST_NOT_READ_SERVER"); }, getAsset() { throw new Error("PERSONAL_FLOW_MUST_NOT_READ_SERVER"); },
  }, { getRuntimeReadinessRequirement: () => null });
  resetEngineModelCatalogRuntimeForTest();
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] });
  const f = assembly(); f.state.desktop = true;
  f.state.desktopContext = { db: scoped, clientId: "client-1", workspaces: new Map([[workspaceId, root]]), orchAssetLaunchSnapshot: new OrchAssetLaunchSnapshotService(reader) } as ApiHandlerContext;
  const input = f.schedulerInput();
  const result = createScheduledWorkflowInstance(input.apiContext, { workspaceId, workflowId, taskName: "account task" });
  const instance = scoped.orchInstances.get(result.instanceId, { strictScope: true });
  assert.deepEqual(instance?.intakeSnapshot.workspaceScope, { scopeType: "local_workspace", scopeId: workspaceId });
  assert.equal(instance?.runtimeConfig?.initiatorUserId, "local:client-1");
  assert.deepEqual(instance?.runtimeConfig?.executionProfileScope, { scopeType: "local_workspace", scopeId: workspaceId });
});

test("index 桌面 owner 固定真实 session，换代/注销/关闭后拒绝旧请求且不调用新会话", async () => {
  const f = assembly(); f.state.desktop = true;
  let current = { serverOrigin: "https://cloud.test", ownerUserId: "A", accountSessionId: "session-A", generation: 7 };
  const calls: unknown[][] = [];
  f.state.cloud = { getOwner: () => ({ ...current }), assertOwner(owner: DesktopCloudAccountOwner) { assert.deepEqual(owner, current); },
    async requestScheduledTasks(...args: unknown[]) { calls.push(args); return { tasks: [], serverNow: 1 }; } } as unknown as ReturnType<typeof createDesktopCloudAccount>;
  const owner = f.getter(), input = f.schedulerInput();
  assert.equal(owner.serverOrigin, "https://cloud.test"); assert.equal(owner.ownerUserId, "A"); assert.equal(owner.generation, 7);
  await input.requestAccountTasks!(owner, "sync", {}, "one");
  assert.deepEqual(calls[0], [current, "sync", {}, "one"]);
  current = { ...current, accountSessionId: "session-B", generation: 8 };
  assert.throws(() => owner.assertCurrent());
  await assert.rejects(async () => input.requestAccountTasks!(owner, "report", {}, "stale"));
  assert.equal(calls.length, 1);
  const fresh = f.getter(); f.state.shutdown = true; assert.throws(() => fresh.assertCurrent());
  f.state.shutdown = false; f.state.cloud = undefined; assert.throws(() => fresh.assertCurrent());
});

/** 真实主入口装配、云 WS/HTTP、SQLite 和原 Scheduler，只控制 Server 业务响应。 */
async function desktopFixture(t: test.TestContext) {
  const f = assembly(); f.state.desktop = true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-assembly-")); t.mock.method(os, "homedir", () => root);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const context = { db, clientId: "client-1", deviceId: "device-1", workspaces: new Map(), localWorkspaceOnly: true } as unknown as ApiHandlerContext;
  f.state.context = context; f.state.desktopContext = context;
  const requests: { token: string | undefined; body: any }[] = [], failures: unknown[] = [], tasks: ScheduledTask[] = [];
  let requestFailure: Error | undefined;
  const server = http.createServer((req, res) => {
    let text = ""; req.on("data", chunk => { text += String(chunk); });
    req.on("end", () => {
      requests.push({ token: req.headers.authorization, body: JSON.parse(text) });
      const failed = requestFailure && (!onlySkipped || requests.at(-1)!.body.run?.status === "skipped");
      res.writeHead(failed ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(failed ? { ok: false } : { ok: true, tasks, configRevisionFloors: tasks.map(task => ({ taskId: task.id, localRevision: 0 })), serverNow: Date.now() }));
    });
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", socket => socket.once("message", () => socket.send(JSON.stringify({ t: "client.helloAck", serverNow: Date.now(), keyHash: "test",
    accountSessionId: "session-A", userSummary: { userId: "A", email: "a@test.local", fullName: "A", accountRole: "personal_normal", enterpriseId: null },
    capabilities: { desktopLocalRuntimeV1: true } }))));
  const origin = `http://127.0.0.1:${await listenLoopbackHttpServer(server)}`;
  let onlySkipped = false;
  const cloud = createDesktopCloudAccount({ clientId: "client-1", deviceId: "device-1", clientVersion: "test", timeoutMs: 3_000,
    onHello: async () => {}, onMessage: async () => {}, onOwnerInvalidated() {}, onFailure(error) { failures.push(error); }, onLinked: f.onLinked() });
  f.state.cloud = cloud;
  const scheduler = new ScheduledTaskScheduler(f.schedulerInput()); f.state.scheduler = scheduler;
  t.after(async () => {
    const results = await Promise.allSettled([scheduler.stopAndDrain(), cloud.stopAndDrain()]);
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => ws.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); fs.rmSync(root, { recursive: true });
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "ASSEMBLY_CLEANUP_FAILED");
  });
  return { ...f, db, scheduler, cloud, origin, requests, failures, tasks,
    /** 只控制独占测试 Server 的明确失败，不改变真实 HTTP。 */
    failRequests(error: Error | undefined, skippedOnly = false) { requestFailure = error; onlySkipped = skippedOnly; } };
}

test("index 真实关联后立即同步，退出账号后原 Scheduler 本机任务仍可运行", async t => {
  const f = await desktopFixture(t);
  await f.scheduler.syncAndTick("offline"); assert.equal(f.requests.length, 0);
  await f.cloud.link({ serverOrigin: f.origin, sessionToken: "test-session" }); await f.scheduler.waitForInFlightWork();
  assert.ok(f.requests.length > 0, "onLinked 必须立即唤醒原 Scheduler");
  assert.ok(f.requests.every(request => request.token === "Bearer test-session"));
  assert.deepEqual(f.failures, []);
  await f.cloud.unlink(); const previous = f.requests.length;
  f.db.scheduledTaskConfigs.create({ at: 1, config: { id: "local", source: "local", clientId: "client-1", deviceId: "device-1", workspaceScope: null,
    name: "local", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "cmd" : "sh", command: "echo local-after-unlink" },
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 10_000 } });
  await f.scheduler.syncAndTick("unlinked"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.requests.length, previous); assert.equal(f.db.scheduledTaskRuns.list({}).items[0]?.status, "success");
});

for (const failure of ["http", "logging", "storage"] as const) test(`desktop 后台账号失败边界不扩大或吞错：${failure}`, async t => {
  const f = await desktopFixture(t), entries: unknown[][] = [], fatal: unknown[] = [];
  await f.cloud.link({ serverOrigin: f.origin, sessionToken: "test-session" }); await f.scheduler.waitForInFlightWork();
  const cause = new Error("CONTROLLED_ACCOUNT_SCAN_FAILURE"); f.failRequests(cause);
  t.mock.method(logger, "error", (...args: unknown[]) => { entries.push(args); if (failure === "logging") throw cause; });
  if (failure === "storage") t.mock.method(f.db, "listLocalScheduledTaskConfigs", () => { throw cause; });
  const originalTick = f.scheduler.syncAndTick.bind(f.scheduler);
  let pending!: Promise<void>;
  t.mock.method(f.scheduler, "syncAndTick", (reason: string, requestId?: string) => { pending = originalTick(reason, requestId); return pending; });
  const recovery = createDesktopStartupRecovery({ scheduler: f.scheduler, recoverQueue() {}, recoverOrchestrations: async () => {} });
  recovery.recover({ requestId: "scan", signal: new AbortController().signal, fail(error) { fatal.push(error); } });
  await assert.rejects(pending); await new Promise(setImmediate);
  if (failure === "http") {
    await f.scheduler.waitForInFlightWork();
    assert.deepEqual(fatal, [], "已记录的账号请求失败不能关闭独立本机运行时");
    assert.equal(entries.length, 1); assert.match(JSON.stringify(entries), /SCHEDULED_TASK_API_FAILED/u);
    assert.doesNotMatch(JSON.stringify(entries), /test-session|legacy-key-must-not-be-used/u);
    f.failRequests(undefined); await f.scheduler.sync("recovered"); await f.scheduler.waitForInFlightWork();
  } else {
    await assert.rejects(f.scheduler.waitForInFlightWork());
    assert.ok(fatal.length > 0, "日志或未知存储错误不能被账号隔离掩盖");
  }
  f.scheduler.stop();
});

test("desktop 原 timer 请求失败只记录一次，后续同步恢复且不关闭本机", async t => {
  const f = await desktopFixture(t), failures: unknown[] = [], entries: unknown[][] = [];
  await f.cloud.link({ serverOrigin: f.origin, sessionToken: "test-session" }); await f.scheduler.waitForInFlightWork();
  let tick!: () => void, logged!: () => void;
  const logging = new Promise<void>(resolve => { logged = resolve; }), originalInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (ms === 60_000) tick = () => callback(...args);
    return originalInterval(callback, ms, ...args);
  });
  t.mock.method(logger, "error", (...args: unknown[]) => { entries.push(args); logged(); });
  f.failRequests(new Error("CONTROLLED_TIMER_HTTP_FAILURE"));
  f.scheduler.start({ requestId: "timer", fail(error) { failures.push(error); } });
  tick(); await logging; await new Promise(setImmediate); await f.scheduler.waitForInFlightWork();
  assert.deepEqual(failures, []); assert.equal(entries.length, 1);
  assert.equal(f.scheduler.isIsolatedAccountRequestScanFailure(Object.assign(new Error("fake"), { code: "SCHEDULED_TASK_API_FAILED", scheduledTaskFailureLogged: true })), false);
  f.failRequests(undefined); tick(); await new Promise(setImmediate); await f.scheduler.waitForInFlightWork();
  assert.equal(entries.length, 1); assert.equal(f.cloud.snapshot().status, "linked");
});

for (const localFailure of ["corrupt", "storage"] as const) test(`desktop 同次本机与账号失败按每项实际隔离结果处理：${localFailure}`, async t => {
  const f = await desktopFixture(t), fatal: unknown[] = [], entries: unknown[][] = [];
  await f.cloud.link({ serverOrigin: f.origin, sessionToken: "test-session" }); await f.scheduler.waitForInFlightWork();
  f.db.scheduledTaskConfigs.create({ at: 1, config: { id: "broken", source: "local", clientId: "client-1", deviceId: "device-1", workspaceScope: null,
    name: "broken", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: "sh", command: "MUST_NOT_EXECUTE" }, concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 1_000 } });
  if (localFailure === "corrupt") f.db.db.prepare("UPDATE scheduled_task_configs SET payload_json=? WHERE id=?").run("{SECRET_CONFIG", "broken");
  else t.mock.method(f.db, "listLocalScheduledTaskConfigs", () => { throw new Error("CONTROLLED_UNKNOWN_STORAGE"); });
  f.failRequests(new Error("CONTROLLED_CLOUD_FAILURE"));
  t.mock.method(logger, "error", (...args: unknown[]) => { entries.push(args); });
  let tick!: () => void;
  const originalInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (ms === 60_000) tick = () => callback(...args);
    return originalInterval(callback, ms, ...args);
  });
  f.scheduler.start({ requestId: "combined", fail(error) { fatal.push(error); } }); tick();
  for (let count = 0; entries.length < (localFailure === "corrupt" ? 2 : 1); count++) {
    assert.ok(count < 500); await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(setImmediate); await new Promise(setImmediate);
  if (localFailure === "corrupt") {
    await f.scheduler.waitForInFlightWork(); assert.deepEqual(fatal, []); assert.equal(entries.length, 2);
  } else { await assert.rejects(f.scheduler.waitForInFlightWork()); assert.equal(fatal.length, 1); }
  assert.doesNotMatch(JSON.stringify(entries), /SECRET_CONFIG|MUST_NOT_EXECUTE|test-session/u);
  f.scheduler.stop();
});

test("index 原 onLinked 共享扫描晚失败不会断开已经关联的下一账号", async t => {
  const f = await desktopFixture(t), entries: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { entries.push(args); });
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => { reject = no; });
  // 原调度器已经观察其Promise，模拟A/B onLinked共用同一在途tick。
  void pending.catch(() => {});
  f.state.scheduler = { syncAndTick: () => pending, isIsolatedAccountRequestScanFailure: () => false,
    isIsolatedLocalConfigScanFailure: () => false } as unknown as ScheduledTaskScheduler;
  await f.cloud.link({ serverOrigin: f.origin, sessionToken: "session-A" });
  const old = f.cloud.getOwner()!;
  await f.cloud.link({ serverOrigin: f.origin, sessionToken: "session-B" });
  const current = f.cloud.getOwner()!; assert.ok(current.generation > old.generation);
  reject(new Error("CONTROLLED_OLD_SCAN_FAILURE")); await new Promise(setImmediate);
  assert.equal(f.cloud.snapshot().status, "linked"); assert.deepEqual(f.cloud.getOwner(), current);
});

test("desktop 真实在途脚本的skip回执失败沿原扫描隔离并保留补报", async t => {
  const f = await desktopFixture(t), entries: unknown[][] = [], fatal: unknown[] = [];
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  await f.cloud.link({ serverOrigin: f.origin, sessionToken: "test-session" }); await f.scheduler.waitForInFlightWork();
  const gate = path.join(os.homedir(), "release-script");
  const task: ScheduledTask = { id: "account-skip", ownerUserId: "A", clientId: "client-1", deviceId: "device-1", deviceKind: "desktop", configRevision: 1,
    clientNameSnapshot: "desktop", deviceLabelSnapshot: null, name: "account", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "powershell" : "sh", command: process.platform === "win32"
      ? `while (-not (Test-Path -LiteralPath '${gate.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 25 }`
      : `while [ ! -f '${gate}' ]; do sleep 0.025; done` }, concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 10_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
  f.tasks.push(task);
  const running = f.scheduler.runNow(task.id); void running.catch(() => {});
  try {
    for (let count = 0; !f.requests.some(request => request.body.run?.status === "running"); count++) {
      assert.ok(count < 500, "真实脚本必须进入running"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    let tick!: () => void, logged!: () => void;
    const logging = new Promise<void>(resolve => { logged = resolve; }), originalInterval = globalThis.setInterval;
    t.mock.method(globalThis, "setInterval", (callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
      if (ms === 60_000) tick = () => callback(...args);
      return originalInterval(callback, ms, ...args);
    });
    t.mock.method(logger, "error", (...args: unknown[]) => { entries.push(args); logged(); });
    f.failRequests(new Error("CONTROLLED_SKIP_REPORT_FAILURE"), true); now += 60_000;
    f.scheduler.start({ requestId: "skip-timer", fail(error) { fatal.push(error); } }); tick();
    await logging; await new Promise(setImmediate); await new Promise(setImmediate);
    assert.ok(f.requests.some(request => request.body.run?.status === "skipped"));
    assert.deepEqual(fatal, [], "skip回执HTTP失败也不能关闭本机"); assert.equal(entries.length, 1);
    f.failRequests(undefined); fs.writeFileSync(gate, "release"); await running; await f.scheduler.waitForInFlightWork();
    await f.scheduler.sync("retry-skip"); await f.scheduler.waitForInFlightWork();
    const owner = f.getter(); assert.equal(f.db.listPendingAccountScheduledTaskRuns(owner).length, 0);
  } finally {
    f.failRequests(undefined); fs.writeFileSync(gate, "release"); await running; await f.scheduler.waitForInFlightWork();
  }
});
