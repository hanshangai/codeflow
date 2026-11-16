import {
  deriveOrchestrationInstanceSummary,
  type IntakeId,
  type NodeExecutionState,
  type OrchestrationId,
  type OrchestrationInstance,
  type OrchestrationInstanceSummary,
  type OrchestrationRuntimeConfig,
  type OrchestrationStatus,
  type ProposalId,
  type TaskIntake,
  type WorkflowDefinition,
  type WorkflowId,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "./sqliteTypes.js";

export const ORCH_INSTANCE_SUMMARY_PROJECTION_VERSION = 1;

const SQL_BATCH_SIZE = 500;
const ORCHESTRATION_STATUSES = new Set<OrchestrationStatus>([
  "pending",
  "running",
  "paused",
  "waiting-start",
  "waiting-approval",
  "waiting-feedback",
  "completed",
  "failed",
  "cancelled",
]);
const SUMMARY_TONES = new Set(["neutral", "info", "success", "warning", "danger"]);
const WAITING_ACTION_KINDS = new Set([
  "start",
  "approval",
  "branch_decision",
  "human_input",
  "review_decision",
  "gate_failure",
  "execution_error",
  "feedback",
]);

export type OrchInstanceSummaryProjectionErrorCode =
  | "ORCH_INSTANCE_SUMMARY_SOURCE_ROW_INVALID"
  | "ORCH_INSTANCE_SUMMARY_SOURCE_JSON_INVALID"
  | "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID"
  | "ORCH_INSTANCE_SUMMARY_PROJECTION_MISMATCH"
  | "ORCH_INSTANCE_SUMMARY_PROJECTION_MISSING";

export type OrchInstanceSummarySourceRow = {
  id: unknown;
  workspace_id: unknown;
  workflow_id: unknown;
  workflow_snapshot_json: unknown;
  proposal_id?: unknown;
  intake_snapshot_json: unknown;
  runtime_config_json?: unknown;
  artifact_index_json?: unknown;
  status: unknown;
  node_states_json?: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export type OrchInstanceSummarySourceOverrides = {
  workflowSnapshot?: WorkflowDefinition;
  intakeSnapshot?: TaskIntake;
  runtimeConfig?: OrchestrationRuntimeConfig | null;
  status?: OrchestrationStatus;
  nodeStates?: Record<string, NodeExecutionState>;
  updatedAt?: number;
};

export type OrchInstanceSummaryProjectionRow = {
  instance_id: unknown;
  workspace_id: unknown;
  intake_id: unknown;
  status: unknown;
  source_updated_at: unknown;
  projection_version: unknown;
  summary_json: unknown;
};

export type OrchInstanceSummaryProjectionExpectation = {
  instanceId?: string;
  workspaceId?: string;
  intakeId?: string;
  status?: OrchestrationStatus;
  sourceUpdatedAt?: number;
};

export type OrchInstanceSummaryProjectionIdentity = {
  instanceId: OrchestrationId;
  workspaceId: WorkspaceId;
  intakeId: IntakeId;
  status: OrchestrationStatus;
  sourceUpdatedAt: number;
  projectionVersion: number;
};

export type OrchInstanceSummaryProjectionRecord = OrchInstanceSummaryProjectionIdentity & {
  summary: OrchestrationInstanceSummary;
  summaryJson: string;
};

/** 摘要投影错误：向调用边界提供稳定 code 和不含原始 JSON 的诊断详情。 */
export class OrchInstanceSummaryProjectionError extends Error {
  /** 构造可检索且不泄露原始投影内容的错误。 */
  constructor(
    public readonly code: OrchInstanceSummaryProjectionErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "OrchInstanceSummaryProjectionError";
  }
}

/** 严格解析实例源行；override 可让增量写路径跳过被替换的大字段。 */
export function parseOrchInstanceSummarySourceRow(
  row: OrchInstanceSummarySourceRow | Record<string, unknown>,
  overrides: OrchInstanceSummarySourceOverrides = {},
): OrchestrationInstance {
  const instanceId = requireSourceText(row?.id, "id");
  const workspaceId = requireSourceText(row?.workspace_id, "workspace_id", instanceId);
  const workflowId = requireSourceText(row?.workflow_id, "workflow_id", instanceId);
  const workflowSnapshot = hasOwn(overrides, "workflowSnapshot")
    ? requireSourceRecord(overrides.workflowSnapshot, "workflowSnapshot", instanceId) as WorkflowDefinition
    : parseSourceJsonRecord(row?.workflow_snapshot_json, "workflow_snapshot_json", instanceId) as WorkflowDefinition;
  const intakeSnapshot = hasOwn(overrides, "intakeSnapshot")
    ? requireSourceRecord(overrides.intakeSnapshot, "intakeSnapshot", instanceId) as TaskIntake
    : parseSourceJsonRecord(row?.intake_snapshot_json, "intake_snapshot_json", instanceId) as TaskIntake;
  const runtimeConfig = hasOwn(overrides, "runtimeConfig")
    ? requireNullableSourceRecord(overrides.runtimeConfig, "runtimeConfig", instanceId) as OrchestrationRuntimeConfig | null
    : parseNullableSourceJsonRecord(row?.runtime_config_json, "runtime_config_json", instanceId) as OrchestrationRuntimeConfig | null;
  const nodeStates = hasOwn(overrides, "nodeStates")
    ? requireSourceRecord(overrides.nodeStates, "nodeStates", instanceId) as Record<string, NodeExecutionState>
    : parseSourceJsonRecord(row?.node_states_json, "node_states_json", instanceId) as Record<string, NodeExecutionState>;
  const status = hasOwn(overrides, "status")
    ? requireSourceStatus(overrides.status, instanceId)
    : requireSourceStatus(row?.status, instanceId);
  const createdAt = requireSourceTimestamp(row?.created_at, "created_at", instanceId);
  const updatedAt = hasOwn(overrides, "updatedAt")
    ? requireSourceTimestamp(overrides.updatedAt, "updatedAt", instanceId)
    : requireSourceTimestamp(row?.updated_at, "updated_at", instanceId);

  validateSourceSnapshotShape(workflowSnapshot, intakeSnapshot, instanceId);
  return {
    id: instanceId as OrchestrationId,
    workspaceId: workspaceId as WorkspaceId,
    workflowId: workflowId as WorkflowId,
    proposalId: normalizeOptionalSourceText(row?.proposal_id, "proposal_id", instanceId) as ProposalId | null,
    intakeSnapshot,
    workflowSnapshot,
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig,
    artifactIndex: {},
    masterThreadId: null,
    status,
    nodeStates,
    createdAt,
    updatedAt,
  };
}

/** 从完整实例构建版本化窄投影；持久摘要不包含 ACL 字段且 artifactCount 固定为 0。 */
export function buildOrchInstanceSummaryProjection(
  instance: OrchestrationInstance,
): OrchInstanceSummaryProjectionRecord {
  const derived = deriveOrchestrationInstanceSummary(instance, { artifactCount: 0 });
  const { sharedContext: _sharedContext, readOnly: _readOnly, ...persistedSummary } = derived;
  const summary = persistedSummary as OrchestrationInstanceSummary;
  const record: OrchInstanceSummaryProjectionRecord = {
    instanceId: summary.id,
    workspaceId: summary.workspaceId,
    intakeId: summary.intakeId,
    status: summary.status,
    sourceUpdatedAt: summary.updatedAt,
    projectionVersion: ORCH_INSTANCE_SUMMARY_PROJECTION_VERSION,
    summary,
    summaryJson: JSON.stringify(summary),
  };
  return parseOrchInstanceSummaryProjectionRow(toProjectionRow(record));
}

/** 在当前 writer 事务中新增或替换实例摘要投影。 */
export function upsertOrchInstanceSummaryProjection(
  db: SqliteDb,
  instance: OrchestrationInstance,
): OrchInstanceSummaryProjectionRecord {
  const projection = buildOrchInstanceSummaryProjection(instance);
  db.prepare(
    `INSERT INTO orch_instance_summaries (
       instance_id, workspace_id, intake_id, status,
       source_updated_at, projection_version, summary_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       intake_id = excluded.intake_id,
       status = excluded.status,
       source_updated_at = excluded.source_updated_at,
       projection_version = excluded.projection_version,
       summary_json = excluded.summary_json`,
  ).run(
    String(projection.instanceId),
    String(projection.workspaceId),
    String(projection.intakeId),
    String(projection.status),
    projection.sourceUpdatedAt,
    projection.projectionVersion,
    projection.summaryJson,
  );
  return projection;
}

/** 严格解析源行并在当前 writer 事务中写入摘要投影。 */
export function upsertOrchInstanceSummaryProjectionFromSourceRow(
  db: SqliteDb,
  row: OrchInstanceSummarySourceRow | Record<string, unknown>,
  overrides: OrchInstanceSummarySourceOverrides = {},
): OrchInstanceSummaryProjectionRecord {
  return upsertOrchInstanceSummaryProjection(db, parseOrchInstanceSummarySourceRow(row, overrides));
}

/** 推进原投影；故障暂停只更新显式状态，保留上次节点统计，不重读损坏源字段。 */
export function touchOrchInstanceSummaryProjection(
  db: SqliteDb,
  input: { instanceId: OrchestrationId | string; sourceUpdatedAt: number; status?: "paused"; expectation?: OrchInstanceSummaryProjectionExpectation },
): OrchInstanceSummaryProjectionRecord {
  const instanceId = requireQueryText(input.instanceId, "instanceId");
  const sourceUpdatedAt = requireProjectionTimestamp(input.sourceUpdatedAt, instanceId, "sourceUpdatedAt");
  const row = selectProjectionRowById(db, instanceId);
  if (!row) throw missingOrchInstanceSummaryProjectionError(instanceId);
  const current = parseOrchInstanceSummaryProjectionRow(row, { ...input.expectation, instanceId });
  const status = input.status ?? current.status;
  const summary = { ...current.summary, status, updatedAt: sourceUpdatedAt,
    ...(input.status === "paused" ? { runSummary: { ...current.summary.runSummary, statusLabel: "已暂停", statusTone: "warning" as const,
      detailText: "实例恢复失败，节点摘要保留上次记录。", waitingActionKind: null } } : {}) };
  const updated = parseOrchInstanceSummaryProjectionRow(
    toProjectionRow({
      ...current,
      status,
      sourceUpdatedAt,
      summary,
      summaryJson: JSON.stringify(summary),
    }),
  );
  db.prepare(
    `UPDATE orch_instance_summaries
     SET status = ?, source_updated_at = ?, summary_json = ?
     WHERE instance_id = ?`,
  ).run(status, sourceUpdatedAt, updated.summaryJson, instanceId);
  return updated;
}

/** 轻量读取投影 identity；不存在时返回 null，不读取 summary_json。 */
export function getOrchInstanceSummaryProjectionIdentity(
  db: SqliteDb,
  instanceId: OrchestrationId | string,
): OrchInstanceSummaryProjectionIdentity | null {
  const normalizedId = requireQueryText(instanceId, "instanceId");
  const row = db.prepare(
    `SELECT instance_id, workspace_id, intake_id, status,
            source_updated_at, projection_version
     FROM orch_instance_summaries WHERE instance_id = ?`,
  ).get(normalizedId) as Omit<OrchInstanceSummaryProjectionRow, "summary_json"> | undefined;
  return row ? parseProjectionIdentity(row) : null;
}

/** 轻量读取投影 identity；作为 Repo 写路径使用的语义化入口。 */
export function readOrchInstanceSummaryProjectionIdentity(
  db: SqliteDb,
  instanceId: OrchestrationId | string,
): OrchInstanceSummaryProjectionIdentity | null {
  return getOrchInstanceSummaryProjectionIdentity(db, instanceId);
}

/** 严格读取投影 identity；缺失时显式抛出稳定错误。 */
export function requireOrchInstanceSummaryProjectionIdentity(
  db: SqliteDb,
  instanceId: OrchestrationId | string,
): OrchInstanceSummaryProjectionIdentity {
  const normalizedId = requireQueryText(instanceId, "instanceId");
  const identity = getOrchInstanceSummaryProjectionIdentity(db, normalizedId);
  if (!identity) throw missingOrchInstanceSummaryProjectionError(normalizedId);
  return identity;
}

/** 创建统一的投影缺失错误，供跨模块严格读路径复用。 */
export function missingOrchInstanceSummaryProjectionError(
  instanceId: OrchestrationId | string,
  details: Readonly<Record<string, unknown>> = {},
): OrchInstanceSummaryProjectionError {
  const normalizedId = String(instanceId ?? "").trim();
  return new OrchInstanceSummaryProjectionError(
    "ORCH_INSTANCE_SUMMARY_PROJECTION_MISSING",
    `编排实例摘要投影不存在：${normalizedId || "unknown"}`,
    { ...details, instanceId: normalizedId || null },
  );
}

/** 严格解析窄表行，并校验行元数据、JSON 元数据和投影版本完全一致。 */
export function parseOrchInstanceSummaryProjectionRow(
  row: OrchInstanceSummaryProjectionRow,
  expected: OrchInstanceSummaryProjectionExpectation = {},
): OrchInstanceSummaryProjectionRecord {
  const identity = parseProjectionIdentity(row);
  validateProjectionExpectation(identity, expected);
  const summary = parseProjectionSummaryJson(row?.summary_json, identity.instanceId);
  validateProjectionSummary(summary, identity);
  return {
    ...identity,
    summary,
    summaryJson: JSON.stringify(summary),
  };
}

/** 只从窄摘要表读取并批量叠加 artifact 数量，不缓存也不回退详情表。 */
export class OrchInstanceSummaryProjectionReader {
  /** 绑定独立读连接或当前 writer 连接。 */
  constructor(private readonly db: SqliteDb) {}

  /** 按 ID 严格读取单个摘要；投影缺失或损坏时显式失败。 */
  requireById(instanceId: OrchestrationId | string): OrchestrationInstanceSummary {
    const normalizedId = requireQueryText(instanceId, "instanceId");
    const summary = this.loadByIds([normalizedId]).get(normalizedId);
    if (!summary) throw missingOrchInstanceSummaryProjectionError(normalizedId);
    return summary;
  }

  /** 按 ID 批量严格读取摘要，并用一次分组查询覆盖 artifactCount。 */
  loadByIds(instanceIds: Array<OrchestrationId | string>): Map<string, OrchestrationInstanceSummary> {
    const ids = normalizeQueryIds(instanceIds);
    if (ids.length === 0) return new Map();
    const projections = new Map<string, OrchInstanceSummaryProjectionRecord>();
    for (const batch of batches(ids)) {
      const rows = this.db.prepare(
        `SELECT instance_id, workspace_id, intake_id, status,
                source_updated_at, projection_version, summary_json
         FROM orch_instance_summaries
         WHERE instance_id IN (${placeholders(batch.length)})`,
      ).all(...batch) as OrchInstanceSummaryProjectionRow[];
      for (const row of rows) {
        const projection = parseOrchInstanceSummaryProjectionRow(row);
        projections.set(String(projection.instanceId), projection);
      }
    }
    for (const id of ids) {
      if (!projections.has(id)) throw missingOrchInstanceSummaryProjectionError(id);
    }
    return this.withArtifactCounts(ids.map((id) => projections.get(id)!));
  }

  /** 按工作区读取全部摘要，顺序与实例最近更新时间一致。 */
  listByWorkspace(workspaceId: WorkspaceId | string): OrchestrationInstanceSummary[] {
    const normalizedWorkspaceId = requireQueryText(workspaceId, "workspaceId");
    const rows = this.db.prepare(
      `SELECT instance_id, workspace_id, intake_id, status,
              source_updated_at, projection_version, summary_json
       FROM orch_instance_summaries
       WHERE workspace_id = ?
       ORDER BY source_updated_at DESC, instance_id DESC`,
    ).all(normalizedWorkspaceId) as OrchInstanceSummaryProjectionRow[];
    const projections = rows.map((row) => parseOrchInstanceSummaryProjectionRow(row, {
      workspaceId: normalizedWorkspaceId,
    }));
    return [...this.withArtifactCounts(projections).values()];
  }

  /** 按单个需求读取摘要，严格限定 workspace 和 intake。 */
  listByIntake(
    workspaceId: WorkspaceId | string,
    intakeId: IntakeId | string,
  ): OrchestrationInstanceSummary[] {
    return this.listByIntakeIds(workspaceId, [intakeId]);
  }

  /** 按多个需求批量读取摘要，避免逐需求查询。 */
  listByIntakeIds(
    workspaceId: WorkspaceId | string,
    intakeIds: Array<IntakeId | string>,
  ): OrchestrationInstanceSummary[] {
    const normalizedWorkspaceId = requireQueryText(workspaceId, "workspaceId");
    const ids = normalizeQueryIds(intakeIds);
    if (ids.length === 0) return [];
    const allowedIds = new Set(ids);
    const projections: OrchInstanceSummaryProjectionRecord[] = [];
    for (const batch of batches(ids)) {
      const rows = this.db.prepare(
        `SELECT instance_id, workspace_id, intake_id, status,
                source_updated_at, projection_version, summary_json
         FROM orch_instance_summaries
         WHERE workspace_id = ?
           AND intake_id IN (${placeholders(batch.length)})
         ORDER BY source_updated_at DESC, instance_id DESC`,
      ).all(normalizedWorkspaceId, ...batch) as OrchInstanceSummaryProjectionRow[];
      for (const row of rows) {
        const projection = parseOrchInstanceSummaryProjectionRow(row, { workspaceId: normalizedWorkspaceId });
        if (!allowedIds.has(String(projection.intakeId))) {
          throw projectionMismatch(projection.instanceId, "intakeId", "query_scope_mismatch");
        }
        projections.push(projection);
      }
    }
    projections.sort((left, right) =>
      right.sourceUpdatedAt - left.sourceUpdatedAt
      || String(right.instanceId).localeCompare(String(left.instanceId)));
    return [...this.withArtifactCounts(projections).values()];
  }

  /** 批量查询 artifact 数量并覆盖内存结果，持久摘要始终保持 artifactCount=0。 */
  private withArtifactCounts(
    projections: OrchInstanceSummaryProjectionRecord[],
  ): Map<string, OrchestrationInstanceSummary> {
    const counts = new Map<string, number>();
    const ids = projections.map((item) => String(item.instanceId));
    for (const batch of batches(ids)) {
      const rows = this.db.prepare(
        `SELECT instance_id, COUNT(1) AS total
         FROM orch_artifacts
         WHERE instance_id IN (${placeholders(batch.length)})
         GROUP BY instance_id`,
      ).all(...batch) as Array<{ instance_id: unknown; total: unknown }>;
      for (const row of rows) {
        const instanceId = requireQueryText(row.instance_id, "instanceId");
        const total = Number(row.total);
        if (!Number.isSafeInteger(total) || total < 0) {
          throw projectionMismatch(instanceId, "artifactCount", "invalid_count");
        }
        counts.set(instanceId, total);
      }
    }
    return new Map(projections.map((projection) => {
      const instanceId = String(projection.instanceId);
      return [instanceId, withArtifactCount(projection.summary, counts.get(instanceId) ?? 0)] as const;
    }));
  }
}

/** 将构建结果转换成数据库行形态，统一复用严格校验。 */
function toProjectionRow(record: OrchInstanceSummaryProjectionRecord): OrchInstanceSummaryProjectionRow {
  return {
    instance_id: record.instanceId,
    workspace_id: record.workspaceId,
    intake_id: record.intakeId,
    status: record.status,
    source_updated_at: record.sourceUpdatedAt,
    projection_version: record.projectionVersion,
    summary_json: record.summaryJson,
  };
}

/** 按 ID 从窄表读取完整投影行。 */
function selectProjectionRowById(db: SqliteDb, instanceId: string): OrchInstanceSummaryProjectionRow | null {
  const row = db.prepare(
    `SELECT instance_id, workspace_id, intake_id, status,
            source_updated_at, projection_version, summary_json
     FROM orch_instance_summaries WHERE instance_id = ?`,
  ).get(instanceId) as OrchInstanceSummaryProjectionRow | undefined;
  return row ?? null;
}

/** 解析窄表 identity，并拒绝未知版本或无效元数据。 */
function parseProjectionIdentity(
  row: Omit<OrchInstanceSummaryProjectionRow, "summary_json"> | OrchInstanceSummaryProjectionRow,
): OrchInstanceSummaryProjectionIdentity {
  if (!isRecord(row)) {
    throw projectionJsonInvalid(null, "row", "expected_object");
  }
  const instanceId = requireProjectionText(row.instance_id, null, "instance_id");
  const projectionVersion = Number(row.projection_version);
  if (projectionVersion !== ORCH_INSTANCE_SUMMARY_PROJECTION_VERSION) {
    throw projectionMismatch(instanceId, "projection_version", "unsupported_version", {
      expected: ORCH_INSTANCE_SUMMARY_PROJECTION_VERSION,
      actual: Number.isFinite(projectionVersion) ? projectionVersion : null,
    });
  }
  return {
    instanceId: instanceId as OrchestrationId,
    workspaceId: requireProjectionText(row.workspace_id, instanceId, "workspace_id") as WorkspaceId,
    intakeId: requireProjectionText(row.intake_id, instanceId, "intake_id") as IntakeId,
    status: requireProjectionStatus(row.status, instanceId),
    sourceUpdatedAt: requireProjectionTimestamp(row.source_updated_at, instanceId, "source_updated_at"),
    projectionVersion,
  };
}

/** 校验调用侧已知元数据，阻止串 workspace 或陈旧投影被当作有效结果。 */
function validateProjectionExpectation(
  identity: OrchInstanceSummaryProjectionIdentity,
  expected: OrchInstanceSummaryProjectionExpectation,
): void {
  const comparisons: Array<[string, unknown, unknown]> = [
    ["instance_id", expected.instanceId, identity.instanceId],
    ["workspace_id", expected.workspaceId, identity.workspaceId],
    ["intake_id", expected.intakeId, identity.intakeId],
    ["status", expected.status, identity.status],
    ["source_updated_at", expected.sourceUpdatedAt, identity.sourceUpdatedAt],
  ];
  for (const [field, expectedValue, actualValue] of comparisons) {
    if (expectedValue !== undefined && expectedValue !== actualValue) {
      throw projectionMismatch(identity.instanceId, field, "expected_value_mismatch", {
        expected: expectedValue,
        actual: actualValue,
      });
    }
  }
}

/** 解析持久摘要 JSON；语法错误与形状错误都不携带原始文本。 */
function parseProjectionSummaryJson(raw: unknown, instanceId: OrchestrationId): OrchestrationInstanceSummary {
  if (typeof raw !== "string" || raw.length === 0) {
    throw projectionJsonInvalid(instanceId, "summary_json", "expected_non_empty_string");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw projectionJsonInvalid(instanceId, "summary_json", "invalid_json");
  }
  if (!isRecord(value)) {
    throw projectionJsonInvalid(instanceId, "summary_json", "expected_object");
  }
  return value as OrchestrationInstanceSummary;
}

/** 严格校验摘要形状及其与窄表元数据的一致性。 */
function validateProjectionSummary(
  summary: OrchestrationInstanceSummary,
  identity: OrchInstanceSummaryProjectionIdentity,
): void {
  const value = summary as unknown as Record<string, unknown>;
  validateSummaryShape(value, identity.instanceId);
  const runSummary = value.runSummary as Record<string, unknown>;
  const comparisons: Array<[string, unknown, unknown]> = [
    ["summary.id", identity.instanceId, value.id],
    ["summary.workspaceId", identity.workspaceId, value.workspaceId],
    ["summary.intakeId", identity.intakeId, value.intakeId],
    ["summary.status", identity.status, value.status],
    ["summary.updatedAt", identity.sourceUpdatedAt, value.updatedAt],
    ["summary.runSummary.instanceId", identity.instanceId, runSummary.instanceId],
  ];
  for (const [field, expected, actual] of comparisons) {
    if (expected !== actual) {
      throw projectionMismatch(identity.instanceId, field, "summary_metadata_mismatch");
    }
  }
  if (runSummary.artifactCount !== 0) {
    throw projectionMismatch(identity.instanceId, "summary.runSummary.artifactCount", "persisted_count_must_be_zero");
  }
  if (hasOwn(value, "sharedContext") || hasOwn(value, "readOnly")) {
    throw projectionMismatch(identity.instanceId, "summary.acl", "acl_fields_not_allowed");
  }
}

/** 校验摘要公共字段，防止合法 JSON 但错误结构进入列表响应。 */
function validateSummaryShape(value: Record<string, unknown>, instanceId: OrchestrationId): void {
  requireSummaryText(value.id, instanceId, "summary.id");
  requireSummaryText(value.workspaceId, instanceId, "summary.workspaceId");
  requireSummaryText(value.workflowId, instanceId, "summary.workflowId");
  requireNullableSummaryText(value.proposalId, instanceId, "summary.proposalId");
  requireSummaryText(value.intakeId, instanceId, "summary.intakeId");
  requireSummaryString(value.intakeTitle, instanceId, "summary.intakeTitle");
  requireSummaryString(value.intakeGoalPreview, instanceId, "summary.intakeGoalPreview");
  requireNullableSummaryText(value.workflowName, instanceId, "summary.workflowName");
  requireProjectionStatus(value.status, String(instanceId));
  requireSummaryTimestamp(value.createdAt, instanceId, "summary.createdAt");
  requireSummaryTimestamp(value.updatedAt, instanceId, "summary.updatedAt");
  if (!isRecord(value.runSummary)) {
    throw projectionJsonInvalid(instanceId, "summary.runSummary", "expected_object");
  }
  validateRunSummaryShape(value.runSummary, instanceId);
}

/** 校验运行摘要字段，保证下游无需对损坏投影做静默兜底。 */
function validateRunSummaryShape(value: Record<string, unknown>, instanceId: OrchestrationId): void {
  requireSummaryText(value.instanceId, instanceId, "summary.runSummary.instanceId");
  requireSummaryString(value.statusLabel, instanceId, "summary.runSummary.statusLabel");
  if (!SUMMARY_TONES.has(String(value.statusTone))) {
    throw projectionJsonInvalid(instanceId, "summary.runSummary.statusTone", "invalid_enum");
  }
  requireNonNegativeSummaryNumber(value.progressDone, instanceId, "summary.runSummary.progressDone");
  requireNonNegativeSummaryNumber(value.progressTotal, instanceId, "summary.runSummary.progressTotal");
  const progressRatio = requireSummaryNumber(value.progressRatio, instanceId, "summary.runSummary.progressRatio");
  if (progressRatio < 0 || progressRatio > 1) {
    throw projectionJsonInvalid(instanceId, "summary.runSummary.progressRatio", "out_of_range");
  }
  requireSummaryString(value.progressText, instanceId, "summary.runSummary.progressText");
  requireNullableSummaryString(value.detailText, instanceId, "summary.runSummary.detailText");
  requireNullableSummaryText(value.activeNodeId, instanceId, "summary.runSummary.activeNodeId");
  requireNullableSummaryString(value.activeNodeLabel, instanceId, "summary.runSummary.activeNodeLabel");
  requireNullableSummaryText(value.activeNodeStatus, instanceId, "summary.runSummary.activeNodeStatus");
  if (value.activeNodeAssigneeUserIds != null && !isStringArray(value.activeNodeAssigneeUserIds)) {
    throw projectionJsonInvalid(instanceId, "summary.runSummary.activeNodeAssigneeUserIds", "expected_string_array_or_null");
  }
  if (value.waitingActionKind != null && !WAITING_ACTION_KINDS.has(String(value.waitingActionKind))) {
    throw projectionJsonInvalid(instanceId, "summary.runSummary.waitingActionKind", "invalid_enum");
  }
  requireNonNegativeSummaryNumber(value.artifactCount, instanceId, "summary.runSummary.artifactCount");
}

/** 校验源快照中摘要派生必需的最小结构。 */
function validateSourceSnapshotShape(
  workflowSnapshot: WorkflowDefinition,
  intakeSnapshot: TaskIntake,
  instanceId: string,
): void {
  const nodes = (workflowSnapshot as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) {
    throw sourceJsonInvalid(instanceId, "workflow_snapshot_json", "nodes_not_array");
  }
  if (nodes.some((node) => !isRecord(node))) {
    throw sourceJsonInvalid(instanceId, "workflow_snapshot_json", "node_not_object");
  }
  const intakeId = String((intakeSnapshot as { id?: unknown }).id ?? "").trim();
  if (!intakeId) throw sourceJsonInvalid(instanceId, "intake_snapshot_json", "id_missing");
}

/** 严格解析源行 JSON 对象，错误中不附带原始文本。 */
function parseSourceJsonRecord(raw: unknown, field: string, instanceId: string): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) {
    throw sourceJsonInvalid(instanceId, field, "expected_non_empty_string");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw sourceJsonInvalid(instanceId, field, "invalid_json");
  }
  return requireSourceRecord(value, field, instanceId);
}

/** 严格解析可空源行 JSON 对象。 */
function parseNullableSourceJsonRecord(
  raw: unknown,
  field: string,
  instanceId: string,
): Record<string, unknown> | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0) {
    throw sourceJsonInvalid(instanceId, field, "expected_non_empty_string");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw sourceJsonInvalid(instanceId, field, "invalid_json");
  }
  return requireNullableSourceRecord(value, field, instanceId);
}

/** 校验源 JSON 或 override 为普通对象。 */
function requireSourceRecord(value: unknown, field: string, instanceId: string): Record<string, unknown> {
  if (!isRecord(value)) throw sourceJsonInvalid(instanceId, field, "expected_object");
  return value;
}

/** 校验源运行配置为普通对象或 null。 */
function requireNullableSourceRecord(
  value: unknown,
  field: string,
  instanceId: string,
): Record<string, unknown> | null {
  if (value === null) return null;
  return requireSourceRecord(value, field, instanceId);
}

/** 校验源行必填文本。 */
function requireSourceText(value: unknown, field: string, instanceId?: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return text;
  throw new OrchInstanceSummaryProjectionError(
    "ORCH_INSTANCE_SUMMARY_SOURCE_ROW_INVALID",
    `编排实例摘要源行字段无效：${field}`,
    { instanceId: instanceId ?? null, field, reason: "expected_non_empty_string" },
  );
}

/** 规范源行可空文本，并拒绝非文本值。 */
function normalizeOptionalSourceText(value: unknown, field: string, instanceId: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new OrchInstanceSummaryProjectionError(
      "ORCH_INSTANCE_SUMMARY_SOURCE_ROW_INVALID",
      `编排实例摘要源行字段无效：${field}`,
      { instanceId, field, reason: "expected_string_or_null" },
    );
  }
  return value.trim() || null;
}

/** 校验源行状态枚举。 */
function requireSourceStatus(value: unknown, instanceId: string): OrchestrationStatus {
  const status = String(value ?? "") as OrchestrationStatus;
  if (ORCHESTRATION_STATUSES.has(status)) return status;
  throw new OrchInstanceSummaryProjectionError(
    "ORCH_INSTANCE_SUMMARY_SOURCE_ROW_INVALID",
    "编排实例摘要源行状态无效",
    { instanceId, field: "status", reason: "invalid_enum" },
  );
}

/** 校验源行时间戳。 */
function requireSourceTimestamp(value: unknown, field: string, instanceId: string): number {
  const timestamp = Number(value);
  if (Number.isSafeInteger(timestamp) && timestamp >= 0) return timestamp;
  throw new OrchInstanceSummaryProjectionError(
    "ORCH_INSTANCE_SUMMARY_SOURCE_ROW_INVALID",
    `编排实例摘要源行时间戳无效：${field}`,
    { instanceId, field, reason: "expected_non_negative_safe_integer" },
  );
}

/** 校验查询范围中的非空 ID。 */
function requireQueryText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return text;
  throw projectionMismatch(null, field, "expected_non_empty_string");
}

/** 去重并严格校验批量查询 ID。 */
function normalizeQueryIds(values: Array<string | OrchestrationId | IntakeId>): string[] {
  return Array.from(new Set(values.map((value) => requireQueryText(value, "id"))));
}

/** 校验投影元数据中的非空文本。 */
function requireProjectionText(value: unknown, instanceId: string | null, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return text;
  throw projectionMismatch(instanceId, field, "expected_non_empty_string");
}

/** 校验投影状态枚举。 */
function requireProjectionStatus(value: unknown, instanceId: string): OrchestrationStatus {
  const status = String(value ?? "") as OrchestrationStatus;
  if (ORCHESTRATION_STATUSES.has(status)) return status;
  throw projectionMismatch(instanceId, "status", "invalid_enum");
}

/** 校验投影时间戳。 */
function requireProjectionTimestamp(value: unknown, instanceId: string, field: string): number {
  const timestamp = Number(value);
  if (Number.isSafeInteger(timestamp) && timestamp >= 0) return timestamp;
  throw projectionMismatch(instanceId, field, "expected_non_negative_safe_integer");
}

/** 校验摘要必填非空文本。 */
function requireSummaryText(value: unknown, instanceId: OrchestrationId, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return text;
  throw projectionJsonInvalid(instanceId, field, "expected_non_empty_string");
}

/** 校验摘要普通字符串，允许空字符串。 */
function requireSummaryString(value: unknown, instanceId: OrchestrationId, field: string): string {
  if (typeof value === "string") return value;
  throw projectionJsonInvalid(instanceId, field, "expected_string");
}

/** 校验摘要可空非空文本。 */
function requireNullableSummaryText(value: unknown, instanceId: OrchestrationId, field: string): string | null {
  if (value === null) return null;
  return requireSummaryText(value, instanceId, field);
}

/** 校验摘要可空字符串。 */
function requireNullableSummaryString(value: unknown, instanceId: OrchestrationId, field: string): string | null {
  if (value === null) return null;
  return requireSummaryString(value, instanceId, field);
}

/** 校验摘要有限数值。 */
function requireSummaryNumber(value: unknown, instanceId: OrchestrationId, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw projectionJsonInvalid(instanceId, field, "expected_finite_number");
}

/** 校验摘要非负数值。 */
function requireNonNegativeSummaryNumber(value: unknown, instanceId: OrchestrationId, field: string): number {
  const number = requireSummaryNumber(value, instanceId, field);
  if (number >= 0) return number;
  throw projectionJsonInvalid(instanceId, field, "expected_non_negative_number");
}

/** 校验摘要时间戳。 */
function requireSummaryTimestamp(value: unknown, instanceId: OrchestrationId, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw projectionJsonInvalid(instanceId, field, "expected_non_negative_safe_integer");
}

/** 创建不含源 JSON 的源字段错误。 */
function sourceJsonInvalid(instanceId: string, field: string, reason: string): OrchInstanceSummaryProjectionError {
  return new OrchInstanceSummaryProjectionError(
    "ORCH_INSTANCE_SUMMARY_SOURCE_JSON_INVALID",
    `编排实例摘要源 JSON 无效：${field}`,
    { instanceId, field, reason },
  );
}

/** 创建不含投影 JSON 原文的解析错误。 */
function projectionJsonInvalid(
  instanceId: OrchestrationId | string | null,
  field: string,
  reason: string,
): OrchInstanceSummaryProjectionError {
  return new OrchInstanceSummaryProjectionError(
    "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID",
    `编排实例摘要投影 JSON 无效：${field}`,
    { instanceId: instanceId ? String(instanceId) : null, field, reason },
  );
}

/** 创建投影元数据不一致错误。 */
function projectionMismatch(
  instanceId: OrchestrationId | string | null,
  field: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): OrchInstanceSummaryProjectionError {
  return new OrchInstanceSummaryProjectionError(
    "ORCH_INSTANCE_SUMMARY_PROJECTION_MISMATCH",
    `编排实例摘要投影元数据不一致：${field}`,
    { ...details, instanceId: instanceId ? String(instanceId) : null, field, reason },
  );
}

/** 在内存结果中覆盖实时 artifact 数量。 */
function withArtifactCount(summary: OrchestrationInstanceSummary, artifactCount: number): OrchestrationInstanceSummary {
  return {
    ...summary,
    runSummary: {
      ...summary.runSummary,
      artifactCount,
    },
  };
}

/** 判断值是否为普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 判断值是否为字符串数组。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

/** 判断对象是否显式提供某字段。 */
function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** 将数组拆成 SQLite 绑定参数的有界批次。 */
function batches<T>(values: T[]): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += SQL_BATCH_SIZE) {
    result.push(values.slice(offset, offset + SQL_BATCH_SIZE));
  }
  return result;
}

/** 生成固定数量的位置参数。 */
function placeholders(size: number): string {
  return Array.from({ length: size }, () => "?").join(", ");
}
