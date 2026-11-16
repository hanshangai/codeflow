import crypto from "node:crypto";
import {
  CHAT_WORKFLOW_ACTIVE_STATUS_LIST,
  mergeThreadPrefs,
  normalizeThreadListSort,
  resolveThreadPrefsWithCatalogDefaults,
  type AccessMode,
  type CodexServiceTier,
  type EngineModelInfo,
  type EngineType,
  type RoleId,
  type SessionId,
  type SharedThreadAclSyncItem,
  type SharedWorkspaceContextVisibility,
  type SharedWorkspaceId,
  type ThreadGroupId,
  type ThreadGroupSummary,
  type ThreadId,
  type ThreadListScope,
  type ThreadListSort,
  type ThreadPrefs,
  type ThreadSessionCapabilities,
  type ThreadSubtype,
  type ThreadSummary,
  type ThreadType,
  type WorkspaceId,
} from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

export const THREAD_DELETION_META_PREFIX = "thread_deletion:";
export type ThreadDeletionTask = {
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  sharedWorkspaceId: SharedWorkspaceId | null;
  requestId: string;
  status: "queued" | "failed" | "completed";
  phase: "queued" | "conversation_events" | "raw_engine_events" | "finalize";
  createdAt: number;
  error: string | null;
};

/** 校验标记身份和状态，错误不得退化为可见会话。 */
function decodeThreadDeletion(value: string, threadId: ThreadId): ThreadDeletionTask {
  const task = JSON.parse(value) as ThreadDeletionTask;
  if (!task || task.threadId !== threadId || !task.workspaceId || !task.requestId
    || !(task.sharedWorkspaceId === null || typeof task.sharedWorkspaceId === "string" && task.sharedWorkspaceId.length > 0)
    || !["queued", "failed", "completed"].includes(task.status)
    || !["queued", "conversation_events", "raw_engine_events", "finalize"].includes(task.phase)
    || !Number.isSafeInteger(task.createdAt) || task.createdAt <= 0
    || !(task.error === null || typeof task.error === "string")) {
    throw new Error(`THREAD_DELETION_TASK_INVALID: ${threadId}`);
  }
  return task;
}

export type PersistedThread = {
  id: ThreadId;
  workspaceId: WorkspaceId;
  engine: EngineType;
  title: string;
  threadType: ThreadType;
  threadSubtype: ThreadSubtype | null;
  sessionId: SessionId | null;
  sessionCapabilities: ThreadSessionCapabilities | null;
  archived: boolean;
  pinnedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** 会话级偏好：model */
  model: string | null;
  /** 会话级偏好：effort */
  effort: string | null;
  /** 会话级偏好：accessMode */
  accessMode: AccessMode | null;
  /** 会话级偏好：planMode */
  planMode: boolean | null;
  /** Whether a normal chat may read project knowledge. */
  knowledgeEnabled: boolean;
  /** 会话级偏好：autoCompactPct */
  autoCompactPct: number | null;
  /** 会话级偏好：contextWindow */
  contextWindow: number | null;
  /** 会话级偏好：Codex Fast mode 服务档位 */
  serviceTier: CodexServiceTier | null;
  /** 会话级偏好：普通聊天角色 */
  roleId: RoleId | null;
  /** 自建会话分组；为空表示未分组。 */
  groupId: ThreadGroupId | null;
  /** 共享工作区 ID；为空表示普通本地会话。 */
  sharedWorkspaceId: SharedWorkspaceId | null;
  /** 共享会话 owner，由服务端 envelope 派生后写入 Host。 */
  ownerUserId: string | null;
  /** 共享会话可见性。 */
  sharedVisibility: SharedWorkspaceContextVisibility | null;
  /** 共享会话参与人 userId 列表。 */
  sharedParticipantUserIds: string[];
  /** 共享 ACL 元数据更新时间。 */
  sharedAclUpdatedAt: number | null;
};

export type ThreadSharedAclInput = {
  sharedWorkspaceId: SharedWorkspaceId;
  ownerUserId: string;
  visibility?: SharedWorkspaceContextVisibility | null;
  participantUserIds?: string[] | null;
  updatedAt?: number | null;
};

export type ThreadSharedAclSyncBatchResult = {
  processed: number;
  updated: number;
  missing: number;
  stale: number;
};

export type ThreadSessionBindingClearResult =
  | { kind: "cleared" }
  | { kind: "already_cleared" }
  | { kind: "session_mismatch"; actualSessionId: SessionId }
  | { kind: "thread_missing" };

export type ThreadSessionCapabilitiesRestoreResult =
  | { kind: "restored" }
  | { kind: "session_mismatch"; actualSessionId: SessionId | null }
  | { kind: "thread_missing" };

/** 携带 ACL workspace 对账字段，供 Host 路由记录结构化诊断后原样失败。 */
export class SharedThreadAclWorkspaceMismatchError extends Error {
  readonly code = "shared_thread_acl_workspace_mismatch";

  constructor(readonly context: {
    mismatchScope: "local_workspace" | "shared_workspace";
    threadId: ThreadId;
    expectedWorkspaceId: WorkspaceId;
    actualWorkspaceId: WorkspaceId;
    expectedSharedWorkspaceId: SharedWorkspaceId;
    actualSharedWorkspaceId: SharedWorkspaceId | null;
    aclUpdatedAt: number;
  }) {
    super(
      context.mismatchScope === "local_workspace"
        ? `Shared thread ACL batch workspace mismatch: ${String(context.threadId)}`
        : `Shared thread ACL batch shared workspace mismatch: ${String(context.threadId)}`,
    );
    this.name = "SharedThreadAclWorkspaceMismatchError";
  }
}

export type ThreadCleanupBusinessBlockedReason = "active_orchestration" | "active_asset_job";

export type ThreadHistoryCleanupTarget = {
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  sharedWorkspaceId: SharedWorkspaceId | null;
  updatedAt: number;
  conversationHighWaterSeq: number;
  rawHighWaterSeq: number;
};

export type ThreadHistoryCleanupCursor = {
  updatedAt: number;
  threadId: ThreadId;
};

export type ThreadHistoryCleanupTargetPage = {
  items: ThreadHistoryCleanupTarget[];
  nextCursor: ThreadHistoryCleanupCursor | null;
  hasMore: boolean;
};

type CleanupOrchestrationCandidate = {
  id: string;
  master_thread_id: string | null;
  status: string;
  node_states_json: string;
};

/** thread 仓储：负责 thread 元数据的持久化。 */
export class ThreadRepo {
  private readonly createStmt;
  private readonly getStmt;
  private readonly setSessionIdStmt;
  private readonly setSessionBindingStmt;
  private readonly restoreSessionCapabilitiesIfMatchesStmt;
  private readonly restoreSessionCapabilitiesIfMatchesTx;
  private readonly clearSessionIdStmt;
  private readonly clearSessionIdPreserveUpdatedAtStmt;
  private readonly clearSessionBindingIfMatchesStmt;
  private readonly clearSessionBindingIfMatchesTx;
  private readonly historyCleanupTargetEligibleStmt;
  private readonly renameStmt;
  private readonly setArchivedStmt;
  private readonly setPinnedStmt;
  private readonly deleteStmt;
  private readonly touchStmt;
  private readonly setGroupStmt;
  private readonly setSharedAclStmt;
  private readonly createGroupStmt;
  private readonly renameGroupStmt;
  private readonly deleteGroupStmt;
  private readonly unassignGroupStmt;
  private readonly deleteGroupTx;
  private readonly touchManyTx;
  private readonly setSharedAclManyTx;

  constructor(
    private readonly db: SqliteDb,
    private readonly resolveEngineModels?: (engine: EngineType) => EngineModelInfo[] | null,
  ) {
    this.createStmt = this.db.prepare(
      "INSERT INTO threads (id, workspace_id, engine, title, thread_type, thread_subtype, session_id, session_capabilities_json, archived, pinned_at, group_id, created_at, updated_at, model, effort, access_mode, plan_mode, knowledge_enabled, auto_compact_pct, context_window, service_tier, role_id, owner_user_id, shared_workspace_id, shared_visibility, shared_participant_user_ids_json, shared_acl_updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.getStmt = this.db.prepare(
      `SELECT id, workspace_id, engine, title, thread_type, thread_subtype, session_id, session_capabilities_json, archived, pinned_at, group_id, created_at, updated_at, model, effort, access_mode, plan_mode, knowledge_enabled, auto_compact_pct, context_window, service_tier, role_id, owner_user_id, shared_workspace_id, shared_visibility, shared_participant_user_ids_json, shared_acl_updated_at FROM threads WHERE id = ?
       AND (? = 1 OR NOT EXISTS (SELECT 1 FROM meta WHERE key = '${THREAD_DELETION_META_PREFIX}' || threads.id))`,
    );
    this.setSessionIdStmt = this.db.prepare("UPDATE threads SET session_id = ?, updated_at = ? WHERE id = ?");
    this.setSessionBindingStmt = this.db.prepare("UPDATE threads SET session_id = ?, session_capabilities_json = ?, updated_at = ? WHERE id = ?");
    this.restoreSessionCapabilitiesIfMatchesStmt = this.db.prepare(
      "UPDATE threads SET session_capabilities_json = ?, updated_at = ? WHERE id = ? AND session_id = ?",
    );
    this.restoreSessionCapabilitiesIfMatchesTx = this.db.transaction(
      (
        threadId: ThreadId,
        expectedSessionId: SessionId,
        sessionCapabilities: ThreadSessionCapabilities,
        updatedAt: number,
      ): ThreadSessionCapabilitiesRestoreResult => {
        const result = this.restoreSessionCapabilitiesIfMatchesStmt.run(
          serializeThreadSessionCapabilities(sessionCapabilities),
          updatedAt,
          String(threadId),
          String(expectedSessionId),
        );
        const changes = Number(result.changes ?? 0);
        if (changes === 1) return { kind: "restored" };
        if (changes !== 0) {
          throw Object.assign(
            new Error(`Unexpected thread session capability restore count: threadId=${threadId}, changes=${changes}`),
            { code: "thread_session_capability_restore_count_invalid" },
          );
        }
        const current = this.get(threadId);
        if (!current) return { kind: "thread_missing" };
        return { kind: "session_mismatch", actualSessionId: current.sessionId };
      },
    );
    this.clearSessionIdStmt = this.db.prepare("UPDATE threads SET session_id = NULL, session_capabilities_json = NULL, updated_at = ? WHERE id = ?");
    this.clearSessionIdPreserveUpdatedAtStmt = this.db.prepare(
      "UPDATE threads SET session_id = NULL, session_capabilities_json = NULL WHERE id = ?",
    );
    this.clearSessionBindingIfMatchesStmt = this.db.prepare(
      "UPDATE threads SET session_id = NULL, session_capabilities_json = NULL, updated_at = ? WHERE id = ? AND session_id = ?",
    );
    this.clearSessionBindingIfMatchesTx = this.db.transaction(
      (threadId: ThreadId, expectedSessionId: SessionId, updatedAt: number): ThreadSessionBindingClearResult => {
        const result = this.clearSessionBindingIfMatchesStmt.run(
          updatedAt,
          String(threadId),
          String(expectedSessionId),
        );
        const changes = Number(result.changes ?? 0);
        if (changes === 1) return { kind: "cleared" };
        if (changes !== 0) {
          throw Object.assign(
            new Error(`Unexpected thread session binding clear count: threadId=${threadId}, changes=${changes}`),
            { code: "thread_session_binding_clear_count_invalid" },
          );
        }
        const current = this.get(threadId);
        if (!current) return { kind: "thread_missing" };
        if (!current.sessionId) return { kind: "already_cleared" };
        return { kind: "session_mismatch", actualSessionId: current.sessionId };
      },
    );
    this.historyCleanupTargetEligibleStmt = this.db.prepare(
      `SELECT 1 AS eligible FROM threads WHERE id = ? AND workspace_id = ? AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM meta WHERE key = '${THREAD_DELETION_META_PREFIX}' || threads.id)`,
    );
    this.renameStmt = this.db.prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?");
    this.setArchivedStmt = this.db.prepare("UPDATE threads SET archived = ?, updated_at = ? WHERE id = ?");
    this.setPinnedStmt = this.db.prepare("UPDATE threads SET pinned_at = ? WHERE id = ?");
    this.deleteStmt = this.db.prepare("DELETE FROM threads WHERE id = ?");
    this.touchStmt = this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?");
    this.setGroupStmt = this.db.prepare("UPDATE threads SET group_id = ? WHERE id = ?");
    this.setSharedAclStmt = this.db.prepare(
      "UPDATE threads SET owner_user_id = ?, shared_workspace_id = ?, shared_visibility = ?, shared_participant_user_ids_json = ?, shared_acl_updated_at = ? WHERE id = ?",
    );
    this.createGroupStmt = this.db.prepare(
      "INSERT INTO thread_groups (id, workspace_id, shared_workspace_id, name, name_key, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.renameGroupStmt = this.db.prepare("UPDATE thread_groups SET name = ?, name_key = ?, updated_at = ? WHERE id = ?");
    this.deleteGroupStmt = this.db.prepare("DELETE FROM thread_groups WHERE id = ?");
    this.unassignGroupStmt = this.db.prepare("UPDATE threads SET group_id = NULL WHERE group_id = ?");
    this.deleteGroupTx = this.db.transaction((groupId: ThreadGroupId) => {
      const unassigned = this.unassignGroupStmt.run(String(groupId));
      this.deleteGroupStmt.run(String(groupId));
      return Number(unassigned.changes ?? 0);
    });
    this.touchManyTx = this.db.transaction((rows: Array<{ threadId: ThreadId; updatedAt: number }>) => {
      for (const row of rows) {
        this.touchStmt.run(Number(row.updatedAt), String(row.threadId));
      }
    });
    this.setSharedAclManyTx = this.db.transaction((input: {
      workspaceId: WorkspaceId;
      sharedWorkspaceId: SharedWorkspaceId;
      items: readonly SharedThreadAclSyncItem[];
    }): ThreadSharedAclSyncBatchResult => {
      const workspaceId = String(input.workspaceId ?? "").trim();
      const sharedWorkspaceId = String(input.sharedWorkspaceId ?? "").trim();
      if (!workspaceId || !sharedWorkspaceId) {
        throw new Error("Invalid shared thread ACL batch scope");
      }

      const seenThreadIds = new Set<string>();
      const pending: Array<{ threadId: ThreadId; acl: NonNullable<ReturnType<typeof normalizeThreadSharedAcl>> }> = [];
      let missing = 0;
      let stale = 0;
      for (const item of input.items) {
        const threadId = String(item?.threadId ?? "").trim();
        if (!threadId || seenThreadIds.has(threadId)) {
          throw new Error(`Invalid or duplicate shared thread ACL batch thread: ${threadId || "<empty>"}`);
        }
        seenThreadIds.add(threadId);
        if (String(item.sharedWorkspaceId ?? "").trim() !== sharedWorkspaceId) {
          throw new Error(`Shared thread ACL batch scope mismatch: ${threadId}`);
        }
        if (!Number.isSafeInteger(item.updatedAt) || item.updatedAt <= 0) {
          throw new Error(`Invalid shared thread ACL batch updatedAt: ${threadId}`);
        }
        if (!Array.isArray(item.participantUserIds) || normalizeSharedVisibility(item.visibility) == null) {
          throw new Error(`Invalid shared thread ACL batch fields: ${threadId}`);
        }
        const acl = normalizeThreadSharedAcl(item, item.updatedAt);
        if (!acl || acl.sharedWorkspaceId !== sharedWorkspaceId) {
          throw new Error(`Invalid shared thread ACL batch item: ${threadId}`);
        }

        const thread = this.get(threadId as ThreadId);
        if (!thread) {
          missing += 1;
          continue;
        }
        if (String(thread.workspaceId) !== workspaceId) {
          throw new SharedThreadAclWorkspaceMismatchError({
            mismatchScope: "local_workspace",
            threadId: threadId as ThreadId,
            expectedWorkspaceId: workspaceId as WorkspaceId,
            actualWorkspaceId: thread.workspaceId,
            expectedSharedWorkspaceId: sharedWorkspaceId as SharedWorkspaceId,
            actualSharedWorkspaceId: thread.sharedWorkspaceId,
            aclUpdatedAt: acl.updatedAt,
          });
        }
        if (thread.sharedWorkspaceId && String(thread.sharedWorkspaceId) !== sharedWorkspaceId) {
          throw new SharedThreadAclWorkspaceMismatchError({
            mismatchScope: "shared_workspace",
            threadId: threadId as ThreadId,
            expectedWorkspaceId: workspaceId as WorkspaceId,
            actualWorkspaceId: thread.workspaceId,
            expectedSharedWorkspaceId: sharedWorkspaceId as SharedWorkspaceId,
            actualSharedWorkspaceId: thread.sharedWorkspaceId,
            aclUpdatedAt: acl.updatedAt,
          });
        }
        if (thread.sharedAclUpdatedAt != null && thread.sharedAclUpdatedAt > acl.updatedAt) {
          stale += 1;
          continue;
        }
        if (thread.sharedAclUpdatedAt === acl.updatedAt) {
          if (!matchesPersistedSharedAcl(thread, acl)) {
            throw new Error(`Shared thread ACL batch timestamp conflict: ${threadId}`);
          }
          stale += 1;
          continue;
        }
        pending.push({ threadId: threadId as ThreadId, acl });
      }

      for (const row of pending) {
        const result = this.setSharedAclStmt.run(
          row.acl.ownerUserId,
          row.acl.sharedWorkspaceId,
          row.acl.visibility,
          serializeSharedParticipantUserIds(row.acl.participantUserIds),
          row.acl.updatedAt,
          String(row.threadId),
        );
        if (Number(result.changes ?? 0) !== 1) {
          throw new Error(`Shared thread ACL batch update failed: ${String(row.threadId)}`);
        }
      }
      return {
        processed: input.items.length,
        updated: pending.length,
        missing,
        stale,
      };
    });
  }

  /** 创建 thread（若已存在则抛错），可同时写入普通自建会话分组。 */
  create(input: {
    id: ThreadId;
    workspaceId: WorkspaceId;
    engine: EngineType;
    title: string;
    threadType?: ThreadType | null;
    threadSubtype?: ThreadSubtype | null;
    groupId?: ThreadGroupId | null;
    prefs?: ThreadPrefs | null;
    sharedAcl?: ThreadSharedAclInput | null;
  }): PersistedThread {
    const now = Date.now();
    const id = String(input.id ?? "").trim();
    const workspaceId = String(input.workspaceId ?? "").trim();
    const engine = String(input.engine ?? "").trim() as EngineType;
    const title = String(input.title ?? "").trim();
    const threadType = normalizeThreadType(input.threadType);
    const threadSubtype = normalizeThreadSubtype(input.threadSubtype, threadType);
    const prefs = resolvePersistedThreadPrefs(
      engine,
      threadSubtype,
      input.prefs ?? null,
      this.resolveEngineModels?.(engine),
    );
    const sharedAcl = normalizeThreadSharedAcl(input.sharedAcl, now);
    const groupId = normalizeThreadGroupId(input.groupId);
    if (!id || !workspaceId || !title || (engine !== "claude" && engine !== "codex")) {
      throw new Error("Invalid thread: id/workspaceId/engine/title required");
    }
    if (this.getDeletion(id as ThreadId)) throw new Error(`thread_deleted: ${id}`);
    if (groupId) {
      if (!isSelfManagedChatThread({ threadType, threadSubtype })) {
        throw new Error("只有自建会话支持分组");
      }
      this.requireGroupInScope(groupId, normalizeThreadGroupScope(workspaceId as WorkspaceId, sharedAcl?.sharedWorkspaceId ?? null));
    }

    this.createStmt.run(
      id,
      workspaceId,
      engine,
      title,
      threadType,
      threadSubtype,
      groupId,
      now,
      now,
      prefs?.model ?? null,
      prefs?.effort ?? null,
      prefs?.accessMode ?? null,
      prefs?.planMode != null ? (prefs.planMode ? 1 : 0) : null,
      prefs?.knowledgeEnabled === true ? 1 : 0,
      prefs?.autoCompactPct ?? null,
      prefs?.contextWindow ?? null,
      prefs?.serviceTier ?? null,
      prefs?.roleId ?? null,
      sharedAcl?.ownerUserId ?? null,
      sharedAcl?.sharedWorkspaceId ?? null,
      sharedAcl?.visibility ?? null,
      sharedAcl ? serializeSharedParticipantUserIds(sharedAcl.participantUserIds) : null,
      sharedAcl?.updatedAt ?? null,
    );

    return {
      id: id as ThreadId,
      workspaceId: workspaceId as WorkspaceId,
      engine,
      title,
      threadType,
      threadSubtype,
      sessionId: null,
      sessionCapabilities: null,
      archived: false,
      pinnedAt: null,
      groupId,
      createdAt: now,
      updatedAt: now,
      model: prefs?.model ?? null,
      effort: prefs?.effort ?? null,
      accessMode: prefs?.accessMode ?? null,
      planMode: prefs?.planMode ?? null,
      knowledgeEnabled: prefs?.knowledgeEnabled === true,
      autoCompactPct: prefs?.autoCompactPct ?? null,
      contextWindow: prefs?.contextWindow ?? null,
      serviceTier: prefs?.serviceTier ?? null,
      roleId: prefs?.roleId ?? null,
      sharedWorkspaceId: sharedAcl?.sharedWorkspaceId ?? null,
      ownerUserId: sharedAcl?.ownerUserId ?? null,
      sharedVisibility: sharedAcl?.visibility ?? null,
      sharedParticipantUserIds: sharedAcl?.participantUserIds ?? [],
      sharedAclUpdatedAt: sharedAcl?.updatedAt ?? null,
    };
  }

  /** 按工作区和筛选分页；localOnly 先校验共享及允许节点、RA 集合，保持游标完整。 */
  listByWorkspace(
    workspaceId: WorkspaceId,
    opts?: {
      scope?: ThreadListScope | null;
      sort?: ThreadListSort | null;
      includeArchived?: boolean;
      search?: string | null;
      limit?: number;
      cursor?: string | null;
      threadListOnly?: boolean;
      localOnly?: boolean;
      /** 可信入口按全部父实例归属提供；省略时本机列表不开放节点。 */
      localNodeThreadIds?: readonly ThreadId[];
      /** 可信入口按持久 RA 归属提供；省略时本机列表不开放需求分析。 */
      localRequirementThreadIds?: readonly ThreadId[];
      groupId?: ThreadGroupId | "ungrouped" | null;
      sharedWorkspaceId?: SharedWorkspaceId | null;
      sharedActorUserId?: string | null;
      sharedOnlyRelatedToMe?: boolean;
      /** API 列表必须传可信账号；null 隐藏知识会话，省略仅供内部数据库查询。 */
      knowledgeActorUserId?: string | null;
      knowledgeSharedWorkspaceId?: string | null;
      /** 仅隐藏已有后台任务归属且没有任何会话事件的空宿主。 */
      emptyKnowledgeOwnerThreadIds?: string[];
    },
  ): { threads: ThreadSummary[]; hasMore: boolean; nextCursor: string | null } {
    const filter = resolveThreadListFilter(opts?.scope, Boolean(opts?.includeArchived ?? false));
    const sortSpec = resolveThreadListSortSpec(opts?.sort);
    const threadListOnly = Boolean(opts?.threadListOnly ?? false);
    const search = normalizeThreadTitleSearch(opts?.search);
    const groupFilter = normalizeThreadGroupFilter(opts?.groupId);
    const limit = Math.min(Math.max(1, Number(opts?.limit ?? 200) || 200), 2000);
    const cursor = opts?.cursor ? String(opts.cursor).trim() : null;
    const sharedWorkspaceId = String(opts?.sharedWorkspaceId ?? "").trim();
    const sharedActorUserId = String(opts?.sharedActorUserId ?? "").trim();

    let sql = [
      "SELECT id, title, engine, thread_type, thread_subtype, archived, pinned_at, group_id, created_at, updated_at",
      "FROM threads",
      "WHERE workspace_id = ?",
      `AND NOT EXISTS (SELECT 1 FROM meta WHERE key = '${THREAD_DELETION_META_PREFIX}' || threads.id)`,
    ].join("\n");
    const params: (string | number)[] = [String(workspaceId)];

    if (opts?.localOnly) {
      sql += "\n  AND shared_workspace_id IS NULL";
      sql += "\n  AND (COALESCE(thread_subtype, '') NOT IN ('node', 'node-discussion') OR id IN (SELECT value FROM json_each(?)))";
      params.push(JSON.stringify(opts.localNodeThreadIds ?? []));
      sql += "\n  AND (COALESCE(thread_subtype, '') <> 'requirement-analysis' OR id IN (SELECT value FROM json_each(?)))";
      params.push(JSON.stringify(opts.localRequirementThreadIds ?? []));
    }

    if (threadListOnly) {
      // 文件工作会话可见，复检子任务只在父会话展开。
      sql += "\n  AND COALESCE(thread_subtype, '') NOT IN ('master', 'asset-draft', 'gate-evaluation', 'knowledge-review')";
      if (opts?.emptyKnowledgeOwnerThreadIds?.length) {
        sql += "\n  AND NOT (COALESCE(thread_subtype, '') = 'knowledge-conversation' AND id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.thread_id = threads.id))";
        params.push(JSON.stringify(opts.emptyKnowledgeOwnerThreadIds));
      }
    }

    // 知识讨论留在创建者 Client，列表类别不能放宽知识会话本身的身份隔离。
    if (opts && "knowledgeActorUserId" in opts) {
      const actorUserId = String(opts.knowledgeActorUserId ?? "").trim();
      const knowledgeSharedWorkspaceId = String(opts.knowledgeSharedWorkspaceId ?? "").trim();
      if (!actorUserId) {
        sql += "\n  AND COALESCE(thread_subtype, '') <> 'knowledge-conversation'";
      } else if (knowledgeSharedWorkspaceId) {
        sql += "\n  AND (COALESCE(thread_subtype, '') <> 'knowledge-conversation' OR (shared_workspace_id = ? AND (owner_user_id = ? OR EXISTS (SELECT 1 FROM json_each(COALESCE(shared_participant_user_ids_json, '[]')) WHERE value = ?))))";
        params.push(knowledgeSharedWorkspaceId, actorUserId, actorUserId);
      } else {
        sql += "\n  AND (COALESCE(thread_subtype, '') <> 'knowledge-conversation' OR (shared_workspace_id IS NULL AND EXISTS (SELECT 1 FROM knowledge_conversations k WHERE k.thread_id = threads.id AND k.created_by_user_id = ?)))";
        params.push(actorUserId);
      }
    }

    if (sharedWorkspaceId) {
      sql += "\n  AND shared_workspace_id = ?";
      params.push(sharedWorkspaceId);
      if (opts?.sharedOnlyRelatedToMe) {
        if (!sharedActorUserId) {
          sql += "\n  AND 1 = 0";
        } else {
          sql += "\n  AND (owner_user_id = ? OR EXISTS (SELECT 1 FROM json_each(COALESCE(shared_participant_user_ids_json, '[]')) WHERE value = ?))";
          params.push(sharedActorUserId, sharedActorUserId);
        }
      }
    }

    if (filter === "archived") {
      sql += "\n  AND archived = 1";
    } else if (filter === "current") {
      sql += "\n  AND archived = 0";
      sql += "\n  AND COALESCE(thread_type, 'chat') <> 'orchestration'";
      sql += "\n  AND COALESCE(thread_subtype, '') NOT IN ('requirement-analysis', 'node-discussion', 'knowledge-conversation')";
    } else if (filter === "knowledge") {
      sql += "\n  AND archived = 0 AND thread_subtype IN ('knowledge-conversation', 'knowledge-assets')";
    } else if (filter === "orchestration") {
      sql += "\n  AND (COALESCE(thread_type, 'chat') = 'orchestration' OR COALESCE(thread_subtype, '') IN ('requirement-analysis', 'node-discussion'))";
    } else if (filter === "unarchived") {
      sql += "\n  AND archived = 0";
    }

    if (search) {
      sql += "\n  AND title LIKE ? ESCAPE '!'";
      params.push(`%${escapeSqlLikePattern(search)}%`);
    }

    if (groupFilter === "ungrouped") {
      sql += "\n  AND group_id IS NULL";
    } else if (groupFilter) {
      sql += "\n  AND group_id = ?";
      params.push(groupFilter);
    }

    const parsedCursor = parseThreadListCursor(cursor, sortSpec);
    if (parsedCursor) {
      const sortOperator = sortSpec.direction === "DESC" ? "<" : ">";
      const idOperator = sortSpec.direction === "DESC" ? "<" : ">";
      sql += ` AND (COALESCE(pinned_at, 0) < ? OR (COALESCE(pinned_at, 0) = ? AND ${sortSpec.valueExpr} ${sortOperator} ?) OR (COALESCE(pinned_at, 0) = ? AND ${sortSpec.valueExpr} = ? AND id ${idOperator} ?))`;
      params.push(
        parsedCursor.pinnedAt,
        parsedCursor.pinnedAt,
        parsedCursor.value,
        parsedCursor.pinnedAt,
        parsedCursor.value,
        parsedCursor.id,
      );
    }

    sql += ` ORDER BY COALESCE(pinned_at, 0) DESC, ${sortSpec.orderExpr}, id ${sortSpec.direction} LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; title: string; engine: string; thread_type: string | null; thread_subtype: string | null; archived: number; pinned_at: number | null; group_id: string | null; created_at: number; updated_at: number;
    }>;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const threads = page.map((r) => {
      const threadType = normalizeThreadType(r.thread_type);
      return {
        id: r.id as ThreadId,
        title: String(r.title ?? ""),
        threadType,
        threadSubtype: normalizeThreadSubtype(r.thread_subtype, threadType),
        archived: Boolean(r.archived ?? 0),
        pinnedAt: normalizePinnedAt(r.pinned_at),
        groupId: normalizeThreadGroupId(r.group_id),
        createdAt: Number(r.created_at ?? 0),
        updatedAt: Number(r.updated_at ?? 0),
        engine: String(r.engine ?? "") as EngineType,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1]!;
      nextCursor = stringifyThreadListCursor(last, sortSpec);
    }

    return { threads, hasMore, nextCursor };
  }

  /**
   * 列出指定会话上的活跃会话工作流原始行（不归并、不去重）。
   * 只按入参 threadIds 过滤，不会暴露调用方未持有的会话；排序与档位归并交给调用方，避免 SQL 顺序不确定导致标签跳动。
   */
  listActiveChatWorkflows(
    workspaceId: WorkspaceId,
    threadIds: ReadonlyArray<ThreadId>,
  ): ActiveChatWorkflowRow[] {
    const normalizedIds = normalizeCleanupThreadIds(threadIds);
    if (!normalizedIds.length) return [];
    const placeholders = normalizedIds.map(() => "?").join(", ");
    const activeChatWorkflow = buildActiveChatWorkflowFilter();
    const rows = this.db.prepare(`SELECT task.thread_id, task.id AS task_id, task.instance_id,
        task.state AS task_state, instance.status AS instance_status, task.created_at
      FROM chat_workflow_tasks task
      LEFT JOIN orch_instances instance ON instance.id = task.instance_id
      WHERE task.workspace_id = ? AND task.thread_id IN (${placeholders}) AND ${activeChatWorkflow.sql}`)
      .all(String(workspaceId), ...normalizedIds, ...activeChatWorkflow.params) as Array<{
        thread_id: string;
        task_id: string;
        instance_id: string | null;
        task_state: string;
        instance_status: string | null;
        created_at: number;
      }>;
    return rows.map((row) => ({
      threadId: String(row.thread_id),
      taskId: String(row.task_id),
      instanceId: row.instance_id == null ? null : String(row.instance_id),
      taskState: String(row.task_state ?? ""),
      instanceStatus: row.instance_status == null ? null : String(row.instance_status),
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  /** 按活动时间游标快照一页历史清理目标及逐表高水位。 */
  listHistoryCleanupTargetPage(input: {
    inactiveBefore: number;
    cursor?: ThreadHistoryCleanupCursor | null;
    limit?: number;
  }): ThreadHistoryCleanupTargetPage {
    const cutoff = Number(input.inactiveBefore);
    if (!Number.isSafeInteger(cutoff) || cutoff <= 0) {
      throw new Error(`Invalid thread history cleanup cutoff: ${String(input.inactiveBefore)}`);
    }
    const limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit ?? 50)) || 50));
    const cursorUpdatedAt = Number(input.cursor?.updatedAt ?? 0);
    const cursorThreadId = String(input.cursor?.threadId ?? "");
    const hasCursor = Number.isSafeInteger(cursorUpdatedAt) && cursorUpdatedAt >= 0 && cursorThreadId.length > 0;
    const cursorSql = hasCursor ? "AND (t.updated_at > ? OR (t.updated_at = ? AND t.id > ?))" : "";
    const params: Array<string | number> = [cutoff];
    if (hasCursor) params.push(cursorUpdatedAt, cursorUpdatedAt, cursorThreadId);
    const rows = this.db
      .prepare(
        `SELECT t.id, t.workspace_id, t.shared_workspace_id, t.updated_at,
                COALESCE((SELECT MAX(event.seq) FROM conversation_events event WHERE event.thread_id = t.id), 0) AS conversation_high_water_seq,
                COALESCE((SELECT MAX(event.seq) FROM raw_engine_events event WHERE event.thread_id = t.id), 0) AS raw_high_water_seq
         FROM threads t
         WHERE t.updated_at < ?
           AND NOT EXISTS (SELECT 1 FROM meta WHERE key = '${THREAD_DELETION_META_PREFIX}' || t.id)
           ${cursorSql}
         ORDER BY t.updated_at ASC, t.id ASC
         LIMIT ?`,
      )
      .all(...params, limit + 1) as Array<{
        id: string;
        workspace_id: string;
        shared_workspace_id: string | null;
        updated_at: number;
        conversation_high_water_seq: number | null;
        raw_high_water_seq: number | null;
      }>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      threadId: String(row.id) as ThreadId,
      workspaceId: String(row.workspace_id) as WorkspaceId,
      sharedWorkspaceId: normalizeSharedWorkspaceId(row.shared_workspace_id),
      updatedAt: Number(row.updated_at),
      conversationHighWaterSeq: normalizeCleanupHighWater(row.conversation_high_water_seq),
      rawHighWaterSeq: normalizeCleanupHighWater(row.raw_high_water_seq),
    }));
    const last = items[items.length - 1] ?? null;
    return {
      items,
      hasMore,
      nextCursor: last ? { updatedAt: last.updatedAt, threadId: last.threadId } : null,
    };
  }

  /** 在会话租约内复核当前元数据仍满足严格清理截止条件。 */
  isHistoryCleanupTargetEligible(input: {
    threadId: ThreadId;
    workspaceId: WorkspaceId;
    inactiveBefore: number;
  }): boolean {
    const cutoff = Number(input.inactiveBefore);
    if (!Number.isSafeInteger(cutoff) || cutoff <= 0) {
      throw new Error(`Invalid thread history cleanup cutoff: ${String(input.inactiveBefore)}`);
    }
    return this.historyCleanupTargetEligibleStmt.get(
      String(input.threadId),
      String(input.workspaceId),
      cutoff,
    ) !== undefined;
  }

  /** 返回会阻止会话清理的编排或资产任务状态；运行 turn 由 Handler 合并。 */
  getCleanupBusinessBlockedReasons(
    threadIds: ReadonlyArray<ThreadId>,
  ): Map<string, ThreadCleanupBusinessBlockedReason> {
    const normalizedIds = normalizeCleanupThreadIds(threadIds);
    const blocked = new Map<string, ThreadCleanupBusinessBlockedReason>();
    if (!normalizedIds.length) return blocked;
    const targetIds = new Set(normalizedIds);
    const placeholders = normalizedIds.map(() => "?").join(", ");

    const activeChatWorkflow = buildActiveChatWorkflowFilter();
    const chatWorkflows = this.db.prepare(`SELECT DISTINCT task.thread_id FROM chat_workflow_tasks task
      LEFT JOIN orch_instances instance ON instance.id = task.instance_id
      WHERE task.thread_id IN (${placeholders}) AND ${activeChatWorkflow.sql}`)
      .all(...normalizedIds, ...activeChatWorkflow.params) as Array<{ thread_id: string }>;
    for (const task of chatWorkflows) blocked.set(task.thread_id, "active_orchestration");

    const instances = this.listCleanupOrchestrationCandidates(normalizedIds);
    for (const instance of instances) {
      const references = collectOrchestrationThreadReferences(instance.node_states_json, instance.id);
      const masterThreadId = String(instance.master_thread_id ?? "").trim();
      if (masterThreadId) references.add(masterThreadId);
      if (isCleanupTerminalOrchestrationStatus(instance.status)) continue;
      for (const threadId of references) {
        if (targetIds.has(threadId)) blocked.set(threadId, "active_orchestration");
      }
    }

    const activeAttempts = this.db
      .prepare(
        `SELECT DISTINCT attempt.thread_id
         FROM orch_node_attempts attempt
         JOIN orch_instances instance ON instance.id = attempt.instance_id
         WHERE (
           instance.status NOT IN ('completed', 'failed', 'cancelled')
           OR attempt.status IN ('running', 'result-submitted', 'finalizing')
         )
           AND attempt.thread_id IN (${placeholders})`,
      )
      .all(...normalizedIds) as Array<{ thread_id: string | null }>;
    for (const row of activeAttempts) {
      const threadId = String(row.thread_id ?? "").trim();
      if (threadId) blocked.set(threadId, "active_orchestration");
    }

    const activePromptSnapshots = this.db
      .prepare(
        `SELECT DISTINCT snapshot.thread_id
         FROM orch_prompt_snapshots snapshot
         JOIN orch_instances instance ON instance.id = snapshot.instance_id
         WHERE instance.status NOT IN ('completed', 'failed', 'cancelled')
           AND snapshot.thread_id IN (${placeholders})`,
      )
      .all(...normalizedIds) as Array<{ thread_id: string | null }>;
    for (const row of activePromptSnapshots) {
      const threadId = String(row.thread_id ?? "").trim();
      if (threadId) blocked.set(threadId, "active_orchestration");
    }

    const activeAssetJobs = this.db
      .prepare(
        `SELECT DISTINCT thread_id
         FROM orch_asset_generation_jobs
         WHERE status NOT IN ('applied', 'rejected', 'failed', 'cancelled')
           AND thread_id IN (${placeholders})`,
      )
      .all(...normalizedIds) as Array<{ thread_id: string | null }>;
    for (const row of activeAssetJobs) {
      const threadId = String(row.thread_id ?? "").trim();
      if (threadId && !blocked.has(threadId)) blocked.set(threadId, "active_asset_job");
    }
    return blocked;
  }

  /** 解除终态业务对象对待删会话的引用，并删除对应大 prompt 快照。 */
  detachCleanupBusinessReferences(threadIds: ReadonlyArray<ThreadId>): void {
    const normalizedIds = normalizeCleanupThreadIds(threadIds);
    if (!normalizedIds.length) return;
    const targetIds = new Set(normalizedIds);
    const placeholders = normalizedIds.map(() => "?").join(", ");
    const instances = this.listCleanupOrchestrationCandidates(normalizedIds);
    const updateInstance = this.db.prepare(
      "UPDATE orch_instances SET master_thread_id = ?, node_states_json = ? WHERE id = ?",
    );
    for (const instance of instances) {
      const masterThreadId = String(instance.master_thread_id ?? "").trim();
      const rewritten = rewriteOrchestrationThreadReferences(instance.node_states_json, instance.id, targetIds);
      const nextMasterThreadId = masterThreadId && targetIds.has(masterThreadId) ? null : instance.master_thread_id;
      if (!rewritten.changed && nextMasterThreadId === instance.master_thread_id) continue;
      updateInstance.run(nextMasterThreadId, rewritten.json, instance.id);
    }

    this.db.prepare(
      `UPDATE orch_node_attempts
       SET thread_id = NULL, turn_id = NULL
       WHERE thread_id IN (${placeholders})`,
    ).run(...normalizedIds);
    this.db.prepare(
      `UPDATE orch_asset_generation_jobs
       SET thread_id = NULL
       WHERE thread_id IN (${placeholders})`,
    ).run(...normalizedIds);
    this.db.prepare(
      `DELETE FROM orch_prompt_snapshots
       WHERE thread_id IN (${placeholders})`,
    ).run(...normalizedIds);
  }

  /** 默认隐藏已确认删除的会话；后台清理可显式读取原元数据。 */
  get(id: ThreadId, options?: { includeDeleted: boolean }): PersistedThread | null {
    const row = this.getStmt.get(String(id), options?.includeDeleted ? 1 : 0) as
      | {
          id: string;
          workspace_id: string;
          engine: string;
          title: string;
          thread_type: string | null;
          thread_subtype: string | null;
          session_id: string | null;
          session_capabilities_json: string | null;
          archived: number;
          pinned_at: number | null;
          group_id: string | null;
          created_at: number;
          updated_at: number;
          model: string | null;
          effort: string | null;
          access_mode: string | null;
          plan_mode: number | null;
          knowledge_enabled: number | null;
          auto_compact_pct: number | null;
          context_window: number | null;
          service_tier: string | null;
          role_id: string | null;
          owner_user_id: string | null;
          shared_workspace_id: string | null;
          shared_visibility: string | null;
          shared_participant_user_ids_json: string | null;
          shared_acl_updated_at: number | null;
        }
      | undefined;
    return row ? rowToPersistedThread(row, this.resolveEngineModels) : null;
  }

  /** 同步 Host 本地共享会话 ACL；本地不存在该 thread 时返回 false。 */
  setSharedAcl(threadId: ThreadId, acl: ThreadSharedAclInput): boolean {
    const normalized = normalizeThreadSharedAcl(acl, Date.now());
    if (!normalized) return false;
    const result = this.setSharedAclStmt.run(
      normalized.ownerUserId,
      normalized.sharedWorkspaceId,
      normalized.visibility,
      serializeSharedParticipantUserIds(normalized.participantUserIds),
      normalized.updatedAt,
      String(threadId),
    );
    return Number(result.changes ?? 0) > 0;
  }

  /** 在一个事务中校验并应用共享会话 ACL；缺失和旧版本只计数，不跨工作区写入。 */
  setSharedAclMany(input: {
    workspaceId: WorkspaceId;
    sharedWorkspaceId: SharedWorkspaceId;
    items: readonly SharedThreadAclSyncItem[];
  }): ThreadSharedAclSyncBatchResult {
    return this.setSharedAclManyTx(input);
  }

  /** 列出会话分组；共享工作区会按 actor 计算维护权限。 */
  listGroups(
    workspaceId: WorkspaceId,
    opts?: { sharedWorkspaceId?: SharedWorkspaceId | null; actorUserId?: string | null; actorIsAdmin?: boolean },
  ): ThreadGroupSummary[] {
    const scope = normalizeThreadGroupScope(workspaceId, opts?.sharedWorkspaceId ?? null);
    const params: (string | null)[] = [scope.workspaceId];
    let sql = [
      "SELECT id, workspace_id, shared_workspace_id, name, created_by_user_id, created_at, updated_at",
      "FROM thread_groups",
      "WHERE workspace_id = ?",
    ].join("\n");
    if (scope.sharedWorkspaceId) {
      sql += "\n  AND shared_workspace_id = ?";
      params.push(scope.sharedWorkspaceId);
    } else {
      sql += "\n  AND shared_workspace_id IS NULL";
    }
    sql += "\nORDER BY name_key ASC, created_at ASC, id ASC";
    return (this.db.prepare(sql).all(...params) as ThreadGroupRow[])
      .map((row) => rowToThreadGroupSummary(row, opts));
  }

  /** 创建会话分组；名称按同一工作区/共享区大小写不敏感唯一。 */
  createGroup(input: {
    workspaceId: WorkspaceId;
    name: string;
    sharedWorkspaceId?: SharedWorkspaceId | null;
    createdByUserId?: string | null;
  }): ThreadGroupSummary {
    const scope = normalizeThreadGroupScope(input.workspaceId, input.sharedWorkspaceId ?? null);
    const name = normalizeThreadGroupName(input.name);
    const nameKey = makeThreadGroupNameKey(name);
    const createdByUserId = normalizeUserId(input.createdByUserId);
    if (scope.sharedWorkspaceId && !createdByUserId) {
      throw new Error("共享工作区分组缺少创建者");
    }
    assertThreadGroupNameAvailable(this.db, scope, nameKey);
    const id = `tg_${crypto.randomUUID()}` as ThreadGroupId;
    const now = Date.now();
    this.createGroupStmt.run(
      id,
      scope.workspaceId,
      scope.sharedWorkspaceId,
      name,
      nameKey,
      createdByUserId,
      now,
      now,
    );
    const group = this.getGroup(id);
    if (!group) throw new Error("会话分组创建失败");
    return rowToThreadGroupSummary(group, {
      sharedWorkspaceId: scope.sharedWorkspaceId,
      actorUserId: createdByUserId,
      actorIsAdmin: false,
    });
  }

  /** 重命名会话分组；共享工作区仅创建者或管理员可维护。 */
  renameGroup(input: {
    workspaceId: WorkspaceId;
    groupId: ThreadGroupId;
    name: string;
    sharedWorkspaceId?: SharedWorkspaceId | null;
    actorUserId?: string | null;
    actorIsAdmin?: boolean;
  }): ThreadGroupSummary {
    const scope = normalizeThreadGroupScope(input.workspaceId, input.sharedWorkspaceId ?? null);
    const group = this.requireGroupInScope(input.groupId, scope);
    assertThreadGroupManageAllowed(group, scope, input);
    const name = normalizeThreadGroupName(input.name);
    const nameKey = makeThreadGroupNameKey(name);
    assertThreadGroupNameAvailable(this.db, scope, nameKey, input.groupId);
    this.renameGroupStmt.run(name, nameKey, Date.now(), String(input.groupId));
    const updated = this.getGroup(input.groupId);
    if (!updated) throw new Error("会话分组重命名失败");
    return rowToThreadGroupSummary(updated, input);
  }

  /** 删除会话分组；先把组内会话回退为未分组。 */
  deleteGroup(input: {
    workspaceId: WorkspaceId;
    groupId: ThreadGroupId;
    sharedWorkspaceId?: SharedWorkspaceId | null;
    actorUserId?: string | null;
    actorIsAdmin?: boolean;
  }): number {
    const scope = normalizeThreadGroupScope(input.workspaceId, input.sharedWorkspaceId ?? null);
    const group = this.requireGroupInScope(input.groupId, scope);
    assertThreadGroupManageAllowed(group, scope, input);
    return this.deleteGroupTx(input.groupId);
  }

  /** 设置自建会话所属分组；groupId 为空表示移回未分组。 */
  setThreadGroup(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    groupId?: ThreadGroupId | null;
    sharedWorkspaceId?: SharedWorkspaceId | null;
  }): ThreadGroupId | null {
    const scope = normalizeThreadGroupScope(input.workspaceId, input.sharedWorkspaceId ?? null);
    const thread = this.get(input.threadId);
    if (!thread || String(thread.workspaceId) !== scope.workspaceId) {
      throw new Error("thread 不存在或不属于当前工作区");
    }
    if (!isSelfManagedChatThread(thread)) {
      throw new Error("只有自建会话支持分组");
    }
    if (String(thread.sharedWorkspaceId ?? "") !== String(scope.sharedWorkspaceId ?? "")) {
      throw new Error("thread 与分组不属于同一共享工作区");
    }
    const groupId = normalizeThreadGroupId(input.groupId);
    if (groupId) this.requireGroupInScope(groupId, scope);
    this.setGroupStmt.run(groupId, String(input.threadId));
    return groupId;
  }

  /** 更新 thread 的 sessionId（用于 resume）。 */
  setSessionId(threadId: ThreadId, sessionId: SessionId): void {
    this.setSessionIdStmt.run(String(sessionId), Date.now(), String(threadId));
  }

  setSessionBinding(threadId: ThreadId, sessionId: SessionId, sessionCapabilities: ThreadSessionCapabilities | null): void {
    this.setSessionBindingStmt.run(
      String(sessionId),
      serializeThreadSessionCapabilities(sessionCapabilities),
      Date.now(),
      String(threadId),
    );
  }

  /** 仅在 provider binding 未换代时原子补回 capability，不改写 sessionId。 */
  restoreSessionCapabilitiesIfMatches(
    threadId: ThreadId,
    expectedSessionId: SessionId,
    sessionCapabilities: ThreadSessionCapabilities,
  ): ThreadSessionCapabilitiesRestoreResult {
    const expected = String(expectedSessionId ?? "").trim();
    if (!expected) {
      throw Object.assign(new Error(`Invalid expected sessionId for thread ${threadId}`), {
        code: "thread_session_capability_expected_id_invalid",
      });
    }
    return this.restoreSessionCapabilitiesIfMatchesTx(
      threadId,
      expected as SessionId,
      sessionCapabilities,
      Date.now(),
    );
  }

  /** 清空 thread 的 sessionId；历史清理可保留活动时间，避免改变分页资格。 */
  clearSessionId(threadId: ThreadId, opts?: { preserveUpdatedAt?: boolean }): void {
    if (opts?.preserveUpdatedAt) {
      this.clearSessionIdPreserveUpdatedAtStmt.run(String(threadId));
      return;
    }
    this.clearSessionIdStmt.run(Date.now(), String(threadId));
  }

  /** 仅当持久化 sessionId 仍为预期旧值时，原子清空 session binding。 */
  clearSessionBindingIfMatches(threadId: ThreadId, expectedSessionId: SessionId): ThreadSessionBindingClearResult {
    const expected = String(expectedSessionId ?? "").trim();
    if (!expected) {
      throw Object.assign(new Error(`Invalid expected sessionId for thread ${threadId}`), {
        code: "thread_session_binding_expected_id_invalid",
      });
    }
    return this.clearSessionBindingIfMatchesTx(threadId, expected as SessionId, Date.now());
  }

  /** 重命名 thread（同时 touch updatedAt）。 */
  rename(threadId: ThreadId, title: string): void {
    const t = String(title ?? "").trim();
    if (!t) throw new Error("Invalid thread title");
    this.renameStmt.run(t, Date.now(), String(threadId));
  }

  /** 设置 thread 归档状态（archived=0/1），并 touch updatedAt。 */
  setArchived(threadId: ThreadId, archived: boolean): void {
    this.setArchivedStmt.run(archived ? 1 : 0, Date.now(), String(threadId));
  }

  /** 设置 thread 置顶状态；置顶时间用于列表排序。 */
  setPinned(threadId: ThreadId, pinned: boolean): number | null {
    const pinnedAt = pinned ? Date.now() : null;
    this.setPinnedStmt.run(pinnedAt, String(threadId));
    return pinnedAt;
  }

  /** 删除 thread（会触发关联表 cascade 删除），返回是否实际删除。 */
  delete(threadId: ThreadId): boolean {
    const result = this.deleteStmt.run(String(threadId));
    return Number(result.changes ?? 0) > 0;
  }

  /** 原子提交删除标记；重复请求保留原任务身份，历史交由跟踪任务清理。 */
  markDeleted(threadId: ThreadId, requestId: string): ThreadDeletionTask {
    return this.db.transaction(() => {
      const existing = this.getDeletion(threadId);
      if (existing) return existing;
      const thread = this.get(threadId);
      if (!thread || !requestId.trim()) throw new Error(`THREAD_DELETION_TARGET_INVALID: ${threadId}`);
      const task: ThreadDeletionTask = { threadId, workspaceId: thread.workspaceId, sharedWorkspaceId: thread.sharedWorkspaceId, requestId,
        status: "queued", phase: "queued", createdAt: Date.now(), error: null };
      this.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)")
        .run(THREAD_DELETION_META_PREFIX + threadId, JSON.stringify(task));
      return task;
    })();
  }

  /** 读取唯一耐久删除任务；损坏记录显式失败，不能按未删除处理。 */
  getDeletion(threadId: ThreadId): ThreadDeletionTask | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(THREAD_DELETION_META_PREFIX + threadId) as { value: string } | undefined;
    return row ? decodeThreadDeletion(row.value, threadId) : null;
  }

  /** 重启只恢复中断的 queued 任务；failed 必须保留明确失败态。 */
  listQueuedDeletions(): ThreadDeletionTask[] {
    const rows = this.db.prepare("SELECT key,value FROM meta WHERE key GLOB ? ORDER BY key")
      .all(THREAD_DELETION_META_PREFIX + "*") as Array<{ key: string; value: string }>;
    return rows.map(row => decodeThreadDeletion(row.value, row.key.slice(THREAD_DELETION_META_PREFIX.length) as ThreadId))
      .filter(task => task.status === "queued");
  }

  /** 推进原任务阶段或失败状态；完成后仍保留标记，防止旧请求复活会话。 */
  setDeletionState(threadId: ThreadId, state: Pick<ThreadDeletionTask, "status" | "phase" | "error">): ThreadDeletionTask {
    const task = this.getDeletion(threadId);
    if (!task) throw new Error(`THREAD_DELETION_TASK_MISSING: ${threadId}`);
    const next = { ...task, ...state };
    this.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(next), THREAD_DELETION_META_PREFIX + threadId);
    return next;
  }

  /** 更新 thread 的 updatedAt（用于列表排序）。 */
  touch(threadId: ThreadId, updatedAt?: number): void {
    this.touchStmt.run(Number(updatedAt ?? Date.now()), String(threadId));
  }

  /** 批量 touch thread 的 updatedAt（用于高频事件合批）。 */
  touchMany(rows: Array<{ threadId: ThreadId; updatedAt?: number }>): void {
    if (!Array.isArray(rows) || rows.length === 0) return;
    this.touchManyTx(
      rows.map((row) => ({
        threadId: row.threadId,
        updatedAt: Number(row.updatedAt ?? Date.now()),
      })),
    );
  }

  /** 按 ID 读取分组原始行；不存在返回 null。 */
  private getGroup(groupId: ThreadGroupId): ThreadGroupRow | null {
    const row = this.db.prepare(
      "SELECT id, workspace_id, shared_workspace_id, name, created_by_user_id, created_at, updated_at FROM thread_groups WHERE id = ?",
    ).get(String(groupId)) as ThreadGroupRow | undefined;
    return row ?? null;
  }

  /** 读取并校验分组属于指定工作区/共享区。 */
  private requireGroupInScope(groupId: ThreadGroupId, scope: ThreadGroupScope): ThreadGroupRow {
    const group = this.getGroup(groupId);
    if (!group || String(group.workspace_id) !== scope.workspaceId || String(group.shared_workspace_id ?? "") !== String(scope.sharedWorkspaceId ?? "")) {
      throw new Error("会话分组不存在或不属于当前工作区");
    }
    return group;
  }

  /** 仅返回目标会话所属工作区内可能包含 thread 引用的编排实例。 */
  private listCleanupOrchestrationCandidates(threadIds: readonly string[]): CleanupOrchestrationCandidate[] {
    if (!threadIds.length) return [];
    const threadPlaceholders = threadIds.map(() => "?").join(", ");
    const workspaceRows = this.db.prepare(
      `SELECT DISTINCT workspace_id FROM threads WHERE id IN (${threadPlaceholders})`,
    ).all(...threadIds) as Array<{ workspace_id: string }>;
    const workspaceIds = workspaceRows
      .map((row) => String(row.workspace_id ?? "").trim())
      .filter(Boolean);
    if (!workspaceIds.length) return [];

    const workspacePlaceholders = workspaceIds.map(() => "?").join(", ");
    const nodeStateMatches = threadIds.map(() => "instr(node_states_json, ?) > 0").join(" OR ");
    return this.db.prepare(
      `SELECT id, master_thread_id, status, node_states_json
       FROM orch_instances
       WHERE workspace_id IN (${workspacePlaceholders})
         AND master_thread_id IN (${threadPlaceholders})
       UNION
       SELECT id, master_thread_id, status, node_states_json
       FROM orch_instances
       WHERE workspace_id IN (${workspacePlaceholders})
         AND (${nodeStateMatches})`,
    ).all(...workspaceIds, ...threadIds, ...workspaceIds, ...threadIds) as CleanupOrchestrationCandidate[];
  }

  /** 查询同引擎最近显式保存偏好的普通会话；localOnly 不读取共享偏好。 */
  getLatestPrefsByEngine(workspaceId: WorkspaceId, engine: EngineType, opts?: { localOnly?: boolean }): ThreadPrefs | null {
    const row = this.db
      .prepare(
        [
          "SELECT model, effort, access_mode, plan_mode, auto_compact_pct, context_window, service_tier",
          "FROM threads",
          "WHERE workspace_id = ?",
          `  AND NOT EXISTS (SELECT 1 FROM meta WHERE key = '${THREAD_DELETION_META_PREFIX}' || threads.id)`,
          ...(opts?.localOnly ? ["  AND shared_workspace_id IS NULL"] : []),
          "  AND engine = ?",
          "  AND thread_type = 'chat'",
          "  AND thread_subtype IS NULL",
          "  AND archived = 0",
          "  AND (model IS NOT NULL OR effort IS NOT NULL OR access_mode IS NOT NULL OR plan_mode IS NOT NULL OR auto_compact_pct IS NOT NULL OR context_window IS NOT NULL OR service_tier IS NOT NULL)",
          "ORDER BY updated_at DESC",
          "LIMIT 1",
        ].join("\n"),
      )
      .get(String(workspaceId), String(engine)) as
      | { model: string | null; effort: string | null; access_mode: string | null; plan_mode: number | null; auto_compact_pct: number | null; context_window: number | null; service_tier: string | null }
      | undefined;
    if (!row) return null;
    return resolvePersistedThreadPrefs(engine, null, {
      model: row.model ?? null,
      effort: row.effort ?? null,
      accessMode: (row.access_mode as AccessMode) ?? null,
      planMode: row.plan_mode != null ? Boolean(row.plan_mode) : null,
      autoCompactPct: row.auto_compact_pct ?? null,
      contextWindow: row.context_window ?? null,
      serviceTier: normalizeServiceTier(row.service_tier),
    }, this.resolveEngineModels?.(engine));
  }

  /** 更新 thread 的会话级偏好。 */
  updatePrefs(threadId: ThreadId, prefs: {
    model?: string | null;
    effort?: string | null;
    accessMode?: AccessMode | null;
    planMode?: boolean | null;
    knowledgeEnabled?: boolean | null;
    autoCompactPct?: number | null;
    contextWindow?: number | null;
    serviceTier?: CodexServiceTier | null;
    roleId?: RoleId | null;
  }): void {
    const current = this.get(threadId);
    // `prefs` is a patch at this boundary. Preserve fields omitted by callers;
    // an explicit null still means reset that field to the catalog default.
    const mergedPrefs = mergeDefinedThreadPrefs(
      current
        ? {
            model: current.model,
            effort: current.effort,
            accessMode: current.accessMode,
            planMode: current.planMode,
            knowledgeEnabled: current.knowledgeEnabled,
            autoCompactPct: current.autoCompactPct,
            contextWindow: current.contextWindow,
            serviceTier: current.serviceTier,
            roleId: current.roleId,
          }
        : null,
      prefs,
    );
    const engine = current?.engine ?? "codex";
    const normalizedPrefs = resolvePersistedThreadPrefs(
      engine,
      current?.threadSubtype ?? null,
      mergedPrefs,
      this.resolveEngineModels?.(engine),
    );
    this.db
      .prepare("UPDATE threads SET model = ?, effort = ?, access_mode = ?, plan_mode = ?, knowledge_enabled = ?, auto_compact_pct = ?, context_window = ?, service_tier = ?, role_id = ?, updated_at = ? WHERE id = ?")
      .run(
        normalizedPrefs?.model ?? null,
        normalizedPrefs?.effort ?? null,
        normalizedPrefs?.accessMode ?? null,
        normalizedPrefs?.planMode != null ? (normalizedPrefs.planMode ? 1 : 0) : null,
        normalizedPrefs?.knowledgeEnabled === true ? 1 : 0,
        normalizedPrefs?.autoCompactPct ?? null,
        normalizedPrefs?.contextWindow ?? null,
        normalizedPrefs?.serviceTier ?? null,
        normalizedPrefs?.roleId ?? null,
        Date.now(),
        String(threadId),
      );
  }
}

function rowToPersistedThread(
  row: {
  id: string;
  workspace_id: string;
  engine: string;
  title: string;
  thread_type: string | null;
  thread_subtype: string | null;
  session_id: string | null;
  session_capabilities_json: string | null;
  archived: number;
  pinned_at: number | null;
  created_at: number;
  updated_at: number;
  model: string | null;
  effort: string | null;
  access_mode: string | null;
  plan_mode: number | null;
  knowledge_enabled: number | null;
  auto_compact_pct: number | null;
  context_window: number | null;
  service_tier: string | null;
  role_id: string | null;
  group_id: string | null;
  owner_user_id: string | null;
  shared_workspace_id: string | null;
  shared_visibility: string | null;
  shared_participant_user_ids_json: string | null;
    shared_acl_updated_at: number | null;
  },
  resolveEngineModels?: (engine: EngineType) => EngineModelInfo[] | null,
): PersistedThread {
  const threadType = normalizeThreadType(row.thread_type);
  const threadSubtype = normalizeThreadSubtype(row.thread_subtype, threadType);
  const engine = row.engine as EngineType;
  const prefs = resolvePersistedThreadPrefs(engine, threadSubtype, {
    model: row.model ?? null,
    effort: row.effort ?? null,
    accessMode: normalizeAccessMode(row.access_mode),
    planMode: row.plan_mode != null ? Boolean(row.plan_mode) : null,
    knowledgeEnabled: row.knowledge_enabled != null ? Boolean(row.knowledge_enabled) : false,
    autoCompactPct: normalizeAutoCompactPct(row.auto_compact_pct),
    contextWindow: normalizeContextWindow(row.context_window),
    serviceTier: normalizeServiceTier(row.service_tier),
    roleId: normalizeRoleId(row.role_id),
  }, resolveEngineModels?.(engine));
  return {
    id: row.id as ThreadId,
    workspaceId: row.workspace_id as WorkspaceId,
    engine: row.engine as EngineType,
    title: String(row.title ?? ""),
    threadType,
    threadSubtype,
    sessionId: (row.session_id ? (row.session_id as SessionId) : null) ?? null,
    sessionCapabilities: parseThreadSessionCapabilities(row.session_capabilities_json),
    archived: Boolean(row.archived ?? 0),
    pinnedAt: normalizePinnedAt(row.pinned_at),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    model: prefs.model ?? null,
    effort: prefs.effort ?? null,
    accessMode: prefs.accessMode ?? null,
    planMode: prefs.planMode ?? null,
    knowledgeEnabled: prefs.knowledgeEnabled === true,
    autoCompactPct: prefs.autoCompactPct ?? null,
    contextWindow: prefs.contextWindow ?? null,
    serviceTier: prefs.serviceTier ?? null,
    roleId: prefs.roleId ?? null,
    groupId: normalizeThreadGroupId(row.group_id),
    sharedWorkspaceId: normalizeSharedWorkspaceId(row.shared_workspace_id),
    ownerUserId: normalizeUserId(row.owner_user_id),
    sharedVisibility: normalizeSharedVisibility(row.shared_visibility),
    sharedParticipantUserIds: parseSharedParticipantUserIds(row.shared_participant_user_ids_json),
    sharedAclUpdatedAt: normalizeTimestamp(row.shared_acl_updated_at),
  };
}

type ThreadGroupScope = {
  workspaceId: string;
  sharedWorkspaceId: string | null;
};

type ThreadGroupRow = {
  id: string;
  workspace_id: string;
  shared_workspace_id: string | null;
  name: string;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

function rowToThreadGroupSummary(
  row: ThreadGroupRow,
  opts?: { sharedWorkspaceId?: SharedWorkspaceId | null; actorUserId?: string | null; actorIsAdmin?: boolean },
): ThreadGroupSummary {
  const sharedWorkspaceId = normalizeSharedWorkspaceId(row.shared_workspace_id);
  return {
    id: String(row.id) as ThreadGroupId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    sharedWorkspaceId,
    name: String(row.name ?? ""),
    createdByUserId: normalizeUserId(row.created_by_user_id),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    canManage: canManageThreadGroup(row, { sharedWorkspaceId, actorUserId: opts?.actorUserId, actorIsAdmin: opts?.actorIsAdmin }),
  };
}

/** 校验分组名称唯一；ignoreGroupId 用于重命名自身。 */
function assertThreadGroupNameAvailable(
  db: SqliteDb,
  scope: ThreadGroupScope,
  nameKey: string,
  ignoreGroupId?: ThreadGroupId | null,
): void {
  const params: (string | null)[] = [scope.workspaceId, nameKey];
  let sql = [
    "SELECT id",
    "FROM thread_groups",
    "WHERE workspace_id = ?",
    "  AND name_key = ?",
  ].join("\n");
  if (scope.sharedWorkspaceId) {
    sql += "\n  AND shared_workspace_id = ?";
    params.push(scope.sharedWorkspaceId);
  } else {
    sql += "\n  AND shared_workspace_id IS NULL";
  }
  const row = db.prepare(sql).get(...params) as { id?: string } | undefined;
  if (row?.id && String(row.id) !== String(ignoreGroupId ?? "")) {
    throw new Error("会话分组名称已存在");
  }
}

/** 校验共享工作区分组维护权限；本地工作区默认允许。 */
function assertThreadGroupManageAllowed(
  group: ThreadGroupRow,
  scope: ThreadGroupScope,
  actor: { actorUserId?: string | null; actorIsAdmin?: boolean },
): void {
  if (!scope.sharedWorkspaceId) return;
  if (!canManageThreadGroup(group, { sharedWorkspaceId: scope.sharedWorkspaceId, ...actor })) {
    throw new Error("无权限维护该会话分组");
  }
}

/** 判断当前操作者能否维护分组；本地分组不做成员权限限制。 */
function canManageThreadGroup(
  group: ThreadGroupRow,
  opts: { sharedWorkspaceId?: SharedWorkspaceId | string | null; actorUserId?: string | null; actorIsAdmin?: boolean },
): boolean {
  const sharedWorkspaceId = String(opts.sharedWorkspaceId ?? "").trim();
  if (!sharedWorkspaceId) return true;
  if (opts.actorIsAdmin) return true;
  const actorUserId = String(opts.actorUserId ?? "").trim();
  return Boolean(actorUserId && actorUserId === String(group.created_by_user_id ?? "").trim());
}

/** 归一化分组域，避免本地和共享工作区分组串用。 */
function normalizeThreadGroupScope(workspaceId: WorkspaceId, sharedWorkspaceId: SharedWorkspaceId | null | undefined): ThreadGroupScope {
  const workspaceIdText = String(workspaceId ?? "").trim();
  if (!workspaceIdText) throw new Error("workspaceId 不能为空");
  return {
    workspaceId: workspaceIdText,
    sharedWorkspaceId: normalizeSharedWorkspaceId(sharedWorkspaceId),
  };
}

/** 归一化分组名称；名称为空或过长时显式失败。 */
function normalizeThreadGroupName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (!name) throw new Error("会话分组名称不能为空");
  if (name.length > 60) throw new Error("会话分组名称不能超过 60 个字符");
  return name;
}

/** 生成分组名称唯一键，当前按大小写不敏感比较。 */
function makeThreadGroupNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** 归一化分组 ID；空值表示未分组或不过滤。 */
function normalizeThreadGroupId(raw: unknown): ThreadGroupId | null {
  const value = String(raw ?? "").trim();
  return value ? (value as ThreadGroupId) : null;
}

/** 列表 groupId 入参归一化；空值表示不过滤。 */
function normalizeThreadGroupFilter(raw: unknown): ThreadGroupId | "ungrouped" | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return value === "ungrouped" ? "ungrouped" : (value as ThreadGroupId);
}

/** 判断是否为第一版支持分组的自建会话。 */
function isSelfManagedChatThread(thread: Pick<PersistedThread, "threadType" | "threadSubtype">): boolean {
  return thread.threadType === "chat" && thread.threadSubtype == null;
}

type ThreadListSortSpec = {
  sort: ThreadListSort;
  direction: "ASC" | "DESC";
  valueKind: "number" | "string";
  valueExpr: string;
  orderExpr: string;
};

type ThreadListCursor = {
  pinnedAt: number;
  value: number | string;
  id: string;
};

type ThreadListCursorRow = {
  id: string;
  title: string;
  pinned_at: number | null;
  created_at: number;
  updated_at: number;
};

const THREAD_ACTIVITY_AT_SQL = "CASE WHEN updated_at > 0 THEN updated_at ELSE created_at END";

/** 生成会话列表排序 SQL 片段；置顶排序由调用处固定前置。 */
function resolveThreadListSortSpec(raw: ThreadListSort | null | undefined): ThreadListSortSpec {
  const sort = normalizeThreadListSort(raw, "activity_desc");
  if (sort === "activity_asc") {
    return { sort, direction: "ASC", valueKind: "number", valueExpr: THREAD_ACTIVITY_AT_SQL, orderExpr: `${THREAD_ACTIVITY_AT_SQL} ASC` };
  }
  if (sort === "created_desc") {
    return { sort, direction: "DESC", valueKind: "number", valueExpr: "created_at", orderExpr: "created_at DESC" };
  }
  if (sort === "created_asc") {
    return { sort, direction: "ASC", valueKind: "number", valueExpr: "created_at", orderExpr: "created_at ASC" };
  }
  if (sort === "title_asc") {
    return { sort, direction: "ASC", valueKind: "string", valueExpr: "LOWER(title)", orderExpr: "LOWER(title) ASC" };
  }
  if (sort === "title_desc") {
    return { sort, direction: "DESC", valueKind: "string", valueExpr: "LOWER(title)", orderExpr: "LOWER(title) DESC" };
  }
  return { sort: "activity_desc", direction: "DESC", valueKind: "number", valueExpr: THREAD_ACTIVITY_AT_SQL, orderExpr: `${THREAD_ACTIVITY_AT_SQL} DESC` };
}

/** 解析列表游标；非法游标按无游标处理，保留旧 created-desc 游标兼容。 */
function parseThreadListCursor(raw: string | null, sortSpec: ThreadListSortSpec): ThreadListCursor | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const pinnedAt = Number(parsed.pinnedAt ?? 0);
    const id = String(parsed.id ?? "").trim();
    if (!Number.isFinite(pinnedAt) || !id) return null;
    if (sortSpec.valueKind === "number") {
      const value = Number(parsed.value);
      return Number.isFinite(value) ? { pinnedAt, value, id } : null;
    }
    return { pinnedAt, value: String(parsed.value ?? ""), id };
  } catch {
    return parseLegacyThreadListCursor(text, sortSpec);
  }
}

/** 兼容旧版 pinned:sortValue:id 游标，避免升级瞬间的下一页请求直接失效。 */
function parseLegacyThreadListCursor(raw: string, sortSpec: ThreadListSortSpec): ThreadListCursor | null {
  if (sortSpec.sort !== "created_desc" && sortSpec.sort !== "activity_desc") return null;
  const sep = raw.indexOf(":");
  const lastSep = raw.lastIndexOf(":");
  if (sep <= 0 || lastSep <= sep) return null;
  const pinnedAt = Number(raw.substring(0, sep));
  const value = Number(raw.substring(sep + 1, lastSep));
  const id = raw.substring(lastSep + 1);
  if (!Number.isFinite(pinnedAt) || !Number.isFinite(value) || !id) return null;
  return { pinnedAt, value, id };
}

/** 序列化列表游标；cursor 是服务端内部不透明值。 */
function stringifyThreadListCursor(row: ThreadListCursorRow, sortSpec: ThreadListSortSpec): string {
  const value = sortSpec.valueKind === "number"
    ? resolveThreadListNumericSortValue(row, sortSpec)
    : String(row.title ?? "").toLowerCase();
  return JSON.stringify({
    pinnedAt: Number(row.pinned_at ?? 0),
    value,
    id: String(row.id),
  });
}

function resolveThreadListNumericSortValue(row: ThreadListCursorRow, sortSpec: ThreadListSortSpec): number {
  if (sortSpec.sort.startsWith("created")) return Number(row.created_at ?? 0);
  return resolveThreadActivityAt(row);
}

function resolveThreadListFilter(scope: ThreadListScope | null | undefined, includeArchived: boolean): ThreadListScope | "unarchived" {
  if (scope === "all" || scope === "current" || scope === "archived" || scope === "orchestration" || scope === "knowledge") {
    return scope;
  }
  return includeArchived ? "all" : "unarchived";
}

function parseThreadSessionCapabilities(raw: string | null | undefined): ThreadSessionCapabilities | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const ids = Array.isArray(parsed.codexDynamicToolIds)
      ? parsed.codexDynamicToolIds.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    const bindingVersion = String(parsed.codexDynamicToolBindingVersion ?? "").trim() || null;
    if (!ids.length && !bindingVersion) return null;
    return {
      codexDynamicToolIds: ids.length ? Array.from(new Set(ids)).sort() : null,
      codexDynamicToolBindingVersion: bindingVersion,
    };
  } catch {
    return null;
  }
}

function serializeThreadSessionCapabilities(capabilities: ThreadSessionCapabilities | null | undefined): string | null {
  const ids = Array.isArray(capabilities?.codexDynamicToolIds)
    ? capabilities!.codexDynamicToolIds!.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const bindingVersion = String(capabilities?.codexDynamicToolBindingVersion ?? "").trim() || null;
  if (!ids.length && !bindingVersion) return null;
  return JSON.stringify({
    codexDynamicToolIds: ids.length ? Array.from(new Set(ids)).sort() : null,
    codexDynamicToolBindingVersion: bindingVersion,
  });
}

/** 归一化共享会话 ACL 输入；空输入表示普通本地会话。 */
function normalizeThreadSharedAcl(input: ThreadSharedAclInput | null | undefined, fallbackUpdatedAt: number): {
  sharedWorkspaceId: SharedWorkspaceId;
  ownerUserId: string;
  visibility: SharedWorkspaceContextVisibility;
  participantUserIds: string[];
  updatedAt: number;
} | null {
  if (!input) return null;
  const sharedWorkspaceId = normalizeSharedWorkspaceId(input.sharedWorkspaceId);
  const ownerUserId = normalizeUserId(input.ownerUserId);
  if (!sharedWorkspaceId || !ownerUserId) {
    throw new Error("Invalid shared thread ACL: sharedWorkspaceId/ownerUserId required");
  }
  return {
    sharedWorkspaceId,
    ownerUserId,
    visibility: normalizeSharedVisibility(input.visibility) ?? "participants",
    participantUserIds: normalizeUserIds(input.participantUserIds ?? []),
    updatedAt: normalizeTimestamp(input.updatedAt) ?? fallbackUpdatedAt,
  };
}

/** 比较持久化 ACL 与同版本下发内容，防止相同时间戳覆盖冲突数据。 */
function matchesPersistedSharedAcl(
  thread: PersistedThread,
  acl: NonNullable<ReturnType<typeof normalizeThreadSharedAcl>>,
): boolean {
  return String(thread.sharedWorkspaceId ?? "") === String(acl.sharedWorkspaceId)
    && String(thread.ownerUserId ?? "") === acl.ownerUserId
    && thread.sharedVisibility === acl.visibility
    && JSON.stringify(normalizeUserIds(thread.sharedParticipantUserIds)) === JSON.stringify(acl.participantUserIds);
}

/** 序列化共享参与人列表；空数组也写成 JSON，避免 SQL json_each 读取不确定值。 */
function serializeSharedParticipantUserIds(userIds: string[]): string {
  return JSON.stringify(normalizeUserIds(userIds));
}

/** 解析共享参与人 JSON；格式错误显式失败，避免权限判断失真。 */
function parseSharedParticipantUserIds(raw: string | null | undefined): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid shared participant user ids JSON");
  }
  return normalizeUserIds(parsed);
}

/** 归一化 userId 列表并去重，保证 ACL JSON 稳定。 */
function normalizeUserIds(raw: unknown[] | readonly unknown[]): string[] {
  const userIds = raw
    .map((item) => normalizeUserId(item))
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(userIds)).sort();
}

/** 读取非空 userId；空值返回 null。 */
function normalizeUserId(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return value || null;
}

/** 读取非空共享工作区 ID；空值返回 null。 */
function normalizeSharedWorkspaceId(raw: unknown): SharedWorkspaceId | null {
  const value = String(raw ?? "").trim();
  return value ? (value as SharedWorkspaceId) : null;
}

/** 限定共享会话可见性枚举，未知值交给调用方默认。 */
function normalizeSharedVisibility(raw: unknown): SharedWorkspaceContextVisibility | null {
  return raw === "private" || raw === "participants" || raw === "team" ? raw : null;
}

/** 读取正整数毫秒时间戳；无效值返回 null。 */
function normalizeTimestamp(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** 活跃会话工作流原始行：只带判定所需的原始列，档位归并交给调用方。 */
export type ActiveChatWorkflowRow = {
  threadId: string;
  taskId: string;
  instanceId: string | null;
  taskState: string;
  instanceStatus: string | null;
  createdAt: number;
};

/**
 * 活跃会话工作流的唯一判定片段：状态字面量由共享枚举生成，使列表徽标与删除门禁的口径在结构上不可能漂移。
 * 返回的 sql 仅是可拼接进 WHERE 的括号条件，params 与之顺序对应。
 */
function buildActiveChatWorkflowFilter(): { sql: string; params: string[] } {
  const placeholders = CHAT_WORKFLOW_ACTIVE_STATUS_LIST.map(() => "?").join(", ");
  return {
    sql: `(task.state = 'starting' OR instance.status IN (${placeholders}))`,
    params: [...CHAT_WORKFLOW_ACTIVE_STATUS_LIST],
  };
}

/** 归一化内部批量清理 ID，保留顺序并去重。 */
function normalizeCleanupThreadIds(threadIds: ReadonlyArray<ThreadId>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const threadId of threadIds) {
    const value = String(threadId ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/** Client 清理只把这三种编排状态视为不可再运行的终态。 */
function isCleanupTerminalOrchestrationStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** 严格读取编排节点状态，坏 JSON 必须中止清理。 */
function parseOrchestrationNodeStates(raw: string, instanceId: string): Record<string, Record<string, unknown>> {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("node_states_json 不是对象");
    }
    for (const [nodeId, state] of Object.entries(parsed)) {
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new Error(`节点状态不是对象：${nodeId}`);
      }
    }
    return parsed as Record<string, Record<string, unknown>>;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`会话清理无法解析编排节点状态：instanceId=${instanceId} ${message}`);
  }
}

/** 收集节点状态内所有会话引用，用于活跃编排阻断。 */
function collectOrchestrationThreadReferences(raw: string, instanceId: string): Set<string> {
  const references = new Set<string>();
  const nodeStates = parseOrchestrationNodeStates(raw, instanceId);
  for (const [nodeId, state] of Object.entries(nodeStates)) {
    for (const field of ["threadId", "discussionThreadId"] as const) {
      const value = normalizeOrchestrationThreadReference(state[field], instanceId, nodeId, field);
      if (value) references.add(value);
    }
    const previousThreadIds = state.previousThreadIds;
    if (previousThreadIds == null) continue;
    if (!Array.isArray(previousThreadIds)) {
      throw new Error(`会话清理发现非法 previousThreadIds：instanceId=${instanceId} nodeId=${nodeId}`);
    }
    for (const value of previousThreadIds) {
      const threadId = normalizeOrchestrationThreadReference(value, instanceId, nodeId, "previousThreadIds");
      if (threadId) references.add(threadId);
    }
  }
  return references;
}

/** 清除节点状态内命中的会话引用，并返回稳定 JSON。 */
function rewriteOrchestrationThreadReferences(
  raw: string,
  instanceId: string,
  targetIds: ReadonlySet<string>,
): { changed: boolean; json: string } {
  const nodeStates = parseOrchestrationNodeStates(raw, instanceId);
  let changed = false;
  for (const [nodeId, state] of Object.entries(nodeStates)) {
    for (const field of ["threadId", "discussionThreadId"] as const) {
      const value = normalizeOrchestrationThreadReference(state[field], instanceId, nodeId, field);
      if (!value || !targetIds.has(value)) continue;
      state[field] = null;
      changed = true;
    }
    const previousThreadIds = state.previousThreadIds;
    if (previousThreadIds == null) continue;
    if (!Array.isArray(previousThreadIds)) {
      throw new Error(`会话清理发现非法 previousThreadIds：instanceId=${instanceId} nodeId=${nodeId}`);
    }
    const filtered = previousThreadIds.filter((value) => {
      const threadId = normalizeOrchestrationThreadReference(value, instanceId, nodeId, "previousThreadIds");
      return !threadId || !targetIds.has(threadId);
    });
    if (filtered.length === previousThreadIds.length) continue;
    state.previousThreadIds = filtered;
    changed = true;
  }
  return { changed, json: changed ? JSON.stringify(nodeStates) : raw };
}

/** 校验编排 JSON 中的可选 threadId；空值返回 null。 */
function normalizeOrchestrationThreadReference(
  raw: unknown,
  instanceId: string,
  nodeId: string,
  field: string,
): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new Error(`会话清理发现非法 ${field}：instanceId=${instanceId} nodeId=${nodeId}`);
  }
  return raw.trim() || null;
}

function normalizeThreadType(raw: unknown): ThreadType {
  return raw === "orchestration" ? "orchestration" : "chat";
}

/** 仅接受已知会话类型，保留内部复检的可见性边界。 */
function normalizeThreadSubtype(raw: unknown, threadType: ThreadType): ThreadSubtype | null {
  if (threadType === "orchestration") {
    return raw === "master" || raw === "node" || raw === "asset-draft" || raw === "knowledge-assets" || raw === "knowledge-review" || raw === "gate-evaluation" ? raw : null;
  }
  return raw === "requirement-analysis" || raw === "node-discussion" || raw === "knowledge-conversation" ? raw : null;
}

function normalizeAccessMode(raw: unknown): AccessMode | null {
  const value = String(raw ?? "").trim();
  return value === "read-only" || value === "current" || value === "full-access"
    ? value
    : null;
}

/** 归一化置顶时间；非正数视为未置顶。 */
function normalizePinnedAt(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/** 列表活动时间：updated_at 缺失时回退 created_at。 */
function resolveThreadActivityAt(row: { created_at?: number | null; updated_at?: number | null }): number {
  const updatedAt = Number(row.updated_at ?? 0);
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  const createdAt = Number(row.created_at ?? 0);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0;
}

/** 规整事件高水位；空表或非法值统一为 0。 */
function normalizeCleanupHighWater(raw: unknown): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** 合并已定义的偏好补丁；省略字段保留旧值，显式 null 继续表示清空。 */
function mergeDefinedThreadPrefs(
  current: ThreadPrefs | null | undefined,
  patch: ThreadPrefs | null | undefined,
): ThreadPrefs {
  if (!patch || typeof patch !== "object") return { ...(current ?? {}) };
  const definedPatch: ThreadPrefs = {};
  if (patch.model !== undefined) definedPatch.model = patch.model;
  if (patch.effort !== undefined) definedPatch.effort = patch.effort;
  if (patch.accessMode !== undefined) definedPatch.accessMode = patch.accessMode;
  if (patch.planMode !== undefined) definedPatch.planMode = patch.planMode;
  if (patch.knowledgeEnabled !== undefined) definedPatch.knowledgeEnabled = patch.knowledgeEnabled;
  if (patch.autoCompactPct !== undefined) definedPatch.autoCompactPct = patch.autoCompactPct;
  if (patch.contextWindow !== undefined) definedPatch.contextWindow = patch.contextWindow;
  // 清空模型表示恢复引擎默认，未显式指定窗口时一并清除旧模型的窗口覆盖。
  else if (patch.model === null) definedPatch.contextWindow = null;
  if (patch.serviceTier !== undefined) definedPatch.serviceTier = patch.serviceTier;
  if (patch.roleId !== undefined) definedPatch.roleId = patch.roleId;
  return mergeThreadPrefs(current, definedPatch);
}

/** 规整偏好输入；省略的 Fast 档位交由目录默认值解析，null 表示关闭。 */
function normalizeThreadPrefsInput(
  threadSubtype: ThreadSubtype | null,
  prefs: ThreadPrefs | null | undefined,
): ThreadPrefs | null {
  if (!prefs || typeof prefs !== "object") return null;
  const normalized: ThreadPrefs = {
    model: typeof prefs.model === "string" ? String(prefs.model).trim() || null : null,
    effort: typeof prefs.effort === "string" ? String(prefs.effort).trim() || null : null,
    accessMode: normalizeAccessMode(prefs.accessMode),
    planMode: prefs.planMode != null ? Boolean(prefs.planMode) : null,
    knowledgeEnabled: prefs.knowledgeEnabled != null ? Boolean(prefs.knowledgeEnabled) : null,
    autoCompactPct: normalizeAutoCompactPct(prefs.autoCompactPct),
    contextWindow: normalizeContextWindow(prefs.contextWindow),
    serviceTier: prefs.serviceTier === undefined ? undefined : normalizeServiceTier(prefs.serviceTier),
    roleId: threadSubtype == null ? normalizeRoleId(prefs.roleId) : null,
  };
  if (threadSubtype === "node-discussion" || threadSubtype === "knowledge-conversation" || threadSubtype === "knowledge-assets" || threadSubtype === "knowledge-review") {
    normalized.accessMode = "read-only";
    normalized.planMode = false;
  }
  return normalized;
}

/** 内部知识执行始终只读，模型偏好沿用现有目录解析入口。 */
function resolvePersistedThreadPrefs(
  engine: EngineType,
  threadSubtype: ThreadSubtype | null,
  prefs: ThreadPrefs | null | undefined,
  models?: EngineModelInfo[] | null,
): ThreadPrefs {
  const normalizedInput = normalizeThreadPrefsInput(threadSubtype, prefs);
  const knowledgeEnabled = threadSubtype == null && normalizedInput?.knowledgeEnabled === true;
  if (models === null) {
    return {
      ...(normalizedInput ?? {}),
      accessMode: threadSubtype === "node-discussion" ? "read-only" : normalizedInput?.accessMode ?? null,
      planMode: threadSubtype === "node-discussion" ? false : normalizedInput?.planMode ?? null,
      knowledgeEnabled,
    };
  }
  const resolved = resolveThreadPrefsWithCatalogDefaults(engine, normalizedInput, models);
  const persisted: ThreadPrefs = {
    model: resolved.model,
    effort: resolved.effort,
    accessMode: resolved.accessMode,
    planMode: resolved.planMode,
    knowledgeEnabled,
    autoCompactPct: resolved.autoCompactPct,
    contextWindow: resolved.contextWindow,
    serviceTier: resolved.serviceTier,
    roleId: normalizedInput?.roleId ?? null,
  };
  if (threadSubtype === "node-discussion" || threadSubtype === "knowledge-conversation" || threadSubtype === "knowledge-assets" || threadSubtype === "knowledge-review") {
    persisted.accessMode = "read-only";
    persisted.planMode = false;
  }
  return persisted;
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

/** 归一化列表标题搜索词；空白值不参与 DB 过滤。 */
function normalizeThreadTitleSearch(raw: unknown): string {
  return String(raw ?? "").trim();
}

/** 转义 SQLite LIKE 通配符，保证用户输入按普通文本匹配。 */
function escapeSqlLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (match) => `!${match}`);
}

/** 归一化 Codex 服务档位；未知值一律按标准档处理。 */
function normalizeServiceTier(raw: unknown): CodexServiceTier | null {
  return raw === "fast" ? "fast" : null;
}

/** 归一化普通聊天角色 ID；空值表示不启用角色注入。 */
function normalizeRoleId(raw: unknown): RoleId | null {
  const value = String(raw ?? "").trim();
  return value ? (value as RoleId) : null;
}

