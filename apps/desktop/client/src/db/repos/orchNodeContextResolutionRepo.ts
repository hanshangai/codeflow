import crypto from "node:crypto";

import type { NodeContextResolutionRecord, OrchestrationId, ResolvedNodeContext } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 节点输入解析快照仓储。 */
export class OrchNodeContextResolutionRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 创建一次节点上下文解析记录，包含失败时的诊断快照。 */
  create(input: Omit<NodeContextResolutionRecord, "id" | "createdAt">): NodeContextResolutionRecord {
    const record: NodeContextResolutionRecord = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO orch_node_context_resolutions (
          id, instance_id, node_id, attempt_no, status, context_json, error_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        String(record.instanceId),
        String(record.nodeId),
        Number(record.attemptNo),
        String(record.status),
        JSON.stringify(record.context),
        record.error ? JSON.stringify(record.error) : null,
        record.createdAt,
      );
    return record;
  }

  /** 查询某节点最近一次输入解析记录。 */
  getLatest(instanceId: OrchestrationId, nodeId: string): NodeContextResolutionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, instance_id, node_id, attempt_no, status, context_json, error_json, created_at
         FROM orch_node_context_resolutions
         WHERE instance_id = ? AND node_id = ?
         ORDER BY attempt_no DESC, created_at DESC
         LIMIT 1`,
      )
      .get(String(instanceId), String(nodeId)) as any | undefined;
    return row ? rowToContextResolution(row) : null;
  }

  /** 查询某节点的输入解析历史。 */
  listByNode(instanceId: OrchestrationId, nodeId: string): NodeContextResolutionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, node_id, attempt_no, status, context_json, error_json, created_at
         FROM orch_node_context_resolutions
         WHERE instance_id = ? AND node_id = ?
         ORDER BY attempt_no ASC, created_at ASC`,
      )
      .all(String(instanceId), String(nodeId)) as any[];
    return rows.map(rowToContextResolution);
  }
}

function rowToContextResolution(row: any): NodeContextResolutionRecord {
  const context = safeParseJson<ResolvedNodeContext>(row.context_json, {
    schemaVersion: "node-context/v1",
    contextId: String(row.id ?? ""),
    instanceId: String(row.instance_id ?? "") as OrchestrationId,
    nodeId: String(row.node_id ?? ""),
    attemptNo: Number(row.attempt_no ?? 1),
    status: String(row.status ?? "invalid") as ResolvedNodeContext["status"],
    createdAt: Number(row.created_at ?? 0),
    task: { title: "", titlePathSegment: "", goal: "" },
    inputs: [],
    upstreamResults: [],
  });
  return {
    id: String(row.id ?? ""),
    instanceId: String(row.instance_id ?? "") as OrchestrationId,
    nodeId: String(row.node_id ?? ""),
    attemptNo: Number(row.attempt_no ?? context.attemptNo ?? 1),
    status: String(row.status ?? context.status ?? "invalid") as ResolvedNodeContext["status"],
    context,
    error: safeParseJson<ResolvedNodeContext["error"]>(row.error_json, context.error ?? null),
    createdAt: Number(row.created_at ?? context.createdAt ?? 0),
  };
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  return JSON.parse(raw) as T;
}
