import crypto from "node:crypto";

import type { FeedbackRecord, FeedbackRecordId, OrchestrationId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 编排人工反馈仓储。 */
export class OrchFeedbackRepo {
  constructor(private readonly db: SqliteDb) {}

  listByInstance(instanceId: OrchestrationId): FeedbackRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, node_id, action, payload_json, created_at
         FROM orch_feedback_records WHERE instance_id = ? ORDER BY created_at ASC`,
      )
      .all(String(instanceId)) as any[];
    return rows.map(rowToFeedbackRecord);
  }

  get(id: FeedbackRecordId): FeedbackRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, instance_id, node_id, action, payload_json, created_at
         FROM orch_feedback_records WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    if (!row) return null;
    return rowToFeedbackRecord(row);
  }

  create(input: Omit<FeedbackRecord, "id">): FeedbackRecord {
    const id = crypto.randomUUID() as FeedbackRecordId;
    const record: FeedbackRecord = { ...input, id };
    this.db
      .prepare(
        `INSERT INTO orch_feedback_records (id, instance_id, node_id, action, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(record.instanceId),
        String(record.nodeId),
        String(record.action),
        JSON.stringify(record),
        Number(record.createdAt ?? Date.now()),
      );
    return record;
  }

  deleteByInstance(instanceId: OrchestrationId): number {
    const result = this.db.prepare("DELETE FROM orch_feedback_records WHERE instance_id = ?").run(String(instanceId));
    return Number(result.changes ?? 0);
  }
}

function rowToFeedbackRecord(row: any): FeedbackRecord {
  const parsed = safeParseJson<FeedbackRecord | null>(row.payload_json, null);
  if (parsed && typeof parsed === "object") {
    return {
      ...parsed,
      id: row.id as FeedbackRecordId,
      createdAt: Number(row.created_at ?? parsed.createdAt ?? 0),
    };
  }
  return {
    id: row.id as FeedbackRecordId,
    instanceId: row.instance_id as OrchestrationId,
    nodeId: String(row.node_id ?? ""),
    action: row.action as FeedbackRecord["action"],
    createdAt: Number(row.created_at ?? 0),
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

