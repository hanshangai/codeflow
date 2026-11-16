import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { resolveSharedWorkspaceEffectiveOperationPolicy, type DesktopApiRequest, type ClientToServerMessage, type WorkspaceId, type ThreadId, type SharedWorkspaceId, type SharedWorkspaceCommandEnvelope } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { handleThreadsUpdatePrefs } from "../src/app/handlers/threadHandlers.js";
import { createDesktopLifecycle, readDesktopClientHealth } from "../src/runtime/desktopLifecycle.js";
import { logger } from "../src/logger.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { CodexAppServerThreadSession } from "../src/engines/codex-app-server/codexAppServerThreadSession.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";
import { getPendingTurnTerminalFailure } from "../src/app/turnInterrupt.js";
import { createLocalEventPipeline } from "../src/runtime/localEventPersistence.js";
import { waitForOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.js";
import { handleSharedWorkspaceCommand } from "../src/app/handlers/sharedWorkspaceHandlers.js";

/** 独占 SQLite 与工作区，运行请求不得触及日常数据或实际 provider。 */
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-execution-api-"));
  const application = openClientDb({ dbPath: path.join(directory, "client.db") });
  const workspaceId = "local-client:workspace" as WorkspaceId;
  application.workspaces.upsert({ id: workspaceId, title: "Local", path: directory });
  const db = application.forWorkspace(workspaceId);
  initializeLocalEngineModelCatalog();
  t.after(() => { resetEngineModelCatalogRuntimeForTest(); application.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  const sent: ClientToServerMessage[] = [];
  const ctx = { db, clientId: "local-client", workspaces: new Map([[workspaceId, directory]]), threads: new ThreadStore(),
    sessions: { beginThreadOperation: () => () => {}, hasActiveTurn: () => false, getExisting: () => null, listActiveTurns: () => [] },
    send: (message: ClientToServerMessage) => { sent.push(message); } } as ApiHandlerContext;
  let sequence = 0;
  return { db, ctx, sent, workspaceId,
    /** 经真实适配器和唯一 API 处理器运行，每个请求有独立关联 ID。 */
    call(method: string, body: Record<string, unknown>) {
      return executeDesktopApiRequest(ctx, { method, body } as DesktopApiRequest, { requestId: `execution-${++sequence}`, startedAt: 1, clientVersion: "1.0.0" });
    },
  };
}

test("桌面请求在真实Writer准入下完成参数校验、历史快照与拒绝诊断", async t => {
  const f = fixture(t), threadId = "writer-desktop" as ThreadId;
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "claude", title: "Writer guard" });
  const writer = new ClientDbWriterService({ db: f.db, dbPath: path.join(f.ctx.workspaces.get(f.workspaceId)!, "client.db"), onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    f.ctx.withDatabase = (id, operation) => writer.withLegacyDatabase(id, operation);
    assert.equal((await f.call("threads.load", { workspaceId: f.workspaceId, threadId })).status, 200);
    assert.equal((await f.call("threads.rename", { workspaceId: f.workspaceId, threadId, title: "许可内更名" })).status, 200);
    assert.equal((await f.call("threads.load", { workspaceId: f.workspaceId, threadId, injected: true })).status, 400);
    assert.equal((await f.call("quickPhrases.list", {})).status, 200);
    assert.equal((await f.call("workspaces.list", {})).status, 200);
    assert.equal((await f.call("workspacePrefs.save", { workspaceId: f.workspaceId, prefs: [{ engine: "claude", workMode: "general" }] })).status, 200);
    assert.equal((await f.call("workspacePrefs.get", { workspaceId: f.workspaceId })).status, 200);
    assert.equal((await f.call("workspaceExecutionProfile.update", { workspaceId: f.workspaceId, profileText: "执行校验" })).status, 200);
    assert.equal((await f.call("workspaceExecutionProfile.get", { workspaceId: f.workspaceId })).status, 200);
    assert.equal((await f.call("workspaceExecutionProfile.status", { workspaceId: f.workspaceId })).status, 200);
    assert.equal((await f.call("git.diff", { workspaceId: f.workspaceId, path: "../outside" })).status, 400);
    assert.equal((await f.call("orch.assetDraftJobs.list", { workspaceId: f.workspaceId })).status, 200);
    assert.equal((await f.call("orch.assetDraftJobs.get", { workspaceId: f.workspaceId, jobId: "missing" })).status, 404);
    for (const method of ["orch.assetDrafts.get", "orch.assetDrafts.apply", "orch.assetDrafts.reject"] as const) {
      assert.equal((await f.call(method, { workspaceId: f.workspaceId, draftId: "missing" })).status, 404);
    }
  } finally { await writer.close(); }
});

test("桌面停止在draining首响应时返回，真实Writer尾链失败仍由原owner跟踪", async t => {
  const f = fixture(t), threadId = "desktop-stop" as ThreadId, turnId = "desktop-stop-turn" as any;
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: "停止准入" });
  f.db.turns.insertStarted({ threadId, workspaceId: f.workspaceId, engine: "codex", turnId, startedAt: 1, startEventSeq: 1 });
  let release!: () => void, confirm!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const confirmed = new Promise<void>(resolve => { confirm = resolve; });
  let tail: Promise<void> | null = null, responseWork: Promise<any> | null = null, returned = false;
  (f.ctx.sessions as any).interrupt = async (_threadId: string, _turnId: string, options: { onStopConfirmed?: () => void }) => {
    options.onStopConfirmed?.(); confirm(); await pending; return true;
  };
  f.ctx.onBeforeEmitConversationEvent = () => { throw new Error("DESKTOP_STOP_SAVE_FAILED"); };
  f.ctx.orchEngine = { forWorkspace() { return this; } } as any;
  f.ctx.getTurnFinalizationFailure = scope => getPendingTurnTerminalFailure(scope);
  f.ctx.trackApiTail = (work, context) => {
    assert.equal(context.threadId, threadId); tail = work;
    void work.then(() => assert.fail("尾链应明确失败"), () => {});
  };
  const writer = new ClientDbWriterService({ db: f.db, dbPath: path.join(f.ctx.workspaces.get(f.workspaceId)!, "client.db"), onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    f.ctx.withDatabase = (id, operation) => writer.withLegacyDatabase(id, operation);
    responseWork = f.call("turns.interrupt", { workspaceId: f.workspaceId, threadId, turnId }).then(response => { returned = true; return response; });
    void responseWork.then(() => {}, () => {});
    await confirmed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, true, "桌面IPC不应等待保存尾链");
    assert.equal((await responseWork).body.phase, "draining");
    assert.ok(tail);
    release();
    await assert.rejects(tail, /TURN_INTERRUPT_FINALIZATION_FAILED/);
    assert.ok(getPendingTurnTerminalFailure({ workspaceId: f.workspaceId, threadId }));
    const summary = await f.call("threads.summary", { workspaceId: f.workspaceId, threadId });
    assert.equal((summary.body as any).running?.phase, "failed");
    assert.equal(f.sent.some(message => message.t === "api.res"), false, "尾链不能向云端补发第二个API响应");
  } finally { release(); await responseWork?.then(() => {}, () => {}); await tail?.then(() => {}, () => {}); await writer.close(); }
});

for (const transport of ["desktop", "central", "shared"] as const) {
  test(`${transport}持久化已失败仍停止provider并暴露保存失败，业务读取保持屏障`, async t => {
    const f = fixture(t), threadId = `failed-save-${transport}` as ThreadId, turnId = `failed-save-turn-${transport}` as any;
    const sharedWorkspaceId = "shared-stop" as SharedWorkspaceId;
    f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: "故障后停止",
      ...(transport === "shared" ? { sharedAcl: { sharedWorkspaceId, ownerUserId: "owner" } } : {}) });
    f.db.turns.insertStarted({ threadId, workspaceId: f.workspaceId, engine: "codex", turnId, startedAt: 1, startEventSeq: 1 });
    const writer = new ClientDbWriterService({ db: f.db, dbPath: path.join(f.ctx.workspaces.get(f.workspaceId)!, "client.db"),
      onFatalError(error) { assert.fail(error); } });
    const failures: unknown[] = [];
    const pipeline = createLocalEventPipeline({ writer, apply() { throw new Error("TEST_PERSISTENCE_INDEX_FAILED"); },
      publish() { assert.fail("失败索引不得发布"); }, onFailure(error) { failures.push(error); } });
    let stopped = 0, tail: Promise<void> | undefined;
    Object.assign(f.ctx, {
      withDatabase: (id: string, operation: () => unknown) => writer.withLegacyDatabase(id, operation),
      assertWorkspacePersistenceAvailable: (workspaceId: string) => pipeline.assertNoFailure(workspaceId),
      flushLocalEvents: (workspaceId: string, id?: string) => pipeline.flush(workspaceId, id),
      getTurnFinalizationFailure: getPendingTurnTerminalFailure,
      onBeforeEmitConversationEvent: (event: any) => pipeline.enqueue({ t: "conversation.event", event }, turnId, 1),
      trackApiTail(work: Promise<void>) { tail = work; void work.then(() => assert.fail("保存尾链应失败"), () => {}); },
    });
    (f.ctx.sessions as any).interrupt = async (_threadId: string, _turnId: string, options: { onStopConfirmed?: () => void }) => {
      stopped++; options.onStopConfirmed?.(); return true;
    };
    /** 中央入口保留原响应与尾链失败，不能把draining误当保存成功。 */
    const centralCall = async (method: string, body: Record<string, unknown>) => {
      const offset = f.sent.length;
      await handleApiRequest(f.ctx, { t: "api.req", id: `${transport}-${method}`, method, path: "/test", body } as any);
      return f.sent.slice(offset).find(message => message.t === "api.res") as Extract<ClientToServerMessage, { t: "api.res" }>;
    };
    /** 复用Server实际共享封套，验证外层scope和内部API/详情双重边界。 */
    const sharedCall = async (operationKey: "context.thread.interrupt" | "context.detail.read", payload: Record<string, unknown>) => {
      const offset = f.sent.length;
      await handleSharedWorkspaceCommand(f.ctx, { sharedWorkspaceId, actorUserId: "owner", hostUserId: "owner",
        hostBindingId: "binding", routeEventId: operationKey, localWorkspaceId: f.workspaceId, operationId: operationKey,
        operationKey, policy: resolveSharedWorkspaceEffectiveOperationPolicy(operationKey, payload)!,
        authorization: { actorAssetRole: "enterprise_admin", authorizationResult: "allowed", authorizationReason: "test" },
        lockToken: "lock", lockVersion: 1, payload, createdAt: Date.now() } as SharedWorkspaceCommandEnvelope);
      return (f.sent.slice(offset).find((message: any) => message.t === "sharedWorkspace.route.result") as any).message;
    };
    try {
      await writer.ready();
      pipeline.enqueue({ t: "conversation.event", event: { ts: 1, workspaceId: f.workspaceId, threadId, engine: "codex",
        type: "item.assistantText.delta", payload: { turnId, itemId: "pending", delta: "未完成输出" } } }, turnId, 1);
      await assert.rejects(pipeline.flush(f.workspaceId, threadId), /TEST_PERSISTENCE_INDEX_FAILED/);
      assert.equal(failures.length, 1);
      assert.throws(() => pipeline.assertNoFailure(f.workspaceId), /TEST_PERSISTENCE_INDEX_FAILED/);
      const body = { workspaceId: f.workspaceId, threadId, turnId };
      if (transport === "desktop") {
        const response = await f.call("turns.interrupt", body);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.phase, "draining");
      } else if (transport === "central") {
        await assert.rejects(centralCall("turns.interrupt", body), /TURN_INTERRUPT_FINALIZATION_FAILED/);
      } else {
        const response = await sharedCall("context.thread.interrupt", body);
        assert.equal(response.status, "succeeded", JSON.stringify(response));
        assert.equal(response.result.phase, "draining");
      }
      assert.equal(stopped, 1, "持久化失败不能阻止provider停止");
      if (transport !== "central") {
        assert.ok(tail);
        await assert.rejects(tail, /TURN_INTERRUPT_FINALIZATION_FAILED/);
      }
      const viewBody = { workspaceId: f.workspaceId, threadId };
      const summary = transport === "desktop" ? await f.call("threads.summary", viewBody) : await centralCall("threads.summary", viewBody);
      assert.equal(summary.status, 200);
      assert.equal((summary.body as any).running?.phase, "failed");
      if (transport === "shared") {
        const sharedSummary = await sharedCall("context.detail.read", { resourceType: "thread", resourceId: threadId, includeEvents: false, limit: 1 });
        assert.equal(sharedSummary.status, "succeeded", JSON.stringify(sharedSummary));
        assert.equal(sharedSummary.result.running?.phase, "failed");
        for (const detail of [{ includeEvents: true }, { includeEvents: false, detailMode: "presentation" }, { includeEvents: false, includeDraft: true }]) {
          const history = await sharedCall("context.detail.read", { resourceType: "thread", resourceId: threadId, ...detail });
          assert.equal(history.status, "failed", "共享正文与草稿读取不能绕过屏障");
        }
      }
      assert.equal(await writer.withLegacyDatabase("verify-no-false-terminal", () => f.db.turns.get(turnId)?.status), "started");
      if (transport === "desktop") await assert.rejects(f.call("threads.load", viewBody), /TEST_PERSISTENCE_INDEX_FAILED/);
      else assert.equal((await centralCall("threads.load", viewBody)).status, 500, "业务历史读取不能绕过未索引屏障");
    } finally {
      await tail?.then(() => {}, () => {});
      await assert.rejects(pipeline.close(), /TEST_PERSISTENCE_INDEX_FAILED/);
      await assert.rejects(writer.close(), /TEST_PERSISTENCE_INDEX_FAILED/);
    }
  });
}

test("桌面普通发送沿真实Writer提交启动与终态，provider等待不持数据库许可", async t => {
  const f = fixture(t), threadId = "desktop-writer-send" as ThreadId, turnId = "desktop-writer-turn" as any;
  const scope = { workspaceId: f.workspaceId, threadId, turnId };
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "claude", title: "普通发送" });
  const failures: unknown[] = [];
  const writer = new ClientDbWriterService({ db: f.db, dbPath: path.join(f.ctx.workspaces.get(f.workspaceId)!, "client.db"), onFatalError(error) { failures.push(error); } });
  let active = false;
  const pipeline = createLocalEventPipeline({ writer, apply(message) {
    if (message.t !== "conversation.event") return;
    const event = message.event;
    if (event.type === "turn.started") {
      active = true;
      f.db.turns.insertStarted({ ...scope, engine: "claude", startedAt: event.ts, startEventSeq: event.seq });
    }
    if (event.type === "turn.completed" || event.type === "turn.error") {
      active = false;
      f.db.turns.setEnded(turnId, { status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: event.seq });
    }
  }, publish() {}, onFailure(error) { failures.push(error); } });
  const session = { engine: "claude", resolvePlatformToolTransport: () => "native-dynamic", hasActiveTurn: () => false,
    async sendMessage(_input: unknown, sink: any) {
      assert.throws(() => f.db.turns.get(turnId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/);
      sink.conversation({ ts: Date.now(), ...scope, engine: "claude", type: "item.assistantText.delta", payload: { turnId, itemId: "assistant", delta: "完成" } });
      await sink.flush();
      return { responseText: "完成" };
    },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
  };
  Object.assign(f.ctx.sessions, { getOrCreate: () => session, getActiveTurnId: () => null });
  f.ctx.orchEngine = { forWorkspace() { return this; }, buildManagedServiceToolRegistry: () => null } as any;
  f.ctx.timeoutPolicy = { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 };
  f.ctx.withDatabase = (id, operation) => writer.withLegacyDatabase(id, operation);
  f.ctx.flushLocalEvents = (workspaceId, id) => pipeline.flush(workspaceId, id);
  f.ctx.getActiveThreadTurn = () => active ? { turnId, startedAt: 1 } : null;
  f.ctx.clearActiveThreadTurn = () => { active = false; };
  f.ctx.onBeforeEmitConversationEvent = event => pipeline.enqueue({ t: "conversation.event", event }, turnId, 1);
  try {
    await writer.ready();
    const response = await f.call("threads.sendMessage", { ...scope, text: "写入验证", model: "claude-sonnet-4-6", effort: "medium" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await waitForOrdinaryTurnExecution(f.ctx.sessions, scope);
    assert.equal(await writer.withLegacyDatabase("verify-desktop-send", () => f.db.turns.get(turnId)?.status), "completed");
    assert.deepEqual(failures, []);
  } finally { try { await pipeline.close(); } finally { await writer.close(); } }
});

test("Codex工具传输解析在Writer许可内读取引擎凭据", async t => {
  const f = fixture(t), threadId = "desktop-codex-tool-transport" as ThreadId, turnId = "desktop-codex-tool-turn" as any;
  const scope = { workspaceId: f.workspaceId, threadId, turnId };
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: "工具传输" });
  const failures: unknown[] = [];
  const writer = new ClientDbWriterService({ db: f.db, dbPath: path.join(f.ctx.workspaces.get(f.workspaceId)!, "client.db"), onFatalError(error) { failures.push(error); } });
  let active = false;
  const pipeline = createLocalEventPipeline({ writer, apply(message) {
    if (message.t !== "conversation.event") return;
    const event = message.event;
    if (event.type === "turn.started") {
      active = true;
      f.db.turns.insertStarted({ ...scope, engine: "codex", startedAt: event.ts, startEventSeq: event.seq });
    }
    if (event.type === "turn.completed" || event.type === "turn.error") {
      active = false;
      f.db.turns.setEnded(turnId, { status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: event.seq });
    }
  }, publish() {}, onFailure(error) { failures.push(error); } });
  let transportResolved = false;
  const session = { engine: "codex",
    /** Codex 无凭据租约时会读取引擎 Key 表；必须处于 Writer 同步许可内。 */
    resolvePlatformToolTransport() {
      f.db.engineKeys.list();
      transportResolved = true;
      return "native-dynamic";
    },
    hasActiveTurn: () => false,
    async sendMessage(_input: unknown, sink: any) {
      sink.conversation({ ts: Date.now(), ...scope, engine: "codex", type: "item.assistantText.delta", payload: { turnId, itemId: "assistant", delta: "完成" } });
      await sink.flush();
      return { responseText: "完成" };
    },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
  };
  Object.assign(f.ctx.sessions, { getOrCreate: () => session, getActiveTurnId: () => null });
  f.ctx.orchEngine = { forWorkspace() { return this; }, buildManagedServiceToolRegistry: () => null } as any;
  f.ctx.timeoutPolicy = { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 };
  f.ctx.withDatabase = (id, operation) => writer.withLegacyDatabase(id, operation);
  f.ctx.flushLocalEvents = (workspaceId, id) => pipeline.flush(workspaceId, id);
  f.ctx.getActiveThreadTurn = () => active ? { turnId, startedAt: 1 } : null;
  f.ctx.clearActiveThreadTurn = () => { active = false; };
  f.ctx.onBeforeEmitConversationEvent = event => pipeline.enqueue({ t: "conversation.event", event }, turnId, 1);
  try {
    await writer.ready();
    const response = await f.call("threads.sendMessage", { ...scope, text: "工具传输", model: "gpt-6.1-sol", effort: "high" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await waitForOrdinaryTurnExecution(f.ctx.sessions, scope);
    assert.equal(transportResolved, true);
    assert.equal(await writer.withLegacyDatabase("verify-codex-tool-transport", () => f.db.turns.get(turnId)?.status), "completed");
    assert.deepEqual(failures, []);
  } finally { try { await pipeline.close(); } finally { await writer.close(); } }
});

/** 真实父通道串联 lifecycle 和 adapter，保留原业务处理与 SQLite 读取。 */
async function lifecycleFixture(t: test.TestContext, f: ReturnType<typeof fixture>) {
  const responses = new Map<string, (response: any) => void>();
  const channel = Object.assign(new EventEmitter(), { send(message: any, callback: (error: Error | null) => void) {
    if (message.t === "desktop.api.res") responses.get(message.id)!(message.response);
    callback(null);
  } });
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected lifecycle failure") });
  await lifecycle.ready(() => assert.fail("business failure must remain isolated"), () => readDesktopClientHealth(f.db.applicationDb, "1.0.0"),
    (request, requestId) => executeDesktopApiRequest(f.ctx, request, { requestId, startedAt: 1, clientVersion: "1.0.0" }));
  t.after(() => lifecycle.drainRequests());
  return {
    /** 以指定关联 ID 发送真实 IPC 请求并等原响应。 */
    call(id: string, method: string, body: Record<string, unknown>): Promise<any> {
      return new Promise(resolve => {
        responses.set(id, resolve);
        channel.emit("message", { t: "desktop.api.req", requestId: "parent", id, request: { method, body } });
      });
    },
  };
}

/** 同时观察应用拒绝与固定 W owner 写入；仍执行真实 writer 验证落盘与单次记录。 */
function observeWorkspaceDiagnostics(t: test.TestContext, f: ReturnType<typeof fixture>, logs: any[][]): void {
  const write = f.db.writeWorkspaceLog;
  t.mock.method(f.db, "writeWorkspaceLog", (workspaceId, entry) => {
    write(workspaceId, entry);
    logs.push([entry.tag, entry.message, entry.data]);
  });
}

test("desktop lifecycle logs each adapter rejection and ordinary handler failure once", async t => {
  const f = fixture(t), lifecycle = await lifecycleFixture(t, f), logs: any[][] = [];
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  observeWorkspaceDiagnostics(t, f, logs);
  assert.equal((await lifecycle.call("foreign-request", "orch.instances.pause", { workspaceId: "foreign:workspace", instanceId: "missing" })).status, 400);
  assert.equal(logs.filter(log => log[2]?.requestId === "foreign-request").length, 1);
  assert.equal((await lifecycle.call("missing-request", "orch.instances.pause", { workspaceId: f.workspaceId, instanceId: "missing" })).status, 404);
  const missingLogs = logs.filter(log => log[2]?.requestId === "missing-request");
  assert.equal(missingLogs.length, 1);
  assert.equal(missingLogs[0]![2].instanceId, "missing");
  assert.equal(missingLogs[0]![2].workspaceId, f.workspaceId);
  assert.equal(missingLogs[0]![2].rootCause.type, "object");
  assert.match(missingLogs[0]![2].rootCause.fingerprint, /^[a-f0-9]{64}$/);
});

test("desktop corrupt proposal keeps the original API translation and one complete owner diagnostic", async t => {
  const f = fixture(t), lifecycle = await lifecycleFixture(t, f), logs: any[][] = [];
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  observeWorkspaceDiagnostics(t, f, logs);
  const workflow = f.db.orchWorkflows.upsert({ workspaceId: f.workspaceId, name: "Flow", description: "Flow", nodes: [], edges: [], version: 1 });
  const intake = f.db.orchIntakes.create({ workspaceId: f.workspaceId, title: "本机需求", goal: "目标", triggerMode: "manual", taskType: "feature", workspaceScope: { scopeType: "local_workspace", scopeId: f.workspaceId } });
  const proposal = f.db.orchProposals.create({ workspaceId: f.workspaceId, intakeId: intake.id, intakeSnapshot: intake, draftWorkflow: workflow, status: "draft",
    recommendedFamily: "custom", rationale: "本机测试", draftRoleBindings: [], draftKnowledgeBindings: [], requiresConfirmation: true } as any);
  f.db.db.prepare("UPDATE orch_proposals SET proposal_json = json_set(proposal_json, '$.intakeSnapshot.workspaceId', ?) WHERE id = ?").run("foreign:workspace", proposal.id);
  const direct: ClientToServerMessage[] = [];
  await handleApiRequest({ ...f.ctx, localWorkspaceOnly: true, intakeWorkspaceScope: intake.workspaceScope!, send: message => { direct.push(message); } },
    { t: "api.req", id: "direct-corrupt", method: "orch.proposals.get", path: "/test", body: { workspaceId: f.workspaceId, proposalId: proposal.id } });
  const expected = direct.find(message => message.t === "api.res") as Extract<ClientToServerMessage, { t: "api.res" }>;
  const response = await lifecycle.call("desktop-corrupt", "orch.proposals.get", { workspaceId: f.workspaceId, proposalId: proposal.id });
  assert.deepEqual(response, { status: expected.status, body: expected.body });
  assert.equal(response.status, 500);
  assert.equal(response.body.code, "INTERNAL_ERROR");
  const diagnostics = logs.filter(log => log[2]?.requestId === "desktop-corrupt");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]![0], "orch-api");
  assert.deepEqual(Object.fromEntries(["errorCode", "workspaceId", "proposalId", "intakeId", "field", "reason"].map(key => [key, diagnostics[0]![2][key]])),
    { errorCode: "ORCH_PROPOSAL_SCOPE_INVALID", workspaceId: f.workspaceId, proposalId: proposal.id, intakeId: intake.id, field: "proposal_json.intakeSnapshot", reason: "intake_identity_mismatch" });
  assert.equal((await lifecycle.call("after-corrupt", "orch.proposals.list", { workspaceId: f.workspaceId, summaryOnly: true })).status, 500);
  assert.equal((await lifecycle.call("still-usable", "runtime.info", {})).status, 200);
});

for (const kind of ["ra", "node"] as const) {
  test(`desktop corrupt ${kind} thread authority reaches the central owner before every accepted action`, async t => {
    const f = fixture(t), lifecycle = await lifecycleFixture(t, f), logs: any[][] = [];
    const created = await f.call("threads.create", { workspaceId: f.workspaceId, engine: "codex", title: "需求分析", threadSubtype: "requirement-analysis" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const threadId = kind === "ra" ? (created.body as any).threadId as ThreadId : "corrupt-node" as ThreadId;
    let instanceId: string | null = null;
    if (kind === "ra") {
      f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = ?").run("{", threadId);
    } else {
      const workflow = f.db.orchWorkflows.upsert({ workspaceId: f.workspaceId, name: "Flow", description: "Flow", nodes: [{ id: "node", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [], version: 1 } as any);
      const intake = f.db.orchIntakes.create({ workspaceId: f.workspaceId, title: "本机需求", goal: "目标", triggerMode: "manual", taskType: "feature", workspaceScope: { scopeType: "local_workspace", scopeId: f.workspaceId } });
      const instance = f.db.orchInstances.create({ workspaceId: f.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
      instanceId = instance.id;
      f.db.orchInstances.updateNodeStates(instance.id, { ...instance.nodeStates, node: { ...instance.nodeStates.node!, threadId } });
      f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: "节点", threadType: "orchestration", threadSubtype: "node" });
      f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = json_set(intake_snapshot_json, '$.workspaceId', ?) WHERE id = ?").run("foreign:workspace", instance.id);
    }
    const turnId = `${kind}-authority-turn` as any;
    f.db.turns.insertStarted({ workspaceId: f.workspaceId, threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: 1 });
    const before = f.db.threads.get(threadId);
    let operationStarted = 0, workspaceWriteStarted = 0, providerStarted = 0;
    f.ctx.sessions = { beginThreadOperation() { operationStarted += 1; return () => {}; }, getOrCreate() { providerStarted += 1; throw new Error("authority must fail first"); } } as any;
    f.ctx.workspaceOperationGate = { beginWrite() { workspaceWriteStarted += 1; return () => {}; } } as any;
    t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
    t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
    observeWorkspaceDiagnostics(t, f, logs);
    const actions: Array<[string, Record<string, unknown>]> = [
      ["threads.rename", { title: "不应写入" }], ["threads.archive", { archived: true }], ["threads.delete", {}],
      ["threads.draft.get", {}], ["threads.draft.save", { draft: { text: "不应保存", images: [], files: [] } }], ["threads.draft.clear", {}],
      ["threads.queue.list", {}], ["threads.queue.append", { text: "不应入队", sendOptions: {} }], ["threads.queue.pause", {}],
      ["threads.queue.move", {}], ["threads.queue.remove", {}], ["threads.queue.clear", {}], ["threads.queue.resume", {}],
      ["threads.load", {}], ["threads.events", {}], ["threads.summary", {}], ["threads.prefs", {}],
      ["threads.latestPrefs", { engine: "codex" }],
      ["threads.updatePrefs", { prefs: { planMode: true } }], ["threads.sendMessage", { text: "不应发送" }],
      ["approvals.respond", { requestId: 7, decision: "accept" }], ["userInput.respond", { requestId: 8, answers: {} }],
      ["turns.interrupt", { turnId }],
    ];
    for (const [index, [method, body]] of actions.entries()) {
      const requestId = `${kind}-authority-${index}`;
      const response = await lifecycle.call(requestId, method, { workspaceId: f.workspaceId, threadId, ...body });
      assert.equal(response.status, 500, method);
      assert.equal(response.body.code, "INTERNAL_ERROR", method);
      const owned = logs.filter(log => log[2]?.requestId === requestId);
      assert.equal(owned.length, 1, method);
      assert.equal(owned[0]![0], "orch-api");
      assert.equal(owned[0]![2].workspaceId, f.workspaceId);
      assert.equal(owned[0]![2].errorCode, kind === "ra" ? "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID" : "ORCH_INSTANCE_SCOPE_INVALID");
      if (kind === "ra") {
        assert.equal(owned[0]![2].sessionId, threadId);
        assert.equal(owned[0]![2].rootCause.type, "object");
        assert.match(owned[0]![2].rootCause.fingerprint, /^[a-f0-9]{64}$/);
      } else {
        assert.equal(owned[0]![2].instanceId, instanceId);
        assert.equal(owned[0]![2].field, "intake_snapshot_json");
        assert.equal(owned[0]![2].reason, "intake_identity_mismatch");
      }
    }
    assert.equal(operationStarted, 0);
    assert.equal(workspaceWriteStarted, 0);
    assert.equal(providerStarted, 0);
    assert.deepEqual(f.db.threads.get(threadId), before);
    assert.deepEqual(f.db.db.prepare("SELECT id FROM thread_message_queue").all(), []);
    assert.equal((await lifecycle.call(`${kind}-still-usable`, "runtime.info", {})).status, 200);
  });
}

test("desktop keeps one owner log for user input failure and fills an unsupported approval diagnostic", async t => {
  const f = fixture(t), lifecycle = await lifecycleFixture(t, f), logs: any[][] = [], threadId = "interaction" as ThreadId;
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: "交互" });
  f.ctx.sessions = { beginThreadOperation: () => () => {}, getOrCreate: () => ({ async respondUserInput() { throw new Error("controlled provider failure"); } }) } as any;
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  observeWorkspaceDiagnostics(t, f, logs);
  assert.equal((await lifecycle.call("input-failure", "userInput.respond", { workspaceId: f.workspaceId, threadId, requestId: 7, answers: {} })).status, 500);
  const inputLogs = logs.filter(log => log[2]?.requestId === "input-failure");
  assert.equal(inputLogs.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(inputLogs[0]![0], "userInput");
  assert.equal(inputLogs[0]![2].providerRequestId, 7);
  assert.equal(inputLogs[0]![2].workspaceId, f.workspaceId);
  assert.equal(inputLogs[0]![2].threadId, threadId);
  assert.match(inputLogs[0]![2].rootCause.fingerprint, /^[a-f0-9]{64}$/);
  logs.length = 0;
  assert.equal((await lifecycle.call("unsupported-approval", "approvals.respond", { workspaceId: f.workspaceId, threadId, requestId: 8, decision: "accept" })).status, 501);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![2].requestId, "unsupported-approval");
  assert.equal(logs[0]![2].threadId, threadId);
  assert.equal(logs[0]![2].status, 501);
});

test("desktop file IO and key mutation failures keep one original owner log", async t => {
  const f = fixture(t), lifecycle = await lifecycleFixture(t, f), logs: any[][] = [];
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  observeWorkspaceDiagnostics(t, f, logs);
  assert.equal((await lifecycle.call("missing-file", "fs.readFile", { workspaceId: f.workspaceId, path: "missing.txt" })).status, 404);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![0], "fs");
  assert.equal(logs[0]![2].requestId, "missing-file");
  assert.equal(logs[0]![2].rootCause.code, "ENOENT");
  logs.length = 0;
  f.db.applicationDb.exec("DROP TABLE engine_keys");
  assert.equal((await lifecycle.call("missing-key", "engineKeys.delete", { workspaceId: f.workspaceId, id: "missing" })).status, 500);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![0], "engine-key");
  assert.equal(logs[0]![2].requestId, "missing-key");
  assert.equal(logs[0]![2].keyId, "missing");
  assert.equal(logs[0]![2].rootCause.code, "ERR_SQLITE_ERROR");
});

test("desktop queue persistence and workspace validation failures keep one owner diagnostic", async t => {
  const f = fixture(t), lifecycle = await lifecycleFixture(t, f), logs: any[][] = [], threadId = "queue-owner" as ThreadId;
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: "队列" });
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  observeWorkspaceDiagnostics(t, f, logs);
  f.db.db.exec("CREATE TRIGGER reject_owner_queue BEFORE INSERT ON thread_message_queue BEGIN SELECT RAISE(ABORT, 'controlled queue persistence failure'); END");
  assert.equal((await lifecycle.call("queue-failure", "threads.queue.append", { workspaceId: f.workspaceId, threadId, text: "消息", sendOptions: { planMode: false, accessMode: "read-only", model: null, effort: null, roleId: null } })).status, 500);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![0], "queue");
  assert.equal(logs[0]![2].requestId, "queue-failure");
  assert.equal(logs[0]![2].rootCause.code, "ERR_SQLITE_ERROR");
  assert.deepEqual(f.db.db.prepare("SELECT id FROM thread_message_queue").all(), []);
  logs.length = 0;
  assert.equal((await lifecycle.call("workspace-failure", "workspaces.upsert", { workspaceId: "local-client:duplicate", title: "重复目录", path: f.ctx.workspaces.get(f.workspaceId)! })).status, 409);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![0], "workspace-index");
  assert.equal(logs[0]![2].requestId, "workspace-failure");
  assert.equal(typeof logs[0]![2].rootCause, "string");
});

test("desktop node send preserves the queue failure owner across its original wrapper", async t => {
  const f = fixture(t), lifecycle = await lifecycleFixture(t, f), logs: any[][] = [], threadId = "node-queue-owner" as ThreadId;
  const workflow = f.db.orchWorkflows.upsert({ workspaceId: f.workspaceId, name: "Flow", description: "Flow", nodes: [{ id: "node", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [], version: 1 } as any);
  const intake = f.db.orchIntakes.create({ workspaceId: f.workspaceId, title: "本机需求", goal: "目标", triggerMode: "manual", taskType: "feature", workspaceScope: { scopeType: "local_workspace", scopeId: f.workspaceId } });
  const instance = f.db.orchInstances.create({ workspaceId: f.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
  f.db.orchInstances.updateNodeStates(instance.id, { ...instance.nodeStates, node: { ...instance.nodeStates.node!, threadId } });
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: "节点", threadType: "orchestration", threadSubtype: "node" });
  f.db.db.exec("CREATE TRIGGER reject_node_owner_queue BEFORE INSERT ON thread_message_queue BEGIN SELECT RAISE(ABORT, 'controlled node queue persistence failure'); END");
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  observeWorkspaceDiagnostics(t, f, logs);
  assert.equal((await lifecycle.call("node-queue-failure", "threads.sendMessage", { workspaceId: f.workspaceId, threadId, text: "节点消息", accessMode: "read-only", planMode: false })).status, 500);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![0], "queue");
  assert.equal(logs[0]![2].requestId, "node-queue-failure");
  assert.equal(logs[0]![2].rootCause.code, "ERR_SQLITE_ERROR");
  assert.deepEqual(f.db.db.prepare("SELECT id FROM thread_message_queue").all(), []);
});

test("desktop original orchestration scope conflict keeps one owner diagnostic", async t => {
  const f = fixture(t), lifecycle = await lifecycleFixture(t, f), logs: any[][] = [];
  const intake = f.db.orchIntakes.create({ workspaceId: f.workspaceId, title: "共享需求", goal: "目标", triggerMode: "manual", taskType: "feature", workspaceScope: { scopeType: "shared_workspace", scopeId: "shared" } });
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  observeWorkspaceDiagnostics(t, f, logs);
  const direct: ClientToServerMessage[] = [];
  let ownedLogs = 0;
  await handleApiRequest({ ...f.ctx, intakeWorkspaceScope: { scopeType: "local_workspace", scopeId: f.workspaceId }, onApiFailureLogged: () => { ownedLogs += 1; }, send: message => { direct.push(message); } } as ApiHandlerContext,
    { t: "api.req", id: "scope-conflict", method: "orch.intakes.upsert", path: "/test", body: { workspaceId: f.workspaceId, intake } });
  assert.equal((direct.find(message => message.t === "api.res") as any)?.status, 403);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![2].errorCode, "ORCH_INTAKE_SCOPE_CONFLICT");
  assert.equal(ownedLogs, 1);
  assert.equal((await lifecycle.call("local-scope-rejected", "orch.intakes.upsert", { workspaceId: f.workspaceId, intake })).status, 404);
});

test("desktop requirement analysis creation keeps the original transaction and trusted local scope", async t => {
  const f = fixture(t);
  const created = await f.call("threads.create", { workspaceId: f.workspaceId, engine: "codex", title: "本机需求", threadSubtype: "requirement-analysis" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const threadId = (created.body as any).threadId as ThreadId;
  const session = f.db.orchRequirementAnalysisSessions.get(threadId as any)!;
  assert.deepEqual(session.workspaceScope, { scopeType: "local_workspace", scopeId: f.workspaceId });
  assert.equal((await f.call("orch.requirementAnalysis.sessions.create", { workspaceId: f.workspaceId, threadId })).status, 200);
  assert.equal((await f.call("threads.draft.save", { workspaceId: f.workspaceId, threadId, draft: { text: "需求草稿", images: [], files: [] } })).status, 200);
  assert.equal((await f.call("threads.rename", { workspaceId: f.workspaceId, threadId, title: "需求新标题" })).status, 200);
  assert.equal(f.db.threads.get(threadId)?.title, "需求新标题");
  assert.equal((await f.call("orch.requirementAnalysis.sessions.get", { workspaceId: f.workspaceId, sessionId: threadId, actorUserId: "forged" })).status, 400);
});

test("desktop requirement creation rolls back the thread when initial RA persistence fails", async t => {
  const f = fixture(t);
  const threadsBefore = f.db.db.prepare("SELECT id FROM threads ORDER BY id").all();
  t.mock.method(f.db.orchRequirementAnalysisSessions, "create", () => { throw new Error("controlled initial RA persistence failure"); });
  const response = await f.call("threads.create", { workspaceId: f.workspaceId, engine: "codex", title: "创建失败", threadSubtype: "requirement-analysis" });
  assert.equal(response.status, 500);
  assert.deepEqual(f.db.db.prepare("SELECT id FROM threads ORDER BY id").all(), threadsBefore);
  assert.deepEqual(f.db.db.prepare("SELECT id FROM orch_requirement_analysis_sessions").all(), []);
  assert.equal(f.sent.some(message => message.t === "conversation.event"), false);
});

test("desktop mutation allows knowledge threads through their connected local bridges", async t => {
  const f = fixture(t);
  for (const subtype of ["knowledge-assets", "knowledge-conversation"] as const) {
    const threadId = `connected-${subtype}` as ThreadId;
    f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: subtype, threadType: subtype === "knowledge-assets" ? "orchestration" : "chat", threadSubtype: subtype });
    for (const [method, extra] of [["threads.draft.get", {}], ["threads.draft.save", { draft: { text: "connected", images: [], files: [] } }],
      ["threads.queue.list", {}], ["threads.updatePrefs", { prefs: { planMode: true } }]] as const) {
      const response = await f.call(method, { workspaceId: f.workspaceId, threadId, ...extra });
      assert.equal(response.status, 200, `${subtype}:${method}:${JSON.stringify(response.body)}`);
    }
  }
});

test("desktop provider replies use each original session pending map and preserve failed delivery", async t => {
  const f = fixture(t), replies: Array<{ threadId: string; id: unknown; result: unknown }> = [];
  const sessions = new Map<string, CodexAppServerThreadSession>();
  let disconnected = false;
  for (const threadId of ["provider-a", "provider-b"]) {
    f.db.threads.create({ id: threadId as ThreadId, workspaceId: f.workspaceId, engine: "codex", title: threadId });
    const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  manager: { getOrCreate: () => ({ async respond(id: unknown, result: unknown) {
      if (disconnected) throw new Error("controlled provider disconnected");
      replies.push({ threadId, id, result });
    } }) } as any, workspacePath: f.ctx.workspaces.get(f.workspaceId)!, workspaceId: f.workspaceId, threadId, initialSessionId: `session-${threadId}` as any, initialSessionCapabilities: null,
      onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
    const active = { codexTurnId: `turn-${threadId}`, clientTurnId: `client-turn-${threadId}`, sharedWorkspaceToolContext: null,
      timeoutController: { onRawEvent() {}, onConversationEvent() {} } };
    Object.assign(session, { active, emitters: { conversation(event: any) { f.sent.push({ t: "conversation.event", event }); }, raw() {} } });
    (session as any).onAppServerMessage({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: `session-${threadId}`, turnId: active.codexTurnId, command: "echo smoke" } });
    sessions.set(threadId, session);
  }
  f.ctx.sessions = { beginThreadOperation: () => () => {}, getOrCreate: (thread: any) => sessions.get(thread.threadId), hasActiveTurn: () => true } as any;
  const body = { workspaceId: f.workspaceId, threadId: "provider-a", requestId: 7, decision: "accept" };
  assert.equal((await f.call("userInput.respond", { workspaceId: f.workspaceId, threadId: "provider-a", requestId: 7, answers: {} })).status, 500);
  assert.deepEqual(replies, []);
  const accepted = await f.call("approvals.respond", body);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(replies.map(reply => reply.threadId), ["provider-a"]);
  assert.equal((await f.call("approvals.respond", body)).status, 409);
  assert.equal((await f.call("approvals.respond", { ...body, threadId: "provider-b" })).status, 200);
  const session = sessions.get("provider-a")!;
  (session as any).onAppServerMessage({ id: "input-8", method: "item/tool/requestUserInput", params: { threadId: "session-provider-a", turnId: "turn-provider-a", questions: [{ id: "question", header: "Input", question: "Choose", options: [] }] } });
  const input = { workspaceId: f.workspaceId, threadId: "provider-a", requestId: "input-8", answers: { question: { answers: ["yes"] } } };
  disconnected = true;
  assert.equal((await f.call("userInput.respond", input)).status, 500);
  assert.equal(replies.length, 2);
  disconnected = false;
  assert.equal((await f.call("userInput.respond", input)).status, 200);
  assert.equal((await f.call("userInput.respond", input)).status, 500);
  assert.equal(replies.length, 3);
});

test("desktop intake edits project business fields and cannot claim shared or unknown records", async t => {
  const f = fixture(t);
  const created = await f.call("orch.intakes.create", { workspaceId: f.workspaceId, intake: { title: "本机需求", goal: "目标", workspaceScope: { scopeType: "shared_workspace", scopeId: "forged" }, sharedContext: { sharedWorkspaceId: "forged" } } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const intake = (created.body as any).intake;
  assert.deepEqual(intake.workspaceScope, { scopeType: "local_workspace", scopeId: f.workspaceId });
  assert.equal(intake.sharedContext ?? null, null);
  const saved = await f.call("orch.intakes.upsert", { workspaceId: f.workspaceId, intake: { ...intake, goal: "更新目标", workspaceScope: null } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(f.db.orchIntakes.get(intake.id)?.workspaceScope, intake.workspaceScope);
  for (const scope of [null, { scopeType: "shared_workspace", scopeId: "shared" }] as const) {
    const protectedIntake = f.db.orchIntakes.create({ workspaceId: f.workspaceId, title: "保护需求", goal: "目标", triggerMode: "manual", taskType: "feature", workspaceScope: scope });
    assert.equal((await f.call("orch.intakes.upsert", { workspaceId: f.workspaceId, intake: { ...protectedIntake, goal: "篡改" } })).status, 404);
    assert.equal(f.db.orchIntakes.get(protectedIntake.id)?.goal, "目标");
  }
  assert.equal((await f.call("orch.intakes.list", { workspaceId: f.workspaceId, allowedResourceIds: [] })).status, 400);
});

test("desktop execution binds orchestration actions to their exact requested workspace", async t => {
  const f = fixture(t), other = "local-client:other" as WorkspaceId;
  f.db.workspaces.upsert({ id: other, title: "Other", path: f.ctx.workspaces.get(f.workspaceId)! });
  f.ctx.workspaces.set(other, f.ctx.workspaces.get(f.workspaceId)!);
  const workflow = f.db.orchWorkflows.upsert({ workspaceId: f.workspaceId, name: "Flow", description: "Flow", nodes: [], edges: [], version: 1 });
  const intake = f.db.orchIntakes.create({ workspaceId: f.workspaceId, title: "本机需求", goal: "目标", triggerMode: "manual", taskType: "feature", workspaceScope: { scopeType: "local_workspace", scopeId: f.workspaceId } });
  const instance = f.db.orchInstances.create({ workspaceId: f.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
  let paused = false;
  f.ctx.orchEngine = { forWorkspace() { return this; }, async pause() { paused = true; } } as any;
  assert.equal((await f.call("orch.instances.pause", { workspaceId: other, instanceId: instance.id })).status, 404);
  assert.equal(paused, false);
  assert.equal((await f.call("orch.instances.pause", { workspaceId: f.workspaceId, instanceId: instance.id })).status, 200);
  assert.equal(paused, true);
});

test("desktop related resource reads use the real parent instance and exact requested workspace", async t => {
  const f = fixture(t), other = "local-client:other" as WorkspaceId;
  f.db.workspaces.upsert({ id: other, title: "Other", path: f.ctx.workspaces.get(f.workspaceId)! });
  f.ctx.workspaces.set(other, f.ctx.workspaces.get(f.workspaceId)!);
  const workflow = f.db.orchWorkflows.upsert({ workspaceId: f.workspaceId, name: "Flow", description: "Flow", nodes: [{ id: "node", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [], version: 1 } as any);
  const intake = f.db.orchIntakes.create({ workspaceId: f.workspaceId, title: "本机需求", goal: "目标", triggerMode: "manual", taskType: "feature", workspaceScope: { scopeType: "local_workspace", scopeId: f.workspaceId } });
  const instance = f.db.orchInstances.create({ workspaceId: f.workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
  const artifact = f.db.orchArtifacts.create({ instanceId: instance.id, nodeId: "node", kind: "text", version: 1, title: "产物", status: "draft", contentJson: "{}" } as any);
  const snapshot = f.db.orchPromptSnapshots.create({ instanceId: instance.id, nodeId: "node", attemptNo: 1, engine: "codex", promptEnvelope: { schemaVersion: "node-prompt-envelope/v1" },
    systemMessage: "system", userMessage: "user", renderedInputPreview: "user", runtimePolicy: {}, knowledgeCatalogs: [], artifactInput: { artifacts: [], fieldBindings: {} }, createdAt: 1 } as any);
  const requests: Array<[string, Record<string, unknown>]> = [
    ["orch.artifacts.get", { artifactId: artifact.id }], ["orch.artifactFiles.list", { artifactId: artifact.id }],
    ["orch.artifacts.list", { instanceId: instance.id }], ["orch.promptSnapshots.get", { promptSnapshotId: snapshot.id }],
    ["orch.promptSnapshots.list", { instanceId: instance.id }], ["orch.nodeWorkItems.list", { instanceId: instance.id, nodeId: "node" }],
    ["orch.nodeWorkItemEvents.list", { instanceId: instance.id, nodeId: "node" }],
  ];
  for (const [method, body] of requests) {
    assert.equal((await f.call(method, { workspaceId: other, ...body })).status, 404, method);
    const response = await f.call(method, { workspaceId: f.workspaceId, ...body });
    assert.equal(response.status, 200, `${method}:${JSON.stringify(response.body)}`);
  }
  f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = json_set(intake_snapshot_json, '$.workspaceScope', NULL) WHERE id = ?").run(instance.id);
  for (const [method, body] of requests) assert.equal((await f.call(method, { workspaceId: f.workspaceId, ...body })).status, 404, `unknown:${method}`);
});

test("desktop creates a plain local chat and persists draft and model prefs through existing handlers", async (t) => {
  const f = fixture(t);
  const created = await f.call("threads.create", { workspaceId: f.workspaceId, engine: "codex", title: "本机会话" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const threadId = (created.body as any).threadId as ThreadId;
  const body = { workspaceId: f.workspaceId, threadId };
  assert.equal(f.db.threads.get(threadId)?.sharedWorkspaceId ?? null, null);
  assert.equal((await f.call("threads.updatePrefs", { ...body, prefs: { planMode: true } })).status, 200);
  assert.equal(f.db.threads.get(threadId)?.planMode, true);
  assert.equal((await f.call("threads.draft.save", { ...body, draft: { text: "离线草稿", images: [], files: [] } })).status, 200);
  assert.equal(((await f.call("threads.draft.get", body)).body as any).draft.text, "离线草稿");
  assert.equal((await f.call("threads.draft.clear", body)).status, 200);
  assert.equal(((await f.call("threads.draft.get", body)).body as any).draft, null);
});

test("desktop execution rejects renderer authority, special thread creation and shared or foreign targets", async (t) => {
  const f = fixture(t);
  const base = { workspaceId: f.workspaceId, engine: "codex", title: "Local" };
  for (const forged of [{ actorUserId: "cloud" }, { sharedThreadAcl: {} }, { executionProfileUserId: "cloud" }, { threadType: "orchestration" }, { threadSubtype: "node" }]) {
    assert.equal((await f.call("threads.create", { ...base, ...forged })).status, 400, JSON.stringify(forged));
  }
  // 桌面通道支持调用方预生成 threadId，用于创建前的乐观路由与幂等重放。
  const providedThreadId = "chosen" as ThreadId;
  const provided = await f.call("threads.create", { ...base, threadId: providedThreadId });
  assert.equal(provided.status, 200, JSON.stringify(provided.body));
  assert.equal((provided.body as any).threadId, providedThreadId);
  const created = await f.call("threads.create", base);
  const threadId = (created.body as any).threadId as ThreadId;
  f.db.threads.create({ id: "shared-thread" as ThreadId, workspaceId: f.workspaceId, engine: "codex", title: "Shared", sharedAcl: { sharedWorkspaceId: "shared" as SharedWorkspaceId, ownerUserId: "cloud" } });
  f.db.threads.create({ id: "node-thread" as ThreadId, workspaceId: f.workspaceId, engine: "codex", title: "Node", threadType: "orchestration", threadSubtype: "node" });
  for (const [method, fields] of [["threads.draft.get", {}], ["threads.updatePrefs", { prefs: { planMode: true } }],
    ["threads.sendMessage", { text: "hi", model: "not-configured" }], ["turns.interrupt", { turnId: "turn" }], ["threads.queue.list", {}]] as const) {
    const body = { workspaceId: f.workspaceId, threadId, ...fields };
    for (const target of [{ workspaceId: "other:workspace" }, { threadId: "shared-thread" }, { threadId: "node-thread" }, { __queueSource: "queue_consume" }, { executionProfileScopeType: "shared_workspace" }]) {
      assert.ok((await f.call(method, { ...body, ...target })).status >= 400);
    }
  }
});

test("desktop queue persists local input and keys are read only from the current Client database", async (t) => {
  const f = fixture(t);
  const created = await f.call("threads.create", { workspaceId: f.workspaceId, engine: "codex", title: "Local" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const body = { workspaceId: f.workspaceId, threadId: (created.body as any).threadId };
  const paused = await f.call("threads.queue.pause", { ...body, reason: "manual" });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  const append = await f.call("threads.queue.append", { ...body, text: "排队消息", sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null } });
  assert.equal(append.status, 200, JSON.stringify(append.body));
  assert.deepEqual(f.db.threadMessageQueue.getExecutionProfileContext((append.body as any).item.id),
    { userId: "local:local-client", scope: { scopeType: "local_workspace", scopeId: f.workspaceId } });
  const snapshot = await f.call("threads.queue.list", body);
  assert.equal(snapshot.status, 200);
  assert.equal((snapshot.body as any).items[0].text, "排队消息");
  assert.equal((await f.call("threads.queue.clear", body)).status, 200);
  assert.deepEqual(((await f.call("threads.queue.list", body)).body as any).items, []);
  assert.equal((await f.call("engineKeys.list", { workspaceId: f.workspaceId })).status, 200);
  assert.equal((await f.call("engineKeys.list", { workspaceId: "foreign:workspace" })).status, 400);
  assert.equal(f.sent.some(message => message.t === "api.res"), false);
});

test("desktop send fails before dispatch for an unavailable model without creating a turn", async (t) => {
  const f = fixture(t);
  const created = await f.call("threads.create", { workspaceId: f.workspaceId, engine: "codex", title: "Local" });
  const threadId = (created.body as any).threadId;
  const response = await f.call("threads.sendMessage", { workspaceId: f.workspaceId, threadId, turnId: "unavailable-model-turn",
    text: "不要执行 provider", model: "model-that-does-not-exist" });
  assert.ok(response.status >= 400, JSON.stringify(response.body));
  assert.equal(f.db.turns.get("unavailable-model-turn" as any), null);
  assert.equal(f.sent.some(message => message.t === "conversation.event" && message.event.type === "turn.started"), false);
});

test("desktop send rejects an existing turn before the original handler can persist a start event", async (t) => {
  const f = fixture(t);
  const created = await f.call("threads.create", { workspaceId: f.workspaceId, engine: "codex", title: "Local" });
  const target = (created.body as any).threadId as ThreadId;
  const foreign = "foreign-thread" as ThreadId;
  f.db.threads.create({ id: foreign, workspaceId: f.workspaceId, engine: "codex", title: "Foreign" });
  for (const [turnId, threadId] of [["foreign-turn", foreign], ["existing-own-turn", target]] as const) {
    f.db.turns.insertStarted({ workspaceId: f.workspaceId, threadId, engine: "codex", turnId: turnId as any, startedAt: 1, startEventSeq: 1 });
    f.sent.length = 0;
    const response = await f.call("threads.sendMessage", { workspaceId: f.workspaceId, threadId: target, turnId, text: "拒绝重复回合" });
    assert.equal(response.status, 409);
    assert.equal(f.sent.some(message => message.t === "conversation.event"), false);
  }
});

test("运行中修改计划模式同步 Claude 权限模式，切换失败时保存偏好并提示下一轮生效", async t => {
  const f = fixture(t);
  const created = await f.call("threads.create", { workspaceId: f.workspaceId, engine: "claude", title: "plan switch" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const threadId = (created.body as any).threadId as ThreadId;
  const patches: Array<Record<string, unknown>> = [];
  const session = {
    hasActiveTurn: () => true,
    applyPermissionPrefs: async (patch: Record<string, unknown>) => { patches.push(patch); },
  };
  (f.ctx.sessions as any).getExisting = () => session;

  const enabled = await f.call("threads.updatePrefs", { workspaceId: f.workspaceId, threadId, prefs: { planMode: true } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.deepEqual(patches, [{ planMode: true }]);
  assert.equal(f.db.threads.get(threadId)?.planMode, true);

  session.applyPermissionPrefs = async () => { throw new Error("switch rejected"); };
  const failed = await f.call("threads.updatePrefs", { workspaceId: f.workspaceId, threadId, prefs: { planMode: false, accessMode: "current" } });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.match((failed.body as any).permissionModeWarning, /下一轮生效/);
  assert.equal(f.db.threads.get(threadId)?.planMode, false, "切换失败时偏好仍应持久化");
});

test("策略锁定的知识会话只改模型时不触发运行中权限切换", async t => {
  const f = fixture(t);
  const threadId = "knowledge-model-thread" as ThreadId;
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "claude", title: "knowledge", threadType: "chat", threadSubtype: "knowledge-conversation" });
  const patches: Array<Record<string, unknown>> = [];
  (f.ctx.sessions as any).getExisting = () => ({
    hasActiveTurn: () => true,
    applyPermissionPrefs: async (patch: Record<string, unknown>) => { patches.push(patch); },
  });

  await handleThreadsUpdatePrefs(f.ctx, { t: "api.req", id: "knowledge-model", method: "threads.updatePrefs",
    body: { workspaceId: f.workspaceId, threadId, prefs: { model: "claude-sonnet-5" } } } as any);

  const response = f.sent.at(-1) as any;
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(patches, [], "策略注入的只读/计划字段不得触发运行中切换");
  const thread = f.db.threads.get(threadId);
  assert.equal(thread?.planMode, false);
  assert.equal(thread?.accessMode, "read-only");
});

test("runtime.activity 只读返回运行中会话，供退出确认使用", async t => {
  const f = fixture(t);
  const threadId = "runtime-activity-thread" as ThreadId;
  const created = await f.call("threads.create", { workspaceId: f.workspaceId, threadId, engine: "claude", title: "正在运行的会话" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  (f.ctx.sessions as any).listActiveTurns = () => [{ threadId, turnId: "turn-running", engine: "claude" }];

  const response = await f.call("runtime.activity", {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const activity = (response.body as any).activity;
  assert.equal(activity.runningTurns.length, 1);
  assert.equal(activity.runningTurns[0].threadId, threadId);
  assert.equal(activity.runningTurns[0].workspaceId, f.workspaceId);
  assert.equal(activity.runningTurns[0].title, "正在运行的会话");
  assert.equal(activity.runningTurns[0].engine, "claude");
  assert.equal(activity.runningTurns[0].turnId, "turn-running");
});
