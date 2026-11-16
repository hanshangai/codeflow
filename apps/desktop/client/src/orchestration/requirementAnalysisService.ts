import crypto from "node:crypto";

import type {
  AccessMode,
  CodexServiceTier,
  ConversationEventInput,
  EngineType,
  ItemId,
  NodeExecutionProfileScope,
  RawEngineEventInput,
  RequirementAnalysisAssistantPayload,
  RequirementAnalysisAssetGap,
  RequirementAnalysisCandidateMutation,
  RequirementAnalysisMessage,
  RequirementAnalysisPhase,
  RequirementAnalysisQuestion,
  RequirementAnalysisSession,
  RequirementCandidateDraft,
  RequirementCandidateId,
  RoleDefinition,
  RoleId,
  TaskAcceptanceCriterion,
  TaskIntake,
  TextFileAttachment,
  ThreadId,
  TurnId,
  WorkflowDefinition,
  WorkflowId,
  WorkflowRuntimeDefinition,
  WorkspacePathReference,
  WorkspaceId,
} from "@codeflowai/shared";
import {
  normalizeTaskIntakeTitle,
  workspaceIdsReferToSameWorkspace,
} from "@codeflowai/shared";
import { createTurnErrorEventInputFromError } from "../errors/turnErrors.js";

import type { ClientDb } from "../db/clientDb.js";
import { readIntakeWorkspaceScope } from "../db/repos/orchIntakeRepo.js";
import { OrchRequirementAnalysisSessionRepoError } from "../db/repos/orchRequirementAnalysisSessionRepo.js";
import { createActiveTurnConflictError, type HostToolExecutionResult, type TurnTimeoutPolicy } from "../engines/threadSession.js";
import type { ThreadSessionManager } from "../engines/threadSessionManager.js";
import { assertClientReasoningEffortSupported } from "../engines/engineModelCapabilities.js";
import type { ThreadStore } from "../threads/threadStore.js";
import { buildPromptText } from "../app/utils/promptWithAttachments.js";
import type { OrchAssetAuthorityRuntimeReadService } from "./orchAssetAuthorityRuntimeReadService.js";
import { createProposalFromIntake } from "./proposalBuilder.js";

type RuntimeRoleDefinition = Omit<RoleDefinition, "createdAt" | "updatedAt">;

type RequirementAnalysisServiceDeps = {
  db: ClientDb;
  intakeWorkspaceScope?: NodeExecutionProfileScope;
  orchAssetRuntimeRead?: Pick<OrchAssetAuthorityRuntimeReadService, "openWorkspace">;
  threads: ThreadStore;
  sessions: ThreadSessionManager;
  workspaces: Map<WorkspaceId, string>;
  timeoutPolicy: TurnTimeoutPolicy;
  emitConversation: (event: ConversationEventInput) => { accepted: boolean } | void;
  emitRaw: (event: RawEngineEventInput) => void;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
};

type SendAssistantTurnResult = {
  session: RequirementAnalysisSession;
  userMessage: RequirementAnalysisMessage;
  assistantMessage: RequirementAnalysisMessage;
  candidates: RequirementCandidateDraft[];
  payload: RequirementAnalysisAssistantPayload;
};

const ASSISTANT_SCHEMA_VERSION = "requirement-analysis-assistant/v2";
const LEGACY_ASSISTANT_SCHEMA_VERSION = "requirement-analysis-assistant/v1";
const MAX_CONTEXT_MESSAGES = 12;
const MAX_SUBMISSION_ATTEMPTS = 2;
const REQUIREMENT_ANALYSIS_TOOLSET_ID = "__runtime_requirement_analysis__";
const REQUIREMENT_ANALYSIS_SUBMIT_TOOL_ID = "runtime.submitRequirementAnalysisTurnResult";
const REQUIREMENT_ANALYSIS_SUBMISSION_NOT_ACCEPTED_CODE = "requirement_analysis_submission_not_accepted";
const REQUIREMENT_CANDIDATE_SET_HASH_RE = /^[0-9a-f]{24}$/;
const HASH_MISMATCH_FAILURE_CODE = "CONFLICT";
const DEFAULT_CLARIFICATION_REASON = "需要先补齐这项信息，才能继续确认流程和验收边界。";
const DEFAULT_CLARIFICATION_SUGGESTION = "请直接补充这项信息，并尽量说明范围、输入输出和验收方式。";
const DEFAULT_CLARIFICATION_PLACEHOLDER = "直接补充您的选择、范围、字段或交互要求。";
const DEFAULT_ASSET_GAP_SUGGESTION = "请先补齐这部分业务资料或执行资产，必要时再新增对应流程、角色、知识库或工具集后继续。";
const DEFAULT_ASSET_GAP_PLACEHOLDER = "也可以直接补充业务资料、规则约束，或说明需要新增的流程、角色、知识库或工具信息。";

type NormalizedAssistantResult = {
  payload: RequirementAnalysisAssistantPayload;
  drafts: RequirementCandidateDraft[];
  meta: {
    validationErrors: string[];
    failureCode?: string | null;
  };
};

export class RequirementAnalysisServiceError extends Error {
  /** 提交或投递失败只暴露固定诊断与实体，原始通知正文不进入异常链。 */
  constructor(
    readonly code: "ORCH_REQUIREMENT_ANALYSIS_CREATE_FAILED" | "ORCH_REQUIREMENT_ANALYSIS_NOTICE_FAILED",
    readonly details: { sessionId: string; workspaceId: string },
    cause: unknown,
  ) {
    const storageCode = String((cause as { code?: unknown } | null)?.code ?? "");
    const rootCause = code === "ORCH_REQUIREMENT_ANALYSIS_NOTICE_FAILED"
      ? "conversation_notice_delivery_failed_after_commit"
      : `sqlite_derived_group_commit_failed${/^ERR_SQLITE_[A-Z_]+$/.test(storageCode) ? `:${storageCode}` : ""}`;
    super(code, { cause: new Error(rootCause) });
    this.name = "RequirementAnalysisServiceError";
  }
}

export class RequirementAnalysisService {
  constructor(private readonly deps: RequirementAnalysisServiceDeps) {}

  /** 同步仓储段独立准入，模型和终态等待不持数据库许可。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.deps.withLegacyDatabase ? this.deps.withLegacyDatabase("requirement-analysis", operation) : operation();
  }

  /** 仅供 threads.create 首次持久写入事务初始化；重放与旧线程懒建不得调用。 */
  initializeNewThreadSession(workspaceId: WorkspaceId, threadId: ThreadId): RequirementAnalysisSession {
    const thread = this.requireAnalysisThread(workspaceId, threadId);
    if (!thread) throw new Error(`需求分析线程不存在：${threadId}`);
    return this.ensureSessionRecord(thread, true);
  }

  /** 补运行态前按真实持久 RA 核对请求工作区与归属，不补建或认领旧线程。 */
  assertThreadWorkspaceScope(workspaceId: WorkspaceId, threadId: ThreadId): void {
    const thread = this.deps.db.threads.get(threadId);
    if (!thread || thread.threadSubtype !== "requirement-analysis") return;
    if (!workspaceIdsReferToSameWorkspace(thread.workspaceId, workspaceId)) {
      throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", { sessionId: String(thread.id), workspaceId: String(thread.workspaceId) });
    }
    this.readThreadWorkspaceScope(thread, this.deps.db.orchRequirementAnalysisSessions.get(thread.id as any));
  }

  /** 本机列表只读原范围，remote 继续沿用既有孤立记录清理。 */
  listSessions(
    workspaceId: WorkspaceId,
    opts?: {
      includeArchived?: boolean;
      limit?: number;
      cursor?: string | null;
      allowedResourceIds?: string[] | null;
      localThreadIds?: readonly ThreadId[];
      search?: string | null;
      statuses?: unknown[] | null;
    },
  ): {
    sessions: RequirementAnalysisSession[];
    hasMore: boolean;
    nextCursor: string | null;
    totalCount: number;
    statusCounts: unknown[];
    listMetaById: Record<string, unknown>;
  } {
    const includeArchived = Boolean(opts?.includeArchived ?? true);
    if (opts?.localThreadIds === undefined) this.deps.db.orchRequirementAnalysisSessions.deleteOrphanedByWorkspace(workspaceId);
    const page = this.deps.db.orchRequirementAnalysisSessions.listByWorkspace(workspaceId, {
      includeArchived,
      limit: opts?.limit,
      cursor: opts?.cursor ?? null,
      allowedResourceIds: opts?.allowedResourceIds ?? null,
      localThreadIds: opts?.localThreadIds,
      search: opts?.search ?? null,
      statuses: opts?.statuses as any,
    });
    return {
      sessions: page.sessions,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
      statusCounts: page.statusCounts,
      listMetaById: page.listMetaById,
    };
  }

  /** 续接已有线程前先核对归属，禁止改名后才发现冲突。 */
  createSession(input: { workspaceId: WorkspaceId; threadId: ThreadId; title?: string | null }): {
    session: RequirementAnalysisSession;
    messages: RequirementAnalysisMessage[];
    candidates: RequirementCandidateDraft[];
  } {
    const thread = this.requireAnalysisThread(input.workspaceId, input.threadId);
    if (!thread) throw new Error(`需求分析线程不存在：${input.threadId}`);
    this.assertThreadWorkspaceScope(input.workspaceId, input.threadId);
    if (input.title && normalizeSessionTitle(input.title) !== thread.title) {
      this.deps.db.threads.rename(thread.id, normalizeSessionTitle(input.title));
      this.deps.threads.setTitle(thread.id, normalizeSessionTitle(input.title));
    }
    const session = this.ensureSessionRecord(this.deps.db.threads.get(thread.id) ?? thread);
    const welcomeText = buildWelcomeMessage({
      workflows: this.deps.db.orchWorkflows.listByWorkspace(input.workspaceId),
      roles: this.deps.db.orchRoles.listByWorkspace(input.workspaceId),
      knowledgeBundles: this.deps.db.orchKnowledgeBundles.listByWorkspace(input.workspaceId),
    });
    const welcomeMessage = this.ensureWelcomeMessage(session, welcomeText);
    const nextSession = this.ensureSessionRecord(this.deps.db.threads.get(thread.id) ?? thread);
    return {
      session: nextSession,
      messages: welcomeMessage ? [welcomeMessage] : this.readThreadMessages(thread.id),
      candidates: this.deps.db.orchRequirementCandidateDrafts.listBySession(nextSession.id),
    };
  }

  getSession(workspaceId: WorkspaceId, sessionId: RequirementAnalysisSession["id"]): {
    session: RequirementAnalysisSession;
    messages: RequirementAnalysisMessage[];
    candidates: RequirementCandidateDraft[];
  } | null {
    const session = this.requireSession(workspaceId, sessionId);
    if (!session) return null;
    return {
      session,
      messages: this.readThreadMessages(session.id as ThreadId),
      candidates: this.deps.db.orchRequirementCandidateDrafts.listBySession(session.id),
    };
  }

  updateSessionStatus(
    workspaceId: WorkspaceId,
    sessionId: RequirementAnalysisSession["id"],
    status: RequirementAnalysisSession["status"],
  ): RequirementAnalysisSession | null {
    const session = this.requireSession(workspaceId, sessionId);
    if (!session) return null;
    const targetThreadId = String(session.runtimeThreadId ?? session.id).trim() as ThreadId;
    if (!targetThreadId) return null;
    this.deps.db.threads.setArchived(targetThreadId, status === "archived");
    const nextThread = this.requireAnalysisThread(workspaceId, targetThreadId);
    if (!nextThread) {
      this.deps.db.orchRequirementAnalysisSessions.deleteByThreadId(targetThreadId);
      return null;
    }
    const persistedThread = this.deps.db.threads.get(nextThread.id) ?? nextThread;
    return this.ensureSessionRecord(persistedThread);
  }

  async sendMessage(input: {
    workspaceId: WorkspaceId;
    sessionId: RequirementAnalysisSession["id"];
    text: string;
    turnId?: TurnId | null;
    userItemId?: ItemId | null;
    assistantItemId?: string | null;
    reasoningItemId?: string | null;
    planMode?: boolean | null;
    accessMode?: AccessMode | null;
    model?: string | null;
    effort?: string | null;
    images?: string[];
    files?: TextFileAttachment[];
    pathReferences?: WorkspacePathReference[];
    contextWindow?: number | null;
    autoCompactPct?: number | null;
    serviceTier?: CodexServiceTier | null;
  }): Promise<SendAssistantTurnResult> {
    return this.runAssistantTurn({
      workspaceId: input.workspaceId,
      threadId: input.sessionId as ThreadId,
      text: input.text,
      turnId: input.turnId ?? null,
      userItemId: input.userItemId ?? null,
      assistantItemId: input.assistantItemId ?? null,
      reasoningItemId: input.reasoningItemId ?? null,
      planMode: input.planMode ?? null,
      accessMode: input.accessMode ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      images: input.images ?? [],
      files: input.files ?? [],
      pathReferences: input.pathReferences ?? [],
      contextWindow: input.contextWindow ?? null,
      autoCompactPct: input.autoCompactPct ?? null,
      serviceTier: input.serviceTier ?? null,
    });
  }

  /** 候选整组提交后再投递成功通知；显式拒收必须失败，旧 void 出口保持兼容。 */
  createIntakes(input: {
    workspaceId: WorkspaceId;
    sessionId: RequirementAnalysisSession["id"];
    candidateIds: RequirementCandidateId[];
    workflowSelections?: Array<{
      candidateId: RequirementCandidateId;
      workflowId: WorkflowId;
    }> | null;
  }): {
    created: Array<{
      candidateId: RequirementCandidateId;
      intake: TaskIntake;
      proposal: ReturnType<typeof createProposalFromIntake>;
    }>;
  } {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    if (!session) throw new Error(`需求分析会话不存在：${input.sessionId}`);
    const requestedIds = new Set(
      (input.candidateIds ?? []).map((item) => String(item ?? "").trim()).filter(Boolean),
    );
    const workflowSelectionMap = new Map(
      (input.workflowSelections ?? [])
        .map((item) => {
          const candidateId = String(item?.candidateId ?? "").trim();
          const workflowId = String(item?.workflowId ?? "").trim();
          if (!candidateId || !workflowId) return null;
          return [candidateId, workflowId] as const;
        })
        .filter((item): item is readonly [string, string] => Boolean(item)),
    );
    if (!requestedIds.size) throw new Error("至少选择一个候选需求");

    const candidates = this.deps.db.orchRequirementCandidateDrafts
      .listBySession(session.id)
      .filter((candidate) => requestedIds.has(String(candidate.id)));
    if (candidates.length !== requestedIds.size) throw new Error("未找到全部选中的候选需求");
    if (candidates.some(isCreatedCandidate)) throw new Error("选中的候选需求已经创建，请刷新后查看");
    const blockedCandidates = candidates.filter((candidate) =>
      !candidate.readyToCreate
      || candidate.clarificationItems.length > 0
      || candidate.assetGaps.some((gap) => gap.severity === "blocking"),
    );
    if (blockedCandidates.length > 0) {
      throw new Error(`这些候选需求还不能创建：${blockedCandidates.map((item) => item.title).join("、")}`);
    }

    if (!this.deps.orchAssetRuntimeRead) throw new Error("资产运行读取服务未装配");
    const assetSession = this.deps.orchAssetRuntimeRead.openWorkspace(input.workspaceId);
    const workflowCache = new Map<WorkflowId, WorkflowRuntimeDefinition | null>();
    const roleCache = new Map<RoleId, RuntimeRoleDefinition | null>();
    const getWorkflow = (workflowId: WorkflowId): WorkflowRuntimeDefinition | null => {
      if (!workflowCache.has(workflowId)) {
        workflowCache.set(workflowId, assetSession.getAsset("workflow", workflowId)?.definition ?? null);
      }
      return workflowCache.get(workflowId) ?? null;
    };
    const getRole = (roleId: RoleId): RuntimeRoleDefinition | null => {
      if (!roleCache.has(roleId)) roleCache.set(roleId, assetSession.getAsset("role", roleId)?.definition ?? null);
      return roleCache.get(roleId) ?? null;
    };
    const prepared = candidates.map((candidate) => {
      const workflowId = workflowSelectionMap.get(String(candidate.id)) ?? candidate.recommendedWorkflowId;
      const usesWorkflowOverride = workflowId !== candidate.recommendedWorkflowId;
      if (!workflowId) {
        throw new Error(`候选需求缺少执行流程，不能创建：${candidate.title}`);
      }
      const workflow = getWorkflow(workflowId);
      if (!workflow) {
        throw new Error(`${usesWorkflowOverride ? "候选需求当前选中的流程不存在" : "候选需求推荐的流程不存在"}，不能创建：${candidate.title}`);
      }
      for (const node of workflow.nodes) {
        if (node.type === "role" && node.roleId && !getRole(node.roleId)) {
          throw new Error(`候选需求流程引用的角色不存在，不能创建：${candidate.title}`);
        }
      }
      return { candidate, workflow, usesWorkflowOverride };
    });

    const noticeTs = Date.now();
    const commit = this.deps.db.db.transaction(() => {
      const created = prepared.map(({ candidate, workflow, usesWorkflowOverride }) => {
        const intake = this.deps.db.orchIntakes.create({
          workspaceId: input.workspaceId,
          workspaceScope: session.workspaceScope ?? null,
          triggerMode: "dialog",
          taskType: resolveTaskTypeFromWorkflow(workflow),
          title: normalizeTaskIntakeTitle(candidate.title, candidate.goal),
          goal: String(candidate.goal ?? "").trim(),
          background: composeIntakeBackground(candidate, {
            preserveUiProjectIntegrationBoundary: workflowUsesUiSpecOutput(
              workflow,
              (roleId) => getRole(roleId as RoleId),
            ),
          }),
          acceptanceCriteria: normalizeAcceptanceCriteria(candidate.acceptanceCriteria),
          workbenchItemRefs: null,
          seedArtifactRefs: null,
          constraints: {
            requireUserConfirmation: true,
            nodeApprovalMode: "auto",
          },
          requester: { source: "chat" },
        });
        const proposal = createProposalFromIntake(
          { db: { orchProposals: this.deps.db.orchProposals }, getRole },
          intake,
          workflow,
          usesWorkflowOverride
            ? `按人工改选流程 ${workflow.name} 生成方案`
            : (candidate.recommendedWorkflowReason || `基于需求分析助手推荐流程 ${workflow.name} 生成方案`),
        );
        return { candidateId: candidate.id, intake, proposal };
      });
      const allCandidates = this.deps.db.orchRequirementCandidateDrafts.listBySession(session.id);
      const createdByCandidateId = new Map(created.map((item) => [String(item.candidateId), item] as const));
      const updatedCandidates = sortRequirementCandidates(allCandidates.map((candidate) => {
        const createdEntry = createdByCandidateId.get(String(candidate.id));
        return createdEntry ? markCandidateCreated(candidate, createdEntry) : candidate;
      }));
      this.deps.db.orchRequirementCandidateDrafts.replaceForSession(session.id, updatedCandidates);
      this.deps.db.orchRequirementAnalysisSessions.update({
        ...session,
        status: "completed",
        phase: updatedCandidates.length > 0 && updatedCandidates.every(isCreatedCandidate) ? "done" : session.phase,
        latestTurnSummary: `已创建 ${created.length} 条需求`,
        lastMessageAt: noticeTs,
      });
      return created;
    });
    let created: ReturnType<typeof commit>;
    try {
      created = commit();
    } catch (error) {
      if (error instanceof OrchRequirementAnalysisSessionRepoError) throw error;
      throw new RequirementAnalysisServiceError("ORCH_REQUIREMENT_ANALYSIS_CREATE_FAILED", { sessionId: session.id, workspaceId: input.workspaceId }, error);
    }
    try {
      const dispatch = this.deps.emitConversation({
        ts: noticeTs, workspaceId: input.workspaceId, threadId: session.id as ThreadId, engine: session.engine, type: "system.notice",
        payload: { level: "success", text: [
          `已从当前会话创建 ${created.length} 条需求，并同步生成方案。`,
          ...created.map(item => `- ${item.intake.title}，流程：${item.proposal.draftWorkflow.name}`),
        ].join("\n") },
      });
      if (dispatch?.accepted === false) throw new Error("requirement_analysis_notice_dispatch_rejected");
    } catch (error) {
      throw new RequirementAnalysisServiceError("ORCH_REQUIREMENT_ANALYSIS_NOTICE_FAILED", { sessionId: session.id, workspaceId: input.workspaceId }, error);
    }

    return { created };
  }

  private requireSession(
    workspaceId: WorkspaceId,
    sessionId: RequirementAnalysisSession["id"],
  ): RequirementAnalysisSession | null {
    const thread = this.requireAnalysisThread(workspaceId, sessionId as ThreadId);
    if (thread) return this.ensureSessionRecord(thread);
    const persisted = this.deps.db.orchRequirementAnalysisSessions.get(sessionId);
    if (!persisted || !workspaceIdsReferToSameWorkspace(persisted.workspaceId, workspaceId)) return null;
    const runtimeThreadId = String(persisted.runtimeThreadId ?? persisted.id).trim() as ThreadId;
    if (!runtimeThreadId) {
      this.deps.db.orchRequirementAnalysisSessions.delete(persisted.id);
      return null;
    }
    const runtimeThread = this.requireAnalysisThread(workspaceId, runtimeThreadId);
    if (!runtimeThread) {
      this.deps.db.orchRequirementAnalysisSessions.deleteByThreadId(runtimeThreadId);
      return null;
    }
    return this.ensureSessionRecord(runtimeThread);
  }

  private collectAssetCatalogs(workspaceId: WorkspaceId) {
    return {
      workflows: this.deps.db.orchWorkflows.listByWorkspace(workspaceId),
      roles: this.deps.db.orchRoles.listByWorkspace(workspaceId),
      knowledgeBundles: this.deps.db.orchKnowledgeBundles.listByWorkspace(workspaceId),
      toolsets: this.deps.db.orchToolsets.listByWorkspace(workspaceId),
    };
  }

  /** 冻结本轮需求上下文后释放许可，候选与会话回写再独立准入。 */
  private async runAssistantTurn(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    text: string;
    turnId?: TurnId | null;
    userItemId?: ItemId | null;
    assistantItemId?: string | null;
    reasoningItemId?: string | null;
    planMode?: boolean | null;
    accessMode?: AccessMode | null;
    model?: string | null;
    effort?: string | null;
    images?: string[];
    files?: TextFileAttachment[];
    pathReferences?: WorkspacePathReference[];
    contextWindow?: number | null;
    autoCompactPct?: number | null;
    serviceTier?: CodexServiceTier | null;
  }): Promise<SendAssistantTurnResult> {
    const thread = (await this.withDatabase(() => this.requireAnalysisThread(input.workspaceId, input.threadId)));
    if (!thread) throw new Error(`需求分析线程不存在：${input.threadId}`);
    const session = (await this.withDatabase(() => this.ensureSessionRecord(thread)));
    const runtimeModel = input.model ?? thread.model ?? session.model ?? null;
    const runtimeEffort = input.effort ?? thread.effort ?? session.effort ?? null;
    (await this.withDatabase(() => assertClientReasoningEffortSupported(this.deps.db, thread.engine, runtimeModel, runtimeEffort)));
    const userText = String(input.text ?? "").trim();
    if (!userText && (input.images?.length ?? 0) === 0 && (input.files?.length ?? 0) === 0 && (input.pathReferences?.length ?? 0) === 0) {
      throw new Error("请输入需求描述或补充信息");
    }

    const promptUserText = buildPromptText({
      text: userText,
      files: input.files ?? [],
      pathReferences: input.pathReferences ?? [],
    });
    const historyMessages = (await this.withDatabase(() => this.readThreadMessages(thread.id, { mode: "prompt" })));
    const pendingUserMessage: RequirementAnalysisMessage = {
      id: "__pending__" as RequirementAnalysisMessage["id"],
      sessionId: session.id,
      role: "user",
      content: decoratePromptUserText(promptUserText, input.images ?? []),
      createdAt: Date.now(),
    };
    const existingCandidates = (await this.withDatabase(() => this.deps.db.orchRequirementCandidateDrafts.listBySession(session.id)));
    const catalogs = (await this.withDatabase(() => this.collectAssetCatalogs(input.workspaceId)));
    const runtimeThread = this.ensureRuntimeThread(thread);
    const sessionRuntime = await this.withDatabase(() => this.deps.sessions.getOrCreate(runtimeThread));
    if (sessionRuntime.hasActiveTurn()) {
      throw createActiveTurnConflictError();
    }
    const turnId = input.turnId ?? (`turn_req_analysis_${crypto.randomUUID()}` as TurnId);
    const userItemId = input.userItemId ?? (`item_req_user_${crypto.randomUUID()}` as ItemId);
    const finalAssistantItemId = input.assistantItemId ?? `item_req_assistant_${crypto.randomUUID()}`;
    const reasoningItemId = input.reasoningItemId ?? `item_req_reasoning_${crypto.randomUUID()}`;
    const userCreatedAt = Date.now();
    let responseText = "";

    this.deps.emitConversation({
      ts: userCreatedAt,
      workspaceId: input.workspaceId,
      threadId: thread.id,
      engine: thread.engine,
      type: "turn.started",
      payload: { turnId },
    });
    this.deps.emitConversation({
      ts: userCreatedAt + 1,
      workspaceId: input.workspaceId,
      threadId: thread.id,
      engine: thread.engine,
      type: "item.userMessage.created",
      payload: {
        turnId,
        itemId: userItemId,
        text: userText,
        images: input.images?.length ? input.images : undefined,
        files: input.files?.length ? input.files : undefined,
        pathReferences: input.pathReferences?.length ? input.pathReferences : undefined,
      },
    });

    try {
      const expectedCandidateSetHash = computeRequirementCandidateSetHash(existingCandidates);
      const developerMessage = buildDeveloperPrompt({
        session,
        workflows: catalogs.workflows,
        roles: catalogs.roles,
        knowledgeBundles: catalogs.knowledgeBundles,
        toolsets: catalogs.toolsets,
        expectedCandidateSetHash,
      });
      const toolRegistry = buildRequirementAnalysisSubmissionToolRegistry();
      const toolTransport = await this.withDatabase(() => sessionRuntime.resolvePlatformToolTransport(toolRegistry, "required"));
      if (toolTransport !== "native-dynamic") {
        throw new Error("当前需求分析助手所需的真实工具提交流程不可用，无法继续本轮需求分析。");
      }
      const sendAssistantDraft = async (draftUserText: string, currentDraftAssistantItemId: string, currentReasoningItemId: string) => {
        responseText = "";
        let submittedResult: NormalizedAssistantResult | null = null;
        let sendResult: { responseText: string } | null = null;
        const bufferedAssistantEvents: ConversationEventInput[] = [];
        let bufferedAssistantText = "";
        let validationErrors: string[] = [];
        try {
          sendResult = await sessionRuntime.sendMessage(
            {
              turnId,
              userItemId,
              text: buildTurnUserMessage({
                session,
                messages: [...historyMessages, pendingUserMessage],
                existingCandidates,
                userText: draftUserText,
              }),
              userMessage: draftUserText,
              systemMessage: buildSystemPrompt(),
              developerMessage,
              toolRegistryJson: JSON.stringify(toolRegistry),
              toolRegistry,
              platformToolTransportRequirement: "required",
              executeHostTool: async ({ toolId, toolInput }) => {
                if (toolId !== REQUIREMENT_ANALYSIS_SUBMIT_TOOL_ID) {
                  return {
                    ok: false,
                    message: `需求分析助手未注册工具：${toolId}`,
                    code: "TOOL_NOT_FOUND",
                  } satisfies HostToolExecutionResult;
                }
                try {
                  const normalized = normalizeAssistantPayload({
                    sessionId: session.id,
                    raw: toolInput,
                    existingCandidates,
                    workflows: catalogs.workflows,
                    roles: catalogs.roles,
                    knowledgeBundles: catalogs.knowledgeBundles,
                    toolsets: catalogs.toolsets,
                  });
                  if (normalized.meta.validationErrors.length > 0) {
                    validationErrors = [...normalized.meta.validationErrors];
                    return {
                      ok: false,
                      message: `需求分析结果未通过平台校验：${normalized.meta.validationErrors.join("；")}`,
                      code: normalized.meta.failureCode ?? "VALIDATION_FAILED",
                      output: {
                        validationErrors: normalized.meta.validationErrors,
                      },
                    } satisfies HostToolExecutionResult;
                  }
                  submittedResult = normalized;
                  return {
                    ok: true,
                    output: {
                      accepted: true,
                      phase: normalized.payload.phase,
                      candidateCount: normalized.drafts.length,
                    },
                  } satisfies HostToolExecutionResult;
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  validationErrors = [errorMessage];
                  return {
                    ok: false,
                    message: errorMessage,
                    code: "VALIDATION_FAILED",
                    output: {
                      validationErrors,
                    },
                  } satisfies HostToolExecutionResult;
                }
              },
              responseFormat: "text",
              providerNativeToolPolicy: "allow",
              conversationProfile: "orchestration",
              workMode: "general",
              planMode: Boolean(input.planMode ?? false),
              images: input.images ?? [],
              assistantItemId: currentDraftAssistantItemId,
              reasoningItemId: currentReasoningItemId,
              accessMode: input.accessMode ?? thread.accessMode ?? ("read-only" satisfies AccessMode),
              model: input.model ?? thread.model ?? session.model ?? null,
              effort: input.effort ?? thread.effort ?? session.effort ?? null,
              contextWindow: input.contextWindow ?? null,
              autoCompactPct: input.autoCompactPct ?? null,
              serviceTier: input.serviceTier ?? null,
              timeoutPolicy: this.deps.timeoutPolicy,
            },
            {
              conversation: (event) => {
                if (
                  event.type === "item.agentMessage.started"
                  || event.type === "item.agentMessage.delta"
                  || event.type === "item.agentMessage.snapshot"
                  || event.type === "item.agentMessage.completed"
                ) {
                  bufferedAssistantEvents.push(event);
                  if (event.type === "item.agentMessage.delta") {
                    bufferedAssistantText += String((event.payload as any)?.delta ?? "");
                  } else if (event.type === "item.agentMessage.snapshot" || event.type === "item.agentMessage.completed") {
                    bufferedAssistantText = String((event.payload as any)?.text ?? "");
                  }
                }
                if (event.type === "item.agentMessage.completed") {
                  responseText = String((event.payload as any)?.text ?? "");
                  return;
                }
                if (event.type === "item.agentMessage.started" || event.type === "item.agentMessage.delta" || event.type === "item.agentMessage.snapshot") {
                  return;
                }
                this.deps.emitConversation(event);
              },
              raw: (event) => {
                this.deps.emitRaw(event);
              },
            },
          );
        } catch (error) {
          if (!submittedResult) throw error;
        }
        if (!responseText.trim()) {
          responseText = bufferedAssistantText.trim() || String(sendResult?.responseText ?? "").trim();
        }
        return {
          responseText,
          submittedResult,
          bufferedAssistantCompletedEvents: bufferedAssistantEvents
            .filter((event) => event.type === "item.agentMessage.completed"),
          validationErrors,
        };
      };

      let draftResult = await sendAssistantDraft(
        promptUserText,
        `item_req_commentary_${crypto.randomUUID()}`,
        reasoningItemId,
      );
      const submissionValidationErrors = [...draftResult.validationErrors];
      for (let attempt = 1; !draftResult.submittedResult && attempt < MAX_SUBMISSION_ATTEMPTS; attempt += 1) {
        draftResult = await sendAssistantDraft(
          buildSubmissionRepairPrompt({
            expectedCandidateSetHash,
            validationErrors: draftResult.validationErrors,
            previousResponse: draftResult.responseText,
          }),
          `item_req_commentary_${crypto.randomUUID()}`,
          `item_req_reasoning_${crypto.randomUUID()}`,
        );
        submissionValidationErrors.push(...draftResult.validationErrors);
      }
      responseText = draftResult.responseText;
      const normalizedResult = draftResult.submittedResult as NormalizedAssistantResult | null;
      if (!normalizedResult) {
        const validationDetail = submissionValidationErrors.length > 0
          ? `：${[...new Set(submissionValidationErrors)].join("；")}`
          : "。";
        const error = new Error(
          `需求分析助手在本轮结束前没有成功调用 ${REQUIREMENT_ANALYSIS_SUBMIT_TOOL_ID} 提交结果${validationDetail}`,
        ) as Error & { code: typeof REQUIREMENT_ANALYSIS_SUBMISSION_NOT_ACCEPTED_CODE };
        error.code = REQUIREMENT_ANALYSIS_SUBMISSION_NOT_ACCEPTED_CODE;
        throw error;
      }
      const payload = normalizedResult.payload;
      const candidates = (await this.withDatabase(() => this.deps.db.orchRequirementCandidateDrafts.replaceForSession(session.id, normalizedResult.drafts)));
      const userMessage: RequirementAnalysisMessage = {
        id: userItemId as RequirementAnalysisMessage["id"],
        sessionId: session.id,
        role: "user",
        content: userText,
        createdAt: userCreatedAt,
      };
      const reconciledAssistantTerminal = await sessionRuntime.prepareAssistantTerminalEvents({
        turnId,
        outcome: "completed",
      });
      const assistantCreatedAt = Date.now();
      const assistantMessage: RequirementAnalysisMessage = {
        id: finalAssistantItemId as RequirementAnalysisMessage["id"],
        sessionId: session.id,
        role: "assistant",
        content: payload.assistantReply,
        structuredPayloadJson: JSON.stringify(payload),
        createdAt: assistantCreatedAt,
      };
      this.deps.emitConversation({
        ts: assistantMessage.createdAt,
        workspaceId: input.workspaceId,
        threadId: thread.id,
        engine: thread.engine,
        type: "item.agentMessage.completed",
        payload: {
          itemId: finalAssistantItemId as ItemId,
          engineMessageId: finalAssistantItemId,
          text: payload.assistantReply,
          revision: 1,
          phase: "structured_result",
          completionSource: "synthetic_structured_result",
          structuredPayloadJson: assistantMessage.structuredPayloadJson,
        },
      });

      const nextSession = (await this.withDatabase(() => this.deps.db.orchRequirementAnalysisSessions.update({
        ...session,
        title: resolveSessionTitle(session, payload, [...historyMessages, userMessage]),
        status: payload.phase === "done" ? "completed" : "active",
        phase: payload.phase,
        model: input.model ?? thread.model ?? session.model ?? null,
        effort: input.effort ?? thread.effort ?? session.effort ?? null,
        latestTurnSummary: payload.conversationSummary,
        latestAssistantReply: payload.assistantReply,
        lastMessageAt: assistantMessage.createdAt,
        runtimeThreadId: thread.id,
        engineSessionId: runtimeThread.sessionId ?? thread.sessionId ?? session.engineSessionId ?? null,
      })));

      this.deps.emitConversation({
        ts: assistantMessage.createdAt,
        workspaceId: input.workspaceId,
        threadId: thread.id,
        engine: thread.engine,
        type: "turn.completed",
        payload: {
          turnId,
          result: {
            responseText: assistantMessage.content || reconciledAssistantTerminal.latestAssistantText || responseText,
          },
        },
      });

      return {
        session: nextSession,
        userMessage,
        assistantMessage,
        candidates,
        payload,
      };
    } catch (error) {
      this.deps.emitConversation(createTurnErrorEventInputFromError({
        ts: Date.now(),
        workspaceId: input.workspaceId,
        threadId: thread.id,
        engine: thread.engine,
        turnId,
        error,
      }));
      throw error;
    }
  }

  private requireAnalysisThread(workspaceId: WorkspaceId, threadId: ThreadId) {
    const thread = this.deps.db.threads.get(threadId);
    if (!thread || !workspaceIdsReferToSameWorkspace(thread.workspaceId, workspaceId)) return null;
    if (thread.threadSubtype !== "requirement-analysis") return null;
    return thread;
  }

  /** 比较已知入口、共享线程与 RA 事实；空归属保持未知，不从缺省标记推导个人。 */
  private readThreadWorkspaceScope(
    thread: { id: ThreadId; workspaceId: WorkspaceId; sharedWorkspaceId?: string | null },
    existing: RequirementAnalysisSession | null,
  ): NodeExecutionProfileScope | null {
    const details = { sessionId: String(thread.id), workspaceId: String(thread.workspaceId) };
    let requestScope: NodeExecutionProfileScope | null;
    try {
      requestScope = readIntakeWorkspaceScope(this.deps.intakeWorkspaceScope, thread.workspaceId);
    } catch {
      throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_SCOPE_INVALID", details);
    }
    const scopes = [requestScope, thread.sharedWorkspaceId ? { scopeType: "shared_workspace", scopeId: thread.sharedWorkspaceId } : null, existing?.workspaceScope]
      .filter((scope): scope is NodeExecutionProfileScope => Boolean(scope));
    if ((existing && existing.workspaceId !== thread.workspaceId)
      || scopes.some(scope => scope.scopeType !== scopes[0]!.scopeType || scope.scopeId !== scopes[0]!.scopeId)) {
      throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", details);
    }
    return requestScope;
  }

  /** 初次创建可写可信范围；其余调用只同步元数据并保留历史未知。 */
  private ensureSessionRecord(thread: {
    id: ThreadId;
    workspaceId: WorkspaceId;
    title: string;
    engine: EngineType;
    sessionId?: string | null;
    model?: string | null;
    effort?: string | null;
    archived?: boolean;
    sharedWorkspaceId?: string | null;
    createdAt: number;
    updatedAt: number;
  }, initializeNew = false): RequirementAnalysisSession {
    const existing = this.deps.db.orchRequirementAnalysisSessions.get(thread.id as any);
    const requestScope = this.readThreadWorkspaceScope(thread, existing);
    if (!existing) {
      return this.deps.db.orchRequirementAnalysisSessions.create({
        id: thread.id as any,
        workspaceId: thread.workspaceId,
        workspaceScope: initializeNew ? requestScope : null,
        title: normalizeSessionTitle(thread.title),
        status: thread.archived ? "archived" : "active",
        phase: "discover",
        engine: thread.engine,
        model: thread.model ?? null,
        effort: thread.effort ?? null,
        runtimeThreadId: thread.id,
        engineSessionId: thread.sessionId ?? null,
        latestTurnSummary: null,
        latestAssistantReply: null,
        lastMessageAt: thread.updatedAt,
      });
    }
    const nextSession: RequirementAnalysisSession = {
      ...existing,
      workspaceId: thread.workspaceId,
      title: normalizeSessionTitle(thread.title),
      status: thread.archived
        ? "archived"
        : existing.status === "archived"
          ? "active"
          : existing.status,
      engine: thread.engine,
      model: thread.model ?? existing.model ?? null,
      effort: thread.effort ?? existing.effort ?? null,
      runtimeThreadId: thread.id,
      engineSessionId: thread.sessionId ?? existing.engineSessionId ?? null,
      lastMessageAt: Math.max(existing.lastMessageAt, thread.updatedAt),
    };
    if (
      nextSession.workspaceId === existing.workspaceId
      && nextSession.title === existing.title
      && nextSession.status === existing.status
      && nextSession.engine === existing.engine
      && (nextSession.model ?? null) === (existing.model ?? null)
      && (nextSession.effort ?? null) === (existing.effort ?? null)
      && (nextSession.runtimeThreadId ?? null) === (existing.runtimeThreadId ?? null)
      && (nextSession.engineSessionId ?? null) === (existing.engineSessionId ?? null)
      && nextSession.lastMessageAt === existing.lastMessageAt
    ) {
      return existing;
    }
    return this.deps.db.orchRequirementAnalysisSessions.update(nextSession);
  }

  private ensureRuntimeThread(thread: {
    id: ThreadId;
    workspaceId: WorkspaceId;
    engine: EngineType;
    title: string;
    sessionId?: string | null;
  }) {
    const runtime = this.deps.threads.create({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      engine: thread.engine,
      title: thread.title,
      sessionId: thread.sessionId as any,
      sessionCapabilities: (thread as any).sessionCapabilities ?? null,
    });
    if (thread.sessionId && !runtime.sessionId) {
      this.deps.threads.setSessionBinding(
        runtime.threadId,
        thread.sessionId as any,
        (thread as any).sessionCapabilities ?? null,
      );
    }
    return runtime;
  }

  private ensureWelcomeMessage(session: RequirementAnalysisSession, welcomeText: string): RequirementAnalysisMessage | null {
    const history = this.readThreadMessages(session.id as ThreadId);
    if (history.some((item) => item.role === "assistant")) return null;
    const createdAt = Date.now();
    const itemId = `item_req_welcome_${crypto.randomUUID()}`;
    this.deps.emitConversation({
      ts: createdAt,
      workspaceId: session.workspaceId,
      threadId: session.id as ThreadId,
      engine: session.engine,
      type: "item.agentMessage.completed",
      payload: {
        itemId: itemId as ItemId,
        engineMessageId: `welcome_${session.id}`,
        text: welcomeText,
        revision: 0,
      },
    });
    this.deps.db.orchRequirementAnalysisSessions.update({
      ...session,
      latestAssistantReply: welcomeText,
      lastMessageAt: createdAt,
    });
    return {
      id: itemId as RequirementAnalysisMessage["id"],
      sessionId: session.id,
      role: "assistant",
      content: welcomeText,
      createdAt,
    };
  }

  private readThreadMessages(
    threadId: ThreadId,
    opts?: { mode?: "display" | "prompt" },
  ): RequirementAnalysisMessage[] {
    const events = this.deps.db.conversationEvents.listByThread(threadId, { limit: 400 });
    const mode = opts?.mode ?? "display";
    const out: RequirementAnalysisMessage[] = [];
    for (const event of events) {
      if (event.type === "item.userMessage.created") {
        const rawText = String(event.payload.text ?? "");
        const baseText = mode === "prompt"
          ? buildPromptText({ text: rawText, files: event.payload.files ?? [], pathReferences: event.payload.pathReferences ?? [] })
          : rawText;
        out.push({
          id: event.payload.itemId as RequirementAnalysisMessage["id"],
          sessionId: threadId as any,
          role: "user",
          content: mode === "prompt" ? decoratePromptUserText(baseText, event.payload.images ?? []) : rawText,
          createdAt: Number(event.ts ?? Date.now()),
        });
        continue;
      }
      if (event.type === "item.agentMessage.completed") {
        if (event.payload.phase === "commentary") continue;
        out.push({
          id: event.payload.itemId as RequirementAnalysisMessage["id"],
          sessionId: threadId as any,
          role: "assistant",
          content: String(event.payload.text ?? ""),
          structuredPayloadJson: event.payload.structuredPayloadJson ?? null,
          createdAt: Number(event.ts ?? Date.now()),
        });
        continue;
      }
      if (event.type === "system.notice") {
        out.push({
          id: `sys_${String((event as any).seq ?? event.ts ?? Date.now())}` as RequirementAnalysisMessage["id"],
          sessionId: threadId as any,
          role: "system",
          content: String(event.payload.text ?? ""),
          createdAt: Number(event.ts ?? Date.now()),
        });
      }
    }
    return out;
  }
}

function buildWelcomeMessage(input: {
  workflows: WorkflowDefinition[];
  roles: Array<{ name: string }>;
  knowledgeBundles: Array<{ name: string }>;
}): string {
  return [
    "请直接描述您的目标、范围、页面或业务背景。我会先判断是否需要拆一期/后续，再收敛成可创建的需求候选，并判断是否需要 UI/架构/技术设计，以及当前工作区里哪条流程最合适。",
    `当前工作区可用资产：${input.workflows.length} 条流程、${input.roles.length} 个角色、${input.knowledgeBundles.length} 个知识库。`,
    "如果遇到微信支付、第三方平台规则、法律合规或其他陌生业务域，我会先查权威资料，再回到需求拆解；只有需要长期复用时，才建议沉淀为知识库。",
    "如果您一次说了多个目标，或者一个大需求里其实包含多个独立闭环/后续阶段，我会主动拆成多条候选需求供您分别创建。",
  ].join("\n");
}

function buildSystemPrompt(): string {
  return [
    "您是 CodeFlow 的需求分析助手。",
    "您的目标是把用户的自然语言诉求整理成可创建的结构化需求候选，并基于当前工作区已有流程、角色、知识库、工具集给出解释性推荐。",
    "如果涉及微信支付、第三方平台规则、签名验签、法律合规等陌生业务域或权威性要求高的事实，优先使用可用原生工具查阅官方文档、标准或其他权威资料，再回到需求分析。",
    "不要把“当前工作区没有某个知识库”直接等同于“无法理解该业务域”；知识库缺口只表示缺少可复用的工作区资产，不等于外部资料不可获得。",
    "您必须先判断需求边界是否已经足够清晰，再决定是继续澄清还是直接推荐流程；不要臆造不存在的资产 ID；允许一次会话拆分多个候选需求。",
    "先做 MMF 分期判断，再做规模估算。不要把“一期/二期”和“开发大小”混成一个总分。",
  ].join("\n");
}

/** 构建 thread 生命周期内保持稳定的需求分析提交工具。 */
function buildRequirementAnalysisSubmissionToolRegistry() {
  return {
    tools: [{
      toolsetId: REQUIREMENT_ANALYSIS_TOOLSET_ID as any,
      toolsetName: "内建需求分析提交",
      toolId: REQUIREMENT_ANALYSIS_SUBMIT_TOOL_ID as any,
      name: "提交需求分析结果",
      alias: null,
      description: "把当前轮需求分析的结构化结果正式提交给平台。平台会立即做结构与语义校验；通过后，候选需求和会话状态会被更新。",
      runtime: "builtin" as const,
      usageGuidance: "只有当本轮的 conversationSummary、assistantReply、questions、candidateMutations 和 nextAction 都整理完整后才调用。v2 只提交本轮候选变更：新增用 create，修改用 update，删除草稿用 delete；省略候选表示保持不变。调用成功就代表本轮结构化分析已经提交。",
      invocationHint: [
        "{",
        `  "schemaVersion": "${ASSISTANT_SCHEMA_VERSION}",`,
        '  "baseCandidateSetHash": "从本轮提示中原样复制的 24 位 hash",',
        '  "phase": "recommend",',
        '  "conversationSummary": "当前回合的总结",',
        '  "assistantReply": "给用户看的中文说明",',
        '  "needUserInput": false,',
        '  "questions": [],',
        '  "candidateMutations": [],',
        '  "nextAction": { "type": "ready-to-create", "targetCandidateIds": [], "note": null }',
        "}",
      ].join("\n"),
      code: "",
      inputSchema: JSON.stringify({
        type: "object",
        required: ["schemaVersion", "baseCandidateSetHash", "phase", "conversationSummary", "assistantReply", "needUserInput", "questions", "candidateMutations", "nextAction"],
        properties: {
          schemaVersion: { type: "string" },
          baseCandidateSetHash: {
            type: "string",
            minLength: 24,
            maxLength: 24,
            pattern: "^[0-9a-f]{24}$",
            description: "必须原样复制本轮 developer/user 提示中的候选集合 hash，禁止重新计算或扩展为 64 位 SHA-256。",
          },
          phase: { type: "string" },
          conversationSummary: { type: "string" },
          assistantReply: { type: "string" },
          needUserInput: { type: "boolean" },
          questions: { type: "array", items: { type: "object" } },
          candidateMutations: { type: "array", items: { type: "object" } },
          nextAction: { type: "object" },
        },
      }),
      outputSchema: JSON.stringify({
        type: "object",
        required: ["accepted", "phase", "candidateCount"],
        properties: {
          accepted: { type: "boolean" },
          phase: { type: "string" },
          candidateCount: { type: "number" },
        },
      }),
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: true,
    }],
  };
}

/** 构建每轮 developer 提示，并注入当前候选快照的精确 hash。 */
function buildDeveloperPrompt(input: {
  session: RequirementAnalysisSession;
  workflows: WorkflowDefinition[];
  roles: Array<{
    id: string;
    name: string;
    description: string;
    responsibility?: string | null;
    defaultKnowledgeBundleIds?: string[] | null;
  }>;
  knowledgeBundles: Array<{
    id: string;
    name: string;
    scope: string;
    description: string;
  }>;
  toolsets: Array<{
    id: string;
    name: string;
    description: string;
    tools: Array<{ id: string; name: string }>;
  }>;
  expectedCandidateSetHash: string;
}): string {
  const workflowCatalog = input.workflows.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    family: workflow.family ?? "feature-dev",
    description: workflow.description,
    workflowKnowledgeBundleIds: workflow.workflowKnowledgeBundleIds ?? [],
    nodeLabels: workflow.nodes.map((node) => node.label),
    roleNodeCount: workflow.nodes.filter((node) => node.type === "role" && node.roleId).length,
  }));
  const roleCatalog = input.roles.map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    responsibility: role.responsibility ?? "",
    defaultKnowledgeBundleIds: role.defaultKnowledgeBundleIds ?? [],
  }));
  const bundleCatalog = input.knowledgeBundles.map((bundle) => ({
    id: bundle.id,
    name: bundle.name,
    scope: bundle.scope,
    description: bundle.description,
  }));
  const toolsetCatalog = input.toolsets.map((toolset) => ({
    id: toolset.id,
    name: toolset.name,
    description: toolset.description,
    toolNames: (toolset.tools ?? []).map((tool) => tool.name),
  }));

  return [
    `当您准备好本轮需求分析的结构化结果时，必须直接调用工具 ${REQUIREMENT_ANALYSIS_SUBMIT_TOOL_ID} 提交。`,
    "不要通过 assistant 文本输出任何 JSON 协议，也不要把结构化 payload 放在自然语言正文里。",
    "工具成功返回后，您可以再补一句自然语言总结，但那只是说明，不是提交事实。",
    `schemaVersion 固定为 ${ASSISTANT_SCHEMA_VERSION}；旧版 ${LEGACY_ASSISTANT_SCHEMA_VERSION} 仅用于兼容历史结果，本轮不要主动使用。`,
    `baseCandidateSetHash 必须原样提交为 ${input.expectedCandidateSetHash}；禁止重新计算、补全或扩展为 64 位 SHA-256。`,
    "工具入参中的所有字段都必须可 JSON.parse。",
    "questions 最多 3 条，且每条都必须是当前判断下最关键的澄清问题。",
    "assistantReply 用中文，语气直接，先给当前理解，再说明判断，再提出必要问题或创建建议。",
    "candidateMutations 表示本轮候选变更补丁，不是完整候选集合；省略某个既有候选表示保持不变，不能为了省事重复输出全部候选。",
    "新增候选使用 op=create，candidate 必须包含完整候选字段；更新候选使用 op=update，只在 patch 中放本轮要改的字段；删除候选使用 op=delete，必须是用户明确取消的草稿候选并写明 reason。",
    "如果用户一次说了多个独立目标，请通过多个 create mutation 拆成多个候选。",
    "如果用户只说了一个大需求，但其中包含多个独立价值假设、多个独立验收闭环，或明显的核心能力与后续商品化/运营化阶段，也必须通过 create mutation 拆分，不能只给一期、不交代后续。",
    "每条新增或更新后的候选都必须先做 phasingAssessment，再做 sizeAssessment。phasingAssessment 负责判断这条候选是不是一个可独立验收的 MMF 切片；sizeAssessment 只负责估算实现规模，不负责决定一期二期。",
    "当前目录的作用是做资产匹配，不是限制您只能依赖这些目录理解业务。遇到陌生业务域、第三方平台规则或事实性问题时，先使用可用原生工具查阅官方文档、标准、平台规则或其他权威资料，再继续分析。",
    "recommendedWorkflowId、recommendedRoleIds、recommendedKnowledgeBundleIds 只能从下面目录里选择已有 ID；没有合适项时可以返回 null/空数组。",
    "只有当后续正式执行确实依赖缺失的可复用工作区资产时，才在 assetGaps 中声明 blocking 缺口。不要因为当前工作区没有支付域或其他外部领域知识库，就直接输出 knowledge-bundle blocking gap。",
    "对于外部调研得到的稳定规则，请优先写入 background、acceptanceCriteria、assumptions 或非阻塞 openQuestions，而不是默认转成 knowledge-bundle 缺口。",
    "需求助手创建正式需求时必须同步生成方案，所以只有在已经选定推荐流程时，候选需求才允许进入 readyToCreate=true。",
    "已经创建过正式需求的候选会作为历史记录保留；不要 update/delete 已创建候选，除非用户明确要求重做或拆出新的需求，此时应 create 新候选。",
    "每条 create candidate 或 update patch 后的候选都必须具备 recommendedApproach，用一句到两句中文告诉用户当前最建议如何收敛这个需求，而不是只重复风险提示。",
    "所有 candidate.title 都必须适合作为后续文件目录名：总长度不超过 48 个字符，不能包含 Windows 路径非法字符 < > : \" / \\ | ? *，不能以点号结尾，也不能使用 CON/NUL/COM1 这类 Windows 保留设备名。",
    "phasingAssessment.scopeDecision=fit 的前提是：这条候选只验证一个核心价值假设、只承诺一个独立验收闭环，并且当前范围足以独立验收。",
    "当 deliverySlice=phase-1 时，必须在 outOfScope 明确列出当前不做的内容；如果当前会话里出现了 phase-1 candidate，通常还应同时输出至少一个 follow-up candidate。",
    "如果本轮输出多个 draft candidates，所有草稿候选的 title 还必须严格按输出顺序使用“第1期-标题 / 第2期-标题 / 第3期-标题”格式；若当前候选快照里已有 created 历史候选，则从已创建历史期次后继续顺延；分隔符固定为半角短横线。",
    "如果某条 candidate 推荐了 UI/UX 原型设计角色，那么“当前明确不纳入真实前端代码改造”只表示不做正式业务逻辑落地，不等于禁止在现有前端项目里新增隔离的 prototype/prototypes 目录、页面、路由和 mock 数据来复用既有壳层、布局、主题和组件。",
    "除非用户明确要求独立静态原型，或仓库里确实没有可复用前端项目，否则不要把“项目集成原型模式”排除在 UI candidate 的建议方案和 outOfScope 之外。",
    "当 scopeDecision=needs-split 时，不允许 readyToCreate=true，且必须通过 clarificationItems 或新增 follow-up candidates 继续收敛。",
    "只要某条候选需求还不能创建，就必须输出 clarificationItems，至少 1 条；每条都要写清楚待澄清事项、原因和您建议用户补充的方向，不要只给一个“待澄清”标签。",
    "clarificationItems 里的每一项都必须带 options，通常给 2 到 4 个可直接点击的选项；至少 1 个 option.recommended=true，并且 option.value 必须是可以直接回传给需求助手的自然语言答案。",
    "clarificationItems.allowCustom 默认 true，answerPlaceholder 给用户一个直接补充的提示。",
    "openQuestions 只允许记录不阻塞当前创建的后续问题；凡是需要用户先回答才能创建的阻塞问题，必须写入 clarificationItems，不能只写 openQuestions。",
    "每条 create candidate 或 update patch 后的候选都必须具备 phasingAssessment。phasingAssessment.signals 必须包含 benefitHypothesisCount、acceptanceLoopCount、actorSurfaceCount、externalSystemCount、newCoreModelCount 五个整数维度。",
    "MMF 分期判断不是主观猜测。请按这套规则判断：如果 benefitHypothesisCount > 1，或 acceptanceLoopCount > 1，或 actorSurfaceCount > 1 且这些端面可独立验收，或 externalSystemCount >= 1 且 newCoreModelCount > 1，则默认不能把原始诉求直接当成一个单一一期候选。",
    "每条 create candidate 或 update patch 后的候选都必须具备 sizeAssessment。sizeAssessment.signals 必须包含 functionalProcessCount、domainEntityCount、stateTransitionCount、interactionSurfaceCount、externalIntegrationCount、asyncConsistencyRiskCount、clientSurfaceCount 七个整数维度。",
    "规模估算借鉴功能点/功能过程思路，但采用当前产品更易执行的简化模型：score = 功能过程*3 + 领域对象*2 + 状态流转*2 + 交互界面*2 + 外部集成*4 + 异步一致性风险*4 + 交付端面*2。系统会根据 score 自动换算 small/standard/large，所以您必须认真给出 signals、summary、reasoning。",
    "readyToCreate 只有在标题、目标、验收、流程建议已经足够清晰且没有 blocking 级资产缺口时才可为 true。",
    "nextAction.type 只能是 wait-user-reply / ready-to-create / needs-assets / review-candidates。",
    `当前会话：${JSON.stringify({
      sessionId: input.session.id,
      phase: input.session.phase,
      title: input.session.title,
      latestTurnSummary: input.session.latestTurnSummary ?? null,
    })}`,
    `流程目录：${JSON.stringify(workflowCatalog)}`,
    `角色目录：${JSON.stringify(roleCatalog)}`,
    `知识库目录：${JSON.stringify(bundleCatalog)}`,
    `工具集目录：${JSON.stringify(toolsetCatalog)}`,
    [
      `工具 ${REQUIREMENT_ANALYSIS_SUBMIT_TOOL_ID} 的入参骨架：`,
      "{",
      '  "schemaVersion": "requirement-analysis-assistant/v2",',
      '  "baseCandidateSetHash": "使用本轮用户提示中的当前候选集合 hash",',
      '  "phase": "discover|clarify|split|recommend|confirm|done",',
      '  "conversationSummary": "string",',
      '  "assistantReply": "string",',
      '  "needUserInput": true,',
      '  "questions": [{ "id": "string", "question": "string", "reason": "string", "impact": "scope|acceptance|workflow|ui-scope|architecture|assets|delivery" }],',
      '  "candidateMutations": [{',
      '    "op": "create|update|delete",',
      '    "candidateId": "既有候选用当前候选索引里的精确 candidateId；新增候选可给短 id",',
      '    "candidate": {',
      '      "title": "string",',
      '      "goal": "string",',
      '      "background": "string|null",',
      '      "acceptanceCriteria": [{ "text": "string" }],',
      '      "splitSource": "single|split-from-batch",',
      '      "complexity": "small|standard|large|unknown",',
      '      "uiScope": "none|light|heavy|unknown",',
      '      "architectureRisk": "low|medium|high|unknown",',
      '      "recommendedWorkflowId": "string|null",',
      '      "recommendedWorkflowName": "string|null",',
      '      "recommendedWorkflowReason": "string",',
      '      "recommendedApproach": "string",',
      '      "recommendedRoleIds": ["roleId"],',
      '      "recommendedKnowledgeBundleIds": ["bundleId"],',
      '      "phasingAssessment": { "scopeDecision": "fit|needs-split", "deliverySlice": "single-phase|phase-1|follow-up", "summary": "string", "reasoning": "string", "signals": { "benefitHypothesisCount": 1, "acceptanceLoopCount": 1, "actorSurfaceCount": 1, "externalSystemCount": 0, "newCoreModelCount": 0 }, "outOfScope": ["string"] },',
      '      "sizeAssessment": { "model": "functional-size-v2", "summary": "string", "reasoning": "string", "signals": { "functionalProcessCount": 0, "domainEntityCount": 0, "stateTransitionCount": 0, "interactionSurfaceCount": 0, "externalIntegrationCount": 0, "asyncConsistencyRiskCount": 0, "clientSurfaceCount": 1 } },',
      '      "assetGaps": [{ "kind": "workflow|role|knowledge-bundle|toolset", "severity": "blocking|warning", "code": "string", "message": "string", "suggestion": "string|null" }],',
      '      "clarificationItems": [{ "question": "string", "reason": "string", "suggestion": "string", "impact": "scope|acceptance|workflow|ui-scope|architecture|assets|delivery", "options": [{ "id": "string", "label": "string", "value": "string", "recommended": true }], "allowCustom": true, "answerPlaceholder": "string|null" }],',
      '      "assumptions": ["string"],',
      '      "openQuestions": ["string"],',
      '      "readyToCreate": true',
      "    },",
      '    "patch": { "只在 op=update 时填写本轮要修改的 candidate 字段": true },',
      '    "reason": "只在 op=delete 时填写删除原因"',
      "  }],",
      '  "nextAction": { "type": "wait-user-reply|ready-to-create|needs-assets|review-candidates", "targetCandidateIds": ["string"], "note": "string|null" }',
      "}",
    ].join("\n"),
  ].join("\n\n");
}

function buildTurnUserMessage(input: {
  session: RequirementAnalysisSession;
  messages: RequirementAnalysisMessage[];
  existingCandidates: RequirementCandidateDraft[];
  userText: string;
}): string {
  const history = input.messages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => `${message.role === "assistant" ? "助手" : message.role === "system" ? "系统" : "用户"}：${message.content}`)
    .join("\n\n");
  const candidateSetHash = computeRequirementCandidateSetHash(input.existingCandidates);
  const candidateIndex = input.existingCandidates.map((candidate) => ({
    candidateId: candidate.id,
    creationState: candidate.creationState === "created" ? "created" : "draft",
    title: candidate.title,
    recommendedWorkflowId: candidate.recommendedWorkflowId ?? null,
    readyToCreate: candidate.readyToCreate,
    clarificationItemCount: candidate.clarificationItems.length,
    assetGapCount: candidate.assetGaps.length,
    summaryHash: computeRequirementCandidateHash(candidate),
  }));
  const candidateDetails = input.existingCandidates
    .filter((candidate) => candidate.clarificationItems.length > 0 || !candidate.readyToCreate || candidate.assetGaps.length > 0)
    .slice(0, 6)
    .map(candidateDraftToRawCandidate);

  return [
    "请基于以下上下文继续本轮需求分析。",
    `会话阶段：${input.session.phase}`,
    `最近总结：${input.session.latestTurnSummary ?? "无"}`,
    history ? `最近对话：\n${history}` : "",
    `当前候选集合 hash：${candidateSetHash}`,
    `当前候选需求索引：${JSON.stringify(candidateIndex)}`,
    candidateDetails.length ? `需关注候选详情：${JSON.stringify(candidateDetails)}` : "",
    `用户本轮输入：${input.userText}`,
  ].filter(Boolean).join("\n\n");
}

/** 规范化需求助手提交结果，并保留校验错误供模型自修复。 */
function normalizeAssistantPayload(input: {
  sessionId: RequirementAnalysisSession["id"];
  raw: any;
  existingCandidates: RequirementCandidateDraft[];
  workflows: WorkflowDefinition[];
  roles: Array<{ id: string; name: string }>;
  knowledgeBundles: Array<{ id: string; name: string }>;
  toolsets: Array<{ id: string; name: string }>;
}): NormalizedAssistantResult {
  const workflowIndex = createEntityIndex(input.workflows.map((item) => ({ id: String(item.id), name: item.name })));
  const roleIndex = createEntityIndex(input.roles);
  const knowledgeIndex = createEntityIndex(input.knowledgeBundles);
  const rawPayload = isAssistantPayloadObject(input.raw) ? input.raw : {};
  const schemaVersion = normalizeAssistantSchemaVersion(rawPayload.schemaVersion);
  const baseCandidateSetHash = computeRequirementCandidateSetHash(input.existingCandidates);
  const mutationPlan = schemaVersion === ASSISTANT_SCHEMA_VERSION
    ? buildCandidateMutationPlan({
      raw: rawPayload,
      existingCandidates: input.existingCandidates,
      baseCandidateSetHash,
      sessionId: input.sessionId,
    })
    : null;
  const existingById = new Map(input.existingCandidates.map((candidate) => [String(candidate.id), candidate] as const));
  const existingByKey = new Map(
    input.existingCandidates.map((candidate) => [candidateIdentityKey(candidate.title, candidate.goal), candidate] as const),
  );
  const createdPhaseOffset = resolveCreatedCandidatePhaseOffset(input.existingCandidates);
  const shapeValidationErrors = validateAssistantPayloadShape(input.raw, schemaVersion);
  const rawCandidates = mutationPlan
    ? mutationPlan.rawCandidates
    : Array.isArray(rawPayload.candidates)
    ? rawPayload.candidates.filter(isAssistantPayloadObject)
    : [];

  const activeEntries: Array<{
    candidate: RequirementCandidateDraft;
    meta: {
      candidateId: string;
      title: string;
      submittedTitle: string;
      creationState: RequirementCandidateDraft["creationState"];
      readyToCreate: boolean;
      clarificationSource: "model" | "fallback-asset-gaps" | "none";
      clarificationOptionIssueCount: number;
      hasRecommendedApproach: boolean;
      hasPhasingAssessment: boolean;
      deliverySlice: RequirementCandidateDraft["phasingAssessment"]["deliverySlice"];
      hasSizeAssessment: boolean;
    };
  }> = rawCandidates.map((rawCandidate: any, candidateIndex: number) => {
    const submittedTitle = normalizeSingleLine(rawCandidate?.title);
    const title = submittedTitle || normalizeSingleLine(rawCandidate?.goal) || "未命名需求";
    const goal = normalizeMultiline(rawCandidate?.goal) || title;
    const existing = existingById.get(String(rawCandidate?.candidateId ?? ""))
      ?? existingByKey.get(candidateIdentityKey(title, goal))
      ?? null;
    const recommendedWorkflowId = resolveEntityId(
      rawCandidate?.recommendedWorkflowId ?? rawCandidate?.recommendedWorkflowName,
      workflowIndex,
    );
    const recommendedWorkflowName = recommendedWorkflowId
      ? input.workflows.find((item) => item.id === recommendedWorkflowId)?.name ?? normalizeSingleLine(rawCandidate?.recommendedWorkflowName)
      : normalizeSingleLine(rawCandidate?.recommendedWorkflowName);
    const recommendedRoleIds = resolveEntityIds(rawCandidate?.recommendedRoleIds, roleIndex);
    const recommendedKnowledgeBundleIds = resolveEntityIds(rawCandidate?.recommendedKnowledgeBundleIds, knowledgeIndex);
    const assetGaps = normalizeAssetGaps(rawCandidate?.assetGaps);
    if (!recommendedWorkflowId && !assetGaps.some((gap) => gap.kind === "workflow" && gap.code === "workflow-required")) {
      assetGaps.unshift({
        kind: "workflow",
        severity: "blocking",
        code: "workflow-required",
        message: "还没有匹配到可执行的流程，当前不能直接创建需求。",
        suggestion: "先补齐需求边界，或新增一个更贴合当前目标的流程。",
      } satisfies RequirementAnalysisAssetGap);
    }
    const openQuestions = normalizeStringList(rawCandidate?.openQuestions);
    const clarification = normalizeClarificationItemsDetailed(rawCandidate?.clarificationItems, assetGaps);
    const acceptanceCriteria = normalizeAcceptanceCriteria(rawCandidate?.acceptanceCriteria);
    const phasingAssessment = normalizeCandidatePhasingAssessment(rawCandidate?.phasingAssessment);
    const sizeAssessment = normalizeCandidateSizeAssessment(rawCandidate?.sizeAssessment, rawCandidate?.complexity);
    const creationState = existing?.creationState === "created" ? "created" : "draft";
    const readyToCreate = creationState !== "created"
      && Boolean(rawCandidate?.readyToCreate)
      && Boolean(title)
      && Boolean(goal)
      && Boolean(recommendedWorkflowId)
      && phasingAssessment.scopeDecision === "fit"
      && assetGaps.every((gap) => gap.severity !== "blocking")
      && clarification.items.length === 0;
    const candidateId = existing?.id
      ?? normalizeCandidateId(input.sessionId, rawCandidate?.candidateId, title, goal);
    const candidate = {
      id: candidateId,
      sessionId: existing?.sessionId ?? input.sessionId,
      creationState,
      createdIntakeId: existing?.createdIntakeId ?? null,
      createdProposalId: existing?.createdProposalId ?? null,
      title,
      goal,
      background: normalizeMultiline(rawCandidate?.background),
      acceptanceCriteria,
      splitSource: rawCandidate?.splitSource === "split-from-batch" ? "split-from-batch" : "single",
      complexity: sizeAssessment.size === "unknown" ? normalizeComplexity(rawCandidate?.complexity) : sizeAssessment.size,
      uiScope: normalizeUiScope(rawCandidate?.uiScope),
      architectureRisk: normalizeArchitectureRisk(rawCandidate?.architectureRisk),
      recommendedWorkflowId,
      recommendedWorkflowName,
      recommendedWorkflowReason: normalizeMultiline(rawCandidate?.recommendedWorkflowReason) || "需要进一步澄清后再决定流程",
      recommendedApproach: normalizeMultiline(rawCandidate?.recommendedApproach)
        || buildRecommendedApproachFallback(title, recommendedWorkflowName, clarification.items.length > 0),
      recommendedRoleIds,
      recommendedKnowledgeBundleIds,
      phasingAssessment,
      sizeAssessment,
      assetGaps,
      clarificationItems: clarification.items,
      assumptions: normalizeStringList(rawCandidate?.assumptions),
      openQuestions,
      readyToCreate,
      displayOrder: candidateIndex,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    } satisfies RequirementCandidateDraft;
    return {
      candidate,
      meta: {
        candidateId: String(candidate.id),
        title,
        submittedTitle,
        creationState,
        readyToCreate,
        clarificationSource: clarification.source,
        clarificationOptionIssueCount: clarification.optionIssueCount,
        hasRecommendedApproach: Boolean(candidate.recommendedApproach.trim()),
        hasPhasingAssessment: Boolean(candidate.phasingAssessment.summary.trim()),
        deliverySlice: candidate.phasingAssessment.deliverySlice,
        hasSizeAssessment: candidate.sizeAssessment.score > 0 && Boolean(candidate.sizeAssessment.summary.trim()),
      },
    };
  });
  const activeCandidates = activeEntries.map((entry) => entry.candidate);

  const activeCandidateIds = new Set(activeCandidates.map((candidate) => String(candidate.id)));
  const omittedDraftCandidates = schemaVersion === ASSISTANT_SCHEMA_VERSION
    ? []
    : findOmittedDraftCandidates(input.existingCandidates, activeCandidateIds);
  const preservedCreatedCandidates: RequirementCandidateDraft[] = input.existingCandidates
    .filter((candidate) => isCreatedCandidate(candidate) && !activeCandidateIds.has(String(candidate.id)))
    .map((candidate: RequirementCandidateDraft, index) => ({
      ...candidate,
      creationState: "created" as const,
      createdIntakeId: candidate.createdIntakeId ?? null,
      createdProposalId: candidate.createdProposalId ?? null,
      readyToCreate: false,
      displayOrder: normalizeCandidateDisplayOrder(candidate.displayOrder, activeCandidates.length + index),
    }));
  const drafts = sortRequirementCandidates([...activeCandidates, ...preservedCreatedCandidates]);
  const questions = normalizeQuestions(rawPayload.questions);
  const phase = normalizePhase(rawPayload.phase, activeCandidates, questions);
  const nextAction = normalizeNextAction(rawPayload.nextAction, activeCandidates, questions, assetGapsExist(activeCandidates));
  const assistantReply = normalizeMultiline(rawPayload.assistantReply)
    || buildFallbackAssistantReply(activeCandidates, questions);
  const conversationSummary = normalizeSingleLine(rawPayload.conversationSummary)
    || buildConversationSummary(activeCandidates, questions);
  const candidateSetHash = computeRequirementCandidateSetHash(drafts);
  const validationCandidateIds = mutationPlan?.validationCandidateIds;
  const validationErrors = [
    ...shapeValidationErrors,
    ...(mutationPlan?.validationErrors ?? []),
    ...buildOmittedDraftCandidateErrors(omittedDraftCandidates),
    ...buildAssistantPayloadValidationErrors(activeEntries.map((entry) => entry.meta), {
      createdPhaseOffset,
      validateCandidateIds: validationCandidateIds,
    }),
  ];
  const payloadCandidates = schemaVersion === ASSISTANT_SCHEMA_VERSION ? drafts : activeCandidates;

  return {
    drafts,
    meta: {
      validationErrors,
      failureCode: mutationPlan?.failureCode ?? null,
    },
    payload: {
      schemaVersion,
      phase,
      conversationSummary,
      assistantReply,
      needUserInput: Boolean(rawPayload.needUserInput) || questions.length > 0 || nextAction.type === "wait-user-reply",
      questions,
      candidates: payloadCandidates.map((candidate: RequirementCandidateDraft) => ({
        candidateId: candidate.id,
        title: candidate.title,
        goal: candidate.goal,
        background: candidate.background ?? null,
        acceptanceCriteria: candidate.acceptanceCriteria ?? null,
        splitSource: candidate.splitSource,
        complexity: candidate.complexity,
        uiScope: candidate.uiScope,
        architectureRisk: candidate.architectureRisk,
        recommendedWorkflowId: candidate.recommendedWorkflowId ?? null,
        recommendedWorkflowName: candidate.recommendedWorkflowName ?? null,
        recommendedWorkflowReason: candidate.recommendedWorkflowReason,
        recommendedApproach: candidate.recommendedApproach,
        recommendedRoleIds: candidate.recommendedRoleIds,
        recommendedKnowledgeBundleIds: candidate.recommendedKnowledgeBundleIds,
        phasingAssessment: candidate.phasingAssessment,
        sizeAssessment: candidate.sizeAssessment,
        assetGaps: candidate.assetGaps,
        clarificationItems: candidate.clarificationItems,
        assumptions: candidate.assumptions,
        openQuestions: candidate.openQuestions,
        readyToCreate: candidate.readyToCreate,
      })),
      baseCandidateSetHash: schemaVersion === ASSISTANT_SCHEMA_VERSION ? baseCandidateSetHash : undefined,
      candidateSetHash: schemaVersion === ASSISTANT_SCHEMA_VERSION ? candidateSetHash : undefined,
      candidateMutations: schemaVersion === ASSISTANT_SCHEMA_VERSION ? mutationPlan?.candidateMutations ?? [] : undefined,
      nextAction,
    },
  };
}

/** Converts valid question objects into the compact UI payload; shape errors are reported separately. */
function normalizeQuestions(raw: unknown): RequirementAnalysisQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!isAssistantPayloadObject(item)) return [];
    const question = normalizeMultiline((item as any)?.question);
    if (!question) return [];
    return [{
      id: normalizeSingleLine((item as any)?.id) || `question-${index + 1}`,
      question,
      reason: normalizeMultiline((item as any)?.why ?? (item as any)?.reason) || "需要补齐这部分信息后才能继续准确拆解需求",
      impact: normalizeQuestionImpact((item as any)?.impact),
    } satisfies RequirementAnalysisQuestion];
  }).slice(0, 3);
}

/** Validates raw tool-input container shapes before any fallback normalization can hide them. */
function validateAssistantPayloadShape(raw: unknown, schemaVersion: RequirementAnalysisAssistantPayload["schemaVersion"]): string[] {
  if (!isAssistantPayloadObject(raw)) {
    return [`工具入参必须是对象，不能是 ${describeAssistantPayloadValueType(raw)}。`];
  }

  const errors: string[] = [];
  if (!Object.prototype.hasOwnProperty.call(raw, "questions")) {
    errors.push("questions 是必填数组；没有澄清问题时请传 questions: []。");
  } else {
    if (!Array.isArray(raw.questions)) {
      errors.push(`questions 必须是数组，不能是 ${describeAssistantPayloadValueType(raw.questions)}。`);
    } else {
      raw.questions.forEach((item, index) => {
        if (!isAssistantPayloadObject(item)) {
          errors.push(`questions[${index}] 必须是对象，不能是 ${describeAssistantPayloadValueType(item)}；不要把问题 JSON 包成字符串。`);
        }
      });
    }
  }

  if (schemaVersion === ASSISTANT_SCHEMA_VERSION && !Object.prototype.hasOwnProperty.call(raw, "candidateMutations")) {
    errors.push("candidateMutations 是 v2 必填数组；没有候选变更时请传 candidateMutations: []。");
  }
  if (Object.prototype.hasOwnProperty.call(raw, "candidateMutations")) {
    if (!Array.isArray(raw.candidateMutations)) {
      errors.push(`candidateMutations 必须是数组，不能是 ${describeAssistantPayloadValueType(raw.candidateMutations)}。`);
    } else {
      raw.candidateMutations.forEach((item, index) => {
        if (!isAssistantPayloadObject(item)) {
          errors.push(`candidateMutations[${index}] 必须是对象，不能是 ${describeAssistantPayloadValueType(item)}。`);
        }
      });
    }
  }

  if (schemaVersion !== ASSISTANT_SCHEMA_VERSION && !Object.prototype.hasOwnProperty.call(raw, "candidates")) {
    errors.push("candidates 是必填数组；没有候选需求时请传 candidates: []。");
  }
  if (Object.prototype.hasOwnProperty.call(raw, "candidates")) {
    if (!Array.isArray(raw.candidates)) {
      errors.push(`candidates 必须是数组，不能是 ${describeAssistantPayloadValueType(raw.candidates)}；请传 candidates: [{...}]，不要传 JSON 字符串。`);
    } else {
      raw.candidates.forEach((item, index) => {
        if (!isAssistantPayloadObject(item)) {
          errors.push(`candidates[${index}] 必须是对象，不能是 ${describeAssistantPayloadValueType(item)}；不要把候选 JSON 包成字符串。`);
        }
      });
    }
  }

  return errors;
}

type CandidateMutationPlan = {
  rawCandidates: Record<string, any>[];
  validationErrors: string[];
  validationCandidateIds: Set<string>;
  candidateMutations: RequirementAnalysisCandidateMutation[];
  failureCode?: string | null;
};

const CANDIDATE_PATCH_FIELDS = new Set([
  "title",
  "goal",
  "background",
  "acceptanceCriteria",
  "splitSource",
  "complexity",
  "uiScope",
  "architectureRisk",
  "recommendedWorkflowId",
  "recommendedWorkflowName",
  "recommendedWorkflowReason",
  "recommendedApproach",
  "recommendedRoleIds",
  "recommendedKnowledgeBundleIds",
  "phasingAssessment",
  "sizeAssessment",
  "assetGaps",
  "clarificationItems",
  "assumptions",
  "openQuestions",
  "readyToCreate",
]);

/** 解析需求分析提交协议版本；未知版本默认走 v2，避免继续鼓励全量提交。 */
function normalizeAssistantSchemaVersion(raw: unknown): RequirementAnalysisAssistantPayload["schemaVersion"] {
  const value = normalizeSingleLine(raw);
  return value === LEGACY_ASSISTANT_SCHEMA_VERSION ? LEGACY_ASSISTANT_SCHEMA_VERSION : ASSISTANT_SCHEMA_VERSION;
}

/** 将 v2 candidateMutations 应用到当前 DB 候选快照，生成平台负责校验的完整候选输入。 */
function buildCandidateMutationPlan(input: {
  raw: Record<string, any>;
  existingCandidates: RequirementCandidateDraft[];
  baseCandidateSetHash: string;
  sessionId: RequirementAnalysisSession["id"];
}): CandidateMutationPlan {
  const validationErrors: string[] = [];
  const validationCandidateIds = new Set<string>();
  const candidateMutations: RequirementAnalysisCandidateMutation[] = [];
  let failureCode: string | null = null;

  const submittedBaseHash = normalizeSingleLine(input.raw.baseCandidateSetHash);
  if (!submittedBaseHash) {
    validationErrors.push("baseCandidateSetHash 是 v2 必填字段，必须使用当前候选集合 hash。");
  } else if (!REQUIREMENT_CANDIDATE_SET_HASH_RE.test(submittedBaseHash)) {
    validationErrors.push("baseCandidateSetHash 格式无效：必须原样提交当前提示中的 24 位小写十六进制 hash，禁止重新计算或扩展为 64 位 SHA-256。");
  } else if (submittedBaseHash !== input.baseCandidateSetHash) {
    failureCode = HASH_MISMATCH_FAILURE_CODE;
    validationErrors.push(`候选集合已变更：当前 hash=${input.baseCandidateSetHash}，提交基于 hash=${submittedBaseHash}；请基于最新候选索引重新提交 candidateMutations。`);
  }

  const existingById = new Map(input.existingCandidates.map((candidate) => [String(candidate.id), candidate] as const));
  const rawById = new Map(
    input.existingCandidates.map((candidate) => [String(candidate.id), candidateDraftToRawCandidate(candidate)] as const),
  );
  const initialOrder = input.existingCandidates.map((candidate) => String(candidate.id));
  const rawMutations = Array.isArray(input.raw.candidateMutations)
    ? input.raw.candidateMutations.filter(isAssistantPayloadObject)
    : [];

  for (const [index, rawMutation] of rawMutations.entries()) {
    const op = normalizeSingleLine(rawMutation.op);
    if (op === "create") {
      const rawCandidate = isAssistantPayloadObject(rawMutation.candidate) ? { ...rawMutation.candidate } : null;
      if (!rawCandidate) {
        validationErrors.push(`candidateMutations[${index}] create 必须提供 candidate 对象。`);
        continue;
      }
      const submittedCandidateId = normalizeSingleLine(rawMutation.candidateId ?? rawCandidate.candidateId);
      if (submittedCandidateId) rawCandidate.candidateId = submittedCandidateId;
      const candidateId = normalizeCandidateId(input.sessionId, rawCandidate.candidateId, rawCandidate.title, rawCandidate.goal);
      if (existingById.has(String(candidateId)) || rawById.has(String(candidateId))) {
        validationErrors.push(`candidateMutations[${index}] create 的 candidateId 已存在：${String(candidateId)}。`);
      }
      rawCandidate.candidateId = candidateId;
      rawById.set(String(candidateId), rawCandidate);
      initialOrder.push(String(candidateId));
      validationCandidateIds.add(String(candidateId));
      candidateMutations.push({
        op: "create",
        candidateId,
        candidate: rawCandidate as any,
      } as RequirementAnalysisCandidateMutation);
      continue;
    }

    const submittedCandidateId = normalizeSingleLine(rawMutation.candidateId);
    if (!submittedCandidateId) {
      validationErrors.push(`candidateMutations[${index}] ${op || "未知操作"} 必须提供 candidateId。`);
      continue;
    }
    const candidateId = resolveExistingCandidateMutationId(
      input.sessionId,
      submittedCandidateId,
      input.existingCandidates,
      existingById,
    );
    const existing = existingById.get(candidateId);
    if (!existing) {
      validationErrors.push(`candidateMutations[${index}] 指向不存在的候选：${submittedCandidateId}。`);
      continue;
    }

    if (op === "update") {
      if (isCreatedCandidate(existing)) {
        validationErrors.push(`candidateMutations[${index}] 不能 update 已创建候选“${existing.title}”；如需重做请新增候选。`);
        continue;
      }
      const patch = isAssistantPayloadObject(rawMutation.patch) ? rawMutation.patch : null;
      if (!patch) {
        validationErrors.push(`candidateMutations[${index}] update 必须提供 patch 对象。`);
        continue;
      }
      const invalidFields = Object.keys(patch).filter((field) => !CANDIDATE_PATCH_FIELDS.has(field));
      if (invalidFields.length) {
        validationErrors.push(`candidateMutations[${index}] patch 包含不允许修改的字段：${invalidFields.join(", ")}。`);
      }
      const merged = {
        ...rawById.get(candidateId),
        ...patch,
        candidateId,
      };
      rawById.set(candidateId, merged);
      validationCandidateIds.add(candidateId);
      candidateMutations.push({
        op: "update",
        candidateId: candidateId as RequirementCandidateId,
        patch: { ...patch } as any,
      } as RequirementAnalysisCandidateMutation);
      continue;
    }

    if (op === "delete") {
      const reason = normalizeMultiline(rawMutation.reason);
      if (isCreatedCandidate(existing)) {
        validationErrors.push(`candidateMutations[${index}] 不能 delete 已创建候选“${existing.title}”；正式需求删除/归档不属于草稿候选补丁。`);
        continue;
      }
      if (!reason) {
        validationErrors.push(`candidateMutations[${index}] delete 必须提供 reason。`);
      }
      rawById.delete(candidateId);
      candidateMutations.push({
        op: "delete",
        candidateId: candidateId as RequirementCandidateId,
        reason: reason ?? "",
      });
      continue;
    }

    validationErrors.push(`candidateMutations[${index}] op 必须是 create、update 或 delete，不能是 ${op || "(empty)"}。`);
  }

  return {
    rawCandidates: initialOrder.flatMap((candidateId) => {
      const rawCandidate = rawById.get(candidateId);
      return rawCandidate ? [rawCandidate] : [];
    }),
    validationErrors,
    validationCandidateIds,
    candidateMutations,
    failureCode,
  };
}

/** 解析 v2 update/delete 目标，兼容模型提交精确持久化 ID 或唯一短 ID。 */
function resolveExistingCandidateMutationId(
  sessionId: RequirementAnalysisSession["id"],
  rawCandidateId: string,
  existingCandidates: RequirementCandidateDraft[],
  existingById: Map<string, RequirementCandidateDraft>,
): string {
  if (existingById.has(rawCandidateId)) return rawCandidateId;
  const normalizedId = String(normalizeCandidateId(sessionId, rawCandidateId, "", ""));
  if (existingById.has(normalizedId)) return normalizedId;
  const suffix = `:${rawCandidateId}`;
  const suffixMatches = existingCandidates.filter((candidate) => String(candidate.id).endsWith(suffix));
  return suffixMatches.length === 1 ? String(suffixMatches[0]?.id) : rawCandidateId;
}

/** Identifies JSON-object-like values that can be safely read as tool payload objects. */
function isAssistantPayloadObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Describes malformed JSON values for validation messages returned to the model. */
function describeAssistantPayloadValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function normalizeAssetGaps(raw: unknown): RequirementAnalysisAssetGap[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const kind = normalizeAssetGapKind((item as any)?.kind);
    const message = normalizeMultiline((item as any)?.message);
    if (!kind || !message) return [];
    return [{
      kind,
      severity: (item as any)?.severity === "blocking" ? "blocking" : "warning",
      code: normalizeSingleLine((item as any)?.code) || `gap-${kind}`,
      message,
      suggestion: normalizeMultiline((item as any)?.suggestion),
    } satisfies RequirementAnalysisAssetGap];
  });
}

/** 只从阻塞澄清项或阻塞资产缺口生成待澄清项；openQuestions 保持非阻塞记录。 */
function normalizeClarificationItemsDetailed(
  raw: unknown,
  assetGaps: RequirementAnalysisAssetGap[],
): {
  items: RequirementCandidateDraft["clarificationItems"];
  source: "model" | "fallback-asset-gaps" | "none";
  optionIssueCount: number;
} {
  const itemsWithMeta = Array.isArray(raw)
    ? raw.flatMap((item) => {
      const question = normalizeMultiline((item as any)?.question);
      if (!question) return [];
      const options = normalizeClarificationOptions((item as any)?.options);
      return [{
        item: {
          question,
          reason: normalizeMultiline((item as any)?.reason) || DEFAULT_CLARIFICATION_REASON,
          suggestion: normalizeMultiline((item as any)?.suggestion) || DEFAULT_CLARIFICATION_SUGGESTION,
          impact: normalizeQuestionImpact((item as any)?.impact),
          options: options.length > 0 ? options : buildFallbackClarificationOptions(question, (item as any)?.suggestion),
          allowCustom: (item as any)?.allowCustom !== false,
          answerPlaceholder: normalizeMultiline((item as any)?.answerPlaceholder) || DEFAULT_CLARIFICATION_PLACEHOLDER,
        } satisfies RequirementCandidateDraft["clarificationItems"][number],
        optionIssue: options.length === 0 || !options.some((option) => option.recommended),
      }];
    })
    : [];
  if (itemsWithMeta.length > 0) {
    return {
      items: dedupeClarificationItems(itemsWithMeta.map((entry) => entry.item)),
      source: "model",
      optionIssueCount: itemsWithMeta.filter((entry) => entry.optionIssue).length,
    };
  }

  const blockingGaps = assetGaps.filter((gap) => gap.severity === "blocking");
  if (blockingGaps.length > 0) {
    return {
      items: dedupeClarificationItems(blockingGaps.map((gap) => ({
      question: gap.message,
      reason: `当前工作区仍缺少${assetGapKindLabel(gap.kind)}或相关业务资料，暂时无法直接创建需求。`,
      suggestion: gap.suggestion || DEFAULT_ASSET_GAP_SUGGESTION,
      impact: assetGapToQuestionImpact(gap.kind),
      options: buildFallbackClarificationOptions(gap.message, gap.suggestion),
      allowCustom: true,
      answerPlaceholder: DEFAULT_ASSET_GAP_PLACEHOLDER,
    }))),
      source: "fallback-asset-gaps",
      optionIssueCount: 0,
    };
  }

  return {
    items: [],
    source: "none",
    optionIssueCount: 0,
  };
}

function normalizeClarificationOptions(raw: unknown): RequirementCandidateDraft["clarificationItems"][number]["options"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    const label = normalizeSingleLine((item as any)?.label ?? (item as any)?.value ?? item);
    const value = normalizeMultiline((item as any)?.value ?? (item as any)?.label ?? item);
    if (!label || !value) return [];
    return [{
      id: normalizeSingleLine((item as any)?.id) || `option-${index + 1}`,
      label,
      value,
      recommended: Boolean((item as any)?.recommended),
    }];
  }).slice(0, 4);
}

function buildFallbackClarificationOptions(question: string, suggestion: unknown): RequirementCandidateDraft["clarificationItems"][number]["options"] {
  const normalizedSuggestion = normalizeMultiline(suggestion) || DEFAULT_CLARIFICATION_SUGGESTION;
  return [{
    id: "follow-ai-suggestion",
    label: "按 AI 建议补充",
    value: normalizedSuggestion,
    recommended: true,
  }, {
    id: "direct-answer",
    label: "我来直接说明",
    value: `关于“${question}”，我补充说明如下：`,
  }];
}

function normalizeCandidatePhasingAssessment(raw: unknown): RequirementCandidateDraft["phasingAssessment"] {
  const signalsRaw = (raw as any)?.signals ?? {};
  const signals = {
    benefitHypothesisCount: Math.max(clampNonNegativeInt(signalsRaw?.benefitHypothesisCount), 1),
    acceptanceLoopCount: Math.max(clampNonNegativeInt(signalsRaw?.acceptanceLoopCount), 1),
    actorSurfaceCount: Math.max(clampNonNegativeInt(signalsRaw?.actorSurfaceCount), 1),
    externalSystemCount: clampNonNegativeInt(signalsRaw?.externalSystemCount),
    newCoreModelCount: clampNonNegativeInt(signalsRaw?.newCoreModelCount),
  };
  const deliverySlice = (raw as any)?.deliverySlice === "phase-1" || (raw as any)?.deliverySlice === "follow-up"
    ? (raw as any).deliverySlice as RequirementCandidateDraft["phasingAssessment"]["deliverySlice"]
    : "single-phase";
  const scopeDecision = (raw as any)?.scopeDecision === "needs-split" ? "needs-split" : "fit";
  const outOfScope = normalizeStringList((raw as any)?.outOfScope);
  return {
    model: (raw as any)?.model === "mmf-phase-gate-v2" ? "mmf-phase-gate-v2" : "legacy-mmf-fallback-v1",
    scopeDecision,
    deliverySlice,
    summary: normalizeMultiline((raw as any)?.summary) || buildPhasingAssessmentSummary(scopeDecision, deliverySlice, signals, outOfScope),
    reasoning: normalizeMultiline((raw as any)?.reasoning) || "",
    signals,
    outOfScope,
  };
}

function buildPhasingAssessmentSummary(
  scopeDecision: RequirementCandidateDraft["phasingAssessment"]["scopeDecision"],
  deliverySlice: RequirementCandidateDraft["phasingAssessment"]["deliverySlice"],
  signals: RequirementCandidateDraft["phasingAssessment"]["signals"],
  outOfScope: string[],
): string {
  if (scopeDecision === "needs-split") {
    return `当前还不是可直接创建的单一切片：覆盖 ${signals.benefitHypothesisCount} 个价值假设、${signals.acceptanceLoopCount} 个验收闭环、${signals.actorSurfaceCount} 个角色/端面，建议继续拆分。`;
  }
  if (deliverySlice === "phase-1") {
    const scopeTail = outOfScope.length ? `当前明确不纳入：${outOfScope.join("、")}。` : "";
    return `这条候选适合作为一期 MMF：先完成一个可独立验收的最小闭环。${scopeTail}`.trim();
  }
  if (deliverySlice === "follow-up") {
    return "这条候选属于后续阶段：应建立在前序核心闭环已经打通的前提上推进。";
  }
  return "这条候选本身就是一个可独立验收的单阶段闭环。";
}

function normalizeCandidateSizeAssessment(
  raw: unknown,
  fallbackComplexity: unknown,
): RequirementCandidateDraft["sizeAssessment"] {
  const signalsRaw = (raw as any)?.signals ?? {};
  const legacySignalsRaw = (raw as any)?.legacySignals ?? {};
  const rawModel = normalizeSingleLine((raw as any)?.model);
  const hasLegacySignalShape = "menuCount" in signalsRaw
    || "featurePointCount" in signalsRaw
    || "businessFlowCount" in signalsRaw
    || "interactionPointCount" in signalsRaw
    || "integrationCount" in signalsRaw
    || "platformCount" in signalsRaw;
  const legacySignals = hasLegacySignalShape || hasAnyLegacySizeSignals(legacySignalsRaw)
    ? {
      menuCount: clampNonNegativeInt((hasLegacySignalShape ? signalsRaw : legacySignalsRaw)?.menuCount),
      featurePointCount: clampNonNegativeInt((hasLegacySignalShape ? signalsRaw : legacySignalsRaw)?.featurePointCount),
      businessFlowCount: clampNonNegativeInt((hasLegacySignalShape ? signalsRaw : legacySignalsRaw)?.businessFlowCount),
      interactionPointCount: clampNonNegativeInt((hasLegacySignalShape ? signalsRaw : legacySignalsRaw)?.interactionPointCount),
      integrationCount: clampNonNegativeInt((hasLegacySignalShape ? signalsRaw : legacySignalsRaw)?.integrationCount),
      platformCount: Math.max(clampNonNegativeInt((hasLegacySignalShape ? signalsRaw : legacySignalsRaw)?.platformCount), 1),
    }
    : null;
  const signals = {
    functionalProcessCount: clampNonNegativeInt(signalsRaw?.functionalProcessCount),
    domainEntityCount: clampNonNegativeInt(signalsRaw?.domainEntityCount),
    stateTransitionCount: clampNonNegativeInt(signalsRaw?.stateTransitionCount),
    interactionSurfaceCount: clampNonNegativeInt(signalsRaw?.interactionSurfaceCount),
    externalIntegrationCount: clampNonNegativeInt(signalsRaw?.externalIntegrationCount),
    asyncConsistencyRiskCount: clampNonNegativeInt(signalsRaw?.asyncConsistencyRiskCount),
    clientSurfaceCount: Math.max(clampNonNegativeInt(signalsRaw?.clientSurfaceCount), 1),
  };
  const usesFunctionalSignals = Object.values(signals).some((value) => value > 0);
  const score = usesFunctionalSignals
    ? (signals.functionalProcessCount * 3)
      + (signals.domainEntityCount * 2)
      + (signals.stateTransitionCount * 2)
      + (signals.interactionSurfaceCount * 2)
      + (signals.externalIntegrationCount * 4)
      + (signals.asyncConsistencyRiskCount * 4)
      + (signals.clientSurfaceCount * 2)
    : legacySignals
    ? legacySignals.menuCount
      + (legacySignals.featurePointCount * 2)
      + (legacySignals.businessFlowCount * 3)
      + legacySignals.interactionPointCount
      + (legacySignals.integrationCount * 3)
      + Math.max(legacySignals.platformCount - 1, 0) * 2
    : 0;
  const derivedSize = score <= 14 ? "small" : score >= 30 ? "large" : "standard";
  const fallbackSize = normalizeComplexity(fallbackComplexity);
  return {
    model: usesFunctionalSignals || rawModel === "functional-size-v2"
      ? "functional-size-v2"
      : legacySignals
      ? "legacy-matrix-v1"
      : "functional-size-v2",
    size: score > 0 ? derivedSize : fallbackSize,
    score,
    summary: normalizeMultiline((raw as any)?.summary)
      || (score > 0 ? buildSizeAssessmentSummary(derivedSize, score, signals, legacySignals) : ""),
    reasoning: normalizeMultiline((raw as any)?.reasoning) || "",
    signals,
    legacySignals,
  };
}

function buildSizeAssessmentSummary(
  size: RequirementCandidateDraft["complexity"],
  score: number,
  signals: RequirementCandidateDraft["sizeAssessment"]["signals"],
  legacySignals: RequirementCandidateDraft["sizeAssessment"]["legacySignals"],
): string {
  const sizeLabel = size === "small" ? "小" : size === "large" ? "大" : "中";
  if (legacySignals) {
    return `按旧版规模矩阵，这条需求属于${sizeLabel}型需求（${score} 分）：约 ${legacySignals.menuCount} 个菜单入口、${legacySignals.featurePointCount} 个功能点、${legacySignals.businessFlowCount} 条业务流程、${legacySignals.interactionPointCount} 个交互点、${legacySignals.integrationCount} 个集成点、${legacySignals.platformCount} 个交付平台。`;
  }
  return `按功能规模简化模型，这条需求属于${sizeLabel}型需求（${score} 分）：约 ${signals.functionalProcessCount} 个功能过程、${signals.domainEntityCount} 个领域对象、${signals.stateTransitionCount} 个状态流转、${signals.interactionSurfaceCount} 个交互界面、${signals.externalIntegrationCount} 个外部集成、${signals.asyncConsistencyRiskCount} 个异步一致性风险点、${signals.clientSurfaceCount} 个交付端面。`;
}

function buildRecommendedApproachFallback(title: string, workflowName: string, needsClarification: boolean): string {
  if (needsClarification) {
    return `建议先把“${title}”收敛成一个边界清晰的可交付版本，再进入 ${workflowName || "正式流程"}，避免在页面范围和验收口径上反复返工。`;
  }
  return `建议按当前推荐流程 ${workflowName || "继续推进"}，先锁定验收标准和页面边界，再直接创建需求并同步生成方案。`;
}

const REQUIREMENT_CANDIDATE_TITLE_MAX_LENGTH = 48;
const MULTI_CANDIDATE_TITLE_RE = /^第([1-9]\d*)期-(.+)$/;
const CANDIDATE_TITLE_PATH_ILLEGAL_RE = /[<>:"/\\|?*\u0000-\u001F]/;
const WINDOWS_RESERVED_CANDIDATE_TITLE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** 计算已创建候选占用的期次，兼容旧单候选标题没有“第N期-”前缀的历史数据。 */
function resolveCreatedCandidatePhaseOffset(candidates: RequirementCandidateDraft[]): number {
  const createdCandidates = candidates.filter(isCreatedCandidate);
  const maxExplicitPhase = createdCandidates.reduce((maxPhase, candidate) => {
    const match = MULTI_CANDIDATE_TITLE_RE.exec(normalizeSingleLine(candidate.title));
    const phase = match ? Number(match[1]) : 0;
    return Number.isFinite(phase) ? Math.max(maxPhase, phase) : maxPhase;
  }, 0);
  return Math.max(createdCandidates.length, maxExplicitPhase);
}

/** 汇总需求助手 payload 的业务校验错误，供模型按原始输入修复。 */
function buildAssistantPayloadValidationErrors(input: Array<{
  candidateId: string;
  title: string;
  submittedTitle: string;
  creationState: RequirementCandidateDraft["creationState"];
  readyToCreate: boolean;
  clarificationSource: "model" | "fallback-asset-gaps" | "none";
  clarificationOptionIssueCount: number;
  hasRecommendedApproach: boolean;
  hasPhasingAssessment: boolean;
  deliverySlice: RequirementCandidateDraft["phasingAssessment"]["deliverySlice"];
  hasSizeAssessment: boolean;
}>, options?: {
  createdPhaseOffset?: number;
  validateCandidateIds?: Set<string> | null;
}): string[] {
  const errors: string[] = [];
  const draftCandidates = input.filter((candidate) => candidate.creationState !== "created");
  const createdPhaseOffset = Math.max(0, Math.trunc(Number(options?.createdPhaseOffset ?? 0)) || 0);
  const hasFollowUpCandidate = draftCandidates.some((candidate) => candidate.deliverySlice === "follow-up");
  for (const [candidateIndex, candidate] of draftCandidates.entries()) {
    if (options?.validateCandidateIds && !options.validateCandidateIds.has(candidate.candidateId)) continue;
    errors.push(...validateRequirementCandidateTitle({
      title: candidate.title,
      submittedTitle: candidate.submittedTitle,
      candidateIndex,
      candidateCount: draftCandidates.length,
      phaseOffset: createdPhaseOffset,
    }));
    if (!candidate.hasRecommendedApproach) {
      errors.push(`候选“${candidate.title}”缺少 recommendedApproach`);
    }
    if (!candidate.hasPhasingAssessment) {
      errors.push(`候选“${candidate.title}”缺少完整的 phasingAssessment`);
    }
    if (candidate.deliverySlice === "phase-1" && !hasFollowUpCandidate) {
      errors.push(`候选“${candidate.title}”被标记为一期，但当前输出里没有任何 follow-up 候选`);
    }
    if (!candidate.hasSizeAssessment) {
      errors.push(`候选“${candidate.title}”缺少完整的 sizeAssessment`);
    }
    if (!candidate.readyToCreate && candidate.clarificationSource !== "model") {
      errors.push(`候选“${candidate.title}”仍待澄清，但 clarificationItems 不是模型按 schema 输出的`);
    }
    if (!candidate.readyToCreate && candidate.clarificationOptionIssueCount > 0) {
      errors.push(`候选“${candidate.title}”的 clarificationItems 缺少可点击 options 或缺少 recommended 选项`);
    }
  }
  return errors;
}

/** 找出本轮提交遗漏的既有草稿候选，防止增量输出误删用户还在看的需求。 */
function findOmittedDraftCandidates(
  existingCandidates: RequirementCandidateDraft[],
  activeCandidateIds: Set<string>,
): RequirementCandidateDraft[] {
  return existingCandidates.filter((candidate) =>
    !isCreatedCandidate(candidate) && !activeCandidateIds.has(String(candidate.id))
  );
}

/** 将遗漏草稿候选转换成模型可修复的校验错误。 */
function buildOmittedDraftCandidateErrors(omittedCandidates: RequirementCandidateDraft[]): string[] {
  if (!omittedCandidates.length) return [];
  const titles = omittedCandidates
    .slice(0, 5)
    .map((candidate) => `“${candidate.title}”`)
    .join("、");
  const more = omittedCandidates.length > 5 ? `等 ${omittedCandidates.length} 条` : "";
  return [
    `本轮 candidates 遗漏了已有草稿候选 ${titles}${more}；candidates 必须是提交后的完整活跃候选集合，仍有效的草稿候选要保留原 candidateId 一并提交，不能只提交新增候选。`,
  ];
}

/** 校验候选标题是否能直接作为有序、路径安全的需求标题。 */
function validateRequirementCandidateTitle(input: {
  title: string;
  submittedTitle: string;
  candidateIndex: number;
  candidateCount: number;
  phaseOffset: number;
}): string[] {
  const errors: string[] = [];
  const title = input.submittedTitle;
  const titleLabel = title || input.title || "未命名候选";
  if (!title) {
    errors.push(`候选“${titleLabel}”缺少 candidate.title：必须由模型直接输出规范标题，不能省略或用 goal 兜底`);
    return errors;
  }
  const candidateIndex = input.candidateIndex;
  const candidateCount = input.candidateCount;
  const expectedPhase = input.phaseOffset + candidateIndex + 1;
  if (candidateCount > 1) {
    const match = MULTI_CANDIDATE_TITLE_RE.exec(title);
    if (!match) {
      errors.push(`候选“${title}”标题格式不合规：多候选时必须使用“第${expectedPhase}期-标题”格式，分隔符固定为半角短横线`);
    } else {
      const actualPhase = Number(match[1]);
      const titleBody = String(match[2] ?? "").trim();
      if (actualPhase !== expectedPhase) {
        errors.push(`候选“${title}”标题期次不正确：当前是第 ${expectedPhase} 条，标题必须以“第${expectedPhase}期-”开头`);
      }
      if (!titleBody) {
        errors.push(`候选“${title}”标题缺少期次后的正文`);
      }
    }
  }
  if (CANDIDATE_TITLE_PATH_ILLEGAL_RE.test(title)) {
    errors.push(`候选“${title}”标题包含路径非法字符，不能包含 < > : " / \\ | ? *`);
  }
  if (title.endsWith(".") || WINDOWS_RESERVED_CANDIDATE_TITLE_RE.test(title)) {
    errors.push(`候选“${title}”标题不是安全目录名：不能以点号结尾，也不能使用 CON/NUL/COM1 这类 Windows 保留设备名`);
  }
  if (Array.from(title).length > REQUIREMENT_CANDIDATE_TITLE_MAX_LENGTH) {
    errors.push(`候选“${title}”标题过长：候选标题总长度不能超过 ${REQUIREMENT_CANDIDATE_TITLE_MAX_LENGTH} 个字符`);
  }
  return errors;
}

/** 构建一次有界的结构化提交修复提示，不改变原始用户需求。 */
function buildSubmissionRepairPrompt(input: {
  expectedCandidateSetHash: string;
  validationErrors: string[];
  previousResponse: string;
}): string {
  const validationErrors = input.validationErrors.length > 0
    ? input.validationErrors
    : [`上一轮没有成功调用 ${REQUIREMENT_ANALYSIS_SUBMIT_TOOL_ID}。`];
  const compactPreviousResponse = String(input.previousResponse ?? "").trim().slice(0, 2400);
  return [
    "上一轮需求分析结果未被平台接受。请保持原始用户意图和当前候选不变，只修复结构化提交。",
    `baseCandidateSetHash 必须原样使用当前值 ${input.expectedCandidateSetHash}。`,
    "必须修正的问题：",
    ...validationErrors.map((item, index) => `${index + 1}. ${item}`),
    `请直接重新调用工具 ${REQUIREMENT_ANALYSIS_SUBMIT_TOOL_ID}；不要只输出普通说明，也不要宣称未被平台接受的修改已经成功。`,
    compactPreviousResponse ? `上一轮普通输出仅供定位，不代表提交成功：${compactPreviousResponse}` : "",
  ].filter(Boolean).join("\n\n");
}

function clampNonNegativeInt(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

function hasAnyLegacySizeSignals(raw: any): boolean {
  return clampNonNegativeInt(raw?.menuCount)
    + clampNonNegativeInt(raw?.featurePointCount)
    + clampNonNegativeInt(raw?.businessFlowCount)
    + clampNonNegativeInt(raw?.interactionPointCount)
    + clampNonNegativeInt(raw?.integrationCount)
    + clampNonNegativeInt(raw?.platformCount) > 0;
}

function normalizeNextAction(
  raw: any,
  candidates: RequirementCandidateDraft[],
  questions: RequirementAnalysisQuestion[],
  hasAssetGaps: boolean,
): RequirementAnalysisAssistantPayload["nextAction"] {
  const requestedType = normalizeSingleLine(raw?.type);
  const readyCandidateIds = candidates.filter((candidate) => candidate.readyToCreate).map((candidate) => candidate.id);
  const reviewCandidateIds = candidates.map((candidate) => candidate.id);
  if (requestedType === "ready-to-create" && readyCandidateIds.length > 0) {
    return {
      type: "ready-to-create",
      targetCandidateIds: readyCandidateIds,
      note: normalizeMultiline(raw?.note),
    };
  }
  if ((requestedType === "needs-assets" || hasAssetGaps) && candidates.length > 0) {
    return {
      type: "needs-assets",
      targetCandidateIds: reviewCandidateIds,
      note: normalizeMultiline(raw?.note) || "当前工作区资产不足，建议补齐流程、角色或知识库后再创建。",
    };
  }
  if ((requestedType === "review-candidates" || candidates.length > 1) && reviewCandidateIds.length > 0) {
    return {
      type: "review-candidates",
      targetCandidateIds: reviewCandidateIds,
      note: normalizeMultiline(raw?.note),
    };
  }
  if (questions.length > 0) {
    return {
      type: "wait-user-reply",
      targetCandidateIds: reviewCandidateIds.length ? reviewCandidateIds : null,
      note: normalizeMultiline(raw?.note),
    };
  }
  return {
    type: readyCandidateIds.length > 0 ? "ready-to-create" : "review-candidates",
    targetCandidateIds: readyCandidateIds.length > 0 ? readyCandidateIds : reviewCandidateIds,
    note: normalizeMultiline(raw?.note),
  };
}

function normalizePhase(
  raw: unknown,
  candidates: RequirementCandidateDraft[],
  questions: RequirementAnalysisQuestion[],
): RequirementAnalysisPhase {
  const phase = normalizeSingleLine(raw);
  if (phase === "clarify" || phase === "split" || phase === "recommend" || phase === "confirm" || phase === "done") {
    return phase;
  }
  const hasPhasedCandidates = candidates.some((candidate) => candidate.phasingAssessment.deliverySlice !== "single-phase");
  const hasSplitRequired = candidates.some((candidate) => candidate.phasingAssessment.scopeDecision === "needs-split");
  if (questions.length > 0) return candidates.length > 1 || hasSplitRequired || hasPhasedCandidates ? "split" : "clarify";
  if (hasSplitRequired || hasPhasedCandidates || candidates.length > 1) return "split";
  if (candidates.some((candidate) => candidate.readyToCreate)) return "confirm";
  if (candidates.length > 0) return "recommend";
  return "discover";
}

/** 生成会话内全局唯一候选 ID；已带当前会话前缀时保持幂等。 */
function normalizeCandidateId(
  sessionId: RequirementAnalysisSession["id"],
  rawId: unknown,
  title: string,
  goal: string,
): RequirementCandidateId {
  const candidateId = normalizeSingleLine(rawId);
  if (candidateId) {
    const sessionPrefix = `${sessionId}:`;
    return (candidateId.startsWith(sessionPrefix) ? candidateId : `${sessionPrefix}${candidateId}`) as RequirementCandidateId;
  }
  const hash = crypto.createHash("sha1")
    .update(`${sessionId}\n${title}\n${goal}`)
    .digest("hex")
    .slice(0, 12);
  return `req-candidate-${hash}` as RequirementCandidateId;
}

function normalizeAcceptanceCriteria(raw: unknown): TaskAcceptanceCriterion[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw
    .map((item) => ({
      text: normalizeMultiline((item as any)?.text ?? item),
    }))
    .filter((item) => item.text) as TaskAcceptanceCriterion[];
  return items.length ? items : null;
}

/** 从已选流程的结构化 family 推导需求类型，避免从标题或目标文案猜测。 */
function resolveTaskTypeFromWorkflow(workflow: WorkflowRuntimeDefinition): TaskIntake["taskType"] {
  if (workflow.family === "bugfix") return "bugfix";
  if (workflow.family === "analysis") return "analysis";
  return "feature";
}

function composeIntakeBackground(
  candidate: RequirementCandidateDraft,
  opts?: {
    preserveUiProjectIntegrationBoundary?: boolean;
  },
): string | null {
  const parts = [
    normalizeMultiline(candidate.background),
    normalizeMultiline(candidate.recommendedApproach)
      ? `建议收敛方案：\n${candidate.recommendedApproach}`
      : null,
    candidate.phasingAssessment.summary
      ? `分期判断：\n${candidate.phasingAssessment.summary}`
      : null,
    candidate.phasingAssessment.outOfScope.length
      ? ["当前明确不纳入：", ...candidate.phasingAssessment.outOfScope.map((item) => `- ${item}`)].join("\n")
      : null,
    opts?.preserveUiProjectIntegrationBoundary
      ? [
        "补充约束：",
        "- 如果后续流程包含 UI/UX 原型节点，那么“当前明确不纳入”的前端实现边界只表示不做正式业务逻辑落地，不等于禁止在现有前端项目中新增隔离的 prototype/prototypes 目录、页面、路由、mock 数据或壳层复用来完成项目集成原型。",
        "- 只有当仓库里确实没有可复用前端项目，或用户明确要求独立静态原型时，才退回独立静态 HTML 原型。",
      ].join("\n")
      : null,
    candidate.sizeAssessment.summary
      ? `需求大小评估：\n${candidate.sizeAssessment.summary}`
      : null,
    candidate.assumptions.length
      ? ["当前假设：", ...candidate.assumptions.map((item) => `- ${item}`)].join("\n")
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

/** 判断流程是否有明确 ui-spec 输出，避免根据角色自然语言描述推断 UI 原型流程。 */
function workflowUsesUiSpecOutput(
  workflow: WorkflowRuntimeDefinition,
  resolveRole: (roleId: string) => { outputDefinition?: { resultKey?: string | null } | null } | null,
): boolean {
  return workflow.nodes.some((node) => {
    if (node.type !== "role" || !node.roleId) return false;
    const nodeResultKey = String(node.outputResultKey ?? "").trim();
    if (nodeResultKey === "ui-spec") return true;
    const roleResultKey = String(resolveRole(String(node.roleId))?.outputDefinition?.resultKey ?? "").trim();
    return roleResultKey === "ui-spec";
  });
}

function buildFallbackAssistantReply(
  candidates: RequirementCandidateDraft[],
  questions: RequirementAnalysisQuestion[],
): string {
  if (!candidates.length && !questions.length) {
    return "我还不能稳定拆出需求候选。请再补充您的目标、使用场景、预期页面或验收标准。";
  }
  const candidateLines = candidates.map((candidate, index) => {
    const workflow = candidate.recommendedWorkflowName ? `，建议流程：${candidate.recommendedWorkflowName}` : "";
    const ready = candidate.readyToCreate ? "，已接近可创建" : "，还需继续澄清";
    const slice = deliverySliceLabel(candidate.phasingAssessment.deliverySlice);
    const splitNote = candidate.phasingAssessment.scopeDecision === "needs-split" ? "，当前仍需继续拆分" : "";
    return `${index + 1}. ${candidate.title}（${slice}）${workflow}${ready}${splitNote}`;
  });
  const questionLines = questions.map((question, index) => `${index + 1}. ${question.question}`);
  return [
    candidateLines.length ? `我先整理出这些候选需求：\n${candidateLines.join("\n")}` : null,
    questionLines.length ? `还需要您补充：\n${questionLines.join("\n")}` : null,
  ].filter(Boolean).join("\n\n");
}

function buildConversationSummary(
  candidates: RequirementCandidateDraft[],
  questions: RequirementAnalysisQuestion[],
): string {
  if (candidates.length === 0) {
    return questions.length > 0 ? "正在澄清需求范围和验收标准" : "等待识别需求候选";
  }
  const phaseOneCount = candidates.filter((candidate) => candidate.phasingAssessment.deliverySlice === "phase-1").length;
  const followUpCount = candidates.filter((candidate) => candidate.phasingAssessment.deliverySlice === "follow-up").length;
  if (phaseOneCount > 0 || followUpCount > 0) {
    return `已整理出 ${candidates.length} 条候选需求，其中一期 ${phaseOneCount} 条、后续 ${followUpCount} 条`;
  }
  if (candidates.some((candidate) => candidate.readyToCreate)) {
    return `已整理出 ${candidates.length} 条候选需求，其中 ${candidates.filter((candidate) => candidate.readyToCreate).length} 条可创建`;
  }
  if (questions.length > 0) {
    return `已整理出 ${candidates.length} 条候选需求，仍需补充关键信息`;
  }
  return `已整理出 ${candidates.length} 条候选需求，正在准备流程推荐`;
}

function deliverySliceLabel(slice: RequirementCandidateDraft["phasingAssessment"]["deliverySlice"]): string {
  if (slice === "phase-1") return "一期候选";
  if (slice === "follow-up") return "后续候选";
  return "单阶段候选";
}

function resolveSessionTitle(
  session: RequirementAnalysisSession,
  payload: RequirementAnalysisAssistantPayload,
  messages: RequirementAnalysisMessage[],
): string {
  const explicit = normalizeSessionTitle(session.title);
  if (explicit && explicit !== "未命名需求分析") return explicit;
  const firstCandidateTitle = normalizeSingleLine(payload.candidates[0]?.title);
  if (firstCandidateTitle) return normalizeSessionTitle(firstCandidateTitle);
  const firstUserMessage = messages.find((message) => message.role === "user");
  return normalizeSessionTitle(firstUserMessage?.content);
}

function normalizeSessionTitle(raw: unknown): string {
  return normalizeTaskIntakeTitle(raw, "未命名需求分析");
}

function decoratePromptUserText(text: string, images: string[]): string {
  const normalizedText = String(text ?? "").trim();
  const imageCount = Array.isArray(images)
    ? images.map((item) => String(item ?? "").trim()).filter(Boolean).length
    : 0;
  if (!imageCount) return normalizedText;
  return [
    normalizedText || "用户补充了图片。",
    `附图：${imageCount} 张`,
  ].filter(Boolean).join("\n\n");
}

function normalizeSingleLine(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMultiline(raw: unknown): string | null {
  const text = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  return text ? text : null;
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeMultiline(item))
    .filter((item): item is string => Boolean(item));
}

function dedupeClarificationItems(
  items: RequirementCandidateDraft["clarificationItems"],
): RequirementCandidateDraft["clarificationItems"] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalizeSingleLine(item.question).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeQuestionImpact(raw: unknown): RequirementAnalysisQuestion["impact"] {
  const value = normalizeSingleLine(raw);
  return value === "acceptance"
    || value === "workflow"
    || value === "ui-scope"
    || value === "architecture"
    || value === "assets"
    || value === "delivery"
    ? value
    : "scope";
}

function normalizeComplexity(raw: unknown): RequirementCandidateDraft["complexity"] {
  const value = normalizeSingleLine(raw);
  return value === "small" || value === "standard" || value === "large" ? value : "unknown";
}

function normalizeUiScope(raw: unknown): RequirementCandidateDraft["uiScope"] {
  const value = normalizeSingleLine(raw);
  return value === "none" || value === "light" || value === "heavy" ? value : "unknown";
}

function normalizeArchitectureRisk(raw: unknown): RequirementCandidateDraft["architectureRisk"] {
  const value = normalizeSingleLine(raw);
  return value === "low" || value === "medium" || value === "high" ? value : "unknown";
}

function normalizeAssetGapKind(raw: unknown): RequirementAnalysisAssetGap["kind"] | null {
  const value = normalizeSingleLine(raw);
  return value === "workflow" || value === "role" || value === "knowledge-bundle" || value === "toolset"
    ? value
    : null;
}

function assetGapKindLabel(kind: RequirementAnalysisAssetGap["kind"]): string {
  switch (kind) {
    case "workflow":
      return "流程";
    case "role":
      return "角色";
    case "knowledge-bundle":
      return "可复用知识资产";
    case "toolset":
      return "工具集";
    default:
      return "资产";
  }
}

function assetGapToQuestionImpact(kind: RequirementAnalysisAssetGap["kind"]): RequirementAnalysisQuestion["impact"] {
  switch (kind) {
    case "workflow":
      return "workflow";
    case "role":
    case "knowledge-bundle":
    case "toolset":
      return "assets";
    default:
      return "scope";
  }
}

function createEntityIndex(items: Array<{ id: string; name: string }>) {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const byName = new Map(items.map((item) => [normalizeSingleLine(item.name).toLowerCase(), item] as const));
  return { byId, byName };
}

function resolveEntityId(raw: unknown, index: ReturnType<typeof createEntityIndex>): string | null {
  const value = normalizeSingleLine(raw);
  if (!value) return null;
  if (index.byId.has(value)) return value;
  return index.byName.get(value.toLowerCase())?.id ?? null;
}

function resolveEntityIds(raw: unknown, index: ReturnType<typeof createEntityIndex>): string[] {
  if (!Array.isArray(raw)) return [];
  const resolved = raw
    .map((item) => resolveEntityId(item, index))
    .filter((item): item is string => Boolean(item));
  return [...new Set(resolved)];
}

function assetGapsExist(candidates: RequirementCandidateDraft[]): boolean {
  return candidates.some((candidate) => candidate.assetGaps.some((gap) => gap.severity === "blocking"));
}

function isCreatedCandidate(candidate: RequirementCandidateDraft | null | undefined): boolean {
  return candidate?.creationState === "created";
}

function markCandidateCreated(
  candidate: RequirementCandidateDraft,
  created: {
    intake: TaskIntake;
    proposal: ReturnType<typeof createProposalFromIntake>;
  },
): RequirementCandidateDraft {
  return {
    ...candidate,
    creationState: "created",
    createdIntakeId: created.intake.id,
    createdProposalId: created.proposal.id,
    readyToCreate: false,
    updatedAt: Date.now(),
  };
}

/** 把已持久化候选还原成工具候选输入，供 v2 patch 合并时保留未触碰字段。 */
function candidateDraftToRawCandidate(candidate: RequirementCandidateDraft): Record<string, any> {
  return {
    candidateId: candidate.id,
    title: candidate.title,
    goal: candidate.goal,
    background: candidate.background ?? null,
    acceptanceCriteria: candidate.acceptanceCriteria ?? null,
    splitSource: candidate.splitSource,
    complexity: candidate.complexity,
    uiScope: candidate.uiScope,
    architectureRisk: candidate.architectureRisk,
    recommendedWorkflowId: candidate.recommendedWorkflowId ?? null,
    recommendedWorkflowName: candidate.recommendedWorkflowName ?? null,
    recommendedWorkflowReason: candidate.recommendedWorkflowReason,
    recommendedApproach: candidate.recommendedApproach,
    recommendedRoleIds: candidate.recommendedRoleIds,
    recommendedKnowledgeBundleIds: candidate.recommendedKnowledgeBundleIds,
    phasingAssessment: candidate.phasingAssessment,
    sizeAssessment: candidate.sizeAssessment,
    assetGaps: candidate.assetGaps,
    clarificationItems: candidate.clarificationItems,
    assumptions: candidate.assumptions,
    openQuestions: candidate.openQuestions,
    readyToCreate: candidate.readyToCreate,
  };
}

/** 计算候选集合内容 hash，用于 v2 patch 的乐观冲突保护。 */
function computeRequirementCandidateSetHash(candidates: RequirementCandidateDraft[]): string {
  const snapshot = sortRequirementCandidates(candidates).map((candidate) => ({
    ...candidateDraftToRawCandidate(candidate),
    creationState: candidate.creationState,
    createdIntakeId: candidate.createdIntakeId ?? null,
    createdProposalId: candidate.createdProposalId ?? null,
    displayOrder: normalizeCandidateDisplayOrder(candidate.displayOrder) ?? null,
  }));
  return computeStableHash(snapshot);
}

/** 计算单个候选摘要 hash，供模型按索引识别候选内容是否变化。 */
function computeRequirementCandidateHash(candidate: RequirementCandidateDraft): string {
  return computeStableHash({
    ...candidateDraftToRawCandidate(candidate),
    creationState: candidate.creationState,
    createdIntakeId: candidate.createdIntakeId ?? null,
    createdProposalId: candidate.createdProposalId ?? null,
    displayOrder: normalizeCandidateDisplayOrder(candidate.displayOrder) ?? null,
  });
}

/** 使用稳定 JSON 序列化计算短 hash，避免对象字段顺序影响冲突判断。 */
function computeStableHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableJsonStringify(value)).digest("hex").slice(0, 24);
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(obj[key])}`).join(",")}}`;
}

function sortRequirementCandidates(candidates: RequirementCandidateDraft[]): RequirementCandidateDraft[] {
  return [...candidates].sort((left, right) => {
    const leftCreated = isCreatedCandidate(left) ? 1 : 0;
    const rightCreated = isCreatedCandidate(right) ? 1 : 0;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    const leftOrder = normalizeCandidateDisplayOrder(left.displayOrder);
    const rightOrder = normalizeCandidateDisplayOrder(right.displayOrder);
    if (leftOrder != null || rightOrder != null) {
      if (leftOrder == null) return 1;
      if (rightOrder == null) return -1;
      return leftOrder - rightOrder
        || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
        || String(left.id).localeCompare(String(right.id));
    }
    return Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
      || String(left.id).localeCompare(String(right.id));
  });
}

/** 归一化候选展示序号；旧数据缺失时返回调用方指定的兜底值。 */
function normalizeCandidateDisplayOrder(raw: unknown, fallback?: number): number | undefined {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  return fallback;
}

function candidateIdentityKey(title: string, goal: string): string {
  return `${normalizeSingleLine(title).toLowerCase()}::${normalizeSingleLine(goal).toLowerCase()}`;
}

