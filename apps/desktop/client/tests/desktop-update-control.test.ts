import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createDesktopUpdateControl } from "../src/runtime/desktopUpdateControl.js";
import { createDesktopLifecycle, readDesktopClientHealth } from "../src/runtime/desktopLifecycle.js";
import { listOrdinaryTurnExecutions, trackOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openClientDb } from "../src/db/clientDb.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";

/** 仅替换外部资源动作，活动查询仍走统一 adapter。 */
function fixture() {
  const calls: string[] = [], turns: any[] = [], instances: any[] = [], services: any[] = [];
  let paused = true, transaction = false, knowledge = false, queue = false, scheduler = false;
  const ctx: any = {
    isTaskAdmissionPaused: () => paused, workspaces: new Map([["ws", "workspace-path"]]),
    db: {
      turns: { listRunning: () => [...turns] },
      orchInstances: { listByWorkspace: () => instances },
      orchEvents: { listByInstance: () => [] },
      threads: { listByWorkspace: () => ({ threads: [{ id: "thread" }], hasMore: false, nextCursor: null }) },
      controlledExperiments: { listRunningForSessionGate: () => [] },
    },
    orchEngine: {
      hasInFlightWork: () => false,
      waitForInFlightWork: async () => {},
      listManagedServicesForThread: () => services,
      stopManagedServiceForThread: async (_thread: string, id: string) => { calls.push(`service:${id}`); services.length = 0; return true; },
      cancelAndWait: async (id: string) => { calls.push(`orchestration:${id}`); instances.find(value => value.id === id).status = "cancelled"; },
    },
    sessions: { disposeThread: async (id: string) => { calls.push(`dispose:${id}`); } },
    controlledExperiments: { hasInFlightWork: () => false, stopForUpdate: async () => { calls.push("experiments"); } },
  };
  const input: any = {
    context: ctx, requestId: "update-request", timeoutMs: 100,
    queueDispatcher: { hasInFlightWork: () => queue, assertNoFailure() {}, resumeWorkspace: (id: string) => { calls.push(`queue:${id}`); } },
    scheduledTaskScheduler: { hasInFlightWork: () => scheduler, beginUpdateStop: () => {}, stopForUpdate: async () => {}, resumeAfterUpdate: () => { calls.push("scheduler"); } },
    terminalManager: { hasRunningTerminals: () => false, stopAllForUpdate: async () => { calls.push("terminals"); } },
    hasBlockingTransaction: () => transaction,
    hasKnowledgeWork: () => knowledge,
    stopKnowledgeWork: async () => { calls.push("knowledge"); knowledge = false; },
    hasAssetDraftWork: () => false,
    stopAssetDraftWork: async () => { calls.push("assets"); },
    interruptTurn: async (turn: any) => { calls.push(`turn:${turn.turnId}`); turns.splice(turns.indexOf(turn), 1); },
  };
  ctx.db.forWorkspace = () => ctx.db;
  ctx.orchEngine.existingWorkspace = () => ctx.orchEngine;
  return { ctx, input, calls, turns, instances, services, control: () => createDesktopUpdateControl(input),
    paused: (value: boolean) => { paused = value; }, transaction: (value: boolean) => { transaction = value; },
    knowledge: (value: boolean) => { knowledge = value; }, queue: (value: boolean) => { queue = value; }, scheduler: (value: boolean) => { scheduler = value; } };
}

test("更新准备、停止与稍后恢复在真实Writer许可下查询，等待副作用不持许可", async () => {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-update-writer-"));
  const dbPath = path.join(root, "client.db"), db = openClientDb({ dbPath });
  const workspaceId = "ws" as any, threadId = "thread" as any, turnId = "update-turn" as any;
  db.workspaces.upsert({ id: workspaceId, title: "更新", path: root });
  const scoped = db.forWorkspace(workspaceId);
  scoped.threads.create({ id: threadId, workspaceId, engine: "claude", title: "更新验证" });
  scoped.turns.insertStarted({ workspaceId, threadId, turnId, engine: "claude", startedAt: 1, startEventSeq: 1 });
  f.ctx.db = db; f.ctx.workspaces = new Map([[workspaceId, root]]);
  const writer = new ClientDbWriterService({ dbPath, db, onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    f.ctx.withDatabase = (requestId: string, operation: () => unknown) => writer.withLegacyDatabase(requestId, operation);
    const messages: any[] = [];
    const channel = Object.assign(new EventEmitter(), { send(message: unknown, callback: (error: Error | null) => void) { messages.push(message); callback(null); } });
    await createDesktopLifecycle(channel, "writer-health", { abortStartup: () => assert.fail("unexpected abort") }).ready(() => {},
      () => writer.withLegacyDatabase("writer-health", () => readDesktopClientHealth(db.applicationDb, "1.0.0")));
    assert.equal(messages[0]?.health?.database, "ready");
    f.input.hasBlockingTransaction = () => writer.withLegacyDatabase("update-blocking", () => db.workspaceDirectoryMigrations.listActive().length > 0);
    f.input.hasAssetDraftWork = () => writer.withLegacyDatabase("update-assets", () => scoped.orchAssetGenerationJobs.listByStatuses(["generating"]).length > 0);
    f.input.interruptTurn = async () => {
      assert.throws(() => scoped.turns.get(turnId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/);
      await writer.withLegacyDatabase("update-terminal", () => scoped.turns.setEnded(turnId, { status: "error", endedAt: 2, endEventSeq: 2 }));
    };
    f.input.queueDispatcher.resumeWorkspace = () => scoped.threadQueueStates.resume(threadId, workspaceId);
    const control = f.control();
    assert.equal((await control.prepare()).hasRunningSessions, true);
    await control.interrupt();
    assert.equal(await writer.withLegacyDatabase("update-verify", () => scoped.turns.get(turnId)?.status), "error");
    f.paused(false);
    await control.resume();
  } finally { await writer.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("异步活动查询失败保留原因，取消后的快照不能返回准备成功或恢复队列", async () => {
  const cause = new Error("ASYNC_UPDATE_READ_FAILED");
  for (const callback of ["hasBlockingTransaction", "hasAssetDraftWork"]) {
    const f = fixture(); f.input[callback] = async () => { throw cause; };
    await assert.rejects(f.control().prepare(), error => error === cause);
    assert.deepEqual(f.calls, []);
  }
  for (const phase of ["prepare", "resume"] as const) {
    const f = fixture(), controller = new AbortController();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const querying = new Promise<void>(resolve => { entered = resolve; });
    if (phase === "prepare") f.input.hasAssetDraftWork = async () => { entered(); await gate; return false; };
    else { f.paused(false); f.ctx.withDatabase = async (_requestId: string, operation: () => unknown) => { entered(); await gate; return operation(); }; }
    const work = f.control()[phase]({ requestId: "cancelled-query", signal: controller.signal });
    await querying;
    controller.abort(cause); release();
    await assert.rejects(work, error => error === cause);
    assert.deepEqual(f.calls, []);
  }
});

test("更新空闲静默，未启动草稿不触发确认", async () => {
  const f = fixture();
  f.instances.push({ id: "draft", status: "pending", nodeStates: { a: { status: "pending", retryCount: 0 } } });
  assert.deepEqual(await f.control().prepare(), { hasRunningSessions: false });
  assert.deepEqual(f.calls, []);
});

test("确认同步标记调度 owner 先于首个异步停止，排空仍晚于原流程取消", async () => {
  const f = fixture(), control = f.control();
  f.input.scheduledTaskScheduler.beginUpdateStop = (requestId: string) => { f.calls.push(`begin:${requestId}`); };
  f.input.scheduledTaskScheduler.stopForUpdate = async () => { f.calls.push("drain"); };
  f.instances.push({ id: "flow", status: "running", nodeStates: {} });
  await control.prepare(); assert.equal(f.calls.length, 0);
  const stopping = control.interrupt({ requestId: "precise-workflow-stop", signal: new AbortController().signal });
  assert.deepEqual(f.calls, ["begin:precise-workflow-stop"]);
  await stopping;
  assert.ok(f.calls.indexOf("begin:precise-workflow-stop") < f.calls.indexOf("knowledge"));
  assert.ok(f.calls.indexOf("orchestration:flow") < f.calls.indexOf("drain"));
});

for (const status of ["running", "paused", "waiting-start", "waiting-approval", "waiting-feedback"]) test(`已启动${status}流程更新前需确认`, async () => {
  const f = fixture();
  f.instances.push({ id: "flow", status, nodeStates: { a: { status: "ready", attemptNo: 1 } } });
  assert.equal((await f.control().prepare()).hasRunningSessions, true);
  assert.deepEqual(f.calls, []);
});

test("启动事件识别尚无节点轮次的未完成流程", async () => {
  const f = fixture();
  f.instances.push({ id: "flow", status: "waiting-start", nodeStates: {} });
  f.ctx.db.orchEvents.listByInstance = () => [{ type: "orchestration.started" }];
  assert.equal((await f.control().prepare()).hasRunningSessions, true);
});

test("更新准备必须已有统一准入围栏", async () => {
  const f = fixture(); f.paused(false);
  await assert.rejects(f.control().prepare(), { code: "DESKTOP_UPDATE_NOT_PREPARED" });
  assert.deepEqual(f.calls, []);
});

test("更新等待事务安全边界，超时不执行停止副作用", async () => {
  const f = fixture(); f.transaction(true); f.input.timeoutMs = 5;
  await assert.rejects(f.control().prepare(), { code: "DESKTOP_UPDATE_BUSY" });
  assert.deepEqual(f.calls, []);
});

test("排队及无工作区调度在途必须提示确认，不能提前等待整轮模型", async () => {
  const f = fixture(); f.queue(true); f.scheduler(true);
  assert.equal((await f.control().prepare()).hasRunningSessions, true);
});

test("队列已结算失败在更新准备直接保因，不等待活动模型或启动停止副作用", async () => {
  const f = fixture(), cause = new Error("QUEUE_SETTLED_FAILURE");
  f.queue(true);
  f.input.queueDispatcher.assertNoFailure = () => { throw cause; };
  await assert.rejects(f.control().prepare(), error => error === cause);
  assert.deepEqual(f.calls, []);
});

test("队列在停止期间结算失败时保原错，不以最终busy超时替代", async () => {
  const f = fixture(), cause = new Error("QUEUE_STOP_FAILURE");
  let failed = false;
  f.input.queueDispatcher.assertNoFailure = () => { if (failed) throw cause; };
  f.input.terminalManager.stopAllForUpdate = async () => { f.calls.push("terminals"); failed = true; f.queue(true); };
  await assert.rejects(f.control().interrupt(), error => error === cause);
  assert.equal(f.calls.at(-1), "terminals");
});

test("确认后沿严格入口停止并复查，停止失败不继续清理", async () => {
  const f = fixture(), cause = new Error("provider-refused");
  f.turns.push({ workspaceId: "ws", threadId: "thread", turnId: "turn" });
  f.input.interruptTurn = async () => { f.calls.push("interrupt-failed"); throw cause; };
  await assert.rejects(f.control().interrupt(), error => error === cause);
  assert.equal(f.calls.includes("terminals"), false);
  assert.equal(f.calls.some(value => value.startsWith("dispose:")), false);
});

test("确认后先补turn终态再取消流程，保留未启动草稿", async () => {
  const f = fixture();
  f.turns.push({ workspaceId: "ws", threadId: "thread", turnId: "turn" });
  f.instances.push({ id: "flow", status: "paused", nodeStates: { a: { attemptNo: 1 } } }, { id: "draft", status: "pending", nodeStates: {} });
  await f.control().interrupt();
  assert.ok(f.calls.indexOf("turn:turn") < f.calls.indexOf("orchestration:flow"));
  assert.equal(f.instances[0].status, "cancelled");
  assert.equal(f.instances[1].status, "pending");
});

test("选择稍后解除准入、恢复队列并立即唤醒原调度", async () => {
  const f = fixture(); f.paused(false);
  await f.control().resume();
  assert.deepEqual(f.calls, ["queue:ws", "scheduler"]);
});

test("停止后仍有调度在途则明确忙碌，不伪装可以切换", async () => {
  const f = fixture(); f.scheduler(true); f.input.timeoutMs = 5;
  await assert.rejects(f.control().interrupt(), { code: "DESKTOP_UPDATE_BUSY" });
});

test("知识、实验、终端及托管服务单独活动均需确认", async () => {
  for (const kind of ["knowledge", "experiments", "terminal", "service"]) {
    const f = fixture();
    if (kind === "knowledge") f.knowledge(true);
    if (kind === "experiments") f.ctx.controlledExperiments.hasInFlightWork = () => true;
    if (kind === "terminal") f.input.terminalManager.hasRunningTerminals = () => true;
    if (kind === "service") f.services.push({ serviceId: "service", status: "ready" });
    assert.equal((await f.control().prepare()).hasRunningSessions, true, kind);
    assert.deepEqual(f.calls, []);
  }
});

test("服务拒绝停止后不处理终端，保留原失败", async () => {
  const f = fixture();
  f.services.push({ serviceId: "service", status: "ready", stopSupported: false });
  await assert.rejects(f.control().interrupt(), { code: "DESKTOP_UPDATE_SERVICE_STOP_FAILED" });
  assert.equal(f.calls.includes("terminals"), false);
  assert.equal(f.services.length, 1);
});

test("稍后恢复不等待云端同步或项目检查", async () => {
  const f = fixture(); f.paused(false);
  f.input.scheduledTaskScheduler.resumeAfterUpdate = () => { f.calls.push("scheduler"); };
  let resumed = false;
  void f.control().resume().then(() => { resumed = true; });
  await new Promise(setImmediate);
  assert.equal(resumed, true);
  assert.deepEqual(f.calls, ["queue:ws", "scheduler"]);
});

test("稍后恢复沿用本次控制请求ID，不复用启动ID", async () => {
  const f = fixture(), requests: string[] = []; f.paused(false);
  f.input.scheduledTaskScheduler.resumeAfterUpdate = (requestId: string) => { requests.push(requestId); };
  await f.control().resume({ requestId: "precise-cancel", signal: new AbortController().signal });
  assert.deepEqual(requests, ["precise-cancel"]);
});

test("已结算的调度恢复失败仍阻止更新，不再停止后续终端", async () => {
  const f = fixture(), cause = new Error("scheduler-resume-failed");
  f.input.scheduledTaskScheduler.stopForUpdate = async () => { throw cause; };
  assert.equal((await f.control().prepare()).hasRunningSessions, false);
  await assert.rejects(f.control().interrupt(), error => error === cause);
  assert.equal(f.calls.includes("terminals"), false);
});

test("确认后以本次请求停止脚本，真实收口前不停止后续终端", async () => {
  const f = fixture(), control = f.control();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requests: unknown[] = [];
  f.scheduler(true);
  f.input.scheduledTaskScheduler.stopForUpdate = async (operation: unknown) => {
    requests.push(operation);
    await pending;
    f.scheduler(false);
  };
  assert.deepEqual(await control.prepare(), { hasRunningSessions: true });
  assert.deepEqual(requests, []);
  const stopping = control.interrupt({ requestId: "script-stop-request", signal: new AbortController().signal });
  await new Promise(setImmediate);
  assert.deepEqual(requests, [{ requestId: "script-stop-request", timeoutMs: 100 }]);
  assert.equal(f.calls.includes("terminals"), false);
  release();
  await stopping;
  assert.equal(f.calls.includes("terminals"), true);
});

test("活动读取失败保持原异常，不能当作静默更新", async () => {
  const f = fixture(), cause = new Error("activity-read-failed");
  f.ctx.db.turns.listRunning = () => { throw cause; };
  await assert.rejects(f.control().prepare(), error => error === cause);
  assert.deepEqual(f.calls, []);
});

test("确认前后重新读取活动，不复用过期空闲快照", async () => {
  const f = fixture(), control = f.control();
  assert.equal((await control.prepare()).hasRunningSessions, false);
  f.turns.push({ workspaceId: "ws", threadId: "thread", turnId: "new-turn" });
  await control.interrupt();
  assert.ok(f.calls.includes("turn:new-turn"));
  assert.equal(f.turns.length, 0);
});

test("真实父通道prepare只读活动，确认interrupt后才停止，cancel恢复原围栏", async () => {
  const f = fixture(), messages: any[] = [];
  const channel = Object.assign(new EventEmitter(), { connected: true, send: (message: unknown, callback: (error: Error | null) => void) => { messages.push(message); callback(null); } });
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  f.ctx.isTaskAdmissionPaused = () => lifecycle.isTaskAdmissionPaused();
  f.turns.push({ workspaceId: "ws", threadId: "thread", turnId: "active-turn" });
  await lifecycle.ready(() => {}, () => ({}) as any, undefined, f.control());
  /** 经真实IPC事件等待唯一关联响应，防止测试直接绕过冻结步骤。 */
  const request = async (id: string, method: string) => {
    channel.emit("message", { t: "desktop.api.req", requestId: "parent", id, request: { method } });
    const deadline = Date.now() + 1000;
    while (!messages.some(message => message.id === id) && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    const response = messages.find(message => message.id === id)?.response;
    assert.ok(response); return response;
  };
  const prepared = await request("prepare", "runtime.update.prepare");
  assert.equal(prepared.body.hasRunningSessions, true);
  assert.equal(lifecycle.isTaskAdmissionPaused(), true);
  assert.deepEqual([...f.calls], []);
  assert.equal((await request("interrupt", "runtime.update.interrupt")).status, 200);
  assert.equal(f.turns.length, 0);
  assert.ok(f.calls.includes("turn:active-turn"));
  assert.equal((await request("cancel", "runtime.update.cancel")).status, 200);
  assert.equal(lifecycle.isTaskAdmissionPaused(), false);
  assert.deepEqual(f.calls.slice(-2), ["queue:ws", "scheduler"]);
});

test("取消更新等待当前停止结果，不再启动后续停止副作用", async () => {
  const f = fixture(), controller = new AbortController(), cause = new Error("update cancelled");
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  f.input.stopKnowledgeWork = async () => { f.calls.push("knowledge"); await current; };
  let settled = false;
  const interrupt = f.control().interrupt({ requestId: "precise-interrupt", signal: controller.signal }).finally(() => { settled = true; });
  await new Promise(setImmediate);
  controller.abort(cause);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  release();
  await assert.rejects(interrupt, error => error === cause);
  assert.deepEqual(f.calls, ["knowledge"]);
});

test("取消事务等待明确退出且不读取活动或停止资源", async () => {
  const f = fixture(), controller = new AbortController(), cause = new Error("update cancelled");
  f.transaction(true);
  const preparing = f.control().prepare({ requestId: "precise-prepare", signal: controller.signal });
  controller.abort(cause);
  await assert.rejects(preparing, error => error === cause);
  assert.deepEqual(f.calls, []);
});

test("停止动作使用本次控制请求关联，不复用进程启动ID", async () => {
  const f = fixture(), controller = new AbortController(), contexts: any[] = [];
  f.input.stopKnowledgeWork = async (operation: unknown) => { contexts.push(operation); };
  f.input.stopAssetDraftWork = async (operation: unknown) => { contexts.push(operation); };
  f.ctx.controlledExperiments.stopForUpdate = async (operation: unknown) => { contexts.push(operation); };
  f.input.terminalManager.stopAllForUpdate = async (operation: unknown) => { contexts.push(operation); };
  await f.control().interrupt({ requestId: "precise-interrupt", signal: controller.signal });
  assert.deepEqual(contexts.map(operation => operation.requestId), Array(4).fill("precise-interrupt"));
});

test("普通回合数据库已终态但原清理尾链仍在时需要确认并等待真实owner", async () => {
  const f = fixture();
  const scope: any = { workspaceId: "ws", threadId: "thread", turnId: "completed-turn" };
  f.ctx.db.turns.get = () => ({ ...scope, status: "completed" });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  trackOrdinaryTurnExecution(f.ctx.sessions, scope, () => pending);
  const control = f.control();
  assert.equal((await control.prepare()).hasRunningSessions, true);
  let done = false;
  const stopping = control.interrupt().then(() => { done = true; });
  await new Promise(setImmediate);
  assert.equal(done, false);
  assert.equal(f.calls.some(value => value.startsWith("turn:")), false, "completed turns must retain their existing terminal result");
  release();
  await stopping;
  assert.equal(done, true);
  assert.deepEqual(listOrdinaryTurnExecutions(f.ctx.sessions), []);
});

test("普通回合清理超时保持owner且不继续停止后续资源", async () => {
  const f = fixture(); f.input.timeoutMs = 5;
  const scope: any = { workspaceId: "ws", threadId: "thread", turnId: "cleanup-turn" };
  f.ctx.db.turns.get = () => ({ ...scope, status: "completed" });
  let release!: () => void;
  trackOrdinaryTurnExecution(f.ctx.sessions, scope, () => new Promise<void>(resolve => { release = resolve; }));
  try {
    await assert.rejects(f.control().interrupt(), { code: "ORDINARY_TURN_EXECUTION_TIMEOUT" });
    assert.equal(listOrdinaryTurnExecutions(f.ctx.sessions).length, 1);
    assert.equal(f.calls.includes("terminals"), false);
  } finally { release(); await new Promise(setImmediate); }
});

test("准备中的普通回合尚无DB行时确认更新精确取消，仍等待准备资源收口", async () => {
  const f = fixture();
  const scope: any = { workspaceId: "ws", threadId: "thread", turnId: "preparing-turn" };
  f.ctx.db.turns.get = () => null;
  let release!: () => void, sent = false;
  const preparing = new Promise<void>(resolve => { release = resolve; });
  trackOrdinaryTurnExecution(f.ctx.sessions, scope, async control => {
    await preparing;
    try { control.assertNotCancelled(); }
    catch (error) { if (control.isCancellation(error)) return; throw error; }
    sent = true;
  });
  const control = f.control();
  assert.equal((await control.prepare()).hasRunningSessions, true);
  const stopping = control.interrupt();
  await new Promise(setImmediate);
  assert.equal(f.calls.includes("terminals"), false);
  release();
  await stopping;
  assert.equal(sent, false);
  assert.deepEqual(listOrdinaryTurnExecutions(f.ctx.sessions), []);
});

test("确认框期间原回合清理失败仍阻止本次更新，稍后清除本次资源快照", async () => {
  const f = fixture(), cause = new Error("CONFIRMATION_CLEANUP_FAILED");
  const scope: any = { workspaceId: "ws", threadId: "thread", turnId: "confirmation-turn" };
  let reject!: (error: unknown) => void;
  trackOrdinaryTurnExecution(f.ctx.sessions, scope, () => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const control = f.control();
  assert.equal((await control.prepare()).hasRunningSessions, true);
  reject(cause);
  await new Promise(setImmediate);
  assert.deepEqual(listOrdinaryTurnExecutions(f.ctx.sessions), []);
  await assert.rejects(control.interrupt(), error => error === cause);
  assert.equal(f.calls.includes("terminals"), false);
  f.paused(false);
  await control.resume();
  f.paused(true);
  assert.equal((await control.prepare()).hasRunningSessions, false);
  await control.interrupt();
});

test("编排数据库已完成但原drive仍在时需要确认且只等待不重新取消", async () => {
  const f = fixture();
  f.instances.push({ id: "completed-flow", status: "completed", nodeStates: {} });
  let active = true, release!: () => void;
  const pending = new Promise<void>(resolve => { release = () => { active = false; resolve(); }; });
  f.ctx.orchEngine.hasInFlightWork = () => active;
  f.ctx.orchEngine.waitForInFlightWork = async () => { await pending; };
  const control = f.control();
  assert.equal((await control.prepare()).hasRunningSessions, true);
  let done = false;
  const stopping = control.interrupt().then(() => { done = true; });
  await new Promise(setImmediate);
  assert.equal(done, false);
  assert.equal(f.calls.some(value => value.startsWith("orchestration:")), false);
  release();
  await stopping;
  assert.equal(done, true);
  assert.equal(f.instances[0].status, "completed");
});
