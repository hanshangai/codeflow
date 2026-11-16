import type { WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type ReminderIgnoreRecord = {
  workspaceId: WorkspaceId;
  reminderId: string;
  marker: string;
  ignoredAt: number;
  updatedAt: number;
};

export class ReminderIgnoreRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 一次读取指定工作区的忽略标记，供提醒聚合避免逐项查询。 */
  listByWorkspace(workspaceId: WorkspaceId): ReminderIgnoreRecord[] {
    const rows = this.db.prepare(
      "SELECT workspace_id, reminder_id, marker, ignored_at, updated_at FROM reminder_ignores WHERE workspace_id = ?",
    ).all(String(workspaceId)) as Array<{
      workspace_id: string; reminder_id: string; marker: string; ignored_at: number; updated_at: number;
    }>;
    return rows.map(row => ({ workspaceId: row.workspace_id as WorkspaceId, reminderId: String(row.reminder_id),
      marker: String(row.marker), ignoredAt: Number(row.ignored_at), updatedAt: Number(row.updated_at) }));
  }

  get(workspaceId: WorkspaceId, reminderId: string): ReminderIgnoreRecord | null {
    const row = this.db
      .prepare(
        [
          "SELECT workspace_id, reminder_id, marker, ignored_at, updated_at",
          "FROM reminder_ignores",
          "WHERE workspace_id = ? AND reminder_id = ?",
        ].join("\n"),
      )
      .get(String(workspaceId), String(reminderId)) as
      | {
          workspace_id: string;
          reminder_id: string;
          marker: string;
          ignored_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      workspaceId: row.workspace_id as WorkspaceId,
      reminderId: String(row.reminder_id),
      marker: String(row.marker),
      ignoredAt: Number(row.ignored_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  upsert(input: {
    workspaceId: WorkspaceId;
    reminderId: string;
    marker: string;
    ignoredAt?: number;
  }): ReminderIgnoreRecord {
    const now = Number(input.ignoredAt ?? Date.now());
    const marker = String(input.marker ?? "").trim();
    if (!marker) throw new Error("Reminder ignore marker is required");
    this.db
      .prepare(
        [
          "INSERT INTO reminder_ignores (workspace_id, reminder_id, marker, ignored_at, updated_at)",
          "VALUES (?, ?, ?, ?, ?)",
          "ON CONFLICT(workspace_id, reminder_id) DO UPDATE SET",
          "  marker = excluded.marker,",
          "  ignored_at = excluded.ignored_at,",
          "  updated_at = excluded.updated_at",
        ].join("\n"),
      )
      .run(
        String(input.workspaceId),
        String(input.reminderId),
        marker,
        now,
        now,
      );
    return {
      workspaceId: input.workspaceId,
      reminderId: String(input.reminderId),
      marker,
      ignoredAt: now,
      updatedAt: now,
    };
  }
}
