import test from "node:test";
import assert from "node:assert/strict";

import { createPinia, setActivePinia } from "pinia";
import type {
  RequirementAnalysisSession,
  RequirementAnalysisSessionId,
  RequirementCandidateDraft,
  RequirementCandidateId,
  ThreadId,
  WorkflowId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../src/api/request.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useRequirementAnalysisStore } from "../src/store/requirementAnalysis.ts";

const originalFetch = globalThis.fetch;

function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-demo",
    webSessionId: "web-demo",
    ensureSession: async () => "session-demo",
    clearSession() {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function buildSessionSummary(id: string, workspaceId: WorkspaceId, title: string, runtimeThreadId: string): RequirementAnalysisSession {
  return {
    id: id as RequirementAnalysisSessionId,
    workspaceId,
    title,
    status: "active",
    phase: "discover",
    engine: "codex",
    model: null,
    effort: null,
    runtimeThreadId: runtimeThreadId as ThreadId,
    engineSessionId: null,
    latestTurnSummary: title,
    latestAssistantReply: null,
    candidateCount: 0,
    readyCandidateCount: 0,
    createdCandidateCount: 0,
    pendingCandidateCount: 0,
    lastMessageAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("refreshSessions 只刷新列表且不自动打开第一条会话", async () => {
  setActivePinia(createPinia());
  const ctx = createApiContext();
  const chat = useChatStore();
  const analysis = useRequirementAnalysisStore();
  const workspaceId = "client-a:ws-demo" as WorkspaceId;
  const sessionId = "session-summary" as RequirementAnalysisSessionId;
  let embeddedActivationCount = 0;
  const requestPaths: string[] = [];

  (chat as any).activateEmbeddedThread = async () => {
    embeddedActivationCount += 1;
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requestPaths.push(url.pathname);
    if (url.pathname !== "/api/orch/requirement-analysis/sessions") {
      throw new Error(`unexpected request: ${url.pathname}`);
    }
    return jsonResponse({
      ok: true,
      sessions: [{
        id: sessionId,
        workspaceId,
        title: "只加载摘要",
        status: "active",
        phase: "discover",
        engine: "codex",
        model: null,
        effort: null,
        runtimeThreadId: "thread-summary",
        engineSessionId: null,
        latestTurnSummary: "摘要",
        latestAssistantReply: null,
        candidateCount: 0,
        readyCandidateCount: 0,
        createdCandidateCount: 0,
        pendingCandidateCount: 0,
        lastMessageAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
      hasMore: false,
      nextCursor: null,
      statusCounts: [],
      totalCount: 1,
      listMetaById: {},
    });
  }) as typeof fetch;

  await analysis.refreshSessions(ctx, workspaceId);

  assert.deepEqual(requestPaths, ["/api/orch/requirement-analysis/sessions"]);
  assert.equal(analysis.sessions[0]?.id, sessionId);
  assert.equal(analysis.selectedSessionId, null);
  assert.equal(analysis.selectedSession, null);
  assert.equal(embeddedActivationCount, 0);
});

test("refreshSessions 在摘要接口失败时显式拒绝并复位 loading", async () => {
  setActivePinia(createPinia());
  const ctx = createApiContext();
  const analysis = useRequirementAnalysisStore();

  globalThis.fetch = (async () => jsonResponse({
    ok: false,
    message: "会话摘要加载失败",
  })) as typeof fetch;

  await assert.rejects(
    analysis.refreshSessions(ctx, "client-a:ws-demo" as WorkspaceId),
    /会话摘要加载失败/u,
  );
  assert.equal(analysis.sessionsLoading, false);
});

test("deleteSession 在原始 thread 已不存在时仍能清掉本地草稿状态", async () => {
  setActivePinia(createPinia());
  const ctx = createApiContext();
  const chat = useChatStore();
  const analysis = useRequirementAnalysisStore();
  const workspaceId = "client-a:ws-demo" as any;
  const sessionId = "session-orphan" as any;
  const runtimeThreadId = "thread-missing" as any;
  let deleteCalls = 0;

  analysis.sessions = [{
    id: sessionId,
    workspaceId,
    title: "残留草稿",
    status: "active",
    phase: "discover",
    engine: "codex",
    model: null,
    effort: null,
    runtimeThreadId,
    engineSessionId: null,
    latestTurnSummary: "stale",
    latestAssistantReply: null,
    candidateCount: 0,
    readyCandidateCount: 0,
    createdCandidateCount: 0,
    pendingCandidateCount: 0,
    lastMessageAt: 1,
    createdAt: 1,
    updatedAt: 1,
  }];
  analysis.selectedSessionId = sessionId;
  analysis.selectedSession = analysis.sessions[0]!;
  analysis.messages = [{
    id: "msg-1" as any,
    sessionId,
    role: "assistant",
    content: "旧消息",
    createdAt: 1,
  }];
  analysis.candidates = [{
    id: "candidate-1" as any,
    sessionId,
    title: "旧候选",
    goal: "旧目标",
    background: null,
    acceptanceCriteria: [],
    splitSource: "single",
    complexity: "unknown",
    uiScope: "unknown",
    architectureRisk: "unknown",
    recommendedWorkflowId: null,
    recommendedWorkflowName: null,
    recommendedWorkflowReason: "",
    recommendedApproach: "",
    recommendedRoleIds: [],
    recommendedKnowledgeBundleIds: [],
    phasingAssessment: {
      model: "mmf-phase-gate-v2",
      scopeDecision: "fit",
      deliverySlice: "single-phase",
      summary: "old",
      reasoning: "old",
      signals: {
        benefitHypothesisCount: 1,
        acceptanceLoopCount: 1,
        actorSurfaceCount: 1,
        externalSystemCount: 0,
        newCoreModelCount: 0,
      },
      outOfScope: [],
    },
    sizeAssessment: {
      model: "functional-size-v2",
      size: "small",
      score: 11,
      summary: "old",
      reasoning: "old",
      signals: {
        functionalProcessCount: 1,
        domainEntityCount: 1,
        stateTransitionCount: 1,
        interactionSurfaceCount: 1,
        externalIntegrationCount: 0,
        asyncConsistencyRiskCount: 0,
        clientSurfaceCount: 1,
      },
    },
    assetGaps: [],
    clarificationItems: [],
    assumptions: [],
    openQuestions: [],
    readyToCreate: false,
    creationState: "draft",
    createdIntakeId: null,
    createdProposalId: null,
    createdAt: 1,
    updatedAt: 1,
  }];

  (chat as any).deleteThread = async (_ctx: ApiRequestContext, body: { threadId: string }) => {
    deleteCalls += 1;
    assert.equal(body.threadId, runtimeThreadId);
    throw new Error("thread 不存在");
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/requirement-analysis/sessions") {
      return jsonResponse({
        ok: true,
        sessions: [],
        hasMore: false,
        nextCursor: null,
      });
    }
    if (url.pathname === "/api/orch/requirement-analysis/sessions/get") {
      return jsonResponse({
        ok: false,
        message: `需求分析会话不存在：${String(sessionId)}`,
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await analysis.deleteSession(ctx, workspaceId, sessionId);

  assert.equal(deleteCalls, 1);
  assert.deepEqual(analysis.sessions, []);
  assert.equal(analysis.selectedSessionId, null);
  assert.equal(analysis.selectedSession, null);
  assert.deepEqual(analysis.messages, []);
  assert.deepEqual(analysis.candidates, []);
});

test("createIntakes 创建正式需求后同步草稿列表状态缓存", async () => {
  setActivePinia(createPinia());
  const ctx = createApiContext();
  const chat = useChatStore();
  const analysis = useRequirementAnalysisStore();
  const workspaceId = "client-a:ws-demo" as WorkspaceId;
  const sessionId = "session-ready" as RequirementAnalysisSessionId;
  const runtimeThreadId = "thread-ready" as ThreadId;
  const candidateId = "candidate-ready" as RequirementCandidateId;
  const workflowId = "wf-standard" as WorkflowId;

  const session: RequirementAnalysisSession = {
    id: sessionId,
    workspaceId,
    title: "首页登录优化",
    status: "active" as const,
    phase: "confirm" as const,
    engine: "codex" as const,
    model: null,
    effort: null,
    runtimeThreadId,
    engineSessionId: null,
    latestTurnSummary: "已有可创建候选",
    latestAssistantReply: null,
    candidateCount: 1,
    readyCandidateCount: 1,
    createdCandidateCount: 0,
    pendingCandidateCount: 0,
    lastMessageAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const candidate: RequirementCandidateDraft = {
    id: candidateId,
    sessionId,
    title: "登录页基础验证码",
    goal: "增加基础验证码",
    background: null,
    acceptanceCriteria: [],
    splitSource: "single" as const,
    complexity: "small" as const,
    uiScope: "unknown" as const,
    architectureRisk: "unknown" as const,
    recommendedWorkflowId: workflowId,
    recommendedWorkflowName: "CodeFlow 标准功能开发",
    recommendedWorkflowReason: "匹配标准功能开发流程",
    recommendedApproach: "直接创建正式需求并生成方案",
    recommendedRoleIds: [],
    recommendedKnowledgeBundleIds: [],
    phasingAssessment: {
      model: "mmf-phase-gate-v2" as const,
      scopeDecision: "fit" as const,
      deliverySlice: "single-phase" as const,
      summary: "fit",
      reasoning: "fit",
      signals: {
        benefitHypothesisCount: 1,
        acceptanceLoopCount: 1,
        actorSurfaceCount: 1,
        externalSystemCount: 0,
        newCoreModelCount: 0,
      },
      outOfScope: [],
    },
    sizeAssessment: {
      model: "functional-size-v2" as const,
      size: "small" as const,
      score: 21,
      summary: "small",
      reasoning: "small",
      signals: {
        functionalProcessCount: 1,
        domainEntityCount: 1,
        stateTransitionCount: 1,
        interactionSurfaceCount: 1,
        externalIntegrationCount: 0,
        asyncConsistencyRiskCount: 0,
        clientSurfaceCount: 1,
      },
    },
    assetGaps: [],
    clarificationItems: [],
    assumptions: [],
    openQuestions: [],
    readyToCreate: true,
    creationState: "draft" as const,
    createdIntakeId: null,
    createdProposalId: null,
    createdAt: 1,
    updatedAt: 1,
  };

  analysis.sessions = [session];
  analysis.sessionStatusCounts = [{ status: "ready-to-create", label: "待创建", count: 1 }];
  analysis.sessionListMetaById = {
    [sessionId]: {
      listStatus: "ready-to-create",
      listStatusLabel: "待创建",
      recommendedWorkflowName: "CodeFlow 标准功能开发",
    },
  };
  analysis.selectedSessionId = sessionId;
  analysis.selectedSession = session;
  analysis.candidates = [candidate];

  (chat as any).activateEmbeddedThread = async () => {};

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/requirement-analysis/create-intakes") {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        workspaceId,
        sessionId,
        candidateIds: [candidateId],
        workflowSelections: [{ candidateId, workflowId }],
      });
      return jsonResponse({
        ok: true,
        created: [{
          intake: { id: "intake-1", title: "登录页基础验证码" },
          proposal: { id: "proposal-1" },
        }],
      });
    }
    if (url.pathname === "/api/orch/requirement-analysis/sessions/get") {
      return jsonResponse({
        ok: true,
        session: {
          ...session,
          phase: "done",
          readyCandidateCount: 0,
          createdCandidateCount: 1,
          pendingCandidateCount: 0,
          updatedAt: 2,
        },
        messages: [],
        candidates: [{
          ...candidate,
          readyToCreate: false,
          creationState: "created",
          createdIntakeId: "intake-1",
          createdProposalId: "proposal-1",
          updatedAt: 2,
        }],
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await analysis.createIntakes(ctx, workspaceId, [candidateId], [{ candidateId, workflowId }]);

  assert.equal(analysis.sessions[0]?.readyCandidateCount, 0);
  assert.equal(analysis.sessions[0]?.createdCandidateCount, 1);
  assert.equal(analysis.sessionListMetaById[sessionId]?.listStatus, "created");
  assert.equal(analysis.sessionListMetaById[sessionId]?.listStatusLabel, "已创建");
  assert.deepEqual(analysis.sessionStatusCounts, [{ status: "created", label: "已创建", count: 1 }]);
});

test("resetForWorkspace clears requirement session metadata, counts, selection details, and loading flags", () => {
  setActivePinia(createPinia());
  const analysis = useRequirementAnalysisStore();
  const workspaceId = "client-a:analysis-reset" as WorkspaceId;
  const session = buildSessionSummary("session-reset", workspaceId, "待清理", "thread-reset");

  analysis.sessions = [session];
  analysis.sessionsLoading = true;
  analysis.sessionsLoadingMore = true;
  analysis.sessionsHasMore = true;
  analysis.sessionsNextCursor = "session-cursor";
  analysis.sessionStatusCounts = [{ status: "clarifying", label: "待澄清", count: 1 }];
  analysis.sessionTotalCount = 11;
  analysis.sessionListMetaById = { [session.id]: { listStatus: "clarifying", listStatusLabel: "待澄清" } };
  analysis.sessionLoading = true;
  analysis.sending = true;
  analysis.creatingIntakes = true;
  analysis.selectedSessionId = session.id;
  analysis.selectedSession = session;
  analysis.messages = [{ id: "message-reset", sessionId: session.id, role: "assistant", content: "old", createdAt: 1 } as any];
  analysis.candidates = [{ id: "candidate-reset" } as any];

  analysis.resetForWorkspace(workspaceId);

  assert.equal(analysis.workspaceScopeId, workspaceId);
  assert.deepEqual(analysis.sessions, []);
  assert.equal(analysis.sessionsLoading, false);
  assert.equal(analysis.sessionsLoadingMore, false);
  assert.equal(analysis.sessionsHasMore, false);
  assert.equal(analysis.sessionsNextCursor, null);
  assert.deepEqual(analysis.sessionStatusCounts, []);
  assert.equal(analysis.sessionTotalCount, 0);
  assert.deepEqual(analysis.sessionListMetaById, {});
  assert.equal(analysis.sessionLoading, false);
  assert.equal(analysis.sending, false);
  assert.equal(analysis.creatingIntakes, false);
  assert.equal(analysis.selectedSessionId, null);
  assert.equal(analysis.selectedSession, null);
  assert.deepEqual(analysis.messages, []);
  assert.deepEqual(analysis.candidates, []);
});

test("refreshSessions ignores an old workspace response without closing the new workspace loading state", async () => {
  setActivePinia(createPinia());
  const ctx = createApiContext();
  const chat = useChatStore();
  const analysis = useRequirementAnalysisStore();
  const workspaceA = "client-a:analysis-a" as WorkspaceId;
  const workspaceB = "client-a:analysis-b" as WorkspaceId;
  const responseA = deferred<Response>();
  const responseB = deferred<Response>();
  const syncedThreadIds: string[] = [];

  (chat as any).upsertThreadSummary = (summary: { id: string }) => syncedThreadIds.push(String(summary.id));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/requirement-analysis/sessions") throw new Error(`unexpected request: ${url.pathname}`);
    return url.searchParams.get("workspaceId") === workspaceA ? responseA.promise : responseB.promise;
  }) as typeof fetch;

  analysis.resetForWorkspace(workspaceA);
  const requestA = analysis.refreshSessions(ctx, workspaceA);
  await Promise.resolve();
  await Promise.resolve();
  analysis.resetForWorkspace(workspaceB);
  const requestB = analysis.refreshSessions(ctx, workspaceB);
  await Promise.resolve();
  await Promise.resolve();

  responseA.resolve(jsonResponse({
    ok: true,
    sessions: [buildSessionSummary("session-a", workspaceA, "旧工作区", "thread-a")],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  }));
  await requestA;
  assert.equal(analysis.sessionsLoading, true);
  assert.equal(analysis.sessions.length, 0);
  assert.deepEqual(syncedThreadIds, []);

  responseB.resolve(jsonResponse({
    ok: true,
    sessions: [buildSessionSummary("session-b", workspaceB, "新工作区", "thread-b")],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  }));
  await requestB;
  assert.equal(analysis.sessionsLoading, false);
  assert.deepEqual(analysis.sessions.map((session) => session.id), ["session-b"]);
  assert.deepEqual(syncedThreadIds, ["thread-b"]);
});

test("refreshSessions keeps only the latest same-workspace filter response and chat projection", async () => {
  setActivePinia(createPinia());
  const ctx = createApiContext();
  const chat = useChatStore();
  const analysis = useRequirementAnalysisStore();
  const workspaceId = "client-a:analysis-filter" as WorkspaceId;
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const syncedThreadIds: string[] = [];

  (chat as any).upsertThreadSummary = (summary: { id: string }) => syncedThreadIds.push(String(summary.id));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/requirement-analysis/sessions") throw new Error(`unexpected request: ${url.pathname}`);
    return url.searchParams.get("search") === "older" ? older.promise : newer.promise;
  }) as typeof fetch;

  analysis.resetForWorkspace(workspaceId);
  const olderRequest = analysis.refreshSessions(ctx, workspaceId, { search: "older" });
  await Promise.resolve();
  const newerRequest = analysis.refreshSessions(ctx, workspaceId, { search: "newer" });
  await Promise.resolve();
  older.resolve(jsonResponse({
    ok: true,
    sessions: [buildSessionSummary("session-older", workspaceId, "旧筛选", "thread-older")],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  }));
  await olderRequest;
  assert.equal(analysis.sessions.length, 0);
  assert.deepEqual(syncedThreadIds, []);
  assert.equal(analysis.sessionsLoading, true);

  newer.resolve(jsonResponse({
    ok: true,
    sessions: [buildSessionSummary("session-newer", workspaceId, "新筛选", "thread-newer")],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  }));
  await newerRequest;

  assert.deepEqual(analysis.sessions.map((session) => session.id), ["session-newer"]);
  assert.deepEqual(syncedThreadIds, ["thread-newer"]);
  assert.equal(analysis.sessionsLoading, false);
});

test("loadSession ignores an old workspace detail response and never activates its embedded thread", async () => {
  setActivePinia(createPinia());
  const ctx = createApiContext();
  const chat = useChatStore();
  const analysis = useRequirementAnalysisStore();
  const workspaceA = "client-a:detail-a" as WorkspaceId;
  const workspaceB = "client-a:detail-b" as WorkspaceId;
  const oldDetail = deferred<Response>();
  const newDetail = deferred<Response>();
  const activatedThreadIds: string[] = [];
  const syncedThreadIds: string[] = [];

  (chat as any).upsertThreadSummary = (summary: { id: string }) => syncedThreadIds.push(String(summary.id));
  (chat as any).activateEmbeddedThread = async (_ctx: ApiRequestContext, input: { threadId: string }) => {
    activatedThreadIds.push(String(input.threadId));
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/requirement-analysis/sessions/get") throw new Error(`unexpected request: ${url.pathname}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { workspaceId?: string };
    return body.workspaceId === workspaceA ? oldDetail.promise : newDetail.promise;
  }) as typeof fetch;

  analysis.resetForWorkspace(workspaceA);
  const requestA = analysis.loadSession(ctx, workspaceA, "session-a" as RequirementAnalysisSessionId);
  await Promise.resolve();
  await Promise.resolve();
  analysis.resetForWorkspace(workspaceB);
  const requestB = analysis.loadSession(ctx, workspaceB, "session-b" as RequirementAnalysisSessionId);
  await Promise.resolve();
  await Promise.resolve();

  oldDetail.resolve(jsonResponse({
    ok: true,
    session: buildSessionSummary("session-a", workspaceA, "旧详情", "thread-a"),
    messages: [{ id: "message-a", content: "old" }],
    candidates: [],
  }));
  await requestA;
  assert.equal(analysis.sessionLoading, true);
  assert.equal<RequirementAnalysisSession | null>(analysis.selectedSession, null);
  assert.deepEqual(syncedThreadIds, []);
  assert.deepEqual(activatedThreadIds, []);

  newDetail.resolve(jsonResponse({
    ok: true,
    session: buildSessionSummary("session-b", workspaceB, "新详情", "thread-b"),
    messages: [],
    candidates: [],
  }));
  await requestB;
  assert.equal(analysis.sessionLoading, false);
  assert.equal(analysis.selectedSessionId, "session-b");
  assert.equal(analysis.selectedSession?.title, "新详情");
  assert.deepEqual(syncedThreadIds, ["thread-b"]);
  assert.deepEqual(activatedThreadIds, ["thread-b"]);
});

test("loadSession ignores detail for a session removed by a newer same-workspace filter", async () => {
  setActivePinia(createPinia());
  const ctx = createApiContext();
  const chat = useChatStore();
  const analysis = useRequirementAnalysisStore();
  const workspaceId = "client-a:detail-filter" as WorkspaceId;
  const session = buildSessionSummary("session-filtered-out", workspaceId, "将被筛掉", "thread-filtered-out");
  const detailResponse = deferred<Response>();
  const syncedThreadIds: string[] = [];
  const activatedThreadIds: string[] = [];

  analysis.resetForWorkspace(workspaceId);
  analysis.sessions = [session];
  analysis.selectedSessionId = session.id;
  (chat as any).upsertThreadSummary = (summary: { id: string }) => syncedThreadIds.push(String(summary.id));
  (chat as any).activateEmbeddedThread = async (_ctx: ApiRequestContext, input: { threadId: string }) => {
    activatedThreadIds.push(String(input.threadId));
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/requirement-analysis/sessions/get") return detailResponse.promise;
    if (url.pathname === "/api/orch/requirement-analysis/sessions") {
      return jsonResponse({
        ok: true,
        sessions: [],
        hasMore: false,
        nextCursor: null,
        statusCounts: [],
        totalCount: 0,
        listMetaById: {},
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const detailRequest = analysis.loadSession(ctx, workspaceId, session.id);
  await Promise.resolve();
  await Promise.resolve();
  await analysis.refreshSessions(ctx, workspaceId, { search: "does-not-match" });
  assert.equal(analysis.selectedSessionId, null);
  detailResponse.resolve(jsonResponse({ ok: true, session, messages: [], candidates: [] }));
  await detailRequest;

  assert.equal(analysis.selectedSessionId, null);
  assert.equal(analysis.selectedSession, null);
  assert.deepEqual(syncedThreadIds, []);
  assert.deepEqual(activatedThreadIds, []);
  assert.equal(analysis.sessionLoading, false);
});
