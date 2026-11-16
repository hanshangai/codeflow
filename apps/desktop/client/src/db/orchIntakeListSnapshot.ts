import {
  getTaskIntakeTitle,
  type IntakeId,
  type ListStatusCount,
  type OrchIntakesListResponseBody,
  type OrchestrationInstanceSummary,
  type OrchestrationStatus,
  type PendingMineListStatus,
  type ReminderActionKind,
  type TaskIntake,
  type TaskIntakeListMeta,
  type TaskIntakeListStatus,
  type TaskIntakeSourceKind,
  type WorkspaceId,
} from "@codeflowai/shared";

import {
  OrchInstanceSummaryProjectionError,
  parseOrchInstanceSummaryProjectionRow,
  type OrchInstanceSummaryProjectionRow,
} from "./orchInstanceSummaryProjection.js";
import { scheduledIntakePredicateSql } from "./repos/orchIntakeListStateRepo.js";
import { readIntakeWorkspaceScope } from "./repos/orchIntakeRepo.js";
import { isLocalOrchestrationExecutionFacts, OrchInstanceScopeError, readStrictInstanceScope } from "./repos/orchInstanceRepo.js";
import type { SqliteDb } from "./sqliteTypes.js";

export type OrchIntakeListSnapshotInput = {
  requestId: string;
  workspaceId: WorkspaceId;
  limit?: number | null;
  cursor?: string | null;
  search?: string | null;
  statuses?: string[] | null;
  sourceKind?: TaskIntakeSourceKind | null;
  allowedResourceIds?: string[] | null;
  localWorkspaceOnly?: boolean;
};

/** 抽象异步列表读取服务，handler 不感知 worker 的传输细节。 */
export interface OrchIntakeListReader {
  listIntakes(input: OrchIntakeListSnapshotInput): Promise<OrchIntakesListResponseBody>;
}

export type OrchIntakeListSnapshotErrorCode =
  | "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID"
  | "ORCH_INTAKE_LIST_SNAPSHOT_STATE_INVALID"
  | "ORCH_INTAKE_LIST_PROJECTION_INCOMPLETE";

/** 表示无法从只读投影构造可信列表响应。 */
export class OrchIntakeListSnapshotError extends Error {
  readonly code: OrchIntakeListSnapshotErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  /** 保存稳定错误码与可跨线程传输的诊断上下文。 */
  constructor(
    code: OrchIntakeListSnapshotErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OrchIntakeListSnapshotError";
    this.code = code;
    this.details = details;
  }
}

type NormalizedSnapshotInput = {
  requestId: string;
  workspaceId: WorkspaceId;
  limit: number;
  cursor: { updatedAt: number; id: string } | null;
  search: string | null;
  cursorSearch: string | null;
  statuses: TaskIntakeListStatus[];
  cursorStatuses: string[];
  sourceKind: TaskIntakeSourceKind;
  allowedResourceIds: string[] | null;
  localWorkspaceOnly: boolean;
};

type IntakeListPageRow = {
  intake_id: string;
  list_status: string;
  latest_instance_id: string | null;
  latest_instance_status: string | null;
  instance_count: number;
  workflow_name: string | null;
  progress_text: string | null;
  state_updated_at: number;
  intake_workspace_id: string;
  intake_json: string;
  intake_created_at: number;
  intake_updated_at: number;
};

type IntakeFactRow = Pick<IntakeListPageRow, "intake_id" | "intake_workspace_id" | "intake_json" | "intake_created_at" | "intake_updated_at">;

type StatusCountRow = {
  status: string;
  count: number;
};

type ArtifactCountRow = {
  instance_id: string;
  artifact_count: number;
};

type ProjectionIntegrityRow = {
  workspace_id?: unknown;
  intake_id?: unknown;
  projection_count?: unknown;
  expected_source_kind?: unknown;
  actual_source_kind?: unknown;
  expected_instance_count?: unknown;
  actual_instance_count?: unknown;
  expected_latest_instance_id?: unknown;
  actual_latest_instance_id?: unknown;
  expected_latest_instance_status?: unknown;
  actual_latest_instance_status?: unknown;
  expected_list_status?: unknown;
  actual_list_status?: unknown;
};

type RawListSnapshot = {
  totalCount: number;
  statusCountRows: StatusCountRow[];
  pageRows: IntakeListPageRow[];
  hasMore: boolean;
  latestProjectionRows: OrchInstanceSummaryProjectionRow[];
  attentionProjectionRows: OrchInstanceSummaryProjectionRow[];
  artifactCountRows: ArtifactCountRow[];
};

type AttentionMeta = Pick<TaskIntakeListMeta, "attentionStatus" | "attentionLabel" | "attentionActionKind">;

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

const ATTENTION_INSTANCE_STATUSES = [
  "paused",
  "waiting-start",
  "waiting-approval",
  "waiting-feedback",
  "failed",
  "completed",
] as const satisfies readonly OrchestrationStatus[];

const PROJECTION_COLUMNS = [
  "instance_id",
  "workspace_id",
  "intake_id",
  "status",
  "source_updated_at",
  "summary_json",
  "projection_version",
].join(", ");

/** 在同一短只读事务中取得并预验列表事实，事务结束后构造完整响应。 */
export function readOrchIntakeListSnapshot(
  db: SqliteDb,
  input: OrchIntakeListSnapshotInput,
): OrchIntakesListResponseBody {
  const normalized = normalizeSnapshotInput(input);
  const cursorScope = buildCursorScope(normalized);
  if (normalized.allowedResourceIds?.length === 0) return emptyResponse(cursorScope);

  const readSnapshot = db.transaction(() => readRawSnapshot(db, normalized));
  return buildResponse(readSnapshot(), normalized, cursorScope);
}

/** 校验需求事实、列表状态与搜索投影一一对应；缺行或孤立行必须阻止启动。 */
export function validateOrchIntakeListProjectionIntegrity(db: SqliteDb): void {
  if (!sqliteTableExists(db, "orch_intakes")) return;
  const stateMultiplicity = db.prepare(
    `SELECT i.workspace_id, i.id AS intake_id, COUNT(s.intake_id) AS projection_count
     FROM orch_intakes i
     LEFT JOIN orch_intake_list_states s
       ON s.workspace_id = i.workspace_id AND s.intake_id = i.id
     GROUP BY i.workspace_id, i.id
     HAVING COUNT(s.intake_id) <> 1
     LIMIT 1`,
  ).get() as ProjectionIntegrityRow | undefined;
  if (stateMultiplicity) {
    throw projectionIncomplete(stateMultiplicity, "state", "projection_count_mismatch");
  }

  const orphanState = db.prepare(
    `SELECT s.workspace_id, s.intake_id, 1 AS projection_count
     FROM orch_intake_list_states s
     LEFT JOIN orch_intakes i
       ON i.workspace_id = s.workspace_id AND i.id = s.intake_id
     WHERE i.id IS NULL
     LIMIT 1`,
  ).get() as ProjectionIntegrityRow | undefined;
  if (orphanState) {
    throw projectionIncomplete(orphanState, "state", "orphan_projection");
  }

  const sourceMismatch = db.prepare(
    `WITH expected_sources AS (
       SELECT i.workspace_id, i.id AS intake_id,
              CASE WHEN (${scheduledIntakePredicateSql("i")})
                   THEN 'scheduled_task' ELSE 'requirement' END AS expected_source_kind
       FROM orch_intakes i
     )
     SELECT expected.workspace_id, expected.intake_id, expected.expected_source_kind,
            s.source_kind AS actual_source_kind
     FROM expected_sources expected
     INNER JOIN orch_intake_list_states s
       ON s.workspace_id = expected.workspace_id AND s.intake_id = expected.intake_id
     WHERE s.source_kind IS NOT expected.expected_source_kind
     LIMIT 1`,
  ).get() as ProjectionIntegrityRow | undefined;
  if (sourceMismatch) {
    throw projectionIncomplete(sourceMismatch, "state", "source_kind_mismatch", {
      field: "sourceKind",
      expected: nullableProjectionText(sourceMismatch.expected_source_kind),
      actual: nullableProjectionText(sourceMismatch.actual_source_kind),
    });
  }

  const stateSummaryMismatch = db.prepare(
    `WITH ranked_summaries AS (
       SELECT workspace_id, intake_id, instance_id, status,
              COUNT(*) OVER display_order AS expected_instance_count,
              ROW_NUMBER() OVER display_order AS display_rank
       FROM orch_instance_summaries
       WINDOW display_order AS (
         PARTITION BY workspace_id, intake_id
         ORDER BY CASE
                    WHEN status IN ('pending', 'running', 'paused', 'waiting-start',
                                    'waiting-approval', 'waiting-feedback') THEN 0
                    ELSE 1
                  END,
                  source_updated_at DESC,
                  instance_id DESC
         ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
       )
     ), expected_states AS (
       SELECT workspace_id, intake_id,
              instance_id AS expected_latest_instance_id,
              status AS expected_latest_instance_status,
              expected_instance_count
       FROM ranked_summaries
       WHERE display_rank = 1
     )
     SELECT s.workspace_id, s.intake_id,
            COALESCE(expected.expected_instance_count, 0) AS expected_instance_count,
            s.instance_count AS actual_instance_count,
            expected.expected_latest_instance_id,
            s.latest_instance_id AS actual_latest_instance_id,
            expected.expected_latest_instance_status,
            s.latest_instance_status AS actual_latest_instance_status,
            COALESCE(expected.expected_latest_instance_status, 'not-started') AS expected_list_status,
            s.list_status AS actual_list_status
     FROM orch_intake_list_states s
     INNER JOIN orch_intakes i
       ON i.workspace_id = s.workspace_id AND i.id = s.intake_id
     LEFT JOIN expected_states expected
       ON expected.workspace_id = s.workspace_id AND expected.intake_id = s.intake_id
     WHERE s.instance_count IS NOT COALESCE(expected.expected_instance_count, 0)
        OR s.latest_instance_id IS NOT expected.expected_latest_instance_id
        OR s.latest_instance_status IS NOT expected.expected_latest_instance_status
        OR s.list_status IS NOT COALESCE(expected.expected_latest_instance_status, 'not-started')
     LIMIT 1`,
  ).get() as ProjectionIntegrityRow | undefined;
  if (stateSummaryMismatch) {
    throw stateSummaryProjectionIncomplete(stateSummaryMismatch);
  }

  const searchMultiplicity = db.prepare(
    `SELECT s.workspace_id, s.intake_id, COUNT(f.rowid) AS projection_count
     FROM orch_intake_list_states s
     LEFT JOIN orch_intake_search_fts f
       ON f.workspace_id = s.workspace_id
      AND f.intake_id = s.intake_id
      AND f.source_kind = s.source_kind
     GROUP BY s.workspace_id, s.intake_id, s.source_kind
     HAVING COUNT(f.rowid) <> 1
     LIMIT 1`,
  ).get() as ProjectionIntegrityRow | undefined;
  if (searchMultiplicity) {
    throw projectionIncomplete(searchMultiplicity, "search", "projection_count_mismatch");
  }

  const orphanSearch = db.prepare(
    `SELECT f.workspace_id, f.intake_id, 1 AS projection_count
     FROM orch_intake_search_fts f
     LEFT JOIN orch_intake_list_states s
       ON s.workspace_id = f.workspace_id
      AND s.intake_id = f.intake_id
      AND s.source_kind = f.source_kind
     WHERE s.intake_id IS NULL
     LIMIT 1`,
  ).get() as ProjectionIntegrityRow | undefined;
  if (orphanSearch) {
    throw projectionIncomplete(orphanSearch, "search", "orphan_projection");
  }
}

/** 本机模式先在同一事务预验全部原事实，再由相同范围读取统计和页面。 */
function readRawSnapshot(db: SqliteDb, input: NormalizedSnapshotInput): RawListSnapshot {
  let localIntakeIds: string[] | null = null;
  if (input.localWorkspaceOnly) {
    localIntakeIds = [];
    const rows = db.prepare(
      `SELECT id AS intake_id, workspace_id AS intake_workspace_id, intake_json,
              created_at AS intake_created_at, updated_at AS intake_updated_at
       FROM orch_intakes WHERE workspace_id = ?`,
    ).iterate(String(input.workspaceId));
    for (const row of rows) {
      const intake = parseIntakeRow(row as IntakeFactRow, input);
      if (isLocalOrchestrationExecutionFacts({ workspaceId: intake.workspaceId, intakeSnapshot: intake })) localIntakeIds.push(intake.id);
    }
  }
  const localInstanceIds = input.localWorkspaceOnly ? readLocalInstanceIds(db, input) : null;
  const base = buildBaseQuery(input, localIntakeIds, localInstanceIds);
  const statusCountRows = readStatusCounts(db, base);
  const totalCount = countSelectedStatuses(statusCountRows, input.statuses, input);
  const rawPageRows = readPageRows(db, base, input);
  const hasMore = rawPageRows.length > input.limit;
  const pageRows = hasMore ? rawPageRows.slice(0, input.limit) : rawPageRows;
  const latestProjectionRows = readLatestProjectionRows(db, pageRows);
  const attentionProjectionRows = readAttentionProjectionRows(db, input, pageRows, localInstanceIds);
  const selectedInstanceIds = uniqueStrings([
    ...latestProjectionRows.map((row) => row.instance_id),
    ...attentionProjectionRows.map((row) => row.instance_id),
  ]);
  const artifactCountRows = readArtifactCounts(db, selectedInstanceIds);
  return {
    totalCount,
    statusCountRows,
    pageRows,
    hasMore,
    latestProjectionRows,
    attentionProjectionRows,
    artifactCountRows,
  };
}

/** 复用实例仓储冻结事实解析；坏行请求失败，合法共享与未知历史不进入本机聚合。 */
function readLocalInstanceIds(db: SqliteDb, input: NormalizedSnapshotInput): string[] {
  const ids: string[] = [];
  for (const row of db.prepare(`SELECT id, workspace_id, intake_snapshot_json, runtime_config_json, node_states_json,
    (SELECT intake_id FROM orch_instance_summaries WHERE instance_id = orch_instances.id) AS frozen_intake_id
    FROM orch_instances WHERE workspace_id = ?`).iterate(String(input.workspaceId))) {
    const fact = row as { id: string; workspace_id: string };
    let scope;
    try { scope = readStrictInstanceScope(row); }
    catch (error) {
      if (!(error instanceof OrchInstanceScopeError)) throw error;
      throw snapshotError("ORCH_INTAKE_LIST_SNAPSHOT_STATE_INVALID", "需求列表实例冻结归属损坏", input, error.details);
    }
    if (isLocalOrchestrationExecutionFacts({ workspaceId: fact.workspace_id, ...scope })) ids.push(fact.id);
  }
  return ids;
}

/** 直接 GROUP BY 读取各状态计数，不读写状态计数缓存。 */
function readStatusCounts(
  db: SqliteDb,
  base: { fromSql: string; whereSql: string; params: unknown[] },
): StatusCountRow[] {
  return db.prepare(
    `SELECT s.list_status AS status, COUNT(1) AS count
     ${base.fromSql}
     ${base.whereSql}
     GROUP BY s.list_status
     ORDER BY s.list_status`,
  ).all(...base.params) as StatusCountRow[];
}

/** 严格校验状态计数并求当前筛选后的总数，避免重复扫描列表状态表。 */
function countSelectedStatuses(
  rows: StatusCountRow[],
  statuses: TaskIntakeListStatus[],
  input: NormalizedSnapshotInput,
): number {
  const selected = statuses.length > 0 ? new Set(statuses) : null;
  let total = 0;
  for (const row of rows) {
    const status = parseListStatus(row.status, input, null);
    const count = requireNonNegativeInteger(row.count, input, "statusCount", null);
    if (selected && !selected.has(status)) continue;
    const nextTotal = total + count;
    if (!Number.isSafeInteger(nextTotal)) {
      throw invalidState(input, null, "status_count_overflow", { status, count });
    }
    total = nextTotal;
  }
  return total;
}

/** 分页读取状态行及其需求 JSON，避免事务外再次回表。 */
function readPageRows(
  db: SqliteDb,
  base: { fromSql: string; whereSql: string; params: unknown[] },
  input: NormalizedSnapshotInput,
): IntakeListPageRow[] {
  const params = [...base.params];
  let sql = `SELECT s.intake_id, s.list_status, s.latest_instance_id,
                    s.latest_instance_status, s.instance_count,
                    s.workflow_name, s.progress_text, s.updated_at AS state_updated_at,
                    i.workspace_id AS intake_workspace_id, i.intake_json,
                    i.created_at AS intake_created_at, i.updated_at AS intake_updated_at
             ${base.fromSql}
             ${base.whereSql}`;
  if (input.statuses.length > 0) {
    sql += ` AND s.list_status IN (${placeholders(input.statuses.length)})`;
    params.push(...input.statuses);
  }
  if (input.cursor) {
    sql += " AND (s.updated_at < ? OR (s.updated_at = ? AND s.intake_id < ?))";
    params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
  }
  sql += " ORDER BY s.updated_at DESC, s.intake_id DESC LIMIT ?";
  params.push(input.limit + 1);
  return db.prepare(sql).all(...params) as IntakeListPageRow[];
}

/** 按列表状态中的精确实例 ID 批量读取展示摘要。 */
function readLatestProjectionRows(db: SqliteDb, pageRows: IntakeListPageRow[]): OrchInstanceSummaryProjectionRow[] {
  const instanceIds = uniqueStrings(pageRows.map((row) => row.latest_instance_id));
  if (instanceIds.length === 0) return [];
  return db.prepare(
    `SELECT ${PROJECTION_COLUMNS}
     FROM orch_instance_summaries
     WHERE instance_id IN (${placeholders(instanceIds.length)})`,
  ).all(...instanceIds) as OrchInstanceSummaryProjectionRow[];
}

/** 每个当前页需求只读取一个最新的关注候选摘要。 */
function readAttentionProjectionRows(
  db: SqliteDb,
  input: NormalizedSnapshotInput,
  pageRows: IntakeListPageRow[],
  localInstanceIds: string[] | null,
): OrchInstanceSummaryProjectionRow[] {
  const intakeIds = uniqueStrings(pageRows.map((row) => row.intake_id));
  if (intakeIds.length === 0) return [];
  const statuses = [...ATTENTION_INSTANCE_STATUSES];
  return db.prepare(
    `WITH ranked_attention AS (
       SELECT instance_id, intake_id, source_updated_at,
               ROW_NUMBER() OVER (
                 PARTITION BY intake_id
                 ORDER BY source_updated_at DESC, instance_id DESC
               ) AS attention_rank
       FROM orch_instance_summaries
       WHERE workspace_id = ?
         ${localInstanceIds === null ? "" : "AND instance_id IN (SELECT value FROM json_each(?))"}
         AND intake_id IN (${placeholders(intakeIds.length)})
         AND status IN (${placeholders(statuses.length)})
      )
      SELECT summary.instance_id, summary.workspace_id, summary.intake_id,
             summary.status, summary.source_updated_at,
             summary.summary_json, summary.projection_version
      FROM orch_instance_summaries summary
      INNER JOIN ranked_attention selected
        ON selected.instance_id = summary.instance_id
       AND selected.attention_rank = 1`,
  ).all(String(input.workspaceId), ...(localInstanceIds === null ? [] : [JSON.stringify(localInstanceIds)]), ...intakeIds, ...statuses) as OrchInstanceSummaryProjectionRow[];
}

/** 对已选择摘要的实例批量统计产物数，不读取产物正文。 */
function readArtifactCounts(db: SqliteDb, instanceIds: string[]): ArtifactCountRow[] {
  if (instanceIds.length === 0) return [];
  return db.prepare(
    `SELECT instance_id, COUNT(1) AS artifact_count
     FROM orch_artifacts
     WHERE instance_id IN (${placeholders(instanceIds.length)})
     GROUP BY instance_id`,
  ).all(...instanceIds) as ArtifactCountRow[];
}

/** 在事务外严格解析行并组装接口响应。 */
function buildResponse(
  raw: RawListSnapshot,
  input: NormalizedSnapshotInput,
  cursorScope: string,
): OrchIntakesListResponseBody {
  const totalCount = requireNonNegativeInteger(raw.totalCount, input, "totalCount");
  const artifactCounts = parseArtifactCounts(raw.artifactCountRows, input);
  const latestRowsById = uniqueProjectionRowsById(raw.latestProjectionRows, input, "latest");
  const attentionRowsByIntakeId = uniqueProjectionRowsByIntakeId(raw.attentionProjectionRows, input);
  const intakes: TaskIntake[] = [];
  const listMetaById: Record<string, TaskIntakeListMeta> = {};

  for (const row of raw.pageRows) {
    const intake = parseIntakeRow(row, input);
    const state = parseListStateRow(row, input);
    const latestInstance = parseLatestSummary(state, latestRowsById, artifactCounts, input);
    const attentionRow = attentionRowsByIntakeId.get(state.intakeId) ?? null;
    const attentionInstance = attentionRow
      ? withArtifactCount(parseOrchInstanceSummaryProjectionRow(attentionRow, {
          workspaceId: input.workspaceId,
          intakeId: state.intakeId,
        }).summary, artifactCounts.get(String(attentionRow.instance_id)) ?? 0)
      : null;
    const attentionMeta = attentionInstance
      ? deriveAttentionMeta(attentionInstance)
      : null;
    intakes.push(intake);
    listMetaById[state.intakeId] = {
      listStatus: state.listStatus,
      listStatusLabel: taskIntakeListStatusLabel(state.listStatus),
      workflowName: nullableString(row.workflow_name),
      instanceCount: state.instanceCount,
      latestInstance,
      progressText: nullableString(row.progress_text),
      ...(attentionMeta ?? {}),
    };
  }

  const lastRow = raw.pageRows[raw.pageRows.length - 1] ?? null;
  return {
    intakes,
    hasMore: raw.hasMore,
    nextCursor: raw.hasMore && lastRow
      ? `${Number(lastRow.state_updated_at)}:${String(lastRow.intake_id)}`
      : null,
    statusCounts: parseStatusCounts(raw.statusCountRows, input),
    totalCount,
    listMetaById,
    listPageMeta: { totalCount, cursorScope },
  };
}

/** 复用仓储归属校验，列表与详情对损坏需求保持相同失败边界。 */
function parseIntakeRow(row: IntakeFactRow, input: NormalizedSnapshotInput): TaskIntake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.intake_json));
  } catch {
    throw snapshotError(
      "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID",
      "需求列表投影中的 intake_json 无法解析",
      input,
      { intakeId: String(row.intake_id), reason: "invalid_json" },
      new SyntaxError("Invalid intake JSON"),
    );
  }
  if (!isRecord(parsed)) {
    throw snapshotError(
      "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID",
      "需求列表投影中的 intake_json 不是对象",
      input,
      { intakeId: String(row.intake_id), reason: "object_required" },
    );
  }
  const intakeId = row.intake_id;
  const workspaceId = row.intake_workspace_id;
  if (typeof intakeId !== "string" || !intakeId || intakeId !== intakeId.trim()
    || typeof workspaceId !== "string" || workspaceId !== input.workspaceId) {
    throw snapshotError(
      "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID",
      "需求列表投影的身份字段不一致",
      input,
      { intakeId, intakeWorkspaceId: workspaceId, reason: "row_identity_mismatch" },
    );
  }
  if (parsed.id !== intakeId || parsed.workspaceId !== workspaceId) {
    throw snapshotError(
      "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID",
      "需求 JSON 与数据库身份字段不一致",
      input,
      { intakeId, intakeWorkspaceId: workspaceId, reason: "json_identity_mismatch" },
    );
  }
  const intake = parsed as TaskIntake;
  let workspaceScope: TaskIntake["workspaceScope"];
  try {
    workspaceScope = readIntakeWorkspaceScope(intake.workspaceScope, workspaceId as WorkspaceId, intakeId);
  } catch (cause) {
    throw snapshotError(
      "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID",
      "需求列表中的工作区归属无效",
      input,
      { intakeId, reason: "invalid_workspace_scope" },
      cause,
    );
  }
  return {
    ...intake,
    workspaceScope,
    id: intakeId as IntakeId,
    workspaceId: workspaceId as WorkspaceId,
    title: getTaskIntakeTitle(intake),
    createdAt: requireFiniteNumber(row.intake_created_at, input, "intake.createdAt", intakeId),
    updatedAt: requireFiniteNumber(row.intake_updated_at, input, "intake.updatedAt", intakeId),
  };
}

/** 校验列表状态投影的计数、状态和 latest 指针。 */
function parseListStateRow(
  row: IntakeListPageRow,
  input: NormalizedSnapshotInput,
): {
  intakeId: string;
  listStatus: TaskIntakeListStatus;
  latestInstanceId: string | null;
  latestInstanceStatus: OrchestrationStatus | null;
  instanceCount: number;
} {
  const intakeId = String(row.intake_id ?? "").trim();
  const listStatus = parseListStatus(row.list_status, input, intakeId);
  const latestInstanceId = nullableString(row.latest_instance_id);
  const latestInstanceStatus = row.latest_instance_status == null
    ? null
    : parseOrchestrationStatus(row.latest_instance_status, input, intakeId);
  const instanceCount = requireNonNegativeInteger(row.instance_count, input, "instanceCount", intakeId);
  const stateUpdatedAt = requireFiniteNumber(row.state_updated_at, input, "state.updatedAt", intakeId);
  if (!intakeId || stateUpdatedAt < 0) {
    throw invalidState(input, intakeId, "invalid_identity_or_updated_at", { stateUpdatedAt });
  }
  const emptyStateValid = instanceCount === 0
    && latestInstanceId === null
    && latestInstanceStatus === null
    && listStatus === "not-started";
  const populatedStateValid = instanceCount > 0
    && latestInstanceId !== null
    && latestInstanceStatus !== null
    && listStatus === latestInstanceStatus;
  if (!emptyStateValid && !populatedStateValid) {
    throw invalidState(input, intakeId, "latest_pointer_mismatch", {
      instanceCount,
      latestInstanceId,
      latestInstanceStatus,
      listStatus,
    });
  }
  return { intakeId, listStatus, latestInstanceId, latestInstanceStatus, instanceCount };
}

/** 解析 latest 摘要并在缺行时显式失败。 */
function parseLatestSummary(
  state: ReturnType<typeof parseListStateRow>,
  rowsById: Map<string, OrchInstanceSummaryProjectionRow>,
  artifactCounts: Map<string, number>,
  input: NormalizedSnapshotInput,
): OrchestrationInstanceSummary | null {
  if (!state.latestInstanceId) return null;
  const row = rowsById.get(state.latestInstanceId);
  if (!row) {
    throw new OrchInstanceSummaryProjectionError(
      "ORCH_INSTANCE_SUMMARY_PROJECTION_MISSING",
      "需求列表引用的实例摘要投影不存在",
      {
        requestId: input.requestId,
        workspaceId: String(input.workspaceId),
        intakeId: state.intakeId,
        instanceId: state.latestInstanceId,
        projectionRole: "latest",
      },
    );
  }
  const summary = parseOrchInstanceSummaryProjectionRow(row, {
    instanceId: state.latestInstanceId,
    workspaceId: input.workspaceId,
    intakeId: state.intakeId,
    status: state.latestInstanceStatus ?? undefined,
  }).summary;
  return withArtifactCount(summary, artifactCounts.get(state.latestInstanceId) ?? 0);
}

/** 用实时批量计数覆盖摘要中的产物占位值。 */
function withArtifactCount(summary: OrchestrationInstanceSummary, artifactCount: number): OrchestrationInstanceSummary {
  return {
    ...summary,
    runSummary: {
      ...summary.runSummary,
      artifactCount,
    },
  };
}

/** 从最新关注候选派生列表关注字段。 */
function deriveAttentionMeta(summary: OrchestrationInstanceSummary): AttentionMeta | null {
  if (hasMatchingActiveNode(summary, "waiting-start")) {
    return attentionMeta("waiting-start", "待启动", "open_orch_primary_action");
  }
  if (hasMatchingActiveNode(summary, "waiting-feedback")) {
    return attentionMeta(
      "waiting-feedback",
      summary.runSummary.statusLabel,
      "open_orch_primary_action",
    );
  }
  if (hasMatchingActiveNode(summary, "waiting-approval")) {
    return attentionMeta("waiting-approval", "待审批", "open_orch_primary_action");
  }
  if (summary.status === "failed") return attentionMeta("failed", "异常待处理", "open_orch_monitor");
  if (summary.status === "paused") return attentionMeta("paused", "暂停待处理", "open_orch_monitor");
  return null;
}

/** 判断摘要是否保留了指定等待态的有效活跃节点。 */
function hasMatchingActiveNode(summary: OrchestrationInstanceSummary, status: OrchestrationStatus): boolean {
  return summary.runSummary.activeNodeStatus === status
    && Boolean(String(summary.runSummary.activeNodeId ?? "").trim());
}

/** 构造紧凑的列表关注字段。 */
function attentionMeta(
  status: PendingMineListStatus,
  label: string,
  actionKind: ReminderActionKind,
): AttentionMeta {
  return {
    attentionStatus: status,
    attentionLabel: label,
    attentionActionKind: actionKind,
  };
}

/** 将状态计数行转换为共享接口结构并拒绝损坏状态。 */
function parseStatusCounts(
  rows: StatusCountRow[],
  input: NormalizedSnapshotInput,
): Array<ListStatusCount<TaskIntakeListStatus>> {
  return rows.map((row) => {
    const status = parseListStatus(row.status, input, null);
    return {
      status,
      label: taskIntakeListStatusLabel(status),
      count: requireNonNegativeInteger(row.count, input, "statusCount", null),
    };
  });
}

/** 将产物计数行转换为实例 ID 映射并校验重复项。 */
function parseArtifactCounts(rows: ArtifactCountRow[], input: NormalizedSnapshotInput): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const instanceId = String(row.instance_id ?? "").trim();
    if (!instanceId || counts.has(instanceId)) {
      throw invalidState(input, null, "invalid_artifact_count_identity", { instanceId });
    }
    counts.set(instanceId, requireNonNegativeInteger(row.artifact_count, input, "artifactCount", null));
  }
  return counts;
}

/** 按实例 ID 去重摘要行，重复行视为投影损坏。 */
function uniqueProjectionRowsById(
  rows: OrchInstanceSummaryProjectionRow[],
  input: NormalizedSnapshotInput,
  projectionRole: string,
): Map<string, OrchInstanceSummaryProjectionRow> {
  const byId = new Map<string, OrchInstanceSummaryProjectionRow>();
  for (const row of rows) {
    const instanceId = String(row.instance_id ?? "").trim();
    if (!instanceId || byId.has(instanceId)) {
      throw new OrchInstanceSummaryProjectionError(
        "ORCH_INSTANCE_SUMMARY_PROJECTION_MISMATCH",
        "实例摘要投影返回了重复或空实例 ID",
        {
          requestId: input.requestId,
          workspaceId: String(input.workspaceId),
          instanceId,
          projectionRole,
        },
      );
    }
    byId.set(instanceId, row);
  }
  return byId;
}

/** 按需求 ID 去重关注摘要行并校验来源。 */
function uniqueProjectionRowsByIntakeId(
  rows: OrchInstanceSummaryProjectionRow[],
  input: NormalizedSnapshotInput,
): Map<string, OrchInstanceSummaryProjectionRow> {
  const byIntakeId = new Map<string, OrchInstanceSummaryProjectionRow>();
  for (const row of rows) {
    const intakeId = String(row.intake_id ?? "").trim();
    if (!intakeId || byIntakeId.has(intakeId)) {
      throw new OrchInstanceSummaryProjectionError(
        "ORCH_INSTANCE_SUMMARY_PROJECTION_MISMATCH",
        "关注摘要投影返回了重复或空需求 ID",
        {
          requestId: input.requestId,
          workspaceId: String(input.workspaceId),
          intakeId,
          projectionRole: "attention",
        },
      );
    }
    byIntakeId.set(intakeId, row);
  }
  return byIntakeId;
}

/** 本机归属与原权限相交，列表统计和搜索分页共用同一查询条件。 */
function buildBaseQuery(input: NormalizedSnapshotInput, localIntakeIds: string[] | null, localInstanceIds: string[] | null): {
  fromSql: string;
  whereSql: string;
  params: unknown[];
} {
  const params: unknown[] = [String(input.workspaceId), input.sourceKind];
  if (localInstanceIds !== null) params.unshift(JSON.stringify(localInstanceIds));
  let whereSql = "WHERE s.workspace_id = ? AND s.source_kind = ?";
  if (localIntakeIds !== null) {
    whereSql += " AND s.intake_id IN (SELECT value FROM json_each(?))";
    params.push(JSON.stringify(localIntakeIds));
  }
  if (input.allowedResourceIds) {
    whereSql += ` AND s.intake_id IN (${placeholders(input.allowedResourceIds.length)})`;
    params.push(...input.allowedResourceIds);
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
    fromSql: `FROM ${localInstanceIds === null ? "orch_intake_list_states" : `(
                WITH ranked_summaries AS (
                  SELECT *, COUNT(*) OVER display_order AS instance_count, ROW_NUMBER() OVER display_order AS display_rank
                  FROM orch_instance_summaries
                  WHERE instance_id IN (SELECT value FROM json_each(?))
                  WINDOW display_order AS (PARTITION BY workspace_id, intake_id
                    ORDER BY CASE WHEN status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0 ELSE 1 END,
                      source_updated_at DESC, instance_id DESC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
                )
                SELECT state.workspace_id, state.intake_id, state.source_kind, state.updated_at,
                  COALESCE(selected.status, 'not-started') AS list_status, selected.instance_id AS latest_instance_id,
                  selected.status AS latest_instance_status, COALESCE(selected.instance_count, 0) AS instance_count,
                  json_extract(selected.summary_json, '$.workflowName') AS workflow_name,
                  CASE WHEN json_extract(selected.summary_json, '$.runSummary.progressTotal') > 0
                    THEN json_extract(selected.summary_json, '$.runSummary.progressDone') || '/' || json_extract(selected.summary_json, '$.runSummary.progressTotal') ELSE NULL END AS progress_text
                FROM orch_intake_list_states state
                LEFT JOIN ranked_summaries selected ON selected.workspace_id = state.workspace_id AND selected.intake_id = state.intake_id AND selected.display_rank = 1
              )`} s
              INNER JOIN orch_intakes i
                ON i.workspace_id = s.workspace_id AND i.id = s.intake_id`,
    whereSql,
    params,
  };
}

/** 规范化可跨线程传输的查询输入。 */
function normalizeSnapshotInput(input: OrchIntakeListSnapshotInput): NormalizedSnapshotInput {
  const sourceText = String(input.sourceKind ?? "").trim();
  const sourceKind = sourceText === "scheduled_task" ? "scheduled_task" : "requirement";
  const cursorStatuses = normalizeStringArray(input.statuses);
  return {
    requestId: String(input.requestId ?? "").trim(),
    workspaceId: input.workspaceId,
    limit: Math.min(Math.max(1, Number(input.limit ?? 100) || 100), 500),
    cursor: parseCursor(input.cursor),
    search: normalizeSearch(input.search),
    cursorSearch: nullableString(input.search),
    statuses: normalizeListStatuses(cursorStatuses),
    cursorStatuses,
    sourceKind,
    allowedResourceIds: input.allowedResourceIds == null
      ? null
      : uniqueStrings(input.allowedResourceIds),
    localWorkspaceOnly: input.localWorkspaceOnly === true,
  };
}

/** 构造分页条件签名，保持现有列表接口口径。 */
function buildCursorScope(input: NormalizedSnapshotInput): string {
  return JSON.stringify({
    sourceKind: input.sourceKind,
    search: input.cursorSearch ?? "",
    statuses: input.cursorStatuses,
    allowedResourceIds: input.allowedResourceIds ?? null,
    ...(input.localWorkspaceOnly ? { workspaceScope: { scopeType: "local_workspace", scopeId: input.workspaceId } } : {}),
  });
}

/** 返回无可见资源时的完整空响应。 */
function emptyResponse(cursorScope: string): OrchIntakesListResponseBody {
  return {
    intakes: [],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 0,
    listMetaById: {},
    listPageMeta: { totalCount: 0, cursorScope },
  };
}

/** 规范化合法状态并保持输入顺序去重。 */
function normalizeListStatuses(value: string[]): TaskIntakeListStatus[] {
  const statuses: TaskIntakeListStatus[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const status = String(item ?? "").trim() as TaskIntakeListStatus;
    if (!(status in TASK_INTAKE_STATUS_LABELS) || seen.has(status)) continue;
    seen.add(status);
    statuses.push(status);
  }
  return statuses;
}

/** 规范化游标签名使用的字符串数组，不改变有效项顺序或重复项。 */
function normalizeStringArray(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/** 严格解析列表状态。 */
function parseListStatus(value: unknown, input: NormalizedSnapshotInput, intakeId: string | null): TaskIntakeListStatus {
  const status = typeof value === "string" ? value : "";
  if (status in TASK_INTAKE_STATUS_LABELS) return status as TaskIntakeListStatus;
  throw invalidState(input, intakeId, "invalid_list_status", { status });
}

/** 严格解析实例状态。 */
function parseOrchestrationStatus(
  value: unknown,
  input: NormalizedSnapshotInput,
  intakeId: string,
): OrchestrationStatus {
  const status = parseListStatus(value, input, intakeId);
  if (status !== "not-started") return status;
  throw invalidState(input, intakeId, "invalid_instance_status", { status });
}

/** 返回列表状态的中文文案。 */
function taskIntakeListStatusLabel(status: TaskIntakeListStatus): string {
  return TASK_INTAKE_STATUS_LABELS[status];
}

/** 规范化最长 120 字符的搜索条件。 */
function normalizeSearch(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 120) : null;
}

/** 解析 keyset 游标；无效游标沿用现有接口语义按首页处理。 */
function parseCursor(value: unknown): { updatedAt: number; id: string } | null {
  const cursor = String(value ?? "").trim();
  const separator = cursor.indexOf(":");
  if (separator <= 0) return null;
  const updatedAt = Number(cursor.substring(0, separator));
  const id = cursor.substring(separator + 1);
  return Number.isFinite(updatedAt) && id ? { updatedAt, id } : null;
}

/** 构造 FTS5 trigram 查询，短关键词交给 LIKE。 */
function buildFtsQuery(value: string): string | null {
  if ([...value].length < 3) return null;
  return `"${value.replace(/"/g, '""')}"`;
}

/** 转义 LIKE 通配符。 */
function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

/** 生成固定数量的 SQL 参数占位符。 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 规范化字符串列表并保持输入顺序去重。 */
function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

/** 将空白文本归一为 null。 */
function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** 校验非负整数。 */
function requireNonNegativeInteger(
  value: unknown,
  input: NormalizedSnapshotInput,
  field: string,
  intakeId: string | null = null,
): number {
  const numberValue = Number(value);
  if (Number.isSafeInteger(numberValue) && numberValue >= 0) return numberValue;
  throw invalidState(input, intakeId, "invalid_non_negative_integer", { field, value: numberValue });
}

/** 校验有限数字。 */
function requireFiniteNumber(
  value: unknown,
  input: NormalizedSnapshotInput,
  field: string,
  intakeId: string | null,
): number {
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return numberValue;
  throw invalidState(input, intakeId, "invalid_number", { field, value: String(value) });
}

/** 构造列表状态损坏错误。 */
function invalidState(
  input: NormalizedSnapshotInput,
  intakeId: string | null,
  reason: string,
  details: Readonly<Record<string, unknown>>,
): OrchIntakeListSnapshotError {
  return snapshotError(
    "ORCH_INTAKE_LIST_SNAPSHOT_STATE_INVALID",
    "需求列表状态投影损坏",
    input,
    { intakeId, reason, ...details },
  );
}

/** 附加请求与工作区上下文后构造快照错误。 */
function snapshotError(
  code: OrchIntakeListSnapshotErrorCode,
  message: string,
  input: NormalizedSnapshotInput,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): OrchIntakeListSnapshotError {
  return new OrchIntakeListSnapshotError(code, message, {
    requestId: input.requestId,
    workspaceId: String(input.workspaceId),
    ...details,
  }, cause);
}

/** 构造不含投影正文的完整性错误，供迁移和 Reader 启动边界复用。 */
function projectionIncomplete(
  row: ProjectionIntegrityRow,
  projectionRole: "state" | "search",
  reason: "projection_count_mismatch" | "orphan_projection" | "source_kind_mismatch" | "state_summary_mismatch",
  mismatch?: { field: string; expected: unknown; actual: unknown },
): OrchIntakeListSnapshotError {
  return new OrchIntakeListSnapshotError(
    "ORCH_INTAKE_LIST_PROJECTION_INCOMPLETE",
    "需求列表投影不完整",
    {
      workspaceId: String(row.workspace_id ?? "").trim() || null,
      intakeId: String(row.intake_id ?? "").trim() || null,
      projectionRole,
      expected: mismatch ? mismatch.expected : reason === "projection_count_mismatch" ? 1 : 0,
      actual: mismatch ? mismatch.actual : Number(row.projection_count ?? 0),
      ...(mismatch ? { field: mismatch.field } : {}),
      reason,
    },
  );
}

/** 找出列表状态与窄摘要的首个差异，并返回稳定字段上下文。 */
function stateSummaryProjectionIncomplete(row: ProjectionIntegrityRow): OrchIntakeListSnapshotError {
  const fields = [
    {
      field: "instanceCount",
      expected: Number(row.expected_instance_count),
      actual: Number(row.actual_instance_count),
    },
    {
      field: "latestInstanceId",
      expected: nullableProjectionText(row.expected_latest_instance_id),
      actual: nullableProjectionText(row.actual_latest_instance_id),
    },
    {
      field: "latestInstanceStatus",
      expected: nullableProjectionText(row.expected_latest_instance_status),
      actual: nullableProjectionText(row.actual_latest_instance_status),
    },
    {
      field: "listStatus",
      expected: nullableProjectionText(row.expected_list_status),
      actual: nullableProjectionText(row.actual_list_status),
    },
  ];
  const mismatch = fields.find((item) => item.expected !== item.actual) ?? fields[0]!;
  return projectionIncomplete(row, "state", "state_summary_mismatch", mismatch);
}

/** 将完整性查询的可空文本值规范为字符串或 null。 */
function nullableProjectionText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 兼容只包含部分历史表的迁移修复夹具；Reader 仍会独立要求完整 schema。 */
function sqliteTableExists(db: SqliteDb, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

/** 判断 JSON 值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
