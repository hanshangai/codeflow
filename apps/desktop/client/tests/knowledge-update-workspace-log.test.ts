import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeGenerationService } from "../src/knowledge/knowledgeGenerationService.js";
import { knowledgeGenerationDiagnosticFailure } from "../src/knowledge/knowledgeGenerationEngine.js";
import { KnowledgeUpdateService, hasActiveKnowledgeUpdate, waitForKnowledgeUpdateCheck } from "../src/knowledge/knowledgeUpdateService.js";
import { tickKnowledgeUpdates } from "../src/knowledge/knowledgeUpdateScheduler.js";
import { createDesktopUpdateControl } from "../src/runtime/desktopUpdateControl.js";
import { logger } from "../src/logger.js";

/** 只读取固定工作区日志；没有日志文件就是没有发生该写入。 */
function logs(root: string): Array<Record<string, unknown>> {
  const directory = path.join(root, ".codeflowai");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^client-.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))) : [];
}

/** 真实A/B注册和知识目录，只在外部扫描及确定故障出口注入失败。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-update-workspace-log-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const a = path.join(root, "a"), b = path.join(root, "b"), workspaceId = "knowledge-update-a" as WorkspaceId;
  fs.mkdirSync(a); fs.mkdirSync(b);
  db.workspaces.upsert({ id: workspaceId, title: "知识甲", path: a });
  db.workspaces.upsert({ id: "knowledge-update-b", title: "知识乙", path: b });
  const store = new KnowledgeAssetStore(a);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "feature", parentId: null, title: "功能", orderKey: "1",
    summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  store.saveDocument({ nodeId: "feature", content: "已确认功能", sources: [], expectedHash: null, origin: "manual", instructions: "" });
  const updates = new KnowledgeUpdateService(store, "knowledge-client", workspaceId, db);
  updates.save({ enabled: false, cronExpr: "* * * * *", timezone: "UTC", selectedNodeIds: ["feature"], includeDescendants: false,
    engine: "codex", model: null, effort: null, concurrency: 1, prompt: "", reviewConfig: { enabled: true, model: null, effort: null } }, null, "shared:business-scope");
  const generation = new KnowledgeGenerationService(store, workspaceId, async () => { assert.fail("失败检查不得启动生成"); },
    "knowledge-update-request", () => ({ nodeId: null, activationVersion: 1 }), db.forWorkspace(workspaceId));
  const appLogs: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { appLogs.push(args); });
  t.after(() => { t.mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, a, b, workspaceId, store, updates, generation, appLogs,
    start: () => updates.start({ requestId: "knowledge-update-request", generation, createOwner: () => { assert.fail("失败检查不得创建owner"); } }) };
}

/** 真实更新控制器消费检查结果；外部停止动作用可见顺序记录代替。 */
function control(f: ReturnType<typeof fixture>) {
  const calls: string[] = [];
  const input: any = { requestId: "update-control", timeoutMs: 1_000, context: {
    db: f.db, workspaces: new Map([[f.workspaceId, f.a]]), isTaskAdmissionPaused: () => true,
    orchEngine: { hasInFlightWork: () => false, waitForInFlightWork: async () => {}, existingWorkspace: () => null,
      listManagedServicesForThread: () => [] },
    sessions: { disposeThread: async (id: string) => { calls.push(`dispose:${id}`); } },
    controlledExperiments: { hasInFlightWork: () => false, stopForUpdate: async () => { calls.push("experiments"); } },
  }, queueDispatcher: { hasInFlightWork: () => false, assertNoFailure() {}, resumeWorkspace() {} },
    scheduledTaskScheduler: { hasInFlightWork: () => false, beginUpdateStop() {}, stopForUpdate: async () => { calls.push("scheduler"); }, resumeAfterUpdate() {} },
    terminalManager: { hasRunningTerminals: () => false, stopAllForUpdate: async () => { calls.push("terminals"); } },
    hasBlockingTransaction: () => hasActiveKnowledgeUpdate(f.a), hasKnowledgeWork: () => false,
    stopKnowledgeWork: async () => { calls.push("knowledge"); }, hasAssetDraftWork: () => false,
    stopAssetDraftWork: async () => { calls.push("assets"); }, interruptTurn: async () => { assert.fail("意外中断"); },
  };
  return { input, calls, value: () => createDesktopUpdateControl(input) };
}

/** 只沿自有聚合数组查原值，falsy根因和异常对象身份不能丢失。 */
function contains(error: unknown, expected: unknown): boolean {
  return Object.is(error, expected) || error instanceof AggregateError && error.errors.some(item => contains(item, expected));
}

/** 等待原后台活动真实收口，摘要不是异步任务结束的替代证据。 */
async function settled(f: ReturnType<typeof fixture>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (hasActiveKnowledgeUpdate(f.a)) {
    assert.ok(Date.now() < deadline, "知识检查必须在限定时间内收口");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

test("检查失败只写可信物理W的固定日志，共享计划scope不改变落点", async t => {
  const f = fixture(t);
  t.mock.method(f.store, "scanMaintenanceFiles", async () => { throw new Error("扫描失败 token=UPDATE_SECRET"); });
  assert.equal(f.start().lastCheck?.outcome, "checking");
  await settled(f);
  assert.equal(f.updates.view().lastCheck?.outcome, "failed");
  const lines = logs(f.a).filter(line => line.message === "scheduled knowledge update failed");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.workspaceId, f.workspaceId);
  assert.equal(lines[0]!.requestId, "knowledge-update-request");
  assert.equal(lines[0]!.selectedWorkspaceId, "shared:business-scope");
  assert.equal(JSON.stringify(lines).includes("UPDATE_SECRET"), false);
  assert.deepEqual(logs(f.b), []);
  assert.deepEqual(f.appLogs, []);
  assert.deepEqual(await control(f).value().prepare(), { hasRunningSessions: false });
});

test("知识更新派发释放数据库许可，失败诊断在原owner的短段内执行", async t => {
  const f = fixture(t), failure = new Error("KNOWLEDGE_DISPATCH_FAILED");
  let permitted = false, logged = false;
  t.mock.method(KnowledgeUpdateService.prototype, "dueAt", () => 1);
  const writer = f.db.writeWorkspaceLog;
  t.mock.method(f.db, "writeWorkspaceLog", (workspaceId, entry) => {
    assert.equal(permitted, true, "knowledge dispatch diagnosis requires permission");
    logged = true;
    writer(workspaceId, entry);
  });
  await assert.rejects(tickKnowledgeUpdates({ context: { db: f.db, workspaces: new Map([[f.workspaceId, f.a]]), clientId: "knowledge-client",
    withDatabase: async (_requestId: string, operation: () => unknown) => {
      permitted = true;
      try { const value = operation(); assert.equal(Boolean((value as any)?.then), false); return value; } finally { permitted = false; }
    } } as any,
    dispatch: async () => { assert.equal(permitted, false); await new Promise(resolve => setImmediate(resolve)); throw failure; },
  }), error => contains(error, failure));
  assert.equal(logged, true);
  assert.equal(f.updates.view().lastCheck?.outcome, "failed");
});

for (const business of [new Error("派发失败"), NaN]) test(`分钟派发失败${String(business)}使用物理W日志和原失败回执`, async t => {
  const f = fixture(t);
  t.mock.method(KnowledgeUpdateService.prototype, "dueAt", () => 1);
  await assert.rejects(tickKnowledgeUpdates({ context: { db: f.db, workspaces: new Map([[f.workspaceId, f.a]]), clientId: "knowledge-client" },
    dispatch: async () => { throw business; } }), error => contains(error, business));
  const lines = logs(f.a).filter(line => line.message === "knowledge update dispatch failed");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.workspaceId, f.workspaceId);
  assert.equal(f.updates.view().lastCheck?.outcome, "failed");
  assert.deepEqual(f.appLogs, []);
});

for (const logFailure of [undefined, null, false, 0]) test(`真实更新prepare和interrupt保留检查业务错及falsy诊断${String(logFailure)}`, async t => {
  const f = fixture(t), c = control(f), business = new Error("原检查失败");
  const scanner = t.mock.method(f.store, "scanMaintenanceFiles", async () => { throw business; });
  const writer = t.mock.method(f.db, "writeWorkspaceLog", () => { throw logFailure; });
  f.start(); await settled(f);
  assert.equal(f.updates.view().lastCheck?.error?.code, "KNOWLEDGE_GENERATION_LOG_FAILED");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.a, f.store.root, "update-state.json"), "utf8")).outcome, "checking");
  for (const consume of [() => c.value().prepare(), () => c.value().interrupt()]) {
    await assert.rejects(consume(), error => error instanceof AggregateError && error.cause === business
      && error.errors[0] === business && Object.is(error.errors[1], logFailure));
    assert.deepEqual(c.calls, []);
  }
  writer.mock.restore(); scanner.mock.restore();
  f.start(); await settled(f);
  assert.equal(f.updates.view().lastCheck?.outcome, "unchanged");
  assert.deepEqual(await c.value().prepare(), { hasRunningSessions: false });
});

test("成功重试不清除尚未交付的诊断，最终消费后再次成功检查才能清除", async t => {
  const f = fixture(t), c = control(f), business = new Error("原检查失败"), logFailure = new Error("日志失败");
  const scanner = t.mock.method(f.store, "scanMaintenanceFiles", async () => { throw business; });
  const writer = t.mock.method(f.db, "writeWorkspaceLog", () => { throw logFailure; });
  f.start(); await settled(f);
  writer.mock.restore(); scanner.mock.restore();
  f.start(); await settled(f);
  assert.equal(f.updates.view().lastCheck?.outcome, "unchanged");
  await assert.rejects(c.value().prepare(), error => contains(error, business) && contains(error, logFailure));
  f.start(); await settled(f);
  assert.deepEqual(await c.value().prepare(), { hasRunningSessions: false });
});

test("摘要写入再失败及第二条日志失败按真实顺序保因，更新不继续停止其他业务", async t => {
  const f = fixture(t), c = control(f), business = new Error("原检查失败"), summary = new Error("摘要失败"), logFailure = new Error("第二日志失败");
  t.mock.method(f.store, "scanMaintenanceFiles", async () => { throw business; });
  const write = f.store.files.write.bind(f.store.files), log = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.store.files, "write", (relative: string, body: string) => {
    if (relative.endsWith("update-state.json") && JSON.parse(body).outcome === "failed") throw summary;
    return write(relative, body);
  });
  t.mock.method(f.db, "writeWorkspaceLog", (...args: Parameters<typeof log>) => {
    if (args[1].message === "knowledge update failure could not be persisted") throw logFailure;
    return log(...args);
  });
  f.start(); await settled(f);
  await assert.rejects(c.value().prepare(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[1], logFailure);
    assert.ok(error.errors[0] instanceof AggregateError);
    assert.deepEqual(error.errors[0].errors, [business, summary]);
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
  assert.deepEqual(c.calls, []);
});

test("未知检查错误反射失败保原对象与次因，不执行getter或字符串转换", async t => {
  const f = fixture(t), reflection = new Error("反射失败");
  let unsafeReads = 0;
  const business = new Proxy(Object.create(null), {
    getOwnPropertyDescriptor() { throw reflection; },
    get() { unsafeReads++; throw new Error("未知属性不得读取"); },
  });
  t.mock.method(f.store, "scanMaintenanceFiles", async () => { throw business; });
  f.start(); await settled(f);
  await assert.rejects(control(f).value().prepare(), error => error instanceof AggregateError
    && error.cause === business && error.errors[0] === business && error.errors[1] === reflection);
  assert.equal(unsafeReads, 0);
});

test("检查收到原generation诊断失败时即使本层日志与摘要成功也阻止更新", async t => {
  const f = fixture(t), original = knowledgeGenerationDiagnosticFailure(new Error("原generation日志失败"));
  t.mock.method(f.store, "scanMaintenanceFiles", async () => { throw original; });
  f.start(); await settled(f);
  assert.equal(f.updates.view().lastCheck?.outcome, "failed");
  await assert.rejects(control(f).value().prepare(), error => error === original);
});

test("检查等待超时和取消保留真实owner，迟到结束仍可再次等待", async t => {
  const f = fixture(t);
  let release!: () => void;
  t.mock.method(f.store, "scanMaintenanceFiles", () => new Promise<Record<string, string>>(resolve => { release = () => resolve({}); }));
  f.start();
  while (!release) await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(waitForKnowledgeUpdateCheck(f.a, { requestId: "check-timeout", timeoutMs: 1 }), { code: "DESKTOP_UPDATE_KNOWLEDGE_CHECK_TIMEOUT" });
  assert.equal(hasActiveKnowledgeUpdate(f.a), true);
  const controller = new AbortController(), reason = new Error("取消更新等待");
  const waiting = waitForKnowledgeUpdateCheck(f.a, { requestId: "check-cancel", signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal(hasActiveKnowledgeUpdate(f.a), true);
  release();
  await waitForKnowledgeUpdateCheck(f.a, { requestId: "check-drain" });
  assert.equal(hasActiveKnowledgeUpdate(f.a), false);
});

test("更新准备和中断只读各W真实会话，同turn主键跨W分别收口", async t => {
  const f = fixture(t), c = control(f), otherId = "knowledge-update-b" as WorkspaceId;
  c.input.context.workspaces.set(otherId, f.b);
  for (const workspaceId of [f.workspaceId, otherId]) {
    const view = f.db.forWorkspace(workspaceId);
    view.threads.create({ id: "same-thread", workspaceId, engine: "codex", title: "工作区会话" });
    view.turns.insertStarted({ workspaceId, threadId: "same-thread", engine: "codex", turnId: "same-turn", startedAt: 1, startEventSeq: null });
  }
  const interrupted: string[] = [];
  c.input.interruptTurn = async (turn: { workspaceId: WorkspaceId; threadId: string; turnId: string }) => {
    interrupted.push(turn.workspaceId);
    assert.equal(turn.threadId, "same-thread");
    f.db.forWorkspace(turn.workspaceId).turns.setEnded(turn.turnId, { status: "error", endedAt: 2, endEventSeq: null });
  };
  const value = c.value();
  assert.deepEqual(await value.prepare(), { hasRunningSessions: true });
  await value.interrupt();
  assert.deepEqual(interrupted, [f.workspaceId, otherId]);
  assert.deepEqual(await value.prepare(), { hasRunningSessions: false });
  assert.deepEqual(f.db.turns.listRunning(), []);
});

test("更新沿各W的原child取消流程与同名进程，不向root或另一W派发控制", async t => {
  const f = fixture(t), c = control(f), otherId = "knowledge-update-b" as WorkspaceId;
  c.input.context.workspaces.set(otherId, f.b);
  const actions: string[] = [], children = new Map();
  for (const workspaceId of [f.workspaceId, otherId]) {
    const view = f.db.forWorkspace(workspaceId);
    view.threads.create({ id: "same-thread", workspaceId, engine: "codex", title: "流程会话" });
    const instance = view.orchInstances.create({ workspaceId, workflowId: "workflow", workflowSnapshot: {
      id: "workflow", workspaceId, name: "流程", description: "", family: "feature-dev", version: 1, nodes: [], edges: [],
    } as never, intakeSnapshot: { id: "intake", workspaceId, title: "运行流程", goal: "运行流程", taskType: "feature", triggerMode: "manual" } as never });
    view.orchInstances.updateStatus(instance.id, "running");
    let active = true;
    children.set(workspaceId, {
      listManagedServicesForThread: () => active ? [{ serviceId: "same-service", status: "ready", startedAt: 1 }] : [],
      async cancelAndWait(id: string) {
        assert.equal(id, instance.id);
        actions.push(`cancel:${workspaceId}`);
        view.orchInstances.updateStatus(id, "cancelled");
      },
      async stopManagedServiceForThread(threadId: string, serviceId: string) {
        assert.equal(threadId, "same-thread"); assert.equal(serviceId, "same-service");
        actions.push(`service:${workspaceId}`); active = false; return true;
      },
    });
  }
  c.input.context.orchEngine.existingWorkspace = (workspaceId: WorkspaceId) => children.get(workspaceId);
  const value = c.value();
  assert.deepEqual(await value.prepare(), { hasRunningSessions: true });
  await value.interrupt();
  assert.deepEqual(actions, [`cancel:${f.workspaceId}`, `cancel:${otherId}`, `service:${f.workspaceId}`, `service:${otherId}`]);
  assert.deepEqual(await value.prepare(), { hasRunningSessions: false });
  assert.deepEqual(f.db.orchInstances.listByWorkspace(f.workspaceId), []);
});
