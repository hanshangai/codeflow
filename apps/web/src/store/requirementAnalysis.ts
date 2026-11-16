import { defineStore } from "pinia";
import type {
  EngineType,
  ListStatusCount,
  RequirementAnalysisSessionListMeta,
  RequirementAnalysisMessage,
  RequirementAnalysisSession,
  RequirementCandidateDraft,
  RequirementCandidateId,
  RequirementDraftListStatus,
  ThreadId,
  WorkflowId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../api/request";
import {
  createRequirementAnalysisIntakes,
  createRequirementAnalysisSession,
  getRequirementAnalysisSession,
  listRequirementAnalysisSessions,
  sendRequirementAnalysisMessage,
} from "../api/orchestration";
import { useChatStore } from "./chat";
import { isSharedWorkspaceSelectionId } from "../utils/workspaceId";

export type RequirementAnalysisViewMode = "intakes" | "analysis";
/** 需求分析草稿列表单页大小:50 条覆盖绝大多数 sidebar 场景,避免一上来就显示「加载更多」 */
const REQUIREMENT_ANALYSIS_PAGE_LIMIT = 50;
const REQUIREMENT_DRAFT_STATUS_LABELS: Record<RequirementDraftListStatus, string> = {
  running: "运行中",
  clarifying: "待澄清",
  "ready-to-create": "待创建",
  "partial-created": "部分创建",
  created: "已创建",
  archived: "已归档",
};

export function resolveRequirementAnalysisRuntimeThreadId(
  session: RequirementAnalysisSession | null | undefined,
  fallbackSessionId?: RequirementAnalysisSession["id"] | null,
): ThreadId | null {
  const runtimeThreadId = String(session?.runtimeThreadId ?? "").trim();
  if (runtimeThreadId) return runtimeThreadId as ThreadId;
  const sessionId = String(session?.id ?? fallbackSessionId ?? "").trim();
  return sessionId ? (sessionId as ThreadId) : null;
}

type RequirementAnalysisState = {
  workspaceScopeId: string | null;
  workspaceRequestGeneration: number;
  workspaceRequestSequence: number;
  workspaceLatestRequestByScope: Record<string, number>;
  viewMode: RequirementAnalysisViewMode;
  sessions: RequirementAnalysisSession[];
  sessionsLoading: boolean;
  sessionsLoadingMore: boolean;
  sessionsHasMore: boolean;
  sessionsNextCursor: string | null;
  sessionStatusCounts: Array<ListStatusCount<RequirementDraftListStatus>>;
  sessionTotalCount: number;
  sessionListMetaById: Record<string, RequirementAnalysisSessionListMeta>;
  /** 共享工作区需求分析草稿筛选；true 表示只看本人 owner/participant 相关记录。 */
  sessionListOnlyRelatedToMe: boolean;
  sessionLoading: boolean;
  sending: boolean;
  creatingIntakes: boolean;
  selectedSessionId: RequirementAnalysisSession["id"] | null;
  selectedSession: RequirementAnalysisSession | null;
  messages: RequirementAnalysisMessage[];
  candidates: RequirementCandidateDraft[];
};

export const useRequirementAnalysisStore = defineStore("requirement-analysis", {
  state: (): RequirementAnalysisState => ({
    workspaceScopeId: null,
    workspaceRequestGeneration: 0,
    workspaceRequestSequence: 0,
    workspaceLatestRequestByScope: {},
    viewMode: "intakes",
    sessions: [],
    sessionsLoading: false,
    sessionsLoadingMore: false,
    sessionsHasMore: false,
    sessionsNextCursor: null,
    sessionStatusCounts: [],
    sessionTotalCount: 0,
    sessionListMetaById: {},
    sessionListOnlyRelatedToMe: true,
    sessionLoading: false,
    sending: false,
    creatingIntakes: false,
    selectedSessionId: null,
    selectedSession: null,
    messages: [],
    candidates: [],
  }),
  persist: {
    pick: ["viewMode", "selectedSessionId"],
  },
  getters: {
    hasSessions(state): boolean {
      return state.sessions.length > 0;
    },
  },
  actions: {
    openAnalysisMode() {
      this.viewMode = "analysis";
    },

    openIntakeMode() {
      this.viewMode = "intakes";
    },

    /** 仅刷新需求分析会话摘要；会话详情和嵌入线程必须由用户明确选择后加载。 */
    async refreshSessions(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { onlyRelatedToMe?: boolean | null; search?: string | null; statuses?: RequirementDraftListStatus[] | null },
    ) {
      const request = beginRequirementWorkspaceRequest(this, workspaceId, "sessions");
      if (!request) return;
      const chat = useChatStore();
      this.sessionsLoading = true;
      this.sessionsLoadingMore = false;
      try {
        const onlyRelatedToMe = resolveSharedOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.sessionListOnlyRelatedToMe);
        if (onlyRelatedToMe != null) this.sessionListOnlyRelatedToMe = onlyRelatedToMe;
        const res = await listRequirementAnalysisSessions(ctx, workspaceId, {
          limit: REQUIREMENT_ANALYSIS_PAGE_LIMIT,
          onlyRelatedToMe,
          search: opts?.search ?? null,
          statuses: opts?.statuses ?? null,
        });
        if (!isRequirementWorkspaceRequestCurrent(this, request)) return;
        assertRequirementApiOk(res, "加载需求分析会话失败");
        this.sessions = (res as any).sessions ?? [];
        this.sessionsHasMore = Boolean((res as any).hasMore);
        this.sessionsNextCursor = (res as any).nextCursor ?? null;
        this.sessionStatusCounts = (res as any).statusCounts ?? [];
        this.sessionTotalCount = Number((res as any).totalCount ?? this.sessions.length);
        this.sessionListMetaById = (res as any).listMetaById ?? {};
        this.sessions.forEach((session) => syncChatThread(chat, session));
        if (this.selectedSessionId && !this.sessions.some((session) => session.id === this.selectedSessionId)) {
          this.selectedSessionId = null;
          this.selectedSession = null;
          this.messages = [];
          this.candidates = [];
        }
      } catch (error) {
        if (!isRequirementWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isRequirementWorkspaceRequestCurrent(this, request)) this.sessionsLoading = false;
      }
    },

    async loadMoreSessions(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { onlyRelatedToMe?: boolean | null; search?: string | null; statuses?: RequirementDraftListStatus[] | null },
    ): Promise<void> {
      if (this.sessionsLoading || !this.sessionsHasMore || this.sessionsLoadingMore || !this.sessionsNextCursor) return;
      const request = beginRequirementWorkspaceRequest(this, workspaceId, "sessions");
      if (!request) return;
      const chat = useChatStore();
      this.sessionsLoadingMore = true;
      try {
        const onlyRelatedToMe = resolveSharedOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.sessionListOnlyRelatedToMe);
        const res = await listRequirementAnalysisSessions(ctx, workspaceId, {
          limit: REQUIREMENT_ANALYSIS_PAGE_LIMIT,
          cursor: this.sessionsNextCursor,
          onlyRelatedToMe,
          search: opts?.search ?? null,
          statuses: opts?.statuses ?? null,
        });
        if (!isRequirementWorkspaceRequestCurrent(this, request)) return;
        assertRequirementApiOk(res, "加载更多需求分析会话失败");
        const existingIds = new Set(this.sessions.map((item) => String(item.id)));
        const appended = ((res as any).sessions ?? []).filter((item: RequirementAnalysisSession) => !existingIds.has(String(item.id)));
        this.sessions = [...this.sessions, ...appended];
        this.sessionsHasMore = Boolean((res as any).hasMore);
        this.sessionsNextCursor = (res as any).nextCursor ?? null;
        this.sessionStatusCounts = (res as any).statusCounts ?? this.sessionStatusCounts;
        this.sessionTotalCount = Number((res as any).totalCount ?? this.sessionTotalCount);
        this.sessionListMetaById = { ...this.sessionListMetaById, ...((res as any).listMetaById ?? {}) };
        appended.forEach((session: RequirementAnalysisSession) => syncChatThread(chat, session));
      } catch (error) {
        if (!isRequirementWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isRequirementWorkspaceRequestCurrent(this, request)) this.sessionsLoadingMore = false;
      }
    },

    async createSession(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { title?: string | null; engine?: EngineType | null },
    ) {
      const chat = useChatStore();
      const title = String(opts?.title ?? "").trim() || "未命名需求分析";
      const engine = opts?.engine === "claude" ? "claude" : "codex";
      const threadId = await chat.createThread(ctx, {
        workspaceId,
        engine,
        title,
        threadType: "chat",
        threadSubtype: "requirement-analysis",
      });
      const res = await createRequirementAnalysisSession(ctx, {
        workspaceId,
        threadId,
        title,
      });
      if (!res.ok) throw new Error((res as any).message ?? "创建需求分析会话失败");
      const session = {
        ...((res as any).session as RequirementAnalysisSession),
        runtimeThreadId: resolveRequirementAnalysisRuntimeThreadId((res as any).session as RequirementAnalysisSession, threadId),
      } satisfies RequirementAnalysisSession;
      this.openAnalysisMode();
      upsertLocal(this.sessions, session);
      syncChatThread(chat, session);
      this.selectedSessionId = session.id;
      this.selectedSession = session;
      this.messages = (res as any).messages ?? [];
      this.candidates = (res as any).candidates ?? [];
      await chat.activateEmbeddedThread(ctx, {
        workspaceId,
        threadId: threadId as ThreadId,
        key: `requirement-analysis:${String(session.id)}`,
        owner: "passive",
      });
      return session;
    },

    async loadSession(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      sessionId: RequirementAnalysisSession["id"],
    ) {
      const listRequestIdAtStart = this.workspaceLatestRequestByScope.sessions ?? 0;
      const request = beginRequirementWorkspaceRequest(this, workspaceId, "session-detail");
      if (!request) return;
      const detailStillCurrent = () => (
        isRequirementWorkspaceRequestCurrent(this, request)
        && (this.workspaceLatestRequestByScope.sessions ?? 0) === listRequestIdAtStart
        && (listRequestIdAtStart === 0 || this.sessions.some((session) => session.id === sessionId))
      );
      const chat = useChatStore();
      this.sessionLoading = true;
      try {
        const res = await getRequirementAnalysisSession(ctx, { workspaceId, sessionId });
        if (!detailStillCurrent()) return;
        assertRequirementApiOk(res, "读取需求分析会话失败");
        this.selectedSessionId = sessionId;
        this.selectedSession = (res as any).session as RequirementAnalysisSession;
        syncChatThread(chat, this.selectedSession);
        this.messages = (res as any).messages ?? [];
        this.candidates = (res as any).candidates ?? [];
        if (this.selectedSession) upsertLocal(this.sessions, this.selectedSession);
        const runtimeThreadId = resolveRequirementAnalysisRuntimeThreadId(this.selectedSession, sessionId);
        if (!runtimeThreadId) {
          throw new Error("需求分析会话缺少 runtimeThreadId");
        }
        await chat.activateEmbeddedThread(ctx, {
          workspaceId,
          threadId: runtimeThreadId,
          key: `requirement-analysis:${String(sessionId)}`,
          owner: "passive",
        });
      } catch (error) {
        if (!detailStillCurrent()) return;
        throw error;
      } finally {
        if (isRequirementWorkspaceRequestCurrent(this, request)) this.sessionLoading = false;
      }
    },

    /** 按终局事件线程刷新当前选中会话，避免切页后候选和待补充状态停留在旧快照。 */
    async refreshSelectedSessionForThread(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      threadId: ThreadId,
    ): Promise<boolean> {
      if (!this.selectedSessionId) return false;
      const runtimeThreadId = resolveRequirementAnalysisRuntimeThreadId(this.selectedSession, this.selectedSessionId);
      if (!runtimeThreadId || String(runtimeThreadId) !== String(threadId)) return false;
      await this.loadSession(ctx, workspaceId, this.selectedSessionId);
      return true;
    },

    async archiveSession(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      sessionId: RequirementAnalysisSession["id"],
      status: "active" | "archived" = "archived",
    ) {
      const chat = useChatStore();
      const existingSession = this.sessions.find((item) => item.id === sessionId) ?? this.selectedSession;
      const runtimeThreadId = resolveRequirementAnalysisRuntimeThreadId(
        existingSession,
        sessionId,
      );
      if (!runtimeThreadId) {
        throw new Error("需求分析会话缺少 runtimeThreadId");
      }
      await chat.setThreadArchived(ctx, {
        workspaceId,
        threadId: runtimeThreadId,
        archived: status === "archived",
      });
      const session = {
        ...(existingSession ?? {
          id: sessionId,
          workspaceId,
          title: "未命名需求分析",
          phase: "discover",
          engine: "codex",
          model: null,
          effort: null,
          runtimeThreadId,
          engineSessionId: null,
          latestTurnSummary: null,
          latestAssistantReply: null,
          candidateCount: 0,
          readyCandidateCount: 0,
          createdCandidateCount: 0,
          pendingCandidateCount: 0,
          lastMessageAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        status,
        runtimeThreadId,
        updatedAt: Date.now(),
      } satisfies RequirementAnalysisSession;
      syncChatThread(chat, session);
      if (status === "archived") {
        this.sessions = this.sessions.filter((item) => item.id !== sessionId);
        if (this.selectedSessionId === sessionId) {
          this.selectedSessionId = this.sessions[0]?.id ?? null;
          if (this.selectedSessionId) {
            await this.loadSession(ctx, workspaceId, this.selectedSessionId);
          } else {
            this.selectedSession = null;
            this.messages = [];
            this.candidates = [];
          }
        }
      } else {
        upsertLocal(this.sessions, session);
      }
      return session;
    },

    async deleteSession(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      sessionId: RequirementAnalysisSession["id"],
    ): Promise<void> {
      const chat = useChatStore();
      const runtimeThreadId = resolveRequirementAnalysisRuntimeThreadId(
        this.sessions.find((item) => item.id === sessionId) ?? this.selectedSession,
        sessionId,
      );
      let deleteError: unknown = null;
      if (runtimeThreadId) {
        try {
          await chat.deleteThread(ctx, {
            workspaceId,
            threadId: runtimeThreadId,
          });
        } catch (error) {
          deleteError = error;
        }
      }
      await this.refreshSessions(ctx, workspaceId);
      if (this.sessions.some((item) => item.id === sessionId)) {
        if (deleteError) throw deleteError;
        throw new Error("删除需求分析会话失败");
      }
    },

    async sendMessage(ctx: ApiRequestContext, workspaceId: WorkspaceId, text: string) {
      if (!this.selectedSessionId) throw new Error("请先选择一个需求分析会话");
      const chat = useChatStore();
      this.sending = true;
      try {
        const res = await sendRequirementAnalysisMessage(ctx, {
          workspaceId,
          sessionId: this.selectedSessionId,
          text,
        });
        if (!res.ok) throw new Error((res as any).message ?? "发送需求分析消息失败");
        this.selectedSession = (res as any).session as RequirementAnalysisSession;
        syncChatThread(chat, this.selectedSession);
        if (this.selectedSession) upsertLocal(this.sessions, this.selectedSession);
        const userMessage = (res as any).userMessage as RequirementAnalysisMessage;
        const assistantMessage = (res as any).assistantMessage as RequirementAnalysisMessage;
        this.messages = [...this.messages, userMessage, assistantMessage];
        this.candidates = (res as any).candidates ?? [];
        return res;
      } finally {
        this.sending = false;
      }
    },

    /** 将选中的候选需求落成正式需求，并同步当前草稿详情与列表态。 */
    async createIntakes(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      candidateIds: RequirementCandidateId[],
      workflowSelections?: Array<{ candidateId: RequirementCandidateId; workflowId: WorkflowId }> | null,
    ) {
      if (!this.selectedSessionId) throw new Error("请先选择一个需求分析会话");
      this.creatingIntakes = true;
      try {
        const res = await createRequirementAnalysisIntakes(ctx, {
          workspaceId,
          sessionId: this.selectedSessionId,
          candidateIds,
          workflowSelections: workflowSelections?.length ? workflowSelections : null,
        });
        if (!res.ok) throw new Error((res as any).message ?? "创建需求失败");
        await this.loadSession(ctx, workspaceId, this.selectedSessionId);
        syncSelectedSessionListState(this);
        return res;
      } finally {
        this.creatingIntakes = false;
      }
    },

    /** 切换工作区时失效旧请求，并清空全部工作区级列表、计数、选择和详情状态。 */
    resetForWorkspace(workspaceId: WorkspaceId | null = null) {
      this.workspaceScopeId = workspaceId == null ? null : String(workspaceId);
      this.workspaceRequestGeneration += 1;
      this.workspaceRequestSequence = 0;
      this.workspaceLatestRequestByScope = {};
      this.sessions = [];
      this.sessionsLoading = false;
      this.sessionsLoadingMore = false;
      this.sessionsHasMore = false;
      this.sessionsNextCursor = null;
      this.sessionStatusCounts = [];
      this.sessionTotalCount = 0;
      this.sessionListMetaById = {};
      this.sessionListOnlyRelatedToMe = true;
      this.sessionLoading = false;
      this.sending = false;
      this.creatingIntakes = false;
      this.selectedSessionId = null;
      this.selectedSession = null;
      this.messages = [];
      this.candidates = [];
    },
  },
});

type RequirementWorkspaceRequestToken = {
  workspaceId: string;
  generation: number;
  scope: string;
  requestId: number;
};

/** 登记需求分析请求；跨工作区调用必须先 reset，避免旧数据回写。 */
function beginRequirementWorkspaceRequest(
  state: RequirementAnalysisState,
  workspaceId: WorkspaceId,
  scope: string,
): RequirementWorkspaceRequestToken | null {
  const normalizedWorkspaceId = String(workspaceId ?? "").trim();
  if (!normalizedWorkspaceId) return null;
  if (state.workspaceScopeId == null) state.workspaceScopeId = normalizedWorkspaceId;
  if (state.workspaceScopeId !== normalizedWorkspaceId) return null;
  const requestId = state.workspaceRequestSequence + 1;
  state.workspaceRequestSequence = requestId;
  state.workspaceLatestRequestByScope[scope] = requestId;
  return {
    workspaceId: normalizedWorkspaceId,
    generation: state.workspaceRequestGeneration,
    scope,
    requestId,
  };
}

/** 仅允许当前工作区 generation 和当前 scope 的最新请求回写。 */
function isRequirementWorkspaceRequestCurrent(
  state: RequirementAnalysisState,
  token: RequirementWorkspaceRequestToken | null,
): token is RequirementWorkspaceRequestToken {
  return Boolean(
    token
    && state.workspaceScopeId === token.workspaceId
    && state.workspaceRequestGeneration === token.generation
    && state.workspaceLatestRequestByScope[token.scope] === token.requestId,
  );
}

/** 把需求分析业务失败转为异常，并保留服务端诊断字段。 */
function assertRequirementApiOk(
  res: { ok: boolean; message?: string; code?: string; requestId?: string | null },
  fallbackMessage: string,
): asserts res is typeof res & { ok: true } {
  if (res.ok) return;
  const error = new Error(String(res.message ?? "").trim() || fallbackMessage) as Error & {
    code?: string;
    requestId?: string | null;
  };
  error.code = String(res.code ?? "API_REQUEST_FAILED").trim() || "API_REQUEST_FAILED";
  error.requestId = String(res.requestId ?? "").trim() || null;
  throw error;
}

function upsertLocal<T extends { id: string }>(list: T[], value: T) {
  const index = list.findIndex((item) => item.id === value.id);
  if (index >= 0) list[index] = value;
  else list.unshift(value);
}

/** 用当前会话详情的候选聚合结果刷新草稿列表缓存，避免左侧徽标停留在旧状态。 */
function syncSelectedSessionListState(state: RequirementAnalysisState): void {
  if (!state.selectedSession) return;
  const candidateStats = resolveCandidateStats(state.candidates);
  const session = {
    ...state.selectedSession,
    candidateCount: candidateStats.candidateCount,
    readyCandidateCount: candidateStats.readyCandidateCount,
    createdCandidateCount: candidateStats.createdCandidateCount,
    pendingCandidateCount: candidateStats.pendingCandidateCount,
  } satisfies RequirementAnalysisSession;
  const sessionId = String(session.id);
  const previousStatus = state.sessionListMetaById[sessionId]?.listStatus ?? null;
  const nextStatus = resolveRequirementDraftListStatus(session);
  state.selectedSession = session;
  upsertLocal(state.sessions, session);
  state.sessionListMetaById = {
    ...state.sessionListMetaById,
    [sessionId]: {
      listStatus: nextStatus,
      listStatusLabel: REQUIREMENT_DRAFT_STATUS_LABELS[nextStatus],
      recommendedWorkflowName: resolveRecommendedWorkflowName(state.candidates, state.sessionListMetaById[sessionId]?.recommendedWorkflowName),
    },
  };
  state.sessionStatusCounts = syncRequirementDraftStatusCounts(state.sessionStatusCounts, previousStatus, nextStatus);
}

/** 汇总候选创建状态；created 不再计入 ready/pending。 */
function resolveCandidateStats(candidates: RequirementCandidateDraft[]): {
  candidateCount: number;
  readyCandidateCount: number;
  createdCandidateCount: number;
  pendingCandidateCount: number;
} {
  const createdCandidateCount = candidates.filter((candidate) => candidate.creationState === "created").length;
  const readyCandidateCount = candidates.filter((candidate) => candidate.creationState !== "created" && candidate.readyToCreate).length;
  return {
    candidateCount: candidates.length,
    readyCandidateCount,
    createdCandidateCount,
    pendingCandidateCount: candidates.length - createdCandidateCount - readyCandidateCount,
  };
}

/** 复用后端列表态口径，按候选聚合结果生成草稿列表状态。 */
function resolveRequirementDraftListStatus(session: RequirementAnalysisSession): RequirementDraftListStatus {
  const candidateCount = Number(session.candidateCount ?? 0);
  const readyCount = Number(session.readyCandidateCount ?? 0);
  const createdCount = Number(session.createdCandidateCount ?? 0);
  const pendingCount = Number(session.pendingCandidateCount ?? 0);
  if (session.status === "archived") return "archived";
  if (candidateCount > 0 && createdCount >= candidateCount) return "created";
  if (createdCount > 0) return "partial-created";
  if (readyCount > 0) return "ready-to-create";
  if (pendingCount > 0 || session.phase === "clarify") return "clarifying";
  if (session.status === "completed" || session.phase === "done") return "created";
  return "clarifying";
}

/** 从候选详情中挑选第一个推荐流程名称，缺失时保留列表已有值。 */
function resolveRecommendedWorkflowName(candidates: RequirementCandidateDraft[], fallback?: string | null): string | null {
  return candidates
    .map((candidate) => String(candidate.recommendedWorkflowName ?? "").trim())
    .find(Boolean) ?? fallback ?? null;
}

/** 在本地同步状态计数，避免状态下拉数量在创建后明显滞后。 */
function syncRequirementDraftStatusCounts(
  counts: Array<ListStatusCount<RequirementDraftListStatus>>,
  previousStatus: RequirementDraftListStatus | null,
  nextStatus: RequirementDraftListStatus,
): Array<ListStatusCount<RequirementDraftListStatus>> {
  if (!previousStatus || previousStatus === nextStatus) return counts;
  const nextCounts = new Map<RequirementDraftListStatus, number>();
  for (const item of counts) {
    nextCounts.set(item.status, Number(item.count ?? 0));
  }
  nextCounts.set(previousStatus, Math.max(0, (nextCounts.get(previousStatus) ?? 0) - 1));
  nextCounts.set(nextStatus, (nextCounts.get(nextStatus) ?? 0) + 1);
  return Object.keys(REQUIREMENT_DRAFT_STATUS_LABELS)
    .map((status) => ({
      status: status as RequirementDraftListStatus,
      label: REQUIREMENT_DRAFT_STATUS_LABELS[status as RequirementDraftListStatus],
      count: nextCounts.get(status as RequirementDraftListStatus) ?? 0,
    }))
    .filter((item) => item.count > 0);
}

/** 共享工作区默认只看本人相关草稿；本地工作区不携带该筛选参数。 */
function resolveSharedOnlyRelatedToMe(workspaceId: WorkspaceId, raw: unknown): boolean | null {
  if (!isSharedWorkspaceSelectionId(String(workspaceId))) return null;
  if (raw == null) return true;
  return Boolean(raw);
}

function syncChatThread(chat: ReturnType<typeof useChatStore>, session: RequirementAnalysisSession | null): void {
  if (!session) return;
  const runtimeThreadId = resolveRequirementAnalysisRuntimeThreadId(session);
  if (!runtimeThreadId) return;
  if (runtimeThreadId !== session.id) {
    delete chat.extraThreadSummariesById[String(session.id)];
  }
  chat.upsertThreadSummary({
    id: runtimeThreadId,
    title: session.title,
    engine: session.engine,
    threadType: "chat",
    threadSubtype: "requirement-analysis",
    archived: session.status === "archived",
    readOnly: session.readOnly,
    sharedContext: session.sharedContext,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
}
