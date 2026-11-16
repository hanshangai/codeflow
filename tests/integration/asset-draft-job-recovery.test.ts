import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AssetGenerationJob,
  AssetGenerationJobStatus,
  ThreadId,
  TurnId,
  WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { openClientDb, type ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { reconcileAssetDraftJobsOnStartup } from "../../apps/desktop/client/src/startup/assetDraftJobReconciler.ts";
import { handleOrchAssetDraftJobsDelete } from "../../apps/desktop/client/src/app/handlers/orchestrationHandlers.ts";
import { AssetDraftService, AssetDraftServiceError, hasInFlightAssetDraftWork, stopAssetDraftJobsForUpdate } from "../../apps/desktop/client/src/orchestration/assetDraftService.ts";
import { ENGINE_MODEL_CATALOG_SCHEMA_VERSION } from "../../packages/shared/src/index.ts";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "../../packages/shared/src/engineModelCatalogSeed.ts";
import { WorkspaceOperationGate } from "../../apps/desktop/client/src/workspace-migration/workspaceOperationGate.ts";

type RecoveryHarness = {
  db: ClientDb;
  workspaceId: WorkspaceId;
  cleanup: () => void;
};

/** 创建隔离的 Client DB，避免恢复测试污染真实用户数据。 */
function createRecoveryHarness(options?: { gate?: WorkspaceOperationGate; expectCloseFailure?: () => boolean }): RecoveryHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-asset-recovery-"));
  const workspaceId = "ws-asset-recovery" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(root, "client.db"), workspaceOperationGate: options?.gate });
  db.workspaces.upsert({ id: workspaceId, title: "recovery", path: root });
  // 资产任务仓储位于工作区库，夹具与启动恢复必须共享同一视图。
  const workspaceDb = db.forWorkspace(workspaceId);
  return {
    db: workspaceDb,
    workspaceId,
    cleanup: () => {
      if (options?.expectCloseFailure?.()) assert.throws(() => db.close(), { message: "CLIENT_DB_CLOSE_FAILED" });
      else db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 创建最小草案任务记录，覆盖启动恢复所需字段。 */
function createJob(
  harness: RecoveryHarness,
  status: AssetGenerationJobStatus,
  threadId: ThreadId | null = null,
): AssetGenerationJob {
  return harness.db.orchAssetGenerationJobs.create({
    workspaceId: harness.workspaceId,
    assetKind: "role",
    mode: "create",
    status,
    targetAssetId: null,
    clientRequestId: null,
    baseVersionId: null,
    draftId: null,
    threadId,
    prompt: "创建恢复测试 Agent",
    requestJson: JSON.stringify({ assetKind: "role", mode: "create" }),
    interactionRequest: null,
    progress: { stage: status, headline: status, detail: null, percent: 50 },
    failure: null,
  });
}

/** 创建 asset-draft thread 及其 turn 索引。 */
function createTurn(
  harness: RecoveryHarness,
  threadId: ThreadId,
  turnId: TurnId,
  status: "started" | "error" | "completed",
): void {
  harness.db.threads.create({
    id: threadId,
    workspaceId: harness.workspaceId,
    engine: "codex",
    title: "恢复测试会话",
    threadType: "orchestration",
    threadSubtype: "asset-draft",
  });
  harness.db.turns.insertStarted({
    workspaceId: harness.workspaceId,
    threadId,
    engine: "codex",
    turnId,
    startedAt: Date.now(),
    startEventSeq: 1,
  });
  if (status !== "started") {
    harness.db.turns.setEnded(turnId, { status, endedAt: Date.now(), endEventSeq: 2 });
  }
}

test("草案任务启动恢复会收口无 turn 和已终止 turn，并保持真实 running turn", () => {
  const harness = createRecoveryHarness();
  try {
    const noTurnJob = createJob(harness, "queued");
    const endedThreadId = "asset-draft-ended" as ThreadId;
    const endedJob = createJob(harness, "generating", endedThreadId);
    createTurn(harness, endedThreadId, "turn-ended" as TurnId, "error");
    const runningThreadId = "asset-draft-running" as ThreadId;
    const runningJob = createJob(harness, "generating", runningThreadId);
    createTurn(harness, runningThreadId, "turn-running" as TurnId, "started");

    const result = reconcileAssetDraftJobsOnStartup(harness.db);

    assert.deepEqual(result, { scanned: 3, restoredFromDraft: 0, failed: 2, pending: 1 });
    assert.equal(harness.db.orchAssetGenerationJobs.get(noTurnJob.id)?.status, "failed");
    assert.equal(harness.db.orchAssetGenerationJobs.get(noTurnJob.id)?.failure?.code, "client_restarted");
    assert.equal(harness.db.orchAssetGenerationJobs.get(endedJob.id)?.failure?.retryable, true);
    assert.equal(harness.db.orchAssetGenerationJobs.get(runningJob.id)?.status, "generating");
  } finally {
    harness.cleanup();
  }
});

test("草案任务启动恢复优先使用已落库草案并保持幂等", () => {
  const harness = createRecoveryHarness();
  try {
    const job = createJob(harness, "validating");
    const draft = harness.db.orchAssetDrafts.create({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      status: "awaiting_review",
      targetAssetId: null,
      baseVersionId: null,
      sourceJobId: job.id,
      prompt: job.prompt,
      payloadJson: "{}",
      validationIssues: [],
      rationale: null,
      engineInfo: { engine: "codex", model: null, effort: null },
    });
    harness.db.orchAssetGenerationJobs.attachDraft(job.id, draft.id);

    const first = reconcileAssetDraftJobsOnStartup(harness.db);
    const second = reconcileAssetDraftJobsOnStartup(harness.db);

    assert.deepEqual(first, { scanned: 1, restoredFromDraft: 1, failed: 0, pending: 0 });
    assert.deepEqual(second, { scanned: 0, restoredFromDraft: 0, failed: 0, pending: 0 });
    assert.equal(harness.db.orchAssetGenerationJobs.get(job.id)?.status, "awaiting_review");
    assert.equal(harness.db.orchAssetGenerationJobs.get(job.id)?.draftId, draft.id);
  } finally {
    harness.cleanup();
  }
});

test("任务 CAS 会拒绝取消后的迟到生成写回", () => {
  const harness = createRecoveryHarness();
  try {
    const job = createJob(harness, "generating");
    const cancelled = harness.db.orchAssetGenerationJobs.patchIfStatus(job.id, ["generating"], {
      status: "cancelled",
      progress: { stage: "cancelled", headline: "已取消", detail: null, percent: 100 },
    });
    const stale = harness.db.orchAssetGenerationJobs.patchIfStatus(job.id, ["generating"], {
      status: "failed",
      progress: { stage: "failed", headline: "迟到失败", detail: null, percent: 100 },
    });

    assert.equal(cancelled?.current.status, "cancelled");
    assert.equal(stale, null);
    assert.equal(harness.db.orchAssetGenerationJobs.get(job.id)?.status, "cancelled");
  } finally {
    harness.cleanup();
  }
});

test("删除运行中但尚未创建 turn 的草案任务会先取消再清理", async () => {
  const harness = createRecoveryHarness();
  try {
    const job = createJob(harness, "planning");
    const responses: any[] = [];
    await handleOrchAssetDraftJobsDelete({
      db: harness.db,
      workspaces: new Map([[harness.workspaceId, "unused"]]),
      getActiveThreadTurn: () => null,
      sessions: {},
      threads: {},
      orchEngine: {},
      send: (message: unknown) => { responses.push(message); },
    } as any, {
      t: "api.req",
      id: "delete-no-turn",
      method: "orch.assetDraftJobs.delete",
      path: "/orch/asset-drafts/jobs/delete",
      body: { workspaceId: harness.workspaceId, jobId: job.id },
    } as any);

    assert.equal(harness.db.orchAssetGenerationJobs.get(job.id), null);
    assert.equal(responses.at(-1)?.status, 200);
    assert.equal(responses.at(-1)?.body?.ok, true);
  } finally {
    harness.cleanup();
  }
});

test("删除运行中草案时 provider 中断失败会保留任务并显式返回失败", async () => {
  const harness = createRecoveryHarness();
  try {
    const threadId = "asset-draft-delete-failed" as ThreadId;
    const turnId = "turn-delete-failed" as TurnId;
    const job = createJob(harness, "generating", threadId);
    createTurn(harness, threadId, turnId, "started");
    const responses: any[] = [];
    await handleOrchAssetDraftJobsDelete({
      db: harness.db,
      workspaces: new Map([[harness.workspaceId, "unused"]]),
      getActiveThreadTurn: () => ({ turnId, source: "runtime" }),
      sessions: {
        interrupt: async () => { throw new Error("provider interrupt unavailable"); },
      },
      threads: {},
      orchEngine: {},
      send: (message: unknown) => { responses.push(message); },
    } as any, {
      t: "api.req",
      id: "delete-interrupt-failed",
      method: "orch.assetDraftJobs.delete",
      path: "/orch/asset-drafts/jobs/delete",
      body: { workspaceId: harness.workspaceId, jobId: job.id },
    } as any);

    assert.equal(harness.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
    assert.equal(responses.at(-1)?.status, 409);
    assert.equal(responses.at(-1)?.body?.code, "ASSET_DRAFT_DELETE_FAILED");
    assert.match(responses.at(-1)?.body?.message ?? "", /requestId delete-interrupt-failed/);
  } finally {
    harness.cleanup();
  }
});

test("删除跨工作区关联的草案任务不会中断 turn", async () => {
  const harness = createRecoveryHarness();
  try {
    const foreignWorkspaceId = "ws-asset-recovery-foreign" as WorkspaceId;
    harness.db.workspaces.upsert({ id: foreignWorkspaceId, title: "foreign", path: path.join(os.tmpdir(), "foreign") });
    const threadId = "asset-draft-foreign-thread" as ThreadId;
    const turnId = "turn-foreign-thread" as TurnId;
    const job = createJob(harness, "generating", threadId);
    let interruptCalls = 0;
    const responses: any[] = [];

    await handleOrchAssetDraftJobsDelete({
      db: harness.db,
      workspaces: new Map([[harness.workspaceId, "unused"]]),
      getActiveThreadTurn: () => ({ turnId, source: "runtime" }),
      sessions: {
        interrupt: async () => { interruptCalls += 1; },
      },
      threads: {},
      orchEngine: {},
      send: (message: unknown) => { responses.push(message); },
    } as any, {
      t: "api.req",
      id: "delete-foreign-thread",
      method: "orch.assetDraftJobs.delete",
      path: "/orch/asset-drafts/jobs/delete",
      body: { workspaceId: harness.workspaceId, jobId: job.id },
    } as any);

    assert.equal(interruptCalls, 0);
    assert.equal(harness.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
    assert.equal(responses.at(-1)?.status, 409);
    assert.equal(responses.at(-1)?.body?.code, "CONFLICT");
  } finally {
    harness.cleanup();
  }
});

/** 固定更新用任务输入，关闭不相关资料扫描以只核对后台 owner 生命周期。 */
function updateDraftRequest(workspaceId: WorkspaceId) {
  return { workspaceId, assetKind: "role" as const, mode: "create" as const, prompt: "生成更新测试角色", roleSnapshot: null,
    contextOptions: { includeExistingAssets: false, includeNotes: false, includeWorkbenchDocs: false, includeWorkspaceFiles: false, maxContextChars: 8000, selectedPaths: [] } };
}

test("热更新冻结拒绝资产新建及续跑，不能先写任务", async () => {
  const h = createRecoveryHarness();
  try {
    const service = new AssetDraftService({ db: h.db, isTaskAdmissionPaused: () => true } as any);
    await assert.rejects(service.generateRoleDraft(updateDraftRequest(h.workspaceId)), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
    await assert.rejects(service.generateSkillDraft({ ...updateDraftRequest(h.workspaceId), assetKind: "skill", skillSnapshot: null }), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
    assert.equal(h.db.orchAssetGenerationJobs.listByWorkspace(h.workspaceId).length, 0);
    const job = createJob(h, "awaiting_input");
    await assert.rejects(service.resumeRoleDraftJob({ workspaceId: h.workspaceId, jobId: job.id, prompt: "继续" }), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
    await assert.rejects(service.resumeSkillDraftJob({ workspaceId: h.workspaceId, jobId: job.id, prompt: "继续" }), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "awaiting_input");
  } finally { h.cleanup(); }
});

/** 等待真实服务副作用，超时必须失败而不是把未发生当成功。 */
async function waitForAssetUpdateCondition(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), "等待资产更新测试条件超时");
}

for (const assetKind of ["role", "skill"] as const) test(`已受理${assetKind}首轮准备和重试暂停可稍后恢复，不应写失败`, async () => {
  const h = createRecoveryHarness(), threads = new ThreadStore();
  applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 1, rows: structuredClone(INITIAL_ENGINE_MODEL_CATALOG_V1) });
  let paused = false, ready!: () => void, release!: () => void, blockedReads = 0, sends = 0;
  const contextReady = new Promise<void>(resolve => { ready = resolve; }), contextGate = new Promise<void>(resolve => { release = resolve; });
  const service = new AssetDraftService({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), threads, isTaskAdmissionPaused: () => { if (paused) blockedReads++; return paused; }, sessions: {
    getOrCreate: () => ({ resolvePlatformToolTransport: () => "native-dynamic", prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
      sendMessage: async () => { sends++; if (sends === 1) paused = true; return { responseText: "未提交草案" }; } }),
  }, timeoutPolicy: {}, emitConversation: () => {}, emitRaw: () => {} } as any);
  const collectMethod = assetKind === "role" ? "collectRoleDraftContext" : "collectSkillDraftContext";
  const collect = (service as any)[collectMethod].bind(service);
  (service as any)[collectMethod] = async (...args: unknown[]) => { ready(); await contextGate; return collect(...args); };
  try {
    const request = { ...updateDraftRequest(h.workspaceId), assetKind };
    const { job } = await service.generateAssetDraft(request); await contextReady; paused = true; release();
    await waitForAssetUpdateCondition(() => blockedReads > 0);
    assert.equal(sends, 0); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.failure, null); assert.equal(hasInFlightAssetDraftWork(h.db), true);
    paused = false; const priorReads = blockedReads;
    await waitForAssetUpdateCondition(() => sends === 1 && blockedReads > priorReads);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.failure, null); assert.equal(hasInFlightAssetDraftWork(h.db), true);
    paused = false; await waitForAssetUpdateCondition(() => !hasInFlightAssetDraftWork(h.db));
    assert.equal(sends, 3); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.failure?.code, "TOOL_RESULT_REQUIRED");
  } finally { paused = false; release(); await waitForAssetUpdateCondition(() => !hasInFlightAssetDraftWork(h.db)); resetEngineModelCatalogRuntimeForTest(); h.cleanup(); }
});

for (const assetKind of ["role", "skill"] as const) for (const phase of ["首轮", "重试"] as const) test(`${assetKind}${phase}等待更新选择时确认停止，不应继续派发`, async () => {
  const h = createRecoveryHarness(), threads = new ThreadStore();
  applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 1, rows: structuredClone(INITIAL_ENGINE_MODEL_CATALOG_V1) });
  let paused = false, ready!: () => void, release!: () => void, blockedReads = 0, sends = 0, disposals = 0;
  const contextReady = new Promise<void>(resolve => { ready = resolve; }), contextGate = new Promise<void>(resolve => { release = resolve; });
  const service = new AssetDraftService({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), threads, isTaskAdmissionPaused: () => { if (paused) blockedReads++; return paused; }, sessions: {
    getOrCreate: () => ({ resolvePlatformToolTransport: () => "native-dynamic", prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
      sendMessage: async () => { sends++; paused = true; return { responseText: "未提交草案" }; } }),
  }, timeoutPolicy: {}, emitConversation: (event: any) => {
    if (event.type === "turn.started") h.db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, turnId: event.payload.turnId, engine: "codex", startedAt: Date.now(), startEventSeq: 1 });
    if (event.type === "turn.completed") h.db.turns.setEnded(event.payload.turnId, { status: "completed", endedAt: Date.now(), endEventSeq: 2 });
  }, emitRaw: () => {} } as any);
  const collectMethod = assetKind === "role" ? "collectRoleDraftContext" : "collectSkillDraftContext";
  const collect = (service as any)[collectMethod].bind(service);
  (service as any)[collectMethod] = async (...args: unknown[]) => { ready(); await contextGate; return collect(...args); };
  try {
    const { job } = await service.generateAssetDraft({ ...updateDraftRequest(h.workspaceId), assetKind }); await contextReady;
    paused = phase === "首轮"; release(); await waitForAssetUpdateCondition(() => blockedReads > 0);
    assert.equal(sends, phase === "首轮" ? 0 : 1); assert.equal(hasInFlightAssetDraftWork(h.db), true);
    await stopAssetDraftJobsForUpdate(h.db, { requestId: `asset-paused-${assetKind}-${phase}`, interruptTurn: async () => { assert.fail("等待下一轮时没有运行中的turn"); }, disposeThread: async () => { disposals++; } });
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "cancelled");
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.failure, null); assert.equal(hasInFlightAssetDraftWork(h.db), false);
    paused = false; await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sends, phase === "首轮" ? 0 : 1); assert.equal(disposals, phase === "首轮" ? 0 : 1);
  } finally { paused = false; release(); await waitForAssetUpdateCondition(() => !hasInFlightAssetDraftWork(h.db)); resetEngineModelCatalogRuntimeForTest(); h.cleanup(); }
});

for (const assetKind of ["role", "skill"] as const) test(`${assetKind}等待期间暂停getter异常必须显式失败且不派发模型`, async () => {
  const h = createRecoveryHarness();
  let paused = false, getterFailure: Error | undefined, ready!: () => void, release!: () => void, blockedReads = 0, sends = 0;
  const cause = new Error(`asset-${assetKind}-admission-getter-failed`);
  const contextReady = new Promise<void>(resolve => { ready = resolve; }), contextGate = new Promise<void>(resolve => { release = resolve; });
  const service = new AssetDraftService({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), isTaskAdmissionPaused: () => { if (getterFailure) throw getterFailure; if (paused) blockedReads++; return paused; }, sessions: { getOrCreate: () => { sends++; assert.fail("暂停事实读取失败不能启动引擎会话"); } }, emitConversation: () => {} } as any);
  const collectMethod = assetKind === "role" ? "collectRoleDraftContext" : "collectSkillDraftContext";
  const collect = (service as any)[collectMethod].bind(service);
  (service as any)[collectMethod] = async (...args: unknown[]) => { ready(); await contextGate; return collect(...args); };
  try {
    const { job } = await service.generateAssetDraft({ ...updateDraftRequest(h.workspaceId), assetKind }); await contextReady;
    paused = true; release(); await waitForAssetUpdateCondition(() => blockedReads > 0); getterFailure = cause;
    await waitForAssetUpdateCondition(() => !hasInFlightAssetDraftWork(h.db));
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "failed");
    assert.match(h.db.orchAssetGenerationJobs.get(job.id)?.failure?.message ?? "", new RegExp(cause.message));
    assert.equal(sends, 0);
  } finally { paused = false; release(); await waitForAssetUpdateCondition(() => !hasInFlightAssetDraftWork(h.db)); h.cleanup(); }
});

test("资产模型派发缺少真实owner时明确失败，不猜测恢复成功", async () => {
  const h = createRecoveryHarness();
  try {
    const service = new AssetDraftService({ db: h.db, isTaskAdmissionPaused: () => false } as any);
    for (const method of ["invokeRoleDraftEngine", "invokeSkillDraftEngine"]) {
      const job = createJob(h, "generating"), before = h.db.orchAssetGenerationJobs.get(job.id);
      await assert.rejects((service as any)[method](job.id), { code: "DESKTOP_UPDATE_ASSET_OWNER_MISSING" });
      assert.deepEqual(h.db.orchAssetGenerationJobs.get(job.id), before);
    }
    assert.equal(hasInFlightAssetDraftWork(h.db), false);
  } finally { h.cleanup(); }
});

test("热更新等待资产后台收口和会话释放，期间拒绝迟到写回", async () => {
  const h = createRecoveryHarness();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const disposed: string[] = [];
  const service = new AssetDraftService({ db: h.db, sessions: { disposeThread: async (id: string) => { disposed.push(id); } } } as any);
  let jobId: any;
  (service as any).runGenerateRoleDraftJob = async (id: any) => {
    jobId = id; entered(); await gate;
    (service as any).updateJobStatus(id, "generating", { stage: "generating", headline: "迟到生成" }, ["queued"]);
  };
  (service as any).loadRoleReferenceContext = () => ({ roles: [], knowledgeBundles: [], toolsets: [], skills: [], knowledgeBundleById: new Map(), toolsetById: new Map() });
  (service as any).requireWorkspacePath = () => h.db.workspaces.get(h.workspaceId)!.path;
  try {
    const result = await service.generateRoleDraft(updateDraftRequest(h.workspaceId)); await ready;
    assert.equal(result.job.id, jobId);
    assert.equal(hasInFlightAssetDraftWork(h.db), true);
    let done = false;
    const stopping = stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-update-owner", interruptTurn: async () => {} }).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false);
    release(); await stopping;
    assert.equal(h.db.orchAssetGenerationJobs.get(jobId)?.status, "cancelled");
    assert.equal(hasInFlightAssetDraftWork(h.db), false);
    assert.deepEqual(disposed, []);
  } finally { release(); h.cleanup(); }
});

test("热更新先精确中断已有 turn，中断失败不伪造 cancelled", async () => {
  const h = createRecoveryHarness();
  try {
    const threadId = "update-detached-asset" as ThreadId, turnId = "update-detached-turn" as TurnId;
    const job = createJob(h, "generating", threadId); createTurn(h, threadId, turnId, "started");
    const cause = new Error("asset-provider-interrupt-failed"), targets: unknown[] = [];
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-interrupt-failure", interruptTurn: async target => { targets.push(target); throw cause; } }), error => error === cause);
    assert.deepEqual(targets, [{ workspaceId: h.workspaceId, threadId, turnId }]);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
    assert.equal(h.db.turns.get(turnId)?.status, "started");
  } finally { h.cleanup(); }
});

test("资产中断失败后等待同次后台失败，聚合保留根因且不继续副作用", async () => {
  const h = createRecoveryHarness();
  let entered!: () => void, rejectWorker!: (reason: unknown) => void, interrupted!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const worker = new Promise<void>((_resolve, reject) => { rejectWorker = reject; });
  const interruption = new Promise<void>(resolve => { interrupted = resolve; });
  const interruptFailure = new Error("asset-stop-independent-interrupt"), executionFailure = new Error("asset-stop-independent-execution");
  const service = new AssetDraftService({ db: h.db } as any);
  (service as any).requireWorkspacePath = () => h.db.workspaces.get(h.workspaceId)!.path;
  (service as any).runGenerateRoleDraftJob = async () => { entered(); await worker; };
  try {
    const { job } = await service.generateRoleDraft(updateDraftRequest(h.workspaceId)); await ready;
    const threadId = "update-combined-asset" as ThreadId, turnId = "update-combined-turn" as TurnId;
    createTurn(h, threadId, turnId, "started");
    h.db.orchAssetGenerationJobs.patchIfStatus(job.id, ["queued"], { threadId });
    const later = createJob(h, "awaiting_input");
    let interrupts = 0, disposals = 0, completed = false;
    const input = { requestId: "asset-combined-stop", interruptTurn: async () => { interrupts++; interrupted(); throw interruptFailure; }, disposeThread: async () => { disposals++; } };
    const stopping = stopAssetDraftJobsForUpdate(h.db, input).then(() => { completed = true; return { status: "fulfilled" as const }; }, reason => { completed = true; return { status: "rejected" as const, reason }; });
    await interruption; await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, "中断失败不能跳过已启动的后台结果");
    assert.equal(disposals, 0);
    assert.equal(h.db.orchAssetGenerationJobs.get(later.id)?.status, "awaiting_input");
    rejectWorker(executionFailure);
    const result = await stopping; assert.equal(result.status, "rejected");
    assert.ok("reason" in result && result.reason instanceof AggregateError);
    assert.deepEqual(result.reason.errors, [interruptFailure, executionFailure]);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === result.reason);
    assert.equal(interrupts, 1); assert.equal(disposals, 0);
    assert.equal(hasInFlightAssetDraftWork(h.db), true);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "failed");
    assert.equal(h.db.orchAssetGenerationJobs.get(later.id)?.status, "awaiting_input");
    assert.equal(h.db.turns.get(turnId)?.status, "started");
  } finally { rejectWorker(executionFailure); h.cleanup(); }
});

test("资产中断失败后超时仍保留同次后台，后续取得完整聚合结果", async () => {
  const h = createRecoveryHarness();
  let entered!: () => void, rejectWorker!: (reason: unknown) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), worker = new Promise<void>((_resolve, reject) => { rejectWorker = reject; });
  const interruptFailure = new Error("asset-stop-timeout-interrupt"), executionFailure = new Error("asset-stop-timeout-execution");
  const service = new AssetDraftService({ db: h.db } as any);
  (service as any).requireWorkspacePath = () => h.db.workspaces.get(h.workspaceId)!.path;
  (service as any).runGenerateRoleDraftJob = async () => { entered(); await worker; };
  try {
    const { job } = await service.generateRoleDraft(updateDraftRequest(h.workspaceId)); await ready;
    const threadId = "update-combined-timeout-asset" as ThreadId, turnId = "update-combined-timeout-turn" as TurnId;
    createTurn(h, threadId, turnId, "started"); h.db.orchAssetGenerationJobs.patchIfStatus(job.id, ["queued"], { threadId });
    let interrupts = 0, disposals = 0;
    const input = { requestId: "asset-combined-timeout", interruptTurn: async () => { interrupts++; throw interruptFailure; }, disposeThread: async () => { disposals++; } };
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, { ...input, timeoutMs: 10 }), { code: "DESKTOP_UPDATE_ASSET_STOP_TIMEOUT" });
    assert.equal(hasInFlightAssetDraftWork(h.db), true); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "queued");
    rejectWorker(executionFailure);
    const [result] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]);
    assert.equal(result.status, "rejected"); assert.ok("reason" in result && result.reason instanceof AggregateError);
    assert.deepEqual(result.reason.errors, [interruptFailure, executionFailure]);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === result.reason);
    assert.equal(interrupts, 1); assert.equal(disposals, 0); assert.equal(hasInFlightAssetDraftWork(h.db), true);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "failed");
  } finally { rejectWorker(executionFailure); h.cleanup(); }
});

const sharedUpdateFailure = new Error("asset-stop-shared-failure");
for (const [label, interruptFailure, executionFailure, uniqueFailures] of [
  ["undefined/null", undefined, null, [undefined, null]],
  ["null/NaN", null, NaN, [null, NaN]],
  ["重复NaN", NaN, NaN, [NaN]],
  ["重复Error", sharedUpdateFailure, sharedUpdateFailure, [sharedUpdateFailure]],
] as const) test(`资产停止收齐任意拒绝值并按原值去重：${label}`, async () => {
  const h = createRecoveryHarness();
  let entered!: () => void, rejectWorker!: (reason: unknown) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), worker = new Promise<void>((_resolve, reject) => { rejectWorker = reject; });
  const service = new AssetDraftService({ db: h.db } as any);
  (service as any).requireWorkspacePath = () => h.db.workspaces.get(h.workspaceId)!.path;
  (service as any).runGenerateRoleDraftJob = async () => { entered(); await worker; };
  try {
    const { job } = await service.generateRoleDraft(updateDraftRequest(h.workspaceId)); await ready;
    const threadId = "update-unknown-combined-asset" as ThreadId, turnId = "update-unknown-combined-turn" as TurnId;
    createTurn(h, threadId, turnId, "started"); h.db.orchAssetGenerationJobs.patchIfStatus(job.id, ["queued"], { threadId });
    let interrupts = 0;
    const input = { requestId: "asset-combined-unknown", interruptTurn: async () => { interrupts++; throw interruptFailure; }, disposeThread: async () => { assert.fail("失败后不能释放会话"); } };
    const stopping = Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]); rejectWorker(executionFailure);
    const [result] = await stopping; assert.equal(result.status, "rejected"); assert.ok("reason" in result);
    if (uniqueFailures.length === 1) assert.equal(result.reason, interruptFailure);
    else { assert.ok(result.reason instanceof AggregateError); assert.deepEqual(result.reason.errors, uniqueFailures); }
    const [repeat] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]);
    assert.equal(repeat.status, "rejected"); assert.ok("reason" in repeat); assert.equal(repeat.reason, result.reason);
    assert.equal(interrupts, 1); assert.equal(hasInFlightAssetDraftWork(h.db), true); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "failed");
  } finally { rejectWorker(executionFailure); h.cleanup(); }
});

test("热更新中断成功后仍须核对 turn 真实终态", async () => {
  const h = createRecoveryHarness();
  try {
    const threadId = "update-unverified-asset" as ThreadId, turnId = "update-unverified-turn" as TurnId;
    const job = createJob(h, "generating", threadId); createTurn(h, threadId, turnId, "started");
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-unverified-stop", interruptTurn: async () => {} }), { code: "DESKTOP_UPDATE_ASSET_TURN_STILL_RUNNING" });
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
  } finally { h.cleanup(); }
});

test("热更新取消人工等待任务保留草案和任务记录", async () => {
  const h = createRecoveryHarness();
  try {
    const inputJob = createJob(h, "awaiting_input"), reviewJob = createJob(h, "awaiting_review");
    const draft = h.db.orchAssetDrafts.create({ workspaceId: h.workspaceId, assetKind: "role", mode: "create", status: "awaiting_review", targetAssetId: null, baseVersionId: null, sourceJobId: reviewJob.id, prompt: reviewJob.prompt, payloadJson: "{}", validationIssues: [], rationale: null, engineInfo: { engine: "codex", model: null, effort: null } });
    h.db.orchAssetGenerationJobs.attachDraft(reviewJob.id, draft.id);
    await stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-waiting-stop", interruptTurn: async () => { assert.fail("未运行等待任务无需中断"); } });
    assert.equal(h.db.orchAssetGenerationJobs.get(inputJob.id)?.status, "cancelled");
    assert.equal(h.db.orchAssetGenerationJobs.get(reviewJob.id)?.status, "cancelled");
    assert.equal(h.db.orchAssetDrafts.get(draft.id)?.status, "awaiting_review");
  } finally { h.cleanup(); }
});

test("热更新超时保留同一资产后台 owner，后续等待不重启任务", async () => {
  const h = createRecoveryHarness();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const service = new AssetDraftService({ db: h.db } as any);
  (service as any).requireWorkspacePath = () => h.db.workspaces.get(h.workspaceId)!.path;
  let runs = 0;
  (service as any).runGenerateRoleDraftJob = async () => { runs++; entered(); await gate; };
  try {
    await service.generateRoleDraft(updateDraftRequest(h.workspaceId)); await ready;
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-timeout", timeoutMs: 10, interruptTurn: async () => {} }), { code: "DESKTOP_UPDATE_ASSET_STOP_TIMEOUT" });
    assert.equal(hasInFlightAssetDraftWork(h.db), true);
    release();
    await stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-timeout-retry", interruptTurn: async () => {} });
    assert.equal(runs, 1); assert.equal(hasInFlightAssetDraftWork(h.db), false);
  } finally { release(); h.cleanup(); }
});

test("热更新等待会话释放并保留释放失败，重复请求不假成功", async () => {
  const h = createRecoveryHarness();
  try {
    const threadId = "update-dispose-asset" as ThreadId, turnId = "update-dispose-turn" as TurnId;
    const job = createJob(h, "generating", threadId); createTurn(h, threadId, turnId, "started");
    const cause = new Error("asset-dispose-failed"); let interrupts = 0, disposals = 0;
    const input = { requestId: "asset-dispose-failure", interruptTurn: async () => { interrupts++; h.db.turns.setEnded(turnId, { status: "error" as const, endedAt: Date.now(), endEventSeq: 2 }); }, disposeThread: async () => { disposals++; throw cause; } };
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === cause);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, { ...input, requestId: "asset-dispose-repeat" }), error => error === cause);
    assert.equal(interrupts, 1); assert.equal(disposals, 1);
    assert.equal(hasInFlightAssetDraftWork(h.db), true);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
  } finally { h.cleanup(); }
});

for (const failure of [undefined, null, NaN]) test(`热更新保留资产后台任意拒绝值：${failure}`, async () => {
  const h = createRecoveryHarness();
  let entered!: () => void, reject!: (value: unknown) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>((_resolve, fail) => { reject = fail; });
  const service = new AssetDraftService({ db: h.db } as any);
  (service as any).requireWorkspacePath = () => h.db.workspaces.get(h.workspaceId)!.path;
  (service as any).runGenerateRoleDraftJob = async () => { entered(); await gate; };
  try {
    await service.generateRoleDraft(updateDraftRequest(h.workspaceId)); await ready;
    const stopping = stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-unknown-rejection", interruptTurn: async () => {} });
    reject(failure);
    let failed = false;
    try { await stopping; } catch (error) { failed = true; assert.equal(error, failure); }
    assert.equal(failed, true); assert.equal(hasInFlightAssetDraftWork(h.db), true);
    failed = false;
    try { await stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-repeat-rejection", interruptTurn: async () => {} }); } catch (error) { failed = true; assert.equal(error, failure); }
    assert.equal(failed, true);
  } finally { h.cleanup(); }
});

test("资产后台失败状态写入失败必须保留 owner 供更新观察", async () => {
  const h = createRecoveryHarness();
  const service = new AssetDraftService({ db: h.db } as any);
  (service as any).requireWorkspacePath = () => h.db.workspaces.get(h.workspaceId)!.path;
  const cause = new Error("asset-worker-failed"), persist = new Error("asset-failure-write-failed");
  (service as any).runGenerateRoleDraftJob = async () => { throw cause; };
  (service as any).settleRunFailure = () => { throw persist; };
  try {
    await service.generateRoleDraft(updateDraftRequest(h.workspaceId));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hasInFlightAssetDraftWork(h.db), true);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-failed-persistence", interruptTurn: async () => {} }), (error: any) => { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [cause, persist]); return true; });
  } finally { h.cleanup(); }
});

test("热更新真实引擎中断后拒绝完成事件和迟到工具，等待 send 与 dispose", async () => {
  const h = createRecoveryHarness(), threads = new ThreadStore();
  applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 1, rows: structuredClone(INITIAL_ENGINE_MODEL_CATALOG_V1) });
  let entered!: () => void, finish!: () => void, cleanup!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), sendGate = new Promise<void>(resolve => { finish = resolve; }), cleanupGate = new Promise<void>(resolve => { cleanup = resolve; });
  const events: any[] = []; let sent: any, sink: any, disposals = 0, late: any;
  const service = new AssetDraftService({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), threads, sessions: {
    getOrCreate: () => ({ resolvePlatformToolTransport: () => "native-dynamic", prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
      sendMessage: async (input: any, emitters: any) => { sent = input; sink = emitters; entered(); await sendGate; late = await input.executeHostTool({ toolId: "runtime.submitRoleDraft", toolInput: {} }); emitters.conversation({ workspaceId: h.workspaceId, threadId: h.db.orchAssetGenerationJobs.listByStatuses(["generating"])[0]!.threadId, type: "turn.completed", payload: { turnId: input.turnId } }); return { responseText: "late" }; } }),
  }, timeoutPolicy: {}, emitConversation: (event: any) => { events.push(event); if (event.type === "turn.started") h.db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, turnId: event.payload.turnId, engine: "codex", startedAt: Date.now(), startEventSeq: 1 }); }, emitRaw: () => {} } as any);
  try {
    const result = await service.generateRoleDraft(updateDraftRequest(h.workspaceId)); await ready;
    let completed = false;
    const stop = stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-real-stop", interruptTurn: async target => { assert.equal(target.turnId, sent.turnId); h.db.turns.setEnded(target.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 2 }); }, disposeThread: async () => { disposals++; await cleanupGate; } }).then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
    finish(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(disposals, 1); assert.equal(completed, false);
    cleanup(); await stop;
    assert.equal(late.ok, false);
    assert.equal(events.some(event => event.type === "turn.completed"), false);
    assert.equal(h.db.orchAssetGenerationJobs.get(result.job.id)?.status, "cancelled");
    assert.equal(hasInFlightAssetDraftWork(h.db), false);
    assert.ok(sink);
  } finally { finish(); cleanup(); resetEngineModelCatalogRuntimeForTest(); h.cleanup(); }
});

test("资产交互中断失败不得显示正常等待，错误保留供更新停止观察", async () => {
  const h = createRecoveryHarness(), threads = new ThreadStore();
  applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 1, rows: structuredClone(INITIAL_ENGINE_MODEL_CATALOG_V1) });
  const cause = new Error("asset-interaction-interrupt-failed");
  const service = new AssetDraftService({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), threads, sessions: {
    getOrCreate: () => ({ resolvePlatformToolTransport: () => "native-dynamic", prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }), interrupt: async () => { throw cause; },
      sendMessage: async (_input: unknown, emitters: any) => { emitters.conversation({ workspaceId: h.workspaceId, threadId: "unused", type: "userInput.requested", payload: { requestId: "input", questions: [] } }); return { responseText: "" }; } }),
  }, timeoutPolicy: {}, emitConversation: () => {}, emitRaw: () => {} } as any);
  try {
    const result = await service.generateRoleDraft(updateDraftRequest(h.workspaceId));
    const deadline = Date.now() + 2000;
    while (["queued", "planning", "collecting_context", "generating"].includes(h.db.orchAssetGenerationJobs.get(result.job.id)!.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.db.orchAssetGenerationJobs.get(result.job.id)?.status, "failed");
    assert.match(h.db.orchAssetGenerationJobs.get(result.job.id)?.failure?.message ?? "", /中断|interrupt/);
  } finally { resetEngineModelCatalogRuntimeForTest(); h.cleanup(); }
});

test("资产更新并发停止共用中断结果，不影响另一数据库", async () => {
  const h = createRecoveryHarness(), other = createRecoveryHarness();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const threadId = "update-concurrent-asset" as ThreadId, turnId = "update-concurrent-turn" as TurnId;
    const job = createJob(h, "generating", threadId); createTurn(h, threadId, turnId, "started");
    let interrupts = 0, disposals = 0;
    const input = { requestId: "asset-concurrent", interruptTurn: async () => { interrupts++; await gate; h.db.turns.setEnded(turnId, { status: "error" as const, endedAt: Date.now(), endEventSeq: 2 }); }, disposeThread: async () => { disposals++; } };
    const first = stopAssetDraftJobsForUpdate(h.db, input), second = stopAssetDraftJobsForUpdate(h.db, input);
    assert.equal(hasInFlightAssetDraftWork(h.db), true);
    assert.equal(hasInFlightAssetDraftWork(other.db), false);
    release(); await Promise.all([first, second]);
    assert.equal(interrupts, 1); assert.equal(disposals, 1);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "cancelled");
  } finally { release(); h.cleanup(); other.cleanup(); }
});

test("资产更新停止日志保留聚合根因且脱敏，中断失败不继续其他任务", async () => {
  const h = createRecoveryHarness();
  try {
    const threadId = "update-log-asset" as ThreadId, turnId = "update-log-turn" as TurnId;
    const first = createJob(h, "generating", threadId); createTurn(h, threadId, turnId, "started");
    const second = createJob(h, "awaiting_input");
    const cause = new AggregateError([new Error("asset-unique-root token=d09l-synthetic-secret"), new Error("asset-cleanup-root", { cause: new Error("asset-nested-root password=d09l-synthetic-password") })], "asset-stop-roots");
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-log-request", interruptTurn: async () => { throw cause; } }), error => error === cause);
    assert.equal(h.db.orchAssetGenerationJobs.get(first.id)?.status, "generating");
    assert.equal(h.db.orchAssetGenerationJobs.get(second.id)?.status, "awaiting_input");
    const serialized = JSON.stringify(readRecoveryAssetLogs(h));
    for (const marker of ["asset-unique-root", "asset-cleanup-root", "asset-nested-root", "asset-log-request", first.id, threadId]) assert.ok(serialized.includes(marker));
    assert.equal(serialized.includes("d09l-synthetic"), false);
  } finally { h.cleanup(); }
});

test("资产终态协调期间确认更新不能再发 completed", async () => {
  const h = createRecoveryHarness(), threads = new ThreadStore(), events: any[] = [];
  applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 1, rows: structuredClone(INITIAL_ENGINE_MODEL_CATALOG_V1) });
  let stopping: Promise<void> | undefined;
  const service = new AssetDraftService({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), threads, sessions: {
    getOrCreate: () => ({ resolvePlatformToolTransport: () => "native-dynamic", prepareAssistantTerminalEvents: async () => {
      stopping = stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-terminal-race", interruptTurn: async target => { h.db.turns.setEnded(target.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 2 }); }, disposeThread: async () => {} });
      return { events: [], latestAssistantText: null };
    }, sendMessage: async () => ({ responseText: "没有提交" }) }),
  }, timeoutPolicy: {}, emitConversation: (event: any) => { events.push(event); if (event.type === "turn.started") h.db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, turnId: event.payload.turnId, engine: "codex", startedAt: Date.now(), startEventSeq: 1 }); }, emitRaw: () => {} } as any);
  try {
    await service.generateRoleDraft(updateDraftRequest(h.workspaceId));
    const deadline = Date.now() + 2000;
    while (!stopping && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(stopping); await stopping;
    assert.equal(events.some(event => event.type === "turn.completed"), false);
  } finally { resetEngineModelCatalogRuntimeForTest(); h.cleanup(); }
});

test("资产恢复遇未释放 owner 不得先改写任务或候选", async () => {
  const h = createRecoveryHarness(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const service = new AssetDraftService({ db: h.db } as any);
  (service as any).requireWorkspacePath = () => h.db.workspaces.get(h.workspaceId)!.path;
  (service as any).runGenerateRoleDraftJob = async () => { entered(); await gate; };
  try {
    const { job } = await service.generateRoleDraft(updateDraftRequest(h.workspaceId)); await ready;
    h.db.orchAssetGenerationJobs.patchIfStatus(job.id, ["queued"], { status: "awaiting_input" });
    const before = h.db.orchAssetGenerationJobs.get(job.id);
    await assert.rejects(service.resumeRoleDraftJob({ workspaceId: h.workspaceId, jobId: job.id, prompt: "继续" }), { code: "CONFLICT" });
    assert.deepEqual(h.db.orchAssetGenerationJobs.get(job.id), before);
    release(); await stopAssetDraftJobsForUpdate(h.db, { requestId: "asset-resume-cleanup", interruptTurn: async () => {} });
  } finally { release(); h.cleanup(); }
});

/** 可控等待只阻塞真实公开 provider 或资源回收入口。 */
function assetLogGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** 公开生成创建真实 job/thread/turn；可在真实交互入口注入中断失败。 */
function createPublicAssetLogHarness(assetKind: "role" | "skill" = "role", resume = false, options?: Parameters<typeof createRecoveryHarness>[0] & { interactionFailure?: { value: unknown } }) {
  const h = createRecoveryHarness(options), threads = new ThreadStore(), entered = assetLogGate(), provider = assetLogGate();
  applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 1, rows: structuredClone(INITIAL_ENGINE_MODEL_CATALOG_V1) });
  let sends = 0, interactionInterrupts = 0, failure: { value: unknown } | undefined;
  const service = new AssetDraftService({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), threads,
    sessions: { getOrCreate: () => ({ resolvePlatformToolTransport: () => "native-dynamic", hasActiveTurn: () => false, interrupt: async () => { interactionInterrupts++; if (options?.interactionFailure) throw options.interactionFailure.value; return true; },
      prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }), sendMessage: async (_input: unknown, emitters: any) => {
        sends++;
        if (resume && sends === 1) { emitters.conversation({ type: "userInput.requested", payload: { requestId: "log-seed", prompt: "请补充", questions: [] } }); throw new Error("turn interrupted"); }
        if (options?.interactionFailure) emitters.conversation({ type: "userInput.requested", payload: { requestId: "f1-interaction", prompt: "请补充交互边界", questions: [] } });
        entered.resolve(); await provider.promise; if (failure) throw failure.value; return { responseText: "无提交" };
      } }) }, timeoutPolicy: {}, emitConversation: (event: any) => {
        if (event.type === "turn.started") h.db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, turnId: event.payload.turnId, engine: "codex", startedAt: Date.now(), startEventSeq: sends + 1 });
        if (event.type === "turn.error" || event.type === "turn.completed") h.db.turns.setEnded(event.payload.turnId, { status: event.type === "turn.error" ? "error" : "completed", endedAt: Date.now(), endEventSeq: sends + 2 });
      }, emitRaw: () => {} } as any);
  return { ...h, threads, service, provider, entered, sends: () => sends, interactionInterrupts: () => interactionInterrupts, fail: (value: unknown) => { failure = { value }; },
    /** 续跑先通过真实待输入轮次释放 owner，再受理第二轮。 */
    async start() {
      const { job } = await service.generateAssetDraft({ ...updateDraftRequest(h.workspaceId), assetKind });
      if (resume) { await waitForAssetUpdateCondition(() => h.db.orchAssetGenerationJobs.get(job.id)?.status === "awaiting_input" && !hasInFlightAssetDraftWork(h.db)); await service.resumeAssetDraftJob({ workspaceId: h.workspaceId, jobId: job.id, prompt: "继续" }); }
      await entered.promise; return h.db.orchAssetGenerationJobs.get(job.id)!;
    },
    /** 测试须先收齐公开结果，再关闭自己的 SQLite 和目录。 */
    cleanup() { provider.resolve(); resetEngineModelCatalogRuntimeForTest(); h.cleanup(); },
  };
}

/** 以原对象沿聚合树检查保因，避免通过字符串重建错误。 */
function assetLogCauses(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(assetLogCauses)] : [error];
}

for (const assetKind of ["role", "skill"] as const) test(`资产日志 F1 ${assetKind} 交互中断和日志已失败时 stop 不得新增 provider 副作用`, async t => {
  const interaction = new Error(`f1-${assetKind}-interaction-interrupt`), diagnostic = new Error(`f1-${assetKind}-workspace-log`), business = new Error(`f1-${assetKind}-provider`);
  const h = createPublicAssetLogHarness(assetKind, false, { interactionFailure: { value: interaction } });
  let logs = 0, interrupts = 0, disposals = 0;
  t.mock.method(h.db, "writeWorkspaceLog", () => { logs++; throw diagnostic; });
  try {
    const job = await h.start(), later = createJob(h, "awaiting_input"); h.fail(business); h.provider.resolve();
    await waitForAssetUpdateCondition(() => logs === 1); await new Promise(resolve => setImmediate(resolve));
    const turns = h.db.turns.listByThread(job.threadId!); assert.equal(turns.length, 1); assert.equal(turns[0]!.status, "started"); assert.equal(h.interactionInterrupts(), 1);
    const transaction = t.mock.method(h.db.db, "transaction"), remove = t.mock.method(h.db.orchAssetGenerationJobs, "delete");
    const input = { requestId: `f1-settled-${assetKind}`, interruptTurn: async (target: { turnId: TurnId }) => { interrupts++; h.db.turns.setEnded(target.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 2 }); }, disposeThread: async () => { disposals++; } };
    const [first, concurrent] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input), stopAssetDraftJobsForUpdate(h.db, input)]);
    assert.equal(interrupts, 0, "执行日志已经失败，公开 stop 不得再启动 provider interrupt");
    assert.ok(first.status === "rejected"); assert.equal(first.reason.code, "ASSET_DRAFT_EXECUTION_LOG_FAILED"); assert.equal(first.reason.errors[1], diagnostic); assert.equal(first.reason.cause, first.reason.errors[0]);
    const causes = assetLogCauses(first.reason); assert.ok(causes.includes(business)); assert.ok(causes.includes(interaction));
    assert.ok(concurrent.status === "rejected" && concurrent.reason === first.reason); await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === first.reason);
    assert.equal(interrupts, 0); assert.equal(disposals, 0); assert.equal(transaction.mock.callCount(), 0); assert.equal(remove.mock.callCount(), 0); assert.equal(logs, 1); assert.equal(h.sends(), 1); assert.equal(h.interactionInterrupts(), 1);
    assert.equal(h.db.turns.get(turns[0]!.turnId)?.status, "started"); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating"); assert.equal(h.db.orchAssetGenerationJobs.get(later.id)?.status, "awaiting_input"); assert.equal(hasInFlightAssetDraftWork(h.db), true);
  } finally { h.provider.resolve(); h.cleanup(); }
});

test("资产日志 F1 已启动的 stop 中断须等完并保留独立错误", async t => {
  const interaction = new Error("f1-started-interaction"), diagnostic = new Error("f1-started-log"), business = new Error("f1-started-provider"), interrupt = new Error("f1-started-stop-interrupt");
  const h = createPublicAssetLogHarness("role", false, { interactionFailure: { value: interaction } }), gate = assetLogGate(), entered = assetLogGate();
  let logs = 0, interrupts = 0, disposals = 0, settled = false;
  t.mock.method(h.db, "writeWorkspaceLog", () => { logs++; throw diagnostic; });
  try {
    const job = await h.start(); h.fail(business);
    const input = { requestId: "f1-started-stop", interruptTurn: async () => { interrupts++; entered.resolve(); await gate.promise; throw interrupt; }, disposeThread: async () => { disposals++; } };
    const stopping = Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]).then(results => { settled = true; return results; }); await entered.promise;
    h.provider.resolve(); await waitForAssetUpdateCondition(() => logs === 1); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(disposals, 0);
    gate.resolve(); const [first] = await stopping; assert.ok(first.status === "rejected");
    const causes = assetLogCauses(first.reason); for (const cause of [interaction, diagnostic, business, interrupt]) assert.ok(causes.includes(cause));
    assert.equal(first.reason.errors[0], interrupt); assert.equal(first.reason.cause, interrupt); assert.equal(first.reason.errors[1].code, "ASSET_DRAFT_EXECUTION_LOG_FAILED");
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === first.reason); assert.equal(interrupts, 1); assert.equal(disposals, 0); assert.equal(logs, 1); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
  } finally { gate.resolve(); h.provider.resolve(); h.cleanup(); }
});

test("资产日志 F1 删除后首次 stop 同时保留已结算诊断和缺行独立原因", async t => {
  const interaction = new Error("f1-deleted-interaction"), diagnostic = new Error("f1-deleted-log"), business = new Error("f1-deleted-provider");
  const h = createPublicAssetLogHarness("skill", false, { interactionFailure: { value: interaction } }); let logs = 0, disposedForDelete = 0;
  t.mock.method(h.db, "writeWorkspaceLog", () => { logs++; throw diagnostic; });
  try {
    const job = await h.start(); h.fail(business); h.provider.resolve(); await waitForAssetUpdateCondition(() => logs === 1); await new Promise(resolve => setImmediate(resolve));
    for (const turn of h.db.turns.listByThread(job.threadId!)) h.db.turns.setEnded(turn.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 2 });
    const responses: any[] = [];
    await handleOrchAssetDraftJobsDelete({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), getActiveThreadTurn: () => null,
      sessions: { disposeThreadWithOptions: async () => { disposedForDelete++; } }, threads: h.threads, orchEngine: { disposeManagedServicesForThread: async () => {} }, send: (response: unknown) => { responses.push(response); } } as any,
      { t: "api.req", id: "f1-public-delete", method: "orch.assetDraftJobs.delete", body: { workspaceId: h.workspaceId, jobId: job.id } } as any);
    assert.equal(responses.at(-1)?.status, 200); assert.equal(disposedForDelete, 1); assert.equal(h.db.orchAssetGenerationJobs.get(job.id), null);
    const later = createJob(h, "awaiting_input"), transaction = t.mock.method(h.db.db, "transaction");
    const input = { requestId: "f1-stop-after-delete", interruptTurn: async () => { assert.fail("不得中断已删除任务"); }, disposeThread: async () => { assert.fail("不得重复释放已删除任务"); } };
    const [first, concurrent] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input), stopAssetDraftJobsForUpdate(h.db, input)]); assert.ok(first.status === "rejected");
    const causes = assetLogCauses(first.reason); for (const cause of [interaction, diagnostic, business]) assert.ok(causes.includes(cause)); assert.ok(causes.some(cause => cause instanceof Error && /更新停止缺少资产任务/.test(cause.message)));
    assert.ok(concurrent.status === "rejected" && concurrent.reason === first.reason); await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === first.reason);
    assert.equal(transaction.mock.callCount(), 0); assert.equal(logs, 1); assert.equal(h.db.orchAssetGenerationJobs.get(job.id), null); assert.equal(h.db.orchAssetGenerationJobs.get(later.id)?.status, "awaiting_input"); assert.equal(hasInFlightAssetDraftWork(h.db), true);
  } finally { h.provider.resolve(); h.cleanup(); }
});

for (const diagnostic of [new Error("execution-log-write-failed"), undefined, null, NaN] as const) test(`资产工作区诊断失败保原业务对象和 falsy ${String(diagnostic)}`, async t => {
  const h = createPublicAssetLogHarness(), business = new AssetDraftServiceError(503, "ENGINE_UNAVAILABLE", "business-中文🙂");
  let attempts = 0;
  const write = h.db.writeWorkspaceLog;
  t.mock.method(h.db, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: Parameters<ClientDb["writeWorkspaceLog"]>[1]) => { attempts++; if (attempts === 1) throw diagnostic; return write(workspaceId, entry); });
  try {
    const job = await h.start(); h.fail(business); h.provider.resolve();
    await waitForAssetUpdateCondition(() => attempts > 0); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
    const input = { requestId: "execution-log-public-stop", interruptTurn: async () => { assert.fail("已结束 turn 不得重复中断"); }, disposeThread: async () => { assert.fail("诊断失败不得释放或取消"); } };
    const [first, concurrent] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input), stopAssetDraftJobsForUpdate(h.db, input)]);
    assert.equal(first.status, "rejected"); assert.ok(first.status === "rejected" && first.reason instanceof AggregateError);
    assert.equal((first.reason as AggregateError & { code: string }).code, "ASSET_DRAFT_EXECUTION_LOG_FAILED"); assert.deepEqual(first.reason.errors, [business, diagnostic]); assert.equal(first.reason.cause, business);
    assert.ok(concurrent.status === "rejected" && concurrent.reason === first.reason);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === first.reason);
    assert.equal(h.sends(), 1); assert.equal(hasInFlightAssetDraftWork(h.db), true);
    assert.equal(h.db.orchAssetJobEvents.listByJob(job.id).some(event => event.type === "orch.assetDraft.failed"), false);
  } finally { h.cleanup(); }
});

/** 读取本例真实固定 W 整行日志。 */
function readRecoveryAssetLogs(h: RecoveryHarness): any[] {
  const directory = path.join(h.db.workspaces.get(h.workspaceId)!.path, ".codeflowai");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^client-\d{8}\.\d+\.log$/.test(name)).flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

test("资产工作区停止根因仅取 data descriptor，深度节点正文有界且不运行 getter/toString", async () => {
  const h = createRecoveryHarness(); let touched = 0;
  const hostile = Object.create(null, { name: { get: () => { touched++; throw new Error("getter must not run"); } }, message: { get: () => { touched++; throw new Error("message must not run"); } }, toString: { value: () => { touched++; throw new Error("toString must not run"); } } });
  const nested = new AggregateError(Array.from({ length: 30 }, () => new Error("bounded-中文🙂" + "x".repeat(2000))), "bounded-root token=descriptor-synthetic-secret");
  Object.defineProperty(nested, "cause", { value: nested });
  const failure = new AggregateError([hostile, nested], "root password=descriptor-synthetic-password");
  try {
    const thread = "safe-descriptor-thread" as ThreadId, turn = "safe-descriptor-turn" as TurnId, job = createJob(h, "generating", thread); createTurn(h, thread, turn, "started");
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, { requestId: "descriptor-log", interruptTurn: async () => { throw failure; } }), error => error === failure);
    const logs = readRecoveryAssetLogs(h); assert.equal(logs.length, 1); assert.equal(touched, 0);
    const root = logs[0].rootCause; let count = 0;
    /** 检查实际日志树而不是内部 describe 实现。 */
    const inspect = (node: any, depth = 0): void => { count++; assert.ok(depth <= 3); assert.ok(node.message.length <= 1000); if (node.errors) { assert.ok(node.errors.length <= 10); node.errors.forEach((value: unknown) => inspect(value, depth + 1)); } if (node.cause) inspect(node.cause, depth + 1); };
    inspect(root); assert.ok(count <= 20); assert.equal(JSON.stringify(logs).includes("descriptor-synthetic"), false); assert.equal(logs[0].jobId, job.id);
  } finally { h.cleanup(); }
});

test("资产工作区描述反射失败保原停止原因且缓存，不继续下一任务", async () => {
  const h = createRecoveryHarness(), diagnostic = new Error("descriptor-reflection-failed"), nested = new Proxy({}, { getOwnPropertyDescriptor: () => { throw diagnostic; } }), original = new Error("original-stop", { cause: nested });
  try {
    const thread = "reflection-thread" as ThreadId, turn = "reflection-turn" as TurnId; createJob(h, "generating", thread); createTurn(h, thread, turn, "started"); const later = createJob(h, "awaiting_input"); let interrupts = 0;
    const input = { requestId: "reflection-log", interruptTurn: async () => { interrupts++; throw original; } };
    const [first] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]);
    assert.ok(first.status === "rejected"); assert.equal(first.reason.code, "ASSET_DRAFT_STOP_LOG_FAILED"); assert.deepEqual(first.reason.errors, [original, diagnostic]); assert.equal(first.reason.cause, original);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === first.reason); assert.equal(interrupts, 1); assert.equal(h.db.orchAssetGenerationJobs.get(later.id)?.status, "awaiting_input");
  } finally { h.cleanup(); }
});

test("资产工作区结算第三错保业务与事务原因，诊断失败后不写 failed", async t => {
  const h = createPublicAssetLogHarness(), business = new AssetDraftServiceError(503, "ENGINE_UNAVAILABLE", "settlement-business"), storage = new Error("settlement-storage"), diagnostic = new Error("settlement-diagnostic");
  let logs = 0, failedWrites = 0;
  const write = h.db.writeWorkspaceLog, patch = h.db.orchAssetGenerationJobs.patchIfStatus.bind(h.db.orchAssetGenerationJobs);
  t.mock.method(h.db, "writeWorkspaceLog", (workspace: WorkspaceId, entry: Parameters<ClientDb["writeWorkspaceLog"]>[1]) => { logs++; if (logs === 2) throw diagnostic; return write(workspace, entry); });
  t.mock.method(h.db.orchAssetGenerationJobs, "patchIfStatus", (...args: Parameters<typeof patch>) => { if (args[2].status === "failed") { failedWrites++; throw storage; } return patch(...args); });
  try {
    const job = await h.start(); h.fail(business); h.provider.resolve(); await waitForAssetUpdateCondition(() => logs === 2);
    const input = { requestId: "settlement-public-stop", interruptTurn: async () => { assert.fail("已完成 turn"); }, disposeThread: async () => { assert.fail("结算失败不得取消"); } };
    const [first] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]); assert.ok(first.status === "rejected");
    assert.equal(first.reason.code, "ASSET_DRAFT_EXECUTION_LOG_FAILED"); assert.deepEqual(first.reason.errors[0].errors, [business, storage]); assert.equal(first.reason.errors[0].cause, business); assert.equal(first.reason.errors[1], diagnostic); assert.equal(first.reason.cause, first.reason.errors[0]);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === first.reason); assert.equal(logs, 2); assert.equal(failedWrites, 1); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating"); assert.equal(h.sends(), 1);
  } finally { h.cleanup(); }
});

test("资产工作区结算错的反射再失败仍保全部原对象且 execution 不产生孤儿拒绝", async t => {
  const h = createPublicAssetLogHarness(), business = new AssetDraftServiceError(503, "ENGINE_UNAVAILABLE", "reflection-settlement-business"), diagnostic = new Error("reflection-settlement-diagnostic");
  const storage = new Proxy({}, { getOwnPropertyDescriptor: () => { throw diagnostic; } });
  const patch = h.db.orchAssetGenerationJobs.patchIfStatus.bind(h.db.orchAssetGenerationJobs); let failedWrites = 0;
  t.mock.method(h.db.orchAssetGenerationJobs, "patchIfStatus", (...args: Parameters<typeof patch>) => { if (args[2].status === "failed") { failedWrites++; throw storage; } return patch(...args); });
  try {
    const job = await h.start(); h.fail(business); h.provider.resolve(); await waitForAssetUpdateCondition(() => failedWrites > 0); await new Promise(resolve => setImmediate(resolve));
    const [result] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, { requestId: "reflection-settlement-stop", interruptTurn: async () => { assert.fail("已结束 turn"); }, disposeThread: async () => { assert.fail("结算失败不得取消"); } })]);
    assert.ok(result.status === "rejected"); const causes = assetLogCauses(result.reason); assert.ok(causes.includes(business)); assert.ok(causes.includes(storage)); assert.ok(causes.includes(diagnostic));
    assert.equal(result.reason.code, "ASSET_DRAFT_EXECUTION_LOG_FAILED"); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
  } finally { h.cleanup(); }
});

test("资产工作区已有执行诊断失败由 stop 直接观察，不再进行分类反射", async t => {
  const h = createPublicAssetLogHarness(), diagnostic = new Error("stop-classification-reflection-failed"); let codeReads = 0;
  const original = new AssetDraftServiceError(503, "ENGINE_UNAVAILABLE", "stop-classification-business");
  const business = new Proxy(Object.assign(new AggregateError([original], "stop-classification-root"), { code: "ASSET_DRAFT_EXECUTION_LOG_FAILED" }), { getOwnPropertyDescriptor(target, key) { if (key === "code" && ++codeReads > 1) throw diagnostic; return Reflect.getOwnPropertyDescriptor(target, key); } });
  const patch = h.db.orchAssetGenerationJobs.patchIfStatus.bind(h.db.orchAssetGenerationJobs);
  t.mock.method(h.db.orchAssetGenerationJobs, "patchIfStatus", (...args: Parameters<typeof patch>) => { if (args[2].status === "failed") throw business; return patch(...args); });
  try {
    await h.start(); h.fail(original); h.provider.resolve(); await waitForAssetUpdateCondition(() => codeReads === 1); await new Promise(resolve => setImmediate(resolve));
    const input = { requestId: "stop-classification-reflection", interruptTurn: async () => { assert.fail("已结束 turn"); }, disposeThread: async () => { assert.fail("失败不得释放"); } };
    const [result] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]); assert.ok(result.status === "rejected");
    assert.equal(result.reason, business); assert.equal(result.reason.code, "ASSET_DRAFT_EXECUTION_LOG_FAILED"); assert.deepEqual(result.reason.errors, [original]);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === result.reason); assert.equal(codeReads, 1);
  } finally { h.cleanup(); }
});

test("资产工作区并发 timer 诊断失败按发生顺序保留，后台未回每次仍有界", async t => {
  const h = createPublicAssetLogHarness(), diagnostics = [new Error("timer-one"), null, undefined], gate = assetLogGate(); let logs = 0, interrupts = 0;
  t.mock.method(h.db, "writeWorkspaceLog", () => { throw diagnostics[logs++]; });
  try {
    const job = await h.start();
    const input = { requestId: "concurrent-timeout", timeoutMs: 15, interruptTurn: async (target: { turnId: TurnId }) => { interrupts++; await gate.promise; h.db.turns.setEnded(target.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 2 }); }, disposeThread: async () => { assert.fail("timer 诊断失败不得释放"); } };
    const first = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input), stopAssetDraftJobsForUpdate(h.db, { ...input, timeoutMs: 25 })]);
    assert.ok(first.every(result => result.status === "rejected")); assert.equal(logs, 2);
    const [third] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]); assert.ok(third.status === "rejected"); assert.equal(logs, 3);
    gate.resolve(); h.provider.resolve();
    const [final] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, { ...input, timeoutMs: 2000 })]); assert.ok(final.status === "rejected");
    const failures = assetLogCauses(final.reason).filter(value => value instanceof AggregateError && (value as any).code === "ASSET_DRAFT_STOP_LOG_FAILED");
    assert.deepEqual(failures.map(value => (value as AggregateError).errors[1]), diagnostics); assert.equal(interrupts, 1); assert.equal(logs, 3); assert.equal(hasInFlightAssetDraftWork(h.db), true); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === final.reason);
  } finally { gate.resolve(); h.provider.resolve(); h.cleanup(); }
});

test("资产工作区 timeout 诊断失败后收齐迟到中断与业务错，不再启动 failed 事务", async t => {
  const h = createPublicAssetLogHarness(), gate = assetLogGate(), diagnostic = new Error("late-timeout-log"), interrupt = new Error("late-interrupt-failed"), business = new AssetDraftServiceError(503, "ENGINE_UNAVAILABLE", "late-business-failed");
  const write = h.db.writeWorkspaceLog, patch = h.db.orchAssetGenerationJobs.patchIfStatus.bind(h.db.orchAssetGenerationJobs); let logs = 0, failedWrites = 0;
  t.mock.method(h.db, "writeWorkspaceLog", (workspace: WorkspaceId, entry: Parameters<ClientDb["writeWorkspaceLog"]>[1]) => { logs++; if (logs === 1) throw diagnostic; return write(workspace, entry); });
  t.mock.method(h.db.orchAssetGenerationJobs, "patchIfStatus", (...args: Parameters<typeof patch>) => { if (args[2].status === "failed") failedWrites++; return patch(...args); });
  try {
    const job = await h.start(); h.fail(business);
    const input = { requestId: "late-all-causes", timeoutMs: 15, interruptTurn: async () => { await gate.promise; throw interrupt; }, disposeThread: async () => { assert.fail("已有诊断失败不得释放"); } };
    const [first] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]); assert.ok(first.status === "rejected");
    gate.resolve(); h.provider.resolve();
    const [final] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, { ...input, timeoutMs: 2000 })]); assert.ok(final.status === "rejected");
    const causes = assetLogCauses(final.reason); for (const cause of [first.reason, diagnostic, interrupt, business]) assert.ok(causes.includes(cause));
    assert.equal(failedWrites, 0); assert.equal(logs, 1); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating");
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === final.reason);
  } finally { gate.resolve(); h.provider.resolve(); h.cleanup(); }
});

for (const fault of ["migration", "unsafe", "close"] as const) test(`资产工作区 ${fault} 实际固定日志失败只挡同 W，异 W 保持可写`, async t => {
  const gate = new WorkspaceOperationGate(); let closeUnconfirmed = false;
  const h = createPublicAssetLogHarness("role", false, { gate, expectCloseFailure: () => closeUnconfirmed }), business = new AssetDraftServiceError(503, "ENGINE_UNAVAILABLE", "physical-failure-business");
  let release: (() => void) | undefined;
  try {
    const job = await h.start(), root = h.db.workspaces.get(h.workspaceId)!.path, otherRoot = path.join(root, "b"), otherId = "ws-asset-log-b" as WorkspaceId; fs.mkdirSync(otherRoot); h.db.workspaces.upsert({ id: otherId, title: "B", path: otherRoot });
    if (fault === "migration") release = gate.restoreMigration(h.workspaceId, "asset-log-migration");
    if (fault === "unsafe") { const directory = path.join(root, ".codeflowai"); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "client-20000101.1.log"), "foreign"); fs.linkSync(path.join(directory, "client-20000101.1.log"), path.join(root, "hardlink")); }
    if (fault === "close") { const close = fs.closeSync; let first = true; t.mock.method(fs, "closeSync", (fd: number) => { close(fd); if (first) { first = false; closeUnconfirmed = true; throw new Error("asset-log-close-unconfirmed"); } }); }
    h.fail(business); h.provider.resolve(); await new Promise(resolve => setImmediate(resolve));
    const input = { requestId: `physical-${fault}`, interruptTurn: async () => { assert.fail("已结束 turn"); }, disposeThread: async () => { assert.fail("失败后不得释放"); } };
    const [result] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]); assert.ok(result.status === "rejected"); assert.equal(result.reason.code, "ASSET_DRAFT_EXECUTION_LOG_FAILED"); assert.equal(result.reason.errors[0], business);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating"); assert.equal(hasInFlightAssetDraftWork(h.db), true);
    h.db.writeWorkspaceLog(otherId, { level: "error", tag: "orch-asset-draft", message: "independent B remains writable" });
    assert.ok(fs.readdirSync(path.join(otherRoot, ".codeflowai")).some(name => name.endsWith(".log")));
    assert.throws(() => h.db.writeWorkspaceLog(h.workspaceId, { level: "error", tag: "orch-asset-draft", message: "same W still blocked" }));
    if (fault === "close") assert.equal(gate.hasActiveWrites(), true);
    else assert.equal(gate.hasActiveWrites(), false);
  } finally { release?.(); h.provider.resolve(); h.cleanup(); }
});

for (const phase of ["interrupt", "execution", "dispose"] as const) test(`资产工作区 timeout 日志失败在 ${phase} 等待内收齐且阻止迟到副作用`, async t => {
  const h = createPublicAssetLogHarness(), gate = assetLogGate(), diagnostic = new Error(`timeout-log-${phase}`), disposeFailure = new Error("already-started-dispose-failed");
  let interrupts = 0, disposals = 0, logs = 0;
  t.mock.method(h.db, "writeWorkspaceLog", () => { logs++; throw diagnostic; });
  try {
    const job = await h.start(), next = createJob(h, "awaiting_input");
    const input = { requestId: `timeout-diagnostic-${phase}`, timeoutMs: 15, interruptTurn: async (target: { turnId: TurnId }) => {
      interrupts++; if (phase === "interrupt") await gate.promise;
      h.db.turns.setEnded(target.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 2 });
    }, disposeThread: async () => { disposals++; await gate.promise; if (phase === "dispose") throw disposeFailure; } };
    const pending = Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]);
    if (phase === "dispose") h.provider.resolve();
    const [first] = await pending;
    assert.equal(first.status, "rejected"); assert.ok(first.status === "rejected" && first.reason instanceof AggregateError);
    assert.equal((first.reason as AggregateError & { code: string }).code, "ASSET_DRAFT_STOP_LOG_FAILED"); assert.equal(first.reason.errors[0].code, "DESKTOP_UPDATE_ASSET_STOP_TIMEOUT"); assert.equal(first.reason.errors[1], diagnostic); assert.equal(first.reason.cause, first.reason.errors[0]);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating"); assert.equal(hasInFlightAssetDraftWork(h.db), true);
    gate.resolve(); h.provider.resolve();
    const [final, concurrent] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, { ...input, timeoutMs: 2000 }), stopAssetDraftJobsForUpdate(h.db, { ...input, timeoutMs: 2000 })]);
    assert.equal(final.status, "rejected"); assert.ok(final.status === "rejected");
    assert.ok(assetLogCauses(final.reason).includes(first.reason));
    if (phase === "dispose") assert.ok(assetLogCauses(final.reason).includes(disposeFailure));
    assert.ok(concurrent.status === "rejected" && concurrent.reason === final.reason);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === final.reason);
    assert.equal(interrupts, 1); assert.equal(disposals, phase === "dispose" ? 1 : 0); assert.equal(logs, 1);
    assert.equal(h.sends(), 1); assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "generating"); assert.equal(h.db.orchAssetGenerationJobs.get(next.id)?.status, "awaiting_input");
  } finally { gate.resolve(); h.provider.resolve(); h.cleanup(); }
});

for (const [assetKind, resume] of [["role", false], ["skill", true]] as const) test(`资产工作区公开删除后 ${assetKind} ${resume ? "resume" : "generate"} 迟到诊断失败仍由有界 stop 收齐`, async t => {
  const h = createPublicAssetLogHarness(assetKind, resume), business = new AssetDraftServiceError(503, "ENGINE_UNAVAILABLE", "deleted-business"), diagnostic = new Error("deleted-log-failed"), responses: any[] = [];
  let logs = 0, disposals = 0;
  const write = h.db.writeWorkspaceLog;
  t.mock.method(h.db, "writeWorkspaceLog", (workspace: WorkspaceId, entry: Parameters<ClientDb["writeWorkspaceLog"]>[1]) => { logs++; if ((entry.data as { event: { action: string } }).event.action === "stop_timeout") return write(workspace, entry); throw diagnostic; });
  try {
    const job = await h.start(); h.fail(business);
    for (const turn of h.db.turns.listByThread(job.threadId!)) if (turn.status === "started") h.db.turns.setEnded(turn.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 2 });
    await handleOrchAssetDraftJobsDelete({ db: h.db, workspaces: new Map([[h.workspaceId, h.db.workspaces.get(h.workspaceId)!.path]]), getActiveThreadTurn: () => null,
      sessions: { interrupt: async () => { for (const turn of h.db.turns.listByThread(job.threadId!)) if (turn.status === "started") h.db.turns.setEnded(turn.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 2 }); }, disposeThreadWithOptions: async () => { disposals++; } },
      threads: h.threads, orchEngine: { disposeManagedServicesForThread: async () => {} }, send: (response: unknown) => { responses.push(response); } } as any,
      { t: "api.req", id: "delete-then-late-log", method: "orch.assetDraftJobs.delete", body: { workspaceId: h.workspaceId, jobId: job.id } } as any);
    assert.equal(responses.at(-1)?.status, 200); assert.equal(h.db.orchAssetGenerationJobs.get(job.id), null); assert.equal(disposals, 1);
    const input = { requestId: "deleted-public-stop", timeoutMs: 15, interruptTurn: async () => { assert.fail("删除后不得中断"); }, disposeThread: async () => { assert.fail("删除后不得重复释放"); } };
    const [bounded] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]);
    assert.equal(bounded.status, "rejected"); assert.ok(bounded.status === "rejected" && bounded.reason.code === "DESKTOP_UPDATE_ASSET_STOP_TIMEOUT");
    h.provider.resolve();
    const [first, concurrent] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, { ...input, timeoutMs: 2000 }), stopAssetDraftJobsForUpdate(h.db, { ...input, timeoutMs: 2000 })]);
    assert.ok(first.status === "rejected");
    const causes = assetLogCauses(first.reason); assert.ok(causes.includes(business)); assert.ok(causes.includes(diagnostic)); assert.ok(causes.some(value => value instanceof Error && /更新停止缺少资产任务/.test(value.message)));
    assert.ok(concurrent.status === "rejected" && concurrent.reason === first.reason);
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === first.reason);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id), null); assert.equal(hasInFlightAssetDraftWork(h.db), true); assert.equal(h.sends(), resume ? 2 : 1); assert.equal(disposals, 1); assert.equal(logs, 2);
  } finally { h.provider.resolve(); h.cleanup(); }
});
