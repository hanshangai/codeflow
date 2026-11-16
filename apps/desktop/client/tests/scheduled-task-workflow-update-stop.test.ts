import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { OrchestrationAssetRuntimeSnapshot, OrchestrationId, ScheduledTask, ScheduledTaskRun, WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { applyEngineModelCatalogSnapshot, cancelEngineModelCatalogDispatchPause, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { createDesktopUpdateControl } from "../src/runtime/desktopUpdateControl.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "@codeflowai/shared/engine-model-catalog-seed";
import { ScheduledTaskRuntimeStateRepo } from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";

const catalog = { schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] };

/** 原失败可经存储边界包装；包括假值也必须留在完整 cause 链。 */
function containsFailure(error: unknown, expected: unknown): boolean {
  if (Object.is(error, expected)) return true;
  if (!(error instanceof Error)) return false;
  return Object.hasOwn(error, "cause") && containsFailure(error.cause, expected)
    || error instanceof AggregateError && error.errors.some(item => containsFailure(item, expected));
}

/** 显式控制真实 HTTP、模型等待与引擎收口的先后。 */
function deferred() {
  let resolve!: () => void;
  const gate = { promise: undefined! as Promise<void>, resolve: () => resolve(), settled: false };
  gate.promise = new Promise<void>(yes => { resolve = () => { gate.settled = true; yes(); }; });
  return gate;
}

/** 仅在可观察边界满足后继续，超时明确报告未达条件。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "workflow boundary timed out");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

/** 保留真实 SQLite、HTTP 和实例创建，仅控制引擎启动及清理边界。 */
async function fixture(run: (f: {
  db: ReturnType<typeof openClientDb>; scheduler: ScheduledTaskScheduler; control: ReturnType<typeof createDesktopUpdateControl>;
  reports: ScheduledTaskRun[]; starts: OrchestrationId[]; cancels: OrchestrationId[]; calls: string[];
  hooks: { report?: (run: ScheduledTaskRun) => Promise<number | void>; knowledge?: () => Promise<void>; start?: () => Promise<void>; cancel?: () => Promise<void>; terminal?: () => Promise<void>; accountCurrent?: () => void };
  pause(value: boolean): void; run(): Promise<ScheduledTaskRun>; gate(): ReturnType<typeof deferred>;
}) => Promise<void>, realEngine = false): Promise<void> {
  resetEngineModelCatalogRuntimeForTest();
  applyEngineModelCatalogSnapshot(catalog);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-scheduled-workflow-update-"));
  const applicationDb = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = "workflow-update-workspace" as WorkspaceId;
  applicationDb.workspaces.upsert({ id: workspaceId, title: "workflow update", path: root });
  const db = applicationDb.forWorkspace(workspaceId);
  const workflow = {
    id: "workflow-update", workspaceId, family: "feature-dev", name: "workflow update", description: "workflow update", version: 1,
    nodes: [{ id: "start", type: "start", label: "start", position: { x: 0, y: 0 } }, { id: "end", type: "end", label: "end", position: { x: 100, y: 0 } }],
    edges: [{ id: "start-end", sourceNodeId: "start", targetNodeId: "end", dataMappings: [] }],
  } as const;
  const snapshot = { authorityMode: "server", workflow: { assetType: "workflow", assetId: workflow.id, definition: workflow,
    source: { authorityMode: "server", metadata: { revision: 1, scopeType: "user", syncChangeSeq: 1, contentHash: "a".repeat(64), cacheStatus: "ready" } } },
    roles: {}, knowledgeBundles: {}, toolsets: {}, skills: {} } as unknown as OrchestrationAssetRuntimeSnapshot;
  const task = {
    id: "workflow-task", ownerUserId: "user-1", clientId: "client-1", deviceId: "device-1", clientNameSnapshot: "client", deviceLabelSnapshot: null,
    name: "workflow update", description: null, taskType: "workflow", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { contextWorkspaceId: workspaceId, workflowId: workflow.id }, concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 30_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1,
  } as ScheduledTask;
  const reports: ScheduledTaskRun[] = [], starts: OrchestrationId[] = [], cancels: OrchestrationId[] = [], calls: string[] = [], errors: unknown[] = [];
  const hooks: Parameters<typeof run>[0]["hooks"] = {};
  const gates: ReturnType<typeof deferred>[] = [], ownedRuns: Promise<ScheduledTaskRun>[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let status = 200;
      if (body.run) { reports.push(body.run); status = await hooks.report?.(body.run) ?? 200; }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200, tasks: [task], serverNow: Date.now() }));
    })().catch(error => { errors.push(error); res.writeHead(500); res.end("test boundary failed"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let paused = false, starting = false;
  const context = {
    db: applicationDb, workspaces: new Map([[workspaceId, root]]), isTaskAdmissionPaused: () => paused, sessions: {},
    orchAssetLaunchSnapshot: { createFromWorkflowId: (actualWorkspaceId: WorkspaceId, workflowId: string) => {
      assert.equal(actualWorkspaceId, workspaceId); assert.equal(workflowId, workflow.id); return snapshot;
    } },
    controlledExperiments: { hasInFlightWork: () => false, stopForUpdate: async () => {} },
    orchEngine: {
      start: async (id: OrchestrationId) => {
        starts.push(id); starting = true; db.orchInstances.updateStatus(id, "running");
        try { await hooks.start?.(); }
        finally { starting = false; }
        if (db.orchInstances.get(id)?.status === "running") db.orchInstances.updateStatus(id, "completed");
      },
      cancelAndWait: async (id: OrchestrationId) => { cancels.push(id); calls.push("cancel"); db.orchInstances.updateStatus(id, "cancelled"); await hooks.cancel?.(); },
      hasInFlightWork: () => starting, waitForInFlightWork: async () => { assert.equal(starting, false); }, listManagedServicesForThread: () => [],
    },
  } as unknown as ApiHandlerContext;
  context.orchEngine.existingWorkspace = () => context.orchEngine;
  context.orchEngine.forWorkspace = actualWorkspaceId => { assert.equal(actualWorkspaceId, workspaceId); return context.orchEngine; };
  if (realEngine) {
    const engine = new OrchestrationEngine({ db, threads: new ThreadStore(), sessions: {} as any, workspaces: context.workspaces,
      timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 }, emitConversation() {}, emitRaw() {},
      isTaskAdmissionPaused: context.isTaskAdmissionPaused });
    const start = engine.start.bind(engine), cancel = engine.cancelAndWait.bind(engine);
    engine.start = async id => { starts.push(id); await start(id); };
    engine.cancelAndWait = async (id, input) => { cancels.push(id); await cancel(id, input); };
    context.orchEngine = engine;
  }
  const scheduler = new ScheduledTaskScheduler({
    config: { serverWsUrl: `ws://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/ws`, clientId: "client-1", apiKey: "isolated-test" } as any,
    deviceId: "device-1", apiContext: context, isTaskAdmissionPaused: () => paused,
    captureAccountContext: () => ({ serverOrigin: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, ownerUserId: "user-1", clientId: "client-1", deviceId: "device-1", generation: 1, assertCurrent() { hooks.accountCurrent?.(); } }),
  });
  const control = createDesktopUpdateControl({
    context, requestId: "workflow-update", timeoutMs: 200, scheduledTaskScheduler: scheduler,
    queueDispatcher: { hasInFlightWork: () => false, assertNoFailure() {}, resumeWorkspace: () => {} },
    terminalManager: { hasRunningTerminals: () => false, stopAllForUpdate: async () => { calls.push("terminal"); await hooks.terminal?.(); } },
    hasBlockingTransaction: () => false, hasKnowledgeWork: () => false, stopKnowledgeWork: async () => { calls.push("knowledge"); await hooks.knowledge?.(); },
    hasAssetDraftWork: () => false, stopAssetDraftWork: async () => {}, interruptTurn: async () => {},
  });
  try {
    await run({ db, scheduler, control, reports, starts, cancels, calls, hooks, pause: value => { paused = value; },
      run: () => { const pending = scheduler.runNow(task.id); ownedRuns.push(pending); void pending.then(() => {}, () => {}); return pending; },
      gate: () => { const gate = deferred(); gates.push(gate); return gate; } });
  } finally {
    for (const gate of gates) gate.resolve();
    resetEngineModelCatalogRuntimeForTest();
    await Promise.allSettled(ownedRuns);
    await scheduler.stopAndDrain();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); fs.rmSync(root, { recursive: true });
    assert.deepEqual(errors, []);
  }
}

test("running ACK 在取消快照之后释放时零新实例且明确上报更新中断", async () => {
  await fixture(async f => {
    const ack = f.gate(), terminal = f.gate(), reachedTerminal = f.gate();
    f.hooks.report = async run => { if (run.status === "running") await ack.promise; };
    f.hooks.terminal = async () => { reachedTerminal.resolve(); await terminal.promise; };
    const running = f.run();
    await waitFor(() => f.reports.some(run => run.status === "running"));
    f.pause(true); assert.deepEqual(await f.control.prepare(), { hasRunningSessions: true });
    const stopping = f.control.interrupt();
    void stopping.then(() => {}, () => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    ack.resolve();
    const result = await running;
    assert.equal(result.status, "failed");
    assert.match(result.errorMessage ?? "", /SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE/);
    assert.equal(result.workflowInstanceId, null);
    assert.equal(f.db.orchInstances.listByWorkspace("workflow-update-workspace").length, 0);
    assert.deepEqual(f.starts, []); assert.deepEqual(f.cancels, []);
    await waitFor(() => reachedTerminal.settled); terminal.resolve(); await stopping;
    assert.equal(f.scheduler.hasInFlightWork(), false);
  }, true);
});

test("模型目录仍暂停时确认可收口，恢复目录后零迟到派发", async () => {
  await fixture(async f => {
    applyEngineModelCatalogSnapshot(catalog, Date.now(), "catalog-paused");
    const running = f.run();
    await waitFor(() => f.reports.some(run => run.status === "running"));
    await new Promise<void>(resolve => setImmediate(resolve));
    f.pause(true); assert.equal((await f.control.prepare()).hasRunningSessions, true);
    try { await f.control.interrupt(); }
    finally { cancelEngineModelCatalogDispatchPause("catalog-paused"); }
    assert.equal((await running).status, "failed");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.starts, []);
    assert.equal(f.db.orchInstances.listByWorkspace("workflow-update-workspace").length, 0);
  }, true);
});

test("账号在模型目录等待后失效不能创建流程实例", async () => {
  await fixture(async f => {
    applyEngineModelCatalogSnapshot(catalog, Date.now(), "stale-account-catalog");
    const running = f.run(); await waitFor(() => f.reports.some(run => run.status === "running"));
    f.hooks.accountCurrent = () => { throw Object.assign(new Error("controlled account stale"), { code: "SCHEDULED_TASK_ACCOUNT_STALE" }); };
    cancelEngineModelCatalogDispatchPause("stale-account-catalog");
    await assert.rejects(running); assert.deepEqual(f.starts, []);
    assert.deepEqual(f.db.orchInstances.listByWorkspace("workflow-update-workspace"), []);
  });
});

test("prepare 与稍后不取消已认领流程，目录恢复后恰好启动一次", async () => {
  await fixture(async f => {
    applyEngineModelCatalogSnapshot(catalog, Date.now(), "catalog-later");
    const running = f.run();
    await waitFor(() => f.reports.some(run => run.status === "running"));
    f.pause(true); assert.equal((await f.control.prepare()).hasRunningSessions, true);
    f.pause(false); await f.control.resume();
    cancelEngineModelCatalogDispatchPause("catalog-later");
    const result = await running;
    assert.equal(result.status, "success");
    assert.equal(f.starts.length, 1); assert.deepEqual(f.cancels, []);
    assert.equal(result.workflowInstanceId, f.starts[0]);
  });
});

test("更新打断模型等待后解绑监听，原目录迟到拒绝仍被受理且零实例", async t => {
  await fixture(async f => {
    const aborted = new Set<AbortSignal>(), listenerCounts: number[] = [], abort = AbortController.prototype.abort;
    t.mock.method(AbortController.prototype, "abort", function (this: AbortController, reason?: unknown) {
      aborted.add(this.signal); listenerCounts.push(getEventListeners(this.signal, "abort").length); return abort.call(this, reason);
    });
    applyEngineModelCatalogSnapshot(catalog, Date.now(), "catalog-late-rejection");
    const running = f.run();
    await waitFor(() => f.reports.some(run => run.status === "running"));
    await new Promise<void>(resolve => setImmediate(resolve));
    f.pause(true); await f.control.prepare(); await f.control.interrupt();
    assert.equal((await running).status, "failed");
    assert.equal(aborted.size, 1);
    assert.equal(listenerCounts[0], 1);
    for (const signal of aborted) assert.equal(getEventListeners(signal, "abort").length, 0);
    resetEngineModelCatalogRuntimeForTest();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.starts, []);
    assert.equal(f.scheduler.hasInFlightWork(), false);
  }, true);
});

test("已建实例只沿 control 取消一次，原启动与最终上报收口后才停止终端", async () => {
  await fixture(async f => {
    const start = f.gate(), cancelled = f.gate(), cancelCleanup = f.gate(), reported = f.gate(), report = f.gate();
    f.hooks.start = () => start.promise;
    f.hooks.cancel = async () => { cancelled.resolve(); start.resolve(); await cancelCleanup.promise; };
    f.hooks.report = async run => { if (run.status !== "running") { reported.resolve(); await report.promise; } };
    const running = f.run(); await waitFor(() => f.starts.length === 1);
    f.pause(true); await f.control.prepare();
    let done = false;
    const stopping = f.control.interrupt().then(() => { done = true; });
    await waitFor(() => cancelled.settled && reported.settled);
    assert.equal(done, false); assert.equal(f.calls.includes("terminal"), false);
    assert.deepEqual(f.cancels, f.starts);
    cancelCleanup.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.includes("terminal"), false);
    report.resolve(); await stopping;
    const result = await running;
    assert.equal(result.status, "failed"); assert.match(result.errorMessage ?? "", /SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE/);
    assert.equal(result.workflowInstanceId, f.starts[0]);
    assert.equal(f.db.orchInstances.get(f.starts[0])?.status, "cancelled");
    assert.equal(f.cancels.length, 1); assert.equal(f.calls.at(-1), "terminal");
  });
});

for (const boundary of ["report", "markFinished"] as const) test(`确认后在 scheduler 排空前发生 ${boundary} 失败仍阻止更新并保留原失败`, async t => {
  await fixture(async f => {
    const knowledge = f.gate(), ack = f.gate(), cause = new Error("WORKFLOW_FINISH_FAILED");
    f.hooks.knowledge = () => knowledge.promise;
    f.hooks.report = async run => { if (run.status === "running") await ack.promise; else if (boundary === "report") return 503; };
    if (boundary === "markFinished") t.mock.method(ScheduledTaskRuntimeStateRepo.prototype, "finishAccount", () => { throw cause; });
    const running = f.run(); let original: unknown;
    const rejectedRun = assert.rejects(running, error => { original = error; return true; });
    await waitFor(() => f.reports.some(run => run.status === "running"));
    f.pause(true); await f.control.prepare();
    const stopping = f.control.interrupt(); const rejectedStop = assert.rejects(stopping, { code: "SCHEDULED_TASK_UPDATE_DRAIN_FAILED" });
    await waitFor(() => f.calls.includes("knowledge"));
    ack.resolve(); await rejectedRun;
    knowledge.resolve(); await rejectedStop;
    assert.equal(f.calls.includes("terminal"), false); assert.equal(f.scheduler.hasInFlightWork(), true);
    let first: unknown;
    await assert.rejects(f.scheduler.stopForUpdate({ requestId: "retry-first" }), error => { first = error; assert.ok(error instanceof AggregateError && error.errors.includes(original)); return true; });
    await assert.rejects(f.scheduler.stopForUpdate({ requestId: "retry-second" }), error => error === first);
  });
});

for (const cause of [undefined, null, false, 0, "", Number.NaN]) test(`确认后清理以假值 ${String(cause)} 拒绝仍保留原失败`, async t => {
  await fixture(async f => {
    const ack = f.gate(), knowledge = f.gate();
    f.hooks.report = async run => { if (run.status === "running") await ack.promise; };
    f.hooks.knowledge = () => knowledge.promise;
    t.mock.method(ScheduledTaskRuntimeStateRepo.prototype, "finishAccount", () => { throw cause; });
    const running = f.run();
    const failedRun = running.then(() => assert.fail("run must reject"), error => { assert.ok(containsFailure(error, cause)); });
    await waitFor(() => f.reports.some(run => run.status === "running"));
    f.pause(true); await f.control.prepare();
    const stopping = assert.rejects(f.control.interrupt(), error => {
      assert.ok(error instanceof AggregateError && containsFailure(error, cause)); return true;
    });
    await waitFor(() => f.calls.includes("knowledge"));
    ack.resolve(); await failedRun; knowledge.resolve(); await stopping;
    await assert.rejects(f.scheduler.stopForUpdate({ requestId: "falsey-retry" }), error => {
      assert.ok(error instanceof AggregateError && containsFailure(error, cause)); return true;
    });
    assert.equal(f.calls.includes("terminal"), false);
  });
});

test("模型等待的更新超时保留 owner，迟到 ACK 收口后可重新严格等待", async () => {
  await fixture(async f => {
    const ack = f.gate();
    f.hooks.report = async run => { if (run.status === "running") await ack.promise; };
    const running = f.run(); await waitFor(() => f.reports.some(run => run.status === "running"));
    await assert.rejects(f.scheduler.stopForUpdate({ requestId: "ack-timeout", timeoutMs: 5 }), { code: "SCHEDULED_TASK_UPDATE_DRAIN_FAILED" });
    assert.equal(f.scheduler.hasInFlightWork(), true);
    ack.resolve(); assert.equal((await running).status, "failed");
    await f.scheduler.stopForUpdate({ requestId: "ack-retry", timeoutMs: 1_000 });
    assert.equal(f.scheduler.hasInFlightWork(), false); assert.deepEqual(f.starts, []);
  });
});
