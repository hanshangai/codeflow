import type { WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type ReminderReceiptEntityType = "thread" | "orch_instance";

export type ReminderReceiptRecord = {
  entityType: ReminderReceiptEntityType;
  workspaceId: WorkspaceId;
  entityId: string;
  marker: string | null;
  readAt: number;
  updatedAt: number;
};

export class ReminderReceiptRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 一次读取指定工作区的已读标记，供提醒聚合避免逐项查询。 */
  listByWorkspace(workspaceId: WorkspaceId): ReminderReceiptRecord[] {
    const rows = this.db.prepare(
      "SELECT entity_type, workspace_id, entity_id, marker, read_at, updated_at FROM reminder_receipts WHERE workspace_id = ?",
    ).all(String(workspaceId)) as Array<{
      entity_type: ReminderReceiptEntityType; workspace_id: string; entity_id: string;
      marker: string | null; read_at: number; updated_at: number;
    }>;
    return rows.map(row => ({ entityType: row.entity_type, workspaceId: row.workspace_id as WorkspaceId,
      entityId: String(row.entity_id), marker: row.marker == null ? null : String(row.marker),
      readAt: Number(row.read_at), updatedAt: Number(row.updated_at) }));
  }

  get(entityType: ReminderReceiptEntityType, workspaceId: WorkspaceId, entityId: string): ReminderReceiptRecord | null {
    const row = this.db
      .prepare(
        [
          "SELECT entity_type, workspace_id, entity_id, marker, read_at, updated_at",
          "FROM reminder_receipts",
          "WHERE entity_type = ? AND workspace_id = ? AND entity_id = ?",
        ].join("\n"),
      )
      .get(String(entityType), String(workspaceId), String(entityId)) as
      | {
          entity_type: ReminderReceiptEntityType;
          workspace_id: string;
          entity_id: string;
          marker: string | null;
          read_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      entityType: row.entity_type,
      workspaceId: row.workspace_id as WorkspaceId,
      entityId: String(row.entity_id),
      marker: row.marker == null ? null : String(row.marker),
      readAt: Number(row.read_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  upsert(input: {
    entityType: ReminderReceiptEntityType;
    workspaceId: WorkspaceId;
    entityId: string;
    marker?: string | null;
    readAt?: number;
  }): ReminderReceiptRecord {
    const now = Number(input.readAt ?? Date.now());
    const marker = String(input.marker ?? "").trim() || null;
    this.db
      .prepare(
        [
          "INSERT INTO reminder_receipts (entity_type, workspace_id, entity_id, marker, read_at, updated_at)",
          "VALUES (?, ?, ?, ?, ?, ?)",
          "ON CONFLICT(entity_type, workspace_id, entity_id) DO UPDATE SET",
          "  marker = excluded.marker,",
          "  read_at = excluded.read_at,",
          "  updated_at = excluded.updated_at",
        ].join("\n"),
      )
      .run(
        String(input.entityType),
        String(input.workspaceId),
        String(input.entityId),
        marker,
        now,
        now,
      );
    return {
      entityType: input.entityType,
      workspaceId: input.workspaceId,
      entityId: String(input.entityId),
      marker,
      readAt: now,
      updatedAt: now,
    };
  }
}
