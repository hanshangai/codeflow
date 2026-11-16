import test from "node:test";
import { createUnusedExperimentExecutor } from "../support/controlled-experiment-fixture.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type ClientToServerMessage,
  type RequirementCandidateId,
  type WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { handleApiRequest, type ApiHandlerContext } from "../../apps/desktop/client/src/app/handleApiRequest.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { ThreadQueueDispatcher } from "../../apps/desktop/client/src/queue/threadQueueDispatcher.ts";
import { waitForOrdinaryTurnExecution } from "../../apps/desktop/client/src/app/ordinaryTurnExecution.ts";
import { flushClientLogger, logger } from "../../apps/desktop/client/src/logger.ts";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";

test.beforeEach(() => initializeLocalEngineModelCatalog());
test.afterEach(() => resetEngineModelCatalogRuntimeForTest());

function buildPhasingAssessment(summary: string) {
  return {
    model: "mmf-phase-gate-v2",
    scopeDecision: "fit",
    deliverySlice: "single-phase",
    summary,
    reasoning: "先判断是否只承诺一个独立验收闭环。",
    signals: {
      benefitHypothesisCount: 1,
      acceptanceLoopCount: 1,
      actorSurfaceCount: 1,
      externalSystemCount: 0,
      newCoreModelCount: 0,
    },
    outOfScope: [],
  };
}

function buildSizeAssessment(summary: string) {
  return {
    model: "functional-size-v2",
    summary,
    reasoning: "按功能过程、领域对象、状态流转、交互界面、外部集成、异步一致性风险和交付端面综合估算。",
    signals: {
      functionalProcessCount: 3,
      domainEntityCount: 2,
      stateTransitionCount: 1,
      interactionSurfaceCount: 3,
      externalIntegrationCount: 0,
      asyncConsistencyRiskCount: 0,
      clientSurfaceCount: 2,
    },
  };
}

/** 构造可通过平台校验的最小需求分析结构化结果。 */
function buildReadyRequirementAnalysisPayload(assistantReply = "首页需求已经可以创建。") {
  return {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "首页需求已具备创建条件",
    assistantReply,
    needUserInput: false,
    questions: [],
    candidates: [
      {
        candidateId: "home",
        title: "鲜花市场首页",
        goal: "实现鲜花市场首页，支持 PC 和移动端",
        background: "作为市场首页展示入口",
        acceptanceCriteria: [{ text: "支持 PC 和移动端适配" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "标准页面功能开发。",
        recommendedApproach: "建议先按静态首页单页收口，确认核心模块后再进入正式创建。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("首页候选本身就是一个可独立验收的单阶段页面闭环。"),
        sizeAssessment: buildSizeAssessment("首页属于中型页面需求，需要兼顾双端适配和多个内容区块。"),
        assetGaps: [],
        clarificationItems: [],
        assumptions: ["先按静态页面交付"],
        openQuestions: [],
        readyToCreate: true,
      },
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["home"],
      note: "可以创建需求并生成方案。",
    },
  };
}

/** 构造 API handler 测试上下文，并暴露必要的运行观测。 */
function createApiHarness(
  responsePayload: unknown,
  opts?: {
    hasActiveTurn?: boolean;
    orchEngine?: Record<string, unknown>;
    queueDispatcher?: boolean;
    sessionFactory?: (thread: { threadId: string }) => any;
    sessions?: Record<string, unknown>;
  },
) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-req-api-"));
  const workspaceId = "ws-req-api" as WorkspaceId;
  const dbPath = path.join(workspacePath, "client.db");
  const db = openClientDb({ dbPath });
  const threads = new ThreadStore();
  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  // 线程与编排仓储位于工作区库；夹具读写必须使用与 API handler 相同的视图。
  const workspaceDb = db.forWorkspace(workspaceId);
  const sent: ClientToServerMessage[] = [];
  const responseText = typeof responsePayload === "string" ? responsePayload : JSON.stringify(responsePayload);
  const structuredResponsePayload = typeof responsePayload === "string" ? null : responsePayload;
  let conversationSeq = 0;
  let sendMessageCalls = 0;
  const sendMessageInputs: any[] = [];
  const begunThreadOperationIds: string[] = [];
  const finishedThreadOperationIds: string[] = [];

  workspaceDb.orchRoles.upsert({
    id: "role-ui" as any,
    workspaceId,
    name: "前端实现",
    description: "负责页面实现",
    responsibility: "完成页面开发",
    systemPrompt: "您是前端实现角色",
    inputDefinition: createDefaultRoleInputDefinition(),
    outputDefinition: createDefaultRoleOutputDefinition(),
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    defaultKnowledgeBundleIds: ["kb-ui" as any],
    toolRefs: [],
    kind: "custom",
  });
  workspaceDb.orchKnowledgeBundles.upsert({
    id: "kb-ui" as any,
    workspaceId,
    name: "前端知识库",
    scope: "shared",
    description: "页面规范与组件约束",
    sourceRefs: [],
  });
  workspaceDb.orchWorkflows.upsert({
    id: "wf-standard" as any,
    workspaceId,
    family: "feature-dev",
    name: "CodeFlow 标准功能开发",
    description: "适合标准页面功能",
    workflowKnowledgeBundleIds: ["kb-ui" as any],
    nodes: [
      {
        id: "node-ui",
        type: "role",
        roleId: "role-ui" as any,
        label: "页面实现",
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    version: 1,
  });

  const deletionTails: Promise<void>[] = [];
  const ctx: ApiHandlerContext = {
    async flushLocalEvents() {},
    trackApiTail(work) { void work.then(undefined, () => undefined); deletionTails.push(work); },
    controlledExperiments: createUnusedExperimentExecutor(db),
    db,
    workspaces: new Map([[workspaceId, workspacePath]]),
    /** 从 harness 的真实资产仓储提供当前 legacy 权威读取。 */
    orchAssetRuntimeRead: {
      openWorkspace(runtimeWorkspaceId: WorkspaceId) {
        assert.equal(runtimeWorkspaceId, workspaceId);
        return {
          authorityMode: "legacy" as const,
          listAssets: () => [],
          getAsset: (assetType: string, assetId: string) => {
            const definition = assetType === "workflow"
              ? workspaceDb.orchWorkflows.get(assetId as any)
              : assetType === "role"
                ? workspaceDb.orchRoles.get(assetId as any)
                : null;
            return definition
              ? {
                  assetType,
                  assetId,
                  definition,
                  source: { authorityMode: "legacy" as const, createdAt: 1, updatedAt: 1 },
                }
              : null;
          },
          getServerReadinessRequirement: () => null,
        };
      },
    } as any,
    clientId: "client-test",
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    threads,
    sessions: {
      /** 记录写请求租约，便于校验 sessionId 已解析为真实 runtime threadId。 */
      beginThreadOperation(threadId: string) {
        begunThreadOperationIds.push(String(threadId));
        return () => finishedThreadOperationIds.push(String(threadId));
      },
      /** 测试不模拟删除竞态，删除租约立即成功。 */
      beginThreadDeletion() { return () => {}; },
      hasActiveTurn() {
        return Boolean(opts?.hasActiveTurn);
      },
      /** 夹具没有驻留会话；偏好更新只落库，不触发运行中权限切换。 */
      getExisting() { return null; },
      /** 测试 provider 不支持运行中追加，沿持久队列等待当前回合。 */
      canAppendInput() { return false; },
      async interrupt() {
        return false;
      },
      async interruptCodexTurnByEngineIds() {
        return;
      },
      async disposeThreadWithOptions() {
        return;
      },
      async disposeThread() {
        return;
      },
      getOrCreate(thread: { threadId: string }) {
        if (opts?.sessionFactory) {
          return opts.sessionFactory(thread);
        }
        threads.setSessionId(thread.threadId as any, "engine-session-api" as any);
        return {
          engine: "codex",
          hasActiveTurn() {
            return Boolean(opts?.hasActiveTurn);
          },
          async prepareAssistantTerminalEvents() {
            return { events: [], latestAssistantText: null };
          },
          resolvePlatformToolTransport() {
            return "native-dynamic";
          },
          sendMessage: async (input: any, emitters: any) => {
            sendMessageCalls += 1;
            sendMessageInputs.push(input);
            let emittedText = responseText;
            if (
              typeof input.executeHostTool === "function"
              && input.toolRegistry?.tools?.some((tool: any) => String(tool?.toolId ?? "") === "runtime.submitRequirementAnalysisTurnResult")
              && structuredResponsePayload
            ) {
              const toolResult = await input.executeHostTool({
                toolId: "runtime.submitRequirementAnalysisTurnResult",
                toolInput: structuredResponsePayload,
                accessMode: input.accessMode ?? "read-only",
              });
              if (!toolResult?.ok) {
                throw new Error(String(toolResult?.message ?? "requirement analysis tool submission failed"));
              }
              emittedText = String((structuredResponsePayload as any)?.assistantReply ?? "").trim() || responseText;
            }
            emitters?.conversation?.({
              ts: Date.now(),
              workspaceId,
              threadId: thread.threadId as any,
              engine: "codex",
              type: "item.agentMessage.started",
              payload: {
                itemId: input.assistantItemId as any,
                engineMessageId: "engine-assistant-message",
              },
            });
            emitters?.conversation?.({
              ts: Date.now(),
              workspaceId,
              threadId: thread.threadId as any,
              engine: "codex",
              type: "item.agentMessage.completed",
              payload: {
                itemId: input.assistantItemId as any,
                engineMessageId: "engine-assistant-message",
                text: emittedText,
                revision: 0,
              },
            });
            return { responseText: emittedText };
          },
        };
      },
      ...(opts?.sessions ?? {}),
    } as any,
    orchEngine: {
      forWorkspace() {
        return this;
      },
      buildManagedServiceToolRegistry() {
        return null;
      },
      async disposeManagedServicesForThread() {
        return;
      },
      async executeManagedServiceToolForThread() {
        throw new Error("unexpected managed service execution in test harness");
      },
      ...(opts?.orchEngine ?? {}),
    } as any,
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
    onBeforeEmitConversationEvent(event) {
      const ts = Number(event.ts ?? Date.now());
      const seq = ++conversationSeq;
      workspaceDb.conversationEvents.appendEnvelope({
        ...event,
        ts,
        seq,
      } as any);
      if (event.type === "turn.started") workspaceDb.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId,
        engine: event.engine, turnId: event.payload.turnId, startedAt: ts, startEventSeq: seq });
      if (event.type === "turn.completed" || event.type === "turn.error") {
        assert.ok(event.payload.turnId);
        workspaceDb.turns.setEnded(event.payload.turnId, { status: event.type === "turn.completed" ? "completed" : "error", endedAt: ts, endEventSeq: seq });
      }
      workspaceDb.threads.touch(event.threadId, ts);
    },
  };
  if (opts?.queueDispatcher) {
    ctx.queueDispatcher = new ThreadQueueDispatcher(ctx);
  }

  async function call(method: string, body: Record<string, unknown>) {
    const id = `req-${method}-${Math.random().toString(36).slice(2, 8)}`;
    await handleApiRequest(ctx, {
      t: "api.req",
      id,
      method: method as any,
      path: `/${method}`,
      body,
    } as any);
    const response = [...sent].reverse().find((item) => item.t === "api.res" && item.id === id) as any;
    assert.ok(response, `missing api.res for ${method}`);
    return response;
  }

  async function flushAsync() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    ctx,
    db: workspaceDb,
    workspaceId,
    sent,
    getSendMessageCalls() {
      return sendMessageCalls;
    },
    getSendMessageInputs() {
      return sendMessageInputs;
    },
    /** 返回已取得的 thread 操作租约。 */
    getThreadOperationIds() {
      return [...begunThreadOperationIds];
    },
    /** 返回已释放的 thread 操作租约。 */
    getFinishedThreadOperationIds() {
      return [...finishedThreadOperationIds];
    },
    /** 清空租约观测，排除测试准备阶段请求。 */
    resetThreadOperations() {
      begunThreadOperationIds.length = 0;
      finishedThreadOperationIds.length = 0;
    },
    call,
    flushAsync,
    /** 删除确认与物理清理分开，关闭夹具前等待真实清理尾链。 */
    async waitForDeletion() { await Promise.all(deletionTails); },
    /** 测试关闭数据库前排空当前队列的已登记异步消费和延迟重试。 */
    async waitForQueueIdle() {
      const dispatcher = ctx.queueDispatcher as unknown as { hasInFlightWork(): boolean; scheduledKickTimers: Map<string, unknown> } | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (!dispatcher || !dispatcher.hasInFlightWork() && !dispatcher.scheduledKickTimers.size) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("queue test did not drain");
    },
    cleanup() {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test("handleApiRequest 让 requirement-analysis thread 复用 threads.sendMessage 主链路", async () => {
  const harness = createApiHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "首页需求已具备创建条件",
    assistantReply: "首页需求已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      {
        candidateId: "home",
        title: "鲜花市场首页",
        goal: "实现鲜花市场首页，支持 PC 和移动端",
        background: "作为市场首页展示入口",
        acceptanceCriteria: [{ text: "支持 PC 和移动端适配" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "标准页面功能开发。",
        recommendedApproach: "建议先按静态首页单页收口，确认核心模块后再进入正式创建。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("首页候选本身就是一个可独立验收的单阶段页面闭环。"),
        sizeAssessment: buildSizeAssessment("首页属于中型页面需求，需要兼顾双端适配和多个内容区块。"),
        assetGaps: [],
        clarificationItems: [],
        assumptions: ["先按静态页面交付"],
        openQuestions: [],
        readyToCreate: true,
      },
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["home"],
      note: "可以创建需求并生成方案。",
    },
  });

  try {
    const threadId = "thread-analysis-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "首页需求梳理",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    assert.equal(createThreadRes.status, 200);

    const createRes = await harness.call("orch.requirementAnalysis.sessions.create", {
      workspaceId: harness.workspaceId,
      threadId,
      title: "首页需求梳理",
    });
    assert.equal(createRes.status, 200);
    assert.equal(createRes.body.session.id, threadId);
    assert.equal(createRes.body.messages.length, 1);

    const listRes = await harness.call("orch.requirementAnalysis.sessions.list", {
      workspaceId: harness.workspaceId,
      limit: 20,
      cursor: "cursor-test-1",
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.sessions.length, 1);
    assert.equal(listRes.body.hasMore, false);
    assert.equal(listRes.body.nextCursor, null);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-req-analysis-1",
      text: "我要做鲜花市场首页，PC 和移动端都要可用。",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      accessMode: "full-access",
      contextWindow: 300_000,
      serviceTier: "fast",
    });
    assert.equal(sendRes.status, 200);
    await harness.flushAsync();
    assert.equal(harness.getSendMessageInputs()[0]?.contextWindow, 300_000);
    assert.equal(harness.getSendMessageInputs()[0]?.serviceTier, "fast");

    const assistantEvents = harness.db.conversationEvents
      .listByThread(threadId as any)
      .filter((event) => event.type === "item.agentMessage.completed");
    assert.equal(assistantEvents.length, 2);
    assert.equal(String(assistantEvents[1]?.payload.text ?? ""), "首页需求已经可以创建。");
    assert.equal(
      String(assistantEvents[1]?.payload.text ?? "").includes("\"schemaVersion\""),
      false,
    );

    const getRes = await harness.call("orch.requirementAnalysis.sessions.get", {
      workspaceId: harness.workspaceId,
      sessionId: threadId,
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.candidates.length, 1);
    const candidateId = getRes.body.candidates[0].id as RequirementCandidateId;

    const createIntakesRes = await harness.call("orch.requirementAnalysis.createIntakes", {
      workspaceId: harness.workspaceId,
      sessionId: threadId,
      candidateIds: [candidateId],
      createProposals: true,
    });
    assert.equal(createIntakesRes.status, 200);
    assert.equal(createIntakesRes.body.created.length, 1);
    assert.equal(harness.db.orchIntakes.listByWorkspace(harness.workspaceId).length, 1);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 1);

    const archiveRes = await harness.call("orch.requirementAnalysis.sessions.archive", {
      workspaceId: harness.workspaceId,
      sessionId: threadId,
      status: "archived",
    });
    assert.equal(archiveRes.status, 200);
    assert.equal(archiveRes.body.session.status, "archived");
  } finally {
    harness.cleanup();
  }
});

test("需求分析三个 sessionId 写入口统一租用 runtimeThreadId", async () => {
  const harness = createApiHarness(buildReadyRequirementAnalysisPayload());
  try {
    const sessionId = "thread-analysis-operation-session";
    const runtimeThreadId = "thread-analysis-operation-runtime";
    for (const threadId of [sessionId, runtimeThreadId]) {
      const createThreadRes = await harness.call("threads.create", {
        workspaceId: harness.workspaceId,
        threadId,
        engine: "codex",
        title: "需求分析写租约",
        threadType: "chat",
        threadSubtype: "requirement-analysis",
      });
      assert.equal(createThreadRes.status, 200);
    }
    const createSessionRes = await harness.call("orch.requirementAnalysis.sessions.create", {
      workspaceId: harness.workspaceId,
      threadId: sessionId,
      title: "需求分析写租约",
    });
    assert.equal(createSessionRes.status, 200);
    harness.resetThreadOperations();

    /** 模拟 sessionId 与真实 runtime threadId 分离的兼容数据。 */
    const bindRuntimeThread = () => harness.db.db.prepare(
      "UPDATE orch_requirement_analysis_sessions SET runtime_thread_id = ? WHERE id = ?",
    ).run(runtimeThreadId, sessionId);

    bindRuntimeThread();
    const sendRes = await harness.call("orch.requirementAnalysis.messages.send", {
      workspaceId: harness.workspaceId,
      sessionId,
      text: "请生成可以正式创建的需求。",
      serviceTier: "fast",
    });
    assert.equal(sendRes.status, 200);
    assert.equal(harness.getSendMessageInputs()[0]?.serviceTier, "fast");
    const candidateId = sendRes.body.candidates[0].id;

    bindRuntimeThread();
    const createIntakesRes = await harness.call("orch.requirementAnalysis.createIntakes", {
      workspaceId: harness.workspaceId,
      sessionId,
      candidateIds: [candidateId],
    });
    assert.equal(createIntakesRes.status, 200);

    bindRuntimeThread();
    const archiveRes = await harness.call("orch.requirementAnalysis.sessions.archive", {
      workspaceId: harness.workspaceId,
      sessionId,
      status: "archived",
    });
    assert.equal(archiveRes.status, 200);
    assert.deepEqual(harness.getThreadOperationIds(), [runtimeThreadId, runtimeThreadId, runtimeThreadId]);
    assert.deepEqual(harness.getFinishedThreadOperationIds(), [runtimeThreadId, runtimeThreadId, runtimeThreadId]);
  } finally {
    harness.cleanup();
  }
});

test("threads.archive 会同步 requirement-analysis session 的归档状态", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-analysis-archive-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "归档同步需求分析",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    assert.equal(createThreadRes.status, 200);

    const createSessionRes = await harness.call("orch.requirementAnalysis.sessions.create", {
      workspaceId: harness.workspaceId,
      threadId,
      title: "归档同步需求分析",
    });
    assert.equal(createSessionRes.status, 200);

    const archiveThreadRes = await harness.call("threads.archive", {
      workspaceId: harness.workspaceId,
      threadId,
      archived: true,
    });
    assert.equal(archiveThreadRes.status, 200);
    assert.equal(harness.db.threads.get(threadId as any)?.archived, true);
    assert.equal(harness.db.orchRequirementAnalysisSessions.get(threadId as any)?.status, "archived");

    const listArchivedRes = await harness.call("orch.requirementAnalysis.sessions.list", {
      workspaceId: harness.workspaceId,
      limit: 20,
    });
    assert.equal(listArchivedRes.status, 200);
    assert.equal(listArchivedRes.body.sessions.length, 0);

    const restoreThreadRes = await harness.call("threads.archive", {
      workspaceId: harness.workspaceId,
      threadId,
      archived: false,
    });
    assert.equal(restoreThreadRes.status, 200);
    assert.equal(harness.db.threads.get(threadId as any)?.archived, false);
    assert.equal(harness.db.orchRequirementAnalysisSessions.get(threadId as any)?.status, "active");

    const listActiveRes = await harness.call("orch.requirementAnalysis.sessions.list", {
      workspaceId: harness.workspaceId,
      limit: 20,
    });
    assert.equal(listActiveRes.status, 200);
    assert.equal(listActiveRes.body.sessions.length, 1);
    assert.equal(listActiveRes.body.sessions[0]?.id, threadId);
  } finally {
    harness.cleanup();
  }
});

test("orch.requirementAnalysis.sessions.list filters by allowedResourceIds before pagination", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const sessionIds = ["thread-analysis-newest", "thread-analysis-middle", "thread-analysis-oldest"];
    for (const threadId of sessionIds) {
      const createThreadRes = await harness.call("threads.create", {
        workspaceId: harness.workspaceId,
        threadId,
        engine: "codex",
        title: threadId,
        threadType: "chat",
        threadSubtype: "requirement-analysis",
      });
      assert.equal(createThreadRes.status, 200);
      const createSessionRes = await harness.call("orch.requirementAnalysis.sessions.create", {
        workspaceId: harness.workspaceId,
        threadId,
        title: threadId,
      });
      assert.equal(createSessionRes.status, 200);
    }
    harness.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET updated_at = ?, created_at = ?, last_message_at = ? WHERE id = ?")
      .run(300, 300, 300, "thread-analysis-newest");
    harness.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET updated_at = ?, created_at = ?, last_message_at = ? WHERE id = ?")
      .run(200, 200, 200, "thread-analysis-middle");
    harness.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET updated_at = ?, created_at = ?, last_message_at = ? WHERE id = ?")
      .run(100, 100, 100, "thread-analysis-oldest");
    harness.db.db.prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?").run(300, 300, "thread-analysis-newest");
    harness.db.db.prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?").run(200, 200, "thread-analysis-middle");
    harness.db.db.prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?").run(100, 100, "thread-analysis-oldest");

    const filtered = await harness.call("orch.requirementAnalysis.sessions.list", {
      workspaceId: harness.workspaceId,
      limit: 2,
      allowedResourceIds: ["thread-analysis-oldest"],
    });
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.sessions.map((item: { id: string }) => item.id), ["thread-analysis-oldest"]);
    assert.equal(filtered.body.hasMore, false);
    assert.equal(filtered.body.nextCursor, null);

    const empty = await harness.call("orch.requirementAnalysis.sessions.list", {
      workspaceId: harness.workspaceId,
      allowedResourceIds: [],
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.sessions, []);
  } finally {
    harness.cleanup();
  }
});

test("threads.delete 会级联清理 requirement-analysis session", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-analysis-delete-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "删除同步需求分析",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    assert.equal(createThreadRes.status, 200);

    const createSessionRes = await harness.call("orch.requirementAnalysis.sessions.create", {
      workspaceId: harness.workspaceId,
      threadId,
      title: "删除同步需求分析",
    });
    assert.equal(createSessionRes.status, 200);
    assert.equal(harness.db.orchRequirementAnalysisSessions.get(threadId as any)?.id, threadId);

    const deleteThreadRes = await harness.call("threads.delete", {
      workspaceId: harness.workspaceId,
      threadId,
    });
    assert.equal(deleteThreadRes.status, 200);
    assert.equal(harness.db.threads.get(threadId as any), null);
    await harness.waitForDeletion();
    assert.equal(harness.db.orchRequirementAnalysisSessions.get(threadId as any), null);

    const listRes = await harness.call("orch.requirementAnalysis.sessions.list", {
      workspaceId: harness.workspaceId,
      limit: 20,
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.sessions.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 将异常中断节点 thread 的继续输入改道到编排 resume_with_input", async () => {
  const submitFeedbackCalls: Array<{
    instanceId: string;
    nodeId: string;
    action: string;
    input: { feedback?: string | null } | undefined;
  }> = [];
  const harness = createApiHarness({ ok: true }, {
    queueDispatcher: true,
    orchEngine: {
      async submitFeedback(instanceId: string, nodeId: string, action: string, input?: { feedback?: string | null }) {
        submitFeedbackCalls.push({ instanceId, nodeId, action, input });
      },
    },
  });

  try {
    const threadId = "thread-node-recovery-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点恢复会话",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    assert.equal(createThreadRes.status, 200);

    const instance = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: "wf-standard" as any,
      workflowSnapshot: {
        id: "wf-standard" as any,
        workspaceId: harness.workspaceId,
        family: "feature-dev",
        name: "CodeFlow 标准功能开发",
        description: "适合标准页面功能",
        workflowKnowledgeBundleIds: [],
        nodes: [
          {
            id: "node-ui",
            type: "role",
            roleId: "role-ui" as any,
            label: "页面实现",
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        version: 1,
      },
      intakeSnapshot: {
        id: "intake-node-recovery" as any,
        workspaceId: harness.workspaceId,
        triggerMode: "manual",
        taskType: "feature",
        title: "节点恢复测试",
        goal: "继续当前中断节点",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: null,
        createdAt: 1,
        updatedAt: 1,
      },
      roleSnapshots: {
        "role-ui": harness.db.orchRoles.get("role-ui" as any)!,
      },
    });
    harness.db.orchInstances.updateStatus(instance.id, "running");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      "node-ui": {
        nodeId: "node-ui",
        status: "waiting-feedback",
        humanActionSource: "execution",
        threadId: threadId as any,
        retryCount: 0,
        error: "stream disconnected before completion",
      },
    } as any);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "继续，把当前节点做完。",
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.body.dispatchMode, "orchestration_feedback");
    assert.equal("turnId" in sendRes.body, false);
    await harness.flushAsync();

    assert.equal(harness.getSendMessageCalls(), 0);
    assert.equal(submitFeedbackCalls.length, 1);
    assert.equal(submitFeedbackCalls[0]?.instanceId, instance.id);
    assert.equal(submitFeedbackCalls[0]?.nodeId, "node-ui");
    assert.equal(submitFeedbackCalls[0]?.action, "resume_with_input");
    assert.equal(submitFeedbackCalls[0]?.input?.feedback, "继续，把当前节点做完。");

    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.started"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 在异常中断节点仍有旧待发消息时用新输入解除 user_stop", async () => {
  const harness = createApiHarness({ ok: true });
  const kickedThreadIds: string[] = [];
  harness.ctx.queueDispatcher = {
    kickIfIdle(threadId) {
      kickedThreadIds.push(String(threadId));
    },
    kickAtActiveTurnBoundary() {},
    notifyTurnTerminal() {},
  };

  try {
    const threadId = "thread-node-recovery-user-stop";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点中断后继续会话",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    assert.equal(createThreadRes.status, 200);

    const instance = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: "wf-standard" as any,
      workflowSnapshot: harness.db.orchWorkflows.get("wf-standard" as any)!,
      intakeSnapshot: {
        id: "intake-node-recovery-user-stop" as any,
        workspaceId: harness.workspaceId,
        triggerMode: "manual",
        taskType: "feature",
        title: "节点中断后继续测试",
        goal: "新输入应恢复当前中断节点",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: null,
        createdAt: 1,
        updatedAt: 1,
      },
      roleSnapshots: {
        "role-ui": harness.db.orchRoles.get("role-ui" as any)!,
      },
    });
    harness.db.orchInstances.updateStatus(instance.id, "waiting-feedback");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      "node-ui": {
        nodeId: "node-ui",
        status: "waiting-feedback",
        humanActionSource: "execution",
        threadId: threadId as any,
        retryCount: 0,
        error: "turn interrupted",
      },
    } as any);

    const oldItem = harness.db.threadMessageQueue.appendItem({
      workspaceId: harness.workspaceId,
      threadId: threadId as any,
      text: "更早的待发补充",
      images: [],
      files: [],
      pathReferences: [],
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: null,
        model: null,
        effort: null,
        contextWindow: null,
        autoCompactPct: null,
        serviceTier: null,
        roleId: null,
      },
      originWebSessionId: null,
      sharedWorkspaceToolContext: null,
      clientItemId: "old-pending-item",
    }).item;
    harness.db.threadQueueStates.pause(threadId as any, harness.workspaceId, "user_stop");

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "继续",
      clientItemId: "resume-after-user-stop",
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.body.dispatchMode, "orchestration_feedback");

    const queueState = harness.db.threadQueueStates.getState(threadId as any);
    assert.equal(queueState.paused, false);
    assert.deepEqual(kickedThreadIds, [threadId]);
    assert.equal(harness.db.threadMessageQueue.getById(oldItem.id)?.status, "pending");
    assert.equal(harness.db.threadMessageQueue.listActiveByThread(threadId as any).length, 2);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 手动压缩异常中断节点时不重放编排反馈", async () => {
  const submitFeedbackCalls: Array<{
    instanceId: string;
    nodeId: string;
    action: string;
    input: { feedback?: string | null; threadReusePolicy?: string | null } | undefined;
  }> = [];
  const compactThreadCalls: Array<{ turnId: string; autoCompactPct?: number | null }> = [];
  const harness = createApiHarness({ ok: true }, {
    queueDispatcher: true,
    orchEngine: {
      async submitFeedback(instanceId: string, nodeId: string, action: string, input?: { feedback?: string | null; threadReusePolicy?: string | null }) {
        submitFeedbackCalls.push({ instanceId, nodeId, action, input });
      },
    },
    sessionFactory: () => ({
      engine: "codex",
      hasActiveTurn() {
        return false;
      },
      getSessionId() {
        return "engine-session-api";
      },
      async prepareAssistantTerminalEvents() {
        return { events: [], latestAssistantText: null };
      },
      resolvePlatformToolTransport() {
        return "native-dynamic";
      },
      async compactThread(input: { turnId: string; autoCompactPct?: number | null }) {
        compactThreadCalls.push(input);
      },
      async interrupt() {
        return false;
      },
    }),
  });

  try {
    const threadId = "thread-node-recovery-compact-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点压缩恢复会话",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    assert.equal(createThreadRes.status, 200);

    const instance = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: "wf-standard" as any,
      workflowSnapshot: {
        id: "wf-standard" as any,
        workspaceId: harness.workspaceId,
        family: "feature-dev",
        name: "CodeFlow 标准功能开发",
        description: "适合标准页面功能",
        workflowKnowledgeBundleIds: [],
        nodes: [
          {
            id: "node-ui",
            type: "role",
            roleId: "role-ui" as any,
            label: "页面实现",
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        version: 1,
      },
      intakeSnapshot: {
        id: "intake-node-recovery-compact" as any,
        workspaceId: harness.workspaceId,
        triggerMode: "manual",
        taskType: "feature",
        title: "节点压缩恢复测试",
        goal: "压缩当前中断节点上下文",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: null,
        createdAt: 1,
        updatedAt: 1,
      },
      roleSnapshots: {
        "role-ui": harness.db.orchRoles.get("role-ui" as any)!,
      },
    });
    harness.db.orchInstances.updateStatus(instance.id, "running");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      "node-ui": {
        nodeId: "node-ui",
        status: "waiting-feedback",
        humanActionSource: "execution",
        threadId: threadId as any,
        retryCount: 0,
        error: "stream disconnected before completion",
      },
    } as any);

    const compactRes = await harness.call("threads.compact", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-node-compact-1",
      autoCompactPct: 88,
    });
    assert.equal(compactRes.status, 200);
    await harness.flushAsync();

    assert.equal(compactThreadCalls.length, 1);
    assert.equal(compactThreadCalls[0]?.turnId, "turn-node-compact-1");
    assert.equal(compactThreadCalls[0]?.autoCompactPct, 88);
    assert.equal(submitFeedbackCalls.length, 0);

    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.completed"), true);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 先持久化异常中断节点输入并在后台显式记录恢复失败", async () => {
  const submitFeedbackCalls: Array<{
    instanceId: string;
    nodeId: string;
    action: string;
    input: { feedback?: string | null } | undefined;
  }> = [];
  const harness = createApiHarness({ ok: true }, {
    queueDispatcher: true,
    orchEngine: {
      async submitFeedback(instanceId: string, nodeId: string, action: string, input?: { feedback?: string | null }) {
        submitFeedbackCalls.push({ instanceId, nodeId, action, input });
        throw new Error("submit feedback failed");
      },
    },
  });

  try {
    const threadId = "thread-node-recovery-failed";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点恢复失败会话",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    assert.equal(createThreadRes.status, 200);

    const instance = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: "wf-standard" as any,
      workflowSnapshot: {
        id: "wf-standard" as any,
        workspaceId: harness.workspaceId,
        family: "feature-dev",
        name: "CodeFlow 标准功能开发",
        description: "适合标准页面功能",
        workflowKnowledgeBundleIds: [],
        nodes: [
          {
            id: "node-ui",
            type: "role",
            roleId: "role-ui" as any,
            label: "页面实现",
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        version: 1,
      },
      intakeSnapshot: {
        id: "intake-node-recovery-failed" as any,
        workspaceId: harness.workspaceId,
        triggerMode: "manual",
        taskType: "feature",
        title: "节点恢复失败测试",
        goal: "恢复失败时不得假成功",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: null,
        createdAt: 1,
        updatedAt: 1,
      },
      roleSnapshots: {
        "role-ui": harness.db.orchRoles.get("role-ui" as any)!,
      },
    });
    harness.db.orchInstances.updateStatus(instance.id, "running");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      "node-ui": {
        nodeId: "node-ui",
        status: "waiting-feedback",
        humanActionSource: "execution",
        threadId: threadId as any,
        retryCount: 0,
        error: "stream disconnected before completion",
      },
    } as any);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "继续，但提交反馈失败。",
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.body.ok, true);
    assert.equal(sendRes.body.dispatchMode, "orchestration_feedback");
    assert.equal("turnId" in sendRes.body, false);
    await harness.flushAsync();

    assert.equal(harness.getSendMessageCalls(), 0);
    assert.equal(submitFeedbackCalls.length, 1);
    assert.equal(submitFeedbackCalls[0]?.instanceId, instance.id);
    assert.equal(submitFeedbackCalls[0]?.nodeId, "node-ui");
    assert.equal(submitFeedbackCalls[0]?.action, "resume_with_input");
    assert.equal(submitFeedbackCalls[0]?.input?.feedback, "继续，但提交反馈失败。");
    const queueItem = harness.db.threadMessageQueue.getById(sendRes.body.item.id);
    assert.equal(queueItem?.status, "failed");
    assert.equal(queueItem?.failureCode, "orchestration_feedback_failed");
    assert.match(queueItem?.failureReason ?? "", /submit feedback failed/);

    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.started"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 允许编排 node、requirement-analysis 与 node-discussion 线程入队补充", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const nodeThreadId = "thread-node-queue-append";
    const createNodeThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId: nodeThreadId,
      engine: "codex",
      title: "节点运行会话",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    assert.equal(createNodeThreadRes.status, 200);

    const instance = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: "wf-standard" as any,
      workflowSnapshot: {
        id: "wf-standard" as any,
        workspaceId: harness.workspaceId,
        family: "feature-dev",
        name: "CodeFlow 标准功能开发",
        description: "适合标准页面功能",
        workflowKnowledgeBundleIds: [],
        nodes: [
          {
            id: "node-ui",
            type: "role",
            roleId: "role-ui" as any,
            label: "页面实现",
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        version: 1,
      },
      intakeSnapshot: {
        id: "intake-node-queue" as any,
        workspaceId: harness.workspaceId,
        triggerMode: "manual",
        taskType: "feature",
        title: "节点队列测试",
        goal: "支持节点补充入队",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: null,
        createdAt: 1,
        updatedAt: 1,
      },
      roleSnapshots: {
        "role-ui": harness.db.orchRoles.get("role-ui" as any)!,
      },
    });
    harness.db.orchInstances.updateStatus(instance.id, "running");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      "node-ui": {
        nodeId: "node-ui",
        status: "running",
        humanActionSource: null,
        threadId: nodeThreadId as any,
        retryCount: 0,
      },
    } as any);

    const nodeQueueRes = await harness.call("threads.queue.append", {
      workspaceId: harness.workspaceId,
      threadId: nodeThreadId,
      text: "补充：优先兼容移动端。",
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: null,
        model: null,
        effort: null,
        contextWindow: null,
        autoCompactPct: null,
        serviceTier: null,
      },
    });
    assert.equal(nodeQueueRes.status, 200);
    assert.equal(nodeQueueRes.body.ok, true);
    assert.equal(harness.db.threadMessageQueue.listActiveByThread(nodeThreadId as any).length, 1);

    const requirementThreadId = "thread-analysis-queue-append";
    const createRequirementThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId: requirementThreadId,
      engine: "codex",
      title: "需求分析",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    assert.equal(createRequirementThreadRes.status, 200);

    const requirementQueueRes = await harness.call("threads.queue.append", {
      workspaceId: harness.workspaceId,
      threadId: requirementThreadId,
      text: "补充需求",
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: null,
        model: null,
        effort: null,
        contextWindow: null,
        autoCompactPct: null,
        serviceTier: null,
      },
    });
    assert.equal(requirementQueueRes.status, 200);
    assert.equal(requirementQueueRes.body.ok, true);
    assert.equal(harness.db.threadMessageQueue.listActiveByThread(requirementThreadId as any).length, 1);

    const discussionThreadId = "thread-node-discussion-queue-append";
    const createDiscussionThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId: discussionThreadId,
      engine: "codex",
      title: "节点讨论",
      threadType: "chat",
      threadSubtype: "node-discussion",
    });
    assert.equal(createDiscussionThreadRes.status, 200);

    const discussionQueueRes = await harness.call("threads.queue.append", {
      workspaceId: harness.workspaceId,
      threadId: discussionThreadId,
      text: "补充讨论这个节点。",
      pathReferences: [{
        id: "pathref-discussion-append",
        path: "apps/desktop/client/src/queue/threadQueueDispatcher.ts",
        kind: "file",
        source: "mention",
      }],
      sendOptions: {
        workMode: "general",
        planMode: true,
        accessMode: "full-access",
        model: "gpt-5.5",
        effort: "high",
        contextWindow: 200_000,
        autoCompactPct: null,
        serviceTier: null,
        forceNewTurn: true,
      },
    });
    assert.equal(discussionQueueRes.status, 200);
    assert.equal(discussionQueueRes.body.ok, true);
    const discussionQueueItem = harness.db.threadMessageQueue.getById(discussionQueueRes.body.item.id);
    assert.equal(discussionQueueItem?.status, "pending");
    assert.equal(discussionQueueItem?.sendOptions.accessMode, "read-only");
    assert.equal(discussionQueueItem?.sendOptions.planMode, false);
    assert.equal(discussionQueueItem?.sendOptions.forceNewTurn, true);
    assert.equal(discussionQueueItem?.pathReferences[0]?.path, "apps/desktop/client/src/queue/threadQueueDispatcher.ts");

    const assetDraftThreadId = "thread-asset-draft-queue-rejected";
    const createAssetDraftThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId: assetDraftThreadId,
      engine: "codex",
      title: "资产草稿",
      threadType: "orchestration",
      threadSubtype: "asset-draft",
    });
    assert.equal(createAssetDraftThreadRes.status, 200);
    const assetDraftQueueRes = await harness.call("threads.queue.append", {
      workspaceId: harness.workspaceId,
      threadId: assetDraftThreadId,
      text: "不应进入普通队列。",
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: "read-only",
        model: null,
        effort: null,
        contextWindow: null,
        autoCompactPct: null,
        serviceTier: null,
      },
    });
    assert.equal(assetDraftQueueRes.status, 409);
    assert.match(String(assetDraftQueueRes.body.message ?? ""), /不支持队列/);
    assert.doesNotMatch(String(assetDraftQueueRes.body.message ?? ""), /面板/);
  } finally {
    harness.cleanup();
  }
});

test("ThreadQueueDispatcher idle 消费 node-discussion 时保留路径引用并强制只读模式", async () => {
  const harness = createApiHarness("节点讨论队列已发送", { queueDispatcher: true });

  try {
    const threadId = "thread-node-discussion-queue-consume";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点讨论队列消费",
      threadType: "chat",
      threadSubtype: "node-discussion",
    });
    assert.equal(createThreadRes.status, 200);

    const appendRes = await harness.call("threads.queue.append", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "请结合引用文件继续讨论。",
      pathReferences: [{
        id: "pathref-discussion-idle",
        path: "apps/desktop/client/src/queue/threadQueueDispatcher.ts",
        kind: "file",
        source: "mention",
      }],
      sendOptions: {
        workMode: "general",
        planMode: true,
        accessMode: "full-access",
        model: "gpt-5.5",
        effort: "high",
        contextWindow: 200_000,
        autoCompactPct: null,
        serviceTier: null,
      },
    });
    assert.equal(appendRes.status, 200);

    for (let index = 0; index < 20; index += 1) {
      const queueItem = harness.db.threadMessageQueue.getById(appendRes.body.item.id);
      if (queueItem?.status === "sent" && harness.getSendMessageCalls() === 1
        && queueItem.sentTurnId && harness.db.turns.get(queueItem.sentTurnId)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const queueItem = harness.db.threadMessageQueue.getById(appendRes.body.item.id);
    assert.equal(queueItem?.status, "sent");
    assert.match(String(queueItem?.sentTurnId ?? ""), /^turn_/);
    assert.equal(queueItem?.sendOptions.accessMode, "read-only");
    assert.equal(queueItem?.sendOptions.planMode, false);
    assert.equal(harness.getSendMessageCalls(), 1);
    const sentInput = harness.getSendMessageInputs()[0];
    assert.equal(sentInput?.accessMode, "read-only");
    assert.equal(sentInput?.planMode, false);
    assert.match(String(sentInput?.userMessage ?? ""), /@apps\/desktop\/client\/src\/queue\/threadQueueDispatcher\.ts/);
    const userEvent = harness.db.conversationEvents.listByThread(threadId as any)
      .find((event) => event.type === "item.userMessage.created");
    assert.equal((userEvent?.payload as any)?.pathReferences?.[0]?.path, "apps/desktop/client/src/queue/threadQueueDispatcher.ts");
    const turnStartedEvent = harness.db.conversationEvents.listByThread(threadId as any)
      .find((event) => event.type === "turn.started");
    assert.equal((turnStartedEvent?.payload as any)?.turnId, queueItem?.sentTurnId);
    assert.deepEqual((turnStartedEvent?.payload as any)?.execution, {
      model: "gpt-5.5",
      effort: "high",
      contextWindow: 200_000,
      autoCompactPct: null,
      serviceTier: null,
    });
    await harness.waitForQueueIdle();
  } finally {
    harness.cleanup();
  }
});

test("ThreadQueueDispatcher 按需求分析服务完成态消费 requirement-analysis 队列", async () => {
  const harness = createApiHarness(buildReadyRequirementAnalysisPayload("已按补充输入更新候选需求。"), {
    queueDispatcher: true,
  });

  try {
    const threadId = "thread-analysis-queue-consume";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "需求分析队列消费",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    assert.equal(createThreadRes.status, 200);

    const createSessionRes = await harness.call("orch.requirementAnalysis.sessions.create", {
      workspaceId: harness.workspaceId,
      threadId,
      title: "需求分析队列消费",
    });
    assert.equal(createSessionRes.status, 200);

    const appendRes = await harness.call("threads.queue.append", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "补充：移动端首页首屏要突出搜索入口。",
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: "read-only",
        model: "gpt-5.6-sol",
        effort: "high",
        contextWindow: 200_000,
        autoCompactPct: null,
        serviceTier: "fast",
      },
    });
    assert.equal(appendRes.status, 200);
    assert.equal(appendRes.body.ok, true);

    await harness.flushAsync();
    await harness.flushAsync();

    const queueItem = harness.db.threadMessageQueue.getById(appendRes.body.item.id);
    assert.equal(queueItem?.status, "sent");
    assert.match(String(queueItem?.sentTurnId ?? ""), /^turn_req_queue_/);
    assert.equal(harness.db.threadMessageQueue.listActiveByThread(threadId as any).length, 0);
    const queueState = harness.db.threadQueueStates.getState(threadId as any);
    assert.equal(queueState.lastConsumedQueueId, appendRes.body.item.id);
    assert.equal(queueState.lastConsumedTurnId, queueItem?.sentTurnId);
    assert.equal(queueState.paused, false);
    assert.equal(harness.getSendMessageCalls(), 1);
    assert.equal(harness.getSendMessageInputs()[0]?.contextWindow, 200_000);
    assert.equal(harness.getSendMessageInputs()[0]?.serviceTier, "fast");

    const getRes = await harness.call("orch.requirementAnalysis.sessions.get", {
      workspaceId: harness.workspaceId,
      sessionId: threadId,
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.candidates.length, 1);
    assert.equal(getRes.body.session.latestAssistantReply, "已按补充输入更新候选需求。");
  } finally {
    harness.cleanup();
  }
});

test("ThreadQueueDispatcher 在 requirement-analysis 主动 turn 完成后自动消费运行中入队项", async () => {
  const payload = buildReadyRequirementAnalysisPayload("已按运行中补充输入更新候选需求。");
  let runtimeActive = false;
  let sendMessageCalls = 0;
  let releaseActiveSend!: () => void;
  let markActiveSendStarted!: () => void;
  const activeSendStarted = new Promise<void>((resolve) => {
    markActiveSendStarted = resolve;
  });
  const activeSendRelease = new Promise<void>((resolve) => {
    releaseActiveSend = resolve;
  });
  const harness = createApiHarness(payload, {
    queueDispatcher: true,
    sessions: {
      hasActiveTurn() {
        return runtimeActive;
      },
    },
    sessionFactory() {
      return {
        engine: "codex",
        hasActiveTurn() {
          return false;
        },
        async prepareAssistantTerminalEvents() {
          return { events: [], latestAssistantText: null };
        },
        resolvePlatformToolTransport() {
          return "native-dynamic";
        },
        async sendMessage(input: any) {
          sendMessageCalls += 1;
          runtimeActive = true;
          markActiveSendStarted();
          if (sendMessageCalls === 1) {
            await activeSendRelease;
          }
          const toolResult = await input.executeHostTool({
            toolId: "runtime.submitRequirementAnalysisTurnResult",
            toolInput: payload,
            accessMode: input.accessMode ?? "read-only",
          });
          if (!toolResult?.ok) {
            throw new Error(String(toolResult?.message ?? "requirement analysis tool submission failed"));
          }
          runtimeActive = false;
          return { responseText: payload.assistantReply };
        },
      };
    },
  });

  try {
    const threadId = "thread-analysis-running-queue-consume";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "运行中需求分析队列消费",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    assert.equal(createThreadRes.status, 200);

    const createSessionRes = await harness.call("orch.requirementAnalysis.sessions.create", {
      workspaceId: harness.workspaceId,
      threadId,
      title: "运行中需求分析队列消费",
    });
    assert.equal(createSessionRes.status, 200);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-analysis-active-send",
      text: "先启动一个需求助手回合。",
    });
    assert.equal(sendRes.status, 200);
    await activeSendStarted;

    const appendRes = await harness.call("threads.queue.append", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "补充：运行中输入应该在当前回合完成后自动发送。",
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: "read-only",
        model: "gpt-5.6-sol",
        effort: null,
        contextWindow: null,
        autoCompactPct: null,
        serviceTier: null,
      },
    });
    assert.equal(appendRes.status, 200, JSON.stringify(appendRes.body));
    assert.equal(harness.db.threadMessageQueue.getById(appendRes.body.item.id)?.status, "pending");

    releaseActiveSend();
    for (let i = 0; i < 6; i += 1) {
      await harness.flushAsync();
    }

    const queueItem = harness.db.threadMessageQueue.getById(appendRes.body.item.id);
    assert.equal(queueItem?.status, "sent");
    assert.match(String(queueItem?.sentTurnId ?? ""), /^turn_req_queue_/);
    assert.equal(harness.db.threadMessageQueue.listActiveByThread(threadId as any).length, 0);
    const queueState = harness.db.threadQueueStates.getState(threadId as any);
    assert.equal(queueState.lastConsumedQueueId, appendRes.body.item.id);
    assert.equal(queueState.paused, false);
    assert.equal(sendMessageCalls, 2);
  } finally {
    runtimeActive = false;
    releaseActiveSend();
    harness.cleanup();
  }
});

test("ThreadQueueDispatcher 在 requirement-analysis 队列消费失败时标记失败并暂停后续", async () => {
  const harness = createApiHarness("没有提交结构化结果", {
    queueDispatcher: true,
  });

  try {
    const threadId = "thread-analysis-queue-fail";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "需求分析队列失败",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    assert.equal(createThreadRes.status, 200);

    const createSessionRes = await harness.call("orch.requirementAnalysis.sessions.create", {
      workspaceId: harness.workspaceId,
      threadId,
      title: "需求分析队列失败",
    });
    assert.equal(createSessionRes.status, 200);

    const appendRes = await harness.call("threads.queue.append", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "补充：这里会触发未提交结构化结果。",
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: "read-only",
        model: "gpt-5.6-sol",
        effort: null,
        contextWindow: null,
        autoCompactPct: null,
        serviceTier: null,
      },
    });
    assert.equal(appendRes.status, 200);

    await harness.flushAsync();
    await harness.flushAsync();

    const queueItem = harness.db.threadMessageQueue.getById(appendRes.body.item.id);
    assert.equal(queueItem?.status, "failed");
    assert.equal(queueItem?.failureCode, "requirement_analysis_submission_not_accepted");
    assert.match(queueItem?.failureReason ?? "", /没有成功调用 runtime\.submitRequirementAnalysisTurnResult/);
    const queueState = harness.db.threadQueueStates.getState(threadId as any);
    assert.equal(queueState.paused, true);
    assert.equal(queueState.pausedReason, "send_failed");
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 普通 threads.sendMessage 在缺少 turnId 时由服务端生成 authoritative turnId 并回传", async () => {
  const harness = createApiHarness("普通聊天已发送");

  try {
    const threadId = "thread-chat-generated-turn";
    harness.db.threads.create({
      id: threadId as any,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "普通会话",
      threadType: "chat",
      threadSubtype: null,
    });

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "继续聊",
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.body.dispatchMode, "chat_turn");
    assert.match(String(sendRes.body.turnId ?? ""), /^turn_/);
    await harness.flushAsync();

    assert.equal(harness.getSendMessageCalls(), 1);
    assert.equal(String(harness.getSendMessageInputs()[0]?.turnId ?? ""), String(sendRes.body.turnId ?? ""));
    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events[0]?.type, "turn.started");
    assert.equal(String((events[0]?.payload as any)?.turnId ?? ""), String(sendRes.body.turnId ?? ""));
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 按具体模型拒绝不支持的显式 effort，缺失 effort 仍允许发送", async () => {
  const harness = createApiHarness("DeepSeek 已发送");

  try {
    const threadId = "thread-chat-deepseek-effort";
    harness.db.threads.create({
      id: threadId as any,
      workspaceId: harness.workspaceId,
      engine: "claude",
      title: "DeepSeek 会话",
      threadType: "chat",
      threadSubtype: null,
      prefs: { model: "deepseek-v4-pro", effort: "high" },
    });

    const rejected = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "使用不支持的中等强度",
      model: "deepseek-v4-pro",
      effort: "medium",
    });
    assert.equal(rejected.status, 400);
    assert.match(String(rejected.body?.message ?? ""), /deepseek-v4-pro.*medium/);
    assert.equal(harness.getSendMessageCalls(), 0);
    assert.deepEqual(harness.db.conversationEvents.listByThread(threadId as any), []);

    const rejectedNonString = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "使用非法强度类型",
      model: "deepseek-v4-pro",
      effort: 1,
    });
    assert.equal(rejectedNonString.status, 400);
    assert.equal(harness.getSendMessageCalls(), 0);
    assert.deepEqual(harness.db.conversationEvents.listByThread(threadId as any), []);

    const accepted = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "使用模型默认强度",
      model: "deepseek-v4-pro",
    });
    assert.equal(accepted.status, 200);
    await harness.flushAsync();
    assert.equal(harness.getSendMessageCalls(), 1);
  } finally {
    harness.cleanup();
  }
});

test("threads.updatePrefs 拒绝具体模型不支持的显式 effort 且不改写原偏好", async () => {
  const harness = createApiHarness("unused");

  try {
    const threadId = "thread-prefs-deepseek-effort";
    harness.db.threads.create({
      id: threadId as any,
      workspaceId: harness.workspaceId,
      engine: "claude",
      title: "DeepSeek 偏好",
      threadType: "chat",
      threadSubtype: null,
      prefs: { model: "deepseek-v4-pro", effort: "high" },
    });

    const readPrefs = () => {
      const thread = harness.db.threads.get(threadId as any);
      return {
        model: thread?.model,
        effort: thread?.effort,
        accessMode: thread?.accessMode,
        planMode: thread?.planMode,
        autoCompactPct: thread?.autoCompactPct,
        contextWindow: thread?.contextWindow,
        serviceTier: thread?.serviceTier,
        roleId: thread?.roleId,
      };
    };
    const originalPrefs = readPrefs();

    const rejectedByCurrentModel = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId,
      prefs: { effort: "medium" },
    });
    assert.equal(rejectedByCurrentModel.status, 400);
    assert.match(String(rejectedByCurrentModel.body?.message ?? ""), /deepseek-v4-pro.*medium/);
    assert.deepEqual(readPrefs(), originalPrefs);

    const defaultModelThreadId = "thread-prefs-default-model-effort";
    harness.db.threads.create({
      id: defaultModelThreadId as any,
      workspaceId: harness.workspaceId,
      engine: "claude",
      title: "恢复默认模型偏好",
      threadType: "chat",
      threadSubtype: null,
      prefs: { model: "deepseek-v4-pro", effort: "high" },
    });
    const acceptedAfterModelReset = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId: defaultModelThreadId,
      prefs: { model: null, effort: "medium" },
    });
    assert.equal(acceptedAfterModelReset.status, 200);
    const resetThread = harness.db.threads.get(defaultModelThreadId as any);
    assert.equal(resetThread?.model, "claude-fable-5");
    assert.equal(resetThread?.effort, "medium");

    const response = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId,
      prefs: {
        model: "deepseek-v4-pro",
        effort: "medium",
        accessMode: "current",
        planMode: false,
      },
    });
    assert.equal(response.status, 400);
    assert.match(String(response.body?.message ?? ""), /deepseek-v4-pro.*medium/);
    assert.deepEqual(readPrefs(), originalPrefs);

    const rejectedNonString = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId,
      prefs: {
        model: "deepseek-v4-pro",
        effort: 1,
      },
    });
    assert.equal(rejectedNonString.status, 400);
    assert.deepEqual(readPrefs(), originalPrefs);

    const rejectedArrayEffort = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId,
      prefs: { effort: ["high"] },
    });
    assert.equal(rejectedArrayEffort.status, 400);
    assert.deepEqual(readPrefs(), originalPrefs);

    const rejectedPrefsArray = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId,
      prefs: [],
    });
    assert.equal(rejectedPrefsArray.status, 400);
    assert.deepEqual(readPrefs(), originalPrefs);
  } finally {
    harness.cleanup();
  }
});

test("新模型经聊天 API 保留所选窗口与 effort，并在发送前拒绝不支持的档位", async () => {
  const harness = createApiHarness("模型参数验证完成");
  try {
    const cases = [
      ["claude-sonnet-5", 1_000_000, "high", "ultra"],
      ["glm-5.3", 1_000_000, "max", "medium"],
      ["glm-5.3-flash", 1_000_000, "max", "medium"],
      ["kimi-k2.7-code", 256_000, null, "high"],
      ["kimi-k2.7-code-highspeed", 256_000, null, "max"],
    ] as const;
    for (const [model, contextWindow, effort, rejectedEffort] of cases) {
      const threadId = `thread-new-model-${model}`;
      harness.db.threads.create({
        id: threadId as any, workspaceId: harness.workspaceId, engine: "claude",
        title: model, threadType: "chat", threadSubtype: null, prefs: { model },
      });
      const beforeCount = harness.getSendMessageCalls();
      const rejected = await harness.call("threads.sendMessage", {
        workspaceId: harness.workspaceId, threadId, model,
        text: "非法档位应被拒绝", effort: rejectedEffort,
      });
      assert.equal(rejected.status, 400, model);
      assert.equal(harness.getSendMessageCalls(), beforeCount);
      assert.deepEqual(harness.db.conversationEvents.listByThread(threadId as any), []);
      const accepted = await harness.call("threads.sendMessage", {
        workspaceId: harness.workspaceId, threadId, model, contextWindow, effort, text: "使用模型目录能力",
      });
      assert.equal(accepted.status, 200, model);
      await harness.flushAsync();
      const sentInput = harness.getSendMessageInputs().at(-1);
      assert.equal(sentInput?.model, model);
      assert.equal(sentInput?.contextWindow, contextWindow, model);
      assert.equal(sentInput?.effort, effort, model);
    }
  } finally {
    harness.cleanup();
  }
});

test("threads.updatePrefs 的 partial prefs 不会把省略的模型字段重置为默认模型", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-prefs-partial-api";
    const createRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "partial API 偏好",
      threadType: "chat",
      initialPrefs: {
        model: "gpt-5.5",
        effort: "high",
        accessMode: "full-access",
        planMode: true,
        autoCompactPct: 88,
        contextWindow: 272_000,
        serviceTier: "fast",
        roleId: "role-prefs-api",
      },
    });
    assert.equal(createRes.status, 200);

    const updateRes = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId,
      prefs: { effort: "medium" },
    });
    assert.equal(updateRes.status, 200);

    const storedThread = harness.db.threads.get(threadId as any);
    assert.equal(storedThread?.model, "gpt-5.5");
    assert.equal(storedThread?.effort, "medium");
    assert.equal(storedThread?.contextWindow, 272_000);
    assert.equal(storedThread?.serviceTier, "fast");
    assert.equal(storedThread?.planMode, true);
    assert.equal(storedThread?.roleId, "role-prefs-api");
  } finally {
    harness.cleanup();
  }
});

test("threads.updatePrefs 保留显式 model null 的恢复默认语义", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-prefs-null-api";
    const createRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "null API 偏好",
      threadType: "chat",
      initialPrefs: { model: "gpt-5.5", effort: "high", serviceTier: "fast" },
    });
    assert.equal(createRes.status, 200);

    const updateRes = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId,
      prefs: { model: null, effort: "ultra" },
    });
    assert.equal(updateRes.status, 200);

    const storedThread = harness.db.threads.get(threadId as any);
    assert.equal(storedThread?.model, "gpt-5.6-sol");
    assert.equal(storedThread?.contextWindow, 372_000);
    assert.equal(storedThread?.effort, "ultra");
    assert.equal(storedThread?.serviceTier, "fast");
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 普通 threads.sendMessage 会把当前用户 Profile 追加到系统提示词", async () => {
  const harness = createApiHarness("普通聊天已发送");

  try {
    const threadId = "thread-chat-profile";
    harness.db.threads.create({
      id: threadId as any,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "普通会话 Profile",
      threadType: "chat",
      threadSubtype: null,
    });
    harness.db.withWorkspaceExecutionProfiles(harness.workspaceId, repo => repo.upsert({
      scope: { scopeType: "local_workspace", scopeId: harness.workspaceId },
      userId: "user-profile-1",
      profileText: "Git author: Alice <alice@example.test>\n使用 feature/alice 分支前缀。",
    }));

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      text: "继续聊",
      executionProfileUserId: "user-profile-1",
      executionProfileScopeType: "local_workspace",
      executionProfileScopeId: harness.workspaceId,
    });
    assert.equal(sendRes.status, 200, JSON.stringify(sendRes.body));
    await waitForOrdinaryTurnExecution(harness.ctx.sessions, { workspaceId: harness.workspaceId, threadId, turnId: sendRes.body.turnId }, { timeoutMs: 2_000 });

    const sent = harness.getSendMessageInputs()[0];
    assert.ok(sent, JSON.stringify(harness.sent.filter(message => message.t === "conversation.event" && message.event.type === "turn.error")));
    assert.equal(sent?.conversationProfile, "default");
    assert.match(String(sent?.systemMessage ?? ""), /当前用户的工作区执行 Profile/);
    assert.match(String(sent?.systemMessage ?? ""), /Git author: Alice/);
    assert.match(String(sent?.systemMessage ?? ""), /feature\/alice/);
    assert.doesNotMatch(String(sent?.userMessage ?? ""), /Git author: Alice/);
    assert.equal(harness.db.turns.get(sendRes.body.turnId)?.status, "completed");
  } finally {
    harness.cleanup();
  }
});

/** 只读真实日志，空目录表示没有该消费者副作用。 */
function executionProfileLogRows(directory: string): Record<string, any>[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^client.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}test("handleApiRequest turns.interrupt 对 stale turnId 返回 409 且保留 authoritative running turn", async () => {
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  const harness = createApiHarness({ ok: true }, {
    sessions: {
      async interrupt(threadId: string, turnId: string) {
        interruptCalls.push({ threadId, turnId });
        return true;
      },
    },
  });

  try {
    const threadId = "thread-interrupt-authoritative";
    harness.db.threads.create({
      id: threadId as any,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "中断测试",
      threadType: "chat",
      threadSubtype: null,
    });
    harness.db.turns.insertStarted({
      workspaceId: harness.workspaceId,
      threadId: threadId as any,
      engine: "codex",
      turnId: "turn-authoritative-running" as any,
      startedAt: 123,
      startEventSeq: 1,
    });

    const interruptRes = await harness.call("turns.interrupt", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-stale-requested",
    });
    assert.equal(interruptRes.status, 409);
    assert.equal((interruptRes.body as any)?.code, "thread_runtime_stale");
    await harness.flushAsync();

    assert.deepEqual(interruptCalls, []);
    assert.equal(harness.db.turns.get("turn-authoritative-running" as any)?.status, "started");
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 将 review waiting-feedback 输入排队后按 resume_with_input 处理", async () => {
  const submitFeedbackCalls: Array<Record<string, any>> = [];
  const harness = createApiHarness({ ok: true }, {
    queueDispatcher: true,
    orchEngine: {
      async submitFeedback(instanceId: string, nodeId: string, action: string, input?: Record<string, unknown>) {
        submitFeedbackCalls.push({ instanceId, nodeId, action, input });
      },
    },
  });

  try {
    const threadId = "thread-node-feedback-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点反馈会话",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    assert.equal(createThreadRes.status, 200);

    const instance = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: "wf-standard" as any,
      workflowSnapshot: {
        id: "wf-standard" as any,
        workspaceId: harness.workspaceId,
        family: "feature-dev",
        name: "CodeFlow 标准功能开发",
        description: "适合标准页面功能",
        workflowKnowledgeBundleIds: [],
        nodes: [
          {
            id: "node-ui",
            type: "role",
            roleId: "role-ui" as any,
            label: "页面实现",
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        version: 1,
      },
      intakeSnapshot: {
        id: "intake-node-feedback" as any,
        workspaceId: harness.workspaceId,
        triggerMode: "manual",
        taskType: "feature",
        title: "节点反馈测试",
        goal: "不要继续普通聊天",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: null,
        createdAt: 1,
        updatedAt: 1,
      },
      roleSnapshots: {
        "role-ui": harness.db.orchRoles.get("role-ui" as any)!,
      },
    });
    harness.db.orchInstances.updateStatus(instance.id, "running");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      "node-ui": {
        nodeId: "node-ui",
        status: "waiting-feedback",
        humanActionSource: "review",
        threadId: threadId as any,
        retryCount: 0,
        error: "需要人工决策",
      },
    } as any);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-node-feedback-1",
      text: "我再补一句聊天内容。",
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.body.dispatchMode, "orchestration_feedback");
    assert.equal("turnId" in sendRes.body, false);
    await harness.flushAsync();
    assert.equal(harness.getSendMessageCalls(), 0);
    assert.equal(submitFeedbackCalls.length, 1);
    assert.equal(submitFeedbackCalls[0]?.instanceId, instance.id);
    assert.equal(submitFeedbackCalls[0]?.nodeId, "node-ui");
    assert.equal(submitFeedbackCalls[0]?.action, "resume_with_input");
    assert.equal(submitFeedbackCalls[0]?.input?.feedback, "我再补一句聊天内容。");

    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.started"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 将 ready 节点输入持久化入队且不创建普通聊天 turn", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-node-ready-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点就绪会话",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    assert.equal(createThreadRes.status, 200);

    const instance = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: "wf-standard" as any,
      workflowSnapshot: {
        id: "wf-standard" as any,
        workspaceId: harness.workspaceId,
        family: "feature-dev",
        name: "CodeFlow 标准功能开发",
        description: "适合标准页面功能",
        workflowKnowledgeBundleIds: [],
        nodes: [
          {
            id: "node-ui",
            type: "role",
            roleId: "role-ui" as any,
            label: "页面实现",
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        version: 1,
      },
      intakeSnapshot: {
        id: "intake-node-ready" as any,
        workspaceId: harness.workspaceId,
        triggerMode: "manual",
        taskType: "feature",
        title: "节点就绪测试",
        goal: "不要继续普通聊天",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: null,
        createdAt: 1,
        updatedAt: 1,
      },
      roleSnapshots: {
        "role-ui": harness.db.orchRoles.get("role-ui" as any)!,
      },
    });
    harness.db.orchInstances.updateStatus(instance.id, "running");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      "node-ui": {
        nodeId: "node-ui",
        status: "ready",
        humanActionSource: null,
        threadId: threadId as any,
        retryCount: 0,
        error: null,
      },
    } as any);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-node-ready-1",
      text: "继续，我补充一句。",
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.body.dispatchMode, "orchestration_feedback");
    assert.equal("turnId" in sendRes.body, false);
    assert.equal(harness.getSendMessageCalls(), 0);
    const queueItems = harness.db.threadMessageQueue.listActiveByThread(threadId as any);
    assert.equal(queueItems.length, 1);
    assert.equal(queueItems[0]?.status, "pending");
    assert.equal(queueItems[0]?.text, "继续，我补充一句。");

    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.started"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});test("threads.updatePrefs 会把 node-discussion 线程锁定为只读讨论模式", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-node-discussion-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点讨论",
      threadType: "chat",
      threadSubtype: "node-discussion",
      initialPrefs: {
        model: "gpt-5.5",
        effort: "high",
        accessMode: "read-only",
        planMode: false,
      },
    });
    assert.equal(createThreadRes.status, 200);

    const updateRes = await harness.call("threads.updatePrefs", {
      workspaceId: harness.workspaceId,
      threadId,
      prefs: {
        model: "gpt-5.5",
        effort: "high",
        accessMode: "full-access",
        planMode: true,
      },
    });
    assert.equal(updateRes.status, 200);

    const storedThread = harness.db.threads.get(threadId as any);
    assert.equal(storedThread?.threadSubtype, "node-discussion");
    assert.equal(storedThread?.accessMode, "read-only");
    assert.equal(storedThread?.planMode, false);
  } finally {
    harness.cleanup();
  }
});

test("threads.create 会把 node-discussion 初始偏好锁定为只读讨论模式", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-node-discussion-create-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点讨论创建",
      threadType: "chat",
      threadSubtype: "node-discussion",
      initialPrefs: {
        model: "gpt-5.5",
        effort: "high",
        accessMode: "full-access",
        planMode: true,
      },
    });
    assert.equal(createThreadRes.status, 200);

    const storedThread = harness.db.threads.get(threadId as any);
    assert.equal(storedThread?.threadSubtype, "node-discussion");
    assert.equal(storedThread?.model, "gpt-5.5");
    assert.equal(storedThread?.effort, "high");
    assert.equal(storedThread?.accessMode, "read-only");
    assert.equal(storedThread?.planMode, false);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 对 node-discussion 线程发送消息时强制 read-only 且禁用 planMode", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-node-discussion-send-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "节点讨论发送",
      threadType: "chat",
      threadSubtype: "node-discussion",
      initialPrefs: {
        model: "gpt-5.5",
        effort: "high",
        accessMode: "read-only",
        planMode: false,
      },
    });
    assert.equal(createThreadRes.status, 200);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-node-discussion-send-1",
      text: "讨论一下这个节点该怎么改。",
      accessMode: "full-access",
      planMode: true,
    });
    assert.equal(sendRes.status, 200);
    await harness.flushAsync();

    assert.equal(harness.getSendMessageCalls(), 1);
    assert.equal(harness.getSendMessageInputs().length, 1);
    assert.equal(harness.getSendMessageInputs()[0]?.accessMode, "read-only");
    assert.equal(harness.getSendMessageInputs()[0]?.planMode, false);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 在上游拒绝真实工具传输时不再退回文本协议，而是直接结束本轮", async () => {
  const managedServiceToolRegistry = {
    tools: [{
      toolsetId: "__runtime_managed_service__" as any,
      toolsetName: "内建进程",
      toolId: "runtime.manageBackgroundService" as any,
      name: "管理进程",
      alias: "管理进程",
      description: "管理当前聊天窗口中的长驻进程",
      runtime: "builtin",
      usageGuidance: "仅用于需要在页面里统一管理的长驻进程",
      invocationHint: "{\"action\":\"status\",\"serviceId\":\"demo\"}",
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
  const sendInputs: any[] = [];
  let sendCallCount = 0;
  const harness = createApiHarness({ ok: true }, {
    orchEngine: {
      forWorkspace() {
        return this;
      },
      buildManagedServiceToolRegistry() {
        return managedServiceToolRegistry;
      },
    },
    sessionFactory(thread) {
      return {
        engine: "codex",
        hasActiveTurn() {
          return false;
        },
        async prepareAssistantTerminalEvents() {
          return { events: [], latestAssistantText: null };
        },
        resolvePlatformToolTransport() {
          return "native-dynamic";
        },
        async sendMessage(input: any, emitters: any) {
          sendCallCount += 1;
          sendInputs.push(input);
          const error = new Error("dynamic tool transport rejected") as Error & { code: string };
          error.code = "dynamic_tool_transport_unsupported";
          throw error;
        },
      };
    },
  });

  try {
    const threadId = "thread-chat-managed-service-fallback-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "进程降级重试",
      threadType: "chat",
    });
    assert.equal(createThreadRes.status, 200);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-managed-service-fallback-1",
      text: "请启动一个要出现在进程区里的本地健康检查进程。",
    });
    assert.equal(sendRes.status, 200);
    await harness.flushAsync();

    assert.equal(sendCallCount, 1);
    assert.equal(sendInputs[0]?.responseFormat, "text");
    assert.match(String(sendInputs[0]?.developerMessage ?? ""), /已注册动作/);

    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), true);
    const lastTurnError = events.filter((event) => event.type === "turn.error").at(-1);
    assert.match(String((lastTurnError?.payload as any)?.error ?? ""), /dynamic tool transport rejected/);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 在普通聊天里不再根据消息文案预判托管进程硬约束", async () => {
  const managedServiceToolRegistry = {
    tools: [{
      toolsetId: "__runtime_managed_service__" as any,
      toolsetName: "内建进程",
      toolId: "runtime.manageBackgroundService" as any,
      name: "管理进程",
      alias: "管理进程",
      description: "管理当前聊天窗口中的长驻进程",
      runtime: "builtin",
      usageGuidance: "仅用于需要在页面里统一管理的长驻进程",
      invocationHint: "{\"action\":\"status\",\"serviceId\":\"demo\"}",
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
  const sendInputs: any[] = [];
  const harness = createApiHarness({ ok: true }, {
    orchEngine: {
      forWorkspace() {
        return this;
      },
      buildManagedServiceToolRegistry() {
        return managedServiceToolRegistry;
      },
    },
    sessionFactory() {
      return {
        engine: "codex",
        hasActiveTurn() {
          return false;
        },
        async prepareAssistantTerminalEvents() {
          return { events: [], latestAssistantText: null };
        },
        resolvePlatformToolTransport() {
          return "protocol";
        },
        async sendMessage(input: any, emitters: any) {
          sendInputs.push(input);
          emitters?.conversation?.({
            ts: Date.now(),
            workspaceId: harness.workspaceId,
            threadId: "thread-chat-managed-service-required-1" as any,
            engine: "codex",
            type: "item.agentMessage.completed",
            payload: {
              itemId: input.assistantItemId as any,
              engineMessageId: "engine-assistant-message",
              text: "当前 provider 尚未启用页面进程区托管能力。",
              revision: 0,
            },
          });
          return { responseText: "当前 provider 尚未启用页面进程区托管能力。" };
        },
      };
    },
  });

  try {
    const threadId = "thread-chat-managed-service-required-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "进程硬约束",
      threadType: "chat",
    });
    assert.equal(createThreadRes.status, 200);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-managed-service-required-1",
      text: "请启动一个要出现在进程区里的本地健康检查进程，并且要能在页面进程区统一查看和跨刷新保留。",
    });
    assert.equal(sendRes.status, 200);
    await harness.flushAsync();

    assert.equal(sendInputs.length, 1);
    assert.equal(sendInputs[0]?.toolRegistry, null);
    assert.equal(sendInputs[0]?.platformToolTransportRequirement, "optional");
    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
    assert.equal(events.some((event) => event.type === "turn.completed"), true);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 在普通聊天里未明确要求页面进程区托管时，允许继续普通对话", async () => {
  const managedServiceToolRegistry = {
    tools: [{
      toolsetId: "__runtime_managed_service__" as any,
      toolsetName: "内建进程",
      toolId: "runtime.manageBackgroundService" as any,
      name: "管理进程",
      alias: "管理进程",
      description: "管理当前聊天窗口中的长驻进程",
      runtime: "builtin",
      usageGuidance: "仅用于需要在页面里统一管理的长驻进程",
      invocationHint: "{\"action\":\"status\",\"serviceId\":\"demo\"}",
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
  const sendInputs: any[] = [];
  const harness = createApiHarness("普通聊天继续执行", {
    orchEngine: {
      forWorkspace() {
        return this;
      },
      buildManagedServiceToolRegistry() {
        return managedServiceToolRegistry;
      },
    },
    sessionFactory(thread) {
      return {
        engine: "codex",
        hasActiveTurn() {
          return false;
        },
        async prepareAssistantTerminalEvents() {
          return { events: [], latestAssistantText: null };
        },
        resolvePlatformToolTransport() {
          return "protocol";
        },
        async sendMessage(input: any, emitters: any) {
          sendInputs.push(input);
          emitters?.conversation?.({
            ts: Date.now(),
            workspaceId: harness.workspaceId,
            threadId: thread.threadId as any,
            engine: "codex",
            type: "item.agentMessage.completed",
            payload: {
              itemId: input.assistantItemId as any,
              engineMessageId: "engine-assistant-message",
              text: "普通聊天继续执行",
              revision: 0,
            },
          });
          return { responseText: "普通聊天继续执行" };
        },
      };
    },
  });

  try {
    const threadId = "thread-chat-managed-service-optional-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "进程可选增强",
      threadType: "chat",
    });
    assert.equal(createThreadRes.status, 200);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-managed-service-optional-1",
      text: "帮我看一下这个本地健康检查命令为什么没启动起来。",
    });
    assert.equal(sendRes.status, 200);
    await harness.flushAsync();

    assert.equal(sendInputs.length, 1);
    assert.equal(sendInputs[0]?.toolRegistry, null);
    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.completed"), true);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 在 thread 已运行时直接拒绝第二次发送，且不制造短命 turn", async () => {
  const harness = createApiHarness({ ok: true }, { hasActiveTurn: true });

  try {
    const threadId = "thread-chat-active-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "运行中会话",
      threadType: "chat",
    });
    assert.equal(createThreadRes.status, 200);

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-chat-active-1",
      text: "这次发送应该被拒绝",
    });
    assert.equal(sendRes.status, 409);
    assert.equal(String(sendRes.body.message ?? ""), "当前线程仍有未完成的 AI 回合，请等待本轮完成后再发送。");
    assert.equal(harness.getSendMessageCalls(), 0);

    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.started"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest 忽略仅存于 DB 的 started turn 并正常发送", async () => {
  const harness = createApiHarness({ ok: true });

  try {
    const threadId = "thread-chat-stale-db-turn";
    const staleTurnId = "turn-stale-db-only";
    const activeTurnQueries: Array<{ workspaceId?: WorkspaceId | null; threadId: string; includeDb?: boolean }> = [];
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "仅数据库残留运行态",
      threadType: "chat",
    });
    assert.equal(createThreadRes.status, 200);
    harness.db.turns.insertStarted({
      workspaceId: harness.workspaceId,
      threadId: threadId as any,
      engine: "codex",
      turnId: staleTurnId as any,
      startedAt: 123,
      startEventSeq: 1,
    });
    harness.ctx.getActiveThreadTurn = (input) => {
      activeTurnQueries.push({ ...input, threadId: String(input.threadId) });
      if (input.includeDb === false) return null;
      const staleTurn = harness.db.turns.get(staleTurnId as any);
      return staleTurn?.status === "started"
        ? { turnId: staleTurn.turnId, startedAt: staleTurn.startedAt, source: "db" }
        : null;
    };

    assert.equal(harness.ctx.getActiveThreadTurn({
      workspaceId: harness.workspaceId,
      threadId: threadId as any,
    })?.turnId, staleTurnId);
    activeTurnQueries.length = 0;

    const sendRes = await harness.call("threads.sendMessage", {
      workspaceId: harness.workspaceId,
      threadId,
      turnId: "turn-after-stale-db-only",
      text: "继续正常发送",
    });
    assert.equal(sendRes.status, 200);
    await harness.flushAsync();

    assert.equal(harness.getSendMessageCalls(), 1);
    assert.deepEqual(activeTurnQueries, [{
      workspaceId: harness.workspaceId,
      threadId,
      includeDb: false,
    }]);
    assert.equal(harness.db.turns.get(staleTurnId as any)?.status, "started");
    assert.equal(harness.db.turns.get(staleTurnId as any)?.endedAt, null);
  } finally {
    harness.cleanup();
  }
});

test("orch.requirementAnalysis.messages.send 在会话运行中返回 409，且不制造短命 turn", async () => {
  const harness = createApiHarness({ ok: true }, { hasActiveTurn: true });

  try {
    const threadId = "thread-analysis-active-1";
    const createThreadRes = await harness.call("threads.create", {
      workspaceId: harness.workspaceId,
      threadId,
      engine: "codex",
      title: "运行中需求分析",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    assert.equal(createThreadRes.status, 200);

    const createSessionRes = await harness.call("orch.requirementAnalysis.sessions.create", {
      workspaceId: harness.workspaceId,
      threadId,
      title: "运行中需求分析",
    });
    assert.equal(createSessionRes.status, 200);

    const sendRes = await harness.call("orch.requirementAnalysis.messages.send", {
      workspaceId: harness.workspaceId,
      sessionId: threadId,
      text: "这次发送应该被拒绝",
    });
    assert.equal(sendRes.status, 409);
    assert.equal(String(sendRes.body.message ?? ""), "当前线程仍有未完成的 AI 回合，请等待本轮完成后再发送。");
    assert.equal(harness.getSendMessageCalls(), 0);

    const events = harness.db.conversationEvents.listByThread(threadId as any);
    assert.equal(events.some((event) => event.type === "turn.started"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});



