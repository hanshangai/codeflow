import {
  getTaskIntakeTitle,
  type IntakeId,
  type ListStatusCount,
  type OrchestrationInstance,
  type OrchestrationInstanceSummary,
  type OrchestrationStatus,
  type TaskIntake,
  type TaskIntakeListMeta,
  type TaskIntakeListStatus,
  type TaskIntakeSourceKind,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import type { OrchInstanceSummaryProjectionReader } from "../orchInstanceSummaryProjection.js";

type IntakeListStateRow = {
  intake_id: string;
  list_status: TaskIntakeListStatus;
  latest_instance_id: string | null;
  instance_count: number;
  workflow_name: string | null;
  progress_text: string | null;
  updated_at: number;
};

type IntakeListPage = {
  intakeIds: IntakeId[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number;
  statusCounts: Array<ListStatusCount<TaskIntakeListStatus>>;
  listMetaById: Record<string, TaskIntakeListMeta>;
};

const TASK_INTAKE_STATUS_LABELS: Record<TaskIntakeListStatus, string> = {
  "not-started": "未启动",
  pending: "待运行",
  running: "运行中",
  paused: "已暂停",
  "waiting-start": "待启动确认",
  "waiting-approval": "待审批",
  "waiting-feedback": "待反馈",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
};

const ACTIVE_INSTANCE_STATUS = new Set<OrchestrationStatus>([
  "pending",
  "running",
  "paused",
  "waiting-start",
  "waiting-approval",
  "waiting-feedback",
]);

/** 编排入口列表状态缓存仓储，负责按 workspace/sourceKind 派生状态并分页查询。 */
export class OrchIntakeListStateRepo {
  constructor(
    private readonly db: SqliteDb,
    private readonly instanceSummaries: OrchInstanceSummaryProjectionReader,
  ) {}

  /** 刷新单个 intake 的列表状态、摘要和搜索投影；写路径调用，避免查询前全量重建。 */
  refreshIntake(input: {
    workspaceId: WorkspaceId;
    intakeId: IntakeId | string;
  }): void {
    const intakeId = String(input.intakeId ?? "").trim();
    if (!intakeId) return;
    const intake = this.getIntake(input.workspaceId, intakeId);
    if (!intake) {
      this.removeIntake(input.workspaceId, intakeId);
      return;
    }
    const sourceKind = this.detectSourceKindForIntake(input.workspaceId, intake);
    this.upsertIntakeState(input.workspaceId, intake, sourceKind);
  }

  /** 刷新实例关联的 intake 状态；实例创建、状态或节点变化后调用。 */
  refreshForInstance(instance: OrchestrationInstance | null | undefined): void {
    const intakeId = String(instance?.intakeSnapshot?.id ?? "").trim();
    const workspaceId = instance?.workspaceId;
    if (!workspaceId || !intakeId) return;
    this.refreshIntake({ workspaceId, intakeId });
  }

  /** 删除 intake 相关状态缓存、搜索投影和计数缓存。 */
  removeIntake(workspaceId: WorkspaceId, intakeId: IntakeId | string): void {
    const normalizedId = String(intakeId ?? "").trim();
    if (!normalizedId) return;
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM orch_intake_list_states WHERE workspace_id = ? AND intake_id = ?",
      ).run(String(workspaceId), normalizedId);
      this.db.prepare(
        "DELETE FROM orch_intake_search_fts WHERE workspace_id = ? AND intake_id = ?",
      ).run(String(workspaceId), normalizedId);
    });
    tx();
  }

  /** 重建指定来源的列表状态缓存；调用方在列表查询前按需触发。 */
  rebuildWorkspace(input: {
    workspaceId: WorkspaceId;
    sourceKind: TaskIntakeSourceKind;
    allowedResourceIds?: string[] | null;
  }): void {
    const sourceKind = normalizeTaskIntakeSourceKind(input.sourceKind) ?? "requirement";
    const allowedIds = normalizeAllowedResourceIds(input.allowedResourceIds);
    const intakes = allowedIds && allowedIds.length === 0 ? [] : this.listIntakes(input.workspaceId, sourceKind, allowedIds);
    const now = Date.now();
    const allowedIdSet = new Set(intakes.map((item) => String(item.id)));

    const tx = this.db.transaction(() => {
      if (allowedIds) {
        if (allowedIds.length > 0) {
          this.db.prepare(
            `DELETE FROM orch_intake_list_states
              WHERE workspace_id = ? AND source_kind = ?
                AND intake_id IN (${allowedIds.map(() => "?").join(", ")})`,
          ).run(String(input.workspaceId), sourceKind, ...allowedIds);
        }
      } else {
        this.db.prepare(
          `DELETE FROM orch_intake_list_states
            WHERE workspace_id = ? AND source_kind = ?
              AND intake_id IN (
                SELECT id FROM orch_intakes WHERE workspace_id = ?
              )`,
        ).run(String(input.workspaceId), sourceKind, String(input.workspaceId));
      }

      for (const intake of intakes) {
        if (!allowedIdSet.has(String(intake.id))) continue;
        this.upsertIntakeState(input.workspaceId, intake, sourceKind, now);
      }
    });
    tx();
  }

  /** 基于状态缓存查询当前页 ID、全量状态计数和列表元数据。 */
  listPage(input: {
    workspaceId: WorkspaceId;
    sourceKind: TaskIntakeSourceKind;
    limit?: number | null;
    cursor?: string | null;
    search?: string | null;
    statuses?: TaskIntakeListStatus[] | null;
    allowedResourceIds?: string[] | null;
  }): IntakeListPage {
    const sourceKind = normalizeTaskIntakeSourceKind(input.sourceKind) ?? "requirement";
    const limit = Math.min(Math.max(1, Number(input.limit ?? 100) || 100), 500);
    const cursor = String(input.cursor ?? "").trim() || null;
    const search = normalizeSearch(input.search);
    const statuses = normalizeTaskIntakeListStatuses(input.statuses);
    const allowedIds = normalizeAllowedResourceIds(input.allowedResourceIds);
    if (allowedIds && allowedIds.length === 0) {
      return { intakeIds: [], hasMore: false, nextCursor: null, totalCount: 0, statusCounts: [], listMetaById: {} };
    }

    const base = buildWhereSql({
      workspaceId: input.workspaceId,
      sourceKind,
      allowedIds,
      search,
    });
    const totalParams = [...base.params];
    let totalSql = `SELECT COUNT(1) AS total ${base.fromSql} ${base.whereSql}`;
    if (statuses.length > 0) {
      totalSql += ` AND s.list_status IN (${statuses.map(() => "?").join(", ")})`;
      totalParams.push(...statuses);
    }
    const totalRow = this.db.prepare(totalSql).get(...totalParams) as { total?: number } | undefined;

    const countRows = this.readStatusCounts(base);

    const pageParams = [...base.params];
    let pageSql = `SELECT s.intake_id, s.list_status, s.latest_instance_id, s.instance_count,
                          s.workflow_name, s.progress_text, s.updated_at
                   ${base.fromSql}
                   ${base.whereSql}`;
    if (statuses.length > 0) {
      pageSql += ` AND s.list_status IN (${statuses.map(() => "?").join(", ")})`;
      pageParams.push(...statuses);
    }
    if (cursor) {
      const parsed = parseCursor(cursor);
      if (parsed) {
        pageSql += " AND (s.updated_at < ? OR (s.updated_at = ? AND s.intake_id < ?))";
        pageParams.push(parsed.updatedAt, parsed.updatedAt, parsed.id);
      }
    }
    pageSql += " ORDER BY s.updated_at DESC, s.intake_id DESC LIMIT ?";
    pageParams.push(limit + 1);

    const rows = this.db.prepare(pageSql).all(...pageParams) as IntakeListStateRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const intakeIds = pageRows.map((row) => String(row.intake_id) as IntakeId);
    const latestSummaries = this.latestSummariesById(pageRows.map((row) => row.latest_instance_id).filter(Boolean) as string[]);
    const listMetaById = Object.fromEntries(pageRows.map((row) => [
      String(row.intake_id),
      rowToListMeta(row, latestSummaries.get(String(row.latest_instance_id ?? "")) ?? null),
    ]));

    return {
      intakeIds,
      hasMore,
      nextCursor: hasMore && pageRows.length > 0 ? `${Number(pageRows[pageRows.length - 1]!.updated_at ?? 0)}:${String(pageRows[pageRows.length - 1]!.intake_id)}` : null,
      totalCount: Number(totalRow?.total ?? 0),
      statusCounts: countRows.map((row) => ({
        status: row.status,
        label: TASK_INTAKE_STATUS_LABELS[row.status] ?? row.status,
        count: Number(row.count ?? 0),
      })),
      listMetaById,
    };
  }

  private listIntakes(workspaceId: WorkspaceId, sourceKind: TaskIntakeSourceKind, allowedIds: string[] | null): TaskIntake[] {
    let sql = `SELECT id, intake_json, created_at, updated_at
               FROM orch_intakes
               WHERE workspace_id = ?`;
    const params: Array<string | number> = [String(workspaceId)];
    if (allowedIds) {
      sql += ` AND id IN (${allowedIds.map(() => "?").join(", ")})`;
      params.push(...allowedIds);
    }
    sql += sourceKind === "scheduled_task" ? ` AND (${scheduledIntakePredicateSql()})` : ` AND NOT (${scheduledIntakePredicateSql()})`;
    sql += " ORDER BY updated_at DESC, id DESC";
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(rowToIntake);
  }

  private getIntake(workspaceId: WorkspaceId, intakeId: string): TaskIntake | null {
    const row = this.db
      .prepare(
        `SELECT id, intake_json, created_at, updated_at
         FROM orch_intakes
         WHERE workspace_id = ? AND id = ?`,
      )
      .get(String(workspaceId), intakeId) as any | undefined;
    return row ? rowToIntake(row) : null;
  }

  private listInstanceSummariesForIntake(workspaceId: WorkspaceId, intakeId: string): OrchestrationInstanceSummary[] {
    return this.instanceSummaries.listByIntakeIds(workspaceId, [intakeId]);
  }

  private upsertIntakeState(
    workspaceId: WorkspaceId,
    intake: TaskIntake,
    sourceKind: TaskIntakeSourceKind,
    rebuiltAt = Date.now(),
  ): void {
    const instances = this.listInstanceSummariesForIntake(workspaceId, String(intake.id));
    const state = deriveListState(instances);
    this.db.prepare(
      "DELETE FROM orch_intake_list_states WHERE workspace_id = ? AND intake_id = ? AND source_kind <> ?",
    ).run(String(workspaceId), String(intake.id), sourceKind);
    this.db.prepare(
      "DELETE FROM orch_intake_search_fts WHERE workspace_id = ? AND intake_id = ? AND source_kind <> ?",
    ).run(String(workspaceId), String(intake.id), sourceKind);
    this.db.prepare(
      `INSERT INTO orch_intake_list_states (
        workspace_id, intake_id, source_kind, list_status, latest_instance_id,
        latest_instance_status, instance_count, workflow_name, progress_text,
        updated_at, rebuilt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, intake_id, source_kind) DO UPDATE SET
        list_status = excluded.list_status,
        latest_instance_id = excluded.latest_instance_id,
        latest_instance_status = excluded.latest_instance_status,
        instance_count = excluded.instance_count,
        workflow_name = excluded.workflow_name,
        progress_text = excluded.progress_text,
        updated_at = excluded.updated_at,
        rebuilt_at = excluded.rebuilt_at`,
    ).run(
      String(workspaceId),
      String(intake.id),
      sourceKind,
      state.listStatus,
      state.latestInstance?.id ?? null,
      state.latestInstance?.status ?? null,
      state.instanceCount,
      state.workflowName,
      state.progressText,
      Number(intake.updatedAt ?? rebuiltAt),
      rebuiltAt,
    );
    this.upsertSearchProjection(workspaceId, intake, sourceKind);
  }

  /** 读取 intake 历史事实，判断普通需求或定时任务来源。 */
  private detectSourceKindForIntake(workspaceId: WorkspaceId, intake: TaskIntake): TaskIntakeSourceKind {
    const explicitSource = String((intake as { requester?: { source?: unknown } }).requester?.source ?? "").trim();
    if (explicitSource === "scheduled_task") return "scheduled_task";
    if (explicitSource === "ui" || explicitSource === "chat" || explicitSource === "api") return "requirement";
    const projected = this.db.prepare(
      `SELECT source_kind FROM orch_intake_list_states
       WHERE workspace_id = ? AND intake_id = ?
       LIMIT 1`,
    ).get(String(workspaceId), String(intake.id)) as { source_kind?: string } | undefined;
    const projectedSource = normalizeTaskIntakeSourceKind(projected?.source_kind);
    if (projectedSource) return projectedSource;
    const row = this.db.prepare(
      `SELECT 1 AS found
       FROM orch_intakes
       WHERE workspace_id = ? AND id = ? AND (${scheduledIntakePredicateSql()})
       LIMIT 1`,
    ).get(String(workspaceId), String(intake.id)) as { found?: number } | undefined;
    return row?.found ? "scheduled_task" : "requirement";
  }

  /** 写入标题和目标摘要搜索投影；正文、背景和验收不进入第一版搜索。 */
  private upsertSearchProjection(workspaceId: WorkspaceId, intake: TaskIntake, sourceKind: TaskIntakeSourceKind): void {
    const intakeId = String(intake.id);
    this.db.prepare(
      "DELETE FROM orch_intake_search_fts WHERE workspace_id = ? AND intake_id = ? AND source_kind = ?",
    ).run(String(workspaceId), intakeId, sourceKind);
    this.db.prepare(
      `INSERT INTO orch_intake_search_fts (intake_id, workspace_id, source_kind, title, summary)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      intakeId,
      String(workspaceId),
      sourceKind,
      getTaskIntakeTitle(intake),
      String(intake.goal ?? "").trim(),
    );
  }

  /** 精确统计当前筛选范围的状态数量，不读写任何 TTL 结果缓存。 */
  private readStatusCounts(
    base: { fromSql: string; whereSql: string; params: Array<string | number> },
  ): Array<{ status: TaskIntakeListStatus; count: number }> {
    return this.db.prepare(
      `SELECT s.list_status AS status, COUNT(1) AS count
       ${base.fromSql}
       ${base.whereSql}
       GROUP BY s.list_status`,
    ).all(...base.params) as Array<{ status: TaskIntakeListStatus; count: number }>;
  }

  /** 严格读取当前页最新实例摘要；缺失或损坏由摘要 Reader 显式失败。 */
  private latestSummariesById(instanceIds: string[]): Map<string, OrchestrationInstanceSummary> {
    const ids = Array.from(new Set(instanceIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
    if (ids.length === 0) return new Map();
    return this.instanceSummaries.loadByIds(ids);
  }
}

/** 规范化列表状态筛选；空数组表示不限制状态。 */
export function normalizeTaskIntakeListStatuses(value: unknown): TaskIntakeListStatus[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<TaskIntakeListStatus>();
  for (const item of input) {
    const text = String(item ?? "").trim();
    if (text in TASK_INTAKE_STATUS_LABELS) seen.add(text as TaskIntakeListStatus);
  }
  return Array.from(seen);
}

/** 返回编排入口列表状态的中文展示文案。 */
export function taskIntakeListStatusLabel(status: TaskIntakeListStatus): string {
  return TASK_INTAKE_STATUS_LABELS[status] ?? status;
}

function buildWhereSql(input: {
  workspaceId: WorkspaceId;
  sourceKind: TaskIntakeSourceKind;
  allowedIds: string[] | null;
  search: string | null;
}): { fromSql: string; whereSql: string; params: Array<string | number> } {
  const params: Array<string | number> = [String(input.workspaceId), input.sourceKind];
  let whereSql = "WHERE s.workspace_id = ? AND s.source_kind = ?";
  if (input.allowedIds) {
    whereSql += ` AND s.intake_id IN (${input.allowedIds.map(() => "?").join(", ")})`;
    params.push(...input.allowedIds);
  }
  if (input.search) {
    const ftsQuery = buildFtsQuery(input.search);
    if (ftsQuery) {
      whereSql += ` AND EXISTS (
        SELECT 1 FROM orch_intake_search_fts f
        WHERE f.workspace_id = s.workspace_id
          AND f.source_kind = s.source_kind
          AND f.intake_id = s.intake_id
          AND orch_intake_search_fts MATCH ?
      )`;
      params.push(ftsQuery);
    } else {
      whereSql += ` AND EXISTS (
        SELECT 1 FROM orch_intake_search_fts f
        WHERE f.workspace_id = s.workspace_id
          AND f.source_kind = s.source_kind
          AND f.intake_id = s.intake_id
          AND (f.title LIKE ? ESCAPE '\\' OR f.summary LIKE ? ESCAPE '\\')
      )`;
      const keyword = `%${escapeLike(input.search)}%`;
      params.push(keyword, keyword);
    }
  }
  return {
    fromSql: `FROM orch_intake_list_states s INNER JOIN orch_intakes i ON i.id = s.intake_id`,
    whereSql,
    params,
  };
}

function deriveListState(instances: OrchestrationInstanceSummary[]): TaskIntakeListMeta {
  const latest = pickDisplayInstance(instances);
  const listStatus = (latest?.status ?? "not-started") as TaskIntakeListStatus;
  const progressTotal = Number(latest?.runSummary.progressTotal ?? 0);
  const progressDone = Number(latest?.runSummary.progressDone ?? 0);
  return {
    listStatus,
    listStatusLabel: taskIntakeListStatusLabel(listStatus),
    workflowName: String(latest?.workflowName ?? "").trim() || null,
    instanceCount: instances.length,
    latestInstance: latest,
    progressText: latest && progressTotal > 0 ? `${progressDone}/${progressTotal}` : null,
  };
}

function pickDisplayInstance(instances: OrchestrationInstanceSummary[]): OrchestrationInstanceSummary | null {
  const active = instances
    .filter((instance) => ACTIVE_INSTANCE_STATUS.has(instance.status))
    .sort(compareInstancesByUpdatedAt);
  if (active[0]) return active[0];
  return [...instances].sort(compareInstancesByUpdatedAt)[0] ?? null;
}

function compareInstancesByUpdatedAt(left: OrchestrationInstanceSummary, right: OrchestrationInstanceSummary): number {
  return right.updatedAt - left.updatedAt || String(right.id).localeCompare(String(left.id));
}

function rowToListMeta(row: IntakeListStateRow, latestInstance: OrchestrationInstanceSummary | null): TaskIntakeListMeta {
  return {
    listStatus: row.list_status,
    listStatusLabel: taskIntakeListStatusLabel(row.list_status),
    workflowName: nullableString(row.workflow_name),
    instanceCount: Number(row.instance_count ?? 0),
    latestInstance,
    progressText: nullableString(row.progress_text),
  };
}

function rowToIntake(row: any): TaskIntake {
  const parsed = safeParseJson<TaskIntake | null>(row.intake_json, null);
  if (parsed && typeof parsed === "object") {
    return {
      ...parsed,
      title: getTaskIntakeTitle(parsed),
      id: row.id as IntakeId,
      createdAt: Number(row.created_at ?? parsed.createdAt ?? 0),
      updatedAt: Number(row.updated_at ?? parsed.updatedAt ?? 0),
    };
  }
  return {
    id: row.id as IntakeId,
    workspaceId: "" as WorkspaceId,
    triggerMode: "manual",
    taskType: "unknown",
    title: "",
    goal: "",
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function normalizeSearch(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 120) : null;
}

function parseCursor(cursor: string): { updatedAt: number; id: string } | null {
  const sep = cursor.indexOf(":");
  if (sep <= 0) return null;
  const updatedAt = Number(cursor.substring(0, sep));
  const id = cursor.substring(sep + 1);
  return Number.isFinite(updatedAt) && id ? { updatedAt, id } : null;
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

function normalizeTaskIntakeSourceKind(value: unknown): TaskIntakeSourceKind | null {
  const text = String(value ?? "").trim();
  return text === "requirement" || text === "scheduled_task" ? text : null;
}

function normalizeAllowedResourceIds(value: string[] | null | undefined): string[] | null {
  if (value == null) return null;
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))).sort();
}

/** 构造定时任务事实判定 SQL；只接受内部固定表名或别名。 */
export function scheduledIntakePredicateSql(intakeTable: "orch_intakes" | "i" = "orch_intakes"): string {
  return `COALESCE(json_extract(${intakeTable}.intake_json, '$.requester.source'), '') = 'scheduled_task'
    OR EXISTS (
      SELECT 1 FROM orch_instance_summaries summary
      WHERE summary.workspace_id = ${intakeTable}.workspace_id
        AND summary.intake_id = ${intakeTable}.id
        AND EXISTS (
          SELECT 1 FROM orch_events oe
          WHERE oe.instance_id = summary.instance_id
            AND oe.type = 'orchestration.instanceStarted'
            AND json_extract(oe.payload_json, '$.triggerSource') = 'scheduled_task'
        )
    )`;
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  return JSON.parse(raw) as T;
}
