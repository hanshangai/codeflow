import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type ConversationEventInput,
  type RawEngineEventInput,
  type RequirementCandidateId,
  type ThreadId,
  type WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import {
  createClientDbOrchAssetLegacyRuntimeReader,
  OrchAssetAuthorityRuntimeReadService,
} from "../../apps/desktop/client/src/orchestration/orchAssetAuthorityRuntimeReadService.ts";
import { RequirementAnalysisService } from "../../apps/desktop/client/src/orchestration/requirementAnalysisService.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";

type MockRequirementAnalysisResponse = unknown | ((input: any) => unknown | Promise<unknown>);

/** 构造需求分析服务测试夹具，opts 只覆盖当前用例关心的角色与运行态字段。 */
function createHarness(
  responsePayload: MockRequirementAnalysisResponse | MockRequirementAnalysisResponse[],
  opts?: {
    hasActiveTurn?: boolean;
    roleName?: string;
    roleDescription?: string;
    roleResponsibility?: string;
    roleSystemPrompt?: string;
    roleOutputResultKey?: string | null;
    assetAuthorityMode?: "legacy" | "server";
    assetReadError?: Error;
    assistantCompletedPhase?: "commentary" | "final_answer" | "structured_result";
    prepareAssistantTerminalEvents?: (input: {
      turnId: string;
      outcome: "completed" | "error";
    }, ctx: {
      workspaceId: WorkspaceId;
      threadId: ThreadId;
      lastResponseText: string | null;
    }) => Promise<{ events: ConversationEventInput[]; latestAssistantText: string | null }>
      | { events: ConversationEventInput[]; latestAssistantText: string | null };
  },
) {
  initializeLocalEngineModelCatalog();
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-req-analysis-"));
  const workspaceId = "ws-req-analysis" as WorkspaceId;
  const dbPath = path.join(workspacePath, "client.db");
  const db = openClientDb({ dbPath });
  const threads = new ThreadStore();
  const responseQueue = Array.isArray(responsePayload) ? [...responsePayload] : [responsePayload];
  let responseIndex = 0;
  let threadIndex = 0;
  let conversationSeq = 0;
  let rawSeq = 0;
  const sentInputs: any[] = [];
  const toolResults: any[] = [];
  let lastResponseText: string | null = null;
  const roleOutputDefinition = createDefaultRoleOutputDefinition();

  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  const workspaceDb = db.forWorkspace(workspaceId);
  const role = workspaceDb.orchRoles.upsert({
    id: "role-ui" as any,
    workspaceId,
    name: opts?.roleName ?? "前端实现",
    description: opts?.roleDescription ?? "负责页面实现",
    responsibility: opts?.roleResponsibility ?? "完成页面开发",
    systemPrompt: opts?.roleSystemPrompt ?? "您是前端实现角色",
    inputDefinition: createDefaultRoleInputDefinition(),
    outputDefinition: {
      ...roleOutputDefinition,
      resultKey: opts?.roleOutputResultKey ?? roleOutputDefinition.resultKey,
    },
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    defaultKnowledgeBundleIds: ["kb-ui" as any],
    toolRefs: [],
    kind: "custom",
  });
  const bundle = workspaceDb.orchKnowledgeBundles.upsert({
    id: "kb-ui" as any,
    workspaceId,
    name: "前端知识库",
    scope: "shared",
    description: "页面规范与组件约束",
    sourceRefs: [],
  });
  const workflow = workspaceDb.orchWorkflows.upsert({
    id: "wf-standard" as any,
    workspaceId,
    family: "feature-dev",
    name: "CodeFlow 标准功能开发",
    description: "适合标准页面功能",
    workflowKnowledgeBundleIds: [bundle.id],
    nodes: [
      {
        id: "node-ui",
        type: "role",
        roleId: role.id,
        label: "页面实现",
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    version: 1,
  });
  const assetReadCalls: string[] = [];
  const orchAssetRuntimeRead = opts?.assetAuthorityMode === "server"
    ? {
      /** Opens one fake Server authority session around the harness's immutable asset fixtures. */
      openWorkspace(runtimeWorkspaceId: WorkspaceId) {
        assetReadCalls.push(`open:${runtimeWorkspaceId}`);
        return {
          authorityMode: "server" as const,
          listAssets() { return []; },
          getAsset(assetType: "role" | "workflow", assetId: string) {
            assetReadCalls.push(`get:${assetType}:${assetId}`);
            if (opts.assetReadError) throw opts.assetReadError;
            const definition = assetType === "workflow" && assetId === workflow.id
              ? workflow
              : assetType === "role" && assetId === role.id
                ? role
                : null;
            if (!definition) return null;
            const { createdAt: _createdAt, updatedAt: _updatedAt, ...runtimeDefinition } = definition;
            return {
              assetType,
              assetId,
              definition: runtimeDefinition,
              source: {
                authorityMode: "server" as const,
                metadata: {
                  revision: 1,
                  scopeType: "user" as const,
                  syncChangeSeq: 7,
                  contentHash: "a".repeat(64),
                  cacheStatus: "ready" as const,
                },
              },
            };
          },
          getServerReadinessRequirement() {
            return {
              context: { contextKey: "context-1", runtimeWorkspaceId },
              authorityEpoch: 2,
              requiredChangeSeq: 7,
            };
          },
        } as any;
      },
    }
    : new OrchAssetAuthorityRuntimeReadService(
      createClientDbOrchAssetLegacyRuntimeReader(workspaceDb),
      {
        listAssets() { throw new Error("legacy harness must not read Server cache"); },
        getAsset() { throw new Error("legacy harness must not read Server cache"); },
      } as any,
      { getRuntimeReadinessRequirement: () => null },
    );

  const sessions = {
    getOrCreate(thread: { threadId: string }) {
      threads.setSessionId(thread.threadId as any, "engine-session-1" as any);
      return {
        hasActiveTurn() {
          return Boolean(opts?.hasActiveTurn);
        },
        resolvePlatformToolTransport() {
          return "native-dynamic" as const;
        },
        sendMessage: async (input: any, emitters: any) => {
          sentInputs.push(input);
          let nextPayload: unknown = "";
          let responseText = "";
          while (true) {
            const queuedPayload = responseQueue[Math.min(responseIndex, responseQueue.length - 1)];
            responseIndex += 1;
            nextPayload = typeof queuedPayload === "function" ? await queuedPayload(input) : queuedPayload;
            responseText = typeof nextPayload === "string"
              ? nextPayload
              : String((nextPayload as any)?.assistantReply ?? JSON.stringify(nextPayload));
            lastResponseText = responseText;
            emitters?.raw?.({
              ts: Date.now(),
              workspaceId,
              threadId: thread.threadId as any,
              engine: "codex",
              source: "test.requirement-analysis",
              data: { responseText },
            });
            if (typeof nextPayload === "string" || !input.executeHostTool) break;
            const toolResult = await input.executeHostTool({
              toolId: "runtime.submitRequirementAnalysisTurnResult",
              toolInput: nextPayload,
              accessMode: input.accessMode ?? "read-only",
            });
            toolResults.push(toolResult);
            if (toolResult?.ok !== false || responseIndex >= responseQueue.length) break;
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
              text: responseText,
              revision: 0,
              phase: opts?.assistantCompletedPhase ?? (typeof nextPayload === "string" ? "final_answer" : "commentary"),
              completionSource: "provider",
            },
          });
          return { responseText };
        },
        prepareAssistantTerminalEvents: async (input: { turnId: string; outcome: "completed" | "error" }) => {
          if (opts?.prepareAssistantTerminalEvents) {
            return await opts.prepareAssistantTerminalEvents(input, {
              workspaceId,
              threadId: thread.threadId as any,
              lastResponseText,
            });
          }
          return {
            events: [],
            latestAssistantText: lastResponseText,
          };
        },
      };
    },
  } as any;

  const service = new RequirementAnalysisService({
    db: workspaceDb,
    orchAssetRuntimeRead,
    threads,
    sessions,
    workspaces: new Map([[workspaceId, workspacePath]]),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation: (event: ConversationEventInput) => {
      const ts = Number(event.ts ?? Date.now());
      workspaceDb.conversationEvents.appendEnvelope({
        ...event,
        ts,
        seq: ++conversationSeq,
      } as any);
      workspaceDb.threads.touch(event.threadId, ts);
    },
    emitRaw: (event: RawEngineEventInput) => {
      workspaceDb.rawEvents.appendEnvelope({
        ...event,
        ts: Number(event.ts ?? Date.now()),
        seq: ++rawSeq,
      } as any);
    },
  });

  function createAnalysisThread(title = "需求分析会话"): ThreadId {
    threadIndex += 1;
    return workspaceDb.threads.create({
      id: `thread-analysis-${threadIndex}` as ThreadId,
      workspaceId,
      engine: "codex",
      title,
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    }).id;
  }

  return {
    db: workspaceDb,
    service,
    workflow,
    role,
    bundle,
    workspaceId,
    sentInputs,
    assetReadCalls,
    toolResults,
    createAnalysisThread,
    cleanup() {
      resetEngineModelCatalogRuntimeForTest();
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

function buildSizeAssessment(summary: string, overrides?: Partial<{
  functionalProcessCount: number;
  domainEntityCount: number;
  stateTransitionCount: number;
  interactionSurfaceCount: number;
  externalIntegrationCount: number;
  asyncConsistencyRiskCount: number;
  clientSurfaceCount: number;
}>) {
  return {
    model: "functional-size-v2" as const,
    summary,
    reasoning: "按功能过程、领域对象、状态流转、交互界面、外部集成、异步一致性风险和交付端面综合估算。",
    signals: {
      functionalProcessCount: overrides?.functionalProcessCount ?? 3,
      domainEntityCount: overrides?.domainEntityCount ?? 2,
      stateTransitionCount: overrides?.stateTransitionCount ?? 1,
      interactionSurfaceCount: overrides?.interactionSurfaceCount ?? 3,
      externalIntegrationCount: overrides?.externalIntegrationCount ?? 0,
      asyncConsistencyRiskCount: overrides?.asyncConsistencyRiskCount ?? 0,
      clientSurfaceCount: overrides?.clientSurfaceCount ?? 2,
    },
  };
}

function buildPhasingAssessment(summary: string, overrides?: Partial<{
  scopeDecision: "fit" | "needs-split";
  deliverySlice: "single-phase" | "phase-1" | "follow-up";
  benefitHypothesisCount: number;
  acceptanceLoopCount: number;
  actorSurfaceCount: number;
  externalSystemCount: number;
  newCoreModelCount: number;
  outOfScope: string[];
}>) {
  return {
    model: "mmf-phase-gate-v2" as const,
    scopeDecision: overrides?.scopeDecision ?? "fit",
    deliverySlice: overrides?.deliverySlice ?? "single-phase",
    summary,
    reasoning: "先判断是否只验证一个核心价值假设和一个独立验收闭环，再决定是否需要拆一期/后续。",
    signals: {
      benefitHypothesisCount: overrides?.benefitHypothesisCount ?? 1,
      acceptanceLoopCount: overrides?.acceptanceLoopCount ?? 1,
      actorSurfaceCount: overrides?.actorSurfaceCount ?? 1,
      externalSystemCount: overrides?.externalSystemCount ?? 0,
      newCoreModelCount: overrides?.newCoreModelCount ?? 0,
    },
    outOfScope: overrides?.outOfScope ?? [],
  };
}

/** Builds a valid candidate tool payload so retry tests can focus on malformed container shapes. */
function buildRequirementCandidatePayload(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "order-page",
    title: "响应式订单页静态实现",
    goal: "做一个订单页，先用静态数据展示，同时兼顾 PC 和手机浏览。",
    background: "先验证页面形态，不接真实接口。",
    acceptanceCriteria: [{ text: "页面支持 PC 和手机访问" }],
    splitSource: "single",
    complexity: "standard",
    uiScope: "light",
    architectureRisk: "low",
    recommendedWorkflowId: "wf-standard",
    recommendedWorkflowName: "CodeFlow 标准功能开发",
    recommendedWorkflowReason: "需要独立 UI 环节收口页面范围。",
    recommendedApproach: "建议先按一个响应式页面收口，确认字段和交互后再进入正式创建。",
    recommendedRoleIds: ["role-ui"],
    recommendedKnowledgeBundleIds: ["kb-ui"],
    phasingAssessment: buildPhasingAssessment("订单页候选本身就是一个可独立验收的单阶段页面闭环。"),
    sizeAssessment: buildSizeAssessment("订单页属于中型需求，需要兼顾双端展示与交互。"),
    assetGaps: [],
    clarificationItems: [],
    assumptions: [],
    openQuestions: [],
    readyToCreate: true,
    ...overrides,
  };
}

/** Extracts the v2 candidate-set hash from the generated model prompt. */
function extractCandidateSetHash(input: any): string {
  const match = /当前候选集合 hash：([a-f0-9]+)/.exec(String(input?.text ?? ""));
  assert.ok(match?.[1], "prompt should include candidate set hash");
  return match[1];
}

/** Extracts the first persisted candidateId from the generated model prompt. */
function extractFirstCandidateId(input: any): RequirementCandidateId {
  const match = /"candidateId":"([^"]+)"/.exec(String(input?.text ?? ""));
  assert.ok(match?.[1], "prompt should include candidateId");
  return match[1] as RequirementCandidateId;
}

function buildRequirementPatchPayload(
  input: any,
  candidateMutations: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: "requirement-analysis-assistant/v2",
    baseCandidateSetHash: extractCandidateSetHash(input),
    phase: "recommend",
    conversationSummary: "按本轮反馈更新候选需求。",
    assistantReply: "已按本轮反馈更新候选需求。",
    needUserInput: false,
    questions: [],
    candidateMutations,
    nextAction: { type: "review-candidates", targetCandidateIds: [], note: null },
    ...overrides,
  };
}

test("RequirementAnalysisService 以 requirement-analysis thread 为主线持久化会话与消息", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "已拆分为两条页面需求",
    assistantReply: "我已经拆出首页和详情页两条需求，均可进入创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      {
        candidateId: "home",
        title: "第1期-鲜花市场首页",
        goal: "实现鲜花市场首页，支持 PC 与移动端浏览",
        background: "用于鲜花市场展示入口。",
        acceptanceCriteria: [{ text: "页面支持 PC 与移动端适配" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "这是典型的标准页面功能开发。",
        recommendedApproach: "建议先按首页单页收口，确认核心模块和响应式表现，再进入正式创建。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("首页候选本身就是一个可独立验收的单阶段页面闭环。"),
        sizeAssessment: buildSizeAssessment("首页属于中型页面需求，需要兼顾多端展示和主视觉模块。"),
        assetGaps: [],
        clarificationItems: [],
        assumptions: ["视觉素材后补"],
        openQuestions: [],
        readyToCreate: true,
      },
      {
        candidateId: "detail",
        title: "第2期-鲜花详情页",
        goal: "实现鲜花详情页，展示商品信息与购买入口",
        background: "承接首页点击后的详情浏览。",
        acceptanceCriteria: [{ text: "详情页展示商品图片、价格、简介" }],
        splitSource: "split-from-batch",
        complexity: "standard",
        uiScope: "light",
        architectureRisk: "low",
        recommendedWorkflowId: "CodeFlow 标准功能开发",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "同样属于标准页面功能开发。",
        recommendedApproach: "建议把详情页单独作为一条页面需求推进，先锁定展示信息和购买入口。",
        recommendedRoleIds: ["前端实现"],
        recommendedKnowledgeBundleIds: ["前端知识库"],
        phasingAssessment: buildPhasingAssessment("详情页候选本身就是一个可独立验收的单阶段页面闭环。"),
        sizeAssessment: buildSizeAssessment("详情页属于中型页面需求，信息展示和购买引导较集中。"),
        assetGaps: [],
        clarificationItems: [],
        assumptions: [],
        openQuestions: [],
        readyToCreate: true,
      },
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["home", "detail"],
      note: "可以直接创建两条需求。",
    },
  });

  try {
    const threadId = harness.createAnalysisThread("首页需求梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "我要做鲜花市场首页和详情页",
    });

    assert.equal(created.session.id, threadId);
    assert.equal(result.session.engineSessionId, "engine-session-1");
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0]?.recommendedWorkflowId, harness.workflow.id);
    assert.equal(result.candidates[1]?.recommendedWorkflowId, harness.workflow.id);

    const persistedThreads = harness.db.threads.listByWorkspace(harness.workspaceId, { includeArchived: true }).threads;
    assert.equal(persistedThreads.length, 1);
    assert.equal(persistedThreads[0]?.threadSubtype, "requirement-analysis");

    const assistantEvents = harness.db.conversationEvents
      .listByThread(threadId)
      .filter((event) => event.type === "item.agentMessage.completed");
    const startedAssistantEvents = harness.db.conversationEvents
      .listByThread(threadId)
      .filter((event) => event.type === "item.agentMessage.started");
    assert.equal(assistantEvents.length, 2);
    assert.equal(startedAssistantEvents.length, 0);
    assert.equal(assistantEvents[1]?.payload.phase, "structured_result");
    assert.equal(String(assistantEvents[1]?.payload.text ?? ""), "我已经拆出首页和详情页两条需求，均可进入创建。");
    assert.equal(
      String(assistantEvents[1]?.payload.text ?? "").includes("\"schemaVersion\""),
      false,
    );
    assert.equal(harness.db.orchRequirementAnalysisMessages.listBySession(threadId as any).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 重新读取候选时保留模型输出顺序", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "已按模型输出顺序拆出三条候选",
    assistantReply: "我已经按当前拆分顺序整理出三条候选需求。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "b-second",
        title: "第1期-第二条展示候选",
        goal: "第二条展示候选应保持在第一位。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "a-first",
        title: "第2期-第一条展示候选",
        goal: "第一条展示候选虽然 ID 更靠前，但应保持在第二位。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "c-third",
        title: "第3期-第三条展示候选",
        goal: "第三条展示候选应保持在第三位。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["b-second", "a-first", "c-third"],
      note: "可以直接创建三条需求。",
    },
  });

  try {
    const threadId = harness.createAnalysisThread("顺序验证需求梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请按第二、第一、第三这个顺序拆三条需求",
    });

    const reloaded = harness.service.getSession(harness.workspaceId, created.session.id);
    assert.deepEqual(reloaded?.candidates.map((item) => item.title), [
      "第1期-第二条展示候选",
      "第2期-第一条展示候选",
      "第3期-第三条展示候选",
    ]);
    assert.deepEqual(reloaded?.candidates.map((item) => item.displayOrder), [0, 1, 2]);
  } finally {
    Date.now = originalNow;
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会在同一 provider turn 内修正不符合期次格式的标题", async () => {
  const invalidPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "已拆出两条候选但标题缺少期次",
    assistantReply: "我已经拆出两条候选需求。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "home",
        title: "鲜花市场首页",
        goal: "实现鲜花市场首页。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "detail",
        title: "鲜花详情页",
        goal: "实现鲜花详情页。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["home", "detail"],
      note: "可以直接创建两条需求。",
    },
  };
  const validPayload = {
    ...invalidPayload,
    conversationSummary: "已按期次格式拆出两条候选",
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "home",
        title: "第1期-鲜花市场首页",
        goal: "实现鲜花市场首页。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "detail",
        title: "第2期-鲜花详情页",
        goal: "实现鲜花详情页。",
      }),
    ],
  };
  const harness = createHarness([invalidPayload, validPayload]);

  try {
    const threadId = harness.createAnalysisThread("标题格式校验");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请拆首页和详情页两期需求",
    });

    assert.equal(harness.sentInputs.length, 1);
    assert.match(String(harness.toolResults[0]?.message ?? ""), /多候选时必须使用“第1期-标题”格式/);
    assert.match(String(harness.toolResults[0]?.message ?? ""), /候选“鲜花市场首页”标题格式不合规/);
    assert.deepEqual(result.candidates.map((candidate) => candidate.title), [
      "第1期-鲜花市场首页",
      "第2期-鲜花详情页",
    ]);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会拒绝不适合作为目录名的候选标题", async () => {
  const invalidPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "单条候选标题包含路径非法字符",
    assistantReply: "订单页候选已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "order-page",
        title: "订单页:移动端",
        goal: "实现移动端订单页。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["order-page"],
      note: "可以直接创建需求。",
    },
  };
  const validPayload = {
    ...invalidPayload,
    conversationSummary: "单条候选标题已改为路径安全格式",
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "order-page",
        title: "订单页移动端",
        goal: "实现移动端订单页。",
      }),
    ],
  };
  const harness = createHarness([invalidPayload, validPayload]);

  try {
    const threadId = harness.createAnalysisThread("目录安全标题校验");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请整理移动端订单页需求",
    });

    assert.equal(harness.sentInputs.length, 1);
    assert.match(String(harness.toolResults[0]?.message ?? ""), /标题包含路径非法字符/);
    assert.equal(result.candidates[0]?.title, "订单页移动端");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会拒绝缺少原始 title 的候选标题", async () => {
  const missingTitleCandidate = buildRequirementCandidatePayload({
    candidateId: "order-page",
    goal: "实现移动端订单页。",
  });
  delete (missingTitleCandidate as any).title;

  const invalidPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "单条候选缺少标题",
    assistantReply: "订单页候选已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [missingTitleCandidate],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["order-page"],
      note: "可以直接创建需求。",
    },
  };
  const validPayload = {
    ...invalidPayload,
    conversationSummary: "单条候选已补齐标题",
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "order-page",
        title: "订单页移动端",
        goal: "实现移动端订单页。",
      }),
    ],
  };
  const harness = createHarness([invalidPayload, validPayload]);

  try {
    const threadId = harness.createAnalysisThread("缺少标题校验");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请整理移动端订单页需求",
    });

    assert.equal(harness.sentInputs.length, 1);
    assert.match(String(harness.toolResults[0]?.message ?? ""), /缺少 candidate\.title/);
    assert.match(String(harness.toolResults[0]?.message ?? ""), /不能省略或用 goal 兜底/);
    assert.equal(result.candidates[0]?.title, "订单页移动端");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会拒绝 Windows 保留目录名候选标题", async () => {
  const invalidPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "单条候选标题使用 Windows 保留名",
    assistantReply: "订单页候选已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "order-page",
        title: "CON",
        goal: "实现移动端订单页。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["order-page"],
      note: "可以直接创建需求。",
    },
  };
  const validPayload = {
    ...invalidPayload,
    conversationSummary: "单条候选标题已改为安全目录名",
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "order-page",
        title: "订单页移动端",
        goal: "实现移动端订单页。",
      }),
    ],
  };
  const harness = createHarness([invalidPayload, validPayload]);

  try {
    const threadId = harness.createAnalysisThread("保留目录名校验");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请整理移动端订单页需求",
    });

    assert.equal(harness.sentInputs.length, 1);
    assert.match(String(harness.toolResults[0]?.message ?? ""), /Windows 保留设备名/);
    assert.equal(result.candidates[0]?.title, "订单页移动端");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 标题期次校验会跳过已创建历史候选", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "首页候选已经可以创建",
    assistantReply: "首页需求已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "home",
        title: "鲜花市场首页",
        goal: "实现鲜花市场首页。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["home"],
      note: "可以创建首页需求。",
    },
  };
  const secondPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "首页已创建，继续补充详情页候选",
    assistantReply: "首页已创建，这轮新增详情页候选。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "home",
        title: "鲜花市场首页",
        goal: "实现鲜花市场首页。",
        readyToCreate: true,
      }),
      buildRequirementCandidatePayload({
        candidateId: "detail",
        title: "鲜花详情页",
        goal: "实现鲜花详情页。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["detail"],
      note: "可以创建详情页需求。",
    },
  };
  const harness = createHarness([firstPayload, secondPayload]);

  try {
    const threadId = harness.createAnalysisThread("历史候选标题校验");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const firstResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请先整理鲜花市场首页需求",
    });
    const createdCandidateId = firstResult.candidates[0]?.id as RequirementCandidateId;
    harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [createdCandidateId],
    });

    const secondResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "首页已创建，继续整理详情页",
    });

    assert.equal(harness.sentInputs.length, 2);
    assert.deepEqual(secondResult.candidates.map((candidate) => candidate.title), [
      "鲜花详情页",
      "鲜花市场首页",
    ]);
    assert.equal(secondResult.candidates[0]?.creationState, "draft");
    assert.equal(secondResult.candidates[1]?.creationState, "created");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 多条后续候选会从已创建历史期次后继续校验", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "推广基础配置已经可以创建",
    assistantReply: "推广基础配置需求已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "promo-base",
        title: "推广基础配置",
        goal: "实现推广基础数据与比例配置管理。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["promo-base"],
      note: "可以创建推广基础配置需求。",
    },
  };
  const secondPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "第一期已创建，继续从第二期规划后续推广能力",
    assistantReply: "第一期已创建，这轮从第二期开始规划后续候选。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "promo-attribution",
        title: "第2期-推广码注册归因",
        goal: "实现推广码注册归因关系记录与查询。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "recharge-reward",
        title: "第3期-受邀充值配置化奖励",
        goal: "实现受邀用户充值后的配置化奖励规则。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["promo-attribution", "recharge-reward"],
      note: "可以创建第二期和第三期需求。",
    },
  };
  const harness = createHarness([firstPayload, secondPayload]);

  try {
    const threadId = harness.createAnalysisThread("后续期次标题校验");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const firstResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请先整理推广基础配置需求",
    });
    const createdCandidateId = firstResult.candidates[0]?.id as RequirementCandidateId;
    harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [createdCandidateId],
    });

    const secondResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "第一期已创建，从第二期开始重新规划后续推广需求",
    });

    assert.equal(harness.sentInputs.length, 2);
    assert.deepEqual(secondResult.candidates.map((candidate) => candidate.title), [
      "第2期-推广码注册归因",
      "第3期-受邀充值配置化奖励",
      "推广基础配置",
    ]);
    assert.deepEqual(secondResult.candidates.map((candidate) => candidate.creationState), [
      "draft",
      "draft",
      "created",
    ]);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会拒绝遗漏已有草稿候选的增量提交", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "split",
    conversationSummary: "推广能力已拆成两个草稿候选",
    assistantReply: "已拆出推广码注册归因和充值奖励两个候选。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "referral-attribution",
        title: "第1期-推广码注册归因",
        goal: "实现推广码生成、注册填写邀请码和邀请关系归因。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "recharge-reward",
        title: "第2期-受邀充值奖励",
        goal: "实现受邀用户充值后给邀请人发放配置化奖励。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["referral-attribution", "recharge-reward"],
      note: "两个候选都可创建。",
    },
  };
  const incrementalOnlyPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "recommend",
    conversationSummary: "补充 Portal 额度页面候选",
    assistantReply: "建议补一个 Portal 推广额度页面。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "portal-quota-page",
        title: "Portal推广额度页面",
        goal: "在 Portal 侧展示推广额度余额、来源和明细。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["portal-quota-page"],
      note: "Portal 页面可创建。",
    },
  };
  const repairedPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "split",
    conversationSummary: "补充 Portal 候选并保留原有两个草稿候选",
    assistantReply: "已保留原有推广码注册归因和充值奖励候选，并补充 Portal 推广额度页面。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "referral-attribution",
        title: "第1期-推广码注册归因",
        goal: "实现推广码生成、注册填写邀请码和邀请关系归因。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "recharge-reward",
        title: "第2期-受邀充值奖励",
        goal: "实现受邀用户充值后给邀请人发放配置化奖励。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "portal-quota-page",
        title: "第3期-Portal推广额度页面",
        goal: "在 Portal 侧展示推广额度余额、来源和明细。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["referral-attribution", "recharge-reward", "portal-quota-page"],
      note: "三个候选都可创建。",
    },
  };
  const harness = createHarness([firstPayload, incrementalOnlyPayload, repairedPayload]);

  try {
    const threadId = harness.createAnalysisThread("推广候选遗漏保护");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请拆推广注册和充值奖励需求。",
    });

    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "Portal 页面是不是也要有推广相关页面？",
    });

    assert.equal(harness.sentInputs.length, 2);
    assert.match(String(harness.toolResults[1]?.message ?? ""), /遗漏了已有草稿候选/);
    assert.deepEqual(result.candidates.map((candidate) => candidate.title), [
      "第1期-推广码注册归因",
      "第2期-受邀充值奖励",
      "第3期-Portal推广额度页面",
    ]);
    assert.equal(
      result.candidates.find((candidate) => candidate.title === "第3期-Portal推广额度页面")?.id,
      `${created.session.id}:portal-quota-page`,
    );
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService v2 create mutation 新增候选时保留既有草稿", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "split",
    conversationSummary: "推广能力已拆成两个草稿候选",
    assistantReply: "已拆出推广码注册归因和充值奖励两个候选。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "referral-attribution",
        title: "第1期-推广码注册归因",
        goal: "实现推广码生成、注册填写邀请码和邀请关系归因。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "recharge-reward",
        title: "第2期-受邀充值奖励",
        goal: "实现受邀用户充值后给邀请人发放配置化奖励。",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["referral-attribution", "recharge-reward"],
      note: "两个候选都可创建。",
    },
  };
  const harness = createHarness([
    firstPayload,
    (input: any) => buildRequirementPatchPayload(input, [{
      op: "create",
      candidateId: "portal-quota-page",
      candidate: buildRequirementCandidatePayload({
        candidateId: "portal-quota-page",
        title: "第3期-Portal推广额度页面",
        goal: "在 Portal 侧展示推广额度余额、来源和明细。",
      }),
    }], {
      conversationSummary: "补充 Portal 候选并由平台保留原有两个草稿候选",
      assistantReply: "已补充 Portal 推广额度页面，原有两个候选保持不变。",
    }),
  ]);

  try {
    const threadId = harness.createAnalysisThread("推广候选 v2 patch");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请拆推广注册和充值奖励需求。",
    });

    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "Portal 页面是不是也要有推广相关页面？",
    });

    assert.equal(result.payload.schemaVersion, "requirement-analysis-assistant/v2");
    assert.equal(result.payload.candidateMutations?.length, 1);
    assert.ok(result.payload.candidateSetHash);
    assert.deepEqual(result.candidates.map((candidate) => candidate.title), [
      "第1期-推广码注册归因",
      "第2期-受邀充值奖励",
      "第3期-Portal推广额度页面",
    ]);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService v2 update mutation 只修改目标候选", async () => {
  const clarificationItem = {
    question: "订单页是否需要导出？",
    reason: "需要确认当前验收边界。",
    suggestion: "请说明是否纳入本期。",
    impact: "scope",
    options: [{ id: "no-export", label: "不纳入", value: "本期不做导出。", recommended: true }],
    allowCustom: true,
    answerPlaceholder: "补充边界。",
  };
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "clarify",
    conversationSummary: "订单页仍需澄清导出边界",
    assistantReply: "订单页候选还需要确认导出边界。",
    needUserInput: true,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "order-page",
        title: "第1期-响应式订单页静态实现",
        readyToCreate: false,
        clarificationItems: [clarificationItem],
      }),
      buildRequirementCandidatePayload({
        candidateId: "order-summary",
        title: "第2期-订单汇总页",
        goal: "展示订单汇总统计。",
      }),
    ],
    nextAction: { type: "wait-user-reply", targetCandidateIds: ["order-page"], note: "等待用户确认导出边界。" },
  };
  const harness = createHarness([
    firstPayload,
    (input: any) => {
      return buildRequirementPatchPayload(input, [{
        op: "update",
        candidateId: "order-page",
        patch: {
          clarificationItems: [],
          openQuestions: ["后续可单独考虑订单导出。"],
          readyToCreate: true,
          recommendedApproach: "本期先收口响应式订单页静态展示，导出能力后续单独拆分。",
        },
      }], {
        assistantReply: "已将订单导出调整为后续问题，订单页候选可以创建。",
      });
    },
  ]);

  try {
    const threadId = harness.createAnalysisThread("订单页 v2 update");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "先整理订单页和汇总页。",
    });

    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "导出先不做，后续再说。",
    });

    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0]?.title, "第1期-响应式订单页静态实现");
    assert.equal(result.candidates[0]?.readyToCreate, true);
    assert.deepEqual(result.candidates[0]?.clarificationItems, []);
    assert.equal(result.candidates[1]?.title, "第2期-订单汇总页");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService v2 delete mutation 只移除草稿候选", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "split",
    conversationSummary: "已有两个草稿候选",
    assistantReply: "已拆出两个候选。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "phase-one",
        title: "第1期-推广码注册归因",
        goal: "实现推广码注册归因。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "phase-two",
        title: "第2期-受邀充值奖励",
        goal: "实现受邀充值奖励。",
      }),
    ],
    nextAction: { type: "review-candidates", targetCandidateIds: ["phase-one", "phase-two"], note: null },
  };
  const harness = createHarness([
    firstPayload,
    (input: any) => buildRequirementPatchPayload(input, [{
      op: "delete",
      candidateId: "phase-one",
      reason: "用户明确取消第一期候选。",
    }], {
      assistantReply: "已移除用户取消的第一期草稿候选。",
    }),
  ]);

  try {
    const threadId = harness.createAnalysisThread("推广候选 v2 delete");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "先拆两个推广候选。",
    });

    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "第一期先不要了。",
    });

    assert.deepEqual(result.candidates.map((candidate) => candidate.title), ["第2期-受邀充值奖励"]);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService v2 mutation 兼容旧数据里的重复会话前缀候选 ID", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "split",
    conversationSummary: "已有两个草稿候选",
    assistantReply: "已拆出两个候选。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "order-page",
        title: "第1期-订单页",
        goal: "实现订单页。",
      }),
      buildRequirementCandidatePayload({
        candidateId: "order-summary",
        title: "第2期-订单汇总",
        goal: "实现订单汇总。",
      }),
    ],
    nextAction: { type: "review-candidates", targetCandidateIds: ["order-page", "order-summary"], note: null },
  };
  const harness = createHarness([
    firstPayload,
    (input: any) => buildRequirementPatchPayload(input, [
      {
        op: "update",
        candidateId: "order-page",
        patch: {
          title: "第1期-订单页与处理状态",
          goal: "实现订单页，并展示处理状态。",
          recommendedApproach: "本期先收口订单页和处理状态展示。",
        },
      },
      {
        op: "delete",
        candidateId: "order-summary",
        reason: "订单汇总本期不做。",
      },
    ], {
      assistantReply: "已更新订单页候选并删除订单汇总候选。",
    }),
  ]);

  try {
    const threadId = harness.createAnalysisThread("旧候选 ID 兼容");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "先拆订单页和订单汇总。",
    });
    const legacyCandidates = harness.db.orchRequirementCandidateDrafts
      .listBySession(created.session.id)
      .map((candidate) => ({
        ...candidate,
        id: `${created.session.id}:${candidate.id}` as RequirementCandidateId,
      }));
    harness.db.orchRequirementCandidateDrafts.replaceForSession(created.session.id, legacyCandidates);

    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "订单汇总先删掉，订单页补处理状态。",
    });

    assert.deepEqual(result.candidates.map((candidate) => candidate.title), ["第1期-订单页与处理状态"]);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService v2 delete mutation 会拒绝已创建候选", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "已有一个可创建候选",
    assistantReply: "已整理订单页候选。",
    needUserInput: false,
    questions: [],
    candidates: [buildRequirementCandidatePayload()],
    nextAction: { type: "ready-to-create", targetCandidateIds: ["order-page"], note: null },
  };
  const harness = createHarness([
    firstPayload,
    (input: any) => buildRequirementPatchPayload(input, [{
      op: "delete",
      candidateId: extractFirstCandidateId(input),
      reason: "尝试删除已创建候选。",
    }], {
      assistantReply: "尝试删除已创建候选。",
    }),
    (input: any) => buildRequirementPatchPayload(input, [], {
      assistantReply: "已保留已创建候选。",
    }),
  ]);

  try {
    const threadId = harness.createAnalysisThread("订单页 v2 delete created");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const firstResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "整理订单页候选。",
    });
    const candidateId = firstResult.candidates[0]?.id as RequirementCandidateId;
    harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [candidateId],
    });

    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "这个已创建候选删掉吧。",
    });

    assert.equal(harness.sentInputs.length, 2);
    assert.match(String(harness.toolResults[1]?.message ?? ""), /不能 delete 已创建候选/);
    assert.equal(result.candidates[0]?.creationState, "created");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 工具冲突后 provider 只输出普通文本时启动修复回合", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "已有一个草稿候选",
    assistantReply: "已整理订单页候选。",
    needUserInput: false,
    questions: [],
    candidates: [buildRequirementCandidatePayload()],
    nextAction: { type: "ready-to-create", targetCandidateIds: ["order-page"], note: null },
  };
  const stalePayload = {
    schemaVersion: "requirement-analysis-assistant/v2",
    baseCandidateSetHash: "000000000000000000000000",
    phase: "recommend",
    conversationSummary: "尝试基于旧候选集合提交",
    assistantReply: "尝试提交。",
    needUserInput: false,
    questions: [],
    candidateMutations: [],
    nextAction: { type: "review-candidates", targetCandidateIds: [], note: null },
  };
  const harness = createHarness([
    firstPayload,
    stalePayload,
    "已统一更新候选并完成本轮分析。",
    (input: any) => buildRequirementPatchPayload(input, [], {
      assistantReply: "已基于最新候选集合重新提交。",
    }),
  ]);

  try {
    const threadId = harness.createAnalysisThread("订单页 v2 conflict");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "整理订单页候选。",
    });

    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "继续确认。",
    });

    assert.equal(harness.sentInputs.length, 3);
    assert.match(String(harness.toolResults[1]?.message ?? ""), /候选集合已变更/);
    const currentHash = extractCandidateSetHash(harness.sentInputs[1]);
    const repairPrompt = String(harness.sentInputs[2]?.userMessage ?? "");
    assert.match(repairPrompt, new RegExp(currentHash));
    assert.match(repairPrompt, /候选集合已变更/);
    assert.match(repairPrompt, /不要只输出普通说明/);
    assert.equal(harness.toolResults[2]?.ok, true);
    assert.equal(result.payload.schemaVersion, "requirement-analysis-assistant/v2");
    assert.equal(result.candidates.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 保持工具 schema 稳定并在每轮 developer prompt 注入精确 hash", async () => {
  const firstPayload = {
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "已整理订单页候选",
    assistantReply: "已整理订单页候选。",
    needUserInput: false,
    questions: [],
    candidates: [buildRequirementCandidatePayload()],
    nextAction: { type: "ready-to-create", targetCandidateIds: ["order-page"], note: null },
  };
  const harness = createHarness([
    firstPayload,
    (input: any) => buildRequirementPatchPayload(input, []),
  ]);

  try {
    const threadId = harness.createAnalysisThread("候选 hash schema");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "整理一个新需求。",
    });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "继续确认。",
    });

    assert.equal(harness.sentInputs.length, 2);
    const firstHash = extractCandidateSetHash(harness.sentInputs[0]);
    const secondHash = extractCandidateSetHash(harness.sentInputs[1]);
    assert.notEqual(firstHash, secondHash);
    const firstTool = harness.sentInputs[0]?.toolRegistry?.tools?.[0];
    const secondTool = harness.sentInputs[1]?.toolRegistry?.tools?.[0];
    assert.equal(firstTool?.inputSchema, secondTool?.inputSchema);
    assert.equal(firstTool?.invocationHint, secondTool?.invocationHint);
    const inputSchema = JSON.parse(String(firstTool?.inputSchema ?? "{}"));
    const hashSchema = inputSchema?.properties?.baseCandidateSetHash;
    assert.equal(hashSchema?.const, undefined);
    assert.equal(hashSchema?.minLength, 24);
    assert.equal(hashSchema?.maxLength, 24);
    assert.equal(hashSchema?.pattern, "^[0-9a-f]{24}$");
    assert.match(String(harness.sentInputs[0]?.developerMessage ?? ""), new RegExp(firstHash));
    assert.match(String(harness.sentInputs[1]?.developerMessage ?? ""), new RegExp(secondHash));
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会在同一 provider turn 内拒绝 64 位候选 hash 并接受修正值", async () => {
  const harness = createHarness([
    (input: any) => ({
      ...buildRequirementPatchPayload(input, []),
      baseCandidateSetHash: `${extractCandidateSetHash(input)}${"0".repeat(40)}`,
    }),
    (input: any) => buildRequirementPatchPayload(input, []),
  ]);

  try {
    const threadId = harness.createAnalysisThread("候选 hash 格式修正");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "整理一个新需求。",
    });

    assert.equal(harness.sentInputs.length, 1);
    assert.equal(harness.toolResults.length, 2);
    assert.equal(harness.toolResults[0]?.ok, false);
    assert.equal(harness.toolResults[0]?.code, "VALIDATION_FAILED");
    assert.match(String(harness.toolResults[0]?.message ?? ""), /必须原样提交当前提示中的 24 位小写十六进制 hash/);
    assert.equal(harness.toolResults[1]?.ok, true);
    assert.equal(result.payload.schemaVersion, "requirement-analysis-assistant/v2");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 连续两次工具校验失败后关闭业务 turn", async () => {
  const harness = createHarness((input: any) => ({
    ...buildRequirementPatchPayload(input, []),
    baseCandidateSetHash: `${extractCandidateSetHash(input)}${"0".repeat(40)}`,
  }));

  try {
    const threadId = harness.createAnalysisThread("候选 hash 格式失败");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await assert.rejects(
      harness.service.sendMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.session.id,
        text: "整理一个新需求。",
      }),
      (error: any) => {
        assert.equal(error?.code, "requirement_analysis_submission_not_accepted");
        assert.match(String(error?.message ?? ""), /baseCandidateSetHash 格式无效/);
        return true;
      },
    );

    assert.equal(harness.sentInputs.length, 2);
    assert.equal(harness.toolResults.length, 2);
    const events = harness.db.conversationEvents.listByThread(threadId);
    assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
    assert.equal(events.filter((event) => event.type === "turn.error").length, 1);
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
    assert.equal(harness.db.orchRequirementCandidateDrafts.listBySession(created.session.id).length, 0);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        harness.db.conversationEvents.listRunningTurnsByWorkspace(harness.workspaceId),
        threadId,
      ),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService prompt模式读取历史时会排除commentary assistant消息", () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "summary",
    assistantReply: "final reply",
    needUserInput: false,
    questions: [],
    candidates: [],
    nextAction: { type: "review-candidates", targetCandidateIds: [], note: null },
  });

  const threadId = harness.createAnalysisThread("过滤 commentary");
  harness.db.conversationEvents.appendEnvelope({
    schema: 1,
    seq: 1,
    ts: 1,
    workspaceId: harness.workspaceId,
    threadId,
    engine: "codex",
    type: "item.agentMessage.completed",
    payload: {
      itemId: "msg-commentary" as any,
      engineMessageId: "msg-commentary",
      text: "过程说明",
      revision: 0,
      phase: "commentary",
    },
  } as any);
  harness.db.conversationEvents.appendEnvelope({
    schema: 1,
    seq: 2,
    ts: 2,
    workspaceId: harness.workspaceId,
    threadId,
    engine: "codex",
    type: "item.agentMessage.completed",
    payload: {
      itemId: "msg-final" as any,
      engineMessageId: "msg-final",
      text: "最终说明",
      revision: 1,
      phase: "structured_result",
      structuredPayloadJson: JSON.stringify({
        schemaVersion: "requirement-analysis-assistant/v1",
        phase: "confirm",
        conversationSummary: "summary",
        assistantReply: "最终说明",
        needUserInput: false,
        questions: [],
        candidates: [],
        nextAction: { type: "review-candidates", targetCandidateIds: [], note: null },
      }),
    },
  } as any);

  const promptMessages = (harness.service as any).readThreadMessages(threadId, { mode: "prompt" });
  assert.deepEqual(
    promptMessages.map((item: any) => item.content),
    ["最终说明"],
  );
  const displayMessages = (harness.service as any).readThreadMessages(threadId, { mode: "display" });
  assert.deepEqual(
    displayMessages.map((item: any) => item.content),
    ["最终说明"],
  );

  harness.cleanup();
});

test("RequirementAnalysisService 不会把 draft assistant completed 释放到 canonical history", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "summary",
    assistantReply: "final requirement analysis reply",
    needUserInput: false,
    questions: [],
    candidates: [],
    nextAction: { type: "review-candidates", targetCandidateIds: [], note: null },
  }, {
    assistantCompletedPhase: "final_answer",
  });

  try {
    const threadId = harness.createAnalysisThread("phase normalization");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请整理需求。",
    });

    const assistantEvents = harness.db.conversationEvents
      .listByThread(threadId)
      .filter((event) => event.type === "item.agentMessage.completed");

    assert.equal(assistantEvents.at(-1)?.payload.phase, "structured_result");
    assert.equal(
      assistantEvents.some((event) => event.payload.phase === "commentary" || event.payload.phase === "final_answer"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService sendMessage 后经 getSession 读取时只返回最终 structured_result，且保留 structuredPayloadJson", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "summary",
    assistantReply: "final requirement analysis reply",
    needUserInput: false,
    questions: [],
    candidates: [],
    nextAction: { type: "review-candidates", targetCandidateIds: [], note: null },
  }, {
    assistantCompletedPhase: "final_answer",
  });

  try {
    const threadId = harness.createAnalysisThread("getSession integration");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请整理需求。",
    });

    const loaded = harness.service.getSession(harness.workspaceId, created.session.id);
    assert.ok(loaded);
    const assistantMessages = loaded!.messages.filter((message) => message.role === "assistant");
    const businessAssistantMessages = assistantMessages.filter((message) => message.content === "final requirement analysis reply");
    assert.equal(businessAssistantMessages.length, 1);
    assert.match(String(businessAssistantMessages[0]?.structuredPayloadJson ?? ""), /requirement-analysis-assistant\/v1/);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会保留一期与后续候选的分期判断", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "split",
    conversationSummary: "已拆成一期和后续两个候选需求",
    assistantReply: "我已经把支付核心闭环拆成一期和后续候选，避免把核心链路和后续商品化混在一起。",
    needUserInput: false,
    questions: [],
    candidates: [
      {
        candidateId: "pay-core",
        title: "第1期-微信支付核心闭环",
        goal: "打通下单、回调、查单和订单终态的最小支付闭环",
        background: "先验证真实支付链路，不引入套餐商品化。",
        acceptanceCriteria: [{ text: "支付主链路可以独立验收" }],
        splitSource: "single",
        complexity: "large",
        uiScope: "light",
        architectureRisk: "high",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "先把核心闭环独立收口。",
        recommendedApproach: "建议先按支付核心闭环推进，把套餐商品化和权益发放后移。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("这条候选适合作为一期 MMF：先完成一个可独立验收的最小闭环。", {
          deliverySlice: "phase-1",
          externalSystemCount: 1,
          newCoreModelCount: 1,
          outOfScope: ["套餐商品化", "订阅权益发放"],
        }),
        sizeAssessment: buildSizeAssessment("支付核心闭环属于大型需求，重点在状态流转、外部集成和异步一致性。", {
          functionalProcessCount: 5,
          domainEntityCount: 5,
          stateTransitionCount: 5,
          interactionSurfaceCount: 2,
          externalIntegrationCount: 1,
          asyncConsistencyRiskCount: 2,
          clientSurfaceCount: 2,
        }),
        assetGaps: [],
        clarificationItems: [],
        assumptions: [],
        openQuestions: [],
        readyToCreate: true,
      },
      {
        candidateId: "pay-packages",
        title: "第2期-支付套餐商品化与权益发放",
        goal: "在支付核心闭环稳定后，补齐套餐、订阅和权益生效规则",
        background: "承接支付主链路之后的业务商品化。",
        acceptanceCriteria: [{ text: "套餐商品化规则可以独立验收" }],
        splitSource: "split-from-batch",
        complexity: "large",
        uiScope: "heavy",
        architectureRisk: "high",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "后续业务商品化仍可单独按标准流程推进。",
        recommendedApproach: "建议等支付核心闭环稳定后，再单独推进套餐商品化和权益发放。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("这条候选属于后续阶段：应建立在前序核心闭环已经打通的前提上推进。", {
          deliverySlice: "follow-up",
          externalSystemCount: 1,
          newCoreModelCount: 2,
        }),
        sizeAssessment: buildSizeAssessment("套餐商品化属于大型需求，重点在领域对象扩展和业务规则。", {
          functionalProcessCount: 4,
          domainEntityCount: 6,
          stateTransitionCount: 4,
          interactionSurfaceCount: 4,
          externalIntegrationCount: 1,
          asyncConsistencyRiskCount: 1,
          clientSurfaceCount: 2,
        }),
        assetGaps: [],
        clarificationItems: [],
        assumptions: [],
        openQuestions: [],
        readyToCreate: true,
      },
    ],
    nextAction: {
      type: "review-candidates",
      targetCandidateIds: ["pay-core", "pay-packages"],
      note: "建议先确认一期与后续的推进顺序。",
    },
  });

  try {
    const threadId = harness.createAnalysisThread("支付需求分期");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "我要做微信支付能力，但感觉这个需求太大，最好先做一期闭环。",
    });

    assert.equal(result.payload.phase, "split");
    assert.deepEqual(result.candidates.map((candidate) => candidate.title), [
      "第1期-微信支付核心闭环",
      "第2期-支付套餐商品化与权益发放",
    ]);
    const phaseOneCandidate = result.candidates.find((candidate) => candidate.title === "第1期-微信支付核心闭环");
    const followUpCandidate = result.candidates.find((candidate) => candidate.title === "第2期-支付套餐商品化与权益发放");
    assert.equal(phaseOneCandidate?.phasingAssessment.deliverySlice, "phase-1");
    assert.equal(followUpCandidate?.phasingAssessment.deliverySlice, "follow-up");
    assert.deepEqual(phaseOneCandidate?.phasingAssessment.outOfScope, ["套餐商品化", "订阅权益发放"]);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 在会话仍运行时拒绝重复发送，且不写入新的 turn.started", async () => {
  const harness = createHarness({ ok: true }, { hasActiveTurn: true });

  try {
    const threadId = harness.createAnalysisThread("运行中需求分析");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await assert.rejects(
      harness.service.sendMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.session.id,
        text: "这次发送应该被拒绝",
      }),
      /当前线程仍有未完成的 AI 回合，请等待本轮完成后再发送。/,
    );

    assert.equal(harness.sentInputs.length, 0);
    const events = harness.db.conversationEvents.listByThread(threadId);
    assert.equal(events.some((event) => event.type === "turn.started"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService listSessions 支持按 updatedAt 游标分页", () => {
  const harness = createHarness({ ok: true });

  try {
    harness.db.threads.create({
      id: "session-a" as ThreadId,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "A",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    harness.db.orchRequirementAnalysisSessions.create({
      id: "session-a" as any,
      workspaceId: harness.workspaceId,
      title: "A",
      status: "active",
      phase: "recommend",
      engine: "codex",
      model: null,
      effort: null,
      runtimeThreadId: null,
      engineSessionId: null,
      latestTurnSummary: "A",
      latestAssistantReply: null,
      lastMessageAt: 300,
    });
    harness.db.threads.create({
      id: "session-b" as ThreadId,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "B",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    harness.db.orchRequirementAnalysisSessions.create({
      id: "session-b" as any,
      workspaceId: harness.workspaceId,
      title: "B",
      status: "active",
      phase: "clarify",
      engine: "codex",
      model: null,
      effort: null,
      runtimeThreadId: null,
      engineSessionId: null,
      latestTurnSummary: "B",
      latestAssistantReply: null,
      lastMessageAt: 200,
    });
    harness.db.threads.create({
      id: "session-c" as ThreadId,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "C",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    harness.db.orchRequirementAnalysisSessions.create({
      id: "session-c" as any,
      workspaceId: harness.workspaceId,
      title: "C",
      status: "active",
      phase: "discover",
      engine: "codex",
      model: null,
      effort: null,
      runtimeThreadId: null,
      engineSessionId: null,
      latestTurnSummary: "C",
      latestAssistantReply: null,
      lastMessageAt: 100,
    });
    harness.db.threads.create({
      id: "session-archived" as ThreadId,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "Archived",
      threadType: "chat",
      threadSubtype: "requirement-analysis",
    });
    harness.db.orchRequirementAnalysisSessions.create({
      id: "session-archived" as any,
      workspaceId: harness.workspaceId,
      title: "Archived",
      status: "archived",
      phase: "done",
      engine: "codex",
      model: null,
      effort: null,
      runtimeThreadId: null,
      engineSessionId: null,
      latestTurnSummary: "archived",
      latestAssistantReply: null,
      lastMessageAt: 400,
    });

    harness.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET updated_at = ?, created_at = ?, last_message_at = ? WHERE id = ?")
      .run(300, 300, 300, "session-a");
    harness.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET updated_at = ?, created_at = ?, last_message_at = ? WHERE id = ?")
      .run(200, 200, 200, "session-b");
    harness.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET updated_at = ?, created_at = ?, last_message_at = ? WHERE id = ?")
      .run(100, 100, 100, "session-c");
    harness.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET updated_at = ?, created_at = ?, last_message_at = ? WHERE id = ?")
      .run(400, 400, 400, "session-archived");
    harness.db.db.prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?").run(300, 300, "session-a");
    harness.db.db.prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?").run(200, 200, "session-b");
    harness.db.db.prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?").run(100, 100, "session-c");
    harness.db.db.prepare("UPDATE threads SET created_at = ?, updated_at = ?, archived = 1 WHERE id = ?").run(400, 400, "session-archived");

    const firstPage = harness.service.listSessions(harness.workspaceId, {
      includeArchived: false,
      limit: 2,
    });
    assert.deepEqual(firstPage.sessions.map((item) => item.id), ["session-a", "session-b"]);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextCursor, "200:session-b");

    const secondPage = harness.service.listSessions(harness.workspaceId, {
      includeArchived: false,
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    assert.deepEqual(secondPage.sessions.map((item) => item.id), ["session-c"]);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.nextCursor, null);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService listSessions 会清理孤儿需求分析会话", () => {
  const harness = createHarness({ ok: true });

  try {
    const liveThreadId = harness.createAnalysisThread("有效需求分析");
    harness.service.createSession({ workspaceId: harness.workspaceId, threadId: liveThreadId });
    harness.db.orchRequirementAnalysisSessions.create({
      id: "thread-orphan" as any,
      workspaceId: harness.workspaceId,
      title: "孤儿需求分析",
      status: "active",
      phase: "discover",
      engine: "codex",
      model: null,
      effort: null,
      runtimeThreadId: "thread-orphan" as any,
      engineSessionId: null,
      latestTurnSummary: "stale",
      latestAssistantReply: null,
      lastMessageAt: 123,
    });

    const page = harness.service.listSessions(harness.workspaceId, {
      includeArchived: false,
      limit: 10,
    });

    assert.deepEqual(page.sessions.map((item) => item.id), [liveThreadId]);
    assert.equal(harness.db.orchRequirementAnalysisSessions.get("thread-orphan" as any), null);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService updateSessionStatus 会同步 requirement-analysis thread 的归档状态", () => {
  const harness = createHarness({ ok: true });

  try {
    const threadId = harness.createAnalysisThread("归档同步需求分析");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });

    const archived = harness.service.updateSessionStatus(harness.workspaceId, created.session.id, "archived");
    assert.equal(archived?.status, "archived");
    assert.equal(harness.db.threads.get(threadId)?.archived, true);

    const restored = harness.service.updateSessionStatus(harness.workspaceId, created.session.id, "active");
    assert.equal(restored?.status, "active");
    assert.equal(harness.db.threads.get(threadId)?.archived, false);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 可以批量创建 intake 与 proposal", async () => {
  const harness = createHarness({
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
        goal: "实现鲜花市场首页",
        background: "展示主站入口与活动信息",
        acceptanceCriteria: [{ text: "支持横幅、分类、推荐区块" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "标准页面开发流程即可覆盖。",
        recommendedApproach: "建议先按静态首页交付，确认区块和视觉方向后直接推进。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("首页候选本身就是一个可独立验收的单阶段页面闭环。"),
        sizeAssessment: buildSizeAssessment("首页交付是中型需求，涉及多个内容区块和双端适配。"),
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
    const threadId = harness.createAnalysisThread("首页需求梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const sendResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "我要做鲜花市场首页",
    });
    const candidateId = sendResult.candidates[0]?.id as RequirementCandidateId;

    const result = harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [candidateId],
    });

    assert.equal(result.created.length, 1);
    assert.equal(result.created[0]?.intake.title, "鲜花市场首页");
    assert.equal(result.created[0]?.proposal?.draftWorkflow.id, harness.workflow.id);
    assert.equal(harness.db.orchIntakes.listByWorkspace(harness.workspaceId).length, 1);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 1);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 批量创建复用一个 Server 资产会话并去重读取", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "两个页面候选均已具备创建条件",
    assistantReply: "两个页面候选已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({ candidateId: "orders", title: "第1期-订单页", goal: "实现订单页" }),
      buildRequirementCandidatePayload({
        candidateId: "customers",
        title: "第2期-客户页",
        goal: "实现客户页",
        splitSource: "split-from-batch",
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["orders", "customers"],
      note: "可以批量创建需求并生成方案。",
    },
  }, { assetAuthorityMode: "server" });

  try {
    const threadId = harness.createAnalysisThread("批量需求梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const sendResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "创建订单页和客户页",
    });

    const result = harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: sendResult.candidates.map((candidate) => candidate.id),
    });

    assert.equal(result.created.length, 2);
    assert.deepEqual(harness.assetReadCalls, [
      `open:${harness.workspaceId}`,
      `get:workflow:${harness.workflow.id}`,
      `get:role:${harness.role.id}`,
    ]);
    for (const item of result.created) {
      assert.equal(Object.hasOwn(item.proposal?.draftWorkflow ?? {}, "createdAt"), false);
      assert.equal(Object.hasOwn(item.proposal?.draftWorkflow ?? {}, "updatedAt"), false);
    }
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService Server 资产读取失败时原样抛错且不写入", async () => {
  const readError = new Error("Server 资产缓存不可用");
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "候选已具备创建条件",
    assistantReply: "候选已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [buildRequirementCandidatePayload()],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["order-page"],
      note: "可以创建需求并生成方案。",
    },
  }, { assetAuthorityMode: "server", assetReadError: readError });

  try {
    const threadId = harness.createAnalysisThread("失败原子性验证");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const sendResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "创建订单页",
    });

    assert.throws(
      () => harness.service.createIntakes({
        workspaceId: harness.workspaceId,
        sessionId: created.session.id,
        candidateIds: [sendResult.candidates[0]!.id],
      }),
      (error) => error === readError,
    );
    assert.equal(harness.db.orchIntakes.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 创建 intake 的 taskType 只从流程 family 推导", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "登录问题候选已具备创建条件",
    assistantReply: "登录问题候选已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "login-analysis",
        title: "登录问题修复分析",
        goal: "分析并修复登录失败问题。",
        recommendedWorkflowId: "wf-standard",
        readyToCreate: true,
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["login-analysis"],
      note: "可以创建需求并生成方案。",
    },
  });

  try {
    const threadId = harness.createAnalysisThread("登录问题梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const sendResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请分析并修复登录问题。",
    });
    const candidateId = sendResult.candidates[0]?.id as RequirementCandidateId;

    const result = harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [candidateId],
    });

    assert.equal(result.created[0]?.intake.taskType, "feature");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 为 UI 原型流程创建 intake 时会保留项目集成原型边界说明", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "split",
    conversationSummary: "HSURP 原型基线已拆成一期和后续候选",
    assistantReply: "我先把原型基线和后续具体页面原型拆开，避免把基线建设和页面打样混在一起。",
    needUserInput: false,
    questions: [],
    candidates: [
      {
        candidateId: "ui-baseline",
        title: "第1期-HSURP 原型设计基线",
        goal: "为 HSURP 后台建立可复用的项目级原型设计基线",
        background: "先沉淀统一的原型规范和模板，不直接落正式业务功能。",
        acceptanceCriteria: [{ text: "后续页面原型可以复用统一基线" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "这类需求需要先经过 UI 原型节点收口页面结构与复用边界。",
        recommendedApproach: "建议先建立项目级原型基线，但继续复用现有前端项目的壳层、布局、主题和路由能力。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("这条候选适合作为一期 MMF：先建立统一的原型设计基线。", {
          deliverySlice: "phase-1",
          outOfScope: ["真实前端代码改造", "接口联调", "主题落地实现"],
        }),
        sizeAssessment: buildSizeAssessment("原型基线属于标准需求，重点在复用边界、模板和评审资产。"),
        assetGaps: [],
        clarificationItems: [],
        assumptions: ["仓库里已有可复用前端项目"],
        openQuestions: [],
        readyToCreate: true,
      },
      {
        candidateId: "ui-pages",
        title: "第2期-HSURP 具体业务页面原型打样",
        goal: "在基线稳定后继续打样各个业务页面的项目集成原型",
        background: "承接统一原型基线之后的具体页面落地。",
        acceptanceCriteria: [{ text: "具体页面原型按统一基线承接" }],
        splitSource: "split-from-batch",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "基线完成后，具体页面仍通过同一套 UI 流程推进。",
        recommendedApproach: "等基线稳定后，再逐页进入项目集成原型打样。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("这条候选属于后续阶段：应建立在统一原型基线已经完成的前提上推进。", {
          deliverySlice: "follow-up",
        }),
        sizeAssessment: buildSizeAssessment("具体页面打样属于标准需求，重点在页面差异和组件复用。"),
        assetGaps: [],
        clarificationItems: [{
          question: "这轮是否只先创建项目级原型基线，不进入任何具体业务页面打样？",
          reason: "需要把一期基线和后续页面打样的验收边界彻底分开。",
          suggestion: "建议这一轮只创建原型基线，具体业务页面作为后续候选保留。",
          impact: "scope",
          options: [
            { id: "baseline-only", label: "只做基线", value: "这轮只创建项目级原型基线，具体页面原型后续再做。", recommended: true },
            { id: "baseline-and-pages", label: "一起做页面", value: "这轮基线和具体业务页面原型都要一起推进。" },
          ],
          allowCustom: true,
          answerPlaceholder: "也可以直接说明这一轮是否要同时打样具体页面。",
        }],
        assumptions: [],
        openQuestions: [],
        readyToCreate: false,
      },
    ],
    nextAction: {
      type: "review-candidates",
      targetCandidateIds: ["ui-baseline", "ui-pages"],
      note: "建议先确认一期基线与后续页面打样的推进顺序。",
    },
  }, {
    roleName: "UI/UX设计师（UI）",
    roleDescription: "负责把需求与业务规则转成可评审、可预览的页面原型。",
    roleResponsibility: "把业务约束转成页面结构、信息层级、关键交互和截图资产。",
    roleSystemPrompt: "您负责 UI/UX 原型设计阶段。",
    roleOutputResultKey: "ui-spec",
  });

  try {
    const threadId = harness.createAnalysisThread("HSURP 原型基线");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const sendResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "我们要做一套能复用现有前端壳层和路由的 UI 原型基线。",
    });
    const candidateId = sendResult.candidates
      .find((candidate) => candidate.readyToCreate)
      ?.id as RequirementCandidateId;

    const result = harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [candidateId],
    });

    const background = String(result.created[0]?.intake.background ?? "");
    assert.equal(result.created[0]?.intake.title, "第1期-HSURP 原型设计基线");
    assert.match(background, /当前明确不纳入：/);
    assert.match(background, /真实前端代码改造/);
    assert.match(background, /补充约束：/);
    assert.match(background, /不等于禁止在现有前端项目中新增隔离的 prototype\/prototypes 目录、页面、路由、mock 数据或壳层复用/);
    assert.match(background, /只有当仓库里确实没有可复用前端项目，或用户明确要求独立静态原型时，才退回独立静态 HTML 原型/);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 不会因角色文案含原型而追加 UI 原型边界说明", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "效率方案说明已具备创建条件",
    assistantReply: "效率方案说明已经可以创建。",
    needUserInput: false,
    questions: [],
    candidates: [
      buildRequirementCandidatePayload({
        candidateId: "efficiency-solution",
        title: "效率方案原型说明",
        goal: "输出普通 file-set 文档交付物，说明效率方案原型思路。",
        background: "这里的原型只是方案草稿语义，不是 UI 原型交付。",
        recommendedWorkflowReason: "沿用普通功能流程即可覆盖。",
        recommendedApproach: "产出效率方案说明文档。",
        readyToCreate: true,
      }),
    ],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["efficiency-solution"],
      note: "可以创建需求并生成方案。",
    },
  }, {
    roleName: "效率方案原型说明",
    roleDescription: "负责整理效率方案原型、交互设想和落地建议，不是 UI 交付节点。",
    roleResponsibility: "输出普通文档交付物。",
    roleSystemPrompt: "您负责普通方案说明。",
    roleOutputResultKey: "efficiency-solution-reply",
  });

  try {
    const threadId = harness.createAnalysisThread("效率方案说明");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const sendResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "请输出一个效率方案原型说明。",
    });
    const candidateId = sendResult.candidates[0]?.id as RequirementCandidateId;

    const result = harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [candidateId],
    });

    const background = String(result.created[0]?.intake.background ?? "");
    assert.doesNotMatch(background, /补充约束：/);
    assert.doesNotMatch(background, /项目集成原型模式/);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 支持按候选需求的人工所选流程创建 proposal", async () => {
  const harness = createHarness({
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
        goal: "实现鲜花市场首页",
        background: "展示主站入口与活动信息",
        acceptanceCriteria: [{ text: "支持横幅、分类、推荐区块" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "标准页面开发流程即可覆盖。",
        recommendedApproach: "建议先按静态首页交付，确认区块和视觉方向后直接推进。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("首页候选本身就是一个可独立验收的单阶段页面闭环。"),
        sizeAssessment: buildSizeAssessment("首页交付是中型需求，涉及多个内容区块和双端适配。"),
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

  const alternateWorkflow = harness.db.orchWorkflows.upsert({
    id: "wf-alt" as any,
    workspaceId: harness.workspaceId,
    family: "feature-dev",
    name: "CodeFlow 轻量页面开发",
    description: "适合先做页面骨架与静态演示",
    workflowKnowledgeBundleIds: [harness.bundle.id],
    nodes: [
      {
        id: "node-ui-lite",
        type: "role",
        roleId: harness.role.id,
        label: "轻量页面实现",
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    version: 1,
  });

  try {
    const threadId = harness.createAnalysisThread("首页需求梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const sendResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "我要做鲜花市场首页",
    });
    const candidateId = sendResult.candidates[0]?.id as RequirementCandidateId;

    const result = harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [candidateId],
      workflowSelections: [{ candidateId, workflowId: alternateWorkflow.id }],
    });

    assert.equal(result.created.length, 1);
    assert.equal(result.created[0]?.proposal?.draftWorkflow.id, alternateWorkflow.id);
    assert.equal(result.created[0]?.proposal?.draftWorkflow.name, "CodeFlow 轻量页面开发");
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会在同一 provider turn 内返回澄清项校验错误", async () => {
  const harness = createHarness([
    {
      schemaVersion: "requirement-analysis-assistant/v1",
      phase: "clarify",
      conversationSummary: "订单页范围待澄清",
      assistantReply: "先补充订单页范围。",
      needUserInput: true,
      questions: [],
      candidates: [
        {
          candidateId: "order-page",
          title: "响应式订单页静态实现",
          goal: "做一个订单页，先用静态数据展示，同时兼顾 PC 和手机浏览。",
          background: "先验证页面形态，不接真实接口。",
          acceptanceCriteria: [{ text: "页面支持 PC 和手机访问" }],
          splitSource: "single",
          complexity: "standard",
          uiScope: "light",
          architectureRisk: "low",
          recommendedWorkflowId: "wf-standard",
          recommendedWorkflowName: "CodeFlow 标准功能开发",
          recommendedWorkflowReason: "需要独立 UI 环节收口页面范围。",
          recommendedApproach: "建议先按一个响应式页面收口。",
          recommendedRoleIds: ["role-ui"],
          recommendedKnowledgeBundleIds: ["kb-ui"],
          phasingAssessment: buildPhasingAssessment("订单页候选本身就是一个可独立验收的单阶段页面闭环。"),
          sizeAssessment: buildSizeAssessment("订单页属于中型需求。"),
          assetGaps: [],
          clarificationItems: [
            {
              question: "订单页是列表、详情，还是两者都要？",
              reason: "页面形态会直接影响需求范围。",
              suggestion: "先把页面范围定下来。",
              impact: "scope",
              options: [],
              allowCustom: true,
              answerPlaceholder: "请说明页面范围。",
            },
          ],
          assumptions: [],
          openQuestions: ["订单页是列表、详情，还是两者都要？"],
          readyToCreate: false,
        },
      ],
      nextAction: {
        type: "wait-user-reply",
        targetCandidateIds: ["order-page"],
        note: "需要先补齐页面范围。",
      },
    },
    {
      schemaVersion: "requirement-analysis-assistant/v1",
      phase: "clarify",
      conversationSummary: "订单页范围待澄清",
      assistantReply: "我已经把待澄清项整理成可直接反馈的选项。",
      needUserInput: true,
      questions: [],
      candidates: [
        {
          candidateId: "order-page",
          title: "响应式订单页静态实现",
          goal: "做一个订单页，先用静态数据展示，同时兼顾 PC 和手机浏览。",
          background: "先验证页面形态，不接真实接口。",
          acceptanceCriteria: [{ text: "页面支持 PC 和手机访问" }],
          splitSource: "single",
          complexity: "standard",
          uiScope: "light",
          architectureRisk: "low",
          recommendedWorkflowId: "wf-standard",
          recommendedWorkflowName: "CodeFlow 标准功能开发",
          recommendedWorkflowReason: "需要独立 UI 环节收口页面范围。",
          recommendedApproach: "建议先按订单列表页收口，确认字段和交互后再决定是否拆详情页。",
          recommendedRoleIds: ["role-ui"],
          recommendedKnowledgeBundleIds: ["kb-ui"],
          phasingAssessment: buildPhasingAssessment("订单页候选本身就是一个可独立验收的单阶段页面闭环。"),
          sizeAssessment: buildSizeAssessment("订单页属于中型需求，需要兼顾双端展示与交互。"),
          assetGaps: [],
          clarificationItems: [
            {
              question: "订单页是列表、详情，还是两者都要？",
              reason: "页面形态会直接影响需求范围。",
              suggestion: "建议优先确认是否先只做列表页。",
              impact: "scope",
              options: [
                { id: "list-only", label: "先只做列表页", value: "这轮先只做订单列表页，不做详情页。", recommended: true },
                { id: "list-and-detail", label: "列表和详情都要", value: "这轮需要同时包含订单列表页和订单详情页。" },
              ],
              allowCustom: true,
              answerPlaceholder: "也可以直接说明您要的页面组合。",
            },
          ],
          assumptions: [],
          openQuestions: ["订单页是列表、详情，还是两者都要？"],
          readyToCreate: false,
        },
      ],
      nextAction: {
        type: "wait-user-reply",
        targetCandidateIds: ["order-page"],
        note: "需要先补齐页面范围。",
      },
    },
  ]);

  try {
    const threadId = harness.createAnalysisThread("订单页澄清");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "做一个订单页，PC 和手机都要能看，先不用接接口。",
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.clarificationItems[0]?.options.length, 2);
    assert.equal(result.candidates[0]?.clarificationItems[0]?.options[0]?.recommended, true);
    assert.equal(
      harness.db.conversationEvents.listByThread(threadId).some((event) => event.type === "item.agentMessage.started"),
      false,
    );
    assert.equal(harness.sentInputs.length, 1);
    assert.match(String(harness.toolResults[0]?.message ?? ""), /clarificationItems 缺少可点击 options 或缺少 recommended 选项/);
    const rawEvents = harness.db.rawEvents.listByThreadFromSeq(threadId, { fromSeqInclusive: 1, limit: 20 });
    assert.equal(rawEvents.length >= 2, true);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 将 openQuestions 作为非阻塞后续问题保留", async () => {
  const candidate = buildRequirementCandidatePayload({
    openQuestions: ["后续是否支持订单导出可作为增强项，不阻塞本期创建。"],
    readyToCreate: true,
  });
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "confirm",
    conversationSummary: "订单页候选已可创建，后续增强项不阻塞本期。",
    assistantReply: "订单页候选已可创建，订单导出后续再评估。",
    needUserInput: false,
    questions: [],
    candidates: [candidate],
    nextAction: {
      type: "ready-to-create",
      targetCandidateIds: ["order-page"],
      note: null,
    },
  });

  try {
    const threadId = harness.createAnalysisThread("订单页非阻塞问题");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "做一个订单页，导出可以后面再看。",
    });

    assert.equal(harness.sentInputs.length, 1);
    assert.equal(result.candidates[0]?.readyToCreate, true);
    assert.deepEqual(result.candidates[0]?.openQuestions, ["后续是否支持订单导出可作为增强项，不阻塞本期创建。"]);
    assert.deepEqual(result.candidates[0]?.clarificationItems, []);
    const persisted = harness.db.orchRequirementCandidateDrafts.listBySession(created.session.id)[0];
    assert.equal(persisted?.readyToCreate, true);
    assert.deepEqual(persisted?.clarificationItems, []);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会拒绝 candidates 字符串并在同一 provider turn 返回原因", async () => {
  const validCandidate = buildRequirementCandidatePayload();
  const harness = createHarness([
    {
      schemaVersion: "requirement-analysis-assistant/v1",
      phase: "split",
      conversationSummary: "订单页候选已初步拆解",
      assistantReply: "我先整理了一个订单页候选，还需要确认页面范围。",
      needUserInput: true,
      questions: [{
        id: "q1",
        question: "订单页先做列表页还是列表和详情都做？",
        reason: "页面组合会影响一期范围。",
        impact: "scope",
      }],
      candidates: JSON.stringify([validCandidate]),
      nextAction: {
        type: "wait-user-reply",
        targetCandidateIds: null,
        note: "等待确认订单页范围。",
      },
    },
    {
      schemaVersion: "requirement-analysis-assistant/v1",
      phase: "confirm",
      conversationSummary: "订单页候选已按对象数组修正",
      assistantReply: "已按可创建候选重新提交。",
      needUserInput: false,
      questions: [],
      candidates: [validCandidate],
      nextAction: {
        type: "ready-to-create",
        targetCandidateIds: ["order-page"],
        note: null,
      },
    },
  ]);

  try {
    const threadId = harness.createAnalysisThread("订单页候选字符串");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "做一个订单页，PC 和手机都要能看，先不用接接口。",
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(harness.db.orchRequirementCandidateDrafts.listBySession(created.session.id).length, 1);
    assert.equal(harness.sentInputs.length, 1);
    const validationMessage = String(harness.toolResults[0]?.message ?? "");
    assert.match(validationMessage, /candidates 必须是数组/);
    assert.match(validationMessage, /不要传 JSON 字符串/);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 会拒绝 questions 和 candidates 数组里的字符串元素", async () => {
  const validCandidate = buildRequirementCandidatePayload();
  const harness = createHarness([
    {
      schemaVersion: "requirement-analysis-assistant/v1",
      phase: "split",
      conversationSummary: "订单页候选形状错误",
      assistantReply: "我先把问题和候选整理出来。",
      needUserInput: true,
      questions: [JSON.stringify({
        id: "q1",
        question: "订单页先做列表页还是列表和详情都做？",
        reason: "页面组合会影响一期范围。",
        impact: "scope",
      })],
      candidates: [JSON.stringify(validCandidate)],
      nextAction: {
        type: "wait-user-reply",
        targetCandidateIds: null,
        note: "等待确认订单页范围。",
      },
    },
    {
      schemaVersion: "requirement-analysis-assistant/v1",
      phase: "confirm",
      conversationSummary: "订单页候选已按对象元素修正",
      assistantReply: "已按对象数组重新提交。",
      needUserInput: false,
      questions: [],
      candidates: [validCandidate],
      nextAction: {
        type: "ready-to-create",
        targetCandidateIds: ["order-page"],
        note: null,
      },
    },
  ]);

  try {
    const threadId = harness.createAnalysisThread("订单页数组元素字符串");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const result = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "做一个订单页，PC 和手机都要能看，先不用接接口。",
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(harness.sentInputs.length, 1);
    const validationMessage = String(harness.toolResults[0]?.message ?? "");
    assert.match(validationMessage, /questions\[0\] 必须是对象/);
    assert.match(validationMessage, /candidates\[0\] 必须是对象/);
    assert.match(validationMessage, /不要把候选 JSON 包成字符串/);
    assert.doesNotMatch(validationMessage, /未命名需求/);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 解析失败时会关闭 turn，并且不把原始 JSON 留在聊天区", async () => {
  const harness = createHarness("not-json");

  try {
    const threadId = harness.createAnalysisThread("失败场景");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await assert.rejects(
      harness.service.sendMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.session.id,
        text: "这次响应会失败",
      }),
    );

    const events = harness.db.conversationEvents.listByThread(threadId);
    assert.equal(events.some((event) => event.type === "turn.error"), true);
    assert.equal(events.some((event) => event.type === "item.agentMessage.started"), false);
    assert.equal(events.some((event) => event.type === "item.agentMessage.snapshot"), false);
    assert.equal(
      events.some(
        (event) => event.type === "item.agentMessage.completed" && String(event.payload.text ?? "").includes("not-json"),
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        harness.db.conversationEvents.listRunningTurnsByWorkspace(harness.workspaceId),
        threadId,
      ),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 失败分支不会调用 assistant terminal reconcile，也不会落 draft assistant", async () => {
  let prepareCalled = false;
  const harness = createHarness("not-json", {
    prepareAssistantTerminalEvents: (_input, ctx) => {
      prepareCalled = true;
      return {
        events: [{
          ts: Date.now(),
          workspaceId: ctx.workspaceId,
          threadId: ctx.threadId,
          engine: "codex",
          type: "item.agentMessage.completed",
          payload: {
            itemId: "assistant-draft" as any,
            engineMessageId: "assistant-draft",
            text: "draft-json-content",
            revision: 1,
            phase: "commentary",
            completionSource: "runtime_close_reconcile",
          },
        } satisfies ConversationEventInput],
        latestAssistantText: ctx.lastResponseText,
      };
    },
  });

  try {
    const threadId = harness.createAnalysisThread("失败 reconcile 场景");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await assert.rejects(
      harness.service.sendMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.session.id,
        text: "这次响应会失败并触发 terminal reconcile",
      }),
    );

    const events = harness.db.conversationEvents.listByThread(threadId);
    assert.equal(prepareCalled, false);
    assert.equal(events.some((event) => event.type === "turn.error"), true);
    assert.equal(events.some((event) => event.type === "item.agentMessage.started"), false);
    assert.equal(
      events.some(
        (event) => event.type === "item.agentMessage.completed" && String(event.payload.text ?? "").includes("draft-json-content"),
      ),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 允许原生工具调研陌生业务域，并提示先查权威资料再判断是否需要知识沉淀", async () => {
  const harness = createHarness({
    schemaVersion: "requirement-analysis-assistant/v1",
    phase: "clarify",
    conversationSummary: "需要先确认支付域约束",
    assistantReply: "我先整理支付域约束，再判断是否需要沉淀成工作区资产。",
    needUserInput: true,
    questions: [],
    candidates: [
      {
        candidateId: "wx-pay",
        title: "微信支付接入",
        goal: "接入微信支付下单和回调",
        background: "需要先确认签名、回调、订单状态等约束。",
        acceptanceCriteria: [{ text: "梳理微信支付接入所需的关键约束" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "light",
        architectureRisk: "medium",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "接入类需求仍可沿用标准开发流程。",
        recommendedApproach: "建议先基于官方资料收口支付域规则，再决定是否需要单独沉淀团队知识资产。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: [],
        phasingAssessment: buildPhasingAssessment("当前支付接入候选先按单一核心闭环收口。"),
        sizeAssessment: buildSizeAssessment("支付接入属于中型需求，重点在规则边界和联调。"),
        assetGaps: [],
        clarificationItems: [{
          question: "这轮是否只覆盖下单与支付回调，不包含退款和对账？",
          reason: "支付链路范围会直接影响需求边界。",
          suggestion: "建议先锁定最小闭环，再决定是否扩展退款与对账。",
          impact: "scope",
          options: [
            { id: "pay-core", label: "先做支付主链路", value: "这轮先覆盖下单、支付回调和订单状态更新。", recommended: true },
            { id: "pay-full", label: "一起覆盖退款对账", value: "这轮需要同时覆盖支付、退款和对账。" },
          ],
          allowCustom: true,
          answerPlaceholder: "也可以直接说明这轮支付链路范围。",
        }],
        assumptions: ["会先参考微信支付官方文档梳理约束"],
        openQuestions: [],
        readyToCreate: false,
      },
    ],
    nextAction: {
      type: "wait-user-reply",
      targetCandidateIds: ["wx-pay"],
      note: "先确认支付链路范围。",
    },
  });

  try {
    const threadId = harness.createAnalysisThread("支付需求梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "我要接微信支付，但我不熟悉签名验签和订单状态规则。",
    });

    const sent = harness.sentInputs[0];
    assert.equal(sent?.providerNativeToolPolicy, "allow");
    assert.equal(sent?.responseFormat, "text");
    assert.equal(sent?.platformToolTransportRequirement, "required");
    assert.match(String(sent?.systemMessage ?? ""), /优先使用可用原生工具查阅官方文档、标准或其他权威资料/);
    assert.match(String(sent?.systemMessage ?? ""), /先做 MMF 分期判断，再做规模估算/);
    assert.match(String(sent?.developerMessage ?? ""), /不要因为当前工作区没有支付域或其他外部领域知识库，就直接输出 knowledge-bundle blocking gap/);
    assert.match(String(sent?.developerMessage ?? ""), /openQuestions 只允许记录不阻塞当前创建的后续问题/);
    assert.match(String(sent?.developerMessage ?? ""), /如果用户只说了一个大需求，但其中包含多个独立价值假设/);
    assert.match(String(sent?.developerMessage ?? ""), /第1期-标题 \/ 第2期-标题 \/ 第3期-标题/);
    assert.match(String(sent?.developerMessage ?? ""), /如果某条 candidate 推荐了 UI\/UX 原型设计角色/);
    assert.match(String(sent?.developerMessage ?? ""), /不要把“项目集成原型模式”排除在 UI candidate 的建议方案和 outOfScope 之外/);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysis candidate draft fallback 文案把知识资产缺口表述为业务资料或可复用资产，而不是直接要求先补知识库", () => {
  const harness = createHarness({ ok: true });

  try {
    const threadId = harness.createAnalysisThread("支付需求梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    harness.db.orchRequirementCandidateDrafts.replaceForSession(created.session.id, [{
      id: "wx-pay" as RequirementCandidateId,
      sessionId: created.session.id,
      creationState: "draft",
      createdIntakeId: null,
      createdProposalId: null,
      title: "微信支付接入",
      goal: "接入微信支付下单和回调",
      background: "外部规则已确认，但团队内部还没有统一沉淀。",
      acceptanceCriteria: [{ id: "ac-1", text: "明确支付接入边界和稳定约束", blocking: true }],
      splitSource: "single",
      complexity: "standard",
      uiScope: "light",
      architectureRisk: "medium",
      recommendedWorkflowId: harness.workflow.id,
      recommendedWorkflowName: harness.workflow.name,
      recommendedWorkflowReason: "接入类需求仍可沿用标准开发流程。",
      recommendedApproach: "建议先按支付主链路推进，并视复用需求决定是否沉淀知识资产。",
      recommendedRoleIds: [harness.role.id],
      recommendedKnowledgeBundleIds: [],
      phasingAssessment: buildPhasingAssessment("当前支付接入候选先按单一核心闭环收口。"),
      sizeAssessment: { ...buildSizeAssessment("支付接入属于中型需求，重点在边界和联调。"), size: "standard", score: 11 },
      assetGaps: [
        {
          kind: "knowledge-bundle",
          severity: "blocking",
          code: "payment-knowledge-reuse-missing",
          message: "支付域稳定约束还没有沉淀为当前工作区可复用知识资产。",
          suggestion: "若后续会反复做支付需求，建议把已经确认的官方约束沉淀成团队知识资产。",
        },
      ],
      clarificationItems: [],
      assumptions: [],
      openQuestions: [],
      readyToCreate: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);

    const clarification = harness.db.orchRequirementCandidateDrafts.listBySession(created.session.id)[0]?.clarificationItems[0];
    assert.match(String(clarification?.reason ?? ""), /关键业务资料或可复用执行资产/);
    assert.match(String(clarification?.answerPlaceholder ?? ""), /业务资料、规则约束/);
    assert.doesNotMatch(String(clarification?.reason ?? ""), /^当前仍缺少知识库/);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 创建后会关闭候选可创建状态，避免重复创建", async () => {
  const harness = createHarness({
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
        goal: "实现鲜花市场首页",
        background: "展示主站入口与活动信息",
        acceptanceCriteria: [{ text: "支持横幅、分类、推荐区块" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "标准页面开发流程即可覆盖。",
        recommendedApproach: "建议按单页首页先交付，避免一次拉太大范围。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("首页候选本身就是一个可独立验收的单阶段页面闭环。"),
        sizeAssessment: buildSizeAssessment("首页需求属于中型规模。"),
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
    const threadId = harness.createAnalysisThread("首页需求梳理");
    const created = harness.service.createSession({ workspaceId: harness.workspaceId, threadId });
    const sendResult = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      text: "我要做鲜花市场首页",
    });
    const candidateId = sendResult.candidates[0]?.id as RequirementCandidateId;

    harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: created.session.id,
      candidateIds: [candidateId],
    });

    const candidates = harness.db.orchRequirementCandidateDrafts.listBySession(created.session.id);
    assert.equal(candidates[0]?.readyToCreate, false);
    await assert.rejects(
      Promise.resolve().then(() => harness.service.createIntakes({
        workspaceId: harness.workspaceId,
        sessionId: created.session.id,
        candidateIds: [candidateId],
        })),
    );
    assert.equal(harness.db.orchIntakes.listByWorkspace(harness.workspaceId).length, 1);
  } finally {
    harness.cleanup();
  }
});

test("RequirementAnalysisService 不会把不同 thread 里同名同目标的需求误并成一条", async () => {
  const payload = {
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
        goal: "实现鲜花市场首页",
        background: "背景占位",
        acceptanceCriteria: [{ text: "支持横幅、分类、推荐区块" }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: "wf-standard",
        recommendedWorkflowName: "CodeFlow 标准功能开发",
        recommendedWorkflowReason: "标准页面开发流程即可覆盖。",
        recommendedApproach: "建议把两个版本分别作为独立需求推进，避免候选串线。",
        recommendedRoleIds: ["role-ui"],
        recommendedKnowledgeBundleIds: ["kb-ui"],
        phasingAssessment: buildPhasingAssessment("每个首页版本候选都可以作为单独的单阶段需求推进。"),
        sizeAssessment: buildSizeAssessment("首页版本拆分后每条仍属于中型页面需求。"),
        assetGaps: [],
        clarificationItems: [],
        assumptions: [],
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
  const harness = createHarness(payload);

  try {
    const threadIdA = harness.createAnalysisThread("首页需求 A");
    const sessionA = harness.service.createSession({ workspaceId: harness.workspaceId, threadId: threadIdA });
    const sendA = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: sessionA.session.id,
      text: "我要做鲜花市场首页，版本 A",
    });
    const candidateIdA = sendA.candidates[0]?.id as RequirementCandidateId;
    const first = harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: sessionA.session.id,
      candidateIds: [candidateIdA],
    });

    const threadIdB = harness.createAnalysisThread("首页需求 B");
    const sessionB = harness.service.createSession({ workspaceId: harness.workspaceId, threadId: threadIdB });
    const sendB = await harness.service.sendMessage({
      workspaceId: harness.workspaceId,
      sessionId: sessionB.session.id,
      text: "我要做鲜花市场首页，版本 B",
    });
    const candidateIdB = sendB.candidates[0]?.id as RequirementCandidateId;
    const second = harness.service.createIntakes({
      workspaceId: harness.workspaceId,
      sessionId: sessionB.session.id,
      candidateIds: [candidateIdB],
    });

    assert.notEqual(first.created[0]?.intake.id, second.created[0]?.intake.id);
    assert.equal(harness.db.orchIntakes.listByWorkspace(harness.workspaceId).length, 2);
  } finally {
    harness.cleanup();
  }
});



