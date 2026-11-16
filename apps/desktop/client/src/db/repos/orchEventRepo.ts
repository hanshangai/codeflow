import crypto from "node:crypto";

import type { OrchestrationEventId, OrchestrationEventRecord, OrchestrationId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type OrchEventListOptions = {
  limit?: number | null;
  includePayload?: boolean | null;
};

/** 节点状态迁移的最小投影；status 为空串表示 payload 缺契约字段，由调用方显式失败。 */
export type OrchNodeStatusTransition = { nodeId: string; status: string; createdAt: number };

/** 编排事件仓储。 */
export class OrchEventRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 列出实例事件；limit 存在时返回最近 N 条并保持时间升序，可选择只返回摘要 payload。 */
  listByInstance(instanceId: OrchestrationId, options: OrchEventListOptions = {}): OrchestrationEventRecord[] {
    const limit = normalizeListLimit(options.limit);
    const includePayload = options.includePayload !== false;
    if (limit) {
      const rows = this.db
        .prepare(
          `SELECT id, instance_id, node_id, type, payload_json, created_at
           FROM (
             SELECT id, instance_id, node_id, type, payload_json, created_at
             FROM orch_events WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?
           )
           ORDER BY created_at ASC`,
        )
        .all(String(instanceId), limit) as any[];
      return rows.map((row) => rowToEvent(row, { includePayload }));
    }
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, node_id, type, payload_json, created_at
         FROM orch_events WHERE instance_id = ? ORDER BY created_at ASC`,
      )
      .all(String(instanceId)) as any[];
    return rows.map((row) => rowToEvent(row, { includePayload }));
  }

  /**
   * 列出实例的节点状态迁移时间轴（按 created_at、rowid 升序）。
   * 复用 idx_orch_events_instance_created，且只取推导耗时所需字段，避免把体积很大的 nodeState 整包读进内存。
   */
  listNodeStatusTransitions(instanceId: OrchestrationId): OrchNodeStatusTransition[] {
    const rows = this.db
      .prepare(
        `SELECT node_id, created_at, json_extract(payload_json, '$.status') AS status
         FROM orch_events
         WHERE instance_id = ? AND type = 'orchestration.nodeStateChanged'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(String(instanceId)) as any[];
    return rows.map((row) => ({
      nodeId: row.node_id ? String(row.node_id) : "",
      status: row.status === null || row.status === undefined ? "" : String(row.status),
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  append(input: Omit<OrchestrationEventRecord, "id" | "createdAt"> & { createdAt?: number }): OrchestrationEventRecord {
    const id = crypto.randomUUID() as OrchestrationEventId;
    const createdAt = Number(input.createdAt ?? Date.now());
    this.db
      .prepare(
        `INSERT INTO orch_events (id, instance_id, node_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(input.instanceId),
        input.nodeId ? String(input.nodeId) : null,
        String(input.type),
        String(input.payloadJson),
        createdAt,
      );
    return { ...input, id, createdAt };
  }

  deleteByInstance(instanceId: OrchestrationId): number {
    const result = this.db.prepare("DELETE FROM orch_events WHERE instance_id = ?").run(String(instanceId));
    return Number(result.changes ?? 0);
  }
}

/** 将外部 limit 规整为正整数；无效值表示不裁剪。 */
function normalizeListLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function rowToEvent(row: any, options: { includePayload: boolean }): OrchestrationEventRecord {
  const type = String(row.type ?? "");
  const payloadJson = String(row.payload_json ?? "{}");
  return {
    id: row.id as OrchestrationEventId,
    instanceId: row.instance_id as OrchestrationId,
    nodeId: row.node_id ? String(row.node_id) : null,
    type,
    payloadJson: options.includePayload ? payloadJson : summarizeEventPayloadJson(type, payloadJson),
    createdAt: Number(row.created_at ?? 0),
  };
}

/** 为历史事件列表保留 UI 摘要所需字段，去掉 nodeState 等大对象。 */
function summarizeEventPayloadJson(type: string, payloadJson: string): string {
  const payload = parsePayloadJson(payloadJson);
  const summary: Record<string, unknown> = {};
  copyPayloadFields(summary, payload, [
    "instanceId",
    "requirementId",
    "intakeId",
    "nodeId",
    "nodeLabel",
    "status",
    "threadId",
    "artifactId",
    "artifactKind",
    "basedOnVersion",
    "stagingPath",
    "publishedPath",
    "promptSnapshotId",
    "nextAction",
    "source",
    "fromNodeId",
    "fromNodeLabel",
    "targetNodeId",
    "targetNodeLabel",
  ]);
  if (type === "orchestration.error") {
    const error = truncatePayloadText(payload.error, 500);
    if (error) summary.error = error;
  }
  return JSON.stringify(summary);
}

/** 解析事件 payload；损坏数据应显式失败，避免伪造摘要继续返回。 */
function parsePayloadJson(payloadJson: string): Record<string, unknown> {
  const parsed = JSON.parse(payloadJson) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** 复制摘要字段并限制字符串长度，避免路径/错误之外的大文本进入列表。 */
function copyPayloadFields(target: Record<string, unknown>, source: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (typeof value === "string") {
      target[key] = truncatePayloadText(value, 500);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      target[key] = value;
    }
  }
}

function truncatePayloadText(value: unknown, maxLength: number): string | null {
  const text = String(value ?? "");
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

