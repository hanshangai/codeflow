import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import os from "node:os";
import path from "node:path";
import { MANUAL_TURN_INTERRUPT_CODE } from "@codeflowai/shared";
import * as owners from "../src/app/ordinaryTurnExecution.js";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { createLocalEventPersistence, createLocalEventPipeline } from "../src/runtime/localEventPersistence.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "@codeflowai/shared/engine-model-catalog-seed";
import { logger } from "../src/logger.js";
import { OrchAssetAuthorityRuntimeReadService, createClientDbOrchAssetLegacyRuntimeReader } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { createDefaultRoleExecutionConfig, createDefaultRoleInputDefinition, createDefaultRoleOutputDefinition } from "@codeflowai/shared";
import { ToolRuntimeService } from "../src/orchestration/toolRuntimeService.js";

/** 控制真实异步边界，不用延时猜测准备或发送的先后。 */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 只替代外部资源与准备；执行当前源码中的完整普通回合函数。 */
function continuationFixture() {
  const prepare = deferred<unknown[]>(), prepared = deferred<void>();
  let current = true, paused = false, sends = 0, transports = 0, released = 0;
  let knowledgeTurn: any = null, directoryRelease = () => {};
  const turn: any = { workspaceId: "workspace", threadId: "thread", turnId: "turn", status: "started" };
  const input: any = { ...turn, workspacePath: ".", engine: "claude", userItemId: "user", assistantItemId: "assistant", reasoningItemId: "reasoning",
    promptText: "任务", displayText: "任务", preparedInputActions: null, roleId: null, images: [], workMode: null,
    planMode: false, accessMode: "read-only", model: null, effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null,
    isThreadLifecycleCurrent: () => current,
    execution: { assertNotCancelled() {}, isCancellation() { return false; }, markProviderDispatch() {} },
    session: { engine: "claude", resolvePlatformToolTransport() { transports++; return "native-dynamic"; },
      async sendMessage() { sends++; return { responseText: "完成" }; }, releasePreparedInputActions() { released++; } },
  };
  const ctx: any = { isTaskAdmissionPaused: () => paused,
    db: { threads: { get: () => ({ workspaceId: "workspace", threadType: "chat", threadSubtype: "node-discussion" }) }, turns: { get: () => turn } },
    orchEngine: { buildManagedServiceToolRegistry: () => null },
  };
  const source = fs.readFileSync(new URL("../src/app/handleApiRequest.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["continueThreadTurnWithManagedServices", "withApiDatabase", "isRuntimeTurnCurrent", "isTurnStillStarted", "joinDeveloperMessages", "waitForOrdinaryTurnDispatch", "shouldPreserveTurnRunningState", "aggregateOrdinaryTurnFailures", "isSkillRuntimeDiagnosticFailure"]);
  const selected = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? "")).map(node => node.getText(parsed)).join("\n");
  const context = vm.createContext({ setTimeout, clearTimeout, MANUAL_TURN_INTERRUPT_CODE,
    readExistingCodeflowaiConfig: () => ({ config: { paths: { workflowDocsRoot: "codeflow-docs" } } }),
    reserveChatWorkflowDirectory: () => () => directoryRelease(), resolveChatRoleRuntime: () => null,
    prepareChatRoleSkills: async () => { prepared.resolve(); return await prepare.promise; },
    createKnowledgeConversationTurn: () => knowledgeTurn,
    KnowledgeAssetStore: class {}, ChatWorkflowService: class {},
    resolveWorkspaceKnowledgeChatContext: () => ({ systemRule: null, requiredWorkspaceSkills: [], knowledgeAssetTools: null }),
    mergeExecutableToolRegistries: () => null, createKnowledgeSuggestionTurn: () => null,
    buildDefaultChatSystemPrompt: () => "system", buildThreadExecutionProfileSystemRule: () => null,
    buildManagedServiceDeveloperMessage: () => null, buildNativeDynamicToolDeveloperMessageForChat: () => null,
    logger: { error() {}, warn() {} }, knowledgeFailure: () => ({ code: "PREPARATION_FAILED" }),
    writeWorkspaceTurnLog() {},
  });
  const code = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInContext(code, context);
  return { ctx, input, turn, prepare, prepared, run: () => context.continueThreadTurnWithManagedServices(ctx, input) as Promise<unknown>,
    setCurrent(value: boolean) { current = value; }, setPaused(value: boolean) { paused = value; },
    useKnowledge(value: unknown) { knowledgeTurn = value; }, releaseDirectory(value: () => void) { directoryRelease = value;
      ctx.db.threads.get = () => ({ workspaceId: "workspace", threadType: "chat", threadSubtype: null }); },
    sends: () => sends, transports: () => transports, released: () => released };
}

test("普通回合异步准备后已取消，禁止继续解析工具或发送模型", async () => {
  const f = continuationFixture();
  const running = f.run();
  const rejected = assert.rejects(running, { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" });
  await f.prepared.promise;
  f.setCurrent(false);
  f.turn.status = "error";
  f.prepare.resolve([]);
  await rejected;
  assert.equal(f.sends(), 0);
  assert.equal(f.transports(), 0);
});

test("普通回合更新询问可逆等待，稍后继续已受理的准备和发送", async () => {
  const f = continuationFixture();
  const running = f.run();
  await f.prepared.promise;
  f.setPaused(true);
  f.prepare.resolve([]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.sends(), 0);
  assert.equal(f.transports(), 0);
  f.setPaused(false);
  await running;
  assert.equal(f.sends(), 1);
});

for (const field of ["workspaceId", "threadId", "turnId", "status", "missing"] as const) {
  test(`准备完成后核对精确 ${field}，不借其它回合事实派发`, async () => {
    const f = continuationFixture(), running = f.run();
    const rejected = assert.rejects(running, { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" });
    await f.prepared.promise;
    if (field === "missing") f.ctx.db.turns.get = () => null;
    else f.turn[field] = "other";
    f.prepare.resolve([]);
    await rejected;
    assert.equal(f.sends(), 0);
    assert.equal(f.transports(), 0);
  });
}

test("更新等待期间确认取消可退出等待，准备输入也按原入口释放", async () => {
  const f = continuationFixture();
  f.input.preparedInputActions = {};
  const running = f.run(), rejected = assert.rejects(running, { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" });
  await f.prepared.promise;
  f.setPaused(true); f.prepare.resolve([]);
  await new Promise<void>(resolve => setImmediate(resolve));
  f.turn.status = "error";
  await rejected;
  assert.equal(f.sends(), 0);
  assert.equal(f.released(), 1);
});

test("Codex binding旋转前冻结，稍后恢复后沿原turn只重试一次", async () => {
  const f = continuationFixture();
  const mismatch = Object.assign(new Error("BINDING_MISMATCH"), { code: "codex_thread_capability_incompatible" });
  const first = deferred<void>();
  let attempts = 0, rotations = 0;
  f.input.engine = "codex";
  f.useKnowledge({ finish() {} });
  f.input.session.getSessionId = () => "provider-thread";
  f.input.session.resetDynamicToolBinding = () => { rotations++; return true; };
  f.input.session.sendMessage = async () => {
    attempts++;
    if (attempts === 1) { f.setPaused(true); first.resolve(); throw mismatch; }
    return { responseText: "完成" };
  };
  f.prepare.resolve([]);
  const running = f.run();
  await first.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(rotations, 0);
  assert.equal(attempts, 1);
  f.setPaused(false);
  await running;
  assert.equal(rotations, 1);
  assert.equal(attempts, 2);
});

test("binding重试间取消，不旋转provider绑定或再次send", async () => {
  const f = continuationFixture();
  const mismatch = Object.assign(new Error("BINDING_MISMATCH"), { code: "codex_thread_capability_incompatible" });
  let attempts = 0, rotations = 0;
  f.input.engine = "codex";
  f.useKnowledge({ finish() {} });
  f.input.session.getSessionId = () => "provider-thread";
  f.input.session.resetDynamicToolBinding = () => { rotations++; return true; };
  f.input.session.sendMessage = async () => { attempts++; f.turn.status = "error"; f.setCurrent(false); throw mismatch; };
  f.prepare.resolve([]);
  await assert.rejects(f.run(), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" });
  assert.equal(rotations, 0);
  assert.equal(attempts, 1);
});

test("原准备错误即使随后取消也保留原identity", async () => {
  const f = continuationFixture(), failure = new Error("SKILL_PREPARATION_FAILED"), running = f.run();
  const rejected = assert.rejects(running, error => error === failure);
  await f.prepared.promise;
  f.turn.status = "error"; f.setCurrent(false);
  f.prepare.reject(failure);
  await rejected;
});

test("发送与知识收尾同时失败，两个原根因全部返回", async () => {
  const f = continuationFixture(), sending = new Error("SEND_ROOT"), cleanup = new Error("KNOWLEDGE_CLEANUP_ROOT");
  f.useKnowledge({ finish() { throw cleanup; } });
  f.input.session.sendMessage = async () => { throw sending; };
  f.prepare.resolve([]);
  await assert.rejects(f.run(), (error: any) => {
    assert.equal(error.name, "AggregateError");
    assert.deepEqual([...error.errors], [sending, cleanup]);
    return true;
  });
});

for (const failure of [undefined, null, NaN, false, 0, ""]) {
  test(`原异步准备拒绝 ${String(failure)} 即使取消也保持失败identity`, async () => {
    const f = continuationFixture(), running = f.run();
    const result = running.then(() => ({ ok: true }), error => ({ ok: false, error }));
    await f.prepared.promise;
    f.setCurrent(false); f.turn.status = "error"; f.prepare.reject(failure);
    const settled = await result;
    assert.equal(settled.ok, false);
    assert.equal("error" in settled && Object.is(settled.error, failure), true);
  });
}

test("发送成功而知识收尾失败，原清理异常仍拒绝", async () => {
  const f = continuationFixture(), failure = new Error("SUCCESS_CLEANUP_FAILED");
  f.useKnowledge({ finish() { throw failure; } });
  f.prepare.resolve([]);
  await assert.rejects(f.run(), error => error === failure);
});

test("binding旋转后迟到取消，不开始第二次模型发送", async () => {
  const f = continuationFixture();
  let sends = 0;
  f.input.engine = "codex"; f.useKnowledge({ finish() {} });
  f.input.session.getSessionId = () => "provider-thread";
  f.input.session.resetDynamicToolBinding = () => { f.setCurrent(false); f.turn.status = "error"; return true; };
  f.input.session.sendMessage = async () => { sends++; throw Object.assign(new Error("binding"), { code: "codex_thread_capability_incompatible" }); };
  f.prepare.resolve([]);
  await assert.rejects(f.run(), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" });
  assert.equal(sends, 1);
});

const scope: owners.OrdinaryTurnExecutionScope = { workspaceId: "workspace", threadId: "thread", turnId: "turn" };

test("普通回合owner覆盖准备发送和清理，成功后移除活动项", async () => {
  const sessions = {}, prepare = deferred<void>(), send = deferred<void>(), cleanup = deferred<void>();
  let phase = "prepare", settled = false;
  owners.trackOrdinaryTurnExecution(sessions, scope, async () => {
    await prepare.promise; phase = "send";
    try { await send.promise; } finally { phase = "cleanup"; await cleanup.promise; }
  });
  assert.equal(owners.hasOrdinaryTurnExecutions(sessions), true);
  assert.deepEqual(owners.listOrdinaryTurnExecutions(sessions), [scope]);
  const waiting = owners.waitForOrdinaryTurnExecution(sessions, scope).then(() => { settled = true; });
  prepare.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(phase, "send");
  assert.equal(settled, false);
  send.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(phase, "cleanup");
  assert.equal(settled, false);
  cleanup.resolve();
  await waiting;
  assert.deepEqual(owners.listOrdinaryTurnExecutions(sessions), []);
  assert.equal(owners.hasOrdinaryTurnExecutions(sessions), false);
  await owners.waitForOrdinaryTurnExecution(sessions, scope);
});

test("owner超时不释放原工作，可再次精确等待直到清理完成", async () => {
  const sessions = {}, cleanup = deferred<void>();
  owners.trackOrdinaryTurnExecution(sessions, scope, () => cleanup.promise);
  await assert.rejects(owners.waitForOrdinaryTurnExecution(sessions, scope, { timeoutMs: 5 }), { code: "ORDINARY_TURN_EXECUTION_TIMEOUT" });
  assert.equal(owners.hasOrdinaryTurnExecutions(sessions), true);
  const first = owners.waitForOrdinaryTurnExecution(sessions, scope), repeated = owners.waitForOrdinaryTurnExecution(sessions, scope);
  cleanup.resolve();
  await Promise.all([first, repeated]);
  assert.equal(owners.hasOrdinaryTurnExecutions(sessions), false);
});

for (const failure of [undefined, null, NaN, false, 0, "", new Error("EXACT_PREPARATION_FAILURE")]) {
  test(`owner保留任意拒绝值 ${String(failure)}，终态历史不再算活动但可重复等待`, async () => {
    const sessions = {}, prepare = deferred<void>();
    owners.trackOrdinaryTurnExecution(sessions, scope, () => prepare.promise);
    const first = owners.waitForOrdinaryTurnExecution(sessions, scope).then(() => ({ ok: true }), error => ({ ok: false, error }));
    prepare.reject(failure);
    const result = await first;
    assert.equal(result.ok, false);
    assert.equal("error" in result && Object.is(result.error, failure), true);
    assert.equal(owners.hasOrdinaryTurnExecutions(sessions), false);
    assert.deepEqual(owners.listOrdinaryTurnExecutions(sessions), []);
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = await owners.waitForOrdinaryTurnExecution(sessions, scope).then(() => ({ ok: true }), error => ({ ok: false, error }));
      assert.equal(again.ok, false);
      assert.equal("error" in again && Object.is(again.error, failure), true);
    }
  });
}

test("owner按sessions与workspace/thread/turn精确隔离，不等待另一回合", async () => {
  const sessions = {}, anotherSessions = {}, pending = deferred<void>();
  owners.trackOrdinaryTurnExecution(sessions, scope, () => pending.promise);
  await owners.waitForOrdinaryTurnExecution(anotherSessions, scope);
  for (const other of [{ ...scope, workspaceId: "other" }, { ...scope, threadId: "other" }, { ...scope, turnId: "other" }]) {
    await owners.waitForOrdinaryTurnExecution(sessions, other);
  }
  assert.equal(owners.hasOrdinaryTurnExecutions(sessions), true);
  pending.resolve();
  await owners.waitForOrdinaryTurnExecution(sessions, scope);
});

test("owner拒绝空身份与非法超时，也不覆盖同一精确回合的在途owner", async () => {
  const sessions = {}, pending = deferred<void>();
  for (const field of ["workspaceId", "threadId", "turnId"] as const) {
    const invalid = { ...scope, [field]: " " };
    assert.throws(() => owners.trackOrdinaryTurnExecution(sessions, invalid, async () => {}), { code: "ORDINARY_TURN_EXECUTION_SCOPE_INVALID" });
    await assert.rejects(owners.waitForOrdinaryTurnExecution(sessions, invalid), { code: "ORDINARY_TURN_EXECUTION_SCOPE_INVALID" });
  }
  owners.trackOrdinaryTurnExecution(sessions, scope, () => pending.promise);
  assert.throws(() => owners.trackOrdinaryTurnExecution(sessions, scope, async () => {}), { code: "ORDINARY_TURN_EXECUTION_ALREADY_OWNED" });
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(owners.waitForOrdinaryTurnExecution(sessions, scope, { timeoutMs }), { code: "ORDINARY_TURN_EXECUTION_TIMEOUT_INVALID" });
  }
  pending.resolve();
  await owners.waitForOrdinaryTurnExecution(sessions, scope);
});

/** 真实 API、SQLite、事件与终态入口，仅让 provider 发送和终态准备可控。 */
function apiFixture(t: TestContext) {
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] });
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-update-stop-")));
  const scope: owners.OrdinaryTurnExecutionScope = { workspaceId: path.basename(directory), threadId: "thread", turnId: "turn" };
  const app = openClientDb({ dbPath: path.join(directory, "client.db"), localCanonicalEvents: true });
  let closeWriter: (() => Promise<void>) | undefined;
  t.after(async () => { try { await closeWriter?.(); } finally { app.close(); fs.rmSync(directory, { recursive: true, force: true }); resetEngineModelCatalogRuntimeForTest(); } });
  const errors = t.mock.method(logger, "error", () => {});
  app.workspaces.upsert({ id: scope.workspaceId, title: "普通回合", path: directory });
  const db = app.forWorkspace(scope.workspaceId);
  db.threads.create({ id: scope.threadId, workspaceId: scope.workspaceId, engine: "claude", title: "更新", threadType: "orchestration", threadSubtype: "node-discussion" });
  const threads = new ThreadStore();
  threads.create({ threadId: scope.threadId, workspaceId: scope.workspaceId, engine: "claude", title: "更新" });
  const entered = deferred<void>(), sending = deferred<{ responseText: string }>(), terminal = deferred<void>();
  let operationCount = 0, releases = 0, pause = false, awaitTerminal = false, failRelease = false;
  let releaseFailure: unknown;
  const session = { engine: "claude", resolvePlatformToolTransport: () => "native-dynamic", hasActiveTurn: () => false,
    async sendMessage() { entered.resolve(); return await sending.promise; },
    async prepareAssistantTerminalEvents() { if (awaitTerminal) await terminal.promise; return { events: [], latestAssistantText: null }; },
  };
  const sessions: any = { hasActiveTurn: () => false, getActiveTurnId: () => null, getOrCreate: () => session,
    beginThreadOperation() { operationCount++; let released = false; return () => {
      assert.equal(released, false); released = true; operationCount--; releases++;
      if (failRelease && operationCount === 0) throw releaseFailure;
    }; },
  };
  const persistence = createLocalEventPersistence({ db, applyRaw() {}, applyConversation(event) {
    if (event.type === "turn.started") db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
      turnId: event.payload.turnId, startedAt: event.ts, startEventSeq: event.seq });
    if (event.type === "turn.completed" || event.type === "turn.error") db.turns.setEnded(event.payload.turnId!, {
      status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: event.seq });
  } });
  const responses: any[] = [];
  const ctx = { db, threads, sessions, workspaces: new Map([[scope.workspaceId, directory]]), clientId: "ordinary-test",
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    orchEngine: { forWorkspace() { return this; }, buildManagedServiceToolRegistry: () => null }, isTaskAdmissionPaused: () => pause,
    send(message: any) { responses.push(message); }, onBeforeEmitConversationEvent(event: any) { persistence.persist({ t: "conversation.event", event }); },
  } as unknown as ApiHandlerContext;
  const request = () => handleApiRequest(ctx, { t: "api.req", id: "ordinary-request", method: "threads.sendMessage", path: "/send",
    body: { ...scope, text: "更新测试", model: "claude-sonnet-4-6", effort: "medium" } });
  return { scope, ctx, db, app, directory, threads, sessions, session, entered, sending, terminal, responses, request, errors,
    ownWriter(close: () => Promise<void>) { closeWriter = close; },
    /** 回归断言读取实际W日志，应用logger不再替代回合诊断。 */
    logs() { return fs.readdirSync(path.join(directory, ".codeflowai")).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(directory, ".codeflowai", name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); },
    operations: () => operationCount, releases: () => releases, setPaused(value: boolean) { pause = value; }, waitTerminal(value: boolean) { awaitTerminal = value; },
    rejectRelease(error: unknown) { failRelease = true; releaseFailure = error; } };
}

/** 将真实Writer和事件管线装入原API夹具，运行态只由已索引事件推进。 */
async function enableApiWriter(f: ReturnType<typeof apiFixture>) {
  let runtimeActive = false;
  const failures: unknown[] = [];
  const writer = new ClientDbWriterService({ dbPath: path.join(f.directory, "client.db"), db: f.app,
    onFatalError: error => { failures.push(error); } });
  const pipeline = createLocalEventPipeline({ writer,
    apply(message) {
      if (message.t !== "conversation.event") return;
      const event = message.event;
      if (event.type === "turn.started") runtimeActive = true;
      if (event.type === "turn.completed" || event.type === "turn.error") runtimeActive = false;
      if (event.type === "turn.started") f.db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId,
        engine: event.engine, turnId: event.payload.turnId, startedAt: event.ts, startEventSeq: event.seq });
      if (event.type === "turn.completed" || event.type === "turn.error") f.db.turns.setEnded(event.payload.turnId!, {
        status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: event.seq });
    }, publish() {}, onFailure(error) { failures.push(error); },
  });
  f.ownWriter(async () => { try { await pipeline.close(); } finally { await writer.close(); } });
  await writer.ready();
  f.ctx.withDatabase = (requestId, operation) => writer.withLegacyDatabase(requestId, operation);
  f.ctx.getActiveThreadTurn = () => runtimeActive ? { turnId: f.scope.turnId, startedAt: 1 } : null;
  f.ctx.clearActiveThreadTurn = () => { runtimeActive = false; };
  f.ctx.flushLocalEvents = (workspaceId, threadId) => pipeline.flush(workspaceId, threadId);
  f.ctx.onBeforeEmitConversationEvent = event => pipeline.enqueue({ t: "conversation.event", event }, f.scope.turnId, 1);
  return { writer, failures };
}

test("普通发送和provider增量在真实Writer许可下完成且网络等待不持许可", async t => {
  const f = apiFixture(t);
  const { writer, failures } = await enableApiWriter(f);
  f.session.sendMessage = async (_input: any, sink: any) => {
    assert.throws(() => f.db.turns.get(f.scope.turnId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    sink.conversation({ ts: Date.now(), ...f.scope, engine: "claude", type: "item.assistantText.delta",
      payload: { turnId: f.scope.turnId, itemId: "assistant", delta: "正文" } });
    await sink.flush();
    return { responseText: "正文" };
  };
  await f.request();
  assert.equal(f.responses.find(message => message.t === "api.res")?.status, 200);
  await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  assert.equal(await writer.withLegacyDatabase("verify-terminal", () => f.db.turns.get(f.scope.turnId)?.status), "completed");
  assert.deepEqual(failures, []);
});

test("普通停止在真实Writer下先确认物理停止再排空增量和终态", async t => {
  const f = apiFixture(t);
  const { writer, failures } = await enableApiWriter(f);
  f.session.sendMessage = async (_input: any, sink: any) => {
    sink.conversation({ ts: Date.now(), ...f.scope, engine: "claude", type: "item.assistantText.delta",
      payload: { turnId: f.scope.turnId, itemId: "assistant", delta: "停止前正文" } });
    f.entered.resolve();
    return await f.sending.promise;
  };
  let stopped = false;
  f.sessions.interrupt = async (_threadId: string, _turnId: string, options: any) => {
    assert.throws(() => f.db.turns.get(f.scope.turnId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    stopped = true;
    options.onStopConfirmed();
    f.sending.reject(Object.assign(new Error("已停止"), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" }));
    return true;
  };
  await f.request();
  await f.entered.promise;
  await handleApiRequest(f.ctx, { t: "api.req", id: "stop-request", method: "turns.interrupt", path: "/stop", body: f.scope });
  await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  assert.equal(stopped, true);
  assert.equal(f.responses.find(message => message.t === "api.res" && message.id === "stop-request")?.body.phase, "draining");
  assert.equal(await writer.withLegacyDatabase("verify-stopped", () => f.db.turns.get(f.scope.turnId)?.status), "error");
  const events = await writer.withLegacyDatabase("verify-events", () => f.db.conversationEvents.listByThread(f.scope.threadId));
  assert.equal(events.filter(event => event.type === "turn.error").length, 1);
  assert.equal(events.some(event => event.type === "item.assistantText.delta"), true);
  assert.deepEqual(failures, []);
});

test("手动压缩在真实Writer下等待started和增量落库再结算", async t => {
  const f = apiFixture(t);
  f.db.db.prepare("UPDATE threads SET engine = 'codex' WHERE id = ?").run(f.scope.threadId);
  f.threads.get(f.scope.threadId)!.engine = "codex";
  f.session.engine = "codex";
  const { writer, failures } = await enableApiWriter(f);
  (f.session as any).compactThread = async (_input: unknown, sink: any) => {
    assert.throws(() => f.db.turns.get(f.scope.turnId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    sink.conversation({ ts: Date.now(), ...f.scope, engine: "codex", type: "item.assistantText.delta",
      payload: { turnId: f.scope.turnId, itemId: "assistant", delta: "压缩结果" } });
    await sink.flush();
  };
  await handleApiRequest(f.ctx, { t: "api.req", id: "compact-request", method: "threads.compact", path: "/compact", body: f.scope });
  assert.equal(f.responses.find(message => message.t === "api.res")?.status, 200);
  await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  assert.equal(await writer.withLegacyDatabase("verify-compacted", () => f.db.turns.get(f.scope.turnId)?.status), "completed");
  assert.deepEqual(failures, []);
});

test("清空API沿处理器自己的独占门禁，不被外层普通租约自锁", async t => {
  const f = apiFixture(t);
  const { writer } = await enableApiWriter(f);
  let deleted = false;
  f.sessions.beginThreadDeletion = () => {
    assert.equal(f.operations(), 0, "清空前不能持有外层普通thread operation");
    deleted = true;
    return () => {};
  };
  await handleApiRequest(f.ctx, { t: "api.req", id: "clear-request", method: "threads.clear", path: "/clear",
    body: { ...f.scope, resetSession: false } });
  assert.equal(f.responses.find(message => message.t === "api.res")?.status, 200);
  assert.equal(deleted, true);
  assert.equal(await writer.withLegacyDatabase("verify-clear", () => f.db.conversationEvents.getLatestSeqByThread(f.scope.threadId)), 0);
});

test("普通API先返回耐久受理，再让原owner执行后续准备", async t => {
  const f = apiFixture(t), observations: string[] = [];
  f.ctx.orchEngine.buildManagedServiceToolRegistry = () => { observations.push("prepare"); return null; };
  await f.request();
  assert.equal(f.responses.filter(message => message.t === "api.res").length, 1);
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "started");
  const preparationBeforeResponse = observations.length;
  f.sending.resolve({ responseText: "完成" });
  await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  assert.equal(preparationBeforeResponse, 0, "受理返回不得被后续同步准备抢占");
  assert.deepEqual(observations, ["prepare"]);
  assert.equal(f.operations(), 0);
});

test("受理回包后让出期间可精确取消，禁止provider派发", async t => {
  const f = apiFixture(t); let sends = 0;
  f.session.sendMessage = async () => { sends++; return { responseText: "不应派发" }; };
  await f.request();
  assert.equal(owners.cancelOrdinaryTurnBeforeDispatch(f.sessions, f.scope), true);
  await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  assert.equal(sends, 0);
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "error");
  assert.equal(f.responses.filter(message => message.t === "api.res").length, 1);
  assert.equal(f.operations(), 0);
});

test("受理回包后立即关闭，原排空入口取消暂停中的未派发回合", async t => {
  const f = apiFixture(t); let sends = 0;
  f.session.sendMessage = async () => { sends++; return { responseText: "不应派发" }; };
  await f.request();
  let polls = 0, requiredCleanup = false;
  // 旧实现重复进入永久暂停时显式清理，避免用墙钟门槛断言或遗留轮询。
  f.ctx.isTaskAdmissionPaused = () => {
    if (++polls === 2) { requiredCleanup = true; owners.cancelOrdinaryTurnBeforeDispatch(f.sessions, f.scope); }
    return true;
  };
  await owners.drainOrdinaryTurnExecutions(f.sessions);
  assert.equal(requiredCleanup, false, "关闭排空必须撤销尚未派发的回合，不能等待永久暂停解除");
  assert.equal(sends, 0);
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "error");
  assert.equal(f.responses.filter(message => message.t === "api.res").length, 1);
  assert.equal(f.operations(), 0);
});

test("真实普通发送在显式全局配置下复用Git保护，不逐查询启动子进程", async t => {
  const f = apiFixture(t), directory = f.ctx.workspaces.get(f.scope.workspaceId as any)!;
  childProcess.execFileSync("git", ["init", "--quiet"], { cwd: directory, windowsHide: true });
  const config = path.join(directory, "test.gitconfig"), previous = process.env.GIT_CONFIG_GLOBAL;
  fs.writeFileSync(config, "[core]\n  autocrlf = false\n", "utf8");
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  f.db.threads.get(f.scope.threadId); f.db.threads.get(f.scope.threadId);
  const spawn = childProcess.spawnSync;
  let git = 0;
  t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof spawn>) => {
    if (args[0] === "git") git++;
    return spawn(...args);
  }) as typeof spawn);
  syncBuiltinESMExports(); t.after(syncBuiltinESMExports);
  const startedAt = performance.now();
  await f.request();
  const duration = Math.round(performance.now() - startedAt), gitBeforeResponse = git;
  f.sending.resolve({ responseText: "完成" });
  await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  assert.equal(gitBeforeResponse, 0);
  assert.equal(git, 0);
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "completed");
  t.diagnostic(`临时真实 Git/SQLite 普通请求受理：${duration}ms，${gitBeforeResponse} 次 Git；provider 为受控夹具`);
});

test("ordinary public API host callback preserves real tool-file preparation rejection and W diagnostic double failure", async t => {
  const f = apiFixture(t), directory = f.ctx.workspaces.get(f.scope.workspaceId as any)!;
  f.db.db.prepare("UPDATE threads SET thread_type = 'chat', thread_subtype = NULL WHERE id = ?").run(f.scope.threadId);
  const skill = f.db.orchSkills.upsert({ id: "execute-skill" as any, workspaceId: f.scope.workspaceId as any, kind: "custom", name: "执行", description: "测试", trigger: "测试", instructions: "测试", slug: "ordinary-execute", targetEngines: ["claude"],
    skillMd: "# Skill", files: [{ relPath: "scripts/run.mjs", kind: "script", contentText: "import fs from 'node:fs'; fs.appendFileSync(process.env.CODEFLOWAI_TOOL_WORKSPACE_PATH + '/once.txt','1'); printJson({ok:true});", sizeBytes: 0, sha256: "" }],
    scripts: [{ id: "run", name: "运行", description: "测试", runtime: "node", scriptPath: "scripts/run.mjs", exposeAsTool: true }] });
  const role = f.db.orchRoles.upsert({ id: "execute-role" as any, workspaceId: f.scope.workspaceId as any, kind: "custom", name: "执行", description: "测试", gateCriteria: [], systemPrompt: "规则", defaultSkillIds: [skill.id],
    inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(), executionConfig: createDefaultRoleExecutionConfig("claude") });
  f.ctx.orchAssetRuntimeRead = new OrchAssetAuthorityRuntimeReadService(createClientDbOrchAssetLegacyRuntimeReader(f.db, { requireCompleteDefinitions: true }),
    { getAsset: () => { throw new Error("unexpected server read"); }, listAssets: () => [] } as any, { getRuntimeReadinessRequirement: () => null });
  const scriptFds = new Set<number>(), open = fs.openSync, write = fs.writeFileSync;
  const preparation = new Error("ordinary-tool-write-root"), logging = new Error("ordinary-log-root");
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => { const fd = open(...args);
    if (String(args[0]).endsWith(`${path.sep}tool.mjs`) && String(args[0]).includes(`${path.sep}tool-runtime${path.sep}`)) scriptFds.add(fd);
    return fd; });
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    if (typeof args[0] === "number" && scriptFds.has(args[0])) { scriptFds.delete(args[0]); throw preparation; }
    return write(...args);
  });
  let original: unknown, executions = 0, sends = 0;
  const execute = ToolRuntimeService.prototype.execute;
  t.mock.method(ToolRuntimeService.prototype, "execute", function(this: ToolRuntimeService, ...args: Parameters<typeof execute>) {
    executions++; return execute.apply(this, args).catch(error => { original = error; throw error; });
  });
  (f.session as any).sendMessage = async (input: any) => {
    sends++; const tool = input.toolRegistry.tools.find((item: any) => item.runtime === "node"); assert.ok(tool);
    await assert.rejects(input.executeHostTool({ toolId: tool.toolId, toolInput: {}, accessMode: "current" }), error => error === original);
    const error = original as any;
    if (sends === 1) assert.equal(error, preparation);
    else {
      assert.equal(error.code, "TOOL_RUNTIME_PREPARATION_FAILED");
      assert.equal(error.parentRequestId, `ordinary-execute-${sends}`); assert.equal(error.turnId, input.turnId);
      assert.equal(error.threadId, f.scope.threadId); assert.equal(error.workspaceId, f.scope.workspaceId);
      assert.deepEqual(error.errors, [preparation, logging]);
    }
    // 模拟原 provider 的明确工具失败投影；工具失败允许模型正常结束本回合。
    return { responseText: "已收到明确工具失败" };
  };
  try {
    for (let index = 1; index <= 2; index++) {
      if (index === 2) t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
      const turnId = `execute-turn-${index}`;
      await handleApiRequest(f.ctx, { t: "api.req", id: `ordinary-execute-${index}`, method: "threads.sendMessage", path: "/send",
        body: { ...f.scope, turnId, roleId: role.id, text: "执行", model: "claude-sonnet-4-6", effort: "medium" } });
      await owners.waitForOrdinaryTurnExecution(f.sessions, { ...f.scope, turnId });
      assert.equal(f.db.turns.get(turnId)?.status, "completed");
    }
    assert.equal(executions, 2); assert.equal(sends, 2); assert.equal(fs.existsSync(path.join(directory, "once.txt")), false);
    const entries = fs.readdirSync(path.join(directory, ".codeflowai")).filter(name => name.endsWith(".log")).flatMap(name => fs.readFileSync(path.join(directory, ".codeflowai", name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    assert.equal(entries.length, 1); assert.equal(entries[0].parentRequestId, "ordinary-execute-1"); assert.equal(entries[0].turnId, "execute-turn-1");
    assert.equal(f.operations(), 0); assert.equal(f.responses.filter(response => response.t === "api.res").length, 2);
  } finally { t.mock.restoreAll(); }
});

for (const mode of ["logged", "failed", "stale-release", "notice", "release-diagnostic", "notice-diagnostic"] as const) test(`ordinary public API materialize ${mode} retains exact final owner`, async t => {
  const f = apiFixture(t), directory = f.ctx.workspaces.get(f.scope.workspaceId as any)!;
  f.db.db.prepare("UPDATE threads SET thread_type = 'chat', thread_subtype = NULL WHERE id = ?").run(f.scope.threadId);
  const skill = f.db.orchSkills.upsert({ id: "ordinary-skill" as any, workspaceId: f.scope.workspaceId as any, kind: "custom", name: "Skill😀", description: "测试", trigger: "测试", instructions: "测试", slug: "ordinary-log", targetEngines: ["claude"],
    skillMd: "PRIVATE_SKILL_BODY", files: [{ relPath: "scripts/run.mjs", kind: "script", contentText: "PRIVATE_SCRIPT", sizeBytes: 0, sha256: "" }],
    scripts: [{ id: "run", name: "运行", description: "测试", runtime: "node", scriptPath: "scripts/run.mjs", exposeAsTool: true }] });
  const role = f.db.orchRoles.upsert({ id: "ordinary-role" as any, workspaceId: f.scope.workspaceId as any, kind: "custom", name: "角色", description: "测试", gateCriteria: [], systemPrompt: "角色规则", defaultSkillIds: [skill.id],
    inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(), executionConfig: createDefaultRoleExecutionConfig("claude") });
  f.ctx.orchAssetRuntimeRead = new OrchAssetAuthorityRuntimeReadService(createClientDbOrchAssetLegacyRuntimeReader(f.db, { requireCompleteDefinitions: true }),
    { getAsset: () => { throw new Error("unexpected server read"); }, listAssets: () => [] } as any, { getRuntimeReadinessRequirement: () => null });
  const business = Object.assign(new Error("PRIVATE_SKILL_BODY"), { code: "EIO" }), logging = new Error("workspace-log-root"), release = new Error("operation-release-root"), notification = new Error("notice-root"), diagnostic = new Error("boundary-diagnostic-root");
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (String(args[0]).endsWith(`${path.sep}run.mjs`) && String(args[0]).includes(".building-")) throw business; return write(...args); });
  let logs = 0;
  const workspaceWrite = f.db.writeWorkspaceLog.bind(f.db);
  t.mock.method(f.db, "writeWorkspaceLog", ((workspaceId, entry) => {
    if (entry.tag === "skill-runtime") {
      logs++;
      if (mode === "stale-release") f.db.turns.setEnded(f.scope.turnId as any, { status: "completed", endedAt: Date.now(), endEventSeq: null });
      if (mode !== "logged") throw logging;
    }
    if ((mode === "release-diagnostic" || mode === "notice-diagnostic")
      && (entry.message === "ordinary turn operation release failed" || entry.message === "turn terminal settlement failed; keeping pending retry state")) throw diagnostic;
    return workspaceWrite(workspaceId, entry);
  }) as typeof f.db.writeWorkspaceLog);
  if (mode === "stale-release" || mode === "release-diagnostic") f.rejectRelease(release);
  if (mode === "notice" || mode === "notice-diagnostic") {
    const persist = f.ctx.onBeforeEmitConversationEvent!;
    f.ctx.onBeforeEmitConversationEvent = event => { if (event.type === "turn.error") throw notification; persist(event); };
  }
  await handleApiRequest(f.ctx, { t: "api.req", id: "ordinary-skill-request😀", method: "threads.sendMessage", path: "/send",
    body: { ...f.scope, roleId: role.id, text: "Skill", model: "claude-sonnet-4-6", effort: "medium" } });
  let result: any;
  await assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), (error: any) => { result = error; return true; });
  const failure = mode === "stale-release" || mode === "notice" || mode === "release-diagnostic" || mode === "notice-diagnostic" ? result.errors[0] : result;
  if (mode === "logged") assert.equal(failure.cause, business, String(failure));
  else {
    assert.equal(failure.code, "SKILL_RUNTIME_FAILURE_LOG_FAILED"); assert.equal(failure.errors[0].cause, business);
    assert.equal(failure.errors[1], logging); assert.equal(failure.cause, failure.errors[0]);
  }
  if (mode === "stale-release") { assert.equal(result.errors[1], release); assert.equal(result.cause, failure); }
  if (mode === "notice") { assert.equal(result.errors[1], notification); assert.equal(result.cause, failure); }
  if (mode === "release-diagnostic") { assert.deepEqual(result.errors, [failure, release, diagnostic]); assert.equal(result.cause, failure); }
  if (mode === "notice-diagnostic") { assert.deepEqual(result.errors, [failure, notification, diagnostic]); assert.equal(result.cause, failure); }
  assert.equal(logs, 1); assert.equal(f.operations(), 0);
  assert.equal(f.responses.filter(response => response.t === "api.res").length, 1);
  assert.equal(f.responses.find(response => response.t === "api.res").status, 200);
  assert.equal(fs.existsSync(path.join(directory, ".claude/skills/ordinary-log")), false);
  assert.equal(f.errors.mock.calls.some(call => call.arguments[0] === "skill-runtime"), false);
  await assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), error => error === result);
});

test("普通 API快速受理后仍持有完整尾链和线程operation，等待终态准备及释放", async t => {
  const f = apiFixture(t);
  await f.request();
  assert.equal(f.responses.find(response => response.t === "api.res")?.status, 200);
  await f.entered.promise;
  assert.equal(owners.hasOrdinaryTurnExecutions(f.sessions), true);
  assert.equal(f.operations(), 1);
  f.waitTerminal(true);
  const waiting = owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  f.sending.resolve({ responseText: "完成" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(owners.hasOrdinaryTurnExecutions(f.sessions), true);
  assert.equal(f.operations(), 1);
  f.terminal.resolve();
  await waiting;
  assert.equal(f.operations(), 0);
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "completed");
  assert.equal(owners.hasOrdinaryTurnExecutions(f.sessions), false);
});

for (const failure of [undefined, null, NaN, new Error("PROVIDER_FAILED_AFTER_TERMINAL")]) {
  test(`普通 API在DB已终态后仍把真实发送失败 ${String(failure)} 交给owner`, async t => {
    const f = apiFixture(t);
    await f.request();
    await f.entered.promise;
    const waiting = owners.waitForOrdinaryTurnExecution(f.sessions, f.scope).then(() => ({ ok: true }), error => ({ ok: false, error }));
    f.db.turns.setEnded(f.scope.turnId, { status: "error", endedAt: Date.now(), endEventSeq: null });
    f.threads.clearSessionId(f.scope.threadId);
    f.sending.reject(failure);
    const result = await waiting;
    assert.equal(result.ok, false);
    assert.equal("error" in result && Object.is(result.error, failure), true);
    assert.equal(f.operations(), 0);
  });
}

test("普通API完成终态持久化失败交给owner，不因内部提示伪成功", async t => {
  const f = apiFixture(t), failure = new Error("TERMINAL_PERSISTENCE_FAILED");
  const persist = f.ctx.onBeforeEmitConversationEvent!;
  f.ctx.onBeforeEmitConversationEvent = event => { if (event.type === "turn.completed") throw failure; persist(event); };
  await f.request();
  await f.entered.promise;
  const rejected = assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), error => error === failure);
  f.sending.resolve({ responseText: "完成" });
  await rejected;
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "started");
  assert.equal(f.operations(), 0);
});

test("普通API发送与错误终态持久化双错都保留", async t => {
  const f = apiFixture(t), sending = new Error("SEND_ROOT"), terminal = new Error("TERMINAL_ROOT");
  const persist = f.ctx.onBeforeEmitConversationEvent!;
  f.ctx.onBeforeEmitConversationEvent = event => { if (event.type === "turn.error") throw terminal; persist(event); };
  await f.request();
  await f.entered.promise;
  const rejected = assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [sending, terminal]); return true;
  });
  f.sending.reject(sending);
  await rejected;
  assert.equal(f.operations(), 0);
});

test("普通API发送与线程operation释放双错都交给owner", async t => {
  const f = apiFixture(t), sending = new Error("SEND_OPERATION_ROOT"), cleanup = new Error("OPERATION_RELEASE_ROOT");
  await f.request();
  await f.entered.promise;
  f.rejectRelease(cleanup);
  const rejected = assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [sending, cleanup]); return true;
  });
  f.sending.reject(sending);
  await rejected;
  assert.equal(f.operations(), 0);
});

test("普通API成功后operation释放失败显式拒绝并记录精确上下文", async t => {
  const f = apiFixture(t), cleanup = new Error("SUCCESS_OPERATION_RELEASE_ROOT");
  await f.request();
  await f.entered.promise;
  f.rejectRelease(cleanup);
  const rejected = assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), error => error === cleanup);
  f.sending.resolve({ responseText: "完成" });
  await rejected;
  assert.equal(f.operations(), 0);
  const releaseLogs = f.logs().filter(entry => entry.code === "ORDINARY_TURN_OPERATION_RELEASE_FAILED");
  assert.equal(releaseLogs.length, 1);
  const context = releaseLogs[0]!;
  assert.equal(context.requestId, "ordinary-request");
  assert.equal(context.workspaceId, f.scope.workspaceId);
  assert.equal(context.threadId, f.scope.threadId);
  assert.equal(context.turnId, f.scope.turnId);
  assert.ok(context.rootCause[0].fingerprint);
});

for (const outcome of ["completed", "error", "manual_interrupt"] as const) {
  test(`普通API ${outcome} 终态与提示均失败时保留所有根因`, async t => {
    const f = apiFixture(t), terminal = new Error("TERMINAL_NOTICE_ROOT"), notice = new Error("NOTICE_ROOT");
    const sending = outcome === "manual_interrupt"
      ? Object.assign(new Error("MANUAL_ROOT"), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" })
      : new Error("SEND_NOTICE_ROOT");
    const persist = f.ctx.onBeforeEmitConversationEvent!;
    f.ctx.onBeforeEmitConversationEvent = event => {
      if (event.type === "turn.completed" || event.type === "turn.error") throw terminal;
      if (event.type === "system.notice") throw notice;
      persist(event);
    };
    await f.request();
    await f.entered.promise;
    const rejected = assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, outcome === "completed" ? [terminal, notice] : [sending, terminal, notice]);
      return true;
    });
    if (outcome === "completed") f.sending.resolve({ responseText: "完成" });
    else f.sending.reject(sending);
    await rejected;
    assert.equal(f.operations(), 0);
  });
}

test("普通API会话失效提示失败时保留发送原错误", async t => {
  const f = apiFixture(t), sending = Object.assign(new Error("SESSION_INVALIDATED_ROOT"), { code: "session_invalidated" });
  const notice = new Error("INVALIDATED_NOTICE_ROOT"), persist = f.ctx.onBeforeEmitConversationEvent!;
  f.ctx.onBeforeEmitConversationEvent = event => { if (event.type === "system.notice") throw notice; persist(event); };
  await f.request();
  await f.entered.promise;
  const rejected = assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [sending, notice]); return true;
  });
  f.sending.reject(sending);
  await rejected;
  assert.equal(f.operations(), 0);
});

test("未知provider发送与知识清理双错仍保留running，不伪造错误终态", async t => {
  const sending = Object.assign(new Error("PROVIDER_START_UNKNOWN"), { preserveRunningState: true });
  const cleanup = new Error("KNOWLEDGE_FINISH_FAILED"), c = continuationFixture();
  c.useKnowledge({ finish() { throw cleanup; } });
  c.input.session.sendMessage = async () => { throw sending; };
  c.prepare.resolve([]);
  const failure = await c.run().then(() => assert.fail("未知发送必须拒绝"), error => error as AggregateError & { preserveRunningState?: boolean });
  assert.deepEqual([...failure.errors], [sending, cleanup]);
  assert.equal(failure.preserveRunningState, true);
  const f = apiFixture(t);
  await f.request();
  await f.entered.promise;
  const rejected = assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), error => error === failure);
  f.sending.reject(failure);
  await rejected;
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "started");
  assert.equal(f.responses.some(message => message.t === "conversation.event" && message.event.type === "turn.error"), false);
});

test("未知provider发送与operation释放双错仍保留running分类和原始根因", async t => {
  const f = apiFixture(t), sending = Object.assign(new Error("PROVIDER_RELEASE_UNKNOWN"), { preserveRunningState: true });
  const cleanup = new Error("UNKNOWN_OPERATION_RELEASE_FAILED");
  await f.request();
  await f.entered.promise;
  f.rejectRelease(cleanup);
  const rejected = assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), (error: any) => {
    assert.deepEqual(error.errors, [sending, cleanup]);
    assert.equal(error.preserveRunningState, true);
    return true;
  });
  f.sending.reject(sending);
  await rejected;
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "started");
});

test("Skill输入准备即登记完整owner，精确等待不能提前成功", async t => {
  const f = apiFixture(t), prepare = deferred<any>(), entered = deferred<void>();
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL, thread_type = 'chat', thread_subtype = NULL WHERE id = ?").run(f.scope.threadId);
  f.threads.get(f.scope.threadId)!.engine = "codex";
  (f.session as any).engine = "codex";
  (f.session as any).prepareInputActions = async (input: any) => {
    entered.resolve();
    await prepare.promise;
    return { kind: "codex-skills", reservationId: "reserved", turnId: input.turnId, userItemId: input.userItemId, processGeneration: 1, skills: [] };
  };
  const request = handleApiRequest(f.ctx, { t: "api.req", id: "prepare-owner", method: "threads.sendMessage", path: "/send",
    body: { ...f.scope, text: "$review", inputKind: "message", skillMentions: [{ skillId: `csk_${"a".repeat(43)}`, name: "review", start: 0, end: 7 }] } });
  await entered.promise;
  try {
    assert.deepEqual(owners.listOrdinaryTurnExecutions(f.sessions), [f.scope]);
    await assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope, { timeoutMs: 5 }), { code: "ORDINARY_TURN_EXECUTION_TIMEOUT" });
  } finally {
    f.setPaused(true);
    prepare.resolve(undefined);
    await request;
    f.db.turns.setEnded(f.scope.turnId, { status: "error", endedAt: Date.now(), endEventSeq: null });
    f.threads.clearSessionId(f.scope.threadId);
    await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  }
});

test("Skill准备原拒绝值交给owner，API仍只返回一次失败", async t => {
  const f = apiFixture(t), failure = new Error("SKILL_INPUT_PREPARATION_FAILED");
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL, thread_type = 'chat', thread_subtype = NULL WHERE id = ?").run(f.scope.threadId);
  f.threads.get(f.scope.threadId)!.engine = "codex";
  (f.session as any).prepareInputActions = async () => { throw failure; };
  await handleApiRequest(f.ctx, { t: "api.req", id: "prepare-failure", method: "threads.sendMessage", path: "/send",
    body: { ...f.scope, text: "$review", inputKind: "message", skillMentions: [{ skillId: `csk_${"a".repeat(43)}`, name: "review", start: 0, end: 7 }] } });
  await assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), error => error === failure);
  assert.equal(f.responses.filter(message => message.t === "api.res").length, 1);
  assert.equal(f.responses.find(message => message.t === "api.res")?.status, 400);
  assert.equal(f.operations(), 0);
});

test("普通回合创建session失败仍由准备owner保留原拒绝", async t => {
  const f = apiFixture(t), failure = new Error("SESSION_PREPARATION_FAILED");
  f.sessions.getOrCreate = () => { throw failure; };
  await f.request();
  await assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), error => error === failure);
  assert.equal(f.responses.filter(message => message.t === "api.res").length, 1);
  assert.equal(f.responses.find(message => message.t === "api.res")?.status, 501);
  assert.equal(f.operations(), 0);
});

test("Skill准备后的启动与预留释放双错保留全部原始根因", async t => {
  const f = apiFixture(t), start = new Error("START_EVENT_FAILED"), release = new Error("PREPARED_INPUT_RELEASE_FAILED");
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL, thread_type = 'chat', thread_subtype = NULL WHERE id = ?").run(f.scope.threadId);
  f.threads.get(f.scope.threadId)!.engine = "codex";
  (f.session as any).prepareInputActions = async (input: any) => ({ kind: "codex-skills", reservationId: "reserved", turnId: input.turnId, userItemId: input.userItemId, processGeneration: 1, skills: [] });
  (f.session as any).releasePreparedInputActions = () => { throw release; };
  f.ctx.onBeforeEmitConversationEvent = () => { throw start; };
  await handleApiRequest(f.ctx, { t: "api.req", id: "start-failure", method: "threads.sendMessage", path: "/send",
    body: { ...f.scope, text: "$review", inputKind: "message", skillMentions: [{ skillId: `csk_${"a".repeat(43)}`, name: "review", start: 0, end: 7 }] } });
  await assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope), (error: any) => {
    assert.deepEqual(error.errors, [start, release]); return true;
  });
});

test("Skill准备期间精确停止等待原准备释放，正常取消owner成功收口", async t => {
  const f = apiFixture(t), prepare = deferred<void>(), entered = deferred<void>();
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL, thread_type = 'chat', thread_subtype = NULL WHERE id = ?").run(f.scope.threadId);
  f.threads.get(f.scope.threadId)!.engine = "codex";
  (f.session as any).engine = "codex";
  f.sessions.interrupt = async () => false;
  let releases = 0, sends = 0;
  (f.session as any).releasePreparedInputActions = () => { releases++; };
  (f.session as any).prepareInputActions = async (input: any) => {
    entered.resolve(); await prepare.promise;
    return { kind: "codex-skills", reservationId: "reserved", turnId: input.turnId, userItemId: input.userItemId, processGeneration: 1, skills: [] };
  };
  f.session.sendMessage = async () => { sends++; return { responseText: "禁止迟到发送" }; };
  const request = handleApiRequest(f.ctx, { t: "api.req", id: "prepare-cancel", method: "threads.sendMessage", path: "/send",
    body: { ...f.scope, text: "$review", inputKind: "message", skillMentions: [{ skillId: `csk_${"a".repeat(43)}`, name: "review", start: 0, end: 7 }] } });
  await entered.promise;
  await handleApiRequest(f.ctx, { t: "api.req", id: "stop-preparing", method: "turns.interrupt", path: "/stop", body: f.scope });
  try {
    await assert.rejects(owners.waitForOrdinaryTurnExecution(f.sessions, f.scope, { timeoutMs: 5 }), { code: "ORDINARY_TURN_EXECUTION_TIMEOUT" });
  } finally { prepare.resolve(); await request; }
  await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  assert.equal(releases, 1);
  assert.equal(sends, 0);
  assert.equal(f.operations(), 0);
  const response = f.responses.filter(message => message.t === "api.res" && message.id === "prepare-cancel");
  assert.equal(response.length, 1);
  assert.equal(response[0].status, 409);
});

test("普通Codex已受理但尚未派发时精确停止，不要求不存在的provider身份", async t => {
  const f = apiFixture(t);
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL WHERE id = ?").run(f.scope.threadId);
  f.threads.get(f.scope.threadId)!.engine = "codex";
  (f.session as any).engine = "codex";
  f.sessions.interrupt = async () => false;
  let sends = 0;
  f.session.sendMessage = async () => { sends++; return await f.sending.promise; };
  const send = f.ctx.send;
  f.ctx.send = message => {
    if (message.t === "api.res" && message.id === "before-dispatch") f.setPaused(true);
    return send(message);
  };
  await handleApiRequest(f.ctx, { t: "api.req", id: "before-dispatch", method: "threads.sendMessage", path: "/send", body: { ...f.scope, text: "停止准备中的回合" } });
  try {
    await handleApiRequest(f.ctx, { t: "api.req", id: "stop-before-dispatch", method: "turns.interrupt", path: "/stop", body: f.scope });
    assert.equal(f.responses.find(message => message.t === "api.res" && message.id === "stop-before-dispatch")?.status, 200);
    await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
    assert.equal(f.db.turns.get(f.scope.turnId)?.status, "error");
    assert.equal(sends, 0);
    assert.equal(f.operations(), 0);
  } finally {
    f.db.turns.setEnded(f.scope.turnId, { status: "error", endedAt: Date.now(), endEventSeq: null });
    f.threads.clearSessionId(f.scope.threadId);
    f.setPaused(false);
    f.sending.resolve({ responseText: "停止后禁止发送" });
    await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  }
});

test("普通Codex已派发的owner不能证明本地取消，缺provider身份仍显式失败", async t => {
  const f = apiFixture(t);
  f.db.db.prepare("UPDATE threads SET engine = 'codex', model = NULL, effort = NULL WHERE id = ?").run(f.scope.threadId);
  f.threads.get(f.scope.threadId)!.engine = "codex";
  (f.session as any).engine = "codex";
  f.sessions.interrupt = async () => false;
  await handleApiRequest(f.ctx, { t: "api.req", id: "dispatched", method: "threads.sendMessage", path: "/send", body: { ...f.scope, text: "真实派发" } });
  await f.entered.promise;
  try {
    await handleApiRequest(f.ctx, { t: "api.req", id: "stop-dispatched", method: "turns.interrupt", path: "/stop", body: f.scope });
    assert.equal(f.responses.find(message => message.t === "api.res" && message.id === "stop-dispatched")?.status, 500);
    assert.equal(f.db.turns.get(f.scope.turnId)?.status, "started");
    assert.equal(owners.hasOrdinaryTurnExecutions(f.sessions), true);
  } finally {
    f.db.turns.setEnded(f.scope.turnId, { status: "error", endedAt: Date.now(), endEventSeq: null });
    f.threads.clearSessionId(f.scope.threadId);
    f.sending.resolve({ responseText: "外部已确认终态" });
    await owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  }
});

test("真实provider正常手动中断由原终态成功收口，不阻止更新等待", async t => {
  const f = apiFixture(t);
  await f.request();
  await f.entered.promise;
  const waiting = owners.waitForOrdinaryTurnExecution(f.sessions, f.scope);
  f.sending.reject(Object.assign(new Error("turn interrupted"), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" }));
  await waiting;
  assert.equal(f.db.turns.get(f.scope.turnId)?.status, "error");
  assert.equal(f.operations(), 0);
});
