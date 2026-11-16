import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";

import type {
  Artifact,
  ArtifactFileEntry,
  EngineType,
  NodeFinalAnswerPayload,
  NodeExecutionState,
  NodeExecutionEnvelope,
  NodePromptSnapshot,
  NodeResultField,
  OrchestrationAssetRuntimeSnapshot,
  OrchestrationInstance,
  OrchestrationRuntimeConfig,
  RoleDefinition,
  SkillDefinition,
  TaskAcceptanceCriterion,
  TaskIntake,
  ThreadId,
  TurnId,
  ToolsetDefinition,
  WorkflowDefinition,
  WorkflowNode,
} from "../../packages/shared/src/index.ts";
import {
  DEFAULT_MAX_REWORK_ROUNDS,
  MANUAL_TURN_INTERRUPT_CODE,
  buildRoleExecutionRevision,
  createDefaultRoleExecutionConfig,
  createDefaultRoleExecutionCustomConfig,
} from "../../packages/shared/src/index.ts";
import {
  OrchestrationEngine as ProductionOrchestrationEngine,
  shouldRecoverPersistedOrchestrationInstance,
} from "../../apps/desktop/client/src/orchestration/orchestrationEngine.ts";
import type {
  OrchNodeAttempt,
  OrchNodeAttemptStatus,
} from "../../apps/desktop/client/src/db/repos/orchNodeAttemptRepo.ts";
import { migrateClientDb } from "../../apps/desktop/client/src/db/migrateClientDb.ts";
import { OrchNodeWorkItemRepo } from "../../apps/desktop/client/src/db/repos/orchNodeWorkItemRepo.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { RuntimeEvidenceService } from "../../apps/desktop/client/src/orchestration/runtimeEvidenceService.ts";
import { buildSkillScriptToolEntries } from "../../apps/desktop/client/src/orchestration/skillPackageService.ts";
import { KnowledgeAssetStore } from "../../apps/desktop/client/src/knowledge/knowledgeAssetStore.ts";
import { KnowledgeChangeStore } from "../../apps/desktop/client/src/knowledge/knowledgeChangeStore.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";
import { buildKnowledgeAssetReadTools } from "../../apps/desktop/client/src/knowledge/knowledgeAssetTools.ts";
import { buildKnowledgeChangeTool } from "../../apps/desktop/client/src/knowledge/knowledgeChangeTools.ts";
import { CodexAppServerWorkspace } from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerWorkspace.ts";
import { CodexAppServerThreadSession } from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerThreadSession.ts";
import { createLocalEventPersistence } from "../../apps/desktop/client/src/runtime/localEventPersistence.ts";
import { clearActiveThreadTurnIfMatches, resolveTurnErrorIndexScope } from "../../apps/desktop/client/src/app/threadRunningState.ts";
import { readTurnExecutionOptionsSnapshot } from "../../apps/desktop/client/src/queue/threadQueueExecutionPolicy.ts";
import { persistOrStageCodexProviderTurn } from "../../apps/desktop/client/src/eventIndex/codexProviderTurnStarted.ts";
import { applyThreadReminderStateEvent } from "../../apps/desktop/client/src/eventIndex/threadReminderStateEvents.ts";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "../../packages/shared/src/engineModelCatalogSeed.ts";
import { ToolRuntimeService } from "../../apps/desktop/client/src/orchestration/toolRuntimeService.ts";

/** 临时W使用规范物理路径，避免Windows短目录别名触发真实身份门禁。 */
function createTemporaryWorkspace(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(prefix));
}

// 普通执行夹具只需空工作区；集成用例另外创建自己的文件事实。
const emptyWorkspace = createTemporaryWorkspace(path.join(os.tmpdir(), "orch-empty-workspace-"));
test.after(() => fs.rmSync(emptyWorkspace, { recursive: true, force: true }));

type TestExecutionProfileInput = {
  enabled?: boolean;
  mode?: "auto" | "custom";
  customConfig?: Partial<ReturnType<typeof createDefaultRoleExecutionCustomConfig>> | null;
};

/** 等待引擎内部 setTimeout 后台调度进入下一轮事件循环。 */
function nextTimerTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 生命周期探针使用固定 writer；其他产品日志仍走该用例原故障出口。 */
function mockLifecycleLog(t: test.TestContext, db: ReturnType<typeof openClientDb>, callback: (...args: any[]) => void): void {
  const write = db.writeWorkspaceLog.bind(db);
  t.mock.method(db, "writeWorkspaceLog", ((workspaceId, entry) => {
    if (["background start did not settle", "managed runtime disposal failed", "instance coordinator failed", "instance coordinator stopped after execution error"].includes(entry.message)) return callback(entry.tag, entry.message, entry.data);
    return write(workspaceId, entry);
  }) as typeof write);
}

/** 真实 SQLite 与公开入口；仅隔离外部 provider、事件出口及可控资源释放。 */
function completionEventFixture(t: test.TestContext, kind: "dag" | "role" | "role-end" | "skip" | "skip-only" = "dag") {
  const root = createTemporaryWorkspace(path.join(os.tmpdir(), "completion-event-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  t.after(() => { t.mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = createRole(), start: WorkflowNode = { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    node: WorkflowNode = { id: "role", type: "role", roleId: role.id, label: "执行", position: { x: 0, y: 0 } },
    end: WorkflowNode = { id: "end", type: "end", label: "结束", position: { x: 0, y: 0 } };
  const nodes = kind === "dag" ? [start, end] : kind === "role-end" || kind === "skip" ? [node, end] : [node];
  const workflow = createWorkflow(nodes, nodes.length === 2 ? [{ id: "edge", sourceNodeId: nodes[0]!.id, targetNodeId: end.id, conditionBranch: null, dataMappings: [] }] : []);
  db.workspaces.upsert({ id: workflow.workspaceId, title: "完成事件", path: root });
  const instance = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }) });
  const broadcasts: string[] = [], logs: any[] = [], order: string[] = [];
  let providerCalls = 0, admissionPaused = false;
  const engine = new ProductionOrchestrationEngine({ db, threads: new ThreadStore(), workspaces: new Map([[workflow.workspaceId, root]]),
    sessions: { getOrCreate() { providerCalls++; throw new Error("UNEXPECTED_COMPLETION_PROVIDER"); } } as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {},
    emitOrchestration(_workspaceId, event) { broadcasts.push(event.type); },
    isTaskAdmissionPaused: () => admissionPaused,
    beginWorkspaceActivity() { return () => { order.push("activity-release"); }; } });
  const append = db.orchEvents.append.bind(db.orchEvents), write = db.writeWorkspaceLog.bind(db);
  t.mock.method(db, "writeWorkspaceLog", (workspaceId: Parameters<typeof write>[0], entry: Parameters<typeof write>[1]) => { logs.push(entry.data); return write(workspaceId, entry); });
  t.mock.method(db.orchEvents, "append", (input: Parameters<typeof append>[0]) => {
    if (input.type === "orchestration.completed") {
      assert.equal(db.orchInstances.get(instance.id)!.status, "completed");
      if (kind === "role" || kind === "role-end") assert.equal(db.orchNodeAttempts.getLatestByNode(instance.id, node.id)!.status, "completed");
      order.push("completed");
    }
    return append(input);
  });
  let attemptId: string | undefined;
  if (kind === "role" || kind === "role-end") {
    const threadId = "completion-role-thread" as ThreadId;
    db.threads.create({ id: threadId, workspaceId: workflow.workspaceId, engine: "codex", title: "恢复" });
    const attempt = db.orchNodeAttempts.begin({ instanceId: instance.id, nodeId: node.id });
    attemptId = attempt.id;
    db.orchNodeAttempts.bindExecution(attempt.id, threadId, "completion-role-turn");
    db.orchNodeAttempts.saveResponseText(attempt.id, "已完成");
    db.orchNodeAttempts.submit(attempt.id, createTextFinalAnswer("已完成"));
    const latest = db.orchInstances.get(instance.id)!;
    latest.nodeStates[node.id] = { ...latest.nodeStates[node.id]!, status: "result-submitted", threadId, attemptId: attempt.id, attemptNo: 1 };
    db.orchInstances.updateNodeStates(instance.id, latest.nodeStates); db.orchInstances.updateStatus(instance.id, "running");
  } else if (kind === "skip" || kind === "skip-only") {
    const latest = db.orchInstances.get(instance.id)!;
    latest.nodeStates[node.id]!.status = "waiting-start";
    db.orchInstances.updateNodeStates(instance.id, latest.nodeStates); db.orchInstances.updateStatus(instance.id, "waiting-start");
  }
  return { db, engine, instance, logs, broadcasts, order, attemptId, providers: () => providerCalls,
    /** 原准入门暂停调度，用于公开 recover/skip 与真实 drive 重叠。 */
    pauseAdmission(value: boolean) { admissionPaused = value; },
    events: () => db.orchEvents.listByInstance(instance.id),
    /** 只替换 completed append，其他持久化与广播链保持真实。 */
    rejectCompletion(error: unknown) {
      let attempts = 0;
      const original = db.orchEvents.append.bind(db.orchEvents);
      t.mock.method(db.orchEvents, "append", (input: Parameters<typeof original>[0]) => { if (input.type === "orchestration.completed") { attempts++; throw error; } return original(input); });
      return () => attempts;
    } };
}

test("completion event public SQLite start settles DAG and resources before exactly one delivery", async t => {
  const f = completionEventFixture(t);
  const runtime = (f.engine as any).managedServiceRuntime, dispose = runtime.disposeInstanceServices.bind(runtime);
  t.mock.method(runtime, "disposeInstanceServices", async (id: string) => { await dispose(id); f.order.push("cleanup"); });
  await f.engine.start(f.instance.id);
  await f.engine.recover(f.instance.id);
  assert.deepEqual(f.order, ["cleanup", "completed"]);
  assert.equal(f.events().filter(event => event.type === "orchestration.completed").length, 1);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.nodeStates.end!.status, "completed");
  assert.equal(f.providers(), 0);
});

for (const kind of ["role", "role-end"] as const) test(`completion event concurrent repeated SQLite recover ${kind} commits once`, async t => {
  const f = completionEventFixture(t, kind), first = f.engine.recover(f.instance.id), second = f.engine.recover(f.instance.id);
  assert.equal(first, second); await first; await f.engine.recover(f.instance.id);
  assert.equal(f.events().filter(event => event.type === "orchestration.completed").length, 1);
  assert.equal(f.db.orchArtifacts.listByInstance(f.instance.id).length, 1);
  assert.equal(f.db.orchNodeAttempts.get(f.attemptId!)!.status, "completed");
  assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "role")!.attemptNo, 1);
  assert.equal(f.providers(), 0);
});

for (const kind of ["dag", "role", "role-end"] as const) test(`completion event public ${kind} rejects append without rewriting committed facts`, async t => {
  const f = completionEventFixture(t, kind), original = new Error("completion-original"), attempts = f.rejectCompletion(original);
  const invoke = kind === "dag" ? f.engine.start(f.instance.id) : f.engine.recover(f.instance.id);
  await assert.rejects(invoke, (error: any) => error.cause === original && error.errors[0] === original);
  assert.equal(attempts(), 1); assert.equal(f.broadcasts.includes("orchestration.completed"), false);
  assert.equal(f.events().some(event => event.type === "orchestration.error"), false);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed");
  if (f.attemptId) { assert.equal(f.db.orchNodeAttempts.get(f.attemptId)!.status, "completed"); assert.equal(f.db.orchArtifacts.listByInstance(f.instance.id).length, 1); }
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0].errorCode, "ORCHESTRATION_COMPLETION_EVENT_FAILED");
  assert.deepEqual(f.logs[0].event, { category: "orchestration", action: "completion_event", outcome: "fail" });
  assert.equal((f.engine as any).runningInstances.has(f.instance.id), false, "已完成的无 drive 恢复 owner 必须释放");
  await f.engine.recover(f.instance.id); assert.equal(attempts(), 1);
});

for (const origin of ["start", "skip"] as const) test(`completion event background ${origin} preserves falsy rejection for settled public wait`, async t => {
  const f = completionEventFixture(t, origin === "skip" ? "skip" : "dag"), attempts = f.rejectCompletion(0);
  let otherLogs = 0; t.mock.method(logger, "error", () => { otherLogs++; });
  if (origin === "start") await f.engine.startInBackground(f.instance.id, "completion-request");
  else await f.engine.skipWaitingNode(f.instance.id, "role");
  await nextTimerTick(); await nextTimerTick();
  assert.equal(f.engine.hasInFlightWork(), false);
  await assert.rejects(f.engine.waitForInFlightWork({ timeoutMs: 1000 }), (error: any) => error.cause === 0 && error.errors[0] === 0);
  assert.equal(attempts(), 1); assert.equal(f.logs.length, 1); assert.equal(otherLogs, 0);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed");
  assert.equal(f.events().some(event => event.type === "orchestration.error"), false);
  await f.engine.waitForInFlightWork({ timeoutMs: 1000 });
});

test("completion event database continuation preserves delivery and activity release failures", async t => {
  const f = completionEventFixture(t, "skip"), original = new Error("continuation-delivery"), secondary = new Error("continuation-release");
  f.pauseAdmission(true); const attempts = f.rejectCompletion(original);
  let releases = 0, otherLogs = 0;
  (f.engine as any).ctx.beginWorkspaceActivity = () => () => { releases++; throw secondary; };
  t.mock.method(logger, "error", () => { otherLogs++; });
  await f.engine.startInBackground(f.instance.id, "continuation-request");
  await f.engine.skipWaitingNode(f.instance.id, "role");
  await nextTimerTick();
  f.pauseAdmission(false);
  await assert.rejects(f.engine.waitForInFlightWork({ timeoutMs: 1000 }), (error: any) => {
    const delivery = error.errors.find((item: any) => item.cause === original);
    const release = error.errors.find((item: any) => item.cause === delivery && item.errors[1] === secondary);
    assert.ok(delivery); assert.ok(release); assert.equal(release.errors[0], delivery); return true;
  });
  assert.equal(releases, 1); assert.equal(attempts(), 1); assert.equal(f.logs.length, 1); assert.equal(otherLogs, 0);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed");
  assert.equal(f.events().some(event => event.type === "orchestration.error"), false);
  assert.equal(f.engine.hasInFlightWork(), false);
});

test("completion event logging and reflection faults preserve both original causes without getters", async t => {
  const f = completionEventFixture(t), original = new Error("completion-original"), secondary = new Error("completion-log");
  let getters = 0; Object.defineProperty(original, "code", { get() { getters++; throw new Error("UNEXPECTED_GETTER"); } });
  f.rejectCompletion(original); t.mock.method(f.db, "writeWorkspaceLog", () => { throw secondary; });
  await assert.rejects(f.engine.start(f.instance.id), (error: any) => error.cause === original && error.errors[0] === original && error.errors[1] === secondary);
  assert.equal(getters, 0); assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed");
});

for (const failure of ["none", "append", "cleanup"] as const) test(`completion event recover awaits real active drive and cleanup ${failure}`, async t => {
  const f = completionEventFixture(t, "role"), original = new Error(`active-${failure}`);
  f.pauseAdmission(true);
  if (failure === "append") f.rejectCompletion(original);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), cleanupEntered = new Promise<void>(resolve => { entered = resolve; });
  const runtime = (f.engine as any).managedServiceRuntime, dispose = runtime.disposeInstanceServices.bind(runtime);
  t.mock.method(runtime, "disposeInstanceServices", async (id: string) => {
    entered(); await held; await dispose(id); f.order.push("cleanup"); if (failure === "cleanup") throw original;
  });
  await f.engine.startInBackground(f.instance.id, "active-request");
  let settled = false;
  const recovery = f.engine.recover(f.instance.id), observed = recovery.then(() => { settled = true; }, () => { settled = true; });
  try {
    await nextTimerTick(); assert.equal(settled, false, "活跃 drive 的投递与清理仍由同一 recover 等待");
    await cleanupEntered;
    assert.equal(settled, false); assert.equal(f.events().filter(event => event.type === "orchestration.completed").length, 0);
    release();
    if (failure === "none") await recovery;
    else await assert.rejects(recovery, (error: any) => failure === "append" ? error.cause === original : error === original);
    if (failure === "append") await assert.rejects(f.engine.waitForInFlightWork({ timeoutMs: 1000 }), (error: any) => error.cause === original);
    else if (failure === "cleanup") await assert.rejects(f.engine.waitForInFlightWork({ timeoutMs: 1000 }), error => error === original);
    else await f.engine.waitForInFlightWork({ timeoutMs: 1000 });
    assert.equal(f.events().filter(event => event.type === "orchestration.completed").length, failure === "none" ? 1 : 0);
    assert.equal(f.db.orchNodeAttempts.get(f.attemptId!)!.status, "completed");
    assert.equal(f.db.orchArtifacts.listByInstance(f.instance.id).length, 1);
    assert.equal(f.providers(), 0);
  } finally { release(); f.pauseAdmission(false); await observed; if (failure === "none") await f.engine.waitForInFlightWork({ timeoutMs: 1000 }); }
});

for (const active of [false, true]) test(`completion event public skip has exactly one owner active=${active}`, async t => {
  const f = completionEventFixture(t, "skip-only");
  const runtime = (f.engine as any).managedServiceRuntime, dispose = runtime.disposeInstanceServices.bind(runtime);
  t.mock.method(runtime, "disposeInstanceServices", async (id: string) => { await dispose(id); f.order.push("cleanup"); });
  if (active) { f.pauseAdmission(true); await f.engine.startInBackground(f.instance.id, "skip-active"); }
  await f.engine.skipWaitingNode(f.instance.id, "role");
  f.pauseAdmission(false); await f.engine.waitForInFlightWork({ timeoutMs: 1000 });
  assert.equal(f.events().filter(event => event.type === "orchestration.completed").length, 1);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.nodeStates.role!.status, "skipped");
  assert.deepEqual(f.order, active ? ["cleanup", "completed"] : ["completed"]);
  assert.equal(f.providers(), 0);
});

for (const control of ["pause", "cancel", "replace"] as const) test(`completion event cleanup respects late ${control} owner control`, async t => {
  const f = completionEventFixture(t);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), cleanupEntered = new Promise<void>(resolve => { entered = resolve; });
  const runtime = (f.engine as any).managedServiceRuntime, dispose = runtime.disposeInstanceServices.bind(runtime);
  let calls = 0;
  t.mock.method(runtime, "disposeInstanceServices", async (id: string) => { if (++calls === 1) { entered(); await held; } await dispose(id); });
  const started = f.engine.start(f.instance.id);
  try {
    await cleanupEntered;
    if (control === "pause") await f.engine.pause(f.instance.id);
    else if (control === "cancel") f.engine.cancel(f.instance.id);
    else { f.pauseAdmission(true); await f.engine.startInBackground(f.instance.id, "replacement"); }
    const replacement = control === "replace" ? (f.engine as any).runningInstances.get(f.instance.id) : null;
    release(); await started;
    if (replacement) assert.equal((f.engine as any).runningInstances.get(f.instance.id), replacement, "旧清理不能删除替换 owner");
    if (control === "replace") f.engine.cancel(f.instance.id);
    f.pauseAdmission(false); await f.engine.waitForInFlightWork({ timeoutMs: 1000 });
    assert.equal(f.events().filter(event => event.type === "orchestration.completed").length, 0);
  } finally { release(); f.pauseAdmission(false); await started; }
});

for (const boundary of ["broadcast", "activity", "reflection"] as const) test(`completion event ${boundary} failure keeps durable append facts and original cause`, async t => {
  const f = completionEventFixture(t), original = new Error(`completion-${boundary}`), reflection = new Error("reflection-secondary");
  let rejected: unknown = original;
  const ctx = (f.engine as any).ctx;
  if (boundary === "broadcast") {
    const emit = ctx.emitOrchestration;
    ctx.emitOrchestration = (workspaceId: any, event: any) => { if (event.type === "orchestration.completed") throw original; emit(workspaceId, event); };
  } else if (boundary === "activity") {
    const resolve = ctx.resolveChatWorkflowBinding;
    ctx.resolveChatWorkflowBinding = () => { if (f.events().some(event => event.type === "orchestration.completed")) throw original; return resolve?.(); };
  } else {
    rejected = new Proxy(original, { getOwnPropertyDescriptor() { throw reflection; } }); f.rejectCompletion(rejected);
  }
  await assert.rejects(f.engine.start(f.instance.id), (error: any) => error.cause === rejected && error.errors[0] === rejected
    && (boundary !== "reflection" || error.errors[1] === reflection));
  assert.equal(f.events().filter(event => event.type === "orchestration.completed").length, boundary === "reflection" ? 0 : 1);
  assert.equal(f.events().some(event => event.type === "orchestration.error"), false);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed");
  await f.engine.recover(f.instance.id);
  assert.equal(f.events().filter(event => event.type === "orchestration.completed").length, boundary === "reflection" ? 0 : 1);
});

test("public engine host callback follows every turn and checkpoint thread while preserving submitted facts", async t => {
  const root = createTemporaryWorkspace(path.join(os.tmpdir(), "tool-engine-")), db = openClientDb({ dbPath: path.join(root, "application.db") });
  const preparation = new Error("engine-preparation-root"), diagnostic = new Error("engine-diagnostic-root");
  t.after(() => { t.mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = createRole({ defaultSkillIds: ["engine-execute-skill" as any] });
  const start: WorkflowNode = { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    node: WorkflowNode = { id: "execute", type: "role", roleId: role.id, label: "执行", position: { x: 0, y: 0 }, workItemPolicy: { mode: "sequential", maxItemsPerThread: 1 } };
  const workflow = createWorkflow([start, node], [{ id: "a", sourceNodeId: "start", targetNodeId: "execute", conditionBranch: null, dataMappings: [] }]);
  db.workspaces.upsert({ id: workflow.workspaceId, title: "执行", path: root });
  const skill = db.orchSkills.upsert({ id: "engine-execute-skill" as any, workspaceId: workflow.workspaceId, kind: "custom", name: "执行", description: "测试", trigger: "测试", instructions: "测试", slug: "engine-execute", targetEngines: ["claude"], skillMd: "# Skill",
    files: [{ relPath: "scripts/run.mjs", kind: "script", contentText: "import fs from 'node:fs'; fs.appendFileSync(process.env.CODEFLOWAI_TOOL_WORKSPACE_PATH+'/once.txt','1'); printJson({ok:true});", sizeBytes: 0, sha256: "" }],
    scripts: [{ id: "run", name: "执行", description: "测试", runtime: "node", scriptPath: "scripts/run.mjs", exposeAsTool: true }] });
  const instance = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role], skills: [skill] }) });
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    const target = String(args[0]);
    if (target.includes(path.join(".codeflow", "tool-runtime")) && path.basename(target) === "tool.mjs") throw preparation;
    return open(...args);
  });
  const writeWorkspaceLog = db.writeWorkspaceLog.bind(db);
  t.mock.method(db, "writeWorkspaceLog", (workspaceId, entry) => {
    writeWorkspaceLog(workspaceId, entry);
    if (entry.tag === "tool-runtime") throw diagnostic;
  });
  let original: any, sends = 0, executions = 0;
  const execute = ToolRuntimeService.prototype.execute;
  t.mock.method(ToolRuntimeService.prototype, "execute", function(this: ToolRuntimeService, ...args: Parameters<typeof execute>) {
    executions++; return execute.apply(this, args).catch(error => { original = error; throw error; });
  });
  const identities: Array<{ turnId: string; threadId: string }> = [];
  const sessions = { getOrCreate(thread: any) { return {
    resolvePlatformToolTransport: () => "native-dynamic",
    async sendMessage(input: any) {
      sends++; identities.push({ turnId: input.turnId, threadId: thread.threadId });
      const tool = input.toolRegistry.tools.find((item: any) => item.runtime === "node"); assert.ok(tool);
      await assert.rejects(input.executeHostTool({ toolId: tool.toolId, toolInput: {}, accessMode: "current" }), error => error === original);
      assert.equal(original.cause, preparation); assert.equal(original.errors[1], diagnostic);
      assert.equal(original.parentRequestId, input.turnId); assert.equal(original.turnId, input.turnId);
      assert.equal(original.threadId, thread.threadId); assert.equal(original.instanceId, instance.id); assert.equal(original.workspaceId, workflow.workspaceId);
      assert.equal(original.nodeId, node.id); assert.equal(original.attemptId, db.orchNodeAttempts.getLatestByNode(instance.id, node.id)!.id);
      // 此可控 session 模拟 provider 已明确投影工具失败后继续生成；真实 adapter 另行验证。
      if (sends === 1) {
        const created = await input.executeHostTool({ toolId: "runtime.workItems.create", toolInput: { items: [
          { clientKey: "a", title: "甲", sourceKey: "a", outputPath: "a.txt", acceptanceCriteria: [] },
          { clientKey: "b", title: "乙", sourceKey: "b", outputPath: "b.txt", acceptanceCriteria: [] }] }, accessMode: "current" });
        assert.equal(created.ok, true, JSON.stringify(created)); return { responseText: "已创建工作项" };
      }
      const item = db.orchNodeWorkItems.list({ instanceId: instance.id, nodeId: node.id }).items.find((item: any) => item.status !== "completed")!;
      fs.writeFileSync(path.join(root, item.outputPath!), "done");
      const updated = await input.executeHostTool({ toolId: "runtime.workItems.update", toolInput: { itemId: item.id, expectedVersion: item.version, patch: { status: "in_progress" } }, accessMode: "current" });
      assert.equal(updated.ok, true, JSON.stringify(updated));
      const current = db.orchNodeWorkItems.get(instance.id, node.id, item.id)!;
      const completed = await input.executeHostTool({ toolId: "runtime.workItems.complete", toolInput: { itemId: item.id, expectedVersion: current.version, resultSummary: "完成", evidence: [item.outputPath], outputPath: item.outputPath }, accessMode: "current" });
      assert.equal(completed.ok, true, JSON.stringify(completed));
      if (sends === 2) return { responseText: "第一项完成" };
      const submitted = await input.executeHostTool({ toolId: "runtime.submitNodeResult", toolInput: createTextFinalAnswer("完成"), accessMode: "current" });
      assert.equal(submitted.ok, true, JSON.stringify(submitted)); return { responseText: "完成" };
    },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
  }; } };
  const engine = new ProductionOrchestrationEngine({ db, threads: new ThreadStore(), workspaces: new Map([[workflow.workspaceId, root]]), sessions: sessions as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitRaw() {}, emitConversation(event) {
      if (event.type === "turn.started") db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine, turnId: event.payload.turnId!, startedAt: event.ts, startEventSeq: null });
      if (event.type === "turn.completed" || event.type === "turn.error") db.turns.setEnded(event.payload.turnId!, { status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: null });
    } });
  await engine.start(instance.id);
  assert.equal(sends, 3, JSON.stringify(db.orchInstances.get(instance.id)!.nodeStates)); assert.equal(executions, 3);
  assert.equal(fs.existsSync(path.join(root, "once.txt")), false);
  const retained = fs.readdirSync(path.join(root, ".codeflow", "tool-runtime"));
  assert.equal(retained.length, 3);
  assert.ok(retained.every(name => fs.existsSync(path.join(root, ".codeflow", "tool-runtime", name, "input.json"))));
  assert.equal(identities[0].threadId, identities[1].threadId); assert.notEqual(identities[1].threadId, identities[2].threadId);
  assert.equal(new Set(identities.map(item => item.turnId)).size, 3);
  assert.equal(db.orchInstances.get(instance.id)!.nodeStates[node.id].status, "completed");
  const entries = fs.readdirSync(path.join(root, ".codeflowai")).filter(name => name.endsWith(".log")).flatMap(name => fs.readFileSync(path.join(root, ".codeflowai", name), "utf8").trim().split("\n").map(line => JSON.parse(line))).filter(item => item.event?.category === "tool");
  assert.equal(entries.length, 3); assert.deepEqual(entries.map(item => ({ turnId: item.turnId, threadId: item.threadId })), identities);
});

test("managed service feedback background disposal retains settled final diagnostic for later public wait", async t => {
  const root = createTemporaryWorkspace(path.join(os.tmpdir(), "managed-feedback-")), db = openClientDb({ dbPath: path.join(root, "application.db") });
  const role = createRole(), node: WorkflowNode = { id: "approval", type: "role", roleId: role.id, label: "服务审批", position: { x: 0, y: 0 } }, workflow = createWorkflow([node], []);
  db.workspaces.upsert({ id: workflow.workspaceId, title: "服务", path: root });
  const threadId = "managed-feedback-thread" as ThreadId;
  db.threads.create({ id: threadId, workspaceId: workflow.workspaceId, engine: "codex", title: "服务" });
  const instance = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }) });
  db.orchInstances.updateNodeStates(instance.id, { approval: { nodeId: "approval", status: "waiting-approval", retryCount: 0, threadId } });
  db.orchInstances.updateStatus(instance.id, "waiting-approval");
  const engine = new ProductionOrchestrationEngine({ db, threads: new ThreadStore(), workspaces: new Map([[workflow.workspaceId, root]]), sessions: {} as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {} });
  const runtime = (engine as any).managedServiceRuntime;
  await runtime.executeBuiltinTool(runtime.buildBuiltinTools()[0], { action: "ensure", serviceId: "feedback", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 100 } }, { workspacePath: root, threadId, instanceId: instance.id });
  const child = runtime.servicesByThread.get(threadId).get("feedback").child, kill = child.kill.bind(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("feedback cleanup timeout")), 3000); child.once("exit", () => { clearTimeout(timeout); resolve(); }); if (!kill()) reject(new Error("feedback cleanup refused")); });
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const business = new Error("feedback-kill-root"), logging = new Error("feedback-log-root"), contextLogging = new Error("feedback-context-log-root");
  child.kill = () => { throw business; };
  t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
  let contextWrites = 0;
  mockLifecycleLog(t, db, (tag: string, message: string) => { if (tag === "orchestration" && message === "managed runtime disposal failed") { contextWrites++; throw contextLogging; } });
  await engine.submitFeedback(instance.id, "approval", "abort");
  await nextTimerTick(); await nextTimerTick();
  assert.equal(engine.hasInFlightWork(), false, "失败已结算，不应继续报告在途");
  let failure: any;
  await assert.rejects(engine.waitForInFlightWork({ requestId: "feedback-wait", timeoutMs: 1000 }), (error: any) => {
    failure = error;
    assert.equal(error.errors[0].errors[0].cause, business);
    assert.equal(error.errors[0].errors[1], logging);
    assert.equal(error.errors[1], contextLogging);
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
  assert.equal(contextWrites, 1);
  assert.equal((engine as any).managedRuntimeDisposalPromises.size, 0);
  await engine.waitForInFlightWork({ timeoutMs: 1000 });
  assert.ok(failure);
  child.kill = kill;
  await assert.rejects(engine.disposeManagedServicesForThread(threadId), (error: any) => error.errors[0].cause === business);
});

test("managed service coordinator diagnosis preserves original aggregate across public start and wait", async t => {
  const root = createTemporaryWorkspace(path.join(os.tmpdir(), "managed-coordinator-")), db = openClientDb({ dbPath: path.join(root, "application.db") });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = createRole(), workflow = createWorkflow([], []);
  db.workspaces.upsert({ id: workflow.workspaceId, title: "服务", path: root });
  const instance = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }) });
  const engine = new ProductionOrchestrationEngine({ db, threads: new ThreadStore(), workspaces: new Map([[workflow.workspaceId, root]]), sessions: {} as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {} });
  const business = new Error("managed-coordinator-business"), logging = new Error("managed-coordinator-log"), diagnostic = new Error("managed-coordinator-context");
  const failure = Object.assign(new AggregateError([business, logging], "MANAGED_SERVICE_FAILURE_LOG_FAILED", { cause: business }), { code: "MANAGED_SERVICE_FAILURE_LOG_FAILED" });
  t.mock.method(engine as any, "executeDAG", async () => { throw failure; });
  const logs: any[] = [];
  mockLifecycleLog(t, db, (_tag: string, message: string, data: unknown) => { logs.push(data); if (message === "instance coordinator failed") throw diagnostic; });
  await engine.startInBackground(instance.id, "managed-coordinator-request");
  await nextTimerTick();
  await assert.rejects(engine.waitForInFlightWork({ timeoutMs: 1000 }), (error: any) => { assert.ok(error instanceof AggregateError, "协调器诊断不能覆盖原托管聚合"); assert.equal(error.errors[0], failure); assert.equal(error.errors[1], diagnostic); assert.equal(error.cause, failure); return true; });
  assert.equal(logs[0].rootCause.errors[0].message, "managed-coordinator-business");
  assert.equal(logs[0].rootCause.errors[1].message, "managed-coordinator-log");
});

for (const mode of ["start", "background"] as const) test(`F3 runtime 自产启动清理聚合经公开 ${mode} 保因且不触发角色重试`, async t => {
  const root = createTemporaryWorkspace(path.join(os.tmpdir(), "managed-f3-")), db = openClientDb({ dbPath: path.join(root, "application.db") });
  const role = createRole(), node: WorkflowNode = { id: "managed", type: "role", label: "托管", roleId: role.id, position: { x: 0, y: 0 }, failPolicy: "skip" };
  role.executionConfig.engineProfiles.claude.customConfig!.maxRetries = 2;
  const start: WorkflowNode = { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } };
  const workflow = createWorkflow([start, node], [{ id: "start-managed", sourceNodeId: start.id, targetNodeId: node.id, conditionBranch: null, dataMappings: [] }]);
  db.workspaces.upsert({ id: workflow.workspaceId, title: "托管", path: root });
  const threadId = "managed-f3-thread" as ThreadId;
  db.threads.create({ id: threadId, workspaceId: workflow.workspaceId, engine: "codex", title: "托管" });
  const instance = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }) });
  const engine = new ProductionOrchestrationEngine({ db, threads: new ThreadStore(), workspaces: new Map([[workflow.workspaceId, root]]), sessions: {} as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {} });
  const runtime = (engine as any).managedServiceRuntime, startup = new Error("F3-startup"), cleanup = new Error("F3-cleanup"), logging = new Error("F3-cleanup-log"), diagnostic = new Error("F3-coordinator-log");
  let child: import("node:child_process").ChildProcess | undefined, kill: (() => boolean) | undefined, dispatches = 0, writes = 0, wrapper: any;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("F3 cleanup timeout")), 3000); child!.once("exit", () => { clearTimeout(timeout); resolve(); }); if (!kill!()) reject(new Error("F3 cleanup signal refused")); });
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(runtime, "checkReady", async (record: any) => { child = record.child; kill = child!.kill.bind(child); child!.kill = () => { throw cleanup; }; throw startup; });
  const write = db.writeWorkspaceLog.bind(db);
  t.mock.method(db, "writeWorkspaceLog", ((...args: Parameters<typeof write>) => { if (++writes === 1) return write(...args); throw logging; }) as typeof db.writeWorkspaceLog);
  /** 只隔离外部 provider 派发，其失败来自实际 runtime 公开启动与清理尾链。 */
  t.mock.method(engine as any, "executeSubThread", async () => {
    dispatches++;
    try { return await runtime.executeBuiltinTool(runtime.buildBuiltinTools()[0], { action: "ensure", serviceId: "f3", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, { workspacePath: root, threadId, instanceId: instance.id }); }
    catch (error) { if (dispatches === 1) wrapper = error; throw error; }
  });
  mockLifecycleLog(t, db, (_tag: string, message: string) => { if (message === "instance coordinator failed") throw diagnostic; });
  let publicFailure: any;
  const waiting = mode === "start" ? engine.start(instance.id) : engine.startInBackground(instance.id, "F3-request").then(() => engine.waitForInFlightWork({ timeoutMs: 3000 }));
  await assert.rejects(waiting, (error: any) => {
    assert.equal(dispatches, 1, "合法自产 startup-cleanup 诊断必须阻止角色重试");
    assert.ok(error instanceof AggregateError, "合法 startup-cleanup 外壳不能被 retry/failPolicy 或新诊断吞掉");
    publicFailure = coordinatorWaitFailure(error, "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED");
    assert.equal(publicFailure.errors[0], wrapper); assert.equal(publicFailure.errors[1], diagnostic); assert.equal(publicFailure.cause, wrapper);
    assert.equal(wrapper.message, "MANAGED_SERVICE_STARTUP_CLEANUP_FAILED"); assert.equal(wrapper.code, "MANAGED_SERVICE_FAILURE_LOG_FAILED");
    assert.equal(wrapper.errors[0], startup); assert.equal(wrapper.errors[1].errors[0].cause, cleanup); assert.equal(wrapper.errors[1].errors[1], logging);
    return true;
  });
  assert.equal(dispatches, 1); assert.equal(writes, 2); assert.equal(db.orchInstances.get(instance.id)!.nodeStates.managed!.retryCount, 0);
  if (mode === "start") await engine.waitForInFlightWork({ timeoutMs: 3000 });
  child!.kill = kill!;
  await assert.rejects(engine.disposeManagedServicesForThread(threadId), error => error === wrapper);
  assert.notEqual(child!.exitCode ?? child!.signalCode, null); assert.ok(publicFailure);
});

const ACTIVE_ATTEMPT_STATUSES = new Set<OrchNodeAttemptStatus>(["running", "result-submitted", "finalizing"]);

for (const mode of ["start", "background", "diagnostic", "inactive", "cleanup", "descriptor", "parallel", "parallel-background", "logged",
  "f1-cancel-start", "f1-terminal-start", "f1-cancel-parallel-start", "f1-terminal-parallel-start"] as const) test(`public Skill materialize DAG ${mode} retains original failures without retry`, async t => {
  const f1 = mode.startsWith("f1-"), f1Parallel = mode === "f1-cancel-parallel-start" || mode === "f1-terminal-parallel-start";
  const parallelMode = mode === "parallel" || mode === "parallel-background" || f1Parallel;
  const sequence: string[] = [];
  const root = createTemporaryWorkspace(path.join(os.tmpdir(), "skill-coordinator-")), db = openClientDb({ dbPath: path.join(root, "application.db") });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = createRole(), start: WorkflowNode = { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    node: WorkflowNode = { id: "skill", type: "role", label: "Skill😀", roleId: role.id, failPolicy: "skip", position: { x: 0, y: 0 } },
    next: WorkflowNode = { id: "next", type: "role", label: "后续", roleId: role.id, position: { x: 0, y: 0 } };
  const workflow = createWorkflow([start, node, next], [{ id: "a", sourceNodeId: "start", targetNodeId: "skill", conditionBranch: null, dataMappings: [] },
    { id: "b", sourceNodeId: "skill", targetNodeId: "next", conditionBranch: null, dataMappings: [] }]);
  db.workspaces.upsert({ id: workflow.workspaceId, title: "Skill", path: root });
  const skill = db.orchSkills.upsert({ id: "coordinator-skill" as any, workspaceId: workflow.workspaceId, name: "Skill", description: "测试", trigger: "测试", instructions: "测试", slug: "coordinator-skill", targetEngines: ["claude"],
    skillMd: "PRIVATE_SKILL_BODY", files: [{ relPath: "scripts/run.mjs", kind: "script", contentText: "PRIVATE_SCRIPT", sizeBytes: 0, sha256: "" }],
    scripts: [{ id: "run", name: "运行", description: "测试", scriptPath: "scripts/run.mjs", runtime: "node", exposeAsTool: true }] });
  role.defaultSkillIds = [skill.id]; role.executionConfig.engineProfiles.claude.customConfig!.maxRetries = 2;
  if (mode === "logged") { node.failPolicy = "stop"; role.executionConfig.engineProfiles.claude.customConfig!.maxRetries = 0; }
  const otherRole = createRole({ id: "parallel-role" as any, defaultSkillIds: [] });
  if (parallelMode) {
    const parallelNode: WorkflowNode = { id: "parallel", type: "role", label: "已启动并发", roleId: otherRole.id, position: { x: 0, y: 0 } };
    if (f1Parallel) workflow.nodes.splice(1, 0, parallelNode);
    else workflow.nodes.push(parallelNode);
    workflow.edges.push({ id: "p", sourceNodeId: "start", targetNodeId: "parallel", conditionBranch: null, dataMappings: [] });
  }
  const instance = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role, otherRole], skills: [skill] }) });
  let providers = 0, writes = 0;
  const engine = new ProductionOrchestrationEngine({ db, threads: new ThreadStore(), workspaces: new Map([[workflow.workspaceId, root]]),
    sessions: { getOrCreate() { providers++; throw new Error("UNEXPECTED_PROVIDER"); } } as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {} });
  const diagnostic = new Error("skill-context-log-root"), logging = mode === "f1-terminal-start" ? false : new Error("skill-log-root"), cleanup = new Error("skill-release-root");
  let descriptorReads = 0;
  const business = mode === "descriptor" ? new Proxy(Object.assign(new Error("PRIVATE_SKILL_BODY"), { code: "EIO" }), {
    getOwnPropertyDescriptor(target, key) { if (key === "name" && ++descriptorReads > 1) throw diagnostic; return Reflect.getOwnPropertyDescriptor(target, key); },
  }) : Object.assign(new Error("PRIVATE_SKILL_BODY"), { code: "EIO" });
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (String(args[0]).includes(".building-") && String(args[0]).endsWith(`${path.sep}run.mjs`)) throw business; return write(...args); });
  const writeWorkspaceLog = db.writeWorkspaceLog.bind(db);
  t.mock.method(db, "writeWorkspaceLog", ((workspaceId, entry) => {
    if (entry.tag !== "skill-runtime") return writeWorkspaceLog(workspaceId, entry);
    writes++;
    if (mode === "logged") return writeWorkspaceLog(workspaceId, entry);
    if (mode === "inactive") { (engine as any).runningInstances.get(instance.id).cancelled = true; }
    if (f1) {
      const cancelled = mode === "f1-cancel-start" || mode === "f1-cancel-parallel-start";
      if (cancelled) (engine as any).runningInstances.get(instance.id).cancelled = true;
      db.orchInstances.updateStatus(instance.id, cancelled ? "cancelled" : "failed");
      sequence.push("log-failed");
    }
    throw logging;
  }) as typeof db.writeWorkspaceLog);
  mockLifecycleLog(t, db, (_tag: string, message: string, data: any) => {
    assert.equal(JSON.stringify(data).includes("PRIVATE_SKILL_BODY"), false);
    if (mode === "diagnostic" && message === "instance coordinator failed") throw diagnostic;
  });
  if (mode === "cleanup" || parallelMode) t.mock.method((engine as any).managedServiceRuntime, "disposeInstanceServices", async () => { sequence.push("managed-release"); throw cleanup; });
  let releaseParallel!: () => void, enteredParallel!: () => void;
  const entered = new Promise<void>(resolve => { enteredParallel = resolve; }), parallel = new Promise<void>(resolve => { releaseParallel = resolve; });
  if (parallelMode) t.mock.method(engine as any, "executeSubThread", async () => { sequence.push("parallel-enter"); enteredParallel(); await parallel; sequence.push("parallel-finish"); return { responseText: "完成" }; });
  if (mode === "logged") {
    await engine.start(instance.id);
    const allEntries = fs.readdirSync(path.join(root, ".codeflowai")).filter(name => name.endsWith(".log")).flatMap(name =>
      fs.readFileSync(path.join(root, ".codeflowai", name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    const entries = allEntries.filter(entry => entry.event?.category === "skill");
    assert.equal(entries.length, 1, "节点准备必须写入持久 instance 的物理 W");
    assert.equal(entries[0].workspaceId, workflow.workspaceId); assert.equal(entries[0].instanceId, instance.id); assert.equal(entries[0].nodeId, node.id);
    assert.equal(entries[0].attemptId, db.orchNodeAttempts.getLatestByNode(instance.id, node.id)!.id);
    assert.equal(entries[0].requestId, `node-attempt:${entries[0].attemptId}`); assert.equal(entries[0].threadId, null);
    assert.equal(entries[0].event.action, "materialize"); assert.equal(entries[0].rootCause.code, "EIO");
    assert.equal(JSON.stringify(allEntries).includes("PRIVATE_SKILL_BODY"), false); assert.equal(writes, 1); assert.equal(providers, 0);
    assert.equal(db.orchNodeAttempts.getLatestByNode(instance.id, "next"), null);
    return;
  }
  let result: any;
  const pending = mode === "start" || mode === "parallel" || f1 ? engine.start(instance.id) : engine.startInBackground(instance.id, "skill-background-request").then(async () => {
    if (mode !== "parallel-background") { await nextTimerTick(); await nextTimerTick(); assert.equal(engine.hasInFlightWork(), false, "settled failed owner 不应计为在途"); }
    try { return await engine.waitForInFlightWork({ timeoutMs: 3000 }); }
    finally { if (mode === "inactive") (engine as any).runningInstances.delete(instance.id); }
  });
  if (parallelMode) {
    await entered;
    const early = await Promise.race([pending.then(() => "settled", () => "settled"), new Promise<string>(resolve => setTimeout(() => resolve("pending"), 20))]);
    releaseParallel();
    await assert.rejects(pending, () => true);
    assert.equal(early, "pending", "公开 start 必须收齐已启动并发尾链");
  }
  await assert.rejects(pending, (error: any) => { result = error; return true; });
  const seen = new Set<unknown>();
  /** 仅检查测试中实际收到的原 Aggregate，不替换产品 owner。 */
  function visit(value: unknown): void { if (seen.has(value)) return; seen.add(value); if (value instanceof AggregateError) for (const item of value.errors) visit(item); if (value instanceof Error && Object.hasOwn(value, "cause")) visit(value.cause); }
  visit(result);
  const failure = [...seen].find((value: any) => value?.code === "SKILL_RUNTIME_FAILURE_LOG_FAILED" && value?.message === "SKILL_RUNTIME_FAILURE_LOG_FAILED") as any;
  assert.ok(failure); assert.equal(failure.errors[0].cause, business); assert.equal(failure.errors[1], logging); assert.equal(failure.cause, failure.errors[0]);
  if (mode === "diagnostic" || mode === "descriptor") assert.ok(seen.has(diagnostic));
  if (mode === "cleanup" || parallelMode) assert.ok(seen.has(cleanup));
  if (f1Parallel) assert.deepEqual(sequence, ["parallel-enter", "log-failed", "parallel-finish", "managed-release"], "已启动执行尾链必须先于 managed 释放");
  if (f1) {
    assert.equal(db.orchInstances.get(instance.id)!.status, mode.includes("cancel") ? "cancelled" : "failed", "控制事实不得回滚");
    assert.equal(db.orchEvents.listByInstance(instance.id).filter(event => event.type === "orchestration.error").length, 0, "已持久终态不再次流转或补发协调器失败事件");
  }
  assert.equal(writes, 1); assert.equal(providers, 0); assert.equal(db.orchInstances.get(instance.id)!.nodeStates.skill!.retryCount, 0);
  assert.equal(db.orchNodeAttempts.getLatestByNode(instance.id, "skill")!.attemptNo, 1);
  assert.equal(db.orchNodeAttempts.getLatestByNode(instance.id, "next"), null);
  if (mode === "start" || mode === "parallel" || f1) await engine.waitForInFlightWork({ timeoutMs: 3000 });
});

test.before(() => {
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] });
});
test.after(() => { resetEngineModelCatalogRuntimeForTest(); });

test("background start rejects preparation failures and accepts a real pending coordinator without awaiting the DAG", async t => {
  const directory = createTemporaryWorkspace(path.join(os.tmpdir(), "desktop-orch-start-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const role = createRole(), workflow = createWorkflow([], []);
  db.workspaces.upsert({ id: workflow.workspaceId, title: "启动", path: directory });
  const instance = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }) });
  const engine = new ProductionOrchestrationEngine({ db, workspaces: new Map([[workflow.workspaceId, directory]]), threads: new ThreadStore(), sessions: {} as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {} });
  assert.equal(typeof (engine as any).startInBackground, "function");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  (engine as any).executeDAG = async () => { await gate; throw new Error("controlled coordinator failure"); };
  const logs: any[][] = [];
  mockLifecycleLog(t, db, (...args: any[]) => { logs.push(args); });
  await (engine as any).startInBackground(instance.id, "start-request");
  assert.equal(db.orchInstances.get(instance.id)?.status, "running");
  assert.equal(db.orchEvents.listByInstance(instance.id).filter(event => event.type === "orchestration.started").length, 1);
  release();
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(db.orchInstances.get(instance.id)?.status, "failed");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![2].requestId, "start-request");
  assert.equal(logs[0]![2].instanceId, instance.id);
  const rejected = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot });
  await assert.rejects((engine as any).startInBackground(rejected.id, "rejected-request"), /完整运行快照/);
  assert.equal(db.orchInstances.get(rejected.id)?.status, "failed");
  assert.equal(db.orchEvents.listByInstance(rejected.id).some(event => event.type === "orchestration.started"), false);
  const preparationFailure = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }) });
  const emit = (engine as any).emitOrchEvent.bind(engine);
  (engine as any).emitOrchEvent = (value: any, type: string, payload: any) => {
    if (value.id === preparationFailure.id && type === "orchestration.started") throw new Error("controlled start event failure");
    return emit(value, type, payload);
  };
  await assert.rejects(engine.startInBackground(preparationFailure.id, "preparation-request"), /controlled start event failure/);
  assert.equal(db.orchInstances.get(preparationFailure.id)?.status, "failed");
  assert.equal((engine as any).runningInstances.has(preparationFailure.id), false);
  assert.equal((engine as any).continuationPromises.size, 0);
  const interrupted = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }) });
  let rejectDrive!: (error: Error) => void;
  (engine as any).executeDAG = () => new Promise<void>((_resolve, reject) => { rejectDrive = reject; });
  await engine.startInBackground(interrupted.id, "shutdown-request");
  const drained = engine.stopAndDrain();
  rejectDrive(new Error("controlled shutdown failure"));
  await assert.rejects(drained, /controlled shutdown failure/);
  assert.equal(db.orchInstances.get(interrupted.id)?.status, "running", "关闭不能把需重启恢复的实例写成失败");
  assert.equal(logs.length, 2, "普通失败与关闭失败由各自 coordinator 只记录一次");
});

/** 公开启动沿真实 Profile、角色、DAG 与 coordinator；只隔离外部 provider 和指定日志故障。 */
function coordinatorProfileFixture(t: test.TestContext, logging: unknown) {
  const root = createTemporaryWorkspace(path.join(os.tmpdir(), "coordinator-profile-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = createRole(), node: WorkflowNode = { id: "profile", type: "role", label: "Profile 中文😀", roleId: role.id,
    position: { x: 0, y: 0 }, failPolicy: "skip" };
  role.executionConfig.engineProfiles.claude.customConfig!.maxRetries = 2;
  const start: WorkflowNode = { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } };
  const workflow = createWorkflow([start, node], [{ id: "start-profile", sourceNodeId: start.id, targetNodeId: node.id, conditionBranch: null, dataMappings: [] }]),
    scope = { scopeType: "shared_workspace" as const, scopeId: "business-shared" };
  db.workspaces.upsert({ id: workflow.workspaceId, title: "物理工作区", path: root });
  db.withWorkspaceExecutionProfiles(workflow.workspaceId, repo => repo.upsert({ scope, userId: "用户😀", profileText: "PRIVATE_PROFILE_BODY" }));
  const damaged = new DatabaseSync(path.join(root, ".codeflowai/workspace.db"));
  try { damaged.exec("ALTER TABLE workspace_execution_profiles RENAME TO damaged_profiles"); } finally { damaged.close(); }
  const instance = db.orchInstances.create({ workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot, assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    runtimeConfig: { executionProfileScope: scope, initiatorUserId: "用户😀" } as any });
  let providers = 0, business: unknown;
  const read = db.withWorkspaceExecutionProfiles.bind(db);
  t.mock.method(db, "withWorkspaceExecutionProfiles", ((...args: Parameters<typeof read>) => {
    try { return read(...args); } catch (error) { business = error; throw error; }
  }) as typeof db.withWorkspaceExecutionProfiles);
  const write = db.writeWorkspaceLog.bind(db);
  t.mock.method(db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.tag === "workspace-profile") throw logging; return write(workspaceId, entry); }) as typeof write);
  const engine = new ProductionOrchestrationEngine({ db, workspaces: new Map([[workflow.workspaceId, root]]), threads: new ThreadStore(),
    sessions: { getOrCreate() { providers++; throw new Error("UNEXPECTED_PROVIDER"); } } as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {} });
  return { db, engine, instance, node, business: () => business, providers: () => providers,
    /** 同引擎后续空实例证明单实例故障没有扩大。 */
    async startOther() {
      const empty = createWorkflow([], []), other = db.orchInstances.create({ workspaceId: empty.workspaceId, workflowId: empty.id,
        workflowSnapshot: empty, intakeSnapshot: createInstance(role, empty).intakeSnapshot,
        assetRuntimeSnapshot: createAssetRuntimeSnapshot(empty, { roles: [role] }) });
      await engine.start(other.id); assert.equal(db.orchInstances.get(other.id)!.status, "completed");
    } };
}

/** 验证保留原对象和 cause，递归只用于本测试已知 Aggregate。 */
function assertProfileCoordinatorCauses(error: unknown, business: unknown, logging: unknown): AggregateError {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, "WORKSPACE_PROFILE_FAILURE_LOG_FAILED");
  assert.equal(error.errors[0], business); assert.equal(error.errors[1], logging); assert.equal(error.cause, business);
  return error;
}

/** 原 wait 可同时观察节点与协调器；保留并核验其原聚合包装。 */
function coordinatorWaitFailure(error: unknown, title: string): AggregateError {
  assert.ok(error instanceof AggregateError);
  if (error.message !== "ORCHESTRATION_IN_FLIGHT_WORK_FAILED") { assert.equal(error.message, title); return error; }
  assert.equal(error.errors.length, 2);
  const failure = error.errors.find(item => item instanceof AggregateError && item.message === title);
  assert.ok(failure instanceof AggregateError);
  const original = title === "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED" ? failure.errors[0].errors[0] : failure.errors[0];
  assert.equal(error.errors.find(item => item !== failure), original);
  return failure;
}

test("public Profile DAG coordinator preserves safe two-cause diagnosis and original failed outcome", async t => {
  let getterReads = 0;
  const logging = Object.assign(new Error("PRIVATE_LOG password=SECRET\nstack"), { errno: -5, cause: undefined });
  Object.defineProperty(logging, "code", { get() { getterReads++; throw new Error("UNEXPECTED_GETTER"); } });
  const f = coordinatorProfileFixture(t, logging), logs: any[][] = [];
  mockLifecycleLog(t, f.db, (...args: any[]) => { if (args[1] === "node Profile read failed before dispatch") throw logging; logs.push(args); });
  await f.engine.start(f.instance.id);
  await f.engine.waitForInFlightWork();
  assert.notEqual(f.business(), undefined, "真实 DAG 必须执行 Profile 读取");
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "failed");
  assert.equal(f.providers(), 0); assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
  assert.equal(logs.length, 1);
  const payload = logs[0]![2]; assert.equal(payload.errorCode, "ORCHESTRATION_COORDINATOR_FAILED");
  assert.equal(payload.workspaceId, f.instance.workspaceId); assert.equal(payload.instanceId, f.instance.id);
  const attempt = f.db.orchNodeAttempts.getLatestByNode(f.instance.id, f.node.id)!;
  assert.equal(payload.nodeId, f.node.id); assert.equal(payload.attemptId, attempt.id); assert.equal(payload.requestId, `node-attempt:${attempt.id}`);
  assert.equal(payload.rootCause.errors.length, 2); assert.equal(payload.rootCause.errors[0].code, "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED");
  assert.equal(payload.rootCause.errors[0].cause.reason, "WORKSPACE_DB_SCHEMA_INVALID");
  assert.equal(payload.rootCause.errors[1].errno, -5); assert.equal(payload.rootCause.errors[1].cause.type, "undefined");
  assert.equal(getterReads, 0); assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_|SECRET|password|stack/);
  assert.equal(f.db.orchEvents.listByInstance(f.instance.id).filter(event => event.type === "orchestration.error").length, 1);
  await f.startOther();
});

test("public Profile background coordinator diagnostic failure stays observable with no later business effects", async t => {
  const logging = new Error("PRIVATE_LOG"), diagnostic = new Error("DIAGNOSTIC_FAILED"), f = coordinatorProfileFixture(t, logging);
  const logs: any[][] = [];
  mockLifecycleLog(t, f.db, (...args: any[]) => {
    logs.push(args); if (args[1] === "instance coordinator failed") throw diagnostic;
  });
  await f.engine.startInBackground(f.instance.id, "request-中文😀");
  await assert.rejects(f.engine.waitForInFlightWork(), error => {
    const failure = coordinatorWaitFailure(error, "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED");
    assertProfileCoordinatorCauses(failure.errors[0], f.business(), logging); assert.equal(failure.errors[1], diagnostic); assert.equal(failure.cause, failure.errors[0]); return true;
  });
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "running");
  const state = f.db.orchInstances.get(f.instance.id)!.nodeStates[f.node.id]!;
  assert.equal(state.status, "running"); assert.equal(state.retryCount, 0); assert.equal(state.attemptNo, 1);
  assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, f.node.id)!.status, "running");
  assert.equal(f.db.orchEvents.listByInstance(f.instance.id).filter(event => event.type === "orchestration.error").length, 0);
  assert.equal(f.providers(), 0); assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
  assert.equal(logs.length, 2); assert.equal(logs[1]![2].rootCause.errors[0].errors.length, 2);
  assert.equal(logs[1]![2].requestId, "request-中文😀");
  await f.startOther();
});

test("public Profile final background diagnostic promise retains fourth cause for stopAndDrain without orphan rejection", async t => {
  const logging = false, diagnostic = undefined, background = new Error("BACKGROUND_DIAGNOSTIC_FAILED"), f = coordinatorProfileFixture(t, logging);
  const orphan: unknown[] = [], onUnhandled = (error: unknown) => { orphan.push(error); };
  process.on("unhandledRejection", onUnhandled); t.after(() => process.off("unhandledRejection", onUnhandled));
  mockLifecycleLog(t, f.db, (_tag: string, message: string) => {
    if (message === "instance coordinator failed") throw diagnostic;
    if (message === "background start did not settle") throw background;
  });
  await f.engine.startInBackground(f.instance.id, "request-background");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.engine.hasInFlightWork(), false);
  await assert.rejects(f.engine.stopAndDrain(), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.message, "ORCHESTRATION_BACKGROUND_START_DIAGNOSTIC_FAILED");
    const coordinator = error.errors[0]; assert.ok(coordinator instanceof AggregateError);
    assertProfileCoordinatorCauses(coordinator.errors[0], f.business(), logging); assert.equal(coordinator.errors[1], diagnostic);
    assert.equal(error.errors[1], background); assert.equal(error.cause, coordinator); return true;
  });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(orphan, []);
  assert.equal((f.engine as any).continuationPromises.size, 0); assert.equal(f.providers(), 0);
});

test("public Profile coordinator cleanup retains latest diagnostic cause and cancellation facts", async t => {
  const logging = new Error("PRIVATE_LOG"), diagnostic = new Error("DIAGNOSTIC_FAILED"), cleanup = new Error("CLEANUP_FAILED");
  const f = coordinatorProfileFixture(t, logging); let cleanups = 0;
  mockLifecycleLog(t, f.db, (_tag: string, message: string) => {
    if (message === "instance coordinator failed") {
      f.db.orchInstances.updateStatus(f.instance.id, "cancelled");
      (f.engine as any).runningInstances.get(f.instance.id).cancelled = true;
      throw diagnostic;
    }
  });
  (f.engine as any).disposeManagedRuntime = async () => { cleanups++; throw cleanup; };
  await f.engine.startInBackground(f.instance.id, "request-cleanup");
  await assert.rejects(f.engine.waitForInFlightWork(), error => {
    const failure = coordinatorWaitFailure(error, "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED");
    const coordinator = failure.errors[0]; assert.ok(coordinator instanceof AggregateError);
    assert.equal(coordinator.message, "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED");
    assertProfileCoordinatorCauses(coordinator.errors[0], f.business(), logging);
    assert.equal(coordinator.errors[1], diagnostic); assert.equal(failure.errors[1], cleanup); return true;
  });
  assert.equal(cleanups, 1); assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "cancelled");
  assert.equal(f.db.orchEvents.listByInstance(f.instance.id).filter(event => event.type === "orchestration.error").length, 0);
});

test("public Profile stopped coordinator preserves safe causes and running recovery facts", async t => {
  const logging = new Error("PRIVATE_LOG"), f = coordinatorProfileFixture(t, logging), logs: any[][] = [];
  const dag = (f.engine as any).executeDAG.bind(f.engine);
  // 保留真实 DAG 原拒绝，只在交给 coordinator 的边界模拟关闭竞态。
  (f.engine as any).executeDAG = async (...args: unknown[]) => { try { await dag(...args); } catch (error) { f.engine.stop(); throw error; } };
  mockLifecycleLog(t, f.db, (...args: any[]) => { logs.push(args); });
  await f.engine.startInBackground(f.instance.id, "request-stopped");
  await assert.rejects(f.engine.waitForInFlightWork(), error => { assertProfileCoordinatorCauses(error, f.business(), logging); return true; });
  await f.engine.stopAndDrain();
  assert.equal(logs.length, 1); assert.equal(logs[0]![1], "instance coordinator stopped after execution error");
  assert.equal(logs[0]![2].rootCause.errors.length, 2); assert.equal(logs[0]![2].requestId, "request-stopped");
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "running");
  assert.equal(f.providers(), 0); assert.equal(f.db.orchEvents.listByInstance(f.instance.id).filter(event => event.type === "orchestration.error").length, 0);
});

test("public Profile diagnostic reads array descriptors without invoking unknown get traps", async t => {
  let reads = 0;
  const logging = new AggregateError([false], "PRIVATE_LOG");
  logging.errors = new Proxy(logging.errors, { get() { reads++; throw new Error("UNKNOWN_ARRAY_GET"); } });
  const f = coordinatorProfileFixture(t, logging), logs: any[][] = [];
  mockLifecycleLog(t, f.db, (...args: any[]) => { logs.push(args); });
  await f.engine.start(f.instance.id);
  await f.engine.waitForInFlightWork();
  assert.equal(reads, 0); assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "failed");
  assert.equal(logs.length, 1); assert.deepEqual(logs[0]![2].rootCause.errors[1].errors, [{ type: "boolean" }]);
  assert.equal(f.providers(), 0); assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
});

for (const mode of ["start", "background", "cleanup"] as const) {
  test(`public Profile diagnostic construction failure preserves original causes through ${mode}`, async t => {
    const logging = new AggregateError([], "PRIVATE_LOG"), diagnostic = new Error("DIAGNOSTIC_DESCRIPTOR_FAILED"), cleanup = new Error("CLEANUP_FAILED");
    const f = coordinatorProfileFixture(t, logging), logs: any[][] = [];
    logging.errors = new Proxy([], { get(target, key, receiver) {
      if (key === "length") throw diagnostic;
      return Reflect.get(target, key, receiver);
    }, getOwnPropertyDescriptor(target, key) {
      if (key === "length") {
        if (mode === "cleanup") {
          f.db.orchInstances.updateStatus(f.instance.id, "cancelled");
          (f.engine as any).runningInstances.get(f.instance.id).cancelled = true;
        }
        throw diagnostic;
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    mockLifecycleLog(t, f.db, (...args: any[]) => { logs.push(args); });
    if (mode === "cleanup") (f.engine as any).disposeManagedRuntime = async () => { throw cleanup; };
    const waiting = mode === "start" ? f.engine.start(f.instance.id) : f.engine.startInBackground(f.instance.id, `request-${mode}`)
      .then(() => f.engine.waitForInFlightWork());
    await assert.rejects(waiting, error => {
      assert.ok(error instanceof AggregateError);
      const title = mode === "cleanup" ? "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED" : mode === "background"
        ? "ORCHESTRATION_BACKGROUND_START_DIAGNOSTIC_FAILED" : "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED";
      const outer = error.message === "ORCHESTRATION_IN_FLIGHT_WORK_FAILED"
        ? error.errors.find(item => item instanceof AggregateError && item.message === title) : error;
      assert.ok(outer instanceof AggregateError);
      if (mode === "cleanup") {
        assert.equal(outer.message, "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED"); assert.equal(outer.errors[1], cleanup);
      } else if (mode === "background") {
        assert.equal(outer.message, "ORCHESTRATION_BACKGROUND_START_DIAGNOSTIC_FAILED"); assert.equal(outer.errors[1], diagnostic); assert.equal(outer.cause, outer.errors[0]);
      }
      const coordinator = mode === "start" ? outer : outer.errors[0];
      assert.ok(coordinator instanceof AggregateError); assert.equal(coordinator.message, "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED");
      assertProfileCoordinatorCauses(coordinator.errors[0], f.business(), logging);
      assert.equal(coordinator.errors[1], diagnostic); assert.equal(coordinator.cause, coordinator.errors[0]); return true;
    });
    assert.equal(f.db.orchInstances.get(f.instance.id)!.status, mode === "cleanup" ? "cancelled" : "running");
    const state = f.db.orchInstances.get(f.instance.id)!.nodeStates[f.node.id]!;
    assert.equal(state.retryCount, 0); assert.equal(state.attemptNo, 1);
    assert.equal(f.db.orchEvents.listByInstance(f.instance.id).filter(event => event.type === "orchestration.error").length, 0);
    assert.equal(f.providers(), 0); assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
    assert.equal(logs.filter(args => args[1] === "instance coordinator failed").length, 0);
    if (mode === "start") await f.startOther();
  });
}
const TERMINAL_ATTEMPT_STATUSES = new Set<OrchNodeAttemptStatus>([
  "completed",
  "waiting-approval",
  "waiting-feedback",
  "rework",
  "failed",
  "skipped",
  "cancelled",
]);

/** 创建测试专用 Attempt 仓储，保持提交、失效和终态冲突语义与生产仓储一致。 */
function createMemoryNodeAttemptRepo() {
  const attempts = new Map<string, OrchNodeAttempt>();
  let sequence = 0;

  const requireAttempt = (id: string): OrchNodeAttempt => {
    const attempt = attempts.get(String(id));
    if (!attempt) throw new Error(`节点 Attempt 不存在: ${id}`);
    return attempt;
  };
  const getLatestByNode = (instanceId: string, nodeId: string): OrchNodeAttempt | null => {
    return [...attempts.values()]
      .filter((attempt) => attempt.instanceId === instanceId && attempt.nodeId === nodeId)
      .sort((left, right) => right.attemptNo - left.attemptNo)[0] ?? null;
  };

  return {
    get(id: string) {
      return attempts.get(String(id)) ?? null;
    },
    getLatestByNode,
    listRecoverableByInstance(instanceId: string) {
      return [...attempts.values()].filter((attempt) =>
        attempt.instanceId === instanceId
        && (attempt.status === "result-submitted" || attempt.status === "finalizing"));
    },
    begin(input: {
      instanceId: string;
      nodeId: string;
      invalidationReason?: string | null;
      id?: string | null;
      attemptNo?: number | null;
    }) {
      const now = Date.now();
      for (const attempt of attempts.values()) {
        if (attempt.instanceId !== input.instanceId || attempt.nodeId !== input.nodeId) continue;
        if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
        attempt.status = "invalidated";
        attempt.lastError = input.invalidationReason ?? "同节点开始新 Attempt";
        attempt.invalidatedAt = now;
        attempt.version += 1;
        attempt.updatedAt = now;
      }
      const latest = getLatestByNode(input.instanceId, input.nodeId);
      const requestedAttemptNo = Number(input.attemptNo ?? 0);
      const attempt: OrchNodeAttempt = {
        id: String(input.id ?? "").trim() || `attempt_test_${++sequence}`,
        instanceId: input.instanceId as any,
        nodeId: input.nodeId,
        attemptNo: Math.max(
          (latest?.attemptNo ?? 0) + 1,
          Number.isFinite(requestedAttemptNo) ? Math.max(1, Math.floor(requestedAttemptNo)) : 1,
        ),
        status: "running",
        threadId: null,
        turnId: null,
        submission: null,
        submissionHash: null,
        responseText: null,
        artifactId: null,
        lastError: null,
        submittedAt: null,
        finalizedAt: null,
        invalidatedAt: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      attempts.set(attempt.id, attempt);
      return attempt;
    },
    bindExecution(id: string, threadId: string, turnId: string) {
      const attempt = requireAttempt(id);
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
        throw new Error(`节点 Attempt ${id} 当前状态 ${attempt.status} 不允许绑定执行上下文`);
      }
      attempt.threadId = String(threadId);
      attempt.turnId = String(turnId);
      attempt.version += 1;
      attempt.updatedAt = Date.now();
      return attempt;
    },
    submit(id: string, submission: NodeFinalAnswerPayload) {
      const attempt = requireAttempt(id);
      const submissionHash = JSON.stringify(submission);
      if (attempt.submissionHash) {
        if (attempt.submissionHash !== submissionHash) {
          throw new Error(`节点 Attempt ${id} 已提交不同结果，拒绝覆盖`);
        }
        if (attempt.status === "invalidated" || attempt.status === "cancelled" || attempt.status === "failed") {
          throw new Error(`节点 Attempt ${id} 已失效，拒绝迟到提交`);
        }
        return { attempt, idempotent: true };
      }
      if (attempt.status !== "running") {
        throw new Error(`节点 Attempt ${id} 当前状态 ${attempt.status} 不允许提交结果`);
      }
      attempt.status = "result-submitted";
      attempt.submission = submission;
      attempt.submissionHash = submissionHash;
      attempt.submittedAt = Date.now();
      attempt.version += 1;
      attempt.updatedAt = attempt.submittedAt;
      return { attempt, idempotent: false };
    },
    markFinalizing(id: string) {
      const attempt = requireAttempt(id);
      if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return { attempt, alreadyFinalized: true };
      if (attempt.status === "finalizing") return { attempt, alreadyFinalized: false };
      if (attempt.status !== "result-submitted" || !attempt.submission) {
        throw new Error(`节点 Attempt ${id} 尚无有效提交，不能进入收尾`);
      }
      attempt.status = "finalizing";
      attempt.version += 1;
      attempt.updatedAt = Date.now();
      return { attempt, alreadyFinalized: false };
    },
    saveResponseText(id: string, responseText: string) {
      const attempt = requireAttempt(id);
      if (attempt.status !== "invalidated" && attempt.status !== "cancelled") {
        attempt.responseText = String(responseText ?? "");
        attempt.version += 1;
        attempt.updatedAt = Date.now();
      }
      return attempt;
    },
    attachArtifact(id: string, artifactId: string) {
      const attempt = requireAttempt(id);
      if (attempt.artifactId && attempt.artifactId !== artifactId) {
        throw new Error(`节点 Attempt ${id} 已绑定其他 Artifact`);
      }
      attempt.artifactId = artifactId;
      attempt.version += 1;
      attempt.updatedAt = Date.now();
      return attempt;
    },
    markTerminal(id: string, status: OrchNodeAttemptStatus, error?: string | null) {
      const attempt = requireAttempt(id);
      if (attempt.status === status && attempt.finalizedAt) return attempt;
      if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status) || attempt.status === "invalidated") {
        throw new Error(`节点 Attempt ${id} 已收敛为 ${attempt.status}，不能改写为 ${status}`);
      }
      attempt.status = status;
      attempt.lastError = error ?? null;
      attempt.finalizedAt = Date.now();
      attempt.version += 1;
      attempt.updatedAt = attempt.finalizedAt;
      return attempt;
    },
    invalidateActiveByNode(instanceId: string, nodeId: string, reason: string) {
      let count = 0;
      for (const attempt of attempts.values()) {
        if (attempt.instanceId !== instanceId || attempt.nodeId !== nodeId) continue;
        if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
        attempt.status = "invalidated";
        attempt.lastError = reason;
        attempt.invalidatedAt = Date.now();
        attempt.version += 1;
        attempt.updatedAt = attempt.invalidatedAt;
        count += 1;
      }
      return count;
    },
    cancelActiveByInstance(instanceId: string, reason: string) {
      let count = 0;
      for (const attempt of attempts.values()) {
        if (attempt.instanceId !== instanceId || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
        attempt.status = "cancelled";
        attempt.lastError = reason;
        attempt.finalizedAt = Date.now();
        attempt.version += 1;
        attempt.updatedAt = attempt.finalizedAt;
        count += 1;
      }
      return count;
    },
    isCurrent(instanceId: string, nodeId: string, attemptId: string) {
      const latest = getLatestByNode(instanceId, nodeId);
      return Boolean(latest && latest.id === attemptId && ACTIVE_ATTEMPT_STATUSES.has(latest.status));
    },
  };
}

/** 补齐旧测试替身的基础事务与仓储契约，不在生产代码中引入缺失依赖降级。 */
function installEngineTestDbContracts(ctx: ConstructorParameters<typeof ProductionOrchestrationEngine>[0]): void {
  const db = ctx.db as any;
  db.db ??= {
    transaction<T extends (...args: any[]) => any>(operation: T): T {
      return operation;
    },
  };
  db.orchNodeAttempts ??= createMemoryNodeAttemptRepo();
  // 旧内存测试明确提供 writer，不给生产缺依赖设置降级。
  db.writeWorkspaceLog ??= () => {};
  // 旧内存替身显式提供合法缺 Profile 仓储，避免在派发前因缺方法误入失败策略。
  db.withWorkspaceExecutionProfiles ??= (_workspaceId: string, operation: (repo: { get(): null }) => unknown) => operation({ get() { return null; } });
  db.orchInstances ??= {};
  db.orchInstances.get ??= () => null;
  db.orchInstances.listByWorkspace ??= () => [];
  db.engineKeys ??= {};
  db.engineKeys.getActive ??= () => null;
  db.engineCustomModels ??= {};
  db.engineCustomModels.getByEngineModel ??= () => null;
  db.workspaces ??= {};
  db.workspaces.get ??= () => null;
  db.workspaces.list ??= () => [];
  db.orchArtifacts ??= {};
  // 摘要查询沿用测试产物集合，正文投影与真实仓储一致。
  db.orchArtifacts.listSummariesByInstance ??= function listSummariesByInstance(instanceId: string) {
    return this.listByInstance(instanceId).map((artifact: Artifact) => ({ ...artifact, contentJson: "" }));
  };
  db.orchArtifacts.getByNodeAttempt ??= function getByNodeAttempt(instanceId: string, attemptId: string) {
    const artifacts = typeof this.listByInstance === "function"
      ? this.listByInstance(instanceId)
      : [];
    return artifacts.find((artifact: Artifact) => artifact.metadata?.nodeAttemptId === attemptId) ?? null;
  };
  db.orchGateEvaluationRuns ??= {
    create(input: Record<string, unknown>) {
      return { ...input, status: "pending", statusVersion: 1, retryOrdinal: 0 };
    },
    get() { return null; },
    updateCas() { return true; },
    listRecoverable() { return []; },
  };
}

/** 让本文件所有旧构造场景自动使用完整的测试数据库契约。 */
class OrchestrationEngine extends ProductionOrchestrationEngine {
  constructor(ctx: ConstructorParameters<typeof ProductionOrchestrationEngine>[0]) {
    installEngineTestDbContracts(ctx);
    super(ctx);
  }
}

/** 为直接调用 finalizer 的测试准备已持久化提交，并同步节点 Attempt 投影。 */
function prepareSubmittedNodeAttempt(
  engine: OrchestrationEngine,
  instance: OrchestrationInstance,
  node: WorkflowNode,
  finalAnswer: NodeFinalAnswerPayload,
  responseText = "",
): string {
  const db = (engine as any).ctx.db;
  const previousGet = db.orchInstances.get.bind(db.orchInstances);
  db.orchInstances.get = (instanceId: string) => (
    instanceId === instance.id ? instance : previousGet(instanceId)
  );
  const attempt = db.orchNodeAttempts.begin({
    instanceId: instance.id,
    nodeId: node.id,
    invalidationReason: "测试准备新 Attempt",
  });
  const submitted = db.orchNodeAttempts.submit(attempt.id, finalAnswer).attempt;
  db.orchNodeAttempts.saveResponseText(attempt.id, responseText);
  const nodeState = instance.nodeStates[node.id];
  if (!nodeState) throw new Error(`测试节点状态不存在: ${node.id}`);
  nodeState.status = "result-submitted";
  nodeState.attemptId = submitted.id;
  nodeState.attemptNo = submitted.attemptNo;
  nodeState.submissionId = submitted.id;
  instance.nodeStates[node.id] = nodeState;
  db.orchInstances.updateNodeStates?.(instance.id, instance.nodeStates);
  return submitted.id;
}

function createExecutionConfig(input: {
  preferredEngine?: EngineType;
  claude?: TestExecutionProfileInput;
  codex?: TestExecutionProfileInput;
} = {}): RoleDefinition["executionConfig"] {
  const preferredEngine = input.preferredEngine ?? "claude";
  const config = createDefaultRoleExecutionConfig(preferredEngine);

  for (const engine of ["claude", "codex"] as const) {
    const profileInput = input[engine];
    if (!profileInput) continue;
    config.engineProfiles[engine].enabled = profileInput.enabled ?? config.engineProfiles[engine].enabled;
    const mode = profileInput.mode ?? (profileInput.customConfig ? "custom" : config.engineProfiles[engine].mode);
    config.engineProfiles[engine].mode = mode;
    config.engineProfiles[engine].customConfig = mode === "custom"
      ? {
          ...createDefaultRoleExecutionCustomConfig(engine),
          ...(profileInput.customConfig ?? {}),
        }
      : null;
  }

  return config;
}

function createRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    id: "role_impl" as any,
    workspaceId: "client-a:ws-demo" as any,
    name: "实现角色",
    description: "实现与落地",
    responsibility: "编写代码",
    systemPrompt: "您是实现角色",
    inputDefinition: {
      instructions: "任务={{requirement}}",
      requiredFields: [],
    },
    outputDefinition: {
      instructions: "",
      deliveryMode: "direct",
      format: "markdown",
      resultKey: "implementation-report",
      filePathRule: null,
      requiredFields: [],
    },
    gateCriteria: [],
    executionConfig: createExecutionConfig({
      preferredEngine: "claude",
      claude: {
        mode: "custom",
        customConfig: {
          model: "claude-sonnet-4-6",
          effort: "medium",
          accessMode: "current",
          maxRetries: 0,
        },
      },
    }),
    defaultKnowledgeBundleIds: [],
    toolRefs: [],
    kind: "custom",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createWorkflow(
  nodes: WorkflowNode[],
  edges?: WorkflowDefinition["edges"],
): WorkflowDefinition {
  return {
    id: "wf_demo" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "demo",
    description: "demo",
    workflowKnowledgeBundleIds: [],
    nodes,
    edges: edges ?? [
      {
        id: "edge-design-impl",
        sourceNodeId: "design",
        targetNodeId: "impl",
        conditionBranch: null,
        dataMappings: [],
      },
      {
        id: "edge-review-impl",
        sourceNodeId: "review",
        targetNodeId: "impl",
        conditionBranch: null,
        dataMappings: [],
      },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 构造测试实例使用的 legacy 完整运行图，运行定义不携带仓储展示时间。 */
function createAssetRuntimeSnapshot(
  workflow: WorkflowDefinition,
  options: {
    roles?: RoleDefinition[];
    toolsets?: ToolsetDefinition[];
    skills?: SkillDefinition[];
  } = {},
): OrchestrationAssetRuntimeSnapshot {
  const { createdAt: _workflowCreatedAt, updatedAt: _workflowUpdatedAt, ...workflowDefinition } = workflow;
  const toLegacySource = (definition: { createdAt: number; updatedAt: number }) => ({
    authorityMode: "legacy" as const,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  });
  const roles = Object.fromEntries((options.roles ?? []).map((role) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = role;
    return [String(role.id), {
      assetType: "role" as const,
      assetId: String(role.id),
      definition,
      source: toLegacySource(role),
    }];
  }));
  const toolsets = Object.fromEntries((options.toolsets ?? []).map((toolset) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = toolset;
    return [String(toolset.id), {
      assetType: "toolset" as const,
      assetId: String(toolset.id),
      definition,
      source: toLegacySource(toolset),
    }];
  }));
  const skills = Object.fromEntries((options.skills ?? []).map((skill) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = skill;
    return [String(skill.id), {
      assetType: "skill" as const,
      assetId: String(skill.id),
      definition: {
        ...definition,
        skillMd: skill.skillMd ?? `# ${skill.name}\n`,
        files: skill.files ?? [],
        packageHash: skill.packageHash ?? "0".repeat(64),
      },
      source: toLegacySource(skill),
    }];
  }));
  return {
    authorityMode: "legacy",
    workflow: {
      assetType: "workflow",
      assetId: String(workflow.id),
      definition: workflowDefinition,
      source: null,
    },
    roles,
    knowledgeBundles: {},
    toolsets,
    skills,
  };
}

function createNodeState(
  nodeId: string,
  status: NodeExecutionState["status"] = "pending",
  patch: Partial<NodeExecutionState> = {},
): NodeExecutionState {
  return {
    nodeId,
    status,
    retryCount: 0,
    inputArtifactIds: [],
    outputArtifactIds: [],
    activeFeedbackRecordIds: [],
    feedbackRecordIds: [],
    ...patch,
  };
}

function createPromptEnvelope(input: {
  workflow: WorkflowDefinition;
  nodeId: string;
  nodeLabel: string;
  userMessage: string;
  runtimePolicy: Record<string, unknown>;
  artifactInput?: { artifacts?: unknown[]; fieldBindings?: Record<string, string> };
  toolRegistry?: unknown;
}) {
  return {
    schemaVersion: "node-prompt-envelope/v1" as const,
    meta: {
      scene: "orchestration-node" as const,
      instanceId: "orch_demo" as any,
      workflowId: input.workflow.id,
      workflowName: input.workflow.name,
      nodeId: input.nodeId,
      nodeLabel: input.nodeLabel,
      intent: /人工反馈|重做|最新文件内容为准/.test(input.userMessage) ? "rework-current-node" as const : "execute" as const,
    },
    role: {
      roleId: "role_impl" as any,
      name: "测试角色",
      description: "测试用 prompt envelope",
      responsibility: "执行节点任务",
      systemPrompt: null,
      formalTemplateName: "测试模板",
      inputDefinition: {
        instructions: "",
        requiredFields: [],
      },
      outputDefinition: {
        instructions: "",
        deliveryMode: "direct" as const,
        format: "markdown" as const,
        resultKey: null,
        filePathRule: null,
        requiredFields: [],
      },
    },
    task: {
      title: "测试任务",
      titlePathSegment: "测试任务",
      goal: "测试任务",
      background: null,
      acceptanceCriteria: null,
      renderedTaskInput: "",
      fieldBindings: input.artifactInput?.fieldBindings ?? {},
    },
    artifacts: {
      upstreamArtifacts: (input.artifactInput?.artifacts ?? []) as any,
    },
    knowledge: {
      catalogs: [],
      warnings: [],
    },
    review: {
      feedbackPatch: null,
    },
    runtime: {
      runtimePolicy: input.runtimePolicy as any,
      toolRegistry: input.toolRegistry ?? null,
    },
  };
}

function createInstance(
  role: RoleDefinition,
  workflow: WorkflowDefinition,
  runtimeConfig: OrchestrationRuntimeConfig | null = null,
): OrchestrationInstance {
  return {
    id: "orch_demo" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_demo" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "实现一个新能力",
      goal: "实现一个新能力",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "pending",
    nodeStates: {
      design: createNodeState("design"),
      review: createNodeState("review"),
      impl: createNodeState("impl"),
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function createArtifact(input: Partial<Artifact> & Pick<Artifact, "id" | "instanceId" | "nodeId" | "kind">): Artifact {
  return {
    version: 1,
    title: input.kind,
    schemaRef: null,
    status: "draft",
    contentJson: JSON.stringify({ text: input.kind }),
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

function createHarness(options: {
  artifacts?: Artifact[];
  artifactFiles?: ArtifactFileEntry[];
  artifactFields?: NodeResultField[];
  liveRole?: RoleDefinition | null;
  skills?: SkillDefinition[];
  toolsets?: ToolsetDefinition[];
  emitOrchestration?: (workspaceId: string, event: {
    id: string;
    instanceId: string;
    nodeId?: string | null;
    type: string;
    payloadJson: string;
    createdAt: number;
  }) => void;
} = {}) {
  const artifacts = [...(options.artifacts ?? [])];
  const artifactFiles = [...(options.artifactFiles ?? [])];
  const artifactFields = [...(options.artifactFields ?? [])];
  const liveRole = options.liveRole ?? null;
  const skills = [...(options.skills ?? [])];
  const toolsets = [...(options.toolsets ?? [])];
  const feedbackRecords: Array<Record<string, any>> = [];
  const contextResolutions: Array<Record<string, any>> = [];
  const orchestrationEvents: Array<{
    id: string;
    instanceId: string;
    nodeId?: string | null;
    type: string;
    payloadJson: string;
    createdAt: number;
  }> = [];

  const engine = new OrchestrationEngine({
    db: {
      orchEvents: {
        append(input: {
          instanceId: string;
          nodeId?: string | null;
          type: string;
          payloadJson: string;
        }) {
          const event = {
            id: `event_${orchestrationEvents.length + 1}`,
            createdAt: 100 + orchestrationEvents.length,
            ...input,
          };
          orchestrationEvents.push(event);
          return event;
        },
      },
      orchArtifacts: {
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        create(input: Omit<Artifact, "createdAt" | "updatedAt" | "id">) {
          const created: Artifact = {
            ...input,
            id: `artifact_${artifacts.length + 1}` as any,
            createdAt: 10 + artifacts.length,
            updatedAt: 10 + artifacts.length,
          };
          artifacts.push(created);
          return created;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
        updateWorkspace(artifactId: string, patch: Partial<Artifact>) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) Object.assign(artifact, patch, { updatedAt: Date.now() });
        },
      },
      orchInstances: {
        updateArtifactIndex() {},
        updateStatus() {},
        updateNodeStates() {},
      },
      orchFeedback: {
        create(input: Record<string, any>) {
          const record = {
            id: `feedback_${feedbackRecords.length + 1}`,
            ...input,
          };
          feedbackRecords.push(record);
          return record;
        },
        get(recordId: string) {
          return feedbackRecords.find((item) => item.id === recordId) ?? null;
        },
      },
      orchArtifactFiles: {
        listByArtifact(artifactId: string) {
          return artifactFiles.filter((file) => file.artifactId === artifactId);
        },
      },
      orchArtifactFields: {
        listByArtifact(artifactId: string) {
          return artifactFields.filter((field) => field.artifactId === artifactId);
        },
      },
      orchNodeContextResolutions: {
        listByNode(instanceId: string, nodeId: string) {
          return contextResolutions.filter((item) => item.instanceId === instanceId && item.nodeId === nodeId);
        },
        create(input: Record<string, any>) {
          const record = { id: `context_${contextResolutions.length + 1}`, createdAt: Date.now(), ...input };
          contextResolutions.push(record);
          return record;
        },
      },
      orchRoles: {
        get() {
          return liveRole;
        },
      },
      orchSkills: {
        get(skillId: string) {
          return skills.find((skill) => String(skill.id) === String(skillId)) ?? null;
        },
      },
      orchToolsets: {
        get(toolsetId: string) {
          return toolsets.find((toolset) => String(toolset.id) === String(toolsetId)) ?? null;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
    emitOrchestration: options.emitOrchestration,
  });

  return { engine, artifacts, orchestrationEvents, contextResolutions };
}

/** 让单实例测试直接驱动引擎私有调度逻辑，同时保留实例对象可断言。 */
function bindSingleInstanceRepo(engine: OrchestrationEngine, instance: OrchestrationInstance): void {
  (engine as any).ctx.db.orchInstances = {
    get(id: string) {
      return id === instance.id ? instance : null;
    },
    updateStatus(id: string, status: OrchestrationInstance["status"]) {
      if (id === instance.id) instance.status = status;
    },
    updateNodeStates(id: string, nodeStates: Record<string, NodeExecutionState>) {
      if (id === instance.id) instance.nodeStates = nodeStates;
    },
    updateArtifactIndex() {},
  };
}

test("reevaluate_gates 复用原 Artifact，评估通过后完成节点", async () => {
  const role = createRole({ gateCriteria: [{ id: "ai-1", label: "质量", type: "ai", config: "必须完整", blocking: true }] });
  const node: WorkflowNode = { id: "delivery", type: "role", label: "交付", roleId: role.id, position: { x: 0, y: 0 } };
  const workflow = createWorkflow([node]);
  const artifact = createArtifact({ id: "artifact-original" as any, instanceId: "orch_demo" as any, nodeId: node.id, kind: "原始产物" });
  const { engine, artifacts } = createHarness({ artifacts: [artifact], liveRole: role });
  const instance = createInstance(role, workflow);
  instance.nodeStates = { delivery: createNodeState(node.id, "waiting-feedback", {
    humanActionSource: "gate", error: "旧错误", activeFeedbackRecordIds: ["feedback-old"], attemptId: "attempt-1", outputArtifactIds: [artifact.id], promptSnapshotIds: ["snapshot-1"],
    gateResults: [{ criterionId: "ai-1", passed: false, message: "未通过", evaluatorKind: "ai", outcome: "fail" }],
  }) };
  bindSingleInstanceRepo(engine, instance);
  const db = (engine as any).ctx.db;
  db.orchPromptSnapshots = { listByNode: () => [{ id: "snapshot-1", engine: "claude", model: null, effort: null, runtimePolicy: {}, promptEnvelope: {} }] };
  (engine as any).aiGateEvaluationService.evaluate = async () => ({ results: [{ criterionId: "ai-1", passed: true, message: "通过", evaluatorKind: "ai", outcome: "pass", evaluationCallId: "call-new" }] });
  (engine as any).scheduleActiveRunAfterFeedback = () => {};

  await engine.submitFeedback(instance.id, node.id, "reevaluate_gates");

  assert.equal(instance.nodeStates.delivery.status, "completed");
  assert.equal(instance.nodeStates.delivery.error, null);
  assert.equal(instance.nodeStates.delivery.activeFeedbackRecordIds, null);
  assert.equal(instance.nodeStates.delivery.gateResults?.[0]?.passed, true);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.id, "artifact-original");
  assert.equal(artifacts[0]?.status, "approved");
});

test("reevaluate_gates 评估失败时保留原 Artifact 并继续等待处理", async () => {
  const role = createRole({ gateCriteria: [{ id: "ai-1", label: "质量", type: "ai", config: "必须完整", blocking: true }] });
  const node: WorkflowNode = { id: "delivery", type: "role", label: "交付", roleId: role.id, position: { x: 0, y: 0 } };
  const workflow = createWorkflow([node]);
  const artifact = createArtifact({ id: "artifact-original" as any, instanceId: "orch_demo" as any, nodeId: node.id, kind: "原始产物" });
  const { engine, artifacts } = createHarness({ artifacts: [artifact], liveRole: role });
  const instance = createInstance(role, workflow);
  instance.nodeStates = { delivery: createNodeState(node.id, "waiting-feedback", {
    humanActionSource: "gate", attemptId: "attempt-1", outputArtifactIds: [artifact.id], promptSnapshotIds: ["snapshot-1"],
    gateResults: [{ criterionId: "ai-1", passed: false, message: "未通过", evaluatorKind: "ai", outcome: "fail" }],
  }) };
  bindSingleInstanceRepo(engine, instance);
  const db = (engine as any).ctx.db;
  db.orchPromptSnapshots = { listByNode: () => [{ id: "snapshot-1", engine: "claude", model: null, effort: null, runtimePolicy: {}, promptEnvelope: {} }] };
  (engine as any).aiGateEvaluationService.evaluate = async () => ({ results: [{ criterionId: "ai-1", passed: false, message: "仍不符合", evaluatorKind: "ai", outcome: "fail", evaluationCallId: "call-new" }] });
  (engine as any).scheduleActiveRunAfterFeedback = () => {};

  await engine.submitFeedback(instance.id, node.id, "reevaluate_gates");

  assert.equal(instance.nodeStates.delivery.status, "waiting-feedback");
  assert.equal(instance.nodeStates.delivery.humanActionSource, "gate");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.id, "artifact-original");
  assert.equal(artifacts[0]?.status, "draft");
});

/** 提供 executeSubThread 单测所需的最小 turn 查询能力，默认视为尚未写入终态。 */
function createActiveTurnProbeStub() {
  return {
    get() {
      return null;
    },
  };
}

test("emitOrchEvent also forwards orchestration event to realtime channel", () => {
  const role = createRole();
  const workflow = createWorkflow([]);
  const instance = createInstance(role, workflow);
  const pushed: Array<{ workspaceId: string; type: string; payloadJson: string }> = [];
  const { engine, orchestrationEvents } = createHarness({
    emitOrchestration(workspaceId, event) {
      pushed.push({ workspaceId, type: event.type, payloadJson: event.payloadJson });
    },
  });

  (engine as any).emitOrchEvent(instance, "orchestration.started", {
    instanceId: instance.id,
    workflowName: instance.workflowSnapshot.name,
  });

  assert.equal(orchestrationEvents.length, 1);
  assert.equal(orchestrationEvents[0]?.type, "orchestration.started");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]?.workspaceId, instance.workspaceId);
  assert.equal(pushed[0]?.type, "orchestration.started");
  assert.deepEqual(JSON.parse(pushed[0]?.payloadJson ?? "{}"), {
    instanceId: instance.id,
    requirementId: instance.intakeSnapshot.id,
    intakeId: instance.intakeSnapshot.id,
    workflowName: instance.workflowSnapshot.name,
  });
});

test("resolveExecutionPrefs keeps role engine when strategy follows role config", () => {
  const role = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "claude",
      claude: {
        mode: "custom",
        customConfig: {
          model: "claude-sonnet-4-6",
          effort: "high",
          accessMode: "current",
          contextWindow: 300_000,
          maxRetries: 2,
        },
      },
    }),
  });
  const workflow = createWorkflow([]);
  const instance = createInstance(role, workflow, { executionEngineStrategy: "follow-role" });
  const { engine } = createHarness();

  const executionPrefs = (engine as any).resolveExecutionPrefs(instance, role, []);

  assert.equal(executionPrefs.engine, "claude");
  assert.equal(executionPrefs.model, "claude-sonnet-4-6[1m]");
  assert.equal(executionPrefs.effort, "high");
  assert.equal(executionPrefs.accessMode, "current");
  assert.equal(executionPrefs.maxRetries, 2);
});

test("resolveExecutionPrefs supports instance-level engine override", () => {
  const claudeRole = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "claude",
      claude: {
        mode: "custom",
        customConfig: {
          model: "claude-sonnet-4-6",
          effort: "high",
          accessMode: "current",
          autoCompactPct: 72,
          contextWindow: 120_000,
          maxRetries: 3,
        },
      },
    }),
  });
  const codexRole = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "codex",
      codex: {
        mode: "custom",
        customConfig: {
          model: "gpt-5.4-mini",
          effort: "low",
          accessMode: "read-only",
          contextWindow: 64_000,
          maxRetries: 1,
        },
      },
    }),
  });
  const workflow = createWorkflow([]);
  const { engine } = createHarness();

  const forcedCodexPrefs = (engine as any).resolveExecutionPrefs(
    createInstance(claudeRole, workflow, { executionEngineStrategy: "force-codex" }),
    claudeRole,
    [],
  );
  assert.equal(forcedCodexPrefs.engine, "codex");
  assert.equal(forcedCodexPrefs.model, "gpt-5.6-sol");
  assert.equal(forcedCodexPrefs.sourceMode, "auto");
  assert.equal(forcedCodexPrefs.accessMode, "full-access");
  assert.equal(forcedCodexPrefs.effort, "xhigh");
  assert.equal(forcedCodexPrefs.maxRetries, 0);
  assert.equal(forcedCodexPrefs.autoCompactPct, 95);

  const forcedClaudePrefs = (engine as any).resolveExecutionPrefs(
    createInstance(codexRole, workflow, { executionEngineStrategy: "force-claude" }),
    codexRole,
    [],
  );
  assert.equal(forcedClaudePrefs.engine, "claude");
  assert.equal(forcedClaudePrefs.model, "claude-fable-5");
  assert.equal(forcedClaudePrefs.sourceMode, "auto");
  assert.equal(forcedClaudePrefs.accessMode, "full-access");
  assert.equal(forcedClaudePrefs.effort, "high");
  assert.equal(forcedClaudePrefs.maxRetries, 0);
});

test("resolveExecutionPrefs applies flow-level role model overrides without mutating access policy", () => {
  const role = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "codex",
      codex: {
        mode: "custom",
        customConfig: {
          model: "gpt-5.5",
          effort: "xhigh",
          accessMode: "current",
          autoCompactPct: 90,
          contextWindow: 272_000,
          maxRetries: 2,
        },
      },
      claude: {
        enabled: true,
        mode: "custom",
        customConfig: {
          model: "claude-sonnet-4-6",
          effort: "high",
          accessMode: "full-access",
          autoCompactPct: 81,
          contextWindow: 300_000,
          maxRetries: 4,
        },
      },
    }),
  });
  const workflow = createWorkflow([{ id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 0 } }]);
  const instance = createInstance(role, workflow, {
    executionEngineStrategy: "follow-role",
    roleExecutionOverrides: {
      [role.id]: {
        engine: "claude",
        model: "deepseek-v4-pro[1m]",
        effort: "max",
        contextWindow: 1_000_000,
        autoCompactPct: 88,
      },
    },
  });
  const { engine } = createHarness();

  const prefs = (engine as any).resolveExecutionPrefs(instance, role, []);

  assert.equal(prefs.engine, "claude");
  assert.equal(prefs.model, "deepseek-v4-pro[1m]");
  assert.equal(prefs.effort, "max");
  assert.equal(prefs.sourceMode, "custom");
  assert.equal(prefs.accessMode, "full-access");
  assert.equal(prefs.autoCompactPct, 88);
  assert.equal(prefs.contextWindow, 1_000_000);
  assert.equal(prefs.maxRetries, 4);
});

test("resolveExecutionPrefs keeps the latest explicit node model override when later active feedback has none", () => {
  const role = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "codex",
      codex: {
        mode: "custom",
        customConfig: {
          model: "gpt-5.6-sol",
          effort: "xhigh",
          accessMode: "full-access",
          autoCompactPct: 95,
          contextWindow: 258_400,
        },
      },
    }),
  });
  const workflow = createWorkflow([{ id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 0 } }]);
  const instance = createInstance(role, workflow, { executionEngineStrategy: "follow-role" });
  const { engine } = createHarness();
  const feedbackRecord = (engine as any).ctx.db.orchFeedback.create({
    instanceId: instance.id,
    nodeId: "impl",
    action: "resume_with_input",
    source: "execution",
    feedback: "继续",
    images: null,
    artifactIds: null,
    executionOverride: {
      model: "gpt-5.6-terra",
      effort: "high",
      autoCompactPct: 92,
      contextWindow: 372_000,
      serviceTier: "fast",
    },
    createdAt: Date.now(),
  });
  const laterSystemRecord = (engine as any).ctx.db.orchFeedback.create({
    instanceId: instance.id,
    nodeId: "impl",
    action: "system_rework",
    source: "system",
    feedback: "补充系统返工说明",
    images: null,
    artifactIds: null,
    executionOverride: null,
    createdAt: Date.now() + 1,
  });
  instance.nodeStates.impl.activeFeedbackRecordIds = [feedbackRecord.id, laterSystemRecord.id];

  const feedbackContext = (engine as any).collectFeedbackContext(instance, "impl");
  const prefs = (engine as any).resolveExecutionPrefs(instance, role, [], feedbackContext.executionOverride);

  assert.equal(prefs.engine, "codex");
  assert.equal(prefs.model, "gpt-5.6-terra");
  assert.equal(prefs.effort, "high");
  assert.equal(prefs.autoCompactPct, 92);
  assert.equal(prefs.contextWindow, 372_000);
  assert.equal(prefs.serviceTier, "fast");
  assert.equal(prefs.accessMode, "full-access");
  assert.equal(role.executionConfig.engineProfiles.codex.customConfig?.model, "gpt-5.6-sol");
  assert.equal(instance.runtimeConfig?.roleExecutionOverrides, undefined);

  instance.nodeStates.impl.activeFeedbackRecordIds = null;
  const clearedFeedbackContext = (engine as any).collectFeedbackContext(instance, "impl");
  const nextPrefs = (engine as any).resolveExecutionPrefs(instance, role, [], clearedFeedbackContext.executionOverride);
  assert.equal(nextPrefs.model, "gpt-5.6-sol");
  assert.equal(nextPrefs.contextWindow, 258_400);
});

test("resolveExecutionPrefs preserves explicit empty role effort override", () => {
  const role = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "codex",
      codex: {
        mode: "custom",
        customConfig: {
          model: "gpt-5.5",
          effort: "xhigh",
          accessMode: "current",
        },
      },
    }),
  });
  const workflow = createWorkflow([{ id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 0 } }]);
  const instance = createInstance(role, workflow, {
    executionEngineStrategy: "follow-role",
    roleExecutionOverrides: {
      [role.id]: {
        effort: null,
      },
    },
  });
  const { engine } = createHarness();

  const prefs = (engine as any).resolveExecutionPrefs(instance, role, []);

  assert.equal(prefs.engine, "codex");
  assert.equal(prefs.model, "gpt-5.5");
  assert.equal(prefs.effort, null);
  assert.equal(prefs.sourceMode, "custom");
  assert.equal(prefs.accessMode, "current");
});

test("resolveExecutionPrefs uses the explicit DeepSeek Flash 1M variant", () => {
  const role = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "claude",
      claude: {
        mode: "custom",
        customConfig: {
          model: "deepseek-v4-flash[1m]",
          effort: "high",
          accessMode: "full-access",
          contextWindow: 1_000_000,
        },
      },
    }),
  });
  const workflow = createWorkflow([]);
  const { engine } = createHarness();

  const prefs = (engine as any).resolveExecutionPrefs(createInstance(role, workflow), role, []);

  assert.equal(prefs.model, "deepseek-v4-flash[1m]");
  assert.equal(prefs.contextWindow, 1_000_000);
});

test("resolveExecutionPrefs treats smart-planning as follow-role until planner lands", () => {
  const role = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "codex",
      codex: {
        mode: "custom",
        customConfig: {
          model: "gpt-5.5",
          effort: "medium",
          accessMode: "full-access",
          maxRetries: 2,
        },
      },
    }),
  });
  const workflow = createWorkflow([]);
  const instance = createInstance(role, workflow, { executionEngineStrategy: "smart-planning" });
  const { engine } = createHarness();

  const executionPrefs = (engine as any).resolveExecutionPrefs(instance, role, []);

  assert.equal(executionPrefs.engine, "codex");
  assert.equal(executionPrefs.model, "gpt-5.5");
  assert.equal(executionPrefs.accessMode, "full-access");
  assert.equal(executionPrefs.maxRetries, 2);
});

function createFinalAnswer(
  answer: NodeExecutionEnvelope,
  overrides: {
    control?: Partial<NodeFinalAnswerPayload["control"]>;
    review?: Partial<NodeFinalAnswerPayload["review"]>;
    acceptanceChecks?: NodeFinalAnswerPayload["acceptanceChecks"];
    humanInput?: NodeFinalAnswerPayload["humanInput"];
    rework?: NodeFinalAnswerPayload["rework"];
  } = {},
): NodeFinalAnswerPayload {
  return {
    answer,
    control: {
      nextAction: "continue",
      reason: "当前节点交付已完成，可以继续。",
      ...overrides.control,
    },
    review: {
      verdict: "pass",
      summary: "当前节点交付满足要求。",
      blockingIssues: [],
      ...overrides.review,
    },
    acceptanceChecks: overrides.acceptanceChecks ?? null,
    humanInput: overrides.humanInput ?? null,
    rework: overrides.rework ?? null,
  };
}

function createTextFinalAnswer(
  text: string,
  overrides: Parameters<typeof createFinalAnswer>[1] = {},
): NodeFinalAnswerPayload {
  return createFinalAnswer({
    mode: "text",
    text,
  }, overrides);
}

test("resolveExecutionPrefs uses role-owned runtime settings and upgrades Claude model for extended context", () => {
  const engine = new OrchestrationEngine({
    db: {} as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  const role = createRole({
    executionConfig: createExecutionConfig({
      preferredEngine: "claude",
      claude: {
        mode: "custom",
        customConfig: {
          model: "claude-sonnet-4-6",
          effort: "high",
          accessMode: "full-access",
          autoCompactPct: 81,
          contextWindow: 300000,
          maxRetries: 2,
        },
      },
    }),
  });
  const workflow = createWorkflow([]);
  const instance = createInstance(role, workflow);

  const prefs = (engine as any).resolveExecutionPrefs(instance, role, []);

  assert.deepEqual(prefs, {
    engine: "claude",
    model: "claude-sonnet-4-6[1m]",
    effort: "high",
    sourceMode: "custom",
    accessMode: "full-access",
    autoCompactPct: 81,
    contextWindow: 300000,
    serviceTier: null,
    maxRetries: 2,
  });
});

test("resolveNodeInputArtifacts uses explicit node bindings and reports missing required bindings", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    { id: "review", type: "role", roleId: role.id, label: "评审", position: { x: 0, y: 120 } },
    {
      id: "impl",
      type: "role",
      roleId: role.id,
      label: "实现",
      position: { x: 0, y: 240 },
      inputBindings: [
        { sourceNodeId: "design", sourceArtifactKind: "design/doc", required: true },
        { sourceNodeId: "review", sourceArtifactKind: "review/checklist", required: true },
      ],
    },
  ]);
  const instance = createInstance(role, workflow);
  const implNode = workflow.nodes[2];
  const designArtifact = createArtifact({
    id: "artifact_design" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "design/doc",
  });
  const unrelatedArtifact = createArtifact({
    id: "artifact_other" as any,
    instanceId: instance.id,
    nodeId: "review",
    kind: "review/notes",
  });

  const { engine } = createHarness({ artifacts: [designArtifact, unrelatedArtifact] });
  const result = (engine as any).resolveNodeInputArtifacts(instance, implNode, role);

  assert.deepEqual(result.ids, ["artifact_design"]);
  assert.deepEqual(result.missingRequired, ["sourceNode=review kind=review/checklist"]);
});

test("resolveNodeInputArtifacts exposes binding target fields for template rendering", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    { id: "review", type: "role", roleId: role.id, label: "评审", position: { x: 0, y: 120 } },
    {
      id: "impl",
      type: "role",
      roleId: role.id,
      label: "实现",
      position: { x: 0, y: 240 },
      inputBindings: [{ sourceNodeId: "design", sourceArtifactKind: "design/doc", targetField: "specDoc", required: true }],
    },
  ]);
  const instance = createInstance(role, workflow);
  const implNode = workflow.nodes[2];
  const designArtifact = createArtifact({
    id: "artifact_design" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "design/doc",
    contentJson: JSON.stringify({ text: "设计说明内容" }),
  });

  const { engine } = createHarness({ artifacts: [designArtifact] });
  const result = (engine as any).resolveNodeInputArtifacts(instance, implNode, role);

  assert.deepEqual(result.fieldValues, {
    specDoc: "设计说明内容",
  });
});

test("inputReferences resolves an exact field and freezes attempt-scoped prompt evidence", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    {
      id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 120 },
      inputReferences: [{
        id: "input-spec", targetKey: "specTitle", sourceNodeId: "design", sourceResultName: "design/doc",
        sourceSelector: { type: "field", fieldKey: "title" }, expectedValueType: "text",
        required: true, promptMode: "inline-value",
      }],
    },
  ]);
  const instance = createInstance(role, workflow);
  const artifact = createArtifact({
    id: "artifact_design" as any, instanceId: instance.id, nodeId: "design", kind: "design/doc",
  });
  const field: NodeResultField = {
    id: "field-title", artifactId: artifact.id, instanceId: instance.id, nodeId: "design",
    resultName: "design/doc", fieldKey: "title", label: "标题", valueType: "text",
    valueJson: JSON.stringify("真实标题"), valuePreview: "真实标题", required: true,
    source: "model", validationStatus: "valid", createdAt: 1, updatedAt: 1,
  };
  const { engine, contextResolutions } = createHarness({ artifacts: [artifact], artifactFields: [field] });
  const node = workflow.nodes[1]!;
  const resolution = (engine as any).resolveNodeInputArtifacts(instance, node, role);
  const context = (engine as any).persistNodeInputResolution(instance, node, {
    id: "attempt-1", attemptNo: 1,
  }, resolution);
  const snapshot = (engine as any).buildArtifactInputSnapshot(instance, resolution.ids, resolution.fieldValues, context);

  assert.equal(resolution.resolutionStatus, "resolved");
  assert.deepEqual(resolution.fieldValues, { specTitle: "真实标题" });
  assert.equal(contextResolutions.length, 1);
  assert.equal(snapshot.inputContextId, context.contextId);
  assert.deepEqual(snapshot.inputReferences, [{
    inputId: "input-spec", targetKey: "specTitle", required: true, selectorType: "field",
    promptMode: "inline-value", status: "resolved", errorCode: null,
    sourceArtifactId: "artifact_design", sourceFieldKey: "title",
  }]);
});

test("inputReferences treats missing or mismatched file formats as invalid contracts", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    {
      id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 120 },
      inputReferences: [{
        id: "input-file", targetKey: "specFile", sourceNodeId: "design", sourceResultName: "design/doc",
        sourceSelector: { type: "file", fileKey: "main" }, expectedFormat: "markdown",
        required: true, promptMode: "reference-only",
      }, {
        id: "input-files", targetKey: "specFiles", sourceNodeId: "design", sourceResultName: "design/doc",
        sourceSelector: { type: "file-set", baseDir: "docs" }, expectedFormat: "markdown",
        required: true, promptMode: "reference-only",
      }, {
        id: "input-invalid", targetKey: "invalidFile", sourceNodeId: "design", sourceResultName: "design/doc",
        sourceSelector: { type: "file", fileKey: "broken" },
        required: true, promptMode: "reference-only",
      }],
    },
  ]);
  const instance = createInstance(role, workflow);
  const artifact = createArtifact({
    id: "artifact_design" as any, instanceId: instance.id, nodeId: "design", kind: "design/doc",
  });
  const baseFile = {
    artifactId: artifact.id,
    fileRole: "contract" as const,
    contractKey: "main",
    validationStatus: "valid" as const,
    publishedPath: null,
    stagingPath: null,
    status: "staging" as const,
    sizeBytes: 12,
    createdAt: 1,
    updatedAt: 1,
  };
  const { engine } = createHarness({
    artifacts: [artifact],
    artifactFiles: [{
      ...baseFile,
      id: "file-main",
      fileKey: "main",
      format: null,
      relPath: "docs/main.md",
      contentHash: "hash-main",
    }, {
      ...baseFile,
      id: "file-extra",
      fileKey: "extra",
      format: "sql",
      relPath: "docs/schema.sql",
      contentHash: "hash-extra",
    }, {
      ...baseFile,
      id: "file-broken",
      fileKey: "broken",
      format: "markdown",
      validationStatus: "invalid",
      relPath: "invalid/broken.md",
      contentHash: "hash-broken",
    }],
  });

  const resolution = (engine as any).resolveNodeInputArtifacts(instance, workflow.nodes[1], role);

  assert.equal(resolution.resolutionStatus, "invalid");
  assert.deepEqual(resolution.resolvedInputs.map((item: any) => [item.inputId, item.errorCode]), [
    ["input-file", "format_mismatch"],
    ["input-files", "format_mismatch"],
    ["input-invalid", "file_invalid"],
  ]);
});

test("inputReferences persists missing required input before prompt creation", () => {
  const role = createRole();
  const workflow = createWorkflow([{
    id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 0 },
    inputReferences: [{
      id: "input-missing", targetKey: "spec", sourceNodeId: "design", sourceResultName: "design/doc",
      sourceSelector: { type: "result-record" }, required: true, promptMode: "inline-value",
    }],
  }]);
  const instance = createInstance(role, workflow);
  const { engine, contextResolutions } = createHarness();
  const resolution = (engine as any).resolveNodeInputArtifacts(instance, workflow.nodes[0], role);
  const context = (engine as any).persistNodeInputResolution(instance, workflow.nodes[0], {
    id: "attempt-1", attemptNo: 1,
  }, resolution);

  assert.equal(resolution.resolutionStatus, "missing_required");
  assert.deepEqual(resolution.missingRequired, ["input-missing:artifact_not_found"]);
  assert.equal(context.status, "missing_required");
  assert.equal(contextResolutions.length, 1);
});

test("inputReferences persists duplicate contract ids with unique invalid evidence identities", () => {
  const role = createRole();
  const reference = {
    targetKey: "spec",
    sourceNodeId: "design",
    sourceResultName: "design/doc",
    sourceSelector: { type: "result-record" as const },
    required: true,
    promptMode: "inline-value" as const,
  };
  const workflow = createWorkflow([{
    id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 0 },
    inputReferences: [
      { ...reference, id: "input-shared" },
      { ...reference, id: "input-shared" },
      { ...reference, id: "invalid-contract-2" },
    ],
  }]);
  const instance = createInstance(role, workflow);
  const { engine, contextResolutions } = createHarness();

  const resolution = (engine as any).resolveNodeInputArtifacts(instance, workflow.nodes[0], role);
  const context = (engine as any).persistNodeInputResolution(instance, workflow.nodes[0], {
    id: "attempt-1", attemptNo: 1,
  }, resolution);

  assert.equal(resolution.resolutionStatus, "invalid");
  assert.deepEqual(context.inputs.map((item: any) => item.inputId), [
    "input-shared",
    "invalid-contract-2-duplicate",
    "invalid-contract-2",
  ]);
  assert.equal(new Set(context.inputs.map((item: any) => item.inputId)).size, 3);
  assert.equal(context.error?.code, "INVALID_INPUT_CONTRACT");
  assert.equal(contextResolutions.length, 1);
});

test("inputReferences persists malformed selectors before blocking the attempt", () => {
  const role = createRole();
  const workflow = createWorkflow([{
    id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 0 },
    inputReferences: [{
      id: "input-broken", targetKey: "spec", sourceNodeId: "design", sourceResultName: "design/doc",
      sourceSelector: null, required: true, promptMode: "inline-value",
    } as any],
  }]);
  const instance = createInstance(role, workflow);
  const { engine, contextResolutions } = createHarness();

  const resolution = (engine as any).resolveNodeInputArtifacts(instance, workflow.nodes[0], role);
  const context = (engine as any).persistNodeInputResolution(instance, workflow.nodes[0], {
    id: "attempt-1", attemptNo: 1,
  }, resolution);

  assert.equal(resolution.resolutionStatus, "invalid");
  assert.equal(context.inputs[0]?.errorCode, "invalid_contract");
  assert.deepEqual(context.inputs[0]?.config.sourceSelector, { type: "result-record" });
  assert.equal(context.error?.code, "INVALID_INPUT_CONTRACT");
  assert.equal(contextResolutions.length, 1);
});

test("resolveNodeInputArtifacts falls back to upstream role artifacts when node bindings are absent", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    { id: "review", type: "role", roleId: role.id, label: "评审", position: { x: 0, y: 120 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 240 }, inputBindings: [] },
  ]);
  const instance = createInstance(role, workflow);
  const implNode = workflow.nodes[2];
  const designArtifact = createArtifact({
    id: "artifact_design" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "design/doc",
  });
  const reviewArtifact = createArtifact({
    id: "artifact_review" as any,
    instanceId: instance.id,
    nodeId: "review",
    kind: "review/notes",
  });

  const { engine } = createHarness({ artifacts: [designArtifact, reviewArtifact] });
  const result = (engine as any).resolveNodeInputArtifacts(instance, implNode, role);

  assert.deepEqual(result.ids, ["artifact_design", "artifact_review"]);
  assert.deepEqual(result.missingRequired, []);
});

test("buildArtifactInputSnapshot includes output fields and keyed file references for downstream prompts", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 120 }, inputBindings: [] },
  ]);
  const instance = createInstance(role, workflow);
  const designArtifact = createArtifact({
    id: "artifact_design" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "design-doc",
    manifest: {
      summary: "设计交付",
      files: [
        {
          fileKey: "main",
          fileRole: "contract",
          contractKey: "main",
          relPath: "docs/design.md",
          summary: "设计文档",
          format: "markdown",
        },
        {
          fileKey: "ddl",
          fileRole: "attachment",
          contractKey: null,
          relPath: "docs/schema.sql",
          summary: "补充 DDL",
          format: "sql",
        },
      ],
    },
  });
  const { engine } = createHarness({
    artifacts: [designArtifact],
    artifactFiles: [
      {
        id: "file_design",
        artifactId: designArtifact.id,
        fileKey: "main",
        fileRole: "contract",
        format: "markdown",
        contractKey: "main",
        validationStatus: "valid",
        relPath: "docs/design.md",
        publishedPath: "docs/design.md",
        stagingPath: null,
        status: "staging",
        contentHash: "hash-design",
        sizeBytes: 12,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "file_design_attachment",
        artifactId: designArtifact.id,
        fileKey: "ddl",
        fileRole: "attachment",
        format: "sql",
        contractKey: null,
        summary: "补充 DDL",
        validationStatus: "valid",
        relPath: "docs/schema.sql",
        publishedPath: "docs/schema.sql",
        stagingPath: null,
        status: "staging",
        contentHash: "hash-ddl",
        sizeBytes: 24,
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    artifactFields: [
      {
        id: "field_summary",
        artifactId: designArtifact.id,
        instanceId: instance.id,
        nodeId: "design",
        resultName: "design-doc",
        fieldKey: "verificationSummary",
        label: "验证摘要",
        valueType: "markdown",
        valueJson: JSON.stringify("已完成设计自检。"),
        valuePreview: "已完成设计自检。",
        required: true,
        source: "model",
        validationStatus: "valid",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "field_large_inventory",
        artifactId: designArtifact.id,
        instanceId: instance.id,
        nodeId: "design",
        resultName: "design-doc",
        fieldKey: "largeInventory",
        label: "大型清单",
        valueType: "json",
        valueJson: JSON.stringify(Array.from({ length: 600 }, (_, index) => `asset-${index}`)),
        valuePreview: `600 项资产清单${"x".repeat(500)}`,
        required: true,
        source: "model",
        validationStatus: "valid",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  const snapshot = (engine as any).buildArtifactInputSnapshot(instance, [designArtifact.id], {});

  assert.equal(snapshot.artifacts[0]?.fields?.[0]?.key, "verificationSummary");
  assert.equal(snapshot.artifacts[0]?.fields?.[0]?.valueText, "已完成设计自检。");
  assert.equal(snapshot.artifacts[0]?.fields?.[1]?.key, "largeInventory");
  assert.match(snapshot.artifacts[0]?.fields?.[1]?.valueText ?? "", /^600 项资产清单x+/);
  assert.match(snapshot.artifacts[0]?.fields?.[1]?.valueText ?? "", /\n\[字段值已压缩/);
  assert.equal(snapshot.artifacts[0]?.fields?.[1]?.valueText.split("\n")[0]?.length, 240);
  assert.equal(snapshot.artifacts[0]?.fields?.[1]?.truncated, true);
  assert.equal(snapshot.artifacts[0]?.workspaceFileRefs?.[0]?.fileKey, "main");
  assert.equal(snapshot.artifacts[0]?.workspaceFileRefs?.[0]?.format, "markdown");
  assert.equal(snapshot.artifacts[0]?.workspaceFileRefs?.[0]?.path, "docs/design.md");
  assert.equal(snapshot.artifacts[0]?.workspaceAttachmentRefs?.[0]?.key, "ddl");
  assert.equal(snapshot.artifacts[0]?.workspaceAttachmentRefs?.[0]?.format, "sql");
  assert.equal(snapshot.artifacts[0]?.workspaceAttachmentRefs?.[0]?.summary, "补充 DDL");
  assert.equal(snapshot.artifacts[0]?.workspaceAttachmentRefs?.[0]?.path, "docs/schema.sql");
  assert.equal(snapshot.artifacts[0]?.textContent, "");
});

test("resolveNodeInputArtifacts accumulates latest ancestor role artifacts beyond direct predecessors", () => {
  const role = createRole();
  const workflow = createWorkflow(
    [
      { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
      { id: "review", type: "role", roleId: role.id, label: "评审", position: { x: 0, y: 120 } },
      { id: "other", type: "role", roleId: role.id, label: "无关节点", position: { x: 240, y: 0 } },
      { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 240 }, inputBindings: [] },
    ],
    [
      {
        id: "edge-design-review",
        sourceNodeId: "design",
        targetNodeId: "review",
        conditionBranch: null,
        dataMappings: [],
      },
      {
        id: "edge-review-impl",
        sourceNodeId: "review",
        targetNodeId: "impl",
        conditionBranch: null,
        dataMappings: [],
      },
    ],
  );
  const instance = createInstance(role, workflow);
  const implNode = workflow.nodes[3];
  const designArtifact = createArtifact({
    id: "artifact_design" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "design/doc",
  });
  const reviewArtifact = createArtifact({
    id: "artifact_review" as any,
    instanceId: instance.id,
    nodeId: "review",
    kind: "review/notes",
  });
  const unrelatedArtifact = createArtifact({
    id: "artifact_other" as any,
    instanceId: instance.id,
    nodeId: "other",
    kind: "other/doc",
  });

  const { engine } = createHarness({ artifacts: [designArtifact, reviewArtifact, unrelatedArtifact] });
  const result = (engine as any).resolveNodeInputArtifacts(instance, implNode, role);

  assert.deepEqual(result.ids, ["artifact_design", "artifact_review"]);
  assert.deepEqual(result.missingRequired, []);
});

test("resolveNodeInputArtifacts ignores rejected artifact versions and keeps the latest usable upstream result", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    { id: "review", type: "role", roleId: role.id, label: "评审", position: { x: 0, y: 120 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 240 }, inputBindings: [] },
  ]);
  const instance = createInstance(role, workflow);
  const implNode = workflow.nodes[2];
  const rejectedDesignV1 = createArtifact({
    id: "artifact_design_v1" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "solution-plan",
    version: 1,
    status: "rejected",
    contentJson: JSON.stringify({ text: "旧方案 v1" }),
    updatedAt: 11,
  });
  const approvedDesignV2 = createArtifact({
    id: "artifact_design_v2" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "solution-plan",
    version: 2,
    status: "approved",
    contentJson: JSON.stringify({ text: "当前方案 v2" }),
    updatedAt: 12,
  });
  const reviewArtifact = createArtifact({
    id: "artifact_review" as any,
    instanceId: instance.id,
    nodeId: "review",
    kind: "review/notes",
    status: "approved",
    contentJson: JSON.stringify({ text: "评审意见" }),
    updatedAt: 13,
  });

  const { engine } = createHarness({ artifacts: [rejectedDesignV1, approvedDesignV2, reviewArtifact] });
  const result = (engine as any).resolveNodeInputArtifacts(instance, implNode, role);

  assert.deepEqual(result.ids, ["artifact_design_v2", "artifact_review"]);
  assert.deepEqual(result.missingRequired, []);
});

test("buildRenderContext ignores rejected history and uses the latest bindable artifact per node", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    { id: "review", type: "role", roleId: role.id, label: "评审", position: { x: 0, y: 120 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 240 } },
  ]);
  const instance = createInstance(role, workflow);
  const rejectedDesignV1 = createArtifact({
    id: "artifact_design_old" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "solution-plan",
    version: 1,
    status: "rejected",
    contentJson: JSON.stringify({ text: "旧方案" }),
    updatedAt: 11,
  });
  const approvedDesignV2 = createArtifact({
    id: "artifact_design_new" as any,
    instanceId: instance.id,
    nodeId: "design",
    kind: "solution-plan",
    version: 2,
    status: "approved",
    contentJson: JSON.stringify({ text: "新方案" }),
    updatedAt: 12,
  });

  const { engine } = createHarness({ artifacts: [rejectedDesignV1, approvedDesignV2] });
  const context = (engine as any).buildRenderContext(instance);

  assert.equal(context.design, "新方案");
});

test("resolveOutputArtifactSpec prefers workflow output result key", () => {
  const role = createRole();
  const { engine } = createHarness();
  const node: WorkflowNode = {
    id: "impl",
    type: "role",
    roleId: role.id,
    label: "实现",
    position: { x: 0, y: 0 },
    outputResultKey: "code/patch",
  };

  const spec = (engine as any).resolveOutputArtifactSpec(node, role);

  assert.deepEqual(spec, {
    kind: "code/patch",
  });
});

test("resolveOutputArtifactSpec falls back to file output kind when workflow node declares file output", () => {
  const role = createRole({
    outputDefinition: {
      instructions: "输出单文件结果",
      deliveryMode: "file",
      format: "markdown",
      resultKey: null,
      filePathRule: "codeflowai/artifacts/{{instanceId}}/{{nodeId}}/result.md",
      requiredFields: [{ key: "filePath", label: "文件路径", valueType: "file-path", required: true }],
    },
  });
  const { engine } = createHarness();
  const node: WorkflowNode = {
    id: "impl",
    type: "role",
    roleId: role.id,
    label: "实现",
    position: { x: 0, y: 0 },
    outputArtifactMode: "file",
  };

  const spec = (engine as any).resolveOutputArtifactSpec(node, role);

  assert.deepEqual(spec, {
    kind: "file-output/impl",
  });
});

test("resolveNodeApprovalMode prefers workflow override, then intake default, then runtime fallback", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 }, approvalMode: "manual" },
    { id: "review", type: "role", roleId: role.id, label: "评审", position: { x: 0, y: 120 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 240 } },
  ]);
  const instance = createInstance(role, workflow, { defaultNodeApprovalMode: "manual" });
  instance.intakeSnapshot.constraints = { requireUserConfirmation: true, nodeApprovalMode: "auto" };
  const { engine } = createHarness();

  assert.equal((engine as any).resolveNodeApprovalMode(instance, workflow.nodes[0]), "manual");
  assert.equal((engine as any).resolveNodeApprovalMode(instance, workflow.nodes[1]), "auto");
  instance.intakeSnapshot.constraints = null;
  assert.equal((engine as any).resolveNodeApprovalMode(instance, workflow.nodes[2]), "manual");
});

test("unattended interaction mode overrides manual start and approval gates", () => {
  const role = createRole();
  const workflow = createWorkflow([
    {
      id: "knowledge",
      type: "role",
      roleId: role.id,
      label: "知识构建",
      position: { x: 0, y: 0 },
      startMode: "manual",
      approvalMode: "manual",
    },
  ]);
  const instance = createInstance(role, workflow, {
    defaultNodeApprovalMode: "manual",
    interactionMode: "unattended",
  });
  instance.nodeStates.knowledge = createNodeState("knowledge", "pending");
  const { engine } = createHarness();

  assert.equal((engine as any).resolveNodeApprovalMode(instance, workflow.nodes[0]), "auto");
  assert.equal((engine as any).shouldWaitForManualStart(instance, workflow.nodes[0], instance.nodeStates.knowledge), false);

  instance.runtimeConfig = { ...instance.runtimeConfig, interactionMode: "guided" };
  assert.equal((engine as any).resolveNodeApprovalMode(instance, workflow.nodes[0]), "manual");
  assert.equal((engine as any).shouldWaitForManualStart(instance, workflow.nodes[0], instance.nodeStates.knowledge), true);
});

test("resolveDagIdleOutcome keeps instance active while waiting for manual approval", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
    { id: "review", type: "role", roleId: role.id, label: "评审", position: { x: 0, y: 120 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 240 } },
  ]);
  const instance = createInstance(role, workflow);
  instance.nodeStates.design.status = "completed";
  instance.nodeStates.review.status = "completed";
  instance.nodeStates.impl.status = "waiting-approval";
  const { engine } = createHarness();

  assert.equal((engine as any).resolveDagIdleOutcome(instance), null);
});

test("manual start node waits before execution and does not create a node turn", async () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 120 }, startMode: "manual" },
  ], [
    { id: "start-impl", sourceNodeId: "start", targetNodeId: "impl", conditionBranch: null, dataMappings: [] },
  ]);
  const instance = createInstance(role, workflow);
  instance.status = "running";
  instance.nodeStates = {
    start: createNodeState("start", "completed"),
    impl: createNodeState("impl", "pending"),
  };
  const { engine } = createHarness();
  bindSingleInstanceRepo(engine, instance);
  let executedNodeId: string | null = null;
  (engine as any).executeNode = async (_instanceId: string, node: WorkflowNode) => {
    executedNodeId = node.id;
  };
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run-manual-start",
    drivePromise: null,
  });

  await (engine as any).executeReadyNodeBatches(instance.id, "run-manual-start", { resolveIdleOutcome: true });

  assert.equal(executedNodeId, null);
  assert.equal(instance.nodeStates.impl.status, "waiting-start");
  assert.equal(instance.nodeStates.impl.threadId ?? null, null);
  assert.equal(instance.status, "waiting-start");
});

test("startWaitingNode releases waiting-start node and schedules continuation", async () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 120 }, startMode: "manual" },
  ], [
    { id: "start-impl", sourceNodeId: "start", targetNodeId: "impl", conditionBranch: null, dataMappings: [] },
  ]);
  const instance = createInstance(role, workflow);
  instance.status = "waiting-start";
  instance.nodeStates = {
    start: createNodeState("start", "completed"),
    impl: createNodeState("impl", "waiting-start", { error: "等待人工启动节点" }),
  };
  const { engine } = createHarness();
  bindSingleInstanceRepo(engine, instance);
  let scheduled = false;
  (engine as any).scheduleActiveRunAfterManualStart = () => { scheduled = true; };

  await engine.startWaitingNode(instance.id, "impl", "user-start", "子系统：订单中心\n模块：分支创建");

  assert.equal(instance.nodeStates.impl.status, "ready");
  assert.equal(typeof instance.nodeStates.impl.manualStartApprovedAt, "number");
  assert.equal(instance.nodeStates.impl.manualStartApprovedBy, "user-start");
  assert.equal(instance.nodeStates.impl.feedbackRecordIds?.length, 1);
  assert.equal(instance.nodeStates.impl.activeFeedbackRecordIds?.length, 1);
  const feedbackRecordId = instance.nodeStates.impl.activeFeedbackRecordIds?.[0] ?? "";
  const feedbackRecord = (engine as any).ctx.db.orchFeedback.get(feedbackRecordId);
  assert.equal(feedbackRecord?.action, "manual_start_context");
  const feedbackContext = (engine as any).collectFeedbackContext(instance, "impl");
  assert.match(String(feedbackContext.feedbackPatch ?? ""), /人工启动补充说明/);
  assert.match(String(feedbackContext.feedbackPatch ?? ""), /订单中心/);
  assert.equal(instance.nodeStates.impl.error, null);
  assert.equal(instance.status, "running");
  assert.equal(scheduled, true);
});

test("appendPendingNodeInput preserves node state and exposes input to the first prompt", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 0 } },
  ], []);
  const instance = createInstance(role, workflow);
  instance.status = "running";
  instance.nodeStates = {
    impl: createNodeState("impl", "ready", {
      threadId: "thread-existing-node" as any,
      attemptId: null,
      retryCount: 2,
    }),
  };
  const { engine } = createHarness();
  bindSingleInstanceRepo(engine, instance);

  engine.appendPendingNodeInput(instance.id, "impl", {
    feedback: "继续当前节点，不要创建新会话。",
    executionOverride: {
      model: "gpt-5.6-terra",
      effort: "high",
      autoCompactPct: 92,
      contextWindow: 372_000,
      serviceTier: "fast",
    },
  });

  assert.equal(instance.nodeStates.impl.status, "ready");
  assert.equal(instance.nodeStates.impl.threadId, "thread-existing-node");
  assert.equal(instance.nodeStates.impl.attemptId, null);
  assert.equal(instance.nodeStates.impl.retryCount, 2);
  assert.equal(instance.nodeStates.impl.feedbackRecordIds?.length, 1);
  assert.equal(instance.nodeStates.impl.activeFeedbackRecordIds?.length, 1);
  const feedbackRecordId = instance.nodeStates.impl.activeFeedbackRecordIds?.[0] ?? "";
  const feedbackRecord = (engine as any).ctx.db.orchFeedback.get(feedbackRecordId);
  assert.equal(feedbackRecord?.action, "system_human_input");
  assert.deepEqual(feedbackRecord?.executionOverride, {
    model: "gpt-5.6-terra",
    effort: "high",
    autoCompactPct: 92,
    contextWindow: 372_000,
    serviceTier: "fast",
  });
  const context = (engine as any).collectFeedbackContext(instance, "impl");
  assert.match(String(context.feedbackPatch ?? ""), /人工补充要求/);
  assert.match(String(context.feedbackPatch ?? ""), /继续当前节点/);
  assert.equal(context.latestAction, "system_human_input");
  assert.equal(context.executionOverride?.model, "gpt-5.6-terra");
});

test("appendPendingNodeInput rejects running and terminal nodes without persisting feedback", () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 0 } },
  ], []);
  const instance = createInstance(role, workflow);
  instance.status = "running";
  instance.nodeStates = { impl: createNodeState("impl", "running") };
  const { engine } = createHarness();
  bindSingleInstanceRepo(engine, instance);

  assert.throws(
    () => engine.appendPendingNodeInput(instance.id, "impl", { feedback: "继续" }),
    /当前节点状态不可追加启动输入: running/,
  );
  assert.deepEqual(instance.nodeStates.impl.feedbackRecordIds, []);

  instance.status = "completed";
  instance.nodeStates.impl.status = "ready";
  assert.throws(
    () => engine.appendPendingNodeInput(instance.id, "impl", { feedback: "继续" }),
    /当前编排状态不可接收节点输入: completed/,
  );
  assert.deepEqual(instance.nodeStates.impl.feedbackRecordIds, []);
});

test("skipWaitingNode marks waiting-start node skipped and schedules continuation", async () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 120 }, startMode: "manual" },
    { id: "end", type: "end", label: "结束", position: { x: 0, y: 240 } },
  ], [
    { id: "start-impl", sourceNodeId: "start", targetNodeId: "impl", conditionBranch: null, dataMappings: [] },
    { id: "impl-end", sourceNodeId: "impl", targetNodeId: "end", conditionBranch: null, dataMappings: [] },
  ]);
  const instance = createInstance(role, workflow);
  instance.status = "waiting-start";
  instance.nodeStates = {
    start: createNodeState("start", "completed"),
    impl: createNodeState("impl", "waiting-start", { error: "等待人工启动节点" }),
    end: createNodeState("end", "pending"),
  };
  const { engine } = createHarness();
  bindSingleInstanceRepo(engine, instance);
  let scheduled = false;
  (engine as any).scheduleReadyNodeBatchesAfterWaitingSkip = () => { scheduled = true; };
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run-skip-waiting-start",
    drivePromise: null,
  });

  await engine.skipWaitingNode(instance.id, "impl", "user-skip");
  await (engine as any).executeReadyNodeBatches(instance.id, "run-skip-waiting-start", { resolveIdleOutcome: true });

  assert.equal(instance.nodeStates.impl.status, "skipped");
  assert.equal(typeof instance.nodeStates.impl.completedAt, "number");
  assert.equal(instance.nodeStates.impl.error, null);
  assert.equal(instance.nodeStates.end.status, "completed");
  assert.equal(instance.status, "completed");
  assert.equal(instance.nodeStates.impl.feedbackRecordIds?.length, 1);
  assert.equal(scheduled, true);
});

test("skipWaitingNode emits completed event when the skipped node is terminal", async () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 120 }, startMode: "manual" },
  ], [
    { id: "start-impl", sourceNodeId: "start", targetNodeId: "impl", conditionBranch: null, dataMappings: [] },
  ]);
  const instance = createInstance(role, workflow);
  instance.status = "waiting-start";
  instance.nodeStates = {
    start: createNodeState("start", "completed"),
    impl: createNodeState("impl", "waiting-start", { error: "等待人工启动节点" }),
  };
  const { engine, orchestrationEvents } = createHarness();
  bindSingleInstanceRepo(engine, instance);
  let scheduled = false;
  (engine as any).scheduleReadyNodeBatchesAfterWaitingSkip = () => { scheduled = true; };

  await engine.skipWaitingNode(instance.id, "impl", "user-skip");

  assert.equal(instance.nodeStates.impl.status, "skipped");
  assert.equal(instance.status, "completed");
  assert.equal(scheduled, false);
  assert.equal(orchestrationEvents.at(-1)?.type, "orchestration.completed");
  assert.deepEqual(JSON.parse(orchestrationEvents.at(-1)?.payloadJson ?? "{}"), {
    instanceId: instance.id,
    status: "completed",
    requirementId: instance.intakeSnapshot.id,
    intakeId: instance.intakeSnapshot.id,
  });
});

test("skipWaitingNode continues ready downstream while another manual-start node is still waiting", async () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    { id: "impl", type: "role", roleId: role.id, label: "实现", position: { x: 0, y: 120 }, startMode: "manual" },
    { id: "review", type: "role", roleId: role.id, label: "复核", position: { x: 180, y: 120 }, startMode: "manual" },
    { id: "end", type: "end", label: "结束", position: { x: 0, y: 240 } },
  ], [
    { id: "start-impl", sourceNodeId: "start", targetNodeId: "impl", conditionBranch: null, dataMappings: [] },
    { id: "start-review", sourceNodeId: "start", targetNodeId: "review", conditionBranch: null, dataMappings: [] },
    { id: "impl-end", sourceNodeId: "impl", targetNodeId: "end", conditionBranch: null, dataMappings: [] },
  ]);
  const instance = createInstance(role, workflow);
  instance.status = "waiting-start";
  instance.nodeStates = {
    start: createNodeState("start", "completed"),
    impl: createNodeState("impl", "waiting-start", { error: "等待人工启动节点" }),
    review: createNodeState("review", "waiting-start", { error: "等待人工启动节点" }),
    end: createNodeState("end", "pending"),
  };
  const { engine } = createHarness();
  bindSingleInstanceRepo(engine, instance);
  let scheduled = false;
  (engine as any).scheduleReadyNodeBatchesAfterWaitingSkip = () => { scheduled = true; };
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run-skip-with-sibling-waiting",
    drivePromise: null,
  });

  await engine.skipWaitingNode(instance.id, "impl", "user-skip");
  await (engine as any).executeReadyNodeBatches(instance.id, "run-skip-with-sibling-waiting", { resolveIdleOutcome: true });

  assert.equal(instance.nodeStates.impl.status, "skipped");
  assert.equal(instance.nodeStates.end.status, "completed");
  assert.equal(instance.nodeStates.review.status, "waiting-start");
  assert.equal(instance.status, "waiting-start");
  assert.equal(scheduled, true);
});

test("findReadyNodes waits for skipped middle node upstream before releasing downstream", async () => {
  const role = createRole();
  const workflow = createWorkflow([
    { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    { id: "first", type: "role", roleId: role.id, label: "第一步", position: { x: 0, y: 120 } },
    { id: "skipped", type: "role", roleId: role.id, label: "被跳过", position: { x: 0, y: 240 } },
    { id: "downstream", type: "role", roleId: role.id, label: "下游", position: { x: 0, y: 360 } },
    { id: "end", type: "end", label: "结束", position: { x: 0, y: 480 } },
  ], [
    { id: "start-first", sourceNodeId: "start", targetNodeId: "first", conditionBranch: null, dataMappings: [] },
    { id: "first-skipped", sourceNodeId: "first", targetNodeId: "skipped", conditionBranch: null, dataMappings: [] },
    { id: "skipped-downstream", sourceNodeId: "skipped", targetNodeId: "downstream", conditionBranch: null, dataMappings: [] },
    { id: "downstream-end", sourceNodeId: "downstream", targetNodeId: "end", conditionBranch: null, dataMappings: [] },
  ]);
  const instance = createInstance(role, workflow);
  instance.status = "running";
  instance.nodeStates = {
    start: createNodeState("start", "completed"),
    first: createNodeState("first", "pending"),
    skipped: createNodeState("skipped", "skipped", { completedAt: 10 }),
    downstream: createNodeState("downstream", "pending"),
    end: createNodeState("end", "pending"),
  };
  const { engine } = createHarness();
  bindSingleInstanceRepo(engine, instance);
  const launchedNodeIds: string[] = [];
  (engine as any).executeNode = async (_instanceId: string, node: WorkflowNode) => {
    launchedNodeIds.push(node.id);
    instance.nodeStates[node.id].status = "running";
  };

  const readyBeforeUpstream = (engine as any).findReadyNodes(workflow.nodes, workflow.edges, instance)
    .map((node: WorkflowNode) => node.id);
  assert.deepEqual(readyBeforeUpstream, ["first"]);

  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run-skipped-middle",
    drivePromise: null,
  });
  await (engine as any).executeReadyNodeBatches(instance.id, "run-skipped-middle", { resolveIdleOutcome: false });
  assert.deepEqual(launchedNodeIds, ["first"]);

  instance.nodeStates.first.status = "completed";
  const readyAfterUpstream = (engine as any).findReadyNodes(workflow.nodes, workflow.edges, instance)
    .map((node: WorkflowNode) => node.id);
  assert.deepEqual(readyAfterUpstream, ["downstream"]);
});

test("resetNodeForRetry clears previous manual start approval", () => {
  const { engine } = createHarness();
  const nodeState = createNodeState("impl", "ready", {
    manualStartApprovedAt: 123,
    manualStartApprovedBy: "user-start",
  });

  (engine as any).resetNodeForRetry(nodeState);

  assert.equal(nodeState.manualStartApprovedAt, null);
  assert.equal(nodeState.manualStartApprovedBy, null);
});

test("resolveRoleDefinition keeps the frozen role when the live role changes", () => {
  const snapshotRole = createRole({ name: "快照角色" });
  const liveRole = createRole({ name: "数据库里的新角色" });
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: snapshotRole.id, label: "设计", position: { x: 0, y: 0 } },
    { id: "review", type: "role", roleId: snapshotRole.id, label: "评审", position: { x: 0, y: 120 } },
    { id: "impl", type: "role", roleId: snapshotRole.id, label: "实现", position: { x: 0, y: 240 } },
  ]);
  const instance = createInstance(snapshotRole, workflow);
  const { engine } = createHarness({ liveRole });

  const resolved = (engine as any).resolveRoleDefinition(instance, snapshotRole.id);

  assert.equal(resolved?.name, "快照角色");
});

test("resolveRoleDefinition keeps the frozen role when the live role is missing", () => {
  const snapshotRole = createRole({ name: "快照角色" });
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: snapshotRole.id, label: "设计", position: { x: 0, y: 0 } },
  ]);
  const instance = createInstance(snapshotRole, workflow);
  const { engine } = createHarness({ liveRole: null });

  const resolved = (engine as any).resolveRoleDefinition(instance, snapshotRole.id);

  assert.equal(resolved?.name, "快照角色");
});

test("resolveRoleTools reads only the frozen toolset graph", () => {
  const frozenToolset: ToolsetDefinition = {
    id: "toolset_live" as any,
    workspaceId: "client-a:ws-demo" as any,
    name: "实时工具集",
    description: "实时工具集",
    kind: "custom",
    tools: [
      {
        id: "tool_live" as any,
        name: "实时工具",
        description: "实时工具",
        runtime: "shell",
        invocationHint: "运行工具",
        code: "echo ok",
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  };
  const role = createRole({
    toolRefs: [{ toolsetId: frozenToolset.id, toolId: "tool_live" as any, required: true }],
  });
  const workflow = createWorkflow([
    { id: "design", type: "role", roleId: role.id, label: "设计", position: { x: 0, y: 0 } },
  ]);
  const instance = createInstance(role, workflow);
  instance.assetRuntimeSnapshot = createAssetRuntimeSnapshot(workflow, {
    roles: [role],
    toolsets: [frozenToolset],
  });
  const changedLiveToolset: ToolsetDefinition = {
    ...frozenToolset,
    name: "实时变更后的工具集",
    tools: [{ ...frozenToolset.tools[0]!, name: "实时变更后的工具" }],
  };
  const { engine } = createHarness({ liveRole: role, toolsets: [changedLiveToolset] });
  (engine as any).ctx.db.orchToolsets = {
    get() {
      throw new Error("live toolset repo should not be called");
    },
  };

  const resolved = (engine as any).resolveRoleTools(instance, role);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.tool.name, "实时工具");
});

test("buildRoleExecutionRevision hashes only referenced tools inside bound toolsets", () => {
  const role = createRole({
    toolRefs: [{ toolsetId: "toolset_revision" as any, toolId: "tool_used" as any, required: true }],
  });
  const baseToolset: ToolsetDefinition = {
    id: "toolset_revision" as any,
    workspaceId: "client-a:ws-demo" as any,
    name: "revision 工具集",
    description: "revision 工具集",
    kind: "custom",
    tools: [
      {
        id: "tool_used" as any,
        name: "已引用工具",
        description: "已引用工具",
        runtime: "shell",
        invocationHint: "运行已引用工具",
        code: "echo used",
      },
      {
        id: "tool_unused" as any,
        name: "未引用工具",
        description: "未引用工具",
        runtime: "shell",
        invocationHint: "运行未引用工具",
        code: "echo unused",
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  };

  const original = buildRoleExecutionRevision(role, [baseToolset]);
  const unreferencedChanged = buildRoleExecutionRevision(role, [{
    ...baseToolset,
    tools: [
      baseToolset.tools[0]!,
      { ...baseToolset.tools[1]!, code: "echo unused changed" },
    ],
  }]);
  const referencedChanged = buildRoleExecutionRevision(role, [{
    ...baseToolset,
    tools: [
      { ...baseToolset.tools[0]!, code: "echo used changed" },
      baseToolset.tools[1]!,
    ],
  }]);

  assert.equal(unreferencedChanged.toolBindingHash, original.toolBindingHash);
  assert.notEqual(referencedChanged.toolBindingHash, original.toolBindingHash);
});

test("buildRoleExecutionRevision hashes referenced skills", () => {
  const role = createRole({
    defaultSkillIds: ["skill_revision" as any],
  });
  const baseSkill: SkillDefinition = {
    id: "skill_revision" as any,
    workspaceId: "client-a:ws-demo" as any,
    name: "revision Skill",
    description: "revision Skill",
    trigger: "测试时启用",
    instructions: "原始指令",
    targetEngines: ["codex"],
    tags: ["test"],
    kind: "custom",
    createdAt: 1,
    updatedAt: 2,
  };
  const unrelatedSkill: SkillDefinition = {
    ...baseSkill,
    id: "skill_unreferenced" as any,
    instructions: "未引用指令已变化",
  };

  const original = buildRoleExecutionRevision(role, [], [baseSkill]);
  const unreferencedChanged = buildRoleExecutionRevision(role, [], [baseSkill, unrelatedSkill]);
  const referencedChanged = buildRoleExecutionRevision(role, [], [{
    ...baseSkill,
    instructions: "变更后的指令",
  }]);

  assert.equal(unreferencedChanged.skillBindingHash, original.skillBindingHash);
  assert.notEqual(referencedChanged.skillBindingHash, original.skillBindingHash);
});

test("role-bound skill scripts are exposed as dynamic orchestration tools", () => {
  const workspacePath = createTemporaryWorkspace(path.join(os.tmpdir(), "codeflowai-skill-tool-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "application.db") });
  try {
    const role = createRole({
      defaultSkillIds: ["skill_package" as any],
      executionConfig: createExecutionConfig({
        preferredEngine: "codex",
        codex: {
          mode: "custom",
          customConfig: {
            accessMode: "current",
          },
        },
      }),
    });
    const workflow = createWorkflow([]);
    const instance = createInstance(role, workflow);
    const skill: SkillDefinition = {
      id: "skill_package" as any,
      workspaceId: instance.workspaceId,
      name: "Package Skill",
      slug: "package-skill",
      description: "Skill package with script",
      trigger: "需要脚本时使用",
      instructions: "使用脚本",
      targetEngines: ["codex"],
      tags: [],
      packageVersion: 1,
      skillMd: "---\nname: package-skill\ndescription: test\n---\n\n# Package Skill\n",
      files: [
        {
          relPath: "SKILL.md",
          kind: "skill-md",
          contentText: "---\nname: package-skill\ndescription: test\n---\n\n# Package Skill\n",
          contentBase64: null,
          contentType: "text/markdown",
          sizeBytes: 0,
          sha256: "",
        },
        {
          relPath: "scripts/hello.py",
          kind: "script",
          contentText: "print_json({\"ok\": True, \"input\": INPUT})\n",
          contentBase64: null,
          contentType: "text/x-python",
          sizeBytes: 0,
          sha256: "",
        },
      ],
      scripts: [{
        id: "hello",
        name: "Hello",
        description: "返回输入",
        scriptPath: "scripts/hello.py",
        runtime: "python",
        inputSchema: "{\"type\":\"object\"}",
        outputSchema: "",
        timeoutMs: 30_000,
        requiresWrite: false,
        exposeAsTool: true,
      }],
      installTargets: ["codex"],
      kind: "custom",
      createdAt: 1,
      updatedAt: 2,
    };
    instance.assetRuntimeSnapshot = createAssetRuntimeSnapshot(workflow, {
      roles: [role],
      skills: [skill],
    });
    const { engine } = createHarness({ skills: [skill] });
    const roleTools = (engine as any).resolveRoleTools(instance, role);
    const prefs = (engine as any).resolveExecutionPrefs(instance, role, roleTools);
    const roleSkills = (engine as any).resolveRoleSkills(instance, role, prefs.engine);
    db.workspaces.upsert({ id: instance.workspaceId, title: "Skill", path: workspacePath });
    const skillTools = buildSkillScriptToolEntries({
      db, requestId: "role-bound-script-test",
      workspacePath,
      workspaceId: instance.workspaceId,
      skills: roleSkills,
    });

    (engine as any).assertToolAccessAllowed(role, [...roleTools, ...skillTools], prefs.accessMode);
    const registry = (engine as any).buildToolRegistry(skillTools, {} as RuntimeEvidenceService, prefs.accessMode, null);
    const tool = registry.tools.find((item: { toolId: string }) => item.toolId === "skill.package-skill.hello");

    assert.equal(tool?.runtime, "python");
    assert.match(tool?.workingDirectory ?? "", /^\.codeflowai\/skill-runtime\/package-skill-[a-f0-9]{16}\/[a-f0-9]{64}$/);
    assert.equal(tool?.inputSchema, "{\"type\":\"object\"}");
    assert.equal(fs.existsSync(path.join(workspacePath, tool!.workingDirectory!, "scripts", "hello.py")), true);
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("流程节点提交知识修改建议后继续交付，提案即时可审批且不产生流程等待", async t => {
  const workspace = createTemporaryWorkspace(path.join(os.tmpdir(), "workflow-knowledge-change-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "retry.ts"), "export const retries = 3;\n");
  const store = new KnowledgeAssetStore(workspace);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "retry", parentId: null, title: "重试策略", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: ["retry.ts"] }] }, null);
  store.saveDocument({ nodeId: "retry", content: "最多重试 2 次。", sources: [], expectedHash: null, origin: "manual" });
  const changes = new KnowledgeChangeStore(store);
  const role = createRole();
  const node: WorkflowNode = { id: "analysis", type: "role", roleId: role.id, label: "分析", position: { x: 0, y: 0 } };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  instance.status = "running";
  instance.nodeStates = { analysis: createNodeState(node.id, "running") };
  const { engine, orchestrationEvents } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const ctx = (engine as any).ctx;
  const conversationEvents: Array<Record<string, any>> = [];
  const rawEvents: unknown[] = [];
  const snapshots: Array<Record<string, any>> = [];
  let turnActive = true;
  let submitAfterTurn: (() => Promise<any>) | null = null;
  ctx.workspaces.set(workflow.workspaceId, workspace);
  ctx.db.turns = { get: () => ({ status: turnActive ? "started" : "completed" }) };
  ctx.db.threads = { create: (input: unknown) => input, updatePrefs() {} };
  ctx.db.orchPromptSnapshots = {
    create(input: Record<string, any>) { const value = { ...input, id: `snapshot-${snapshots.length}` }; snapshots.push(value); return value; },
    listByNode: () => [],
  };
  ctx.threads = { create: (input: unknown) => input };
  ctx.emitConversation = (event: Record<string, any>) => conversationEvents.push(event);
  ctx.emitRaw = (event: unknown) => rawEvents.push(event);
  ctx.sessions = { getOrCreate: () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    async sendMessage(input: any, emitters: any) {
      assert.ok(input.toolRegistry.tools.some((tool: any) => tool.toolId === "knowledge.change.propose"));
      const read = await input.executeHostTool({ toolId: "knowledge.node.read", toolInput: { nodeId: "retry" }, accessMode: "current" });
      const source = await input.executeHostTool({ toolId: "knowledge.source.read", toolInput: { path: "retry.ts" }, accessMode: "current" });
      assert.equal(read.ok, true);
      assert.equal(source.ok, true);
      const proposal = {
        nodeId: "retry", expectedHash: store.currentHash("retry"), summary: "源码为 3 次，纠正过期文档", content: "最多重试 3 次。",
        sources: [{ kind: "code", path: "retry.ts", contentHash: store.readSource("retry.ts").contentHash, relation: "重试次数定义" }],
      };
      submitAfterTurn = () => input.executeHostTool({ toolId: "knowledge.change.propose", toolInput: proposal, accessMode: "current" });
      const result = await submitAfterTurn();
      assert.equal(result.ok, true);
      assert.equal(result.output.continueCurrentTask, true);
      assert.equal(changes.list().items[0]?.status, "pending", "提案在节点完成前已进入审批区");
      assert.equal(store.detail("retry").current?.content, "最多重试 2 次。");
      assert.equal(instance.status, "running");
      assert.equal(instance.nodeStates.analysis.status, "running");
      emitters.raw({ ts: Date.now(), workspaceId: workflow.workspaceId, threadId: instance.nodeStates.analysis.threadId, engine: "claude", source: "test.knowledge-proposal", data: { proposalId: result.output.proposalId }, handled: true, action: "mapped", emittedTypes: [] });
      const delivered = await input.executeHostTool({ toolId: "runtime.submitNodeResult", toolInput: createTextFinalAnswer("原任务正常交付，知识修改建议独立审核。"), accessMode: "current" });
      assert.equal(delivered.ok, true);
      return { responseText: "原任务已完成。" };
    },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
  }) };
  const registry = { tools: [...buildKnowledgeAssetReadTools(true).tools, buildKnowledgeChangeTool()] };
  const runtimePolicy = {
    workflowId: workflow.id, workflowName: workflow.name, nodeId: node.id, nodeLabel: node.label,
    approvalMode: "auto", accessMode: "current", toolRuntimePolicy: { allowedToolIds: registry.tools.map(tool => tool.toolId), requiresWorkspaceWrite: false },
    artifactPolicy: { persistenceMode: "db-only", outputMode: "text", primaryKind: "analysis-report" },
  };
  const prompt = {
    systemMessage: "system", developerMessage: "developer", userMessage: "核对重试规则并继续原任务", renderedInputPreview: "preview",
    promptEnvelope: createPromptEnvelope({ workflow, nodeId: node.id, nodeLabel: node.label, userMessage: "核对重试规则并继续原任务", runtimePolicy, toolRegistry: registry }),
    snapshots: { runtimePolicy, knowledgeCatalogs: [], knowledgeWarnings: [], artifactInput: { artifacts: [], fieldBindings: {} }, toolRegistry: registry },
  };
  const result = await (engine as any).executeSubThread(instance, node, role, prompt, { engine: "claude", model: "claude-sonnet-4-6", effort: "medium", accessMode: "current" });
  assert.equal(result.finalAnswer.control.nextAction, "continue");
  assert.equal(changes.list().items[0]?.origin, "workflow");
  assert.equal(changes.list().items[0]?.status, "pending");
  const suggestionMessage = conversationEvents.find(event => event.type === "item.agentMessage.completed" && event.payload.text.includes("本轮已提交 1 项文档修改建议"));
  assert.ok(suggestionMessage && suggestionMessage.type === "item.agentMessage.completed");
  assert.ok(suggestionMessage.payload.text.includes(`[规格知识库 → 待确认更新](/knowledge?view=approvals&workspaceId=${encodeURIComponent(instance.workspaceId)}&changeId=${encodeURIComponent(changes.list().items[0]!.id)})`));
  assert.equal(conversationEvents.some(event => /approval|interaction.*request/.test(event.type)), false);
  assert.equal(orchestrationEvents.some(event => /waiting|approval/i.test(event.type)), false);
  assert.equal(rawEvents.length, 1);
  assert.ok(snapshots[0]?.toolRegistry.tools.some((tool: any) => tool.toolId === "knowledge.change.propose"));
  turnActive = false;
  assert.ok(submitAfterTurn);
  const late = await (submitAfterTurn as () => Promise<any>)();
  assert.equal(late.ok, false);
  assert.equal(late.code, "KNOWLEDGE_ASSET_INTERRUPTED");
  assert.equal(changes.list().items.length, 1);
});

test("executeSubThread keeps provider native tools enabled for orchestration role turns", async () => {
  const role = createRole();
  const workflow: WorkflowDefinition = {
    id: "wf_exec" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "执行测试",
    description: "执行测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "分析", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_exec" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_exec" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "analysis",
      title: "验证工具循环",
      goal: "验证工具循环",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      analysis: {
        nodeId: "analysis",
        status: "running",
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const sentInputs: Array<Record<string, unknown>> = [];
  const promptSnapshots: NodePromptSnapshot[] = [];
  const threadRecords: Array<Record<string, unknown>> = [];
  const threadPrefs: Array<Record<string, unknown>> = [];
  const conversationEvents: Array<Record<string, unknown>> = [];
  const rawEvents: Array<Record<string, unknown>> = [];
  const orchestrationEvents: Array<Record<string, unknown>> = [];

  const engine = new OrchestrationEngine({
    db: {
      threads: {
        create(input: Record<string, unknown>) {
          threadRecords.push(input);
          return input;
        },
        updatePrefs(threadId: ThreadId, prefs: Record<string, unknown>) {
          threadPrefs.push({ threadId, prefs });
        },
      },
      orchPromptSnapshots: {
        create(input: Record<string, unknown>) {
          const snapshot = {
            id: `snapshot_${promptSnapshots.length + 1}`,
            ...input,
          } as NodePromptSnapshot;
          promptSnapshots.push(snapshot);
          return snapshot;
        },
        listByNode() {
          return [];
        },
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus() {},
      },
      orchEvents: {
        append(event: Record<string, unknown>) {
          orchestrationEvents.push(event);
          return event;
        },
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
      },
      turns: createActiveTurnProbeStub(),
    } as any,
    threads: {
      create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string }) {
        return input;
      },
    } as any,
    sessions: {
      getOrCreate() {
        return {
          resolvePlatformToolTransport() {
            return "native-dynamic" as const;
          },
          async sendMessage(
            input: Record<string, unknown>,
            emitters: {
              conversation: (event: Record<string, unknown>) => void;
              raw: (event: Record<string, unknown>) => void;
            },
          ) {
            sentInputs.push(input);
            emitters.raw({
              ts: 1,
              workspaceId: workflow.workspaceId,
              threadId: threadRecords[0]?.id ?? "thread-test",
              engine: "claude",
              source: "test.raw",
              data: { step: "raw" },
              handled: true,
              action: "mapped",
              emittedTypes: ["item.agentMessage.completed"],
            });
            const submitted = createTextFinalAnswer("分析完成");
            const toolInput = submitted;
            const toolResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.submitNodeResult",
              toolInput,
              accessMode: "current",
            });
            assert.equal(toolResult?.ok, true);
            const acceptedAttempt = (engine as any).ctx.db.orchNodeAttempts.getLatestByNode(instance.id, "analysis");
            assert.ok(acceptedAttempt);
            (engine as any).ctx.db.orchNodeAttempts.begin({
              instanceId: instance.id,
              nodeId: "analysis",
              invalidationReason: "测试同节点新 Attempt 替换旧提交",
            });
            const staleToolResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.submitNodeResult",
              toolInput,
              accessMode: "current",
            });
            assert.equal(staleToolResult?.ok, false);
            assert.equal(staleToolResult?.code, "VALIDATION_FAILED");
            const responseText = "分析完成";
            emitters.conversation({
              ts: 1,
              workspaceId: workflow.workspaceId,
              threadId: threadRecords[0]?.id ?? "thread-test",
              engine: "claude",
              type: "item.agentMessage.completed",
              payload: {
                itemId: "assistant-item",
                engineMessageId: "assistant-item",
                text: responseText,
                revision: 0,
              },
            });
            return {
              responseText,
            };
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
        };
      },
    } as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation(event: Record<string, unknown>) {
      conversationEvents.push(event);
    },
    emitRaw(event: Record<string, unknown>) {
      rawEvents.push(event);
    },
  });

  const prompt = {
    systemMessage: "system",
    developerMessage: "developer",
    userMessage: "user",
    renderedInputPreview: "preview",
    snapshots: {
      runtimePolicy: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: "analysis",
        nodeLabel: "分析",
        approvalMode: "auto",
        accessMode: "current",
        toolRuntimePolicy: {
          allowedToolIds: ["tool-a"],
          requiresWorkspaceWrite: false,
        },
        artifactPolicy: {
          persistenceMode: "db-only",
          outputMode: "text",
          primaryKind: "analysis-report",
        },
      },
      knowledgeCatalogs: [],
      knowledgeWarnings: [],
      artifactInput: {
        artifacts: [],
        fieldBindings: {},
      },
      toolRegistry: {
        tools: [
          {
            toolsetId: "toolset-1" as any,
            toolsetName: "工具集",
            toolId: "tool-a" as any,
            name: "工具 A",
            alias: null,
            description: "测试工具",
            runtime: "shell",
            usageGuidance: null,
            invocationHint: null,
            code: "echo ok",
            inputSchema: null,
            outputSchema: null,
            timeoutMs: 1_000,
            workingDirectory: ".",
            permissions: {
              requiresWrite: false,
            },
            envPolicy: null,
            required: false,
          },
        ],
      },
    },
  };
  (prompt as any).promptEnvelope = createPromptEnvelope({
    workflow,
    nodeId: "analysis",
    nodeLabel: "分析",
    userMessage: prompt.userMessage,
    runtimePolicy: prompt.snapshots.runtimePolicy,
    artifactInput: prompt.snapshots.artifactInput,
    toolRegistry: prompt.snapshots.toolRegistry,
  });
  const roleRevision = buildRoleExecutionRevision(role, []);
  (prompt as any).promptEnvelope.meta.roleExecutionRevision = roleRevision;

  const result = await (engine as any).executeSubThread(
    instance,
    workflow.nodes[0],
    role,
    prompt,
    {
      engine: "claude",
      model: "claude-sonnet-4-6[1m]",
      effort: "medium",
      accessMode: "current",
      autoCompactPct: 81,
      contextWindow: 300000,
    },
  );

  assert.equal(sentInputs.length, 1);
  assert.equal(sentInputs[0]?.providerNativeToolPolicy, "allow");
  assert.equal(sentInputs[0]?.conversationProfile, "orchestration");
  assert.equal(sentInputs[0]?.responseFormat, "text");
  assert.equal(sentInputs[0]?.autoCompactPct, 81);
  assert.equal(sentInputs[0]?.contextWindow, 300000);
  assert.equal(sentInputs[0]?.model, "claude-sonnet-4-6[1m]");
  assert.equal(promptSnapshots.length, 1);
  assert.equal(promptSnapshots[0]?.promptEnvelope.meta.nodeId, "analysis");
  assert.deepEqual(promptSnapshots[0]?.promptEnvelope.meta.roleExecutionRevision, roleRevision);
  assert.deepEqual(promptSnapshots[0]?.roleExecutionRevision, roleRevision);
  assert.equal(result.finalAnswer.answer.mode, "text");
  assert.equal((result.finalAnswer.answer as NodeExecutionEnvelope & { text?: string }).text, "分析完成");
  assert.equal(result.finalAnswer.control.nextAction, "continue");
  assert.equal(instance.nodeStates.analysis.threadId, threadRecords[0]?.id);
  const turnStartedEvent = conversationEvents.find((event) => event.type === "turn.started");
  const turnStartedPayload = turnStartedEvent?.payload as { execution?: unknown } | undefined;
  assert.deepEqual(turnStartedPayload?.execution, {
    model: "claude-sonnet-4-6[1m]",
    effort: "medium",
    contextWindow: 300000,
    autoCompactPct: 81,
    serviceTier: null,
  });
  assert.deepEqual(rawEvents, [
    {
      ts: 1,
      workspaceId: workflow.workspaceId,
      threadId: threadRecords[0]?.id ?? "thread-test",
      engine: "claude",
      source: "test.raw",
      data: { step: "raw" },
      handled: true,
      action: "mapped",
      emittedTypes: ["item.agentMessage.completed"],
    },
  ]);
  assert.ok(orchestrationEvents.some((event) => event.type === "orchestration.nodeAttemptRejected"));
});

test("实际 provider unexpected close 沿原编排消费写唯一 turn.error 和 ended_at，默认等待反馈并停止下游", async (t) => {
  const directory = createTemporaryWorkspace(path.join(os.tmpdir(), "codex-orch-unexpected-close-"));
  const application = openClientDb({ dbPath: path.join(directory, "client.db"), localCanonicalEvents: true });
  t.after(() => { application.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const role = createRole({ executionConfig: createExecutionConfig({ preferredEngine: "codex" }) });
  const node: WorkflowNode = { id: "analysis", type: "role", roleId: role.id, label: "分析", position: { x: 0, y: 0 } };
  const downstream: WorkflowNode = { ...node, id: "downstream", label: "下游" };
  const start: WorkflowNode = { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } };
  const workflow = createWorkflow([start, node, downstream], [{
    id: "edge-start", sourceNodeId: start.id, targetNodeId: node.id, conditionBranch: null, dataMappings: [],
  }, {
    id: "edge-next", sourceNodeId: node.id, targetNodeId: downstream.id, conditionBranch: null, dataMappings: [],
  }]);
  application.workspaces.upsert({ id: workflow.workspaceId, title: "进程失败", path: directory });
  const db = application.forWorkspace(workflow.workspaceId);
  const instance = db.orchInstances.create({
    workspaceId: workflow.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: createInstance(role, workflow).intakeSnapshot,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
  });
  const workspace = new CodexAppServerWorkspace({
    workspaceId: workflow.workspaceId, workspacePath: directory,
    clientInfo: { name: "test", title: "Test", version: "0.0.0" },
  });
  const child = { pid: 42_427 };
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  const requests: string[] = [];
  t.mock.method(workspace, "request", async (method: string, params: any) => {
    requests.push(method);
    if (method === "thread/start") return { thread: { id: "provider-orch-close" } };
    if (method === "turn/start") return { turn: { id: "provider-turn-close" } };
    if (method === "thread/read" && params.includeTurns === false) return { thread: { id: "provider-orch-close", status: { type: "idle" } } };
    if (method === "thread/goal/get") return { goal: null };
    assert.fail(`实际退出后不得发送恢复 RPC：${method}`);
  });

  // 执行原主入口索引函数，避免测试自行重写 turn 终态写库规则。
  const source = fs.readFileSync(new URL("../../apps/desktop/client/src/index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(["createEventIndexRuntime", "applyTurnIndexEvent", "applyPendingCodexProviderTurnMapping", "ensureTerminalTurnRow", "cleanupPendingTools"]);
  const code = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text ?? ""))
    .map(statement => statement.getText(ast)).join("\n");
  const indexContext: Record<string, any> = {
    clearActiveThreadTurnIfMatches, resolveTurnErrorIndexScope, readTurnExecutionOptionsSnapshot,
    persistOrStageCodexProviderTurn, applyThreadReminderStateEvent, logger,
  };
  vm.runInNewContext(ts.transpileModule(`${code}\nglobalThis.indexEvent = applyTurnIndexEvent; globalThis.runtime = createEventIndexRuntime();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, indexContext);
  const workspaces = new Map([[workflow.workspaceId, directory]]);
  const persistence = createLocalEventPersistence({
    db,
    applyConversation(event) { indexContext.indexEvent({ db, runtime: indexContext.runtime, workspaces }, event); },
    applyRaw() {},
  });
  const sessions: CodexAppServerThreadSession[] = [];
  const engine = new ProductionOrchestrationEngine({
    db, workspaces, threads: new ThreadStore(),
    sessions: { getOrCreate(thread: any) {
      const session = new CodexAppServerThreadSession({
        writeWorkspaceLog: db.writeWorkspaceLog,
        manager: { getOrCreate: () => workspace, getExisting: () => workspace } as any,
        workspacePath: directory, workspaceId: workflow.workspaceId, threadId: thread.threadId,
        initialSessionId: null, initialSessionCapabilities: null,
        onEngineProcessSnapshot() { return false; }, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {},
        supportsNativeDynamicTools() { return true; },
      });
      sessions.push(session);
      return session;
    } } as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 60_000, engineIdleTimeoutMs: 60_000 },
    emitConversation(event) { persistence.persist({ t: "conversation.event", event }); },
    emitRaw(event) { persistence.persist({ t: "raw.event", event }); },
  });
  await engine.startInBackground(instance.id, "request-provider-close");
  let drive: Promise<void> | undefined;
  try {
    for (let attempt = 0; attempt < 50 && !(sessions[0] as any)?.active; attempt += 1) await nextTimerTick();
    assert.ok((sessions[0] as any)?.active, JSON.stringify(db.orchInstances.get(instance.id)?.nodeStates));
    drive = (engine as any).runningInstances.get(instance.id)?.drivePromise;
    assert.ok(drive);
    (workspace as any).handleChildClose(child, 1, 1, null);
    let settled = false;
    void drive.then(() => { settled = true; });
    for (let attempt = 0; attempt < 50 && !settled; attempt += 1) await nextTimerTick();
    assert.equal(settled, true, "原编排消费者必须结算真实进程失败");
    await drive;
    const current = db.orchInstances.get(instance.id)!;
    const threadId = current.nodeStates.analysis.threadId!;
    const turns = db.turns.listByThread(threadId);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.status, "error");
    assert.ok(turns[0]?.endedAt);
    const events = db.conversationEvents.listByThreadType(threadId, "turn.error", { limit: 10 });
    assert.equal(events.length, 1);
    assert.equal((events[0]?.payload as any).code, "codex_app_server_closed");
    assert.equal(db.conversationEvents.listByThreadType(threadId, "turn.completed", { limit: 10 }).length, 0);
    assert.equal(current.nodeStates.analysis.status, "waiting-feedback");
    assert.equal(current.status, "waiting-feedback");
    assert.equal(current.nodeStates.downstream.status, "pending");
    assert.equal(db.orchArtifacts.listByInstance(instance.id).length, 0);
    const orchEvents = db.orchEvents.listByInstance(instance.id);
    assert.equal(orchEvents.filter(event => event.type === "orchestration.feedbackRequested").length, 1);
    assert.equal(orchEvents.some(event => event.type === "orchestration.completed"), false);
    assert.deepEqual(requests, ["thread/start", "turn/start"]);
  } finally {
    for (const session of sessions) (session as any).active?.reject(Object.assign(new Error("test cleanup"), { terminationKind: "error" }));
    if (drive) await drive;
  }
});

test("executeSubThread keeps the turn completed when runtime.submitNodeResult is accepted before a late sendMessage error", async () => {
  const role = createRole();
  const workflow: WorkflowDefinition = {
    id: "wf_exec_late_error" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "执行测试",
    description: "执行测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "分析", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_exec_late_error" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_exec_late_error" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "analysis",
      title: "验证 accepted 后迟到异常",
      goal: "验证 accepted 后迟到异常",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      analysis: {
        nodeId: "analysis",
        status: "running",
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const sentInputs: Array<Record<string, unknown>> = [];
  const promptSnapshots: NodePromptSnapshot[] = [];
  const threadRecords: Array<Record<string, unknown>> = [];
  const conversationEvents: Array<Record<string, unknown>> = [];

  const engine = new OrchestrationEngine({
    db: {
      threads: {
        create(input: Record<string, unknown>) {
          threadRecords.push(input);
          return input;
        },
        updatePrefs() {},
      },
      orchPromptSnapshots: {
        create(input: Record<string, unknown>) {
          const snapshot = {
            id: `snapshot_${promptSnapshots.length + 1}`,
            ...input,
          } as NodePromptSnapshot;
          promptSnapshots.push(snapshot);
          return snapshot;
        },
        listByNode() {
          return [];
        },
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus() {},
      },
      orchEvents: {
        append() {},
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
      },
      turns: createActiveTurnProbeStub(),
    } as any,
    threads: {
      create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string }) {
        return input;
      },
    } as any,
    sessions: {
      getOrCreate() {
        return {
          resolvePlatformToolTransport() {
            return "native-dynamic" as const;
          },
          async sendMessage(
            input: Record<string, unknown>,
            emitters: {
              conversation: (event: Record<string, unknown>) => void;
              raw: (event: Record<string, unknown>) => void;
            },
          ) {
            sentInputs.push(input);
            const submitted = createTextFinalAnswer("分析完成");
            const toolInput = submitted;
            const toolResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.submitNodeResult",
              toolInput,
              accessMode: "current",
            });
            assert.equal(toolResult?.ok, true);
            emitters.conversation({
              ts: 1,
              workspaceId: workflow.workspaceId,
              threadId: threadRecords[0]?.id ?? "thread-test",
              engine: "claude",
              type: "turn.error",
              payload: {
                turnId: input.turnId,
                error: "late failure after submission",
              },
            });
            emitters.conversation({
              ts: 1,
              workspaceId: workflow.workspaceId,
              threadId: threadRecords[0]?.id ?? "thread-test",
              engine: "claude",
              type: "item.agentMessage.completed",
              payload: {
                itemId: "assistant-item",
                engineMessageId: "assistant-item",
                text: "分析完成",
                revision: 0,
              },
            });
            throw new Error("late failure after submission");
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
        };
      },
    } as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation(event: Record<string, unknown>) {
      conversationEvents.push(event);
    },
    emitRaw() {},
  });

  const prompt = {
    systemMessage: "system",
    developerMessage: "developer",
    userMessage: "user",
    renderedInputPreview: "preview",
    snapshots: {
      runtimePolicy: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: "analysis",
        nodeLabel: "分析",
        approvalMode: "auto",
        accessMode: "current",
        toolRuntimePolicy: {
          allowedToolIds: ["tool-a"],
          requiresWorkspaceWrite: false,
        },
        artifactPolicy: {
          persistenceMode: "db-only",
          outputMode: "text",
          primaryKind: "analysis-report",
        },
      },
      knowledgeCatalogs: [],
      knowledgeWarnings: [],
      artifactInput: {
        artifacts: [],
        fieldBindings: {},
      },
      toolRegistry: {
        tools: [
          {
            toolsetId: "toolset-1" as any,
            toolsetName: "工具集",
            toolId: "tool-a" as any,
            name: "工具 A",
            alias: null,
            description: "工具 A",
            runtime: "builtin",
            usageGuidance: null,
            invocationHint: null,
            code: "",
            inputSchema: "{\"type\":\"object\"}",
            outputSchema: "{\"type\":\"object\"}",
            permissions: { requiresWrite: false },
            envPolicy: null,
            required: false,
          },
        ],
      },
    },
  };
  (prompt as any).promptEnvelope = createPromptEnvelope({
    workflow,
    nodeId: "analysis",
    nodeLabel: "分析",
    userMessage: prompt.userMessage,
    runtimePolicy: prompt.snapshots.runtimePolicy,
    artifactInput: prompt.snapshots.artifactInput,
    toolRegistry: prompt.snapshots.toolRegistry,
  });

  const result = await (engine as any).executeSubThread(
    instance,
    workflow.nodes[0],
    role,
    prompt,
    {
      engine: "claude",
      model: "claude-sonnet-4-6[1m]",
      effort: "medium",
      accessMode: "current",
      autoCompactPct: 81,
      contextWindow: 300000,
    },
  );

  assert.equal(sentInputs.length, 1);
  assert.equal(result.finalAnswer.answer.mode, "text");
  assert.equal((result.finalAnswer.answer as NodeExecutionEnvelope & { text?: string }).text, "分析完成");
  const terminalEvents = conversationEvents.filter((event) => event.type === "turn.completed" || event.type === "turn.error");
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0]?.type, "turn.completed");
});

test("executeSubThread reuses a Codex thread without requiring frozen capability evidence", async () => {
  const role = createRole();
  const workflow: WorkflowDefinition = {
    id: "wf_exec_reuse_thread" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "执行线程复用测试",
    description: "执行线程复用测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "分析", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const existingThreadId = "orch_existing_thread" as ThreadId;
  const instance: OrchestrationInstance = {
    id: "orch_exec_reuse_thread" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_exec_reuse_thread" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "复用原线程",
      goal: "复用原线程",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      analysis: {
        nodeId: "analysis",
        status: "running",
        threadId: existingThreadId,
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const createdDbThreads: Array<Record<string, unknown>> = [];
  const renamedDbThreads: Array<Record<string, unknown>> = [];
  const hydratedThreads: Array<Record<string, unknown>> = [];
  const threadPrefs: Array<Record<string, unknown>> = [];
  const promptSnapshots: NodePromptSnapshot[] = [];
  const sentInputs: Array<Record<string, unknown>> = [];

  const engine = new OrchestrationEngine({
    db: {
      threads: {
        create(input: Record<string, unknown>) {
          createdDbThreads.push(input);
          return input;
        },
        get(threadId: ThreadId) {
          if (threadId !== existingThreadId) return null;
          return {
            id: existingThreadId,
            workspaceId: workflow.workspaceId,
            engine: "codex",
            title: "[编排] 历史线程",
            threadType: "orchestration",
            threadSubtype: "node",
            sessionId: "session_existing" as any,
            sessionCapabilities: null,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
            model: "gpt-5.5",
            effort: "medium",
            accessMode: "current",
            planMode: null,
          };
        },
        rename(threadId: ThreadId, title: string) {
          renamedDbThreads.push({ threadId, title });
        },
        updatePrefs(threadId: ThreadId, prefs: Record<string, unknown>) {
          threadPrefs.push({ threadId, prefs });
        },
      },
      orchPromptSnapshots: {
        create(input: Record<string, unknown>) {
          const snapshot = {
            id: `snapshot_${promptSnapshots.length + 1}`,
            ...input,
          } as NodePromptSnapshot;
          promptSnapshots.push(snapshot);
          return snapshot;
        },
        listByNode() {
          return [];
        },
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus() {},
      },
      orchEvents: {
        append() {},
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
      },
      turns: createActiveTurnProbeStub(),
    } as any,
    threads: {
      get(threadId: ThreadId) {
        assert.equal(threadId, existingThreadId);
        return null;
      },
      create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string; sessionId?: string | null }) {
        hydratedThreads.push(input);
        return { ...input, sessionId: input.sessionId ?? null };
      },
      setSessionId(threadId: ThreadId, sessionId: string) {
        hydratedThreads.push({ kind: "sessionId", threadId, sessionId });
      },
      setTitle(threadId: ThreadId, title: string) {
        hydratedThreads.push({ kind: "title", threadId, title });
      },
    } as any,
    sessions: {
      getOrCreate(thread: { threadId: ThreadId }) {
        assert.equal(thread.threadId, existingThreadId);
        return {
          resolvePlatformToolTransport() {
            return "native-dynamic" as const;
          },
          async sendMessage(
            input: Record<string, unknown>,
            emitters: {
              conversation: (event: Record<string, unknown>) => void;
              raw: (event: Record<string, unknown>) => void;
            },
          ) {
            sentInputs.push(input);
            const submitted = createTextFinalAnswer("沿用原线程继续执行");
            const toolInput = submitted;
            const toolResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.submitNodeResult",
              toolInput,
              accessMode: "current",
            });
            assert.equal(toolResult?.ok, true);
            const responseText = "沿用原线程继续执行";
            emitters.conversation({
              ts: 1,
              workspaceId: workflow.workspaceId,
              threadId: existingThreadId,
              engine: "codex",
              type: "item.agentMessage.completed",
              payload: {
                itemId: "assistant-item",
                engineMessageId: "assistant-item",
                text: responseText,
                revision: 0,
              },
            });
            return { responseText };
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
        };
      },
    } as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const prompt = {
    systemMessage: "system",
    developerMessage: "developer",
    userMessage: [
      "<user_prompt>",
      "  <task_goal>复用原线程</task_goal>",
      "  <execution_intent mode=\"rework-upstream-node\">当前轮次是上游节点返工</execution_intent>",
      "  <acceptance_criteria>",
      "    <criterion id=\"ac_1\" blocking=\"true\">保留线程上下文</criterion>",
      "  </acceptance_criteria>",
      "</user_prompt>",
    ].join("\n"),
    continuationUserMessage: [
      "<user_prompt>",
      "  <task_goal>复用原线程</task_goal>",
      "  <execution_intent mode=\"rework-upstream-node\">当前节点因下游反馈被退回返工</execution_intent>",
      "  <human_feedback>- 退回修改要求",
      "请基于最新测试反馈继续修正</human_feedback>",
      "</user_prompt>",
    ].join("\n"),
    renderedInputPreview: "preview",
    snapshots: {
      runtimePolicy: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: "analysis",
        nodeLabel: "分析",
        approvalMode: "auto",
        accessMode: "current",
        toolRuntimePolicy: {
          allowedToolIds: ["tool-a"],
          requiresWorkspaceWrite: false,
        },
        artifactPolicy: {
          persistenceMode: "db-only",
          outputMode: "text",
          primaryKind: "analysis-report",
        },
      },
      knowledgeCatalogs: [],
      knowledgeWarnings: [],
      artifactInput: {
        artifacts: [],
        fieldBindings: {},
      },
      toolRegistry: {
        tools: [{
          toolsetId: "toolset-1" as any,
          toolsetName: "工具集",
          toolId: "tool-a" as any,
          name: "工具 A",
          alias: null,
          description: "工具 A",
          runtime: "builtin",
          usageGuidance: null,
          invocationHint: null,
          code: "",
          inputSchema: "{\"type\":\"object\"}",
          outputSchema: "{\"type\":\"object\"}",
          permissions: { requiresWrite: false },
          envPolicy: null,
          required: false,
        }],
      },
    },
  };
  (prompt as any).promptEnvelope = createPromptEnvelope({
    workflow,
    nodeId: "analysis",
    nodeLabel: "分析",
    userMessage: prompt.userMessage,
    runtimePolicy: prompt.snapshots.runtimePolicy,
    artifactInput: prompt.snapshots.artifactInput,
    toolRegistry: prompt.snapshots.toolRegistry,
  });
  (prompt as any).promptEnvelope.meta.intent = "rework-upstream-node";
  (prompt as any).promptEnvelope.review = {
    feedbackPatch: "- 退回修改要求\n请基于最新测试反馈继续修正",
    latestFeedbackPatch: "- 退回修改要求\n请基于最新测试反馈继续修正",
    latestAction: "system_rework",
  };

  const result = await (engine as any).executeSubThread(
    instance,
    workflow.nodes[0],
    role,
    prompt,
    {
      engine: "codex",
      model: "gpt-5.5",
      effort: "medium",
      accessMode: "current",
      autoCompactPct: null,
      contextWindow: null,
    },
  );

  assert.equal(createdDbThreads.length, 0);
  assert.equal(renamedDbThreads.length, 1);
  assert.equal(threadPrefs.length, 1);
  assert.equal(sentInputs[0]?.text, prompt.continuationUserMessage);
  assert.doesNotMatch(String(sentInputs[0]?.text ?? ""), /<acceptance_criteria>/);
  assert.equal(promptSnapshots[0]?.threadId, existingThreadId);
  assert.equal(promptSnapshots[0]?.userMessage, prompt.continuationUserMessage);
  assert.equal(instance.nodeStates.analysis.threadId, existingThreadId);
  assert.equal(result.finalAnswer.answer.mode, "text");
  assert.equal((result.finalAnswer.answer as NodeExecutionEnvelope & { text?: string }).text, "沿用原线程继续执行");
});

test("resolveOrCreateNodeThread uses the persisted Codex binding instead of the node error projection", () => {
  const role = createRole();
  const node: WorkflowNode = {
    id: "analysis",
    type: "role",
    roleId: role.id,
    label: "分析",
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  const threadId = "thread_codex_runtime_binding_missing" as ThreadId;
  const providerThreadId = "provider_codex_persisted_binding";
  const projectedProviderThreadId = "provider_codex_stale_error_projection";
  instance.nodeStates = {
    analysis: createNodeState(node.id, "running", {
      threadId,
      providerThreadId: projectedProviderThreadId,
    }),
  };
  const runtimeThreads = new ThreadStore();
  runtimeThreads.create({
    threadId,
    workspaceId: instance.workspaceId,
    engine: "codex",
    title: "[编排] 分析",
  });
  const persistedThread = {
    id: threadId,
    workspaceId: instance.workspaceId,
    engine: "codex",
    title: "[编排] 分析",
    sessionId: providerThreadId,
    sessionCapabilities: null,
  };
  const engine = new OrchestrationEngine({
    db: {
      threads: {
        get(candidateThreadId: ThreadId) {
          return candidateThreadId === threadId ? persistedThread : null;
        },
        rename() {},
        updatePrefs() {},
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
    } as any,
    threads: runtimeThreads,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const result = (engine as any).resolveOrCreateNodeThread(instance, node, role, {
    engine: "codex",
    model: null,
    effort: null,
    accessMode: "current",
    autoCompactPct: null,
    contextWindow: null,
  });

  assert.equal(result.reused, true);
  assert.equal(result.threadId, threadId);
  assert.equal(result.thread.sessionId, providerThreadId);
  assert.equal(runtimeThreads.get(threadId)?.sessionId, providerThreadId);
  assert.equal(instance.nodeStates.analysis.providerThreadId, projectedProviderThreadId);
});

test("resolveOrCreateNodeThread leaves an empty persisted Codex binding to normal session startup", () => {
  const role = createRole();
  const node: WorkflowNode = {
    id: "analysis",
    type: "role",
    roleId: role.id,
    label: "分析",
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  const threadId = "thread_codex_without_persisted_binding" as ThreadId;
  instance.nodeStates = {
    analysis: createNodeState(node.id, "running", { threadId }),
  };
  const runtimeThreads = new ThreadStore();
  const engine = new OrchestrationEngine({
    db: {
      threads: {
        get(candidateThreadId: ThreadId) {
          if (candidateThreadId !== threadId) return null;
          return {
            id: threadId,
            workspaceId: instance.workspaceId,
            engine: "codex",
            title: "[编排] 分析",
            sessionId: null,
            sessionCapabilities: null,
          };
        },
        rename() {},
        updatePrefs() {},
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
    } as any,
    threads: runtimeThreads,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const result = (engine as any).resolveOrCreateNodeThread(instance, node, role, {
    engine: "codex",
    model: null,
    effort: null,
    accessMode: "current",
    autoCompactPct: null,
    contextWindow: null,
  });

  assert.equal(result.reused, true);
  assert.equal(result.threadId, threadId);
  assert.equal(result.thread.sessionId, null);
});

test("resolveOrCreateNodeThread does not let a provider error projection block a new thread", () => {
  const role = createRole();
  const node: WorkflowNode = {
    id: "analysis",
    type: "role",
    roleId: role.id,
    label: "分析",
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  const projectedProviderThreadId = "provider_codex_projection_without_thread";
  instance.nodeStates = {
    analysis: createNodeState(node.id, "running", {
      providerThreadId: projectedProviderThreadId,
    }),
  };
  const createdThreads: Array<Record<string, unknown>> = [];
  const runtimeThreads = new ThreadStore();
  const engine = new OrchestrationEngine({
    db: {
      threads: {
        create(input: Record<string, unknown>) {
          createdThreads.push(input);
          return input;
        },
        updatePrefs() {},
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
    } as any,
    threads: runtimeThreads,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const result = (engine as any).resolveOrCreateNodeThread(instance, node, role, {
    engine: "codex",
    model: null,
    effort: null,
    accessMode: "current",
    autoCompactPct: null,
    contextWindow: null,
  });

  assert.equal(result.reused, false);
  assert.equal(createdThreads.length, 1);
  assert.equal(instance.nodeStates.analysis.threadId, result.threadId);
  assert.equal(instance.nodeStates.analysis.providerThreadId, projectedProviderThreadId);
});

test("executeSubThread rejects the turn when the model never calls runtime.submitNodeResult", async () => {
  const role = createRole();
  const workflow: WorkflowDefinition = {
    id: "wf_exec_snapshot" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "执行测试",
    description: "执行测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "分析", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_exec_snapshot" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_exec_snapshot" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "analysis",
      title: "验证 snapshot fallback",
      goal: "验证 snapshot fallback",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      analysis: {
        nodeId: "analysis",
        status: "running",
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const threadRecords: Array<Record<string, unknown>> = [];

  const engine = new OrchestrationEngine({
    db: {
      threads: {
        create(input: Record<string, unknown>) {
          threadRecords.push(input);
          return input;
        },
        updatePrefs() {},
      },
      orchPromptSnapshots: {
        create(input: Record<string, unknown>) {
          return {
            id: "snapshot_1",
            ...input,
          } as NodePromptSnapshot;
        },
        listByNode() {
          return [];
        },
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus() {},
      },
      orchEvents: {
        append() {},
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
      },
      turns: createActiveTurnProbeStub(),
    } as any,
    threads: {
      create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string }) {
        return input;
      },
    } as any,
    sessions: {
      getOrCreate() {
        return {
          resolvePlatformToolTransport() {
            return "protocol" as const;
          },
          async sendMessage() {
            return {
              responseText: JSON.stringify(createTextFinalAnswer("API Error: 423 channels unavailable")),
            };
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
        };
      },
    } as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const prompt = {
    systemMessage: "system",
    developerMessage: "developer",
    userMessage: "user",
    renderedInputPreview: "preview",
    snapshots: {
      runtimePolicy: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: "analysis",
        nodeLabel: "分析",
        approvalMode: "auto",
        accessMode: "current",
        toolRuntimePolicy: {
          allowedToolIds: [],
          requiresWorkspaceWrite: false,
        },
        artifactPolicy: {
          persistenceMode: "db-only",
          outputMode: "text",
          primaryKind: "analysis-report",
        },
      },
      knowledgeCatalogs: [],
      knowledgeWarnings: [],
      artifactInput: {
        artifacts: [],
        fieldBindings: {},
      },
      toolRegistry: null,
    },
  };
  (prompt as any).promptEnvelope = createPromptEnvelope({
    workflow,
    nodeId: "analysis",
    nodeLabel: "分析",
    userMessage: prompt.userMessage,
    runtimePolicy: prompt.snapshots.runtimePolicy,
    artifactInput: prompt.snapshots.artifactInput,
    toolRegistry: prompt.snapshots.toolRegistry,
  });

  await assert.rejects(
    () => (engine as any).executeSubThread(
      instance,
      workflow.nodes[0],
      role,
      prompt,
      {
        engine: "claude",
        model: "claude-sonnet-4-6",
        effort: "medium",
        accessMode: "current",
      },
    ),
    /没有调用 runtime\.submitNodeResult/,
  );
  assert.equal(instance.nodeStates.analysis.threadId, threadRecords[0]?.id);
});

test("executeSubThread retries once with a runtime.submitNodeResult reminder when non-text node returns natural language only", async () => {
  const role = createRole({
    outputDefinition: {
      instructions: "输出实现报告文件",
      deliveryMode: "file",
      format: "markdown",
      resultKey: "implementation-report",
      filePathRule: "codeflow-docs/功能/demo/开发实现/implementation-report.md",
      requiredFields: [],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_exec_retry" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "执行纠偏测试",
    description: "执行纠偏测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "implementation", type: "role", roleId: role.id, label: "开发实现", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_exec_retry" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_exec_retry" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "验证非文本结果自动纠偏",
      goal: "验证非文本结果自动纠偏",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      implementation: {
        nodeId: "implementation",
        status: "running",
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const sentInputs: Array<Record<string, unknown>> = [];
  const threadRecords: Array<Record<string, unknown>> = [];
  const workspacePath = createTemporaryWorkspace(path.join(os.tmpdir(), "codeflowai-exec-retry-"));

  try {
    const engine = new OrchestrationEngine({
      db: {
        threads: {
          create(input: Record<string, unknown>) {
            threadRecords.push(input);
            return input;
          },
          updatePrefs() {},
        },
        orchPromptSnapshots: {
          create(input: Record<string, unknown>) {
            return {
              id: `snapshot_${Date.now()}`,
              ...input,
            } as NodePromptSnapshot;
          },
          listByNode() {
            return [];
          },
        },
        orchInstances: {
          updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
            instance.nodeStates = nodeStates;
          },
          updateStatus() {},
        },
        orchEvents: {
          append() {},
        },
        orchArtifacts: {
          listByInstance() {
            return [];
          },
          listByNode() {
            return [];
          },
        },
        orchArtifactFiles: {
          listByArtifact() {
            return [];
          },
        },
        turns: createActiveTurnProbeStub(),
      } as any,
      threads: {
        create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string }) {
          return input;
        },
      } as any,
    sessions: {
      getOrCreate() {
        return {
          resolvePlatformToolTransport() {
            return "native-dynamic" as const;
          },
          async sendMessage(input: Record<string, unknown>) {
            sentInputs.push(input);
            if (sentInputs.length === 1) {
              return { responseText: "代码和测试已经完成，我接下来会整理交付结果。" };
            }
            const relPath = "codeflow-docs/功能/demo/开发实现/implementation-report.md";
            const absPath = path.join(workspacePath, relPath);
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, "# 实现报告\n", "utf8");
            const submitted = createFinalAnswer({
              mode: "file",
              file: {
                key: "main",
                path: relPath,
                summary: "实现完成",
              },
              changedFiles: ["src/main.js"],
            });
            const toolInput = submitted;
            const toolResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.submitNodeResult",
              toolInput,
              accessMode: "current",
            });
            assert.equal(toolResult?.ok, true);
            return {
              responseText: "实现完成，已通过 runtime.submitNodeResult 提交。",
            };
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
          };
        },
      } as any,
      workspaces: new Map([[workflow.workspaceId, workspacePath]]),
      timeoutPolicy: {
        mode: "activity",
        startupTimeoutMs: 1_000,
        engineIdleTimeoutMs: 1_000,
      },
      emitConversation() {},
      emitRaw() {},
    });

    const prompt = {
      systemMessage: "system",
      developerMessage: "developer",
      userMessage: "请完成实现并输出文件结果。",
      renderedInputPreview: "preview",
      snapshots: {
        runtimePolicy: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          nodeId: "implementation",
          nodeLabel: "开发实现",
          approvalMode: "auto",
          accessMode: "current",
          toolRuntimePolicy: {
            allowedToolIds: [],
            requiresWorkspaceWrite: true,
          },
          artifactPolicy: {
            persistenceMode: "dual-write",
            outputMode: "file",
            primaryKind: "implementation-report",
          },
        },
        knowledgeCatalogs: [],
        knowledgeWarnings: [],
        artifactInput: {
          artifacts: [],
          fieldBindings: {},
        },
        toolRegistry: null,
      },
    };
    (prompt as any).promptEnvelope = createPromptEnvelope({
      workflow,
      nodeId: "implementation",
      nodeLabel: "开发实现",
      userMessage: prompt.userMessage,
      runtimePolicy: prompt.snapshots.runtimePolicy,
      artifactInput: prompt.snapshots.artifactInput,
      toolRegistry: prompt.snapshots.toolRegistry,
    });

    const result = await (engine as any).executeSubThread(
      instance,
      workflow.nodes[0],
      role,
      prompt,
      {
        engine: "codex",
        model: "gpt-5.5",
        effort: "medium",
        accessMode: "current",
      },
    );

    assert.equal(sentInputs.length, 2);
    assert.match(String(sentInputs[1]?.text ?? ""), /runtime\.submitNodeResult/);
    assert.match(String(sentInputs[1]?.text ?? ""), /先把正式交付文件写到工作区目标路径/);
    assert.match(String(sentInputs[1]?.text ?? ""), /不要输出 assistant 文本 JSON 协议/);
    assert.equal(result.finalAnswer.answer.mode, "file");
    assert.equal((result.finalAnswer.answer as NodeExecutionEnvelope & { file?: { path: string } }).file?.path, "codeflow-docs/功能/demo/开发实现/implementation-report.md");
    assert.equal(instance.nodeStates.implementation.threadId, threadRecords[0]?.id);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("executeSubThread does not enqueue a synthetic recovery prompt after manual interrupt", async () => {
  const role = createRole({
    outputDefinition: {
      instructions: "输出实现报告文件",
      deliveryMode: "file",
      format: "markdown",
      resultKey: "implementation-report",
      filePathRule: "codeflow-docs/功能/demo/开发实现/implementation-report.md",
      requiredFields: [],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_exec_manual_interrupt" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "手动中断不自动补交",
    description: "手动中断不自动补交",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "implementation", type: "role", roleId: role.id, label: "开发实现", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_exec_manual_interrupt" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_exec_manual_interrupt" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "验证手动中断不自动补交",
      goal: "验证手动中断不自动补交",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      implementation: createNodeState("implementation", "running"),
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const sentInputs: Array<Record<string, unknown>> = [];
  const threadRecords: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      threads: {
        create(input: Record<string, unknown>) {
          threadRecords.push(input);
          return input;
        },
        updatePrefs() {},
      },
      orchPromptSnapshots: {
        create(input: Record<string, unknown>) {
          return {
            id: `snapshot_${Date.now()}`,
            ...input,
          } as NodePromptSnapshot;
        },
        listByNode() {
          return [];
        },
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus() {},
      },
      orchEvents: {
        append() {},
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
      },
      turns: createActiveTurnProbeStub(),
    } as any,
    threads: {
      create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string }) {
        return input;
      },
    } as any,
    sessions: {
      getOrCreate() {
        return {
          resolvePlatformToolTransport() {
            return "native-dynamic" as const;
          },
          async sendMessage(input: Record<string, unknown>, emitters: any) {
            sentInputs.push(input);
            emitters.conversation({
              ts: 1,
              workspaceId: workflow.workspaceId,
              threadId: threadRecords[0]?.id ?? "thread_manual_interrupt",
              engine: "codex",
              type: "turn.error",
              payload: {
                turnId: input.turnId,
                error: "turn interrupted",
                code: MANUAL_TURN_INTERRUPT_CODE,
                terminationKind: "manual_interrupt",
              },
            });
            return { responseText: "" };
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
        };
      },
    } as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const prompt = {
    systemMessage: "system",
    developerMessage: "developer",
    userMessage: "请完成实现并输出文件结果。",
    renderedInputPreview: "preview",
    snapshots: {
      runtimePolicy: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: "implementation",
        nodeLabel: "开发实现",
        approvalMode: "auto",
        accessMode: "current",
        toolRuntimePolicy: {
          allowedToolIds: [],
          requiresWorkspaceWrite: true,
        },
        artifactPolicy: {
          persistenceMode: "dual-write",
          outputMode: "file",
          primaryKind: "implementation-report",
        },
      },
      knowledgeCatalogs: [],
      knowledgeWarnings: [],
      artifactInput: {
        artifacts: [],
        fieldBindings: {},
      },
      toolRegistry: null,
    },
  };
  (prompt as any).promptEnvelope = createPromptEnvelope({
    workflow,
    nodeId: "implementation",
    nodeLabel: "开发实现",
    userMessage: prompt.userMessage,
    runtimePolicy: prompt.snapshots.runtimePolicy,
    artifactInput: prompt.snapshots.artifactInput,
    toolRegistry: prompt.snapshots.toolRegistry,
  });

  await assert.rejects(
    () => (engine as any).executeSubThread(
      instance,
      workflow.nodes[0],
      role,
      prompt,
      {
        engine: "codex",
        model: "gpt-5.5",
        effort: "medium",
        accessMode: "current",
      },
    ),
    (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE,
  );

  assert.equal(sentInputs.length, 1);
  assert.equal(instance.nodeStates.implementation.threadId, threadRecords[0]?.id);
});

test("executeSubThread feeds artifact path validation errors back to the model instead of guessing fallback paths", async () => {
  const role = createRole({
    outputDefinition: {
      instructions: "输出实现报告文件",
      deliveryMode: "file",
      format: "markdown",
      resultKey: "implementation-report",
      filePathRule: "codeflow-docs/功能/demo/开发实现/implementation-report.md",
      requiredFields: [],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_exec_path_retry" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "路径纠偏测试",
    description: "路径纠偏测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "implementation", type: "role", roleId: role.id, label: "开发实现", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_exec_path_retry" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_exec_path_retry" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "验证工件路径纠偏",
      goal: "验证工件路径纠偏",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      implementation: {
        nodeId: "implementation",
        status: "running",
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const sentInputs: Array<Record<string, unknown>> = [];
  const threadRecords: Array<Record<string, unknown>> = [];
  const workspacePath = createTemporaryWorkspace(path.join(os.tmpdir(), "codeflowai-exec-path-retry-"));

  try {
    const runtimeEvidence = new RuntimeEvidenceService({
      db: {
        orchInstances: {
          get(instanceId: string) {
            return instanceId === instance.id ? instance : null;
          },
        },
        orchArtifacts: {
          listByInstance() {
            return [];
          },
        },
        orchFeedback: {
          listByInstance() {
            return [];
          },
        },
        orchPromptSnapshots: {
          listByInstance() {
            return [];
          },
          listByNode() {
            return [];
          },
        },
        orchEvents: {
          listByInstance() {
            return [];
          },
        },
      } as any,
      instance,
    });

    const engine = new OrchestrationEngine({
      db: {
        threads: {
          create(input: Record<string, unknown>) {
            threadRecords.push(input);
            return input;
          },
          updatePrefs() {},
        },
        orchPromptSnapshots: {
          create(input: Record<string, unknown>) {
            return {
              id: `snapshot_${Date.now()}`,
              ...input,
            } as NodePromptSnapshot;
          },
          listByNode() {
            return [];
          },
        },
        orchInstances: {
          updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
            instance.nodeStates = nodeStates;
          },
          updateStatus() {},
        },
        orchEvents: {
          append() {},
        },
        orchArtifacts: {
          listByInstance() {
            return [];
          },
          listByNode() {
            return [];
          },
        },
        orchArtifactFiles: {
          listByArtifact() {
            return [];
          },
        },
        turns: createActiveTurnProbeStub(),
      } as any,
      threads: {
        create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string }) {
          return input;
        },
      } as any,
    sessions: {
      getOrCreate() {
        return {
          resolvePlatformToolTransport() {
            return "native-dynamic" as const;
          },
          async sendMessage(input: Record<string, unknown>) {
            sentInputs.push(input);
            const wrongRelPath = "docs/other/implementation-report.md";
            const firstAttempt = createFinalAnswer({
              mode: "file",
              file: {
                key: "main",
                path: wrongRelPath,
                summary: "实现完成",
              },
              changedFiles: ["src/main.js"],
            });
            const firstToolInput = firstAttempt;
            const firstResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.submitNodeResult",
              toolInput: firstToolInput,
              accessMode: "current",
            });
            assert.equal(firstResult?.ok, false);
            assert.match(String(firstResult?.message ?? ""), /文件输出路径没有通过平台校验/);
            assert.match(String(firstResult?.message ?? ""), /docs\/other\/implementation-report\.md/);

            const relPath = "codeflow-docs/功能/demo/开发实现/implementation-report.md";
            const absPath = path.join(workspacePath, relPath);
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, "# 实现报告\n", "utf8");
            const submitted = createFinalAnswer({
              mode: "file",
              file: {
                key: "main",
                path: relPath,
                summary: "实现完成",
              },
              changedFiles: ["src/main.js"],
            });
            const toolInput = submitted;
            const toolResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.submitNodeResult",
              toolInput,
              accessMode: "current",
            });
            assert.equal(toolResult?.ok, true);
            return {
              responseText: "已改到正确路径并重新提交。",
            };
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
          };
        },
      } as any,
      workspaces: new Map([[workflow.workspaceId, workspacePath]]),
      timeoutPolicy: {
        mode: "activity",
        startupTimeoutMs: 1_000,
        engineIdleTimeoutMs: 1_000,
      },
      emitConversation() {},
      emitRaw() {},
    });

    const prompt = {
      systemMessage: "system",
      developerMessage: "developer",
      userMessage: "请完成实现并输出文件结果。",
      renderedInputPreview: "preview",
      snapshots: {
        runtimePolicy: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          nodeId: "implementation",
          nodeLabel: "开发实现",
          approvalMode: "auto",
          accessMode: "current",
          toolRuntimePolicy: {
            allowedToolIds: [],
            requiresWorkspaceWrite: true,
          },
          artifactPolicy: {
            persistenceMode: "dual-write",
            outputMode: "file",
            primaryKind: "implementation-report",
          },
        },
        knowledgeCatalogs: [],
        knowledgeWarnings: [],
        artifactInput: {
          artifacts: [],
          fieldBindings: {},
        },
        toolRegistry: null,
      },
    };
    (prompt as any).promptEnvelope = createPromptEnvelope({
      workflow,
      nodeId: "implementation",
      nodeLabel: "开发实现",
      userMessage: prompt.userMessage,
      runtimePolicy: prompt.snapshots.runtimePolicy,
      artifactInput: prompt.snapshots.artifactInput,
      toolRegistry: prompt.snapshots.toolRegistry,
    });

    const result = await (engine as any).executeSubThread(
      instance,
      workflow.nodes[0],
      role,
      prompt,
      {
        engine: "codex",
        model: "gpt-5.5",
        effort: "medium",
        accessMode: "current",
      },
      runtimeEvidence,
    );

    assert.equal(sentInputs.length, 1);
    assert.equal(result.finalAnswer.answer.mode, "file");
    assert.equal(
      (result.finalAnswer.answer as NodeExecutionEnvelope & { file?: { path: string } }).file?.path,
      "codeflow-docs/功能/demo/开发实现/implementation-report.md",
    );
    assert.equal(instance.nodeStates.implementation.threadId, threadRecords[0]?.id);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("executeSubThread serves runtime instance evidence requests before returning final output", async () => {
  const role = createRole({ name: "验证角色" });
  const workflow: WorkflowDefinition = {
    id: "wf_runtime_evidence_exec" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "运行证据测试",
    description: "运行证据测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "verification", type: "role", roleId: role.id, label: "测试验证", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_runtime_evidence_exec" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_runtime_evidence_exec" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "analysis",
      title: "验证运行证据工具循环",
      goal: "验证运行证据工具循环",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      verification: {
        nodeId: "verification",
        status: "running",
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const sentInputs: Array<Record<string, unknown>> = [];
  const conversationEvents: Array<Record<string, unknown>> = [];
  const threadRecords: Array<Record<string, unknown>> = [];

  const runtimeEvidence = new RuntimeEvidenceService({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
      },
      orchFeedback: {
        listByInstance() {
          return [];
        },
      },
      orchPromptSnapshots: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchEvents: {
        listByInstance() {
          return [];
        },
      },
    } as any,
    instance,
  });
  const [runtimeTool] = runtimeEvidence.buildBuiltinTools();

  const engine = new OrchestrationEngine({
    db: {
      threads: {
        create(input: Record<string, unknown>) {
          threadRecords.push(input);
          return input;
        },
        updatePrefs() {},
      },
      orchPromptSnapshots: {
        create(input: Record<string, unknown>) {
          return {
            id: `snapshot_${Date.now()}`,
            ...input,
          } as NodePromptSnapshot;
        },
        listByNode() {
          return [];
        },
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus() {},
      },
      orchEvents: {
        append() {},
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
      },
      turns: createActiveTurnProbeStub(),
    } as any,
    threads: {
      create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string }) {
        return input;
      },
    } as any,
    sessions: {
      getOrCreate() {
        return {
          resolvePlatformToolTransport() {
            return "native-dynamic" as const;
          },
          async sendMessage(
            input: Record<string, unknown>,
            emitters: {
              conversation: (event: Record<string, unknown>) => void;
              raw: (event: Record<string, unknown>) => void;
            },
          ) {
            sentInputs.push(input);
            emitters.conversation({
              ts: Date.now(),
              workspaceId: workflow.workspaceId,
              threadId: threadRecords[0]?.id ?? "thread-test",
              engine: "codex",
              type: "item.tool.started",
              payload: {
                itemId: "tool-runtime-evidence",
                toolCallId: "call-runtime-evidence",
                toolName: "runtime.inspectInstanceEvidence",
                input: { mode: "summary" },
              },
            });
            const evidenceResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.inspectInstanceEvidence",
              toolInput: { mode: "summary" },
              accessMode: "current",
            });
            emitters.conversation({
              ts: Date.now(),
              workspaceId: workflow.workspaceId,
              threadId: threadRecords[0]?.id ?? "thread-test",
              engine: "codex",
              type: "item.tool.completed",
              payload: {
                itemId: "tool-runtime-evidence",
                toolCallId: "call-runtime-evidence",
                toolName: "runtime.inspectInstanceEvidence",
                output: evidenceResult?.output ?? null,
                success: evidenceResult?.ok !== false,
              },
            });
            const submitted = createTextFinalAnswer("已根据实例运行证据完成验证结论。");
            const toolInput = submitted;
            const submissionResult = await (input.executeHostTool as Function)?.({
              toolId: "runtime.submitNodeResult",
              toolInput,
              accessMode: "current",
            });
            assert.equal(submissionResult?.ok, true);
            const responseText = "已根据实例运行证据完成验证结论。";
            emitters.conversation({
              ts: Date.now(),
              workspaceId: workflow.workspaceId,
              threadId: threadRecords[0]?.id ?? "thread-test",
              engine: "codex",
              type: "item.agentMessage.completed",
              payload: {
                itemId: `assistant-${sentInputs.length}`,
                engineMessageId: `assistant-${sentInputs.length}`,
                text: responseText,
                revision: 0,
              },
            });
            return { responseText };
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
        };
      },
    } as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation(event: Record<string, unknown>) {
      conversationEvents.push(event);
    },
    emitRaw() {},
  });

  const prompt = {
    systemMessage: "system",
    developerMessage: "developer",
    userMessage: "请核对实例运行证据后给出验证结论。",
    renderedInputPreview: "preview",
    snapshots: {
      runtimePolicy: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: "verification",
        nodeLabel: "测试验证",
        approvalMode: "auto",
        accessMode: "current",
        toolRuntimePolicy: {
          allowedToolIds: ["runtime.inspectInstanceEvidence"],
          requiresWorkspaceWrite: false,
        },
        artifactPolicy: {
          persistenceMode: "db-only",
          outputMode: "text",
          primaryKind: "verification-report",
        },
      },
      knowledgeCatalogs: [],
      knowledgeWarnings: [],
      artifactInput: {
        artifacts: [],
        fieldBindings: {},
      },
      toolRegistry: {
        tools: [runtimeTool],
      },
    },
  };
  (prompt as any).promptEnvelope = createPromptEnvelope({
    workflow,
    nodeId: "verification",
    nodeLabel: "测试验证",
    userMessage: prompt.userMessage,
    runtimePolicy: prompt.snapshots.runtimePolicy,
    artifactInput: prompt.snapshots.artifactInput,
    toolRegistry: prompt.snapshots.toolRegistry,
  });

  const result = await (engine as any).executeSubThread(
    instance,
    workflow.nodes[0],
    role,
    prompt,
    {
      engine: "codex",
      model: "gpt-5.5",
      effort: "medium",
      accessMode: "current",
    },
    runtimeEvidence,
  );

  assert.equal(sentInputs.length, 1);
  assert.equal(sentInputs[0]?.responseFormat, "text");
  assert.equal(result.finalAnswer.answer.mode, "text");
  assert.equal((result.finalAnswer.answer as NodeExecutionEnvelope & { text?: string }).text, "已根据实例运行证据完成验证结论。");
  assert.ok(conversationEvents.some((event) => event.type === "item.tool.started"));
  assert.ok(conversationEvents.some((event) => event.type === "item.tool.completed"));
});

test("buildToolRegistry injects managed background service builtin for writable nodes", () => {
  const role = createRole();
  const workflow: WorkflowDefinition = {
    id: "wf_tool_registry" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "工具边界测试",
    description: "工具边界测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "需求分析", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const runtimeEvidence = new RuntimeEvidenceService({
    db: {} as any,
    instance,
  });
  const { engine } = createHarness();

  const writableRegistry = (engine as any).buildToolRegistry([], runtimeEvidence, "current");
  assert.deepEqual(writableRegistry?.tools.map((tool: any) => String(tool.toolId)), [
    "runtime.submitNodeResult",
    "runtime.manageBackgroundService",
  ]);

  const readOnlyRegistry = (engine as any).buildToolRegistry([], runtimeEvidence, "read-only");
  assert.deepEqual(readOnlyRegistry?.tools.map((tool: any) => String(tool.toolId)), [
    "runtime.submitNodeResult",
  ]);

  const explicitRegistry = (engine as any).buildToolRegistry([
    {
      toolset: {
        id: "toolset-runtime" as any,
        workspaceId: workflow.workspaceId,
        name: "编排运行证据工具",
        description: "按需查看运行证据",
        tools: [],
        createdAt: 1,
        updatedAt: 1,
      },
      tool: {
        id: "runtime.inspectInstanceEvidence" as any,
        toolsetId: "toolset-runtime" as any,
        name: "查看实例运行证据",
        description: "查看当前实例的节点状态、审核记录、工件版本、事件时间线，以及指定节点的 prompt 快照。",
        runtime: "builtin",
        invocationHint: "先用 mode=summary 看全局，再按需要下钻。",
        code: "",
        inputSchema: null,
        outputSchema: null,
        timeoutMs: null,
        workingDirectory: null,
        requiresWrite: false,
        envPolicy: null,
        createdAt: 1,
        updatedAt: 1,
      },
      ref: {
        toolsetId: "toolset-runtime" as any,
        toolId: "runtime.inspectInstanceEvidence" as any,
        alias: "查看实例运行证据",
        usageGuidance: "只有核对运行链路时才调用。",
        required: false,
      },
    },
  ], runtimeEvidence, "current");

  assert.deepEqual(explicitRegistry?.tools.map((tool: any) => String(tool.toolId)), [
    "runtime.inspectInstanceEvidence",
    "runtime.submitNodeResult",
    "runtime.manageBackgroundService",
  ]);
  assert.equal(explicitRegistry?.tools[0]?.toolsetName, "编排运行证据工具");
});

test("sequential work item tools stay scoped to one node session", () => {
  const role = createRole();
  const node: WorkflowNode = {
    id: "asset-details",
    type: "role",
    roleId: role.id,
    label: "资产详情",
    position: { x: 0, y: 0 },
    workItemPolicy: { mode: "sequential" },
  };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  const runtimeEvidence = new RuntimeEvidenceService({ db: {} as any, instance });
  const { engine } = createHarness();

  const registry = (engine as any).buildToolRegistry([], runtimeEvidence, "read-only", null, node);
  assert.deepEqual(registry?.tools.map((tool: any) => String(tool.toolId)), [
    "runtime.submitNodeResult",
    "runtime.workItems.list",
    "runtime.workItems.create",
    "runtime.workItems.update",
    "runtime.workItems.delete",
    "runtime.workItems.reopenMany",
    "runtime.workItems.complete",
  ]);
  for (const tool of registry?.tools.filter((item: any) => String(item.toolId).startsWith("runtime.workItems.")) ?? []) {
    const schema = JSON.parse(tool.inputSchema);
    assert.equal(schema.properties?.threadId, undefined, `${tool.toolId} 不得允许模型为工作项指定独立会话`);
    assert.equal(schema.properties?.sessionId, undefined, `${tool.toolId} 不得允许模型为工作项指定独立会话`);
    assert.equal(schema.properties?.nodeId, undefined, `${tool.toolId} 只能绑定当前节点`);
    assert.equal(schema.properties?.instanceId, undefined, `${tool.toolId} 只能绑定当前实例`);
  }

  const plainRegistry = (engine as any).buildToolRegistry([], runtimeEvidence, "read-only", null, { ...node, workItemPolicy: null });
  assert.deepEqual(plainRegistry?.tools.map((tool: any) => String(tool.toolId)), ["runtime.submitNodeResult"]);
});

test("strict work item tools expose frozen acceptance, output verification and batch reopen contracts", () => {
  const role = createRole();
  const node: WorkflowNode = {
    id: "asset-details",
    type: "role",
    roleId: role.id,
    label: "资产详情",
    position: { x: 0, y: 0 },
    workItemPolicy: {
      mode: "sequential",
      completion: { requireEvidence: true, requireAcceptanceChecks: true, verifyOutputPath: true },
      reworkAlwaysClientKeys: ["asset:detail:finalize"],
      maxItemsPerThread: 40,
    },
  };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  const runtimeEvidence = new RuntimeEvidenceService({ db: {} as any, instance });
  const { engine } = createHarness();
  const registry = (engine as any).buildToolRegistry([], runtimeEvidence, "read-only", null, node);
  const tools = new Map<string, any>(registry.tools.map((tool: any) => [String(tool.toolId), tool]));

  assert.match(tools.get("runtime.workItems.list").description, /找不到工作项.*版本冲突.*先调用/);

  const createSchema = JSON.parse(tools.get("runtime.workItems.create").inputSchema);
  assert.deepEqual(createSchema.properties.items.items.required, [
    "clientKey",
    "title",
    "sourceKey",
    "outputPath",
    "acceptanceCriteria",
  ]);
  assert.equal(createSchema.properties.items.items.properties.acceptanceCriteria.minItems, 0);
  assert.match(tools.get("runtime.workItems.create").usageGuidance, /可为空数组.*没有额外验收项/);
  const updateSchema = JSON.parse(tools.get("runtime.workItems.update").inputSchema);
  assert.ok(updateSchema.properties.patch.properties.acceptanceCriteria);
  assert.equal(updateSchema.properties.patch.properties.acceptanceCriteria.minItems, 0);
  assert.throws(
    () => (engine as any).validateNodeWorkItemUpdatePatch(node, { sourceKey: null }),
    /不能清空稳定 sourceKey/,
  );
  assert.throws(
    () => (engine as any).validateNodeWorkItemUpdatePatch(node, { outputPath: null }),
    /不能清空 workspace 相对 outputPath/,
  );
  assert.doesNotThrow(() => (engine as any).validateNodeWorkItemUpdatePatch(
    node,
    { acceptanceCriteria: [] },
    { acceptanceCriteria: [] },
  ));
  assert.doesNotThrow(() => (engine as any).validateNodeWorkItemUpdatePatch(
    node,
    { acceptanceCriteria: [] },
    { acceptanceCriteria: [{ id: "draft", label: "启动前草案验收" }], startedAt: null },
  ));
  assert.throws(
    () => (engine as any).validateNodeWorkItemUpdatePatch(
      node,
      { acceptanceCriteria: [] },
      { acceptanceCriteria: [{ id: "frozen", label: "冻结验收" }], startedAt: 1 },
    ),
    /不能清空已有 acceptanceCriteria/,
  );
  assert.throws(
    () => (engine as any).validateNodeWorkItemUpdatePatch(node, { status: "pending" }, {
      clientKey: "asset:completed",
      status: "completed",
    }),
    /reopenMany.*稳定 sourceKey/,
  );
  const completeSchema = JSON.parse(tools.get("runtime.workItems.complete").inputSchema);
  assert.deepEqual(completeSchema.required, [
    "itemId",
    "expectedVersion",
    "resultSummary",
    "evidence",
    "outputPath",
  ]);
  assert.equal(completeSchema.properties.completionChecks.minItems, 0);
  assert.match(tools.get("runtime.workItems.complete").usageGuidance, /有验收条件时.*没有验收条件时/);
  assert.equal(JSON.parse(tools.get("runtime.workItems.complete").invocationHint).completionChecks, undefined);
  const reopenSchema = JSON.parse(tools.get("runtime.workItems.reopenMany").inputSchema);
  assert.equal(reopenSchema.properties.nodeId, undefined, "Agent 只能重开当前节点，不能越权指定其他节点");
  assert.deepEqual(reopenSchema.properties.mode.enum, ["all", "selected"]);
  const submitSchema = JSON.parse(tools.get("runtime.submitNodeResult").inputSchema);
  assert.match(submitSchema.properties.rework.properties.workItemScopes.description, /已有工作项看板时必填/);
});

test("strict work item completion accepts empty criteria and still verifies output bytes", () => {
  const testRoot = createTemporaryWorkspace(path.join(os.tmpdir(), "codeflowai-work-item-output-"));
  const workspacePath = path.join(testRoot, "workspace");
  try {
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(path.join(workspacePath, "docs"), { recursive: true });
    const outputPath = "docs/asset.md";
    let storedOutputPath = outputPath;
    const content = Buffer.from("# Asset\n\nVerified output.\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, outputPath), content);
    const role = createRole();
    const node: WorkflowNode = {
      id: "asset-details",
      type: "role",
      roleId: role.id,
      label: "资产详情",
      position: { x: 0, y: 0 },
      workItemPolicy: {
        mode: "sequential",
        completion: { requireEvidence: true, requireAcceptanceChecks: true, verifyOutputPath: true },
      },
    };
    const workflow = createWorkflow([node], []);
    const instance = createInstance(role, workflow);
    const { engine } = createHarness();
    (engine as any).ctx.workspaces.set(instance.workspaceId, workspacePath);
    let acceptanceCriteria = [{ id: "verified", label: "输出已验证" }];
    (engine as any).ctx.db.orchNodeWorkItems = {
      get() {
        return {
          id: "workitem-asset",
          instanceId: instance.id,
          nodeId: node.id,
          clientKey: "asset:one",
          title: "生成资产",
          description: null,
          sourceKey: "asset-one",
          outputPath: storedOutputPath,
          sortOrder: 1000,
          status: "in_progress",
          resultSummary: null,
          evidence: [],
          acceptanceCriteria,
          completionChecks: [],
          outputSha256: null,
          version: 2,
          startedAt: 1,
          completedAt: null,
          deletedAt: null,
          createdAt: 1,
          updatedAt: 1,
        };
      },
    };

    assert.throws(
      () => (engine as any).validateNodeWorkItemCompletion(instance, node, {
        itemId: "workitem-asset",
        evidence: [],
        completionChecks: [{ criterionId: "verified", evidence: outputPath }],
        outputPath,
      }),
      /必须提供至少一条 evidence/,
    );
    assert.throws(
      () => (engine as any).validateNodeWorkItemCompletion(instance, node, {
        itemId: "workitem-asset",
        evidence: [outputPath],
        completionChecks: [],
        outputPath,
      }),
      /必须逐项提交 completionChecks/,
    );
    assert.throws(
      () => (engine as any).validateNodeWorkItemCompletion(instance, node, {
        itemId: "workitem-asset",
        evidence: [outputPath],
        completionChecks: [{ criterionId: "verified", evidence: outputPath }],
        outputPath: "docs/other.md",
      }),
      /不能改写冻结 outputPath/,
    );
    const proof = (engine as any).validateNodeWorkItemCompletion(instance, node, {
      itemId: "workitem-asset",
      evidence: [outputPath],
      completionChecks: [{ criterionId: "verified", evidence: `${outputPath} 已回读` }],
      outputPath,
    });
    assert.deepEqual(proof, {
      outputPath,
      outputSha256: crypto.createHash("sha256").update(content).digest("hex"),
    });

    acceptanceCriteria = [];
    assert.throws(
      () => (engine as any).validateNodeWorkItemCompletion(instance, node, {
        itemId: "workitem-asset",
        evidence: [],
        completionChecks: [],
        outputPath,
      }),
      /必须提供至少一条 evidence/,
    );
    const emptyCriteriaProof = (engine as any).validateNodeWorkItemCompletion(instance, node, {
      itemId: "workitem-asset",
      evidence: [outputPath],
      completionChecks: [],
      outputPath,
    });
    assert.deepEqual(emptyCriteriaProof, proof);

    const gb18030OutputPath = "docs/gb18030.md";
    fs.writeFileSync(path.join(workspacePath, gb18030OutputPath), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    storedOutputPath = gb18030OutputPath;
    assert.throws(
      () => (engine as any).validateNodeWorkItemCompletion(instance, node, {
        itemId: "workitem-asset",
        evidence: [storedOutputPath],
        completionChecks: [],
        outputPath: storedOutputPath,
      }),
      /必须使用 UTF-8/,
    );

    const outsideDir = path.join(testRoot, "outside");
    const outsideFile = path.join(outsideDir, "asset.md");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, content);
    storedOutputPath = path.relative(workspacePath, outsideFile);
    assert.throws(
      () => (engine as any).validateNodeWorkItemCompletion(instance, node, {
        itemId: "workitem-asset",
        evidence: [storedOutputPath],
        completionChecks: [],
        outputPath: storedOutputPath,
      }),
      /outputPath 越出工作区/,
    );

    const linkedDir = path.join(workspacePath, "linked-output");
    fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    storedOutputPath = path.join("linked-output", "asset.md");
    assert.throws(
      () => (engine as any).validateNodeWorkItemCompletion(instance, node, {
        itemId: "workitem-asset",
        evidence: [storedOutputPath],
        completionChecks: [],
        outputPath: storedOutputPath,
      }),
      /outputPath 通过链接越出工作区/,
    );

    if (process.platform !== "win32") {
      const caseSiblingDir = path.join(testRoot, "WORKSPACE");
      const caseSiblingFile = path.join(caseSiblingDir, "asset.md");
      fs.mkdirSync(caseSiblingDir, { recursive: true });
      fs.writeFileSync(caseSiblingFile, content);
      storedOutputPath = path.relative(workspacePath, caseSiblingFile);
      assert.throws(
        () => (engine as any).validateNodeWorkItemCompletion(instance, node, {
          itemId: "workitem-asset",
          evidence: [storedOutputPath],
          completionChecks: [],
          outputPath: storedOutputPath,
        }),
        /outputPath 越出工作区/,
      );
    }
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("strict work item host tools create, start and complete an empty-criteria item", async () => {
  const testRoot = createTemporaryWorkspace(path.join(os.tmpdir(), "codeflowai-work-item-host-"));
  const workspacePath = path.join(testRoot, "workspace");
  const db = openSqliteDb(path.join(testRoot, "client.db"));
  try {
    migrateClientDb(db);
    fs.mkdirSync(path.join(workspacePath, "docs"), { recursive: true });
    const outputPath = "docs/empty-criteria.md";
    const outputBytes = Buffer.from("# Empty criteria asset\n\nVerified from frozen evidence.\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, outputPath), outputBytes);

    const role = createRole();
    const node: WorkflowNode = {
      id: "asset-details",
      type: "role",
      roleId: role.id,
      label: "资产详情",
      position: { x: 0, y: 0 },
      workItemPolicy: {
        mode: "sequential",
        completion: { requireEvidence: true, requireAcceptanceChecks: true, verifyOutputPath: true },
      },
    };
    const workflow = createWorkflow([node], []);
    const instance = createInstance(role, workflow);
    instance.status = "running";
    instance.nodeStates = {
      [node.id]: createNodeState(node.id, "running"),
    };
    db.prepare(`
      INSERT INTO workspaces (id, title, path, is_deleted, created_at, updated_at)
      VALUES (?, 'Host work item test', ?, 0, 1, 1)
    `).run(String(instance.workspaceId), workspacePath);
    db.prepare(`
      INSERT INTO orch_instances (
        id, workspace_id, workflow_id, workflow_snapshot_json, proposal_id, intake_snapshot_json,
        role_snapshots_json, toolset_snapshots_json, runtime_config_json, artifact_index_json,
        master_thread_id, status, node_states_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', NULL, '{}', NULL, 'running', ?, 1, 1)
    `).run(
      String(instance.id),
      String(instance.workspaceId),
      String(instance.workflowId),
      JSON.stringify(instance.workflowSnapshot),
      JSON.stringify(instance.intakeSnapshot),
      JSON.stringify(instance.nodeStates),
    );

    const workItems = new OrchNodeWorkItemRepo(db);
    const { engine } = createHarness();
    (engine as any).ctx.workspaces.set(instance.workspaceId, workspacePath);
    (engine as any).ctx.db.orchNodeWorkItems = workItems;
    (engine as any).ctx.db.orchInstances = {
      get(id: string) {
        return id === instance.id ? instance : null;
      },
      updateNodeStates(_id: string, nodeStates: Record<string, NodeExecutionState>) {
        instance.nodeStates = nodeStates;
      },
      updateStatus(_id: string, status: OrchestrationInstance["status"]) {
        instance.status = status;
      },
      updateArtifactIndex() {},
    };

    const created = await (engine as any).executeNodeWorkItemTool(
      instance,
      node,
      "attempt-empty-criteria",
      "runtime.workItems.create",
      {
        items: [{
          clientKey: "asset:empty-criteria",
          title: "完成无额外验收项的资产详情",
          sourceKey: "empty-criteria-source",
          outputPath,
          acceptanceCriteria: [],
        }],
      },
    );
    assert.equal(created.ok, true);
    assert.equal(created.code, undefined);
    assert.equal(created.output.createdOrMatchedCount, 1);
    const emptyCriteriaItem = workItems.getNext(instance.id, node.id)!;
    assert.deepEqual(emptyCriteriaItem.acceptanceCriteria, []);

    const recoveryOutput = {
      retryable: true,
      recoveryAction: "runtime.workItems.list",
      recoveryInput: { statuses: ["pending", "in_progress"], limit: 100 },
    };
    const missing = await (engine as any).executeNodeWorkItemTool(
      instance,
      node,
      "attempt-empty-criteria",
      "runtime.workItems.update",
      {
        itemId: "missing-item",
        expectedVersion: 1,
        patch: { status: "in_progress" },
      },
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "WORK_ITEM_NOT_FOUND");
    assert.deepEqual(missing.output, recoveryOutput);

    const stale = await (engine as any).executeNodeWorkItemTool(
      instance,
      node,
      "attempt-empty-criteria",
      "runtime.workItems.update",
      {
        itemId: emptyCriteriaItem.id,
        expectedVersion: emptyCriteriaItem.version + 1,
        patch: { status: "in_progress" },
      },
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "WORK_ITEM_VERSION_CONFLICT");
    assert.deepEqual(stale.output, recoveryOutput);
    assert.equal(workItems.get(instance.id, node.id, emptyCriteriaItem.id)?.version, emptyCriteriaItem.version);

    const refreshed = await (engine as any).executeNodeWorkItemTool(
      instance,
      node,
      "attempt-empty-criteria",
      "runtime.workItems.list",
      recoveryOutput.recoveryInput,
    );
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.output.items[0]?.id, emptyCriteriaItem.id);
    assert.equal(refreshed.output.items[0]?.version, emptyCriteriaItem.version);

    const started = await (engine as any).executeNodeWorkItemTool(
      instance,
      node,
      "attempt-empty-criteria",
      "runtime.workItems.update",
      {
        itemId: emptyCriteriaItem.id,
        expectedVersion: emptyCriteriaItem.version,
        patch: { status: "in_progress", acceptanceCriteria: [] },
      },
    );
    assert.equal(started.ok, true);
    assert.equal(started.code, undefined);
    assert.equal(workItems.get(instance.id, node.id, emptyCriteriaItem.id)?.status, "in_progress");

    const completed = await (engine as any).executeNodeWorkItemTool(
      instance,
      node,
      "attempt-empty-criteria",
      "runtime.workItems.complete",
      {
        itemId: emptyCriteriaItem.id,
        expectedVersion: 2,
        resultSummary: "无额外验收项的资产详情已生成并核对",
        evidence: [outputPath],
        outputPath,
      },
    );
    assert.equal(completed.ok, true);
    assert.equal(completed.code, undefined);
    const stored = workItems.get(instance.id, node.id, emptyCriteriaItem.id)!;
    assert.equal(stored.status, "completed");
    assert.deepEqual(stored.acceptanceCriteria, []);
    assert.deepEqual(stored.completionChecks, []);
    assert.equal(stored.outputSha256, crypto.createHash("sha256").update(outputBytes).digest("hex"));
  } finally {
    db.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("executeSubThread switches only the underlying thread at the configured work item boundary", async (t) => {
  // 同一毫秒内换段也必须生成不同的线程 ID，不能依赖计时器精度维持唯一性。
  t.mock.method(Date, "now", () => 1_788_950_000_000);
  const role = createRole();
  const node: WorkflowNode = {
    id: "asset-details",
    type: "role",
    roleId: role.id,
    label: "资产详情",
    position: { x: 0, y: 0 },
    workItemPolicy: { mode: "sequential", maxItemsPerThread: 1 },
  };
  const workflow = createWorkflow([node], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_work_item_checkpoint" as any,
    status: "running",
    nodeStates: {
      [node.id]: createNodeState(node.id, "running"),
    },
  };
  const threadRecords: Array<Record<string, any>> = [];
  const orchestrationEvents: Array<Record<string, any>> = [];
  let sendCount = 0;
  let summary = {
    total: 2,
    pending: 2,
    inProgress: 0,
    completed: 0,
    deleted: 0,
    progressPercent: 0,
    boardVersion: 1,
    updatedAt: 1,
  };
  const engine = new OrchestrationEngine({
    db: {
      threads: {
        create(input: Record<string, any>) {
          threadRecords.push(input);
          return input;
        },
        updatePrefs() {},
      },
      orchPromptSnapshots: {
        create(input: Record<string, any>) {
          return { id: `snapshot-${sendCount + 1}`, ...input };
        },
        listByNode() {
          return [];
        },
      },
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus() {},
      },
      orchEvents: {
        append(event: Record<string, any>) {
          orchestrationEvents.push(event);
          return event;
        },
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
      },
      turns: createActiveTurnProbeStub(),
    } as any,
    threads: {
      create(input: Record<string, any>) {
        return input;
      },
    } as any,
    sessions: {
      getOrCreate() {
        return {
          resolvePlatformToolTransport() {
            return "native-dynamic" as const;
          },
          async sendMessage(input: Record<string, any>) {
            sendCount += 1;
            const completed = await input.executeHostTool({
              toolId: "runtime.workItems.complete",
              toolInput: {},
              accessMode: "current",
            });
            assert.equal(completed.ok, true);
            if (sendCount === 1) {
              assert.equal(completed.output.contextCheckpointRequired, true);
              const blocked = await input.executeHostTool({
                toolId: "runtime.workItems.update",
                toolInput: {},
                accessMode: "current",
              });
              assert.equal(blocked.ok, false);
              assert.equal(blocked.code, "WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED");
              throw Object.assign(new Error(blocked.message), { code: blocked.code });
            }
            assert.equal(completed.output.contextCheckpointRequired, undefined);
            const submitted = createTextFinalAnswer("全部工作项已完成");
            const submitResult = await input.executeHostTool({
              toolId: "runtime.submitNodeResult",
              toolInput: submitted,
              accessMode: "current",
            });
            assert.equal(submitResult.ok, true);
            return { responseText: "全部工作项已完成" };
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
        };
      },
    } as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).ctx.db.orchNodeWorkItems = {
    getSummary() {
      return summary;
    },
    getNext() {
      if (summary.completed >= summary.total) return null;
      return {
        id: `workitem-${summary.completed + 1}`,
        clientKey: `asset:${summary.completed + 1}`,
        sourceKey: `asset-${summary.completed + 1}`,
        outputPath: `docs/${summary.completed + 1}.md`,
        acceptanceCriteria: [],
        status: "pending",
        version: 1,
      };
    },
  };
  (engine as any).executeNodeWorkItemTool = async (
    _instance: OrchestrationInstance,
    _node: WorkflowNode,
    _attemptId: string,
    toolId: string,
  ) => {
    assert.equal(toolId, "runtime.workItems.complete");
    const completed = summary.completed + 1;
    summary = {
      ...summary,
      pending: summary.total - completed,
      completed,
      progressPercent: Math.round((completed / summary.total) * 100),
      boardVersion: summary.boardVersion + 1,
      updatedAt: summary.updatedAt + 1,
    };
    return { ok: true, output: { summary } };
  };
  const runtimeEvidence = new RuntimeEvidenceService({ db: {} as any, instance });
  const toolRegistry = (engine as any).buildToolRegistry([], runtimeEvidence, "current", null, node);
  const runtimePolicy = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    nodeId: node.id,
    nodeLabel: node.label,
    approvalMode: "auto",
    accessMode: "current",
    toolRuntimePolicy: {
      allowedToolIds: toolRegistry.tools.map((tool: any) => String(tool.toolId)),
      requiresWorkspaceWrite: false,
    },
    artifactPolicy: {
      persistenceMode: "db-only",
      outputMode: "text",
      primaryKind: "asset-details",
    },
  };
  const prompt = {
    systemMessage: "system",
    developerMessage: "developer",
    userMessage: "user",
    renderedInputPreview: "preview",
    promptEnvelope: createPromptEnvelope({
      workflow,
      nodeId: node.id,
      nodeLabel: node.label,
      userMessage: "user",
      runtimePolicy,
      toolRegistry,
    }),
    snapshots: {
      runtimePolicy,
      knowledgeCatalogs: [],
      knowledgeWarnings: [],
      artifactInput: { artifacts: [], fieldBindings: {} },
      toolRegistry,
    },
  };

  const result = await (engine as any).executeSubThread(
    instance,
    node,
    role,
    prompt,
    {
      engine: "claude",
      model: "claude-sonnet-4-6",
      effort: "medium",
      accessMode: "current",
      autoCompactPct: null,
      contextWindow: null,
    },
    runtimeEvidence,
  );

  assert.equal(sendCount, 2);
  assert.equal(threadRecords.length, 2);
  assert.notEqual(threadRecords[0]?.id, threadRecords[1]?.id);
  assert.deepEqual(instance.nodeStates[node.id]?.previousThreadIds, [threadRecords[0]?.id]);
  assert.equal(instance.nodeStates[node.id]?.threadId, threadRecords[1]?.id);
  assert.equal(result.finalAnswer.control.nextAction, "continue");
  const attempt = (engine as any).ctx.db.orchNodeAttempts.getLatestByNode(instance.id, node.id);
  assert.equal(attempt?.attemptNo, 1, "上下文换段必须复用同一个节点 Attempt");
  assert.equal(attempt?.threadId, threadRecords[1]?.id);
  assert.ok(orchestrationEvents.some((event) => event.type === "orchestration.nodeWorkItemContextCheckpoint"));
});

test("sequential work item nodes block continue and rework until the same board is complete", () => {
  const role = createRole();
  const node: WorkflowNode = {
    id: "asset-details",
    type: "role",
    roleId: role.id,
    label: "资产详情",
    position: { x: 0, y: 0 },
    workItemPolicy: { mode: "sequential" },
  };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  const { engine } = createHarness();
  let summary = {
    total: 2,
    pending: 1,
    inProgress: 1,
    completed: 0,
    deleted: 0,
    progressPercent: 0,
    boardVersion: 3,
    updatedAt: 1,
  };
  (engine as any).ctx.db.orchNodeWorkItems = {
    getSummary(instanceId: string, nodeId: string) {
      assert.equal(instanceId, instance.id);
      assert.equal(nodeId, node.id);
      return summary;
    },
    getNext() {
      return { id: "workitem-1", clientKey: "asset:a", status: "in_progress", version: 2 };
    },
  };

  const prompt = (engine as any).appendNodeWorkItemPromptContext(instance, node, "生成资产详情");
  assert.match(prompt, /同一 Agent 会话维护工作项，禁止为工作项新建独立会话/);
  assert.match(prompt, /首个未完成项 id=workitem-1/);
  assert.match(prompt, /不得调用 runtime\.submitNodeResult 提交 continue 或 rework/);

  const continueResult = createTextFinalAnswer("完成");
  const reworkResult = createTextFinalAnswer("需要驳回", { control: { nextAction: "rework" } });
  const askHumanResult = createTextFinalAnswer("需要确认", { control: { nextAction: "ask_human" } });
  const stopResult = createTextFinalAnswer("异常终止", { control: { nextAction: "stop" } });

  summary = { ...summary, total: 0, pending: 0, inProgress: 0, boardVersion: 4 };
  assert.throws(
    () => (engine as any).validateNodeWorkItemSubmission(instance, node, continueResult),
    /尚未创建任何工作项/,
  );
  assert.throws(
    () => (engine as any).validateNodeWorkItemSubmission(instance, node, reworkResult),
    /尚未创建任何工作项/,
  );
  assert.doesNotThrow(() => (engine as any).validateNodeWorkItemSubmission(instance, node, askHumanResult));
  assert.doesNotThrow(() => (engine as any).validateNodeWorkItemSubmission(instance, node, stopResult));

  summary = { ...summary, total: 2, pending: 1, inProgress: 1, completed: 0, boardVersion: 5 };
  assert.throws(
    () => (engine as any).validateNodeWorkItemSubmission(instance, node, continueResult),
    /仍有未完成工作项/,
  );
  assert.throws(
    () => (engine as any).validateNodeWorkItemSubmission(instance, node, reworkResult),
    /仍有未完成工作项/,
  );

  summary = { ...summary, pending: 0, inProgress: 0, completed: 2, progressPercent: 100, boardVersion: 6 };
  assert.doesNotThrow(() => (engine as any).validateNodeWorkItemSubmission(instance, node, continueResult));
  assert.doesNotThrow(() => (engine as any).validateNodeWorkItemSubmission(instance, node, reworkResult));
});

test("deterministic internal ask_human submissions are routed back to the current Agent", () => {
  const { engine } = createHarness();
  const internal = createTextFinalAnswer("acceptanceCriteria 为空，Host 拒绝 runtime.workItems.complete（WORK_ITEM_TOOL_FAILED）", {
    control: { nextAction: "ask_human" },
    review: { verdict: "partial", summary: "acceptanceCriteria 为空，无法完成工作项" },
    humanInput: {
      summary: "acceptanceCriteria 为空，Host 拒绝 runtime.workItems.complete（WORK_ITEM_TOOL_FAILED）",
      fields: null,
    },
  });
  const business = createTextFinalAnswer("请补充部署环境与目标端口", {
    control: { nextAction: "ask_human" },
    review: { verdict: "partial", summary: "还缺少部署环境" },
    humanInput: {
      summary: "请补充部署环境与目标端口",
      fields: null,
    },
  });

  assert.equal((engine as any).isAutoRecoverableNodeHumanInput(internal), true);
  const stopped = createTextFinalAnswer("请联系系统管理员或开发人员，由他们在后台修复", {
    control: { nextAction: "stop" },
    review: { verdict: "partial", summary: "系统处理失败" },
  });
  assert.equal((engine as any).isAutoRecoverableNodeHumanInput(stopped), true);
  assert.equal((engine as any).isAutoRecoverableNodeHumanInput(business), false);
  const recovery = (engine as any).buildAutoRecoveryNodeSubmissionResult();
  assert.equal(recovery.ok, false);
  assert.equal(recovery.code, "ORCHESTRATION_AUTO_RECOVERY_REQUIRED");
  assert.match(recovery.message, /当前节点读取最新状态/);
});

test("buildToolRegistry exposes current output file contract in submit node result tool", () => {
  const role = createRole({
    outputDefinition: {
      instructions: "",
      deliveryMode: "file-set",
      format: "markdown",
      resultKey: "ui-delivery",
      filePathRule: null,
      files: [
        {
          key: "ui",
          name: "UI 主文档",
          format: "markdown",
          allowedExtensions: [".md", ".markdown"],
          pathRule: "codeflow-docs/ui.md",
          description: null,
          required: true,
        },
        {
          key: "prototype-style",
          name: "原型设计风格配置",
          format: "yaml",
          allowedExtensions: [".yaml", ".yml"],
          pathRule: "codeflow-docs/prototype-style.yaml",
          description: null,
          required: false,
        },
      ],
      requiredFields: [
        {
          key: "verificationSummary",
          label: "验证摘要",
          valueType: "text",
          required: true,
          description: null,
          example: null,
        },
      ],
    },
  });
  const workflow = createWorkflow([
    { id: "ui", type: "role", roleId: role.id, label: "UI", position: { x: 0, y: 0 }, outputArtifactMode: "file-set" },
  ]);
  const instance = createInstance(role, workflow);
  const runtimeEvidence = new RuntimeEvidenceService({
    db: {} as any,
    instance,
  });
  const { engine } = createHarness();

  const registry = (engine as any).buildToolRegistry([], runtimeEvidence, "read-only", {
    outputMode: "file-set",
    outputDefinition: role.outputDefinition,
  });
  const submitTool = registry?.tools.find((tool: any) => String(tool.toolId) === "runtime.submitNodeResult");
  assert.ok(submitTool);
  assert.match(submitTool.description, /当前节点 outputMode=file-set/);
  assert.match(submitTool.description, /ui（UI 主文档，格式 markdown，必填/);
  assert.match(submitTool.description, /prototype-style（原型设计风格配置，格式 yaml，可选/);
  assert.match(submitTool.description, /ask_human\/rework\/stop 可使用 answer\.mode="text"/);
  assert.match(submitTool.usageGuidance, /answer\.files\[\]\.key 必须唯一/);
  assert.match(submitTool.usageGuidance, /非 continue 决策可用 answer\.mode="text"/);
  assert.match(submitTool.usageGuidance, /真实文件必须放 answer\.attachments/);
  assert.match(submitTool.usageGuidance, /不要只在正文里写路径/);

  const schema = JSON.parse(submitTool.inputSchema);
  assert.match(schema.properties.answer.properties.mode.description, /ask_human\/rework\/stop 可使用 text/);
  assert.match(schema.properties.answer.properties.files.description, /每个 key 最多一次/);
  assert.match(schema.properties.answer.properties.files.description, /continue 提交/);
  assert.match(schema.properties.answer.properties.files.items.properties.key.description, /ui, prototype-style/);
  assert.match(schema.properties.answer.properties.attachments.description, /不能只在正文写路径/);

  const example = JSON.parse(submitTool.invocationHint);
  assert.equal(example.answer.mode, "file-set");
  assert.deepEqual(example.answer.files.map((file: any) => file.key), ["ui"]);
  assert.deepEqual(example.answer.attachments, []);
  assert.equal(example.answer.fields.verificationSummary, "简要说明");
  assert.equal(example.acceptanceChecks[0].criterionId, undefined);
});

test("normalizeNodeResultSubmission rejects legacy kind field", () => {
  const { engine } = createHarness();
  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission({
      kind: "legacy-node-result",
      ...createTextFinalAnswer("这是旧协议字段"),
    }, "text"),
    /不应再包含 kind/,
  );
});

test("normalizeNodeResultSubmission accepts text result for text-mode nodes", () => {
  const { engine } = createHarness();
  const parsed = (engine as any).normalizeNodeResultSubmission(
    createTextFinalAnswer("### 下一步\n\n继续复验。"),
    "text",
  );
  assert.equal(parsed.answer.mode, "text");
  assert.match((parsed.answer as NodeExecutionEnvelope & { text?: string }).text ?? "", /继续复验/);
});

test("normalizeNodeResultSubmission accepts structured result for structured-mode nodes", () => {
  const { engine } = createHarness();
  const parsed = (engine as any).normalizeNodeResultSubmission(
    createFinalAnswer({
      mode: "structured",
      data: {
        sections: ["需求", "方案", "验证"],
        approved: false,
      },
      summary: "结构化结果",
      changedFiles: ["docs/plan.md"],
    }),
    "structured",
  );
  assert.equal(parsed.answer.mode, "structured");
  assert.deepEqual((parsed.answer as NodeExecutionEnvelope & { data?: unknown }).data, {
    sections: ["需求", "方案", "验证"],
    approved: false,
  });
  assert.equal((parsed.answer as NodeExecutionEnvelope & { summary?: string }).summary, "结构化结果");
});

test("normalizeNodeResultSubmission accepts file-set result for file-set nodes", () => {
  const { engine } = createHarness();
  const parsed = (engine as any).normalizeNodeResultSubmission(
    createFinalAnswer({
      mode: "file-set",
      files: [
        { key: "analysis-doc", path: "docs/analysis.md", summary: "分析文档" },
        { key: "verification-doc", path: "docs/verification.md", summary: "验证文档" },
      ],
      fields: {
        verificationSummary: "已检查上下游约束。",
      },
      changedFiles: ["docs/analysis.md", "docs/verification.md"],
    }),
    "file-set",
  );
  assert.equal(parsed.answer.mode, "file-set");
  assert.deepEqual((parsed.answer as NodeExecutionEnvelope & { files?: Array<{ path: string }> }).files?.map((file) => file.path), [
    "docs/analysis.md",
    "docs/verification.md",
  ]);
  assert.deepEqual((parsed.answer as NodeExecutionEnvelope & { changedFiles?: string[] }).changedFiles, [
    "docs/analysis.md",
    "docs/verification.md",
  ]);
  assert.deepEqual((parsed.answer as NodeExecutionEnvelope & { files?: Array<{ key?: string | null }> }).files?.map((file) => file.key), [
    "analysis-doc",
    "verification-doc",
  ]);
  assert.deepEqual((parsed.answer as NodeExecutionEnvelope & { fields?: Record<string, unknown> | null }).fields, {
    verificationSummary: "已检查上下游约束。",
  });
});

test("normalizeNodeResultSubmission rejects final output when mode does not match node contract", () => {
  const { engine } = createHarness();

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission(
      createFinalAnswer({
        mode: "file",
        file: { path: "result.md", content: "hello" },
      }),
      "structured",
    ),
    /模型输出模式与节点要求不一致/,
  );
});

test("normalizeNodeResultSubmission rejects malformed file and file-set payloads", () => {
  const { engine } = createHarness();

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission(
      createFinalAnswer({
        mode: "file",
      } as NodeExecutionEnvelope),
      "file",
    ),
    /模型输出缺少 file 对象/,
  );

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission(
      createFinalAnswer({
        mode: "file-set",
        files: [],
      } as NodeExecutionEnvelope),
      "file-set",
    ),
    /模型输出缺少 files 数组/,
  );
});

test("normalizeNodeResultSubmission allows decision actions without complete file output", () => {
  const { engine } = createHarness();

  const parsed = (engine as any).normalizeNodeResultSubmission(
    createTextFinalAnswer("需要用户补充部署目录", {
      control: { nextAction: "ask_human" },
      review: { verdict: "partial", summary: "缺少部署目录" },
      humanInput: {
        summary: "请补充部署目录",
        fields: [
          {
            key: "deployPath",
            label: "部署目录",
            valueType: "file-path",
            required: true,
            description: null,
          },
        ],
      },
    }),
    "file",
  );

  assert.equal(parsed.answer.mode, "text");
  assert.equal((parsed.answer as NodeExecutionEnvelope & { text?: string }).text, "需要用户补充部署目录");
  assert.equal(parsed.control.nextAction, "ask_human");
});

test("normalizeNodeResultSubmission still requires complete file output for continue", () => {
  const { engine } = createHarness();

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission(
      createFinalAnswer({
        mode: "file",
      } as NodeExecutionEnvelope),
      "file",
    ),
    /模型输出缺少 file 对象/,
  );
});

test("normalizeNodeResultSubmission rejects inline file content for file and file-set outputs", () => {
  const { engine } = createHarness();

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission(
      createFinalAnswer({
        mode: "file",
        file: { path: "result.md", content: "hello" },
      }),
      "file",
    ),
    /不能在节点结果工具入参内联文件正文/,
  );

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission(
      createFinalAnswer({
        mode: "file-set",
        files: [{ path: "docs/a.md", content: "# a" }],
      }),
      "file-set",
    ),
    /不能在节点结果工具入参内联文件正文/,
  );
});

test("normalizeNodeResultSubmission rejects node result objects that omit control or review", () => {
  const { engine } = createHarness();

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission({
        answer: {
          mode: "text",
          text: "只有正文，没有控制字段",
        },
      }, "text"),
    /节点结果\.control 缺失或格式错误[\s\S]*runtime\.submitNodeResult 示例[\s\S]*"nextAction":"continue"/,
  );

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission(
      createTextFinalAnswer("等待用户补充", {
        control: { nextAction: "ask_human" },
        review: { verdict: "partial" },
        humanInput: {} as any,
      }),
      "text",
    ),
    /节点结果\.humanInput\.summary 不能为空[\s\S]*runtime\.submitNodeResult 示例[\s\S]*"nextAction":"ask_human"/,
  );

  assert.throws(
    () => (engine as any).normalizeNodeResultSubmission(
      createTextFinalAnswer("验收记录", {
        acceptanceChecks: ["不是对象"] as any,
      }),
      "text",
    ),
    /节点结果\.acceptanceChecks\[0\] 必须是对象[\s\S]*runtime\.submitNodeResult 示例[\s\S]*"acceptanceChecks"/,
  );
});

test("validateFinalAnswerSemantics binds acceptance criterion metadata and rejects blocking failures that still continue", () => {
  const role = createRole();
  const workflow: WorkflowDefinition = {
    id: "wf_acceptance_semantics" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "验收语义测试",
    description: "验收语义测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "需求分析", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const criteria: TaskAcceptanceCriterion[] = [
    { id: "ac_1", text: "必须给出验证证据", blocking: true },
  ];
  instance.intakeSnapshot.acceptanceCriteria = criteria;
  const { engine } = createHarness();

  const validAnswer = createTextFinalAnswer("分析完成", {
    acceptanceChecks: [
      {
        criterionId: "ac_1",
        label: "占位标签",
        verdict: "pass",
        blocking: false,
        evidence: "已引用真实验证证据",
      },
    ],
  });
  (engine as any).validateFinalAnswerSemantics(instance, workflow.nodes[0], role, validAnswer);
  assert.equal(validAnswer.acceptanceChecks?.[0]?.label, "必须给出验证证据");
  assert.equal(validAnswer.acceptanceChecks?.[0]?.blocking, true);

  const invalidAnswer = createTextFinalAnswer("分析完成", {
    control: { nextAction: "continue" },
    review: { verdict: "partial", summary: "还有阻断问题未解决" },
    acceptanceChecks: [
      {
        criterionId: "ac_1",
        label: "占位标签",
        verdict: "fail",
        blocking: false,
        evidence: "证据缺失",
      },
    ],
  });
  assert.throws(
    () => (engine as any).validateFinalAnswerSemantics(instance, workflow.nodes[0], role, invalidAnswer),
    /存在阻断性验收未通过项，control\.nextAction 不能是 continue/,
  );
});

test("validateFinalAnswerSemantics rejects rework targets outside the allowed upstream nodes", () => {
  const role = createRole({ name: "测试验证" });
  const workflow: WorkflowDefinition = {
    id: "wf_rework_semantics" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "返工语义测试",
    description: "返工语义测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "需求分析", position: { x: 0, y: 0 } },
      { id: "implementation", type: "role", roleId: role.id, label: "开发实现", position: { x: 180, y: 0 } },
      {
        id: "verification",
        type: "role",
        roleId: role.id,
        label: "测试验证",
        position: { x: 360, y: 0 },
        reworkPolicy: {
          allowedTargetNodeIds: ["implementation"],
        },
      },
    ],
    edges: [
      { id: "e-a-i", sourceNodeId: "analysis", targetNodeId: "implementation", dataMappings: [] },
      { id: "e-i-v", sourceNodeId: "implementation", targetNodeId: "verification", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    nodeStates: {
      analysis: createNodeState("analysis"),
      implementation: createNodeState("implementation"),
      verification: createNodeState("verification"),
    },
  };
  const { engine } = createHarness();
  const invalidRework = createTextFinalAnswer("请退回修改", {
    control: { nextAction: "rework" },
    review: { verdict: "fail", summary: "需要上游重做" },
    rework: {
      targetNodeId: "analysis",
      reason: "需求分析存在遗漏",
    },
  });

  assert.throws(
    () => (engine as any).validateFinalAnswerSemantics(instance, workflow.nodes[2], role, invalidRework),
    /不允许退回到 analysis/,
  );
});

test("validateFinalAnswerSemantics requires structured humanInput when nextAction is ask_human", () => {
  const role = createRole();
  const workflow: WorkflowDefinition = {
    id: "wf_human_input_semantics" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "人工补充语义测试",
    description: "人工补充语义测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "需求分析", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const { engine } = createHarness();

  assert.throws(
    () => (engine as any).validateFinalAnswerSemantics(
      instance,
      workflow.nodes[0],
      role,
      createTextFinalAnswer("信息不足", {
        control: { nextAction: "ask_human" },
        review: { verdict: "partial", summary: "需要用户补充目录路径" },
      }),
    ),
    /必须填写节点结果\.humanInput\.summary/,
  );
});

test("validateFinalAnswerSemantics rejects UI standalone-only delivery when integrated prototype baseline already exists", () => {
  const role = createRole({
    id: "role.ui" as any,
    name: "UI/UX设计师（UI）",
    description: "负责把需求与业务规则转成可评审、可预览的页面原型、交互流程和截图资产。",
    responsibility: "把上游约束转成页面结构、关键交互和原型资产。",
    outputDefinition: {
      instructions: "",
      deliveryMode: "file-set",
      format: "markdown",
      resultKey: "ui-spec",
      filePathRule: null,
      requiredFields: [],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_ui_integrated_mode_required" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "UI 集成原型模式",
    description: "UI 集成原型模式",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "ui", type: "role", roleId: role.id, label: "原型设计", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const workspacePath = createTemporaryWorkspace(path.join(os.tmpdir(), "orch-ui-integrated-required-"));
  const workflowDocsRoot = "docs/workflow";
  fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "codeflowai", "codeflowai.json"),
    JSON.stringify({ paths: { workflowDocsRoot } }, null, 2),
    "utf8",
  );
  fs.mkdirSync(path.join(workspacePath, "apps/web/src/prototypes/init"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "apps/web/src/prototypes/init/index.vue"), "<template />", "utf8");

  const { engine } = createHarness();
  (engine as any).ctx.workspaces.set(workflow.workspaceId, workspacePath);

  const standaloneOnlyAnswer = createFinalAnswer({
    mode: "file-set",
    files: [
      { path: "docs/workflow/统一报送/原型设计/UI-统一报送-20260414.md" },
      { path: "docs/workflow/统一报送/原型设计/UI-统一报送-20260414/index.html" },
      { path: "docs/workflow/统一报送/原型设计/UI-统一报送-20260414/screenshots/01-overview.png" },
    ],
  });

  assert.throws(
    () => (engine as any).validateFinalAnswerSemantics(instance, workflow.nodes[0], role, standaloneOnlyAnswer),
    /已存在项目集成原型基线[\s\S]*至少返回 1 个真实项目内的集成原型路径/,
  );
});

test("collectAffectedReworkNodes keeps completed sibling domains outside a declared rework impact", () => {
  const role = createRole({ name: "领域评审" });
  const workflow: WorkflowDefinition = {
    id: "wf_scoped_rework_impact" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "analysis",
    name: "精确返工影响集",
    description: "精确返工影响集",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "source", type: "role", roleId: role.id, label: "资料扫描", position: { x: 0, y: 0 } },
      { id: "locked-domain", type: "role", roleId: role.id, label: "已锁定领域", position: { x: 180, y: 0 } },
      { id: "target-domain", type: "role", roleId: role.id, label: "目标领域", position: { x: 180, y: 180 } },
      {
        id: "reviewer",
        type: "role",
        roleId: role.id,
        label: "目标领域评审",
        position: { x: 360, y: 180 },
        reworkPolicy: {
          allowedTargetNodeIds: ["source"],
          affectedNodeIdsByTargetNodeId: {
            source: ["source", "target-domain", "reviewer", "review-join", "audit", "end"],
          },
        },
      },
      { id: "review-join", type: "parallel-join", label: "领域评审汇合", position: { x: 540, y: 90 } },
      { id: "audit", type: "role", roleId: role.id, label: "全局审计", position: { x: 720, y: 90 } },
      { id: "end", type: "end", label: "结束", position: { x: 900, y: 90 } },
    ],
    edges: [
      { id: "source-locked", sourceNodeId: "source", targetNodeId: "locked-domain", dataMappings: [] },
      { id: "source-target", sourceNodeId: "source", targetNodeId: "target-domain", dataMappings: [] },
      { id: "target-reviewer", sourceNodeId: "target-domain", targetNodeId: "reviewer", dataMappings: [] },
      { id: "locked-join", sourceNodeId: "locked-domain", targetNodeId: "review-join", dataMappings: [] },
      { id: "reviewer-join", sourceNodeId: "reviewer", targetNodeId: "review-join", dataMappings: [] },
      { id: "join-audit", sourceNodeId: "review-join", targetNodeId: "audit", dataMappings: [] },
      { id: "audit-end", sourceNodeId: "audit", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  instance.nodeStates = Object.fromEntries(workflow.nodes.map((node) => [node.id, createNodeState(node.id)]));
  const { engine } = createHarness();

  assert.throws(
    () => (engine as any).resolveModelReworkNodeIds(instance, workflow.nodes[3], {
      targetNodeId: "source",
      reason: "未声明精确重跑集合",
    }),
    /必须显式提供非空 rework\.rerunNodeIds/,
  );

  const scoped = (engine as any).collectAffectedReworkNodes(instance, "source", "reviewer") as Set<string>;
  assert.deepEqual(
    Array.from(scoped).sort(),
    ["audit", "end", "review-join", "reviewer", "source", "target-domain"],
  );
  assert.equal(scoped.has("locked-domain"), false);

  const outOfScope = createTextFinalAnswer("需要精确返工", {
    control: { nextAction: "rework" },
    review: { verdict: "fail" },
    rework: {
      targetNodeId: "source",
      reason: "只重查受影响领域",
      rerunNodeIds: ["source", "locked-domain", "reviewer"],
    },
  });
  assert.throws(
    () => (engine as any).validateFinalAnswerSemantics(instance, workflow.nodes[3], role, outOfScope),
    /工作流声明影响范围之外.*locked-domain/,
  );

  assert.throws(
    () => (engine as any).resolveModelReworkNodeIds(instance, workflow.nodes[3], {
      targetNodeId: "source",
      reason: "跨过目标领域",
      rerunNodeIds: ["source", "reviewer"],
    }),
    /未选中的非终态桥节点.*target-domain\(pending\)/,
  );
  assert.throws(
    () => (engine as any).resolveModelReworkNodeIds(instance, workflow.nodes[3], {
      targetNodeId: "source",
      reason: "只重跑 Owner",
      rerunNodeIds: ["source"],
    }),
    /必须包含当前节点 reviewer/,
  );
  instance.nodeStates["target-domain"].status = "completed";
  assert.deepEqual(
    Array.from((engine as any).resolveModelReworkNodeIds(instance, workflow.nodes[3], {
      targetNodeId: "source",
      reason: "跨过已完成目标领域",
      rerunNodeIds: ["source", "reviewer"],
    })),
    ["source", "reviewer"],
  );

  assert.throws(
    () => (engine as any).resolveModelReworkNodeIds(instance, workflow.nodes[3], {
      targetNodeId: "source",
      reason: "只重跑目标领域并重新汇合",
      rerunNodeIds: ["source", "reviewer", "review-join"],
    }),
    /未选中的非终态桥节点.*locked-domain\(pending\)/,
  );
  instance.nodeStates["review-join"].status = "completed";
  assert.throws(
    () => (engine as any).resolveModelReworkNodeIds(instance, workflow.nodes[3], {
      targetNodeId: "source",
      reason: "跨过已完成汇合节点并重跑审计",
      rerunNodeIds: ["source", "reviewer", "audit"],
    }),
    /未选中的非终态桥节点.*locked-domain\(pending\)/,
  );
  instance.nodeStates["locked-domain"].status = "completed";
  assert.deepEqual(
    Array.from((engine as any).resolveModelReworkNodeIds(instance, workflow.nodes[3], {
      targetNodeId: "source",
      reason: "复用已完成汇合节点后重跑审计",
      rerunNodeIds: ["source", "reviewer", "audit"],
    })),
    ["source", "reviewer", "audit"],
  );

  const legacy = (engine as any).collectAffectedReworkNodes(instance, "source") as Set<string>;
  assert.equal(legacy.has("locked-domain"), true);
  assert.equal(legacy.size, workflow.nodes.length);
});

test("collectAffectedReworkNodes keeps parallel siblings locked for undeclared model rework", () => {
  const role = createRole({ name: "领域评审" });
  const workflow: WorkflowDefinition = {
    id: "wf_causal_rework_impact" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "analysis",
    name: "因果返工影响集",
    description: "因果返工影响集",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "source", type: "role", roleId: role.id, label: "资料扫描", position: { x: 0, y: 0 } },
      { id: "locked-domain", type: "role", roleId: role.id, label: "已锁定领域", position: { x: 180, y: 0 } },
      { id: "target-domain", type: "role", roleId: role.id, label: "目标领域", position: { x: 180, y: 180 } },
      { id: "reviewer", type: "role", roleId: role.id, label: "目标领域评审", position: { x: 360, y: 180 } },
      { id: "review-join", type: "parallel-join", label: "领域评审汇合", position: { x: 540, y: 90 } },
      { id: "audit", type: "role", roleId: role.id, label: "全局审计", position: { x: 720, y: 90 } },
      { id: "end", type: "end", label: "结束", position: { x: 900, y: 90 } },
    ],
    edges: [
      { id: "source-locked", sourceNodeId: "source", targetNodeId: "locked-domain", dataMappings: [] },
      { id: "source-target", sourceNodeId: "source", targetNodeId: "target-domain", dataMappings: [] },
      { id: "target-reviewer", sourceNodeId: "target-domain", targetNodeId: "reviewer", dataMappings: [] },
      { id: "locked-join", sourceNodeId: "locked-domain", targetNodeId: "review-join", dataMappings: [] },
      { id: "reviewer-join", sourceNodeId: "reviewer", targetNodeId: "review-join", dataMappings: [] },
      { id: "join-audit", sourceNodeId: "review-join", targetNodeId: "audit", dataMappings: [] },
      { id: "audit-end", sourceNodeId: "audit", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const { engine } = createHarness();

  const scoped = (engine as any).collectAffectedReworkNodes(instance, "source", "reviewer") as Set<string>;
  assert.deepEqual(
    Array.from(scoped).sort(),
    ["audit", "end", "review-join", "reviewer", "source", "target-domain"],
  );
  assert.equal(scoped.has("locked-domain"), false);
});

test("collectAffectedReworkNodes traverses an active skipped bridge without reopening it", () => {
  const role = createRole({ name: "需求评审" });
  const workflow: WorkflowDefinition = {
    id: "wf_rework_through_skipped_bridge" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "analysis",
    name: "跳过原型后的需求评审",
    description: "跳过原型后的需求评审",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: role.id, label: "需求分析", position: { x: 0, y: 0 } },
      { id: "decision", type: "condition", label: "选择下一步流程节点", position: { x: 180, y: 0 } },
      { id: "prototype", type: "role", roleId: role.id, label: "原型设计", position: { x: 360, y: 0 } },
      {
        id: "review",
        type: "role",
        roleId: role.id,
        label: "需求评审",
        position: { x: 540, y: 0 },
        reworkPolicy: { allowedTargetNodeIds: ["analysis"] },
      },
    ],
    edges: [
      { id: "analysis-decision", sourceNodeId: "analysis", targetNodeId: "decision", dataMappings: [] },
      {
        id: "decision-prototype",
        sourceNodeId: "decision",
        targetNodeId: "prototype",
        conditionBranch: "prototype",
        dataMappings: [],
      },
      {
        id: "decision-review",
        sourceNodeId: "decision",
        targetNodeId: "review",
        conditionBranch: "skip-prototype",
        dataMappings: [],
      },
      { id: "prototype-review", sourceNodeId: "prototype", targetNodeId: "review", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  instance.nodeStates = {
    analysis: createNodeState("analysis", "completed"),
    decision: createNodeState("decision", "completed", { branchTaken: "prototype" }),
    prototype: createNodeState("prototype", "skipped"),
    review: createNodeState("review", "waiting-feedback"),
  };
  const { engine } = createHarness();

  const affected = (engine as any).collectAffectedReworkNodes(instance, "analysis", "review") as Set<string>;

  assert.deepEqual(Array.from(affected).sort(), ["analysis", "decision", "review"]);
  assert.equal(affected.has("prototype"), false);
});

test("resolveAllowedReworkTargets honors an explicit empty policy", () => {
  const role = createRole({ name: "Owner" });
  const workflow: WorkflowDefinition = {
    id: "wf_owner_no_automatic_rework" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "analysis",
    name: "Owner 无自动返工",
    description: "Owner 无自动返工",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "upstream", type: "role", roleId: role.id, label: "上游", position: { x: 0, y: 0 } },
      { id: "owner", type: "role", roleId: role.id, label: "Owner", reworkPolicy: { allowedTargetNodeIds: [] }, position: { x: 180, y: 0 } },
    ],
    edges: [{ id: "upstream-owner", sourceNodeId: "upstream", targetNodeId: "owner", dataMappings: [] }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const { engine } = createHarness();

  const allowed = (engine as any).resolveAllowedReworkTargets(instance, workflow.nodes[1]) as Set<string>;
  assert.equal(allowed.size, 0);
});

test("normalizeReworkDirective preserves a deduplicated exact rerun set", () => {
  const { engine } = createHarness();
  const directive = (engine as any).normalizeReworkDirective({
    targetNodeId: "baseline-plan",
    reason: "输入版本已刷新",
    rerunNodeIds: ["baseline-plan", "frontend-spec", "frontend-spec"],
    workItemScopes: [
      { nodeId: "baseline-plan", mode: "selected", sourceKeys: ["asset-a", "asset-a", "asset-b"] },
      { nodeId: "frontend-spec", mode: "all" },
    ],
  });
  assert.deepEqual(directive, {
    targetNodeId: "baseline-plan",
    reason: "输入版本已刷新",
    rerunNodeIds: ["baseline-plan", "frontend-spec"],
    workItemScopes: [
      { nodeId: "baseline-plan", mode: "selected", sourceKeys: ["asset-a", "asset-b"] },
      { nodeId: "frontend-spec", mode: "all" },
    ],
  });
  assert.throws(
    () => (engine as any).normalizeReworkDirective({
      targetNodeId: "baseline-plan",
      reason: "输入版本已刷新",
    }),
    /rerunNodeIds 必须显式填写/,
  );
  assert.throws(
    () => (engine as any).normalizeReworkDirective({
      targetNodeId: "baseline-plan",
      reason: "输入版本已刷新",
      rerunNodeIds: null,
    }),
    /rerunNodeIds 必须显式填写/,
  );
  assert.throws(
    () => (engine as any).normalizeReworkDirective({
      targetNodeId: "baseline-plan",
      reason: "输入版本已刷新",
      rerunNodeIds: [],
    }),
    /rerunNodeIds 不能为空数组/,
  );
  assert.throws(
    () => (engine as any).normalizeReworkDirective({
      targetNodeId: "baseline-plan",
      reason: "输入版本已刷新",
      rerunNodeIds: ["baseline-plan"],
      workItemScopes: [{ nodeId: "baseline-plan", mode: "selected", sourceKeys: [] }],
    }),
    /sourceKeys 在 selected 模式不能为空/,
  );
  assert.throws(
    () => (engine as any).normalizeReworkDirective({
      targetNodeId: "baseline-plan",
      reason: "输入版本已刷新",
      rerunNodeIds: ["baseline-plan"],
      workItemScopes: [
        { nodeId: "baseline-plan", mode: "all" },
        { nodeId: "baseline-plan", mode: "all" },
      ],
    }),
    /workItemScopes 节点重复/,
  );
});

test("resolveNodeWorkItemReworkScopes requires exact board coverage and merges fixed items", () => {
  const role = createRole();
  const owner: WorkflowNode = {
    id: "details",
    type: "role",
    roleId: role.id,
    label: "详情 Owner",
    position: { x: 0, y: 0 },
    workItemPolicy: {
      mode: "sequential",
      reworkAlwaysClientKeys: ["asset:detail:finalize"],
    },
  };
  const reviewer: WorkflowNode = {
    id: "review",
    type: "role",
    roleId: role.id,
    label: "综合 Reviewer",
    position: { x: 0, y: 180 },
    workItemPolicy: {
      mode: "sequential",
      reworkAlwaysClientKeys: ["asset:review:machine-gate", "asset:review:finalize"],
    },
  };
  const workflow = createWorkflow([owner, reviewer], [
    { id: "details-review", sourceNodeId: owner.id, targetNodeId: reviewer.id, dataMappings: [] },
  ]);
  const instance = createInstance(role, workflow);
  const { engine } = createHarness();
  let validatedScopes: unknown = null;
  (engine as any).ctx.db.orchNodeWorkItems = {
    getSummary(_instanceId: string, nodeId: string) {
      return {
        total: nodeId === "details" ? 3 : 4,
        pending: 0,
        inProgress: 0,
        completed: nodeId === "details" ? 3 : 4,
        deleted: 0,
        progressPercent: 100,
        boardVersion: 10,
        updatedAt: 1,
      };
    },
    validateReopenMany(input: { scopes: unknown }) {
      validatedScopes = input.scopes;
      return [];
    },
  };
  const resolved = (engine as any).resolveNodeWorkItemReworkScopes(
    instance,
    new Set(["details", "review"]),
    [
      { nodeId: "details", mode: "selected", sourceKeys: ["asset-a"] },
      { nodeId: "review", mode: "selected", sourceKeys: ["asset-a"] },
    ],
    "测试返工",
  );
  assert.deepEqual(resolved, [
    {
      nodeId: "details",
      mode: "selected",
      sourceKeys: ["asset-a"],
      alwaysClientKeys: ["asset:detail:finalize"],
    },
    {
      nodeId: "review",
      mode: "selected",
      sourceKeys: ["asset-a"],
      alwaysClientKeys: ["asset:review:machine-gate", "asset:review:finalize"],
    },
  ]);
  assert.deepEqual(validatedScopes, resolved);
  assert.throws(
    () => (engine as any).resolveNodeWorkItemReworkScopes(
      instance,
      new Set(["details", "review"]),
      [{ nodeId: "details", mode: "all" }],
      "测试返工",
    ),
    /missing=review/,
  );
});

test("validateFinalAnswerSemantics does not use role text to force integrated UI delivery", () => {
  const role = createRole({
    id: "role.prototype_writer" as any,
    name: "效率方案原型说明",
    description: "负责整理效率方案原型、交互设想和落地建议，不是 UI 交付节点。",
    responsibility: "输出普通文档交付物。",
    outputDefinition: {
      instructions: "",
      deliveryMode: "file-set",
      format: "markdown",
      resultKey: "efficiency-solution-reply",
      filePathRule: null,
      requiredFields: [],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_non_ui_prototype_text" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "非 UI 原型文案",
    description: "非 UI 原型文案",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "solution", type: "role", roleId: role.id, label: "方案说明", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const workspacePath = createTemporaryWorkspace(path.join(os.tmpdir(), "orch-non-ui-prototype-text-"));
  const workflowDocsRoot = "docs/workflow";
  fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "codeflowai", "codeflowai.json"),
    JSON.stringify({ paths: { workflowDocsRoot } }, null, 2),
    "utf8",
  );
  fs.mkdirSync(path.join(workspacePath, "apps/web/src/prototypes/init"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "apps/web/src/prototypes/init/index.vue"), "<template />", "utf8");

  const { engine } = createHarness();
  (engine as any).ctx.workspaces.set(workflow.workspaceId, workspacePath);

  const docsOnlyAnswer = createFinalAnswer({
    mode: "file-set",
    files: [
      { path: "docs/workflow/效率方案/方案说明/效率方案原型说明.md" },
    ],
  });

  assert.doesNotThrow(() => (engine as any).validateFinalAnswerSemantics(instance, workflow.nodes[0], role, docsOnlyAnswer));
});

test("validateFinalAnswerSemantics allows UI delivery to continue when节点结果 includes integrated project files", () => {
  const role = createRole({
    id: "role.ui" as any,
    name: "UI/UX设计师（UI）",
    description: "负责把需求与业务规则转成可评审、可预览的页面原型、交互流程和截图资产。",
    responsibility: "把上游约束转成页面结构、关键交互和原型资产。",
    outputDefinition: {
      instructions: "",
      deliveryMode: "file-set",
      format: "markdown",
      resultKey: "ui-spec",
      filePathRule: null,
      requiredFields: [],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_ui_integrated_mode_allowed" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "UI 集成原型通过",
    description: "UI 集成原型通过",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "ui", type: "role", roleId: role.id, label: "原型设计", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const workspacePath = createTemporaryWorkspace(path.join(os.tmpdir(), "orch-ui-integrated-allowed-"));
  const workflowDocsRoot = "docs/workflow";
  fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "codeflowai", "codeflowai.json"),
    JSON.stringify({ paths: { workflowDocsRoot } }, null, 2),
    "utf8",
  );
  fs.mkdirSync(path.join(workspacePath, "apps/web/src/prototypes/init"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "apps/web/src/prototypes/init/index.vue"), "<template />", "utf8");

  const { engine } = createHarness();
  (engine as any).ctx.workspaces.set(workflow.workspaceId, workspacePath);

  const integratedAnswer = createFinalAnswer({
    mode: "file-set",
    files: [
      { path: "docs/workflow/统一报送/原型设计/UI-统一报送-20260414.md" },
      { path: "apps/web/src/prototypes/unified-report/index.vue" },
      { path: "apps/web/src/prototypes/unified-report/README.md" },
    ],
  });

  assert.doesNotThrow(() => (engine as any).validateFinalAnswerSemantics(instance, workflow.nodes[0], role, integratedAnswer));
});

test("validateFinalAnswerSemantics does not force integrated UI delivery when workspace has no integrated prototype baseline", () => {
  const role = createRole({
    id: "role.ui" as any,
    name: "UI/UX设计师（UI）",
    description: "负责把需求与业务规则转成可评审、可预览的页面原型、交互流程和截图资产。",
    responsibility: "把上游约束转成页面结构、关键交互和原型资产。",
    outputDefinition: {
      instructions: "",
      deliveryMode: "file-set",
      format: "markdown",
      resultKey: "ui-spec",
      filePathRule: null,
      requiredFields: [],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_ui_no_integrated_baseline" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "UI 无集成基线",
    description: "UI 无集成基线",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "ui", type: "role", roleId: role.id, label: "原型设计", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const workspacePath = createTemporaryWorkspace(path.join(os.tmpdir(), "orch-ui-no-baseline-"));
  const workflowDocsRoot = "docs/workflow";
  fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "codeflowai", "codeflowai.json"),
    JSON.stringify({ paths: { workflowDocsRoot } }, null, 2),
    "utf8",
  );

  const { engine } = createHarness();
  (engine as any).ctx.workspaces.set(workflow.workspaceId, workspacePath);

  const standaloneOnlyAnswer = createFinalAnswer({
    mode: "file-set",
    files: [
      { path: "docs/workflow/统一报送/原型设计/UI-统一报送-20260414.md" },
      { path: "docs/workflow/统一报送/原型设计/UI-统一报送-20260414/index.html" },
    ],
  });

  assert.doesNotThrow(() => (engine as any).validateFinalAnswerSemantics(instance, workflow.nodes[0], role, standaloneOnlyAnswer));
});

test("submitFeedback rejects rework approval without improvement feedback", async () => {
  const role = createRole({ name: "交付整理" });
  const workflow: WorkflowDefinition = {
    id: "wf_rework_feedback_required" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "返工意见必填",
    description: "返工意见必填",
    workflowKnowledgeBundleIds: [],
    nodes: [
      {
        id: "delivery",
        type: "role",
        label: "交付整理",
        roleId: role.id,
        position: { x: 0, y: 0 },
        reworkPolicy: {
          allowedTargetNodeIds: ["implementation"],
        },
      },
      {
        id: "implementation",
        type: "role",
        label: "开发实现",
        roleId: role.id,
        position: { x: 180, y: 0 },
      },
    ],
    edges: [
      { id: "e-delivery-impl", sourceNodeId: "delivery", targetNodeId: "implementation", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rework_feedback_required" as any,
    status: "running",
    nodeStates: {
      delivery: createNodeState("delivery", "waiting-approval", {
        conclusion: {
          nextAction: "rework",
          reviewVerdict: "fail",
          summary: "需要退回开发实现修正问题",
          blockingIssues: ["验证失败"],
          acceptanceChecks: null,
          humanInput: null,
          rework: {
            targetNodeId: "implementation",
            reason: "请修复验证发现的问题",
            rerunNodeIds: ["implementation", "delivery"],
          },
          decidedBy: "model",
          decidedAt: 1,
        },
      }),
      implementation: createNodeState("implementation"),
    },
  };

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
      },
      orchFeedback: {
        create() {
          throw new Error("should not create feedback record");
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  await assert.rejects(
    () => engine.submitFeedback(instance.id, "delivery", "approve", { feedback: "" }),
    /确认退回修改时必须填写改进意见/,
  );
});

test("submitFeedback rejects retry from manual approval without improvement feedback", async () => {
  const role = createRole({ name: "方案设计" });
  const workflow: WorkflowDefinition = {
    id: "wf_retry_feedback_required" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "重跑意见必填",
    description: "重跑意见必填",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "design", type: "role", label: "方案设计", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_retry_feedback_required" as any,
    status: "running",
    nodeStates: {
      design: createNodeState("design", "waiting-approval", {
        conclusion: {
          nextAction: "continue",
          reviewVerdict: "partial",
          summary: "需要补充说明后再生成一次",
          blockingIssues: null,
          acceptanceChecks: null,
          humanInput: null,
          rework: null,
          decidedBy: "model",
          decidedAt: 1,
        },
      }),
    },
  };

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
      },
      orchFeedback: {
        create() {
          throw new Error("should not create feedback record");
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  await assert.rejects(
    () => engine.submitFeedback(instance.id, "design", "retry", { feedback: "   " }),
    /退回重跑前必须填写改进意见/,
  );
});

function createResumeScopeHarness(instance: OrchestrationInstance) {
  let statusWrites = 0;
  let reconcileCalls = 0;
  let driveCalls = 0;
  let backgroundCalls = 0;
  const events: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          statusWrites += 1;
          instance.status = status;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          events.push(input);
          return { id: `event_${events.length}`, createdAt: events.length, ...input };
        },
      },
      orchNodeAttempts: {
        cancelActiveByInstance() {},
        getLatestByNode() { return null; },
      },
      orchGateEvaluationRuns: {
        listRecoverable() { return []; },
      },
      turns: {
        listRunningByWorkspace() { return {}; },
      },
    } as any,
    threads: {} as any,
    sessions: {
      async interrupt() { return true; },
    } as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).reconcileRecoveredInstance = async () => {
    reconcileCalls += 1;
  };
  (engine as any).driveInstance = async () => {
    driveCalls += 1;
  };
  (engine as any).continueRunInBackground = async () => {
    backgroundCalls += 1;
  };
  return {
    engine,
    events,
    get statusWrites() {
      return statusWrites;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    get driveCalls() {
      return driveCalls;
    },
    get backgroundCalls() {
      return backgroundCalls;
    },
  };
}

test("reconcileRecoveredInstance preserves cancellation applied during role reconciliation", async () => {
  const role = createRole({ id: "role_reconcile_cancel" as any, name: "恢复对账取消" });
  const node: WorkflowNode = {
    id: "implementation",
    type: "role",
    label: "开发实现",
    roleId: role.id,
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_reconcile_cancel" as any,
    status: "running",
    nodeStates: {
      implementation: createNodeState("implementation", "running"),
    },
  };
  const harness = createResumeScopeHarness(instance);
  const engine = harness.engine;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  (engine as any).resolveRecoveredRoleDefinition = () => role;
  (engine as any).reconcileRecoveredRoleNode = async () => {
    enteredResolve();
    await release;
  };
  (engine as any).disposeManagedRuntime = async () => {};

  const reconcile = (OrchestrationEngine.prototype as any).reconcileRecoveredInstance.call(engine, instance.id);
  await entered;
  engine.cancel(instance.id);
  releaseResolve();
  await reconcile;

  assert.equal(instance.status, "cancelled");
  assert.equal(instance.nodeStates.implementation.status, "cancelled");
  assert.equal(harness.events.filter((event) => event.type === "orchestration.completed").length, 0);
});

test("submitFeedback retry from manual approval atomically reopens the current work item board", async () => {
  const role = createRole({ name: "资产详情 Owner" });
  const node: WorkflowNode = {
    id: "asset-details",
    type: "role",
    label: "资产详情",
    roleId: role.id,
    position: { x: 0, y: 0 },
    workItemPolicy: {
      mode: "sequential",
      reworkAlwaysClientKeys: ["asset:detail:finalize"],
    },
  };
  const workflow = createWorkflow([node]);
  const instance = createInstance(role, workflow);
  instance.id = "orch_manual_retry_work_items" as any;
  instance.status = "running";
  instance.nodeStates = {
    [node.id]: createNodeState(node.id, "waiting-approval", {
      nodeExecutionId: "attempt-asset-details",
      attemptId: "attempt-asset-details",
      workItemSummary: {
        total: 100,
        pending: 0,
        inProgress: 0,
        completed: 100,
        deleted: 0,
        progressPercent: 100,
        boardVersion: 300,
        updatedAt: 1,
      },
    }),
  };
  let reopenInput: Record<string, any> | null = null;
  const reopenedSummary = {
    total: 100,
    pending: 100,
    inProgress: 0,
    completed: 0,
    deleted: 0,
    progressPercent: 0,
    boardVersion: 301,
    updatedAt: 2,
  };
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          return { id: "feedback-manual-retry", ...input };
        },
      },
      orchNodeWorkItems: {
        getSummary() {
          return instance.nodeStates[node.id]!.workItemSummary!;
        },
        validateReopenMany(input: Record<string, any>) {
          assert.equal(input.allowInProgress, true);
          assert.deepEqual(input.scopes, [{
            nodeId: node.id,
            mode: "all",
            alwaysClientKeys: ["asset:detail:finalize"],
          }]);
          return [];
        },
        reopenMany(input: Record<string, any>) {
          reopenInput = input;
          return {
            batchId: "batch-manual-retry",
            nodes: [{
              nodeId: node.id,
              reopenedClientKeys: ["asset:a", "asset:detail:finalize"],
              unchangedClientKeys: [],
              summary: reopenedSummary,
            }],
          };
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).resolveRetryBaselineArtifactIds = () => null;
  (engine as any).rejectNodeArtifacts = () => {};
  (engine as any).beginNodeAttempt = () => null;
  (engine as any).syncInstanceRuntimeStatus = () => {};
  (engine as any).emitNodeStateChanged = () => {};
  (engine as any).emitOrchEvent = () => {};
  (engine as any).scheduleActiveRunAfterFeedback = () => {};

  await engine.submitFeedback(instance.id, node.id, "retry", { feedback: "逐项重新生成并复核" });

  const actualReopenInput = reopenInput as {
    allowInProgress: boolean;
    scopes: Array<{ nodeId: string; mode: "all"; alwaysClientKeys: string[] }>;
  } | null;
  assert.ok(actualReopenInput);
  assert.equal(actualReopenInput.allowInProgress, true);
  assert.deepEqual(actualReopenInput.scopes, [{
    nodeId: node.id,
    mode: "all",
    alwaysClientKeys: ["asset:detail:finalize"],
  }]);
  assert.equal(instance.nodeStates[node.id]?.status, "ready");
  assert.deepEqual(instance.nodeStates[node.id]?.workItemSummary, reopenedSummary);
});

test("submitFeedback approve applies model-requested rework and really resets the target branch", async () => {
  const role = createRole({ name: "交付整理" });
  const workflow: WorkflowDefinition = {
    id: "wf_rework_feedback" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "返工反馈测试",
    description: "返工反馈测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
      {
        id: "implementation",
        type: "role",
        label: "开发实现",
        roleId: role.id,
        position: { x: 180, y: 0 },
        workItemPolicy: { mode: "sequential", reworkAlwaysClientKeys: ["implementation:finalize"] },
      },
      { id: "verification", type: "role", label: "测试验证", roleId: role.id, position: { x: 360, y: 0 } },
      {
        id: "delivery",
        type: "role",
        label: "交付整理",
        roleId: role.id,
        position: { x: 540, y: 0 },
        reworkPolicy: {
          allowedTargetNodeIds: ["implementation"],
        },
        workItemPolicy: {
          mode: "sequential",
          reworkAlwaysClientKeys: ["delivery:machine-gate", "delivery:finalize"],
        },
      },
    ],
    edges: [
      { id: "e-a-i", sourceNodeId: "analysis", targetNodeId: "implementation", dataMappings: [] },
      { id: "e-i-v", sourceNodeId: "implementation", targetNodeId: "verification", dataMappings: [] },
      { id: "e-v-d", sourceNodeId: "verification", targetNodeId: "delivery", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rework_feedback" as any,
    status: "running",
    nodeStates: {
      analysis: createNodeState("analysis"),
      implementation: createNodeState("implementation"),
      verification: createNodeState("verification"),
      delivery: createNodeState("delivery"),
    },
  };
  instance.nodeStates.analysis.status = "completed";
  instance.nodeStates.implementation.status = "completed";
  instance.nodeStates.implementation.nodeExecutionId = "implementation-execution-1";
  instance.nodeStates.implementation.attemptNo = 1;
  instance.nodeStates.implementation.threadId = "thread-implementation" as any;
  instance.nodeStates.implementation.outputArtifactIds = ["artifact_impl" as any];
  instance.nodeStates.implementation.activeFeedbackRecordIds = ["feedback_old_impl" as any];
  instance.nodeStates.verification.status = "completed";
  instance.nodeStates.verification.nodeExecutionId = "verification-execution-1";
  instance.nodeStates.verification.attemptNo = 1;
  instance.nodeStates.verification.outputArtifactIds = ["artifact_verification" as any];
  instance.nodeStates.verification.activeFeedbackRecordIds = ["feedback_old_verification" as any];
  instance.nodeStates.delivery.status = "waiting-approval";
  instance.nodeStates.delivery.nodeExecutionId = "delivery-execution-1";
  instance.nodeStates.delivery.attemptNo = 1;
  instance.nodeStates.delivery.threadId = "thread-delivery" as any;
  instance.nodeStates.delivery.outputArtifactIds = ["artifact_delivery" as any];
  instance.nodeStates.delivery.activeFeedbackRecordIds = ["feedback_old_delivery" as any];
  instance.nodeStates.delivery.conclusion = {
    nextAction: "rework",
    reviewVerdict: "fail",
    summary: "需要退回开发实现修正问题",
    blockingIssues: ["验证失败"],
    acceptanceChecks: null,
    humanInput: null,
    rework: {
      targetNodeId: "implementation",
      reason: "请修复验证发现的问题",
      rerunNodeIds: ["implementation", "delivery"],
      workItemScopes: [
        { nodeId: "implementation", mode: "selected", sourceKeys: ["asset-a"] },
        { nodeId: "delivery", mode: "selected", sourceKeys: ["asset-a"] },
      ],
    },
    decidedBy: "model",
    decidedAt: 1,
  };
  instance.artifactIndex = {
    implementation: ["artifact_impl" as any],
    verification: ["artifact_verification" as any],
    delivery: ["artifact_delivery" as any],
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const reopenedWorkItemBatches: Array<Record<string, any>> = [];
  const artifacts: Artifact[] = [
    createArtifact({
      id: "artifact_impl" as any,
      instanceId: instance.id,
      nodeId: "implementation",
      kind: "implementation-report",
      status: "approved",
    }),
    createArtifact({
      id: "artifact_verification" as any,
      instanceId: instance.id,
      nodeId: "verification",
      kind: "verification-report",
      status: "approved",
    }),
    createArtifact({
      id: "artifact_delivery" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
      status: "draft",
    }),
  ];

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
        updateWorkspace(artifactId: string, patch: Partial<Artifact>) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) Object.assign(artifact, patch, { updatedAt: Date.now() });
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
      orchNodeWorkItems: {
        getSummary(_instanceId: string, nodeId: string) {
          const total = nodeId === "implementation" ? 2 : 3;
          return {
            total,
            pending: 0,
            inProgress: 0,
            completed: total,
            deleted: 0,
            progressPercent: 100,
            boardVersion: 7,
            updatedAt: 1,
          };
        },
        validateReopenMany() {
          return [];
        },
        reopenMany(input: Record<string, any>) {
          reopenedWorkItemBatches.push(input);
          return {
            batchId: "batch-rework",
            nodes: input.scopes.map((scope: { nodeId: string }) => ({
              nodeId: scope.nodeId,
              reopenedClientKeys: [`${scope.nodeId}:asset-a`],
              unchangedClientKeys: [],
              summary: {
                total: scope.nodeId === "implementation" ? 2 : 3,
                pending: scope.nodeId === "implementation" ? 2 : 3,
                inProgress: 0,
                completed: 0,
                deleted: 0,
                progressPercent: 0,
                boardVersion: 8,
                updatedAt: 2,
              },
            })),
          };
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).startCoordinator = async () => {};
  (engine as any).ctx.db.orchInstances.updateArtifactIndex = (
    _instanceId: string,
    artifactIndex: Record<string, string[]>,
  ) => {
    instance.artifactIndex = artifactIndex as any;
  };

  await engine.submitFeedback(instance.id, "delivery", "approve", { feedback: "确认退回开发实现" });

  assert.equal(instance.nodeStates.implementation.status, "pending");
  assert.equal(instance.nodeStates.verification.status, "completed");
  assert.equal(instance.nodeStates.delivery.status, "pending");
  assert.equal(instance.nodeStates.implementation.attemptNo, 1);
  assert.equal(instance.nodeStates.implementation.parentExecutionId, "delivery-execution-1");
  assert.equal(instance.nodeStates.implementation.nodeExecutionId, null);
  assert.equal(instance.nodeStates.implementation.threadId, "thread-implementation");
  assert.equal(instance.nodeStates.implementation.previousThreadIds, undefined);
  assert.deepEqual(instance.nodeStates.implementation.inputArtifactIds, ["artifact_delivery"]);
  assert.deepEqual(instance.nodeStates.implementation.activeFeedbackRecordIds, ["feedback_2" as any]);
  assert.deepEqual(instance.nodeStates.verification.activeFeedbackRecordIds, ["feedback_old_verification" as any]);
  assert.deepEqual(instance.nodeStates.delivery.activeFeedbackRecordIds, ["feedback_3" as any]);
  assert.equal(instance.nodeStates.delivery.threadId, null);
  assert.deepEqual(instance.nodeStates.delivery.previousThreadIds, ["thread-delivery"]);
  assert.equal(instance.nodeStates.implementation.workItemSummary?.pending, 2);
  assert.equal(instance.nodeStates.delivery.workItemSummary?.pending, 3);
  assert.equal(reopenedWorkItemBatches.length, 1);
  assert.deepEqual(reopenedWorkItemBatches[0]?.scopes, [
    {
      nodeId: "implementation",
      mode: "selected",
      sourceKeys: ["asset-a"],
      alwaysClientKeys: ["implementation:finalize"],
    },
    {
      nodeId: "delivery",
      mode: "selected",
      sourceKeys: ["asset-a"],
      alwaysClientKeys: ["delivery:machine-gate", "delivery:finalize"],
    },
  ]);
  assert.deepEqual(instance.artifactIndex, { verification: ["artifact_verification"] });
  assert.ok((instance.nodeStates.implementation.feedbackRecordIds ?? []).includes("feedback_2" as any));
  assert.equal(artifacts.find((artifact) => artifact.id === "artifact_impl")?.status, "superseded");
  assert.equal(artifacts.find((artifact) => artifact.id === "artifact_verification")?.status, "approved");
  assert.equal(artifacts.find((artifact) => artifact.id === "artifact_delivery")?.status, "superseded");
  assert.deepEqual(
    ((engine as any).findReadyNodes(workflow.nodes, workflow.edges, instance) as WorkflowNode[]).map((node) => node.id),
    ["implementation"],
    "已完成的 verification 只作为依赖桥，delivery 必须等待 implementation 完成",
  );
  instance.nodeStates.implementation.status = "completed";
  assert.deepEqual(
    ((engine as any).findReadyNodes(workflow.nodes, workflow.edges, instance) as WorkflowNode[]).map((node) => node.id),
    ["delivery"],
    "更早的重跑节点完成后，已完成桥节点应释放后续精确重跑节点",
  );
  assert.ok(orchEvents.some((event) => event.type === "orchestration.reworkRequested"));
  assert.ok(orchEvents.some((event) => {
    if (event.type !== "orchestration.nodeStateChanged") return false;
    const payload = JSON.parse(String(event.payloadJson ?? "{}"));
    return payload.nodeExecutionId === "delivery-execution-1" && payload.status === "cancelled";
  }));
  assert.equal(feedbackRecords.length, 3);
  assert.equal(feedbackRecords[0]?.action, "approve");
  assert.equal(feedbackRecords[1]?.action, "system_rework");
  assert.equal(feedbackRecords[2]?.action, "system_rework_followup");
  assert.equal(feedbackRecords[2]?.nodeId, "delivery");
  assert.deepEqual(feedbackRecords[2]?.artifactIds, ["artifact_delivery"]);
  assert.match(String(feedbackRecords[2]?.feedback ?? ""), /上一轮列举项只是已知问题/);

  const implementationNode = workflow.nodes.find((node) => node.id === "implementation");
  assert.ok(implementationNode);
  (engine as any).updateNodeStatus(instance.id, implementationNode, instance, "queued");
  assert.equal(instance.nodeStates.implementation.attemptNo, 2);
  assert.equal(instance.nodeStates.implementation.parentExecutionId, "delivery-execution-1");
  assert.ok(instance.nodeStates.implementation.nodeExecutionId);
  assert.notEqual(instance.nodeStates.implementation.nodeExecutionId, "implementation-execution-1");
});

test("submitFeedback rework_to_target directly resets the requested upstream branch", async () => {
  const role = createRole({ name: "交付整理" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_rework_to_target" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "人工驳回到指定节点",
    description: "人工驳回到指定节点",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
      {
        id: "implementation",
        type: "role",
        label: "开发实现",
        roleId: role.id,
        position: { x: 180, y: 0 },
        workItemPolicy: { mode: "sequential", reworkAlwaysClientKeys: ["implementation:finalize"] },
      },
      { id: "verification", type: "role", label: "测试验证", roleId: role.id, position: { x: 360, y: 0 } },
      {
        id: "delivery",
        type: "role",
        label: "交付整理",
        roleId: role.id,
        position: { x: 540, y: 0 },
        reworkPolicy: {
          allowedTargetNodeIds: ["implementation"],
        },
        workItemPolicy: {
          mode: "sequential",
          reworkAlwaysClientKeys: ["delivery:machine-gate", "delivery:finalize"],
        },
      },
    ],
    edges: [
      { id: "e-a-i", sourceNodeId: "analysis", targetNodeId: "implementation", dataMappings: [] },
      { id: "e-i-v", sourceNodeId: "implementation", targetNodeId: "verification", dataMappings: [] },
      { id: "e-v-d", sourceNodeId: "verification", targetNodeId: "delivery", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_rework_to_target" as any,
    status: "running",
    nodeStates: {
      analysis: createNodeState("analysis", "completed"),
      implementation: createNodeState("implementation", "completed", {
        outputArtifactIds: ["artifact_impl" as any],
        activeFeedbackRecordIds: ["feedback_old_impl" as any],
      }),
      verification: createNodeState("verification", "completed", {
        outputArtifactIds: ["artifact_verification" as any],
        activeFeedbackRecordIds: ["feedback_old_verification" as any],
      }),
      delivery: createNodeState("delivery", "waiting-feedback", {
        humanActionSource: "review",
        outputArtifactIds: ["artifact_delivery" as any],
        activeFeedbackRecordIds: ["feedback_old_delivery" as any],
      }),
    },
    artifactIndex: {
      implementation: ["artifact_impl" as any],
      verification: ["artifact_verification" as any],
      delivery: ["artifact_delivery" as any],
    },
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const manualReopenBatches: Array<Record<string, any>> = [];
  const artifacts: Artifact[] = [
    createArtifact({
      id: "artifact_impl" as any,
      instanceId: instance.id,
      nodeId: "implementation",
      kind: "implementation-report",
      status: "approved",
    }),
    createArtifact({
      id: "artifact_verification" as any,
      instanceId: instance.id,
      nodeId: "verification",
      kind: "verification-report",
      status: "approved",
    }),
    createArtifact({
      id: "artifact_delivery" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
      status: "draft",
    }),
  ];

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
        updateWorkspace(artifactId: string, patch: Partial<Artifact>) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) Object.assign(artifact, patch, { updatedAt: Date.now() });
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchArtifactFields: {
        listByArtifact() {
          return [];
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
      orchNodeWorkItems: {
        getSummary(_instanceId: string, nodeId: string) {
          const total = nodeId === "implementation" || nodeId === "delivery" ? 2 : 0;
          return {
            total,
            pending: 0,
            inProgress: 0,
            completed: total,
            deleted: 0,
            progressPercent: total ? 100 : 0,
            boardVersion: total ? 5 : 0,
            updatedAt: total ? 1 : null,
          };
        },
        validateReopenMany(input: Record<string, any>) {
          assert.equal(input.allowInProgress, true);
          return [];
        },
        reopenMany(input: Record<string, any>) {
          manualReopenBatches.push(input);
          return {
            batchId: "batch-manual-rework",
            nodes: input.scopes.map((scope: { nodeId: string }) => ({
              nodeId: scope.nodeId,
              reopenedClientKeys: [`${scope.nodeId}:all`],
              unchangedClientKeys: [],
              summary: {
                total: 2,
                pending: 2,
                inProgress: 0,
                completed: 0,
                deleted: 0,
                progressPercent: 0,
                boardVersion: 6,
                updatedAt: 2,
              },
            })),
          };
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).startCoordinator = async () => {};
  (engine as any).ctx.db.orchInstances.updateArtifactIndex = (
    _instanceId: string,
    artifactIndex: Record<string, string[]>,
  ) => {
    instance.artifactIndex = artifactIndex as any;
  };
  (engine as any).ctx.db.orchFeedback.get = (recordId: string) =>
    feedbackRecords.find((record) => record.id === recordId) ?? null;

  await engine.submitFeedback(instance.id, "delivery", "rework_to_target", {
    feedback: "请退回开发修复这次人工反馈的问题",
    targetNodeId: "implementation",
    artifactIds: ["artifact_delivery" as any],
  });

  assert.equal(instance.nodeStates.implementation.status, "pending");
  assert.equal(instance.nodeStates.verification.status, "pending");
  assert.equal(instance.nodeStates.delivery.status, "pending");
  assert.deepEqual(instance.nodeStates.implementation.inputArtifactIds, ["artifact_delivery"]);
  assert.deepEqual(instance.nodeStates.implementation.activeFeedbackRecordIds, ["feedback_2" as any]);
  assert.equal(instance.nodeStates.verification.activeFeedbackRecordIds ?? null, null);
  assert.equal(instance.nodeStates.delivery.activeFeedbackRecordIds ?? null, null);
  assert.equal(instance.nodeStates.implementation.workItemSummary?.pending, 2);
  assert.equal(instance.nodeStates.delivery.workItemSummary?.pending, 2);
  assert.equal(manualReopenBatches.length, 1);
  assert.equal(manualReopenBatches[0]?.allowInProgress, true);
  assert.deepEqual(manualReopenBatches[0]?.scopes, [
    {
      nodeId: "implementation",
      mode: "all",
      alwaysClientKeys: ["implementation:finalize"],
    },
    {
      nodeId: "delivery",
      mode: "all",
      alwaysClientKeys: ["delivery:machine-gate", "delivery:finalize"],
    },
  ]);
  assert.deepEqual(instance.artifactIndex, {});
  assert.ok((instance.nodeStates.implementation.feedbackRecordIds ?? []).includes("feedback_2" as any));
  assert.equal(artifacts.find((artifact) => artifact.id === "artifact_impl")?.status, "superseded");
  assert.equal(artifacts.find((artifact) => artifact.id === "artifact_verification")?.status, "superseded");
  assert.equal(artifacts.find((artifact) => artifact.id === "artifact_delivery")?.status, "superseded");
  const feedbackContext = (engine as any).collectFeedbackContext(instance, "implementation");
  assert.deepEqual(feedbackContext.artifactIds, ["artifact_delivery" as any]);
  const feedbackArtifactInput = (engine as any).buildArtifactInputSnapshot(instance, feedbackContext.artifactIds, {});
  assert.deepEqual(
    feedbackArtifactInput.artifacts.map((artifact: any) => ({
      artifactId: artifact.artifactId,
      nodeId: artifact.nodeId,
      kind: artifact.kind,
      status: artifact.status,
    })),
    [
      {
        artifactId: "artifact_delivery",
        nodeId: "delivery",
        kind: "delivery-pack",
        status: "superseded",
      },
    ],
  );
  assert.ok(orchEvents.some((event) => event.type === "orchestration.reworkRequested"));
  assert.equal(feedbackRecords.length, 2);
  assert.equal(feedbackRecords[0]?.action, "rework_to_target");
  assert.equal(feedbackRecords[1]?.action, "system_rework");
});

/** rerunFromNode：用户主动从指定节点重跑 — 任意 role 节点（含 completed/failed）均可发起。 */
test("rerunFromNode resets selected node and downstream to pending with user-provided note", async () => {
  const role = createRole({ name: "实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_rerun_from_node" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "从指定节点重跑",
    description: "从指定节点重跑",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
      {
        id: "implementation",
        type: "role",
        label: "开发实现",
        roleId: role.id,
        position: { x: 180, y: 0 },
        workItemPolicy: { mode: "sequential" },
      },
      { id: "verification", type: "role", label: "测试验证", roleId: role.id, position: { x: 360, y: 0 } },
    ],
    edges: [
      { id: "e-a-i", sourceNodeId: "analysis", targetNodeId: "implementation", dataMappings: [] },
      { id: "e-i-v", sourceNodeId: "implementation", targetNodeId: "verification", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const liveWorkflow: WorkflowDefinition = {
    ...workflow,
    nodes: workflow.nodes.map((node) => node.id === "implementation"
      ? {
          ...node,
          workItemPolicy: {
            mode: "sequential",
            completion: { requireEvidence: true, requireAcceptanceChecks: true, verifyOutputPath: true },
            reworkAlwaysClientKeys: ["implementation:finalize"],
            maxItemsPerThread: 40,
          },
        }
      : node),
    updatedAt: 2,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rerun_from_node" as any,
    status: "completed",
    nodeStates: {
      analysis: createNodeState("analysis", "completed"),
      implementation: createNodeState("implementation", "completed", {
        threadId: "thread-implementation-existing" as any,
        outputArtifactIds: ["artifact_impl" as any],
      }),
      verification: createNodeState("verification", "completed", {
        threadId: "thread-verification-existing" as any,
        outputArtifactIds: ["artifact_verification" as any],
      }),
    },
    artifactIndex: {
      implementation: ["artifact_impl" as any],
      verification: ["artifact_verification" as any],
    },
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const artifacts: Artifact[] = [
    createArtifact({
      id: "artifact_impl" as any,
      instanceId: instance.id,
      nodeId: "implementation",
      kind: "implementation-report",
      status: "approved",
    }),
    createArtifact({
      id: "artifact_verification" as any,
      instanceId: instance.id,
      nodeId: "verification",
      kind: "verification-report",
      status: "approved",
    }),
  ];

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateRuntimeConfig(_instanceId: string, runtimeConfig: OrchestrationInstance["runtimeConfig"]) {
          instance.runtimeConfig = runtimeConfig;
        },
      },
      orchWorkflows: {
        get(workflowId: string) {
          return workflowId === liveWorkflow.id ? liveWorkflow : null;
        },
      },
      orchNodeWorkItems: {
        getSummary() {
          return { total: 0, pending: 0, inProgress: 0, completed: 0, deleted: 0, progressPercent: 0, boardVersion: 0, updatedAt: 0 };
        },
      },
      orchNodeAttempts: {
        cancelActiveByInstance() {},
        invalidateActiveByNode() {},
      },
      orchGateEvaluationRuns: {
        listRecoverable() { return []; },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
        updateWorkspace(artifactId: string, patch: Partial<Artifact>) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) Object.assign(artifact, patch, { updatedAt: Date.now() });
        },
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
      turns: {
        listRunningByWorkspace() { return {}; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).startCoordinator = async () => {};
  (engine as any).disposeManagedRuntime = async () => {};
  (engine as any).ctx.db.orchInstances.updateArtifactIndex = (
    _instanceId: string,
    artifactIndex: Record<string, string[]>,
  ) => {
    instance.artifactIndex = artifactIndex as any;
  };

  await engine.rerunFromNode(instance.id, "implementation", {
    note: "修复上次漏掉的分支",
    applyLatestWorkItemPolicy: true,
  });

  assert.equal(instance.nodeStates.analysis.status, "completed", "上游未受影响");
  assert.equal(instance.nodeStates.implementation.status, "pending");
  assert.equal(instance.nodeStates.verification.status, "pending");
  assert.equal(instance.nodeStates.implementation.threadId, "thread-implementation-existing");
  assert.equal(instance.nodeStates.verification.threadId, "thread-verification-existing");
  assert.equal(instance.nodeStates.implementation.previousThreadIds, undefined);
  assert.equal(instance.nodeStates.verification.previousThreadIds, undefined);
  assert.deepEqual(instance.artifactIndex, {});
  assert.equal(artifacts.find((artifact) => artifact.id === "artifact_impl")?.status, "superseded");
  assert.equal(artifacts.find((artifact) => artifact.id === "artifact_verification")?.status, "superseded");
  assert.ok(orchEvents.some((event) => event.type === "orchestration.reworkRequested"));
  assert.deepEqual(instance.runtimeConfig?.nodeWorkItemPolicyOverrides?.implementation, {
    mode: "sequential",
    completion: { requireEvidence: true, requireAcceptanceChecks: true, verifyOutputPath: true },
    reworkAlwaysClientKeys: ["implementation:finalize"],
    maxItemsPerThread: 40,
  });
  assert.ok(orchEvents.some((event) => event.type === "orchestration.nodeWorkItemPoliciesUpdated"));
  assert.equal(feedbackRecords.length, 1);
  assert.equal(feedbackRecords[0]?.action, "system_rework");
  assert.equal(feedbackRecords[0]?.nodeId, "implementation");
  assert.match(String(feedbackRecords[0]?.feedback ?? ""), /修复上次漏掉的分支/);
  assert.equal(instance.status, "running", "完成后应已通过 resume 置为 running");

  instance.status = "completed";
  instance.nodeStates.implementation = createNodeState("implementation", "completed", {
    threadId: "thread-implementation-existing" as any,
    outputArtifactIds: ["artifact_impl" as any],
  });
  instance.nodeStates.verification = createNodeState("verification", "completed", {
    threadId: "thread-verification-existing" as any,
    outputArtifactIds: ["artifact_verification" as any],
  });
  instance.artifactIndex = {
    implementation: ["artifact_impl" as any],
    verification: ["artifact_verification" as any],
  };
  artifacts[0]!.status = "approved";
  artifacts[1]!.status = "approved";

  await engine.rerunFromNode(instance.id, "implementation", {
    note: "只重新规划当前节点",
    rerunNodeIds: ["implementation"],
  });

  assert.equal(instance.nodeStates.implementation.status, "pending");
  assert.equal(instance.nodeStates.verification.status, "completed");
  assert.deepEqual(instance.artifactIndex, { verification: ["artifact_verification"] });
  assert.equal(artifacts[0]?.status, "superseded");
  assert.equal(artifacts[1]?.status, "approved");
  const exactReworkEvent = [...orchEvents].reverse().find((event) => event.type === "orchestration.reworkRequested");
  assert.deepEqual(JSON.parse(String(exactReworkEvent?.payloadJson ?? "{}"))?.affectedNodeIds, ["implementation"]);

  await assert.rejects(
    () => engine.rerunFromNode(instance.id, "implementation", {
      rerunNodeIds: ["implementation", "verification", "analysis"],
    }),
    /有效下游之外/,
  );

  const originalEnsureSnapshot = (engine as any).ensureAssetRuntimeSnapshotForExecution.bind(engine);
  const originalInterruptAffected = (engine as any).interruptAffectedNodesForRerun.bind(engine);
  const originalApplyRework = (engine as any).applyRequestedRework.bind(engine);
  const originalResumeInBackground = engine.resumeInBackground.bind(engine);
  for (const phase of ["snapshot", "interrupt", "apply"] as const) {
    for (const control of ["pause", "cancel"] as const) {
      instance.status = "completed";
      instance.nodeStates.implementation = createNodeState("implementation", "completed", {
        threadId: "thread-implementation-existing" as any,
        outputArtifactIds: ["artifact_impl" as any],
      });
      instance.nodeStates.verification = createNodeState("verification", "completed", {
        threadId: "thread-verification-existing" as any,
        outputArtifactIds: ["artifact_verification" as any],
      });
      instance.artifactIndex = {
        implementation: ["artifact_impl" as any],
        verification: ["artifact_verification" as any],
      };
      artifacts[0]!.status = "approved";
      artifacts[1]!.status = "approved";
      (engine as any).runningInstances.delete(instance.id);
      const feedbackCountBefore: number = feedbackRecords.length;
      let resumeCalls = 0;
      const applyControl = async () => {
        if (control === "pause") await engine.pause(instance.id);
        else engine.cancel(instance.id);
      };
      (engine as any).ensureAssetRuntimeSnapshotForExecution = async (...args: unknown[]) => {
        const ensured = await originalEnsureSnapshot(...args);
        if (phase === "snapshot") await applyControl();
        return ensured;
      };
      (engine as any).interruptAffectedNodesForRerun = async (...args: unknown[]) => {
        await originalInterruptAffected(...args);
        if (phase === "interrupt") await applyControl();
      };
      (engine as any).applyRequestedRework = async (...args: unknown[]) => {
        await originalApplyRework(...args);
        if (phase === "apply") await applyControl();
      };
      engine.resumeInBackground = async (...args: Parameters<typeof engine.resumeInBackground>) => {
        resumeCalls += 1;
        await originalResumeInBackground(...args);
      };

      await assert.rejects(
        () => engine.rerunFromNode(instance.id, "implementation", { note: "并发控制测试" }),
        /后续暂停或取消终止/,
        `${phase}/${control}`,
      );

      assert.equal(instance.status, control === "pause" ? "paused" : "cancelled", `${phase}/${control}`);
      assert.equal(resumeCalls, 0, `${phase}/${control}`);
      assert.equal(
        feedbackRecords.length,
        phase === "apply" ? feedbackCountBefore + 1 : feedbackCountBefore,
        `${phase}/${control}`,
      );
    }
  }
  (engine as any).ensureAssetRuntimeSnapshotForExecution = originalEnsureSnapshot;
  (engine as any).interruptAffectedNodesForRerun = originalInterruptAffected;
  (engine as any).applyRequestedRework = originalApplyRework;
  engine.resumeInBackground = originalResumeInBackground;
});

test("rerunFromNode keeps remembered manual condition branch and inactive sibling skipped", async () => {
  const role = createRole({ name: "分支任务" });
  const workflow: WorkflowDefinition = {
    id: "wf_rerun_condition_memory" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "重跑保留条件分支",
    description: "重跑保留条件分支",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "prepare", type: "role", label: "准备输入", roleId: role.id, position: { x: 0, y: 0 } },
      { id: "condition", type: "condition", label: "人工决策", conditionDecisionMode: "manual", position: { x: 180, y: 0 } },
      { id: "true-node", type: "role", label: "输出true", roleId: role.id, position: { x: 360, y: 0 } },
      { id: "false-node", type: "role", label: "输出false", roleId: role.id, position: { x: 360, y: 120 } },
    ],
    edges: [
      { id: "e-prepare-condition", sourceNodeId: "prepare", targetNodeId: "condition", dataMappings: [] },
      { id: "e-condition-true", sourceNodeId: "condition", targetNodeId: "true-node", conditionBranch: null, dataMappings: [] },
      { id: "e-condition-false", sourceNodeId: "condition", targetNodeId: "false-node", conditionBranch: null, dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rerun_condition_memory" as any,
    status: "completed",
    nodeStates: {
      prepare: createNodeState("prepare", "completed"),
      condition: createNodeState("condition", "completed", { branchTaken: "target:true-node" }),
      "true-node": createNodeState("true-node", "completed"),
      "false-node": createNodeState("false-node", "skipped", { completedAt: 20 }),
    },
  };
  const feedbackRecords: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
          instance.artifactIndex = artifactIndex as any;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
        get() { return null; },
        updateStatus() {},
      },
      orchArtifactFiles: {
        listByArtifact() { return []; },
      },
      orchEvents: {
        append(input: Record<string, unknown>) { return input; },
      },
      turns: {
        listRunningByWorkspace() { return {}; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).startCoordinator = async () => {};

  await engine.rerunFromNode(instance.id, "prepare", { note: "重新生成上游输入" });

  assert.equal(instance.nodeStates.prepare.status, "pending");
  assert.equal(instance.nodeStates.condition.status, "pending");
  assert.equal(instance.nodeStates.condition.branchTaken, "target:true-node");
  assert.equal(instance.nodeStates["true-node"].status, "pending");
  assert.equal(instance.nodeStates["false-node"].status, "skipped");
  assert.equal(instance.nodeStates["false-node"].completedAt, 20);

  instance.nodeStates.prepare.status = "completed";
  await (engine as any).executeConditionNode(instance.id, workflow.nodes[1], instance);

  assert.equal(instance.nodeStates.condition.status, "completed");
  assert.equal(instance.nodeStates.condition.branchTaken, "target:true-node");
  assert.equal(instance.nodeStates["true-node"].status, "pending");
  assert.equal(instance.nodeStates["false-node"].status, "skipped");
});

test("rerunFromNode does not restore manually skipped downstream nodes", async () => {
  const role = createRole({ name: "并行任务" });
  const workflow: WorkflowDefinition = {
    id: "wf_rerun_manual_skip_memory" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "重跑保留手工跳过",
    description: "重跑保留手工跳过",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "prepare", type: "role", label: "准备输入", roleId: role.id, position: { x: 0, y: 60 } },
      { id: "task-a", type: "role", label: "分支A", roleId: role.id, position: { x: 200, y: 0 } },
      { id: "task-b", type: "role", label: "分支B", roleId: role.id, position: { x: 200, y: 120 } },
      { id: "join", type: "parallel-join", label: "汇合", position: { x: 400, y: 60 } },
    ],
    edges: [
      { id: "e-prepare-a", sourceNodeId: "prepare", targetNodeId: "task-a", dataMappings: [] },
      { id: "e-prepare-b", sourceNodeId: "prepare", targetNodeId: "task-b", dataMappings: [] },
      { id: "e-a-join", sourceNodeId: "task-a", targetNodeId: "join", dataMappings: [] },
      { id: "e-b-join", sourceNodeId: "task-b", targetNodeId: "join", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rerun_manual_skip_memory" as any,
    status: "completed",
    nodeStates: {
      prepare: createNodeState("prepare", "completed"),
      "task-a": createNodeState("task-a", "completed"),
      "task-b": createNodeState("task-b", "skipped", { completedAt: 30 }),
      join: createNodeState("join", "completed"),
    },
  };
  const feedbackRecords: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
          instance.artifactIndex = artifactIndex as any;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
        get() { return null; },
        updateStatus() {},
      },
      orchArtifactFiles: {
        listByArtifact() { return []; },
      },
      orchEvents: {
        append(input: Record<string, unknown>) { return input; },
      },
      turns: {
        listRunningByWorkspace() { return {}; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).startCoordinator = async () => {};

  await engine.rerunFromNode(instance.id, "prepare", { note: "只重跑有效分支" });

  assert.equal(instance.nodeStates.prepare.status, "pending");
  assert.equal(instance.nodeStates["task-a"].status, "pending");
  assert.equal(instance.nodeStates["task-b"].status, "skipped");
  assert.equal(instance.nodeStates["task-b"].completedAt, 30);
  assert.equal(instance.nodeStates.join.status, "pending");
});

test("rerunFromNode preserves a running parallel sibling outside the target subgraph", async () => {
  const role = createRole({ name: "并行任务" });
  const workflow: WorkflowDefinition = {
    id: "wf_rerun_parallel_sibling" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "并行重跑边界",
    description: "并行重跑边界",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "fork", type: "parallel-fork", label: "并行分叉", position: { x: 0, y: 60 } },
      { id: "plan", type: "role", label: "开发计划", roleId: role.id, position: { x: 200, y: 0 } },
      { id: "fill", type: "role", label: "任务回填", roleId: role.id, position: { x: 200, y: 120 } },
      { id: "join", type: "parallel-join", label: "并行汇合", position: { x: 400, y: 60 } },
    ],
    edges: [
      { id: "e-fork-plan", sourceNodeId: "fork", targetNodeId: "plan", dataMappings: [] },
      { id: "e-fork-fill", sourceNodeId: "fork", targetNodeId: "fill", dataMappings: [] },
      { id: "e-plan-join", sourceNodeId: "plan", targetNodeId: "join", dataMappings: [] },
      { id: "e-fill-join", sourceNodeId: "fill", targetNodeId: "join", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rerun_parallel_sibling" as any,
    status: "running",
    nodeStates: {
      fork: createNodeState("fork", "completed"),
      plan: createNodeState("plan", "running", { threadId: "thread-plan" as any }),
      fill: createNodeState("fill", "ready", { threadId: "thread-fill" as any }),
      join: createNodeState("join", "pending"),
    },
  };
  const feedbackRecords: Array<Record<string, unknown>> = [];
  const interrupts: Array<{ threadId: string; turnId: string }> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
          instance.artifactIndex = artifactIndex as any;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
        get() { return null; },
        updateStatus() {},
      },
      orchArtifactFiles: {
        listByArtifact() { return []; },
      },
      orchEvents: {
        append(input: Record<string, unknown>) { return input; },
      },
      turns: {
        listRunningByWorkspace() {
          return {
            "thread-plan": { runningTurnId: "turn-plan" },
          };
        },
      },
    } as any,
    threads: {} as any,
    sessions: {
      async interrupt(threadId: ThreadId, turnId: string) {
        interrupts.push({ threadId: String(threadId), turnId });
        return true;
      },
    } as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).startCoordinator = async () => {};
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run_rerun_parallel_sibling",
    drivePromise: new Promise<void>(() => {}),
    activeNodePromises: new Map(),
  });

  await engine.rerunFromNode(instance.id, "fill", { note: "只重跑任务回填" });

  assert.equal(instance.nodeStates.plan.status, "running");
  assert.deepEqual(interrupts, []);
  assert.equal(instance.nodeStates.fill.status, "pending");
  assert.equal(instance.nodeStates.join.status, "pending");
  assert.equal(feedbackRecords[0]?.nodeId, "fill");
  assert.equal(instance.status, "running");
});

test("rerunFromNode archives target and downstream thread ids only when new-thread policies are selected", async () => {
  const role = createRole({ name: "实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_rerun_thread_policy" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "重跑会话策略",
    description: "重跑会话策略",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
      { id: "implementation", type: "role", label: "开发实现", roleId: role.id, position: { x: 180, y: 0 } },
      { id: "verification", type: "role", label: "测试验证", roleId: role.id, position: { x: 360, y: 0 } },
    ],
    edges: [
      { id: "e-a-i", sourceNodeId: "analysis", targetNodeId: "implementation", dataMappings: [] },
      { id: "e-i-v", sourceNodeId: "implementation", targetNodeId: "verification", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rerun_thread_policy" as any,
    status: "completed",
    nodeStates: {
      analysis: createNodeState("analysis", "completed", { threadId: "thread-analysis" as any }),
      implementation: createNodeState("implementation", "completed", { threadId: "thread-implementation" as any }),
      verification: createNodeState("verification", "completed", { threadId: "thread-verification" as any }),
    },
  };
  const feedbackRecords: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateArtifactIndex() {},
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
        get() { return null; },
        updateStatus() {},
      },
      orchArtifactFiles: {
        listByArtifact() { return []; },
      },
      orchEvents: {
        append(input: Record<string, unknown>) { return input; },
      },
      turns: {
        listRunningByWorkspace() { return {}; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).startCoordinator = async () => {};

  await engine.rerunFromNode(instance.id, "implementation", {
    threadReusePolicy: "new-thread",
    downstreamThreadReusePolicy: "cascade-new-thread",
  });

  assert.equal(instance.nodeStates.analysis.threadId, "thread-analysis");
  assert.equal(instance.nodeStates.implementation.threadId, null);
  assert.deepEqual(instance.nodeStates.implementation.previousThreadIds, ["thread-implementation"]);
  assert.equal(instance.nodeStates.verification.threadId, null);
  assert.deepEqual(instance.nodeStates.verification.previousThreadIds, ["thread-verification"]);
  assert.equal(feedbackRecords[0]?.action, "system_rework");
});

/** rerunFromNode：缺省 note 时使用默认 reason，并拒绝非 role 节点。 */
test("rerunFromNode uses default reason when note is empty and rejects non-role nodes", async () => {
  const role = createRole({ name: "实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_rerun_from_node_guard" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "从指定节点重跑 - 边界",
    description: "从指定节点重跑 - 边界",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "START", position: { x: 0, y: 0 } },
      { id: "implementation", type: "role", label: "开发实现", roleId: role.id, position: { x: 180, y: 0 } },
      { id: "end", type: "end", label: "END", position: { x: 360, y: 0 } },
    ],
    edges: [
      { id: "e-s-i", sourceNodeId: "start", targetNodeId: "implementation", dataMappings: [] },
      { id: "e-i-e", sourceNodeId: "implementation", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rerun_from_node_guard" as any,
    status: "failed",
    nodeStates: {
      start: createNodeState("start", "completed"),
      implementation: createNodeState("implementation", "failed"),
      end: createNodeState("end", "pending"),
    },
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
        get() { return null; },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() { return []; },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) { return input; },
      },
      orchRoles: { get() { return null; } },
      turns: {
        listRunningByWorkspace() { return {}; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).startCoordinator = async () => {};
  (engine as any).ctx.db.orchInstances.updateArtifactIndex = (
    _instanceId: string,
    artifactIndex: Record<string, string[]>,
  ) => {
    instance.artifactIndex = artifactIndex as any;
  };

  // 缺省 note：feedback reason 使用默认值
  await engine.rerunFromNode(instance.id, "implementation");
  assert.equal(feedbackRecords.length, 1);
  assert.match(String(feedbackRecords[0]?.feedback ?? ""), /用户从此节点重跑/);

  // 非 role 节点：拒绝
  await assert.rejects(
    () => engine.rerunFromNode(instance.id, "start"),
    /仅 role 节点支持重跑/,
  );
  await assert.rejects(
    () => engine.rerunFromNode(instance.id, "end"),
    /仅 role 节点支持重跑/,
  );

  // 不存在的节点：拒绝
  await assert.rejects(
    () => engine.rerunFromNode(instance.id, "nonexistent"),
    /节点不存在/,
  );

  // 空 targetNodeId：拒绝
  await assert.rejects(
    () => engine.rerunFromNode(instance.id, ""),
    /必须提供 targetNodeId/,
  );
});

test("collectFeedbackContext ignores audit-only resume feedback after node reset", () => {
  const role = createRole({ name: "测试分析" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_context_reset" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "反馈上下文重置",
    description: "反馈上下文重置",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "测试分析", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_context_reset" as any,
    nodeStates: {
      analysis: createNodeState("analysis", "pending", {
        activeFeedbackRecordIds: null,
        feedbackRecordIds: ["feedback_resume_old" as any],
      }),
    },
  };

  const engine = new OrchestrationEngine({
    db: {
      orchFeedback: {
        get(recordId: string) {
          if (recordId !== "feedback_resume_old") return null;
          return {
            id: "feedback_resume_old" as any,
            instanceId: instance.id,
            nodeId: "analysis",
            action: "resume_with_input",
            feedback: "这是一条已经消费过的旧人工补充",
            artifactIds: null,
            createdAt: 1,
          };
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const context = (engine as any).collectFeedbackContext(instance, "analysis");
  assert.equal(context.feedbackPatch, null);
  assert.equal(context.latestFeedbackPatch, null);
  assert.equal(context.latestAction, null);
});

test("collectFeedbackContext keeps a pending legacy system_rework record injectable during compatibility fallback", () => {
  const role = createRole({ name: "开发实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_context_legacy_rework" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "旧返工反馈兼容",
    description: "旧返工反馈兼容",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "implementation", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_context_legacy_rework" as any,
    nodeStates: {
      implementation: createNodeState("implementation", "pending", {
        activeFeedbackRecordIds: undefined,
        feedbackRecordIds: ["feedback_rework_legacy" as any],
      }),
    },
  };

  const engine = new OrchestrationEngine({
    db: {
      orchFeedback: {
        get(recordId: string) {
          if (recordId !== "feedback_rework_legacy") return null;
          return {
            id: "feedback_rework_legacy" as any,
            instanceId: instance.id,
            nodeId: "implementation",
            action: "system_rework",
            feedback: "请基于最新测试反馈继续修正",
            artifactIds: null,
            createdAt: 1,
          };
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const context = (engine as any).collectFeedbackContext(instance, "implementation");
  assert.match(String(context.feedbackPatch ?? ""), /退回修改要求/);
  assert.match(String(context.latestFeedbackPatch ?? ""), /请基于最新测试反馈继续修正/);
  assert.equal(context.latestAction, "system_rework");
});

test("collectFeedbackContext exposes the previous review artifact on a model rework follow-up", () => {
  const role = createRole({ name: "综合评审" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_context_rework_followup" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "返工后复审上下文",
    description: "返工后复审上下文",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "review", type: "role", label: "综合评审", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_context_rework_followup" as any,
    nodeStates: {
      review: createNodeState("review", "pending", {
        activeFeedbackRecordIds: ["feedback_rework_followup" as any],
        feedbackRecordIds: ["feedback_rework_followup" as any],
      }),
    },
  };

  const engine = new OrchestrationEngine({
    db: {
      orchFeedback: {
        get(recordId: string) {
          if (recordId !== "feedback_rework_followup") return null;
          return {
            id: "feedback_rework_followup" as any,
            instanceId: instance.id,
            nodeId: "review",
            action: "system_rework_followup",
            feedback: "先核对上一轮 findings，再完成全部评审范围",
            artifactIds: ["artifact_previous_review" as any],
            createdAt: 1,
          };
        },
      },
      orchArtifacts: {
        get(artifactId: string) {
          if (artifactId !== "artifact_previous_review") return null;
          return {
            id: "artifact_previous_review" as any,
            instanceId: instance.id,
            title: "上一轮综合评审报告",
            version: 1,
          };
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const context = (engine as any).collectFeedbackContext(instance, "review");
  assert.match(String(context.feedbackPatch ?? ""), /返工后复审要求/);
  assert.match(String(context.latestFeedbackPatch ?? ""), /完成全部评审范围/);
  assert.equal(context.latestAction, "system_rework_followup");
  assert.deepEqual(context.artifactIds, ["artifact_previous_review" as any]);
});

test("ensureDiscussionThread creates a read-only node-discussion thread and reuses it afterwards", () => {
  const role = createRole({ name: "交付整理" });
  const workflow: WorkflowDefinition = {
    id: "wf_ensure_discussion_thread" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "讨论线程测试",
    description: "讨论线程测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "delivery", type: "role", label: "交付整理", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_ensure_discussion_thread" as any,
    status: "waiting-feedback",
    nodeStates: {
      delivery: createNodeState("delivery", "waiting-feedback", {
        threadId: "thread-node-delivery" as any,
      }),
    },
  };

  const persistedThreads = new Map<string, any>([
    ["thread-node-delivery", {
      id: "thread-node-delivery",
      workspaceId: instance.workspaceId,
      engine: "codex",
      title: "[编排] 交付整理",
      threadType: "orchestration",
      threadSubtype: "node",
      sessionId: null,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      model: "gpt-5.4",
      effort: "high",
      accessMode: "current",
      planMode: false,
    }],
  ]);
  const runtimeThreads = new Map<string, { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string; sessionId?: string | null }>();

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
      threads: {
        get(threadId: string) {
          return persistedThreads.get(threadId) ?? null;
        },
        create(input: Record<string, unknown>) {
          const created = {
            id: input.id,
            workspaceId: input.workspaceId,
            engine: input.engine,
            title: input.title,
            threadType: input.threadType,
            threadSubtype: input.threadSubtype,
            sessionId: null,
            archived: false,
            createdAt: 2,
            updatedAt: 2,
            model: (input.prefs as any)?.model ?? null,
            effort: (input.prefs as any)?.effort ?? null,
            accessMode: (input.prefs as any)?.accessMode ?? null,
            planMode: (input.prefs as any)?.planMode ?? null,
          };
          persistedThreads.set(String(created.id), created);
          return created;
        },
        rename(threadId: string, title: string) {
          const thread = persistedThreads.get(threadId);
          if (thread) {
            thread.title = title;
            thread.updatedAt = Date.now();
          }
        },
        updatePrefs(threadId: string, prefs: Record<string, unknown>) {
          const thread = persistedThreads.get(threadId);
          if (thread) {
            thread.model = prefs.model ?? null;
            thread.effort = prefs.effort ?? null;
            thread.accessMode = prefs.accessMode ?? null;
            thread.planMode = prefs.planMode ?? null;
            thread.updatedAt = Date.now();
          }
        },
      },
    } as any,
    threads: {
      get(threadId: string) {
        return runtimeThreads.get(threadId) ?? null;
      },
      create(input: { threadId: ThreadId; workspaceId: string; engine: EngineType; title: string }) {
        const created = { ...input, sessionId: null };
        runtimeThreads.set(String(input.threadId), created);
        return created;
      },
      setTitle(threadId: string, title: string) {
        const thread = runtimeThreads.get(threadId);
        if (thread) thread.title = title;
      },
      setSessionId(threadId: string, sessionId: string) {
        const thread = runtimeThreads.get(threadId);
        if (thread) thread.sessionId = sessionId;
      },
    } as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const first = engine.ensureDiscussionThread(instance.id, "delivery");
  const persistedDiscussionThread = persistedThreads.get(String(first.threadId));
  assert.equal(first.created, true);
  assert.equal(instance.nodeStates.delivery.discussionThreadId, first.threadId);
  assert.equal(persistedDiscussionThread?.threadSubtype, "node-discussion");
  assert.equal(persistedDiscussionThread?.threadType, "chat");
  assert.equal(persistedDiscussionThread?.engine, "codex");
  assert.equal(persistedDiscussionThread?.accessMode, "read-only");
  assert.equal(persistedDiscussionThread?.planMode, false);
  assert.equal(persistedDiscussionThread?.model, "gpt-5.4");
  assert.equal(persistedDiscussionThread?.effort, "high");

  const second = engine.ensureDiscussionThread(instance.id, "delivery");
  assert.equal(second.created, false);
  assert.equal(second.threadId, first.threadId);
});

test("submitFeedback rework carries latest human revision note back to the target node", async () => {
  const role = createRole({ name: "交付整理" });
  const workflow: WorkflowDefinition = {
    id: "wf_rework_human_revision" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "返工带人工修订记录",
    description: "返工带人工修订记录",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "implementation", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
      {
        id: "delivery",
        type: "role",
        label: "交付整理",
        roleId: role.id,
        position: { x: 180, y: 0 },
        reworkPolicy: {
          allowedTargetNodeIds: ["implementation"],
        },
      },
    ],
    edges: [
      { id: "e-i-d", sourceNodeId: "implementation", targetNodeId: "delivery", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_rework_human_revision" as any,
    status: "running",
    nodeStates: {
      implementation: createNodeState("implementation", "completed"),
      delivery: createNodeState("delivery", "waiting-approval", {
        outputArtifactIds: ["artifact_delivery_v1" as any, "artifact_delivery_v2" as any],
        conclusion: {
          nextAction: "rework",
          reviewVerdict: "fail",
          summary: "交付物需要回退实现节点重做",
          blockingIssues: ["交付内容缺失人工确认后的修订"],
          acceptanceChecks: null,
          humanInput: null,
          rework: {
            targetNodeId: "implementation",
            reason: "请基于最新交付内容重新实现",
            rerunNodeIds: ["implementation", "delivery"],
          },
          decidedBy: "model",
          decidedAt: 1,
        },
      }),
    },
    artifactIndex: {
      delivery: ["artifact_delivery_v1" as any, "artifact_delivery_v2" as any],
    },
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const artifacts: Artifact[] = [
    createArtifact({
      id: "artifact_delivery_v1" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
      status: "draft",
      version: 1,
      contentJson: JSON.stringify({ mode: "text", text: "初版交付" }),
    }),
    createArtifact({
      id: "artifact_delivery_v2" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
      status: "draft",
      version: 2,
      contentJson: JSON.stringify({ mode: "text", text: "人工修订后的交付" }),
      metadata: {
        revision: {
          source: "human",
          basedOnArtifactId: "artifact_delivery_v1",
          basedOnVersion: 1,
          note: "人工补充了验收清单和最终交付边界",
          editedAt: 2,
        },
      },
    }),
  ];

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
        get() {
          return null;
        },
      },
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append() {},
      },
      orchRoles: {
        get() {
          return role;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).ctx.db.orchInstances.updateArtifactIndex = (
    _instanceId: string,
    artifactIndex: Record<string, string[]>,
  ) => {
    instance.artifactIndex = artifactIndex as any;
  };

  await engine.submitFeedback(instance.id, "delivery", "approve", { feedback: "请把实现与最新交付物对齐" });

  assert.deepEqual(instance.nodeStates.implementation.inputArtifactIds, ["artifact_delivery_v2"]);
  assert.deepEqual(instance.artifactIndex, {});
  assert.ok((instance.nodeStates.implementation.feedbackRecordIds ?? []).includes("feedback_2" as any));
  const reworkFeedback = feedbackRecords[1] as { artifactIds?: string[]; feedback?: string } | undefined;
  assert.equal(reworkFeedback?.artifactIds?.[0], "artifact_delivery_v2");
  assert.match(String(reworkFeedback?.feedback ?? ""), /人工修订记录：/);
  assert.match(String(reworkFeedback?.feedback ?? ""), /人工补充了验收清单和最终交付边界/);
});

test("submitFeedback schedules active run continuation without blocking feedback submit", async () => {
  const role = createRole({ name: "审核节点" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_continue" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "反馈后继续执行",
    description: "反馈后继续执行",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
      { id: "end", type: "end", label: "结束", position: { x: 180, y: 0 } },
    ],
    edges: [
      { id: "e-a-end", sourceNodeId: "analysis", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_continue" as any,
    status: "running",
    nodeStates: {
      analysis: createNodeState("analysis", "waiting-approval", {
        startedAt: 10,
        completedAt: 20,
        conclusion: {
          nextAction: "continue",
          reviewVerdict: "pass",
          summary: "当前节点交付满足要求。",
          blockingIssues: null,
          acceptanceChecks: null,
          humanInput: null,
          rework: null,
          decidedBy: "model",
          decidedAt: 20,
        },
      }),
      end: createNodeState("end", "pending"),
    },
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
        get() {
          return null;
        },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run_active_feedback",
    drivePromise: null,
  });
  let releaseDrive: () => void = () => {
    throw new Error("drive continuation was not started");
  };
  let driveStarted = false;
  let driveFinished = false;
  (engine as any).startCoordinator = async () => {
    driveStarted = true;
    await new Promise<void>((resolve) => {
      releaseDrive = resolve;
    });
    driveFinished = true;
  };

  await engine.submitFeedback(instance.id, "analysis", "approve", { feedback: "继续执行" });

  assert.equal(instance.nodeStates.analysis.status, "completed");
  assert.equal(instance.nodeStates.end.status, "pending");
  assert.equal(instance.status, "running");
  assert.equal(driveStarted, false);
  await nextTimerTick();
  assert.equal(driveStarted, true);
  assert.equal(driveFinished, false);
  releaseDrive();
  await nextTimerTick();
  assert.equal(driveFinished, true);
  assert.equal(feedbackRecords.length, 1);
  assert.ok(orchEvents.some((event) =>
    event.type === "orchestration.nodeStateChanged"
    && JSON.parse(String(event.payloadJson ?? "{}")).nodeId === "analysis"
    && JSON.parse(String(event.payloadJson ?? "{}")).status === "completed"));
  assert.ok(!orchEvents.some((event) => event.type === "orchestration.completed"));
});

test("submitFeedback resume_with_input starts a ready parallel branch while sibling is still running", async () => {
  const role = createRole({ name: "并行任务" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_parallel_continue" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "并行补充继续",
    description: "并行补充继续",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "fork", type: "parallel-fork", label: "并行分叉", position: { x: 0, y: 60 } },
      { id: "plan", type: "role", label: "开发计划", roleId: role.id, position: { x: 200, y: 0 } },
      { id: "fill", type: "role", label: "任务回填", roleId: role.id, position: { x: 200, y: 120 } },
      { id: "join", type: "parallel-join", label: "并行汇合", position: { x: 400, y: 60 } },
    ],
    edges: [
      { id: "e-fork-plan", sourceNodeId: "fork", targetNodeId: "plan", dataMappings: [] },
      { id: "e-fork-fill", sourceNodeId: "fork", targetNodeId: "fill", dataMappings: [] },
      { id: "e-plan-join", sourceNodeId: "plan", targetNodeId: "join", dataMappings: [] },
      { id: "e-fill-join", sourceNodeId: "fill", targetNodeId: "join", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_parallel_continue" as any,
    status: "running",
    nodeStates: {
      fork: createNodeState("fork", "completed"),
      plan: createNodeState("plan", "running", { threadId: "thread-plan" as any }),
      fill: createNodeState("fill", "waiting-feedback", {
        threadId: "thread-fill" as any,
        humanActionSource: "human_input",
        error: "需要补充任务回填字段",
      }),
      join: createNodeState("join", "pending"),
    },
  };
  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const executedNodeIds: string[] = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
        get() { return null; },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() { return []; },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() { return role; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run_parallel_feedback",
    drivePromise: null,
  });
  (engine as any).executeNode = async (_instanceId: string, node: WorkflowNode) => {
    executedNodeIds.push(node.id);
    const nodeState = instance.nodeStates[node.id];
    if (nodeState) {
      nodeState.status = "completed";
      instance.nodeStates[node.id] = nodeState;
    }
  };

  await engine.submitFeedback(instance.id, "fill", "resume_with_input", { feedback: "已补充字段映射" });

  assert.equal(instance.nodeStates.fill.status, "ready");
  await nextTimerTick();
  await nextTimerTick();
  assert.deepEqual(executedNodeIds, ["fill"]);
  assert.equal(instance.nodeStates.plan.status, "running");
  assert.equal(instance.nodeStates.fill.status, "completed");
  assert.equal(feedbackRecords[0]?.action, "resume_with_input");
  assert.ok(orchEvents.some((event) =>
    event.type === "orchestration.nodeStateChanged"
    && JSON.parse(String(event.payloadJson ?? "{}")).nodeId === "fill"
    && JSON.parse(String(event.payloadJson ?? "{}")).status === "queued"));
});

test("submitFeedback resume_with_input starts a ready parallel branch while sibling is still waiting-feedback", async () => {
  const role = createRole({ name: "并行任务" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_parallel_waiting_continue" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "并行等待分支继续",
    description: "并行等待分支继续",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "fork", type: "parallel-fork", label: "并行分叉", position: { x: 0, y: 60 } },
      { id: "plan", type: "role", label: "开发计划", roleId: role.id, position: { x: 200, y: 0 } },
      { id: "fill", type: "role", label: "任务回填", roleId: role.id, position: { x: 200, y: 120 } },
      { id: "join", type: "parallel-join", label: "并行汇合", position: { x: 400, y: 60 } },
    ],
    edges: [
      { id: "e-fork-plan", sourceNodeId: "fork", targetNodeId: "plan", dataMappings: [] },
      { id: "e-fork-fill", sourceNodeId: "fork", targetNodeId: "fill", dataMappings: [] },
      { id: "e-plan-join", sourceNodeId: "plan", targetNodeId: "join", dataMappings: [] },
      { id: "e-fill-join", sourceNodeId: "fill", targetNodeId: "join", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_parallel_waiting_continue" as any,
    status: "waiting-feedback",
    nodeStates: {
      fork: createNodeState("fork", "completed"),
      plan: createNodeState("plan", "waiting-feedback", {
        threadId: "thread-plan" as any,
        humanActionSource: "human_input",
        error: "需要补充开发计划",
      }),
      fill: createNodeState("fill", "waiting-feedback", {
        threadId: "thread-fill" as any,
        humanActionSource: "human_input",
        error: "需要补充任务回填字段",
      }),
      join: createNodeState("join", "pending"),
    },
  };
  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const executedNodeIds: string[] = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
        get() { return null; },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() { return []; },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() { return role; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).reconcileRecoveredInstance = async () => {};
  (engine as any).executeNode = async (_instanceId: string, node: WorkflowNode) => {
    executedNodeIds.push(node.id);
    const nodeState = instance.nodeStates[node.id];
    if (nodeState) {
      nodeState.status = "completed";
      instance.nodeStates[node.id] = nodeState;
    }
  };

  await engine.submitFeedback(instance.id, "fill", "resume_with_input", { feedback: "已补充字段映射" });

  assert.equal(instance.nodeStates.fill.status, "ready");
  assert.equal(instance.nodeStates.plan.status, "waiting-feedback");
  assert.equal(instance.status, "waiting-feedback");
  assert.equal((engine as any).runningInstances.has(instance.id), false);
  await nextTimerTick();
  await nextTimerTick();
  await nextTimerTick();
  assert.deepEqual(executedNodeIds, ["fill"]);
  assert.equal(instance.nodeStates.fill.status, "completed");
  assert.equal(instance.nodeStates.plan.status, "waiting-feedback");
  assert.equal(instance.nodeStates.join.status, "pending");
  assert.equal(instance.status, "waiting-feedback");
  assert.equal(feedbackRecords[0]?.action, "resume_with_input");
  assert.ok(orchEvents.some((event) =>
    event.type === "orchestration.nodeStateChanged"
    && JSON.parse(String(event.payloadJson ?? "{}")).nodeId === "fill"
    && JSON.parse(String(event.payloadJson ?? "{}")).status === "queued"));
});

test("submitFeedback parallel continuation completes after the original driver settles", async () => {
  const role = createRole({ name: "并行任务" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_parallel_late_finish" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "并行补充晚完成",
    description: "并行补充晚完成",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "fork", type: "parallel-fork", label: "并行分叉", position: { x: 0, y: 60 } },
      { id: "plan", type: "role", label: "开发计划", roleId: role.id, position: { x: 200, y: 0 } },
      { id: "fill", type: "role", label: "任务回填", roleId: role.id, position: { x: 200, y: 120 } },
      { id: "join", type: "parallel-join", label: "并行汇合", position: { x: 400, y: 60 } },
    ],
    edges: [
      { id: "e-fork-plan", sourceNodeId: "fork", targetNodeId: "plan", dataMappings: [] },
      { id: "e-fork-fill", sourceNodeId: "fork", targetNodeId: "fill", dataMappings: [] },
      { id: "e-plan-join", sourceNodeId: "plan", targetNodeId: "join", dataMappings: [] },
      { id: "e-fill-join", sourceNodeId: "fill", targetNodeId: "join", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_parallel_late_finish" as any,
    status: "running",
    nodeStates: {
      fork: createNodeState("fork", "completed"),
      plan: createNodeState("plan", "completed", { threadId: "thread-plan" as any }),
      fill: createNodeState("fill", "waiting-feedback", {
        threadId: "thread-fill" as any,
        humanActionSource: "human_input",
        error: "需要补充任务回填字段",
      }),
      join: createNodeState("join", "pending"),
    },
  };
  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const executedNodeIds: string[] = [];
  let releaseFill: () => void = () => {
    throw new Error("fill continuation was not started");
  };
  let releaseOriginalDriver: () => void = () => {
    throw new Error("original driver was not awaited");
  };
  let fillStarted = false;
  const activeState: { paused: boolean; cancelled: boolean; runId: string; drivePromise: Promise<void> | null } = {
    paused: false,
    cancelled: false,
    runId: "run_parallel_late_finish",
    drivePromise: null,
  };
  activeState.drivePromise = new Promise<void>((resolve) => {
    releaseOriginalDriver = resolve;
  }).finally(() => {
    activeState.drivePromise = null;
  });
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
        get() { return null; },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() { return []; },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() { return role; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).runningInstances.set(instance.id, activeState);
  (engine as any).executeNode = async (_instanceId: string, node: WorkflowNode) => {
    executedNodeIds.push(node.id);
    if (node.id === "fill") {
      fillStarted = true;
      await new Promise<void>((resolve) => {
        releaseFill = resolve;
      });
    }
    const nodeState = instance.nodeStates[node.id];
    if (nodeState) {
      nodeState.status = "completed";
      nodeState.completedAt = Date.now();
      instance.nodeStates[node.id] = nodeState;
    }
  };

  await engine.submitFeedback(instance.id, "fill", "resume_with_input", { feedback: "已补充字段映射" });
  await nextTimerTick();

  assert.equal(fillStarted, false);
  releaseOriginalDriver();
  await nextTimerTick();
  await nextTimerTick();
  assert.equal(fillStarted, true);
  assert.equal(instance.nodeStates.fill.status, "queued");
  assert.ok(releaseFill);
  releaseFill();
  await nextTimerTick();
  await nextTimerTick();

  assert.deepEqual(executedNodeIds, ["fill", "join"]);
  assert.equal(instance.nodeStates.fill.status, "completed");
  assert.equal(instance.nodeStates.join.status, "completed");
  assert.equal(instance.status, "completed");
  assert.ok(orchEvents.some((event) => event.type === "orchestration.completed"));
});

test("submitFeedback approve carries human approval feedback into the next role context", async () => {
  const role = createRole({ name: "审核节点" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_approval_note" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "审核通过备注下传",
    description: "审核通过备注下传",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
      { id: "implementation", type: "role", label: "开发实现", roleId: role.id, position: { x: 180, y: 0 } },
    ],
    edges: [
      { id: "e-a-i", sourceNodeId: "analysis", targetNodeId: "implementation", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_approval_note" as any,
    status: "paused",
    nodeStates: {
      analysis: createNodeState("analysis", "waiting-approval", {
        conclusion: {
          nextAction: "continue",
          reviewVerdict: "pass",
          summary: "当前节点交付满足要求。",
          blockingIssues: null,
          acceptanceChecks: null,
          humanInput: null,
          rework: null,
          decidedBy: "model",
          decidedAt: 20,
        },
      }),
      implementation: createNodeState("implementation", "pending"),
    },
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
        get(recordId: string) {
          return feedbackRecords.find((record) => record.id === recordId) ?? null;
        },
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
        get() {
          return null;
        },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append() {},
      },
      orchRoles: {
        get() {
          return role;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  await engine.submitFeedback(instance.id, "analysis", "approve", { feedback: "下一个节点请严格按这次人工确认边界继续实现。" });

  assert.equal(instance.nodeStates.analysis.status, "completed");
  assert.equal(instance.nodeStates.implementation.status, "pending");
  assert.equal(instance.status, "paused");
  assert.equal(feedbackRecords.length, 2);
  assert.equal(feedbackRecords[0]?.action, "approve");
  assert.equal(feedbackRecords[1]?.action, "system_approval_note");
  assert.deepEqual(instance.nodeStates.implementation.activeFeedbackRecordIds, ["feedback_2" as any]);
  const context = (engine as any).collectFeedbackContext(instance, "implementation");
  assert.match(String(context.feedbackPatch ?? ""), /上游审核补充意见/);
  assert.match(String(context.feedbackPatch ?? ""), /严格按这次人工确认边界继续实现/);
  assert.equal(context.latestAction, "system_approval_note");
});

test("executeRoleNode applies maxRetries to ordinary and recovery-coded failures", async () => {
  const role = createRole({
    name: "开发实现",
    executionConfig: createExecutionConfig({
      preferredEngine: "codex",
      codex: {
        mode: "custom",
        customConfig: {
          model: "gpt-5.5",
          effort: "medium",
          accessMode: "current",
          maxRetries: 2,
        },
      },
    }),
  });
  const workflow: WorkflowDefinition = {
    id: "wf_manual_interrupt_wait_feedback" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "手动中断等待反馈",
    description: "手动中断等待反馈",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_manual_interrupt_wait_feedback" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_manual_interrupt_wait_feedback" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "手动中断等待反馈",
      goal: "手动中断等待反馈",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      analysis: createNodeState("analysis", "pending"),
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const orchEvents: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateArtifactIndex() {},
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
        get() {
          return null;
        },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        replaceForArtifact() {},
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run_manual_interrupt_wait_feedback",
    drivePromise: null,
  });
  (engine as any).executeSubThread = async () => {
    const error = new Error("turn interrupted") as Error & {
      code?: string;
      terminationKind?: "manual_interrupt";
    };
    error.code = MANUAL_TURN_INTERRUPT_CODE;
    error.terminationKind = "manual_interrupt";
    throw error;
  };

  await (engine as any).executeRoleNode(instance.id, workflow.nodes[0], instance);

  assert.equal(instance.nodeStates.analysis.status, "waiting-feedback");
  assert.equal(instance.nodeStates.analysis.retryCount, 0);
  assert.equal(instance.nodeStates.analysis.humanActionSource, "execution");
  assert.equal(instance.nodeStates.analysis.error, "turn interrupted");
  assert.ok(orchEvents.some((event) =>
    event.type === "orchestration.feedbackRequested"
    && JSON.parse(String(event.payloadJson ?? "{}")).reason === "turn interrupted"));

  const firstExecutionId = instance.nodeStates.analysis.nodeExecutionId;
  assert.ok(firstExecutionId);
  assert.equal(instance.nodeStates.analysis.attemptId, firstExecutionId);
  (engine as any).executeSubThread = async () => {
    const error = new Error("automatic failure") as Error & { code?: string };
    error.code = "session_invalidated";
    throw error;
  };

  await (engine as any).executeRoleNode(instance.id, workflow.nodes[0], instance);

  const automaticFailurePayload = orchEvents
    .filter((event) => event.type === "orchestration.nodeStateChanged")
    .map((event) => JSON.parse(String(event.payloadJson ?? "{}")))
    .find((payload) => payload.status === "failed" && payload.nodeState?.error === "automatic failure");
  const failedAutomaticExecutionId = String(automaticFailurePayload?.nodeExecutionId ?? "");
  const readyAfterAutomaticRetryId = instance.nodeStates.analysis.nodeExecutionId;
  assert.equal(instance.nodeStates.analysis.status, "ready");
  assert.equal(instance.nodeStates.analysis.retryCount, 1);
  assert.equal(instance.nodeStates.analysis.attemptNo, 3);
  assert.equal(instance.nodeStates.analysis.parentExecutionId, failedAutomaticExecutionId);
  assert.equal(instance.nodeStates.analysis.attemptId, readyAfterAutomaticRetryId);
  assert.ok(failedAutomaticExecutionId);
  assert.notEqual(failedAutomaticExecutionId, firstExecutionId);
  assert.ok(readyAfterAutomaticRetryId);
  assert.notEqual(readyAfterAutomaticRetryId, failedAutomaticExecutionId);
  assert.equal(instance.nodeStates.analysis.startedAt, null);
  assert.equal(instance.nodeStates.analysis.completedAt, null);
  assert.equal(automaticFailurePayload?.attemptNo, 2);

  (engine as any).handleRecoveredRoleError(
    instance.id,
    workflow.nodes[0],
    instance,
    role,
    "recovered failure",
    "codex_thread_resume_unconfirmed",
    "thread-recovered",
    "turn-recovered",
  );

  const readyAfterRecoveredRetryId = instance.nodeStates.analysis.nodeExecutionId;
  assert.equal(instance.nodeStates.analysis.status, "ready");
  assert.equal(instance.nodeStates.analysis.retryCount, 2);
  assert.equal(instance.nodeStates.analysis.attemptNo, 4);
  assert.equal(instance.nodeStates.analysis.parentExecutionId, readyAfterAutomaticRetryId);
  assert.equal(instance.nodeStates.analysis.attemptId, readyAfterRecoveredRetryId);
  assert.ok(readyAfterRecoveredRetryId);
  assert.notEqual(readyAfterRecoveredRetryId, readyAfterAutomaticRetryId);
  assert.equal(instance.nodeStates.analysis.startedAt, null);
  assert.equal(instance.nodeStates.analysis.completedAt, null);
  assert.ok(orchEvents.some((event) => {
    if (event.type !== "orchestration.nodeStateChanged") return false;
    const payload = JSON.parse(String(event.payloadJson ?? "{}"));
    return payload.nodeExecutionId === readyAfterAutomaticRetryId && payload.status === "failed";
  }));
});

test("executeRoleNode applies failPolicy to session-invalidated errors and preserves the code", async () => {
  const role = createRole({ id: "role_structured_session_error" as any, name: "结构化会话错误" });
  const node: WorkflowNode = {
    id: "analysis",
    type: "role",
    roleId: role.id,
    label: "分析",
    failPolicy: "skip",
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  instance.status = "running";
  instance.nodeStates.analysis = createNodeState(node.id, "pending", {
    activeFeedbackRecordIds: ["feedback_resume" as any],
  });
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run_structured_session_error",
    drivePromise: null,
  });
  (engine as any).executeSubThread = async () => {
    const error = new Error("当前 Codex 会话缺少本轮必需的动态工具绑定") as Error & { code?: string };
    error.code = "session_invalidated";
    throw error;
  };

  await (engine as any).executeRoleNode(instance.id, node, instance);

  assert.equal(instance.nodeStates.analysis.status, "skipped");
  assert.equal(instance.nodeStates.analysis.errorCode, "session_invalidated");
});

test("beginNodeAttempt adopts a legacy execution identity into the persistent attempt repository", () => {
  const role = createRole({ name: "开发实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_adopt_legacy_execution" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "收编旧执行身份",
    description: "收编旧执行身份",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  instance.id = "orch_adopt_legacy_execution" as any;
  instance.status = "running";
  instance.nodeStates.analysis = {
    ...createNodeState("analysis", "ready"),
    attemptId: null,
    nodeExecutionId: "legacy-execution-7",
    attemptNo: 7,
    parentExecutionId: "legacy-execution-6",
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);

  const attempt = (engine as any).beginNodeAttempt(instance.id, workflow.nodes[0], instance);

  assert.equal(attempt.id, "legacy-execution-7");
  assert.equal(attempt.attemptNo, 7);
  assert.equal(instance.nodeStates.analysis.attemptId, attempt.id);
  assert.equal(instance.nodeStates.analysis.nodeExecutionId, attempt.id);
  assert.equal(instance.nodeStates.analysis.attemptNo, attempt.attemptNo);
  assert.equal(instance.nodeStates.analysis.parentExecutionId, "legacy-execution-6");
  assert.equal((engine as any).ctx.db.orchNodeAttempts.get(attempt.id)?.status, "running");
});

test("beginNodeAttempt does not link a legacy execution id owned by another node", () => {
  const role = createRole({ name: "开发实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_reject_foreign_legacy_execution" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "拒绝跨节点执行血缘",
    description: "拒绝跨节点执行血缘",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  instance.id = "orch_reject_foreign_legacy_execution" as any;
  instance.status = "running";
  instance.nodeStates.analysis = {
    ...createNodeState("analysis", "ready"),
    attemptId: null,
    nodeExecutionId: "foreign-execution",
    attemptNo: 4,
    parentExecutionId: null,
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  (engine as any).ctx.db.orchNodeAttempts.begin({
    instanceId: "other-instance",
    nodeId: "other-node",
    id: "foreign-execution",
    attemptNo: 4,
  });

  const attempt = (engine as any).beginNodeAttempt(instance.id, workflow.nodes[0], instance);

  assert.notEqual(attempt.id, "foreign-execution");
  assert.equal(instance.nodeStates.analysis.attemptId, attempt.id);
  assert.equal(instance.nodeStates.analysis.nodeExecutionId, attempt.id);
  assert.equal(instance.nodeStates.analysis.parentExecutionId, null);
});

function createManualCompletionHarness(status: NodeExecutionState["status"] = "running") {
  const role = createRole({ name: "手动完成测试" });
  const workflow = createWorkflow([
    { id: "analysis", type: "role", label: "评审", roleId: role.id, position: { x: 0, y: 0 } },
    { id: "sibling", type: "role", label: "并行作业", roleId: role.id, position: { x: 0, y: 100 } },
    { id: "end", type: "end", label: "结束", position: { x: 180, y: 0 } },
  ], [{ id: "analysis-end", sourceNodeId: "analysis", targetNodeId: "end", dataMappings: [] }]);
  const instance = createInstance(role, workflow);
  instance.status = "running";
  instance.nodeStates = {
    analysis: createNodeState("analysis", status, { threadId: "thread-manual-complete" as ThreadId }),
    sibling: createNodeState("sibling", "running", { threadId: "thread-sibling" as ThreadId }),
    end: createNodeState("end", "pending"),
  };
  const { engine, orchestrationEvents } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const ctx = (engine as any).ctx;
  const attempt = ctx.db.orchNodeAttempts.begin({ instanceId: instance.id, nodeId: "analysis" });
  instance.nodeStates.analysis.attemptId = attempt.id;
  instance.nodeStates.analysis.attemptNo = attempt.attemptNo;
  ctx.db.turns = {
    listRunningByWorkspace() {
      return {
        "thread-manual-complete": { runningTurnId: "turn-manual-complete" },
        "thread-sibling": { runningTurnId: "turn-sibling" },
      };
    },
  };
  let scheduled = 0;
  (engine as any).scheduleActiveRunAfterFeedback = () => { scheduled += 1; };
  return { engine, instance, ctx, attempt, orchestrationEvents, get scheduled() { return scheduled; } };
}

test("manual completion stops the current turn before completing and preserves concurrent sibling progress", async () => {
  const harness = createManualCompletionHarness();
  const { engine, instance, ctx, attempt, orchestrationEvents } = harness;
  const interrupts: string[] = [];
  let releaseInterrupt!: () => void;
  const stopped = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
  ctx.sessions.interrupt = async (threadId: ThreadId, turnId: string) => {
    interrupts.push(threadId + ":" + turnId);
    await stopped;
    return true;
  };
  const completion = engine.submitFeedback(instance.id, "analysis", "override");
  await nextTimerTick();
  assert.deepEqual(interrupts, ["thread-manual-complete:turn-manual-complete"]);
  assert.equal(instance.nodeStates.analysis.status, "running");
  assert.equal(instance.nodeStates.end.status, "pending");
  assert.equal(harness.scheduled, 0);

  // 模拟中断等待期间另一个节点落盘；真实仓储每次 get 都返回新的实例对象。
  const latest = structuredClone(instance);
  latest.nodeStates.sibling.status = "completed";
  ctx.db.orchInstances.get = () => structuredClone(latest);
  ctx.db.orchInstances.updateNodeStates = (_id: string, states: OrchestrationInstance["nodeStates"]) => {
    latest.nodeStates = structuredClone(states);
  };
  releaseInterrupt();
  await completion;

  assert.equal(latest.nodeStates.analysis.status, "completed");
  assert.equal(latest.nodeStates.analysis.conclusion?.decidedBy, "human");
  assert.equal(latest.nodeStates.sibling.status, "completed");
  assert.equal(latest.nodeStates.analysis.threadId, "thread-manual-complete");
  assert.equal(ctx.db.orchNodeAttempts.get(attempt.id).status, "completed");
  assert.equal(harness.scheduled, 1);
  assert.equal((engine as any).canContinueNodeAttempt(instance.id, instance.workflowSnapshot.nodes[0], attempt.id, "late-agent-result"), false);
  assert.equal(orchestrationEvents.some((event) => event.type === "orchestration.feedbackRequested"), false);
});

test("manual completion leaves the node unfinished when the provider rejects interruption", async () => {
  const harness = createManualCompletionHarness();
  const { engine, instance, ctx, attempt, orchestrationEvents } = harness;
  const failure = new Error("provider interruption failed");
  ctx.sessions.interrupt = async () => { throw failure; };

  await assert.rejects(engine.submitFeedback(instance.id, "analysis", "override"), (error) => error === failure);

  assert.equal(instance.nodeStates.analysis.status, "running");
  assert.equal(instance.nodeStates.analysis.conclusion, undefined);
  assert.equal(ctx.db.orchNodeAttempts.get(attempt.id).status, "running");
  assert.deepEqual(instance.nodeStates.analysis.feedbackRecordIds, []);
  assert.equal(harness.scheduled, 0);
  assert.equal(orchestrationEvents.some((event) => JSON.parse(event.payloadJson).status === "completed"), false);
});

test("manual completion still works when the current turn has already ended", async () => {
  const harness = createManualCompletionHarness("waiting-feedback");
  const { engine, instance, ctx } = harness;
  ctx.db.turns.listRunningByWorkspace = () => ({});
  ctx.sessions.interrupt = async () => { assert.fail("没有活跃 turn 时不应调用中断"); };

  await engine.submitFeedback(instance.id, "analysis", "override");

  assert.equal(instance.nodeStates.analysis.status, "completed");
  assert.equal(instance.nodeStates.sibling.status, "running");
  assert.equal(harness.scheduled, 1);
});

test("manual completion accepts the session layer reporting that a turn has already stopped", async () => {
  const harness = createManualCompletionHarness();
  const { engine, instance, ctx } = harness;
  ctx.sessions.interrupt = async () => false;

  await engine.submitFeedback(instance.id, "analysis", "override");

  assert.equal(instance.nodeStates.analysis.status, "completed");
  assert.equal(harness.scheduled, 1);
});

test("manual completion does not complete a replacement execution started during interruption", async () => {
  const harness = createManualCompletionHarness();
  const { engine, instance, ctx } = harness;
  ctx.sessions.interrupt = async () => {
    const nextAttempt = ctx.db.orchNodeAttempts.begin({ instanceId: instance.id, nodeId: "analysis" });
    instance.nodeStates.analysis.attemptId = nextAttempt.id;
    instance.nodeStates.analysis.attemptNo = nextAttempt.attemptNo;
    return true;
  };

  await assert.rejects(engine.submitFeedback(instance.id, "analysis", "override"), /当前节点执行已变化/);

  assert.equal(instance.nodeStates.analysis.status, "running");
  assert.equal(instance.nodeStates.analysis.conclusion, undefined);
  assert.equal(harness.scheduled, 0);
});

test("manual completion cancels the current AI gate as well as the node turn", async () => {
  const harness = createManualCompletionHarness("gate-checking");
  const { engine, instance, ctx } = harness;
  const gate = { id: "gate-manual-complete", nodeId: "analysis", status: "running", statusVersion: 1 };
  const siblingGate = { id: "gate-sibling", nodeId: "sibling", status: "running", statusVersion: 1 };
  instance.nodeStates.analysis.activeGateEvaluation = {
    evaluationRunId: gate.id, threadId: "thread-gate", turnId: "turn-gate",
  } as NodeExecutionState["activeGateEvaluation"];
  ctx.db.orchGateEvaluationRuns = {
    listRecoverable() { return [gate, siblingGate]; },
    get() { return gate; },
    updateCas(id: string, _version: number, patch: { status: string }) {
      assert.equal(id, gate.id);
      gate.status = patch.status;
      return true;
    },
  };
  const interrupts: string[] = [];
  ctx.sessions.interrupt = async (threadId: ThreadId, turnId: string) => {
    interrupts.push(threadId + ":" + turnId);
    return true;
  };

  await engine.submitFeedback(instance.id, "analysis", "override");

  assert.deepEqual(interrupts, ["thread-gate:turn-gate", "thread-manual-complete:turn-manual-complete"]);
  assert.equal(gate.status, "cancelled");
  assert.equal(siblingGate.status, "running");
  assert.equal(instance.nodeStates.analysis.status, "completed");
  assert.equal(harness.scheduled, 1);
});

test("cancelNode immediately settles an interrupted active Attempt to waiting-feedback", async () => {
  const role = createRole({ name: "开发实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_cancel_node_attempt" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "停止节点收敛",
    description: "停止节点收敛",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  instance.id = "orch_cancel_node_attempt" as any;
  instance.status = "running";
  instance.nodeStates = {
    analysis: createNodeState("analysis", "running", { threadId: "thread-cancel-node" as any }),
  };
  const { engine, orchestrationEvents } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const attempt = (engine as any).ctx.db.orchNodeAttempts.begin({
    instanceId: instance.id,
    nodeId: "analysis",
  });
  instance.nodeStates.analysis.attemptId = attempt.id;
  instance.nodeStates.analysis.attemptNo = attempt.attemptNo;
  (engine as any).ctx.db.turns = {
    listRunningByWorkspace() {
      return { "thread-cancel-node": { runningTurnId: "turn-cancel-node" } };
    },
  };
  const interrupts: Array<{ threadId: string; turnId: string }> = [];
  (engine as any).ctx.sessions = {
    async interrupt(threadId: ThreadId, turnId: string) {
      interrupts.push({ threadId: String(threadId), turnId });
      return true;
    },
  };

  await engine.cancelNode(instance.id, "analysis");

  assert.deepEqual(interrupts, [{ threadId: "thread-cancel-node", turnId: "turn-cancel-node" }]);
  assert.equal(instance.nodeStates.analysis.status, "waiting-feedback");
  assert.equal(instance.nodeStates.analysis.humanActionSource, "execution");
  assert.equal(instance.nodeStates.analysis.error, "用户已停止节点执行");
  assert.equal((engine as any).ctx.db.orchNodeAttempts.get(attempt.id)?.status, "invalidated");
  assert.ok(orchestrationEvents.some((event) => event.type === "orchestration.feedbackRequested"));
});

test("a current node Attempt cannot write back after the instance has failed", () => {
  const role = createRole({ name: "开发实现" });
  const workflow = createWorkflow([
    { id: "analysis", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
  ], []);
  const instance = createInstance(role, workflow);
  instance.id = "orch_failed_attempt_writeback" as any;
  instance.status = "running";
  instance.nodeStates = { analysis: createNodeState("analysis", "running") };
  const { engine, orchestrationEvents } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const attempt = (engine as any).ctx.db.orchNodeAttempts.begin({
    instanceId: instance.id,
    nodeId: "analysis",
  });
  instance.nodeStates.analysis.attemptId = attempt.id;
  instance.nodeStates.analysis.attemptNo = attempt.attemptNo;
  instance.status = "failed";

  assert.equal(
    (engine as any).canContinueNodeAttempt(instance.id, workflow.nodes[0], attempt.id, "late-writeback"),
    false,
  );
  assert.ok(orchestrationEvents.some((event) => event.type === "orchestration.nodeAttemptRejected"));
});

test("pause interrupts running role node and requeues it for resume-current-node", async () => {
  const role = createRole({ name: "开发实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_pause_interrupts_running_node" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "暂停中断当前节点",
    description: "暂停中断当前节点",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const threadId = "orch_pause_thread" as ThreadId;
  const instance: OrchestrationInstance = {
    id: "orch_pause_interrupts_running_node" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_pause_interrupts_running_node" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "暂停中断当前节点",
      goal: "暂停中断当前节点",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      analysis: createNodeState("analysis", "running", {
        threadId,
        startedAt: 10,
        inputArtifactIds: ["artifact_input" as any],
      }),
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const interrupts: Array<{ threadId: ThreadId; turnId: string }> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      turns: {
        listRunningByWorkspace() {
          return { [threadId]: { runningTurnId: "turn_pause_1" } };
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {
      async interrupt(interruptThreadId: ThreadId, turnId: string) {
        interrupts.push({ threadId: interruptThreadId, turnId });
        return true;
      },
    } as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run_pause_interrupts_running_node",
    drivePromise: null,
  });

  await engine.pause(instance.id);

  assert.equal(instance.status, "paused");
  assert.equal((engine as any).runningInstances.get(instance.id).paused, true);
  assert.deepEqual(interrupts, [{ threadId, turnId: "turn_pause_1" }]);
  assert.equal(instance.nodeStates.analysis.status, "ready");
  assert.equal(instance.nodeStates.analysis.error, null);
  assert.equal(instance.nodeStates.analysis.humanActionSource, null);
  assert.equal(instance.nodeStates.analysis.startedAt, null);
  assert.deepEqual(instance.nodeStates.analysis.feedbackRecordIds, ["feedback_1" as any]);
  assert.deepEqual(instance.nodeStates.analysis.activeFeedbackRecordIds, ["feedback_1" as any]);
  assert.equal(feedbackRecords[0]?.action, "system_human_input");
  assert.match(String(feedbackRecords[0]?.feedback ?? ""), /流程已暂停/);
  assert.deepEqual(feedbackRecords[0]?.artifactIds, ["artifact_input"]);
  assert.ok(orchEvents.some((event) =>
    event.type === "orchestration.nodeStateChanged"
    && JSON.parse(String(event.payloadJson ?? "{}")).nodeId === "analysis"
    && JSON.parse(String(event.payloadJson ?? "{}")).status === "ready"));
  assert.ok(orchEvents.some((event) =>
    event.type === "orchestration.paused"
    && JSON.parse(String(event.payloadJson ?? "{}")).pausedNodeIds?.includes("analysis")));
});

test("normalizePersistedInstanceStatuses requeues paused active nodes left by older pause semantics", () => {
  const role = createRole({ name: "原型设计" });
  const workflow: WorkflowDefinition = {
    id: "wf_pause_startup_normalize" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "暂停启动收敛",
    description: "暂停启动收敛",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "ui", type: "role", label: "原型设计", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_pause_startup_normalize" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_pause_startup_normalize" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "暂停启动收敛",
      goal: "暂停启动收敛",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "paused",
    nodeStates: {
      ui: createNodeState("ui", "running", {
        threadId: "orch_pause_startup_thread" as ThreadId,
        error: null,
        startedAt: 20,
      }),
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      workspaces: {
        list() {
          return [{ id: workflow.workspaceId, path: emptyWorkspace }];
        },
      },
      orchInstances: {
        listByWorkspace() {
          return [instance];
        },
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  engine.normalizePersistedInstanceStatuses();

  assert.equal(instance.status, "paused");
  assert.equal(instance.nodeStates.ui.status, "ready");
  assert.equal(instance.nodeStates.ui.error, null);
  assert.equal(instance.nodeStates.ui.humanActionSource, null);
  assert.deepEqual(instance.nodeStates.ui.activeFeedbackRecordIds, ["feedback_1" as any]);
  assert.equal(feedbackRecords[0]?.action, "system_human_input");
  assert.match(String(feedbackRecords[0]?.feedback ?? ""), /暂停流程仍有执行中节点/);
  assert.ok(orchEvents.some((event) =>
    event.type === "orchestration.nodeStateChanged"
    && JSON.parse(String(event.payloadJson ?? "{}")).nodeId === "ui"
    && JSON.parse(String(event.payloadJson ?? "{}")).status === "ready"));
});

test("submitFeedback resume_with_input recreates a missing active run state before continuing", async () => {
  const role = createRole({ name: "开发实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_resume_rehydrates_state" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "反馈后恢复执行态",
    description: "反馈后恢复执行态",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "analysis", type: "role", label: "开发实现", roleId: role.id, position: { x: 180, y: 0 } },
      { id: "end", type: "end", label: "结束", position: { x: 360, y: 0 } },
    ],
    edges: [
      { id: "e-start-analysis", sourceNodeId: "start", targetNodeId: "analysis", dataMappings: [] },
      { id: "e-analysis-end", sourceNodeId: "analysis", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_feedback_resume_rehydrates_state" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_feedback_resume_rehydrates_state" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "恢复执行态",
      goal: "恢复执行态",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "waiting-feedback",
    nodeStates: {
      start: createNodeState("start", "completed", { completedAt: 5 }),
      analysis: createNodeState("analysis", "waiting-feedback", {
        startedAt: 10,
        humanActionSource: "execution",
        error: "Codex turn ended as interrupted",
      }),
      end: createNodeState("end", "pending"),
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const feedbackRecords: Array<Record<string, unknown>> = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const driveCalls: Array<Record<string, unknown>> = [];
  const reconcileCalls: string[] = [];
  const callOrder: string[] = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
        get() {
          return null;
        },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return null;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).reconcileRecoveredInstance = async (instanceId: string) => {
    callOrder.push("reconcile");
    reconcileCalls.push(instanceId);
  };
  (engine as any).startCoordinator = async (instanceId: string, state: Record<string, unknown>) => {
    callOrder.push("drive");
    driveCalls.push({
      instanceId,
      hasEntry: (engine as any).runningInstances.get(instanceId) === state,
      paused: state.paused,
      cancelled: state.cancelled,
    });
  };

  await engine.submitFeedback(instance.id, "analysis", "resume_with_input", { feedback: "继续" });

  assert.equal(instance.nodeStates.analysis.status, "ready");
  assert.equal(instance.nodeStates.analysis.error, null);
  assert.equal(instance.nodeStates.analysis.humanActionSource, null);
  assert.deepEqual(instance.nodeStates.analysis.activeFeedbackRecordIds, ["feedback_1" as any]);
  assert.equal(instance.status, "running");
  assert.equal(feedbackRecords.length, 1);
  assert.equal(feedbackRecords[0]?.source, "execution");
  assert.equal((engine as any).runningInstances.has(instance.id), false);
  assert.deepEqual(reconcileCalls, []);
  assert.deepEqual(callOrder, []);

  await nextTimerTick();

  assert.equal((engine as any).runningInstances.has(instance.id), true);
  assert.deepEqual(reconcileCalls, [instance.id]);
  assert.deepEqual(callOrder, ["reconcile", "drive"]);
  assert.equal(driveCalls.length, 1);
  assert.equal(driveCalls[0]?.instanceId, instance.id);
  assert.equal(driveCalls[0]?.hasEntry, true);
  assert.equal(driveCalls[0]?.paused, false);
  assert.equal(driveCalls[0]?.cancelled, false);
  assert.ok(orchEvents.some((event) =>
    event.type === "orchestration.nodeStateChanged"
    && JSON.parse(String(event.payloadJson ?? "{}")).nodeId === "analysis"
    && JSON.parse(String(event.payloadJson ?? "{}")).status === "ready"));
});

test("reconcileExecutionInterruptedTurnCompletion recreates a missing active run state before resuming", async () => {
  const { engine, instance, threadId, orchEvents, conversationEvents } = createExecutionInterruptedRealtimeHarness();
  (engine as any).runningInstances.delete(instance.id);
  appendRecoveredNodeResultTurn(conversationEvents, {
    workspaceId: instance.workspaceId,
    threadId,
    turnId: "turn_ui_resume_missing_state" as any,
    submission: createTextFinalAnswer("原型设计已补齐并可继续。"),
    responseText: "原型设计已补齐并可继续。",
  });

  const reconcileCalls: string[] = [];
  const driveCalls: Array<Record<string, unknown>> = [];
  const callOrder: string[] = [];
  (engine as any).reconcileRecoveredInstance = async (instanceId: string) => {
    callOrder.push("reconcile");
    reconcileCalls.push(instanceId);
  };
  (engine as any).driveInstance = async (instanceId: string, state: Record<string, unknown>) => {
    callOrder.push("drive");
    driveCalls.push({
      instanceId,
      hasEntry: (engine as any).runningInstances.get(instanceId) === state,
      paused: state.paused,
      cancelled: state.cancelled,
    });
  };

  await engine.reconcileExecutionInterruptedTurnCompletion({
    threadId,
    turnId: "turn_ui_resume_missing_state" as any,
    responseText: "原型设计已补齐并可继续。",
  });

  assert.deepEqual(reconcileCalls, [instance.id]);
  assert.equal((engine as any).runningInstances.has(instance.id), true);
  assert.deepEqual(callOrder, ["reconcile", "drive"]);
  assert.equal(driveCalls.length, 1);
  assert.equal(driveCalls[0]?.instanceId, instance.id);
  assert.equal(driveCalls[0]?.hasEntry, true);
  assert.equal(driveCalls[0]?.paused, false);
  assert.equal(driveCalls[0]?.cancelled, false);
  assert.ok(orchEvents.some((event) => {
    if (event.type !== "orchestration.nodeRecovered") return false;
    const payload = JSON.parse(String(event.payloadJson ?? "{}")) as Record<string, unknown>;
    return payload.action === "execution-feedback-turn-completed";
  }));
});

test("executeRoleNode ignores late final answers after instance cancellation", async () => {
  const role = createRole({ name: "需求分析" });
  const workflow: WorkflowDefinition = {
    id: "wf_cancel_late_result" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "取消后忽略迟到结果",
    description: "取消后忽略迟到结果",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_cancel_late_result" as any,
    status: "running",
    nodeStates: {
      analysis: createNodeState("analysis", "pending"),
    },
  };

  const events: Array<Record<string, unknown>> = [];
  let artifactCreateCount = 0;
  let resolveExecution!: (value: { rawOutput: string; finalAnswer: NodeFinalAnswerPayload }) => void;

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateArtifactIndex() {},
      },
      turns: {
        listRunningByWorkspace() {
          return {};
        },
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
        create() {
          artifactCreateCount += 1;
          throw new Error("cancelled run should not persist artifacts");
        },
        get() {
          return null;
        },
        updateStatus() {},
        updateWorkspace() {},
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        replaceForArtifact() {},
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          events.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run_cancel_late_result",
    drivePromise: Promise.resolve(),
  });
  (engine as any).executeSubThread = () => new Promise((resolve) => {
    resolveExecution = resolve;
  });

  const rolePromise = (engine as any).executeRoleNode(instance.id, workflow.nodes[0], instance);
  engine.cancel(instance.id);
  resolveExecution({
    rawOutput: JSON.stringify(createTextFinalAnswer("迟到结果")),
    finalAnswer: createTextFinalAnswer("迟到结果"),
  });
  await rolePromise;

  assert.equal(instance.status, "cancelled");
  assert.equal(instance.nodeStates.analysis.status, "cancelled");
  assert.equal(artifactCreateCount, 0);
  assert.equal(instance.nodeStates.analysis.outputArtifactIds?.length ?? 0, 0);
  assert.ok(events.some((event) => event.type === "orchestration.cancelled"));
  assert.ok(!events.some((event) => event.type === "orchestration.artifactWritten"));
});

test("executeRoleNode ignores late execution errors after instance cancellation", async () => {
  const role = createRole({ name: "开发实现" });
  const workflow: WorkflowDefinition = {
    id: "wf_cancel_late_error" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "取消后忽略迟到错误",
    description: "取消后忽略迟到错误",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "implementation", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_cancel_late_error" as any,
    status: "running",
    nodeStates: {
      implementation: createNodeState("implementation", "pending"),
    },
  };

  const events: Array<Record<string, unknown>> = [];
  let rejectExecution!: (error: Error) => void;

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      turns: {
        listRunningByWorkspace() {
          return {};
        },
      },
      orchArtifacts: {
        listByInstance() {
          return [];
        },
        listByNode() {
          return [];
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          events.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).runningInstances.set(instance.id, {
    paused: false,
    cancelled: false,
    runId: "run_cancel_late_error",
    drivePromise: Promise.resolve(),
  });
  (engine as any).executeSubThread = () => new Promise((_, reject) => {
    rejectExecution = reject;
  });

  const rolePromise = (engine as any).executeRoleNode(instance.id, workflow.nodes[0], instance);
  engine.cancel(instance.id);
  rejectExecution(new Error("迟到错误"));
  await rolePromise;

  assert.equal(instance.status, "cancelled");
  assert.equal(instance.nodeStates.implementation.status, "cancelled");
  assert.equal(instance.nodeStates.implementation.retryCount, 0);
  assert.ok(events.some((event) => event.type === "orchestration.cancelled"));
  assert.ok(!events.some((event) => event.type === "orchestration.feedbackRequested"));
});

test("finalizeRoleExecution puts ask_human conclusions into waiting-feedback and emits feedbackRequested", async () => {
  const role = createRole({ name: "需求分析" });
  const workflow: WorkflowDefinition = {
    id: "wf_finalize_ask_human" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "人工补充执行测试",
    description: "人工补充执行测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_finalize_ask_human" as any,
    status: "running",
    nodeStates: {
      analysis: createNodeState("analysis", "running"),
    },
  };
  instance.runtimeConfig = { ...instance.runtimeConfig, interactionMode: "unattended" };
  instance.nodeStates.analysis.threadId = "thread-analysis" as any;

  const artifacts: Artifact[] = [];
  const events: Array<Record<string, unknown>> = [];

  const engine = new OrchestrationEngine({
    db: {
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        create(input: Omit<Artifact, "createdAt" | "updatedAt" | "id">) {
          const created: Artifact = {
            ...input,
            id: `artifact_${artifacts.length + 1}` as any,
            createdAt: 10 + artifacts.length,
            updatedAt: 10 + artifacts.length,
          };
          artifacts.push(created);
          return created;
        },
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
      },
      orchArtifactFiles: {
        replaceForArtifact() {},
        listByArtifact() {
          return [];
        },
      },
      orchInstances: {
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
          instance.artifactIndex = artifactIndex as any;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          events.push(input);
          return input;
        },
      },
      orchRoles: {
        get() {
          return null;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  const finalAnswer = createTextFinalAnswer("需要用户补充部署目录", {
    control: { nextAction: "ask_human" },
    review: { verdict: "partial", summary: "当前还缺少部署目录信息" },
    humanInput: {
      summary: "请补充部署目录路径后继续",
      fields: [
        {
          key: "deployPath",
          label: "部署目录",
          valueType: "file-path",
          required: true,
          description: "需要写入发布说明的最终目录",
        },
      ],
    },
  });
  const attemptId = prepareSubmittedNodeAttempt(
    engine,
    instance,
    workflow.nodes[0],
    finalAnswer,
    "需要用户补充部署目录",
  );

  await (engine as any).finalizeRoleExecution(instance.id, workflow.nodes[0], instance, role, {
    rawOutput: "需要用户补充部署目录",
    finalAnswer,
  }, attemptId);

  assert.equal(instance.nodeStates.analysis.status, "waiting-feedback");
  assert.equal(instance.status, "waiting-feedback");
  assert.equal(instance.nodeStates.analysis.conclusion?.nextAction, "ask_human");
  assert.equal(instance.nodeStates.analysis.outputArtifactIds?.length, 1);
  assert.equal(artifacts[0]?.status, "draft");
  assert.ok(events.some((event) => {
    if (event.type !== "orchestration.feedbackRequested") return false;
    const payload = JSON.parse(String(event.payloadJson ?? "{}")) as Record<string, unknown>;
    return payload.source === "human_input";
  }));
});

test("submitFeedback resume_with_input keeps rejected ask artifact as feedback evidence", async () => {
  const role = createRole({ name: "需求分析" });
  const workflow: WorkflowDefinition = {
    id: "wf_feedback_ask_artifact" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "Ask 工件回传测试",
    description: "Ask 工件回传测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_feedback_ask_artifact" as any,
    status: "waiting-feedback",
    nodeStates: {
      analysis: createNodeState("analysis", "waiting-feedback", {
        humanActionSource: "human_input",
        error: "请补充部署目录路径后继续",
        outputArtifactIds: ["artifact_ask_result" as any],
      }),
    },
  };
  const askArtifact = createArtifact({
    id: "artifact_ask_result" as any,
    instanceId: instance.id,
    nodeId: "analysis",
    kind: "implementation-report",
    title: "Ask 中间结果",
    status: "rejected",
    contentJson: JSON.stringify({ text: "已生成需求分析草稿，但缺少部署目录。" }),
    manifest: { summary: "已生成需求分析草稿，但缺少部署目录。" },
  });
  const { engine } = createHarness({ artifacts: [askArtifact] });
  bindSingleInstanceRepo(engine, instance);
  (engine as any).ctx.db.orchArtifactFiles.updateStatusByArtifact = () => {};
  (engine as any).scheduleActiveRunAfterFeedback = () => {};

  await engine.submitFeedback(instance.id, "analysis", "resume_with_input", {
    feedback: "部署目录是 /opt/codeflow",
    artifactIds: ["artifact_ask_result" as any],
    executionOverride: {
      model: "gpt-5.6-terra",
      effort: "high",
      autoCompactPct: 92,
      contextWindow: 372_000,
      serviceTier: "fast",
    },
  });

  assert.deepEqual(instance.nodeStates.analysis.inputArtifactIds, ["artifact_ask_result" as any]);
  const feedbackContext = (engine as any).collectFeedbackContext(instance, "analysis");
  assert.deepEqual(feedbackContext.artifactIds, ["artifact_ask_result" as any]);
  assert.deepEqual(feedbackContext.executionOverride, {
    model: "gpt-5.6-terra",
    effort: "high",
    autoCompactPct: 92,
    contextWindow: 372_000,
    serviceTier: "fast",
  });
  const feedbackArtifactInput = (engine as any).buildArtifactInputSnapshot(instance, feedbackContext.artifactIds, {});
  assert.deepEqual(
    feedbackArtifactInput.artifacts.map((artifact: any) => ({
      artifactId: artifact.artifactId,
      nodeId: artifact.nodeId,
      kind: artifact.kind,
      status: artifact.status,
      summaryText: artifact.summaryText,
    })),
    [
      {
        artifactId: "artifact_ask_result",
        nodeId: "analysis",
        kind: "implementation-report",
        status: "rejected",
        summaryText: "已生成需求分析草稿，但缺少部署目录。",
      },
    ],
  );
});

test("persistOutputArtifact stores consumable output fields in artifact field index", () => {
  const role = createRole({
    name: "需求分析",
    outputDefinition: {
      instructions: "",
      deliveryMode: "direct",
      format: "markdown",
      resultKey: "analysis-report",
      filePathRule: null,
      files: null,
      requiredFields: [
        {
          key: "verificationSummary",
          label: "验证摘要",
          valueType: "markdown",
          required: true,
        },
      ],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_persist_output_fields" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "字段输出测试",
    description: "字段输出测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", label: "需求分析", roleId: role.id, position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = {
    ...createInstance(role, workflow),
    id: "orch_persist_output_fields" as any,
    nodeStates: {
      analysis: createNodeState("analysis", "running", { threadId: "thread-analysis" as any }),
    },
  };
  const artifacts: Artifact[] = [];
  const fieldEntries: Array<Record<string, unknown>> = [];
  const engine = new OrchestrationEngine({
    db: {
      orchArtifacts: {
        listByNode() {
          return [];
        },
        create(input: Omit<Artifact, "createdAt" | "updatedAt" | "id">) {
          const artifact: Artifact = {
            ...input,
            id: "artifact_fields" as any,
            createdAt: 1,
            updatedAt: 1,
          };
          artifacts.push(artifact);
          return artifact;
        },
      },
      orchArtifactFiles: {
        replaceForArtifact() {},
        listByArtifact() {
          return [];
        },
      },
      orchArtifactFields: {
        replaceForArtifact(_artifactId: string, entries: Array<Record<string, unknown>>) {
          fieldEntries.push(...entries);
          return entries;
        },
      },
      orchInstances: {
        updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
          instance.artifactIndex = artifactIndex as any;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  const finalAnswer = createTextFinalAnswer("分析完成", {
    review: { verdict: "pass", summary: "满足输出契约" },
  });
  finalAnswer.answer.fields = {
    verificationSummary: "已通过单元测试。",
  };

  const validation = (engine as any).validateNodeResultContract(instance, workflow.nodes[0], role, finalAnswer);
  const attemptId = prepareSubmittedNodeAttempt(engine, instance, workflow.nodes[0], finalAnswer, "分析完成");
  (engine as any).ctx.db.orchNodeAttempts.markFinalizing(attemptId);
  const artifact = (engine as any).persistOutputArtifact(instance, workflow.nodes[0], role, finalAnswer, validation, attemptId);

  assert.equal(artifact.metadata?.nodeResult?.validationStatus, "valid");
  assert.equal(artifact.metadata?.nodeResult?.consumable, true);
  assert.equal(fieldEntries.length, 1);
  assert.equal(fieldEntries[0]?.fieldKey, "verificationSummary");
  assert.equal(JSON.parse(String(fieldEntries[0]?.valueJson ?? "null")), "已通过单元测试。");
  assert.deepEqual(instance.artifactIndex?.analysis, ["artifact_fields"]);
});

test("finalizeRoleExecution auto-approves file-set outputs when repo methods depend on bound this", async () => {
  const workspacePath = createTemporaryWorkspace(path.join(os.tmpdir(), "orch-finalize-fileset-"));
  try {
    const role = createRole({
      name: "基线工程师",
      outputDefinition: {
        instructions: "输出基线文档",
        deliveryMode: "file",
        format: "markdown",
        resultKey: "baseline-docs",
        filePathRule: null,
        requiredFields: [],
      },
    });
    const workflow: WorkflowDefinition = {
      id: "wf_finalize_file_set" as any,
      workspaceId: "client-a:ws-demo" as any,
      family: "feature-dev",
      name: "file-set 收尾测试",
      description: "file-set 收尾测试",
      workflowKnowledgeBundleIds: [],
      nodes: [
        {
          id: "baseline",
          type: "role",
          label: "基线工程师",
          roleId: role.id,
          position: { x: 0, y: 0 },
          outputArtifactMode: "file-set",
          outputWritePolicy: {
            persistenceMode: "dual-write",
            overwritePolicy: "overwrite",
          },
        },
      ],
      edges: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const instance: OrchestrationInstance = {
      ...createInstance(role, workflow),
      id: "orch_finalize_file_set" as any,
      status: "running",
      nodeStates: {
        baseline: createNodeState("baseline", "running"),
      },
    };
    instance.nodeStates.baseline.threadId = "thread-baseline" as any;

    const docRelPath = "codeflow-docs/代码知识库/全局架构/架构总览.md";
    const docAbsPath = path.join(workspacePath, docRelPath);
    fs.mkdirSync(path.dirname(docAbsPath), { recursive: true });
    fs.writeFileSync(docAbsPath, "# 架构总览\n\n这是基线文档。", "utf8");

    const artifacts: Artifact[] = [];
    const artifactFilesByArtifactId = new Map<string, Array<Record<string, any>>>();
    const events: Array<Record<string, unknown>> = [];
    const state = { instance };

    class OrchArtifactsRepoStub {
      constructor(private readonly db: { artifacts: Artifact[] }) {}

      listByNode(instanceId: string, nodeId: string) {
        return this.db.artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
      }

      create(input: Omit<Artifact, "createdAt" | "updatedAt" | "id">) {
        const created: Artifact = {
          ...input,
          id: `artifact_${this.db.artifacts.length + 1}` as any,
          createdAt: 100 + this.db.artifacts.length,
          updatedAt: 100 + this.db.artifacts.length,
        };
        this.db.artifacts.push(created);
        return created;
      }

      get(artifactId: string) {
        return this.db.artifacts.find((artifact) => artifact.id === artifactId) ?? null;
      }

      updateStatus(artifactId: string, status: Artifact["status"]) {
        const artifact = this.get(artifactId);
        if (artifact) artifact.status = status;
      }

      updateWorkspace(artifactId: string, patch: Record<string, unknown>) {
        const artifact = this.get(artifactId);
        if (artifact) Object.assign(artifact, patch, { updatedAt: Date.now() });
      }
    }

    class OrchArtifactFilesRepoStub {
      constructor(private readonly db: { entries: Map<string, Array<Record<string, any>>> }) {}

      replaceForArtifact(artifactId: string, entries: Array<Record<string, any>>) {
        this.db.entries.set(artifactId, entries.map((entry, index) => ({
          ...entry,
          id: `${artifactId}_file_${index + 1}`,
          artifactId,
        })));
      }

      listByArtifact(artifactId: string) {
        return [...(this.db.entries.get(artifactId) ?? [])];
      }

      updatePublishedPaths(artifactId: string, updates: Array<Record<string, any>>) {
        const merged = (this.db.entries.get(artifactId) ?? []).map((entry) => {
          const patch = updates.find((item) => item.id === entry.id);
          return patch ? { ...entry, ...patch } : entry;
        });
        this.db.entries.set(artifactId, merged);
      }

      updateStatusByArtifact(artifactId: string, status: string) {
        const merged = (this.db.entries.get(artifactId) ?? []).map((entry) => ({ ...entry, status }));
        this.db.entries.set(artifactId, merged);
      }
    }

    class OrchInstancesRepoStub {
      constructor(private readonly db: { instance: OrchestrationInstance }) {}

      get(instanceId: string) {
        return this.db.instance.id === instanceId ? this.db.instance : null;
      }

      updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
        this.db.instance.nodeStates = nodeStates;
      }

      updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
        this.db.instance.artifactIndex = artifactIndex as any;
      }

      updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
        this.db.instance.status = status;
      }
    }

    const engine = new OrchestrationEngine({
      db: {
        orchArtifacts: new OrchArtifactsRepoStub({ artifacts }),
        orchArtifactFiles: new OrchArtifactFilesRepoStub({ entries: artifactFilesByArtifactId }),
        orchInstances: new OrchInstancesRepoStub(state),
        orchEvents: {
          append(input: Record<string, unknown>) {
            events.push(input);
            return input;
          },
        },
        orchRoles: {
          get() {
            return null;
          },
        },
      } as any,
      threads: {} as any,
      sessions: {} as any,
      workspaces: new Map([[workflow.workspaceId, workspacePath]]),
      timeoutPolicy: {
        mode: "activity",
        startupTimeoutMs: 1_000,
        engineIdleTimeoutMs: 1_000,
      },
      emitConversation() {},
      emitRaw() {},
    });
    (engine as any).runningInstances.set(instance.id, {
      paused: false,
      cancelled: false,
      runId: "run_finalize_file_set",
      drivePromise: Promise.resolve(),
    });

    const finalAnswer: NodeFinalAnswerPayload = {
      answer: {
        mode: "file-set",
        files: [
          {
            key: "main",
            path: docRelPath,
            summary: "基线架构总览",
          },
        ],
        changedFiles: [],
      },
      control: {
        nextAction: "continue",
        reason: "当前节点交付完成。",
      },
      review: {
        verdict: "pass",
        summary: "基线文档已生成。",
        blockingIssues: [],
      },
      acceptanceChecks: [],
    };
    const attemptId = prepareSubmittedNodeAttempt(
      engine,
      instance,
      workflow.nodes[0],
      finalAnswer,
      "基线文档已生成。",
    );

    await (engine as any).finalizeRoleExecution(instance.id, workflow.nodes[0], instance, role, {
      rawOutput: "基线文档已生成。",
      finalAnswer,
    }, attemptId);

    assert.equal(instance.nodeStates.baseline.status, "completed");
    assert.equal(instance.nodeStates.baseline.error, undefined);
    assert.equal(instance.nodeStates.baseline.outputArtifactIds?.length, 1);
    assert.equal(artifacts[0]?.status, "approved");
    assert.equal(artifacts[0]?.workspaceStatus, "published");
    const persistedFiles = artifactFilesByArtifactId.get(String(artifacts[0]?.id)) ?? [];
    assert.equal(persistedFiles.length, 1);
    assert.equal(persistedFiles[0]?.status, "published");
    assert.equal(persistedFiles[0]?.publishedPath, docRelPath);
    assert.ok(events.some((event) => event.type === "orchestration.artifactPublished"));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("auto-approved rework rolls back immediately and stops at the rework round limit", async () => {
  const role = createRole({ name: "代码评审" });
  const workflow: WorkflowDefinition = {
    id: "wf_auto_rework_limit" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "自动回退上限测试",
    description: "自动回退上限测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "dev", type: "role", label: "全栈开发", roleId: role.id, position: { x: 120, y: 0 } },
      {
        id: "review",
        type: "role",
        label: "代码评审",
        roleId: role.id,
        position: { x: 240, y: 0 },
        approvalMode: "auto",
        reworkPolicy: { allowedTargetNodeIds: ["dev"] },
      },
      { id: "end", type: "end", label: "结束", position: { x: 360, y: 0 } },
    ],
    edges: [
      { id: "e-start-dev", sourceNodeId: "start", targetNodeId: "dev", dataMappings: [] },
      { id: "e-dev-review", sourceNodeId: "dev", targetNodeId: "review", dataMappings: [] },
      { id: "e-review-end", sourceNodeId: "review", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const reviewFinalAnswer = createTextFinalAnswer("评审未通过，需要退回开发修正", {
    control: { nextAction: "rework" },
    review: { verdict: "fail", blockingIssues: ["实现缺少边界校验"] },
    rework: { targetNodeId: "dev", reason: "请补齐边界校验", rerunNodeIds: ["dev", "review"] },
  });

  /** 构造「评审节点已提交 fail+rework 结论、等待 finalize」的实例；reworkCount 表示该节点已发起的回退轮次。 */
  const buildEngineForPendingReview = (reworkCount: number) => {
    const instance: OrchestrationInstance = {
      ...createInstance(role, workflow),
      id: "orch_auto_rework_limit" as any,
      status: "running",
      nodeStates: {
        start: createNodeState("start", "completed"),
        dev: createNodeState("dev", "completed", {
          nodeExecutionId: "dev-execution-1",
          attemptNo: 1,
          threadId: "thread-dev" as any,
          outputArtifactIds: ["artifact_dev" as any],
        }),
        review: createNodeState("review", "running", { threadId: "thread-review" as any, reworkCount }),
        end: createNodeState("end"),
      },
    };
    const artifacts: Artifact[] = [
      createArtifact({ id: "artifact_dev" as any, instanceId: instance.id, nodeId: "dev", kind: "implementation-report" }),
    ];
    const feedbackRecords: Array<Record<string, any>> = [];
    const orchEvents: Array<Record<string, unknown>> = [];
    const engine = new OrchestrationEngine({
      db: {
        orchInstances: {
          get: (instanceId: string) => (instanceId === instance.id ? instance : null),
          updateStatus: (_instanceId: string, status: OrchestrationInstance["status"]) => {
            instance.status = status;
          },
          updateNodeStates: (_instanceId: string, nodeStates: Record<string, NodeExecutionState>) => {
            instance.nodeStates = nodeStates;
          },
          updateArtifactIndex: (_instanceId: string, artifactIndex: Record<string, string[]>) => {
            instance.artifactIndex = artifactIndex as any;
          },
        },
        orchArtifacts: {
          listByInstance: (instanceId: string) => artifacts.filter((item) => item.instanceId === instanceId),
          listByNode: (instanceId: string, nodeId: string) =>
            artifacts.filter((item) => item.instanceId === instanceId && item.nodeId === nodeId),
          create: (input: Omit<Artifact, "createdAt" | "updatedAt" | "id">) => {
            const created: Artifact = {
              ...input,
              id: `artifact_${artifacts.length + 1}` as any,
              createdAt: 10 + artifacts.length,
              updatedAt: 10 + artifacts.length,
            };
            artifacts.push(created);
            return created;
          },
          get: (artifactId: string) => artifacts.find((item) => item.id === artifactId) ?? null,
          updateStatus: (artifactId: string, status: Artifact["status"]) => {
            const artifact = artifacts.find((item) => item.id === artifactId);
            if (artifact) artifact.status = status;
          },
          updateWorkspace: (artifactId: string, patch: Partial<Artifact>) => {
            const artifact = artifacts.find((item) => item.id === artifactId);
            if (artifact) Object.assign(artifact, patch, { updatedAt: Date.now() });
          },
        },
        orchArtifactFiles: {
          replaceForArtifact() {},
          listByArtifact() {
            return [];
          },
          updatePublishedPaths() {},
          updateStatusByArtifact() {},
        },
        orchFeedback: {
          create: (input: Record<string, any>) => {
            const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
            feedbackRecords.push(record);
            return record;
          },
          get: (recordId: string) => feedbackRecords.find((item) => item.id === recordId) ?? null,
        },
        orchEvents: {
          append: (input: Record<string, unknown>) => {
            orchEvents.push(input);
            return input;
          },
        },
        conversationEvents: {
          listByThread: () => [
            { type: "turn.started", payload: { turnId: "turn_review_rework" } },
            {
              type: "item.tool.started",
              payload: { itemId: "tool_review_fail", toolName: "runtime.submitNodeResult", input: reviewFinalAnswer },
            },
            {
              type: "item.tool.completed",
              payload: {
                itemId: "tool_review_fail",
                toolName: "runtime.submitNodeResult",
                output: { accepted: true },
                status: "completed",
              },
            },
            { type: "turn.completed", payload: { turnId: "turn_review_rework", result: { responseText: "评审未通过" } } },
          ],
        },
        turns: {
          listByThread: (threadId: ThreadId) => [
            {
              threadId,
              turnId: "turn_review_rework" as any,
              workspaceId: workflow.workspaceId,
              engine: "codex",
              engineSessionId: null,
              status: "completed",
              startedAt: 2,
              endedAt: 3,
              startEventSeq: 1,
              endEventSeq: 2,
              userItemId: null,
              userText: "请评审开发结果",
              engineCheckpointJson: null,
            },
          ],
        },
        orchRoles: { get: () => role },
      } as any,
      threads: {} as any,
      sessions: {} as any,
      workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
      timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
      emitConversation() {},
      emitRaw() {},
    });
    return { instance, engine, orchEvents };
  };

  // 未达上限：auto 审批下立即自动回退，dev 重回待执行并计入 1 轮。
  const belowLimit = buildEngineForPendingReview(0);
  await belowLimit.engine.recover(belowLimit.instance.id);
  assert.equal(belowLimit.instance.nodeStates.review.reworkCount, 1);
  assert.notEqual(belowLimit.instance.nodeStates.dev.status, "completed");

  // 已达默认上限：不再自动回退，停在人工决策点，dev 保持已完成。
  const atLimit = buildEngineForPendingReview(DEFAULT_MAX_REWORK_ROUNDS);
  await atLimit.engine.recover(atLimit.instance.id);
  assert.equal(atLimit.instance.nodeStates.review.status, "waiting-feedback");
  assert.equal(atLimit.instance.nodeStates.dev.status, "completed");
  assert.equal(atLimit.instance.nodeStates.review.reworkCount, DEFAULT_MAX_REWORK_ROUNDS);
  assert.ok(atLimit.orchEvents.some((event) => event.type === "orchestration.feedbackRequested"));

  // 人工确认的回退不受上限限制：人授权后仍能退回 dev。
  await atLimit.engine.submitFeedback(atLimit.instance.id, "review", "approve", { feedback: "已确认退回修复" });
  assert.notEqual(atLimit.instance.nodeStates.dev.status, "completed");
});

test("recover replays a completed role turn without requiring prompt revision evidence", async () => {
  const role = createRole({
    id: "role_verification" as any,
    name: "测试验证",
    outputDefinition: {
      instructions: "输出验证报告",
      deliveryMode: "direct",
      format: "markdown",
      resultKey: "verification-report",
      filePathRule: null,
      requiredFields: [],
    },
  });
  const workflow: WorkflowDefinition = {
    id: "wf_recover" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "恢复执行测试",
    description: "恢复执行测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "verification", type: "role", roleId: role.id, label: "测试验证", position: { x: 0, y: 120 } },
      { id: "end", type: "end", label: "结束", position: { x: 0, y: 240 } },
    ],
    edges: [
      {
        id: "edge-start-verification",
        sourceNodeId: "start",
        targetNodeId: "verification",
        conditionBranch: null,
        dataMappings: [],
      },
      {
        id: "edge-verification-end",
        sourceNodeId: "verification",
        targetNodeId: "end",
        conditionBranch: null,
        dataMappings: [],
      },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_recover" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_recover" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "analysis",
      title: "验证 client 重启后的编排恢复",
      goal: "验证 client 重启后的编排恢复",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow, { roles: [role] }),
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      start: {
        nodeId: "start",
        status: "completed",
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
        startedAt: 1,
        completedAt: 1,
      },
      verification: {
        nodeId: "verification",
        status: "running",
        retryCount: 0,
        inputArtifactIds: [],
        outputArtifactIds: [],
        feedbackRecordIds: [],
        threadId: "orch-thread-recover" as any,
        startedAt: 2,
      },
      end: createNodeState("end"),
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const artifacts: Artifact[] = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const conversationLog: Array<Record<string, unknown>> = [];
  const responseText = "验证通过，可以结束流程。";
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
          instance.artifactIndex = artifactIndex as any;
        },
      },
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        create(input: Omit<Artifact, "createdAt" | "updatedAt" | "id">) {
          const created: Artifact = {
            ...input,
            id: `artifact_${artifacts.length + 1}` as any,
            createdAt: 10 + artifacts.length,
            updatedAt: 10 + artifacts.length,
          };
          artifacts.push(created);
          return created;
        },
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
        updateWorkspace(artifactId: string, patch: Partial<Artifact>) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) Object.assign(artifact, patch, { updatedAt: Date.now() });
        },
      },
      orchArtifactFiles: {
        replaceForArtifact() {},
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          orchEvents.push(input);
          return input;
        },
      },
      conversationEvents: {
        listByThread(threadId: ThreadId) {
          assert.equal(threadId, instance.nodeStates.verification.threadId);
          return [
            {
              type: "turn.started",
              payload: {
                turnId: "turn_recover_done",
              },
            },
            {
              type: "item.tool.started",
              payload: {
                itemId: "tool_recover_done",
                toolName: "runtime.submitNodeResult",
                input: createTextFinalAnswer("验证已完成。"),
              },
            },
            {
              type: "item.tool.completed",
              payload: {
                itemId: "tool_recover_done",
                toolName: "runtime.submitNodeResult",
                output: {
                  accepted: true,
                },
                status: "completed",
              },
            },
            {
              type: "turn.completed",
              payload: {
                turnId: "turn_recover_done",
                result: {
                  responseText,
                },
              },
            },
          ];
        },
      },
      turns: {
        listByThread(threadId: ThreadId) {
          assert.equal(threadId, instance.nodeStates.verification.threadId);
          return [
            {
              threadId,
              turnId: "turn_recover_done" as any,
              workspaceId: workflow.workspaceId,
              engine: "codex",
              engineSessionId: null,
              status: "completed",
              startedAt: 2,
              endedAt: 3,
              startEventSeq: 1,
              endEventSeq: 2,
              userItemId: null,
              userText: "请完成验证",
              engineCheckpointJson: null,
            },
          ];
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation(event: Record<string, unknown>) {
      conversationLog.push(event);
    },
    emitRaw() {},
  });

  await engine.recover(instance.id);

  assert.equal(instance.nodeStates.verification.status, "completed");
  assert.equal(instance.nodeStates.end.status, "completed");
  assert.equal(instance.status, "completed");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.kind, "verification-report");
  assert.equal(artifacts[0]?.status, "approved");
  assert.deepEqual(instance.artifactIndex, {
    verification: [artifacts[0]?.id],
  });
  assert.ok(orchEvents.some((event) => event.type === "orchestration.nodeRecovered"));
  assert.equal(orchEvents.filter((event) => event.type === "orchestration.completed").length, 1);
  assert.ok(!conversationLog.some((event) => String(event.type).startsWith("orchestration.")));
});

test("startup recovery candidates follow recoverable node facts without starting untouched or paused instances", () => {
  const buildCandidate = (
    instanceStatus: OrchestrationInstance["status"],
    nodeStatus: NodeExecutionState["status"],
  ): Pick<OrchestrationInstance, "status" | "nodeStates"> => ({
    status: instanceStatus,
    nodeStates: {
      verification: {
        nodeId: "verification",
        status: nodeStatus,
        retryCount: 0,
      },
    },
  });

  for (const nodeStatus of [
    "ready",
    "queued",
    "running",
    "result-submitted",
    "finalizing",
    "artifact-writing",
    "gate-checking",
  ] as const) {
    assert.equal(shouldRecoverPersistedOrchestrationInstance(buildCandidate("pending", nodeStatus)), true);
  }
  assert.equal(shouldRecoverPersistedOrchestrationInstance(buildCandidate("running", "waiting-feedback")), true);
  assert.equal(shouldRecoverPersistedOrchestrationInstance(buildCandidate("pending", "pending")), false);
  assert.equal(shouldRecoverPersistedOrchestrationInstance(buildCandidate("waiting-feedback", "waiting-feedback")), false);
  const consumedFeedbackFailure = buildCandidate("waiting-feedback", "waiting-feedback");
  consumedFeedbackFailure.nodeStates.verification.humanActionSource = "execution";
  consumedFeedbackFailure.nodeStates.verification.errorCode = "session_invalidated";
  consumedFeedbackFailure.nodeStates.verification.activeFeedbackRecordIds = ["feedback_resume" as any];
  assert.equal(shouldRecoverPersistedOrchestrationInstance(consumedFeedbackFailure), false);
  assert.equal(shouldRecoverPersistedOrchestrationInstance(buildCandidate("paused", "ready")), false);
  assert.equal(shouldRecoverPersistedOrchestrationInstance(buildCandidate("completed", "queued")), false);
  assert.equal(shouldRecoverPersistedOrchestrationInstance(buildCandidate("failed", "running")), false);
  assert.equal(shouldRecoverPersistedOrchestrationInstance(buildCandidate("cancelled", "ready")), false);
});

test("recover rechecks the latest instance status before creating a run state", async () => {
  const role = createRole({ id: "role_recover_status_gate" as any, name: "恢复状态门禁" });
  const workflow = createWorkflow([
    { id: "verification", type: "role", roleId: role.id, label: "验证", position: { x: 0, y: 0 } },
  ], []);
  const instances = [
    { status: "paused", nodeStatus: "ready" },
    { status: "completed", nodeStatus: "queued" },
    { status: "failed", nodeStatus: "running" },
    { status: "cancelled", nodeStatus: "running" },
  ] as const;

  for (const [index, candidate] of instances.entries()) {
    const instance: OrchestrationInstance = {
      ...createInstance(role, workflow),
      id: `orch_recover_status_gate_${index}` as any,
      status: candidate.status,
      nodeStates: {
        verification: createNodeState("verification", candidate.nodeStatus),
      },
    };
    const statusUpdates: string[] = [];
    let driveCalls = 0;
    const engine = new OrchestrationEngine({
      db: {
        orchInstances: {
          get(instanceId: string) {
            return instanceId === instance.id ? instance : null;
          },
          updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
            statusUpdates.push(status);
            instance.status = status;
          },
        },
      } as any,
      threads: {} as any,
      sessions: {} as any,
      workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
      timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
      emitConversation() {},
      emitRaw() {},
    });
    (engine as any).driveInstance = async () => {
      driveCalls += 1;
    };

    await engine.recover(instance.id);

    assert.equal(instance.status, candidate.status);
    assert.deepEqual(statusUpdates, []);
    assert.equal(driveCalls, 0);
    assert.equal((engine as any).runningInstances.has(instance.id), false);
  }
});

test("recover leaves consumed session-invalidated feedback waiting for explicit user action", async () => {
  const role = createRole({ id: "role_consumed_feedback_recovery" as any, name: "恢复已接收反馈" });
  const node: WorkflowNode = {
    id: "verification",
    type: "role",
    roleId: role.id,
    label: "验证",
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const feedbackRecord = {
    id: "feedback_resume" as any,
    instanceId: "orch_consumed_feedback_recovery" as any,
    nodeId: node.id,
    action: "resume_with_input" as const,
    source: "execution" as const,
    feedback: "继续",
    images: null,
    artifactIds: null,
    createdAt: 1,
  };
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: feedbackRecord.instanceId,
    status: "waiting-feedback",
    nodeStates: {
      verification: createNodeState(node.id, "waiting-feedback", {
        attemptId: "attempt_failed" as any,
        nodeExecutionId: "attempt_failed",
        attemptNo: 1,
        threadId: "thread_failed" as any,
        humanActionSource: "execution",
        error: "旧会话无法继续",
        errorCode: "session_invalidated",
        activeFeedbackRecordIds: [feedbackRecord.id],
        feedbackRecordIds: [feedbackRecord.id],
      }),
    },
  };
  const { engine, orchestrationEvents } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const failedAttempt: OrchNodeAttempt = {
    id: "attempt_failed",
    instanceId: instance.id,
    nodeId: node.id,
    attemptNo: 1,
    status: "waiting-feedback",
    threadId: "thread_failed",
    turnId: "turn_failed",
    submission: null,
    submissionHash: null,
    responseText: null,
    artifactId: null,
    lastError: "旧会话无法继续",
    submittedAt: null,
    finalizedAt: 2,
    invalidatedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 2,
  };
  (engine as any).ctx.db.orchNodeAttempts = {
    getLatestByNode: () => failedAttempt,
  };
  (engine as any).ctx.db.conversationEvents = {
    listByThread: () => [{
      type: "turn.error",
      payload: {
        turnId: failedAttempt.turnId,
        error: failedAttempt.lastError,
        code: "session_invalidated",
      },
    }],
  };
  let feedbackCreateCalls = 0;
  (engine as any).ctx.db.orchFeedback = {
    create() {
      feedbackCreateCalls += 1;
      throw new Error("自动恢复不得创建第二条反馈");
    },
    get(recordId: string) {
      return recordId === feedbackRecord.id ? feedbackRecord : null;
    },
  };
  let driveCalls = 0;
  (engine as any).driveInstance = async () => {
    driveCalls += 1;
  };

  await Promise.all([engine.recover(instance.id), engine.recover(instance.id)]);

  assert.equal(instance.nodeStates.verification.status, "waiting-feedback");
  assert.equal(instance.nodeStates.verification.error, "旧会话无法继续");
  assert.equal(instance.nodeStates.verification.errorCode, "session_invalidated");
  assert.deepEqual(instance.nodeStates.verification.activeFeedbackRecordIds, [feedbackRecord.id]);
  assert.deepEqual(instance.nodeStates.verification.feedbackRecordIds, [feedbackRecord.id]);
  assert.equal(instance.nodeStates.verification.parentExecutionId, undefined);
  assert.equal(driveCalls, 0);
  assert.equal(feedbackCreateCalls, 0);
  const feedbackContext = (engine as any).collectFeedbackContext(instance, node.id);
  assert.match(String(feedbackContext.feedbackPatch ?? ""), /继续/);
  assert.equal(instance.nodeStates.verification.attemptId, "attempt_failed");
  assert.equal(instance.nodeStates.verification.threadId, "thread_failed");
  assert.equal(orchestrationEvents.some((event) => {
    if (event.type !== "orchestration.nodeRecovered") return false;
    return JSON.parse(event.payloadJson).action === "consumed-feedback-requeued";
  }), false);

  instance.status = "waiting-feedback";
  instance.nodeStates.verification.status = "waiting-feedback";
  instance.nodeStates.verification.humanActionSource = "execution";
  instance.nodeStates.verification.error = "同一错误再次出现";
  instance.nodeStates.verification.errorCode = "session_invalidated";
  assert.equal(shouldRecoverPersistedOrchestrationInstance(instance), false);
  await engine.recover(instance.id);
  assert.equal(driveCalls, 0);
  assert.equal(instance.nodeStates.verification.status, "waiting-feedback");
});

test("legacy session-invalidated feedback is backfilled from the exact failed turn", () => {
  const role = createRole({ id: "role_legacy_feedback_recovery" as any, name: "旧反馈恢复" });
  const node: WorkflowNode = {
    id: "verification",
    type: "role",
    roleId: role.id,
    label: "验证",
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_legacy_feedback_recovery" as any,
    status: "waiting-feedback",
    nodeStates: {
      verification: createNodeState(node.id, "waiting-feedback", {
        attemptId: "attempt_legacy_failed" as any,
        nodeExecutionId: "attempt_legacy_failed",
        threadId: "thread_legacy_failed" as any,
        humanActionSource: "execution",
        error: "历史展示文案",
        activeFeedbackRecordIds: ["feedback_legacy_resume" as any],
      }),
    },
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  (engine as any).ctx.db.workspaces = { list: () => [{ id: instance.workspaceId }] };
  (engine as any).ctx.db.orchInstances.listByWorkspace = () => [instance];
  (engine as any).ctx.db.orchNodeAttempts = {
    getLatestByNode: () => ({
      id: "attempt_legacy_failed",
      instanceId: instance.id,
      nodeId: node.id,
      threadId: "thread_legacy_failed",
      turnId: "turn_legacy_failed",
    }),
  };
  (engine as any).ctx.db.conversationEvents = {
    listByThread(threadId: string) {
      assert.equal(threadId, "thread_legacy_failed");
      return [{
        type: "turn.error",
        payload: {
          turnId: "turn_legacy_failed",
          error: "当前 Codex 会话缺少本轮必需的动态工具绑定",
          code: "session_invalidated",
        },
      }];
    },
  };

  engine.normalizePersistedInstanceStatuses();

  assert.equal(instance.nodeStates.verification.errorCode, "session_invalidated");
  assert.equal(shouldRecoverPersistedOrchestrationInstance(instance), false);
});

test("legacy feedback recovery never combines a projected thread with another attempt turn", () => {
  const role = createRole({ id: "role_legacy_feedback_pair_guard" as any, name: "旧反馈配对门禁" });
  const node: WorkflowNode = {
    id: "verification",
    type: "role",
    roleId: role.id,
    label: "验证",
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const instance = createInstance(role, workflow);
  instance.status = "waiting-feedback";
  instance.nodeStates.verification = createNodeState(node.id, "waiting-feedback", {
    attemptId: "attempt_legacy_pair_guard" as any,
    nodeExecutionId: "attempt_legacy_pair_guard",
    threadId: "thread_projected_old" as any,
    humanActionSource: "execution",
    error: "历史展示文案",
    activeFeedbackRecordIds: ["feedback_legacy_pair_guard" as any],
  });
  const attempt = {
    id: "attempt_legacy_pair_guard",
    instanceId: instance.id,
    nodeId: node.id,
    threadId: null as string | null,
    turnId: "turn_latest" as string | null,
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  (engine as any).ctx.db.workspaces = { list: () => [{ id: instance.workspaceId }] };
  (engine as any).ctx.db.orchInstances.listByWorkspace = () => [instance];
  (engine as any).ctx.db.orchNodeAttempts = { getLatestByNode: () => attempt };
  let eventReads = 0;
  (engine as any).ctx.db.conversationEvents = {
    listByThread: () => {
      eventReads += 1;
      return [{
        type: "turn.error",
        payload: { turnId: "turn_other", error: "历史展示文案", code: "session_invalidated" },
      }];
    },
  };

  engine.normalizePersistedInstanceStatuses();
  assert.equal(eventReads, 0);
  assert.equal(instance.nodeStates.verification.errorCode, undefined);

  attempt.threadId = "thread_projected_old";
  engine.normalizePersistedInstanceStatuses();
  assert.equal(eventReads, 1);
  assert.equal(instance.nodeStates.verification.errorCode, undefined);
});

test("recover requeues a claimed role node that never started a provider turn", async () => {
  const role = createRole({ id: "role_recover_queued" as any, name: "恢复排队节点" });
  const workflow = createWorkflow([
    { id: "verification", type: "role", roleId: role.id, label: "验证", position: { x: 0, y: 0 } },
  ], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_recover_queued" as any,
    status: "running",
    nodeStates: {
      verification: createNodeState("verification", "queued", {
        attemptId: "attempt_before_restart" as any,
        nodeExecutionId: "attempt_before_restart",
        attemptNo: 1,
        startedAt: null,
      }),
    },
  };
  const events: Array<Record<string, unknown>> = [];
  const invalidations: Array<{ instanceId: string; nodeId: string; reason: string }> = [];
  let driveCalls = 0;
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
      orchNodeAttempts: {
        invalidateActiveByNode(instanceId: string, nodeId: string, reason: string) {
          invalidations.push({ instanceId, nodeId, reason });
          return 1;
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          events.push(input);
          return input;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).driveInstance = async () => {
    driveCalls += 1;
  };

  await engine.recover(instance.id);

  assert.equal(instance.status, "pending");
  assert.equal(instance.nodeStates.verification.status, "ready");
  assert.equal(instance.nodeStates.verification.attemptId, null);
  assert.equal(instance.nodeStates.verification.nodeExecutionId, null);
  assert.equal(instance.nodeStates.verification.parentExecutionId, "attempt_before_restart");
  assert.equal(instance.nodeStates.verification.startedAt, null);
  assert.equal(driveCalls, 1);
  assert.deepEqual(invalidations, [{
    instanceId: instance.id,
    nodeId: "verification",
    reason: "节点在 client 重启前已被认领但尚未启动 turn，已重新排队",
  }]);
  assert.ok(events.some((event) => {
    if (event.type !== "orchestration.nodeRecovered") return false;
    const payload = JSON.parse(String(event.payloadJson ?? "{}"));
    return payload.nodeId === "verification" && payload.action === "requeued";
  }));
});

test("reconcileRecoveredRoleNode preserves an exact running provider turn while recovery is pending", async () => {
  const role = createRole({ id: "role_recover_provider_pending" as any, name: "provider pending 恢复" });
  const node: WorkflowNode = {
    id: "verification",
    type: "role",
    roleId: role.id,
    label: "验证",
    position: { x: 0, y: 0 },
  };
  const workflow = createWorkflow([node], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_recover_provider_pending" as any,
    status: "running",
    nodeStates: {
      verification: createNodeState("verification", "running", {
        attemptId: "attempt_provider_pending" as any,
        nodeExecutionId: "attempt_provider_pending",
        attemptNo: 1,
        threadId: "thread_provider_pending" as any,
        startedAt: 123,
      }),
    },
  };
  const persistedAttempt: OrchNodeAttempt = {
    id: "attempt_provider_pending",
    instanceId: instance.id,
    nodeId: node.id,
    attemptNo: 1,
    status: "running",
    threadId: "thread_provider_pending",
    turnId: "turn_provider_pending",
    submission: null,
    submissionHash: null,
    responseText: null,
    artifactId: null,
    lastError: null,
    submittedAt: null,
    finalizedAt: null,
    invalidatedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 123,
  };
  const { engine, orchestrationEvents } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  let invalidationCalls = 0;
  (engine as any).ctx.db.orchNodeAttempts = {
    getLatestByNode() {
      return persistedAttempt;
    },
    invalidateActiveByNode() {
      invalidationCalls += 1;
      throw new Error("provider pending 不得失效当前 Attempt");
    },
  };
  (engine as any).ctx.db.turns = {
    listByThread(threadId: ThreadId) {
      assert.equal(threadId, "thread_provider_pending");
      return [{
        threadId,
        turnId: "turn_provider_pending" as TurnId,
        workspaceId: instance.workspaceId,
        engine: "codex",
        engineSessionId: "provider-session-pending" as any,
        status: "started",
        startedAt: 123,
        endedAt: null,
        startEventSeq: null,
        endEventSeq: null,
        userItemId: null,
        userText: null,
        engineCheckpointJson: null,
      }];
    },
  };

  await (engine as any).reconcileRecoveredRoleNode(
    instance.id,
    node,
    instance,
    role,
    instance.nodeStates.verification,
  );

  assert.equal(instance.nodeStates.verification.status, "running");
  assert.equal(instance.nodeStates.verification.attemptId, "attempt_provider_pending");
  assert.equal(instance.nodeStates.verification.nodeExecutionId, "attempt_provider_pending");
  assert.equal(instance.nodeStates.verification.threadId, "thread_provider_pending");
  assert.equal(instance.nodeStates.verification.startedAt, 123);
  assert.equal(invalidationCalls, 0);
  const recoveryEvent = orchestrationEvents.find((event) => event.type === "orchestration.nodeRecovered");
  assert.ok(recoveryEvent);
  assert.equal(JSON.parse(recoveryEvent.payloadJson).action, "provider-recovery-pending");
});

test("recover requeues a claimed control node that never executed", async () => {
  const role = createRole({ id: "role_recover_control" as any, name: "控制节点恢复" });
  const workflow = createWorkflow([
    { id: "end", type: "end", label: "结束", position: { x: 0, y: 0 } },
  ], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_recover_control_queued" as any,
    status: "running",
    nodeStates: {
      end: createNodeState("end", "queued", {
        attemptId: "attempt_control_before_restart" as any,
        nodeExecutionId: "attempt_control_before_restart",
        attemptNo: 1,
      }),
    },
  };
  const invalidations: string[] = [];
  let driveCalls = 0;
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
      orchNodeAttempts: {
        invalidateActiveByNode(_instanceId: string, nodeId: string) {
          invalidations.push(nodeId);
          return 1;
        },
      },
      orchEvents: { append(input: Record<string, unknown>) { return input; } },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).driveInstance = async () => {
    driveCalls += 1;
  };

  await engine.recover(instance.id);

  assert.equal(instance.nodeStates.end.status, "ready");
  assert.equal(instance.nodeStates.end.attemptId, null);
  assert.equal(instance.nodeStates.end.parentExecutionId, "attempt_control_before_restart");
  assert.deepEqual(invalidations, ["end"]);
  assert.equal(driveCalls, 1);
});

test("recover requeues a running control node interrupted before completion", async () => {
  const role = createRole({ id: "role_recover_running_control" as any, name: "运行中控制节点恢复" });
  const workflow = createWorkflow([
    {
      id: "condition",
      type: "condition",
      label: "条件判断",
      conditionExpr: "always",
      position: { x: 0, y: 0 },
    },
  ], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_recover_running_control" as any,
    status: "running",
    nodeStates: {
      condition: createNodeState("condition", "running", {
        attemptId: "attempt_running_control_before_restart" as any,
        nodeExecutionId: "attempt_running_control_before_restart",
        attemptNo: 1,
        startedAt: 10,
      }),
    },
  };
  const invalidations: Array<{ nodeId: string; reason: string }> = [];
  const events: Array<Record<string, unknown>> = [];
  let driveCalls = 0;
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
      },
      orchNodeAttempts: {
        invalidateActiveByNode(_instanceId: string, nodeId: string, reason: string) {
          invalidations.push({ nodeId, reason });
          return 1;
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          events.push(input);
          return input;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map([[workflow.workspaceId, emptyWorkspace]]),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    emitConversation() {},
    emitRaw() {},
  });
  (engine as any).driveInstance = async () => {
    driveCalls += 1;
  };

  await engine.recover(instance.id);

  assert.equal(instance.status, "pending");
  assert.equal(instance.nodeStates.condition.status, "ready");
  assert.equal(instance.nodeStates.condition.attemptId, null);
  assert.equal(instance.nodeStates.condition.nodeExecutionId, null);
  assert.equal(instance.nodeStates.condition.parentExecutionId, "attempt_running_control_before_restart");
  assert.equal(instance.nodeStates.condition.startedAt, null);
  assert.deepEqual(invalidations, [{
    nodeId: "condition",
    reason: "控制节点在 client 重启前未完成执行，已重新排队",
  }]);
  assert.equal(driveCalls, 1);
  assert.ok(events.some((event) => {
    if (event.type !== "orchestration.nodeRecovered") return false;
    const payload = JSON.parse(String(event.payloadJson ?? "{}"));
    return payload.nodeId === "condition" && payload.action === "requeued";
  }));
});

function createExecutionInterruptedRealtimeHarness(input: {
  nodeStatePatch?: Partial<NodeExecutionState>;
  createArtifactError?: string | null;
} = {}) {
  const role = createRole({ name: "原型设计" });
  const workflow: WorkflowDefinition = {
    id: "wf_execution_interrupted_realtime" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "execution-interrupted-realtime",
    description: "execution-interrupted-realtime",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "ui", type: "role", label: "原型设计", position: { x: 0, y: 0 }, roleId: role.id },
      { id: "end", type: "end", label: "结束", position: { x: 240, y: 0 } },
    ],
    edges: [
      { id: "e-ui-end", sourceNodeId: "ui", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const threadId = "thread_execution_interrupted" as ThreadId;
  const roleRevision = buildRoleExecutionRevision(role, []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_execution_interrupted" as any,
    status: "running",
    nodeStates: {
      ui: createNodeState("ui", "waiting-feedback", {
        threadId,
        promptSnapshotIds: ["prompt_execution_interrupted"],
        error: "stream disconnected before completion",
        humanActionSource: "execution",
        ...input.nodeStatePatch,
      }),
      end: createNodeState("end", "pending"),
    },
  };

  const artifacts: Artifact[] = [];
  const orchEvents: Array<Record<string, unknown>> = [];
  const conversationEvents: Array<Record<string, any>> = [];

  const engine = new OrchestrationEngine({
    db: {
      threads: {
        get(requestedThreadId: ThreadId) {
          assert.equal(requestedThreadId, threadId);
          return {
            id: requestedThreadId,
            workspaceId: workflow.workspaceId,
            engine: "codex",
            title: "原型设计",
            threadType: "chat",
            threadSubtype: null,
            sessionId: null,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
            model: null,
            effort: null,
            accessMode: null,
            planMode: null,
          };
        },
      },
      conversationEvents: {
        listByThread(requestedThreadId: ThreadId) {
          assert.equal(requestedThreadId, threadId);
          return conversationEvents;
        },
      },
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        create(inputArtifact: Omit<Artifact, "createdAt" | "updatedAt" | "id">) {
          if (input.createArtifactError) {
            throw new Error(input.createArtifactError);
          }
          const created: Artifact = {
            ...inputArtifact,
            id: `artifact_${artifacts.length + 1}` as any,
            createdAt: 10 + artifacts.length,
            updatedAt: 10 + artifacts.length,
          };
          artifacts.push(created);
          return created;
        },
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
        updateWorkspace(artifactId: string, patch: Partial<Artifact>) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) Object.assign(artifact, patch, { updatedAt: Date.now() });
        },
      },
      orchArtifactFiles: {
        replaceForArtifact() {},
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchInstances: {
        get(requestedInstanceId: string) {
          return requestedInstanceId === instance.id ? instance : null;
        },
        listByWorkspace(workspaceId: string) {
          assert.equal(workspaceId, workflow.workspaceId);
          return [instance];
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
          instance.artifactIndex = artifactIndex as any;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchEvents: {
        append(event: Record<string, unknown>) {
          const created = {
            id: `event_${orchEvents.length + 1}`,
            createdAt: 100 + orchEvents.length,
            ...event,
          };
          orchEvents.push(created);
          return created;
        },
      },
      orchPromptSnapshots: {
        get(promptSnapshotId: string) {
          if (promptSnapshotId !== "prompt_execution_interrupted") return null;
          return { promptEnvelope: { meta: { roleExecutionRevision: roleRevision } } };
        },
        listByNode() {
          return [{ promptEnvelope: { meta: { roleExecutionRevision: roleRevision } } }];
        },
      },
      orchRoles: {
        get() {
          return role;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  (engine as any).runningInstances.set(instance.id, {
    paused: true,
    cancelled: false,
    runId: "run_test",
    drivePromise: null,
  });

  return { engine, instance, threadId, artifacts, orchEvents, conversationEvents };
}

function appendRecoveredNodeResultTurn(
  conversationEvents: Array<Record<string, any>>,
  input: {
    workspaceId: string;
    threadId: ThreadId;
    turnId: TurnId;
    submission?: NodeFinalAnswerPayload | null;
    responseText: string;
    accepted?: boolean;
  },
): void {
  const tsBase = Date.now();
  conversationEvents.push({
    ts: tsBase,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: "codex",
    type: "turn.started",
    payload: { turnId: input.turnId },
  });
  if (input.submission) {
    conversationEvents.push({
      ts: tsBase + 1,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      engine: "codex",
      type: "item.tool.started",
      payload: {
        itemId: `tool_${String(input.turnId)}`,
        toolName: "提交节点结果",
        input: input.submission,
      },
    });
    conversationEvents.push({
      ts: tsBase + 2,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      engine: "codex",
      type: "item.tool.completed",
      payload: {
        itemId: `tool_${String(input.turnId)}`,
        toolName: "提交节点结果",
        output: input.accepted === false ? {} : { accepted: true },
        status: "completed",
      },
    });
  }
  conversationEvents.push({
    ts: tsBase + 3,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: "codex",
    type: "turn.completed",
    payload: {
      turnId: input.turnId,
      result: {
        responseText: input.responseText,
      },
    },
  });
}

test("listInstancesBoundToThread excludes unrelated same-workspace and running instances", () => {
  const { engine, instance, threadId } = createExecutionInterruptedRealtimeHarness();
  const unboundInstance: OrchestrationInstance = {
    ...instance,
    id: "orch_execution_interrupted_unbound" as any,
    masterThreadId: "thread_unbound_master" as any,
    nodeStates: {
      ui: createNodeState("ui", "waiting-feedback", { threadId: "thread_unbound_node" as any }),
      end: createNodeState("end", "pending"),
    },
  };
  const masterBoundInstance: OrchestrationInstance = {
    ...unboundInstance,
    id: "orch_execution_interrupted_master_bound" as any,
    masterThreadId: threadId,
  };
  const ctx = (engine as any).ctx;
  const instances = new Map([
    [String(instance.id), instance],
    [String(unboundInstance.id), unboundInstance],
    [String(masterBoundInstance.id), masterBoundInstance],
  ]);
  ctx.db.orchInstances.get = (instanceId: string) => instances.get(instanceId) ?? null;
  ctx.db.orchInstances.listByWorkspace = () => [unboundInstance, masterBoundInstance, instance];
  (engine as any).runningInstances.set(unboundInstance.id, { paused: true, cancelled: false });

  const result = (engine as any).listInstancesBoundToThread(threadId) as OrchestrationInstance[];

  assert.deepEqual(
    result.map((candidate) => candidate.id).sort(),
    [instance.id, masterBoundInstance.id].sort(),
  );
});

test("reconcileExecutionInterruptedTurnCompletion completes current execution-interrupted node on runtime.submitNodeResult turn", async () => {
  const { engine, instance, threadId, artifacts, orchEvents, conversationEvents } = createExecutionInterruptedRealtimeHarness();
  appendRecoveredNodeResultTurn(conversationEvents, {
    workspaceId: instance.workspaceId,
    threadId,
    turnId: "turn_ui_completed" as any,
    submission: createTextFinalAnswer("原型设计已补齐并可继续。"),
    responseText: "原型设计已补齐并可继续。",
  });

  await engine.reconcileExecutionInterruptedTurnCompletion({
    threadId,
    turnId: "turn_ui_completed" as any,
    responseText: "原型设计已补齐并可继续。",
  });

  assert.equal(instance.nodeStates.ui.status, "completed");
  assert.equal(instance.nodeStates.ui.humanActionSource, null);
  assert.equal(instance.nodeStates.ui.error, null);
  assert.equal(instance.nodeStates.ui.output, "原型设计已补齐并可继续。");
  assert.equal(instance.nodeStates.ui.outputArtifactIds?.length ?? 0, 1);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.status, "approved");
  assert.ok(orchEvents.some((event) => {
    if (event.type !== "orchestration.nodeRecovered") return false;
    const payload = JSON.parse(String(event.payloadJson ?? "{}")) as Record<string, unknown>;
    return payload.action === "execution-feedback-turn-completed";
  }));
});

test("reconcileExecutionInterruptedTurnCompletion ignores node submission turns without accepted=true", async () => {
  const { engine, instance, threadId, artifacts, orchEvents, conversationEvents } = createExecutionInterruptedRealtimeHarness();
  appendRecoveredNodeResultTurn(conversationEvents, {
    workspaceId: instance.workspaceId,
    threadId,
    turnId: "turn_ui_not_accepted" as any,
    submission: createTextFinalAnswer("原型设计已补齐并可继续。"),
    responseText: "原型设计已补齐并可继续。",
    accepted: false,
  });

  await engine.reconcileExecutionInterruptedTurnCompletion({
    threadId,
    turnId: "turn_ui_not_accepted" as any,
    responseText: "原型设计已补齐并可继续。",
  });

  assert.equal(instance.nodeStates.ui.status, "waiting-feedback");
  assert.equal(instance.nodeStates.ui.humanActionSource, "execution");
  assert.equal(instance.nodeStates.ui.error, "stream disconnected before completion");
  assert.equal(instance.nodeStates.ui.outputArtifactIds?.length ?? 0, 0);
  assert.equal(artifacts.length, 0);
  assert.ok(!orchEvents.some((event) => event.type === "orchestration.nodeRecovered"));
});

test("normalizePersistedInstanceStatuses rewrites legacy running instances blocked on human input", () => {
  const intake: TaskIntake = {
    id: "intake_normalize_waiting_feedback" as any,
    workspaceId: "client-a:ws-demo" as any,
    triggerMode: "manual",
    taskType: "feature",
    title: "补充部署目录",
    goal: "等待人工补充",
    background: null,
    acceptanceCriteria: null,
    workbenchItemRefs: null,
    seedArtifactRefs: null,
    constraints: null,
    requester: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const workflow = createWorkflow([
    { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
    { id: "role", type: "role", label: "实现", roleId: "role_impl" as any, position: { x: 0, y: 120 } },
    { id: "end", type: "end", label: "结束", position: { x: 0, y: 240 } },
  ], [
    { id: "edge-start-role", sourceNodeId: "start", targetNodeId: "role", conditionBranch: null, dataMappings: [] },
    { id: "edge-role-end", sourceNodeId: "role", targetNodeId: "end", conditionBranch: null, dataMappings: [] },
  ]);
  const instance: OrchestrationInstance = {
    id: "orch_normalize_waiting_feedback" as any,
    workspaceId: intake.workspaceId,
    workflowId: workflow.id,
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow),
    intakeSnapshot: intake,
    roleSnapshots: {},
    runtimeConfig: null,
    status: "running",
    nodeStates: {
      start: createNodeState("start", "completed", { completedAt: 10 }),
      role: createNodeState("role", "waiting-feedback", {
        startedAt: 11,
        humanActionSource: "human_input",
        error: "请补充部署目录",
      }),
      end: createNodeState("end", "pending"),
    },
    artifactIndex: {},
    createdAt: 1,
    updatedAt: 1,
  };

  const updatedStatuses: string[] = [];
  const engine = new OrchestrationEngine({
    db: {
      workspaceId: intake.workspaceId,
      workspaces: {
        list() {
          return [{ id: intake.workspaceId }];
        },
      },
      orchInstances: {
        listByWorkspace(workspaceId: string) {
          return workspaceId === intake.workspaceId ? [instance] : [];
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
          updatedStatuses.push(status);
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  engine.normalizePersistedInstanceStatuses();

  assert.equal(instance.status, "waiting-feedback");
  assert.deepEqual(updatedStatuses, ["waiting-feedback"]);
});

test("reconcileExecutionInterruptedTurnCompletion ignores plain text follow-up", async () => {
  const { engine, instance, threadId, artifacts, orchEvents, conversationEvents } = createExecutionInterruptedRealtimeHarness();
  appendRecoveredNodeResultTurn(conversationEvents, {
    workspaceId: instance.workspaceId,
    threadId,
    turnId: "turn_ui_follow_up" as any,
    submission: null,
    responseText: "四张截图已经按您当前修改后的页面重新生成。",
  });

  await engine.reconcileExecutionInterruptedTurnCompletion({
    threadId,
    turnId: "turn_ui_follow_up" as any,
    responseText: "四张截图已经按您当前修改后的页面重新生成。",
  });

  assert.equal(instance.nodeStates.ui.status, "waiting-feedback");
  assert.equal(instance.nodeStates.ui.humanActionSource, "execution");
  assert.equal(instance.nodeStates.ui.error, "stream disconnected before completion");
  assert.equal(instance.nodeStates.ui.outputArtifactIds?.length ?? 0, 0);
  assert.equal(artifacts.length, 0);
  assert.ok(!orchEvents.some((event) => event.type === "orchestration.nodeRecovered"));
});

test("reconcileExecutionInterruptedTurnCompletion ignores non-execution waiting-feedback nodes", async () => {
  const { engine, instance, threadId, artifacts, orchEvents, conversationEvents } = createExecutionInterruptedRealtimeHarness({
    nodeStatePatch: {
      error: "请补充业务约束后再继续。",
      humanActionSource: "human_input",
    },
  });
  appendRecoveredNodeResultTurn(conversationEvents, {
    workspaceId: instance.workspaceId,
    threadId,
    turnId: "turn_human_feedback" as any,
    submission: createTextFinalAnswer("请补充业务约束后再继续。"),
    responseText: "请补充业务约束后再继续。",
  });

  await engine.reconcileExecutionInterruptedTurnCompletion({
    threadId,
    turnId: "turn_human_feedback" as any,
    responseText: "请补充业务约束后再继续。",
  });

  assert.equal(instance.nodeStates.ui.status, "waiting-feedback");
  assert.equal(instance.nodeStates.ui.humanActionSource, "human_input");
  assert.equal(instance.nodeStates.ui.error, "请补充业务约束后再继续。");
  assert.equal(artifacts.length, 0);
  assert.ok(!orchEvents.some((event) => event.type === "orchestration.nodeRecovered"));
});

test("reconcileExecutionInterruptedTurnCompletion fails an accepted submission when artifact persistence fails", async () => {
  const { engine, instance, threadId, artifacts, orchEvents, conversationEvents } = createExecutionInterruptedRealtimeHarness({
    createArtifactError: "artifact persist failed",
  });
  appendRecoveredNodeResultTurn(conversationEvents, {
    workspaceId: instance.workspaceId,
    threadId,
    turnId: "turn_ui_completed" as any,
    submission: createTextFinalAnswer("原型设计已补齐并可继续。"),
    responseText: "原型设计已补齐并可继续。",
  });

  await assert.rejects(
    engine.reconcileExecutionInterruptedTurnCompletion({
      threadId,
      turnId: "turn_ui_completed" as any,
      responseText: "原型设计已补齐并可继续。",
    }),
    /artifact persist failed/,
  );

  assert.equal(instance.nodeStates.ui.status, "failed");
  assert.equal(instance.nodeStates.ui.humanActionSource, null);
  assert.equal(instance.nodeStates.ui.error, "artifact persist failed");
  assert.equal(instance.status, "failed");
  assert.equal(instance.nodeStates.ui.outputArtifactIds?.length ?? 0, 0);
  assert.equal(artifacts.length, 0);
  assert.ok(!orchEvents.some((event) => event.type === "orchestration.nodeRecovered"));
  assert.ok(orchEvents.some((event) => event.type === "orchestration.nodeFinalizationFailed"));
});

test("reconcileRecoveredRoleNode fails a persisted accepted Attempt when restart finalization fails", async () => {
  const { engine, instance, artifacts, orchEvents } = createExecutionInterruptedRealtimeHarness({
    createArtifactError: "restart artifact persist failed",
  });
  const node = instance.workflowSnapshot.nodes.find((item) => item.id === "ui")!;
  const role = instance.roleSnapshots?.[String(node.roleId)];
  assert.ok(role);
  const finalAnswer = createTextFinalAnswer("原型设计已补齐并可继续。");
  const attemptId = prepareSubmittedNodeAttempt(
    engine,
    instance,
    node,
    finalAnswer,
    "原型设计已补齐并可继续。",
  );

  await assert.rejects(
    (engine as any).reconcileRecoveredRoleNode(
      instance.id,
      node,
      instance,
      role,
      instance.nodeStates.ui,
    ),
    /restart artifact persist failed/,
  );

  assert.equal(instance.nodeStates.ui.status, "failed");
  assert.equal(instance.status, "failed");
  assert.equal((engine as any).ctx.db.orchNodeAttempts.get(attemptId)?.status, "failed");
  assert.equal(artifacts.length, 0);
  assert.ok(orchEvents.some((event) => event.type === "orchestration.nodeFinalizationFailed"));
});

test("executeConditionNode skips only the unselected branch and preserves shared downstream nodes", async () => {
  const workflow: WorkflowDefinition = {
    id: "wf_condition" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "condition-join",
    description: "condition-join",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "condition", type: "condition", label: "复杂度判断", position: { x: 0, y: 0 }, conditionExpr: "如果需求复杂则走 Yes，否则走 No。复杂任务返回 Yes。" },
      { id: "yes-node", type: "role", label: "复杂分支", position: { x: 200, y: 0 }, roleId: "role_impl" as any },
      { id: "no-node", type: "role", label: "简单分支", position: { x: 200, y: 120 }, roleId: "role_impl" as any },
      { id: "join", type: "parallel-join", label: "汇合", position: { x: 400, y: 60 } },
      { id: "impl", type: "role", label: "实现", position: { x: 560, y: 60 }, roleId: "role_impl" as any },
    ],
    edges: [
      { id: "e-condition-no", sourceNodeId: "condition", targetNodeId: "no-node", conditionBranch: "No", dataMappings: [] },
      { id: "e-condition-yes", sourceNodeId: "condition", targetNodeId: "yes-node", conditionBranch: "Yes", dataMappings: [] },
      { id: "e-yes-join", sourceNodeId: "yes-node", targetNodeId: "join", dataMappings: [] },
      { id: "e-no-join", sourceNodeId: "no-node", targetNodeId: "join", dataMappings: [] },
      { id: "e-join-impl", sourceNodeId: "join", targetNodeId: "impl", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  const instance: OrchestrationInstance = {
    id: "orch_condition" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_condition" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "复杂条件分支测试",
      goal: [
        "这是一个非常复杂的需求，需要同时改页面结构、状态模型、筛选逻辑、导出能力、README、单元测试、浏览器路径验证、交付整理、运行时证据核对和多角色协作编排。",
        "它不仅涉及多个前端模块，还会牵动条件判断、并行汇合、工件落地和后续验证链路。",
        "为了确保这个测试一定命中复杂分支，这里故意把需求描述写得更长、更复杂，也更接近真实的软件工程场景。",
        "复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂复杂",
      ].join(" "),
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow),
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      condition: createNodeState("condition"),
      "yes-node": createNodeState("yes-node"),
      "no-node": createNodeState("no-node"),
      join: createNodeState("join"),
      impl: createNodeState("impl"),
    },
    createdAt: 1,
    updatedAt: 1,
  };

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        updateNodeStates() {},
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
      },
      orchRoles: {
        get() { return null; },
      },
      orchEvents: {
        append() {},
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  await (engine as any).executeConditionNode(instance.id, workflow.nodes[0], instance);

  assert.equal(instance.nodeStates.condition.branchTaken, "No");
  assert.equal(instance.nodeStates["yes-node"].status, "skipped");
  assert.equal(instance.nodeStates["no-node"].status, "pending");
  assert.equal(instance.nodeStates.join.status, "pending");
  assert.equal(instance.nodeStates.impl.status, "pending");
});

test("executeConditionNode preserves unselected direct targets that remain reachable downstream", async () => {
  const workflow: WorkflowDefinition = {
    id: "wf_condition_downstream_target" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "condition-downstream-target",
    description: "condition-downstream-target",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "route", type: "condition", label: "走哪个分支", position: { x: 0, y: 0 } },
      { id: "branch-1", type: "role", label: "分支流程1", position: { x: 200, y: 0 }, roleId: "role_impl" as any },
      { id: "branch-2", type: "condition", label: "分支流程2", position: { x: 400, y: 0 } },
      { id: "branch-3", type: "role", label: "分支流程3", position: { x: 600, y: 0 }, roleId: "role_impl" as any },
    ],
    edges: [
      { id: "e-route-branch-1", sourceNodeId: "route", targetNodeId: "branch-1", conditionBranch: "分支流程1", dataMappings: [] },
      { id: "e-route-branch-2", sourceNodeId: "route", targetNodeId: "branch-2", conditionBranch: "分支流程2", dataMappings: [] },
      { id: "e-route-branch-3", sourceNodeId: "route", targetNodeId: "branch-3", conditionBranch: "分支流程3", dataMappings: [] },
      { id: "e-branch-1-branch-2", sourceNodeId: "branch-1", targetNodeId: "branch-2", dataMappings: [] },
      { id: "e-branch-2-branch-3", sourceNodeId: "branch-2", targetNodeId: "branch-3", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_condition_downstream_target" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_condition_downstream_target" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "条件分支下游复用测试",
      goal: "条件分支节点同时作为条件出边目标和已选分支下游时不能被跳过。",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow),
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      route: createNodeState("route"),
      "branch-1": createNodeState("branch-1"),
      "branch-2": createNodeState("branch-2"),
      "branch-3": createNodeState("branch-3"),
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        updateNodeStates() {},
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
      },
      orchRoles: {
        get() { return null; },
      },
      orchEvents: {
        append() {},
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  await (engine as any).executeConditionNode(instance.id, workflow.nodes[0], instance);

  assert.equal(instance.nodeStates.route.branchTaken, "分支流程1");
  assert.equal(instance.nodeStates["branch-1"].status, "pending");
  assert.equal(instance.nodeStates["branch-2"].status, "pending");
  assert.equal(instance.nodeStates["branch-3"].status, "pending");

  instance.nodeStates["branch-1"].status = "completed";
  const readyNodeIds = (engine as any).findReadyNodes(workflow.nodes, workflow.edges, instance)
    .map((node: WorkflowNode) => node.id);
  assert.deepEqual(readyNodeIds, ["branch-2"]);
});

test("manual condition node waits for branch choice and choose_branch selects a target", async () => {
  const workflow: WorkflowDefinition = {
    id: "wf_manual_condition" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "manual-condition",
    description: "manual-condition",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "condition", type: "condition", label: "人工决策", position: { x: 0, y: 0 }, conditionDecisionMode: "manual" },
      { id: "yes-node", type: "role", label: "分支 A", position: { x: 200, y: 0 }, roleId: "role_impl" as any },
      { id: "no-node", type: "role", label: "分支 B", position: { x: 200, y: 120 }, roleId: "role_impl" as any },
      { id: "join", type: "parallel-join", label: "汇合", position: { x: 400, y: 60 } },
    ],
    edges: [
      { id: "e-condition-yes", sourceNodeId: "condition", targetNodeId: "yes-node", conditionBranch: "Yes", dataMappings: [] },
      { id: "e-condition-no", sourceNodeId: "condition", targetNodeId: "no-node", conditionBranch: "No", dataMappings: [] },
      { id: "e-yes-join", sourceNodeId: "yes-node", targetNodeId: "join", dataMappings: [] },
      { id: "e-no-join", sourceNodeId: "no-node", targetNodeId: "join", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_manual_condition" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_manual_condition" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "人工条件分支测试",
      goal: "需要人工选择分支",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow),
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "paused",
    nodeStates: {
      condition: createNodeState("condition"),
      "yes-node": createNodeState("yes-node"),
      "no-node": createNodeState("no-node"),
      join: createNodeState("join"),
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const events: Array<{ type: string; payload: any }> = [];
  const feedbackRecords: any[] = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get() { return instance; },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
      },
      orchFeedback: {
        create(input: any) {
          const record = { id: `feedback-${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchRoles: {
        get() { return null; },
      },
      orchEvents: {
        append(input: any) {
          events.push({ type: input.type, payload: JSON.parse(input.payloadJson) });
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  await (engine as any).executeConditionNode(instance.id, workflow.nodes[0], instance);

  assert.equal(instance.nodeStates.condition.status, "waiting-feedback");
  assert.equal(instance.nodeStates.condition.humanActionSource, "branch_decision");
  assert.equal(events.some((event) => event.type === "orchestration.feedbackRequested" && event.payload.source === "branch_decision"), true);

  await engine.submitFeedback(instance.id, "condition", "choose_branch", { targetNodeId: "no-node" });

  assert.equal(instance.nodeStates.condition.status, "completed");
  assert.equal(instance.nodeStates.condition.branchTaken, "No");
  assert.equal(instance.nodeStates["yes-node"].status, "skipped");
  assert.equal(instance.nodeStates["no-node"].status, "pending");
  assert.equal(instance.nodeStates.join.status, "pending");
  assert.equal(feedbackRecords[0]?.action, "choose_branch");
});

test("manual condition choose_branch distinguishes unlabeled target branches", async () => {
  const workflow: WorkflowDefinition = {
    id: "wf_manual_condition_unlabeled" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "manual-condition-unlabeled",
    description: "manual-condition-unlabeled",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "condition", type: "condition", label: "人工决策", position: { x: 0, y: 0 }, conditionDecisionMode: "manual" },
      { id: "false-node", type: "role", label: "输出false", position: { x: 200, y: 0 }, roleId: "role_impl" as any },
      { id: "true-node", type: "role", label: "输出true", position: { x: 200, y: 120 }, roleId: "role_impl" as any },
    ],
    edges: [
      { id: "e-condition-false", sourceNodeId: "condition", targetNodeId: "false-node", conditionBranch: null, dataMappings: [] },
      { id: "e-condition-true", sourceNodeId: "condition", targetNodeId: "true-node", conditionBranch: null, dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance: OrchestrationInstance = {
    id: "orch_manual_condition_unlabeled" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_manual_condition_unlabeled" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "无标签人工条件分支测试",
      goal: "人工选择输出true时输出false不能一起执行。",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: createAssetRuntimeSnapshot(workflow),
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "paused",
    nodeStates: {
      condition: createNodeState("condition"),
      "false-node": createNodeState("false-node"),
      "true-node": createNodeState("true-node"),
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const feedbackRecords: any[] = [];
  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get() { return instance; },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
      },
      orchArtifacts: {
        listByInstance() { return []; },
        listByNode() { return []; },
      },
      orchFeedback: {
        create(input: any) {
          const record = { id: `feedback-${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
      },
      orchRoles: {
        get() { return null; },
      },
      orchEvents: {
        append(input: any) { return input; },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  await (engine as any).executeConditionNode(instance.id, workflow.nodes[0], instance);
  await engine.submitFeedback(instance.id, "condition", "choose_branch", { targetNodeId: "true-node" });

  assert.equal(instance.nodeStates.condition.status, "completed");
  assert.equal(instance.nodeStates.condition.branchTaken, "target:true-node");
  assert.equal(instance.nodeStates["false-node"].status, "skipped");
  assert.equal(instance.nodeStates["true-node"].status, "pending");
  const readyNodeIds = (engine as any).findReadyNodes(workflow.nodes, workflow.edges, instance)
    .map((node: WorkflowNode) => node.id);
  assert.deepEqual(readyNodeIds, ["true-node"]);
  assert.equal(feedbackRecords[0]?.action, "choose_branch");
});

test("stopAndDrain skips queued continuations and blocks new orchestration execution", async () => {
  const role = createRole({ id: "role_shutdown_gate" as any, name: "关闭门禁" });
  const node: WorkflowNode = { id: "end", type: "end", label: "结束", position: { x: 0, y: 0 } };
  const workflow = createWorkflow([node], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_shutdown_gate" as any,
    status: "running",
    nodeStates: { end: createNodeState("end", "pending") },
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);

  let activityStarts = 0;
  let activityReleases = 0;
  let continuationCalls = 0;
  let continuationFailureCalls = 0;
  let claimCalls = 0;
  (engine as any).ctx.beginWorkspaceActivity = () => {
    activityStarts += 1;
    return () => {
      activityReleases += 1;
    };
  };
  (engine as any).scheduleDatabaseContinuation(
    instance.id,
    async () => {
      continuationCalls += 1;
    },
    () => {
      continuationFailureCalls += 1;
    },
  );

  const state = (engine as any).createRunState();
  state.runId = "run_shutdown_gate";
  (engine as any).runningInstances.set(instance.id, state);
  void (engine as any).getCoordinatorWakePromise(state);
  (engine as any).claimReadyNodeForExecution = () => {
    claimCalls += 1;
    return true;
  };

  engine.stop();
  assert.equal(state.wakeResolver, null);
  const drainPromise = engine.stopAndDrain();
  await drainPromise;
  await (engine as any).executeReadyNodeBatches(instance.id, state.runId, { resolveIdleOutcome: true });

  assert.equal(activityStarts, 1);
  assert.equal(activityReleases, 1);
  assert.equal(continuationCalls, 0);
  assert.equal(continuationFailureCalls, 0);
  assert.equal(claimCalls, 0);
  assert.equal(instance.status, "running");
  assert.equal(instance.nodeStates.end.status, "pending");
  assert.equal((engine as any).hasPendingCoordinatorWork(instance.id, state), false);
  assert.throws(
    () => (engine as any).startCoordinator(instance.id, state),
    /编排引擎正在停止/,
  );
  await assert.rejects(engine.start(instance.id), /编排引擎正在停止/);
});

test("start rechecks shutdown after awaiting an existing runtime snapshot", async () => {
  const role = createRole({ id: "role_shutdown_start_race" as any, name: "启动竞态" });
  const workflow = createWorkflow([], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_shutdown_start_race" as any,
    status: "pending",
    nodeStates: {},
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const statusUpdates: OrchestrationInstance["status"][] = [];
  (engine as any).ctx.db.orchInstances.updateStatus = (
    _instanceId: string,
    status: OrchestrationInstance["status"],
  ) => {
    statusUpdates.push(status);
    instance.status = status;
  };

  const startPromise = engine.start(instance.id);
  const drainPromise = engine.stopAndDrain();
  await Promise.all([
    drainPromise,
    assert.rejects(startPromise, /编排引擎正在停止/),
  ]);

  assert.deepEqual(statusUpdates, []);
  assert.equal(instance.status, "pending");
  assert.equal((engine as any).runningInstances.has(instance.id), false);
});

test("stopAndDrain waits for owned orchestration work and dynamically added runtime disposal", async () => {
  const role = createRole({ id: "role_shutdown_owner" as any, name: "关闭 owner" });
  const workflow = createWorkflow([], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_shutdown_owner" as any,
    status: "running",
    nodeStates: {},
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);

  let resolveRecovery!: () => void;
  let recoveryPromise!: Promise<void>;
  recoveryPromise = new Promise<void>((resolve) => {
    resolveRecovery = resolve;
  }).finally(() => {
    (engine as any).recoveryPromises.delete(instance.id);
  });
  (engine as any).recoveryPromises.set(instance.id, recoveryPromise);

  const state = (engine as any).createRunState();
  let resolveDrive!: () => void;
  let drivePromise!: Promise<void>;
  drivePromise = new Promise<void>((resolve) => {
    resolveDrive = resolve;
  }).finally(() => {
    if (state.drivePromise === drivePromise) state.drivePromise = null;
  });
  state.drivePromise = drivePromise;
  (engine as any).runningInstances.set(instance.id, state);

  let resolveDisposal!: () => void;
  let signalDisposalStarted!: () => void;
  const disposalStarted = new Promise<void>((resolve) => {
    signalDisposalStarted = resolve;
  });
  (engine as any).managedServiceRuntime.disposeInstanceServices = async () => {
    signalDisposalStarted();
    await new Promise<void>((resolve) => {
      resolveDisposal = resolve;
    });
  };

  let resolveActiveNode!: () => void;
  let activeNodePromise!: Promise<{ nodeId: string; error: null }>;
  activeNodePromise = new Promise<void>((resolve) => {
    resolveActiveNode = resolve;
  })
    .then(() => {
      (engine as any).disposeManagedRuntimeInBackground(instance.id, "shutdown_owner_test");
      return { nodeId: "node", error: null };
    })
    .finally(() => {
      state.activeNodePromises.delete("node");
    });
  state.activeNodePromises.set("node", activeNodePromise);

  let continuationStarted = false;
  let resolveContinuation!: () => void;
  (engine as any).scheduleDatabaseContinuation(
    instance.id,
    async () => {
      continuationStarted = true;
      await new Promise<void>((resolve) => {
        resolveContinuation = resolve;
      });
    },
    (error: unknown) => {
      throw error;
    },
  );
  await nextTimerTick();
  assert.equal(continuationStarted, true);

  let drained = false;
  const drainPromise = engine.stopAndDrain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);

  resolveRecovery();
  resolveDrive();
  resolveContinuation();
  await Promise.resolve();
  assert.equal(drained, false);

  resolveActiveNode();
  await disposalStarted;
  assert.equal(drained, false);

  resolveDisposal();
  await drainPromise;
  assert.equal(drained, true);
  assert.equal(instance.status, "running");
});

test("background coordinator hands off immediately while drain owns runtime disposal failure", async () => {
  const role = createRole({ id: "role_shutdown_disposal_error" as any, name: "释放失败" });
  const workflow = createWorkflow([], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_shutdown_disposal_error" as any,
    status: "completed",
    nodeStates: {},
  };
  const { engine, orchestrationEvents } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const state = (engine as any).createRunState();
  (engine as any).runningInstances.set(instance.id, state);
  (engine as any).executeDAG = async () => {};
  let releaseDisposal!: () => void;
  let signalDisposalStarted!: () => void;
  const disposalStarted = new Promise<void>((resolve) => {
    signalDisposalStarted = resolve;
  });
  (engine as any).managedServiceRuntime.disposeInstanceServices = async () => {
    signalDisposalStarted();
    await new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    throw new Error("managed runtime dispose failed");
  };

  await (engine as any).continueRunInBackground(instance.id, state);
  await disposalStarted;
  const drainPromise = engine.stopAndDrain();
  releaseDisposal();

  await assert.rejects(drainPromise, /managed runtime dispose failed/);
  assert.equal(state.drivePromise, null);
  assert.equal((engine as any).runningInstances.has(instance.id), false);
  assert.equal(orchestrationEvents.some((event) => event.type === "orchestration.error"), false);
});

test("stopAndDrain reports coordinator errors without writing a business failure status", async () => {
  const role = createRole({ id: "role_shutdown_drive_error" as any, name: "执行失败" });
  const workflow = createWorkflow([], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_shutdown_drive_error" as any,
    status: "running",
    nodeStates: {},
  };
  const { engine, orchestrationEvents } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const statusUpdates: OrchestrationInstance["status"][] = [];
  (engine as any).ctx.db.orchInstances.updateStatus = (
    _instanceId: string,
    status: OrchestrationInstance["status"],
  ) => {
    statusUpdates.push(status);
    instance.status = status;
  };

  let releaseExecution!: () => void;
  (engine as any).executeDAG = async () => {
    await new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    throw new Error("active node failed during shutdown");
  };
  const state = (engine as any).createRunState();
  (engine as any).runningInstances.set(instance.id, state);
  await (engine as any).continueRunInBackground(instance.id, state);

  const drainPromise = engine.stopAndDrain();
  await Promise.resolve();
  releaseExecution();

  await assert.rejects(drainPromise, /active node failed during shutdown/);
  assert.deepEqual(statusUpdates, []);
  assert.equal(instance.status, "running");
  assert.equal(state.drivePromise, null);
  assert.equal(orchestrationEvents.some((event) => event.type === "orchestration.error"), false);
});

test("stopAndDrain reports active node errors that settle after the coordinator stops", async () => {
  const role = createRole({ id: "role_shutdown_active_error" as any, name: "节点失败" });
  const node: WorkflowNode = { id: "node", type: "end", label: "节点", position: { x: 0, y: 0 } };
  const workflow = createWorkflow([node], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_shutdown_active_error" as any,
    status: "running",
    nodeStates: { node: createNodeState("node", "pending") },
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);
  const state = (engine as any).createRunState();
  (engine as any).runningInstances.set(instance.id, state);
  (engine as any).findReadyNodes = () => [node];
  (engine as any).claimReadyNodeForExecution = () => true;

  let releaseNode!: () => void;
  (engine as any).executeNode = async () => {
    await new Promise<void>((resolve) => {
      releaseNode = resolve;
    });
    throw new Error("active node failed after stop");
  };
  assert.equal((engine as any).launchReadyNodes(instance.id, instance, state), 1);

  const drainPromise = engine.stopAndDrain();
  releaseNode();

  await assert.rejects(drainPromise, /active node failed after stop/);
  assert.equal(instance.status, "running");
  assert.equal(state.activeNodePromises.size, 0);
});

test("asset runtime snapshot backfill rechecks the shutdown gate before execution", async () => {
  const role = createRole({ id: "role_shutdown_snapshot" as any, name: "补录门禁" });
  const workflow = createWorkflow([], []);
  const instance: OrchestrationInstance = {
    ...createInstance(role, workflow),
    id: "orch_shutdown_snapshot" as any,
    status: "running",
    assetRuntimeSnapshot: null,
    nodeStates: {},
  };
  const { engine } = createHarness({ liveRole: role });
  bindSingleInstanceRepo(engine, instance);

  let releaseBackfill!: () => void;
  let backfillStarted = false;
  (engine as any).ctx.ensureAssetRuntimeSnapshot = async () => {
    backfillStarted = true;
    await new Promise<void>((resolve) => {
      releaseBackfill = resolve;
    });
    instance.assetRuntimeSnapshot = createAssetRuntimeSnapshot(workflow, { roles: [role] });
    return instance.assetRuntimeSnapshot;
  };

  const executionPromise = engine.ensureAssetRuntimeSnapshotForExecution(instance.id);
  assert.equal(backfillStarted, true);
  await engine.stopAndDrain();
  releaseBackfill();

  await assert.rejects(executionPromise, /编排引擎正在停止/);
  assert.ok(instance.assetRuntimeSnapshot);
  assert.equal(instance.status, "running");
});
