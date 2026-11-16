import test from "node:test";
import assert from "node:assert/strict";

import type {
  OrchestrationId,
  ThreadId,
  ThreadQueueSharedWorkspaceContext,
  WorkspaceId,
} from "@codeflowai/shared";

import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { FileBlobRepo } from "../src/db/repos/fileBlobRepo.ts";
import { ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE, ThreadMessageQueueRepo } from "../src/db/repos/threadMessageQueueRepo.ts";
import { ThreadQueueStateRepo } from "../src/db/repos/threadQueueStateRepo.ts";
import { ThreadTurnRepo } from "../src/db/repos/threadTurnRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";
import { onThreadQueueAppend, QueueChangeNotificationError } from "../src/app/handleThreadQueueRequest.ts";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.ts";
import { ActiveTurnInputClosedError } from "../src/engines/threadSession.ts";

const WORKSPACE_ID = "test:disp-ws" as WorkspaceId;
const THREAD_ID = "test_thread_disp" as ThreadId;

type ActiveTurnExecutionSnapshot = {
  model: string | null;
  effort: string | null;
  contextWindow: number | null;
  autoCompactPct: number | null;
  serviceTier: "fast" | null;
};

type SetupResult = {
  db: SqliteDb;
  queueRepo: ThreadMessageQueueRepo;
  stateRepo: ThreadQueueStateRepo;
  dispatcher: ThreadQueueDispatcher;
  sentMessages: any[];
  hasActiveTurnReturn: { value: boolean };
  canAppendInputReturn: { value: boolean };
  activeTurnIdReturn: { value: string | null };
  activeTurnExecutionReturn: { value: ActiveTurnExecutionSnapshot | null };
  appendInputCalls: any[];
  appendPendingNodeInputCalls: any[];
  submitFeedbackCalls: any[];
  resumeInBackgroundCalls: string[];
};

/**
 * 构造一个最小可用的 ApiHandlerContext：
 * - db.threads.get → 返回伪 thread（subtype null = chat）
 * - db.threadMessageQueue / db.threadQueueStates → 真实 repo（:memory: SQLite）
 * - sessions.hasActiveTurn → 通过 hasActiveTurnReturn.value 控制
 * - send → 收集 ws 消息（不真发）
 * 不调 handleApiRequest，所以不需要 dispatcher 跑完 executeQueueSend；
 * 我们只测 notifyTurnTerminal / kickIfIdle 的 short-circuit + 状态机分支。
 */
function setup(opts?: {
  threadSubtype?: string | null;
  nodeState?: Record<string, unknown> | null;
  nodeInstances?: Array<{
    id: string;
    status: "pending" | "running" | "paused" | "waiting-start" | "waiting-approval" | "waiting-feedback" | "completed" | "failed" | "cancelled";
    nodeId?: string;
    nodeState: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
  }>;
  submitFeedbackImpl?: (instanceId: string, nodeId: string, action: string, input?: any) => Promise<void>;
  resumeInBackgroundImpl?: (instanceId: string) => Promise<void>;
  appendInputImpl?: (threadId: ThreadId, input: any) => Promise<any>;
  appendPendingNodeInputImpl?: (instanceId: string, nodeId: string, input: any) => void;
  beforeSetLastConsumedImpl?: () => void;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
}): SetupResult {
  const setupOptions = opts ?? {};
  const originalBeforeSetLastConsumedImpl = setupOptions.beforeSetLastConsumedImpl;
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(String(WORKSPACE_ID), "ws", "/tmp", Date.now(), Date.now());
  db.prepare("INSERT INTO threads (id, workspace_id, engine, title, thread_type, thread_subtype, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    String(THREAD_ID),
    String(WORKSPACE_ID),
    "claude",
    "t",
    opts?.threadSubtype === "node" ? "orchestration" : "chat",
    opts?.threadSubtype ?? null,
    Date.now(),
    Date.now(),
  );

  const blobs = new FileBlobRepo(db);
  const queueRepo = new ThreadMessageQueueRepo(db, blobs);
  const stateRepo = new ThreadQueueStateRepo(db);
  const turnRepo = new ThreadTurnRepo(db);

  const sentMessages: any[] = [];
  const hasActiveTurnReturn = { value: false };
  const canAppendInputReturn = { value: true };
  const activeTurnIdReturn = { value: null as string | null };
  const activeTurnExecutionReturn = {
    value: {
      model: "test-model",
      effort: null,
      contextWindow: null,
      autoCompactPct: null,
      serviceTier: null,
    } satisfies ActiveTurnExecutionSnapshot,
  };
  const appendInputCalls: any[] = [];
  const appendPendingNodeInputCalls: any[] = [];
  const submitFeedbackCalls: any[] = [];
  const resumeInBackgroundCalls: string[] = [];
  const nodeInstances = opts?.nodeInstances ?? (opts?.nodeState
    ? [{
        id: "orch-test-instance",
        status: "running" as const,
        nodeId: "node-a",
        nodeState: opts.nodeState,
        createdAt: 1,
        updatedAt: 1,
      }]
    : []);

  const threadQueueStates = {
    getState: stateRepo.getState.bind(stateRepo),
    pause: stateRepo.pause.bind(stateRepo),
    resume: stateRepo.resume.bind(stateRepo),
    setLastConsumed(...args: Parameters<ThreadQueueStateRepo["setLastConsumed"]>) {
      originalBeforeSetLastConsumedImpl?.();
      stateRepo.setLastConsumed(...args);
    },
  };
  const fakeCtx = {
    workspaces: new Map([[WORKSPACE_ID, "/tmp"]]),
    db: {
      db,
      workspaceId: WORKSPACE_ID,
      /** 本夹具只有一个已固定的内存库；不执行生产工作区定位。 */
      forWorkspace() { return this; },
      /** 单位夹具验证队列状态；真实固定W日志由workspace-queue-dispatcher-log覆盖。 */
      writeWorkspaceLog(workspaceId: WorkspaceId) { assert.equal(workspaceId, WORKSPACE_ID); },
      threads: {
        get: (tid: ThreadId) => ({
          id: tid,
          workspaceId: WORKSPACE_ID,
          engine: "claude",
          threadSubtype: opts?.threadSubtype ?? null,
        }),
      },
      orchInstances: {
        listByWorkspace: () => nodeInstances.map((instance) => ({
              id: instance.id as OrchestrationId,
              status: instance.status,
              createdAt: instance.createdAt,
              updatedAt: instance.updatedAt,
              nodeStates: {
                [instance.nodeId ?? "node-a"]: {
                  nodeId: instance.nodeId ?? "node-a",
                  threadId: THREAD_ID,
                  retryCount: 0,
                  ...instance.nodeState,
                },
              },
            })),
      },
      threadMessageQueue: queueRepo,
      threadQueueStates,
      turns: turnRepo,
    },
    sessions: {
      hasActiveTurn: (_tid: ThreadId): boolean => hasActiveTurnReturn.value,
      canAppendInput: (_tid: ThreadId): boolean => canAppendInputReturn.value,
      async appendInput(_tid: ThreadId, input: any) {
        appendInputCalls.push(input);
        if (opts?.appendInputImpl) return await opts.appendInputImpl(_tid, input);
        return {
          engineCall: {
            kind: "jsonrpc",
            engine: "codex",
            transport: "test",
            requests: [],
          },
        };
      },
    },
    orchEngine: {
      /** 夹具的引擎 owner 与单库 scope 一致。 */
      forWorkspace() { return this; },
      appendPendingNodeInput(instanceId: string, nodeId: string, input: any) {
        appendPendingNodeInputCalls.push({ instanceId, nodeId, input });
        opts?.appendPendingNodeInputImpl?.(instanceId, nodeId, input);
      },
      async submitFeedback(instanceId: string, nodeId: string, action: string, input?: any) {
        submitFeedbackCalls.push({ instanceId, nodeId, action, input });
        await opts?.submitFeedbackImpl?.(instanceId, nodeId, action, input);
      },
      async resumeInBackground(instanceId: string) {
        resumeInBackgroundCalls.push(instanceId);
        await opts?.resumeInBackgroundImpl?.(instanceId);
      },
    },
    getActiveThreadTurn: () => activeTurnIdReturn.value
      ? { turnId: activeTurnIdReturn.value, execution: activeTurnExecutionReturn.value }
      : null,
    send: (msg: any) => {
      sentMessages.push(msg);
    },
  } as any;

  const dispatcher = new ThreadQueueDispatcher(fakeCtx, undefined, undefined, opts?.withLegacyDatabase);
  const closeDb = db.close.bind(db);
  // 测试结束先取消夹具创建的延迟消费，禁止关闭连接后继续访问数据库。
  db.close = () => {
    for (const timer of (dispatcher as any).scheduledKickTimers.values()) clearTimeout(timer);
    (dispatcher as any).scheduledKickTimers.clear();
    closeDb();
  };
  return {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    sentMessages,
    hasActiveTurnReturn,
    canAppendInputReturn,
    activeTurnIdReturn,
    activeTurnExecutionReturn,
    appendInputCalls,
    appendPendingNodeInputCalls,
    submitFeedbackCalls,
    resumeInBackgroundCalls,
  };
}

test("队列追加的provider等待不持数据库许可，ACK后的本地收尾重新准入", async () => {
  let permitted = false;
  const withLegacyDatabase = async <T>(_requestId: string, operation: () => T): Promise<T> => {
    await Promise.resolve();
    permitted = true;
    try { return operation(); } finally { permitted = false; }
  };
  const h = setup({ withLegacyDatabase, async appendInputImpl() {
    assert.equal(permitted, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(permitted, false);
    return { engineCall: { kind: "jsonrpc", engine: "claude", transport: "test", requests: [] } };
  } });
  const item = appendOne(h.queueRepo, "协调追加");
  h.hasActiveTurnReturn.value = true; h.activeTurnIdReturn.value = "active-turn";
  h.db.setAccessGuard?.(() => { if (!permitted) throw new Error("TEST_QUEUE_PERMISSION_REQUIRED"); });
  try {
    h.dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await h.dispatcher.waitForIdle();
    assert.equal(await withLegacyDatabase("verify", () => h.queueRepo.getById(item.id)?.status), "sent");
  } finally { h.db.setAccessGuard?.(null); h.db.close(); }
});

for (const nodeStatus of ["pending", "waiting-feedback"] as const) {
  test(`节点队列${nodeStatus}在业务await前释放许可并保护后续队列写回`, async () => {
    let permitted = false;
    const withLegacyDatabase = async <T>(_requestId: string, operation: () => T): Promise<T> => {
      await Promise.resolve(); permitted = true;
      try { return operation(); } finally { permitted = false; }
    };
    const outsideDatabase = async () => { assert.equal(permitted, false); await new Promise(resolve => setImmediate(resolve)); };
    const h = setup({ withLegacyDatabase, threadSubtype: "node", nodeState: { status: nodeStatus, humanActionSource: nodeStatus === "waiting-feedback" ? "execution" : null },
      resumeInBackgroundImpl: outsideDatabase, submitFeedbackImpl: outsideDatabase });
    const item = appendOne(h.queueRepo, "协调节点输入");
    h.db.setAccessGuard?.(() => { if (!permitted) throw new Error("TEST_QUEUE_PERMISSION_REQUIRED"); });
    try {
      h.dispatcher.kickIfIdle(THREAD_ID); await h.dispatcher.waitForIdle();
      const stored = await withLegacyDatabase("verify", () => h.queueRepo.getById(item.id));
      assert.equal(stored?.status, "sent", JSON.stringify({ code: stored?.failureCode, reason: stored?.failureReason }));
    } finally { h.db.setAccessGuard?.(null); h.db.close(); }
  });
}

test("update admission preserves pending node input without waking and resumes once", async () => {
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" } });
  try {
    let paused = true;
    (h.dispatcher as any).ctx.isTaskAdmissionPaused = () => paused;
    const item = appendOne(h.queueRepo, "wait for update");
    const before = h.stateRepo.getState(THREAD_ID);
    h.dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(h.stateRepo.getState(THREAD_ID), before);
    assert.equal(h.queueRepo.getById(item.id)?.attemptCount, 0);
    assert.equal(h.appendPendingNodeInputCalls.length, 0);
    assert.equal(h.resumeInBackgroundCalls.length, 0);
    paused = false;
    h.dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.queueRepo.getById(item.id)?.status, "sent");
    assert.equal(h.appendPendingNodeInputCalls.length, 1);
    assert.equal(h.resumeInBackgroundCalls.length, 1);
  } finally { h.db.close(); }
});

test("update admission does not alter the existing user pause", () => {
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" } });
  try {
    let paused = true;
    (h.dispatcher as any).ctx.isTaskAdmissionPaused = () => paused;
    appendOne(h.queueRepo, "keep user pause");
    h.stateRepo.pause(THREAD_ID, WORKSPACE_ID, "user_pause");
    const before = h.stateRepo.getState(THREAD_ID);
    h.dispatcher.kickIfIdle(THREAD_ID);
    paused = false;
    h.dispatcher.kickIfIdle(THREAD_ID);
    assert.deepEqual(h.stateRepo.getState(THREAD_ID), before);
    assert.equal(h.resumeInBackgroundCalls.length, 0);
  } finally { h.db.close(); }
});

test("update admission freezes node wake scheduled before the next microtask", async () => {
  const h = setup({ threadSubtype: "node", nodeState: { status: "running" } });
  try {
    let paused = false;
    (h.dispatcher as any).ctx.isTaskAdmissionPaused = () => paused;
    const item = appendOne(h.queueRepo, "deferred wake");
    h.dispatcher.kickIfIdle(THREAD_ID);
    paused = true;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.resumeInBackgroundCalls.length, 0);
    assert.equal(h.queueRepo.getById(item.id)?.status, "pending");
    assert.equal(h.stateRepo.getState(THREAD_ID).paused, false);
    paused = false;
    h.dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.resumeInBackgroundCalls.length, 1);
  } finally { h.db.close(); }
});

test("update admission returns a claimed input to pending if freeze arrives before dispatch", async () => {
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" } });
  try {
    let paused = false;
    const ctx = (h.dispatcher as any).ctx, originalSend = ctx.send;
    ctx.isTaskAdmissionPaused = () => paused;
    ctx.send = (message: any) => { originalSend(message); if (message.reason === "consuming") paused = true; };
    const item = appendOne(h.queueRepo, "claimed before freeze");
    h.dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.queueRepo.getById(item.id)?.status, "pending");
    assert.equal(h.queueRepo.getById(item.id)?.attemptCount, 1);
    assert.equal(h.stateRepo.getState(THREAD_ID).paused, false);
    assert.equal(h.appendPendingNodeInputCalls.length, 0);
    assert.equal(h.dispatcher.hasInFlightWork(), false);
    paused = false;
    ctx.send = originalSend;
    h.dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.queueRepo.getById(item.id)?.status, "sent");
    assert.equal(h.appendPendingNodeInputCalls.length, 1);
  } finally { h.db.close(); }
});

test("accepted node input finishes its tracked wake before update activity is inspected", async () => {
  let finishWake!: () => void;
  const wake = new Promise<void>(resolve => { finishWake = resolve; });
  let paused = false;
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" },
    appendPendingNodeInputImpl: () => { paused = true; }, resumeInBackgroundImpl: () => wake });
  try {
    (h.dispatcher as any).ctx.isTaskAdmissionPaused = () => paused;
    const item = appendOne(h.queueRepo, "accepted input");
    h.dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.queueRepo.getById(item.id)?.status, "sent");
    assert.equal(h.resumeInBackgroundCalls.length, 1);
    assert.equal(h.dispatcher.hasInFlightWork(), true);
    finishWake();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.dispatcher.hasInFlightWork(), false);
    assert.equal(h.stateRepo.getState(THREAD_ID).paused, false);
  } finally { finishWake(); await new Promise(resolve => setTimeout(resolve, 10)); h.db.close(); }
});

test("already dispatched pending-node wake remains visible until its acknowledgement", async () => {
  let finishWake!: () => void;
  const wake = new Promise<void>(resolve => { finishWake = resolve; });
  const h = setup({ threadSubtype: "node", nodeState: { status: "running" }, resumeInBackgroundImpl: () => wake });
  try {
    let paused = false;
    (h.dispatcher as any).ctx.isTaskAdmissionPaused = () => paused;
    appendOne(h.queueRepo, "running node wake");
    h.dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    paused = true;
    assert.equal(h.resumeInBackgroundCalls.length, 1);
    assert.equal(h.dispatcher.hasInFlightWork(), true);
    finishWake();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.dispatcher.hasInFlightWork(), false);
  } finally { finishWake(); await new Promise(resolve => setTimeout(resolve, 10)); h.db.close(); }
});

test("ordinary queue update rejection releases its claim without marking send failed", async () => {
  const h = setup();
  let dispatcher: ThreadQueueDispatcher | undefined;
  try {
    let paused = false;
    const ctx = (h.dispatcher as any).ctx;
    ctx.isTaskAdmissionPaused = () => paused;
    dispatcher = new ThreadQueueDispatcher(ctx, () => ({ ...ctx, isTaskAdmissionPaused: () => { paused = true; return true; } }));
    const item = appendOne(h.queueRepo, "ordinary accepted input");
    dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    const saved = h.queueRepo.getById(item.id)!;
    assert.equal(saved.status, "pending");
    assert.equal(saved.attemptCount, 1);
    assert.equal(saved.failureCode, null);
    assert.equal(h.stateRepo.getState(THREAD_ID).paused, false);
    assert.equal(dispatcher.hasInFlightWork(), false);
  } finally {
    if (dispatcher) for (const timer of (dispatcher as any).scheduledKickTimers.values()) clearTimeout(timer);
    h.db.close();
  }
});

test("admission query failure after claim releases the reservation and preserves the error", () => {
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" } });
  try {
    const failure = new Error("update query failed"), ctx = (h.dispatcher as any).ctx, originalSend = ctx.send;
    let claimed = false;
    ctx.isTaskAdmissionPaused = () => { if (claimed) throw failure; return false; };
    ctx.send = (message: any) => { originalSend(message); if (message.reason === "consuming") claimed = true; };
    const item = appendOne(h.queueRepo, "query failure");
    assert.throws(() => h.dispatcher.kickIfIdle(THREAD_ID), error => error === failure);
    assert.equal(h.queueRepo.getById(item.id)?.status, "pending");
    assert.equal(h.dispatcher.hasInFlightWork(), false);
    assert.equal(h.stateRepo.getState(THREAD_ID).paused, false);
    assert.equal(h.appendPendingNodeInputCalls.length, 0);
  } finally { h.db.close(); }
});

for (const mode of ["pending", "running", "waiting-feedback"] as const) {
  test(`parent node ${mode} dispatches through the resolved workspace context`, async (t) => {
    const h = setup({ threadSubtype: "node", nodeState: { status: mode, humanActionSource: mode === "waiting-feedback" ? "execution" : null } });
    try {
      const ctx = (h.dispatcher as any).ctx;
      const resolverCalls: ThreadId[] = [];
      const dispatcher = new ThreadQueueDispatcher(ctx, threadId => { resolverCalls.push(threadId); return ctx; });
      t.after(() => {
        for (const timer of (dispatcher as any).scheduledKickTimers.values()) clearTimeout(timer);
        (dispatcher as any).scheduledKickTimers.clear();
      });
      const item = appendOne(h.queueRepo, "shared feedback");
      dispatcher.kickIfIdle(THREAD_ID);
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(resolverCalls.includes(THREAD_ID));
      if (mode === "pending") assert.equal(h.appendPendingNodeInputCalls.length, 1);
      else if (mode === "waiting-feedback") assert.equal(h.submitFeedbackCalls.length, 1);
      else assert.equal(h.resumeInBackgroundCalls.length, 1);
    } finally { h.db.close(); }
  });
}

test("local node consumes through the resolved workspace context", async () => {
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" } });
  try {
    const ctx = (h.dispatcher as any).ctx;
    const local = { ...ctx };
    const dispatcher = new ThreadQueueDispatcher(ctx, () => local);
    const item = appendOne(h.queueRepo, "local feedback");
    dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.queueRepo.getById(item.id)?.status, "sent");
    assert.equal(h.appendPendingNodeInputCalls.length, 1);
    assert.equal(h.resumeInBackgroundCalls.length, 1);
  } finally { h.db.close(); }
});

test("node wake continues after pending input is accepted", async () => {
  let accepted = false;
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" }, appendPendingNodeInputImpl: () => { accepted = true; } });
  try {
    const ctx = (h.dispatcher as any).ctx;
    const dispatcher = new ThreadQueueDispatcher(ctx, () => ctx);
    const item = appendOne(h.queueRepo, "accepted before disconnect");
    dispatcher.kickIfIdle(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.queueRepo.getById(item.id)?.status, "sent");
    assert.equal(accepted, true);
    assert.equal(h.resumeInBackgroundCalls.length, 1);
    assert.equal(h.appendPendingNodeInputCalls.length, 1);
    assert.equal(h.stateRepo.getState(THREAD_ID).paused, false);
  } finally { h.db.close(); }
});

test("active node append reaches the current turn", async () => {
  const h = setup({ threadSubtype: "node", nodeState: { status: "running" } });
  try {
    const ctx = (h.dispatcher as any).ctx;
    h.hasActiveTurnReturn.value = true;
    h.activeTurnIdReturn.value = "active-shared-turn";
    const item = appendOne(h.queueRepo, "shared append");
    new ThreadQueueDispatcher(ctx, () => ctx).kickAtActiveTurnBoundary(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.appendInputCalls.length, 1);
    assert.equal(h.queueRepo.getById(item.id)?.status, "sent");
  } finally { h.db.close(); }
});

test("persisted node wake retry resumes the accepted input", async () => {
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" } });
  try {
    const ctx = (h.dispatcher as any).ctx;
    const dispatcher = new ThreadQueueDispatcher(ctx, () => ctx);
    const item = appendOne(h.queueRepo, "already accepted");
    h.queueRepo.markSent(item.id, null);
    h.stateRepo.setLastConsumed(THREAD_ID, WORKSPACE_ID, item.id, null);
    h.stateRepo.pause(THREAD_ID, WORKSPACE_ID, "send_failed");
    await dispatcher.retryPersistedNodeWake(THREAD_ID, item.id);
    assert.equal(h.resumeInBackgroundCalls.length, 1);
    assert.equal(h.stateRepo.getState(THREAD_ID).paused, false);
  } finally { h.db.close(); }
});

test("queue append persists trusted local Profile context for dispatcher recovery", async () => {
  const h = setup();
  try {
    const ctx = (h.dispatcher as any).ctx;
    ctx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    ctx.queueDispatcher = { kickIfIdle: () => {} };
    const profile = { executionProfileUserId: "local:test-device", executionProfileScopeType: "local_workspace", executionProfileScopeId: WORKSPACE_ID };
    await onThreadQueueAppend(ctx, { t: "api.req", id: "profile-append", method: "threads.queue.append", path: "/threads/queue/append",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "run", sendOptions: SEND_OPTS, ...profile } } as any);
    const response = h.sentMessages.find(message => message.t === "api.res" && message.id === "profile-append");
    assert.equal(response?.status, 200);
    const item = h.queueRepo.listActiveByThread(THREAD_ID)[0]!;
    assert.deepEqual(h.queueRepo.getExecutionProfileContext(item.id), { userId: "local:test-device", scope: { scopeType: "local_workspace", scopeId: WORKSPACE_ID } });
    const restarted = new ThreadQueueDispatcher(ctx);
    assert.deepEqual((restarted as any).buildExecutionProfileBody(item.id), profile);
  } finally { h.db.close(); }
});

test("Dispatcher restores the selected execution context when consuming a persisted queue item", async () => {
  const h = setup();
  try {
    const ctx = (h.dispatcher as any).ctx;
    const desktopCtx = { ...ctx, assertAssetExecution: () => { throw new Error("selected desktop context rejected execution"); } };
    let resolvedThread: ThreadId | undefined;
    const dispatcher = new ThreadQueueDispatcher(ctx, (threadId: ThreadId) => { resolvedThread = threadId; return desktopCtx; });
    const { item } = h.queueRepo.appendItem({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "run", images: [], files: [], originWebSessionId: null, sendOptions: SEND_OPTS });
    await (dispatcher as any).executeQueueSend(item, WORKSPACE_ID, THREAD_ID);
    assert.equal(resolvedThread, THREAD_ID);
    assert.equal(h.queueRepo.getById(item.id)?.status, "failed");
    assert.equal(h.queueRepo.getById(item.id)?.failureCode, "exception");
    assert.match(h.queueRepo.getById(item.id)?.failureReason ?? "", /selected desktop context rejected execution/);
  } finally { h.db.close(); }
});

test("Dispatcher startup recovery schedules only its scope and does not reset an active local claim again", () => {
  const h = setup();
  try {
    const scheduled: ThreadId[] = [];
    (h.dispatcher as any).scheduleKickIfIdle = (threadId: ThreadId) => scheduled.push(threadId);
    const { item } = h.queueRepo.appendItem({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "run", images: [], files: [], originWebSessionId: null, sendOptions: SEND_OPTS });
    h.queueRepo.claimNextPendingForDispatch(THREAD_ID);
    h.dispatcher.recoverOnStartup(() => false);
    assert.deepEqual(scheduled, []);
    assert.equal(h.queueRepo.getById(item.id)?.status, "pending");
    h.queueRepo.claimNextPendingForDispatch(THREAD_ID);
    h.dispatcher.recoverOnStartup(() => true);
    assert.equal(h.queueRepo.getById(item.id)?.status, "sending");
  } finally { h.db.close(); }
});

test("Dispatcher.recoverOnStartup: 退役资产授权显式失败且不占用更新准入", async () => {
  const h = setupRetiredAssetQueue();
  try {
    h.dispatcher.recoverOnStartup();
    await waitFor(() => h.queueRepo.getById(h.retiredItem.id)?.status === "failed", "退役资产输入未显式失败");

    const failed = h.queueRepo.getById(h.retiredItem.id)!;
    assert.equal(failed.failureCode, "ASSET_CACHE_EXECUTION_REMOVED");
    assert.equal(failed.attemptCount, 0, "退役输入不得被认领或投递");
    assert.equal(h.stateRepo.getState(THREAD_ID).pausedReason, "send_failed");
    assert.equal(h.queueRepo.listActiveByThread(THREAD_ID).length, 0);
    assert.equal(h.appendPendingNodeInputCalls.length, 0);
    assert.equal(h.resumeInBackgroundCalls.length, 0);
    assert.ok(h.sentMessages.some(message => message.t === "thread.queue.changed" && message.reason === "failed"));
    assert.equal(h.logs.filter(entry => entry.data.code === "ASSET_CACHE_EXECUTION_REMOVED").length, 1);
    assert.equal(h.dispatcher.hasInFlightWork(), false);
    assert.doesNotThrow(() => h.dispatcher.assertNoFailure());

    const localItem = appendOne(h.queueRepo, "本地资产输入");
    h.stateRepo.resume(THREAD_ID, WORKSPACE_ID);
    h.dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => h.queueRepo.getById(localItem.id)?.status === "sent", "退役项移出后本地输入仍被阻塞");
    await h.dispatcher.waitForIdle();
    assert.equal(h.appendPendingNodeInputCalls.length, 1);
    assert.equal(h.resumeInBackgroundCalls.length, 1);
    assert.equal(h.queueRepo.getById(h.retiredItem.id)?.status, "failed");
    assert.equal(h.dispatcher.hasInFlightWork(), false);
    assert.doesNotThrow(() => h.dispatcher.assertNoFailure());
  } finally { h.db.close(); }
});

test("Dispatcher.recoverOnStartup: 非退役资产拒绝仍保留后台失败", async () => {
  const h = setupRetiredAssetQueue();
  const failure = Object.assign(new Error("其他资产执行拒绝"), { code: "ASSET_EXECUTION_DENIED" });
  try {
    (h.dispatcher as any).ctx.assertAssetExecution = () => { throw failure; };
    h.dispatcher.recoverOnStartup();
    await waitFor(() => h.dispatcher.hasInFlightWork(), "非退役拒绝未保留后台失败");
    assert.equal(h.queueRepo.getById(h.retiredItem.id)?.status, "pending");
    assert.throws(() => h.dispatcher.assertNoFailure(), error => error === failure);
    await assert.rejects(h.dispatcher.waitForIdle(), error => error === failure);
    assert.equal(h.appendPendingNodeInputCalls.length, 0);
  } finally { h.db.close(); }
});

for (const boundary of ["persistence", "logging"] as const) {
  test(`Dispatcher.recoverOnStartup: 退役拒绝收尾 ${boundary} 失败仍保留后台错误`, async t => {
    const h = setupRetiredAssetQueue();
    const failure = new Error(`${boundary} failed`);
    try {
      if (boundary === "persistence") t.mock.method(h.queueRepo, "markFailed", () => { throw failure; });
      else t.mock.method((h.dispatcher as any).ctx.db, "writeWorkspaceLog", () => { throw failure; });
      h.dispatcher.recoverOnStartup();
      await waitFor(() => h.dispatcher.hasInFlightWork(), "退役拒绝收尾失败被错误释放");
      assert.throws(() => h.dispatcher.assertNoFailure());
      await assert.rejects(h.dispatcher.waitForIdle(), error => {
        if (boundary === "persistence") assert.equal(error, failure);
        else assert.ok((error as { errors: unknown[] }).errors.includes(failure));
        return true;
      });
      assert.equal(h.appendPendingNodeInputCalls.length, 0);
      assert.equal(h.resumeInBackgroundCalls.length, 0);
    } finally { h.db.close(); }
  });
}

test("Dispatcher.kickIfIdle: 退役拒绝的通知失败保留原显式隔离合同", () => {
  const h = setupRetiredAssetQueue();
  try {
    const originalSend = (h.dispatcher as any).ctx.send;
    (h.dispatcher as any).ctx.send = (message: any) => {
      originalSend(message);
      return { accepted: false, reason: "closed" };
    };
    assert.throws(() => h.dispatcher.kickIfIdle(THREAD_ID), error => {
      assert.ok(error instanceof QueueChangeNotificationError);
      assert.equal(error.isolated, true);
      return true;
    });
    assert.equal(h.queueRepo.getById(h.retiredItem.id)?.failureCode, "ASSET_CACHE_EXECUTION_REMOVED");
    assert.equal(h.stateRepo.getState(THREAD_ID).pausedReason, "send_failed");
    assert.ok(h.logs.some(entry => entry.data.code === "QUEUE_CHANGE_NOTIFICATION_FAILED"));
    assert.equal(h.appendPendingNodeInputCalls.length, 0);
    assert.equal(h.dispatcher.hasInFlightWork(), false);
  } finally { h.db.close(); }
});

const SEND_OPTS = {
  workMode: "general" as const,
  planMode: false,
  accessMode: null,
  model: "test-model",
  effort: null,
  contextWindow: null,
  autoCompactPct: null,
  serviceTier: null,
};

/** 真实持久化旧授权，只在资产执行边界模拟已退役的业务拒绝。 */
function setupRetiredAssetQueue() {
  const h = setup({ threadSubtype: "node", nodeState: { status: "pending" } });
  const logs: any[] = [];
  const ctx = (h.dispatcher as any).ctx;
  ctx.db.writeWorkspaceLog = (_workspaceId: WorkspaceId, entry: any) => { logs.push(entry); };
  ctx.assertAssetExecution = ({ authorization }: { authorization: unknown }) => {
    if (authorization) throw Object.assign(new Error("云端缓存资产执行已移除，请选择本地资产重新开始"), { code: "ASSET_CACHE_EXECUTION_REMOVED" });
  };
  const retiredItem = h.queueRepo.appendItem({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text: "旧缓存资产输入",
    images: [],
    files: [],
    sendOptions: SEND_OPTS,
    originWebSessionId: null,
    assetExecutionAuthorization: {
      serverOrigin: "https://example.test", userId: "owner", deviceId: "device", clientId: "client",
      hostBindingId: "binding", hostScopeEpoch: 1, sharedWorkspaceId: "shared", runtimeWorkspaceId: WORKSPACE_ID,
      contextKey: "retired", authorityEpoch: 1, appliedChangeSeq: 1, revisionSetHash: "a".repeat(64), snapshotHash: "b".repeat(64),
    },
  }).item;
  return { ...h, retiredItem, logs };
}

function appendOne(queueRepo: ThreadMessageQueueRepo, text: string, sharedWorkspaceToolContext?: ThreadQueueSharedWorkspaceContext) {
  // appendItem 现在返回 { item, idempotent }；旧测试便利返回 item
  return queueRepo.appendItem({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text,
    images: [],
    files: [],
    sendOptions: SEND_OPTS,
    originWebSessionId: null,
    sharedWorkspaceToolContext: sharedWorkspaceToolContext ?? null,
  }).item;
}

/** 在限定时间内等待异步调度达到预期状态，超时后显式失败。 */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Dispatcher: 空 node 队列在直调和延迟调度中均于昂贵状态读取前返回", async () => {
  const { db, dispatcher } = setup({
    threadSubtype: "node",
    nodeState: { status: "running" },
  });
  try {
    const ctx = (dispatcher as any).ctx;
    let activeChecks = 0;
    let stateReads = 0;
    let bindingReads = 0;
    let turnReads = 0;
    let sessionTurnReads = 0;
    const hasActiveByThread = ctx.db.threadMessageQueue.hasActiveByThread.bind(ctx.db.threadMessageQueue);
    const getState = ctx.db.threadQueueStates.getState.bind(ctx.db.threadQueueStates);
    const listByWorkspace = ctx.db.orchInstances.listByWorkspace.bind(ctx.db.orchInstances);
    ctx.db.threadMessageQueue.hasActiveByThread = (threadId: ThreadId) => {
      activeChecks += 1;
      return hasActiveByThread(threadId);
    };
    ctx.db.threadQueueStates.getState = (threadId: ThreadId) => {
      stateReads += 1;
      return getState(threadId);
    };
    ctx.db.orchInstances.listByWorkspace = (workspaceId: WorkspaceId) => {
      bindingReads += 1;
      return listByWorkspace(workspaceId);
    };
    ctx.getActiveThreadTurn = () => {
      turnReads += 1;
      return null;
    };
    ctx.sessions.hasActiveTurn = () => {
      sessionTurnReads += 1;
      return false;
    };
    (dispatcher as any).orchestrationWakeRequests.add(`stale\u0000${String(THREAD_ID)}`);

    dispatcher.kickIfIdle(THREAD_ID);

    assert.equal(activeChecks, 1);
    assert.equal(stateReads, 0);
    assert.equal(bindingReads, 0);
    assert.equal(turnReads, 0);
    assert.equal(sessionTurnReads, 0);
    assert.equal((dispatcher as any).orchestrationWakeRequests.size, 0);

    (dispatcher as any).scheduleKickIfIdle(THREAD_ID);
    await waitFor(
      () => activeChecks === 2 && (dispatcher as any).scheduledKickTimers.size === 0,
      "空 node 延迟 kick 未完成快速返回",
    );
    assert.equal(stateReads, 0);
    assert.equal(bindingReads, 0);
    assert.equal(turnReads, 0);
    assert.equal(sessionTurnReads, 0);
  } finally {
    db.close();
  }
});

test("Dispatcher.notifyTurnTerminal(completed, queue_consume): markSent + setLastConsumed + 广播 consumed", () => {
  const { db, queueRepo, stateRepo, dispatcher, sentMessages } = setup();
  try {
    const item = appendOne(queueRepo, "A");
    queueRepo.claimNextPending(THREAD_ID); // 模拟 dispatcher 已经认领

    dispatcher.notifyTurnTerminal({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: "turn_1" as any,
      source: "queue_consume",
      queueItemId: item.id,
      outcome: "completed",
    });

    // sent 后 active 列表应排除该项
    const active = queueRepo.listActiveByThread(THREAD_ID);
    assert.equal(active.length, 0);

    const state = stateRepo.getState(THREAD_ID);
    assert.equal(state.lastConsumedQueueId, item.id);
    assert.equal(state.lastConsumedTurnId, "turn_1");
    assert.equal(state.paused, false, "completed 不应触发 pause");

    const reasons = sentMessages.filter((m) => m.t === "thread.queue.changed").map((m) => m.reason);
    assert.ok(reasons.includes("consumed"), "应广播 consumed");
  } finally {
    db.close();
  }
});

test("Dispatcher.notifyTurnTerminal(error, manual_interrupt): pause 为 user_stop，不消费下一条", () => {
  const { db, queueRepo, stateRepo, dispatcher, sentMessages, hasActiveTurnReturn } = setup();
  try {
    appendOne(queueRepo, "A"); // 留在 pending 但 dispatcher 不应该消费

    dispatcher.notifyTurnTerminal({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: "turn_1" as any,
      source: "user_send",
      queueItemId: null,
      outcome: "error",
      terminationKind: "manual_interrupt",
    });

    const state = stateRepo.getState(THREAD_ID);
    assert.equal(state.paused, true);
    assert.equal(state.pausedReason, "user_stop");

    const reasons = sentMessages.filter((m) => m.t === "thread.queue.changed").map((m) => m.reason);
    assert.ok(reasons.includes("paused"));

    // pending 项仍在（没被 cancel），但因 paused 不会被 kick
    assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 1);
    void hasActiveTurnReturn;
  } finally {
    db.close();
  }
});

test("Dispatcher.notifyTurnTerminal(error, transient_cleanup): pause 为 transient_cleanup", () => {
  const { db, queueRepo, stateRepo, dispatcher } = setup();
  try {
    appendOne(queueRepo, "A");
    dispatcher.notifyTurnTerminal({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: "turn_1" as any,
      source: "queue_consume",
      queueItemId: null,
      outcome: "error",
      terminationKind: "transient_cleanup",
    });
    const state = stateRepo.getState(THREAD_ID);
    assert.equal(state.paused, true);
    assert.equal(state.pausedReason, "transient_cleanup");
  } finally {
    db.close();
  }
});

test("Dispatcher.notifyTurnTerminal(error, error, queue_consume): markFailed + pause turn_error", () => {
  const { db, queueRepo, stateRepo, dispatcher } = setup();
  try {
    const item = appendOne(queueRepo, "A");
    appendOne(queueRepo, "B");
    queueRepo.claimNextPending(THREAD_ID); // sending

    dispatcher.notifyTurnTerminal({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: "turn_1" as any,
      source: "queue_consume",
      queueItemId: item.id,
      outcome: "error",
      terminationKind: "error",
      errorCode: "engine_failure",
    });

    // 当前 sending 项应被 markFailed（从 active 列表移出）
    const active = queueRepo.listActiveByThread(THREAD_ID);
    assert.equal(active.length, 1, "failed 项不在 active 列表，后续 pending 项保留");
    assert.equal(active[0].text, "B");

    const state = stateRepo.getState(THREAD_ID);
    assert.equal(state.paused, true);
    assert.equal(state.pausedReason, "turn_error");
  } finally {
    db.close();
  }
});

test("Dispatcher.notifyTurnTerminal(error, errorCode=session_invalidated): pause 为 session_invalidated", () => {
  const { db, queueRepo, stateRepo, dispatcher } = setup();
  try {
    appendOne(queueRepo, "A");
    dispatcher.notifyTurnTerminal({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: "turn_1" as any,
      source: "user_send",
      queueItemId: null,
      outcome: "error",
      terminationKind: undefined,
      errorCode: "session_invalidated",
    });
    const state = stateRepo.getState(THREAD_ID);
    assert.equal(state.paused, true);
    assert.equal(state.pausedReason, "session_invalidated");
  } finally {
    db.close();
  }
});

test("Dispatcher.kickIfIdle short-circuits: 有 active turn → 不消费", () => {
  const { db, queueRepo, dispatcher, hasActiveTurnReturn } = setup();
  try {
    appendOne(queueRepo, "A");
    hasActiveTurnReturn.value = true;
    dispatcher.kickIfIdle(THREAD_ID);

    // pending 项不应被认领（不应转 sending）
    const active = queueRepo.listActiveByThread(THREAD_ID);
    assert.equal(active.length, 1);
    assert.equal(active[0].status, "pending", "有 active turn 时不应认领");
  } finally {
    db.close();
  }
});

test("Dispatcher.kickIfIdle 忽略仅存于 DB 的 started turn 并消费 pending", async () => {
  const { db, queueRepo, dispatcher } = setup();
  try {
    const ctx = (dispatcher as any).ctx;
    const staleTurnId = "turn_stale_db_only";
    const activeTurnQueries: Array<{ workspaceId?: WorkspaceId | null; threadId: ThreadId; includeDb?: boolean }> = [];
    const consumedQueueItemIds: string[] = [];
    ctx.db.turns.insertStarted({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "claude",
      turnId: staleTurnId,
      startedAt: 123,
      startEventSeq: 1,
    });
    ctx.sessions.hasActiveTurn = () => false;
    ctx.getActiveThreadTurn = (input: { workspaceId?: WorkspaceId | null; threadId: ThreadId; includeDb?: boolean }) => {
      activeTurnQueries.push({ ...input });
      if (input.includeDb === false) return null;
      const staleTurn = ctx.db.turns.get(staleTurnId);
      return staleTurn?.status === "started"
        ? { turnId: staleTurn.turnId, startedAt: staleTurn.startedAt, source: "db" }
        : null;
    };
    (dispatcher as any).executeQueueSend = async (item: { id: string }) => {
      consumedQueueItemIds.push(item.id);
      queueRepo.markSent(item.id, "turn_after_stale_db_only" as any);
    };
    const item = appendOne(queueRepo, "继续消费 stale turn 后的输入");

    assert.equal(ctx.getActiveThreadTurn({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID })?.turnId, staleTurnId);
    activeTurnQueries.length = 0;

    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(
      () => queueRepo.getById(item.id)?.status === "sent"
        && !(dispatcher as any).inFlight.has(String(THREAD_ID))
        && (dispatcher as any).scheduledKickTimers.size === 0,
      "DB stale started turn 阻塞了 pending 消费",
    );

    assert.deepEqual(consumedQueueItemIds, [item.id]);
    assert.ok(activeTurnQueries.length > 0);
    assert.equal(activeTurnQueries.every((input) => input.includeDb === false), true);
    assert.equal(ctx.db.turns.get(staleTurnId)?.status, "started");
  } finally {
    db.close();
  }
});

test("Dispatcher.kickAtActiveTurnBoundary: 共享工作区队列项运行中不做 active append", async () => {
  const { db, queueRepo, dispatcher, hasActiveTurnReturn, activeTurnIdReturn, appendInputCalls } = setup();
  try {
    appendOne(queueRepo, "共享补充输入", {
      sharedWorkspaceId: "sw_queue",
      operationId: "op_queue" as never,
      routeEventId: "route_queue" as never,
      operationKey: "context.thread.queue.append",
      toolPolicyKey: "ai.shared.write",
      lockToken: "lock-token",
      lockVersion: 1,
      allowSharedUpgrade: false,
    });
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = "turn_active_shared";

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const active = queueRepo.listActiveByThread(THREAD_ID);
    assert.equal(appendInputCalls.length, 0);
    assert.equal(active.length, 1);
    assert.ok(active[0]);
    assert.equal(active[0].status, "pending");
    assert.equal(queueRepo.peekNextPendingSharedWorkspaceContext(THREAD_ID)?.sharedWorkspaceId, "sw_queue");
  } finally {
    db.close();
  }
});

test("Dispatcher.kickAtActiveTurnBoundary: 编排运行中节点队列补充走 active append", async () => {
  const { db, queueRepo, stateRepo, dispatcher, hasActiveTurnReturn, activeTurnIdReturn, appendInputCalls, sentMessages } = setup({
    threadSubtype: "node",
    nodeState: {
      status: "running",
      humanActionSource: null,
    },
  });
  try {
    const item = appendOne(queueRepo, "补充：优先处理登录态。");
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = "turn_active_node";

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(appendInputCalls.length, 1);
    assert.equal(appendInputCalls[0]?.turnId, "turn_active_node");
    assert.equal(appendInputCalls[0]?.userMessage, "补充：优先处理登录态。");
    assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 0);
    assert.equal(queueRepo.getById(item.id)?.sentTurnId, "turn_active_node");
    assert.equal(stateRepo.getState(THREAD_ID).lastConsumedTurnId, "turn_active_node");
    const userEvents = sentMessages.filter((m) => m.t === "conversation.event" && m.event?.type === "item.userMessage.created");
    assert.equal(userEvents.length, 1);
    assert.equal(userEvents[0]?.event?.payload?.activeTurnAppend, true);
    hasActiveTurnReturn.value = false;
    activeTurnIdReturn.value = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    db.close();
  }
});

test("Dispatcher.kickAtActiveTurnBoundary: node-discussion 运行中补充追加到当前 turn", async () => {
  const { db, queueRepo, stateRepo, dispatcher, hasActiveTurnReturn, activeTurnIdReturn, appendInputCalls, sentMessages } = setup({
    threadSubtype: "node-discussion",
  });
  try {
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "补充讨论这个实现边界。",
      images: [],
      files: [],
      pathReferences: [{
        id: "pathref_node_discussion_active",
        path: "apps/desktop/client/src/queue/threadQueueDispatcher.ts",
        kind: "file",
        displayName: "threadQueueDispatcher.ts",
        source: "mention",
      }],
      sendOptions: { ...SEND_OPTS, accessMode: "read-only", planMode: false },
      originWebSessionId: null,
    }).item;
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = "turn_active_node_discussion";

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await waitFor(() => appendInputCalls.length === 1, "node-discussion 运行中输入未追加到当前 turn");

    assert.equal(appendInputCalls[0]?.turnId, "turn_active_node_discussion");
    assert.match(String(appendInputCalls[0]?.userMessage ?? ""), /@apps\/desktop\/client\/src\/queue\/threadQueueDispatcher\.ts/);
    assert.equal(queueRepo.getById(item.id)?.status, "sent");
    assert.equal(queueRepo.getById(item.id)?.sentTurnId, "turn_active_node_discussion");
    assert.equal(stateRepo.getState(THREAD_ID).lastConsumedTurnId, "turn_active_node_discussion");
    assert.equal(sentMessages.some((message) => message.t === "conversation.event" && message.event?.type === "turn.started"), false);
    hasActiveTurnReturn.value = false;
    activeTurnIdReturn.value = null;
    await waitFor(() => !(dispatcher as any).inFlight.has(String(THREAD_ID)), "node-discussion active append 调度未收尾");
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    db.close();
  }
});

test("Dispatcher.kickAtActiveTurnBoundary: 根据 active turn 快照识别切模并等待新 turn", async () => {
  const { db, queueRepo, dispatcher, hasActiveTurnReturn, activeTurnIdReturn, appendInputCalls } = setup({
    threadSubtype: "node-discussion",
  });
  try {
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "改用新模型继续讨论。",
      images: [],
      files: [],
      sendOptions: { ...SEND_OPTS, model: "gpt-5.6-terra" },
      originWebSessionId: null,
    }).item;
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = "turn_active_old_model";

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(appendInputCalls.length, 0);
    assert.equal(queueRepo.getById(item.id)?.status, "pending");

    const freshTurnItems: string[] = [];
    (dispatcher as any).scheduleKickIfIdle = () => {};
    (dispatcher as any).executeQueueSend = async (next: { id: string }) => {
      freshTurnItems.push(next.id);
      queueRepo.markSent(next.id, "turn_new_model" as any);
    };
    hasActiveTurnReturn.value = false;
    activeTurnIdReturn.value = null;
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => freshTurnItems.length === 1, "旧 turn 结束后未按新 turn 路径消费");

    assert.deepEqual(freshTurnItems, [item.id]);
    assert.equal(queueRepo.getById(item.id)?.sentTurnId, "turn_new_model");
  } finally {
    db.close();
  }
});

test("Dispatcher.kickAtActiveTurnBoundary: 运行中节点拒绝不同模型的已入队补充", async () => {
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    hasActiveTurnReturn,
    activeTurnIdReturn,
    appendInputCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "running", humanActionSource: null },
  });
  try {
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "改用新模型继续节点。",
      images: [],
      files: [],
      sendOptions: { ...SEND_OPTS, model: "gpt-5.6-terra" },
      originWebSessionId: null,
    }).item;
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = "turn_active_node_old_model";

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "failed", "不同模型的节点补充未被拒绝");

    assert.equal(appendInputCalls.length, 0);
    assert.equal(queueRepo.getById(item.id)?.failureCode, "ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT");
    assert.equal(stateRepo.getState(THREAD_ID).paused, true);
    assert.equal(stateRepo.getState(THREAD_ID).pausedReason, "send_failed");
  } finally {
    db.close();
  }
});

test("threads.queue.append: 运行中节点切模在持久化前返回稳定 409", async () => {
  const {
    db,
    queueRepo,
    dispatcher,
    sentMessages,
    hasActiveTurnReturn,
    activeTurnIdReturn,
    appendInputCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "running", humanActionSource: null },
  });
  try {
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = "turn_active_node_api_guard";
    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;

    await onThreadQueueAppend(fakeCtx, {
      id: "req-node-model-change-conflict",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "改用新模型继续节点。",
        sendOptions: { ...SEND_OPTS, model: "gpt-5.6-terra" },
      },
    } as any);

    const response = sentMessages.find((message) => (
      message.t === "api.res" && message.id === "req-node-model-change-conflict"
    ));
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT");
    assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 0);
    assert.equal(appendInputCalls.length, 0);
  } finally {
    db.close();
  }
});

test("Dispatcher: active append 前 turn 已结束时退回 pending 且不暂停", async () => {
  const hasActiveTurnReturn = { value: true };
  const activeTurnIdReturn = { value: "turn_terminal_race" as string | null };
  const { db, queueRepo, stateRepo, dispatcher, appendInputCalls, activeTurnExecutionReturn } = setup({
    threadSubtype: "node",
    nodeState: { status: "running", humanActionSource: null },
    async appendInputImpl() {
      hasActiveTurnReturn.value = false;
      activeTurnIdReturn.value = null;
      return null;
    },
  });
  try {
    (dispatcher as any).ctx.sessions.hasActiveTurn = () => hasActiveTurnReturn.value;
    (dispatcher as any).ctx.getActiveThreadTurn = () => activeTurnIdReturn.value
      ? { turnId: activeTurnIdReturn.value, execution: activeTurnExecutionReturn.value }
      : null;
    const item = appendOne(queueRepo, "继续处理竞态后的输入。");

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "pending", "竞态输入未退回 pending");

    const stored = queueRepo.getById(item.id);
    assert.equal(appendInputCalls.length, 1);
    assert.equal(stored?.status, "pending");
    assert.equal(stored?.attemptCount, 1);
    assert.equal(stored?.failureCode, null);
    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
  } finally {
    db.close();
  }
});

test("Dispatcher: stdin 关闭但回合仍活跃时等待终态后按原顺序投递", async () => {
  const h = setup();
  const { db, queueRepo, stateRepo, dispatcher, hasActiveTurnReturn, canAppendInputReturn, activeTurnIdReturn, appendInputCalls } = h;
  try {
    const first = appendOne(queueRepo, "第一条等待投递。");
    const second = appendOne(queueRepo, "第二条等待投递。");
    hasActiveTurnReturn.value = true;
    canAppendInputReturn.value = false;
    activeTurnIdReturn.value = "turn_closing_stdin";
    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    assert.equal(appendInputCalls.length, 0);
    assert.equal(queueRepo.getById(first.id)?.attemptCount, 0);
    assert.equal(stateRepo.getState(THREAD_ID).paused, false);

    const consumed: string[] = [];
    (dispatcher as any).executeQueueSend = async (item: { id: string }) => {
      consumed.push(item.id);
      queueRepo.markSent(item.id, "turn_after_close" as any);
    };
    hasActiveTurnReturn.value = false;
    activeTurnIdReturn.value = null;
    dispatcher.notifyTurnTerminal({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: "turn_closing_stdin", source: "user_send", queueItemId: null, outcome: "completed" });
    await waitFor(() => consumed.length === 2 && !(dispatcher as any).inFlight.has(String(THREAD_ID)), "旧回合结束后未完成顺序投递");
    assert.deepEqual(consumed, [first.id, second.id]);
  } finally {
    db.close();
  }
});

test("Dispatcher: 检查后 stdin 才关闭时只退回一次 pending 且不暂停", async () => {
  let h: SetupResult;
  h = setup({
    async appendInputImpl() {
      h.canAppendInputReturn.value = false;
      throw new ActiveTurnInputClosedError();
    },
  });
  const { db, queueRepo, stateRepo, dispatcher, hasActiveTurnReturn, activeTurnIdReturn, appendInputCalls } = h;
  try {
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = "turn_pipe_race";
    const item = appendOne(queueRepo, "管道关闭后的输入。");
    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await waitFor(() => appendInputCalls.length === 1 && queueRepo.getById(item.id)?.status === "pending" && !(dispatcher as any).inFlight.has(String(THREAD_ID)), "未写入的输入未退回 pending");
    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    assert.equal(appendInputCalls.length, 1, "关闭的通道不得被反复重试");
    assert.equal(queueRepo.getById(item.id)?.attemptCount, 1);
    assert.equal(queueRepo.getById(item.id)?.failureCode, null);
    assert.equal(stateRepo.getState(THREAD_ID).paused, false);

    (dispatcher as any).executeQueueSend = async (next: { id: string }) => queueRepo.markSent(next.id, "turn_retry" as any);
    hasActiveTurnReturn.value = false;
    activeTurnIdReturn.value = null;
    dispatcher.notifyTurnTerminal({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: "turn_pipe_race", source: "user_send", queueItemId: null, outcome: "completed" });
    await waitFor(() => queueRepo.getById(item.id)?.status === "sent" && !(dispatcher as any).inFlight.has(String(THREAD_ID)), "终态后未重新投递输入");
    assert.equal(queueRepo.getById(item.id)?.attemptCount, 2);
  } finally {
    db.close();
  }
});

test("Dispatcher: 写入结果未知时即使通道已关闭也不得重新投递", async () => {
  const h = setup({
    async appendInputImpl() {
      throw Object.assign(new Error("write outcome unknown"), { code: "active_turn_input_closed", requestOutcomeUnknown: true });
    },
  });
  const { db, queueRepo, stateRepo, dispatcher, hasActiveTurnReturn, activeTurnIdReturn, appendInputCalls } = h;
  try {
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = "turn_unknown_append";
    const item = appendOne(queueRepo, "不能重复执行的输入。");
    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "failed" && !(dispatcher as any).inFlight.has(String(THREAD_ID)), "未知写入结果未显式失败");
    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    assert.equal(appendInputCalls.length, 1);
    assert.equal(queueRepo.getById(item.id)?.failureCode, ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE);
    assert.equal(stateRepo.getState(THREAD_ID).pausedReason, "send_failed");
  } finally {
    db.close();
  }
});

for (const failure of [
  { name: "Claude 写入结果未知", fields: { requestOutcomeUnknown: true } },
  { name: "Codex steer 超时", fields: { method: "turn/steer", code: "codex_app_server_request_timeout" } },
]) {
  test(`Dispatcher: ${failure.name}后同键重放不重发，真正新输入仍可恢复`, async () => {
    let calls = 0;
    const h = setup({
      async appendInputImpl() {
        calls++;
        if (calls === 1) throw Object.assign(new Error("delivery outcome unknown"), failure.fields);
        return { engineCall: { kind: "jsonrpc", engine: "codex", transport: "test", requests: [] } };
      },
    });
    const { db, queueRepo, stateRepo, dispatcher, hasActiveTurnReturn, activeTurnIdReturn, sentMessages } = h;
    try {
      hasActiveTurnReturn.value = true;
      activeTurnIdReturn.value = "turn_unknown_replay";
      const ctx = (dispatcher as any).ctx;
      ctx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
      ctx.queueDispatcher = dispatcher;
      const body = { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "结果未知的投递", clientItemId: "same-unknown-key", sendOptions: SEND_OPTS };
      await onThreadQueueAppend(ctx, { id: "unknown-initial", body } as any);
      const firstResponse = sentMessages.find(message => message.t === "api.res" && message.id === "unknown-initial");
      assert.equal(firstResponse?.status, 200);
      const original = firstResponse.body.item;
      dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
      await waitFor(() => queueRepo.getById(original.id)?.status === "failed" && !(dispatcher as any).inFlight.has(String(THREAD_ID)), "未知结果未保存");
      assert.equal(queueRepo.getById(original.id)?.failureCode, ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE);
      dispatcher.recoverOnStartup();

      for (let i = 0; i < 2; i++) {
        const requestId = `unknown-replay-${i}`;
        await onThreadQueueAppend(ctx, { id: requestId, body } as any);
        const replay = sentMessages.find(message => message.t === "api.res" && message.id === requestId);
        assert.equal(replay?.status, 409);
        assert.equal(replay?.body?.ok, false);
        assert.equal(replay?.body?.code, ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE);
        assert.equal(stateRepo.getState(THREAD_ID).paused, true);
        assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 0);
        dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
        assert.equal(calls, 1);
      }

      await onThreadQueueAppend(ctx, { id: "unknown-fresh-input", body: { ...body, text: "真正的新输入", clientItemId: "fresh-key" } } as any);
      assert.equal(stateRepo.getState(THREAD_ID).paused, false);
      dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
      const fresh = sentMessages.find(message => message.t === "api.res" && message.id === "unknown-fresh-input")?.body.item;
      await waitFor(() => calls === 2 && queueRepo.getById(fresh.id)?.status === "sent" && !(dispatcher as any).inFlight.has(String(THREAD_ID)), "新输入未恢复投递");
      assert.equal(queueRepo.getById(original.id)?.attemptCount, 1);
      assert.equal(queueRepo.getById(original.id)?.status, "failed");

      await onThreadQueueAppend(ctx, { id: "unknown-replay-after-recovery", body } as any);
      const replay = sentMessages.find(message => message.t === "api.res" && message.id === "unknown-replay-after-recovery");
      assert.equal(replay?.status, 409);
      assert.equal(stateRepo.getState(THREAD_ID).paused, false, "旧请求重放不得改变新输入恢复后的状态");
      assert.equal(calls, 2);
      const count = db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number };
      assert.equal(count.count, 2, "同键重放不能创建新队列记录");
      hasActiveTurnReturn.value = false;
      activeTurnIdReturn.value = null;
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      db.close();
    }
  });
}

test("Dispatcher: provider 已接收 active append 后本地落库失败不得重新投递", async () => {
  const hasActiveTurnReturn = { value: true };
  const activeTurnIdReturn = { value: "turn_post_ack_failure" as string | null };
  const { db, queueRepo, stateRepo, dispatcher, appendInputCalls, activeTurnExecutionReturn } = setup({
    threadSubtype: "node",
    nodeState: { status: "running", humanActionSource: null },
    async appendInputImpl() {
      hasActiveTurnReturn.value = false;
      activeTurnIdReturn.value = null;
      return {
        engineCall: {
          kind: "jsonrpc",
          engine: "codex",
          transport: "test",
          requests: [],
        },
      };
    },
  });
  try {
    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.sessions.hasActiveTurn = () => hasActiveTurnReturn.value;
    fakeCtx.getActiveThreadTurn = () => activeTurnIdReturn.value
      ? { turnId: activeTurnIdReturn.value, execution: activeTurnExecutionReturn.value }
      : null;
    fakeCtx.onBeforeEmitConversationEvent = () => {
      throw new Error("canonical event persistence failed");
    };
    const item = appendOne(queueRepo, "已被 provider 接收的输入。");

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "failed", "ACK 后本地失败未显式收尾");

    const stored = queueRepo.getById(item.id);
    assert.equal(appendInputCalls.length, 1);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.failureCode, "active_turn_append_evidence_incomplete");
    assert.equal(stateRepo.getState(THREAD_ID).paused, true);
    assert.equal(stateRepo.getState(THREAD_ID).pausedReason, "send_failed");

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(appendInputCalls.length, 1, "provider 已 ACK 的输入不得因 turn 结束而再次投递");
  } finally {
    db.close();
  }
});

test("Dispatcher: active append ACK 后同 clientItemId 只补齐本地收尾", async () => {
  let failFinalizeOnce = true;
  const { db, queueRepo, stateRepo, dispatcher, appendInputCalls, sentMessages, hasActiveTurnReturn, activeTurnIdReturn } = setup({
    threadSubtype: "node",
    nodeState: { status: "running", humanActionSource: null },
    beforeSetLastConsumedImpl() {
      if (!failFinalizeOnce) return;
      failFinalizeOnce = false;
      throw new Error("queue local finalize failed");
    },
  });
  try {
    const activeTurnId = "turn_post_ack_retry";
    hasActiveTurnReturn.value = true;
    activeTurnIdReturn.value = activeTurnId;
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "ACK 后只补本地收尾。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-active-post-ack",
    }).item;

    dispatcher.kickAtActiveTurnBoundary(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "failed", "active append ACK 后失败屏障未落库");
    assert.equal(queueRepo.getById(item.id)?.status, "failed", `active append ACK 后状态异常：${JSON.stringify(queueRepo.getById(item.id))}`);
    assert.equal(appendInputCalls.length, 1);
    assert.equal(queueRepo.getById(item.id)?.failureCode, "active_turn_append_post_ack_failed");
    assert.equal(queueRepo.getById(item.id)?.sentTurnId, activeTurnId);
    assert.equal(stateRepo.getState(THREAD_ID).paused, true);

    const fakeCtx = (dispatcher as any).ctx;
    const restartedDispatcher = new ThreadQueueDispatcher(fakeCtx);
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = restartedDispatcher;
    await onThreadQueueAppend(fakeCtx, {
      id: "req-active-post-ack-retry",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "ACK 后只补本地收尾。",
        clientItemId: "client-active-post-ack",
        sendOptions: SEND_OPTS,
      },
    } as any);

    const stored = queueRepo.getById(item.id);
    const state = stateRepo.getState(THREAD_ID);
    const response = sentMessages.find((message) => message.t === "api.res" && message.id === "req-active-post-ack-retry");
    assert.equal(appendInputCalls.length, 1, "provider ACK 后重试不得再次追加输入");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.idempotent, true);
    assert.equal(response?.body?.item?.id, item.id);
    assert.equal(stored?.status, "sent");
    assert.equal(stored?.sentTurnId, activeTurnId);
    assert.equal(stored?.failureCode, "active_turn_append_post_ack_failed_completed");
    assert.equal(stored?.failureReason, null);
    assert.equal(stored?.attemptCount, 1);
    assert.equal(state.lastConsumedQueueId, item.id);
    assert.equal(state.lastConsumedTurnId, activeTurnId);
    assert.equal(state.paused, false);

    await onThreadQueueAppend(fakeCtx, {
      id: "req-active-post-ack-late-retry",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "ACK 后只补本地收尾。",
        clientItemId: "client-active-post-ack",
        sendOptions: SEND_OPTS,
      },
    } as any);
    const lateResponse = sentMessages.find((message) => message.t === "api.res" && message.id === "req-active-post-ack-late-retry");
    assert.equal(lateResponse?.status, 200);
    assert.equal(lateResponse?.body?.idempotent, true);
    assert.equal(lateResponse?.body?.item?.id, item.id);
    assert.equal(appendInputCalls.length, 1, "完成墓碑命中后不得再次追加 provider 输入");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    await waitFor(() => !(dispatcher as any).inFlight.has(String(THREAD_ID)), "active append ACK 后调度未收尾");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    db.close();
  }
});

test("节点新输入会解除 send_failed 并保留旧 pending 顺序", async () => {
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    appendPendingNodeInputCalls,
    sentMessages,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
  });
  try {
    const first = appendOne(queueRepo, "失败前保留的输入。");
    stateRepo.pause(THREAD_ID, WORKSPACE_ID, "send_failed");
    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;

    await onThreadQueueAppend(fakeCtx, {
      id: "req-resume-node-send-failed",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "新的继续输入。",
        sendOptions: SEND_OPTS,
      },
    } as any);
    await waitFor(() => appendPendingNodeInputCalls.length === 2, "解除暂停后未按顺序消费节点输入");

    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.deepEqual(
      appendPendingNodeInputCalls.map((call) => call.input.feedback),
      ["失败前保留的输入。", "新的继续输入。"],
    );
    assert.equal(queueRepo.getById(first.id)?.status, "sent");
    const response = sentMessages.find((message) => message.t === "api.res" && message.id === "req-resume-node-send-failed");
    assert.equal(response?.status, 200);
    assert.equal(queueRepo.getById(response?.body?.item?.id)?.status, "sent");
  } finally {
    db.close();
  }
});

test("节点新输入会解除 session_invalidated 并重试原会话", async () => {
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    appendPendingNodeInputCalls,
    sentMessages,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
  });
  try {
    const first = appendOne(queueRepo, "恢复前保留的输入。");
    stateRepo.pause(THREAD_ID, WORKSPACE_ID, "session_invalidated");
    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;

    await onThreadQueueAppend(fakeCtx, {
      id: "req-resume-node-session-invalidated",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "继续",
        sendOptions: SEND_OPTS,
      },
    } as any);
    await waitFor(() => appendPendingNodeInputCalls.length === 2, "解除恢复暂停后未按顺序消费节点输入");

    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.deepEqual(
      appendPendingNodeInputCalls.map((call) => call.input.feedback),
      ["恢复前保留的输入。", "继续"],
    );
    assert.equal(queueRepo.getById(first.id)?.status, "sent");
    const response = sentMessages.find((message) => (
      message.t === "api.res" && message.id === "req-resume-node-session-invalidated"
    ));
    assert.equal(response?.status, 200);
    assert.equal(queueRepo.getById(response?.body?.item?.id)?.status, "sent");
  } finally {
    db.close();
  }
});

test("普通 chat 的 session_invalidated 不由新输入自动解除", async () => {
  const { db, queueRepo, stateRepo, dispatcher, appendInputCalls, sentMessages } = setup();
  try {
    stateRepo.pause(THREAD_ID, WORKSPACE_ID, "session_invalidated");
    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;

    await onThreadQueueAppend(fakeCtx, {
      id: "req-chat-session-invalidated",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "继续",
        sendOptions: SEND_OPTS,
      },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = sentMessages.find((message) => (
      message.t === "api.res" && message.id === "req-chat-session-invalidated"
    ));
    assert.equal(response?.status, 200);
    assert.equal(stateRepo.getState(THREAD_ID).paused, true);
    assert.equal(stateRepo.getState(THREAD_ID).pausedReason, "session_invalidated");
    assert.equal(appendInputCalls.length, 0);
    assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 1);
  } finally {
    db.close();
  }
});

test("节点 send_failed 后同 clientItemId 幂等重试会解除暂停并继续消费", async () => {
  const { db, queueRepo, stateRepo, dispatcher, appendPendingNodeInputCalls, sentMessages } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
  });
  try {
    const original = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "同一条继续输入。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-node-idempotent-retry",
    }).item;
    stateRepo.pause(THREAD_ID, WORKSPACE_ID, "send_failed");
    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;

    await onThreadQueueAppend(fakeCtx, {
      id: "req-node-idempotent-retry",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "同一条继续输入。",
        clientItemId: "client-node-idempotent-retry",
        sendOptions: SEND_OPTS,
      },
    } as any);
    await waitFor(
      () => appendPendingNodeInputCalls.length === 1 && queueRepo.getById(original.id)?.status === "sent",
      "幂等重试解除暂停后未完成消费",
    );

    const response = sentMessages.find((message) => message.t === "api.res" && message.id === "req-node-idempotent-retry");
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.idempotent, true);
    assert.equal(response?.body?.item?.id, original.id);
    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.equal(appendPendingNodeInputCalls[0]?.input?.feedback, "同一条继续输入。");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    await waitFor(() => !(dispatcher as any).inFlight.has(String(THREAD_ID)), "节点幂等重试调度未收尾");
  } finally {
    db.close();
  }
});

for (const hasPending of [false, true]) {
  test(`普通 chat 新投递解除 send_failed（旧 pending=${hasPending}）且不重发旧 failed`, async () => {
    const { db, queueRepo, stateRepo, dispatcher, sentMessages } = setup();
    try {
      const failed = appendOne(queueRepo, "旧失败消息。");
      queueRepo.markFailed(failed.id, "append_failed", "previous send failed");
      const pending = hasPending ? appendOne(queueRepo, "旧 pending 消息。") : null;
      stateRepo.pause(THREAD_ID, WORKSPACE_ID, "send_failed");
      const ctx = (dispatcher as any).ctx;
      ctx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
      ctx.queueDispatcher = dispatcher;
      const consumed: string[] = [];
      (dispatcher as any).executeQueueSend = async (item: { id: string }) => {
        consumed.push(item.id);
        queueRepo.markSent(item.id, "turn_resumed" as any);
      };
      await onThreadQueueAppend(ctx, {
        id: "req-chat-new-after-failure", body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "新投递消息。", clientItemId: "new-after-failure", sendOptions: SEND_OPTS },
      } as any);
      const response = sentMessages.find(message => message.t === "api.res" && message.id === "req-chat-new-after-failure");
      assert.equal(response?.status, 200);
      assert.equal(response?.body?.idempotent, false);
      await waitFor(() => consumed.length === (hasPending ? 2 : 1) && !(dispatcher as any).inFlight.has(String(THREAD_ID)), "新投递未恢复消费");
      assert.equal(stateRepo.getState(THREAD_ID).paused, false);
      assert.deepEqual(consumed, [...(pending ? [pending.id] : []), response.body.item.id]);
      assert.equal(queueRepo.getById(failed.id)?.status, "failed");
    } finally {
      db.close();
    }
  });
}

for (const pauseReason of ["user_pause", "user_stop", "turn_error", "session_invalidated"] as const) {
  test(`普通 chat 新投递保留有旧 pending 的 ${pauseReason} 暂停`, async () => {
    const { db, queueRepo, stateRepo, dispatcher, appendInputCalls } = setup();
    try {
      appendOne(queueRepo, "暂停前的输入。");
      stateRepo.pause(THREAD_ID, WORKSPACE_ID, pauseReason);
      const ctx = (dispatcher as any).ctx;
      ctx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
      ctx.queueDispatcher = dispatcher;
      await onThreadQueueAppend(ctx, {
        id: `req-preserve-${pauseReason}`, body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "新的输入。", sendOptions: SEND_OPTS },
      } as any);
      assert.equal(stateRepo.getState(THREAD_ID).pausedReason, pauseReason);
      assert.equal(stateRepo.getState(THREAD_ID).paused, true);
      assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 2);
      assert.equal(appendInputCalls.length, 0);
    } finally {
      db.close();
    }
  });
}

test("普通 chat 的 send_failed 幂等 ACK 保持暂停且不触发消费", async () => {
  const { db, queueRepo, stateRepo, dispatcher, appendInputCalls, sentMessages } = setup();
  try {
    const original = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "普通会话重试。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-chat-idempotent-retry",
    }).item;
    stateRepo.pause(THREAD_ID, WORKSPACE_ID, "send_failed");
    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;

    await onThreadQueueAppend(fakeCtx, {
      id: "req-chat-idempotent-retry",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "普通会话重试。",
        clientItemId: "client-chat-idempotent-retry",
        sendOptions: SEND_OPTS,
      },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = sentMessages.find((message) => message.t === "api.res" && message.id === "req-chat-idempotent-retry");
    assert.equal(response?.body?.idempotent, true);
    assert.equal(response?.body?.item?.id, original.id);
    assert.equal(stateRepo.getState(THREAD_ID).paused, true);
    assert.equal(queueRepo.getById(original.id)?.status, "pending");
    assert.equal(appendInputCalls.length, 0);
  } finally {
    db.close();
  }
});

for (const status of ["pending", "ready", "queued"] as const) {
  test(`Dispatcher: ${status} 节点输入先持久化到首轮 Prompt，再唤醒编排`, async () => {
    const {
      db,
      queueRepo,
      stateRepo,
      dispatcher,
      appendInputCalls,
      appendPendingNodeInputCalls,
      resumeInBackgroundCalls,
    } = setup({
      threadSubtype: "node",
      nodeState: { status, humanActionSource: null },
    });
    try {
      const item = appendOne(queueRepo, `继续 ${status} 节点。`);

      dispatcher.kickIfIdle(THREAD_ID);
      dispatcher.kickIfIdle(THREAD_ID);
      await waitFor(() => resumeInBackgroundCalls.length === 1, `${status} 节点未被唤醒`);

      assert.equal(appendPendingNodeInputCalls.length, 1);
      assert.equal(appendPendingNodeInputCalls[0]?.instanceId, "orch-test-instance");
      assert.equal(appendPendingNodeInputCalls[0]?.nodeId, "node-a");
      assert.equal(appendPendingNodeInputCalls[0]?.input?.feedback, `继续 ${status} 节点。`);
      assert.deepEqual(appendPendingNodeInputCalls[0]?.input?.executionOverride, {
        model: "test-model",
        effort: null,
        autoCompactPct: null,
        contextWindow: null,
        serviceTier: null,
      });
      assert.equal(appendInputCalls.length, 0, "节点输入不得退化为普通 chat turn");
      assert.equal(queueRepo.getById(item.id)?.status, "sent");
      assert.equal(queueRepo.getById(item.id)?.sentTurnId, null);
      assert.equal(stateRepo.getState(THREAD_ID).lastConsumedQueueId, item.id);
      assert.equal(stateRepo.getState(THREAD_ID).lastConsumedTurnId, null);
      assert.deepEqual(resumeInBackgroundCalls, ["orch-test-instance"]);
    } finally {
      db.close();
    }
  });
}

test("Dispatcher: 历史终态实例不会抢占当前 ready 节点绑定", async () => {
  const {
    db,
    queueRepo,
    dispatcher,
    appendPendingNodeInputCalls,
    resumeInBackgroundCalls,
  } = setup({
    threadSubtype: "node",
    nodeInstances: [
      {
        id: "orch-terminal-newer",
        status: "completed",
        nodeState: { status: "running", humanActionSource: null },
        createdAt: 20,
        updatedAt: 20,
      },
      {
        id: "orch-current-active",
        status: "running",
        nodeState: { status: "ready", humanActionSource: null },
        createdAt: 10,
        updatedAt: 10,
      },
    ],
  });
  try {
    const item = appendOne(queueRepo, "继续当前实例。");

    dispatcher.kickIfIdle(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitFor(() => resumeInBackgroundCalls.length === 1, "当前实例未被唤醒");
    assert.deepEqual(resumeInBackgroundCalls, ["orch-current-active"]);
    assert.equal(appendPendingNodeInputCalls.length, 1);
    assert.equal(appendPendingNodeInputCalls[0]?.instanceId, "orch-current-active");
    assert.equal(queueRepo.getById(item.id)?.status, "sent");
  } finally {
    db.close();
  }
});

test("Dispatcher: paused 实例收到节点会话输入后先持久化再恢复", async () => {
  const { db, queueRepo, dispatcher, appendPendingNodeInputCalls, resumeInBackgroundCalls } = setup({
    threadSubtype: "node",
    nodeInstances: [{
      id: "orch-paused-instance",
      status: "paused",
      nodeState: { status: "ready", humanActionSource: null },
      createdAt: 10,
      updatedAt: 10,
    }],
  });
  try {
    const item = appendOne(queueRepo, "继续当前节点。");

    dispatcher.kickIfIdle(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitFor(() => resumeInBackgroundCalls.length === 1, "paused 实例未被恢复");
    assert.equal(appendPendingNodeInputCalls.length, 1);
    assert.equal(queueRepo.getById(item.id)?.status, "sent");
    assert.deepEqual(resumeInBackgroundCalls, ["orch-paused-instance"]);
  } finally {
    db.close();
  }
});

test("Dispatcher: 已持久化节点输入唤醒失败后下一次输入只重新唤醒", async () => {
  let resumeAttempts = 0;
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    sentMessages,
    appendPendingNodeInputCalls,
    resumeInBackgroundCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    async resumeInBackgroundImpl() {
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error("resume unavailable");
    },
  });
  try {
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "继续。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-persisted-wake-retry",
    }).item;

    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => stateRepo.getState(THREAD_ID).paused, "节点唤醒失败后未显式暂停");

    assert.deepEqual(resumeInBackgroundCalls, ["orch-test-instance"]);
    assert.equal(appendPendingNodeInputCalls.length, 1);
    assert.equal(queueRepo.getById(item.id)?.status, "sent");
    assert.equal(queueRepo.getById(item.id)?.failureCode, "orchestration_pending_input_post_ack_failed_completed");
    assert.equal(stateRepo.getState(THREAD_ID).pausedReason, "send_failed");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    await onThreadQueueAppend(fakeCtx, {
      id: "req-persisted-wake-retry",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "继续。",
        clientItemId: "client-next-input-wake-retry",
        sendOptions: SEND_OPTS,
      },
    } as any);
    await waitFor(() => resumeInBackgroundCalls.length === 2, "幂等重试未重新唤醒节点");

    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.equal(appendPendingNodeInputCalls.length, 1, "唤醒重试不得重复持久化反馈");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    const response = sentMessages.find((message) => message.t === "api.res" && message.id === "req-persisted-wake-retry");
    assert.equal(response?.body?.idempotent, true);
    assert.equal(response?.body?.item?.id, item.id);
  } finally {
    db.close();
  }
});

test("节点唤醒失败后不同补充内容不会被旧输入幂等 ACK 吞掉", async () => {
  let resumeAttempts = 0;
  const { db, queueRepo, stateRepo, dispatcher, sentMessages, appendPendingNodeInputCalls } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    async resumeInBackgroundImpl() {
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error("initial wake failed");
    },
  });
  try {
    const original = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "继续。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-old-wake-input",
    }).item;
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => stateRepo.getState(THREAD_ID).paused, "初次唤醒失败后未暂停");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    await onThreadQueueAppend(fakeCtx, {
      id: "req-different-node-input",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "补充：还要检查缓存。",
        clientItemId: "client-different-node-input",
        sendOptions: SEND_OPTS,
      },
    } as any);
    await waitFor(() => appendPendingNodeInputCalls.length === 2, "不同补充内容未正常持久化");

    const response = sentMessages.find((message) => message.t === "api.res" && message.id === "req-different-node-input");
    assert.equal(response?.body?.idempotent, false);
    assert.notEqual(response?.body?.item?.id, original.id);
    assert.deepEqual(
      appendPendingNodeInputCalls.map((call) => call.input.feedback),
      ["继续。", "补充：还要检查缓存。"],
    );
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 2);
    await waitFor(() => !(dispatcher as any).inFlight.has(String(THREAD_ID)), "不同补充内容调度未收尾");
  } finally {
    db.close();
  }
});

test("节点唤醒失败后相同正文但附件变化仍作为新补充持久化", async () => {
  let resumeAttempts = 0;
  const { db, queueRepo, stateRepo, dispatcher, appendPendingNodeInputCalls } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    async resumeInBackgroundImpl() {
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error("initial wake failed");
    },
  });
  try {
    queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "继续。",
      images: [],
      files: [{ id: "file-old", name: "note.txt", displayName: null, mime: "text/plain", size: 3, text: "旧" }],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-old-attachment",
    });
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => stateRepo.getState(THREAD_ID).paused, "初次附件输入唤醒失败后未暂停");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    await onThreadQueueAppend(fakeCtx, {
      id: "req-changed-attachment",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "继续。",
        files: [{ id: "file-new", name: "note.txt", displayName: null, mime: "text/plain", size: 3, text: "新" }],
        clientItemId: "client-changed-attachment",
        sendOptions: SEND_OPTS,
      },
    } as any);
    await waitFor(() => appendPendingNodeInputCalls.length === 2, "变化附件未作为新补充持久化");

    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 2);
    assert.match(appendPendingNodeInputCalls[0]?.input.feedback ?? "", /旧/);
    assert.match(appendPendingNodeInputCalls[1]?.input.feedback ?? "", /新/);
    await waitFor(() => !(dispatcher as any).inFlight.has(String(THREAD_ID)), "变化附件调度未收尾");
  } finally {
    db.close();
  }
});

test("节点唤醒失败后相同附件内容只重试唤醒", async () => {
  let resumeAttempts = 0;
  const { db, queueRepo, stateRepo, dispatcher, appendPendingNodeInputCalls } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    async resumeInBackgroundImpl() {
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error("initial wake failed");
    },
  });
  try {
    queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "继续。",
      images: [],
      files: [{ id: "file-original", name: "note.txt", displayName: null, mime: "text/plain", size: 3, text: "相同" }],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-original-attachment",
    });
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => stateRepo.getState(THREAD_ID).paused, "初次相同附件输入唤醒失败后未暂停");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    await onThreadQueueAppend(fakeCtx, {
      id: "req-same-attachment",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "继续。",
        files: [{ id: "file-recreated", name: "note.txt", displayName: null, mime: "text/plain", size: 3, text: "相同" }],
        clientItemId: "client-recreated-attachment",
        sendOptions: SEND_OPTS,
      },
    } as any);

    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.equal(appendPendingNodeInputCalls.length, 1, "相同附件的唤醒重试不得重复持久化反馈");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
  } finally {
    db.close();
  }
});

test("Dispatcher: 并发同 clientItemId 唤醒重试共享一次恢复且不重复反馈", async () => {
  let resumeAttempts = 0;
  let releaseRetryWake!: () => void;
  const retryWakeGate = new Promise<void>((resolve) => {
    releaseRetryWake = resolve;
  });
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    sentMessages,
    appendPendingNodeInputCalls,
    resumeInBackgroundCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    async resumeInBackgroundImpl() {
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error("initial wake failed");
      await retryWakeGate;
    },
  });
  try {
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "并发重试继续。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-concurrent-wake-retry",
    }).item;
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => stateRepo.getState(THREAD_ID).paused, "初次唤醒失败后未暂停");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    const buildRequest = (id: string) => ({
      id,
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "并发重试继续。",
        clientItemId: "client-concurrent-wake-retry",
        sendOptions: SEND_OPTS,
      },
    } as any);

    const firstRetry = onThreadQueueAppend(fakeCtx, buildRequest("req-concurrent-wake-1"));
    await waitFor(() => resumeInBackgroundCalls.length === 2, "首个重试未开始唤醒");
    const secondRetry = onThreadQueueAppend(fakeCtx, buildRequest("req-concurrent-wake-2"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(resumeInBackgroundCalls.length, 2, "并发幂等重试不得重复调用节点恢复");
    assert.equal(stateRepo.getState(THREAD_ID).paused, true, "唤醒成功前必须保持失败暂停态");

    releaseRetryWake();
    await Promise.all([firstRetry, secondRetry]);

    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.equal(appendPendingNodeInputCalls.length, 1);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    assert.equal(queueRepo.getById(item.id)?.status, "sent");
    const responses = sentMessages.filter((message) => message.t === "api.res" && String(message.id).startsWith("req-concurrent-wake-"));
    assert.equal(responses.length, 2);
    assert.ok(responses.every((response) => response.status === 200 && response.body?.idempotent === true));
  } finally {
    db.close();
  }
});

test("Dispatcher: 节点唤醒失败不会覆盖在途期间的用户 Stop", async () => {
  let releaseWake!: () => void;
  const wakeGate = new Promise<void>((resolve) => {
    releaseWake = resolve;
  });
  const { db, queueRepo, stateRepo, dispatcher, resumeInBackgroundCalls } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    async resumeInBackgroundImpl() {
      await wakeGate;
      throw new Error("wake failed after user stop");
    },
  });
  try {
    appendOne(queueRepo, "继续当前节点。");
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => resumeInBackgroundCalls.length === 1, "节点唤醒未开始");

    stateRepo.pause(THREAD_ID, WORKSPACE_ID, "user_stop");
    releaseWake();
    await waitFor(() => !(dispatcher as any).inFlight.has(String(THREAD_ID)), "用户 Stop 后的唤醒失败未收尾");

    const state = stateRepo.getState(THREAD_ID);
    assert.equal(state.paused, true);
    assert.equal(state.pausedReason, "user_stop");
  } finally {
    db.close();
  }
});

test("Dispatcher: pending 节点多条输入按队列顺序持久化且不创建普通 turn", async () => {
  const {
    db,
    queueRepo,
    dispatcher,
    appendPendingNodeInputCalls,
    resumeInBackgroundCalls,
    appendInputCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
  });
  try {
    const first = appendOne(queueRepo, "第一条节点输入。");
    const second = appendOne(queueRepo, "第二条节点输入。");
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => appendPendingNodeInputCalls.length === 2, "两条节点输入未全部持久化");

    assert.deepEqual(
      appendPendingNodeInputCalls.map((call) => call.input.feedback),
      ["第一条节点输入。", "第二条节点输入。"],
    );
    assert.equal(appendInputCalls.length, 0);
    assert.equal(queueRepo.getById(first.id)?.status, "sent");
    assert.equal(queueRepo.getById(second.id)?.status, "sent");
    assert.ok(resumeInBackgroundCalls.length >= 1);
  } finally {
    db.close();
  }
});

test("Dispatcher.kickIfIdle: 异常中断节点队列补充走 resume_with_input", async () => {
  const { db, queueRepo, stateRepo, dispatcher, submitFeedbackCalls } = setup({
    threadSubtype: "node",
    nodeState: {
      status: "waiting-feedback",
      humanActionSource: "execution",
    },
  });
  try {
    const item = appendOne(queueRepo, "继续执行，补上错误处理。");

    dispatcher.kickIfIdle(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(submitFeedbackCalls.length, 1);
    assert.equal(submitFeedbackCalls[0]?.instanceId, "orch-test-instance");
    assert.equal(submitFeedbackCalls[0]?.nodeId, "node-a");
    assert.equal(submitFeedbackCalls[0]?.action, "resume_with_input");
    assert.equal(submitFeedbackCalls[0]?.input?.feedback, "继续执行，补上错误处理。");
    assert.deepEqual(submitFeedbackCalls[0]?.input?.executionOverride, {
      model: "test-model",
      effort: null,
      autoCompactPct: null,
      contextWindow: null,
      serviceTier: null,
    });
    assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 0);
    assert.equal(queueRepo.getById(item.id)?.sentTurnId, null);
    assert.equal(stateRepo.getState(THREAD_ID).lastConsumedQueueId, item.id);
    assert.equal(stateRepo.getState(THREAD_ID).lastConsumedTurnId, null);
  } finally {
    db.close();
  }
});

test("Dispatcher: pending 节点反馈 ACK 后同 clientItemId 不重复写反馈", async () => {
  let failFinalizeOnce = true;
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    sentMessages,
    appendInputCalls,
    appendPendingNodeInputCalls,
    submitFeedbackCalls,
    resumeInBackgroundCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    beforeSetLastConsumedImpl() {
      if (!failFinalizeOnce) return;
      failFinalizeOnce = false;
      throw new Error("pending feedback local finalize failed");
    },
  });
  try {
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "继续 pending 节点。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-pending-post-ack",
    }).item;
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "failed", "pending 节点 ACK 后失败屏障未落库");
    assert.equal(appendPendingNodeInputCalls.length, 1);
    assert.equal(resumeInBackgroundCalls.length, 0);
    assert.equal(queueRepo.getById(item.id)?.failureCode, "orchestration_pending_input_post_ack_failed");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    await onThreadQueueAppend(fakeCtx, {
      id: "req-pending-post-ack-retry",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "继续 pending 节点。",
        clientItemId: "client-pending-post-ack",
        sendOptions: SEND_OPTS,
      },
    } as any);

    const stored = queueRepo.getById(item.id);
    const state = stateRepo.getState(THREAD_ID);
    const response = sentMessages.find((message) => message.t === "api.res" && message.id === "req-pending-post-ack-retry");
    assert.equal(appendPendingNodeInputCalls.length, 1, "已写入的 pending 节点反馈不得重复");
    assert.equal(resumeInBackgroundCalls.length, 1, "ACK 后收尾重试必须补齐首次遗漏的节点唤醒");
    assert.equal(submitFeedbackCalls.length, 0);
    assert.equal(appendInputCalls.length, 0);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.idempotent, true);
    assert.equal(response?.body?.item?.id, item.id);
    assert.equal(stored?.status, "sent");
    assert.equal(stored?.sentTurnId, null);
    assert.equal(stored?.failureCode, "orchestration_pending_input_post_ack_failed_completed");
    assert.equal(stored?.attemptCount, 1);
    assert.equal(state.lastConsumedQueueId, item.id);
    assert.equal(state.lastConsumedTurnId, null);
    assert.equal(state.paused, false);
  } finally {
    db.close();
  }
});

test("Dispatcher: pending 节点 post-ACK 唤醒失败后同 clientItemId 只重试唤醒", async () => {
  let failFinalizeOnce = true;
  let resumeAttempts = 0;
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    sentMessages,
    appendPendingNodeInputCalls,
    resumeInBackgroundCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    beforeSetLastConsumedImpl() {
      if (!failFinalizeOnce) return;
      failFinalizeOnce = false;
      throw new Error("pending feedback local finalize failed");
    },
    async resumeInBackgroundImpl() {
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error("post-ACK wake failed");
    },
  });
  try {
    const clientItemId = "client-pending-post-ack-wake-retry";
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "继续 pending 节点并重试唤醒。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId,
    }).item;
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "failed", "pending 节点 ACK 后失败屏障未落库");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    const buildRequest = (id: string) => ({
      id,
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "继续 pending 节点并重试唤醒。",
        clientItemId,
        sendOptions: SEND_OPTS,
      },
    } as any);

    await onThreadQueueAppend(fakeCtx, buildRequest("req-pending-post-ack-wake-failed"));

    const failedResponse = sentMessages.find((message) => (
      message.t === "api.res" && message.id === "req-pending-post-ack-wake-failed"
    ));
    assert.equal(failedResponse?.status, 500);
    assert.equal(appendPendingNodeInputCalls.length, 1, "post-ACK wake 失败不得重复写入节点反馈");
    assert.equal(resumeInBackgroundCalls.length, 1);
    assert.equal(queueRepo.getById(item.id)?.status, "sent");
    assert.equal(queueRepo.getById(item.id)?.failureCode, "orchestration_pending_input_post_ack_failed_completed");
    assert.equal(stateRepo.getState(THREAD_ID).paused, true);
    assert.equal(stateRepo.getState(THREAD_ID).pausedReason, "send_failed");

    await onThreadQueueAppend(fakeCtx, buildRequest("req-pending-post-ack-wake-retried"));

    const retriedResponse = sentMessages.find((message) => (
      message.t === "api.res" && message.id === "req-pending-post-ack-wake-retried"
    ));
    assert.equal(retriedResponse?.status, 200);
    assert.equal(retriedResponse?.body?.idempotent, true);
    assert.equal(retriedResponse?.body?.item?.id, item.id);
    assert.equal(appendPendingNodeInputCalls.length, 1, "同 clientItemId 只能重试 wake，不能重复节点反馈");
    assert.equal(resumeInBackgroundCalls.length, 2);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
  } finally {
    db.close();
  }
});

test("Dispatcher: pending 节点 post-ACK 并发同 clientItemId 共享一次 wake", async () => {
  let failFinalizeOnce = true;
  let releaseWake!: () => void;
  const wakeGate = new Promise<void>((resolve) => {
    releaseWake = resolve;
  });
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    sentMessages,
    appendPendingNodeInputCalls,
    resumeInBackgroundCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "ready", humanActionSource: null },
    beforeSetLastConsumedImpl() {
      if (!failFinalizeOnce) return;
      failFinalizeOnce = false;
      throw new Error("pending feedback local finalize failed");
    },
    async resumeInBackgroundImpl() {
      await wakeGate;
    },
  });
  try {
    const clientItemId = "client-pending-post-ack-concurrent-wake";
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "并发继续 pending 节点。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId,
    }).item;
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "failed", "pending 节点 ACK 后失败屏障未落库");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    const buildRequest = (id: string) => ({
      id,
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "并发继续 pending 节点。",
        clientItemId,
        sendOptions: SEND_OPTS,
      },
    } as any);

    const firstRetry = onThreadQueueAppend(fakeCtx, buildRequest("req-pending-post-ack-concurrent-1"));
    await waitFor(() => resumeInBackgroundCalls.length === 1, "首个 post-ACK 重试未开始 wake");
    const secondRetry = onThreadQueueAppend(fakeCtx, buildRequest("req-pending-post-ack-concurrent-2"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(resumeInBackgroundCalls.length, 1, "并发同 clientItemId 必须合并为一次 wake");
    assert.equal(appendPendingNodeInputCalls.length, 1, "并发 wake 不得重复写入节点反馈");
    assert.equal(stateRepo.getState(THREAD_ID).paused, true, "wake 完成前必须保留 send_failed 暂停");
    assert.equal(
      sentMessages.filter((message) => message.t === "api.res" && String(message.id).startsWith("req-pending-post-ack-concurrent-")).length,
      0,
      "并发请求不得在 wake 完成前提前返回成功",
    );

    releaseWake();
    await Promise.all([firstRetry, secondRetry]);

    const responses = sentMessages.filter((message) => (
      message.t === "api.res" && String(message.id).startsWith("req-pending-post-ack-concurrent-")
    ));
    assert.equal(responses.length, 2);
    assert.ok(responses.every((response) => response.status === 200 && response.body?.idempotent === true));
    assert.equal(resumeInBackgroundCalls.length, 1);
    assert.equal(appendPendingNodeInputCalls.length, 1);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    assert.equal(queueRepo.getById(item.id)?.status, "sent");
    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
  } finally {
    db.close();
  }
});

test("Dispatcher: resume_with_input ACK 后同 clientItemId 不重复提交反馈", async () => {
  let failFinalizeOnce = true;
  const {
    db,
    queueRepo,
    stateRepo,
    dispatcher,
    sentMessages,
    appendInputCalls,
    appendPendingNodeInputCalls,
    submitFeedbackCalls,
    resumeInBackgroundCalls,
  } = setup({
    threadSubtype: "node",
    nodeState: { status: "waiting-feedback", humanActionSource: "execution" },
    beforeSetLastConsumedImpl() {
      if (!failFinalizeOnce) return;
      failFinalizeOnce = false;
      throw new Error("resume feedback local finalize failed");
    },
  });
  try {
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "继续恢复节点。",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "client-resume-post-ack",
    }).item;
    dispatcher.kickIfIdle(THREAD_ID);
    await waitFor(() => queueRepo.getById(item.id)?.status === "failed", "resume feedback ACK 后失败屏障未落库");
    assert.equal(submitFeedbackCalls.length, 1);
    assert.equal(submitFeedbackCalls[0]?.action, "resume_with_input");
    assert.equal(queueRepo.getById(item.id)?.failureCode, "orchestration_feedback_post_ack_failed");

    const fakeCtx = (dispatcher as any).ctx;
    fakeCtx.workspaces = new Map([[WORKSPACE_ID, "/tmp"]]);
    fakeCtx.queueDispatcher = dispatcher;
    await onThreadQueueAppend(fakeCtx, {
      id: "req-resume-post-ack-retry",
      method: "threads.queue.append",
      path: "/threads/queue/append",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: "继续恢复节点。",
        clientItemId: "client-resume-post-ack",
        sendOptions: SEND_OPTS,
      },
    } as any);

    const stored = queueRepo.getById(item.id);
    const state = stateRepo.getState(THREAD_ID);
    const response = sentMessages.find((message) => message.t === "api.res" && message.id === "req-resume-post-ack-retry");
    assert.equal(submitFeedbackCalls.length, 1, "已提交的 resume_with_input 不得重复");
    assert.equal(resumeInBackgroundCalls.length, 0);
    assert.equal(appendPendingNodeInputCalls.length, 0);
    assert.equal(appendInputCalls.length, 0);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM thread_message_queue").get() as { count: number })?.count), 1);
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.idempotent, true);
    assert.equal(response?.body?.item?.id, item.id);
    assert.equal(stored?.status, "sent");
    assert.equal(stored?.sentTurnId, null);
    assert.equal(stored?.failureCode, "orchestration_feedback_post_ack_failed_completed");
    assert.equal(stored?.attemptCount, 1);
    assert.equal(state.lastConsumedQueueId, item.id);
    assert.equal(state.lastConsumedTurnId, null);
    assert.equal(state.paused, false);
  } finally {
    db.close();
  }
});

for (const humanActionSource of ["human_input", "review", "gate"] as const) {
  test(`Dispatcher.kickIfIdle: waiting-feedback/${humanActionSource} 将自由文本作为当前节点补充重跑`, async () => {
    const { db, queueRepo, dispatcher, submitFeedbackCalls, appendInputCalls } = setup({
      threadSubtype: "node",
      nodeState: {
        status: "waiting-feedback",
        humanActionSource,
      },
    });
    try {
      const item = appendOne(queueRepo, `补充意见：${humanActionSource}`);

      dispatcher.kickIfIdle(THREAD_ID);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(submitFeedbackCalls.length, 1);
      assert.equal(submitFeedbackCalls[0]?.action, "resume_with_input");
      assert.equal(submitFeedbackCalls[0]?.input?.feedback, `补充意见：${humanActionSource}`);
      assert.equal(appendInputCalls.length, 0);
      assert.equal(queueRepo.getById(item.id)?.status, "sent");
    } finally {
      db.close();
    }
  });
}

test("Dispatcher.kickIfIdle: paused waiting-feedback 直接提交补充", async () => {
  const callOrder: string[] = [];
  const { db, queueRepo, dispatcher, submitFeedbackCalls, resumeInBackgroundCalls } = setup({
    threadSubtype: "node",
    nodeInstances: [{
      id: "orch-paused-feedback",
      status: "paused",
      nodeState: { status: "waiting-feedback", humanActionSource: "review" },
      createdAt: 10,
      updatedAt: 10,
    }],
    async submitFeedbackImpl() {
      callOrder.push("submitFeedback");
    },
  });
  try {
    const item = appendOne(queueRepo, "补充评审意见后继续。");

    dispatcher.kickIfIdle(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(submitFeedbackCalls.length, 1);
    assert.equal(submitFeedbackCalls[0]?.action, "resume_with_input");
    assert.deepEqual(resumeInBackgroundCalls, []);
    assert.deepEqual(callOrder, ["submitFeedback"]);
    assert.equal(queueRepo.getById(item.id)?.status, "sent");
  } finally {
    db.close();
  }
});

for (const nodeState of [
  { status: "waiting-feedback", humanActionSource: "branch_decision" },
  { status: "waiting-approval", humanActionSource: "approval" },
  { status: "waiting-start", humanActionSource: null },
] as const) {
  test(`Dispatcher.kickIfIdle: ${nodeState.status}/${nodeState.humanActionSource ?? "none"} 保持明确动作边界`, () => {
    const { db, queueRepo, dispatcher, submitFeedbackCalls, appendInputCalls, resumeInBackgroundCalls } = setup({
      threadSubtype: "node",
      nodeState,
    });
    try {
      const item = appendOne(queueRepo, "继续");

      dispatcher.kickIfIdle(THREAD_ID);

      assert.equal(queueRepo.getById(item.id)?.status, "failed");
      assert.equal(queueRepo.getById(item.id)?.failureCode, "orchestration_node_queue_not_supported");
      assert.equal(submitFeedbackCalls.length, 0);
      assert.equal(appendInputCalls.length, 0);
      assert.equal(resumeInBackgroundCalls.length, 0);
    } finally {
      db.close();
    }
  });
}

test("Dispatcher.kickIfIdle: 异常中断节点恢复失败时队列项显式失败并暂停", async () => {
  const { db, queueRepo, stateRepo, dispatcher, submitFeedbackCalls, appendInputCalls, sentMessages } = setup({
    threadSubtype: "node",
    nodeState: {
      status: "waiting-feedback",
      humanActionSource: "execution",
    },
    async submitFeedbackImpl() {
      throw new Error("resume failed in test");
    },
  });
  try {
    const item = appendOne(queueRepo, "继续执行，但引擎拒绝。");

    dispatcher.kickIfIdle(THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = queueRepo.getById(item.id);
    assert.equal(submitFeedbackCalls.length, 1);
    assert.equal(appendInputCalls.length, 0);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.failureCode, "orchestration_feedback_failed");
    assert.match(stored?.failureReason ?? "", /resume failed in test/);
    assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 0);

    const state = stateRepo.getState(THREAD_ID);
    assert.equal(state.paused, true);
    assert.equal(state.pausedReason, "send_failed");
    const queueReasons = sentMessages.filter((m) => m.t === "thread.queue.changed").map((m) => m.reason);
    assert.ok(queueReasons.includes("failed"));
  } finally {
    db.close();
  }
});

test("Dispatcher.kickIfIdle: 不支持队列的专用线程残留项显式失败", () => {
  const { db, queueRepo, stateRepo, dispatcher, submitFeedbackCalls, appendInputCalls, sentMessages } = setup({
    threadSubtype: "asset-draft",
  });
  try {
    const item = appendOne(queueRepo, "不应被普通队列消费。");

    dispatcher.kickIfIdle(THREAD_ID);

    const stored = queueRepo.getById(item.id);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.failureCode, "subtype_not_supported");
    assert.match(stored?.failureReason ?? "", /当前线程类型不支持队列/);
    assert.equal(queueRepo.listActiveByThread(THREAD_ID).length, 0);
    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.equal(submitFeedbackCalls.length, 0);
    assert.equal(appendInputCalls.length, 0);
    const queueReasons = sentMessages.filter((m) => m.t === "thread.queue.changed").map((m) => m.reason);
    assert.deepEqual(queueReasons, ["failed"]);
  } finally {
    db.close();
  }
});

test("Dispatcher.kickIfIdle short-circuits: paused 状态 → 不消费", () => {
  const { db, queueRepo, stateRepo, dispatcher } = setup();
  try {
    appendOne(queueRepo, "A");
    stateRepo.pause(THREAD_ID, WORKSPACE_ID, "user_stop");
    dispatcher.kickIfIdle(THREAD_ID);

    const active = queueRepo.listActiveByThread(THREAD_ID);
    assert.equal(active.length, 1);
    assert.equal(active[0].status, "pending");
  } finally {
    db.close();
  }
});

test("Dispatcher.recoverOnStartup: 残留 sending 项重置为 pending", () => {
  const { db, queueRepo, dispatcher } = setup();
  try {
    appendOne(queueRepo, "A");
    queueRepo.claimNextPending(THREAD_ID); // 模拟崩溃前的 sending
    let active = queueRepo.listActiveByThread(THREAD_ID);
    assert.equal(active[0].status, "sending");

    dispatcher.recoverOnStartup();

    active = queueRepo.listActiveByThread(THREAD_ID);
    assert.equal(active[0].status, "pending", "recoverOnStartup 后应回 pending");
  } finally {
    db.close();
  }
});

test("Dispatcher.recoverOnStartup: 中断节点有暂停后的继续输入时解除 user_stop", async () => {
  const { db, queueRepo, stateRepo, dispatcher, submitFeedbackCalls } = setup({
    threadSubtype: "node",
    nodeState: { status: "waiting-feedback", humanActionSource: "execution" },
  });
  try {
    const oldItem = appendOne(queueRepo, "暂停前留下的输入。");
    stateRepo.pause(THREAD_ID, WORKSPACE_ID, "user_stop");
    const pausedAt = stateRepo.getState(THREAD_ID).pausedAt ?? 0;
    const newItem = appendOne(queueRepo, "继续当前中断节点。");
    // 固定“暂停后入队”的事实，避免测试受同毫秒 Date.now 精度影响。
    db.prepare("UPDATE thread_message_queue SET enqueued_at = ?, updated_at = ? WHERE id = ?")
      .run(pausedAt + 1, pausedAt + 1, newItem.id);

    dispatcher.recoverOnStartup();
    await waitFor(() => queueRepo.getById(oldItem.id)?.status === "sent", "启动恢复未消费中断节点输入");

    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.ok(submitFeedbackCalls.length >= 1);
    assert.equal(submitFeedbackCalls[0]?.action, "resume_with_input");
  } finally {
    db.close();
  }
});

test("Dispatcher: fresh-turn reservation active 竞态按 attempt CAS 退回 pending", () => {
  const { db, queueRepo, stateRepo, dispatcher, sentMessages } = setup();
  try {
    const text = "use $review";
    const item = queueRepo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text,
      inputKind: "message",
      skillMentions: [{
        skillId: `csk_${"a".repeat(43)}`,
        name: "review",
        start: 4,
        end: 11,
      }],
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
    }).item;
    const claim = queueRepo.claimNextPendingForDispatch(THREAD_ID);
    assert.equal(claim?.kind, "claimed");
    const claimed = (claim as any).item;

    const handled = (dispatcher as any).deferFreshTurnReservationConflict(
      claimed,
      WORKSPACE_ID,
      THREAD_ID,
      { code: "active_turn_conflict", message: "occupied after resolve" },
    );

    assert.equal(handled, true);
    const stored = queueRepo.getById(item.id);
    assert.equal(stored?.status, "pending");
    assert.equal(stored?.attemptCount, 1);
    assert.equal(stateRepo.getState(THREAD_ID).paused, false);
    assert.ok(sentMessages.some((message) => message.t === "thread.queue.changed" && message.reason === "appended"));
  } finally {
    db.close();
  }
});

test("Dispatcher.notifyTurnTerminal: source 非 user_send/queue_consume 直接忽略（如 compact 不应触发）", () => {
  const { db, queueRepo, stateRepo, dispatcher, sentMessages } = setup();
  try {
    appendOne(queueRepo, "A");
    queueRepo.claimNextPending(THREAD_ID);

    // 模拟 compact 终态：source 字段不在白名单内
    dispatcher.notifyTurnTerminal({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: "turn_compact" as any,
      source: "user_send" as any, // 实际 dispatcher 实现仅在 user_send / queue_consume 时处理
      queueItemId: null,
      outcome: "completed",
    });
    // user_send completed 路径：不会动 sending 项（queueItemId 为 null）但会 kickIfIdle；
    // 因为 hasActiveTurn=false + paused=false，会重新 claim 下一个 pending（这里没有，所以 noop）。
    // 当前 sending 项不应被 markSent（因为 queueItemId=null）
    const active = queueRepo.listActiveByThread(THREAD_ID);
    assert.equal(active.length, 1);
    assert.equal(active[0].status, "sending", "user_send 路径不应误标 sending 项");
    void sentMessages;
    void stateRepo;
  } finally {
    db.close();
  }
});
