import crypto from "node:crypto";

import type {
  NodeWorkItem,
  NodeWorkItemAcceptanceCriterion,
  NodeWorkItemBoard,
  NodeWorkItemCompletionCheck,
  NodeWorkItemEvent,
  NodeWorkItemEventType,
  NodeWorkItemReworkScope,
  NodeWorkItemStatus,
  NodeWorkItemSummary,
  OrchestrationId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type NodeWorkItemCreateInput = {
  clientKey: string;
  title: string;
  description?: string | null;
  sourceKey?: string | null;
  outputPath?: string | null;
  sortOrder?: number | null;
  acceptanceCriteria?: NodeWorkItemAcceptanceCriterion[] | null;
};

export type NodeWorkItemUpdatePatch = {
  title?: string;
  description?: string | null;
  sourceKey?: string | null;
  outputPath?: string | null;
  sortOrder?: number;
  acceptanceCriteria?: NodeWorkItemAcceptanceCriterion[];
  status?: Extract<NodeWorkItemStatus, "pending" | "in_progress">;
};

type NormalizedNodeWorkItemCreateInput = {
  clientKey: string;
  title: string;
  description: string | null;
  sourceKey: string | null;
  outputPath: string | null;
  sortOrder: number | null;
  acceptanceCriteria: NodeWorkItemAcceptanceCriterion[];
};

type NodeWorkItemReopenScopeInput = NodeWorkItemReworkScope & {
  alwaysClientKeys?: string[] | null;
};

type NormalizedNodeWorkItemReopenScope = {
  nodeId: string;
  mode: "all" | "selected";
  sourceKeys: string[];
  alwaysClientKeys: string[];
};

type NodeWorkItemReopenPlan = {
  scope: NormalizedNodeWorkItemReopenScope;
  selected: NodeWorkItem[];
};

export class NodeWorkItemRepoError extends Error {
  /** 构造可透传到模型工具与 API 的稳定错误码。 */
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "NodeWorkItemRepoError";
  }
}

/** 节点工作项仓储：负责严格顺序状态机、CAS、软删除和追加事件。 */
export class OrchNodeWorkItemRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 读取看板；尚未创建工作项时返回 null。 */
  getBoard(instanceId: OrchestrationId, nodeId: string): NodeWorkItemBoard | null {
    const row = this.db.prepare(
      `SELECT instance_id, node_id, version, created_at, updated_at
       FROM orch_node_work_item_boards WHERE instance_id = ? AND node_id = ?`,
    ).get(String(instanceId), normalizeNodeId(nodeId)) as any | undefined;
    return row ? rowToBoard(row) : null;
  }

  /** 返回节点工作项汇总，不创建空看板。 */
  getSummary(instanceId: OrchestrationId, nodeId: string): NodeWorkItemSummary {
    const normalizedNodeId = normalizeNodeId(nodeId);
    const board = this.getBoard(instanceId, normalizedNodeId);
    if (!board) return emptySummary();
    const row = this.db.prepare(
      `SELECT
         SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN deleted_at IS NULL AND status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN deleted_at IS NULL AND status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN deleted_at IS NULL AND status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
       FROM orch_node_work_items WHERE instance_id = ? AND node_id = ?`,
    ).get(String(instanceId), normalizedNodeId) as any;
    const total = Number(row?.total ?? 0);
    const completed = Number(row?.completed ?? 0);
    return {
      total,
      pending: Number(row?.pending ?? 0),
      inProgress: Number(row?.in_progress ?? 0),
      completed,
      deleted: Number(row?.deleted ?? 0),
      progressPercent: total > 0 ? Math.floor((completed / total) * 100) : 0,
      boardVersion: board.version,
      updatedAt: board.updatedAt,
    };
  }

  /** 读取当前节点内未删除工作项，供 Host 完成门禁核对固定身份。 */
  get(instanceId: OrchestrationId, nodeId: string, itemId: string): NodeWorkItem | null {
    const normalizedNodeId = normalizeNodeId(nodeId);
    const row = this.db.prepare(
      `SELECT * FROM orch_node_work_items
       WHERE id = ? AND instance_id = ? AND node_id = ? AND deleted_at IS NULL`,
    ).get(requiredText(itemId, "itemId", 200), String(instanceId), normalizedNodeId) as any | undefined;
    return row ? rowToItem(row) : null;
  }

  /** 按稳定顺序分页读取工作项。 */
  list(input: {
    instanceId: OrchestrationId;
    nodeId: string;
    search?: string | null;
    statuses?: NodeWorkItemStatus[] | null;
    includeDeleted?: boolean;
    limit?: number;
    cursor?: string | null;
  }): { board: NodeWorkItemBoard | null; summary: NodeWorkItemSummary; items: NodeWorkItem[]; hasMore: boolean; nextCursor: string | null } {
    const nodeId = normalizeNodeId(input.nodeId);
    const limit = normalizeLimit(input.limit, 100, 500);
    const cursor = decodeItemCursor(input.cursor);
    const search = nullableText(input.search, 200);
    const statuses = normalizeStatuses(input.statuses);
    const where = ["instance_id = ?", "node_id = ?"];
    const params: unknown[] = [String(input.instanceId), nodeId];
    if (!input.includeDeleted) where.push("deleted_at IS NULL");
    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      where.push(
        "(title LIKE ? ESCAPE '\\' OR client_key LIKE ? ESCAPE '\\' OR source_key LIKE ? ESCAPE '\\' OR output_path LIKE ? ESCAPE '\\')",
      );
      params.push(pattern, pattern, pattern, pattern);
    }
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (cursor) {
      where.push("(sort_order > ? OR (sort_order = ? AND created_at > ?) OR (sort_order = ? AND created_at = ? AND id > ?))");
      params.push(cursor.sortOrder, cursor.sortOrder, cursor.createdAt, cursor.sortOrder, cursor.createdAt, cursor.id);
    }
    const rows = this.db.prepare(
      `SELECT * FROM orch_node_work_items
       WHERE ${where.join(" AND ")}
       ORDER BY sort_order ASC, created_at ASC, id ASC
       LIMIT ?`,
    ).all(...params, limit + 1) as any[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToItem);
    const last = items.at(-1) ?? null;
    return {
      board: this.getBoard(input.instanceId, nodeId),
      summary: this.getSummary(input.instanceId, nodeId),
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeItemCursor(last) : null,
    };
  }

  /** 倒序分页读取节点或单个工作项的追加事件。 */
  listEvents(input: {
    instanceId: OrchestrationId;
    nodeId: string;
    itemId?: string | null;
    limit?: number;
    cursor?: string | null;
  }): { events: NodeWorkItemEvent[]; hasMore: boolean; nextCursor: string | null } {
    const nodeId = normalizeNodeId(input.nodeId);
    const limit = normalizeLimit(input.limit, 100, 500);
    const beforeId = decodeEventCursor(input.cursor);
    const where = ["instance_id = ?", "node_id = ?"];
    const params: unknown[] = [String(input.instanceId), nodeId];
    const itemId = nullableText(input.itemId);
    if (itemId) {
      where.push("item_id = ?");
      params.push(itemId);
    }
    if (beforeId != null) {
      where.push("id < ?");
      params.push(beforeId);
    }
    const rows = this.db.prepare(
      `SELECT id, instance_id, node_id, item_id, event_type, item_version, payload_json, created_at
       FROM orch_node_work_item_events
       WHERE ${where.join(" AND ")}
       ORDER BY id DESC LIMIT ?`,
    ).all(...params, limit + 1) as any[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(rowToEvent);
    return {
      events,
      hasMore,
      nextCursor: hasMore && events.length ? String(events.at(-1)!.id) : null,
    };
  }

  /** 批量创建工作项；clientKey 在同一节点内保证幂等。 */
  createMany(input: {
    instanceId: OrchestrationId;
    nodeId: string;
    items: NodeWorkItemCreateInput[];
    actorAttemptId?: string | null;
  }): { items: NodeWorkItem[]; idempotentClientKeys: string[]; summary: NodeWorkItemSummary } {
    const nodeId = normalizeNodeId(input.nodeId);
    const items = normalizeCreateInputs(input.items);
    const actorAttemptId = nullableText(input.actorAttemptId);
    const transaction = this.db.transaction(() => {
      this.ensureBoard(input.instanceId, nodeId);
      let nextSortOrder = this.readMaxSortOrder(input.instanceId, nodeId);
      const created: NodeWorkItem[] = [];
      const idempotentClientKeys: string[] = [];
      for (const itemInput of items) {
        const existing = this.getActiveByClientKey(input.instanceId, nodeId, itemInput.clientKey);
        if (existing) {
          assertIdempotentCreate(existing, itemInput);
          created.push(existing);
          idempotentClientKeys.push(itemInput.clientKey);
          continue;
        }
        const now = Date.now();
        const sortOrder = itemInput.sortOrder ?? nextSortOrder + 1_000;
        nextSortOrder = Math.max(nextSortOrder, sortOrder);
        const id = `workitem_${crypto.randomUUID()}`;
        this.db.prepare(
          `INSERT INTO orch_node_work_items (
             id, instance_id, node_id, client_key, title, description, source_key, output_path,
             sort_order, status, result_summary, evidence_json, acceptance_criteria_json,
             completion_checks_json, output_sha256, version, started_at, completed_at, deleted_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, '[]', ?, '[]', NULL, 1, NULL, NULL, NULL, ?, ?)`,
        ).run(
          id,
          String(input.instanceId),
          nodeId,
          itemInput.clientKey,
          itemInput.title,
          itemInput.description,
          itemInput.sourceKey,
          itemInput.outputPath,
          sortOrder,
          JSON.stringify(itemInput.acceptanceCriteria),
          now,
          now,
        );
        const item = this.requireItem(id);
        this.appendEvent(input.instanceId, nodeId, item, "item_created", {
          actorAttemptId,
          clientKey: item.clientKey,
          sourceKey: item.sourceKey,
          outputPath: item.outputPath,
          acceptanceCriteria: item.acceptanceCriteria,
          sortOrder: item.sortOrder,
        });
        created.push(item);
      }
      this.assertSequentialIntegrity(input.instanceId, nodeId);
      if (created.length !== idempotentClientKeys.length) this.touchBoard(input.instanceId, nodeId);
      return { items: created, idempotentClientKeys };
    });
    const result = transaction();
    return { ...result, summary: this.getSummary(input.instanceId, nodeId) };
  }

  /** 使用 expectedVersion 更新工作项；完成必须走 complete。 */
  update(input: {
    instanceId: OrchestrationId;
    nodeId: string;
    itemId: string;
    expectedVersion: number;
    patch: NodeWorkItemUpdatePatch;
    reason?: string | null;
    actorAttemptId?: string | null;
  }): { item: NodeWorkItem; nextItem: NodeWorkItem | null; summary: NodeWorkItemSummary } {
    const nodeId = normalizeNodeId(input.nodeId);
    const patch = normalizeUpdatePatch(input.patch);
    const transaction = this.db.transaction(() => {
      const current = this.requireActiveItem(input.instanceId, nodeId, input.itemId);
      assertExpectedVersion(current, input.expectedVersion);
      validateMutableIdentity(current, patch);
      const nextStatus = patch.status ?? current.status;
      if (current.status === "completed" && nextStatus !== "pending") {
        if (patch.status) throw repoError("INVALID_TRANSITION", "已完成工作项只能重新打开为 pending");
      }
      if (nextStatus === "in_progress") this.assertCanStart(input.instanceId, nodeId, current.id);
      const now = Date.now();
      const reopened = current.status === "completed" && nextStatus === "pending";
      const started = current.status === "pending" && nextStatus === "in_progress";
      const result = this.db.prepare(
        `UPDATE orch_node_work_items SET
           title = ?, description = ?, source_key = ?, output_path = ?, sort_order = ?, status = ?,
           result_summary = ?, evidence_json = ?, acceptance_criteria_json = ?,
           completion_checks_json = ?, output_sha256 = ?, started_at = ?, completed_at = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      ).run(
        patch.title ?? current.title,
        Object.prototype.hasOwnProperty.call(patch, "description") ? patch.description ?? null : current.description,
        Object.prototype.hasOwnProperty.call(patch, "sourceKey") ? patch.sourceKey ?? null : current.sourceKey,
        Object.prototype.hasOwnProperty.call(patch, "outputPath") ? patch.outputPath ?? null : current.outputPath,
        patch.sortOrder ?? current.sortOrder,
        nextStatus,
        reopened ? null : current.resultSummary,
        reopened ? "[]" : JSON.stringify(current.evidence),
        JSON.stringify(patch.acceptanceCriteria ?? current.acceptanceCriteria),
        reopened ? "[]" : JSON.stringify(current.completionChecks),
        reopened ? null : current.outputSha256,
        started ? now : current.startedAt,
        reopened ? null : current.completedAt,
        now,
        current.id,
        current.version,
      );
      if (Number(result.changes ?? 0) !== 1) throw versionConflict(current.id);
      this.assertSequentialIntegrity(input.instanceId, nodeId);
      const updated = this.requireItem(current.id);
      const type: NodeWorkItemEventType = reopened ? "item_reopened" : started ? "item_started" : "item_updated";
      this.appendEvent(input.instanceId, nodeId, updated, type, {
        actorAttemptId: nullableText(input.actorAttemptId),
        reason: nullableText(input.reason),
        changedFields: Object.keys(patch),
      });
      this.touchBoard(input.instanceId, nodeId);
      return updated;
    });
    const item = transaction();
    return { item, nextItem: this.getNext(input.instanceId, nodeId), summary: this.getSummary(input.instanceId, nodeId) };
  }

  /** 软删除从未启动的 pending 工作项。 */
  delete(input: {
    instanceId: OrchestrationId;
    nodeId: string;
    itemId: string;
    expectedVersion: number;
    reason?: string | null;
    actorAttemptId?: string | null;
  }): { item: NodeWorkItem; nextItem: NodeWorkItem | null; summary: NodeWorkItemSummary } {
    const nodeId = normalizeNodeId(input.nodeId);
    const transaction = this.db.transaction(() => {
      const current = this.requireActiveItem(input.instanceId, nodeId, input.itemId);
      assertExpectedVersion(current, input.expectedVersion);
      if (current.status !== "pending" || current.startedAt != null) {
        throw repoError("WORK_ITEM_ALREADY_STARTED", "已启动或已完成的工作项不能删除；需要返工时请重新打开该项");
      }
      const now = Date.now();
      const result = this.db.prepare(
        `UPDATE orch_node_work_items
         SET deleted_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      ).run(now, now, current.id, current.version);
      if (Number(result.changes ?? 0) !== 1) throw versionConflict(current.id);
      const deleted = this.requireItem(current.id);
      this.appendEvent(input.instanceId, nodeId, deleted, "item_deleted", {
        actorAttemptId: nullableText(input.actorAttemptId),
        reason: nullableText(input.reason),
      });
      this.touchBoard(input.instanceId, nodeId);
      return deleted;
    });
    const item = transaction();
    return { item, nextItem: this.getNext(input.instanceId, nodeId), summary: this.getSummary(input.instanceId, nodeId) };
  }

  /** 完成当前唯一进行中的首个未完成项，并返回下一项。 */
  complete(input: {
    instanceId: OrchestrationId;
    nodeId: string;
    itemId: string;
    expectedVersion: number;
    resultSummary: string;
    evidence?: string[] | null;
    completionChecks?: NodeWorkItemCompletionCheck[] | null;
    outputPath?: string | null;
    outputSha256?: string | null;
    actorAttemptId?: string | null;
  }): { item: NodeWorkItem; nextItem: NodeWorkItem | null; summary: NodeWorkItemSummary } {
    const nodeId = normalizeNodeId(input.nodeId);
    const resultSummary = requiredText(input.resultSummary, "resultSummary", 8_000);
    const evidence = normalizeEvidence(input.evidence);
    const completionChecks = normalizeCompletionChecks(input.completionChecks);
    const outputPath = normalizeOutputPathText(input.outputPath, "outputPath");
    const outputSha256 = normalizeOutputSha256(input.outputSha256);
    const transaction = this.db.transaction(() => {
      const current = this.requireActiveItem(input.instanceId, nodeId, input.itemId);
      assertExpectedVersion(current, input.expectedVersion);
      if (current.status !== "in_progress") {
        throw repoError("INVALID_TRANSITION", "只有当前 in_progress 工作项可以完成");
      }
      this.assertCanStart(input.instanceId, nodeId, current.id);
      if (current.outputPath && outputPath && current.outputPath !== outputPath) {
        throw repoError("WORK_ITEM_IDENTITY_LOCKED", "工作项启动后不能改写 outputPath");
      }
      assertCompletionChecks(current.acceptanceCriteria, completionChecks);
      const now = Date.now();
      const result = this.db.prepare(
        `UPDATE orch_node_work_items SET
           status = 'completed', result_summary = ?, evidence_json = ?, output_path = ?,
           completion_checks_json = ?, output_sha256 = ?, completed_at = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      ).run(
        resultSummary,
        JSON.stringify(evidence),
        current.outputPath ?? outputPath,
        JSON.stringify(completionChecks),
        outputSha256,
        now,
        now,
        current.id,
        current.version,
      );
      if (Number(result.changes ?? 0) !== 1) throw versionConflict(current.id);
      const completed = this.requireItem(current.id);
      this.appendEvent(input.instanceId, nodeId, completed, "item_completed", {
        actorAttemptId: nullableText(input.actorAttemptId),
        resultSummary,
        evidence,
        completionChecks,
        outputPath: completed.outputPath,
        outputSha256: completed.outputSha256,
      });
      this.touchBoard(input.instanceId, nodeId);
      return completed;
    });
    const item = transaction();
    return { item, nextItem: this.getNext(input.instanceId, nodeId), summary: this.getSummary(input.instanceId, nodeId) };
  }

  /** 只读预检批量返工范围，确保所有节点、sourceKey 和固定伴随项都可精确定位。 */
  validateReopenMany(input: {
    instanceId: OrchestrationId;
    scopes: NodeWorkItemReopenScopeInput[];
    allowInProgress?: boolean;
  }): Array<{ nodeId: string; selectedCount: number; completedCount: number; pendingCount: number }> {
    const plans = this.resolveReopenPlans(
      input.instanceId,
      normalizeReopenScopes(input.scopes),
      input.allowInProgress === true,
    );
    return plans.map(({ scope, selected }) => ({
      nodeId: scope.nodeId,
      selectedCount: selected.length,
      completedCount: selected.filter((item) => item.status === "completed").length,
      pendingCount: selected.filter((item) => item.status === "pending").length,
    }));
  }

  /** 在一个事务内按显式范围批量重开多个节点的工作项，并保留逐项审计事件。 */
  reopenMany(input: {
    instanceId: OrchestrationId;
    scopes: NodeWorkItemReopenScopeInput[];
    reason: string;
    actorAttemptId?: string | null;
    batchId?: string | null;
    allowInProgress?: boolean;
  }): {
    batchId: string;
    nodes: Array<{
      nodeId: string;
      reopenedClientKeys: string[];
      unchangedClientKeys: string[];
      summary: NodeWorkItemSummary;
    }>;
  } {
    const scopes = normalizeReopenScopes(input.scopes);
    const reason = requiredText(input.reason, "reason", 8_000);
    const actorAttemptId = nullableText(input.actorAttemptId);
    const batchId = nullableText(input.batchId, 200) ?? `workitem_reopen_${crypto.randomUUID()}`;
    const allowInProgress = input.allowInProgress === true;
    const transaction = this.db.transaction(() => {
      const plans = this.resolveReopenPlans(input.instanceId, scopes, allowInProgress);

      return plans.map(({ scope, selected }) => {
        const reopenedClientKeys: string[] = [];
        const unchangedClientKeys: string[] = [];
        const now = Date.now();
        for (const current of selected) {
          const canReopen = current.status === "completed" || (allowInProgress && current.status === "in_progress");
          if (!canReopen) {
            unchangedClientKeys.push(current.clientKey);
            continue;
          }
          const result = this.db.prepare(
            `UPDATE orch_node_work_items SET
               status = 'pending', result_summary = NULL, evidence_json = '[]',
               completion_checks_json = '[]', output_sha256 = NULL, completed_at = NULL,
               version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL AND status = ?`,
          ).run(now, current.id, current.version, current.status);
          if (Number(result.changes ?? 0) !== 1) throw versionConflict(current.id);
          const reopened = this.requireItem(current.id);
          this.appendEvent(input.instanceId, scope.nodeId, reopened, "item_reopened", {
            actorAttemptId,
            batchId,
            reason,
            mode: scope.mode,
            previousStatus: current.status,
          });
          reopenedClientKeys.push(reopened.clientKey);
        }
        this.assertSequentialIntegrity(input.instanceId, scope.nodeId);
        if (reopenedClientKeys.length) this.touchBoard(input.instanceId, scope.nodeId);
        return { nodeId: scope.nodeId, reopenedClientKeys, unchangedClientKeys };
      });
    });
    const nodes = transaction().map((node) => ({
      ...node,
      summary: this.getSummary(input.instanceId, node.nodeId),
    }));
    return { batchId, nodes };
  }

  /** 返回严格排序后的首个未完成工作项。 */
  getNext(instanceId: OrchestrationId, nodeId: string): NodeWorkItem | null {
    const row = this.db.prepare(
      `SELECT * FROM orch_node_work_items
       WHERE instance_id = ? AND node_id = ? AND deleted_at IS NULL AND status != 'completed'
       ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT 1`,
    ).get(String(instanceId), normalizeNodeId(nodeId)) as any | undefined;
    return row ? rowToItem(row) : null;
  }

  /** 解析并完整验证批量返工计划；调用方决定只读预检或事务应用。 */
  private resolveReopenPlans(
    instanceId: OrchestrationId,
    scopes: NormalizedNodeWorkItemReopenScope[],
    allowInProgress = false,
  ): NodeWorkItemReopenPlan[] {
    return scopes.map((scope) => {
      if (!this.getBoard(instanceId, scope.nodeId)) {
        throw repoError("WORK_ITEM_BOARD_NOT_FOUND", `节点 ${scope.nodeId} 尚未创建工作项看板`);
      }
      const rows = this.db.prepare(
        `SELECT * FROM orch_node_work_items
         WHERE instance_id = ? AND node_id = ? AND deleted_at IS NULL
         ORDER BY sort_order ASC, created_at ASC, id ASC`,
      ).all(String(instanceId), scope.nodeId) as any[];
      const items = rows.map(rowToItem);
      const requestedSourceKeys = new Set(scope.sourceKeys);
      const alwaysClientKeys = new Set(scope.alwaysClientKeys);
      const selected = scope.mode === "all"
        ? items
        : items.filter((item) => requestedSourceKeys.has(item.sourceKey ?? "") || alwaysClientKeys.has(item.clientKey));
      if (scope.mode === "selected") {
        const matchedSourceKeys = new Set(selected.map((item) => item.sourceKey).filter((item): item is string => Boolean(item)));
        const missingSourceKeys = scope.sourceKeys.filter((sourceKey) => !matchedSourceKeys.has(sourceKey));
        if (missingSourceKeys.length) {
          throw repoError("WORK_ITEM_REWORK_SCOPE_MISMATCH", `节点 ${scope.nodeId} 找不到返工 sourceKey：${missingSourceKeys.join("、")}`);
        }
      }
      const matchedClientKeys = new Set(selected.map((item) => item.clientKey));
      const missingAlwaysClientKeys = scope.alwaysClientKeys.filter((clientKey) => !matchedClientKeys.has(clientKey));
      if (missingAlwaysClientKeys.length) {
        throw repoError("WORK_ITEM_REWORK_SCOPE_MISMATCH", `节点 ${scope.nodeId} 找不到固定返工项：${missingAlwaysClientKeys.join("、")}`);
      }
      const active = selected.find((item) => item.status === "in_progress");
      if (active && !allowInProgress) {
        throw repoError("WORK_ITEM_REWORK_CONFLICT", `节点 ${scope.nodeId} 的工作项 ${active.clientKey} 仍在进行中，不能批量重开`);
      }
      return { scope, selected };
    });
  }

  /** 确保看板存在，并记录一次不可变创建事件。 */
  private ensureBoard(instanceId: OrchestrationId, nodeId: string): void {
    if (this.getBoard(instanceId, nodeId)) return;
    const now = Date.now();
    this.db.prepare(
      `INSERT OR IGNORE INTO orch_node_work_item_boards (instance_id, node_id, version, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(String(instanceId), nodeId, now, now);
    this.db.prepare(
      `INSERT INTO orch_node_work_item_events
       (instance_id, node_id, item_id, event_type, item_version, payload_json, created_at)
       VALUES (?, ?, NULL, 'board_created', NULL, NULL, ?)`,
    ).run(String(instanceId), nodeId, now);
  }

  /** 递增看板版本，供跨回合进度检测和 UI 刷新。 */
  private touchBoard(instanceId: OrchestrationId, nodeId: string): void {
    this.db.prepare(
      `UPDATE orch_node_work_item_boards SET version = version + 1, updated_at = ?
       WHERE instance_id = ? AND node_id = ?`,
    ).run(Date.now(), String(instanceId), nodeId);
  }

  /** 写入一条工作项追加事件。 */
  private appendEvent(
    instanceId: OrchestrationId,
    nodeId: string,
    item: NodeWorkItem,
    type: NodeWorkItemEventType,
    payload: Record<string, unknown> | null,
  ): void {
    this.db.prepare(
      `INSERT INTO orch_node_work_item_events
       (instance_id, node_id, item_id, event_type, item_version, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      String(instanceId),
      nodeId,
      item.id,
      type,
      item.version,
      payload ? JSON.stringify(payload) : null,
      Date.now(),
    );
  }

  /** 校验同一节点最多一个进行项，且它必须是首个未完成项。 */
  private assertSequentialIntegrity(instanceId: OrchestrationId, nodeId: string): void {
    const rows = this.db.prepare(
      `SELECT id, status FROM orch_node_work_items
       WHERE instance_id = ? AND node_id = ? AND deleted_at IS NULL AND status != 'completed'
       ORDER BY sort_order ASC, created_at ASC, id ASC`,
    ).all(String(instanceId), nodeId) as Array<{ id: string; status: NodeWorkItemStatus }>;
    const active = rows.filter((row) => row.status === "in_progress");
    if (active.length > 1) throw repoError("WORK_ITEM_SEQUENCE_CONFLICT", "同一节点只能有一个 in_progress 工作项");
    if (active.length === 1 && rows[0]?.id !== active[0]?.id) {
      throw repoError("WORK_ITEM_OUT_OF_ORDER", "进行中的工作项必须是首个未完成项，不能通过排序或新增工作项插队");
    }
  }

  /** 校验指定项可以成为或仍是当前进行项。 */
  private assertCanStart(instanceId: OrchestrationId, nodeId: string, itemId: string): void {
    const first = this.getNext(instanceId, nodeId);
    if (!first || first.id !== itemId) {
      throw repoError("WORK_ITEM_OUT_OF_ORDER", `只能处理首个未完成工作项：${first?.id ?? "无"}`);
    }
    const row = this.db.prepare(
      `SELECT id FROM orch_node_work_items
       WHERE instance_id = ? AND node_id = ? AND deleted_at IS NULL AND status = 'in_progress' AND id != ?
       LIMIT 1`,
    ).get(String(instanceId), nodeId, itemId) as any | undefined;
    if (row) throw repoError("WORK_ITEM_SEQUENCE_CONFLICT", `已有进行中的工作项：${String(row.id)}`);
  }

  /** 按 clientKey 读取未删除工作项。 */
  private getActiveByClientKey(instanceId: OrchestrationId, nodeId: string, clientKey: string): NodeWorkItem | null {
    const row = this.db.prepare(
      `SELECT * FROM orch_node_work_items
       WHERE instance_id = ? AND node_id = ? AND client_key = ? AND deleted_at IS NULL`,
    ).get(String(instanceId), nodeId, clientKey) as any | undefined;
    return row ? rowToItem(row) : null;
  }

  /** 读取工作项，不限定软删除状态。 */
  private requireItem(itemId: string): NodeWorkItem {
    const row = this.db.prepare("SELECT * FROM orch_node_work_items WHERE id = ?").get(requiredText(itemId, "itemId", 200)) as any | undefined;
    if (!row) throw repoError("WORK_ITEM_NOT_FOUND", `工作项不存在：${itemId}`);
    return rowToItem(row);
  }

  /** 读取指定节点内的未删除工作项。 */
  private requireActiveItem(instanceId: OrchestrationId, nodeId: string, itemId: string): NodeWorkItem {
    const item = this.requireItem(itemId);
    if (item.instanceId !== instanceId || item.nodeId !== nodeId || item.deletedAt != null) {
      throw repoError("WORK_ITEM_NOT_FOUND", `当前节点不存在工作项：${itemId}`);
    }
    return item;
  }

  /** 读取当前最大排序值。 */
  private readMaxSortOrder(instanceId: OrchestrationId, nodeId: string): number {
    const row = this.db.prepare(
      "SELECT MAX(sort_order) AS max_sort_order FROM orch_node_work_items WHERE instance_id = ? AND node_id = ? AND deleted_at IS NULL",
    ).get(String(instanceId), nodeId) as any;
    return Number(row?.max_sort_order ?? 0);
  }
}

/** 将数据库行映射为工作项。 */
function rowToItem(row: any): NodeWorkItem {
  return {
    id: String(row.id),
    instanceId: String(row.instance_id) as OrchestrationId,
    nodeId: String(row.node_id),
    clientKey: String(row.client_key),
    title: String(row.title),
    description: nullableText(row.description),
    sourceKey: nullableText(row.source_key),
    outputPath: nullableText(row.output_path),
    sortOrder: Number(row.sort_order),
    status: normalizeStatus(row.status),
    resultSummary: nullableText(row.result_summary, 8_000),
    evidence: parseEvidence(row.evidence_json),
    acceptanceCriteria: parseAcceptanceCriteria(row.acceptance_criteria_json),
    completionChecks: parseCompletionChecks(row.completion_checks_json),
    outputSha256: normalizeOutputSha256(row.output_sha256),
    version: Number(row.version),
    startedAt: nullableNumber(row.started_at),
    completedAt: nullableNumber(row.completed_at),
    deletedAt: nullableNumber(row.deleted_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 将数据库行映射为看板。 */
function rowToBoard(row: any): NodeWorkItemBoard {
  return {
    instanceId: String(row.instance_id) as OrchestrationId,
    nodeId: String(row.node_id),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 将数据库行映射为追加事件。 */
function rowToEvent(row: any): NodeWorkItemEvent {
  return {
    id: Number(row.id),
    instanceId: String(row.instance_id) as OrchestrationId,
    nodeId: String(row.node_id),
    itemId: nullableText(row.item_id),
    type: String(row.event_type) as NodeWorkItemEventType,
    itemVersion: nullableNumber(row.item_version),
    payload: parseJsonRecord(row.payload_json),
    createdAt: Number(row.created_at),
  };
}

/** 构造尚无看板时的空汇总。 */
function emptySummary(): NodeWorkItemSummary {
  return { total: 0, pending: 0, inProgress: 0, completed: 0, deleted: 0, progressPercent: 0, boardVersion: 0, updatedAt: null };
}

/** 规范化批量创建输入并拒绝同批重复 clientKey。 */
function normalizeCreateInputs(value: NodeWorkItemCreateInput[]): NormalizedNodeWorkItemCreateInput[] {
  if (!Array.isArray(value) || value.length === 0) throw repoError("INVALID_INPUT", "items 至少包含一项");
  if (value.length > 2_000) throw repoError("INVALID_INPUT", "单次最多创建 2000 个工作项");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const clientKey = requiredText(item?.clientKey, `items[${index}].clientKey`, 500);
    if (seen.has(clientKey)) throw repoError("DUPLICATE_CLIENT_KEY", `同批 clientKey 重复：${clientKey}`);
    seen.add(clientKey);
    return {
      clientKey,
      title: requiredText(item?.title, `items[${index}].title`, 1_000),
      description: nullableText(item?.description, 8_000),
      sourceKey: nullableText(item?.sourceKey, 2_000),
      outputPath: normalizeOutputPathText(item?.outputPath, `items[${index}].outputPath`),
      sortOrder: normalizeOptionalSortOrder(item?.sortOrder),
      acceptanceCriteria: normalizeAcceptanceCriteria(item?.acceptanceCriteria),
    };
  });
}

/** 规范化更新补丁并拒绝空更新。 */
function normalizeUpdatePatch(value: NodeWorkItemUpdatePatch): NodeWorkItemUpdatePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw repoError("INVALID_INPUT", "patch 必须是对象");
  const out: NodeWorkItemUpdatePatch = {};
  if (Object.prototype.hasOwnProperty.call(value, "title")) out.title = requiredText(value.title, "patch.title", 1_000);
  if (Object.prototype.hasOwnProperty.call(value, "description")) out.description = nullableText(value.description, 8_000);
  if (Object.prototype.hasOwnProperty.call(value, "sourceKey")) out.sourceKey = nullableText(value.sourceKey, 2_000);
  if (Object.prototype.hasOwnProperty.call(value, "outputPath")) out.outputPath = normalizeOutputPathText(value.outputPath, "patch.outputPath");
  if (Object.prototype.hasOwnProperty.call(value, "sortOrder")) out.sortOrder = normalizeRequiredSortOrder(value.sortOrder);
  if (Object.prototype.hasOwnProperty.call(value, "acceptanceCriteria")) out.acceptanceCriteria = normalizeAcceptanceCriteria(value.acceptanceCriteria);
  if (Object.prototype.hasOwnProperty.call(value, "status")) {
    if (value.status !== "pending" && value.status !== "in_progress") throw repoError("INVALID_INPUT", "patch.status 只能是 pending 或 in_progress");
    out.status = value.status;
  }
  if (!Object.keys(out).length) throw repoError("INVALID_INPUT", "patch 至少包含一个字段");
  return out;
}

/** 锁定已启动项身份；仅允许 pending 历史乱码项修复 outputPath。 */
function validateMutableIdentity(current: NodeWorkItem, patch: NodeWorkItemUpdatePatch): void {
  if (current.startedAt == null) return;
  if (patch.sourceKey !== undefined && patch.sourceKey !== current.sourceKey) throw repoError("WORK_ITEM_IDENTITY_LOCKED", "工作项启动后不能改写 sourceKey");
  if (
    patch.outputPath !== undefined
    && patch.outputPath !== current.outputPath
    && !canRepairDamagedOutputPath(current, patch.outputPath)
  ) {
    throw repoError("WORK_ITEM_IDENTITY_LOCKED", "工作项启动后不能改写 outputPath");
  }
  if (patch.sortOrder !== undefined && patch.sortOrder !== current.sortOrder) throw repoError("WORK_ITEM_IDENTITY_LOCKED", "工作项启动后不能改写 sortOrder");
  if (patch.acceptanceCriteria !== undefined && !sameJson(patch.acceptanceCriteria, current.acceptanceCriteria)) {
    if (current.status !== "pending" || !isAcceptanceCriteriaStrengthening(current.acceptanceCriteria, patch.acceptanceCriteria)) {
      throw repoError("WORK_ITEM_IDENTITY_LOCKED", "工作项启动后不能弱化或改写 acceptanceCriteria；仅重开为 pending 时允许在末尾追加条件");
    }
  }
}

/** 仅修复已重开为 pending 且旧值明确含 U+FFFD 的历史输出路径。 */
function canRepairDamagedOutputPath(current: NodeWorkItem, nextOutputPath: string | null): boolean {
  return current.status === "pending"
    && current.outputPath?.includes("\uFFFD") === true
    && typeof nextOutputPath === "string"
    && nextOutputPath.length > 0;
}

/** 判断新验收条件是否仅在原有有序条件后追加内容。 */
function isAcceptanceCriteriaStrengthening(
  current: NodeWorkItemAcceptanceCriterion[],
  next: NodeWorkItemAcceptanceCriterion[],
): boolean {
  if (next.length <= current.length) return false;
  return current.every((criterion, index) => sameJson(criterion, next[index]));
}

/** 校验 clientKey 重放与原创建身份一致。 */
function assertIdempotentCreate(existing: NodeWorkItem, input: ReturnType<typeof normalizeCreateInputs>[number]): void {
  if (existing.title !== input.title
    || existing.sourceKey !== input.sourceKey
    || existing.outputPath !== input.outputPath
    || !sameJson(existing.acceptanceCriteria, input.acceptanceCriteria)) {
    throw repoError("CLIENT_KEY_CONFLICT", `clientKey ${input.clientKey} 已对应不同工作项；请使用 update 修改未开始项`);
  }
}

/** 校验工作项乐观锁版本。 */
function assertExpectedVersion(item: NodeWorkItem, expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw repoError("INVALID_INPUT", "expectedVersion 必须是正整数");
  if (item.version !== expectedVersion) throw versionConflict(item.id, item.version);
}

/** 构造工作项版本冲突错误。 */
function versionConflict(itemId: string, currentVersion?: number): NodeWorkItemRepoError {
  return repoError("WORK_ITEM_VERSION_CONFLICT", `工作项版本已变化：${itemId}${currentVersion ? `，当前版本 ${currentVersion}` : ""}；请先重新 list`);
}

/** 规范化节点 ID。 */
function normalizeNodeId(value: unknown): string {
  return requiredText(value, "nodeId", 500);
}

/** 规范化状态筛选。 */
function normalizeStatuses(value: NodeWorkItemStatus[] | null | undefined): NodeWorkItemStatus[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizeStatus)));
}

/** 规范化单个工作项状态。 */
function normalizeStatus(value: unknown): NodeWorkItemStatus {
  if (value === "pending" || value === "in_progress" || value === "completed") return value;
  throw repoError("INVALID_STATUS", `未知工作项状态：${String(value)}`);
}

/** 规范化结果证据引用。 */
function normalizeEvidence(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw repoError("INVALID_INPUT", "evidence 必须是字符串数组");
  return Array.from(new Set(value.map((item) => requiredText(item, "evidence[]", 4_000))));
}

/** 规范化工作项验收条件并拒绝重复 criterion id。 */
function normalizeAcceptanceCriteria(value: unknown): NodeWorkItemAcceptanceCriterion[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw repoError("INVALID_INPUT", "acceptanceCriteria 必须是对象数组");
  if (value.length > 100) throw repoError("INVALID_INPUT", "acceptanceCriteria 单项最多 100 条");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw repoError("INVALID_INPUT", `acceptanceCriteria[${index}] 必须是对象`);
    }
    const criterion = raw as Record<string, unknown>;
    const id = requiredText(criterion.id, `acceptanceCriteria[${index}].id`, 200);
    if (seen.has(id)) throw repoError("DUPLICATE_ACCEPTANCE_CRITERION", `验收条件 id 重复：${id}`);
    seen.add(id);
    return { id, label: requiredText(criterion.label, `acceptanceCriteria[${index}].label`, 1_000) };
  });
}

/** 规范化完成检查并拒绝同一 criterion 重复自证。 */
function normalizeCompletionChecks(value: unknown): NodeWorkItemCompletionCheck[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw repoError("INVALID_INPUT", "completionChecks 必须是对象数组");
  if (value.length > 100) throw repoError("INVALID_INPUT", "completionChecks 单项最多 100 条");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw repoError("INVALID_INPUT", `completionChecks[${index}] 必须是对象`);
    }
    const check = raw as Record<string, unknown>;
    const criterionId = requiredText(check.criterionId, `completionChecks[${index}].criterionId`, 200);
    if (seen.has(criterionId)) throw repoError("DUPLICATE_COMPLETION_CHECK", `完成检查 criterionId 重复：${criterionId}`);
    seen.add(criterionId);
    return {
      criterionId,
      evidence: requiredText(check.evidence, `completionChecks[${index}].evidence`, 4_000),
    };
  });
}

/** 验证完成检查精确覆盖创建时冻结的验收条件。 */
function assertCompletionChecks(
  criteria: NodeWorkItemAcceptanceCriterion[],
  checks: NodeWorkItemCompletionCheck[],
): void {
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const checkIds = new Set(checks.map((check) => check.criterionId));
  const unknown = checks.filter((check) => !criterionIds.has(check.criterionId)).map((check) => check.criterionId);
  if (unknown.length) throw repoError("UNKNOWN_COMPLETION_CHECK", `完成检查引用未知验收条件：${unknown.join("、")}`);
  const missing = criteria.filter((criterion) => !checkIds.has(criterion.id)).map((criterion) => criterion.id);
  if (missing.length) throw repoError("INCOMPLETE_ACCEPTANCE_CHECKS", `工作项仍有未检查验收条件：${missing.join("、")}`);
}

/** 规范化并校验已验证输出哈希。 */
function normalizeOutputSha256(value: unknown): string | null {
  const text = nullableText(value, 64)?.toLowerCase() ?? null;
  if (text && !/^[a-f0-9]{64}$/.test(text)) throw repoError("INVALID_INPUT", "outputSha256 必须是 64 位 SHA256 十六进制文本");
  return text;
}

/** 归一化跨节点批量重开范围并拒绝模糊或重复节点声明。 */
function normalizeReopenScopes(value: NodeWorkItemReopenScopeInput[]): NormalizedNodeWorkItemReopenScope[] {
  if (!Array.isArray(value) || value.length === 0) throw repoError("INVALID_INPUT", "scopes 至少包含一个节点范围");
  if (value.length > 100) throw repoError("INVALID_INPUT", "scopes 单次最多包含 100 个节点");
  const seenNodeIds = new Set<string>();
  return value.map((raw, index) => {
    const nodeId = normalizeNodeId(raw?.nodeId);
    if (seenNodeIds.has(nodeId)) throw repoError("DUPLICATE_REWORK_SCOPE", `返工节点范围重复：${nodeId}`);
    seenNodeIds.add(nodeId);
    const mode = raw?.mode;
    if (mode !== "all" && mode !== "selected") throw repoError("INVALID_INPUT", `scopes[${index}].mode 只能是 all 或 selected`);
    const sourceKeys = normalizeStableKeyArray(raw?.sourceKeys, `scopes[${index}].sourceKeys`, 2_000);
    if (mode === "selected" && sourceKeys.length === 0) {
      throw repoError("INVALID_INPUT", `scopes[${index}].sourceKeys 在 selected 模式不能为空`);
    }
    if (mode === "all" && sourceKeys.length > 0) {
      throw repoError("INVALID_INPUT", `scopes[${index}].sourceKeys 在 all 模式必须省略`);
    }
    return {
      nodeId,
      mode,
      sourceKeys,
      alwaysClientKeys: normalizeStableKeyArray(raw?.alwaysClientKeys, `scopes[${index}].alwaysClientKeys`, 100),
    };
  });
}

/** 规范化稳定键数组，用于确定性范围选择。 */
function normalizeStableKeyArray(value: unknown, field: string, maxItems: number): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw repoError("INVALID_INPUT", `${field} 必须是字符串数组`);
  if (value.length > maxItems) throw repoError("INVALID_INPUT", `${field} 最多包含 ${maxItems} 项`);
  return Array.from(new Set(value.map((item) => requiredText(item, `${field}[]`, 2_000))));
}

/** 安全解析持久化证据数组。 */
function parseEvidence(value: unknown): string[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw repoError("CORRUPT_WORK_ITEM", `工作项 evidence_json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeEvidence(parsed);
}

/** 安全解析持久化验收条件。 */
function parseAcceptanceCriteria(value: unknown): NodeWorkItemAcceptanceCriterion[] {
  return normalizeAcceptanceCriteria(parseJsonArray(value, "acceptance_criteria_json"));
}

/** 安全解析持久化完成检查。 */
function parseCompletionChecks(value: unknown): NodeWorkItemCompletionCheck[] {
  return normalizeCompletionChecks(parseJsonArray(value, "completion_checks_json"));
}

/** 解析工作项 JSON 数组列，损坏时显式失败。 */
function parseJsonArray(value: unknown, column: string): unknown[] {
  if (typeof value !== "string") {
    throw repoError("CORRUPT_WORK_ITEM", `工作项 ${column} 不是 JSON 文本`);
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("不是数组");
    return parsed;
  } catch (error) {
    throw repoError("CORRUPT_WORK_ITEM", `工作项 ${column} 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 比较已归一化的短结构化字段。 */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 安全解析事件 payload。 */
function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch (error) {
    throw repoError("CORRUPT_WORK_ITEM_EVENT", `工作项事件 payload_json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 编码稳定工作项分页游标。 */
function encodeItemCursor(item: NodeWorkItem): string {
  return Buffer.from(JSON.stringify([item.sortOrder, item.createdAt, item.id]), "utf8").toString("base64url");
}

/** 解码稳定工作项分页游标。 */
function decodeItemCursor(value: string | null | undefined): { sortOrder: number; createdAt: number; id: string } | null {
  const cursor = nullableText(value, 4_000);
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error("shape");
    const sortOrder = Number(parsed[0]);
    const createdAt = Number(parsed[1]);
    const id = requiredText(parsed[2], "cursor.id", 200);
    if (!Number.isSafeInteger(sortOrder) || !Number.isSafeInteger(createdAt)) throw new Error("number");
    return { sortOrder, createdAt, id };
  } catch {
    throw repoError("INVALID_CURSOR", "工作项分页 cursor 无效");
  }
}

/** 解码事件 ID 游标。 */
function decodeEventCursor(value: string | null | undefined): number | null {
  const cursor = nullableText(value, 100);
  if (!cursor) return null;
  const id = Number(cursor);
  if (!Number.isSafeInteger(id) || id < 1) throw repoError("INVALID_CURSOR", "工作项事件 cursor 无效");
  return id;
}

/** 规范化分页大小。 */
function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** 规范化可选排序值。 */
function normalizeOptionalSortOrder(value: unknown): number | null {
  return value == null ? null : normalizeRequiredSortOrder(value);
}

/** 规范化必填排序值。 */
function normalizeRequiredSortOrder(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw repoError("INVALID_INPUT", "sortOrder 必须是非负整数");
  return parsed;
}

/** 规范化必填文本。 */
function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = String(value ?? "").trim();
  if (!text) throw repoError("INVALID_INPUT", `${field} 不能为空`);
  if (text.length > maxLength) throw repoError("INVALID_INPUT", `${field} 超过最大长度 ${maxLength}`);
  return text;
}

/** 规范化可空文本。 */
function nullableText(value: unknown, maxLength = 8_000): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw repoError("INVALID_INPUT", `文本超过最大长度 ${maxLength}`);
  return text;
}

/** 规范化输出路径，并拒绝已经丢失原始字符信息的路径文本。 */
function normalizeOutputPathText(value: unknown, field: string): string | null {
  const text = nullableText(value, 4_000);
  if (text?.includes("\uFFFD")) {
    throw repoError("INVALID_OUTPUT_PATH_TEXT", `${field} 包含 Unicode 替换字符 U+FFFD，原始路径信息已丢失，请提交正确 outputPath`);
  }
  return text;
}

/** 转义 SQLite LIKE 通配符，确保搜索词按字面值匹配。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** 规范化可空数字。 */
function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

/** 构造带稳定错误码的仓储错误。 */
function repoError(code: string, message: string): NodeWorkItemRepoError {
  return new NodeWorkItemRepoError(code, message);
}
