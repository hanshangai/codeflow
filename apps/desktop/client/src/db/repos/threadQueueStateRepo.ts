import type {
  ThreadId,
  ThreadQueuePauseReason,
  ThreadQueueState,
  TurnId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

type StateRow = {
  thread_id: string;
  workspace_id: string;
  paused: number;
  paused_reason: string | null;
  paused_at: number | null;
  last_consumed_queue_id: string | null;
  last_consumed_turn_id: string | null;
  updated_at: number;
};

/** thread 级队列状态：paused 标记 + 上次消费指针。 */
export class ThreadQueueStateRepo {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly setPausedStmt;
  private readonly setResumedStmt;
  private readonly setLastConsumedStmt;

  constructor(private readonly db: SqliteDb) {
    this.getStmt = this.db.prepare(
      `SELECT thread_id, workspace_id, paused, paused_reason, paused_at,
              last_consumed_queue_id, last_consumed_turn_id, updated_at
         FROM thread_queue_states
        WHERE thread_id = ?`,
    );
    this.upsertStmt = this.db.prepare(
      `INSERT INTO thread_queue_states (
         thread_id, workspace_id, paused, paused_reason, paused_at,
         last_consumed_queue_id, last_consumed_turn_id, updated_at
       ) VALUES (?, ?, 0, NULL, NULL, NULL, NULL, ?)
       ON CONFLICT(thread_id) DO NOTHING`,
    );
    this.setPausedStmt = this.db.prepare(
      `UPDATE thread_queue_states
          SET paused = 1, paused_reason = ?, paused_at = MAX(?, COALESCE(paused_at + 1, 0)), updated_at = ?
        WHERE thread_id = ?`,
    );
    this.setResumedStmt = this.db.prepare(
      `UPDATE thread_queue_states
          SET paused = 0, paused_reason = NULL, updated_at = ?
        WHERE thread_id = ?`,
    );
    this.setLastConsumedStmt = this.db.prepare(
      `UPDATE thread_queue_states
          SET last_consumed_queue_id = ?, last_consumed_turn_id = ?, updated_at = ?
        WHERE thread_id = ?`,
    );
  }

  /** 读取公开状态；未暂停时不暴露保留在库内的历史暂停时间。 */
  getState(threadId: ThreadId): ThreadQueueState {
    const row = this.getStmt.get(String(threadId)) as StateRow | undefined;
    if (!row) {
      return {
        threadId,
        workspaceId: "" as WorkspaceId,
        paused: false,
        pausedReason: null,
        pausedAt: null,
        lastConsumedQueueId: null,
        lastConsumedTurnId: null,
      };
    }
    return {
      threadId: String(row.thread_id) as ThreadId,
      workspaceId: String(row.workspace_id) as WorkspaceId,
      paused: Number(row.paused ?? 0) === 1,
      pausedReason: normalizePauseReason(row.paused_reason),
      pausedAt: Number(row.paused) === 1 && row.paused_at != null ? Number(row.paused_at) : null,
      lastConsumedQueueId: nullableString(row.last_consumed_queue_id),
      lastConsumedTurnId: nullableString(row.last_consumed_turn_id) as TurnId | null,
    };
  }

  /** 暂停并单调更新 pausedAt，避免同毫秒的旧唤醒误认仍拥有新暂停；首次自动建行。 */
  pause(threadId: ThreadId, workspaceId: WorkspaceId, reason: ThreadQueuePauseReason): void {
    const now = Date.now();
    this.upsertStmt.run(String(threadId), String(workspaceId), now);
    this.setPausedStmt.run(String(reason), now, now, String(threadId));
  }

  /** 恢复时保留历史暂停时间，避免再次暂停复用旧唤醒持有的时间值。 */
  resume(threadId: ThreadId, workspaceId: WorkspaceId): void {
    const now = Date.now();
    this.upsertStmt.run(String(threadId), String(workspaceId), now);
    this.setResumedStmt.run(now, String(threadId));
  }

  /** 记录最近消费指针；编排反馈消费没有普通 turn，可保留 lastConsumedTurnId 为空。 */
  setLastConsumed(threadId: ThreadId, workspaceId: WorkspaceId, queueItemId: string, turnId: TurnId | null): void {
    const now = Date.now();
    this.upsertStmt.run(String(threadId), String(workspaceId), now);
    this.setLastConsumedStmt.run(String(queueItemId), nullableString(turnId), now, String(threadId));
  }
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** 规范化 DB 暂停原因；未知值保持为空，避免前端误导性展示。 */
function normalizePauseReason(s: unknown): ThreadQueuePauseReason | null {
  const v = String(s ?? "").trim();
  if (
    v === "user_pause" ||
    v === "user_stop" ||
    v === "turn_error" ||
    v === "send_failed" ||
    v === "session_invalidated" ||
    v === "rollback" ||
    v === "transient_cleanup"
  ) {
    return v;
  }
  return null;
}
