import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import type { ThreadId, WorkspaceId } from "@codeflowai/shared";
import { handleApiRequest, WorkspaceApiRequestFailure, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { onThreadQueueResume } from "../src/app/handleThreadQueueRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";
import { OrchInstanceScopeError } from "../src/db/repos/orchInstanceRepo.js";
import { logger } from "../src/logger.js";
import { isDesktopLocalAssetExecution, isDesktopLocalThreadAssetExecution } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { OrchAssetLaunchSnapshotError } from "../src/orchestration/orchAssetLaunchSnapshotService.js";
import { shouldRecoverPersistedOrchestrationInstance } from "../src/orchestration/orchestrationEngine.js";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.js";
import { createDesktopLifecycle } from "../src/runtime/desktopLifecycle.js";
import { createDesktopStartupRecovery } from "../src/runtime/desktopStartupRecovery.js";

const clientId = "node-recovery-device";
const affectedId = `${clientId}:affected` as WorkspaceId;
const otherId = `${clientId}:other` as WorkspaceId;
const privateBody = "{PRIVATE_NODE_STATE_BODY";

/** 故障证据保留原领域上下文和聚合因果，不序列化任意错误正文。 */
function describeFailure(error: unknown): unknown {
  if (!(error instanceof Error)) return { type: error === null ? "null" : typeof error };
  const detail = error as Error & { code?: string; details?: unknown };
  return { name: error.name, message: error.message, code: detail.code, details: detail.details,
    ...(error.cause === undefined ? {} : { cause: describeFailure(error.cause) }),
    ...(error instanceof AggregateError ? { errors: error.errors.map(describeFailure) } : {}) };
}

/** 执行 index 原恢复与事务隔离 owner；只替代外部引擎，不复制恢复算法。 */
function instanceRecovery(db: ReturnType<typeof openClientDb>, workspaces: Map<WorkspaceId, string>, failLog?: Error, failEngine?: { instanceId: string; error: Error }) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["isolatePersistedInstanceFailure", "recoverRunningOrchestrations"];
  const declarations = new Map<string, ts.VariableDeclaration>();
  /** 仅提取现有 owner，避免导入 index 时启动真实进程及 provider。 */
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree))) declarations.set(node.name.getText(tree), node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const name of names) assert.ok(declarations.has(name), `missing original recovery owner: ${name}`);
  const code = ts.transpileModule(names.map(name => `const ${declarations.get(name)!.getText(tree)};`).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const recovered: Array<{ workspaceId: WorkspaceId; instanceId: string }> = [], logs: any[][] = [];
  const recover = new Function("env", `with(env) { ${code}; return recoverRunningOrchestrations; }`)({ db, workspaces,
    orchRecoveryStarted: new Set(), desktopLifecycle: {}, config: { clientId }, deviceIdentity: { deviceId: "node-recovery-device" }, desktopRequestId: "node-recovery-index",
    OrchInstanceScopeError, OrchAssetLaunchSnapshotError, isDesktopLocalAssetExecution, shouldRecoverPersistedOrchestrationInstance,
    logger: { info() {} },
    /** 收集真实 owner 日志；受控日志故障必须原样上抛。 */
    logClientStep(...args: any[]) { logs.push(args); if (failLog && args[0] === "error") throw failLog; },
    toOrchAssetActivationErrorLogValue: () => ({ code: "ASSET_CACHE_AUTHORIZATION_REQUIRED" }),
    orchEngine: { forWorkspace(workspaceId: WorkspaceId) { return {
      /** 引擎为外部执行边界，仅记录实际被原恢复 owner 放行的实体。 */
      async recover(instanceId: string) {
        if (failEngine?.instanceId === instanceId) throw failEngine.error;
        recovered.push({ workspaceId, instanceId });
      },
    }; } },
  }) as (scope: "desktop" | "server") => Promise<void>;
  return { recover, recovered, logs };
}

/** 真实工作区 SQLite 与仓储产生关系；只隔离 provider 派发及 IPC 传输。 */
function fixture(t: test.TestContext, subtype: "node" | "node-discussion", mode: "automatic" | "held") {
  const evidenceRoot = process.env.CF_NODE_RECOVERY_EVIDENCE_ROOT;
  const parent = evidenceRoot ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, `${mode}-${subtype}-`));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaces = new Map<WorkspaceId, string>();
  const workspaceLogs: Array<{ workspaceId: WorkspaceId; entry: any }> = [];
  for (const workspaceId of [affectedId, otherId]) {
    const workspacePath = path.join(root, workspaceId === affectedId ? "affected" : "other");
    fs.mkdirSync(workspacePath);
    db.workspaces.upsert({ id: workspaceId, title: workspaceId, path: workspacePath });
    workspaces.set(workspaceId, workspacePath);
    const scoped = db.forWorkspace(workspaceId);
    const write = scoped.writeWorkspaceLog;
    t.mock.method(scoped, "writeWorkspaceLog", (id, entry) => {
      write(id, entry);
      workspaceLogs.push({ workspaceId: id, entry });
    });
  }
  const affected = db.forWorkspace(affectedId), other = db.forWorkspace(otherId);
  const sent: any[] = [], visited: Array<{ workspaceId: WorkspaceId; threadId: ThreadId; local: boolean }> = [];
  const context = { db, clientId, workspaces, localWorkspaceOnly: true,
    // 保留真实恢复调度，仅阻止测试进入外部模型执行。
    isTaskAdmissionPaused: () => true,
    send(message: unknown) { sent.push(message); },
  } as unknown as ApiHandlerContext;
  const dispatcher = new ThreadQueueDispatcher(context);
  context.queueDispatcher = dispatcher;

  /** 通过真实队列仓储追加输入，失败历史与后续新输入分别保留。 */
  function append(workspaceId: WorkspaceId, threadId: ThreadId) {
    return db.forWorkspace(workspaceId).threadMessageQueue.appendItem({ workspaceId, threadId,
      text: "PRIVATE_PENDING_INPUT", images: [], files: [], originWebSessionId: null,
      sendOptions: { workMode: "general", planMode: false, model: null, effort: null, accessMode: null,
        contextWindow: null, autoCompactPct: null, serviceTier: null } }).item;
  }
  /** 原编排仓储冻结本机归属，节点及讨论绑定使用现有 nodeStates 字段。 */
  function execution(workspaceId: WorkspaceId, id: string, threadSubtype: "node" | "node-discussion") {
    const scoped = db.forWorkspace(workspaceId), threadId = id as ThreadId;
    const workflow = scoped.orchWorkflows.upsert({ id: `${id}-workflow` as any, workspaceId, name: id,
      description: id, version: 1, nodes: [{ id: "start", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [] });
    const intake = scoped.orchIntakes.upsert({ id: `${id}-intake` as any, workspaceId, title: id, goal: id,
      taskType: "feature", triggerMode: "manual", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
    const instance = scoped.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
    scoped.threads.create({ id: threadId, workspaceId, engine: "codex", title: id,
      threadType: threadSubtype === "node" ? "orchestration" : "chat", threadSubtype });
    assert.equal(scoped.threads.get(threadId)?.threadSubtype, threadSubtype);
    scoped.orchInstances.updateNodeStates(instance.id, { start: { ...instance.nodeStates.start!,
      ...(threadSubtype === "node" ? { threadId } : { discussionThreadId: threadId }) } });
    scoped.orchInstances.updateStatus(instance.id, "running");
    const queue = append(workspaceId, threadId);
    return { instanceId: instance.id, intakeId: intake.id, threadId, queueId: queue.id };
  }
  const broken = execution(affectedId, "broken-node", subtype);
  const adjacent = execution(affectedId, "adjacent-node", "node");
  const healthy = execution(otherId, "healthy-node", "node");
  const chatId = "plain-chat" as ThreadId;
  affected.threads.create({ id: chatId, workspaceId: affectedId, engine: "codex", title: "普通聊天" });
  const chatQueueId = append(affectedId, chatId).id;
  const raId = "requirement-analysis" as ThreadId;
  affected.threads.create({ id: raId, workspaceId: affectedId, engine: "codex", title: "需求分析", threadSubtype: "requirement-analysis" });
  affected.orchRequirementAnalysisSessions.create({ id: raId as any, workspaceId: affectedId, title: "需求分析", status: "active", phase: "discover", engine: "codex",
    runtimeThreadId: raId, workspaceScope: { scopeType: "local_workspace", scopeId: affectedId } });
  const raQueueId = append(affectedId, raId).id;
  const original = affected.db.prepare("SELECT node_states_json FROM orch_instances WHERE id = ?").get(broken.instanceId) as { node_states_json: string };
  const originalSummary = affected.db.prepare("SELECT summary_json FROM orch_instance_summaries WHERE instance_id = ?").get(broken.instanceId) as { summary_json: string };
  affected.db.prepare("UPDATE orch_instances SET node_states_json = ? WHERE id = ?").run(privateBody, broken.instanceId);

  /** 真实生产 authority 选当前工作区，不按裸线程 ID 跨库反查。 */
  function shouldRecover(threadId: ThreadId, workspaceId?: WorkspaceId) {
    assert.ok(workspaceId);
    const local = isDesktopLocalThreadAssetExecution(clientId, workspaces, db.forWorkspace(workspaceId), threadId);
    visited.push({ workspaceId, threadId, local });
    return local;
  }
  /** 业务与 IPC 排空后仅关闭自有连接；外置证据保留原库。 */
  function close() {
    db.close();
    if (!evidenceRoot) fs.rmSync(root, { recursive: true });
  }
  return { root, db, affected, other, context, dispatcher, broken, adjacent, healthy, chatId, chatQueueId, raId, raQueueId,
    append, original: original.node_states_json, originalSummary: JSON.parse(originalSummary.summary_json), workspaceLogs, visited, shouldRecover, sent, close };
}

for (const mode of ["automatic", "held"] as const) for (const subtype of ["node", "node-discussion"] as const)
test(`损坏 nodeStates ${mode}/${subtype} 仅失败本区节点队列并保持桌面可用`, async t => {
  const f = fixture(t, subtype, mode);
  const channel = new EventEmitter() as EventEmitter & { connected: boolean; send(message: unknown, callback: (error: Error | null) => void): void };
  const parentRequestId = `recovery-${mode}-${subtype}`, continuationId = "node-recovery-continue";
  const ipc: any[] = [], lifecycleLogs: unknown[][] = [], closed: Array<{ reason: string; error?: Error }> = [];
  const recovery = instanceRecovery(f.db, f.context.workspaces);
  let orchestrationRecovery = 0;
  channel.connected = true;
  channel.send = (message, callback) => { ipc.push(message); callback(null); };
  t.mock.method(logger, "error", (...args: unknown[]) => { lifecycleLogs.push(args); });
  const lifecycle = createDesktopLifecycle(channel, parentRequestId, {
    startup: mode === "held" ? { mode, continuationId } : { mode },
    abortStartup() { assert.fail("测试不应触发紧急退出"); },
  });
  t.after(async () => {
    try { await lifecycle.drainRequests(); await f.dispatcher.waitForIdle(); }
    finally { f.close(); }
  });
  await lifecycle.ready((reason, error) => { closed.push({ reason, error }); },
    () => ({ protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: CLIENT_DB_SCHEMA_VERSION, database: "ready" }),
    async (request, requestId) => {
      await handleApiRequest(f.context, { t: "api.req", id: requestId, ...request } as any);
      const response = f.sent.find(message => message.t === "api.res" && message.id === requestId);
      assert.ok(response);
      return { status: response.status, body: response.body };
    }, undefined, createDesktopStartupRecovery({
      scheduler: { start() {}, syncAndTick() { return Promise.resolve(); }, isIsolatedLocalConfigScanFailure() { return false; } },
      recoverQueue() { f.dispatcher.recoverOnStartup(f.shouldRecover); },
      recoverOrchestrations() { orchestrationRecovery++; return recovery.recover("desktop"); },
    }));
  if (mode === "held") {
    assert.deepEqual(closed, []);
    assert.equal(f.visited.length, 0);
    channel.emit("message", { t: "desktop.api.req", requestId: parentRequestId, id: "continue", request: { method: "runtime.startup.continue", body: { continuationId } } });
  }
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const state = {
    closed: closed.map(item => ({ reason: item.reason, error: describeFailure(item.error) })),
    broken: f.affected.threadMessageQueue.getById(f.broken.queueId),
    adjacent: f.affected.threadMessageQueue.getById(f.adjacent.queueId),
    chat: f.affected.threadMessageQueue.getById(f.chatQueueId),
    ra: f.affected.threadMessageQueue.getById(f.raQueueId),
    other: f.other.threadMessageQueue.getById(f.healthy.queueId),
    brokenPause: f.affected.threadQueueStates.getState(f.broken.threadId),
    adjacentPause: f.affected.threadQueueStates.getState(f.adjacent.threadId),
    visited: f.visited, workspaceLogs: f.workspaceLogs, lifecycleLogs,
    orchestrationRecovery, admissionPaused: lifecycle.isTaskAdmissionPaused(),
    raw: f.affected.db.prepare("SELECT node_states_json FROM orch_instances WHERE id = ?").get(f.broken.instanceId), ipc,
    instance: f.affected.db.prepare("SELECT status, updated_at FROM orch_instances WHERE id = ?").get(f.broken.instanceId),
    summary: f.affected.db.prepare("SELECT status, source_updated_at, summary_json FROM orch_instance_summaries WHERE instance_id = ?").get(f.broken.instanceId),
    listState: f.affected.db.prepare("SELECT list_status, latest_instance_id, latest_instance_status FROM orch_intake_list_states WHERE intake_id = ?").get(f.broken.intakeId),
    recoveryLogs: recovery.logs, recovered: recovery.recovered,
  };
  fs.writeFileSync(path.join(f.root, "evidence.json"), JSON.stringify(state, null, 2), "utf8");
  t.diagnostic(`evidence=${path.join(f.root, "evidence.json")}; shutdown=${closed.map(item => item.reason).join(",") || "none"}`);
  assert.equal(closed.length, 0, "单个工作区节点绑定损坏不得关闭整个桌面运行时");
  assert.equal(lifecycle.isTaskAdmissionPaused(), false);
  assert.equal(orchestrationRecovery, 1);
  assert.deepEqual(state.raw, { node_states_json: privateBody });
  assert.equal(state.instance?.status, "paused");
  assert.equal(state.summary?.status, "paused");
  assert.equal(state.summary.source_updated_at, state.instance.updated_at);
  const pausedSummary = JSON.parse(String(state.summary.summary_json));
  assert.equal(pausedSummary.status, "paused");
  assert.equal(pausedSummary.runSummary.statusLabel, "已暂停");
  assert.equal(pausedSummary.runSummary.waitingActionKind, null);
  for (const field of ["progressDone", "progressTotal", "progressRatio", "progressText"]) {
    assert.equal(pausedSummary.runSummary[field], f.originalSummary.runSummary[field]);
  }
  assert.deepEqual(state.listState, { list_status: "paused", latest_instance_id: f.broken.instanceId, latest_instance_status: "paused" });
  assert.equal(recovery.recovered.some(entry => entry.instanceId === f.broken.instanceId), false);
  assert.ok(recovery.recovered.some(entry => entry.workspaceId === otherId && entry.instanceId === f.healthy.instanceId));
  const events = f.affected.orchEvents.listByInstance(f.broken.instanceId);
  assert.equal(events.filter(event => event.type === "orchestration.error").length, 1);
  assert.equal(JSON.parse(events.find(event => event.type === "orchestration.error")!.payloadJson).code, "ORCH_INSTANCE_SCOPE_INVALID");
  assert.equal(recovery.logs.filter(entry => entry[0] === "error").length, 1);
  assert.doesNotMatch(JSON.stringify(recovery.logs), /PRIVATE_NODE_STATE_BODY|PRIVATE_PENDING_INPUT/);
  const restart = instanceRecovery(f.db, f.context.workspaces);
  await restart.recover("desktop");
  assert.equal(f.affected.orchEvents.listByInstance(f.broken.instanceId).filter(event => event.type === "orchestration.error").length, 1);
  assert.equal(restart.logs.filter(entry => entry[0] === "error").length, 0);
  for (const [entity, item, pause] of [[f.broken, state.broken, state.brokenPause], [f.adjacent, state.adjacent, state.adjacentPause]] as const) {
    assert.equal(item?.status, "failed");
    assert.equal(item.failureCode, "ORCH_INSTANCE_SCOPE_INVALID");
    assert.equal(item.sentTurnId, null);
    assert.equal(pause.paused, true);
    assert.equal(pause.pausedReason, "send_failed");
    const logs = f.workspaceLogs.filter(log => log.entry.level === "error" && log.entry.data.threadId === entity.threadId);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.workspaceId, affectedId);
    assert.equal(logs[0]!.entry.data.instanceId, f.broken.instanceId);
    assert.equal(logs[0]!.entry.data.errorCode, "ORCH_INSTANCE_SCOPE_INVALID");
    assert.equal(logs[0]!.entry.data.field, "node_states_json");
    assert.equal(logs[0]!.entry.data.reason, "invalid_json");
    assert.equal(logs[0]!.entry.data.requestId, `queue-recovery:${entity.threadId}`);
    assert.equal(logs[0]!.entry.data.isolationScope, "workspace_nodes");
    assert.deepEqual(logs[0]!.entry.data.queueItemIds, [entity.queueId]);
  }
  assert.doesNotMatch(JSON.stringify([f.workspaceLogs, lifecycleLogs]), /PRIVATE_NODE_STATE_BODY|PRIVATE_PENDING_INPUT/);
  for (const [workspaceId, threadId, item] of [[affectedId, f.chatId, state.chat], [affectedId, f.raId, state.ra], [otherId, f.healthy.threadId, state.other]] as const) {
    assert.ok(f.visited.some(entry => entry.workspaceId === workspaceId && entry.threadId === threadId && entry.local));
    assert.equal(item?.status, "pending");
    assert.equal(item.sentTurnId, null);
    assert.equal(f.db.forWorkspace(workspaceId).threadQueueStates.getState(threadId).paused, false);
    const id = `list-${threadId}`;
    channel.emit("message", { t: "desktop.api.req", requestId: parentRequestId, id, request: { method: "threads.queue.list", body: { workspaceId, threadId } } });
    await new Promise(setImmediate);
    assert.equal(ipc.find(message => message.id === id)?.response.status, 200);
  }
  f.affected.db.prepare("UPDATE orch_instances SET node_states_json = ? WHERE id = ?").run(f.original, f.broken.instanceId);
  assert.equal(isDesktopLocalThreadAssetExecution(clientId, f.context.workspaces, f.affected, f.broken.threadId), true);
  const next = f.append(affectedId, f.broken.threadId);
  await onThreadQueueResume(f.context, { t: "api.req", id: "resume-after-repair", method: "threads.queue.resume", body: { workspaceId: affectedId, threadId: f.broken.threadId } } as any);
  assert.equal(f.sent.find(message => message.id === "resume-after-repair")?.status, 200);
  assert.equal(f.affected.threadQueueStates.getState(f.broken.threadId).paused, false);
  assert.equal(f.affected.threadMessageQueue.getById(f.broken.queueId)?.status, "failed");
  assert.equal(f.affected.threadMessageQueue.getById(next.id)?.status, "pending");
  assert.equal(f.affected.threadMessageQueue.getById(next.id)?.sentTurnId, null);
});

test("跨工作区领域错误不得被当前节点队列隔离为本区故障", t => {
  const f = fixture(t, "node", "automatic");
  t.after(f.close);
  const cause = new OrchInstanceScopeError({ instanceId: f.broken.instanceId, workspaceId: otherId, field: "node_states_json", reason: "invalid_json" });
  assert.throws(() => f.dispatcher.recoverOnStartup(() => { throw cause; }), error => error === cause);
  assert.equal(f.affected.threadMessageQueue.getById(f.broken.queueId)?.status, "pending");
  assert.equal(f.affected.threadQueueStates.getState(f.broken.threadId).paused, false);
  assert.equal(f.workspaceLogs.length, 0);
});

test("合法 JSON 内非法线程绑定仍按原严格字段诊断隔离节点队列", t => {
  const f = fixture(t, "node", "automatic");
  t.after(async () => { try { await f.dispatcher.waitForIdle(); } finally { f.close(); } });
  const invalid = JSON.stringify({ start: { ...JSON.parse(f.original).start, threadId: [] } });
  f.affected.db.prepare("UPDATE orch_instances SET node_states_json = ? WHERE id = ?").run(invalid, f.broken.instanceId);
  assert.doesNotThrow(() => f.dispatcher.recoverOnStartup(f.shouldRecover));
  assert.equal(f.affected.threadMessageQueue.getById(f.broken.queueId)?.status, "failed");
  assert.equal(f.affected.threadQueueStates.getState(f.broken.threadId).paused, true);
  const diagnostics = f.workspaceLogs.filter(log => log.entry.level === "error");
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every(log => log.entry.data.field === "node_states_json.threadId"
    && log.entry.data.reason === "expected_thread_id" && log.entry.data.isolationScope === "workspace_nodes"));
  assert.deepEqual(f.affected.db.prepare("SELECT node_states_json FROM orch_instances WHERE id = ?").get(f.broken.instanceId), { node_states_json: invalid });
  assert.equal(f.affected.threadMessageQueue.getById(f.chatQueueId)?.status, "pending");
  assert.equal(f.affected.threadMessageQueue.getById(f.raQueueId)?.status, "pending");
  assert.equal(f.other.threadMessageQueue.getById(f.healthy.queueId)?.status, "pending");
});

test("隔离队列写入失败必须回滚且上抛，不继续其他工作区", t => {
  const f = fixture(t, "node", "automatic");
  t.after(f.close);
  f.affected.db.exec("CREATE TRIGGER reject_recovery_queue_write BEFORE UPDATE OF status ON thread_message_queue WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'CONTROLLED_QUEUE_WRITE_FAILURE'); END");
  assert.throws(() => f.dispatcher.recoverOnStartup(f.shouldRecover), /CONTROLLED_QUEUE_WRITE_FAILURE/);
  assert.equal(f.affected.threadMessageQueue.getById(f.broken.queueId)?.status, "pending");
  assert.equal(f.affected.threadQueueStates.getState(f.broken.threadId).paused, false);
  assert.equal(f.other.threadMessageQueue.getById(f.healthy.queueId)?.status, "pending");
  assert.equal(f.visited.some(entry => entry.workspaceId === otherId), false);
  assert.equal(f.workspaceLogs.length, 0);
});

test("隔离错误日志失败仍保留原始领域因并拒绝后续恢复", t => {
  const f = fixture(t, "node", "automatic");
  t.after(f.close);
  const loggingFailure = new Error("CONTROLLED_RECOVERY_LOG_FAILURE");
  t.mock.method(f.affected, "writeWorkspaceLog", () => { throw loggingFailure; });
  assert.throws(() => f.dispatcher.recoverOnStartup(f.shouldRecover), error => {
    assert.ok(error instanceof WorkspaceApiRequestFailure);
    assert.equal(error.code, "WORKSPACE_API_REQUEST_LOG_FAILED");
    assert.ok(error.errors.includes(loggingFailure));
    assert.ok(error.errors[0] instanceof OrchInstanceScopeError);
    assert.equal(error.errors[0].details.instanceId, f.broken.instanceId);
    return true;
  });
  const queues = [f.broken, f.adjacent].map(entity => ({
    item: f.affected.threadMessageQueue.getById(entity.queueId), pause: f.affected.threadQueueStates.getState(entity.threadId),
  }));
  assert.equal(queues.filter(queue => queue.item?.status === "failed" && queue.pause.paused).length, 1);
  assert.equal(queues.filter(queue => queue.item?.status === "pending" && !queue.pause.paused).length, 1);
  assert.equal(f.other.threadMessageQueue.getById(f.healthy.queueId)?.status, "pending");
  assert.equal(f.visited.some(entry => entry.workspaceId === otherId), false);
});

test("真实 index 实例隔离事件写入失败回滚实体摘要和需求状态并上抛", async t => {
  const f = fixture(t, "node", "automatic");
  t.after(f.close);
  const before = {
    instance: f.affected.db.prepare("SELECT status, updated_at, node_states_json FROM orch_instances WHERE id = ?").get(f.broken.instanceId),
    summary: f.affected.db.prepare("SELECT * FROM orch_instance_summaries WHERE instance_id = ?").get(f.broken.instanceId),
    listState: f.affected.db.prepare("SELECT * FROM orch_intake_list_states WHERE intake_id = ?").get(f.broken.intakeId),
  };
  f.affected.db.exec("CREATE TRIGGER reject_instance_recovery_event BEFORE INSERT ON orch_events WHEN NEW.type = 'orchestration.error' BEGIN SELECT RAISE(ABORT, 'CONTROLLED_INSTANCE_EVENT_WRITE_FAILURE'); END");
  const recovery = instanceRecovery(f.db, f.context.workspaces);
  await assert.rejects(recovery.recover("desktop"), /CONTROLLED_INSTANCE_EVENT_WRITE_FAILURE/);
  assert.deepEqual({
    instance: f.affected.db.prepare("SELECT status, updated_at, node_states_json FROM orch_instances WHERE id = ?").get(f.broken.instanceId),
    summary: f.affected.db.prepare("SELECT * FROM orch_instance_summaries WHERE instance_id = ?").get(f.broken.instanceId),
    listState: f.affected.db.prepare("SELECT * FROM orch_intake_list_states WHERE intake_id = ?").get(f.broken.intakeId),
  }, before);
  assert.deepEqual(f.affected.orchEvents.listByInstance(f.broken.instanceId), []);
  assert.equal(recovery.logs.filter(entry => entry[0] === "error").length, 0);
  assert.equal(recovery.recovered.some(entry => entry.workspaceId === otherId), false);
});

test("真实 index 实例隔离日志失败保留已提交的暂停和事件并上抛", async t => {
  const f = fixture(t, "node", "automatic");
  t.after(f.close);
  const cause = new Error("CONTROLLED_INSTANCE_RECOVERY_LOG_FAILURE");
  const recovery = instanceRecovery(f.db, f.context.workspaces, cause);
  await assert.rejects(recovery.recover("desktop"), error => error === cause);
  assert.deepEqual(f.affected.db.prepare("SELECT status, node_states_json FROM orch_instances WHERE id = ?").get(f.broken.instanceId), { status: "paused", node_states_json: privateBody });
  assert.equal(f.affected.db.prepare("SELECT status FROM orch_instance_summaries WHERE instance_id = ?").get(f.broken.instanceId)?.status, "paused");
  assert.equal(f.affected.db.prepare("SELECT list_status FROM orch_intake_list_states WHERE intake_id = ?").get(f.broken.intakeId)?.list_status, "paused");
  assert.equal(f.affected.orchEvents.listByInstance(f.broken.instanceId).filter(event => event.type === "orchestration.error").length, 1);
  assert.equal(recovery.recovered.some(entry => entry.workspaceId === otherId), false);
});

for (const corruption of ["missing", "invalid_shape"] as const)
test(`真实 index 拒绝依赖 ${corruption} 摘要暂停实例且不改源记录`, async t => {
  const f = fixture(t, "node", "automatic");
  t.after(f.close);
  const before = f.affected.db.prepare("SELECT status, updated_at, node_states_json FROM orch_instances WHERE id = ?").get(f.broken.instanceId);
  if (corruption === "missing") f.affected.db.prepare("DELETE FROM orch_instance_summaries WHERE instance_id = ?").run(f.broken.instanceId);
  else f.affected.db.prepare("UPDATE orch_instance_summaries SET summary_json = ? WHERE instance_id = ?")
    .run(JSON.stringify({ ...f.originalSummary, runSummary: [] }), f.broken.instanceId);
  const recovery = instanceRecovery(f.db, f.context.workspaces);
  await assert.rejects(recovery.recover("desktop"), (error: any) => error.code === (corruption === "missing"
    ? "ORCH_INSTANCE_SUMMARY_PROJECTION_MISSING" : "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID"));
  assert.deepEqual(f.affected.db.prepare("SELECT status, updated_at, node_states_json FROM orch_instances WHERE id = ?").get(f.broken.instanceId), before);
  assert.deepEqual(f.affected.orchEvents.listByInstance(f.broken.instanceId), []);
  assert.equal(recovery.recovered.some(entry => entry.workspaceId === otherId), false);
  assert.doesNotMatch(JSON.stringify(recovery.logs), /PRIVATE_SUMMARY_BODY|PRIVATE_NODE_STATE_BODY/);
});

test("真实 index 不接受外部引擎冒用另一工作区的实例归属错误", async t => {
  const f = fixture(t, "node", "automatic");
  t.after(f.close);
  f.affected.db.prepare("UPDATE orch_instances SET node_states_json = ? WHERE id = ?").run(f.original, f.broken.instanceId);
  const cause = new OrchInstanceScopeError({ instanceId: f.broken.instanceId, workspaceId: otherId, field: "node_states_json", reason: "invalid_json" });
  const recovery = instanceRecovery(f.db, f.context.workspaces, undefined, { instanceId: f.broken.instanceId, error: cause });
  await assert.rejects(recovery.recover("desktop"), error => error === cause);
  assert.equal(f.affected.db.prepare("SELECT status FROM orch_instances WHERE id = ?").get(f.broken.instanceId)?.status, "running");
  assert.deepEqual(f.affected.orchEvents.listByInstance(f.broken.instanceId), []);
  assert.equal(recovery.recovered.some(entry => entry.workspaceId === otherId), false);
});
