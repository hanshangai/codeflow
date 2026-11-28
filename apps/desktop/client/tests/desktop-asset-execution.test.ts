import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createDefaultRoleExecutionConfig, createDefaultRoleInputDefinition, createDefaultRoleOutputDefinition,
  type OrchAssetExecutionAuthorization, type WorkspaceId,
} from "@codeflowai/shared";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { waitForOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.js";
import { evaluateSharedWorkspaceProviderNativeToolPolicy } from "../src/app/sharedWorkspaceToolPolicy.js";
import { openClientDb } from "../src/db/clientDb.js";
import { resetEngineModelCatalogRuntimeForTest, setEngineModelCatalogCustomModels } from "../src/engines/engineModelCatalogRuntime.js";
import { createClientDbOrchAssetLegacyRuntimeReader, OrchAssetAuthorityRuntimeReadService } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { XmlNodePromptRenderer } from "../src/orchestration/promptRenderer.js";
import { CodexAppServerThreadSession } from "../src/engines/codex-app-server/codexAppServerThreadSession.js";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.js";
import { createLocalEventPersistence } from "../src/runtime/localEventPersistence.js";
import { ThreadStore } from "../src/threads/threadStore.js";

/** 保留真实API、资产读取、SQLite与终态，仅隔离provider调用和授权owner。 */
function chatFixture(t: TestContext) {
  setEngineModelCatalogCustomModels([{
    id: "test:claude:claude-sonnet-4-6", engine: "claude", providerId: "anthropic", modelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6", inputModalities: ["text"],
    supportedReasoningEfforts: ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort, description: "" })),
    defaultReasoningEffort: "medium", contextWindow: 200_000, maxContextWindow: null,
    supportsFastMode: false, supports1MContext: false, enabled: true, createdAt: 1, updatedAt: 1,
  }]);
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-asset-dispatch-")));
  const scope = { workspaceId: path.basename(directory) as WorkspaceId, threadId: "thread" as any, turnId: "turn" as any };
  const app = openClientDb({ dbPath: path.join(directory, "client.db"), localCanonicalEvents: true });
  t.after(() => { app.close(); fs.rmSync(directory, { recursive: true, force: true }); resetEngineModelCatalogRuntimeForTest(); });
  app.workspaces.upsert({ id: scope.workspaceId, title: "授权派发", path: directory });
  const db = app.forWorkspace(scope.workspaceId);
  db.threads.create({ id: scope.threadId, workspaceId: scope.workspaceId, engine: "claude", title: "共享角色", threadType: "chat" });
  const threads = new ThreadStore();
  threads.create({ threadId: scope.threadId, workspaceId: scope.workspaceId, engine: "claude", title: "共享角色" });
  const authorization: OrchAssetExecutionAuthorization = {
    serverOrigin: "https://example.test", userId: "user-A", deviceId: "device-A", clientId: "local-device", hostBindingId: "host-A",
    hostScopeEpoch: 1, sharedWorkspaceId: "shared-A", runtimeWorkspaceId: scope.workspaceId, contextKey: "context-A",
    authorityEpoch: 2, appliedChangeSeq: 7, revisionSetHash: "a".repeat(64), snapshotHash: "b".repeat(64),
  };
  const role = { id: "shared-role", workspaceId: scope.workspaceId, name: "只读检查", description: "", systemPrompt: "检查代码",
    inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(), gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("claude"), kind: "custom" };
  let revoked = false, sends = 0;
  const failure = Object.assign(new Error("授权已失效"), { code: "ASSET_CACHE_REAUTHORIZATION_REQUIRED" });
  db.orchRoles.upsert(role as any);
  const reader = new OrchAssetAuthorityRuntimeReadService(createClientDbOrchAssetLegacyRuntimeReader(db, { requireCompleteDefinitions: true }));
  let beforeSend: (input: any) => void = () => {}, beforeTransport = () => {};
  const session = { engine: "claude", resolvePlatformToolTransport() { beforeTransport(); return "native-dynamic"; }, hasActiveTurn: () => false,
    async sendMessage(input: any) { sends++; beforeSend(input); return { responseText: "已完成检查" }; },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
  };
  const sessions: any = { hasActiveTurn: () => false, getActiveTurnId: () => null, getOrCreate: () => session,
    beginThreadOperation: () => () => {} };
  const persistence = createLocalEventPersistence({ db, applyRaw() {}, applyConversation(event) {
    if (event.type === "turn.started") db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
      turnId: event.payload.turnId, startedAt: event.ts, startEventSeq: event.seq });
    if (event.type === "turn.completed" || event.type === "turn.error") db.turns.setEnded(event.payload.turnId!, {
      status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: event.seq });
  } });
  const responses: any[] = [];
  const ctx = { db, threads, sessions, workspaces: new Map([[scope.workspaceId, directory]]), clientId: "local-device",
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 }, orchAssetRuntimeRead: reader,
    orchEngine: { forWorkspace() { return this; }, buildManagedServiceToolRegistry: () => null },
    assertAssetExecution(input: { authorization?: OrchAssetExecutionAuthorization | null }) {
      if (input.authorization) throw failure;
      if (revoked) throw failure;
    },
    send(message: any) { responses.push(message); }, onBeforeEmitConversationEvent(event: any) { persistence.persist({ t: "conversation.event", event }); },
  } as unknown as ApiHandlerContext;
  const request = () => handleApiRequest(ctx, { t: "api.req", id: "shared-dispatch", method: "threads.sendMessage", path: "/send",
    body: { ...scope, text: "检查代码", roleId: role.id, accessMode: "full-access", model: "claude-sonnet-4-6", effort: "medium" } });
  return { scope, ctx, db, sessions, authorization, failure, responses, request, sends: () => sends,
    revoke() { revoked = true; }, beforeSend(value: typeof beforeSend) { beforeSend = value; },
    beforeTransport(value: typeof beforeTransport) { beforeTransport = value; } };
}

test("本地角色异步准备后停止执行，真实普通发送入口拒绝派发", async t => {
  const f = chatFixture(t);
  f.beforeTransport(() => f.revoke());
  await f.request();
  await assert.rejects(waitForOrdinaryTurnExecution(f.sessions, f.scope), error => error === f.failure);
  assert.equal(f.sends(), 0);
});

test("本地角色保持所选访问模式且在途撤销不影响已接收回合收尾", async t => {
  const f = chatFixture(t);
  f.beforeSend(input => {
    assert.equal(input.accessMode, "full-access");
    assert.equal(input.sharedWorkspaceToolContext, null);
    f.revoke();
  });
  await f.request();
  await waitForOrdinaryTurnExecution(f.sessions, f.scope);
  assert.equal(f.sends(), 1);
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "completed");
});

test("已有运行快照的流程恢复仍复验授权，不能直接早返回", async () => {
  const instance = { id: "instance", workspaceId: "workspace", assetRuntimeSnapshot: {} };
  const failure = new Error("原账号授权失效");
  const engine = new OrchestrationEngine({ db: { orchInstances: { get: () => instance } } as any,
    threads: {} as any, sessions: {} as any, workspaces: new Map(), emitConversation() {}, emitRaw() {},
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    assertAssetExecution() { throw failure; },
  } as any);
  await assert.rejects(engine.ensureAssetRuntimeSnapshotForExecution(instance.id as any), error => error === failure);
});

test("本地角色入队不生成历史云端授权", async t => {
  const f = chatFixture(t);
  f.ctx.queueDispatcher = { forWorkspace() { return this; }, kickIfIdle() {} } as any;
  await handleApiRequest(f.ctx, { t: "api.req", id: "queue-asset", method: "threads.queue.append", path: "/queue",
    body: { ...f.scope, text: "稍后检查", sendOptions: { roleId: "shared-role", accessMode: "full-access", planMode: false } } });
  const item = f.db.threadMessageQueue.listActiveByThread(f.scope.threadId)[0];
  assert.ok(item);
  const stored = f.db.db.prepare("SELECT send_options_json FROM thread_message_queue WHERE id = ?").get(item.id) as { send_options_json: string };
  assert.equal(Object.hasOwn(JSON.parse(stored.send_options_json), "__assetExecutionAuthorization"), false);
  assert.equal(item.sendOptions.accessMode, "full-access");
  assert.equal(JSON.stringify(item).includes("user-A"), false);
});

test("取消本地角色后新入队不产生历史共享来源", async t => {
  const f = chatFixture(t);
  await f.request(); await waitForOrdinaryTurnExecution(f.sessions, f.scope);
  f.ctx.queueDispatcher = { forWorkspace() { return this; }, kickIfIdle() {} } as any;
  await handleApiRequest(f.ctx, { t: "api.req", id: "queue-history", method: "threads.queue.append", path: "/queue",
    body: { ...f.scope, text: "无角色继续", sendOptions: { roleId: null, accessMode: "full-access", planMode: false } } });
  const item = f.db.threadMessageQueue.listActiveByThread(f.scope.threadId)[0];
  assert.ok(item);
  assert.equal(f.db.threadMessageQueue.getAssetExecutionAuthorization(item.id), null);
  assert.equal(item.sendOptions.accessMode, "full-access");
});

for (const oldContext of ["missing-reference", "shared-write"] as const) {
  test(`原队列${oldContext}不能借历史缓存授权自动重放`, t => {
    const f = chatFixture(t);
    const item = f.db.threadMessageQueue.appendItem({ ...f.scope, text: "旧项", images: [], files: [], originWebSessionId: null,
      assetExecutionAuthorization: oldContext === "shared-write" ? f.authorization : null,
      sharedWorkspaceToolContext: oldContext === "shared-write" ? { sharedWorkspaceId: "shared-A", operationId: "write-op" as any,
        operationKey: "ai.thread.send.shared", toolPolicyKey: "ai.shared.write" } : null,
      sendOptions: { workMode: null, planMode: false, accessMode: "full-access", model: null, effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null },
    }).item;
    f.ctx.assertAssetExecution = input => {
      if (input.authorization === null || input.toolContext?.toolPolicyKey === "ai.shared.write") throw f.failure;
    };
    assert.throws(() => new ThreadQueueDispatcher(f.ctx).kickIfIdle(f.scope.threadId), error => error === f.failure);
    assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "pending");
    assert.equal(f.db.threadMessageQueue.getById(item.id)?.attemptCount, 0);
  });
}

test("撤权队列在claim前失败，保留pending与零次尝试", t => {
  const f = chatFixture(t);
  const item = f.db.threadMessageQueue.appendItem({ ...f.scope, text: "旧共享项", images: [], files: [], originWebSessionId: null,
    sendOptions: { workMode: null, planMode: false, accessMode: "read-only", model: null, effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null, roleId: "shared-role" as any },
  }).item;
  f.revoke();
  const dispatcher = new ThreadQueueDispatcher(f.ctx);
  assert.throws(() => dispatcher.kickIfIdle(f.scope.threadId), error => error === f.failure);
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "pending");
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.attemptCount, 0);
});

test("队列隐藏来源损坏显式失败，不把它当作旧个人项", t => {
  const f = chatFixture(t);
  const item = f.db.threadMessageQueue.appendItem({ ...f.scope, text: "损坏项", images: [], files: [], originWebSessionId: null,
    sendOptions: { workMode: null, planMode: false, accessMode: "read-only", model: null, effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null },
  }).item;
  for (const value of [{ userId: "user-A" }, null, []]) {
    f.db.db.prepare("UPDATE thread_message_queue SET send_options_json = ? WHERE id = ?").run(JSON.stringify({ __assetExecutionAuthorization: value }), item.id);
    assert.throws(() => f.db.threadMessageQueue.getAssetExecutionAuthorization(item.id), /ASSET_EXECUTION_HISTORY_INVALID/);
  }
});

test("缓存队列派发固定入队来源，不能用当前账号替换", async t => {
  const f = chatFixture(t);
  const original = { ...f.authorization };
  const item = f.db.threadMessageQueue.appendItem({ ...f.scope, text: "原账号入队", images: [], files: [], originWebSessionId: null,
    assetExecutionAuthorization: original,
    sendOptions: { workMode: null, planMode: false, accessMode: "read-only", model: "claude-sonnet-4-6", effort: "medium", contextWindow: null, autoCompactPct: null, serviceTier: null, roleId: "shared-role" as any },
  }).item;
  f.authorization.userId = "user-B";
  f.ctx.assertAssetExecution = input => {
    if (input.authorization) {
      assert.equal(input.authorization.userId, "user-A");
      throw f.failure;
    }
  };
  const dispatcher = new ThreadQueueDispatcher(f.ctx);
  assert.throws(() => dispatcher.kickIfIdle(f.scope.threadId), error => error === f.failure);
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "pending");
  assert.equal(f.sends(), 0);
});

test("已ACK队列同键重试只补本地收尾，授权失效不阻断已接收结果", async t => {
  const f = chatFixture(t);
  const item = f.db.threadMessageQueue.appendItem({ ...f.scope, text: "已接收", images: [], files: [], originWebSessionId: null,
    assetExecutionAuthorization: f.authorization, clientItemId: "ack-key",
    sendOptions: { workMode: null, planMode: false, accessMode: "read-only", model: null, effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null, roleId: "shared-role" as any },
  }).item;
  f.db.threadMessageQueue.markFailed(item.id, "active_turn_append_post_ack_failed", "只待本地收尾");
  let finalized = 0;
  f.ctx.queueDispatcher = { forWorkspace() { return this; }, kickIfIdle() { assert.fail("不能再次投递"); },
    async retryAcknowledgedFinalization() { finalized++; f.db.threadMessageQueue.markSent(item.id, "accepted-turn"); } } as any;
  f.revoke();
  await handleApiRequest(f.ctx, { t: "api.req", id: "queue-ack", method: "threads.queue.append", path: "/queue",
    body: { ...f.scope, text: "已接收", clientItemId: "ack-key", sendOptions: item.sendOptions } });
  assert.equal(finalized, 1);
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "sent");
  assert.equal(f.sends(), 0);
});

test("active追加发送前复验，撤权不把新输入送进已有provider回合", async t => {
  const f = chatFixture(t), item = f.db.threadMessageQueue.appendItem({ ...f.scope, text: "追加", images: [], files: [], originWebSessionId: null,
    assetExecutionAuthorization: f.authorization,
    sendOptions: { workMode: null, planMode: false, accessMode: "read-only", model: null, effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null },
  }).item;
  const claimed = f.db.threadMessageQueue.claimNextPendingForDispatch(f.scope.threadId);
  assert.ok(claimed && claimed.kind === "claimed");
  let appended = 0;
  f.sessions.appendInput = async () => { appended++; };
  f.sessions.hasActiveTurn = () => true;
  f.ctx.getActiveThreadTurn = () => ({ workspaceId: f.scope.workspaceId, threadId: f.scope.threadId, turnId: "active-turn", engine: "claude" } as any);
  f.revoke();
  const dispatcher = new ThreadQueueDispatcher(f.ctx);
  await (dispatcher as any).executeActiveTurnAppend({ ...item, attemptCount: 1 }, f.scope.workspaceId, f.scope.threadId, "active-turn");
  assert.equal(appended, 0);
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "failed");
  assert.equal(f.db.threadQueueStates.getState(f.scope.threadId).paused, true);
});

test("compact作为新执行复验，失效授权不发送provider压缩", async t => {
  const f = chatFixture(t);
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL WHERE id = ?").run(f.scope.threadId);
  f.ctx.threads.get(f.scope.threadId)!.engine = "codex";
  let compacts = 0;
  (f.sessions.getOrCreate() as any).compactThread = async () => { compacts++; };
  f.revoke();
  await handleApiRequest(f.ctx, { t: "api.req", id: "compact-asset", method: "threads.compact", path: "/compact", body: f.scope });
  await assert.rejects(waitForOrdinaryTurnExecution(f.sessions, f.scope), error => error === f.failure);
  assert.equal(compacts, 0);
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "error");
});

test("本地派发不保存云端授权且保留 provider checkpoint", async t => {
  const f = chatFixture(t);
  f.beforeSend(input => f.db.turns.setEngineCheckpoint(input.turnId, JSON.stringify({ sessionFileByteLen: 42 })));
  await f.request();
  await waitForOrdinaryTurnExecution(f.sessions, f.scope);
  const checkpoint = JSON.parse(f.db.turns.get(f.scope.turnId)!.engineCheckpointJson!);
  assert.equal(Object.hasOwn(checkpoint, "assetExecutionAuthorization"), false);
  assert.equal(checkpoint.sessionFileByteLen, 42);
});

test("compact复验之前实际派发来源，清空角色偏好不能绕过", async t => {
  const f = chatFixture(t);
  await f.request();
  await waitForOrdinaryTurnExecution(f.sessions, f.scope);
  f.db.turns.mergeEngineCheckpoint(f.scope.turnId, { assetExecutionAuthorization: f.authorization });
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL, role_id = NULL WHERE id = ?").run(f.scope.threadId);
  f.ctx.threads.get(f.scope.threadId)!.engine = "codex";
  let compacts = 0;
  (f.sessions.getOrCreate() as any).compactThread = async () => { compacts++; };
  f.ctx.assertAssetExecution = input => { if (input.authorization) throw f.failure; };
  const compactScope = { ...f.scope, turnId: "compact-turn" as any };
  await handleApiRequest(f.ctx, { t: "api.req", id: "compact-history", method: "threads.compact", path: "/compact", body: compactScope });
  await assert.rejects(waitForOrdinaryTurnExecution(f.sessions, compactScope), error => error === f.failure);
  assert.equal(compacts, 0);
});

test("历史共享来源的 compact 显式拒绝且保留原始来源", async t => {
  const f = chatFixture(t);
  await f.request(); await waitForOrdinaryTurnExecution(f.sessions, f.scope);
  f.db.turns.mergeEngineCheckpoint(f.scope.turnId, { assetExecutionAuthorization: f.authorization });
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL, role_id = NULL WHERE id = ?").run(f.scope.threadId);
  f.ctx.threads.get(f.scope.threadId)!.engine = "codex";
  let compacts = 0;
  (f.sessions.getOrCreate() as any).compactThread = async () => { compacts++; };
  const scope = { ...f.scope, turnId: "compact-history-rejected" as any };
  await handleApiRequest(f.ctx, { t: "api.req", id: "compact-history-rejected", method: "threads.compact", path: "/compact", body: scope });
  await assert.rejects(waitForOrdinaryTurnExecution(f.sessions, scope), error => error === f.failure);
  assert.equal(compacts, 0);
  assert.deepEqual(f.db.turns.getAssetExecutionAuthorizations(f.scope.threadId, null), [f.authorization]);
});

test("历史来源仅绑定实际provider会话，明确新binding不继承旧限制", async t => {
  const f = chatFixture(t);
  await f.request(); await waitForOrdinaryTurnExecution(f.sessions, f.scope);
  f.db.turns.mergeEngineCheckpoint(f.scope.turnId, { assetExecutionAuthorization: f.authorization });
  f.db.turns.setEngineSessionIdByThread(f.scope.threadId, "provider-A");
  assert.deepEqual(f.db.turns.getAssetExecutionAuthorizations(f.scope.threadId, "provider-A"), [f.authorization]);
  assert.deepEqual(f.db.turns.getAssetExecutionAuthorizations(f.scope.threadId, "provider-B"), []);
  assert.deepEqual(f.db.turns.getAssetExecutionAuthorizations(f.scope.threadId, null), []);
});

test("取消角色后的新聊天仍拒绝复用历史共享来源", async t => {
  const f = chatFixture(t);
  await f.request(); await waitForOrdinaryTurnExecution(f.sessions, f.scope);
  f.db.turns.mergeEngineCheckpoint(f.scope.turnId, { assetExecutionAuthorization: f.authorization });
  const scope = { ...f.scope, turnId: "without-role" as any };
  await handleApiRequest(f.ctx, { t: "api.req", id: "without-role", method: "threads.sendMessage", path: "/send",
    body: { ...scope, text: "继续", roleId: null, accessMode: "full-access", model: "claude-sonnet-4-6", effort: "medium" } });
  await assert.rejects(waitForOrdinaryTurnExecution(f.sessions, scope), error => error === f.failure);
  assert.equal(f.sends(), 1);
});

test("同一流程节点每轮派发复验，第一轮后撤权不能发送重试", async t => {
  const f = chatFixture(t), stop = new Error("第二轮授权已失效");
  let sends = 0, checks = 0;
  const session = { resolvePlatformToolTransport: () => "native-dynamic",
    async sendMessage(input: any) {
      sends++;
      assert.equal(input.accessMode, "read-only");
      assert.equal(evaluateSharedWorkspaceProviderNativeToolPolicy({ context: input.sharedWorkspaceToolContext, provider: "codex", toolName: "Bash" }).allowed, false);
      return { responseText: "尚未提交结果" };
    } };
  const engine = Object.create(OrchestrationEngine.prototype) as any;
  engine.ctx = { sessions: { getOrCreate: () => session }, workspaces: new Map([ [f.scope.workspaceId, f.ctx.workspaces.get(f.scope.workspaceId)] ]),
    db: { orchNodeAttempts: { bindExecution() {} } }, emitConversation() {}, emitRaw() {},
    assertAssetExecution() { checks++; if (sends) throw stop; } };
  engine.resolveOrCreateNodeThread = () => ({ threadId: "node-thread", thread: {}, reused: false });
  engine.resolveNodeBillingContext = () => null;
  engine.createPromptSnapshot = () => {};
  engine.isTurnStillStarted = () => false;
  engine.buildNodeResultSubmissionRecoveryMessage = () => "请提交结果";
  const envelope: any = { schemaVersion: "node-prompt-envelope/v1",
    meta: { scene: "orchestration-node", instanceId: "instance", workflowId: "workflow", workflowName: "复验", nodeId: "node", nodeLabel: "检查", intent: "execute" },
    role: { roleId: "role", name: "检查", responsibility: "检查", inputDefinition: { instructions: "", requiredFields: [] }, outputDefinition: { deliveryMode: "direct", format: "markdown", instructions: "结果", requiredFields: [] } },
    task: { title: "检查", goal: "检查", fieldBindings: {}, renderedTaskInput: "检查" }, artifacts: { upstreamArtifacts: [] },
    knowledge: { catalogs: [], warnings: [] }, review: {}, runtime: { toolRegistry: null, executionProfiles: [],
      runtimePolicy: { accessMode: "read-only", artifactPolicy: { outputMode: "text", primaryKind: "text", persistenceMode: "db-only" }, toolRuntimePolicy: { allowedToolIds: [], requiresWorkspaceWrite: false } } } };
  const prompt = { ...new XmlNodePromptRenderer().render(envelope), promptEnvelope: envelope,
    snapshots: { toolRegistry: null, runtimePolicy: envelope.runtime.runtimePolicy, knowledgeCatalogs: [], knowledgeWarnings: [], artifactInput: {} } };
  await assert.rejects(engine.executeSubThread({ id: "instance", workspaceId: f.scope.workspaceId, assetRuntimeSnapshot: { executionAuthorization: f.authorization } },
    { id: "node", type: "role", label: "检查" }, { outputDefinition: envelope.role.outputDefinition }, prompt,
    { engine: "codex", model: null, effort: null, accessMode: "full-access" }, {}, [], "attempt"), error => error === stop);
  assert.equal(sends, 1); assert.equal(checks, 2);
});

test("真实Codex compact消费者沿共享只读策略拒绝写工具审批", async t => {
  const f = chatFixture(t);
  let entered!: () => void, answered!: (value: any) => void;
  const compactEntered = new Promise<void>(resolve => { entered = resolve; });
  const answer = new Promise<any>(resolve => { answered = resolve; });
  const ws = { async ensureStarted() {}, registerThread() { return () => {}; },
    async request(method: string) {
      if (method === "thread/resume") return {};
      if (method === "thread/read") return { thread: { id: "provider-compact", status: "idle", turns: [] } };
      if (method === "thread/compact/start") { entered(); return {}; }
      assert.fail(`意外provider调用：${method}`);
    }, async respond(_id: unknown, value: any) { answered(value); } };
  const session = new CodexAppServerThreadSession({ manager: { getOrCreate: () => ws } as any,
    writeWorkspaceLog() {}, workspacePath: f.ctx.workspaces.get(f.scope.workspaceId)!, workspaceId: f.scope.workspaceId, threadId: f.scope.threadId,
    initialSessionId: "provider-compact", initialSessionCapabilities: null, onEngineProcessSnapshot: () => false,
    onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  const pending = session.compactThread({ turnId: "compact-native", catalogModel: "gpt-6.1-sol", accessMode: "read-only",
    sharedWorkspaceToolContext: { sharedWorkspaceId: "shared-A", operationId: "operation" as any, operationKey: "ai.thread.send.personal", toolPolicyKey: "ai.personal.readonly" } },
  { conversation() {}, raw() {} });
  await compactEntered;
  for (let i = 0; i < 30 && (session as any).active?.compactStartState?.phase !== "accepted"; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((session as any).active?.compactStartState?.phase, "accepted");
  (session as any).onAppServerMessage({ method: "item/started", params: { threadId: "provider-compact", turnId: "provider-turn", item: { id: "compact-item", type: "contextCompaction" } } });
  (session as any).onAppServerMessage({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "provider-compact", turnId: "provider-turn", command: "write-file" } });
  const result = await answer;
  assert.equal(result.decision, "decline");
  assert.match(result.note, /SHARED_WORKSPACE_TOOL_LOCK_REQUIRED/);
  (session as any).onAppServerMessage({ method: "turn/completed", params: { threadId: "provider-compact", turn: { id: "provider-turn", status: "completed" } } });
  await pending;
});
