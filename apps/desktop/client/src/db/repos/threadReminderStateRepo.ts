import type { TurnId, WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type ThreadReminderAttentionKind = "approval" | "user_input" | "error";
export type ThreadReminderTerminalStatus = "completed" | "error" | "interrupted" | "transient_cleanup";

export type ThreadReminderStateRecord = {
  threadId: string;
  workspaceId: WorkspaceId;
  attentionKind: ThreadReminderAttentionKind | null;
  attentionRequestId: string | null;
  latestCompletedTurnId: TurnId | null;
  latestCompletedAt: number | null;
  latestCompletedStatus: ThreadReminderTerminalStatus | null;
  updatedAt: number;
};

export class ThreadReminderStateRepo {
  constructor(private readonly db: SqliteDb) {}

  get(threadId: string): ThreadReminderStateRecord | null {
    const row = this.db
      .prepare(
        [
          "SELECT thread_id, workspace_id, attention_kind, attention_request_id,",
          "       latest_completed_turn_id, latest_completed_at, latest_completed_status, updated_at",
          "FROM thread_reminder_states",
          "WHERE thread_id = ?",
        ].join("\n"),
      )
      .get(String(threadId)) as ReminderStateRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByWorkspace(workspaceId: WorkspaceId): ThreadReminderStateRecord[] {
    const rows = this.db
      .prepare(
        [
          "SELECT thread_id, workspace_id, attention_kind, attention_request_id,",
          "       latest_completed_turn_id, latest_completed_at, latest_completed_status, updated_at",
          "FROM thread_reminder_states",
          "WHERE workspace_id = ?",
          "ORDER BY updated_at DESC, thread_id DESC",
        ].join("\n"),
      )
      .all(String(workspaceId)) as ReminderStateRow[];
    return rows.map(rowToRecord);
  }

  setAttention(input: {
    threadId: string;
    workspaceId: WorkspaceId;
    attentionKind: ThreadReminderAttentionKind;
    attentionRequestId?: string | null;
    updatedAt?: number;
  }): void {
    const now = Number(input.updatedAt ?? Date.now());
    const attentionRequestId = String(input.attentionRequestId ?? "").trim() || null;
    this.db
      .prepare(
        [
          "INSERT INTO thread_reminder_states (",
          "  thread_id, workspace_id, attention_kind, attention_request_id,",
          "  latest_completed_turn_id, latest_completed_at, latest_completed_status, updated_at",
          ") VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)",
          "ON CONFLICT(thread_id) DO UPDATE SET",
          "  workspace_id = excluded.workspace_id,",
          "  attention_kind = excluded.attention_kind,",
          "  attention_request_id = excluded.attention_request_id,",
          "  updated_at = excluded.updated_at",
        ].join("\n"),
      )
      .run(
        String(input.threadId),
        String(input.workspaceId),
        String(input.attentionKind),
        attentionRequestId,
        now,
      );
  }

  clearAttention(threadId: string, opts?: { attentionKind?: ThreadReminderAttentionKind | null; requestId?: string | null; updatedAt?: number }): void {
    const current = this.get(threadId);
    if (!current) return;
    const expectedKind = opts?.attentionKind ?? null;
    const expectedRequestId = String(opts?.requestId ?? "").trim() || null;
    if (expectedKind && current.attentionKind !== expectedKind) return;
    if (expectedRequestId && current.attentionRequestId !== expectedRequestId) return;
    const now = Number(opts?.updatedAt ?? Date.now());
    this.db
      .prepare(
        [
          "UPDATE thread_reminder_states",
          "SET attention_kind = NULL, attention_request_id = NULL, updated_at = ?",
          "WHERE thread_id = ?",
        ].join("\n"),
      )
      .run(now, String(threadId));
  }

  recordTurnCompleted(input: {
    threadId: string;
    workspaceId: WorkspaceId;
    turnId: TurnId;
    completedAt?: number;
  }): void {
    const now = Number(input.completedAt ?? Date.now());
    this.db
      .prepare(
        [
          "INSERT INTO thread_reminder_states (",
          "  thread_id, workspace_id, attention_kind, attention_request_id,",
          "  latest_completed_turn_id, latest_completed_at, latest_completed_status, updated_at",
          ") VALUES (?, ?, NULL, NULL, ?, ?, 'completed', ?)",
          "ON CONFLICT(thread_id) DO UPDATE SET",
          "  workspace_id = excluded.workspace_id,",
          "  attention_kind = NULL,",
          "  attention_request_id = NULL,",
          "  latest_completed_turn_id = excluded.latest_completed_turn_id,",
          "  latest_completed_at = excluded.latest_completed_at,",
          "  latest_completed_status = excluded.latest_completed_status,",
          "  updated_at = excluded.updated_at",
        ].join("\n"),
      )
      .run(
        String(input.threadId),
        String(input.workspaceId),
        String(input.turnId),
        now,
        now,
      );
  }

  recordTurnError(input: {
    threadId: string;
    workspaceId: WorkspaceId;
    turnId: TurnId;
    endedAt?: number;
  }): void {
    this.recordTerminalState({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      attentionKind: "error",
      terminalStatus: "error",
      updatedAt: input.endedAt,
    });
  }

  recordTurnInterrupted(input: {
    threadId: string;
    workspaceId: WorkspaceId;
    turnId: TurnId;
    endedAt?: number;
  }): void {
    this.recordTerminalState({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      attentionKind: null,
      terminalStatus: "interrupted",
      updatedAt: input.endedAt,
    });
  }

  recordTurnTransientCleanup(input: {
    threadId: string;
    workspaceId: WorkspaceId;
    turnId: TurnId;
    endedAt?: number;
  }): void {
    this.recordTerminalState({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      attentionKind: null,
      terminalStatus: "transient_cleanup",
      updatedAt: input.endedAt,
    });
  }

  private recordTerminalState(input: {
    threadId: string;
    workspaceId: WorkspaceId;
    attentionKind: ThreadReminderAttentionKind | null;
    terminalStatus: ThreadReminderTerminalStatus;
    updatedAt?: number;
  }): void {
    const now = Number(input.updatedAt ?? Date.now());
    this.db
      .prepare(
        [
          "INSERT INTO thread_reminder_states (",
          "  thread_id, workspace_id, attention_kind, attention_request_id,",
          "  latest_completed_turn_id, latest_completed_at, latest_completed_status, updated_at",
          ") VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)",
          "ON CONFLICT(thread_id) DO UPDATE SET",
          "  workspace_id = excluded.workspace_id,",
          "  attention_kind = excluded.attention_kind,",
          "  attention_request_id = NULL,",
          "  latest_completed_turn_id = NULL,",
          "  latest_completed_at = NULL,",
          "  latest_completed_status = excluded.latest_completed_status,",
          "  updated_at = excluded.updated_at",
        ].join("\n"),
      )
      .run(
        String(input.threadId),
        String(input.workspaceId),
        input.attentionKind,
        String(input.terminalStatus),
        now,
      );
  }
}

type ReminderStateRow = {
  thread_id: string;
  workspace_id: string;
  attention_kind: ThreadReminderAttentionKind | null;
  attention_request_id: string | null;
  latest_completed_turn_id: string | null;
  latest_completed_at: number | null;
  latest_completed_status: ThreadReminderTerminalStatus | null;
  updated_at: number;
};

function rowToRecord(row: ReminderStateRow): ThreadReminderStateRecord {
  return {
    threadId: String(row.thread_id),
    workspaceId: row.workspace_id as WorkspaceId,
    attentionKind: row.attention_kind ?? null,
    attentionRequestId: row.attention_request_id == null ? null : String(row.attention_request_id),
    latestCompletedTurnId: row.latest_completed_turn_id ? (String(row.latest_completed_turn_id) as TurnId) : null,
    latestCompletedAt: row.latest_completed_at == null ? null : Number(row.latest_completed_at),
    latestCompletedStatus: row.latest_completed_status ?? null,
    updatedAt: Number(row.updated_at ?? 0),
  };
}
