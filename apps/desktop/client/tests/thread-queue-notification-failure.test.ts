import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationEventInput, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { handleApiRequest } from "../src/app/handleApiRequest.ts";
import { emitQueueChanged } from "../src/app/handleThreadQueueRequest.ts";
import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { FileBlobRepo } from "../src/db/repos/fileBlobRepo.ts";
import { ThreadMessageQueueRepo } from "../src/db/repos/threadMessageQueueRepo.ts";
import { ThreadQueueStateRepo } from "../src/db/repos/threadQueueStateRepo.ts";
import { ThreadTurnRepo } from "../src/db/repos/threadTurnRepo.ts";
import { openSqliteDb } from "../src/db/sqliteDb.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.ts";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.ts";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.ts";
import { logger } from "../src/logger.ts";
import { createLocalEventPersistence } from "../src/runtime/localEventPersistence.ts";
import { waitForOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.ts";

const WORKSPACE = "notification-workspace" as WorkspaceId;
const THREAD = "notification-thread" as ThreadId;
const OTHER_THREAD = "notification-other-thread" as ThreadId;
const CODE = "QUEUE_CHANGE_NOTIFICATION_FAILED";
const OPTIONS = { workMode: "general" as const, planMode: false, accessMode: null, model: "test-model",
  effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null };

/** 真实 SQLite 状态配合可控传输，业务入口只替换外部 provider 和编排依赖。 */
function setup(mode: "analysis" | "append" | "pending" | "feedback" | "idle" = "analysis") {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, 'w', '/tmp', 1, 1)").run(WORKSPACE);
  for (const id of [THREAD, OTHER_THREAD]) {
    db.prepare("INSERT INTO threads (id, workspace_id, engine, title, thread_type, thread_subtype, created_at, updated_at) VALUES (?, ?, 'claude', 't', 'chat', NULL, 1, 1)").run(id, WORKSPACE);
  }
  const queue = new ThreadMessageQueueRepo(db, new FileBlobRepo(db));
  const states = new ThreadQueueStateRepo(db);
  const messages: any[] = [];
  const workspaceLogs: any[] = [];
  const calls = { business: 0, wake: 0, kick: 0, logged: 0 };
  let sendImpl: (message: any) => any = () => undefined;
  const subtype = mode === "analysis" ? "requirement-analysis" : mode === "append" || mode === "idle" ? null : "node";
  const ctx: any = {
    db: { db, workspaceId: WORKSPACE, threadMessageQueue: queue, threadQueueStates: states, turns: new ThreadTurnRepo(db),
      /** 原单位夹具固定单W；实际W文件路由由workspace-queue-request-log回归验证。 */
      forWorkspace(workspaceId: WorkspaceId) { assert.equal(workspaceId, WORKSPACE); return this; },
      /** 记录原W诊断，便于断言日志不会误落应用logger。 */
      writeWorkspaceLog(workspaceId: WorkspaceId, entry: any) { assert.equal(workspaceId, WORKSPACE); workspaceLogs.push(entry); },
      threads: { get: (id: ThreadId) => ({ id, workspaceId: WORKSPACE, engine: "claude", threadSubtype: subtype }) },
      orchInstances: { listByWorkspace: () => [{ id: "notification-instance", status: "running", createdAt: 1, updatedAt: 1,
        nodeStates: { node: { threadId: THREAD, status: mode === "feedback" ? "waiting-feedback" : "pending", humanActionSource: "execution" } } }] },
    },
    sessions: {
      beginThreadOperation: () => () => {},
      hasActiveTurn: () => mode === "append", canAppendInput: () => true,
      async appendInput() { calls.business++; return { engineCall: { kind: "jsonrpc", engine: "claude", transport: "test", requests: [] } }; },
    },
    getActiveThreadTurn: () => mode === "append" ? { turnId: "notification-turn", execution: OPTIONS } : null,
    workspaces: new Map([[WORKSPACE, "/tmp"]]),
    orchEngine: {
      /** 单W编排替身保持与队列相同的工作区身份。 */
      forWorkspace(workspaceId: WorkspaceId) { assert.equal(workspaceId, WORKSPACE); return this; },
      appendPendingNodeInput() { calls.business++; },
      async submitFeedback() { calls.business++; },
      async resumeInBackground() { calls.wake++; },
    },
    send(message: any) { messages.push(message); return sendImpl(message); },
    onApiFailureLogged() { calls.logged++; },
  };
  const dispatcher = new ThreadQueueDispatcher(ctx);
  const internal = dispatcher as any;
  internal.createRequirementAnalysisService = () => ({ async sendMessage() { calls.business++; } });
  ctx.queueDispatcher = dispatcher;
  return { db, queue, states, ctx, dispatcher, internal, messages, workspaceLogs, calls,
    setSend(fn: typeof sendImpl) { sendImpl = fn; },
    append(threadId = THREAD) { return queue.appendItem({ workspaceId: WORKSPACE, threadId, text: "input", images: [], files: [], originWebSessionId: null, sendOptions: OPTIONS }).item; },
    async close() {
      await new Promise(resolve => setTimeout(resolve, 20));
      for (const timer of internal.scheduledKickTimers.values()) clearTimeout(timer);
      db.close();
    },
  };
}

/** 等待调度释放占用；超时明确失败，不用任意长等待掩盖资源泄漏。 */
async function settled(h: ReturnType<typeof setup>) {
  const deadline = Date.now() + 1000;
  while (h.internal.inFlight.size || h.internal.persistedOrchestrationWakeRequests.size) {
    assert.ok(Date.now() < deadline, "dispatcher did not release its resources");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const transport of ["throw", "reject"] as const) {
  test(`notification ${transport} fails explicitly with one structured log`, async t => {
    const h = setup();
    const appLog = t.mock.method(logger, "error", () => {});
    h.setSend(() => { if (transport === "throw") throw new Error("parent disconnected"); return { accepted: false, reason: "closed" }; });
    try {
      assert.throws(() => emitQueueChanged(h.ctx, WORKSPACE, THREAD, "appended"), { code: CODE });
      assert.equal(h.workspaceLogs.length, 1);
      assert.equal(h.workspaceLogs[0].data.code, CODE);
      assert.equal(h.workspaceLogs[0].data.threadId, THREAD);
      assert.ok(h.workspaceLogs[0].data.requestId);
      assert.equal(appLog.mock.callCount(), 0);
      assert.equal(h.calls.logged, 1);
    } finally { await h.close(); }
  });
}

test("legacy void senders keep the notification contract", async () => {
  const h = setup();
  try { assert.doesNotThrow(() => emitQueueChanged(h.ctx, WORKSPACE, THREAD, "appended")); }
  finally { await h.close(); }
});

for (const method of ["append", "resume"] as const) {
  test(`queue ${method} returns failure and never kicks after notification rejection`, async () => {
    const h = setup("append");
    h.ctx.sessions.hasActiveTurn = () => false;
    h.ctx.getActiveThreadTurn = () => null;
    h.ctx.queueDispatcher = { kickIfIdle() { h.calls.kick++; } };
    h.setSend(message => message.t === "thread.queue.changed" ? { accepted: false, reason: "closed" } : undefined);
    try {
      await handleApiRequest(h.ctx, { t: "api.req", id: `request-${method}`, method: `threads.queue.${method}`, path: `/threads/queue/${method}`,
        body: { workspaceId: WORKSPACE, threadId: THREAD, text: "input", sendOptions: OPTIONS } } as any);
      const response = h.messages.find(message => message.t === "api.res");
      assert.equal(response?.status, 500);
      assert.match(response.body.message, /队列变更通知失败/);
      assert.ok(h.messages.some(message => message.t === "thread.queue.changed"));
      if (method === "append") assert.equal(h.queue.listActiveByThread(THREAD).length, 1);
      assert.equal(h.calls.kick, 0);
      assert.equal(h.states.getState(THREAD).paused, true);
    } finally { await h.close(); }
  });
}

test("consuming failure terminates only its claim, releases inFlight and preserves other threads", async () => {
  const h = setup();
  const first = h.append();
  const second = h.append();
  const other = h.append(OTHER_THREAD);
  h.setSend(message => {
    if (message.t === "thread.queue.changed" && message.threadId === THREAD) throw new Error("parent disconnected");
  });
  try {
    assert.throws(() => h.dispatcher.kickIfIdle(THREAD), { code: CODE });
    assert.equal(h.queue.getById(first.id)?.status, "failed");
    assert.equal(h.queue.getById(first.id)?.failureCode, CODE);
    assert.equal(h.queue.getById(second.id)?.status, "pending");
    assert.equal(h.internal.inFlight.has(THREAD), false);
    assert.equal(h.states.getState(THREAD).pausedReason, "send_failed");
    assert.equal(h.calls.business, 0);
    h.dispatcher.kickIfIdle(OTHER_THREAD);
    await settled(h);
    assert.equal(h.queue.getById(other.id)?.status, "sent");
    assert.equal(h.calls.business, 1);
  } finally { await h.close(); }
});

for (const mode of ["analysis", "append", "pending", "feedback"] as const) {
  test(`${mode} ACK survives consumed notification failure without a second business delivery`, async () => {
    const h = setup(mode);
    const first = h.append();
    const second = h.append();
    h.setSend(message => {
      if (message.t === "thread.queue.changed" && message.reason === "consumed") return { accepted: false, reason: "closed" };
    });
    try {
      if (mode === "append") h.dispatcher.kickAtActiveTurnBoundary(THREAD);
      else h.dispatcher.kickIfIdle(THREAD);
      await settled(h);
      const current = h.queue.getById(first.id)!;
      assert.equal(current.status, "sent");
      assert.equal(h.states.getState(THREAD).lastConsumedQueueId, first.id);
      assert.equal(h.states.getState(THREAD).pausedReason, "send_failed");
      assert.equal(h.queue.getById(second.id)?.status, "pending");
      assert.equal(h.calls.business, 1);
      assert.equal(h.calls.wake, 0);
      assert.equal(h.internal.scheduledKickTimers.size, 0);
      h.queue.remove(THREAD, second.id);
      h.setSend(() => undefined);
      if (mode !== "analysis") await h.dispatcher.retryAcknowledgedFinalization(THREAD, first.id);
      h.dispatcher.kickIfIdle(THREAD);
      await settled(h);
      assert.equal(h.calls.business, 1);
    } finally { await h.close(); }
  });
}

test("notification cleanup transaction failure escalates and still releases inFlight", async t => {
  const h = setup();
  h.append();
  h.setSend(() => { throw new Error("parent disconnected"); });
  t.mock.method(h.states, "pause", () => { throw new Error("database write failed"); });
  try {
    assert.throws(() => h.dispatcher.kickIfIdle(THREAD), error => {
      assert.match(String((error as any).cause?.errors?.[1]), /database write failed/);
      assert.notEqual((error as any).code, CODE, "unpersisted isolation must not be treated as handled");
      return true;
    });
    assert.equal(h.internal.inFlight.has(THREAD), false);
    assert.equal(h.calls.business, 0);
  } finally { await h.close(); }
});

test("claim cleanup failure cannot be mistaken for an isolated active-boundary error", async t => {
  const h = setup("append");
  const item = h.append();
  h.setSend(() => ({ accepted: false, reason: "closed" }));
  t.mock.method(h.queue, "markFailed", () => { throw new Error("claim write failed"); });
  try {
    assert.throws(() => h.dispatcher.kickAtActiveTurnBoundary(THREAD), { code: "QUEUE_CHANGE_NOTIFICATION_CLEANUP_FAILED", isolated: false });
    assert.equal(h.queue.getById(item.id)?.status, "sending");
    assert.equal(h.internal.inFlight.size, 0);
    assert.equal(h.calls.business, 0);
  } finally { await h.close(); }
});

test("idle failure notification preserves the original business failure code", async () => {
  const h = setup("idle");
  const item = h.append();
  h.queue.claimNextPendingForDispatch(THREAD);
  const gate = new WorkspaceOperationGate();
  const release = await gate.acquireMigration(WORKSPACE, "notification-migration");
  h.ctx.workspaceOperationGate = gate;
  h.ctx.takeApiResponseDispatch = () => null;
  h.setSend(message => message.t === "thread.queue.changed" ? { accepted: false, reason: "closed" } : undefined);
  // 目录迁移拒绝在业务执行前返回稳定失败，验证广播失败仍保留原业务码。
  try {
    await assert.rejects(h.internal.executeQueueSend(h.queue.getById(item.id), WORKSPACE, THREAD), { code: CODE });
    assert.equal(h.queue.getById(item.id)?.status, "failed");
    assert.equal(h.queue.getById(item.id)?.failureCode, "WORKSPACE_MIGRATION_IN_PROGRESS");
    assert.equal(h.states.getState(THREAD).pausedReason, "send_failed");
  } finally { release(); await h.close(); }
});

test("idle send ACK survives rejected completion notification through the real API handler", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-notification-"));
  const workspacePath = path.join(root, "workspace"); fs.mkdirSync(workspacePath);
  const app = openClientDb({ dbPath: path.join(root, "app.db"), localCanonicalEvents: true });
  initializeLocalEngineModelCatalog();
  app.workspaces.upsert({ id: WORKSPACE, title: "test", path: workspacePath });
  const db = app.forWorkspace(WORKSPACE);
  db.threads.create({ id: THREAD, workspaceId: WORKSPACE, engine: "claude", title: "test", threadType: "orchestration", threadSubtype: "node-discussion" });
  const threads = new ThreadStore();
  let businessCalls = 0;
  let providerStarted!: () => void;
  const enteredProvider = new Promise<void>(resolve => { providerStarted = resolve; });
  let finishProvider!: (value: { responseText: string }) => void;
  const providerResult = new Promise<{ responseText: string }>(resolve => { finishProvider = resolve; });
  const ctx: any = { db, threads, clientId: "notification-client", workspaces: new Map([[WORKSPACE, workspacePath]]),
    sessions: { beginThreadOperation: () => () => {}, hasActiveTurn: () => false, canAppendInput: () => false,
      getOrCreate: () => ({ engine: "claude", resolvePlatformToolTransport: () => "none",
        prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
        sendMessage: () => { businessCalls++; providerStarted(); return providerResult; } }) },
    orchEngine: { forWorkspace: () => ctx.orchEngine, buildManagedServiceToolRegistry: () => null },
    send: (message: any) => message.t === "thread.queue.changed" ? { accepted: false, reason: "closed" } : undefined,
  };
  const persistence = createLocalEventPersistence({ db, applyRaw() {}, applyConversation(event) {
    if (event.type === "turn.started") db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
      turnId: event.payload.turnId, startedAt: event.ts, startEventSeq: event.seq });
    if (event.type === "turn.completed" || event.type === "turn.error") db.turns.setEnded(event.payload.turnId, {
      status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: event.seq });
  } });
  ctx.onBeforeEmitConversationEvent = (event: ConversationEventInput) => { persistence.persist({ t: "conversation.event", event }); };
  const dispatcher = new ThreadQueueDispatcher(ctx);
  ctx.queueDispatcher = dispatcher;
  const item = db.threadMessageQueue.appendItem({ workspaceId: WORKSPACE, threadId: THREAD, text: "input", images: [], files: [],
    originWebSessionId: null, sendOptions: { ...OPTIONS, model: null } }).item;
  db.threadMessageQueue.claimNextPendingForDispatch(THREAD);
  try {
    await assert.rejects((dispatcher as any).executeQueueSend(db.threadMessageQueue.getById(item.id), WORKSPACE, THREAD), { code: CODE });
    assert.equal(db.threadMessageQueue.getById(item.id)?.status, "sent");
    assert.ok(db.threadMessageQueue.getById(item.id)?.sentTurnId);
    assert.equal(db.threadQueueStates.getState(THREAD).lastConsumedQueueId, item.id);
    assert.equal(db.threadQueueStates.getState(THREAD).pausedReason, "send_failed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([enteredProvider, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("TEST_PROVIDER_NOT_STARTED")), 2_000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    assert.equal(businessCalls, 1);
    dispatcher.kickIfIdle(THREAD);
    assert.equal(businessCalls, 1);
  } finally {
    const runtime = threads.get(THREAD);
    if (runtime) runtime.lifecycleVersion++;
    finishProvider({ responseText: "done" });
    const turnId = db.threadMessageQueue.getById(item.id)?.sentTurnId;
    if (turnId) await waitForOrdinaryTurnExecution(ctx.sessions, { workspaceId: WORKSPACE, threadId: THREAD, turnId }, { timeoutMs: 2_000 });
    resetEngineModelCatalogRuntimeForTest();
    app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const reason of ["resumed", "paused"] as const) {
  test(`persisted wake ${reason} notification failure preserves accepted input and clears the wake map`, async () => {
    const h = setup("pending");
    const item = h.append();
    h.queue.markSent(item.id, null);
    h.states.setLastConsumed(THREAD, WORKSPACE, item.id, null);
    if (reason === "resumed") h.states.pause(THREAD, WORKSPACE, "send_failed");
    else h.ctx.orchEngine.resumeInBackground = async () => { h.calls.wake++; throw new Error("wake unavailable"); };
    h.setSend(message => message.t === "thread.queue.changed" ? { accepted: false, reason: "closed" } : undefined);
    const binding = { instanceId: "notification-instance", nodeId: "node", status: "pending" };
    try {
      await assert.rejects(h.internal.wakeOrchestrationForPersistedInput(WORKSPACE, THREAD, item.id, binding), { code: CODE });
      assert.equal(h.queue.getById(item.id)?.status, "sent");
      assert.equal(h.states.getState(THREAD).lastConsumedQueueId, item.id);
      assert.equal(h.states.getState(THREAD).pausedReason, "send_failed");
      assert.equal(h.internal.persistedOrchestrationWakeRequests.size, 0);
      assert.equal(h.internal.scheduledKickTimers.size, 0);
      assert.equal(h.calls.business, 0);
      h.setSend(() => undefined);
      h.ctx.orchEngine.resumeInBackground = async () => { h.calls.wake++; };
      await h.dispatcher.retryPersistedNodeWake(THREAD, item.id);
      assert.equal(h.calls.wake, 2);
      assert.equal(h.calls.business, 0);
    } finally { await h.close(); }
  });
}

for (const outcome of ["completed", "error"] as const) {
  test(`terminal ${outcome} notification failure cancels old timers and preserves its business outcome`, async () => {
    const h = setup("idle");
    const first = h.append();
    const second = h.append();
    h.queue.claimNextPendingForDispatch(THREAD);
    h.internal.scheduledKickTimers.set(THREAD, setTimeout(() => assert.fail("stale timer executed"), 1000));
    h.setSend(() => { throw new Error("parent disconnected"); });
    try {
      assert.doesNotThrow(() => h.dispatcher.notifyTurnTerminal({ workspaceId: WORKSPACE, threadId: THREAD,
        turnId: "notification-turn", source: "queue_consume", queueItemId: first.id, outcome, terminationKind: "manual_interrupt" }));
      assert.equal(h.queue.getById(first.id)?.status, outcome === "completed" ? "sent" : "cancelled");
      assert.equal(h.states.getState(THREAD).pausedReason, outcome === "completed" ? "send_failed" : "user_stop");
      assert.equal(h.queue.getById(second.id)?.status, "pending");
      assert.equal(h.internal.scheduledKickTimers.size, 0);
      assert.equal(h.calls.business, 0);
    } finally { await h.close(); }
  });
}

for (const boundary of ["timer", "active"] as const) {
  test(`${boundary} boundary isolates a notification failure without stopping other work`, async () => {
    const h = setup("append");
    if (boundary === "timer") {
      h.ctx.sessions.hasActiveTurn = () => false;
      h.ctx.getActiveThreadTurn = () => null;
    }
    const item = h.append();
    h.setSend(() => ({ accepted: false, reason: "closed" }));
    try {
      if (boundary === "active") assert.doesNotThrow(() => h.dispatcher.kickAtActiveTurnBoundary(THREAD));
      else h.internal.scheduleKickIfIdle(THREAD);
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(h.queue.getById(item.id)?.status, "failed");
      assert.equal(h.queue.getById(item.id)?.failureCode, CODE);
      assert.equal(h.internal.inFlight.size, 0);
      assert.equal(h.internal.scheduledKickTimers.size, 0);
      assert.equal(h.calls.business, 0);
    } finally { await h.close(); }
  });
}

test("API notification rejection blocks an already scheduled kick and preserves a user pause", async () => {
  const h = setup("idle");
  const item = h.append();
  h.states.pause(THREAD, WORKSPACE, "user_stop");
  h.setSend(message => message.t === "thread.queue.changed" ? { accepted: false, reason: "closed" } : undefined);
  try {
    h.internal.scheduleKickIfIdle(THREAD);
    assert.throws(() => emitQueueChanged(h.ctx, WORKSPACE, THREAD, "appended"), { code: CODE });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.states.getState(THREAD).pausedReason, "user_stop");
    assert.equal(h.queue.getById(item.id)?.status, "pending");
    assert.equal(h.calls.business, 0);
    assert.equal(h.internal.scheduledKickTimers.size, 0);
  } finally { await h.close(); }
});

for (const mode of ["append", "pending", "feedback"] as const) {
  test(`${mode} ACK cannot clear a notification failure pause created while business was in flight`, async () => {
    const h = setup(mode);
    const first = h.append();
    const second = h.append();
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    if (mode === "append") h.ctx.sessions.appendInput = async () => { h.calls.business++; await waiting; return { engineCall: null }; };
    if (mode === "feedback") h.ctx.orchEngine.submitFeedback = async () => { h.calls.business++; await waiting; };
    if (mode === "pending") h.ctx.orchEngine.appendPendingNodeInput = () => {
      h.calls.business++;
      h.setSend(() => ({ accepted: false, reason: "closed" }));
      assert.throws(() => emitQueueChanged(h.ctx, WORKSPACE, THREAD, "appended"), { code: CODE });
      h.setSend(() => undefined);
    };
    try {
      if (mode === "append") h.dispatcher.kickAtActiveTurnBoundary(THREAD);
      else h.dispatcher.kickIfIdle(THREAD);
      if (mode !== "pending") {
        h.setSend(() => ({ accepted: false, reason: "closed" }));
        assert.throws(() => emitQueueChanged(h.ctx, WORKSPACE, THREAD, "appended"), { code: CODE });
        h.setSend(() => undefined);
      }
      finish();
      await settled(h);
      assert.equal(h.queue.getById(first.id)?.status, "sent");
      assert.equal(h.states.getState(THREAD).pausedReason, "send_failed");
      assert.equal(h.queue.getById(second.id)?.status, "pending");
      assert.equal(h.calls.business, 1);
      assert.equal(h.calls.wake, 0);
      assert.equal(h.internal.scheduledKickTimers.size, 0);
    } finally { finish(); await h.close(); }
  });
}

for (const failureEntry of ["notification", "resume-api"] as const) {
test(`in-flight wake retry preserves a newer ${failureEntry} failure in the same millisecond`, async t => {
  const h = setup("pending");
  t.mock.method(Date, "now", () => 1000);
  const item = h.append();
  const next = h.append();
  h.queue.markSent(item.id, null);
  h.states.setLastConsumed(THREAD, WORKSPACE, item.id, null);
  h.states.pause(THREAD, WORKSPACE, "send_failed");
  const originalPause = h.states.getState(THREAD).pausedAt;
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  h.ctx.orchEngine.resumeInBackground = () => { h.calls.wake++; return waiting; };
  try {
    const retry = h.dispatcher.retryPersistedNodeWake(THREAD, item.id);
    await Promise.resolve();
    h.setSend(message => message.t === "thread.queue.changed" ? { accepted: false, reason: "closed" } : undefined);
    if (failureEntry === "notification") {
      assert.throws(() => emitQueueChanged(h.ctx, WORKSPACE, THREAD, "appended"), { code: CODE });
    } else {
      await handleApiRequest(h.ctx, { t: "api.req", id: "wake-resume-request", method: "threads.queue.resume", path: "/threads/queue/resume",
        body: { workspaceId: WORKSPACE, threadId: THREAD } } as any);
      assert.equal(h.messages.find(message => message.t === "api.res")?.status, 500);
    }
    h.setSend(() => undefined);
    finish();
    await retry;
    assert.equal(h.states.getState(THREAD).pausedReason, "send_failed");
    assert.ok(h.states.getState(THREAD).pausedAt! > originalPause!);
    assert.equal(h.queue.getById(next.id)?.status, "pending");
    assert.equal(h.internal.persistedOrchestrationWakeRequests.size, 0);
    assert.equal(h.internal.scheduledKickTimers.size, 0);
    assert.equal(h.calls.business, 0);
  } finally { finish(); await h.close(); }
});
}

test("resume keeps the public unpaused timestamp empty while subsequent pauses remain monotonic", async t => {
  const h = setup();
  t.mock.method(Date, "now", () => 1000);
  try {
    h.states.pause(THREAD, WORKSPACE, "send_failed");
    const first = h.states.getState(THREAD).pausedAt;
    h.states.resume(THREAD, WORKSPACE);
    assert.equal(h.states.getState(THREAD).pausedAt, null);
    h.states.pause(THREAD, WORKSPACE, "send_failed");
    assert.ok(h.states.getState(THREAD).pausedAt! > first!);
  } finally { await h.close(); }
});
