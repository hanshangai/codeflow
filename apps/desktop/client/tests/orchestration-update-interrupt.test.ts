import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationEventInput } from "@codeflowai/shared";
import { createDefaultRoleExecutionConfig, createDefaultRoleExecutionCustomConfig } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { createLocalEventPersistence } from "../src/runtime/localEventPersistence.js";
import { createDesktopUpdateControl } from "../src/runtime/desktopUpdateControl.js";
import type { SendMessageInput } from "../src/engines/threadSession.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { XmlNodePromptRenderer } from "../src/orchestration/promptRenderer.js";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "@codeflowai/shared/engine-model-catalog-seed";

/** 分离测试控制与实际等待，不依赖固定延时判断先后。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 原日志探针改接固定 writer，保留原 tag/message/data 故障及断言接口。 */
function mockLifecycleLog(t: TestContext, db: ReturnType<typeof openClientDb>, callback: (...args: any[]) => void) {
  const writer = t.mock.method(db, "writeWorkspaceLog", (_workspaceId: Parameters<typeof db.writeWorkspaceLog>[0], entry: Parameters<typeof db.writeWorkspaceLog>[1]) => callback(entry.tag, entry.message, entry.data));
  return { mock: { get calls() { return writer.mock.calls.map(call => ({ arguments: [call.arguments[1].tag, call.arguments[1].message, call.arguments[1].data] })); } } };
}

/** 保留真实仓储和取消入口，仅替代 provider 与托管进程。 */
function fixture(t: TestContext, status: "running" | "waiting-approval" | "paused" = "running") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orch-update-interrupt-"));
  const applicationDb = openClientDb({ dbPath: path.join(directory, "client.db"), localCanonicalEvents: true });
  t.after(() => { applicationDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "workspace-update-interrupt", threadId = "thread-update-interrupt", turnId = "turn-update-interrupt";
  applicationDb.workspaces.upsert({ id: workspaceId, title: "更新中断", path: directory });
  const db = applicationDb.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "更新中断", threadType: "orchestration" });
  const persistence = createLocalEventPersistence({ db,
    applyConversation(event) {
      if (event.type === "turn.started") {
        db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
          turnId: event.payload.turnId, startedAt: event.ts, startEventSeq: event.seq });
      }
      if (event.type === "turn.completed") {
        db.turns.setEnded(event.payload.turnId, { status: "completed", endedAt: event.ts, endEventSeq: event.seq });
      }
      if (event.type === "turn.error") {
        assert.ok(event.payload.turnId);
        db.turns.setEnded(event.payload.turnId, { status: "error", endedAt: event.ts, endEventSeq: event.seq });
      }
    }, applyRaw() {} });
  db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: Date.now(), startEventSeq: 1 });
  const instance = db.orchInstances.create({ workspaceId, workflowId: "workflow-update-interrupt",
    workflowSnapshot: { id: "workflow-update-interrupt", workspaceId, family: "feature-dev", name: "更新中断", description: "更新中断", version: 1,
      nodes: [{ id: "role", type: "role", roleId: "role-update-interrupt", label: "角色", position: { x: 0, y: 0 } }], edges: [] },
    intakeSnapshot: { id: "intake-update-interrupt", workspaceId, triggerMode: "manual", taskType: "feature", title: "更新中断", goal: "更新中断",
      background: null, acceptanceCriteria: null, workbenchItemRefs: null, seedArtifactRefs: null, constraints: null, requester: null, createdAt: 1, updatedAt: 1 },
  });
  instance.nodeStates.role.status = status === "paused" ? "waiting-feedback" : status;
  instance.nodeStates.role.threadId = threadId;
  db.orchInstances.updateNodeStates(instance.id, instance.nodeStates);
  db.orchInstances.updateStatus(instance.id, status);
  let active: string | null = turnId;
  const calls: string[] = [];
  const sessions = {
    async interrupt(actualThread: string, actualTurn: string) {
      calls.push(`${actualThread}:${actualTurn}`);
      active = null;
      return true;
    },
    getActiveTurnId() { return active; },
  };
  const engine = new OrchestrationEngine({ db, threads: new ThreadStore(), sessions: sessions as any, workspaces: new Map([[workspaceId, directory]]),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    emitConversation(event: ConversationEventInput) { persistence.persist({ t: "conversation.event", event }); }, emitRaw() {},
  });
  let disposals = 0;
  (engine as any).managedServiceRuntime.disposeInstanceServices = async () => { disposals++; };
  return { db, engine, instance, sessions, calls, threadId, turnId, workspaceId, disposals: () => disposals, setActive(value: string | null) { active = value; } };
}

test("cancelAndWait 等待 provider 中断并保留同步终态序号", async t => {
  const f = fixture(t), interrupt = deferred<boolean>();
  f.sessions.interrupt = async () => await interrupt.promise;
  let settled = false;
  const waiting = f.engine.cancelAndWait(f.instance.id).then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const terminal = f.db.conversationEvents.listByThreadType(f.threadId, "turn.error", { limit: 10 });
  assert.equal(terminal.length, 1);
  assert.equal(f.db.turns.get(f.turnId)?.endEventSeq, terminal[0].seq);
  interrupt.resolve(true);
  await waiting;
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
});

test("cancelAndWait 传播 provider 失败而非用本地终态伪造成功", async t => {
  const f = fixture(t), failure = new Error("provider interruption failed");
  f.sessions.interrupt = async () => { throw failure; };
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
});

test("同步 cancel 后并发等待复用同次中断", async t => {
  const f = fixture(t), interrupt = deferred<boolean>();
  let interruptions = 0, completions = 0;
  f.sessions.interrupt = async () => { interruptions++; return await interrupt.promise; };
  f.engine.cancel(f.instance.id);
  const first = f.engine.cancelAndWait(f.instance.id).then(() => { completions++; });
  const second = f.engine.cancelAndWait(f.instance.id).then(() => { completions++; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(interruptions, 1);
  assert.equal(completions, 0);
  interrupt.resolve(true);
  await Promise.all([first, second]);
  assert.equal(f.db.conversationEvents.listByThreadType(f.threadId, "turn.error", { limit: 10 }).length, 1);
});

test("cancelAndWait 保留协调器失败并等待活动节点收口", async t => {
  const f = fixture(t), drive = deferred<void>(), node = deferred<{ nodeId: string; error: unknown }>();
  const failure = new Error("coordinator failed");
  (f.engine as any).runningInstances.set(f.instance.id, { cancelled: false, paused: false, runId: "update-run",
    drivePromise: drive.promise, activeNodePromises: new Map([["role", node.promise]]) });
  let settled = false;
  const waiting = f.engine.cancelAndWait(f.instance.id).finally(() => { settled = true; });
  const rejected = assert.rejects(waiting, error => error === failure);
  drive.reject(failure);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  node.resolve({ nodeId: "role", error: null });
  await rejected;
});

test("真实协调器取消后失败保持 cancelled 并拒绝等待入口", async t => {
  const f = fixture(t), execution = deferred<void>(), entered = deferred<void>();
  const failure = new Error("cancelled coordinator failed");
  const state = { cancelled: false, paused: false, runId: "update-run", drivePromise: null, activeNodePromises: new Map() };
  (f.engine as any).runningInstances.set(f.instance.id, state);
  (f.engine as any).executeDAG = async () => { entered.resolve(); await execution.promise; };
  const driving = (f.engine as any).startCoordinator(f.instance.id, state) as Promise<void>;
  const rejectedDrive = assert.rejects(driving, error => error === failure);
  await entered.promise;
  const waiting = assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  execution.reject(failure);
  await Promise.all([waiting, rejectedDrive]);
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
});

test("真实协调器取消后的执行错误和 finally 清理错误全部保留", async t => {
  const f = fixture(t), execution = deferred<void>(), entered = deferred<void>();
  const secret = "test-double-failure-secret";
  const root = new Error(`UNIQUE_EXECUTION_ROOT_091 token=${secret}`, { cause: new Error(`NESTED_EXECUTION_CAUSE password=${secret}`) });
  const cleanup = new Error(`UNIQUE_CLEANUP_ROOT_092 apiKey=${secret}`);
  const log = mockLifecycleLog(t, f.db, () => {});
  const state = { cancelled: false, paused: false, runId: "update-run", drivePromise: null, activeNodePromises: new Map() };
  let disposals = 0;
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { if (++disposals === 2) throw cleanup; };
  (f.engine as any).runningInstances.set(f.instance.id, state);
  (f.engine as any).executeDAG = async () => { entered.resolve(); await execution.promise; };
  const driving = (f.engine as any).startCoordinator(f.instance.id, state) as Promise<void>;
  const includesBoth = (error: unknown): boolean => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [root, cleanup]);
    return true;
  };
  const rejectedDrive = assert.rejects(driving, includesBoth);
  await entered.promise;
  const waiting = assert.rejects(() => f.engine.cancelAndWait(f.instance.id, { requestId: "double-failure-request" }), includesBoth);
  execution.reject(root);
  await Promise.all([waiting, rejectedDrive]);
  assert.equal(log.mock.calls.length, 1);
  const context = log.mock.calls[0].arguments[2] as any;
  assert.equal(context.requestId, "double-failure-request");
  const logged = JSON.stringify(context.rootCause);
  assert.match(logged, /UNIQUE_EXECUTION_ROOT_091/);
  assert.match(logged, /UNIQUE_CLEANUP_ROOT_092/);
  assert.match(logged, /NESTED_EXECUTION_CAUSE/);
  assert.match(logged, /REDACTED/);
  assert.equal(logged.includes(secret), false);
});

test("provider 与资源同时失败保留全部根因", async t => {
  const f = fixture(t), provider = new Error("provider failed"), resource = new Error("resource failed");
  f.sessions.interrupt = async () => { throw provider; };
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { throw resource; };
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [provider, resource]);
    return true;
  });
});

test("取消失败只记录一次脱敏根因与请求及 turn 归属", async t => {
  const f = fixture(t);
  const secret = "test-secret-no-log";
  const failure = new Error(`provider token=${secret}`);
  f.sessions.interrupt = async () => { throw failure; };
  const log = mockLifecycleLog(t, f.db, () => {});
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id, { requestId: "update-request" }), error => error === failure);
  assert.equal(log.mock.calls.length, 1);
  const context = log.mock.calls[0].arguments[2] as any;
  assert.equal(context.code, "ORCHESTRATION_CANCEL_FAILED");
  assert.equal(context.requestId, "update-request");
  assert.equal(context.instanceId, f.instance.id);
  assert.equal(context.workspaceId, f.workspaceId);
  assert.equal(context.rootCause[0].threadId, f.threadId);
  assert.equal(context.rootCause[0].turnId, f.turnId);
  assert.equal(JSON.stringify(context).includes(secret), false);
  assert.match(context.rootCause[0].message, /REDACTED/);
});

test("取消日志对循环 cause 和过大聚合有界展开，原错误仍完整返回", async t => {
  const f = fixture(t), secret = "test-large-error-secret";
  const cycle = new Error(`cyclic token=${secret}`);
  cycle.cause = cycle;
  const errors = Array.from({ length: 100 }, (_, index) => new Error(`failure-${index} password=${secret}`));
  const failure = new AggregateError([cycle, ...errors], "wide aggregation");
  failure.cause = cycle;
  f.sessions.interrupt = async () => { throw failure; };
  const log = mockLifecycleLog(t, f.db, () => {});
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  const context = log.mock.calls[0].arguments[2] as any;
  const logged = JSON.stringify(context.rootCause);
  assert.equal(logged.includes(secret), false);
  assert.equal(logged.includes("failure-99"), false);
  assert.ok(logged.length < 20_000);
  assert.equal(failure.errors.length, 101);
  assert.equal(cycle.cause, cycle);
});

test("一项中断失败仍等待另一活跃节点完成并保留其结果", async t => {
  const f = fixture(t), gate = deferred<boolean>(), failure = new Error("role interruption failed");
  const gateThreadId = "gate-update-interrupt", gateTurnId = "gate-turn-update-interrupt";
  f.db.threads.create({ id: gateThreadId, workspaceId: f.workspaceId, engine: "codex", title: "Gate", threadType: "orchestration" });
  f.db.turns.insertStarted({ workspaceId: f.workspaceId, threadId: gateThreadId, engine: "codex", turnId: gateTurnId, startedAt: Date.now(), startEventSeq: 2 });
  f.instance.nodeStates.role.activeGateEvaluation = { evaluationRunId: "gate-run", evaluationCallId: "gate-call", retryOrdinal: 0, statusVersion: 1,
    artifactId: "artifact", nodeAttemptId: "attempt", threadId: gateThreadId, turnId: gateTurnId, promptSnapshotId: "snapshot", startedAt: Date.now() };
  f.db.orchInstances.updateNodeStates(f.instance.id, f.instance.nodeStates);
  f.sessions.interrupt = async (threadId: string) => { if (threadId === f.threadId) throw failure; return await gate.promise; };
  let settled = false;
  const waiting = f.engine.cancelAndWait(f.instance.id).finally(() => { settled = true; });
  const rejected = assert.rejects(waiting, error => error === failure);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve(true);
  await rejected;
});

test("同步终态写入失败仍等待已发出的中断并原样失败", async t => {
  const f = fixture(t), interrupt = deferred<boolean>(), failure = new Error("terminal persistence failed");
  f.sessions.interrupt = async () => await interrupt.promise;
  (f.engine as any).ctx.emitConversation = () => { throw failure; };
  let settled = false;
  const waiting = f.engine.cancelAndWait(f.instance.id).finally(() => { settled = true; });
  const rejected = assert.rejects(waiting, error => error === failure);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  interrupt.resolve(true);
  await rejected;
  assert.equal(f.db.turns.get(f.turnId)?.status, "started");
});

test("同步终态写入失败由并发取消等待及统一排空共同观察", async t => {
  const f = fixture(t), interrupt = deferred<boolean>(), failure = new Error("sync-terminal-persist-failure");
  f.sessions.interrupt = async () => await interrupt.promise;
  (f.engine as any).ctx.emitConversation = () => { throw failure; };
  const first = assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  const second = assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  const drained = assert.rejects(() => f.engine.stopAndDrain(), error => error === failure);
  interrupt.resolve(true);
  await Promise.all([first, second, drained]);
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "running");
  assert.equal(f.db.turns.get(f.turnId)?.status, "started");
  assert.equal(f.disposals(), 0);
});

test("cancelAndWait 传播活动节点 settlement 内的错误", async t => {
  const f = fixture(t), failure = new Error("node failed");
  (f.engine as any).runningInstances.set(f.instance.id, { cancelled: false, paused: false, runId: "update-run", drivePromise: null,
    activeNodePromises: new Map([["role", Promise.resolve({ nodeId: "role", error: failure })]]) });
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
});

test("cancelAndWait 不以第二次服务清理掩盖首次失败", async t => {
  const f = fixture(t), failure = new Error("service disposal failed");
  let attempts = 0;
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { if (++attempts === 1) throw failure; };
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  assert.equal(attempts, 1);
});

test("同步 cancel 的失败仍由统一排空显式报告", async t => {
  const f = fixture(t), failure = new Error("background interruption failed");
  f.sessions.interrupt = async () => { throw failure; };
  f.engine.cancel(f.instance.id);
  await assert.rejects(() => f.engine.stopAndDrain(), error => error === failure);
});

test("取消等待与统一排空并发时都报告同一失败", async t => {
  const f = fixture(t), interrupt = deferred<boolean>(), failure = new Error("parallel interruption failed");
  f.sessions.interrupt = async () => await interrupt.promise;
  const cancelled = assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  const drained = assert.rejects(() => f.engine.stopAndDrain(), error => error === failure);
  interrupt.reject(failure);
  await Promise.all([cancelled, drained]);
});

test("同步 cancel 失败后再次取消会重试，仍在途的重复调用不会重复派发", async t => {
  const f = fixture(t), failure = new Error("first synchronous interruption failed"), retry = deferred<boolean>();
  let attempts = 0;
  f.sessions.interrupt = async () => {
    if (++attempts === 1) throw failure;
    const result = await retry.promise;
    f.setActive(null);
    return result;
  };
  const log = mockLifecycleLog(t, f.db, () => {});
  f.engine.cancel(f.instance.id, { requestId: "first-cancel" });
  await new Promise<void>(resolve => setImmediate(resolve));
  f.engine.cancel(f.instance.id, { requestId: "retry-cancel" });
  f.engine.cancel(f.instance.id, { requestId: "duplicate-retry" });
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
  assert.equal(attempts, 1, "同步取消只记录终态，provider 派发必须等数据库许可释放");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(log.mock.calls.length, 1);
  assert.equal((log.mock.calls[0].arguments[2] as any).requestId, "first-cancel");
  retry.resolve(true);
  await f.engine.cancelAndWait(f.instance.id);
  await f.engine.stopAndDrain();
  assert.equal(f.sessions.getActiveTurnId(), null);
  assert.equal(f.db.conversationEvents.listByThreadType(f.threadId, "turn.error", { limit: 10 }).length, 1);
});

test("严格等待先消费已失败的同步取消，再由下一次调用显式重试", async t => {
  const f = fixture(t), failure = new Error("stored cancellation failure");
  let attempts = 0;
  f.sessions.interrupt = async () => {
    if (++attempts === 1) throw failure;
    f.setActive(null);
    return true;
  };
  f.engine.cancel(f.instance.id);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  assert.equal(attempts, 1);
  await f.engine.cancelAndWait(f.instance.id);
  assert.equal(attempts, 2);
  await f.engine.stopAndDrain();
});

test("中断失败后重试使用真实活跃 turn 而非已结束的 SQLite 索引", async t => {
  const f = fixture(t), failure = new Error("first interruption failed");
  let attempts = 0;
  f.sessions.interrupt = async () => {
    if (++attempts === 1) throw failure;
    f.setActive(null);
    return true;
  };
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  await f.engine.cancelAndWait(f.instance.id);
  assert.equal(attempts, 2);
  assert.equal(f.db.conversationEvents.listByThreadType(f.threadId, "turn.error", { limit: 10 }).length, 1);
});

test("无目标活跃 session 的 false 可收口，仍有活跃 turn 则明确失败", async t => {
  const f = fixture(t);
  f.sessions.interrupt = async () => false;
  await assert.rejects(() => f.engine.cancelAndWait(f.instance.id), { code: "ORCHESTRATION_INTERRUPT_UNCONFIRMED" });
  f.setActive(null);
  await f.engine.cancelAndWait(f.instance.id);
});

test("无 live 目标的 false 只收口本地取消，不代表 detached provider 已结束", async t => {
  const f = fixture(t);
  f.setActive(null);
  f.sessions.interrupt = async () => false;
  await f.engine.cancelAndWait(f.instance.id);
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
});

for (const status of ["waiting-approval", "paused"] as const) test(`cancelAndWait 取消 ${status} 并保持重复调用幂等`, async t => {
  const f = fixture(t, status);
  await f.engine.cancelAndWait(f.instance.id);
  await f.engine.cancelAndWait(f.instance.id);
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
  assert.equal(f.db.turns.get(f.turnId)?.status, "error");
  assert.equal(f.db.conversationEvents.listByThreadType(f.threadId, "turn.error", { limit: 10 }).length, 1);
});

/** 使用真实实例、节点仓储与协调器，仅控制生命周期的准入回调。 */
function admissionFixture(t: TestContext) {
  const f = fixture(t);
  f.setActive(null);
  f.db.turns.setEnded(f.turnId, { status: "completed", endedAt: Date.now(), endEventSeq: null });
  const workflow = { ...f.instance.workflowSnapshot, id: "workflow-update-admission",
      nodes: [
        { id: "first", type: "start" as const, label: "首节点", position: { x: 0, y: 0 } },
        { id: "next", type: "end" as const, label: "后续节点", position: { x: 1, y: 0 } },
      ], edges: [{ id: "first-next", sourceNodeId: "first", targetNodeId: "next", dataMappings: [] }] };
  const instance = f.db.orchInstances.create({
    workspaceId: f.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    assetRuntimeSnapshot: { authorityMode: "legacy", workflow: { assetType: "workflow", assetId: workflow.id, definition: workflow, source: null },
      roles: {}, knowledgeBundles: {}, toolsets: {}, skills: {} },
    intakeSnapshot: f.instance.intakeSnapshot,
  });
  f.db.orchInstances.updateStatus(instance.id, "running");
  const state = (f.engine as any).createRunState();
  (f.engine as any).runningInstances.set(instance.id, state);
  let paused = false, checks = 0;
  (f.engine as any).ctx.isTaskAdmissionPaused = () => { checks++; return paused; };
  return { ...f, instance, state, setPaused(value: boolean) { paused = value; }, checks: () => checks };
}

/** 等到真实异步边界被观察；超时明确失败，避免测试依赖固定执行速度。 */
async function waitForAdmission(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "未到达预期编排派发边界");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

/** 真实协调器先落 completed，仅在托管服务释放边界等待测试放行。 */
function disposalFixture(t: TestContext) {
  const f = admissionFixture(t), disposal = deferred<void>(), entered = deferred<void>();
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { entered.resolve(); await disposal.promise; };
  const driving = (f.engine as any).startCoordinator(f.instance.id, f.state) as Promise<void>;
  const result = Promise.allSettled([driving]);
  return { ...f, disposal, entered, driving, result };
}

test("真实协调器已写 completed 仍报告清理活动，只读等待完成后保持终态", async t => {
  const f = disposalFixture(t);
  try {
    await f.entered.promise;
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    assert.equal(f.engine.hasInFlightWork(), true);
    let settled = false;
    const waiting = f.engine.waitForInFlightWork({ requestId: "natural-disposal" }).then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal((f.engine as any).stopping, false);
    assert.equal(f.state.cancelled, false);
    assert.deepEqual(f.calls, []);
    f.disposal.resolve();
    await Promise.all([waiting, f.driving]);
    assert.equal(f.engine.hasInFlightWork(), false);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "next")?.status, "completed");
  } finally { f.disposal.resolve(); await f.result; }
});

for (const failure of [undefined, null, false, 0, -0, NaN, "", new Error("DISPOSAL_EXACT_FAILURE")]) {
  test(`只读等待原样传播真实协调器清理异常 ${String(failure)}`, async t => {
    const f = disposalFixture(t);
    try {
      await f.entered.promise;
      const waiting = Promise.allSettled([f.engine.waitForInFlightWork(), f.engine.waitForInFlightWork()]);
      f.disposal.reject(failure);
      for (const result of await waiting) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.equal(Object.is(result.reason, failure), true);
      }
      assert.equal(f.engine.hasInFlightWork(), false);
      assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    } finally { f.disposal.resolve(); await f.result; }
  });
}

test("只读等待清理超时保留原 owner，稍后仍可自然完成", async t => {
  const f = disposalFixture(t);
  mockLifecycleLog(t, f.db, () => {});
  try {
    await f.entered.promise;
    await assert.rejects(() => f.engine.waitForInFlightWork({ requestId: "disposal-timeout", timeoutMs: 10 }), {
      code: "ORCHESTRATION_IN_FLIGHT_WAIT_TIMEOUT", requestId: "disposal-timeout",
    });
    assert.equal(f.engine.hasInFlightWork(), true);
    assert.equal(f.state.drivePromise, f.driving);
    assert.equal((f.engine as any).stopping, false);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    f.disposal.resolve();
    await f.engine.waitForInFlightWork({ timeoutMs: 1_000 });
    assert.equal(f.engine.hasInFlightWork(), false);
  } finally { f.disposal.resolve(); await f.result; }
});

test("无异步 owner 时数据库仍 running 不构成只读活动", async t => {
  const f = fixture(t);
  assert.equal(f.engine.hasInFlightWork(), false);
  await f.engine.waitForInFlightWork();
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "running");
  assert.equal((f.engine as any).stopping, false);
});

test("已结算的后台启动失败不再触发活动确认，等待仍明确报告原失败", async t => {
  const f = admissionFixture(t), failure = new Error("BACKGROUND_DISPOSAL_FAILURE");
  mockLifecycleLog(t, f.db, () => {});
  (f.engine as any).runningInstances.delete(f.instance.id);
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { throw failure; };
  await f.engine.startInBackground(f.instance.id, "background-disposal");
  await waitForAdmission(() => f.db.orchInstances.get(f.instance.id)?.status === "completed");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.engine.hasInFlightWork(), false);
  await assert.rejects(() => f.engine.waitForInFlightWork(), error => error === failure);
  await f.engine.waitForInFlightWork();
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
});

test("只读等待收齐等待期间原 owner 派生的后台清理", async t => {
  const f = fixture(t), recovery = deferred<void>(), disposal = deferred<void>(), entered = deferred<void>();
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { entered.resolve(); await disposal.promise; };
  const recovering = recovery.promise.then(() => {
    (f.engine as any).disposeManagedRuntimeInBackground(f.instance.id, "owner-handoff");
  }).finally(() => { (f.engine as any).recoveryPromises.delete(f.instance.id); });
  (f.engine as any).recoveryPromises.set(f.instance.id, recovering);
  let settled = false;
  const waiting = f.engine.waitForInFlightWork().then(() => { settled = true; });
  try {
    recovery.resolve();
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.engine.hasInFlightWork(), true);
    disposal.resolve();
    await waiting;
    assert.equal(f.engine.hasInFlightWork(), false);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "running");
  } finally { recovery.resolve(); disposal.resolve(); await waiting; }
});

test("只读等待跨 owner 交接超时后仍保留已观察的失败", async t => {
  const f = admissionFixture(t), failure = new Error("FAILURE_BEFORE_OWNER_HANDOFF");
  const recovery = deferred<void>(), disposal = deferred<void>(), entered = deferred<void>();
  mockLifecycleLog(t, f.db, () => {});
  (f.engine as any).runningInstances.delete(f.instance.id);
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { throw failure; };
  await f.engine.startInBackground(f.instance.id, "handoff-failure");
  await waitForAdmission(() => f.db.orchInstances.get(f.instance.id)?.status === "completed");
  await new Promise<void>(resolve => setImmediate(resolve));
  const original = [...(f.engine as any).continuationPromises][0];
  assert.ok(original);
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { entered.resolve(); await disposal.promise; };
  const recovering = recovery.promise.then(() => {
    (f.engine as any).disposeManagedRuntimeInBackground(f.instance.id, "timeout-owner-handoff");
  }).finally(() => { (f.engine as any).recoveryPromises.delete(f.instance.id); });
  (f.engine as any).recoveryPromises.set(f.instance.id, recovering);
  const waiting = assert.rejects(() => f.engine.waitForInFlightWork({ timeoutMs: 20 }), { code: "ORCHESTRATION_IN_FLIGHT_WAIT_TIMEOUT" });
  try {
    recovery.resolve();
    await entered.promise;
    await waiting;
    assert.equal((f.engine as any).continuationPromises.has(original), true);
    assert.equal(f.engine.hasInFlightWork(), true);
    disposal.resolve();
    await assert.rejects(() => f.engine.waitForInFlightWork(), error => error === failure);
  } finally { recovery.resolve(); disposal.resolve(); await waiting; }
});

test("只读等待复用取消 owner 的内部拒绝，已失败 owner 不构成活动且不重发取消", async t => {
  const f = fixture(t), interrupt = deferred<boolean>(), failure = new Error("READ_ONLY_CANCELLATION_FAILURE");
  mockLifecycleLog(t, f.db, () => {});
  f.sessions.interrupt = async () => { f.calls.push("single-cancel"); return await interrupt.promise; };
  f.engine.cancel(f.instance.id);
  assert.equal(f.engine.hasInFlightWork(), true);
  const waiting = assert.rejects(() => f.engine.waitForInFlightWork(), error => error === failure);
  interrupt.reject(failure);
  await waiting;
  assert.equal(f.engine.hasInFlightWork(), false);
  assert.deepEqual(f.calls, ["single-cancel"]);
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
});

test("已失败的同步取消无需再次活动确认，等待仍读取其失败", async t => {
  const f = fixture(t), failure = new Error("SETTLED_CANCELLATION_FAILURE");
  mockLifecycleLog(t, f.db, () => {});
  f.sessions.interrupt = async () => { throw failure; };
  f.engine.cancel(f.instance.id);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.engine.hasInFlightWork(), false);
  await assert.rejects(() => f.engine.waitForInFlightWork(), error => error === failure);
  await f.engine.waitForInFlightWork();
});

test("更新询问在首次派发前冻结协调器，稍后沿原 owner 恢复", async t => {
  const f = admissionFixture(t);
  f.setPaused(true);
  let settled = false;
  const driving = (f.engine as any).startCoordinator(f.instance.id, f.state).then(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "running");
    assert.equal(f.db.orchInstances.get(f.instance.id)?.nodeStates.first.status, "pending");
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "first"), null);
    assert.equal(f.state.paused, false);
    f.setPaused(false);
    await driving;
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    assert.equal(f.db.orchInstances.get(f.instance.id)?.nodeStates.next.status, "completed");
    assert.equal(f.state.activeNodePromises.size, 0);
  } finally { f.setPaused(false); await driving; }
});

test("更新冻结不阻止已派发节点自然结束，也不抢先派发后继或完成实例", async t => {
  const f = admissionFixture(t), current = deferred<void>(), entered = deferred<void>();
  const original = (f.engine as any).executeNode.bind(f.engine);
  (f.engine as any).executeNode = async (id: string, node: any, instance: any) => {
    if (node.id === "first") { entered.resolve(); await current.promise; }
    await original(id, node, instance);
  };
  let settled = false;
  const driving = (f.engine as any).startCoordinator(f.instance.id, f.state).then(() => { settled = true; });
  try {
    await entered.promise;
    f.setPaused(true);
    current.resolve();
    await waitForAdmission(() => f.db.orchInstances.get(f.instance.id)?.nodeStates.first.status === "completed");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.nodeStates.next.status, "pending");
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "running");
    f.setPaused(false);
    await driving;
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
  } finally { current.resolve(); f.setPaused(false); await driving; }
});

test("更新冻结中的确认取消结束原协调器，不落失败或误完成", async t => {
  const f = admissionFixture(t);
  f.setPaused(true);
  const driving = (f.engine as any).startCoordinator(f.instance.id, f.state);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.engine.cancelAndWait(f.instance.id);
    await driving;
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
    assert.equal(f.db.orchInstances.get(f.instance.id)?.nodeStates.next.status, "pending");
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "next"), null);
  } finally { f.setPaused(false); await driving; }
});

test("更新冻结时最终节点自然结束，必要清理后无需解除准入即可完成一次", async t => {
  const f = admissionFixture(t), current = deferred<void>(), entered = deferred<void>(), cleanup = deferred<void>(), cleanupEntered = deferred<void>();
  const order: string[] = [];
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { cleanupEntered.resolve(); await cleanup.promise; order.push("cleanup"); };
  (f.engine as any).ctx.emitOrchestration = (_workspaceId: string, event: { type: string }) => { if (event.type === "orchestration.completed") order.push("completed"); };
  const original = (f.engine as any).executeNode.bind(f.engine);
  (f.engine as any).executeNode = async (id: string, node: any, instance: any) => {
    if (node.id === "next") { entered.resolve(); await current.promise; }
    await original(id, node, instance);
  };
  let settled = false;
  const driving = (f.engine as any).startCoordinator(f.instance.id, f.state).then(() => { settled = true; });
  try {
    await entered.promise;
    f.setPaused(true);
    current.resolve();
    await waitForAdmission(() => f.db.orchInstances.get(f.instance.id)?.nodeStates.next.status === "completed");
    await cleanupEntered.promise;
    assert.equal(settled, false);
    assert.equal(f.engine.hasInFlightWork(), true);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    const attempt = f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "next");
    assert.equal(attempt?.status, "completed");
    assert.equal(f.db.orchEvents.listByInstance(f.instance.id).some(event => event.type === "orchestration.completed"), false);
    cleanup.resolve();
    await driving;
    assert.equal(settled, true);
    assert.equal(f.engine.hasInFlightWork(), false);
    assert.deepEqual(order, ["cleanup", "completed"]);
    await f.engine.waitForInFlightWork();
    f.setPaused(false);
    await f.engine.waitForInFlightWork();
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "next")?.id, attempt?.id);
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "first")?.attemptNo, 1);
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "next")?.attemptNo, 1);
    assert.equal(f.db.orchEvents.listByInstance(f.instance.id).filter(event => event.type === "orchestration.completed").length, 1);
  } finally { current.resolve(); cleanup.resolve(); f.setPaused(false); await driving; }
});

/** 公开启动真实最终角色，仅在 provider 与必要资源清理出口设置屏障。 */
function publicCompletionUpdateFixture(t: TestContext) {
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] });
  t.after(() => resetEngineModelCatalogRuntimeForTest());
  const f = fixture(t), provider = deferred<void>(), providerEntered = deferred<void>(), cleanup = deferred<void>(), cleanupEntered = deferred<void>();
  f.setActive(null);
  f.db.turns.setEnded(f.turnId, { status: "completed", endedAt: Date.now(), endEventSeq: null });
  const executionConfig = createDefaultRoleExecutionConfig("codex");
  executionConfig.engineProfiles.codex.mode = "custom";
  executionConfig.engineProfiles.codex.customConfig = { ...createDefaultRoleExecutionCustomConfig("codex"), model: "gpt-5.5", effort: "medium", accessMode: "read-only", maxRetries: 0 };
  const role = { id: "role-update-interrupt", workspaceId: f.workspaceId, name: "更新完成", description: "更新完成", responsibility: "交付结果",
    systemPrompt: "完成当前任务", inputDefinition: { instructions: "任务={{requirement}}", requiredFields: [] },
    outputDefinition: { instructions: "返回结果", deliveryMode: "direct" as const, format: "markdown" as const, resultKey: null, filePathRule: null, requiredFields: [] },
    gateCriteria: [], executionConfig, defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom" as const };
  f.db.orchInstances.delete(f.instance.id);
  const workflow = { ...f.instance.workflowSnapshot,
    nodes: [{ id: "start", type: "start" as const, label: "开始", position: { x: 0, y: 0 } }, ...f.instance.workflowSnapshot.nodes],
    edges: [{ id: "start-role", sourceNodeId: "start", targetNodeId: "role", dataMappings: [] }] };
  f.instance = f.db.orchInstances.create({ workspaceId: f.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: f.instance.intakeSnapshot, assetRuntimeSnapshot: { authorityMode: "legacy",
      workflow: { assetType: "workflow", assetId: workflow.id, definition: workflow, source: null },
      roles: { [role.id]: { assetType: "role", assetId: role.id, definition: role, source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 } } },
      knowledgeBundles: {}, toolsets: {}, skills: {} } });
  let paused = false, sends = 0;
  const order: string[] = [], resumes: string[] = [];
  Object.assign(f.sessions, {
    /** 此 provider 夹具不启动引擎托管服务；查询仍经真实 engine/control。 */
    listEngineManagedServices() { return []; },
    getOrCreate: () => ({
      resolvePlatformToolTransport() { return "native-dynamic"; },
      async sendMessage(input: SendMessageInput) {
        sends++; f.setActive(input.turnId); providerEntered.resolve();
        try {
          await provider.promise;
          assert.ok(input.executeHostTool);
          const submitted = await input.executeHostTool({ toolId: "runtime.submitNodeResult", accessMode: "read-only", toolInput: {
            answer: { mode: "text", text: "已完成" }, control: { nextAction: "continue", reason: "已完成" },
            review: { verdict: "pass", summary: "已完成", blockingIssues: [] }, acceptanceChecks: null, humanInput: null, rework: null,
          } });
          assert.equal(submitted.ok, true, JSON.stringify(submitted));
          return { responseText: "已完成" };
        } finally { f.setActive(null); }
      },
      async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
    }),
  });
  (f.engine as any).ctx.isTaskAdmissionPaused = () => paused;
  (f.engine as any).ctx.emitOrchestration = (_workspaceId: string, event: { type: string }) => { if (event.type === "orchestration.completed") order.push("completed"); };
  const runtime = (f.engine as any).managedServiceRuntime, dispose = runtime.disposeInstanceServices.bind(runtime);
  t.mock.method(runtime, "disposeInstanceServices", async (id: string) => { cleanupEntered.resolve(); await cleanup.promise; await dispose(id); order.push("cleanup"); });
  const context = { db: f.db, workspaces: (f.engine as any).ctx.workspaces, orchEngine: f.engine, sessions: f.sessions,
    isTaskAdmissionPaused: () => paused, controlledExperiments: { hasInFlightWork: () => false, stopForUpdate: async () => {} },
  } as unknown as Parameters<typeof createDesktopUpdateControl>[0]["context"];
  const control = createDesktopUpdateControl({ context, requestId: "natural-completion-update", timeoutMs: 2_000,
    queueDispatcher: { hasInFlightWork: () => false, assertNoFailure() {}, resumeWorkspace: id => { resumes.push(`queue:${id}`); } },
    scheduledTaskScheduler: { hasInFlightWork: () => false, beginUpdateStop() {}, async stopForUpdate() {}, resumeAfterUpdate() { resumes.push("scheduler"); } },
    terminalManager: { hasRunningTerminals: () => false, async stopAllForUpdate() {} },
    hasBlockingTransaction: () => false, hasKnowledgeWork: () => false, async stopKnowledgeWork() {},
    hasAssetDraftWork: () => false, async stopAssetDraftWork() {},
    async interruptTurn() { assert.fail("自然完成的 turn 不应被再次中断"); },
  });
  return { ...f, provider, providerEntered, cleanup, cleanupEntered, control, order, resumes, sends: () => sends,
    /** 复用生命周期提供的准入事实，不改变流程暂停或取消状态。 */
    setPaused(value: boolean) { paused = value; } };
}

for (const choice of ["确认", "稍后"] as const) test(`公开启动最终角色在更新冻结中自然完成，${choice}沿真实 control 收口且排空后空闲`, { timeout: 10_000 }, async t => {
  const f = publicCompletionUpdateFixture(t);
  let settled = false;
  const starting = choice === "确认" ? f.engine.start(f.instance.id).then(() => { settled = true; })
    : f.engine.startInBackground(f.instance.id, "natural-completion-background");
  try {
    await f.providerEntered.promise;
    f.setPaused(true);
    assert.deepEqual(await f.control.prepare(), { hasRunningSessions: true });
    f.provider.resolve();
    await f.cleanupEntered.promise;
    if (choice === "稍后") await starting;
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    const attempt = f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "role");
    assert.ok(attempt);
    assert.equal(attempt?.status, "completed");
    assert.equal(f.engine.hasInFlightWork(), true);
    assert.deepEqual(await f.control.prepare(), { hasRunningSessions: true });
    assert.equal(settled, false);
    assert.deepEqual(f.order, []);
    assert.equal(f.db.orchEvents.listByInstance(f.instance.id).filter(event => event.type === "orchestration.completed").length, 0);
    let interrupted = false;
    const stopping = choice === "确认" ? f.control.interrupt().then(() => { interrupted = true; }) : Promise.resolve();
    if (choice === "确认") {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(interrupted, false);
      assert.equal(f.engine.hasInFlightWork(), true);
    }
    f.cleanup.resolve();
    await Promise.all([starting, stopping, f.engine.waitForInFlightWork()]);
    assert.deepEqual(f.order, ["cleanup", "completed"]);
    assert.equal(f.engine.hasInFlightWork(), false);
    assert.deepEqual(await f.control.prepare(), { hasRunningSessions: false });
    f.setPaused(false);
    await f.control.resume();
    await f.engine.waitForInFlightWork();
    assert.deepEqual(f.resumes, [`queue:${f.workspaceId}`, "scheduler"]);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "role")?.id, attempt?.id);
    assert.equal(attempt?.attemptNo, 1);
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "start")?.attemptNo, 1);
    assert.equal(f.sends(), 1);
    assert.equal(f.disposals(), 1);
    assert.equal(f.db.turns.listRunning().length, 0);
    assert.deepEqual(f.calls, []);
    const events = f.db.orchEvents.listByInstance(f.instance.id);
    assert.equal(events.filter(event => event.type === "orchestration.started").length, 1);
    assert.equal(events.filter(event => event.type === "orchestration.completed").length, 1);
    assert.equal(events.some(event => event.type === "orchestration.cancelled" || event.type === "orchestration.resumed"), false);
  } finally {
    f.provider.resolve(); f.cleanup.resolve(); f.setPaused(false);
    await starting;
    await f.engine.waitForInFlightWork();
  }
});

test("更新冻结期间活动节点失败仍使原协调器明确失败", async t => {
  const f = admissionFixture(t), current = deferred<void>(), entered = deferred<void>();
  const failure = new Error("ACTIVE_NODE_DURING_UPDATE_FAILED");
  (f.engine as any).executeNode = async () => { entered.resolve(); await current.promise; throw failure; };
  const log = mockLifecycleLog(t, f.db, () => {});
  const driving = (f.engine as any).startCoordinator(f.instance.id, f.state);
  try {
    await entered.promise;
    f.setPaused(true);
    current.resolve();
    await waitForAdmission(() => log.mock.calls.some(call => (call.arguments[2] as any)?.rootCause?.message === failure.message));
    assert.equal(f.db.orchEvents.listByInstance(f.instance.id).some(event => event.type === "orchestration.error" && event.payloadJson.includes(failure.message)), true);
    await driving;
    assert.equal(f.state.activeNodePromises.size, 0);
  } finally { current.resolve(); f.setPaused(false); await driving; }
});

test("原协调器普通唤醒竞争也不会丢失活动节点失败", async t => {
  const f = admissionFixture(t), current = deferred<void>(), entered = deferred<void>();
  const failure = new Error("ACTIVE_NODE_WAKE_FAILED");
  (f.engine as any).executeNode = async () => { entered.resolve(); await current.promise; throw failure; };
  const log = mockLifecycleLog(t, f.db, () => {});
  const driving = (f.engine as any).startCoordinator(f.instance.id, f.state);
  await entered.promise;
  current.resolve();
  await driving;
  assert.equal(log.mock.calls.some(call => (call.arguments[2] as any)?.rootCause?.message === failure.message), true);
  assert.equal(f.state.activeNodePromises.size, 0);
});

test("更新待消费的失败结算由并发取消和停止共同报告，不留下节点 owner", async t => {
  const f = admissionFixture(t), failure = new Error("SETTLED_NODE_CANCEL_STOP_FAILED");
  mockLifecycleLog(t, f.db, () => {});
  (f.engine as any).executeNode = async () => { throw failure; };
  assert.equal((f.engine as any).launchReadyNodes(f.instance.id, f.db.orchInstances.get(f.instance.id), f.state), 1);
  const node = f.state.activeNodePromises.get("first");
  assert.equal((await node).error, failure);
  const cancelled = assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  const repeated = assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  const drained = assert.rejects(() => f.engine.stopAndDrain(), error => error === failure);
  await Promise.all([cancelled, repeated, drained]);
  assert.equal(f.state.activeNodePromises.size, 0);
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
});

test("更新待消费的失败结算仅停止时也明确报告并清理原活动 Map", async t => {
  const f = admissionFixture(t), failure = new Error("SETTLED_NODE_STOP_FAILED");
  (f.engine as any).executeNode = async () => { throw failure; };
  assert.equal((f.engine as any).launchReadyNodes(f.instance.id, f.db.orchInstances.get(f.instance.id), f.state), 1);
  const node = f.state.activeNodePromises.get("first");
  assert.equal((await node).error, failure);
  await assert.rejects(() => f.engine.stopAndDrain(), error => error === failure);
  assert.equal(f.state.activeNodePromises.size, 0);
});

const settlementFailures: Array<[string, unknown]> = [["undefined", undefined], ["null", null], ["NaN", NaN], ["negative-zero", -0],
  ["false", false], ["zero", 0], ["empty", ""], ["Error", new Error("EXACT_NODE_FAILURE")]];
for (const [label, failure] of settlementFailures) for (const mode of ["normal", "frozen", "cancel", "stop", "wait"] as const) {
  test(`活动节点 ${label} 异常由 ${mode} 精确消费，不因假值漏判或残留`, async t => {
    const f = admissionFixture(t);
    mockLifecycleLog(t, f.db, () => {});
    (f.engine as any).executeNode = async () => { throw failure; };
    assert.equal((f.engine as any).launchReadyNodes(f.instance.id, f.db.orchInstances.get(f.instance.id), f.state), 1);
    const pending = f.state.activeNodePromises.get("first");
    try {
      const settlement = await pending;
      assert.equal(settlement.failed, true, "失败判别必须独立于异常值");
      assert.equal(Object.is(settlement.error, failure), true);
      if (mode === "wait") assert.equal(f.engine.hasInFlightWork(), false);
      f.setPaused(mode === "frozen");
      const operation = mode === "cancel" ? f.engine.cancelAndWait(f.instance.id)
        : mode === "stop" ? f.engine.stopAndDrain()
        : mode === "wait" ? f.engine.waitForInFlightWork()
        : (f.engine as any).executeReadyNodeBatches(f.instance.id, f.state.runId, { resolveIdleOutcome: true });
      const repeated = mode === "cancel" ? f.engine.cancelAndWait(f.instance.id) : operation;
      for (const result of await Promise.all([operation, repeated].map(value => Promise.resolve(value).then(
        () => ({ status: "fulfilled" as const }), reason => ({ status: "rejected" as const, reason }))))) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.equal(Object.is(result.reason, failure), true);
      }
      assert.equal(f.state.activeNodePromises.size, 0);
    } finally { f.setPaused(false); f.state.activeNodePromises.clear(); }
  });
}

test("更新等待中停止与取消先到时仍等待活动节点失败后明确收口", async t => {
  const f = admissionFixture(t), current = deferred<void>(), entered = deferred<void>();
  const failure = new Error("RUNNING_NODE_CANCEL_STOP_FAILED");
  mockLifecycleLog(t, f.db, () => {});
  (f.engine as any).executeNode = async () => { entered.resolve(); await current.promise; throw failure; };
  assert.equal((f.engine as any).launchReadyNodes(f.instance.id, f.db.orchInstances.get(f.instance.id), f.state), 1);
  await entered.promise;
  const cancelled = assert.rejects(() => f.engine.cancelAndWait(f.instance.id), error => error === failure);
  const drained = assert.rejects(() => f.engine.stopAndDrain(), error => error === failure);
  current.resolve();
  await Promise.all([cancelled, drained]);
  assert.equal(f.state.activeNodePromises.size, 0);
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
});

test("更新冻结的就绪认领入口不创建 Attempt，取消优先于准入回调", async t => {
  const f = admissionFixture(t);
  f.setPaused(true);
  assert.equal((f.engine as any).launchReadyNodes(f.instance.id, f.instance, f.state), 0);
  assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "first"), null);
  await f.engine.cancelAndWait(f.instance.id);
  (f.engine as any).ctx.isTaskAdmissionPaused = () => { throw new Error("CANCELLED_OWNER_MUST_NOT_WAIT"); };
  await (f.engine as any).executeReadyNodeBatches(f.instance.id, f.state.runId, { resolveIdleOutcome: true });
  assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
});

test("更新冻结前已经在异步准备中的启动，不绕过后续派发围栏", async t => {
  const f = admissionFixture(t), prepared = deferred<void>(), entered = deferred<void>();
  (f.engine as any).runningInstances.delete(f.instance.id);
  const prepare = (f.engine as any).ensureAssetRuntimeSnapshotForExecution.bind(f.engine);
  (f.engine as any).ensureAssetRuntimeSnapshotForExecution = async (id: string) => {
    entered.resolve(); await prepared.promise; return await prepare(id);
  };
  let settled = false;
  const starting = f.engine.start(f.instance.id).then(() => { settled = true; });
  try {
    await entered.promise;
    f.setPaused(true);
    prepared.resolve();
    await waitForAdmission(() => f.checks() > 0);
    assert.equal(settled, false);
    assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "first"), null);
    f.setPaused(false);
    await starting;
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "completed");
  } finally { prepared.resolve(); f.setPaused(false); await starting; }
});

/** 模型发送由测试控制，节点 Attempt、快照与 canonical turn 仍使用真实仓储。 */
function modelAdmissionFixture(t: TestContext, send: (turn: number) => Promise<{ responseText: string }>) {
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] });
  t.after(() => resetEngineModelCatalogRuntimeForTest());
  const f = fixture(t);
  f.setActive(null);
  f.db.turns.setEnded(f.turnId, { status: "completed", endedAt: Date.now(), endEventSeq: null });
  const node = f.instance.workflowSnapshot.nodes[0];
  const attempt = f.db.orchNodeAttempts.begin({ instanceId: f.instance.id, nodeId: node.id });
  Object.assign(f.instance.nodeStates[node.id], { attemptId: attempt.id, nodeExecutionId: attempt.id, attemptNo: attempt.attemptNo });
  f.db.orchInstances.updateNodeStates(f.instance.id, f.instance.nodeStates);
  let paused = false, checks = 0;
  const sent: string[] = [];
  (f.engine as any).ctx.isTaskAdmissionPaused = () => { checks++; return paused; };
  (f.engine as any).ctx.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport() { return "native-dynamic"; },
    async sendMessage(input: { turnId: string }) {
      sent.push(input.turnId);
      f.setActive(input.turnId);
      try { return await send(sent.length); } finally { f.setActive(null); }
    },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
  });
  const outputDefinition = { deliveryMode: "direct", format: "markdown", instructions: "返回处理结果", requiredFields: [] };
  const envelope: any = {
    schemaVersion: "node-prompt-envelope/v1",
    meta: { scene: "orchestration-node", instanceId: f.instance.id, workflowId: f.instance.workflowId, workflowName: "更新派发",
      nodeId: node.id, nodeLabel: node.label, intent: "execute", roleExecutionRevision: null },
    role: { roleId: node.roleId, name: "更新角色", description: null, responsibility: "处理任务", systemPrompt: null,
      formalTemplateName: null, inputDefinition: { instructions: "", requiredFields: [] }, outputDefinition },
    task: { title: "更新任务", titlePathSegment: "update-task", goal: "更新派发验证", background: null, acceptanceCriteria: null,
      renderedTaskInput: "处理任务", fieldBindings: {} },
    artifacts: { upstreamArtifacts: [] }, knowledge: { catalogs: [], warnings: [] },
    review: { feedbackPatch: null, latestFeedbackPatch: null, latestAction: null },
    runtime: { runtimePolicy: { workflowId: f.instance.workflowId, workflowName: "更新派发", nodeId: node.id, nodeLabel: node.label,
      approvalMode: "auto", accessMode: "read-only", toolRuntimePolicy: { allowedToolIds: [], requiresWorkspaceWrite: false },
      artifactPolicy: { persistenceMode: "db-only", outputMode: "text", primaryKind: "text" } }, toolRegistry: null, executionProfiles: [] },
  };
  const prompt = { ...new XmlNodePromptRenderer().render(envelope), promptEnvelope: envelope,
    snapshots: { toolRegistry: null, runtimePolicy: envelope.runtime.runtimePolicy, knowledgeCatalogs: [], knowledgeWarnings: [],
      artifactInput: { artifacts: [], fieldBindings: {} } } };
  return { ...f, attempt, node, sent, setPaused(value: boolean) { paused = value; }, checks: () => checks,
    execute: () => (f.engine as any).executeSubThread(f.instance, node, { outputDefinition }, prompt,
      { engine: "codex", model: null, effort: null, accessMode: "read-only", autoCompactPct: null, contextWindow: null, serviceTier: null }, {}, [], attempt.id) as Promise<unknown> };
}

test("模型首次派发在更新冻结时不创建 turn，稍后继续原 Attempt", async t => {
  const stop = new Error("MODEL_SEND_AFTER_RESUME");
  const f = modelAdmissionFixture(t, async () => { throw stop; });
  f.setPaused(true);
  const execution = f.execute();
  const rejected = assert.rejects(execution, error => error === stop);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, 0);
    assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
    assert.equal(f.db.orchNodeAttempts.get(f.attempt.id)?.turnId, null);
    f.setPaused(false);
    await rejected;
    assert.equal(f.sent.length, 1);
    assert.equal(f.db.orchNodeAttempts.get(f.attempt.id)?.turnId, f.sent[0]);
  } finally { f.setPaused(false); await rejected; }
});

test("更新冻结不打断已发模型，首轮自然结束后阻止同节点下一轮", async t => {
  const current = deferred<{ responseText: string }>(), entered = deferred<void>(), stop = new Error("SECOND_MODEL_SEND");
  const f = modelAdmissionFixture(t, async turn => {
    if (turn === 1) { entered.resolve(); return await current.promise; }
    throw stop;
  });
  const execution = f.execute();
  const rejected = assert.rejects(execution, error => error === stop);
  try {
    await entered.promise;
    f.setPaused(true);
    current.resolve({ responseText: "首轮自然完成，仍需提交结果" });
    await waitForAdmission(() => f.db.turns.get(f.sent[0])?.status === "completed");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, 1);
    assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 1);
    assert.equal(f.db.orchNodeAttempts.get(f.attempt.id)?.status, "running");
    f.setPaused(false);
    await rejected;
    assert.equal(f.sent.length, 2);
  } finally { current.resolve({ responseText: "完成" }); f.setPaused(false); await rejected; }
});

test("模型更新等待中的确认取消结束等待，保持取消终态且不派发", async t => {
  const stop = new Error("UNEXPECTED_MODEL_SEND");
  const f = modelAdmissionFixture(t, async () => { throw stop; });
  f.setPaused(true);
  const execution = f.execute();
  const rejected = assert.rejects(execution, { code: "turn_interrupted", terminationKind: "manual_interrupt" });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.engine.cancelAndWait(f.instance.id);
    await rejected;
    assert.equal(f.sent.length, 0);
    assert.equal(f.db.orchNodeAttempts.get(f.attempt.id)?.status, "cancelled");
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "cancelled");
    assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
  } finally { f.setPaused(false); await Promise.allSettled([execution, rejected]); }
});

test("模型更新等待中原 Attempt 被取消，即使实例仍运行也不继续派发", async t => {
  const f = modelAdmissionFixture(t, async () => { throw new Error("STALE_ATTEMPT_SENT"); });
  f.setPaused(true);
  const execution = f.execute();
  const rejected = assert.rejects(execution, { code: "turn_interrupted", terminationKind: "manual_interrupt" });
  try {
    await waitForAdmission(() => f.checks() > 0);
    f.db.orchNodeAttempts.markTerminal(f.attempt.id, "cancelled", "用户停止节点");
    await rejected;
    assert.equal(f.sent.length, 0);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "running");
    assert.equal(f.db.orchNodeAttempts.get(f.attempt.id)?.status, "cancelled");
  } finally { f.setPaused(false); await Promise.allSettled([execution, rejected]); }
});

test("模型准入等待已取消时优先结束，不再读取更新回调", async t => {
  const f = modelAdmissionFixture(t, async () => { throw new Error("CANCELLED_MODEL_SENT"); });
  await f.engine.cancelAndWait(f.instance.id);
  (f.engine as any).ctx.isTaskAdmissionPaused = () => { throw new Error("CANCELLED_MODEL_MUST_NOT_WAIT"); };
  await assert.rejects(f.execute(), { code: "turn_interrupted", terminationKind: "manual_interrupt" });
  assert.equal(f.sent.length, 0);
});

test("更新等待中的真实角色执行随停止排空，不派发且保留原运行事实", async t => {
  const f = modelAdmissionFixture(t, async () => { throw new Error("MODEL_SENT_AFTER_STOP"); });
  const executionConfig = createDefaultRoleExecutionConfig("codex");
  executionConfig.engineProfiles.codex.mode = "custom";
  executionConfig.engineProfiles.codex.customConfig = { ...createDefaultRoleExecutionCustomConfig("codex"), model: "gpt-5.5",
    effort: "medium", accessMode: "read-only", maxRetries: 0 };
  const role = { id: f.node.roleId!, workspaceId: f.workspaceId, name: "更新角色", description: "更新等待", responsibility: "执行任务",
    systemPrompt: "执行当前任务", inputDefinition: { instructions: "任务={{requirement}}", requiredFields: [] },
    outputDefinition: { instructions: "返回结果", deliveryMode: "direct" as const, format: "markdown" as const,
      resultKey: null, filePathRule: null, requiredFields: [] }, gateCriteria: [], executionConfig, defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom" as const };
  f.db.orchInstances.backfillAssetRuntimeSnapshot(f.instance.id, { authorityMode: "legacy",
    workflow: { assetType: "workflow", assetId: f.instance.workflowId, definition: f.instance.workflowSnapshot, source: null },
    roles: { [role.id]: { assetType: "role", assetId: role.id, definition: role, source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 } } },
    knowledgeBundles: {}, toolsets: {}, skills: {} });
  const state = (f.engine as any).createRunState();
  (f.engine as any).runningInstances.set(f.instance.id, state);
  f.setPaused(true);
  const execution = (f.engine as any).executeRoleNode(f.instance.id, f.node, f.db.orchInstances.get(f.instance.id)) as Promise<void>;
  state.activeNodePromises.set(f.node.id, execution.then(() => ({ nodeId: f.node.id, error: null })));
  try {
    await waitForAdmission(() => f.checks() > 0);
    await f.engine.stopAndDrain();
    await execution;
    assert.equal(f.sent.length, 0);
    assert.equal(f.db.orchInstances.get(f.instance.id)?.status, "running");
    assert.equal(f.db.orchInstances.get(f.instance.id)?.nodeStates[f.node.id].status, "running");
    assert.equal(f.db.orchNodeAttempts.get(f.attempt.id)?.status, "running");
  } finally { f.setPaused(false); await execution; }
});
