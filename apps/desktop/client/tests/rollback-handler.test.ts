import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionId, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";

import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { handleThreadsFileChangesUndo } from "../src/app/handlers/fileChangeHandlers.ts";
import {
  handleThreadsRollback,
  handleThreadsRollbackPreview,
  reconcileUnresolvedRollbackBeforeMutation,
} from "../src/app/handlers/rollbackHandlers.ts";
import { prepareCodexProviderTurnHistoryBatch } from "../src/app/utils/codexTurnHistory.ts";
import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import type { ClientToServerMessage } from "../src/protocol/messages.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.ts";
import { waitForOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";

const WORKSPACE_ID = "client-test:ws-rollback" as WorkspaceId;
const THREAD_ID = "thread-rollback-handler" as ThreadId;
const BASE_TURN_ID = "turn-rollback-base" as TurnId;
const DROPPED_TURN_ID = "turn-rollback-dropped" as TurnId;
const LATER_DROPPED_TURN_ID = "turn-rollback-dropped-later" as TurnId;
const SESSION_ID = "codex-thread-rollback" as SessionId;
const BASE_PROVIDER_TURN_ID = "provider-turn-rollback-base";
const DROPPED_PROVIDER_TURN_ID = "provider-turn-rollback-dropped";
const LATER_DROPPED_PROVIDER_TURN_ID = "provider-turn-rollback-dropped-later";

type ProviderRollback = (
  numTurnsToDrop: number,
  expectation: { droppedTurnIds: string[]; retainedTurnId: string | null },
) => void | Promise<void>;

type PreparedRollbackFixture = {
  sessionId: SessionId;
  numTurns: number;
  beforeTurnIds: string[];
  afterTurnIds: string[];
  droppedTurnIds: string[];
  retainedTurnId: string | null;
};

/** 在真实工作区库构建可注入 provider 故障的回滚环境，直接处理器与 API 共用同一事实源。 */
function setupRollbackHarness(options?: {
  providerPrepare?: (workspacePath: string) => void | Promise<void>;
  providerPreparedRollback?: (
    numTurnsToDrop: number,
    expectation: { droppedTurnIds: string[]; retainedTurnId: string | null },
  ) => PreparedRollbackFixture | null;
  providerRollback?: ProviderRollback;
  providerCancel?: () => void;
  providerHistoryRead?: () => void | Promise<void>;
  providerHistoryTurnIds?: string[];
  disposeFailures?: number;
  flushRollbackEvidence?: (callCount: number) => void;
  rollbackEvidenceFence?: (callCount: number) => number | Promise<number>;
}) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-rollback-handler-"));
  const appDb = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  appDb.workspaces.upsert({ id: WORKSPACE_ID, title: "回滚测试工作区", path: workspacePath });
  const db = appDb.forWorkspace(WORKSPACE_ID);
  const sent: ClientToServerMessage[] = [];
  const rollbackCalls: number[] = [];
  const rollbackExpectations: Array<{ droppedTurnIds: string[]; retainedTurnId: string | null }> = [];
  const runtimeSessions: Array<{ sessionId: SessionId | null }> = [];
  const blobIds = new Set<string>();
  let getOrCreateCalls = 0;
  let disposeCalls = 0;
  let flushEvidenceCalls = 0;
  let rollbackEvidenceFenceCalls = 0;
  let remainingDisposeFailures = Math.max(0, Number(options?.disposeFailures ?? 0));
  let providerHistoryTurnIds = [...(options?.providerHistoryTurnIds ?? ["provider-history-unknown"])];

  db.threads.create({ id: THREAD_ID, workspaceId: WORKSPACE_ID, engine: "codex", title: "回滚测试" });
  db.threads.setSessionId(THREAD_ID, SESSION_ID);

  db.turns.insertStarted({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    turnId: BASE_TURN_ID,
    startedAt: 1_000,
    startEventSeq: 1,
  });
  db.turns.setEnded(BASE_TURN_ID, { status: "completed", endedAt: 2_000, endEventSeq: 10 });
  db.turns.insertStarted({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    turnId: DROPPED_TURN_ID,
    startedAt: 3_000,
    startEventSeq: 11,
  });
  db.turns.setEnded(DROPPED_TURN_ID, { status: "completed", endedAt: 4_000, endEventSeq: 20 });
  db.turns.setEngineSessionIdByThread(THREAD_ID, SESSION_ID);

  db.conversationEvents.appendEnvelope({
    schema: 1,
    seq: 5,
    ts: 1_500,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    type: "system.notice",
    payload: { level: "info", text: "base turn event" },
  });
  db.conversationEvents.appendEnvelope({
    schema: 1,
    seq: 18,
    ts: 3_800,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    type: "system.notice",
    payload: { level: "info", text: "dropped turn event" },
  });
  db.rawEvents.appendEnvelope({
    schema: 1,
    seq: 2,
    ts: 1_200,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    source: "codex.app-server.msg",
    clientTurnId: BASE_TURN_ID,
    data: { method: "turn/started", params: { turn: { id: BASE_PROVIDER_TURN_ID } } },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  });
  db.rawEvents.appendEnvelope({
    schema: 1,
    seq: 5,
    ts: 1_600,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    source: "rollback.fixture",
    data: { phase: "base" },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  });
  db.rawEvents.appendEnvelope({
    schema: 1,
    seq: 12,
    ts: 3_200,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    source: "codex.app-server.msg",
    clientTurnId: DROPPED_TURN_ID,
    data: { method: "turn/started", params: { turn: { id: DROPPED_PROVIDER_TURN_ID } } },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  });
  db.rawEvents.appendEnvelope({
    schema: 1,
    seq: 15,
    ts: 3_500,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    source: "rollback.fixture",
    data: { phase: "dropped" },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  });

  db.turns.setCodexProviderTurnId(BASE_TURN_ID, {
    engineTurnId: BASE_PROVIDER_TURN_ID,
    engineSessionId: SESSION_ID,
    source: "turn.engineBound",
    eventSeq: 2,
    observedAt: 1_200,
  });
  db.turns.setCodexProviderTurnId(DROPPED_TURN_ID, {
    engineTurnId: DROPPED_PROVIDER_TURN_ID,
    engineSessionId: SESSION_ID,
    source: "turn.engineBound",
    eventSeq: 12,
    observedAt: 3_200,
  });

  const threads = new ThreadStore();
  const session = {
    getSessionId() {
      return SESSION_ID;
    },
    async prepareRollbackHistory(numTurnsToDrop: number, expectation: { droppedTurnIds: string[]; retainedTurnId: string | null }) {
      await options?.providerPrepare?.(workspacePath);
      const preparedOverride = options?.providerPreparedRollback?.(numTurnsToDrop, expectation) ?? null;
      if (preparedOverride) return preparedOverride;
      const afterTurnIds = expectation.retainedTurnId ? [expectation.retainedTurnId] : [];
      return {
        sessionId: SESSION_ID,
        numTurns: numTurnsToDrop,
        beforeTurnIds: [...afterTurnIds, ...expectation.droppedTurnIds],
        afterTurnIds,
        droppedTurnIds: [...expectation.droppedTurnIds],
        retainedTurnId: expectation.retainedTurnId,
      };
    },
    async applyPreparedRollbackHistory(prepared: PreparedRollbackFixture) {
      const { numTurns: numTurnsToDrop, droppedTurnIds, retainedTurnId } = prepared;
      rollbackCalls.push(numTurnsToDrop);
      rollbackExpectations.push({ droppedTurnIds, retainedTurnId });
      await options?.providerRollback?.(numTurnsToDrop, { droppedTurnIds, retainedTurnId });
    },
    cancelPreparedRollbackHistory() {
      options?.providerCancel?.();
    },
    async readRollbackHistoryTurnIds() {
      await options?.providerHistoryRead?.();
      return [...providerHistoryTurnIds];
    },
  };
  const ctx = {
    db,
    workspaces: new Map([[WORKSPACE_ID, workspacePath]]),
    clientId: "client-test",
    threads,
    sessions: {
      /** 单请求夹具不模拟并发删除；专项测试另行断言准入顺序。 */
      beginThreadDeletion() { return () => {}; },
      /** 测试不模拟删除竞态，thread 操作租约立即成功。 */
      beginThreadOperation() { return () => {}; },
      getOrCreate(runtime: { sessionId: SessionId | null }) {
        getOrCreateCalls += 1;
        runtimeSessions.push({ sessionId: runtime.sessionId });
        return session;
      },
      async disposeThreadWithOptions() {
        disposeCalls += 1;
        if (remainingDisposeFailures > 0) {
          remainingDisposeFailures -= 1;
          throw new Error("injected dispose failure");
        }
      },
    },
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
    flushRollbackEvidence() {
      flushEvidenceCalls += 1;
      options?.flushRollbackEvidence?.(flushEvidenceCalls);
    },
    async fenceRollbackEvidence() {
      rollbackEvidenceFenceCalls += 1;
      if (options?.rollbackEvidenceFence) {
        return await options.rollbackEvidenceFence(rollbackEvidenceFenceCalls);
      }
      const row = db.db.prepare("SELECT MAX(seq) AS maxSeq FROM conversation_events WHERE thread_id = ?")
        .get(String(THREAD_ID)) as { maxSeq?: number | null } | undefined;
      return Number(row?.maxSeq ?? 1);
    },
  } as unknown as ApiHandlerContext;

  return {
    db,
    ctx,
    workspacePath,
    sent,
    rollbackCalls,
    rollbackExpectations,
    runtimeSessions,
    blobIds,
    get getOrCreateCalls() {
      return getOrCreateCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    get flushEvidenceCalls() {
      return flushEvidenceCalls;
    },
    get rollbackEvidenceFenceCalls() {
      return rollbackEvidenceFenceCalls;
    },
    setProviderHistoryTurnIds(turnIds: string[]) {
      providerHistoryTurnIds = [...turnIds];
    },
    cleanup() {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

type RollbackHarness = ReturnType<typeof setupRollbackHarness>;

for (const failAt of [0, 1, 2]) test(`真实Writer回滚在证据构建和提交前等待异步ACK排空（失败位置=${failAt}）`, async () => {
  const h = setupRollbackHarness();
  const writer = new ClientDbWriterService({ db: h.db, dbPath: path.join(h.workspacePath, "client.db"), onFatalError(error) { assert.fail(error); } });
  let flushes = 0;
  h.ctx.withDatabase = (requestId, operation) => writer.withLegacyDatabase(requestId, operation);
  h.ctx.fenceRollbackEvidence = async () => 20;
  h.ctx.flushRollbackEvidence = async () => {
    assert.throws(() => h.db.turns.get(BASE_TURN_ID), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/);
    await writer.withLegacyDatabase("async-rollback-flush", () => h.db.conversationEvents.getLatestSeqByThread(THREAD_ID));
    if (++flushes === failAt) throw new Error("ASYNC_ROLLBACK_ACK_FAILED");
  };
  try {
    await writer.ready();
    await handleThreadsRollback(h.ctx, { t: "api.req", id: "async-rollback", method: "threads.rollback", path: "/test", body: {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, toTurnId: DROPPED_TURN_ID, rollbackFiles: false,
    } });
    assert.equal((h.sent.find(message => message.t === "api.res") as any)?.status, failAt ? 500 : 200);
    assert.equal(h.rollbackCalls.length, failAt === 1 ? 0 : 1);
    assert.equal(await writer.withLegacyDatabase("verify-rollback-trim", () => h.db.conversationEvents.getLatestSeqByThread(THREAD_ID)), failAt ? 18 : 5);
  } finally { await writer.close(); h.cleanup(); }
});

for (const providerFails of [false, true]) test(`回滚在每个同步数据库短段取得许可，provider与排空等待不持锁（provider失败=${providerFails}）`, async () => {
  let permitted = false;
  const harness = setupRollbackHarness({ providerPrepare: async () => { assert.equal(permitted, false); }, providerRollback: async () => {
    assert.equal(permitted, false);
    if (providerFails) throw new Error("PROVIDER_ROLLBACK_FAILED");
  } });
  try {
    let fenced = false, leases = 0;
    harness.ctx.withDatabase = async (_requestId, operation) => {
      assert.equal(permitted, false); permitted = true; leases++;
      try { const result = operation(); assert.equal(Boolean(result && typeof (result as any).then === "function"), false); return result; }
      finally { permitted = false; }
    };
    (harness.ctx.sessions as any).beginThreadDeletion = () => { fenced = true; return () => { fenced = false; }; };
    harness.ctx.flushLocalEvents = async () => { assert.equal(permitted, false); assert.equal(fenced, true); };
    harness.ctx.fenceRollbackEvidence = async () => { assert.equal(permitted, false); return 20; };
    for (const name of ["threads", "turns", "rollbacks", "conversationEvents", "rawEvents", "fileChanges", "blobs", "threadMessageQueue", "threadQueueStates"] as const) {
      const repository = harness.db[name];
      (harness.ctx.db as any)[name] = new Proxy(repository, { get(target, key) {
        const value = Reflect.get(target, key, target);
        return typeof value !== "function" ? value : (...args: unknown[]) => {
          assert.equal(permitted, true, `数据库许可缺失：${name}.${String(key)}`);
          return value.apply(target, args);
        };
      } });
    }
    await handleThreadsRollback(harness.ctx, { t: "api.req", id: "rollback-short-lease", method: "threads.rollback", path: "/test", body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, toTurnId: DROPPED_TURN_ID, rollbackFiles: false } });
    assert.equal((harness.sent.find(message => message.t === "api.res") as any)?.status, providerFails ? 502 : 200);
    assert.ok(leases > 3);
    assert.equal(fenced, false);
  } finally { harness.cleanup(); }
});

test("未决回滚的索引排空失败时保持未决，不伪造恢复成功", async () => {
  const harness = setupRollbackHarness({ disposeFailures: 1 });
  const request: ApiRequestMessage = { t: "api.req", id: "rollback-index-failed", method: "threads.rollback", path: "/test", body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, toTurnId: DROPPED_TURN_ID, rollbackFiles: false } };
  try {
    await handleThreadsRollback(harness.ctx, request);
    const unresolved = harness.db.rollbacks.findLatestUnresolvedByThread(THREAD_ID);
    assert.ok(unresolved);
    harness.ctx.flushLocalEvents = async () => { throw new Error("ROLLBACK_INDEX_BARRIER_FAILED"); };
    const result = await reconcileUnresolvedRollbackBeforeMutation(harness.ctx, request, { workspaceId: WORKSPACE_ID, threadId: THREAD_ID });
    assert.equal(result, null);
    assert.equal(harness.db.rollbacks.findLatestUnresolvedByThread(THREAD_ID)?.id, unresolved.id);
    assert.equal((harness.sent.at(-1) as any)?.status, 409);
  } finally { harness.cleanup(); }
});

function seedFileChange(
  harness: RollbackHarness,
  input: {
    path: string;
    before: string | null;
    after: string | null;
    turnId?: TurnId;
    capturedAt?: number;
  },
): { beforeBlobId: string | null; afterBlobId: string | null } {
  const turnId = input.turnId ?? DROPPED_TURN_ID;
  const capturedAt = input.capturedAt ?? 3_100;
  const beforeBlobId = input.before == null ? null : harness.db.blobs.put(Buffer.from(input.before, "utf8"), "utf8");
  const afterBlobId = input.after == null ? null : harness.db.blobs.put(Buffer.from(input.after, "utf8"), "utf8");
  if (beforeBlobId) harness.blobIds.add(beforeBlobId);
  if (afterBlobId) harness.blobIds.add(afterBlobId);

  harness.db.fileChanges.captureBefore({
    threadId: THREAD_ID,
    turnId,
    path: input.path,
    beforeExists: input.before != null,
    beforeBlobId,
    capturedAt,
  });
  harness.db.fileChanges.captureAfter({
    threadId: THREAD_ID,
    turnId,
    path: input.path,
    afterExists: input.after != null,
    afterBlobId,
    capturedAt: capturedAt + 800,
  });
  writeDiskFile(harness.workspacePath, input.path, input.after);
  return { beforeBlobId, afterBlobId };
}

function seedCodexDiff(harness: RollbackHarness, paths: string[]): void {
  seedCodexDiffText(harness, buildUnifiedDiff(paths));
}

/** 写入指定 unified diff，供 rename 等聚合证据场景复用。 */
function seedCodexDiffText(harness: RollbackHarness, diff: string): void {
  seedCodexDiffEvent(harness, diff, {
    seq: 12,
    ts: 3_200,
    turnId: DROPPED_TURN_ID,
    itemId: "diff-rollback",
  });
}

/** 写入指定 turn 的 provider diff，供多 turn recovery 场景复用。 */
function seedCodexDiffEvent(
  harness: RollbackHarness,
  diff: string,
  input: { seq: number; ts: number; turnId: TurnId; itemId: string },
): void {
  harness.db.conversationEvents.appendEnvelope({
    schema: 1,
    seq: input.seq,
    ts: input.ts,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    type: "item.diff.created",
    payload: {
      itemId: input.itemId as any,
      title: "Codex aggregate diff",
      diff,
      turnId: input.turnId,
      status: "completed",
    },
  });
}

/** 增加第二个待回滚 turn，构造同路径跨 turn 的多段 inverse。 */
function seedLaterDroppedTurn(harness: RollbackHarness): void {
  harness.db.turns.insertStarted({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    turnId: LATER_DROPPED_TURN_ID,
    startedAt: 5_000,
    startEventSeq: 21,
  });
  harness.db.turns.setEnded(LATER_DROPPED_TURN_ID, {
    status: "completed",
    endedAt: 6_000,
    endEventSeq: 30,
  });
  harness.db.turns.setEngineSessionIdByThread(THREAD_ID, SESSION_ID);
  harness.db.turns.setCodexProviderTurnId(LATER_DROPPED_TURN_ID, {
    engineTurnId: LATER_DROPPED_PROVIDER_TURN_ID,
    engineSessionId: SESSION_ID,
    source: "turn.engineBound",
    eventSeq: 22,
    observedAt: 5_200,
  });
}

/** 追加多组完整 Codex 控制事件，构造会重放大量 provider turn 的预览历史。 */
function seedBulkProviderHistoryTurns(harness: RollbackHarness, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const turnId = `turn-rollback-bulk-${index}` as TurnId;
    const providerTurnId = `provider-turn-rollback-bulk-${index}`;
    const startSeq = 100 + index * 10;
    for (const event of [
      {
        seq: startSeq,
        ts: 10_000 + index * 1_000,
        type: "turn.started",
        payload: { turnId },
      },
      {
        seq: startSeq + 1,
        ts: 10_100 + index * 1_000,
        type: "turn.engineBound",
        payload: {
          turnId,
          engineTurnId: providerTurnId,
          previousEngineTurnId: null,
          engineSessionId: SESSION_ID,
        },
      },
      {
        seq: startSeq + 2,
        ts: 10_200 + index * 1_000,
        type: "turn.completed",
        payload: { turnId },
      },
    ] as const) {
      harness.db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: event.seq,
        ts: event.ts,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        engine: "codex",
        type: event.type,
        payload: event.payload,
      } as any);
    }
  }
}

/** 将默认待删 turn 改造成 provider thread 创建前失败的本地-only 回合。 */
function seedPreProviderFailedTurn(harness: RollbackHarness, options?: { structuredMethod?: boolean }): void {
  harness.db.rawEvents.deleteByThread(THREAD_ID);
  harness.db.turns.setEngineCheckpoint(DROPPED_TURN_ID, "{}");
  harness.db.turns.setEnded(DROPPED_TURN_ID, {
    status: "error",
    endedAt: 4_000,
    endEventSeq: 20,
  });
  harness.db.conversationEvents.appendEnvelope({
    schema: 1,
    seq: 20,
    ts: 4_000,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    type: "turn.error",
    payload: {
      turnId: DROPPED_TURN_ID,
      error: "Codex app-server request timeout: thread/start",
      code: "codex_app_server_request_timeout",
      ...(options?.structuredMethod ? { requestMethod: "thread/start" } : {}),
      terminationKind: "error",
    },
  });
}

/** 构造同一路径 v1 -> v2 -> v3 的两 turn 变更与 provider diff。 */
function seedTwoStepFileChange(harness: RollbackHarness, filePath: string): void {
  seedLaterDroppedTurn(harness);
  seedFileChange(harness, {
    path: filePath,
    before: "v1\n",
    after: "v2\n",
  });
  seedCodexDiffEvent(harness, buildUnifiedDiff([filePath]), {
    seq: 12,
    ts: 3_200,
    turnId: DROPPED_TURN_ID,
    itemId: "diff-rollback-first",
  });
  seedFileChange(harness, {
    path: filePath,
    before: "v2\n",
    after: "v3\n",
    turnId: LATER_DROPPED_TURN_ID,
    capturedAt: 5_100,
  });
  seedCodexDiffEvent(harness, buildUnifiedDiff([filePath]), {
    seq: 22,
    ts: 5_200,
    turnId: LATER_DROPPED_TURN_ID,
    itemId: "diff-rollback-later",
  });
}

function buildUnifiedDiff(paths: string[]): string {
  return `${paths.map((filePath, index) => [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1 +1 @@",
    `-before-${index}`,
    `+after-${index}`,
  ].join("\n")).join("\n")}\n`;
}

function writeDiskFile(workspacePath: string, relativePath: string, content: string | null): void {
  const absolutePath = path.join(workspacePath, ...relativePath.split("/"));
  if (content == null) {
    try {
      fs.unlinkSync(absolutePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    return;
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

function readDiskFile(harness: RollbackHarness, relativePath: string): string {
  return fs.readFileSync(path.join(harness.workspacePath, ...relativePath.split("/")), "utf8");
}

/** 捕获审计表之外的回滚相关持久化状态，用于证明失败路径没有局部裁剪。 */
function snapshotProtectedHistory(db: ClientDb): Record<string, unknown> {
  return {
    thread: db.db
      .prepare("SELECT id, session_id, updated_at FROM threads WHERE id = ?")
      .all(String(THREAD_ID)),
    conversationEvents: db.db
      .prepare("SELECT seq, type, event_json, ts FROM conversation_events WHERE thread_id = ? ORDER BY seq")
      .all(String(THREAD_ID)),
    rawEvents: db.db
      .prepare("SELECT seq, source, event_json, ts FROM raw_engine_events WHERE thread_id = ? ORDER BY seq")
      .all(String(THREAD_ID)),
    turns: db.db
      .prepare("SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY start_event_seq")
      .all(String(THREAD_ID)),
    fileChanges: db.db
      .prepare("SELECT * FROM turn_file_changes WHERE thread_id = ? ORDER BY id")
      .all(String(THREAD_ID)),
    blobs: db.db
      .prepare("SELECT blob_id, byte_len, encoding, hex(data) AS data_hex, created_at FROM file_blobs ORDER BY blob_id")
      .all(),
  };
}

/** 执行回滚请求并返回对应 API 响应。 */
async function executeRollback(
  harness: RollbackHarness,
  requestId: string,
  options?: { rollbackFiles?: boolean; toTurnId?: TurnId },
): Promise<any> {
  await handleThreadsRollback(harness.ctx, {
    t: "api.req",
    id: requestId,
    method: "threads.rollback",
    path: "/threads/rollback",
    body: {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      toTurnId: options?.toTurnId ?? DROPPED_TURN_ID,
      rollbackFiles: options?.rollbackFiles ?? true,
    },
  } as ApiRequestMessage);
  const response = harness.sent.find((message) => message.t === "api.res" && message.id === requestId);
  assert.ok(response, `missing api.res for ${requestId}`);
  return response;
}

/** 执行回滚预览并返回对应 API 响应。 */
async function executeRollbackPreview(harness: RollbackHarness, requestId: string): Promise<any> {
  await handleThreadsRollbackPreview(harness.ctx, {
    t: "api.req",
    id: requestId,
    method: "threads.rollback.preview",
    path: "/threads/rollback/preview",
    body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, toTurnId: DROPPED_TURN_ID },
  } as ApiRequestMessage);
  const response = harness.sent.find((message) => message.t === "api.res" && message.id === requestId);
  assert.ok(response, `missing api.res for ${requestId}`);
  return response;
}

/** 直接执行未决回滚核对，避免把第二次回滚请求混入状态机断言。 */
async function executeRollbackReconciliation(harness: RollbackHarness, requestId: string) {
  return await reconcileUnresolvedRollbackBeforeMutation(harness.ctx, {
    t: "api.req",
    id: requestId,
    method: "threads.sendMessage",
    path: "/threads/sendMessage",
    body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID },
  } as ApiRequestMessage, { workspaceId: WORKSPACE_ID, threadId: THREAD_ID });
}

/** 执行文件面板批量撤销并返回对应 API 响应。 */
function executeFileUndo(harness: RollbackHarness, requestId: string, paths: string[]): any {
  handleThreadsFileChangesUndo(harness.ctx, {
    t: "api.req",
    id: requestId,
    method: "threads.fileChanges.undo",
    path: "/threads/file-changes/undo",
    body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, paths },
  } as ApiRequestMessage);
  const response = harness.sent.find((message) => message.t === "api.res" && message.id === requestId);
  assert.ok(response, `missing api.res for ${requestId}`);
  return response;
}

function readSingleAudit(harness: RollbackHarness) {
  const rows = harness.db.rollbacks.listByThread(THREAD_ID);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

function parseAuditError(error: string | null): {
  phase?: string;
  message?: string;
  requestId?: string;
  recoveryPlan?: any;
} {
  assert.ok(error);
  return JSON.parse(error) as {
    phase?: string;
    message?: string;
    requestId?: string;
    recoveryPlan?: any;
  };
}

test("threads.rollback restores created, modified, and deleted files and trims local history", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "created.txt", before: null, after: "created after\n" });
    seedFileChange(harness, { path: "nested/modified.txt", before: "modified before\n", after: "modified after\n" });
    seedFileChange(harness, { path: "deleted.txt", before: "deleted before\n", after: null });
    seedCodexDiff(harness, ["created.txt", "nested/modified.txt", "deleted.txt"]);

    const response = await executeRollback(harness, "req-rollback-success");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ok: true,
      droppedTurnCount: 1,
      revertedFileCount: 3,
      skippedFileCount: 0,
      fileRollbackStatus: "completed",
      rollbackEventSeqBarrier: 18,
    });
    assert.equal(fs.existsSync(path.join(harness.workspacePath, "created.txt")), false);
    assert.equal(readDiskFile(harness, "nested/modified.txt"), "modified before\n");
    assert.equal(readDiskFile(harness, "deleted.txt"), "deleted before\n");
    assert.deepEqual(harness.rollbackCalls, [1]);
    assert.deepEqual(harness.rollbackExpectations, [{
      droppedTurnIds: [DROPPED_PROVIDER_TURN_ID],
      retainedTurnId: BASE_PROVIDER_TURN_ID,
    }]);
    assert.equal(harness.getOrCreateCalls, 1);
    assert.deepEqual(harness.runtimeSessions, [{ sessionId: SESSION_ID }]);
    assert.equal(harness.disposeCalls, 1);

    assert.deepEqual(harness.db.turns.listByThread(THREAD_ID).map((turn) => turn.turnId), [BASE_TURN_ID]);
    assert.deepEqual(
      harness.db.conversationEvents.listByThread(THREAD_ID).map((event) => event.seq),
      [5],
    );
    assert.deepEqual(
      harness.db.rawEvents.pageByThread(THREAD_ID).events.map((event) => event.seq),
      [5, 2],
    );
    assert.equal(harness.db.fileChanges.listByThread(THREAD_ID).length, 0);
    for (const blobId of harness.blobIds) assert.equal(harness.db.blobs.get(blobId), null);
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "success");
    assert.equal(audit.error, null);
    assert.equal(audit.toTurnId, DROPPED_TURN_ID);
    assert.equal(audit.droppedTurnCount, 1);
    assert.equal(audit.droppedEventSeqGt, 10);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preview rejects a running thread before rebuilding history", async () => {
  const harness = setupRollbackHarness();
  const runningTurnId = "turn-rollback-running" as TurnId;
  const originalPrepare = harness.db.db.prepare.bind(harness.db.db);
  const originalListByThread = harness.db.fileChanges.listByThread.bind(harness.db.fileChanges);
  let providerHistoryQueries = 0;
  try {
    harness.db.turns.insertStarted({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      turnId: runningTurnId,
      startedAt: 5_000,
      startEventSeq: 21,
    });
    (harness.db.fileChanges as any).listByThread = () => {
      throw new Error("running preview must not read file history");
    };
    (harness.db.db as any).prepare = (sql: string) => {
      const normalized = String(sql);
      if (normalized.includes("FROM conversation_events") || normalized.includes("FROM raw_engine_events")) {
        providerHistoryQueries += 1;
        throw new Error("running preview must not query provider history");
      }
      return originalPrepare(sql);
    };

    const response = await executeRollbackPreview(harness, "req-rollback-preview-running");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_thread_running");
    assert.match(String(response.body?.message ?? ""), /thread 运行中/);
    assert.equal(providerHistoryQueries, 0);
    assert.equal(harness.flushEvidenceCalls, 0);
  } finally {
    (harness.db.db as any).prepare = originalPrepare;
    (harness.db.fileChanges as any).listByThread = originalListByThread;
    harness.cleanup();
  }
});

test("threads.rollback rejects a turn that starts during file assessment", async () => {
  const harness = setupRollbackHarness();
  const runningTurnId = "turn-rollback-running-before-commit" as TurnId;
  const originalListByThread = harness.db.fileChanges.listByThread.bind(harness.db.fileChanges);
  let injected = false;
  try {
    seedFileChange(harness, { path: "running-before-commit.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["running-before-commit.txt"]);
    (harness.db.fileChanges as any).listByThread = (threadId: ThreadId) => {
      const records = originalListByThread(threadId);
      if (!injected) {
        injected = true;
        harness.db.turns.insertStarted({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          engine: "codex",
          turnId: runningTurnId,
          startedAt: 5_000,
          startEventSeq: 21,
        });
      }
      return records;
    };

    const response = await executeRollback(harness, "req-rollback-running-before-commit");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_thread_running");
    assert.equal(response.body?.details?.runningTurnId, runningTurnId);
    assert.equal(harness.getOrCreateCalls, 0);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 0);
  } finally {
    (harness.db.fileChanges as any).listByThread = originalListByThread;
    harness.cleanup();
  }
});

test("Codex provider history batch fails closed when raw history prepare fails before a later target", () => {
  const harness = setupRollbackHarness();
  const originalPrepare = harness.db.db.prepare.bind(harness.db.db);
  try {
    (harness.db.db as any).prepare = (sql: string) => {
      if (String(sql).includes("FROM raw_engine_events") && String(sql).includes("codex.app-server.msg")) {
        throw new Error("injected raw history prepare failure");
      }
      return originalPrepare(sql);
    };

    const batch = prepareCodexProviderTurnHistoryBatch(harness.db, {
      threadId: THREAD_ID,
      clientTurnIds: [BASE_TURN_ID, DROPPED_TURN_ID],
    });

    assert.throws(
      () => batch.findTurnId(DROPPED_TURN_ID),
      /injected raw history prepare failure/,
    );
  } finally {
    (harness.db.db as any).prepare = originalPrepare;
    harness.cleanup();
  }
});

test("Codex provider history batch does not correlate empty client ids", () => {
  const harness = setupRollbackHarness();
  const targetTurnId = "turn-rollback-empty-client-id" as TurnId;
  const providerTurnId = "provider-turn-empty-client-id";
  try {
    harness.db.turns.insertStarted({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      turnId: targetTurnId,
      startedAt: 5_000,
      startEventSeq: 21,
    });
    harness.db.turns.setEnded(targetTurnId, { status: "completed", endedAt: 6_000, endEventSeq: 24 });
    harness.db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 22,
      ts: 5_200,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      source: "codex.app-server.msg",
      clientTurnId: targetTurnId,
      data: {
        method: "item/started",
        params: { item: { type: "userMessage" }, turn: { id: providerTurnId } },
      },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);
    harness.db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 23,
      ts: 5_300,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      source: "codex.app-server.msg",
      data: { method: "turn/started", params: { turn: { id: providerTurnId } } },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);

    const batch = prepareCodexProviderTurnHistoryBatch(harness.db, {
      threadId: THREAD_ID,
      clientTurnIds: [targetTurnId],
    });

    assert.equal(batch.findTurnId(targetTurnId), null);
    assert.equal(harness.db.turns.get(targetTurnId)?.engineCheckpointJson, null);
  } finally {
    harness.cleanup();
  }
});

test("Codex provider history batch keeps the full canonical window for a zero start seq", () => {
  const harness = setupRollbackHarness();
  const targetTurnId = "turn-rollback-zero-start-seq" as TurnId;
  const providerTurnId = "provider-turn-zero-start-seq";
  try {
    harness.db.turns.insertStarted({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      turnId: targetTurnId,
      startedAt: 100,
      startEventSeq: 0,
    });
    harness.db.turns.setEnded(targetTurnId, { status: "completed", endedAt: 400, endEventSeq: 4 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 1,
      ts: 200,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: targetTurnId,
        engineTurnId: providerTurnId,
        previousEngineTurnId: null,
        engineSessionId: SESSION_ID,
      },
    } as any);

    const batch = prepareCodexProviderTurnHistoryBatch(harness.db, {
      threadId: THREAD_ID,
      clientTurnIds: [targetTurnId, DROPPED_TURN_ID],
    });

    assert.deepEqual(batch.findPair(targetTurnId), {
      engineSessionId: SESSION_ID,
      engineTurnId: providerTurnId,
    });
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preview scans provider history a constant number of times", async () => {
  const harness = setupRollbackHarness();
  const originalPrepare = harness.db.db.prepare.bind(harness.db.db);
  try {
    seedBulkProviderHistoryTurns(harness, 12);
    let canonicalHistoryPrepares = 0;
    let rawHistoryPrepares = 0;
    (harness.db.db as any).prepare = (sql: string) => {
      const normalized = String(sql);
      if (normalized.includes("FROM conversation_events") && normalized.includes("turn.engineBound")) {
        canonicalHistoryPrepares += 1;
      }
      if (normalized.includes("FROM raw_engine_events") && normalized.includes("codex.app-server.msg")) {
        rawHistoryPrepares += 1;
      }
      return originalPrepare(sql);
    };

    const response = await executeRollbackPreview(harness, "req-rollback-preview-bulk-provider-history");

    assert.equal(response.status, 200);
    assert.equal(response.body?.droppedTurnCount, 13);
    assert.ok(canonicalHistoryPrepares <= 2, `canonical history prepared ${canonicalHistoryPrepares} times`);
    assert.ok(rawHistoryPrepares <= 1, `raw history prepared ${rawHistoryPrepares} times`);
  } finally {
    (harness.db.db as any).prepare = originalPrepare;
    harness.cleanup();
  }
});

test("threads.rollback reuses one indexed file-change read", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "indexed-file-change.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["indexed-file-change.txt"]);
    const originalListByThread = harness.db.fileChanges.listByThread.bind(harness.db.fileChanges);
    let listByThreadCalls = 0;
    (harness.db.fileChanges as any).listByThread = (threadId: ThreadId) => {
      listByThreadCalls += 1;
      return originalListByThread(threadId);
    };
    (harness.db.fileChanges as any).listByThreadAndTurn = () => {
      throw new Error("rollback must reuse its file-change index");
    };

    const response = await executeRollback(harness, "req-rollback-indexed-file-changes");

    assert.equal(response.status, 200);
    assert.equal(listByThreadCalls, 1);
    assert.equal(readDiskFile(harness, "indexed-file-change.txt"), "before\n");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback refreshes the canonical event barrier inside the local commit", async () => {
  let harness!: RollbackHarness;
  harness = setupRollbackHarness({
    flushRollbackEvidence(callCount) {
      if (callCount !== 2) return;
      harness.db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: 24,
        ts: 4_200,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        engine: "codex",
        type: "system.notice",
        payload: { level: "info", text: "late canonical event during provider apply" },
      });
    },
  });
  try {
    seedFileChange(harness, { path: "late-barrier.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["late-barrier.txt"]);

    const response = await executeRollback(harness, "req-rollback-late-barrier");

    assert.equal(response.status, 200);
    assert.equal(response.body?.rollbackEventSeqBarrier, 24);
    assert.deepEqual(
      harness.db.conversationEvents.listByThread(THREAD_ID).map((event) => event.seq),
      [5],
    );
    assert.deepEqual(harness.rollbackCalls, [1]);
    assert.equal(harness.flushEvidenceCalls, 2);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback includes the Server fence when its ACK is not yet in canonical SQLite", async () => {
  const harness = setupRollbackHarness({
    rollbackEvidenceFence() {
      return 24;
    },
  });
  try {
    seedFileChange(harness, { path: "network-fence.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["network-fence.txt"]);

    const response = await executeRollback(harness, "req-rollback-network-fence");

    assert.equal(response.status, 200);
    assert.equal(response.body?.rollbackEventSeqBarrier, 24);
    assert.equal(harness.rollbackEvidenceFenceCalls, 1);
    assert.deepEqual(
      harness.db.conversationEvents.listByThread(THREAD_ID).map((event) => event.seq),
      [5],
    );
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback rejects a Codex diff path without a captured snapshot before provider mutation", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "tracked.txt", before: "tracked before\n", after: "tracked after\n" });
    writeDiskFile(harness.workspacePath, "shell-only.txt", "changed indirectly by shell\n");
    seedCodexDiff(harness, ["tracked.txt", "shell-only.txt"]);
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-untracked");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_evidence_incomplete");
    assert.equal(response.body?.details?.evidenceIssues?.some(
      (issue: any) => issue.code === "untracked_change" && issue.path === "shell-only.txt",
    ), true);
    assert.equal(readDiskFile(harness, "tracked.txt"), "tracked after\n");
    assert.equal(readDiskFile(harness, "shell-only.txt"), "changed indirectly by shell\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 0);
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(harness.getOrCreateCalls, 0);
    assert.equal(harness.disposeCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback rejects a captured file omitted by the Codex diff before provider mutation", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "tracked.txt", before: "tracked before\n", after: "tracked after\n" });
    seedFileChange(harness, { path: "omitted.txt", before: "omitted before\n", after: "omitted after\n" });
    seedCodexDiff(harness, ["tracked.txt"]);
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-diff-omitted");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_evidence_incomplete");
    assert.equal(response.body?.details?.evidenceIssues?.some(
      (issue: any) => issue.code === "invalid_provider_diff" && issue.path === "omitted.txt",
    ), true);
    assert.equal(readDiskFile(harness, "tracked.txt"), "tracked after\n");
    assert.equal(readDiskFile(harness, "omitted.txt"), "omitted after\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback rejects a workspace symlink or junction before provider mutation", async (t) => {
  const harness = setupRollbackHarness();
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-rollback-external-"));
  const linkedDirectory = path.join(harness.workspacePath, "linked");
  try {
    try {
      fs.symlinkSync(externalRoot, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (cause) {
      const code = String((cause as NodeJS.ErrnoException)?.code ?? "");
      if (["EPERM", "EACCES", "UNKNOWN"].includes(code)) {
        t.skip(`当前环境无法创建 symlink/junction：${code}`);
        return;
      }
      throw cause;
    }
    seedFileChange(harness, { path: "linked/outside.txt", before: "outside before\n", after: "outside after\n" });
    seedCodexDiff(harness, ["linked/outside.txt"]);
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-linked-path");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_file_conflict");
    assert.match(String(response.body?.details?.files?.[0]?.conflictReason ?? ""), /symlink\/junction/);
    assert.equal(fs.readFileSync(path.join(externalRoot, "outside.txt"), "utf8"), "outside after\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(harness.getOrCreateCalls, 0);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 0);
  } finally {
    harness.cleanup();
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("threads.rollback rejects an external disk conflict with no file, provider, or DB side effects", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "conflicted.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["conflicted.txt"]);
    writeDiskFile(harness.workspacePath, "conflicted.txt", "external edit\n");
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-conflict");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_file_conflict");
    assert.equal(response.body?.details?.files?.[0]?.path, "conflicted.txt");
    assert.equal(response.body?.details?.files?.[0]?.hasConflict, true);
    assert.match(String(response.body?.details?.files?.[0]?.conflictReason ?? ""), /会话外被修改/);
    assert.equal(readDiskFile(harness, "conflicted.txt"), "external edit\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 0);
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(harness.getOrCreateCalls, 0);
    assert.equal(harness.disposeCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preserves an external edit made after assessment but before file mutation", async () => {
  const harness = setupRollbackHarness({
    providerPrepare(workspacePath) {
      writeDiskFile(workspacePath, "late-conflict.txt", "late external edit\n");
    },
  });
  try {
    seedFileChange(harness, { path: "late-conflict.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["late-conflict.txt"]);
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-late-conflict");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_file_conflict");
    assert.match(String(response.body?.message ?? ""), /回滚提交期间发生变化/);
    assert.equal(readDiskFile(harness, "late-conflict.txt"), "late external edit\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID)[0]?.result, "failed");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preserves a file conflict classification when provider cancel also fails", async () => {
  const harness = setupRollbackHarness({
    providerPrepare(workspacePath) {
      writeDiskFile(workspacePath, "late-conflict-cancel.txt", "late external edit\n");
    },
    providerCancel() {
      throw new Error("injected provider cancel failure");
    },
  });
  try {
    seedFileChange(harness, { path: "late-conflict-cancel.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["late-conflict-cancel.txt"]);
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-late-conflict-cancel");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_file_conflict");
    assert.match(String(response.body?.message ?? ""), /回滚提交期间发生变化/);
    assert.match(String(response.body?.message ?? ""), /injected provider cancel failure/);
    assert.equal(readDiskFile(harness, "late-conflict-cancel.txt"), "late external edit\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.deepEqual(harness.rollbackCalls, []);
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "failed");
    assert.equal(parseAuditError(audit.error).phase, "files");
  } finally {
    harness.cleanup();
  }
});

test("rollback handlers block repeated requests while provider prepare has no audit row yet", async () => {
  let markPrepareEntered!: () => void;
  let releasePrepare!: () => void;
  const prepareEntered = new Promise<void>((resolve) => {
    markPrepareEntered = resolve;
  });
  const prepareRelease = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  const harness = setupRollbackHarness({
    async providerPrepare() {
      markPrepareEntered();
      await prepareRelease;
    },
  });
  let pendingRollback: Promise<any> | null = null;
  const originalPrepare = harness.db.db.prepare.bind(harness.db.db);
  try {
    seedFileChange(harness, { path: "prepare-gate.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["prepare-gate.txt"]);
    pendingRollback = executeRollback(harness, "req-rollback-prepare-gate");
    await prepareEntered;
    const flushCallsBeforeRepeatedRequests = harness.flushEvidenceCalls;
    let providerHistoryQueries = 0;
    (harness.db.db as any).prepare = (sql: string) => {
      const normalized = String(sql);
      if (
        (normalized.includes("FROM conversation_events") && normalized.includes("turn.engineBound"))
        || (normalized.includes("FROM raw_engine_events") && normalized.includes("codex.app-server.msg"))
      ) {
        providerHistoryQueries += 1;
        throw new Error("repeated rollback request must not scan provider history");
      }
      return originalPrepare(sql);
    };

    const preview = await executeRollbackPreview(harness, "req-rollback-prepare-gate-preview");
    const formal = await executeRollback(harness, "req-rollback-prepare-gate-formal");
    const reconciliation = await executeRollbackReconciliation(harness, "req-rollback-prepare-gate-concurrent");
    const blocked = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-rollback-prepare-gate-concurrent",
    ) as any;
    const auditCountBeforeRelease = harness.db.rollbacks.listByThread(THREAD_ID).length;
    const flushCallsAfterRepeatedRequests = harness.flushEvidenceCalls;

    (harness.db.db as any).prepare = originalPrepare;
    releasePrepare();
    const response = await pendingRollback;
    pendingRollback = null;

    assert.equal(preview.status, 409);
    assert.equal(preview.body?.code, "rollback_in_progress");
    assert.equal(formal.status, 409);
    assert.equal(formal.body?.code, "rollback_in_progress");
    assert.equal(reconciliation, null);
    assert.equal(blocked?.status, 409);
    assert.equal(blocked?.body?.code, "rollback_in_progress");
    assert.equal(auditCountBeforeRelease, 0);
    assert.equal(providerHistoryQueries, 0);
    assert.equal(flushCallsAfterRepeatedRequests, flushCallsBeforeRepeatedRequests);
    assert.equal(response.status, 200);
    assert.deepEqual(harness.rollbackCalls, [1]);
  } finally {
    (harness.db.db as any).prepare = originalPrepare;
    releasePrepare?.();
    await pendingRollback?.catch(() => undefined);
    harness.cleanup();
  }
});

test("threads.rollback flushes and rebuilds provider history after async reconciliation", async () => {
  const replacementProviderTurnId = "provider-turn-rollback-dropped-replacement";
  let harness!: RollbackHarness;
  let providerRollbackCalls = 0;
  let replacementPending = false;
  harness = setupRollbackHarness({
    providerHistoryRead() {
      replacementPending = true;
    },
    flushRollbackEvidence() {
      if (!replacementPending) return;
      replacementPending = false;
      harness.db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: 25,
        ts: 5_000,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId: DROPPED_TURN_ID,
          engineTurnId: replacementProviderTurnId,
          previousEngineTurnId: DROPPED_PROVIDER_TURN_ID,
          engineSessionId: SESSION_ID,
        },
      } as any);
    },
    providerRollback() {
      providerRollbackCalls += 1;
      if (providerRollbackCalls === 1) {
        throw Object.assign(new Error("provider response lost before replacement reconciliation"), {
          providerMutationMayHaveApplied: true,
        });
      }
    },
  });
  try {
    const first = await executeRollback(harness, "req-rollback-refresh-history-start", { rollbackFiles: false });
    assert.equal(first.status, 502);
    assert.equal(first.body?.code, "rollback_provider_state_uncertain");
    harness.setProviderHistoryTurnIds([BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID]);

    const second = await executeRollback(harness, "req-rollback-refresh-history-retry", { rollbackFiles: false });

    assert.equal(second.status, 200);
    assert.deepEqual(
      harness.rollbackExpectations.map((expectation) => expectation.droppedTurnIds),
      [[DROPPED_PROVIDER_TURN_ID], [replacementProviderTurnId]],
    );
    assert.equal(harness.flushEvidenceCalls, 4);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback treats a delete-time ENOENT as an external conflict", async () => {
  const harness = setupRollbackHarness();
  const filePath = "delete-race-created.txt";
  const absolutePath = path.join(harness.workspacePath, filePath);
  const originalUnlinkSync = fs.unlinkSync;
  let injected = false;
  try {
    seedFileChange(harness, { path: filePath, before: null, after: "created\n" });
    seedCodexDiff(harness, [filePath]);
    (fs as any).unlinkSync = ((targetPath: fs.PathLike) => {
      if (!injected && path.resolve(String(targetPath)) === path.resolve(absolutePath)) {
        injected = true;
        originalUnlinkSync(targetPath);
        throw Object.assign(new Error("injected external delete race"), { code: "ENOENT" });
      }
      return originalUnlinkSync(targetPath);
    }) as typeof fs.unlinkSync;

    const response = await executeRollback(harness, "req-rollback-delete-enoent-race");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_file_conflict");
    assert.match(String(response.body?.message ?? ""), /回滚删除前已被外部移除/);
    assert.equal(fs.existsSync(absolutePath), false);
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(readSingleAudit(harness).result, "failed");
    assert.equal(parseAuditError(readSingleAudit(harness).error).phase, "files");
  } finally {
    (fs as any).unlinkSync = originalUnlinkSync;
    harness.cleanup();
  }
});

test("threads.rollback compensates files and marks audit failed when provider rollback definitely fails", async () => {
  const harness = setupRollbackHarness({
    providerRollback() {
      throw new Error("provider rejected rollback");
    },
  });
  try {
    seedFileChange(harness, { path: "provider-failure.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["provider-failure.txt"]);
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-provider-failed");

    assert.equal(response.status, 502);
    assert.equal(response.body?.code, "rollback_provider_failed");
    assert.match(String(response.body?.message ?? ""), /provider rejected rollback/);
    assert.equal(readDiskFile(harness, "provider-failure.txt"), "after\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.deepEqual(harness.rollbackCalls, [1]);
    assert.equal(harness.getOrCreateCalls, 1);
    assert.equal(harness.disposeCalls, 0);
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "failed");
    const auditError = parseAuditError(audit.error);
    assert.equal(auditError.requestId, "req-rollback-provider-failed");
    assert.equal(auditError.phase, "provider");
    assert.match(String(auditError.message ?? ""), /provider rejected rollback/);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preserves an external edit made while provider rollback fails", async () => {
  let workspacePath = "";
  const filePath = "provider-failure-external-edit.txt";
  const harness = setupRollbackHarness({
    providerRollback() {
      writeDiskFile(workspacePath, filePath, "external edit during provider wait\n");
      throw new Error("provider rejected rollback after external edit");
    },
  });
  workspacePath = harness.workspacePath;
  try {
    seedFileChange(harness, { path: filePath, before: "before\n", after: "after\n" });
    seedCodexDiff(harness, [filePath]);

    const response = await executeRollback(harness, "req-rollback-provider-external-edit");

    assert.equal(response.status, 502);
    assert.equal(response.body?.code, "rollback_file_compensation_conflict");
    assert.equal(readDiskFile(harness, filePath), "external edit during provider wait\n");
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "partial");
    const auditError = parseAuditError(audit.error);
    assert.equal(auditError.phase, "provider_compensation_conflict");
    assert.match(String(auditError.message ?? ""), /文件补偿冲突/);
    assert.equal(harness.db.turns.listByThread(THREAD_ID).length, 2);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preserves a compensation conflict nested in an aggregate error", async () => {
  const firstPath = "aggregate-compensation-first.txt";
  const secondPath = "aggregate-compensation-second.txt";
  const harness = setupRollbackHarness({
    providerRollback() {
      throw new Error("provider rejected rollback before aggregate compensation");
    },
  });
  const absolutePaths = new Map([
    [path.resolve(path.join(harness.workspacePath, firstPath)), firstPath],
    [path.resolve(path.join(harness.workspacePath, secondPath)), secondPath],
  ]);
  const originalRenameSync = fs.renameSync;
  let externallyEditedPath: string | null = null;
  try {
    seedFileChange(harness, { path: firstPath, before: "first before\n", after: "first after\n" });
    seedFileChange(harness, { path: secondPath, before: "second before\n", after: "second after\n" });
    seedCodexDiff(harness, [firstPath, secondPath]);
    (fs as any).renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      const destination = path.resolve(String(newPath));
      if (!externallyEditedPath && harness.rollbackCalls.length === 1 && absolutePaths.has(destination)) {
        const completedPath = absolutePaths.get(destination)!;
        externallyEditedPath = completedPath === firstPath ? secondPath : firstPath;
        writeDiskFile(harness.workspacePath, externallyEditedPath, "external edit between compensation files\n");
      }
      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;

    const response = await executeRollback(harness, "req-rollback-aggregate-compensation-conflict");

    assert.equal(response.status, 502);
    assert.equal(response.body?.code, "rollback_file_compensation_conflict");
    assert.ok(externallyEditedPath);
    assert.equal(readDiskFile(harness, externallyEditedPath), "external edit between compensation files\n");
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "partial");
    assert.equal(parseAuditError(audit.error).phase, "provider_compensation_conflict");
  } finally {
    (fs as any).renameSync = originalRenameSync;
    harness.cleanup();
  }
});

test("threads.rollback compensates only paths whose inverse mutation may have applied", async () => {
  const harness = setupRollbackHarness();
  const conflictPath = "inverse-failed-before-rename.txt";
  const completedPath = "inverse-completed-first.txt";
  const conflictAbs = path.join(harness.workspacePath, conflictPath);
  const originalRenameSync = fs.renameSync;
  let injected = false;
  try {
    seedFileChange(harness, { path: conflictPath, before: "conflict before\n", after: "conflict after\n" });
    seedFileChange(harness, { path: completedPath, before: "completed before\n", after: "completed after\n" });
    seedCodexDiff(harness, [conflictPath, completedPath]);
    (fs as any).renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!injected && path.resolve(String(newPath)) === path.resolve(conflictAbs)) {
        injected = true;
        writeDiskFile(harness.workspacePath, conflictPath, "external edit before failed rename\n");
        throw new Error("injected rename failure before target mutation");
      }
      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;

    const response = await executeRollback(harness, "req-rollback-file-mutation-tracking");

    assert.equal(response.status, 500);
    assert.match(String(response.body?.message ?? ""), /injected rename failure/);
    assert.equal(readDiskFile(harness, conflictPath), "external edit before failed rename\n");
    assert.equal(readDiskFile(harness, completedPath), "completed after\n");
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "failed");
    assert.equal(parseAuditError(audit.error).phase, "files");
    assert.deepEqual(harness.rollbackCalls, []);
  } finally {
    (fs as any).renameSync = originalRenameSync;
    harness.cleanup();
  }
});

test("threads.rollback marks audit partial when provider failure compensation also fails", async () => {
  let workspacePath = "";
  const filePath = "provider-compensation-failure.txt";
  const harness = setupRollbackHarness({
    providerRollback() {
      const absolutePath = path.join(workspacePath, filePath);
      fs.rmSync(absolutePath);
      fs.mkdirSync(absolutePath);
      throw new Error("provider rejected rollback before mutation");
    },
  });
  workspacePath = harness.workspacePath;
  try {
    seedFileChange(harness, { path: filePath, before: "before\n", after: "after\n" });
    seedCodexDiff(harness, [filePath]);

    const response = await executeRollback(harness, "req-rollback-provider-compensation-failed");

    assert.equal(response.status, 502);
    assert.equal(response.body?.code, "rollback_file_compensation_failed");
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "partial");
    const auditError = parseAuditError(audit.error);
    assert.equal(auditError.phase, "provider_compensation");
    assert.match(String(auditError.message ?? ""), /文件补偿失败/);

    const retryResponse = await executeRollback(harness, "req-rollback-provider-compensation-retry", { rollbackFiles: false });
    assert.equal(retryResponse.status, 409);
    assert.equal(retryResponse.body?.code, "rollback_reconciliation_required");
    assert.equal(harness.rollbackCalls.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback keeps inverse files and marks audit partial when provider state is uncertain", async () => {
  const harness = setupRollbackHarness({
    providerRollback() {
      throw Object.assign(new Error("provider response lost after mutation"), {
        providerMutationMayHaveApplied: true,
      });
    },
  });
  try {
    seedFileChange(harness, { path: "provider-uncertain.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["provider-uncertain.txt"]);
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-provider-uncertain");

    assert.equal(response.status, 502);
    assert.equal(response.body?.code, "rollback_provider_state_uncertain");
    assert.match(String(response.body?.message ?? ""), /provider response lost after mutation/);
    assert.equal(readDiskFile(harness, "provider-uncertain.txt"), "before\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.deepEqual(harness.rollbackCalls, [1]);
    assert.equal(harness.getOrCreateCalls, 1);
    assert.equal(harness.disposeCalls, 0);
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "partial");
    const auditError = parseAuditError(audit.error);
    assert.equal(auditError.requestId, "req-rollback-provider-uncertain");
    assert.equal(auditError.phase, "provider_uncertain");
    assert.match(String(auditError.message ?? ""), /provider response lost after mutation/);

    const retryResponse = await executeRollback(harness, "req-rollback-provider-uncertain-retry", { rollbackFiles: false });
    assert.equal(retryResponse.status, 409);
    assert.equal(retryResponse.body?.code, "rollback_reconciliation_required");
    assert.equal(harness.rollbackCalls.length, 1);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 1);

  } finally {
    harness.cleanup();
  }
});

test("rollback reconciliation restores pre from a persisted multi-inverse intermediate state", async () => {
  const filePath = "reconcile-intermediate-provider-before.txt";
  const harness = setupRollbackHarness({
    providerRollback() {
      throw Object.assign(new Error("provider result unknown for intermediate recovery"), {
        providerMutationMayHaveApplied: true,
      });
    },
  });
  try {
    seedTwoStepFileChange(harness, filePath);
    const response = await executeRollback(harness, "req-reconcile-intermediate-before-start");
    assert.equal(response.status, 502);
    assert.equal(readDiskFile(harness, filePath), "v1\n");
    const preparedAudit = parseAuditError(readSingleAudit(harness).error);
    assert.equal(preparedAudit.recoveryPlan?.files?.[0]?.intermediateStates?.length, 1);
    assert.equal(preparedAudit.recoveryPlan?.rollbackEventSeqBarrier, 22);

    writeDiskFile(harness.workspacePath, filePath, "v2\n");
    harness.setProviderHistoryTurnIds([
      BASE_PROVIDER_TURN_ID,
      DROPPED_PROVIDER_TURN_ID,
      LATER_DROPPED_PROVIDER_TURN_ID,
    ]);
    const reconciled = await executeRollbackReconciliation(harness, "req-reconcile-intermediate-before");

    assert.equal(reconciled?.kind, "failed");
    assert.equal(reconciled?.recoveryPlan?.rollbackEventSeqBarrier, 22);
    assert.equal(readDiskFile(harness, filePath), "v3\n");
    assert.equal(readSingleAudit(harness).result, "failed");
    assert.equal(harness.db.turns.listByThread(THREAD_ID).length, 3);
  } finally {
    harness.cleanup();
  }
});

test("rollback reconciliation restores target from a persisted multi-inverse intermediate state", async () => {
  const filePath = "reconcile-intermediate-provider-after.txt";
  const harness = setupRollbackHarness({
    providerRollback() {
      throw Object.assign(new Error("provider result unknown after multi inverse"), {
        providerMutationMayHaveApplied: true,
      });
    },
  });
  try {
    seedTwoStepFileChange(harness, filePath);
    const response = await executeRollback(harness, "req-reconcile-intermediate-after-start");
    assert.equal(response.status, 502);
    assert.equal(readDiskFile(harness, filePath), "v1\n");

    writeDiskFile(harness.workspacePath, filePath, "v2\n");
    harness.setProviderHistoryTurnIds([BASE_PROVIDER_TURN_ID]);
    const reconciledResponse = await executeRollback(harness, "req-reconcile-intermediate-after");

    assert.equal(reconciledResponse.status, 200);
    assert.equal(reconciledResponse.body?.reconciled, true);
    assert.equal(reconciledResponse.body?.rollbackEventSeqBarrier, 22);
    assert.equal(readDiskFile(harness, filePath), "v1\n");
    assert.equal(readSingleAudit(harness).result, "success");
    assert.deepEqual(harness.db.turns.listByThread(THREAD_ID).map((turn) => turn.turnId), [BASE_TURN_ID]);
  } finally {
    harness.cleanup();
  }
});

test("rollback reconciliation restores pre files and marks failed when provider stayed before", async () => {
  const harness = setupRollbackHarness({
    providerRollback() {
      throw Object.assign(new Error("provider response lost before mutation"), { providerMutationMayHaveApplied: true });
    },
  });
  try {
    seedFileChange(harness, { path: "reconcile-before.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["reconcile-before.txt"]);
    const response = await executeRollback(harness, "req-reconcile-before-start");
    assert.equal(response.status, 502);
    assert.equal(readDiskFile(harness, "reconcile-before.txt"), "before\n");
    assert.equal(parseAuditError(readSingleAudit(harness).error).recoveryPlan?.files?.[0]?.intermediateStates, undefined);

    harness.setProviderHistoryTurnIds([BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID]);
    const reconciled = await executeRollbackReconciliation(harness, "req-reconcile-before");

    assert.equal(reconciled?.kind, "failed");
    assert.equal(readDiskFile(harness, "reconcile-before.txt"), "after\n");
    assert.equal(readSingleAudit(harness).result, "failed");
    assert.equal(harness.db.turns.listByThread(THREAD_ID).length, 2);
  } finally {
    harness.cleanup();
  }
});

test("rollback reconciliation completes local trim when provider reached after", async () => {
  const harness = setupRollbackHarness({
    providerRollback() {
      throw Object.assign(new Error("provider response lost after mutation"), { providerMutationMayHaveApplied: true });
    },
  });
  try {
    seedFileChange(harness, { path: "reconcile-after.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["reconcile-after.txt"]);
    const response = await executeRollback(harness, "req-reconcile-after-start");
    assert.equal(response.status, 502);
    assert.equal(readDiskFile(harness, "reconcile-after.txt"), "before\n");

    harness.setProviderHistoryTurnIds([BASE_PROVIDER_TURN_ID]);
    const reconciled = await executeRollbackReconciliation(harness, "req-reconcile-after");

    assert.equal(reconciled?.kind, "success");
    assert.equal(readDiskFile(harness, "reconcile-after.txt"), "before\n");
    assert.equal(readSingleAudit(harness).result, "success");
    assert.deepEqual(harness.db.turns.listByThread(THREAD_ID).map((turn) => turn.turnId), [BASE_TURN_ID]);
    assert.equal(harness.disposeCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test("post-reconcile 启动与终态围栏均失败保留原 barrier，重试不重复 terminal 或 queue consume", async () => {
  let harness!: RollbackHarness;
  let rejectPostCommitFence = true;
  let providerSendCalls = 0;
  let queueTerminalCalls = 0;
  let forceActiveConflict = false;
  harness = setupRollbackHarness({
    providerRollback() {
      throw Object.assign(new Error("provider response lost after mutation"), { providerMutationMayHaveApplied: true });
    },
    rollbackEvidenceFence() {
      const audit = harness.db.rollbacks.listByThread(THREAD_ID)[0] ?? null;
      if (rejectPostCommitFence && audit?.result === "success") {
        throw new Error("injected post-commit fence failure");
      }
      return 22;
    },
  });
  const newTurnId = "turn-post-reconcile-fence" as TurnId;
  try {
    // 完整发送入口须有可用模型目录，才能实际验证回滚后证据围栏。
    initializeLocalEngineModelCatalog();
    seedFileChange(harness, { path: "reconcile-fence.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["reconcile-fence.txt"]);
    const rollbackResponse = await executeRollback(harness, "req-reconcile-fence-start");
    assert.equal(rollbackResponse.status, 502);
    harness.setProviderHistoryTurnIds([BASE_PROVIDER_TURN_ID]);

    const originalGetOrCreate = (harness.ctx.sessions as any).getOrCreate.bind(harness.ctx.sessions);
    (harness.ctx.sessions as any).getOrCreate = (runtime: unknown) => {
      const session = originalGetOrCreate(runtime);
      session.resolvePlatformToolTransport = () => "native-dynamic";
      session.sendMessage = async () => {
        providerSendCalls += 1;
        return { responseText: "unexpected" };
      };
      return session;
    };
    (harness.ctx.sessions as any).hasActiveTurn = () => forceActiveConflict;
    harness.ctx.queueDispatcher = {
      notifyTurnTerminal() {
        queueTerminalCalls += 1;
      },
    } as any;
    harness.ctx.timeoutPolicy = { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 } as any;
    harness.ctx.orchEngine = {
      /** 真实 API 先进入工作区边界，夹具只允许当前测试工作区。 */
      forWorkspace(workspaceId: WorkspaceId) { assert.equal(workspaceId, WORKSPACE_ID); return this; },
      buildManagedServiceToolRegistry() { return null; },
    } as any;
    harness.ctx.onBeforeEmitConversationEvent = (event) => {
      if (event.type !== "turn.started" || String(event.payload.turnId) !== String(newTurnId)) return;
      if (harness.db.turns.get(newTurnId)) return;
      harness.db.turns.insertStarted({
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        engine: "codex",
        turnId: newTurnId,
        startedAt: event.ts,
        startEventSeq: 23,
      });
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-after-reconcile-fence",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: newTurnId,
        text: "continue after reconcile",
        __queueSource: { queueItemId: "queue-reconcile-fence" },
      },
    } as ApiRequestMessage);

    const failedResponse = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-send-after-reconcile-fence",
    ) as any;
    assert.equal(failedResponse?.status, 500, JSON.stringify(failedResponse?.body));
    await assert.rejects(waitForOrdinaryTurnExecution(harness.ctx.sessions, { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: newTurnId }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "ORDINARY_TURN_START_TERMINAL_FAILED");
      assert.equal(error.errors.length, 2);
      assert.ok(error.errors.every(cause => cause instanceof Error && cause.message === "injected post-commit fence failure"));
      return true;
    });
    assert.equal(failedResponse?.body?.rollbackReconciled, true);
    assert.equal(failedResponse?.body?.rollbackEventSeqBarrier, 22);
    assert.equal(providerSendCalls, 0);
    assert.equal(queueTerminalCalls, 0);
    assert.equal(harness.db.turns.get(newTurnId)?.status, "started");
    assert.equal(
      harness.sent.filter((message) => message.t === "conversation.event" && message.event.type === "turn.error").length,
      1,
    );

    rejectPostCommitFence = false;
    forceActiveConflict = true;
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-retry-pending-terminal",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "retry terminal" },
    } as ApiRequestMessage);

    assert.equal(harness.db.turns.get(newTurnId)?.status, "error");
    assert.equal(queueTerminalCalls, 0);
    assert.equal(
      harness.sent.filter((message) => message.t === "conversation.event" && message.event.type === "turn.error").length,
      1,
    );
    const retryResponse = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-retry-pending-terminal",
    ) as any;
    assert.equal(retryResponse?.status, 409);
  } finally {
    resetEngineModelCatalogRuntimeForTest();
    harness.cleanup();
  }
});

test("rollback reconciliation retries session cache disposal after local commit", async () => {
  const harness = setupRollbackHarness({ disposeFailures: 2 });
  try {
    seedFileChange(harness, { path: "reconcile-session-cache.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["reconcile-session-cache.txt"]);

    const response = await executeRollback(harness, "req-reconcile-session-cache-start");
    assert.equal(response.status, 500);
    assert.equal(response.body?.code, "rollback_session_cache_failed");
    assert.equal(readSingleAudit(harness).result, "partial");
    assert.equal(harness.disposeCalls, 1);

    const firstRetry = await executeRollbackReconciliation(harness, "req-reconcile-session-cache-first");
    assert.equal(firstRetry, null);
    assert.equal(parseAuditError(readSingleAudit(harness).error).phase, "session_cache");

    const reconciled = await executeRollbackReconciliation(harness, "req-reconcile-session-cache-second");

    assert.equal(reconciled?.kind, "success");
    assert.equal(readSingleAudit(harness).result, "success");
    assert.equal(harness.disposeCalls, 3);
  } finally {
    harness.cleanup();
  }
});

test("rollback reconciliation preserves a refreshed barrier when session disposal fails", async () => {
  let injected = false;
  let harness!: RollbackHarness;
  harness = setupRollbackHarness({
    disposeFailures: 1,
    providerRollback() {
      throw Object.assign(new Error("provider response lost after mutation"), {
        providerMutationMayHaveApplied: true,
      });
    },
    providerHistoryRead() {
      if (injected) return;
      injected = true;
      harness.db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: 24,
        ts: 4_200,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        engine: "codex",
        type: "system.notice",
        payload: { level: "info", text: "late canonical event during reconciliation" },
      });
    },
  });
  try {
    seedFileChange(harness, { path: "reconcile-late-barrier.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["reconcile-late-barrier.txt"]);
    const response = await executeRollback(harness, "req-reconcile-late-barrier-start");
    assert.equal(response.status, 502);
    harness.setProviderHistoryTurnIds([BASE_PROVIDER_TURN_ID]);

    const firstRetry = await executeRollbackReconciliation(harness, "req-reconcile-late-barrier-first");

    assert.equal(firstRetry, null);
    const pendingAudit = parseAuditError(readSingleAudit(harness).error);
    assert.equal(pendingAudit.phase, "session_cache");
    assert.equal(pendingAudit.recoveryPlan?.rollbackEventSeqBarrier, 24);
    assert.deepEqual(
      harness.db.conversationEvents.listByThread(THREAD_ID).map((event) => event.seq),
      [5],
    );

    const reconciled = await executeRollbackReconciliation(harness, "req-reconcile-late-barrier-second");

    assert.equal(reconciled?.kind, "success");
    assert.equal(reconciled?.recoveryPlan?.rollbackEventSeqBarrier, 24);
    assert.equal(readSingleAudit(harness).result, "success");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback accepts a legacy thread/start timeout as a local-only Codex turn", async () => {
  const harness = setupRollbackHarness({
    providerHistoryRead() {
      throw new Error("local-only rollback must not read provider history");
    },
  });
  try {
    harness.db.db.prepare("DELETE FROM thread_turns WHERE turn_id = ?").run(String(BASE_TURN_ID));
    harness.db.threads.clearSessionId(THREAD_ID);
    seedPreProviderFailedTurn(harness);

    const preview = await executeRollbackPreview(harness, "req-rollback-local-only-preview");
    const response = await executeRollback(harness, "req-rollback-local-only");

    assert.equal(preview.status, 200);
    assert.equal(response.status, 200);
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(harness.getOrCreateCalls, 0);
    assert.equal(harness.db.turns.get(DROPPED_TURN_ID), null);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, null);
    assert.equal(readSingleAudit(harness).result, "success");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback trims only provider-backed turns when local-only and provider turns are mixed", async () => {
  const harness = setupRollbackHarness();
  try {
    seedPreProviderFailedTurn(harness, { structuredMethod: true });
    seedLaterDroppedTurn(harness);

    const response = await executeRollback(harness, "req-rollback-mixed-local-provider");

    assert.equal(response.status, 200);
    assert.deepEqual(harness.rollbackCalls, [1]);
    assert.deepEqual(harness.rollbackExpectations, [{
      droppedTurnIds: [LATER_DROPPED_PROVIDER_TURN_ID],
      retainedTurnId: BASE_PROVIDER_TURN_ID,
    }]);
    assert.equal(harness.db.turns.get(DROPPED_TURN_ID), null);
    assert.equal(harness.db.turns.get(LATER_DROPPED_TURN_ID), null);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback cancels an invalid prepared provider plan before returning failure", async () => {
  let cancelCalls = 0;
  const harness = setupRollbackHarness({
    providerPreparedRollback() {
      return {
        sessionId: SESSION_ID,
        numTurns: 2,
        beforeTurnIds: [BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID],
        afterTurnIds: [],
        droppedTurnIds: [BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID],
        retainedTurnId: BASE_PROVIDER_TURN_ID,
      };
    },
    providerCancel() {
      cancelCalls += 1;
    },
  });
  try {
    const response = await executeRollback(harness, "req-rollback-invalid-prepared", { rollbackFiles: false });

    assert.equal(response.status, 502);
    assert.equal(response.body?.code, "rollback_provider_prepare_failed");
    assert.equal(cancelCalls, 1);
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback persists the reconciled provider count when local history contains a phantom mapping", async () => {
  const phantomProviderTurnId = "provider-turn-rollback-phantom";
  const harness = setupRollbackHarness({
    providerPreparedRollback(numTurnsToDrop, expectation) {
      assert.equal(numTurnsToDrop, 3);
      assert.deepEqual(expectation, {
        droppedTurnIds: [BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID, phantomProviderTurnId],
        retainedTurnId: null,
      });
      return {
        sessionId: SESSION_ID,
        numTurns: 2,
        beforeTurnIds: [BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID],
        afterTurnIds: [],
        droppedTurnIds: [BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID],
        retainedTurnId: null,
      };
    },
    providerRollback() {
      throw Object.assign(new Error("provider response lost after reconciled rollback"), {
        providerMutationMayHaveApplied: true,
      });
    },
  });
  try {
    seedLaterDroppedTurn(harness);
    harness.db.turns.setCodexProviderTurnId(LATER_DROPPED_TURN_ID, {
      engineTurnId: phantomProviderTurnId,
      engineSessionId: SESSION_ID,
      previousEngineTurnId: LATER_DROPPED_PROVIDER_TURN_ID,
      source: "turn.engineBound",
      eventSeq: 23,
      observedAt: 5_300,
    });

    const response = await executeRollback(harness, "req-rollback-provider-count-reconciled", {
      rollbackFiles: false,
      toTurnId: BASE_TURN_ID,
    });

    assert.equal(response.status, 502);
    assert.equal(response.body?.code, "rollback_provider_state_uncertain");
    assert.deepEqual(harness.rollbackCalls, [2]);
    assert.deepEqual(harness.rollbackExpectations, [{
      droppedTurnIds: [BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID],
      retainedTurnId: null,
    }]);
    const audit = readSingleAudit(harness);
    assert.equal(audit.droppedTurnCount, 3);
    const auditError = parseAuditError(audit.error);
    assert.equal(auditError.recoveryPlan?.droppedTurnIds?.length, 3);
    assert.equal(auditError.recoveryPlan?.codexProviderDroppedTurnCount, 2);
    assert.deepEqual(auditError.recoveryPlan?.codexHistory, {
      beforeTurnIds: [BASE_PROVIDER_TURN_ID, DROPPED_PROVIDER_TURN_ID],
      afterTurnIds: [],
    });

    harness.setProviderHistoryTurnIds([]);
    const reconciled = await executeRollbackReconciliation(harness, "req-rollback-provider-count-reconcile");

    assert.equal(reconciled?.kind, "success");
    assert.deepEqual(harness.db.turns.listByThread(THREAD_ID).map((turn) => turn.turnId), []);
    assert.equal(readSingleAudit(harness).result, "success");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback treats an all-phantom provider plan as a verified no-op", async () => {
  const phantomProviderTurnId = "provider-turn-rollback-all-phantom";
  let providerHistoryReadCount = 0;
  const harness = setupRollbackHarness({
    providerHistoryTurnIds: [BASE_PROVIDER_TURN_ID],
    providerPreparedRollback(numTurnsToDrop, expectation) {
      assert.equal(numTurnsToDrop, 1);
      assert.deepEqual(expectation, {
        droppedTurnIds: [phantomProviderTurnId],
        retainedTurnId: BASE_PROVIDER_TURN_ID,
      });
      return {
        sessionId: SESSION_ID,
        numTurns: 0,
        beforeTurnIds: [BASE_PROVIDER_TURN_ID],
        afterTurnIds: [BASE_PROVIDER_TURN_ID],
        droppedTurnIds: [],
        retainedTurnId: BASE_PROVIDER_TURN_ID,
      };
    },
    rollbackEvidenceFence(callCount) {
      if (callCount === 1) throw new Error("injected local commit fence failure");
      return 24;
    },
    providerHistoryRead() {
      providerHistoryReadCount += 1;
    },
  });
  try {
    harness.db.turns.setCodexProviderTurnId(DROPPED_TURN_ID, {
      engineTurnId: phantomProviderTurnId,
      engineSessionId: SESSION_ID,
      previousEngineTurnId: DROPPED_PROVIDER_TURN_ID,
      source: "turn.engineBound",
      eventSeq: 23,
      observedAt: 4_100,
    });

    const response = await executeRollback(harness, "req-rollback-provider-noop", { rollbackFiles: false });

    assert.equal(response.status, 500);
    assert.equal(response.body?.code, "rollback_local_history_failed");
    assert.deepEqual(harness.rollbackCalls, [0]);
    assert.deepEqual(harness.rollbackExpectations, [{ droppedTurnIds: [], retainedTurnId: BASE_PROVIDER_TURN_ID }]);
    const pendingAudit = parseAuditError(readSingleAudit(harness).error);
    assert.equal(pendingAudit.recoveryPlan?.codexProviderDroppedTurnCount, 0);
    assert.deepEqual(pendingAudit.recoveryPlan?.codexHistory, {
      beforeTurnIds: [BASE_PROVIDER_TURN_ID],
      afterTurnIds: [BASE_PROVIDER_TURN_ID],
    });

    const reconciled = await executeRollbackReconciliation(harness, "req-rollback-provider-noop-reconcile");

    assert.equal(reconciled?.kind, "success");
    assert.equal(providerHistoryReadCount, 1);
    assert.equal(harness.db.turns.get(DROPPED_TURN_ID), null);
    assert.ok(harness.db.turns.get(BASE_TURN_ID));
    assert.equal(readSingleAudit(harness).result, "success");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback refuses to commit an all-phantom local rollback after provider history drifts", async () => {
  const phantomProviderTurnId = "provider-turn-rollback-all-phantom-drift";
  const harness = setupRollbackHarness({
    providerHistoryTurnIds: [BASE_PROVIDER_TURN_ID],
    providerPreparedRollback() {
      return {
        sessionId: SESSION_ID,
        numTurns: 0,
        beforeTurnIds: [BASE_PROVIDER_TURN_ID],
        afterTurnIds: [BASE_PROVIDER_TURN_ID],
        droppedTurnIds: [],
        retainedTurnId: BASE_PROVIDER_TURN_ID,
      };
    },
    rollbackEvidenceFence(callCount) {
      if (callCount === 1) throw new Error("injected local commit fence failure");
      return 24;
    },
  });
  try {
    harness.db.turns.setCodexProviderTurnId(DROPPED_TURN_ID, {
      engineTurnId: phantomProviderTurnId,
      engineSessionId: SESSION_ID,
      previousEngineTurnId: DROPPED_PROVIDER_TURN_ID,
      source: "turn.engineBound",
      eventSeq: 23,
      observedAt: 4_100,
    });

    const response = await executeRollback(harness, "req-rollback-provider-noop-drift", { rollbackFiles: false });
    assert.equal(response.status, 500);
    assert.equal(response.body?.code, "rollback_local_history_failed");
    assert.ok(harness.db.turns.get(DROPPED_TURN_ID));

    harness.setProviderHistoryTurnIds([BASE_PROVIDER_TURN_ID, "provider-turn-added-after-crash"]);
    const reconciled = await executeRollbackReconciliation(harness, "req-rollback-provider-noop-drift-reconcile");

    assert.equal(reconciled, null);
    assert.ok(harness.db.turns.get(DROPPED_TURN_ID));
    assert.equal(readSingleAudit(harness).result, "partial");
    const failure = parseAuditError(readSingleAudit(harness).error);
    assert.equal(failure.phase, "reconciliation_zero_provider_after");
    assert.match(String(failure.message ?? ""), /既不等于 before 也不等于 after/);

    harness.setProviderHistoryTurnIds([BASE_PROVIDER_TURN_ID]);
    const retried = await executeRollbackReconciliation(harness, "req-rollback-provider-noop-drift-retry");

    assert.equal(retried?.kind, "success");
    assert.equal(harness.db.turns.get(DROPPED_TURN_ID), null);
    assert.equal(readSingleAudit(harness).result, "success");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback searches past a retained local-only turn for the provider boundary", async () => {
  const harness = setupRollbackHarness();
  try {
    seedPreProviderFailedTurn(harness, { structuredMethod: true });
    seedLaterDroppedTurn(harness);

    const response = await executeRollback(harness, "req-rollback-local-only-boundary", {
      toTurnId: LATER_DROPPED_TURN_ID,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(harness.rollbackCalls, [1]);
    assert.deepEqual(harness.rollbackExpectations, [{
      droppedTurnIds: [LATER_DROPPED_PROVIDER_TURN_ID],
      retainedTurnId: BASE_PROVIDER_TURN_ID,
    }]);
    assert.ok(harness.db.turns.get(DROPPED_TURN_ID));
    assert.equal(harness.db.turns.get(LATER_DROPPED_TURN_ID), null);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback reconciles a local-only Codex rollback without provider reads", async () => {
  const harness = setupRollbackHarness({
    rollbackEvidenceFence(callCount) {
      if (callCount === 1) throw new Error("injected first fence failure");
      return 24;
    },
    providerHistoryRead() {
      throw new Error("local-only reconciliation must not read provider history");
    },
  });
  try {
    seedPreProviderFailedTurn(harness, { structuredMethod: true });

    const response = await executeRollback(harness, "req-rollback-local-only-reconcile-start");
    const reconciled = await executeRollbackReconciliation(harness, "req-rollback-local-only-reconcile-finish");

    assert.equal(response.status, 500);
    assert.equal(response.body?.code, "rollback_local_history_failed");
    assert.equal(reconciled?.kind, "success");
    assert.equal(harness.getOrCreateCalls, 0);
    assert.equal(harness.db.turns.get(DROPPED_TURN_ID), null);
    assert.equal(readSingleAudit(harness).result, "success");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback retries a local-only reconciliation without losing its commit boundary", async () => {
  const harness = setupRollbackHarness({
    rollbackEvidenceFence(callCount) {
      if (callCount <= 2) throw new Error(`injected fence failure ${callCount}`);
      return 24;
    },
    providerHistoryRead() {
      throw new Error("local-only reconciliation must not read provider history");
    },
  });
  try {
    seedPreProviderFailedTurn(harness, { structuredMethod: true });

    const response = await executeRollback(harness, "req-rollback-local-only-retry-start");
    const firstReconcile = await executeRollbackReconciliation(harness, "req-rollback-local-only-retry-first");

    assert.equal(response.status, 500);
    assert.equal(firstReconcile, null);
    assert.equal(parseAuditError(readSingleAudit(harness).error).phase, "reconciliation_zero_provider_after");
    assert.ok(harness.db.turns.get(DROPPED_TURN_ID));

    const retried = await executeRollbackReconciliation(harness, "req-rollback-local-only-retry-second");

    assert.equal(retried?.kind, "success");
    assert.equal(harness.getOrCreateCalls, 0);
    assert.equal(harness.db.turns.get(DROPPED_TURN_ID), null);
    assert.equal(readSingleAudit(harness).result, "success");
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback rejects missing provider turn mapping before file or provider mutation", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "missing-provider-map.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["missing-provider-map.txt"]);
    harness.db.db.prepare("DELETE FROM raw_engine_events WHERE seq = ?").run(12);
    harness.db.turns.setEngineCheckpoint(DROPPED_TURN_ID, "{}");

    const before = snapshotProtectedHistory(harness.db);
    const response = await executeRollback(harness, "req-rollback-provider-map-missing");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_provider_history_evidence_incomplete");
    assert.equal(readDiskFile(harness, "missing-provider-map.txt"), "after\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.equal(harness.rollbackCalls.length, 0);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preview ignores raw thread.started when current Codex binding is detached", async () => {
  const harness = setupRollbackHarness();
  try {
    const rawSessionId = "codex-thread-rollback-raw-fallback" as SessionId;
    harness.db.threads.clearSessionId(THREAD_ID);
    harness.db.rawEvents.deleteByThread(THREAD_ID);
    harness.db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 21,
      ts: 4_100,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      source: "codex.app-server.msg",
      data: { method: "thread/started", params: { thread: { id: rawSessionId } } },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    });

    const response = await executeRollbackPreview(harness, "req-rollback-thread-session-raw-fallback");

    assert.equal(response.status, 200);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, null);
    for (const [turnId, providerTurnId] of [
      [BASE_TURN_ID, BASE_PROVIDER_TURN_ID],
      [DROPPED_TURN_ID, DROPPED_PROVIDER_TURN_ID],
    ] as const) {
      const turn = harness.db.turns.get(turnId);
      const checkpoint = JSON.parse(String(turn?.engineCheckpointJson));
      assert.equal(turn?.engineSessionId, SESSION_ID);
      assert.equal(checkpoint.codexProviderTurn?.engineSessionId, SESSION_ID);
      assert.equal(checkpoint.codexProviderTurn?.engineTurnId, providerTurnId);
      assert.equal(checkpoint.codexProviderTurn?.source, "turn.engineBound");
    }
    assert.deepEqual(harness.rollbackCalls, []);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preview ignores multiple historical raw Codex generations", async () => {
  const harness = setupRollbackHarness();
  try {
    harness.db.threads.clearSessionId(THREAD_ID);
    harness.db.rawEvents.deleteByThread(THREAD_ID);
    for (const [seq, sessionId] of [
      [21, "codex-thread-rollback-raw-a"],
      [22, "codex-thread-rollback-raw-b"],
    ] as const) {
      harness.db.rawEvents.appendEnvelope({
        schema: 1,
        seq,
        ts: seq * 200,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        engine: "codex",
        source: "codex.app-server.msg",
        data: { method: "thread/started", params: { thread: { id: sessionId } } },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      });
    }
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollbackPreview(harness, "req-rollback-thread-session-raw-ambiguous");

    assert.equal(response.status, 200);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, null);
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    assert.deepEqual(harness.rollbackCalls, []);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback preview does not revive a detached Codex binding from canonical thread.started", async () => {
  const harness = setupRollbackHarness();
  try {
    harness.db.threads.clearSessionId(THREAD_ID);
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 21,
      ts: 4_100,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "thread.started",
      payload: { sessionId: "codex-thread-stale-generation" },
    } as any);

    const response = await executeRollbackPreview(harness, "req-rollback-stale-canonical-generation");

    assert.equal(response.status, 200);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, null);
    assert.deepEqual(harness.rollbackCalls, []);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback rejects a missing durable Codex binding before provider or file mutation", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "missing-current-binding.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["missing-current-binding.txt"]);
    harness.db.threads.clearSessionId(THREAD_ID);

    const response = await executeRollback(harness, "req-rollback-missing-current-binding");

    assert.equal(response.status, 502);
    assert.equal(response.body?.code, "rollback_provider_prepare_failed");
    assert.match(String(response.body?.message ?? ""), /provider session binding 缺失/);
    assert.equal(readDiskFile(harness, "missing-current-binding.txt"), "after\n");
    assert.deepEqual(harness.rollbackCalls, []);
    assert.equal(harness.db.rollbacks.listByThread(THREAD_ID).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback backfills provider mappings and survives raw event cleanup", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "provider-map-retained.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["provider-map-retained.txt"]);
    harness.db.turns.setEngineCheckpoint(BASE_TURN_ID, "{}");
    harness.db.turns.setEngineCheckpoint(DROPPED_TURN_ID, "{}");

    const preview = await executeRollbackPreview(harness, "req-rollback-provider-map-preview");
    assert.equal(preview.status, 200);
    for (const turnId of [BASE_TURN_ID, DROPPED_TURN_ID]) {
      const checkpoint = JSON.parse(String(harness.db.turns.get(turnId)?.engineCheckpointJson));
      assert.equal(checkpoint.codexProviderTurn?.source, "turn/started");
      assert.ok(checkpoint.codexProviderTurn?.engineTurnId);
    }

    harness.db.rawEvents.deleteByThread(THREAD_ID);
    const response = await executeRollback(harness, "req-rollback-provider-map-after-retention");

    assert.equal(response.status, 200);
    assert.deepEqual(harness.rollbackExpectations, [{
      droppedTurnIds: [DROPPED_PROVIDER_TURN_ID],
      retainedTurnId: BASE_PROVIDER_TURN_ID,
    }]);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback accepts a delayed raw ancestor from checkpoint lineage", async () => {
  const harness = setupRollbackHarness();
  const replacementB = "provider-turn-checkpoint-lineage-b";
  const replacementC = "provider-turn-checkpoint-lineage-c";
  try {
    seedFileChange(harness, { path: "provider-checkpoint-lineage.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["provider-checkpoint-lineage.txt"]);
    harness.db.turns.setCodexProviderTurnId(DROPPED_TURN_ID, {
      engineTurnId: replacementB,
      engineSessionId: SESSION_ID,
      previousEngineTurnId: DROPPED_PROVIDER_TURN_ID,
      source: "turn.engineBound",
      eventSeq: 13,
      observedAt: 3_300,
    });
    harness.db.turns.setCodexProviderTurnId(DROPPED_TURN_ID, {
      engineTurnId: replacementC,
      engineSessionId: SESSION_ID,
      previousEngineTurnId: replacementB,
      source: "turn.engineBound",
      eventSeq: 14,
      observedAt: 3_400,
    });

    const response = await executeRollbackPreview(harness, "req-rollback-checkpoint-lineage");

    assert.equal(response.status, 200);
    const checkpoint = JSON.parse(String(harness.db.turns.get(DROPPED_TURN_ID)?.engineCheckpointJson));
    assert.deepEqual(checkpoint.codexProviderTurn.supersededEngineTurnIds, [
      DROPPED_PROVIDER_TURN_ID,
      replacementB,
    ]);
    assert.equal(readDiskFile(harness, "provider-checkpoint-lineage.txt"), "after\n");
    assert.deepEqual(harness.rollbackCalls, []);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback replays a multi-hop canonical provider replacement chain", async () => {
  const harness = setupRollbackHarness();
  const replacementB = "provider-turn-rollback-replacement-b";
  const replacementC = "provider-turn-rollback-replacement-c";
  try {
    seedFileChange(harness, { path: "provider-map-multi-hop.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["provider-map-multi-hop.txt"]);
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 13,
      ts: 3_300,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: DROPPED_TURN_ID,
        engineTurnId: replacementB,
        previousEngineTurnId: DROPPED_PROVIDER_TURN_ID,
        engineSessionId: SESSION_ID,
      },
    });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 14,
      ts: 3_400,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: DROPPED_TURN_ID,
        engineTurnId: replacementC,
        previousEngineTurnId: replacementB,
        engineSessionId: SESSION_ID,
      },
    });

    const preview = await executeRollbackPreview(harness, "req-rollback-provider-map-multi-hop-preview");

    assert.equal(preview.status, 200);
    const checkpoint = JSON.parse(String(harness.db.turns.get(DROPPED_TURN_ID)?.engineCheckpointJson));
    assert.equal(checkpoint.codexProviderTurn?.engineTurnId, replacementC);
    assert.equal(checkpoint.codexProviderTurn?.previousEngineTurnId, replacementB);

    const response = await executeRollback(harness, "req-rollback-provider-map-multi-hop");

    assert.equal(response.status, 200);
    assert.deepEqual(harness.rollbackExpectations, [{
      droppedTurnIds: [replacementC],
      retainedTurnId: BASE_PROVIDER_TURN_ID,
    }]);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback rejects a canonical provider replacement cycle", async () => {
  const harness = setupRollbackHarness();
  const replacementB = "provider-turn-rollback-cycle-b";
  try {
    seedFileChange(harness, { path: "provider-map-cycle.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["provider-map-cycle.txt"]);
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 13,
      ts: 3_300,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: DROPPED_TURN_ID,
        engineTurnId: replacementB,
        previousEngineTurnId: DROPPED_PROVIDER_TURN_ID,
        engineSessionId: SESSION_ID,
      },
    });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 14,
      ts: 3_400,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: DROPPED_TURN_ID,
        engineTurnId: DROPPED_PROVIDER_TURN_ID,
        previousEngineTurnId: replacementB,
        engineSessionId: SESSION_ID,
      },
    });

    const response = await executeRollbackPreview(harness, "req-rollback-provider-map-cycle");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_provider_history_evidence_incomplete");
    assert.match(String(response.body?.message ?? ""), /(?:replacement 链|替换链)冲突/);
    assert.equal(readDiskFile(harness, "provider-map-cycle.txt"), "after\n");
    assert.deepEqual(harness.rollbackCalls, []);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback reindex rolls back earlier provider repairs when a later canonical session conflicts", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "provider-session-conflict.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["provider-session-conflict.txt"]);
    harness.db.db.prepare(
      "UPDATE thread_turns SET engine_session_id = NULL, engine_checkpoint_json = NULL WHERE thread_id = ?",
    ).run(String(THREAD_ID));
    for (const event of [
      {
        seq: 21,
        turnId: BASE_TURN_ID,
        engineTurnId: BASE_PROVIDER_TURN_ID,
        previousEngineTurnId: null,
        engineSessionId: "session-reindex-a",
      },
      {
        seq: 22,
        turnId: DROPPED_TURN_ID,
        engineTurnId: DROPPED_PROVIDER_TURN_ID,
        previousEngineTurnId: null,
        engineSessionId: "session-reindex-a",
      },
      {
        seq: 23,
        turnId: DROPPED_TURN_ID,
        engineTurnId: "provider-session-conflict-c",
        previousEngineTurnId: DROPPED_PROVIDER_TURN_ID,
        engineSessionId: "session-reindex-b",
      },
    ] as const) {
      harness.db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: event.seq,
        ts: event.seq * 100,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId: event.turnId,
          engineTurnId: event.engineTurnId,
          previousEngineTurnId: event.previousEngineTurnId,
          engineSessionId: event.engineSessionId,
        },
      } as any);
    }

    const response = await executeRollbackPreview(harness, "req-rollback-provider-session-conflict");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_provider_history_evidence_incomplete");
    assert.match(String(response.body?.message ?? ""), /provider session 证据冲突/);
    for (const turnId of [BASE_TURN_ID, DROPPED_TURN_ID]) {
      assert.equal(harness.db.turns.get(turnId)?.engineSessionId, null);
      assert.equal(harness.db.turns.get(turnId)?.engineCheckpointJson, null);
    }
    assert.equal(readDiskFile(harness, "provider-session-conflict.txt"), "after\n");
    assert.deepEqual(harness.rollbackCalls, []);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback reindex rejects another thread's turnId without modifying that turn", async () => {
  const harness = setupRollbackHarness();
  const foreignThreadId = "thread-rollback-foreign" as ThreadId;
  const foreignTurnId = "turn-rollback-foreign" as TurnId;
  try {
    // 工作区库隔离外部工作区；同库另一会话验证 turn 归属检查且原记录不变。
    harness.db.threads.create({
      id: foreignThreadId,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "foreign",
    });
    harness.db.turns.insertStarted({
      workspaceId: WORKSPACE_ID,
      threadId: foreignThreadId,
      engine: "codex",
      turnId: foreignTurnId,
      startedAt: 5_000,
      startEventSeq: 30,
    });
    const before = harness.db.turns.get(foreignTurnId);
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 21,
      ts: 4_100,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.started",
      payload: { turnId: foreignTurnId },
    } as any);

    const response = await executeRollbackPreview(harness, "req-rollback-foreign-turn");

    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "rollback_provider_history_evidence_incomplete");
    assert.match(String(response.body?.message ?? ""), /turn scope 不匹配/);
    assert.deepEqual(harness.db.turns.get(foreignTurnId), before);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback restores both sides of a rename from captured snapshots", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "old name.txt", before: "before rename\n", after: null });
    seedFileChange(harness, { path: "new name.txt", before: null, after: "before rename\n" });
    seedCodexDiffText(harness, [
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 100%",
      "rename from old name.txt",
      "rename to new name.txt",
      "",
    ].join("\n"));

    const response = await executeRollback(harness, "req-rollback-rename");

    assert.equal(response.status, 200);
    assert.equal(readDiskFile(harness, "old name.txt"), "before rename\n");
    assert.equal(fs.existsSync(path.join(harness.workspacePath, "new name.txt")), false);
    assert.deepEqual(harness.rollbackCalls, [1]);
  } finally {
    harness.cleanup();
  }
});

test("threads.rollback rolls back every local trim when SQLite fails at turn deletion", async () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "local-history-failure.txt", before: "before\n", after: "after\n" });
    seedCodexDiff(harness, ["local-history-failure.txt"]);
    harness.db.db.exec([
      "CREATE TRIGGER fail_rollback_turn_delete",
      "BEFORE DELETE ON thread_turns",
      `WHEN OLD.thread_id = '${THREAD_ID}'`,
      "BEGIN",
      "  SELECT RAISE(ABORT, 'injected local trim failure');",
      "END;",
    ].join("\n"));
    const before = snapshotProtectedHistory(harness.db);

    const response = await executeRollback(harness, "req-rollback-local-history-failed");

    assert.equal(response.status, 500);
    assert.equal(response.body?.code, "rollback_local_history_failed");
    assert.match(String(response.body?.message ?? ""), /本地历史裁剪失败/);
    assert.equal(readDiskFile(harness, "local-history-failure.txt"), "before\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    for (const blobId of harness.blobIds) assert.ok(harness.db.blobs.get(blobId));
    assert.deepEqual(harness.rollbackCalls, [1]);
    assert.equal(harness.getOrCreateCalls, 1);
    assert.equal(harness.disposeCalls, 0);
    const audit = readSingleAudit(harness);
    assert.equal(audit.result, "partial");
    const auditError = parseAuditError(audit.error);
    assert.equal(auditError.requestId, "req-rollback-local-history-failed");
    assert.equal(auditError.phase, "local_history");
    assert.match(String(auditError.message ?? ""), /injected local trim failure/);
  } finally {
    harness.cleanup();
  }
});

test("threads.fileChanges.undo restores all selected files in one operation", () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "undo-a.txt", before: "a-before\n", after: "a-after\n" });
    seedFileChange(harness, { path: "undo-b.txt", before: "b-before\n", after: "b-after\n" });

    const response = executeFileUndo(harness, "req-file-undo-success", ["undo-a.txt", "undo-b.txt"]);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body?.undonePaths, ["undo-a.txt", "undo-b.txt"]);
    assert.deepEqual(response.body?.skippedPaths, []);
    assert.equal(readDiskFile(harness, "undo-a.txt"), "a-before\n");
    assert.equal(readDiskFile(harness, "undo-b.txt"), "b-before\n");
    assert.deepEqual(harness.db.fileChanges.listByThread(THREAD_ID), []);
  } finally {
    harness.cleanup();
  }
});

test("threads.fileChanges.undo compensates every file when DB deletion fails", () => {
  const harness = setupRollbackHarness();
  try {
    seedFileChange(harness, { path: "undo-db-a.txt", before: "a-before\n", after: "a-after\n" });
    seedFileChange(harness, { path: "undo-db-b.txt", before: "b-before\n", after: "b-after\n" });
    const before = snapshotProtectedHistory(harness.db);
    harness.db.db.exec([
      "CREATE TRIGGER fail_file_undo_delete",
      "BEFORE DELETE ON turn_file_changes",
      "WHEN OLD.path = 'undo-db-b.txt'",
      "BEGIN",
      "  SELECT RAISE(ABORT, 'injected file undo delete failure');",
      "END;",
    ].join("\n"));

    const response = executeFileUndo(harness, "req-file-undo-db-failed", ["undo-db-a.txt", "undo-db-b.txt"]);

    assert.equal(response.status, 500);
    assert.match(String(response.body?.message ?? ""), /injected file undo delete failure/);
    assert.equal(readDiskFile(harness, "undo-db-a.txt"), "a-after\n");
    assert.equal(readDiskFile(harness, "undo-db-b.txt"), "b-after\n");
    assert.deepEqual(snapshotProtectedHistory(harness.db), before);
    for (const blobId of harness.blobIds) assert.ok(harness.db.blobs.get(blobId));
  } finally {
    harness.cleanup();
  }
});
