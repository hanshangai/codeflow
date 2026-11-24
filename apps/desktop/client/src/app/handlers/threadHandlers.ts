import {
  getThreadEntryVisibility,
  matchesThreadListScope,
  createWorkspacePathReference,
  normalizeThreadListSort,
  normalizeThreadListScope,
  normalizeThreadInputContract,
  normalizeWorkspacePathReferenceList,
  resolveWorkspaceIdAlias,
  ThreadInputContractError,
  workspaceIdsReferToSameWorkspace,
} from "@codeflowai/shared";
import type {
  ConversationEventInput,
  ItemId,
  CodexSkillMentionBinding,
  EngineType,
  TextFileAttachment,
  ThreadGroupId,
  ThreadDraftImageAttachment,
  ThreadId,
  ThreadInputKind,
  ThreadListScope,
  ThreadListSort,
  ThreadManagedServicesScope,
  ThreadPrefs,
  ThreadSubtype,
  ThreadType,
  WorkspacePathReference,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { resolveThreadRunningState, resolveThreadRunningStateMap, resolveThreadWorkflowStateMap } from "../threadRunningState.js";
import { RequirementAnalysisService } from "../../orchestration/requirementAnalysisService.js";
import { OrchRequirementAnalysisSessionRepoError } from "../../db/repos/orchRequirementAnalysisSessionRepo.js";
import { listDesktopLocalNodeThreadIds, listDesktopLocalRequirementThreadIds } from "../../orchestration/orchAssetAuthorityRuntimeReadService.js";
import {
  THREAD_DELETION_IN_PROGRESS_CODE,
} from "../../engines/threadSessionManager.js";
import { assertClientReasoningEffortSupported } from "../../engines/engineModelCapabilities.js";
import { resolveRuntimeThreadPrefsWithCatalogDefaults } from "../../engines/engineModelCatalogRuntime.js";
import { hasExplicitThreadInputContract } from "../../engines/threadInputActions.js";
import { logger } from "../../logger.js";
import { knowledgeTaskOwnerThreadIds } from "../../knowledge/knowledgeConversationService.js";
import { retryPendingTurnTerminal, settleTerminatedCodexTurnOnce } from "../turnInterrupt.js";
import type { ThreadDeletionTask } from "../../db/repos/threadRepo.js";
import type { WorkspaceWriteLease } from "../../workspace-migration/workspaceOperationGate.js";

const CODEX_APP_SERVER_RESTART_NOTICE = "Codex app-server 运行态已重置；下一次请求会启动新进程。";
const THREAD_EVENT_DELETE_BATCH_SIZE = 1_000;
type ThreadDeletionBlockedReason = "running_turn" | "active_orchestration" | "active_asset_job";
type NormalizedSharedThreadAcl = {
  sharedWorkspaceId: string;
  ownerUserId: string;
  visibility?: "private" | "participants" | "team" | null;
  participantUserIds?: string[] | null;
  updatedAt?: number | null;
};
type PersistedThreadForCreateReplay = NonNullable<ReturnType<ApiHandlerContext["db"]["threads"]["get"]>>;

/** 只把同步数据库短段交给现有writer许可，未启用writer时保留原同步入口。 */
function withThreadDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 处理 `threads.create`：创建 thread 元数据（engine 创建后不可变）。 */
export function handleThreadsCreate(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const engine = String((req.body as any)?.engine ?? "").trim() as EngineType;
  const title = String((req.body as any)?.title ?? "").trim();
  const threadType = normalizeThreadType((req.body as any)?.threadType);
  const threadSubtype = normalizeThreadSubtype((req.body as any)?.threadSubtype, threadType);
  const groupId = normalizeThreadGroupId((req.body as any)?.groupId);
  const initialPrefs = normalizeInitialThreadPrefs(threadSubtype, (req.body as any)?.initialPrefs);
  const sharedAcl = normalizeSharedThreadAclInput((req.body as any)?.sharedThreadAcl);
  if (!requestedWorkspaceId || !threadId || (engine !== "claude" && engine !== "codex") || !title) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/engine/title" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }

  let existing: PersistedThreadForCreateReplay | null;
  try {
    existing = ctx.db.threads.get(threadId);
  } catch (error) {
    sendThreadCreateStorageError(ctx, req, "thread_lookup", error);
    return;
  }
  if (existing) {
    if (sharedAcl) {
      handleSharedThreadCreateReplay(ctx, req, {
        thread: existing,
        workspaceId,
        engine,
        threadType,
        threadSubtype,
        sharedAcl,
      });
      return;
    }
    sendThreadCreateError(ctx, req, new Error(`Thread 已存在：${threadId}`));
    return;
  }

  try {
    assertClientReasoningEffortSupported(
      ctx.db,
      engine,
      initialPrefs?.model ?? null,
      (req.body as any)?.initialPrefs?.effort,
    );
  } catch (error) {
    sendThreadCreateError(ctx, req, error);
    return;
  }
  try {
    const persistThread = () => {
      ctx.db.threads.create({ id: threadId, workspaceId, engine, title, threadType, threadSubtype, groupId, prefs: initialPrefs, sharedAcl });
      if (threadSubtype === "requirement-analysis") createRequirementAnalysisService(ctx).initializeNewThreadSession(workspaceId, threadId);
    };
    if (threadSubtype === "requirement-analysis") ctx.db.db.transaction(persistThread)();
    else persistThread();
  } catch (error) {
    if (error instanceof OrchRequirementAnalysisSessionRepoError) throw error;
    let raced: PersistedThreadForCreateReplay | null = null;
    if (sharedAcl && isThreadIdConstraintError(error)) {
      try {
        raced = ctx.db.threads.get(threadId);
      } catch (lookupError) {
        sendThreadCreateStorageError(
          ctx,
          req,
          "constraint_recheck",
          new AggregateError([error, lookupError], "共享会话创建唯一约束后的持久化回读失败"),
        );
        return;
      }
    }
    if (raced && sharedAcl) {
      handleSharedThreadCreateReplay(ctx, req, {
        thread: raced,
        workspaceId,
        engine,
        threadType,
        threadSubtype,
        sharedAcl,
      });
      return;
    }
    if (threadSubtype === "requirement-analysis") sendThreadCreateStorageError(ctx, req, "requirement_analysis_initialize", error);
    else sendThreadCreateError(ctx, req, error);
    return;
  }
  ctx.threads.create({ workspaceId, threadId, engine, title });

  emit(ctx, { ts: Date.now(), workspaceId, threadId, engine, type: "thread.started", payload: {} });
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
}

/** 同一短快照读取归属、分页和运行态；本机节点与 RA 归属在分页前校验，事务外响应。 */
export function handleThreadsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const includeArchived = Boolean((req.body as any)?.includeArchived ?? false);
  const scope = resolveThreadListScope((req.body as any)?.scope);
  const sort = resolveThreadListSort((req.body as any)?.sort);
  const search = String((req.body as any)?.search ?? "").trim();
  const groupId = normalizeThreadGroupFilter((req.body as any)?.groupId);
  const limit = parsePositiveInt((req.body as any)?.limit) ?? undefined;
  const cursor = typeof (req.body as any)?.cursor === "string" ? String((req.body as any).cursor).trim() || null : null;
  if (!requestedWorkspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }

  const data = ctx.db.db.transaction(() => {
    const result = ctx.db.threads.listByWorkspace(workspaceId, { scope, sort, includeArchived, search, groupId, limit, cursor, threadListOnly: true, localOnly: ctx.localWorkspaceOnly,
      localNodeThreadIds: ctx.localWorkspaceOnly ? listDesktopLocalNodeThreadIds(ctx.clientId, ctx.workspaces, ctx.db, workspaceId) : undefined,
      localRequirementThreadIds: ctx.localWorkspaceOnly ? listDesktopLocalRequirementThreadIds(ctx.clientId, ctx.workspaces, ctx.db, workspaceId) : undefined,
      knowledgeActorUserId: nullableString((req.body as any)?.actorUserId),
      emptyKnowledgeOwnerThreadIds: scope === "current" || scope === "orchestration" ? [] : knowledgeTaskOwnerThreadIds(ctx.workspaces.get(workspaceId)!),
    });
    const threads = result.threads.filter((thread) => getThreadEntryVisibility(thread).threadList && (!scope || matchesThreadListScope(thread, scope)));
    const runningByThreadId = threads.length ? resolveThreadRunningStateMap(ctx, { workspaceId, threads }) : {};
    const workflowByThreadId = threads.length ? resolveThreadWorkflowStateMap(ctx, { workspaceId, threads }) : {};
    return { threads, runningByThreadId, workflowByThreadId, hasMore: result.hasMore, nextCursor: result.nextCursor };
  })();
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: { ok: true, ...data },
  });
}

/** 读取 Host 内部派生的共享 ACL；普通 `threads.create` 不传时保持本地会话语义。 */
function normalizeSharedThreadAclInput(raw: unknown): NormalizedSharedThreadAcl | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const sharedWorkspaceId = String(record.sharedWorkspaceId ?? "").trim();
  const ownerUserId = String(record.ownerUserId ?? "").trim();
  if (!sharedWorkspaceId || !ownerUserId) return null;
  const visibility = record.visibility === "private" || record.visibility === "team" ? record.visibility : "participants";
  const participantUserIds = Array.isArray(record.participantUserIds)
    ? record.participantUserIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const updatedAt = Number(record.updatedAt);
  return {
    sharedWorkspaceId,
    ownerUserId,
    visibility,
    participantUserIds,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : null,
  };
}

/** 仅对身份一致的共享创建重放返回幂等成功，并按持久化记录补齐缺失运行态。 */
function handleSharedThreadCreateReplay(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  input: {
    thread: PersistedThreadForCreateReplay;
    workspaceId: WorkspaceId;
    engine: EngineType;
    threadType: ThreadType;
    threadSubtype: ThreadSubtype | null;
    sharedAcl: NormalizedSharedThreadAcl;
  },
): void {
  const { thread, workspaceId, engine, threadType, threadSubtype, sharedAcl } = input;
  const conflictField = !workspaceIdsReferToSameWorkspace(thread.workspaceId, workspaceId)
    ? "workspaceId"
    : thread.engine !== engine
      ? "engine"
      : thread.threadType !== threadType
        ? "threadType"
        : thread.threadSubtype !== threadSubtype
          ? "threadSubtype"
          : !thread.sharedWorkspaceId || thread.sharedWorkspaceId !== sharedAcl.sharedWorkspaceId
            ? "sharedWorkspaceId"
            : !thread.ownerUserId || thread.ownerUserId !== sharedAcl.ownerUserId
              ? "ownerUserId"
              : null;
  if (conflictField) {
    rejectSharedThreadCreateReplay(ctx, req, input, `持久化会话的 ${conflictField} 不匹配`);
    return;
  }
  if (thread.threadSubtype === "requirement-analysis") createRequirementAnalysisService(ctx).assertThreadWorkspaceScope(workspaceId, thread.id);

  const runtime = ctx.threads.get(thread.id);
  if (runtime && (
    !workspaceIdsReferToSameWorkspace(runtime.workspaceId, thread.workspaceId)
    || runtime.engine !== thread.engine
  )) {
    rejectSharedThreadCreateReplay(ctx, req, input, "内存运行态与持久化会话身份不匹配");
    return;
  }
  if (!runtime) {
    ctx.threads.create({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      engine: thread.engine,
      title: thread.title,
      sessionId: thread.sessionId,
      sessionCapabilities: thread.sessionCapabilities,
    });
  }
  ctx.threads.setTitle(thread.id, thread.title);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, idempotent: true } });
}

/** 拒绝共享创建重放中的身份冲突，并记录可检索的请求与会话上下文。 */
function rejectSharedThreadCreateReplay(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  input: {
    thread: PersistedThreadForCreateReplay;
    workspaceId: WorkspaceId;
    sharedAcl: NormalizedSharedThreadAcl;
  },
  rootCause: string,
): void {
  const errorCode = "SHARED_THREAD_CREATE_IDEMPOTENCY_CONFLICT";
  logger.warn("thread-create", "shared thread create replay rejected", {
    errorCode,
    requestId: req.id,
    threadId: input.thread.id,
    workspaceId: input.workspaceId,
    sharedWorkspaceId: input.sharedAcl.sharedWorkspaceId,
    rootCause,
  });
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 409,
    body: { ok: false, code: errorCode, message: `共享会话创建重放冲突：${rootCause}` },
  });
}

function resolveThreadManagedServicesScope(ctx: ApiHandlerContext, threadId: ThreadId): ThreadManagedServicesScope {
  const thread = ctx.db.threads.get(threadId);
  if (!thread) return { visible: false, threadId: null };
  return { visible: true, threadId };
}

export function handleThreadsSummary(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const thread = requireWorkspaceThread(ctx, req);
  if (!thread) return;

  const running = resolveThreadRunningState(ctx, { workspaceId: thread.workspaceId, threadId: thread.id });
  const managedServices = resolveThreadManagedServicesScope(ctx, thread.id);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      thread: {
        id: thread.id,
        title: thread.title,
        threadType: thread.threadType,
        threadSubtype: thread.threadSubtype,
        archived: thread.archived,
        pinnedAt: thread.pinnedAt,
        groupId: thread.groupId,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        engine: thread.engine,
      },
      running,
      visibility: getThreadEntryVisibility(thread),
      managedServices,
    },
  });
}

/** 处理 `threads.groups.list`：列出当前工作区的会话分组。 */
export function handleThreadGroupsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  if (!requestedWorkspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }
  const groups = ctx.db.threads.listGroups(workspaceId, {
    sharedWorkspaceId: normalizeSharedWorkspaceId((req.body as any)?.sharedWorkspaceId),
    actorUserId: nullableString((req.body as any)?.actorUserId),
    actorIsAdmin: Boolean((req.body as any)?.actorIsAdmin ?? false),
  });
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, groups } });
}

/** 处理 `threads.groups.create`：创建会话分组。 */
export function handleThreadGroupsCreate(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  if (!requestedWorkspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }
  try {
    const group = ctx.db.threads.createGroup({
      workspaceId,
      name: (req.body as any)?.name,
      sharedWorkspaceId: normalizeSharedWorkspaceId((req.body as any)?.sharedWorkspaceId),
      createdByUserId: nullableString((req.body as any)?.actorUserId),
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, group } });
  } catch (error) {
    sendThreadGroupError(ctx, req, error);
  }
}

/** 处理 `threads.groups.rename`：重命名会话分组。 */
export function handleThreadGroupsRename(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const groupId = normalizeThreadGroupId((req.body as any)?.groupId);
  if (!requestedWorkspaceId || !groupId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/groupId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }
  try {
    const group = ctx.db.threads.renameGroup({
      workspaceId,
      groupId,
      name: (req.body as any)?.name,
      sharedWorkspaceId: normalizeSharedWorkspaceId((req.body as any)?.sharedWorkspaceId),
      actorUserId: nullableString((req.body as any)?.actorUserId),
      actorIsAdmin: Boolean((req.body as any)?.actorIsAdmin ?? false),
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, group } });
  } catch (error) {
    sendThreadGroupError(ctx, req, error);
  }
}

/** 处理 `threads.groups.delete`：删除分组并让组内会话回到未分组。 */
export function handleThreadGroupsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const groupId = normalizeThreadGroupId((req.body as any)?.groupId);
  if (!requestedWorkspaceId || !groupId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/groupId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }
  try {
    const ungroupedThreadCount = ctx.db.threads.deleteGroup({
      workspaceId,
      groupId,
      sharedWorkspaceId: normalizeSharedWorkspaceId((req.body as any)?.sharedWorkspaceId),
      actorUserId: nullableString((req.body as any)?.actorUserId),
      actorIsAdmin: Boolean((req.body as any)?.actorIsAdmin ?? false),
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ungroupedThreadCount } });
  } catch (error) {
    sendThreadGroupError(ctx, req, error);
  }
}

/** 处理 `threads.group.assign`：把自建会话移动到指定分组或未分组。 */
export function handleThreadGroupAssign(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  if (!requestedWorkspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }
  try {
    const groupId = ctx.db.threads.setThreadGroup({
      workspaceId,
      threadId,
      groupId: normalizeThreadGroupId((req.body as any)?.groupId),
      sharedWorkspaceId: normalizeSharedWorkspaceId((req.body as any)?.sharedWorkspaceId),
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, groupId } });
  } catch (error) {
    sendThreadGroupError(ctx, req, error);
  }
}

/** 解析正整数（非法返回 null）。 */
function parsePositiveInt(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i > 0 ? i : null;
}

function resolveThreadListScope(raw: unknown): ThreadListScope | null {
  if (raw == null || String(raw).trim() === "") return null;
  return normalizeThreadListScope(raw, "all");
}

/** 解析列表排序参数；缺省使用最近活动倒序。 */
function resolveThreadListSort(raw: unknown): ThreadListSort {
  return normalizeThreadListSort(raw, "activity_desc");
}

/** 解析列表分组过滤；空值表示不过滤，ungrouped 表示未分组。 */
function normalizeThreadGroupFilter(raw: unknown): ThreadGroupId | "ungrouped" | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return value === "ungrouped" ? "ungrouped" : (value as ThreadGroupId);
}

/** 读取非空分组 ID；空值表示未分组。 */
function normalizeThreadGroupId(raw: unknown): ThreadGroupId | null {
  const value = String(raw ?? "").trim();
  return value ? (value as ThreadGroupId) : null;
}

/** 分批只读历史并在短快照内组装附属状态；慢请求记录阶段耗时。 */
export async function handleThreadsLoad(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const startedAt = performance.now();
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const limit = parseLoadLimit((req.body as any)?.limit);
  const beforeSeq = parseBeforeSeq((req.body as any)?.beforeSeq);
  const presentationLimit = parsePresentationLimit((req.body as any)?.presentationLimit);
  const presentationBeforePosition = parseBeforeSeq((req.body as any)?.presentationBeforePosition);
  if (!requestedWorkspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }
  await ctx.flushLocalEvents?.(workspaceId, threadId);
  const thread = await withThreadDatabase(ctx, req.id, () => ctx.db.threads.get(threadId));
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (!workspaceIdsReferToSameWorkspace(thread.workspaceId, workspaceId)) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        message: "workspace 不匹配",
        details: threadWorkspaceMismatchDetails(thread.workspaceId, workspaceId),
      },
    });
    return;
  }

  const historyStartedAt = performance.now();
  let presentationPrepareMs = 0, presentationReadMs = 0, databaseWaitMs = 0;
  let presentationPending = false;
  /** 区分writer准入排队和同步数据库工作，避免将全部history耗时误判为锁等待。 */
  const historyAccess = <T>(operation: () => T): Promise<T> => {
    const queuedAt = performance.now();
    return withThreadDatabase(ctx, req.id, () => { databaseWaitMs += performance.now() - queuedAt; return operation(); });
  };
  let history;
  try {
    if ((req.body as { presentation?: unknown })?.presentation === "lazy") {
      const ready = await historyAccess(() => ctx.db.conversationEvents.isPresentationReady(threadId));
      if (ready) {
        const readingAt = performance.now();
        const presentation = await historyAccess(() => presentationLimit
          ? ctx.db.conversationEvents.readPresentationPage(threadId, { messageLimit: presentationLimit, beforePosition: presentationBeforePosition })
          : ctx.db.conversationEvents.readPresentation(threadId));
        presentationReadMs = performance.now() - readingAt;
        history = { events: [], presentation, hasMore: false, oldestSeq: null, latestSeq: presentation.version, rawEventCount: 0 };
      } else {
        presentationPending = true;
        history = { ...await ctx.db.conversationEvents.listByThreadForReplay(threadId, {
          ...(limit ? { limit } : {}), ...(beforeSeq != null ? { beforeSeq } : {}), withDatabase: historyAccess,
        }), presentation: undefined };
        logger.info("api", "cold thread presentation deferred", {
          code: "THREAD_PRESENTATION_BUILD_DEFERRED", requestId: req.id, workspaceId, threadId,
          replayEventCount: history.rawEventCount, latestSeq: history.latestSeq, databaseWaitMs,
          elapsedMs: performance.now() - startedAt,
        });
      }
    } else {
      history = { ...await ctx.db.conversationEvents.listByThreadForReplay(threadId, { ...(limit ? { limit } : {}), ...(beforeSeq != null ? { beforeSeq } : {}),
        withDatabase: historyAccess }), presentation: undefined };
    }
  } catch (error) {
    logger.error("api", "thread history load failed", {
      code: "THREAD_HISTORY_LOAD_FAILED", requestId: req.id, workspaceId, threadId, beforeSeq, limit,
      presentationPrepareMs, presentationReadMs, databaseWaitMs,
      rootCause: error instanceof Error ? { message: error.message, cause: error.cause instanceof Error ? error.cause.message : error.cause } : String(error),
    });
    ctx.onApiFailureLogged?.();
    throw error;
  }
  const { events, hasMore, oldestSeq, latestSeq, rawEventCount } = history;
  const stateStartedAt = performance.now();
  const { running, hasRealTurnActivity, managedServices, draft, deletedMessageIds } = await withThreadDatabase(ctx, req.id, () => ctx.db.db.transaction(() => ({
    running: resolveThreadRunningState(ctx, { workspaceId: thread.workspaceId, threadId: thread.id,
      runningByThreadId: ctx.db.turns.listRunningByWorkspace(thread.workspaceId) }),
    hasRealTurnActivity: ctx.db.turns.hasAnyByThread(thread.id),
    managedServices: resolveThreadManagedServicesScope(ctx, thread.id),
    draft: readThreadDraftForRequest(ctx, req, thread),
    deletedMessageIds: ctx.db.conversationEvents.listDeletedMessageIds(threadId),
  }))());
  const completedAt = performance.now();
  if (completedAt - startedAt >= 500) logger.warn("api", "thread history load slow", {
    code: "THREAD_HISTORY_LOAD_SLOW", requestId: req.id, workspaceId, threadId, beforeSeq, limit,
    ms: completedAt - startedAt, historyMs: stateStartedAt - historyStartedAt, stateMs: completedAt - stateStartedAt,
    presentationPending, presentationPrepareMs, presentationReadMs, databaseWaitMs,
    rawEventCount, eventCount: events.length,
  });
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      thread: {
        id: thread.id,
        workspaceId: thread.workspaceId,
        engine: thread.engine,
        title: thread.title,
        threadType: thread.threadType,
        threadSubtype: thread.threadSubtype,
        sessionId: thread.sessionId,
        pinnedAt: thread.pinnedAt,
        groupId: thread.groupId,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        model: thread.model,
        effort: thread.effort,
        accessMode: thread.accessMode,
        planMode: thread.planMode,
        knowledgeEnabled: thread.knowledgeEnabled,
        autoCompactPct: thread.autoCompactPct,
        contextWindow: thread.contextWindow,
        serviceTier: thread.serviceTier,
        roleId: thread.roleId,
      },
      hasRealTurnActivity,
      running,
      managedServices,
      draft,
      deletedMessageIds,
      events,
      hasMore,
      oldestSeq,
      latestSeq,
      rawEventCount,
      ...(presentationPending ? { presentationPending: true } : {}),
      ...(history.presentation ? { presentation: history.presentation } : {}),
    },
  });
}

/** 展示与过程明细沿本机仓储读取；失败在请求边界带上下文记录并向上返回。 */
export async function handleThreadsPresentation(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const startedAt = performance.now();
  let prepareMs = 0, readMs = 0, databaseWaitMs = 0;
  /** 单独记录Writer准入等待，冷建、投影读取和锁排队不可混成一个历史时间。 */
  const access = <T>(operation: () => T): Promise<T> => {
    const queuedAt = performance.now();
    return withThreadDatabase(ctx, req.id, () => { databaseWaitMs += performance.now() - queuedAt; return operation(); });
  };
  const bodyScope = req.body as { workspaceId?: WorkspaceId; threadId?: ThreadId };
  if (bodyScope.workspaceId && bodyScope.threadId) await ctx.flushLocalEvents?.(bodyScope.workspaceId, bodyScope.threadId);
  const thread = await withThreadDatabase(ctx, req.id, () => requireWorkspaceThread(ctx, req));
  if (!thread) return;
  try {
    const prepareStartedAt = performance.now();
    await ctx.db.ensureThreadPresentation(thread.workspaceId, thread.id, { withDatabase: access });
    prepareMs = performance.now() - prepareStartedAt;
    const body = req.body as { processId?: string; afterSeq?: number; cursor?: string; throughSeq?: number; limit?: number;
      presentationLimit?: number; presentationBeforePosition?: number };
    const presentationLimit = parsePresentationLimit(body.presentationLimit);
    const presentationBeforePosition = parseBeforeSeq(body.presentationBeforePosition);
    const readStartedAt = performance.now();
    const result = await access(() => req.method === "threads.process"
      ? ctx.db.conversationEvents.readProcess(thread.id, String(body.processId ?? ""), body)
      : { presentation: presentationLimit
          ? ctx.db.conversationEvents.readPresentationPage(thread.id, { messageLimit: presentationLimit, beforePosition: presentationBeforePosition })
          : ctx.db.conversationEvents.readPresentation(thread.id) });
    readMs = performance.now() - readStartedAt;
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= 500) logger.warn("api", "thread presentation read slow", {
      code: "THREAD_PRESENTATION_READ_SLOW", requestId: req.id, workspaceId: thread.workspaceId, threadId: thread.id,
      method: req.method, elapsedMs, prepareMs, readMs, databaseWaitMs,
      presentationLimit: presentationLimit ?? null,
      itemCount: "presentation" in result ? result.presentation.items.length : result.items.length,
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (error) {
    logger.error("api", "thread presentation read failed", {
      code: "THREAD_PRESENTATION_READ_FAILED", requestId: req.id, workspaceId: thread.workspaceId, threadId: thread.id,
      method: req.method, prepareMs, readMs, databaseWaitMs, elapsedMs: performance.now() - startedAt,
      processId: (req.body as { processId?: unknown })?.processId,
      rootCause: error instanceof Error ? error.message : String(error),
    });
    ctx.onApiFailureLogged?.();
    throw error;
  }
}

/** 删除聊天记录并广播删除事实；允许运行中操作，不接触引擎上下文或执行状态。 */
export async function handleThreadMessageDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const thread = await withThreadDatabase(ctx, req.id, () => requireWorkspaceThread(ctx, req));
  if (!thread) return;
  const itemId = String((req.body as { itemId?: unknown })?.itemId ?? "").trim();
  const context = { requestId: req.id, workspaceId: thread.workspaceId, threadId: thread.id, itemId };
  try {
    if (!itemId || itemId.length > 512 || itemId.startsWith("local_user_")) {
      throw new Error("消息 ID 无效，请等待消息发送完成后重试");
    }
    await ctx.flushLocalEvents?.(thread.workspaceId, thread.id);
    await withThreadDatabase(ctx, req.id, () => ctx.db.conversationEvents.deleteMessage(thread.id, itemId));
    const dispatched = ctx.send({
      t: "conversation.event",
      event: {
        ts: Date.now(), workspaceId: thread.workspaceId, threadId: thread.id, engine: thread.engine,
        type: "item.message.deleted", payload: { itemId: itemId as ItemId },
      },
    });
    if (!dispatched?.accepted) throw new Error(`消息已删除，删除通知发送失败：${dispatched?.reason ?? "未返回发送结果"}`);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, itemId } });
  } catch (error) {
    const rootCause = error instanceof Error ? error.message : String(error);
    logger.error("message-delete", "chat message deletion failed", { ...context, code: "MESSAGE_DELETE_FAILED", rootCause });
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, code: "MESSAGE_DELETE_FAILED", message: rootCause } });
  }
}

/** 处理 `threads.prefs`：只读取 thread 的会话级偏好。 */
export function handleThreadsPrefs(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  if (!requestedWorkspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }
  const thread = ctx.db.threads.get(threadId);
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (!workspaceIdsReferToSameWorkspace(thread.workspaceId, workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }

  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      prefs: {
        model: thread.model,
        effort: thread.effort,
        accessMode: thread.accessMode,
        planMode: thread.planMode,
        knowledgeEnabled: thread.knowledgeEnabled,
        autoCompactPct: thread.autoCompactPct,
        contextWindow: thread.contextWindow,
        serviceTier: thread.serviceTier,
        roleId: thread.roleId,
      },
    },
  });
}

export function handleThreadsDraftGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const thread = requireWorkspaceThread(ctx, req);
  if (!thread) return;

  const draft = readThreadDraftForRequest(ctx, req, thread);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: { ok: true, draft },
  });
}

export function handleThreadsDraftSave(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const thread = requireWorkspaceThread(ctx, req);
  if (!thread) return;

  const rawDraft = (req.body as any)?.draft;
  let draft: ReturnType<typeof normalizeThreadDraftPayload>;
  try {
    draft = normalizeThreadDraftPayload(rawDraft);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("api", "thread draft input contract validation failed", {
      code: error instanceof ThreadInputContractError ? error.code : "BAD_REQUEST",
      requestId: req.id,
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      rootCause: message,
    });
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }
  if (!draft) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：draft" } });
    return;
  }
  const explicitInputContract = hasExplicitThreadInputContract(rawDraft);
  const knowledgeTextDraft = thread.threadSubtype === "knowledge-conversation" && draft.inputKind !== "provider-slash" && !draft.skillMentions?.length;
  if (explicitInputContract && !knowledgeTextDraft && (thread.threadSubtype != null || thread.threadType === "orchestration")) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "PROVIDER_SLASH_CONFLICT", message: "输入动作仅支持普通聊天会话" },
    });
    return;
  }
  if (draft.skillMentions?.length && thread.engine !== "codex") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, code: "CODEX_SKILL_BINDING_INVALID", message: "Skill binding 仅支持 Codex" },
    });
    return;
  }

  const saved = ctx.db.threadDrafts.save({
    workspaceId: thread.workspaceId,
    threadId: thread.id,
    text: draft.text,
    ...(draft.inputKind ? { inputKind: draft.inputKind } : {}),
    ...(draft.skillMentions ? { skillMentions: draft.skillMentions } : {}),
    images: draft.images,
    files: draft.files,
    pathReferences: draft.pathReferences,
    updatedByWebSessionId: (req.body as any)?.updatedByWebSessionId ?? null,
  });
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      version: saved.version,
      updatedAt: saved.updatedAt,
      updatedByWebSessionId: saved.updatedByWebSessionId,
    },
  });
}

export function handleThreadsDraftClear(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const thread = requireWorkspaceThread(ctx, req);
  if (!thread) return;

  ctx.db.threadDrafts.clear(thread.id);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
}

/** threads.load：解析 limit（非法值返回 null，使用默认 limit）。 */
function parseLoadLimit(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return i;
}

/** threads.load：解析展示消息窗口大小（非法值返回 null；超上限与其它入口一致截断到 200）。 */
function parsePresentationLimit(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i > 0 ? Math.min(200, i) : null;
}

/** threads.load：解析 beforeSeq 游标（非法值返回 null，即取最新）。 */
function parseBeforeSeq(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return i;
}

/** 倒序分页读取原始事件；所属请求边界记录完整读取失败后继续上抛。 */
export function handleThreadsEvents(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const beforeSeq = (req.body as any)?.beforeSeq as number | null | undefined;
  const limit = (req.body as any)?.limit as number | null | undefined;
  if (!requestedWorkspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }
  const thread = ctx.db.threads.get(threadId);
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (thread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }

  let page;
  try {
    page = ctx.db.rawEvents.pageByThread(threadId, { beforeSeq, limit });
  } catch (error) {
    logger.error("api", "thread raw events load failed", {
      code: "THREAD_RAW_EVENTS_LOAD_FAILED", requestId: req.id, workspaceId, threadId, beforeSeq, limit,
      rootCause: error instanceof Error ? { message: error.message, cause: error.cause instanceof Error ? error.cause.message : error.cause } : String(error),
    });
    ctx.onApiFailureLogged?.();
    throw error;
  }
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      events: page.events,
      nextBeforeSeq: page.nextBeforeSeq,
    },
  });
}

/** 处理 `threads.managedServices.list`：列出当前聊天窗口绑定的进程。 */
export function handleThreadsManagedServicesList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const thread = requireWorkspaceThread(ctx, req);
  if (!thread) return;
  const items = ctx.orchEngine.listManagedServicesForThread(thread.id);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      items,
    },
  });
}

/** 处理 `threads.managedServices.stop`：停止当前聊天窗口绑定的进程。 */
export async function handleThreadsManagedServicesStop(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const thread = await withThreadDatabase(ctx, req.id, () => requireWorkspaceThread(ctx, req));
  if (!thread) return;
  const serviceId = String((req.body as any)?.serviceId ?? "").trim();
  if (!serviceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：serviceId" } });
    return;
  }

  const stopped = await ctx.orchEngine.stopManagedServiceForThread(thread.id, serviceId);
  if (!stopped) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `进程不存在：${serviceId}` } });
    return;
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
}

/** 处理 `threads.restartCodexAppServer`：显式重启 Codex，作为自动恢复之外的兜底动作。 */
export async function handleThreadsRestartCodexAppServer(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const thread = await withThreadDatabase(ctx, req.id, () => requireWorkspaceThread(ctx, req));
  if (!thread) return;
  if (thread.engine !== "codex") {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "当前会话不是 Codex，无法重启 Codex" } });
    return;
  }

  try {
    const runningTurnIds = await withThreadDatabase(ctx, req.id, () => new Set(ctx.db.turns.listByThread(thread.id)
      .filter((turn) => turn.status === "started" && turn.endedAt == null)
      .map((turn) => turn.turnId)));
    const activeTurnId = ctx.sessions.getActiveTurnId(thread.id);
    if (activeTurnId) runningTurnIds.add(activeTurnId);
    const queueTurnId = activeTurnId ?? [...runningTurnIds].at(-1) ?? null;
    logger.info("thread-handler", "explicit Codex app-server restart requested", {
      code: "codex_explicit_restart_requested",
      requestId: req.id,
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      turnIds: [...runningTurnIds],
      source: req.method,
    });
    await ctx.sessions.restartCodexProcesses({
      mode: "force",
      threadId: thread.id,
      requestId: req.id,
      afterTermination: async (session) => {
        await retryPendingTurnTerminal(ctx, { workspaceId: thread.workspaceId, threadId: thread.id });
        for (const turnId of runningTurnIds) {
          await settleTerminatedCodexTurnOnce(ctx, {
            workspaceId: thread.workspaceId, threadId: thread.id, turnId, session,
            notifyQueue: turnId === queueTurnId,
          });
        }
        await ctx.flushEventPersistence?.();
        await ctx.flushLocalEvents?.(thread.workspaceId, thread.id);
      },
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: { ok: true, message: CODEX_APP_SERVER_RESTART_NOTICE },
    });
  } catch (cause) {
    const rootCause = cause instanceof Error ? cause.message : String(cause);
    logger.error("thread-handler", "explicit Codex app-server restart failed", {
      code: "codex_explicit_restart_failed",
      requestId: req.id,
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      rootCause,
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "codex_restart_failed",
        message: rootCause,
      },
    });
  }
}

/** 处理 `threads.rename`：更新 thread 标题（不改变 engine/session）。 */
export function handleThreadsRename(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const title = String((req.body as any)?.title ?? "").trim();
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim();
  const requestedThreadId = String((req.body as any)?.threadId ?? "").trim();
  if (!requestedWorkspaceId || !requestedThreadId || !title) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/title" } });
    return;
  }
  const thread = requireWorkspaceThread(ctx, req);
  if (!thread) return;

  if (thread.threadSubtype === "requirement-analysis") createRequirementAnalysisService(ctx).assertThreadWorkspaceScope(thread.workspaceId, thread.id);
  ctx.db.threads.rename(thread.id, title);
  ctx.threads.setTitle(thread.id, title);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
}

/** 处理 `threads.archive`：归档/取消归档 thread。 */
export function handleThreadsArchive(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const archived = Boolean((req.body as any)?.archived ?? false);
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim();
  const requestedThreadId = String((req.body as any)?.threadId ?? "").trim();
  if (!requestedWorkspaceId || !requestedThreadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/archived" } });
    return;
  }
  const thread = requireWorkspaceThread(ctx, req);
  if (!thread) return;

  if (thread.threadSubtype === "requirement-analysis") {
    const session = createRequirementAnalysisService(ctx).updateSessionStatus(
      thread.workspaceId,
      thread.id as any,
      archived ? "archived" : "active",
    );
    if (!session) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `需求分析会话不存在：${thread.id}` } });
      return;
    }
  } else {
    ctx.db.threads.setArchived(thread.id, archived);
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
}

/** 处理 `threads.pin`：置顶/取消置顶 thread。 */
export function handleThreadsPin(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const pinned = Boolean((req.body as any)?.pinned ?? false);
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim();
  const requestedThreadId = String((req.body as any)?.threadId ?? "").trim();
  if (!requestedWorkspaceId || !requestedThreadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/pinned" } });
    return;
  }
  const thread = requireWorkspaceThread(ctx, req);
  if (!thread) return;

  const pinnedAt = ctx.db.threads.setPinned(thread.id, pinned);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, pinnedAt } });
}

/** 处理 `clientDb.cleanup.status`：返回当前空间与权威清理任务状态。 */
export async function handleClientDbCleanupStatus(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (!requireClientDbCleanupClient(ctx, req)) return;
  if (!ctx.dbCleanup) {
    sendThreadError(ctx, req, 503, "db_cleanup_unavailable", "Client 数据库清理服务不可用");
    return;
  }
  try {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: { ok: true, storage: await ctx.dbCleanup.getStorageSummaryAsync() },
    });
  } catch (cause) {
    sendThreadError(ctx, req, 500, "db_cleanup_status_failed", threadErrorMessage(cause, "读取数据库清理状态失败"));
  }
}

/** 处理 `clientDb.cleanup.start`：校验截止时间并立即返回 queued 任务。 */
export async function handleClientDbCleanupStart(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (!requireClientDbCleanupClient(ctx, req)) return;
  if (!ctx.dbCleanup) {
    sendThreadError(ctx, req, 503, "db_cleanup_unavailable", "Client 数据库清理服务不可用");
    return;
  }
  const inactiveBefore = (req.body as any)?.inactiveBefore;
  if (typeof inactiveBefore !== "number" || !Number.isSafeInteger(inactiveBefore) || inactiveBefore <= 0 || inactiveBefore >= Date.now()) {
    sendThreadError(ctx, req, 400, "db_cleanup_invalid_cutoff", "参数错误：inactiveBefore 必须是早于当前时间的正整数时间戳");
    return;
  }
  try {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 202,
      body: { ok: true, storage: await ctx.dbCleanup.startAsync({ inactiveBefore, requestId: req.id }) },
    });
  } catch (cause) {
    const status = Number((cause as { status?: unknown } | null)?.status);
    const code = String((cause as { code?: unknown } | null)?.code ?? "").trim();
    if ((status === 409 || status === 503) && code) {
      sendThreadError(ctx, req, status, code, threadErrorMessage(cause, "启动数据库清理失败"));
      return;
    }
    sendThreadError(ctx, req, 500, "db_cleanup_start_failed", threadErrorMessage(cause, "启动数据库清理失败"));
  }
}

/** 校验数据库清理请求精确指向当前 Client。 */
function requireClientDbCleanupClient(ctx: ApiHandlerContext, req: ApiRequestMessage): boolean {
  const requestedClientId = String((req.body as any)?.clientId ?? "").trim();
  if (!requestedClientId) {
    sendThreadError(ctx, req, 400, "db_cleanup_invalid_request", "参数错误：clientId");
    return false;
  }
  if (requestedClientId !== ctx.clientId) {
    sendThreadError(ctx, req, 403, "db_cleanup_client_mismatch", "无权清理其他 Client 的数据库", {
      clientId: requestedClientId,
    });
    return false;
  }
  return true;
}

/** 确认持久删除后立即响应，历史物理清理由现有后台尾链跟踪。 */
export async function handleThreadsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim();
  const requestedThreadId = String((req.body as any)?.threadId ?? "").trim();
  if (!requestedWorkspaceId || !requestedThreadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  try {
    const existing = await withThreadDatabase(ctx, req.id, () => ctx.db.threads.getDeletion(requestedThreadId as ThreadId));
    if (existing) {
      if (existing.workspaceId !== requestedWorkspaceId) throw new Error("THREAD_DELETION_WORKSPACE_MISMATCH");
      if (existing.status === "failed") {
        sendThreadError(ctx, req, 500, "thread_delete_cleanup_failed", existing.error ?? "删除历史清理失败", {
          threadId: existing.threadId, deletionRequestId: existing.requestId, phase: existing.phase,
        });
        return;
      }
      ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, cleanupStatus: existing.status } });
      return;
    }
    const thread = await withThreadDatabase(ctx, req.id, () => requireWorkspaceThread(ctx, req));
    if (!thread) return;
    const startedAt = Date.now();
    const releaseDeletion = ctx.sessions.beginThreadDeletion([thread.id]);
    let transferred = false;
    try {
      await withThreadDatabase(ctx, req.id, () => ctx.db.withWorkspaceCoreRepos(thread.workspaceId, () => assertThreadDeletable(ctx, thread)));
      if (!ctx.trackApiTail || !ctx.flushLocalEvents) throw new Error("THREAD_DELETION_RUNTIME_NOT_READY");
      const flushBeforeStartedAt = Date.now();
      await ctx.flushLocalEvents(thread.workspaceId, thread.id);
      const flushBeforeMs = Date.now() - flushBeforeStartedAt;
      const disposeStartedAt = Date.now();
      await ctx.orchEngine.disposeManagedServicesForThread(thread.id, "thread-deleted");
      await ctx.sessions.disposeThreadWithOptions(thread.id, { flushActiveTurn: false });
      const disposeMs = Date.now() - disposeStartedAt;
      const flushAfterStartedAt = Date.now();
      await ctx.flushLocalEvents(thread.workspaceId, thread.id);
      const flushAfterMs = Date.now() - flushAfterStartedAt;
      const markStartedAt = Date.now();
      const task = await withThreadDatabase(ctx, req.id, () => ctx.db.db.transaction(() => {
        assertThreadDeletable(ctx, thread);
        ctx.assertWorkspacePersistenceAvailable?.(thread.workspaceId);
        const task = ctx.db.threads.markDeleted(thread.id, req.id);
        ctx.db.conversationEvents.invalidateDeletedThread(thread.id);
        return task;
      })());
      ctx.threads.delete(thread.id);
      logger.info("thread-handler", "thread deletion confirmed", { code: "THREAD_DELETE_CONFIRMED",
        requestId: req.id, workspaceId: thread.workspaceId, threadId: thread.id,
        phase: "confirmed", durationMs: Date.now() - startedAt, flushBeforeMs, disposeMs, flushAfterMs,
        markDeletedMs: Date.now() - markStartedAt, cleanupStatus: task.status });
      trackThreadDeletion(ctx, task, releaseDeletion);
      transferred = true;
      ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, cleanupStatus: "queued" } });
    } finally {
      if (!transferred) releaseDeletion();
    }
  } catch (cause) {
    logger.error("thread-handler", "thread deletion request failed", { code: "THREAD_DELETE_FAILED",
      requestId: req.id, workspaceId: requestedWorkspaceId, threadId: requestedThreadId,
      phase: "confirm", rootCause: threadErrorMessage(cause, "删除会话失败") });
    ctx.onApiFailureLogged?.();
    const conflict = resolveThreadDeletionConflict(cause);
    if (conflict) {
      sendThreadError(ctx, req, 409, conflict.code, conflict.message, { threadId: conflict.threadId });
      return;
    }
    sendThreadError(ctx, req, 500, "thread_delete_failed", threadErrorMessage(cause, "删除会话失败"), {
      threadId: requestedThreadId,
    });
  }
}

type PersistedThreadForDeletion = NonNullable<ReturnType<ApiHandlerContext["db"]["threads"]["get"]>>;

/** 先登记既有任务 owner，再开始清理；首轮让出事件循环保证响应先发出。 */
function trackThreadDeletion(ctx: ApiHandlerContext, task: ThreadDeletionTask, releaseDeletion: () => void): void {
  if (!ctx.trackApiTail) throw new Error("THREAD_DELETION_TRACKER_REQUIRED");
  const releaseActivity = ctx.workspaceOperationGate?.beginActivity(task.workspaceId, { type: "thread-deletion", resourceId: task.threadId });
  let releaseWrite: WorkspaceWriteLease | undefined;
  try { releaseWrite = ctx.workspaceOperationGate?.beginWrite(task.workspaceId); }
  catch (cause) { releaseActivity?.(); throw cause; }
  const cleanupContext: ApiHandlerContext = releaseWrite ? { ...ctx,
    withDatabase: (requestId, operation) => withThreadDatabase(ctx, requestId, () => releaseWrite!.run(operation)),
  } : ctx;
  let start!: () => void;
  const work = new Promise<void>(resolve => { start = resolve; }).then(async () => {
    try {
      await yieldThreadDeletionEventLoop();
      await purgeDeletedThread(cleanupContext, task);
    } finally {
      try { releaseDeletion(); }
      finally { try { releaseWrite?.(); } finally { releaseActivity?.(); } }
    }
  });
  try {
    ctx.trackApiTail(work, { requestId: task.requestId, method: "threads.delete",
      workspaceId: task.workspaceId, threadId: task.threadId });
  } catch (cause) {
    try { releaseWrite?.(); } finally { releaseActivity?.(); }
    throw cause;
  }
  start();
}

/** 启动恢复只调度已确认且未失败的任务，不等待大历史清理才开放请求。 */
export async function resumeThreadDeletions(ctx: ApiHandlerContext): Promise<void> {
  const tasks = await withThreadDatabase(ctx, "thread-delete:recovery", () => ctx.db.threads.listQueuedDeletions());
  for (const task of tasks) {
    const release = ctx.sessions.beginThreadDeletion([task.threadId]);
    try { trackThreadDeletion(ctx, task, release); }
    catch (cause) { release(); throw cause; }
  }
}

/** 已隐藏会话沿原分批删除链路清理；失败保留阶段并交回跟踪任务 owner。 */
async function purgeDeletedThread(ctx: ApiHandlerContext, task: ThreadDeletionTask): Promise<void> {
  let phase: ThreadDeletionTask["phase"] = "conversation_events";
  const startedAt = Date.now();
  const scope = { requestId: task.requestId, workspaceId: task.workspaceId, threadId: task.threadId };
  try {
    const thread = await withThreadDatabase(ctx, task.requestId, () => ctx.db.threads.get(task.threadId, { includeDeleted: true }));
    if (!thread || thread.workspaceId !== task.workspaceId) throw new Error("THREAD_DELETION_TARGET_MISSING");
    const stats = await deleteThreadEventsInBatches(ctx, task, next => { phase = next; });
    phase = "finalize";
    const finalizeStartedAt = Date.now();
    await withThreadDatabase(ctx, task.requestId, () => ctx.db.db.transaction((): void => {
      ctx.db.threads.setDeletionState(thread.id, { status: "queued", phase, error: null });
      assertThreadDeletable(ctx, thread, true);
      const blobReferences = ctx.db.blobs.collectReferencedByThreadIds([thread.id]);
      deleteThreadAuxiliaryRecords(ctx, [thread]);
      ctx.db.threads.detachCleanupBusinessReferences([thread.id]);
      if (thread.threadSubtype === "requirement-analysis") {
        ctx.db.orchRequirementAnalysisSessions.deleteByThreadId(thread.id);
      }
      if (!ctx.db.threads.delete(thread.id)) {
        throw new Error(`会话删除未生效：threadId=${thread.id}`);
      }
      ctx.db.blobs.tryDeleteIfUnreferencedMany(blobReferences.map((blob) => blob.blobId));
      ctx.db.threads.setDeletionState(thread.id, { status: "completed", phase, error: null });
    })());
    logger.info("thread-handler", "thread deletion cleanup completed", { code: "THREAD_DELETE_COMPLETED", ...scope,
      phase, durationMs: Date.now() - startedAt, finalizeDurationMs: Date.now() - finalizeStartedAt,
      queuedMs: startedAt - task.createdAt, ...stats });
  } catch (cause) {
    const rootCause = threadErrorMessage(cause, "删除历史清理失败");
    let failure = cause;
    try { await withThreadDatabase(ctx, task.requestId, () => ctx.db.threads.setDeletionState(task.threadId,
      { status: "failed", phase, error: rootCause })); }
    catch (recordError) { failure = new AggregateError([cause, recordError], "THREAD_DELETION_FAILURE_RECORD_FAILED", { cause }); }
    logger.error("thread-handler", "thread deletion cleanup failed", { code: "THREAD_DELETE_CLEANUP_FAILED", ...scope,
      phase, durationMs: Date.now() - startedAt, rootCause, failure: threadErrorMessage(failure, rootCause) });
    throw failure;
  }
}

/** 冻结并分批删除两张高体量事件表；残留事件会阻止后续 thread 删除。 */
async function deleteThreadEventsInBatches(ctx: Pick<ApiHandlerContext, "db" | "withDatabase">, task: ThreadDeletionTask,
  onPhase: (phase: "conversation_events" | "raw_engine_events") => void): Promise<{ deletedRows: number; batchCount: number }> {
  const { requestId, threadId, workspaceId } = task;
  const [conversationHighWaterSeq, rawHighWaterSeq] = await withThreadDatabase(ctx, requestId, () => [
    ctx.db.conversationEvents.getLatestSeqByThread(threadId), ctx.db.rawEvents.getLatestSeqByThread(threadId),
  ] as const);
  let deletedRows = 0, batchCount = 0;
  for (const [phase, highWaterSeq] of [["conversation_events", conversationHighWaterSeq], ["raw_engine_events", rawHighWaterSeq]] as const) {
    onPhase(phase);
    const startedAt = Date.now();
    await withThreadDatabase(ctx, requestId, () => ctx.db.threads.setDeletionState(threadId, { status: "queued", phase, error: null }));
    logger.info("thread-handler", "thread deletion event phase started", { code: "THREAD_DELETE_PHASE_STARTED",
      requestId, threadId, workspaceId, phase, highWaterSeq });
    const result = await deleteEventTableInBatches(highWaterSeq, (throughSeq, limit) =>
      withThreadDatabase(ctx, requestId, () => ctx.db.withWorkspaceCoreRepos(workspaceId, () =>
        (phase === "conversation_events" ? ctx.db.conversationEvents : ctx.db.rawEvents).deleteByThreadThroughSeq(threadId, throughSeq, limit))));
    deletedRows += result.deletedRows; batchCount += result.batchCount;
    logger.info("thread-handler", "thread deletion event phase completed", { code: "THREAD_DELETE_PHASE_COMPLETED",
      requestId, threadId, workspaceId, phase, durationMs: Date.now() - startedAt, ...result });
  }

  const [remainingConversationSeq, remainingRawSeq] = await withThreadDatabase(ctx, requestId, () => [
    ctx.db.conversationEvents.getLatestSeqByThread(threadId), ctx.db.rawEvents.getLatestSeqByThread(threadId),
  ] as const);
  if (remainingConversationSeq > 0 || remainingRawSeq > 0) {
    throw new Error(
      `会话事件清理未完成：threadId=${threadId}, conversationSeq=${remainingConversationSeq}, rawSeq=${remainingRawSeq}`,
    );
  }
  return { deletedRows, batchCount };
}

/** 复用事件仓储的限量删除接口，并在每个有效批次后让出事件循环。 */
async function deleteEventTableInBatches(
  highWaterSeq: number,
  deleteBatch: (throughSeq: number, limit: number) => Promise<number>,
): Promise<{ deletedRows: number; batchCount: number }> {
  const result = { deletedRows: 0, batchCount: 0 };
  if (highWaterSeq <= 0) return result;
  while (true) {
    const deleted = await deleteBatch(highWaterSeq, THREAD_EVENT_DELETE_BATCH_SIZE);
    result.batchCount++;
    result.deletedRows += deleted;
    if (deleted <= 0) return result;
    await yieldThreadDeletionEventLoop();
    if (deleted < THREAD_EVENT_DELETE_BATCH_SIZE) return result;
  }
}

/** 在同步 SQLite 删除批次之间恢复 Node 事件循环调度。 */
async function yieldThreadDeletionEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 删除无外键约束的会话提醒、忽略项和外部通知历史，避免留下孤儿记录。 */
function deleteThreadAuxiliaryRecords(
  ctx: Pick<ApiHandlerContext, "db">,
  threads: ReadonlyArray<PersistedThreadForDeletion>,
): void {
  const threadIdsByWorkspace = new Map<string, ThreadId[]>();
  for (const thread of threads) {
    const workspaceId = String(thread.workspaceId);
    const ids = threadIdsByWorkspace.get(workspaceId) ?? [];
    ids.push(thread.id);
    threadIdsByWorkspace.set(workspaceId, ids);
  }

  for (const [workspaceId, threadIds] of threadIdsByWorkspace) {
    const idsJson = JSON.stringify(threadIds.map(String));
    const reminderIdsJson = JSON.stringify(threadIds.flatMap((threadId) => [
      `thread:${threadId}:approval`,
      `thread:${threadId}:user-input`,
      `thread:${threadId}:error`,
      `thread:${threadId}:interrupted`,
    ]));
    ctx.db.db.prepare(
      [
        "DELETE FROM reminder_receipts",
        "WHERE entity_type = 'thread' AND workspace_id = ?",
        "  AND entity_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
      ].join("\n"),
    ).run(workspaceId, idsJson);
    ctx.db.db.prepare(
      [
        "DELETE FROM reminder_ignores",
        "WHERE workspace_id = ?",
        "  AND reminder_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
      ].join("\n"),
    ).run(workspaceId, reminderIdsJson);
    for (const tableName of ["dingtalk_reminder_notifications", "wecom_reminder_notifications"] as const) {
      ctx.db.db.prepare(
        [
          `DELETE FROM ${tableName}`,
          "WHERE source_type = 'chat' AND workspace_id = ?",
          "  AND target_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
        ].join("\n"),
      ).run(workspaceId, idsJson);
    }
    // 工作流表未声明 thread 外键；删除会话时显式清理，避免工作流事实脱离会话继续占用资源。
    ctx.db.db.prepare(
      "DELETE FROM chat_workflow_actions WHERE task_id IN (SELECT id FROM chat_workflow_tasks WHERE thread_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)))",
    ).run(idsJson);
    ctx.db.db.prepare(
      "DELETE FROM chat_workflow_tasks WHERE thread_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
    ).run(idsJson);
    ctx.db.db.prepare(
      "DELETE FROM chat_workflow_settings WHERE thread_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
    ).run(idsJson);
  }
}

/** 重读目标元数据，并统一校验单会话运行态与业务活跃态。 */
function assertThreadDeletable(ctx: ApiHandlerContext, expected: PersistedThreadForDeletion, includeDeleted = false): void {
  const current = ctx.db.threads.get(expected.id, { includeDeleted });
  const unchanged = current
    && String(current.workspaceId) === String(expected.workspaceId)
    && String(current.sharedWorkspaceId ?? "") === String(expected.sharedWorkspaceId ?? "")
    && current.threadSubtype === expected.threadSubtype;
  if (!unchanged) {
    throw Object.assign(new Error(`会话状态已变化，已取消删除：${expected.id}`), {
      code: "thread_delete_state_changed",
      threadId: expected.id,
    });
  }
  const running = resolveThreadRunningState(ctx, { workspaceId: expected.workspaceId, threadId: expected.id });
  const blockedReason: ThreadDeletionBlockedReason | null = running
    ? "running_turn"
    : ctx.db.threads.getCleanupBusinessBlockedReasons([expected.id]).get(String(expected.id)) ?? null;
  if (blockedReason) throw threadDeletionBlockedError(expected.id, blockedReason);
}

/** 构造带稳定阻断原因的删除冲突。 */
function threadDeletionBlockedError(threadId: ThreadId, blockedReason: ThreadDeletionBlockedReason): Error {
  const details = blockedReason === "running_turn"
    ? { code: "thread_cleanup_thread_running", message: `运行中的会话不能清理：${threadId}` }
    : blockedReason === "active_orchestration"
      ? { code: "thread_cleanup_active_orchestration", message: "当前会话有运行中的工作流，请先终止会话工作流后再删除。" }
      : { code: "thread_cleanup_active_asset_job", message: `活跃资产任务使用中的会话不能清理：${threadId}` };
  return Object.assign(new Error(details.message), {
    code: details.code,
    threadId,
    blockedReason,
  });
}

/** 仅接受三种会话删除阻断原因。 */
function normalizeThreadDeletionBlockedReason(raw: unknown): ThreadDeletionBlockedReason | null {
  return raw === "running_turn" || raw === "active_orchestration" || raw === "active_asset_job"
    ? raw
    : null;
}

/** 把删除互斥、运行态或资格变化转换为稳定的 409 响应。 */
function resolveThreadDeletionConflict(cause: unknown): {
  code: string;
  message: string;
  threadId: string | null;
  blockedReason: ThreadDeletionBlockedReason | null;
} | null {
  const code = String((cause as any)?.code ?? "").trim();
  if (
    code !== THREAD_DELETION_IN_PROGRESS_CODE
    && code !== "thread_operation_in_progress"
    && code !== "thread_cleanup_thread_running"
    && code !== "thread_cleanup_active_orchestration"
    && code !== "thread_cleanup_active_asset_job"
    && code !== "thread_delete_state_changed"
  ) return null;
  return {
    code,
    message: threadErrorMessage(cause, "会话当前不能删除"),
    threadId: String((cause as any)?.threadId ?? "").trim() || null,
    blockedReason: normalizeThreadDeletionBlockedReason((cause as any)?.blockedReason),
  };
}

/** 原线程校验后显式冲刷并复核W准入，失败时终止删除请求。 */
async function flushThreadPersistence(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<boolean> {
  try {
    const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
    await ctx.flushEventPersistence?.();
    await ctx.flushLocalEvents?.(workspaceId, String((req.body as any)?.threadId ?? "").trim() as ThreadId);
    await withThreadDatabase(ctx, req.id, () => ctx.assertWorkspacePersistenceAvailable?.(workspaceId));
    return true;
  } catch (cause) {
    sendThreadError(ctx, req, 500, "thread_persistence_flush_failed", threadErrorMessage(cause, "会话持久化缓冲落盘失败"));
    return false;
  }
}

/** 返回会话或数据库清理 API 的明确失败态，并附带 requestId。 */
function sendThreadError(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  ctx.send({
    t: "api.res",
    id: req.id,
    status,
    body: { ok: false, code, message, details: { requestId: req.id, ...(details ?? {}) } },
  });
}

/** 生成稳定错误文本并保留底层失败原因。 */
function threadErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause ?? "").trim();
  return text || fallback;
}

/** 处理 `threads.clear`：清空 thread 历史与文件变更，可选重置 sessionId。 */
export async function handleThreadsClear(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const resetSession = (req.body as any)?.resetSession !== false;
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim();
  const requestedThreadId = String((req.body as any)?.threadId ?? "").trim();
  if (!requestedWorkspaceId || !requestedThreadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  const thread = await withThreadDatabase(ctx, req.id, () => requireWorkspaceThread(ctx, req));
  if (!thread) return;
  const releaseDeletion = ctx.sessions.beginThreadDeletion([thread.id]);
  try {
  if (!await flushThreadPersistence(ctx, req)) return;
  if (resetSession) {
    await ctx.orchEngine.disposeManagedServicesForThread(thread.id, "thread-cleared");
    await ctx.sessions.disposeThreadWithOptions(thread.id, { flushActiveTurn: false });
    if (!await flushThreadPersistence(ctx, req)) return;
  }
  const { deletedConversationEvents, deletedRawEvents, deletedFileChanges } = await withThreadDatabase(ctx, req.id, () => ctx.db.db.transaction(() => {
    const deletedConversationEvents = ctx.db.conversationEvents.deleteByThread(thread.id);
    const deletedRawEvents = ctx.db.rawEvents.deleteByThread(thread.id);
    const deletedFileChanges = ctx.db.fileChanges.deleteByThread(thread.id);
    if (resetSession) ctx.db.threads.clearSessionId(thread.id);
    return { deletedConversationEvents, deletedRawEvents, deletedFileChanges };
  })());
  if (resetSession) ctx.threads.clearSessionId(thread.id);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      deletedEvents: deletedConversationEvents + deletedRawEvents,
      deletedFileChanges,
    },
  });
  } finally { releaseDeletion(); }
}

/** 查询同引擎最近会话偏好；桌面 Host 限定为本地会话。 */
export function handleThreadsLatestPrefs(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const engine = String((req.body as any)?.engine ?? "").trim() as EngineType;
  if (!requestedWorkspaceId || (engine !== "claude" && engine !== "codex")) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/engine" } });
    return;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return;
  }

  const prefs = ctx.db.threads.getLatestPrefsByEngine(workspaceId, engine, { localOnly: ctx.localWorkspaceOnly });
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, prefs } });
}

function normalizeThreadType(raw: unknown): ThreadType {
  return raw === "orchestration" ? "orchestration" : "chat";
}

/** 按可信入口装配归属和资产，并保留通知投递结果。 */
function createRequirementAnalysisService(ctx: ApiHandlerContext): RequirementAnalysisService {
  return new RequirementAnalysisService({
    db: ctx.db,
    intakeWorkspaceScope: ctx.intakeWorkspaceScope,
    orchAssetRuntimeRead: ctx.orchAssetRuntimeRead,
    threads: ctx.threads,
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    timeoutPolicy: ctx.timeoutPolicy,
    emitConversation: (event) => {
      if (ctx.onBeforeEmitConversationEvent) ctx.onBeforeEmitConversationEvent(event);
      return ctx.send({ t: "conversation.event", event });
    },
    emitRaw: (event) => {
      ctx.send({ t: "raw.event", event });
    },
  });
}

function requireWorkspaceThread(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
): NonNullable<ReturnType<ApiHandlerContext["db"]["threads"]["get"]>> | null {
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const workspaceId = resolveExistingWorkspaceId(ctx, requestedWorkspaceId);
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  if (!requestedWorkspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return null;
  }
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${requestedWorkspaceId}` } });
    return null;
  }
  const thread = ctx.db.threads.get(threadId);
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return null;
  }
  if (!workspaceIdsReferToSameWorkspace(thread.workspaceId, workspaceId)) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        message: "workspace 不匹配",
        details: threadWorkspaceMismatchDetails(thread.workspaceId, workspaceId),
      },
    });
    return null;
  }
  return thread;
}

/** 返回 workspace 冲突详情，供 Web 深链自动切到 thread 所属工作区。 */
function threadWorkspaceMismatchDetails(
  threadWorkspaceId: WorkspaceId,
  requestedWorkspaceId: WorkspaceId,
): { threadWorkspaceId: WorkspaceId; requestedWorkspaceId: WorkspaceId } {
  return { threadWorkspaceId, requestedWorkspaceId };
}

/** 归一化草稿附件与显式输入合同，空 binding 字段不会进入持久化。 */
function normalizeThreadDraftPayload(raw: unknown): {
  text: string;
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
  images: ThreadDraftImageAttachment[];
  files: TextFileAttachment[];
  pathReferences: WorkspacePathReference[];
} | null {
  if (!raw || typeof raw !== "object") return null;
  const draft = raw as Record<string, unknown>;
  const text = String(draft.text ?? "");
  const inputContract = normalizeThreadInputContract(draft, text);
  const imagesRaw = Array.isArray(draft.images) ? draft.images : [];
  const filesRaw = Array.isArray(draft.files) ? draft.files : [];
  const pathReferencesRaw = Array.isArray(draft.pathReferences) ? draft.pathReferences : [];

  const images: ThreadDraftImageAttachment[] = [];
  for (let i = 0; i < imagesRaw.length; i += 1) {
    const item = imagesRaw[i];
    if (!item || typeof item !== "object") return null;
    const image = item as Record<string, unknown>;
    const id = String(image.id ?? "").trim() || `img_${i}`;
    const name = String(image.name ?? "").trim() || "image";
    const dataUrl = String(image.dataUrl ?? "");
    if (!dataUrl) return null;
    const size = Number(image.size);
    images.push({
      id,
      name,
      dataUrl,
      size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : Buffer.byteLength(dataUrl, "utf8"),
    });
  }

  const files: TextFileAttachment[] = [];
  for (let i = 0; i < filesRaw.length; i += 1) {
    const item = filesRaw[i];
    if (!item || typeof item !== "object") return null;
    const file = item as Record<string, unknown>;
    const id = String(file.id ?? "").trim() || `file_${i}`;
    const name = String(file.name ?? "").trim() || "file";
    const textContent = String(file.text ?? "");
    if (!textContent) return null;
    const size = Number(file.size);
    files.push({
      id,
      name,
      displayName: nullableString(file.displayName),
      mime: String(file.mime ?? "").trim(),
      size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : Buffer.byteLength(textContent, "utf8"),
      text: textContent,
    });
  }

  const pathReferences = normalizeWorkspacePathReferenceList(pathReferencesRaw).map((ref) => createWorkspacePathReference(ref));

  return {
    text,
    ...(inputContract.inputKind ? { inputKind: inputContract.inputKind } : {}),
    ...(inputContract.skillMentions ? { skillMentions: inputContract.skillMentions } : {}),
    images,
    files,
    pathReferences,
  };
}

/** 读取草稿并在 API 拥有边界记录不可恢复的持久化合同错误。 */
function readThreadDraftForRequest(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  thread: NonNullable<ReturnType<ApiHandlerContext["db"]["threads"]["get"]>>,
) {
  try {
    return ctx.db.threadDrafts.get(thread.id);
  } catch (error) {
    const rootCause = error instanceof Error ? error.message : String(error);
    logger.error("api", "thread draft hydrate failed", {
      code: error instanceof ThreadInputContractError ? error.code : "THREAD_DRAFT_HYDRATE_FAILED",
      requestId: req.id,
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      rootCause,
    });
    ctx.onApiFailureLogged?.();
    throw error;
  }
}

function normalizeThreadSubtype(raw: unknown, threadType: ThreadType): ThreadSubtype | null {
  if (threadType === "orchestration") {
    return raw === "master" || raw === "node" || raw === "asset-draft" || raw === "gate-evaluation" ? raw : null;
  }
  return raw === "requirement-analysis" || raw === "node-discussion" ? raw : null;
}

/** 规整新会话偏好，保留省略的 Fast 档位以应用模型默认值。 */
function normalizeInitialThreadPrefs(threadSubtype: ThreadSubtype | null, raw: unknown): ThreadPrefs | null {
  if (!raw || typeof raw !== "object") return null;
  const prefs = raw as Record<string, unknown>;
  const model = String(prefs.model ?? "").trim() || null;
  const effort = String(prefs.effort ?? "").trim() || null;
  const accessMode = String(prefs.accessMode ?? "").trim();
  const normalized: ThreadPrefs = {
    model,
    effort,
    accessMode: accessMode === "read-only" || accessMode === "current" || accessMode === "full-access"
      ? accessMode
      : null,
    planMode: prefs.planMode != null ? Boolean(prefs.planMode) : null,
    knowledgeEnabled: threadSubtype == null && prefs.knowledgeEnabled === true,
    autoCompactPct: normalizeAutoCompactPct(prefs.autoCompactPct),
    contextWindow: normalizeContextWindow(prefs.contextWindow),
    serviceTier: prefs.serviceTier === undefined ? undefined : prefs.serviceTier === "fast" ? "fast" : null,
    roleId: threadSubtype == null ? normalizeRoleId(prefs.roleId) : null,
  };
  if (threadSubtype === "node-discussion" || threadSubtype === "knowledge-assets") {
    normalized.accessMode = "read-only";
    normalized.planMode = false;
  }
  return normalized;
}

type ThreadPrefsPatchInput = {
  model?: unknown;
  effort?: unknown;
  accessMode?: unknown;
  planMode?: unknown;
  autoCompactPct?: unknown;
  contextWindow?: unknown;
  serviceTier?: unknown;
  roleId?: unknown;
  knowledgeEnabled?: unknown;
};

/** 在 HTTP 边界拒绝非法偏好类型和枚举，避免错误值被静默解释为清空。 */
function assertThreadPrefsPatchInput(prefs: ThreadPrefsPatchInput): void {
  const has = (key: keyof ThreadPrefsPatchInput): boolean =>
    Object.prototype.hasOwnProperty.call(prefs, key) && prefs[key] !== undefined;
  const invalid = (field: keyof ThreadPrefsPatchInput, expected: string): never => {
    throw new Error(`参数错误：prefs.${field} 必须是 ${expected} 或 null`);
  };

  if (has("model") && prefs.model !== null && typeof prefs.model !== "string") invalid("model", "字符串");
  if (has("effort") && prefs.effort !== null && typeof prefs.effort !== "string") invalid("effort", "字符串");
  if (has("accessMode")) {
    const value = prefs.accessMode;
    if (value !== null && typeof value !== "string") invalid("accessMode", "read-only/current/full-access");
    if (typeof value === "string" && value && value !== "read-only" && value !== "current" && value !== "full-access") {
      invalid("accessMode", "read-only/current/full-access");
    }
  }
  if (has("planMode") && prefs.planMode !== null && typeof prefs.planMode !== "boolean") invalid("planMode", "布尔值");
  if (has("knowledgeEnabled") && prefs.knowledgeEnabled !== null && typeof prefs.knowledgeEnabled !== "boolean") invalid("knowledgeEnabled", "布尔值");
  if (has("autoCompactPct")) {
    const value = prefs.autoCompactPct;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 50 || value > 99)) {
      invalid("autoCompactPct", "50-99 的数字");
    }
  }
  if (has("contextWindow")) {
    const value = prefs.contextWindow;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      invalid("contextWindow", "正数");
    }
  }
  if (has("serviceTier")) {
    const value = prefs.serviceTier;
    if (value !== null && value !== "" && value !== "fast") invalid("serviceTier", "fast");
  }
  if (has("roleId") && prefs.roleId !== null && typeof prefs.roleId !== "string") invalid("roleId", "字符串");
}

function normalizeLockedThreadPrefs(
  thread: { threadSubtype: ThreadSubtype | null },
  prefs: ThreadPrefsPatchInput,
): ThreadPrefs {
  const has = (key: keyof ThreadPrefs): boolean =>
    Object.prototype.hasOwnProperty.call(prefs, key) && prefs[key] !== undefined;
  const normalized: ThreadPrefs = {};
  if (has("model")) {
    normalized.model = typeof prefs.model === "string" ? String(prefs.model).trim() || null : null;
  }
  if (has("effort")) {
    normalized.effort = typeof prefs.effort === "string" ? String(prefs.effort).trim() || null : null;
  }
  if (has("accessMode")) {
    const rawAccessMode = String(prefs.accessMode ?? "").trim();
    normalized.accessMode = rawAccessMode === "read-only" || rawAccessMode === "current" || rawAccessMode === "full-access"
      ? rawAccessMode
      : null;
  }
  if (has("planMode")) normalized.planMode = prefs.planMode != null ? Boolean(prefs.planMode) : null;
  if (has("knowledgeEnabled")) normalized.knowledgeEnabled = prefs.knowledgeEnabled != null ? Boolean(prefs.knowledgeEnabled) : null;
  if (has("autoCompactPct")) normalized.autoCompactPct = normalizeAutoCompactPct(prefs.autoCompactPct);
  if (has("contextWindow")) normalized.contextWindow = normalizeContextWindow(prefs.contextWindow);
  if (has("serviceTier")) normalized.serviceTier = prefs.serviceTier === "fast" ? "fast" : null;
  if (thread.threadSubtype == null && has("roleId")) normalized.roleId = normalizeRoleId(prefs.roleId);
  if (thread.threadSubtype === "node-discussion" || thread.threadSubtype === "knowledge-conversation" || thread.threadSubtype === "knowledge-assets") {
    normalized.accessMode = "read-only";
    normalized.planMode = false;
    normalized.knowledgeEnabled = false;
  }
  return normalized;
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** 读取非空共享工作区 ID；空值表示本地工作区上下文。 */
function normalizeSharedWorkspaceId(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** 将分组仓储错误转换为明确 API 状态，避免客户端误判成功。 */
function sendThreadGroupError(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const status = errorMessage.includes("无权限")
    ? 403
    : errorMessage.includes("不存在")
      ? 404
      : errorMessage.includes("已存在")
        ? 409
        : 400;
  ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, message: errorMessage } });
}

/** 将创建会话仓储错误转换为明确 API 状态，避免无效分组被误报为成功。 */
function sendThreadCreateError(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const status = errorMessage.includes("不存在")
    ? 404
    : errorMessage.includes("已存在") || isThreadIdConstraintError(error)
      ? 409
      : 400;
  logger.warn("thread-create", "threads.create failed", {
    errorCode: status === 409 ? "THREAD_CREATE_CONFLICT" : "THREAD_CREATE_INVALID",
    requestId: req.id,
    threadId: String((req.body as any)?.threadId ?? "").trim(),
    workspaceId: String((req.body as any)?.workspaceId ?? "").trim(),
    sharedWorkspaceId: String((req.body as any)?.sharedThreadAcl?.sharedWorkspaceId ?? "").trim() || null,
    rootCause: errorMessage,
  });
  ctx.onApiFailureLogged?.();
  ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, message: errorMessage } });
}

/** 只识别 `threads.id` 唯一约束，避免把外键等完整性错误误报为创建冲突。 */
function isThreadIdConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bunique constraint failed:\s*(?:main\.)?threads\.id\b/i.test(message);
}

/** 在会话创建存储访问失败时记录完整上下文，并向调用方返回稳定的内部错误。 */
function sendThreadCreateStorageError(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  stage: "thread_lookup" | "constraint_recheck" | "requirement_analysis_initialize",
  error: unknown,
): void {
  const rootCause = error instanceof AggregateError
    ? error.errors.map((item) => item instanceof Error ? item.message : String(item)).join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
  logger.error("thread-create", "threads.create storage access failed", {
    errorCode: "THREAD_CREATE_STORAGE_ERROR",
    requestId: req.id,
    threadId: String((req.body as any)?.threadId ?? "").trim(),
    workspaceId: String((req.body as any)?.workspaceId ?? "").trim(),
    sharedWorkspaceId: String((req.body as any)?.sharedThreadAcl?.sharedWorkspaceId ?? "").trim() || null,
    stage,
    rootCause,
  });
  ctx.onApiFailureLogged?.();
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 500,
    body: { ok: false, code: "THREAD_CREATE_STORAGE_ERROR", message: "会话存储访问失败" },
  });
}

/** 归一化普通聊天角色 ID；非普通会话由调用方置空。 */
function normalizeRoleId(value: unknown): ThreadPrefs["roleId"] {
  const text = String(value ?? "").trim();
  return text ? (text as NonNullable<ThreadPrefs["roleId"]>) : null;
}

/** 处理 `threads.updatePrefs`：更新 thread 的会话级偏好。 */
export async function handleThreadsUpdatePrefs(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const prefs = (req.body as any)?.prefs;
  const requestedWorkspaceId = String((req.body as any)?.workspaceId ?? "").trim();
  const requestedThreadId = String((req.body as any)?.threadId ?? "").trim();
  if (!requestedWorkspaceId || !requestedThreadId || !prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/prefs" } });
    return;
  }
  const thread = await withThreadDatabase(ctx, req.id, () => requireWorkspaceThread(ctx, req));
  if (!thread) return;

  let normalizedPrefs: ThreadPrefs;
  try {
    assertThreadPrefsPatchInput(prefs);
    normalizedPrefs = normalizeLockedThreadPrefs(thread, prefs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("thread-prefs", "threads.updatePrefs rejected invalid prefs", {
      requestId: req.id,
      workspaceId: requestedWorkspaceId,
      threadId: requestedThreadId,
      error: message,
    });
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }
  try {
    const hasModelPatch = Object.prototype.hasOwnProperty.call(normalizedPrefs, "model");
    const modelForEffort = resolveRuntimeThreadPrefsWithCatalogDefaults(thread.engine, {
      model: hasModelPatch ? normalizedPrefs.model : thread.model,
    }).model;
    await withThreadDatabase(ctx, req.id, () => assertClientReasoningEffortSupported(
      ctx.db,
      thread.engine,
      modelForEffort,
      prefs.effort,
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("thread-prefs", "threads.updatePrefs rejected unsupported effort", {
      requestId: req.id,
      workspaceId: requestedWorkspaceId,
      threadId: requestedThreadId,
      error: message,
    });
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }
  // 先持久化用户意图，避免运行中切换失败导致 UI 与落库偏好分叉。
  await withThreadDatabase(ctx, req.id, () => ctx.db.threads.updatePrefs(thread.id, normalizedPrefs));
  // 仅响应用户显式修改的计划/执行模式；策略补全字段（如知识会话只读锁定）不得触发运行中切换。
  const explicitPlanMode = Object.prototype.hasOwnProperty.call(prefs, "planMode");
  const explicitAccessMode = Object.prototype.hasOwnProperty.call(prefs, "accessMode");
  let permissionModeWarning: string | undefined;
  if (explicitPlanMode || explicitAccessMode) {
    const session = ctx.sessions.getExisting(thread.id);
    const applyPermissionPrefs = session?.applyPermissionPrefs?.bind(session);
    if (applyPermissionPrefs && session?.hasActiveTurn()) {
      try {
        await applyPermissionPrefs({
          ...(explicitPlanMode ? { planMode: normalizedPrefs.planMode ?? false } : {}),
          ...(explicitAccessMode ? { accessMode: normalizedPrefs.accessMode ?? null } : {}),
        });
      } catch (error) {
        // 偏好已落库；当前轮无法切换时明确告知下一轮生效，不伪造已应用。
        const rootCause = error instanceof Error ? error.message : String(error);
        logger.error("thread-prefs", "thread permission mode switch failed", {
          code: "CLAUDE_PERMISSION_MODE_SWITCH_FAILED",
          requestId: req.id,
          workspaceId: requestedWorkspaceId,
          threadId: requestedThreadId,
          rootCause,
        });
        permissionModeWarning = `会话配置已保存；当前轮次权限模式未切换，将在下一轮生效：${rootCause}`;
      }
    }
  }
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: { ok: true, ...(permissionModeWarning ? { permissionModeWarning } : {}) },
  });
}

function normalizeAutoCompactPct(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 50 || value > 99) return null;
  return Math.round(value);
}

function normalizeContextWindow(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function emit(ctx: Pick<ApiHandlerContext, "send">, event: ConversationEventInput): void {
  ctx.send({ t: "conversation.event", event });
}

function resolveExistingWorkspaceId(
  ctx: Pick<ApiHandlerContext, "workspaces">,
  workspaceId: WorkspaceId | null | undefined,
): WorkspaceId | null {
  const resolvedWorkspaceId = resolveWorkspaceIdAlias(workspaceId, ctx.workspaces.keys());
  return resolvedWorkspaceId ? (resolvedWorkspaceId as WorkspaceId) : null;
}

