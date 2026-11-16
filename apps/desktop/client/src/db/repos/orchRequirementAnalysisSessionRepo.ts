import crypto from "node:crypto";

import type {
  ListStatusCount,
  NodeExecutionProfileScope,
  RequirementAnalysisSession,
  RequirementAnalysisSessionId,
  RequirementAnalysisSessionListMeta,
  RequirementDraftListStatus,
  ThreadId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import { readIntakeWorkspaceScope } from "./orchIntakeRepo.js";

const STATUS_COUNT_CACHE_TTL_MS = 30_000;

export type RequirementAnalysisWorkspaceScopeRow = Pick<RequirementAnalysisSession, "id" | "workspaceId" | "runtimeThreadId" | "workspaceScope">;

export class OrchRequirementAnalysisSessionRepoError extends Error {
  /** 只传递固定诊断与实体身份，正文和原始 JSON 不进入异常链。 */
  constructor(
    readonly code: "ORCH_REQUIREMENT_ANALYSIS_SCOPE_INVALID" | "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT" | "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID" | "ORCH_REQUIREMENT_ANALYSIS_SESSION_NOT_FOUND",
    readonly details: { sessionId: string; workspaceId: string },
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "OrchRequirementAnalysisSessionRepoError";
  }
}

/** 需求分析助手会话仓储。 */
export class OrchRequirementAnalysisSessionRepo {
  private readonly deleteStmt;
  private readonly deleteByThreadIdStmt;
  private readonly deleteOrphanedByWorkspaceStmt;

  constructor(private readonly db: SqliteDb) {
    this.deleteStmt = this.db.prepare("DELETE FROM orch_requirement_analysis_sessions WHERE id = ?");
    this.deleteByThreadIdStmt = this.db.prepare(
      `DELETE FROM orch_requirement_analysis_sessions
        WHERE id = ? OR runtime_thread_id = ?`,
    );
    this.deleteOrphanedByWorkspaceStmt = this.db.prepare(
      `DELETE FROM orch_requirement_analysis_sessions
        WHERE workspace_id = ?
          AND NOT EXISTS (
            SELECT 1
              FROM threads t
             WHERE t.id = COALESCE(NULLIF(TRIM(orch_requirement_analysis_sessions.runtime_thread_id), ''), orch_requirement_analysis_sessions.id)
               AND t.workspace_id = orch_requirement_analysis_sessions.workspace_id
               AND COALESCE(t.thread_subtype, '') = 'requirement-analysis'
          )`,
    );
  }

  /** 仅读归属列；单线程按可信同 ID 查询，全集保留跨工作区同 ID 冲突且不修复投影。 */
  listWorkspaceScopeRows(workspaceId: WorkspaceId, threadId?: ThreadId): RequirementAnalysisWorkspaceScopeRow[] {
    const rows = this.db.prepare(
      `SELECT s.id, s.workspace_id, s.runtime_thread_id, s.workspace_scope_json
       FROM orch_requirement_analysis_sessions s
       WHERE ${threadId === undefined ? `s.workspace_id = ? OR s.id IN (
         SELECT t.id FROM threads t WHERE t.workspace_id = ? AND t.thread_subtype = 'requirement-analysis'
       )` : "s.id = ?"}`,
    ).all(...(threadId === undefined ? [String(workspaceId), String(workspaceId)] : [String(threadId)])) as any[];
    return rows.map(row => ({
      id: row.id as RequirementAnalysisSessionId,
      workspaceId: row.workspace_id as WorkspaceId,
      runtimeThreadId: row.runtime_thread_id as ThreadId | null,
      workspaceScope: readRowWorkspaceScope(row),
    }));
  }

  /** 列表与单条读取沿用同一归属解析，坏记录显式失败。 */
  listByWorkspace(
    workspaceId: WorkspaceId,
    opts?: {
      includeArchived?: boolean;
      limit?: number;
      cursor?: string | null;
      allowedResourceIds?: string[] | null;
      localThreadIds?: readonly ThreadId[];
      search?: string | null;
      statuses?: RequirementDraftListStatus[] | null;
    },
  ): {
    sessions: RequirementAnalysisSession[];
    hasMore: boolean;
    nextCursor: string | null;
    totalCount: number;
    statusCounts: Array<ListStatusCount<RequirementDraftListStatus>>;
    listMetaById: Record<string, RequirementAnalysisSessionListMeta>;
  } {
    return this.readListByWorkspace(workspaceId, opts);
  }

  /** 本机列表不清理或修复派生数据，统计与分页在调用方同步事务内完成。 */
  private readListByWorkspace(workspaceId: WorkspaceId, opts?: { includeArchived?: boolean; limit?: number; cursor?: string | null; allowedResourceIds?: string[] | null; localThreadIds?: readonly ThreadId[]; search?: string | null; statuses?: RequirementDraftListStatus[] | null }): ReturnType<OrchRequirementAnalysisSessionRepo["listByWorkspace"]> {
    const includeArchived = Boolean(opts?.includeArchived ?? true);
    const limit = Math.min(Math.max(1, Number(opts?.limit ?? 100) || 100), 500);
    const cursor = String(opts?.cursor ?? "").trim() || null;
    const allowedIds = normalizeAllowedResourceIds(opts?.allowedResourceIds);
    if (allowedIds && allowedIds.length === 0) {
      return { sessions: [], hasMore: false, nextCursor: null, totalCount: 0, statusCounts: [], listMetaById: {} };
    }
    const search = normalizeSearch(opts?.search);
    const statuses = normalizeRequirementDraftListStatuses(opts?.statuses);
    if (opts?.localThreadIds === undefined) this.ensureSearchProjection(workspaceId);

    const effectiveUpdatedAtExpr = "CASE WHEN COALESCE(t.updated_at, 0) > COALESCE(s.updated_at, 0) THEN t.updated_at ELSE s.updated_at END";

    let sql = `SELECT s.id, s.workspace_id, s.workspace_scope_json,
                      COALESCE(NULLIF(TRIM(t.title), ''), s.title) AS title,
                      CASE WHEN COALESCE(t.archived, 0) = 1 THEN 'archived' ELSE s.status END AS status,
                      s.phase,
                      COALESCE(NULLIF(TRIM(t.engine), ''), s.engine) AS engine,
                      COALESCE(t.model, s.model) AS model,
                      COALESCE(t.effort, s.effort) AS effort,
                      COALESCE(NULLIF(TRIM(s.runtime_thread_id), ''), t.id) AS runtime_thread_id,
                      COALESCE(NULLIF(TRIM(t.session_id), ''), s.engine_session_id) AS engine_session_id,
                      s.latest_turn_summary,
                      s.latest_assistant_reply,
                      s.last_message_at,
                      s.created_at,
                      ${effectiveUpdatedAtExpr} AS updated_at,
                      COALESCE(candidate_stats.candidate_count, 0) AS candidate_count,
                      COALESCE(candidate_stats.ready_candidate_count, 0) AS ready_candidate_count,
                      COALESCE(candidate_stats.created_candidate_count, 0) AS created_candidate_count,
                      COALESCE(candidate_stats.pending_candidate_count, 0) AS pending_candidate_count,
                      candidate_stats.recommended_workflow_names,
                      ${listStatusExpr()} AS list_status
               FROM orch_requirement_analysis_sessions s
               INNER JOIN threads t
                  ON t.id = COALESCE(NULLIF(TRIM(s.runtime_thread_id), ''), s.id)
                 AND t.workspace_id = s.workspace_id
                 AND COALESCE(t.thread_subtype, '') = 'requirement-analysis'
               LEFT JOIN (
                 SELECT session_id,
                        COUNT(*) AS candidate_count,
                        SUM(CASE
                              WHEN ready_to_create = 1
                                AND instr(candidate_json, '"creationState":"created"') = 0
                              THEN 1 ELSE 0
                            END) AS ready_candidate_count,
                        SUM(CASE
                              WHEN instr(candidate_json, '"creationState":"created"') > 0
                              THEN 1 ELSE 0
                            END) AS created_candidate_count,
                        SUM(CASE
                              WHEN ready_to_create = 0
                                AND instr(candidate_json, '"creationState":"created"') = 0
                              THEN 1 ELSE 0
                            END) AS pending_candidate_count,
                        GROUP_CONCAT(DISTINCT json_extract(candidate_json, '$.recommendedWorkflowName')) AS recommended_workflow_names
                 FROM orch_requirement_candidate_drafts
                 GROUP BY session_id
                ) candidate_stats
                  ON candidate_stats.session_id = s.id
                WHERE s.workspace_id = ? AND (? OR COALESCE(t.archived, 0) = 0)`;
    const params: Array<string | number> = [String(workspaceId), includeArchived ? 1 : 0];
    if (opts?.localThreadIds !== undefined) {
      sql += " AND s.id IN (SELECT value FROM json_each(?))";
      params.push(JSON.stringify(opts.localThreadIds));
    }

    if (allowedIds) {
      sql += ` AND s.id IN (${allowedIds.map(() => "?").join(", ")})`;
      params.push(...allowedIds);
    }
    if (search) {
      const ftsQuery = buildFtsQuery(search);
      if (ftsQuery) {
        sql += ` AND EXISTS (
          SELECT 1 FROM orch_requirement_analysis_search_fts f
          WHERE f.workspace_id = s.workspace_id
            AND f.session_id = s.id
            AND orch_requirement_analysis_search_fts MATCH ?
        )`;
        params.push(ftsQuery);
      } else {
        sql += ` AND EXISTS (
          SELECT 1 FROM orch_requirement_analysis_search_fts f
          WHERE f.workspace_id = s.workspace_id
            AND f.session_id = s.id
            AND (f.title LIKE ? ESCAPE '\\' OR f.summary LIKE ? ESCAPE '\\')
        )`;
        const keyword = `%${escapeLike(search)}%`;
        params.push(keyword, keyword);
      }
    }
    const countBaseSql = sql;
    const countBaseParams = [...params];
    if (statuses.length > 0) {
      sql += ` AND ${listStatusExpr()} IN (${statuses.map(() => "?").join(", ")})`;
      params.push(...statuses);
    } else {
      sql += ` AND ${listStatusExpr()} <> 'archived'`;
    }

    if (cursor) {
      const sep = cursor.indexOf(":");
      if (sep > 0) {
        const cursorSort = Number(cursor.substring(0, sep));
        const cursorId = cursor.substring(sep + 1);
        if (Number.isFinite(cursorSort) && cursorId) {
          sql += ` AND (${effectiveUpdatedAtExpr} < ? OR (${effectiveUpdatedAtExpr} = ? AND s.id < ?))`;
          params.push(cursorSort, cursorSort, cursorId);
        }
      }
    }

    sql += ` ORDER BY ${effectiveUpdatedAtExpr} DESC, s.id DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as any[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const sessions = page.map(rowToSession);

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1]!;
      nextCursor = `${Number(last.updated_at ?? 0)}:${String(last.id)}`;
    }

    const totalStatusSql = statuses.length > 0
      ? ` AND ${listStatusExpr()} IN (${statuses.map(() => "?").join(", ")})`
      : ` AND ${listStatusExpr()} <> 'archived'`;
    const totalRow = this.db.prepare(`SELECT COUNT(1) AS total FROM (${countBaseSql}${totalStatusSql}) AS scoped`)
      .get(...countBaseParams, ...statuses) as { total?: number } | undefined;
    const countRows = opts?.localThreadIds === undefined
      ? this.readOrComputeStatusCounts(workspaceId, search, allowedIds, countBaseSql, countBaseParams)
      : this.db.prepare(`SELECT list_status AS status, COUNT(1) AS count FROM (${countBaseSql}) AS scoped GROUP BY list_status`).all(...countBaseParams) as Array<{ status: RequirementDraftListStatus; count: number }>;

    return {
      sessions,
      hasMore,
      nextCursor,
      totalCount: Number(totalRow?.total ?? 0),
      statusCounts: countRows.map((row) => ({
        status: row.status,
        label: requirementDraftStatusLabel(row.status),
        count: Number(row.count ?? 0),
      })),
      listMetaById: Object.fromEntries(page.map((row) => {
        const status = normalizeRequirementDraftListStatus(row.list_status) ?? "clarifying";
        return [String(row.id), {
          listStatus: status,
          listStatusLabel: requirementDraftStatusLabel(status),
          recommendedWorkflowName: resolveRecommendedWorkflowName(row.recommended_workflow_names),
        } satisfies RequirementAnalysisSessionListMeta] as const;
      })),
    };
  }

  /** 读取列式会话事实，缺列或损坏归属不得被解释为未知。 */
  get(id: RequirementAnalysisSessionId): RequirementAnalysisSession | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.workspace_id, s.workspace_scope_json, s.title, s.status, s.phase, s.engine, s.model, s.effort,
                s.runtime_thread_id, s.engine_session_id, s.latest_turn_summary,
                s.latest_assistant_reply, s.last_message_at, s.created_at, s.updated_at,
                COALESCE(candidate_stats.candidate_count, 0) AS candidate_count,
                COALESCE(candidate_stats.ready_candidate_count, 0) AS ready_candidate_count,
                COALESCE(candidate_stats.created_candidate_count, 0) AS created_candidate_count,
                COALESCE(candidate_stats.pending_candidate_count, 0) AS pending_candidate_count
         FROM orch_requirement_analysis_sessions s
         LEFT JOIN (
           SELECT session_id,
                  COUNT(*) AS candidate_count,
                  SUM(CASE
                        WHEN ready_to_create = 1
                          AND instr(candidate_json, '"creationState":"created"') = 0
                        THEN 1 ELSE 0
                      END) AS ready_candidate_count,
                  SUM(CASE
                        WHEN instr(candidate_json, '"creationState":"created"') > 0
                        THEN 1 ELSE 0
                      END) AS created_candidate_count,
                  SUM(CASE
                        WHEN ready_to_create = 0
                          AND instr(candidate_json, '"creationState":"created"') = 0
                        THEN 1 ELSE 0
                      END) AS pending_candidate_count
           FROM orch_requirement_candidate_drafts
           GROUP BY session_id
         ) candidate_stats
           ON candidate_stats.session_id = s.id
         WHERE s.id = ?`,
      )
      .get(String(id)) as any | undefined;
    return row ? rowToSession(row) : null;
  }

  /** 校验并复制归属，事实、搜索投影与计数失效同事务提交。 */
  create(input: Omit<RequirementAnalysisSession, "createdAt" | "updatedAt" | "lastMessageAt"> & {
    lastMessageAt?: number;
  }): RequirementAnalysisSession {
    const id = (String((input as any).id ?? "").trim() || crypto.randomUUID()) as RequirementAnalysisSessionId;
    const now = Date.now();
    const session: RequirementAnalysisSession = {
      ...input,
      id,
      workspaceScope: readSessionWorkspaceScope(input.workspaceScope, input.workspaceId, id),
      lastMessageAt: Number(input.lastMessageAt ?? now),
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO orch_requirement_analysis_sessions (
            id, workspace_id, title, status, phase, engine, model, effort,
            runtime_thread_id, engine_session_id, latest_turn_summary,
            latest_assistant_reply, last_message_at, created_at, updated_at, workspace_scope_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          String(session.workspaceId),
          String(session.title ?? "").trim(),
          String(session.status),
          String(session.phase),
          String(session.engine),
          nullableString(session.model),
          nullableString(session.effort),
          nullableString(session.runtimeThreadId),
          nullableString(session.engineSessionId),
          nullableString(session.latestTurnSummary),
          nullableString(session.latestAssistantReply),
          session.lastMessageAt,
          session.createdAt,
          session.updatedAt,
          session.workspaceScope ? JSON.stringify(session.workspaceScope) : null,
        );
      this.upsertSearchProjection(session);
      this.clearCountCache(session.workspaceId);
    })();
    return session;
  }

  /** 同事务读取和比较原归属，禁止重绑、移除、跨工作区或认领未知记录。 */
  update(session: RequirementAnalysisSession): RequirementAnalysisSession {
    return this.db.transaction(() => {
      const details = { sessionId: String(session.id), workspaceId: String(session.workspaceId) };
      const existing = this.get(session.id);
      if (!existing) throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_SESSION_NOT_FOUND", details);
      if (existing.workspaceId !== session.workspaceId) {
        throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", details);
      }
      const workspaceScope = readSessionWorkspaceScope(session.workspaceScope, session.workspaceId, session.id);
      const existingScope = existing.workspaceScope ?? null;
      if (session.workspaceScope !== undefined
        && (existingScope?.scopeType !== workspaceScope?.scopeType || existingScope?.scopeId !== workspaceScope?.scopeId)) {
        throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", details);
      }
      const next: RequirementAnalysisSession = {
        ...session,
        workspaceScope: existingScope,
        title: String(session.title ?? "").trim() || "未命名需求分析",
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
      };
      this.db
        .prepare(
          `UPDATE orch_requirement_analysis_sessions
           SET title = ?, status = ?, phase = ?, engine = ?, model = ?, effort = ?,
               runtime_thread_id = ?, engine_session_id = ?, latest_turn_summary = ?,
               latest_assistant_reply = ?, last_message_at = ?, updated_at = ?, workspace_scope_json = ?
           WHERE id = ?`,
        )
        .run(
          next.title,
          String(next.status),
          String(next.phase),
          String(next.engine),
          nullableString(next.model),
          nullableString(next.effort),
          nullableString(next.runtimeThreadId),
          nullableString(next.engineSessionId),
          nullableString(next.latestTurnSummary),
          nullableString(next.latestAssistantReply),
          Number(next.lastMessageAt ?? next.updatedAt),
          next.updatedAt,
          next.workspaceScope ? JSON.stringify(next.workspaceScope) : null,
          String(next.id),
        );
      this.upsertSearchProjection(next);
      this.clearCountCache(next.workspaceId);
      return next;
    })();
  }

  /** 删除需求分析会话，并同步移除搜索投影和状态计数缓存。 */
  delete(id: RequirementAnalysisSessionId): void {
    const existing = this.get(id);
    this.deleteStmt.run(String(id));
    if (existing) {
      this.removeSearchProjection(existing.workspaceId, existing.id);
      this.clearCountCache(existing.workspaceId);
    }
  }

  deleteByThreadId(threadId: string): void {
    const normalized = String(threadId ?? "").trim();
    if (!normalized) return;
    const existing = this.getByIdOrRuntimeThreadId(normalized);
    this.deleteByThreadIdStmt.run(normalized, normalized);
    if (existing) {
      this.removeSearchProjection(existing.workspaceId, existing.id);
      this.clearCountCache(existing.workspaceId);
    }
  }

  /** 按会话 id 或运行线程 id 定位会话，用于删除链路清理派生投影。 */
  private getByIdOrRuntimeThreadId(value: string): RequirementAnalysisSession | null {
    const row = this.db
      .prepare(
        `SELECT id
         FROM orch_requirement_analysis_sessions
         WHERE id = ? OR runtime_thread_id = ?
         LIMIT 1`,
      )
      .get(value, value) as { id?: string } | undefined;
    return row?.id ? this.get(row.id as RequirementAnalysisSessionId) : null;
  }

  deleteOrphanedByWorkspace(workspaceId: WorkspaceId): number {
    const result = this.deleteOrphanedByWorkspaceStmt.run(String(workspaceId));
    if (Number(result.changes ?? 0) > 0) {
      this.rebuildSearchProjection(workspaceId);
      this.clearCountCache(workspaceId);
    }
    return Number(result.changes ?? 0);
  }

  /** 外部写路径改变列表文案或状态时，统一重建搜索投影并失效计数缓存。 */
  invalidateListCaches(workspaceId: WorkspaceId): void {
    this.rebuildSearchProjection(workspaceId);
    this.clearCountCache(workspaceId);
  }

  /** 候选需求变化只影响列表状态计数，不影响标题/摘要搜索投影。 */
  invalidateStatusCountCache(workspaceId: WorkspaceId): void {
    this.clearCountCache(workspaceId);
  }

  /** 确保历史原始需求已有搜索投影；迁移后若只写入了部分新会话，需要回填旧会话。 */
  private ensureSearchProjection(workspaceId: WorkspaceId): void {
    const expectedRow = this.db.prepare(
      "SELECT COUNT(1) AS total FROM orch_requirement_analysis_sessions WHERE workspace_id = ?",
    ).get(String(workspaceId)) as { total?: number } | undefined;
    const expectedCount = Number(expectedRow?.total ?? 0);
    if (expectedCount === 0) return;
    const projectedRow = this.db.prepare(
      "SELECT COUNT(1) AS total FROM orch_requirement_analysis_search_fts WHERE workspace_id = ?",
    ).get(String(workspaceId)) as { total?: number } | undefined;
    if (Number(projectedRow?.total ?? 0) === expectedCount) return;
    this.rebuildSearchProjection(workspaceId);
  }

  private rebuildSearchProjection(workspaceId: WorkspaceId): void {
    const rows = this.db.prepare(
      `SELECT id, workspace_id, title, latest_turn_summary
       FROM orch_requirement_analysis_sessions
       WHERE workspace_id = ?`,
    ).all(String(workspaceId)) as Array<{
      id: string;
      workspace_id: string;
      title: string | null;
      latest_turn_summary: string | null;
    }>;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM orch_requirement_analysis_search_fts WHERE workspace_id = ?").run(String(workspaceId));
      const insert = this.db.prepare(
        `INSERT INTO orch_requirement_analysis_search_fts (session_id, workspace_id, title, summary)
         VALUES (?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(
          String(row.id),
          String(row.workspace_id),
          String(row.title ?? ""),
          String(row.latest_turn_summary ?? "").trim(),
        );
      }
    });
    tx();
  }

  private upsertSearchProjection(session: RequirementAnalysisSession): void {
    this.removeSearchProjection(session.workspaceId, session.id);
    this.db.prepare(
      `INSERT INTO orch_requirement_analysis_search_fts (session_id, workspace_id, title, summary)
       VALUES (?, ?, ?, ?)`,
    ).run(
      String(session.id),
      String(session.workspaceId),
      String(session.title ?? ""),
      String(session.latestTurnSummary ?? "").trim(),
    );
  }

  private removeSearchProjection(workspaceId: WorkspaceId, sessionId: RequirementAnalysisSessionId): void {
    this.db.prepare(
      "DELETE FROM orch_requirement_analysis_search_fts WHERE workspace_id = ? AND session_id = ?",
    ).run(String(workspaceId), String(sessionId));
  }

  private readOrComputeStatusCounts(
    workspaceId: WorkspaceId,
    search: string | null,
    allowedIds: string[] | null,
    countBaseSql: string,
    countBaseParams: Array<string | number>,
  ): Array<{ status: RequirementDraftListStatus; count: number }> {
    const cacheKey = buildCountCacheKey("draft", workspaceId, search, allowedIds);
    const now = Date.now();
    const cached = this.db.prepare(
      `SELECT counts_json FROM orch_list_status_count_cache
       WHERE cache_key = ? AND expires_at > ?`,
    ).get(cacheKey, now) as { counts_json?: string } | undefined;
    if (cached?.counts_json) {
      return safeParseJson<Array<{ status: RequirementDraftListStatus; count: number }>>(cached.counts_json, []);
    }
    const rows = this.db.prepare(`SELECT list_status AS status, COUNT(1) AS count FROM (${countBaseSql}) AS scoped GROUP BY list_status`)
      .all(...countBaseParams) as Array<{ status: RequirementDraftListStatus; count: number }>;
    this.db.prepare(
      `INSERT INTO orch_list_status_count_cache (
        cache_key, workspace_id, list_kind, search, scope_key,
        counts_json, total_count, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        counts_json = excluded.counts_json,
        total_count = excluded.total_count,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at`,
    ).run(
      cacheKey,
      String(workspaceId),
      "draft",
      search ?? "",
      allowedIds?.join(",") ?? "*",
      JSON.stringify(rows),
      rows.reduce((total, row) => total + Number(row.count ?? 0), 0),
      now,
      now + STATUS_COUNT_CACHE_TTL_MS,
    );
    return rows;
  }

  private clearCountCache(workspaceId: WorkspaceId): void {
    this.db.prepare(
      "DELETE FROM orch_list_status_count_cache WHERE workspace_id = ? AND list_kind = 'draft'",
    ).run(String(workspaceId));
  }
}

/** 原列表、详情及轻量读取共用归属解析；仅 SQL NULL 表示未知，不回显原始 JSON。 */
function readRowWorkspaceScope(row: any): NodeExecutionProfileScope | null {
  const details = { sessionId: String(row.id), workspaceId: String(row.workspace_id) };
  let workspaceScope: NodeExecutionProfileScope | null = null;
  if (row.workspace_scope_json !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.workspace_scope_json);
    } catch {
      throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID", details, { cause: new SyntaxError("Invalid requirement analysis workspace scope JSON") });
    }
    if (parsed == null) throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID", details);
    workspaceScope = readSessionWorkspaceScope(parsed, row.workspace_id, row.id, "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID");
  }
  return workspaceScope;
}

function rowToSession(row: any): RequirementAnalysisSession {
  return {
    id: String(row.id) as RequirementAnalysisSessionId,
    workspaceId: row.workspace_id as WorkspaceId,
    workspaceScope: readRowWorkspaceScope(row),
    title: String(row.title ?? "").trim() || "未命名需求分析",
    status: row.status === "completed" || row.status === "archived" ? row.status : "active",
    phase: normalizePhase(row.phase),
    engine: row.engine === "claude" ? "claude" : "codex",
    model: nullableString(row.model),
    effort: nullableString(row.effort),
    runtimeThreadId: nullableString(row.runtime_thread_id) as any,
    engineSessionId: nullableString(row.engine_session_id),
    latestTurnSummary: nullableString(row.latest_turn_summary),
    latestAssistantReply: nullableString(row.latest_assistant_reply),
    candidateCount: Number(row.candidate_count ?? 0),
    readyCandidateCount: Number(row.ready_candidate_count ?? 0),
    createdCandidateCount: Number(row.created_candidate_count ?? 0),
    pendingCandidateCount: Number(row.pending_candidate_count ?? 0),
    lastMessageAt: Number(row.last_message_at ?? row.updated_at ?? row.created_at ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** 复用需求归属语义，只翻译 RA 自身的固定错误码及安全根因。 */
function readSessionWorkspaceScope(
  value: unknown,
  workspaceId: WorkspaceId,
  sessionId: string,
  code: "ORCH_REQUIREMENT_ANALYSIS_SCOPE_INVALID" | "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID" = "ORCH_REQUIREMENT_ANALYSIS_SCOPE_INVALID",
): NodeExecutionProfileScope | null {
  try {
    return readIntakeWorkspaceScope(value, workspaceId);
  } catch {
    throw new OrchRequirementAnalysisSessionRepoError(code, { sessionId: String(sessionId), workspaceId: String(workspaceId) }, { cause: new Error("Invalid requirement analysis workspace scope") });
  }
}

function normalizePhase(raw: unknown): RequirementAnalysisSession["phase"] {
  const value = String(raw ?? "").trim();
  return value === "clarify" || value === "split" || value === "recommend" || value === "confirm" || value === "done"
    ? value
    : "discover";
}

/** 规范化原始需求列表状态筛选；空数组表示默认非归档全集。 */
export function normalizeRequirementDraftListStatuses(value: unknown): RequirementDraftListStatus[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<RequirementDraftListStatus>();
  for (const item of input) {
    const status = normalizeRequirementDraftListStatus(item);
    if (status) seen.add(status);
  }
  return Array.from(seen);
}

/** 返回原始需求列表状态的中文展示文案。 */
export function requirementDraftStatusLabel(status: RequirementDraftListStatus): string {
  const labels: Record<RequirementDraftListStatus, string> = {
    running: "运行中",
    clarifying: "待澄清",
    "ready-to-create": "待创建",
    "partial-created": "部分创建",
    created: "已创建",
    archived: "已归档",
  };
  return labels[status] ?? status;
}

function normalizeRequirementDraftListStatus(value: unknown): RequirementDraftListStatus | null {
  const text = String(value ?? "").trim();
  return text === "running"
    || text === "clarifying"
    || text === "ready-to-create"
    || text === "partial-created"
    || text === "created"
    || text === "archived"
    ? text
    : null;
}

function listStatusExpr(): string {
  return `CASE
    WHEN COALESCE(t.archived, 0) = 1 THEN 'archived'
    WHEN EXISTS (
      SELECT 1 FROM thread_turns tt
      WHERE tt.thread_id = COALESCE(NULLIF(TRIM(s.runtime_thread_id), ''), s.id)
        AND tt.status IN ('pending', 'running')
    ) THEN 'running'
    WHEN COALESCE(candidate_stats.candidate_count, 0) > 0
      AND COALESCE(candidate_stats.created_candidate_count, 0) >= COALESCE(candidate_stats.candidate_count, 0) THEN 'created'
    WHEN COALESCE(candidate_stats.created_candidate_count, 0) > 0 THEN 'partial-created'
    WHEN COALESCE(candidate_stats.ready_candidate_count, 0) > 0 THEN 'ready-to-create'
    WHEN COALESCE(candidate_stats.pending_candidate_count, 0) > 0 OR s.phase = 'clarify' THEN 'clarifying'
    WHEN s.status = 'completed' OR s.phase = 'done' THEN 'created'
    ELSE 'clarifying'
  END`;
}

function normalizeSearch(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 120) : null;
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

/** 构造 FTS5 trigram 查询；过短中文词交给 LIKE 兜底保证体验。 */
function buildFtsQuery(value: string): string | null {
  const text = value.trim();
  if ([...text].length < 3) return null;
  return `"${text.replace(/"/g, '""')}"`;
}

/** 从候选需求聚合值中选择第一个推荐流程名。 */
function resolveRecommendedWorkflowName(value: unknown): string | null {
  return String(value ?? "").split(",").map((item) => item.trim()).find(Boolean) ?? null;
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** 规范共享工作区下发的可见草稿 ID；undefined 表示不限制，空数组表示无可见项。 */
function normalizeAllowedResourceIds(value: string[] | null | undefined): string[] | null {
  if (value == null) return null;
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))).sort();
}

function buildCountCacheKey(
  kind: string,
  workspaceId: WorkspaceId,
  search: string | null,
  allowedIds: string[] | null,
): string {
  return [
    kind,
    String(workspaceId),
    search ?? "",
    allowedIds ? allowedIds.join(",") : "*",
  ].join("|");
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  return JSON.parse(raw) as T;
}
