import crypto from "node:crypto";
import {
  canonicalizeOrchAssetJson,
  deriveOrchestrationRunSummary,
  deriveOrchestrationInstanceSummary,
  collectOrchAssetDependencyReferences,
  isPlainOrchAssetRecord,
  readOrchAssetExecutionAuthorization,
  normalizeOrchestrationRunPlanSkippedNodeIds,
  normalizeTaskIntakeTitle,
  type ArtifactId,
  type IntakeId,
  type NodeExecutionRuntimePatch,
  type OrchestrationAssetRuntimeSnapshot,
  type OrchestrationId,
  type OrchestrationInstance,
  type OrchestrationInstanceRuntimePatch,
  type OrchestrationInstanceSummary,
  type OrchestrationRuntimeConfig,
  type OrchestrationRuntimeAssetDefinitionByType,
  type OrchestrationRuntimeAssetSnapshotEntry,
  type OrchestrationRuntimeAssetSource,
  type OrchestrationRuntimeAssetType,
  type OrchestrationStatus,
  type NodeExecutionState,
  type ProposalId,
  type RoleRuntimeDefinition,
  type ToolsetRuntimeDefinition,
  type TaskIntake,
  type TaskIntakeSourceKind,
  type ThreadId,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRuntimeDefinition,
  type WorkflowId,
  type WorkspaceId,
} from "@codeflowai/shared";
import {
  OrchInstanceSummaryProjectionReader,
  missingOrchInstanceSummaryProjectionError,
  parseOrchInstanceSummarySourceRow,
  readOrchInstanceSummaryProjectionIdentity,
  touchOrchInstanceSummaryProjection,
  upsertOrchInstanceSummaryProjection,
} from "../orchInstanceSummaryProjection.js";
import type { SqliteDb } from "../sqliteTypes.js";
import type { OrchIntakeListStateRepo } from "./orchIntakeListStateRepo.js";
import { readIntakeWorkspaceScope } from "./orchIntakeRepo.js";

export class OrchInstanceScopeError extends Error {
  /** 原列实体与固定原因可跨边界追踪，冻结正文不写入异常链。 */
  constructor(readonly details: { instanceId: string; workspaceId: string; field: string; reason: string }) {
    super(`ORCH_INSTANCE_SCOPE_INVALID: instanceId=${details.instanceId} workspaceId=${details.workspaceId} field=${details.field} reason=${details.reason}`);
    this.name = "OrchInstanceScopeError";
  }
  readonly code = "ORCH_INSTANCE_SCOPE_INVALID";
}

/** 已解析冻结事实的唯一执行归属判定；本机配置必须同区，未知和共享不属本机。 */
export function isLocalOrchestrationExecutionFacts(target: {
  workspaceId: string;
  intakeSnapshot?: { workspaceScope?: { scopeType: string; scopeId: string } | null; sharedContext?: { sharedWorkspaceId?: string } | null };
  runtimeConfig?: { executionProfileScope?: { scopeType: string; scopeId: string } | null } | null;
}): boolean {
  return target.intakeSnapshot?.workspaceScope?.scopeType === "local_workspace"
    && target.intakeSnapshot.workspaceScope.scopeId === target.workspaceId
    && !target.intakeSnapshot.sharedContext?.sharedWorkspaceId
    && (target.runtimeConfig?.executionProfileScope == null
      || target.runtimeConfig.executionProfileScope.scopeType === "local_workspace"
        && target.runtimeConfig.executionProfileScope.scopeId === target.workspaceId);
}

const INSTANCE_RUNTIME_PATCH_CACHE_MAX_ENTRIES = 256;
const INSTANCE_RUNTIME_PATCH_WORKFLOW_CACHE_MAX_ENTRIES = 128;

export type OrchestrationInstanceAccessProjection = {
  id: OrchestrationId;
  workspaceId: WorkspaceId;
  intakeId: IntakeId | null;
  sourceKind: TaskIntakeSourceKind;
};

type InstanceRuntimePatchCacheEntry = {
  updatedAt: number;
  patch: OrchestrationInstanceRuntimePatch;
};

type RuntimePatchWorkflowSnapshotCacheEntry = {
  workflowSnapshotJson: string;
  workflowSnapshot: Pick<WorkflowDefinition, "nodes">;
};

/** 编排实例仓储：负责 orch_instances 表的 CRUD。 */
export class OrchInstanceRepo {
  private readonly runtimePatchCache = new Map<string, InstanceRuntimePatchCacheEntry>();
  private readonly runtimePatchWorkflowCache = new Map<string, RuntimePatchWorkflowSnapshotCacheEntry>();

  constructor(
    private readonly db: SqliteDb,
    private readonly listStates: OrchIntakeListStateRepo,
    private readonly summaryReader: OrchInstanceSummaryProjectionReader,
  ) {}

  /** 列出某 workspace 的轻量实例摘要，避免列表接口返回详情级快照。 */
  listSummariesByWorkspace(input: {
    workspaceId: WorkspaceId;
    limit?: number | null;
    allowedResourceIds?: string[] | null;
    allowedInstanceIds?: string[] | null;
    sourceKind?: TaskIntakeSourceKind | null;
  }): { instances: OrchestrationInstanceSummary[]; totalCountByIntake: Record<string, number>; hasMore: boolean } {
    const limit = normalizeSummaryLimit(input.limit);
    const allowedIds = normalizeAllowedResourceIds(input.allowedResourceIds);
    const sourceKind = normalizeTaskIntakeSourceKind(input.sourceKind);
    if (allowedIds && allowedIds.length === 0) {
      return { instances: [], totalCountByIntake: {}, hasMore: false };
    }
    const params: Array<string | number> = [String(input.workspaceId)];
    const instanceFilter = input.allowedInstanceIds ? " AND summary.instance_id IN (SELECT value FROM json_each(?))" : "";
    if (input.allowedInstanceIds) params.push(JSON.stringify(input.allowedInstanceIds));
    const allowedFilter = allowedIds
      ? ` AND summary.intake_id IN (${allowedIds.map(() => "?").join(", ")})`
      : "";
    if (allowedIds) params.push(...allowedIds);
    const sourceFilter = sourceKind
      ? ` AND EXISTS (
            SELECT 1 FROM orch_intake_list_states source_state
            WHERE source_state.workspace_id = summary.workspace_id
              AND source_state.intake_id = summary.intake_id
              AND source_state.source_kind = ?
          )`
      : "";
    if (sourceKind) params.push(sourceKind);
    const rows = this.db.prepare(
      `SELECT summary.instance_id
       FROM orch_instance_summaries summary
       WHERE summary.workspace_id = ?
         ${instanceFilter}
         ${allowedFilter}
         ${sourceFilter}
       ORDER BY CASE
                  WHEN summary.status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0
                  ELSE 1
                END,
                summary.source_updated_at DESC,
                summary.instance_id DESC
       LIMIT ?`,
    ).all(...params, limit + 1) as Array<{ instance_id: string }>;
    const pageRows = rows.slice(0, limit);
    const ids = pageRows.map((row) => String(row.instance_id));
    const summariesById = this.summaryReader.loadByIds(ids);
    return {
      instances: ids.map((id) => summariesById.get(id)!),
      totalCountByIntake: this.countByIntake({ workspaceId: input.workspaceId, allowedResourceIds: allowedIds, allowedInstanceIds: input.allowedInstanceIds, sourceKind }),
      hasMore: rows.length > limit,
    };
  }

  /** 统计某 workspace 下各需求的实例数量，用于分页列表仍显示准确执行次数。 */
  countByIntake(input: { workspaceId: WorkspaceId; allowedResourceIds?: string[] | null; allowedInstanceIds?: string[] | null; sourceKind?: TaskIntakeSourceKind | null }): Record<string, number> {
    const allowedIds = normalizeAllowedResourceIds(input.allowedResourceIds);
    const sourceKind = normalizeTaskIntakeSourceKind(input.sourceKind);
    if (allowedIds && allowedIds.length === 0) return {};
    const params: Array<string | number> = [String(input.workspaceId)];
    const instanceFilter = input.allowedInstanceIds ? " AND summary.instance_id IN (SELECT value FROM json_each(?))" : "";
    if (input.allowedInstanceIds) params.push(JSON.stringify(input.allowedInstanceIds));
    const allowedFilter = allowedIds
      ? ` AND summary.intake_id IN (${allowedIds.map(() => "?").join(", ")})`
      : "";
    if (allowedIds) params.push(...allowedIds);
    const sourceFilter = sourceKind
      ? ` AND EXISTS (
            SELECT 1 FROM orch_intake_list_states source_state
            WHERE source_state.workspace_id = summary.workspace_id
              AND source_state.intake_id = summary.intake_id
              AND source_state.source_kind = ?
          )`
      : "";
    if (sourceKind) params.push(sourceKind);
    const rows = this.db
      .prepare(
        `SELECT summary.intake_id, COUNT(1) AS total
         FROM orch_instance_summaries summary
         WHERE summary.workspace_id = ?
           ${instanceFilter}
           ${allowedFilter}
           ${sourceFilter}
         GROUP BY summary.intake_id`,
      )
      .all(...params) as any[];
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const intakeId = String(row.intake_id ?? "").trim();
      if (!intakeId) continue;
      counts[intakeId] = (counts[intakeId] ?? 0) + Number(row.total ?? 0);
    }
    return counts;
  }

  /** 列出 workspace 实例；权限入口须严格读取原始归属与节点绑定，禁止损坏数据降为本机。 */
  listByWorkspace(workspaceId: WorkspaceId, options?: { strictScope?: boolean; threadId?: ThreadId }): OrchestrationInstance[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, workflow_id, workflow_snapshot_json,
                asset_runtime_snapshot_json, proposal_id, intake_snapshot_json, role_snapshots_json,
                toolset_snapshots_json, runtime_config_json,
                artifact_index_json, master_thread_id, status,
                node_states_json, created_at, updated_at,
                (SELECT intake_id FROM orch_instance_summaries WHERE instance_id = orch_instances.id) AS frozen_intake_id
         FROM orch_instances WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(String(workspaceId)) as any[];
    const selected = options?.threadId ? rows.filter(row => Object.values(readStrictInstanceNodeStates(row)).some(state =>
      state.threadId === options.threadId || state.discussionThreadId === options.threadId || state.previousThreadIds?.includes(options.threadId!))) : rows;
    return selected.map(row => rowToInstance(row, options?.strictScope));
  }

  /** 按 intake ID 批量读取实例摘要，用于列表和待办提醒态。 */
  listSummariesByIntakeIds(workspaceId: WorkspaceId, intakeIds: Array<IntakeId | string>): OrchestrationInstanceSummary[] {
    const ids = normalizeAllowedResourceIds(intakeIds);
    if (!ids || ids.length === 0) return [];
    return this.summaryReader.listByIntakeIds(workspaceId, ids);
  }

  /** 读取提醒聚合所需的全部轻量摘要，不触碰实例详情 JSON。 */
  listReminderSummariesByWorkspace(workspaceId: WorkspaceId): OrchestrationInstanceSummary[] {
    return this.summaryReader.listByWorkspace(workspaceId);
  }

  /**
   * 批量判断实例是否仍存在，只读 id 列。
   * 调用方按实例判卡片可见性，不能用 get()：那会解析整行大 JSON，而该判定既被 4s 面板轮询也被每轮 developerMessage 触发。
   */
  listExistingIds(ids: readonly string[]): Set<string> {
    const normalized = [...new Set(ids.map(id => String(id ?? "").trim()).filter(Boolean))];
    if (!normalized.length) return new Set();
    const placeholders = normalized.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT id FROM orch_instances WHERE id IN (${placeholders})`).all(...normalized) as Array<{ id: string }>;
    return new Set(rows.map(row => String(row.id)));
  }

  /** 获取实例；本机严格模式核对冻结事实及原摘要身份，不存在返回 null。 */
  get(id: OrchestrationId, options?: { strictScope?: boolean }): OrchestrationInstance | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, workflow_id, workflow_snapshot_json,
                asset_runtime_snapshot_json, proposal_id, intake_snapshot_json, role_snapshots_json,
                toolset_snapshots_json, runtime_config_json,
                artifact_index_json, master_thread_id, status,
                node_states_json, created_at, updated_at,
                (SELECT intake_id FROM orch_instance_summaries WHERE instance_id = orch_instances.id) AS frozen_intake_id
         FROM orch_instances WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    if (!row) return null;
    return rowToInstance(row, options?.strictScope);
  }

  /** 只读取共享 ACL 所需字段；来源兜底仅解析 intake requester 标记。 */
  getAccessProjection(id: OrchestrationId): OrchestrationInstanceAccessProjection | null {
    const row = this.db
      .prepare(
        `SELECT summary.instance_id AS id,
                summary.workspace_id,
                summary.intake_id,
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM orch_intake_list_states scheduled_state
                    WHERE scheduled_state.workspace_id = summary.workspace_id
                      AND scheduled_state.intake_id = summary.intake_id
                      AND scheduled_state.source_kind = 'scheduled_task'
                  ) THEN 'scheduled_task'
                  WHEN EXISTS (
                    SELECT 1 FROM orch_intake_list_states requirement_state
                    WHERE requirement_state.workspace_id = summary.workspace_id
                      AND requirement_state.intake_id = summary.intake_id
                      AND requirement_state.source_kind = 'requirement'
                  ) THEN 'requirement'
                  WHEN json_extract(instance.intake_snapshot_json, '$.requester.source') = 'scheduled_task'
                    THEN 'scheduled_task'
                  ELSE 'requirement'
                END AS source_kind
         FROM orch_instance_summaries summary
         JOIN orch_instances instance ON instance.id = summary.instance_id
         WHERE summary.instance_id = ?
         LIMIT 1`,
      )
      .get(String(id)) as any | undefined;
    if (!row) {
      const fact = this.db
        .prepare("SELECT 1 AS found FROM orch_instances WHERE id = ?")
        .get(String(id)) as { found?: number } | undefined;
      if (fact?.found) {
        throw missingOrchInstanceSummaryProjectionError(id, { projectionRole: "access" });
      }
      return null;
    }
    const intakeId = String(row.intake_id ?? "").trim();
    return {
      id: row.id as OrchestrationId,
      workspaceId: row.workspace_id as WorkspaceId,
      intakeId: intakeId ? intakeId as IntakeId : null,
      sourceKind: row.source_kind === "scheduled_task" ? "scheduled_task" : "requirement",
    };
  }

  /** 按 updated_at 复用运行态补丁，避免轮询重复解析实例大 JSON。 */
  getRuntimePatch(id: OrchestrationId): OrchestrationInstanceRuntimePatch | null {
    const cacheKey = String(id);
    const versionRow = this.db
      .prepare("SELECT updated_at FROM orch_instances WHERE id = ?")
      .get(cacheKey) as { updated_at?: number } | undefined;
    if (!versionRow) {
      this.runtimePatchCache.delete(cacheKey);
      this.runtimePatchWorkflowCache.delete(cacheKey);
      return null;
    }
    const updatedAt = Number(versionRow.updated_at ?? 0);
    const cached = this.runtimePatchCache.get(cacheKey);
    if (cached?.updatedAt === updatedAt) {
      rememberBoundedCache(this.runtimePatchCache, cacheKey, cached, INSTANCE_RUNTIME_PATCH_CACHE_MAX_ENTRIES);
      return cached.patch;
    }
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, workflow_id, workflow_snapshot_json,
                proposal_id, json_extract(intake_snapshot_json, '$.id') AS intake_id,
                json_extract(runtime_config_json, '$.initiatorUserId') AS initiator_user_id,
                artifact_index_json, status, node_states_json, created_at, updated_at,
                CASE WHEN (${scheduledInstancePredicateSql()}) THEN 'scheduled_task' ELSE 'requirement' END AS source_kind,
                (SELECT COUNT(1) FROM orch_artifacts WHERE orch_artifacts.instance_id = orch_instances.id) AS artifact_count
         FROM orch_instances WHERE id = ?`,
      )
      .get(cacheKey) as any | undefined;
    if (!row) {
      this.runtimePatchWorkflowCache.delete(cacheKey);
      return null;
    }
    const patch = this.buildRuntimePatch(row);
    rememberBoundedCache(
      this.runtimePatchCache,
      cacheKey,
      { updatedAt: Number(row.updated_at ?? 0), patch },
      INSTANCE_RUNTIME_PATCH_CACHE_MAX_ENTRIES,
    );
    return patch;
  }

  /** 创建编排实例。 */
  create(input: {
    workspaceId: WorkspaceId;
    workflowId: WorkflowId;
    workflowSnapshot: WorkflowRuntimeDefinition;
    assetRuntimeSnapshot?: OrchestrationAssetRuntimeSnapshot | null;
    masterThreadId?: ThreadId | null;
    proposalId?: ProposalId | null;
    intakeSnapshot: TaskIntake;
    roleSnapshots?: Record<string, RoleRuntimeDefinition> | null;
    toolsetSnapshots?: Record<string, ToolsetRuntimeDefinition> | null;
    runtimeConfig?: OrchestrationRuntimeConfig | null;
    artifactIndex?: Record<string, ArtifactId[]> | null;
    nodeAssigneeUserIdsByNodeId?: Record<string, string[] | null | undefined> | null;
    skippedNodeIds?: string[] | null;
  }): OrchestrationInstance {
    const id = crypto.randomUUID() as OrchestrationId;
    const now = Date.now();
    const intakeSnapshot = {
      ...input.intakeSnapshot,
      title: normalizeTaskIntakeTitle(input.intakeSnapshot.title, input.intakeSnapshot.goal),
    };
    const runtimeConfig = input.runtimeConfig ?? null;
    const artifactIndex = input.artifactIndex ?? {};
    const nodeAssigneeUserIdsByNodeId = input.nodeAssigneeUserIdsByNodeId ?? {};
    const skippedNodeIds = new Set(normalizeOrchestrationRunPlanSkippedNodeIds(input.skippedNodeIds));
    const masterThreadId = String(input.masterThreadId ?? "").trim() || null;
    const workflowSnapshot = stripWorkflowAssetTimes(input.workflowSnapshot);
    const assetRuntimeSnapshot = input.assetRuntimeSnapshot == null
      ? null
      : normalizeAssetRuntimeSnapshot(input.assetRuntimeSnapshot, {
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        workflowSnapshot,
      });
    const roleSnapshots = normalizeLegacyRuntimeDefinitionMap(
      assetRuntimeSnapshot
        ? Object.fromEntries(Object.entries(assetRuntimeSnapshot.roles).map(([id, entry]) => [id, entry.definition]))
        : input.roleSnapshots ?? {},
    );
    const toolsetSnapshots = normalizeLegacyRuntimeDefinitionMap(
      assetRuntimeSnapshot
        ? Object.fromEntries(Object.entries(assetRuntimeSnapshot.toolsets).map(([id, entry]) => [id, entry.definition]))
        : input.toolsetSnapshots ?? {},
    );
    const nodeStates: Record<string, NodeExecutionState> = {};
    for (const node of workflowSnapshot.nodes) {
      const skipped = skippedNodeIds.has(node.id);
      nodeStates[node.id] = {
        nodeId: node.id,
        status: skipped ? "skipped" : "pending",
        retryCount: 0,
        assigneeUserIds: normalizeNodeAssigneeUserIds(nodeAssigneeUserIdsByNodeId[node.id]),
        completedAt: skipped ? now : null,
      };
    }

    const instance: OrchestrationInstance = {
      id,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      proposalId: input.proposalId ?? null,
      intakeSnapshot,
      workflowSnapshot,
      assetRuntimeSnapshot,
      roleSnapshots,
      toolsetSnapshots,
      runtimeConfig,
      artifactIndex,
      masterThreadId: masterThreadId as ThreadId | null,
      status: "pending",
      nodeStates,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO orch_instances (id, workspace_id, workflow_id, workflow_snapshot_json,
                  asset_runtime_snapshot_json, proposal_id, intake_snapshot_json, role_snapshots_json,
                  toolset_snapshots_json, runtime_config_json,
                  artifact_index_json, master_thread_id, status,
                  node_states_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          String(input.workspaceId),
          String(input.workflowId),
          JSON.stringify(workflowSnapshot),
          assetRuntimeSnapshot === null ? null : JSON.stringify(assetRuntimeSnapshot),
          input.proposalId ? String(input.proposalId) : null,
          JSON.stringify(intakeSnapshot),
          JSON.stringify(roleSnapshots),
          JSON.stringify(toolsetSnapshots),
          JSON.stringify(runtimeConfig),
          JSON.stringify(artifactIndex),
          masterThreadId,
          JSON.stringify(nodeStates),
          now,
          now,
        );
      upsertOrchInstanceSummaryProjection(this.db, instance);
      this.listStates.refreshForInstance(instance);
    })();
    this.runtimePatchCache.delete(String(id));
    return instance;
  }

  /** 仅为尚无完整图的历史实例补录运行快照，不覆盖已持久化快照。 */
  backfillAssetRuntimeSnapshot(
    id: OrchestrationId,
    snapshot: OrchestrationAssetRuntimeSnapshot,
  ): { applied: boolean; instance: OrchestrationInstance } {
    const existing = this.get(id);
    if (!existing) throw new Error(`编排实例不存在: ${id}`);
    if (existing.assetRuntimeSnapshot) return { applied: false, instance: existing };

    const normalized = normalizeAssetRuntimeSnapshot(snapshot, {
      workspaceId: existing.workspaceId,
      workflowId: existing.workflowId,
      workflowSnapshot: existing.workflowSnapshot,
    });
    const roleSnapshots = normalizeLegacyRuntimeDefinitionMap(
      Object.fromEntries(Object.entries(normalized.roles).map(([assetId, entry]) => [assetId, entry.definition])),
    );
    const toolsetSnapshots = normalizeLegacyRuntimeDefinitionMap(
      Object.fromEntries(Object.entries(normalized.toolsets).map(([assetId, entry]) => [assetId, entry.definition])),
    );
    const result = this.db
      .prepare(
        `UPDATE orch_instances
         SET asset_runtime_snapshot_json = ?, role_snapshots_json = ?, toolset_snapshots_json = ?
         WHERE id = ? AND asset_runtime_snapshot_json IS NULL`,
      )
      .run(
        JSON.stringify(normalized),
        JSON.stringify(roleSnapshots),
        JSON.stringify(toolsetSnapshots),
        String(id),
      );
    if (Number(result.changes ?? 0) === 0) {
      const current = this.get(id);
      if (current?.assetRuntimeSnapshot) return { applied: false, instance: current };
      throw new Error(`编排实例资产运行快照补录冲突: ${id}`);
    }
    const persisted = this.get(id);
    if (!persisted?.assetRuntimeSnapshot) throw new Error(`编排实例资产运行快照补录未持久化: ${id}`);
    return { applied: true, instance: persisted };
  }

  /** 更新编排实例状态。 */
  updateStatus(id: OrchestrationId, status: OrchestrationStatus): void {
    const now = Date.now();
    this.db.transaction(() => {
      const row = this.readSummarySourceRow(id, true);
      if (!row) return;
      this.requireSummaryProjection(id);
      const instance = parseOrchInstanceSummarySourceRow(row, { status, updatedAt: now });
      this.db
        .prepare("UPDATE orch_instances SET status = ?, updated_at = ? WHERE id = ?")
        .run(String(status), now, String(id));
      upsertOrchInstanceSummaryProjection(this.db, instance);
      this.listStates.refreshForInstance(instance);
    })();
    this.runtimePatchCache.delete(String(id));
  }

  /** 已确认归属损坏时原子暂停实体与既有摘要；保留坏数据，投影或写入失败继续上抛。 */
  pauseAfterScopeFailure(error: OrchInstanceScopeError): void {
    const id = error.details.instanceId as OrchestrationId;
    const now = Date.now();
    this.db.transaction(() => {
      const fact = this.db.prepare("SELECT workspace_id, status, updated_at FROM orch_instances WHERE id = ?")
        .get(String(id)) as { workspace_id: string; status: OrchestrationStatus; updated_at: number } | undefined;
      if (!fact || fact.workspace_id !== error.details.workspaceId) throw error;
      const projection = touchOrchInstanceSummaryProjection(this.db, { instanceId: id, sourceUpdatedAt: now, status: "paused",
        expectation: { workspaceId: fact.workspace_id, status: fact.status, sourceUpdatedAt: fact.updated_at } });
      this.db.prepare("UPDATE orch_instances SET status = 'paused', updated_at = ? WHERE id = ?").run(now, String(id));
      this.listStates.refreshIntake({ workspaceId: projection.workspaceId, intakeId: projection.intakeId });
    })();
    this.runtimePatchCache.delete(String(id));
  }

  /** 更新节点状态。 */
  updateNodeStates(id: OrchestrationId, nodeStates: Record<string, NodeExecutionState>): void {
    const now = Date.now();
    this.db.transaction(() => {
      const row = this.readSummarySourceRow(id, false);
      if (!row) return;
      this.requireSummaryProjection(id);
      const instance = parseOrchInstanceSummarySourceRow(row, { nodeStates, updatedAt: now });
      this.db
        .prepare("UPDATE orch_instances SET node_states_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(nodeStates), now, String(id));
      upsertOrchInstanceSummaryProjection(this.db, instance);
      this.listStates.refreshForInstance(instance);
    })();
    this.runtimePatchCache.delete(String(id));
  }

  /** 更新实例冻结的运行配置，供恢复前调整后续节点的执行偏好。 */
  updateRuntimeConfig(id: OrchestrationId, runtimeConfig: OrchestrationInstance["runtimeConfig"]): void {
    const now = Date.now();
    this.db.transaction(() => {
      const row = this.readSummarySourceRow(id, true);
      if (!row) return;
      this.requireSummaryProjection(id);
      const instance = parseOrchInstanceSummarySourceRow(row, { runtimeConfig: runtimeConfig ?? null, updatedAt: now });
      this.db
        .prepare("UPDATE orch_instances SET runtime_config_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(runtimeConfig ?? null), now, String(id));
      upsertOrchInstanceSummaryProjection(this.db, instance);
      this.listStates.refreshForInstance(instance);
    })();
    this.runtimePatchCache.delete(String(id));
  }

  /** 更新 artifact 索引。 */
  updateArtifactIndex(id: OrchestrationId, artifactIndex: Record<string, ArtifactId[]>): void {
    const now = Date.now();
    this.db.transaction(() => {
      const projection = this.readExistingSummaryProjection(id);
      if (!projection) return;
      this.db
        .prepare("UPDATE orch_instances SET artifact_index_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(artifactIndex ?? {}), now, String(id));
      touchOrchInstanceSummaryProjection(this.db, { instanceId: id, sourceUpdatedAt: now });
      this.listStates.refreshIntake({ workspaceId: projection.workspaceId, intakeId: projection.intakeId });
    })();
    this.runtimePatchCache.delete(String(id));
  }

  /** 删除编排实例。 */
  delete(id: OrchestrationId): void {
    this.db.transaction(() => {
      const projection = this.readExistingSummaryProjection(id);
      if (!projection) return;
      this.db.prepare("DELETE FROM orch_instances WHERE id = ?").run(String(id));
      this.listStates.refreshIntake({ workspaceId: projection.workspaceId, intakeId: projection.intakeId });
    })();
    this.runtimePatchCache.delete(String(id));
    this.runtimePatchWorkflowCache.delete(String(id));
  }

  /** 读取摘要重建所需源列；节点状态已由调用方提供时不搬运大 JSON。 */
  private readSummarySourceRow(id: OrchestrationId, includeNodeStates: boolean): Record<string, unknown> | null {
    const nodeStatesColumn = includeNodeStates ? "node_states_json" : "NULL AS node_states_json";
    const row = this.db.prepare(
      `SELECT id, workspace_id, workflow_id, workflow_snapshot_json,
              proposal_id, intake_snapshot_json, runtime_config_json,
              status, ${nodeStatesColumn}, created_at, updated_at
       FROM orch_instances
       WHERE id = ?`,
    ).get(String(id)) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  /** 对已存在事实行要求摘要投影同步存在，缺失时显式失败。 */
  private requireSummaryProjection(id: OrchestrationId) {
    const projection = readOrchInstanceSummaryProjectionIdentity(this.db, id);
    if (!projection) throw missingOrchInstanceSummaryProjectionError(id);
    return projection;
  }

  /** 区分实例不存在与投影缺失，避免把一致性损坏伪装成普通 no-op。 */
  private readExistingSummaryProjection(id: OrchestrationId) {
    const exists = this.db.prepare("SELECT 1 AS found FROM orch_instances WHERE id = ?").get(String(id));
    if (!exists) return null;
    return this.requireSummaryProjection(id);
  }

  /** 读取 runtimePatch 的 workflow 节点摘要；workflow JSON 稳定时复用解析结果。 */
  private readRuntimePatchWorkflowSnapshot(id: string, workflowSnapshotJson: string): Pick<WorkflowDefinition, "nodes"> {
    const cached = this.runtimePatchWorkflowCache.get(id);
    if (cached?.workflowSnapshotJson === workflowSnapshotJson) {
      rememberBoundedCache(
        this.runtimePatchWorkflowCache,
        id,
        cached,
        INSTANCE_RUNTIME_PATCH_WORKFLOW_CACHE_MAX_ENTRIES,
      );
      return cached.workflowSnapshot;
    }
    const parsed = safeParseJson<Pick<WorkflowDefinition, "nodes">>(
      workflowSnapshotJson,
      { nodes: [] } as Pick<WorkflowDefinition, "nodes">,
    );
    const workflowSnapshot = {
      nodes: Array.isArray(parsed.nodes)
        ? parsed.nodes.filter((node): node is WorkflowNode => node.type !== "start" && node.type !== "end")
        : [],
    } as Pick<WorkflowDefinition, "nodes">;
    rememberBoundedCache(
      this.runtimePatchWorkflowCache,
      id,
      { workflowSnapshotJson, workflowSnapshot },
      INSTANCE_RUNTIME_PATCH_WORKFLOW_CACHE_MAX_ENTRIES,
    );
    return workflowSnapshot;
  }

  /** 将实例行裁剪成运行态补丁，避免每轮轮询重新解析整份实例大 JSON。 */
  private buildRuntimePatch(row: any): OrchestrationInstanceRuntimePatch {
    const workflowSnapshot = this.readRuntimePatchWorkflowSnapshot(String(row.id), String(row.workflow_snapshot_json ?? ""));
    const runtimeConfigValue = String(row.initiator_user_id ?? "").trim();
    const runtimeConfig = runtimeConfigValue
      ? ({ initiatorUserId: runtimeConfigValue } as OrchestrationRuntimeConfig)
      : null;
    const artifactIndex = safeParseJson<Record<string, ArtifactId[]>>(row.artifact_index_json, {});
    const nodeStates = safeParseJson<Record<string, NodeExecutionState>>(row.node_states_json, {});
    const instance = {
      id: row.id as OrchestrationId,
      workspaceId: row.workspace_id as WorkspaceId,
      workflowId: row.workflow_id as WorkflowId,
      proposalId: row.proposal_id ? String(row.proposal_id) as ProposalId : null,
      intakeSnapshot: createEmptyIntake(row),
      workflowSnapshot,
      roleSnapshots: {},
      toolsetSnapshots: {},
      runtimeConfig,
      artifactIndex,
      masterThreadId: null,
      status: (row.status ?? "pending") as OrchestrationStatus,
      nodeStates,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    } as OrchestrationInstance;
    const intakeId = String(row.intake_id ?? "").trim();
    return {
      id: instance.id,
      workspaceId: instance.workspaceId,
      workflowId: instance.workflowId,
      intakeId: intakeId ? intakeId as IntakeId : null,
      sourceKind: row.source_kind === "scheduled_task" ? "scheduled_task" : "requirement",
      status: instance.status,
      runSummary: deriveOrchestrationRunSummary(instance, {
        artifactCount: Number(row.artifact_count ?? 0),
      }),
      artifactIndex: instance.artifactIndex ?? {},
      nodeStates: Object.fromEntries(
        Object.entries(instance.nodeStates ?? {}).map(([nodeId, state]) => [nodeId, toNodeRuntimePatch(state)]),
      ),
      updatedAt: instance.updatedAt,
    };
  }
}

/** 限制摘要列表页大小，避免异常请求重新制造大响应。 */
function normalizeSummaryLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 50;
  return Math.min(200, Math.max(1, Math.floor(value)));
}

/** 规范共享工作区下发的可见需求 ID；undefined 表示不限制，空数组表示无可见项。 */
function normalizeAllowedResourceIds(value: string[] | null | undefined): string[] | null {
  if (value == null) return null;
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

/** 规范化实例来源筛选；未知值按不筛选处理。 */
function normalizeTaskIntakeSourceKind(value: unknown): TaskIntakeSourceKind | null {
  const text = String(value ?? "").trim();
  return text === "requirement" || text === "scheduled_task" ? text : null;
}

/** 基于实例快照与历史启动事件识别定时任务调度生成的编排。 */
function scheduledInstancePredicateSql(): string {
  return `COALESCE(json_extract(intake_snapshot_json, '$.requester.source'), '') = 'scheduled_task'
    OR EXISTS (
      SELECT 1 FROM orch_events oe
      WHERE oe.instance_id = orch_instances.id
        AND oe.type = 'orchestration.instanceStarted'
        AND json_extract(oe.payload_json, '$.triggerSource') = 'scheduled_task'
    )`;
}

/** 写入有界缓存；超过上限时移除最早写入的条目。 */
function rememberBoundedCache<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

/** 只保留监控状态刷新所需的节点运行态字段。 */
function toNodeRuntimePatch(state: NodeExecutionState): NodeExecutionRuntimePatch {
  return {
    nodeId: state.nodeId,
    status: state.status,
    attemptId: state.attemptId ?? null,
    nodeExecutionId: state.nodeExecutionId ?? state.attemptId ?? null,
    attemptNo: state.attemptNo ?? null,
    submissionId: state.submissionId ?? null,
    parentExecutionId: state.parentExecutionId ?? null,
    humanActionSource: state.humanActionSource ?? null,
    assigneeUserIds: normalizeNodeAssigneeUserIds(state.assigneeUserIds),
    threadId: state.threadId ?? null,
    previousThreadIds: normalizeThreadIds(state.previousThreadIds),
    discussionThreadId: state.discussionThreadId ?? null,
    promptSnapshotIds: state.promptSnapshotIds ?? null,
    knowledgeWarnings: state.knowledgeWarnings ?? null,
    gateResults: state.gateResults ?? null,
    retryCount: state.retryCount,
    startedAt: state.startedAt ?? null,
    completedAt: state.completedAt ?? null,
    error: state.error ?? null,
    errorCode: state.errorCode ?? null,
    providerThreadId: state.providerThreadId ?? null,
    recoveryReason: state.recoveryReason ?? null,
    preserveBinding: state.preserveBinding ?? null,
    userChoiceRequired: state.userChoiceRequired ?? null,
    recoveryStrategies: normalizeNodeRecoveryStrategies(state.recoveryStrategies),
    branchTaken: state.branchTaken ?? null,
    inputArtifactIds: state.inputArtifactIds ?? null,
    outputArtifactIds: state.outputArtifactIds ?? null,
    activeFeedbackRecordIds: state.activeFeedbackRecordIds ?? null,
    workItemSummary: state.workItemSummary ?? null,
    feedbackRecordIds: state.feedbackRecordIds ?? null,
    manualStartApprovedAt: state.manualStartApprovedAt ?? null,
    manualStartApprovedBy: state.manualStartApprovedBy ?? null,
  };
}

/** 仅向 runtime patch 下发已知的显式恢复策略。 */
function normalizeNodeRecoveryStrategies(value: unknown): Array<"retry-existing" | "new-thread"> | null {
  if (!Array.isArray(value)) return null;
  const strategies = Array.from(new Set(value.filter(
    (item): item is "retry-existing" | "new-thread" => item === "retry-existing" || item === "new-thread",
  )));
  return strategies.length ? strategies : null;
}

/** 规范化节点处理人快照，空数组按未指定处理。 */
function normalizeNodeAssigneeUserIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
  return ids.length ? ids : null;
}

/** Normalizes historical node thread IDs for lightweight runtime patches. */
function normalizeThreadIds(value: unknown): ThreadId[] | null {
  if (!Array.isArray(value)) return null;
  const ids = Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
  return ids.length ? ids as ThreadId[] : null;
}

/** 详情沿用历史展示兼容；权限读取在归一化前验证原始归属字段。 */
function rowToInstance(row: any, strictScope = false): OrchestrationInstance {
  const scope = strictScope ? readStrictInstanceScope(row) : null;
  const intakeSnapshot = scope?.intakeSnapshot ?? safeParseJson<TaskIntake>(row.intake_snapshot_json, createEmptyIntake(row));
  const workflowSnapshot = stripWorkflowAssetTimes(
    safeParseJson<WorkflowRuntimeDefinition>(row.workflow_snapshot_json, {
      id: "",
      workspaceId: "" as WorkspaceId,
      name: "",
      description: "",
      nodes: [],
      edges: [],
      version: 0,
    }),
  );
  return {
    id: row.id as OrchestrationId,
    workspaceId: row.workspace_id as WorkspaceId,
    workflowId: row.workflow_id as WorkflowId,
    proposalId: row.proposal_id ? String(row.proposal_id) as ProposalId : null,
    intakeSnapshot: {
      ...intakeSnapshot,
      title: normalizeTaskIntakeTitle(intakeSnapshot.title, intakeSnapshot.goal),
    },
    workflowSnapshot,
    assetRuntimeSnapshot: parsePersistedAssetRuntimeSnapshot(row.asset_runtime_snapshot_json, {
      instanceId: String(row.id ?? ""),
      workspaceId: row.workspace_id as WorkspaceId,
      workflowId: row.workflow_id as WorkflowId,
      workflowSnapshot,
    }),
    roleSnapshots: safeParseJson<Record<string, RoleRuntimeDefinition>>(row.role_snapshots_json, {}),
    toolsetSnapshots: safeParseJson<Record<string, ToolsetRuntimeDefinition>>(row.toolset_snapshots_json, {}),
    runtimeConfig: scope ? scope.runtimeConfig : safeParseJson<OrchestrationRuntimeConfig | null>(row.runtime_config_json, null),
    artifactIndex: safeParseJson<Record<string, ArtifactId[]>>(row.artifact_index_json, {}),
    masterThreadId: row.master_thread_id ? String(row.master_thread_id) as ThreadId : null,
    status: (row.status ?? "pending") as OrchestrationStatus,
    nodeStates: scope?.nodeStates ?? safeParseJson<Record<string, NodeExecutionState>>(row.node_states_json, {}),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** 校验冻结归属与本机配置同区，允许旧可选字段缺省；损坏实例显式失败。 */
export function readStrictInstanceScope(row: any): Pick<OrchestrationInstance, "intakeSnapshot" | "runtimeConfig" | "nodeStates"> {
  /** 错误保留实例、工作区、字段及根因，不附带快照原文。 */
  const invalid: (field: string, reason: string) => never = (field, reason) => {
    throw new OrchInstanceScopeError({ instanceId: String(row.id), workspaceId: String(row.workspace_id), field, reason });
  };
  /** 归属标识必须为规范非空文本，不能经强制转换或裁剪掩盖损坏。 */
  const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;
  if (!validId(row.id) || !validId(row.workspace_id)) invalid("identity", "invalid_row_identity");
  const records: Record<string, Record<string, unknown> | null> = {};
  for (const field of ["intake_snapshot_json", "runtime_config_json"] as const) {
    const raw = row[field];
    if (field === "runtime_config_json" && raw === null) { records[field] = null; continue; }
    if (typeof raw !== "string" || !raw) invalid(field, "expected_json_text");
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { invalid(field, "invalid_json"); }
    if (field === "runtime_config_json" && value === null) { records[field] = null; continue; }
    if (!isPlainOrchAssetRecord(value)) invalid(field, "expected_object");
    records[field] = value;
  }
  const intakeSnapshot = records.intake_snapshot_json!;
  if (!validId(intakeSnapshot.id) || intakeSnapshot.workspaceId !== row.workspace_id) invalid("intake_snapshot_json", "intake_identity_mismatch");
  if (row.frozen_intake_id !== undefined && intakeSnapshot.id !== row.frozen_intake_id) invalid("intake_snapshot_json", "intake_projection_identity_mismatch");
  try { intakeSnapshot.workspaceScope = readIntakeWorkspaceScope(intakeSnapshot.workspaceScope, row.workspace_id); }
  catch { invalid("intake_snapshot_json.workspaceScope", "invalid_workspace_scope"); }
  const sharedContext = intakeSnapshot.sharedContext;
  if (sharedContext != null && (!isPlainOrchAssetRecord(sharedContext) || !validId(sharedContext.sharedWorkspaceId))) {
    invalid("intake_snapshot_json.sharedContext", "expected_shared_workspace_identity");
  }
  const runtimeConfig = records.runtime_config_json;
  const profileScope = runtimeConfig?.executionProfileScope;
  if (profileScope != null && (!isPlainOrchAssetRecord(profileScope)
    || (profileScope.scopeType !== "local_workspace" && profileScope.scopeType !== "shared_workspace") || !validId(profileScope.scopeId))) {
    invalid("runtime_config_json.executionProfileScope", "expected_profile_scope");
  }
  if (profileScope?.scopeType === "local_workspace" && profileScope.scopeId !== row.workspace_id) {
    invalid("runtime_config_json.executionProfileScope", "local_profile_workspace_mismatch");
  }
  return { intakeSnapshot: intakeSnapshot as unknown as TaskIntake, runtimeConfig: runtimeConfig as OrchestrationRuntimeConfig | null,
    nodeStates: readStrictInstanceNodeStates(row) };
}

/** 原节点绑定解析可单独定位真实父实例，归属损坏不能污染其他线程。 */
export function readStrictInstanceNodeStates(row: any): Record<string, NodeExecutionState> {
  /** 诊断字段只用固定路径，不输出不可信节点键或 JSON。 */
  const invalid: (field: string, reason: string) => never = (field, reason) => {
    throw new OrchInstanceScopeError({ instanceId: String(row.id), workspaceId: String(row.workspace_id), field, reason });
  };
  const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;
  let nodeStates: unknown;
  try { nodeStates = JSON.parse(row.node_states_json); } catch { invalid("node_states_json", "invalid_json"); }
  if (!isPlainOrchAssetRecord(nodeStates)) invalid("node_states_json", "expected_object");
  for (const state of Object.values(nodeStates)) {
    if (!isPlainOrchAssetRecord(state)) invalid("node_states_json", "expected_object");
    for (const field of ["threadId", "discussionThreadId"] as const) {
      if (state[field] != null && !validId(state[field])) invalid(`node_states_json.${field}`, "expected_thread_id");
    }
    if (state.previousThreadIds != null && (!Array.isArray(state.previousThreadIds) || state.previousThreadIds.some(value => !validId(value)))) {
      invalid("node_states_json.previousThreadIds", "expected_thread_ids");
    }
  }
  return nodeStates as Record<string, NodeExecutionState>;
}

/** Detaches legacy lightweight definitions and removes repository-owned presentation timestamps. */
function normalizeLegacyRuntimeDefinitionMap<T extends RoleRuntimeDefinition | ToolsetRuntimeDefinition>(
  definitions: Record<string, T>,
): Record<string, T> {
  const normalized = Object.create(null) as Record<string, T>;
  for (const [id, definition] of Object.entries(definitions)) {
    const detached = structuredClone(definition) as T & { createdAt?: unknown; updatedAt?: unknown };
    delete detached.createdAt;
    delete detached.updatedAt;
    normalized[id] = detached;
  }
  return normalized;
}

type AssetRuntimeSnapshotContext = {
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  workflowSnapshot: WorkflowRuntimeDefinition;
};

/** Parses a non-null persisted launch graph and reports corruption with instance identity. */
function parsePersistedAssetRuntimeSnapshot(
  raw: unknown,
  context: AssetRuntimeSnapshotContext & { instanceId: string },
): OrchestrationAssetRuntimeSnapshot | null {
  if (raw === null || raw === undefined) return null;
  try {
    if (typeof raw !== "string" || !raw) throw new Error("快照 JSON 为空或不是文本");
    return normalizeAssetRuntimeSnapshot(JSON.parse(raw), context);
  } catch (error) {
    throw new Error(`编排实例资产运行快照损坏：${context.instanceId}`, { cause: error });
  }
}

/** 校验并脱离完整资产图；可选来源只冻结绑定，磁盘快照不授予执行资格。 */
function normalizeAssetRuntimeSnapshot(
  value: unknown,
  context: AssetRuntimeSnapshotContext,
): OrchestrationAssetRuntimeSnapshot {
  const snapshot = requiredPlainRecord(value, "assetRuntimeSnapshot");
  assertExactKeys(snapshot, ["authorityMode", "workflow", "roles", "knowledgeBundles", "toolsets", "skills",
    ...(Object.hasOwn(snapshot, "executionAuthorization") ? ["executionAuthorization"] : [])], "assetRuntimeSnapshot");
  const authorityMode = requiredAuthorityMode(snapshot.authorityMode, "assetRuntimeSnapshot.authorityMode");
  const workspaceId = requiredIdentity(context.workspaceId, "workspaceId") as WorkspaceId;
  const authorizationField = Object.getOwnPropertyDescriptor(snapshot, "executionAuthorization");
  if (authorizationField && (!authorizationField.enumerable || !("value" in authorizationField))) {
    throw new Error("assetRuntimeSnapshot.executionAuthorization 必须是自有数据字段");
  }
  const executionAuthorization = authorizationField ? readOrchAssetExecutionAuthorization(authorizationField.value) : undefined;
  if (executionAuthorization && (authorityMode !== "server" || executionAuthorization.runtimeWorkspaceId !== workspaceId)) {
    throw new Error("assetRuntimeSnapshot.executionAuthorization 与资产来源或工作区不一致");
  }
  const workflowId = requiredIdentity(context.workflowId, "workflowId") as WorkflowId;
  if (context.workflowSnapshot.id !== workflowId || context.workflowSnapshot.workspaceId !== workspaceId) {
    throw new Error("workflowSnapshot 与实例身份不一致");
  }
  const workflow = normalizeRuntimeAssetEntry(
    snapshot.workflow,
    "workflow",
    workspaceId,
    authorityMode,
    false,
    "assetRuntimeSnapshot.workflow",
  );
  if (canonicalizeOrchAssetJson(workflow.definition) !== canonicalizeOrchAssetJson(context.workflowSnapshot)) {
    throw new Error("assetRuntimeSnapshot.workflow 与 workflowSnapshot 内容不一致");
  }
  const normalized: OrchestrationAssetRuntimeSnapshot = {
    authorityMode,
    ...(executionAuthorization ? { executionAuthorization } : {}),
    workflow,
    roles: normalizeRuntimeAssetMap(snapshot.roles, "role", workspaceId, authorityMode, "assetRuntimeSnapshot.roles"),
    knowledgeBundles: normalizeRuntimeAssetMap(
      snapshot.knowledgeBundles,
      "knowledge_bundle",
      workspaceId,
      authorityMode,
      "assetRuntimeSnapshot.knowledgeBundles",
    ),
    toolsets: normalizeRuntimeAssetMap(snapshot.toolsets, "toolset", workspaceId, authorityMode, "assetRuntimeSnapshot.toolsets"),
    skills: normalizeRuntimeAssetMap(snapshot.skills, "skill", workspaceId, authorityMode, "assetRuntimeSnapshot.skills"),
  };
  validateRuntimeAssetGraphClosure(normalized);
  return normalized;
}

/** Normalizes one dependency map into a null-prototype dictionary. */
function normalizeRuntimeAssetMap<T extends Exclude<OrchestrationRuntimeAssetType, "workflow">>(
  value: unknown,
  assetType: T,
  workspaceId: WorkspaceId,
  authorityMode: "legacy" | "server",
  label: string,
): Record<string, OrchestrationRuntimeAssetSnapshotEntry<T>> {
  const input = requiredPlainRecord(value, label);
  const output = Object.create(null) as Record<string, OrchestrationRuntimeAssetSnapshotEntry<T>>;
  for (const mapKey of Object.keys(input)) {
    const assetId = requiredIdentity(mapKey, `${label} key`);
    const entry = normalizeRuntimeAssetEntry(input[mapKey], assetType, workspaceId, authorityMode, true, `${label}.${assetId}`);
    if (entry.assetId !== assetId) throw new Error(`${label}.${assetId} 的映射键与资产 ID 不一致`);
    output[assetId] = entry;
  }
  return output;
}

/** Validates one runtime asset identity, workspace and authority source. */
function normalizeRuntimeAssetEntry<T extends OrchestrationRuntimeAssetType>(
  value: unknown,
  assetType: T,
  workspaceId: WorkspaceId,
  authorityMode: "legacy" | "server",
  sourceRequired: boolean,
  label: string,
): OrchestrationRuntimeAssetSnapshotEntry<T> {
  const entry = requiredPlainRecord(value, label);
  assertExactKeys(entry, ["assetType", "assetId", "definition", "source"], label);
  if (entry.assetType !== assetType) throw new Error(`${label}.assetType 不一致`);
  const assetId = requiredIdentity(entry.assetId, `${label}.assetId`);
  const definitionRecord = requiredPlainRecord(entry.definition, `${label}.definition`);
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...runtimeFields } = definitionRecord;
  const definition = JSON.parse(canonicalizeOrchAssetJson(runtimeFields)) as OrchestrationRuntimeAssetDefinitionByType[T];
  if (definition.id !== assetId) throw new Error(`${label}.definition.id 不一致`);
  if (definition.workspaceId !== workspaceId) throw new Error(`${label}.definition.workspaceId 不一致`);
  validateRuntimeAssetDefinition(assetType, definition, label);
  return {
    assetType,
    assetId,
    definition,
    source: normalizeRuntimeAssetSource(entry.source, authorityMode, sourceRequired, `${label}.source`),
  };
}

/** Validates the minimum executable structure for each frozen runtime definition. */
function validateRuntimeAssetDefinition<T extends OrchestrationRuntimeAssetType>(
  assetType: T,
  definition: OrchestrationRuntimeAssetDefinitionByType[T],
  label: string,
): void {
  const value = definition as unknown as Record<string, unknown>;
  requiredIdentity(value.name, `${label}.definition.name`);
  if (assetType === "role") {
    requiredString(value.description, `${label}.definition.description`);
    requiredString(value.systemPrompt, `${label}.definition.systemPrompt`);
    requiredPlainRecord(value.inputDefinition, `${label}.definition.inputDefinition`);
    requiredPlainRecord(value.outputDefinition, `${label}.definition.outputDefinition`);
    requiredPlainRecord(value.executionConfig, `${label}.definition.executionConfig`);
    requiredArray(value.gateCriteria, `${label}.definition.gateCriteria`);
    collectOrchAssetDependencyReferences("role", value);
    for (const [index, raw] of requiredOptionalArray(value.toolRefs, `${label}.definition.toolRefs`).entries()) {
      const ref = requiredPlainRecord(raw, `${label}.definition.toolRefs[${index}]`);
      requiredIdentity(ref.toolId, `${label}.definition.toolRefs[${index}].toolId`);
    }
    return;
  }
  if (assetType === "workflow") {
    requiredString(value.description, `${label}.definition.description`);
    requiredSafeInteger(value.version, `${label}.definition.version`, 1);
    validateRuntimeWorkflow(value, `${label}.definition`);
    collectOrchAssetDependencyReferences("workflow", value);
    return;
  }
  if (assetType === "knowledge_bundle") {
    if (value.scope !== "workflow" && value.scope !== "role" && value.scope !== "shared") {
      throw new Error(`${label}.definition.scope 非法`);
    }
    requiredString(value.description, `${label}.definition.description`);
    for (const [index, source] of requiredArray(value.sourceRefs, `${label}.definition.sourceRefs`).entries()) {
      requiredPlainRecord(source, `${label}.definition.sourceRefs[${index}]`);
    }
    return;
  }
  if (assetType === "toolset") {
    requiredString(value.description, `${label}.definition.description`);
    validateRuntimeTools(value.tools, `${label}.definition.tools`);
    return;
  }
  validateRuntimeSkill(value, `${label}.definition`);
}

/** Validates workflow node/edge identities and their local references. */
function validateRuntimeWorkflow(value: Record<string, unknown>, label: string): void {
  const nodes = requiredArray(value.nodes, `${label}.nodes`);
  const nodeIds = new Set<string>();
  for (const [index, raw] of nodes.entries()) {
    const node = requiredPlainRecord(raw, `${label}.nodes[${index}]`);
    requiredUniqueIdentity(node.id, nodeIds, `${label}.nodes[${index}].id`);
    if (!new Set(["role", "condition", "parallel-fork", "parallel-join", "start", "end"]).has(String(node.type ?? ""))) {
      throw new Error(`${label}.nodes[${index}].type 非法`);
    }
    requiredString(node.label, `${label}.nodes[${index}].label`);
    const position = requiredPlainRecord(node.position, `${label}.nodes[${index}].position`);
    requiredFiniteNumber(position.x, `${label}.nodes[${index}].position.x`);
    requiredFiniteNumber(position.y, `${label}.nodes[${index}].position.y`);
    if (node.type === "role") requiredIdentity(node.roleId, `${label}.nodes[${index}].roleId`);
  }
  const edgeIds = new Set<string>();
  for (const [index, raw] of requiredArray(value.edges, `${label}.edges`).entries()) {
    const edge = requiredPlainRecord(raw, `${label}.edges[${index}]`);
    requiredUniqueIdentity(edge.id, edgeIds, `${label}.edges[${index}].id`);
    const sourceNodeId = requiredIdentity(edge.sourceNodeId, `${label}.edges[${index}].sourceNodeId`);
    const targetNodeId = requiredIdentity(edge.targetNodeId, `${label}.edges[${index}].targetNodeId`);
    if (!nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) {
      throw new Error(`${label}.edges[${index}] 引用了不存在的节点`);
    }
    requiredArray(edge.dataMappings, `${label}.edges[${index}].dataMappings`);
  }
}

/** Validates tool identities and the executable fields consumed by the engine. */
function validateRuntimeTools(value: unknown, label: string): void {
  const toolIds = new Set<string>();
  for (const [index, raw] of requiredArray(value, label).entries()) {
    const tool = requiredPlainRecord(raw, `${label}[${index}]`);
    requiredUniqueIdentity(tool.id, toolIds, `${label}[${index}].id`);
    requiredIdentity(tool.name, `${label}[${index}].name`);
    requiredString(tool.description, `${label}[${index}].description`);
    if (!new Set(["shell", "python", "node", "java", "prompt", "builtin"]).has(String(tool.runtime ?? ""))) {
      throw new Error(`${label}[${index}].runtime 非法`);
    }
    requiredString(tool.invocationHint, `${label}[${index}].invocationHint`);
    requiredString(tool.code, `${label}[${index}].code`);
  }
}

/** Validates a complete Skill package without redoing upstream authority content hashes. */
function validateRuntimeSkill(value: Record<string, unknown>, label: string): void {
  requiredString(value.description, `${label}.description`);
  requiredString(value.trigger, `${label}.trigger`);
  requiredString(value.instructions, `${label}.instructions`);
  const targetEngines = requiredArray(value.targetEngines, `${label}.targetEngines`);
  if (targetEngines.length === 0 || targetEngines.some((engine) => engine !== "codex" && engine !== "claude")) {
    throw new Error(`${label}.targetEngines 非法`);
  }
  if (typeof value.packageHash !== "string" || !/^[0-9a-f]{64}$/.test(value.packageHash)) {
    throw new Error(`${label}.packageHash 非法`);
  }
  if (typeof value.skillMd !== "string") throw new Error(`${label}.skillMd 非法`);
  const files = requiredArray(value.files, `${label}.files`);
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const packageFiles = new Map<string, { kind: unknown; contentText: unknown }>();
  let packageSkillMd: string | null = null;
  for (const [index, raw] of files.entries()) {
    const fileLabel = `${label}.files[${index}]`;
    const file = requiredPlainRecord(raw, fileLabel);
    const relPath = requiredUniqueIdentity(file.relPath, paths, `${fileLabel}.relPath`);
    const foldedPath = relPath.toLowerCase();
    if (foldedPaths.has(foldedPath)) throw new Error(`${fileLabel}.relPath 大小写折叠重复`);
    foldedPaths.add(foldedPath);
    if (!new Set(["skill-md", "script", "reference", "asset", "metadata"]).has(String(file.kind ?? ""))) {
      throw new Error(`${fileLabel}.kind 非法`);
    }
    if (file.kind === "skill-md" && relPath !== "SKILL.md") throw new Error(`${fileLabel}.kind 与路径不一致`);
    const hasText = typeof file.contentText === "string" && file.contentBase64 == null;
    const hasBase64 = typeof file.contentBase64 === "string" && file.contentText == null;
    if (hasText === hasBase64) throw new Error(`${fileLabel} 正文类型非法`);
    const body = hasText
      ? Buffer.from(file.contentText as string, "utf8")
      : decodeCanonicalBase64(file.contentBase64 as string, `${fileLabel}.contentBase64`);
    if (requiredSafeInteger(file.sizeBytes, `${fileLabel}.sizeBytes`, 0) !== body.byteLength) {
      throw new Error(`${fileLabel}.sizeBytes 与正文不一致`);
    }
    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)
      || crypto.createHash("sha256").update(body).digest("hex") !== file.sha256) {
      throw new Error(`${fileLabel}.sha256 与正文不一致`);
    }
    if (relPath === "SKILL.md") {
      if (!hasText || file.kind !== "skill-md" || packageSkillMd !== null) {
        throw new Error(`${label} 必须有且仅有一个文本型 SKILL.md`);
      }
      packageSkillMd = file.contentText as string;
    }
    packageFiles.set(relPath, { kind: file.kind, contentText: file.contentText });
  }
  if (packageSkillMd === null || packageSkillMd !== value.skillMd) {
    throw new Error(`${label}.skillMd 与 SKILL.md 文件不一致`);
  }
  for (const [index, raw] of requiredOptionalArray(value.scripts, `${label}.scripts`).entries()) {
    const script = requiredPlainRecord(raw, `${label}.scripts[${index}]`);
    const scriptPath = requiredIdentity(script.scriptPath, `${label}.scripts[${index}].scriptPath`);
    const file = packageFiles.get(scriptPath);
    if (file?.kind !== "script" || typeof file.contentText !== "string" || !file.contentText) {
      throw new Error(`${label}.scripts[${index}] 未指向非空文本脚本`);
    }
  }
}

/** Ensures every workflow and role dependency is present in the frozen graph. */
function validateRuntimeAssetGraphClosure(snapshot: OrchestrationAssetRuntimeSnapshot): void {
  const requireDependency = (assetType: OrchestrationRuntimeAssetType, assetId: string, referencePath: string): void => {
    const exists = assetType === "role"
      ? Object.hasOwn(snapshot.roles, assetId)
      : assetType === "knowledge_bundle"
        ? Object.hasOwn(snapshot.knowledgeBundles, assetId)
        : assetType === "toolset"
          ? Object.hasOwn(snapshot.toolsets, assetId)
          : assetType === "skill"
            ? Object.hasOwn(snapshot.skills, assetId)
            : snapshot.workflow.assetId === assetId;
    if (!exists) throw new Error(`启动资产图缺少依赖：${referencePath} -> ${assetType}/${assetId}`);
  };
  for (const dependency of collectOrchAssetDependencyReferences(
    "workflow",
    snapshot.workflow.definition as unknown as Record<string, unknown>,
  )) {
    requireDependency(dependency.targetAssetType, dependency.targetAssetId, `workflow.${dependency.referencePath}`);
  }
  for (const role of Object.values(snapshot.roles)) {
    for (const dependency of collectOrchAssetDependencyReferences(
      "role",
      role.definition as unknown as Record<string, unknown>,
    )) {
      requireDependency(dependency.targetAssetType, dependency.targetAssetId, `role.${role.assetId}.${dependency.referencePath}`);
    }
    for (const [index, ref] of (role.definition.toolRefs ?? []).entries()) {
      const toolset = snapshot.toolsets[ref.toolsetId];
      if (!toolset?.definition.tools.some((tool) => tool.id === ref.toolId)) {
        throw new Error(`启动资产图缺少角色工具：${role.assetId}/toolRefs[${index}]`);
      }
    }
  }
}

/** Validates legacy or Server source metadata without inventing missing provenance. */
function normalizeRuntimeAssetSource(
  value: unknown,
  authorityMode: "legacy" | "server",
  required: boolean,
  label: string,
): OrchestrationRuntimeAssetSource | null {
  if (value === null) {
    if (required) throw new Error(`${label} 缺失`);
    return null;
  }
  const source = requiredPlainRecord(value, label);
  if (source.authorityMode !== authorityMode) throw new Error(`${label}.authorityMode 与快照权威不一致`);
  if (authorityMode === "legacy") {
    assertExactKeys(source, ["authorityMode", "createdAt", "updatedAt"], label);
    return {
      authorityMode,
      createdAt: requiredSafeInteger(source.createdAt, `${label}.createdAt`, 0),
      updatedAt: requiredSafeInteger(source.updatedAt, `${label}.updatedAt`, 0),
    };
  }
  assertExactKeys(source, ["authorityMode", "metadata"], label);
  const metadata = requiredPlainRecord(source.metadata, `${label}.metadata`);
  assertExactKeys(metadata, ["revision", "scopeType", "syncChangeSeq", "contentHash", "cacheStatus"], `${label}.metadata`);
  if (!new Set(["builtin", "user", "shared_workspace"]).has(String(metadata.scopeType ?? ""))) {
    throw new Error(`${label}.metadata.scopeType 非法`);
  }
  if (metadata.cacheStatus !== "ready") throw new Error(`${label}.metadata.cacheStatus 非法`);
  if (typeof metadata.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(metadata.contentHash)) {
    throw new Error(`${label}.metadata.contentHash 非法`);
  }
  return {
    authorityMode,
    metadata: {
      revision: requiredSafeInteger(metadata.revision, `${label}.metadata.revision`, 1),
      scopeType: metadata.scopeType as "builtin" | "user" | "shared_workspace",
      syncChangeSeq: requiredSafeInteger(metadata.syncChangeSeq, `${label}.metadata.syncChangeSeq`, 0),
      contentHash: metadata.contentHash,
      cacheStatus: "ready",
    },
  };
}

/** Requires a plain object so persistence never accepts class or array payloads. */
function requiredPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainOrchAssetRecord(value)) throw new Error(`${label} 必须是普通对象`);
  return value;
}

/** Requires an exact non-empty, already-trimmed identity string. */
function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) throw new Error(`${label} 非法`);
  return value;
}

/** Requires a string while allowing intentionally empty runtime text. */
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 非法`);
  return value;
}

/** Requires one array without coercing malformed persisted fields. */
function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}

/** Reads a nullable array as empty while rejecting every other malformed value. */
function requiredOptionalArray(value: unknown, label: string): unknown[] {
  return value == null ? [] : requiredArray(value, label);
}

/** Requires a unique normalized identity within one local definition. */
function requiredUniqueIdentity(value: unknown, seen: Set<string>, label: string): string {
  const identity = requiredIdentity(value, label);
  if (seen.has(identity)) throw new Error(`${label} 重复`);
  seen.add(identity);
  return identity;
}

/** Requires a finite number for persisted geometry fields. */
function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} 非法`);
  return value;
}

/** Decodes canonical Base64 so malformed Skill bytes cannot enter a runtime snapshot. */
function decodeCanonicalBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} 非法`);
  return bytes;
}

/** Requires one supported runtime authority mode. */
function requiredAuthorityMode(value: unknown, label: string): "legacy" | "server" {
  if (value !== "legacy" && value !== "server") throw new Error(`${label} 非法`);
  return value;
}

/** Requires an integer within the configured persistence bound. */
function requiredSafeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label} 非法`);
  return Number(value);
}

/** Rejects missing and unexpected fields at the persisted graph boundary. */
function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${label} 字段集合非法`);
  }
}

/** Removes legacy asset presentation timestamps at the instance persistence boundary. */
function stripWorkflowAssetTimes(
  workflow: WorkflowRuntimeDefinition & { createdAt?: number; updatedAt?: number },
): WorkflowRuntimeDefinition {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...runtimeWorkflow } = workflow;
  return runtimeWorkflow;
}

function createEmptyIntake(row: any): TaskIntake {
  return {
    id: `missing-intake-${String(row.id ?? "")}` as TaskIntake["id"],
    workspaceId: row.workspace_id as WorkspaceId,
    triggerMode: "manual",
    taskType: "unknown",
    title: "",
    goal: "",
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? row.created_at ?? 0),
  };
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

