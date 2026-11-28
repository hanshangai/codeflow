import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RoleDefinition, WorkflowDefinition, WorkflowNode } from "@codeflowai/shared";
import { createDefaultRoleExecutionConfig, createDefaultRoleExecutionCustomConfig } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";

/** 屏障直接控制真实 session 与资源尾链的结算顺序。 */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 只读物理日志；缺目录表示该工作区没有写入。 */
function logs(root: string): any[] {
  const directory = path.join(root, ".codeflowai");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^client-.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

/** 真实 A/B、实例、线程和 Attempt；仅替外部 session 与确定故障出口。 */
function fixture(t: TestContext, kind: "empty" | "role" | "parallel" | "successor" = "role") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-lifecycle-")), a = path.join(root, "A"), b = path.join(root, "B");
  fs.mkdirSync(a); fs.mkdirSync(b);
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  t.after(() => { t.mock.restoreAll(); db.close(); resetEngineModelCatalogRuntimeForTest(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspaceId = "workspace-lifecycle-a", otherId = "workspace-lifecycle-b";
  db.workspaces.upsert({ id: workspaceId, title: "可信中文😀", path: a });
  db.workspaces.upsert({ id: otherId, title: "错误落点", path: b });
  const config = createDefaultRoleExecutionConfig();
  config.preferredEngine = "claude";
  config.engineProfiles.claude = { enabled: true, mode: "custom", customConfig: { ...createDefaultRoleExecutionCustomConfig("claude"), model: "claude-sonnet-4-6", maxRetries: 0 } };
  const role: RoleDefinition = { id: "role-lifecycle", workspaceId, name: "角色", description: "执行", responsibility: "执行", systemPrompt: "执行",
    inputDefinition: { instructions: "任务", requiredFields: [] }, outputDefinition: { instructions: "", deliveryMode: "direct", format: "markdown", resultKey: "report", filePathRule: null, requiredFields: [] },
    gateCriteria: [], executionConfig: config, defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom", createdAt: 1, updatedAt: 1 } as RoleDefinition;
  const node: WorkflowNode = { id: "role", type: "role", roleId: role.id, label: "执行中文😀", position: { x: 0, y: 0 } };
  const workflow: WorkflowDefinition = { id: "workflow-lifecycle", workspaceId, family: "feature-dev", name: "生命周期", description: "生命周期", version: 1,
    nodes: kind === "empty" ? [] : [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } }, node, ...(kind === "parallel" || kind === "successor" ? [{ ...node, id: "other" }] : []), ...(kind === "successor" ? [{ ...node, id: "successor" }] : [])],
    edges: kind === "empty" ? [] : [...["role", ...(kind === "parallel" || kind === "successor" ? ["other"] : [])].map(id => ({ id: `edge-${id}`, sourceNodeId: "start", targetNodeId: id, conditionBranch: null, dataMappings: [] })),
      ...(kind === "successor" ? [{ id: "edge-successor", sourceNodeId: "other", targetNodeId: "successor", conditionBranch: null, dataMappings: [] }] : [])], createdAt: 1, updatedAt: 1 } as WorkflowDefinition;
  const { createdAt: _r1, updatedAt: _r2, ...roleDefinition } = role;
  const { createdAt: _w1, updatedAt: _w2, ...workflowDefinition } = workflow;
  const instance = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    intakeSnapshot: { id: "intake-lifecycle", workspaceId, triggerMode: "manual", taskType: "feature", title: "生命周期", goal: "生命周期", background: null, acceptanceCriteria: null, workbenchItemRefs: null, seedArtifactRefs: null, constraints: null, requester: null, createdAt: 1, updatedAt: 1 },
    assetRuntimeSnapshot: { authorityMode: "legacy", workflow: { assetType: "workflow", assetId: workflow.id, definition: workflowDefinition, source: null },
      roles: { [role.id]: { assetType: "role", assetId: role.id, definition: roleDefinition, source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 } } }, knowledgeBundles: {}, toolsets: {}, skills: {} },
    runtimeConfig: { executionProfileScope: { scopeType: "shared_workspace", scopeId: otherId } } as any });
  let active: string | null = null, sends = 0;
  const sessions = { getActiveTurnId() { return active; }, async interrupt() { active = null; return true; }, releaseCodexRecoveryPending() { return false; },
    getOrCreate(thread: any) { return { resolvePlatformToolTransport() { return "native-dynamic"; }, async sendMessage(input: any) { sends++; return await send(input, thread); },
      async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; } }; } };
  let send = async (_input: any, _thread: any): Promise<any> => { throw new Error("SESSION_BUSINESS token=LIFECYCLE_SECRET"); };
  let release = () => {}, emit = (_event: any) => {};
  const engine = new OrchestrationEngine({ db, threads: new ThreadStore(), sessions: sessions as any,
    workspaces: new Map([[workspaceId, b], [otherId, b]]), timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 },
    beginWorkspaceActivity() { return () => release(); }, emitOrchestration(_workspace, event) { emit(event); }, emitRaw() {},
    emitConversation(event) {
      if (event.type === "turn.started") { active = event.payload.turnId!; db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine, turnId: event.payload.turnId!, startedAt: event.ts, startEventSeq: null }); }
      if (event.type === "turn.completed" || event.type === "turn.error") db.turns.setEnded(event.payload.turnId!, { status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: null });
    } });
  return { root, a, b, db, engine, instance, node, sessions, sends: () => sends,
    setSend(value: typeof send) { send = value; }, setRelease(value: typeof release) { release = value; }, setEmit(value: typeof emit) { emit = value; },
    /** 持久记录确定的待启动或运行中 Attempt，不注入 engine owner。 */
    stage(status: "running" | "waiting-start" | "waiting-approval" = "running", fence = false) {
      const threadId = "thread-lifecycle", turnId = "turn-lifecycle";
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "恢复", threadType: "orchestration" });
      const attempt = db.orchNodeAttempts.begin({ instanceId: instance.id, nodeId: node.id });
      db.orchNodeAttempts.bindExecution(attempt.id, threadId, turnId);
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: null }); active = turnId;
      const latest = db.orchInstances.get(instance.id)!;
      latest.nodeStates.start!.status = "completed";
      latest.nodeStates[node.id] = { ...latest.nodeStates[node.id]!, status, threadId, attemptId: attempt.id, attemptNo: 1, ...(fence ? { preserveBinding: true, providerThreadId: "provider-lifecycle" } : {}) };
      db.orchInstances.updateNodeStates(instance.id, latest.nodeStates); db.orchInstances.updateStatus(instance.id, status === "waiting-start" ? "waiting-start" : status);
      return { threadId, turnId, attempt };
    } };
}

/** 只沿受控聚合 data 字段检查原对象，不按 message 合并独立原因。 */
function contains(error: unknown, expected: unknown): boolean {
  return Object.is(error, expected) || error instanceof AggregateError && error.errors.some(item => contains(item, expected));
}

for (const action of [false, true]) test(`编排${action ? "待办" : "完成"}通知沿原异步owner报告失败，只写可信W`, async t => {
  const f = fixture(t, "empty");
  const notifier = { async notifyCompletion() { throw undefined; }, async notifyAction() { throw undefined; } };
  (f.engine as any).ctx.reminderCompletionNotifier = notifier;
  if (action) {
    (f.engine as any).notifyOrchestrationActionIfNeeded(f.instance, f.node, { status: "waiting-start" }, null, "waiting-start");
  } else await f.engine.start(f.instance.id);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.engine.waitForInFlightWork(), error => error === undefined);
  assert.equal(logs(f.a).filter(row => row.code === (action ? "ORCHESTRATION_ACTION_NOTIFICATION_FAILED" : "ORCHESTRATION_COMPLETION_NOTIFICATION_FAILED")).length, 1);
  assert.equal(logs(f.b).length, 0);
  if (!action) assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed");
});

test("编排已完成后的通知与诊断双错保原值，不伪造业务失败", async t => {
  const f = fixture(t, "empty");
  (f.engine as any).ctx.reminderCompletionNotifier = { async notifyCompletion() { throw false; } };
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((id, entry) => {
    if (entry.message === "completion external notification failed") throw 0;
    return write(id, entry);
  }) as typeof write);
  await f.engine.start(f.instance.id);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.engine.waitForInFlightWork(), error => contains(error, false) && contains(error, 0));
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed");
});

test("orchestration workspace lifecycle role failure writes only trusted A with searchable safe context", async t => {
  const f = fixture(t);
  await f.engine.start(f.instance.id);
  const rows = logs(f.a).filter(row => row.msg === "role execution failed" || row.message === "role execution failed");
  assert.equal(rows.length, 1); assert.equal(logs(f.b).length, 0);
  assert.equal(rows[0].workspaceId, f.instance.workspaceId); assert.equal(rows[0].instanceId, f.instance.id);
  assert.equal(rows[0].requestId, `node-attempt:${f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "role")!.id}`);
  assert.equal(rows[0].event.outcome, "fail"); assert.doesNotMatch(JSON.stringify(rows), /LIFECYCLE_SECRET/);
  assert.equal(f.sends(), 1);
});

test("orchestration workspace lifecycle cancellation keeps original causes and waits cleanup before concurrent consumers", async t => {
  const f = fixture(t), business = new Error("INTERRUPT token=LIFECYCLE_SECRET"), logging = false, gate = deferred<void>();
  f.stage(); f.sessions.interrupt = async () => { throw business; };
  let disposals = 0;
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { disposals++; await gate.promise; };
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  let settled = false;
  const cancelling = f.engine.cancelAndWait(f.instance.id).finally(() => { settled = true; });
  const first = assert.rejects(cancelling, error => contains(error, business) && contains(error, logging));
  const second = assert.rejects(f.engine.waitForInFlightWork(), error => contains(error, business) && contains(error, logging));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(disposals, 1); assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "cancelled");
});

for (const value of [undefined, null, false, 0, -0, NaN, ""] as const) test(`orchestration workspace lifecycle cancellation preserves falsy business ${String(value)} ${Object.is(value, -0)}`, async t => {
  const f = fixture(t), logging = new Error("WRITER_FAILED"); f.stage();
  f.sessions.interrupt = async () => { throw value; };
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  await assert.rejects(f.engine.cancelAndWait(f.instance.id), error => {
    assert.ok(error instanceof AggregateError); assert.ok(Object.is(error.errors[0], value)); assert.equal(error.errors[1], logging); return true;
  });
});

test("orchestration workspace lifecycle unknown error descriptors never execute getters or coercion", async t => {
  const f = fixture(t); f.stage(); let reads = 0;
  const business = Object.defineProperties({}, { message: { get() { reads++; throw new Error("MESSAGE_GET"); } }, code: { get() { reads++; throw new Error("CODE_GET"); } },
    toString: { value() { reads++; throw new Error("STRING_CALL"); } } });
  f.sessions.interrupt = async () => { throw business; };
  await assert.rejects(f.engine.cancelAndWait(f.instance.id), error => error === business);
  assert.equal(reads, 0); assert.equal(logs(f.a).filter(row => row.code === "ORCHESTRATION_CANCEL_FAILED").length, 1);
});

test("orchestration workspace lifecycle manual override logging failure prevents feedback and completion", async t => {
  const f = fixture(t), business = new Error("OVERRIDE_INTERRUPT"), logging = new Error("OVERRIDE_LOG"); f.stage();
  f.sessions.interrupt = async () => { throw business; };
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  await assert.rejects(f.engine.submitFeedback(f.instance.id, "role", "override"), error => contains(error, business) && contains(error, logging));
  assert.equal(f.db.orchInstances.get(f.instance.id)!.nodeStates.role.status, "running");
  assert.equal(f.db.orchFeedback.listByInstance(f.instance.id).length, 0); assert.equal(f.sends(), 0);
});

test("orchestration workspace lifecycle false fence preserves cancellation but writer rejection still drains disposal", async t => {
  const f = fixture(t), logging = new Error("FENCE_LOG"); f.stage("running", true);
  let disposals = 0; (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { disposals++; };
  const original = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message.includes("recovery fence")) throw logging; return original(workspaceId, entry); }) as typeof original);
  await assert.rejects(f.engine.cancelAndWait(f.instance.id), error => contains(error, logging));
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "cancelled"); assert.equal(disposals, 1);
});

for (const source of ["manual", "skip"] as const) test(`orchestration workspace lifecycle ${source} continuation retains task log release after settled wait`, async t => {
  const f = fixture(t, "parallel"), business = new Error("CONTINUATION_TASK"), logging = new Error("CONTINUATION_LOG"), release = new Error("CONTINUATION_RELEASE");
  f.stage("waiting-start"); let released = 0;
  f.setRelease(() => { released++; throw release; });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message === "database continuation owner failed") throw logging; return write(workspaceId, entry); }) as typeof write);
  if (source === "manual") await f.engine.startWaitingNode(f.instance.id, "role"); else await f.engine.skipWaitingNode(f.instance.id, "role");
  const get = f.db.orchInstances.get.bind(f.db.orchInstances); let failed = false;
  t.mock.method(f.db.orchInstances, "get", ((...args: Parameters<typeof get>) => { if (!failed) { failed = true; throw business; } return get(...args); }) as typeof get);
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  assert.equal(f.engine.hasInFlightWork(), false);
  await assert.rejects(f.engine.waitForInFlightWork(), error => contains(error, business) && contains(error, logging) && contains(error, release));
  assert.equal(released, 1); assert.equal(f.sends(), 0);
});

test("orchestration workspace lifecycle background start retains late writer and cleanup failures without retry", async t => {
  const f = fixture(t, "parallel"), entered = deferred<void>(), gate = deferred<void>(), cleanupGate = deferred<void>();
  const business = new Error("LATE_NODE_FAILURE"), logging = new Error("ROLE_LOG_FAILED"), cleanup = new Error("DISPOSE_FAILED");
  let current: unknown, sends = 0, disposals = 0;
  f.setSend(async input => {
    if (++sends === 1) { entered.resolve(); await gate.promise; throw business; }
    await cleanupGate.promise;
    await assert.rejects(input.executeHostTool({ toolId: "runtime.submitNodeResult", toolInput: {}, accessMode: "current" }), error => contains(error, logging));
    throw cleanup;
  });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => {
    if (entry.message === "role execution failed" && current === undefined) { current = logging; throw logging; }
    return write(workspaceId, entry);
  }) as typeof write);
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { disposals++; };
  await f.engine.startInBackground(f.instance.id, "request-lifecycle-中文😀"); await entered.promise;
  gate.resolve(); let settled = false;
  const waiting = f.engine.waitForInFlightWork().finally(() => { settled = true; });
  const rejected = assert.rejects(waiting, error => contains(error, business) && contains(error, logging) && contains(error, cleanup));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
  cleanupGate.resolve(); await rejected; assert.equal(disposals, 1); assert.equal(sends, 2);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "waiting-feedback");
  assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "role")!.attemptNo, 1);
});

test("orchestration workspace lifecycle settled background diagnosis keeps ordered original causes for later wait", async t => {
  const f = fixture(t), business = new Error("ROLE_BUSINESS"), roleLog = new Error("ROLE_WRITER"), coordinatorLog = null, backgroundLog = 0;
  f.setSend(async () => { throw business; });
  t.mock.method(f.db, "writeWorkspaceLog", (_workspaceId: any, entry: any) => {
    if (entry.message === "role execution failed") throw roleLog;
    if (entry.message === "instance coordinator failed") throw coordinatorLog;
    if (entry.message === "background start did not settle") throw backgroundLog;
  });
  await f.engine.startInBackground(f.instance.id, "lifecycle-settled-request");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.engine.hasInFlightWork(), false);
  await assert.rejects(f.engine.waitForInFlightWork(), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], backgroundLog);
    const coordinator = error.errors[0]; assert.equal(coordinator.errors[1], coordinatorLog);
    const role = coordinator.errors[0]; assert.deepEqual(role.errors, [business, roleLog]); assert.equal(role.cause, business); return true;
  });
});

test("orchestration workspace lifecycle unknown reflection failure preserves original object and independent diagnostic", async t => {
  const f = fixture(t), diagnostic = new Error("DESCRIPTOR_FAILED"); f.stage();
  let getters = 0;
  const business = new Proxy({}, { get() { getters++; throw new Error("UNEXPECTED_GET"); }, getOwnPropertyDescriptor() { throw diagnostic; } });
  f.sessions.interrupt = async () => { throw business; };
  await assert.rejects(f.engine.cancelAndWait(f.instance.id), error => contains(error, business) && contains(error, diagnostic));
  assert.equal(getters, 0);
});

test("orchestration workspace lifecycle recovered exact turn logs trusted W and writer failure prevents later recovery event", async t => {
  const f = fixture(t), logging = new Error("RECOVERY_LOG"), staged = f.stage();
  f.db.turns.setEnded(staged.turnId, { status: "error", endedAt: 2, endEventSeq: null });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message === "recovered role execution failed") throw logging; return write(workspaceId, entry); }) as typeof write);
  await assert.rejects(f.engine.recover(f.instance.id), error => contains(error, logging));
  assert.equal(f.sends(), 0); assert.equal(f.db.orchInstances.get(f.instance.id)!.nodeStates.role.retryCount, 0);
  assert.equal(f.db.orchEvents.listByInstance(f.instance.id).some(event => event.type === "orchestration.nodeRecovered"), false);
});

test("orchestration workspace lifecycle knowledge callback keeps business writer pair in process then continues after explicit failure", async t => {
  const f = fixture(t), store = new KnowledgeAssetStore(f.b), business = new Error("KNOWLEDGE_READ token=LIFECYCLE_SECRET"), logging = new Error("KNOWLEDGE_LOG");
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "node", parentId: null, title: "规则", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  t.mock.method(KnowledgeAssetStore.prototype, "detail", () => { throw business; });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message === "workflow knowledge tool failed") throw logging; return write(workspaceId, entry); }) as typeof write);
  let observed: unknown;
  f.setSend(async input => {
    try { await input.executeHostTool({ toolId: "knowledge.node.read", toolInput: { nodeId: "node" }, accessMode: "current" }); }
    catch (error) { observed = error; }
    assert.ok(observed instanceof AggregateError); assert.deepEqual(observed.errors, [business, logging]); assert.equal(observed.cause, business);
    throw new Error("EXPLICIT_PROVIDER_STOP_AFTER_TOOL_FAILURE");
  });
  await f.engine.start(f.instance.id); assert.equal(f.sends(), 1);
  assert.equal(logs(f.b).length, 0);
});

test("orchestration workspace lifecycle aborted feedback disposal retains writer failure after settled wait", async t => {
  const f = fixture(t), business = new Error("DISPOSAL_BUSINESS"), logging = new Error("DISPOSAL_WRITER"); f.stage("waiting-approval");
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { throw business; };
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  await f.engine.submitFeedback(f.instance.id, "role", "abort");
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.engine.hasInFlightWork(), false);
  await assert.rejects(f.engine.waitForInFlightWork(), error => contains(error, business) && contains(error, logging));
  assert.equal(f.db.orchInstances.get(f.instance.id)!.nodeStates.role.status, "failed");
});

test("orchestration workspace lifecycle stale rejected submission keeps warning failure and never accepts late artifact", async t => {
  const f = fixture(t), entered = deferred<void>(), gate = deferred<void>(), logging = new Error("STALE_LOG");
  let callback: any;
  f.setSend(async input => { callback = input.executeHostTool; entered.resolve(); await gate.promise; return { responseText: "迟到结果" }; });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message === "rejected stale node attempt continuation") throw logging; return write(workspaceId, entry); }) as typeof write);
  await f.engine.startInBackground(f.instance.id, "stale-request"); await entered.promise;
  const cancelling = f.engine.cancelAndWait(f.instance.id);
  await assert.rejects(callback({ toolId: "runtime.submitNodeResult", toolInput: {}, accessMode: "current" }), error => contains(error, logging));
  gate.resolve();
  await assert.rejects(cancelling, error => contains(error, logging));
  await assert.rejects(f.engine.waitForInFlightWork(), error => contains(error, logging));
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "cancelled");
  assert.equal(f.db.orchArtifacts.listByInstance(f.instance.id).length, 0);
});

for (const source of ["feedback", "resume"] as const) test(`orchestration workspace lifecycle public ${source} continuation exposes task and event failure after settled`, async t => {
  const f = fixture(t), business = new Error("RESUME_EVENT_FAILED"); f.stage("waiting-approval");
  f.setEmit(event => { if (event.type === "orchestration.resumed") throw business; });
  if (source === "feedback") {
    // 原公开反馈先受理；定时交接中的仓储失败由同一个 continuation Promise 持有。
    await f.engine.submitFeedback(f.instance.id, "role", "abort");
    const get = f.db.orchInstances.get.bind(f.db.orchInstances); let failed = false;
    t.mock.method(f.db.orchInstances, "get", ((...args: Parameters<typeof get>) => { if (!failed) { failed = true; throw business; } return get(...args); }) as typeof get);
    await new Promise<void>(resolve => setTimeout(resolve, 30)); assert.equal(f.engine.hasInFlightWork(), false);
    await assert.rejects(f.engine.waitForInFlightWork(), error => contains(error, business));
  } else {
    // 同步恢复受理事件失败仍直接拒绝；不得伪造后台成功。
    await assert.rejects(f.engine.resumeInBackground(f.instance.id), error => error === business);
  }
  assert.equal(f.sends(), 0);
});

for (const value of [undefined, null, false, 0, -0, NaN, ""] as const) test(`orchestration workspace lifecycle writer falsy ${String(value)} ${Object.is(value, -0)} keeps business first`, async t => {
  const f = fixture(t), business = new Error("BUSINESS_FIRST"); f.stage();
  f.sessions.interrupt = async () => { throw business; };
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw value; });
  await assert.rejects(f.engine.cancelAndWait(f.instance.id), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], business); assert.ok(Object.is(error.errors[1], value)); assert.equal(error.cause, business); return true;
  });
});

test("orchestration workspace lifecycle ordinary matching code never masquerades as internal diagnostic", async t => {
  const f = fixture(t), business = Object.assign(new Error("ordinary provider"), { code: "ORCHESTRATION_WORKSPACE_LOG_FAILED" });
  f.setSend(async () => { throw business; });
  await f.engine.start(f.instance.id);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "waiting-feedback"); assert.equal(f.sends(), 1);
  assert.equal(logs(f.a).filter(row => (row.message ?? row.msg) === "role execution failed").length, 1);
});

test("orchestration workspace lifecycle false fence writes once to trusted W without changing business result", async t => {
  const f = fixture(t); f.stage("running", true); await f.engine.cancelAndWait(f.instance.id);
  const rows = logs(f.a).filter(row => (row.message ?? row.msg) === "failed to release Codex recovery fence after terminal action");
  assert.equal(rows.length, 1); assert.equal(rows[0].workspaceId, f.instance.workspaceId); assert.equal(rows[0].action, "cancel-instance");
  assert.equal(logs(f.b).length, 0); assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "cancelled");
});

test("orchestration workspace lifecycle release only failure is logged and retained by original continuation", async t => {
  const f = fixture(t, "parallel"), business = new Error("ACTIVITY_RELEASE_ONLY"); f.stage("waiting-start");
  const latest = f.db.orchInstances.get(f.instance.id)!; latest.nodeStates.other.status = "waiting-start";
  f.db.orchInstances.updateNodeStates(f.instance.id, latest.nodeStates);
  f.setRelease(() => { throw business; });
  await f.engine.skipWaitingNode(f.instance.id, "role");
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  await assert.rejects(f.engine.waitForInFlightWork(), error => contains(error, business));
  const rows = logs(f.a).filter(row => (row.message ?? row.msg) === "database continuation owner failed");
  assert.equal(rows.length, 1); assert.match(JSON.stringify(rows[0].rootCause), /ACTIVITY_RELEASE_ONLY/); assert.equal(logs(f.b).length, 0);
});

test("orchestration workspace lifecycle background disposal failure logs safe trusted W after completed fact", async t => {
  const f = fixture(t, "empty"), business = new Error("FINAL_CLEANUP token=LIFECYCLE_SECRET");
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { throw business; };
  await f.engine.startInBackground(f.instance.id, "request-background-cleanup");
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.engine.hasInFlightWork(), false);
  await assert.rejects(f.engine.waitForInFlightWork(), error => contains(error, business));
  const rows = logs(f.a).filter(row => (row.message ?? row.msg) === "background start did not settle"); assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, "request-background-cleanup"); assert.equal(logs(f.b).length, 0); assert.doesNotMatch(JSON.stringify(rows), /LIFECYCLE_SECRET/);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed");
});

test("orchestration workspace lifecycle coordinator uses safe diagnostics and permits independent workspace after failure", async t => {
  const f = fixture(t), business = new Error("COORDINATOR_BEGIN token=LIFECYCLE_SECRET");
  t.mock.method(f.db.orchNodeAttempts, "begin", () => { throw business; });
  await f.engine.start(f.instance.id);
  const rows = logs(f.a).filter(row => (row.message ?? row.msg) === "instance coordinator failed"); assert.equal(rows.length, 1);
  assert.equal(rows[0].instanceId, f.instance.id); assert.equal(logs(f.b).length, 0); assert.doesNotMatch(JSON.stringify(rows), /LIFECYCLE_SECRET/);
  const other = fixture(t, "empty"); await other.engine.start(other.instance.id); assert.equal(other.db.orchInstances.get(other.instance.id)!.status, "completed");
});

test("orchestration workspace lifecycle stopped coordinator retains safe business and writer error through drain", async t => {
  const f = fixture(t), business = new Error("STOPPED_BEGIN"), logging = new Error("STOPPED_WRITER");
  t.mock.method(f.db.orchNodeAttempts, "begin", () => { f.engine.stop(); throw business; });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message === "instance coordinator stopped after execution error") throw logging; return write(workspaceId, entry); }) as typeof write);
  await assert.rejects(f.engine.start(f.instance.id), error => contains(error, business) && contains(error, logging));
  await f.engine.stopAndDrain(); assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "running");
});

test("orchestration workspace lifecycle first knowledge error remains explicit and next valid submission succeeds", async t => {
  const f = fixture(t), store = new KnowledgeAssetStore(f.b);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "node", parentId: null, title: "规则", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  let reads = 0;
  const business = Object.defineProperties({}, { code: { get() { reads++; throw new Error("KNOWLEDGE_CODE_GET"); } }, message: { get() { reads++; throw new Error("KNOWLEDGE_MESSAGE_GET"); } }, toString: { value() { reads++; throw new Error("KNOWLEDGE_COERCE"); } } });
  t.mock.method(KnowledgeAssetStore.prototype, "detail", () => { throw business; });
  f.setSend(async input => {
    const failed = await input.executeHostTool({ toolId: "knowledge.node.read", toolInput: { nodeId: "node" }, accessMode: "current" });
    assert.equal(failed.ok, false); assert.equal(failed.code, "KNOWLEDGE_ASSET_IO_FAILED");
    const delivered = await input.executeHostTool({ toolId: "runtime.submitNodeResult", accessMode: "current", toolInput: {
      answer: { mode: "text", text: "正常交付" }, control: { nextAction: "continue", reason: "已完成" },
      review: { verdict: "pass", summary: "满足要求", blockingIssues: [] }, acceptanceChecks: null, humanInput: null, rework: null,
    } });
    assert.equal(delivered.ok, true); return { responseText: "正常交付" };
  });
  await f.engine.start(f.instance.id);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "completed"); assert.equal(reads, 0); assert.equal(f.sends(), 1);
  const rows = logs(f.a).filter(row => (row.message ?? row.msg) === "workflow knowledge tool failed");
  assert.equal(rows.length, 1); assert.equal(rows[0].code, "KNOWLEDGE_ASSET_IO_FAILED"); assert.equal(logs(f.b).length, 0);
});

for (const second of ["success", "failure"] as const) test(`orchestration workspace lifecycle F1 cancellation releases every captured binding after first writer failure ${second}`, async t => {
  const f = fixture(t, "parallel"), first = f.stage("running", true), logging = false, independent = undefined, cleanup = new Error("F1_DISPOSAL");
  const threadId = "f1-other-thread", turnId = "f1-other-turn";
  f.db.threads.create({ id: threadId, workspaceId: f.instance.workspaceId, engine: "codex", title: "另一门禁", threadType: "orchestration" });
  f.db.turns.insertStarted({ workspaceId: f.instance.workspaceId, threadId, engine: "codex", turnId, startedAt: 2, startEventSeq: null });
  const attempt = f.db.orchNodeAttempts.begin({ instanceId: f.instance.id, nodeId: "other" });
  f.db.orchNodeAttempts.bindExecution(attempt.id, threadId, turnId);
  const latest = f.db.orchInstances.get(f.instance.id)!;
  Object.assign(latest.nodeStates.other, { status: "running", threadId, attemptId: attempt.id, attemptNo: 1, preserveBinding: true, providerThreadId: "f1-other-provider" });
  f.db.orchInstances.updateNodeStates(f.instance.id, latest.nodeStates);
  const releases: string[] = [], gate = deferred<void>(), entered = deferred<void>(); let disposals = 0;
  t.mock.method(f.sessions, "releaseCodexRecoveryPending", (id: string) => {
    releases.push(id); if (id === first.threadId) return false; if (second === "failure") throw independent; return true;
  });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message.includes("recovery fence")) throw logging; return write(workspaceId, entry); }) as typeof write);
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { disposals++; entered.resolve(); await gate.promise; if (second === "failure") throw cleanup; };
  let settled = false;
  const waiting = f.engine.cancelAndWait(f.instance.id).finally(() => { settled = true; });
  /** 同一取消 owner 应向两个公开消费者保留每项独立原因。 */
  const check = (error: unknown): boolean => {
    assert.equal(contains(error, logging), true);
    assert.ok(error instanceof AggregateError);
    if (second === "failure") {
      assert.equal(error.errors[0], cleanup);
      const fences = error.errors[1]; assert.ok(fences instanceof AggregateError);
      const firstFence = fences.errors[0]; assert.ok(firstFence instanceof AggregateError);
      assert.deepEqual(firstFence.errors, [logging]); assert.equal(firstFence.cause, logging);
      assert.equal(fences.errors[1], independent); assert.equal(fences.cause, firstFence);
    } else { assert.deepEqual(error.errors, [logging]); assert.equal(error.cause, logging); }
    return true;
  };
  const cancelled = assert.rejects(waiting, check), drained = assert.rejects(f.engine.waitForInFlightWork(), check);
  await entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
  const attempted = releases.slice(); assert.equal(settled, false); gate.resolve();
  await Promise.all([cancelled, drained]);
  assert.deepEqual(attempted, [first.threadId, threadId]); assert.equal(disposals, 1);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "cancelled"); assert.equal(f.sends(), 0);
});

for (const action of ["abort", "cancel"] as const) for (const failCleanup of [false, true]) test(`orchestration workspace lifecycle F2 feedback ${action} fence failure still owns disposal cleanup=${failCleanup}`, async t => {
  const f = fixture(t), logging = new Error("F2_FENCE_WRITER"), cleanup = null, gate = deferred<void>();
  f.stage("waiting-approval", true); let disposals = 0, continuations = 0;
  f.setRelease(() => { continuations++; });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message.includes("recovery fence")) throw logging; return write(workspaceId, entry); }) as typeof write);
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { disposals++; await gate.promise; if (failCleanup) throw cleanup; };
  let fenceFailure: unknown;
  await assert.rejects(f.engine.submitFeedback(f.instance.id, "role", action), error => { fenceFailure = error; return contains(error, logging); });
  // 给原背景释放入口一轮启动机会，避免失败版本因缺 owner 永久挂起测试。
  await new Promise<void>(resolve => setImmediate(resolve));
  const started = disposals;
  let settled = false;
  const waiting = f.engine.waitForInFlightWork().finally(() => { settled = true; });
  const observed = waiting.then(() => ({ failed: false, error: undefined }), error => ({ failed: true, error }));
  await new Promise<void>(resolve => setImmediate(resolve)); const early = settled; gate.resolve();
  const result = await observed;
  assert.equal(started, 1); assert.equal(early, false); assert.equal(result.failed, true); assert.equal(contains(result.error, logging), true);
  if (failCleanup) {
    assert.ok(result.error instanceof AggregateError); assert.deepEqual(result.error.errors, [fenceFailure, cleanup]); assert.equal(result.error.cause, fenceFailure);
  } else assert.equal(result.error, fenceFailure);
  assert.equal(disposals, 1); assert.equal(continuations, 0); assert.equal(f.sends(), 0);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.status, "failed");
  assert.equal(f.db.orchInstances.get(f.instance.id)!.nodeStates.role.status, "failed");
});

test("orchestration workspace lifecycle F3 settled diagnosis blocks successor claim after wake while started cleanup drains", async t => {
  const f = fixture(t, "successor"), firstEntered = deferred<void>(), otherEntered = deferred<void>(), firstGate = deferred<void>(), otherGate = deferred<void>(), disposalGate = deferred<void>(), disposalEntered = deferred<void>();
  const business = new Error("F3_FIRST_BUSINESS"), logging = new Error("F3_FIRST_WRITER"), cleanup = new Error("F3_DISPOSAL");
  const sends: string[] = [], queued: string[] = []; let disposals = 0;
  f.setEmit(event => { if (event.type === "orchestration.nodeStateChanged") { const payload = JSON.parse(event.payloadJson); if (payload.status === "queued") queued.push(payload.nodeId); } });
  f.setSend(async (input, thread) => {
    const nodeId = ["role", "other", "successor"].find(id => f.db.orchNodeAttempts.getLatestByNode(f.instance.id, id)?.threadId === thread.threadId)!;
    sends.push(nodeId);
    if (nodeId === "role") { firstEntered.resolve(); await firstGate.promise; throw business; }
    if (nodeId === "other") {
      const submitted = await input.executeHostTool({ toolId: "runtime.submitNodeResult", accessMode: "current", toolInput: {
        answer: { mode: "text", text: "并行完成" }, control: { nextAction: "continue", reason: "已完成" }, review: { verdict: "pass", summary: "满足要求", blockingIssues: [] }, acceptanceChecks: null, humanInput: null, rework: null,
      } });
      assert.equal(submitted.ok, true); otherEntered.resolve(); await otherGate.promise; return { responseText: "并行完成" };
    }
    throw new Error("F3_UNEXPECTED_SUCCESSOR_PROVIDER");
  });
  const write = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => { if (entry.message === "role execution failed" && entry.data && (entry.data as any).nodeId === "role") throw logging; return write(workspaceId, entry); }) as typeof write);
  (f.engine as any).managedServiceRuntime.disposeInstanceServices = async () => { disposals++; disposalEntered.resolve(); await disposalGate.promise; throw cleanup; };
  await f.engine.startInBackground(f.instance.id, "F3-claim-request"); await Promise.all([firstEntered.promise, otherEntered.promise]);
  let settled = false;
  const waiting = f.engine.waitForInFlightWork().finally(() => { settled = true; });
  const rejected = assert.rejects(waiting, error => contains(error, business) && contains(error, logging) && contains(error, cleanup));
  // 同轮结算两个已发出的 session，令原 wake 与失败 Promise 真实竞争。
  firstGate.resolve(); otherGate.resolve();
  await disposalEntered.promise; await new Promise<void>(resolve => setImmediate(resolve));
  const early = settled; disposalGate.resolve(); await rejected;
  assert.equal(early, false); assert.equal(disposals, 1);
  assert.deepEqual(sends, ["role", "other"]); assert.deepEqual(queued, ["start", "role", "other"]);
  assert.equal(f.db.orchInstances.get(f.instance.id)!.nodeStates.successor.status, "pending");
  assert.equal(f.db.orchNodeAttempts.getLatestByNode(f.instance.id, "successor"), null);
  assert.equal(f.db.orchArtifacts.listByInstance(f.instance.id).some(artifact => artifact.nodeId === "successor"), false);
});
