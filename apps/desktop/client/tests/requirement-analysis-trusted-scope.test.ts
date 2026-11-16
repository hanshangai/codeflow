import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NodeExecutionProfileScope, WorkspaceId } from "@codeflowai/shared";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { logger } from "../src/logger.js";
import { RequirementAnalysisService } from "../src/orchestration/requirementAnalysisService.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.js";

/** 独立真实 SQLite 和目录；仅替代外部 provider 与资产来源。 */
function fixture(t: test.TestContext, scope?: NodeExecutionProfileScope) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-ra-trusted-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  initializeLocalEngineModelCatalog();
  t.after(() => { resetEngineModelCatalogRuntimeForTest(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "client:ra-trusted" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "可信需求分析", path: directory });
  const sent: any[] = [];
  const threads = new ThreadStore();
  const workflow = { id: "wf-trusted", workspaceId, name: "可信派生", family: "feature-dev", version: 1, nodes: [], edges: [] };
  const ctx = { db, clientId: "client", threads, workspaces: new Map([[workspaceId, directory]]), intakeWorkspaceScope: scope,
    sessions: { beginThreadOperation: () => () => {}, hasActiveTurn: () => false, getOrCreate: () => assert.fail("provider 不应运行") },
    orchAssetRuntimeRead: { openWorkspace: () => ({ getAsset: (kind: string, id: string) => kind === "workflow" && id === workflow.id ? { definition: workflow } : null }) },
    send: (message: unknown) => sent.push(message) } as unknown as ApiHandlerContext;
  /** 复用生产服务，通知可注入故障以验证事务提交边界。 */
  function service(emitConversation: (event: any) => void = event => sent.push(event), requestScope = scope) {
    return new RequirementAnalysisService({ db, threads, sessions: ctx.sessions, workspaces: ctx.workspaces,
      timeoutPolicy: ctx.timeoutPolicy, orchAssetRuntimeRead: ctx.orchAssetRuntimeRead, intakeWorkspaceScope: requestScope,
      emitConversation, emitRaw: event => sent.push(event) } as any);
  }
  /** 旧线程直接写原仓储，故意绕过新线程可信初始化。 */
  function seedThread(id = "ra-thread", sharedWorkspaceId?: string) {
    return db.threads.create({ id: id as any, workspaceId, engine: "codex", title: "原始标题", threadSubtype: "requirement-analysis",
      sharedAcl: sharedWorkspaceId ? { sharedWorkspaceId: sharedWorkspaceId as any, ownerUserId: "owner" } : null });
  }
  /** 直接准备持久 RA 事实，测试操作不得用待测方法生成预期。 */
  function seedSession(workspaceScope: NodeExecutionProfileScope | null = null, id = "ra-thread") {
    return db.orchRequirementAnalysisSessions.create({ id: id as any, workspaceId, workspaceScope, title: "原始标题", status: "active", phase: "discover", engine: "codex", runtimeThreadId: id as any });
  }
  /** 准备可创建候选，范围传播与事务测试无需调用实际模型。 */
  function seedCandidates() {
    return db.orchRequirementCandidateDrafts.replaceForSession("ra-thread" as any, ["candidate-a", "candidate-b"].map((id, index) => ({
      id, sessionId: "ra-thread", creationState: "draft", title: id, goal: "验证范围传播", acceptanceCriteria: [{ text: "保留归属" }],
      splitSource: "single", complexity: "simple", uiScope: "none", architectureRisk: "low", recommendedWorkflowId: workflow.id,
      recommendedWorkflowReason: "验证", recommendedApproach: "验证", recommendedRoleIds: [], recommendedKnowledgeBundleIds: [],
      phasingAssessment: {}, sizeAssessment: {}, assetGaps: [], clarificationItems: [], assumptions: [], openQuestions: [], readyToCreate: true,
      displayOrder: index, createdAt: 1, updatedAt: 1,
    })) as any);
  }
  /** 经过真实中央 API，返回本次唯一响应。 */
  async function call(method: string, body: Record<string, unknown>) {
    sent.length = 0;
    await handleApiRequest(ctx, { t: "api.req", id: "request-ra-trusted", method, body: { workspaceId, ...body } } as any);
    const responses = sent.filter(message => message.t === "api.res");
    assert.equal(responses.length, 1);
    return responses[0];
  }
  return { db, ctx, sent, workspaceId, service, seedThread, seedSession, seedCandidates, call };
}

for (const trusted of [true, false]) {
  test(`RA 新线程首次持久写入${trusted ? "采用可信 local" : "保留未知"}并忽略 body 伪造`, async t => {
    const f = fixture(t, trusted ? { scopeType: "local_workspace", scopeId: "client:ra-trusted" } : undefined);
    const response = await f.call("threads.create", { threadId: "ra-new", engine: "codex", title: "新分析", threadSubtype: "requirement-analysis", workspaceScope: { scopeType: "shared_workspace", scopeId: "forged" } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(f.db.orchRequirementAnalysisSessions.get("ra-new" as any)?.workspaceScope, trusted ? { scopeType: "local_workspace", scopeId: f.workspaceId } : null);
  });
}

test("RA 首次归属保存失败回滚线程且不产生运行态或事件", async t => {
  const f = fixture(t, { scopeType: "local_workspace", scopeId: "client:ra-trusted" });
  f.db.db.exec("CREATE TRIGGER fail_ra_insert BEFORE INSERT ON orch_requirement_analysis_sessions BEGIN SELECT RAISE(ABORT, 'RA_INSERT_FAILURE'); END");
  const response = await f.call("threads.create", { threadId: "ra-new", engine: "codex", title: "新分析", threadSubtype: "requirement-analysis" });
  assert.equal(response.status, 500);
  assert.equal(f.db.threads.get("ra-new" as any), null);
  assert.equal(f.ctx.threads.get("ra-new" as any), null);
  assert.equal(f.sent.some(message => message.t === "conversation.event"), false);
});

for (const operation of ["create", "get", "archive", "send"]) {
  test(`RA 旧线程 ${operation} 懒建不按当前可信 context 补归属`, async t => {
    const f = fixture(t, { scopeType: "local_workspace", scopeId: "client:ra-trusted" });
    f.seedThread();
    const service = f.service();
    if (operation === "create") service.createSession({ workspaceId: f.workspaceId, threadId: "ra-thread" as any });
    if (operation === "get") service.getSession(f.workspaceId, "ra-thread" as any);
    if (operation === "archive") service.updateSessionStatus(f.workspaceId, "ra-thread" as any, "archived");
    if (operation === "send") await assert.rejects(service.sendMessage({ workspaceId: f.workspaceId, sessionId: "ra-thread" as any, text: "" }), /请输入/);
    assert.equal(f.db.orchRequirementAnalysisSessions.get("ra-thread" as any)?.workspaceScope, null);
  });
}

for (const operation of ["create", "archive", "send"]) {
  test(`RA 已知冲突在 ${operation} 标题归档事件和 provider 副作用前失败`, async t => {
    const f = fixture(t, { scopeType: "local_workspace", scopeId: "client:ra-trusted" });
    f.seedThread("ra-thread", "shared-real");
    f.seedSession({ scopeType: "shared_workspace", scopeId: "shared-real" });
    const before = f.db.threads.get("ra-thread" as any);
    const service = f.service();
    const fail = (error: any) => error.code === "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT";
    if (operation === "create") assert.throws(() => service.createSession({ workspaceId: f.workspaceId, threadId: "ra-thread" as any, title: "不可修改" }), fail);
    if (operation === "archive") assert.throws(() => service.updateSessionStatus(f.workspaceId, "ra-thread" as any, "archived"), fail);
    if (operation === "send") await assert.rejects(service.sendMessage({ workspaceId: f.workspaceId, sessionId: "ra-thread" as any, text: "不可执行" }), fail);
    assert.deepEqual(f.db.threads.get("ra-thread" as any), before);
    assert.equal(f.sent.length, 0);
  });
}

test("RA API scope 冲突返回403且只记录一次安全实体诊断", async t => {
  const f = fixture(t, { scopeType: "local_workspace", scopeId: "client:ra-trusted" });
  f.seedThread();
  f.seedSession({ scopeType: "shared_workspace", scopeId: "shared-real" });
  const logs: any[] = [];
  const error = logger.error, warn = logger.warn;
  logger.error = (...args: any[]) => { logs.push(args); };
  logger.warn = (...args: any[]) => { logs.push(args); };
  try {
    const response = await f.call("orch.requirementAnalysis.sessions.create", { threadId: "ra-thread", title: "PRIVATE_BODY" });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "FORBIDDEN");
    assert.equal(logs.length, 1);
    assert.equal(logs[0][2].requestId, "request-ra-trusted");
    assert.equal(logs[0][2].sessionId, "ra-thread");
    assert.doesNotMatch(JSON.stringify({ logs, response }), /PRIVATE_BODY/);
  } finally { logger.error = error; logger.warn = warn; }
});

test("RA 异区发送在补内存前403失败并只记录真实持久实体", async t => {
  const f = fixture(t, { scopeType: "local_workspace", scopeId: "client:ra-trusted" });
  f.seedThread(); f.seedSession({ scopeType: "local_workspace", scopeId: f.workspaceId });
  const foreignWorkspaceId = "client:ra-foreign" as WorkspaceId;
  f.db.workspaces.upsert({ id: foreignWorkspaceId, title: "异区分析", path: f.ctx.workspaces.get(f.workspaceId)! });
  f.ctx.workspaces.set(foreignWorkspaceId, f.ctx.workspaces.get(f.workspaceId)!);
  f.db.threads.create({ id: "foreign-ra" as any, workspaceId: foreignWorkspaceId, engine: "codex", title: "异区分析", threadSubtype: "requirement-analysis" });
  f.db.orchRequirementAnalysisSessions.create({ id: "foreign-ra" as any, workspaceId: foreignWorkspaceId, title: "异区分析", status: "active", phase: "discover", engine: "codex", runtimeThreadId: "foreign-ra" as any,
    workspaceScope: { scopeType: "local_workspace", scopeId: foreignWorkspaceId } });
  const before = f.db.threads.get("foreign-ra" as any);
  const logs: any[] = []; const error = logger.error, warn = logger.warn;
  logger.error = (...args: any[]) => { logs.push(args); };
  logger.warn = (...args: any[]) => { logs.push(args); };
  try {
    assert.equal(f.ctx.threads.get("foreign-ra" as any), null);
    const response = await f.call("threads.sendMessage", { threadId: "foreign-ra", text: "PRIVATE_FOREIGN_BODY", sessionId: "PRIVATE_FORGED_SESSION", intakeId: "PRIVATE_FORGED_INTAKE", instanceId: "PRIVATE_FORGED_INSTANCE" });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "FORBIDDEN");
    assert.equal(f.ctx.threads.get("foreign-ra" as any), null);
    assert.deepEqual(f.db.threads.get("foreign-ra" as any), before);
    assert.equal(f.sent.some(message => message.t === "conversation.event"), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][2].requestId, "request-ra-trusted");
    assert.equal(logs[0][2].errorCode, "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT");
    assert.equal(logs[0][2].sessionId, "foreign-ra");
    assert.equal(logs[0][2].workspaceId, foreignWorkspaceId);
    assert.doesNotMatch(JSON.stringify({ logs, response }), /PRIVATE_FOREIGN_BODY|PRIVATE_FORGED_/);
  } finally { logger.error = error; logger.warn = warn; }
});

for (const workspaceScope of [null, { scopeType: "local_workspace", scopeId: "client:ra-trusted" }, { scopeType: "shared_workspace", scopeId: "shared-real" }] as const) {
  test(`RA 候选派生只继承持久 ${workspaceScope?.scopeType ?? "unknown"} 归属到 intake 和 proposal snapshot`, t => {
    const f = fixture(t);
    f.seedThread(); f.seedSession(workspaceScope); f.seedCandidates();
    const result = f.service().createIntakes({ workspaceId: f.workspaceId, sessionId: "ra-thread" as any, candidateIds: ["candidate-a", "candidate-b"] as any });
    assert.equal(result.created.length, 2);
    for (const item of result.created) {
      assert.deepEqual(item.intake.workspaceScope, workspaceScope);
      assert.deepEqual(item.proposal.intakeSnapshot?.workspaceScope, workspaceScope);
    }
  });
}

test("RA 候选请求包含不存在ID时整组失败且不生成子集", t => {
  const f = fixture(t); f.seedThread(); f.seedSession(); f.seedCandidates();
  assert.throws(() => f.service().createIntakes({ workspaceId: f.workspaceId, sessionId: "ra-thread" as any, candidateIds: ["candidate-a", "missing"] as any }));
  assert.equal(f.db.orchIntakes.listByWorkspace(f.workspaceId).length, 0);
  assert.equal(f.sent.length, 0);
});

for (const boundary of ["proposal", "candidate", "session"]) {
  test(`RA 候选派生 ${boundary} 失败回滚整组事实和状态且不通知`, t => {
    const f = fixture(t); f.seedThread(); const session = f.seedSession(); const candidates = f.seedCandidates();
    const trigger = boundary === "proposal"
      ? "CREATE TRIGGER fail_derive BEFORE INSERT ON orch_proposals WHEN (SELECT COUNT(*) FROM orch_proposals) = 1 BEGIN SELECT RAISE(ABORT, 'RA_DERIVE_FAILURE'); END"
      : boundary === "candidate"
        ? "CREATE TRIGGER fail_derive BEFORE DELETE ON orch_requirement_candidate_drafts BEGIN SELECT RAISE(ABORT, 'RA_DERIVE_FAILURE'); END"
        : "CREATE TRIGGER fail_derive BEFORE UPDATE ON orch_requirement_analysis_sessions WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'RA_DERIVE_FAILURE'); END";
    f.db.db.exec(trigger);
    assert.throws(() => f.service().createIntakes({ workspaceId: f.workspaceId, sessionId: session.id, candidateIds: candidates.map(item => item.id) }), (error: any) => error.code === "ORCH_REQUIREMENT_ANALYSIS_CREATE_FAILED");
    assert.equal(f.db.orchIntakes.listByWorkspace(f.workspaceId).length, 0);
    assert.equal(f.db.orchProposals.listByWorkspace(f.workspaceId).length, 0);
    assert.deepEqual(f.db.orchRequirementCandidateDrafts.listBySession(session.id), candidates);
    assert.equal(f.db.orchRequirementAnalysisSessions.get(session.id)?.status, "active");
    assert.equal(f.sent.length, 0);
  });
}

test("RA 提交后通知失败显式报错保留已提交状态且重试不重复派生", t => {
  const f = fixture(t); f.seedThread(); const session = f.seedSession(); const candidates = f.seedCandidates();
  const service = f.service(() => { throw new Error("PRIVATE_NOTICE_BODY"); });
  const input = { workspaceId: f.workspaceId, sessionId: session.id, candidateIds: candidates.map(item => item.id) };
  assert.throws(() => service.createIntakes(input), (error: any) => {
    assert.equal(error.code, "ORCH_REQUIREMENT_ANALYSIS_NOTICE_FAILED");
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)} ${error.cause?.message}`, /PRIVATE_NOTICE_BODY/);
    return true;
  });
  assert.equal(f.db.orchIntakes.listByWorkspace(f.workspaceId).length, 2);
  assert.equal(f.db.orchProposals.listByWorkspace(f.workspaceId).length, 2);
  assert.equal(f.db.orchRequirementAnalysisSessions.get(session.id)?.phase, "done");
  assert.ok(f.db.orchRequirementCandidateDrafts.listBySession(session.id).every(item => item.creationState === "created"));
  assert.throws(() => service.createIntakes(input));
  assert.equal(f.db.orchIntakes.listByWorkspace(f.workspaceId).length, 2);
});

for (const method of ["threads.rename", "threads.archive", "threads.sendMessage", "orch.requirementAnalysis.messages.send", "orch.requirementAnalysis.createIntakes"]) {
  test(`RA ${method} 已知冲突不修改线程或派发事件并返回403`, async t => {
    const f = fixture(t, { scopeType: "local_workspace", scopeId: "client:ra-trusted" });
    f.seedThread("ra-thread", "shared-real"); f.seedSession({ scopeType: "shared_workspace", scopeId: "shared-real" });
    const before = f.db.threads.get("ra-thread" as any);
    const response = await f.call(method, { threadId: "ra-thread", sessionId: "ra-thread", text: "PRIVATE_BODY", title: "PRIVATE_BODY", archived: true, candidateIds: ["candidate-a"] });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.deepEqual(f.db.threads.get("ra-thread" as any), before);
    assert.equal(f.sent.filter(message => message.t === "conversation.event").length, 0);
    if (method === "threads.sendMessage") assert.equal(f.ctx.threads.get("ra-thread" as any), null);
  });
}

test("RA 通知失败经中央只记录一次安全失败并保留已提交事实", async t => {
  const f = fixture(t); f.seedThread(); f.seedSession(); f.seedCandidates();
  f.ctx.onBeforeEmitConversationEvent = () => { throw new Error("PRIVATE_NOTICE_BODY"); };
  const logs: any[] = []; const error = logger.error;
  logger.error = (...args: any[]) => { logs.push(args); };
  try {
    const response = await f.call("orch.requirementAnalysis.createIntakes", { sessionId: "ra-thread", candidateIds: ["candidate-a", "candidate-b"], intakeId: "PRIVATE_BODY", instanceId: "PRIVATE_BODY" });
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "INTERNAL_ERROR");
    assert.equal(logs.length, 1);
    assert.equal(logs[0][2].errorCode, "ORCH_REQUIREMENT_ANALYSIS_NOTICE_FAILED");
    assert.equal(logs[0][2].sessionId, "ra-thread");
    assert.equal(logs[0][2].requestId, "request-ra-trusted");
    assert.match(JSON.stringify(logs[0][2].rootCause), /delivery_failed_after_commit/);
    assert.doesNotMatch(JSON.stringify({ logs, response }), /PRIVATE_BODY|PRIVATE_NOTICE_BODY/);
    assert.equal(f.db.orchIntakes.listByWorkspace(f.workspaceId).length, 2);
    assert.equal(f.db.orchRequirementAnalysisSessions.get("ra-thread" as any)?.phase, "done");
  } finally { logger.error = error; }
});

test("RA 通知投递被拒绝经中央显式失败且重试不重复已提交派生", async t => {
  const f = fixture(t); f.seedThread(); f.seedSession(); f.seedCandidates();
  f.ctx.send = message => {
    f.sent.push(message);
    return message.t === "conversation.event" ? { accepted: false, reason: "PRIVATE_NOTICE_BODY" } as any : undefined;
  };
  const logs: any[] = []; const error = logger.error;
  logger.error = (...args: any[]) => { logs.push(args); };
  try {
    const input = { sessionId: "ra-thread", candidateIds: ["candidate-a", "candidate-b"] };
    const response = await f.call("orch.requirementAnalysis.createIntakes", input);
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "INTERNAL_ERROR");
    assert.equal(logs.length, 1);
    assert.equal(logs[0][2].errorCode, "ORCH_REQUIREMENT_ANALYSIS_NOTICE_FAILED");
    assert.equal(logs[0][2].requestId, "request-ra-trusted");
    assert.equal(logs[0][2].sessionId, "ra-thread");
    assert.match(JSON.stringify(logs[0][2].rootCause), /delivery_failed_after_commit/);
    assert.doesNotMatch(JSON.stringify({ logs, response }), /PRIVATE_NOTICE_BODY/);
    assert.equal(f.db.orchIntakes.listByWorkspace(f.workspaceId).length, 2);
    assert.equal(f.db.orchProposals.listByWorkspace(f.workspaceId).length, 2);
    assert.equal(f.db.orchRequirementAnalysisSessions.get("ra-thread" as any)?.phase, "done");
    assert.ok(f.db.orchRequirementCandidateDrafts.listBySession("ra-thread" as any).every(item => item.creationState === "created"));
    const retried = await f.call("orch.requirementAnalysis.createIntakes", input);
    assert.equal(retried.status, 400);
    assert.equal(f.db.orchIntakes.listByWorkspace(f.workspaceId).length, 2);
    assert.equal(f.db.orchProposals.listByWorkspace(f.workspaceId).length, 2);
    assert.equal(logs.length, 1);
    assert.equal(f.sent.some(message => message.t === "conversation.event"), false);
  } finally { logger.error = error; }
});

test("RA 队列采用 resolver 可信context并在范围冲突时失败暂停且保留关联日志", async t => {
  const f = fixture(t); f.seedThread(); f.seedSession({ scopeType: "local_workspace", scopeId: f.workspaceId });
  const { item } = f.db.threadMessageQueue.appendItem({ workspaceId: f.workspaceId, threadId: "ra-thread" as any, text: "PRIVATE_QUEUE_BODY", images: [], files: [], originWebSessionId: null,
    sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null } });
  const context = { ...f.ctx, intakeWorkspaceScope: { scopeType: "shared_workspace", scopeId: "shared-real" } } as ApiHandlerContext;
  const dispatcher = new ThreadQueueDispatcher(f.ctx, () => context);
  const logs: any[] = []; const error = logger.error;
  logger.error = (...args: any[]) => { logs.push(args); };
  try {
    dispatcher.kickIfIdle("ra-thread" as any);
    for (let attempts = 0; attempts < 20 && f.db.threadMessageQueue.getById(item.id)?.status !== "failed"; attempts++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.db.threadMessageQueue.getById(item.id)?.failureCode, "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT");
    assert.equal(f.db.threadQueueStates.getState("ra-thread" as any).paused, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][2].requestId, item.id);
    assert.equal(logs[0][2].queueItemId, item.id);
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_QUEUE_BODY/);
    assert.equal(f.sent.some(message => message.t === "conversation.event"), false);
  } finally { logger.error = error; }
});
