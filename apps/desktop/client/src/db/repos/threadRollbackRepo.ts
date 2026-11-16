import type { ThreadId, TurnId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type ThreadRollbackResult = "pending" | "success" | "failed" | "partial";

export type ThreadRollbackRecord = {
  id: number;
  threadId: ThreadId;
  toTurnId: TurnId;
  droppedTurnCount: number;
  droppedEventSeqGt: number;
  createdAt: number;
  result: ThreadRollbackResult;
  error: string | null;
};

/** 回滚记录仓储：用于排障/审计（本地）。 */
export class ThreadRollbackRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 写入一条回滚记录。 */
  insert(input: Omit<ThreadRollbackRecord, "id">): number {
    const result = normalizeRollbackResult(input.result);
    const res = this.db
      .prepare(
        [
          "INSERT INTO thread_rollbacks (thread_id, to_turn_id, dropped_turn_count, dropped_event_seq_gt, created_at, result, error)",
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"),
      )
      .run(
        String(input.threadId),
        String(input.toTurnId),
        Number(input.droppedTurnCount ?? 0),
        Number(input.droppedEventSeqGt ?? 0),
        Number(input.createdAt ?? Date.now()),
        result,
        input.error ?? null,
      );
    return Number(res.lastInsertRowid ?? 0);
  }

  /** 按审计行 id 更新回滚结果；行不存在时显式失败。 */
  updateResult(id: number, input: { result: ThreadRollbackResult; error: string | null }): void {
    const rollbackId = Number(id);
    if (!Number.isSafeInteger(rollbackId) || rollbackId <= 0) throw new Error(`Invalid rollback id: ${id}`);
    const result = normalizeRollbackResult(input.result);
    const updated = this.db
      .prepare("UPDATE thread_rollbacks SET result = ?, error = ? WHERE id = ?")
      .run(result, input.error ?? null, rollbackId);
    if (Number(updated.changes ?? 0) !== 1) throw new Error(`Rollback record not found: ${rollbackId}`);
  }

  /** 列出某 thread 的回滚记录（最新在前）。 */
  listByThread(threadId: ThreadId, opts?: { limit?: number | null }): ThreadRollbackRecord[] {
    const limit = Math.max(1, Math.min(200, Number(opts?.limit ?? 50)));
    const rows = this.db
      .prepare(
        [
          "SELECT id, thread_id, to_turn_id, dropped_turn_count, dropped_event_seq_gt, created_at, result, error",
          "FROM thread_rollbacks WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
        ].join("\n"),
      )
      .all(String(threadId), limit) as any[];
    return rows.map((r) => ({
      id: Number(r.id ?? 0),
      threadId: String(r.thread_id ?? "") as ThreadId,
      toTurnId: String(r.to_turn_id ?? "") as TurnId,
      droppedTurnCount: Number(r.dropped_turn_count ?? 0),
      droppedEventSeqGt: Number(r.dropped_event_seq_gt ?? 0),
      createdAt: Number(r.created_at ?? 0),
      result: normalizeRollbackResult(r.result),
      error: r.error == null ? null : String(r.error),
    }));
  }

  /** 返回最近一条未完成或结果不确定的回滚，供后续 mutation 门禁使用。 */
  findLatestUnresolvedByThread(threadId: ThreadId): ThreadRollbackRecord | null {
    const row = this.db
      .prepare(
        [
          "SELECT id, thread_id, to_turn_id, dropped_turn_count, dropped_event_seq_gt, created_at, result, error",
          "FROM thread_rollbacks WHERE thread_id = ? AND result IN ('pending', 'partial')",
          "ORDER BY created_at DESC, id DESC LIMIT 1",
        ].join("\n"),
      )
      .get(String(threadId)) as any;
    if (!row) return null;
    return {
      id: Number(row.id ?? 0),
      threadId: String(row.thread_id ?? "") as ThreadId,
      toTurnId: String(row.to_turn_id ?? "") as TurnId,
      droppedTurnCount: Number(row.dropped_turn_count ?? 0),
      droppedEventSeqGt: Number(row.dropped_event_seq_gt ?? 0),
      createdAt: Number(row.created_at ?? 0),
      result: normalizeRollbackResult(row.result),
      error: row.error == null ? null : String(row.error),
    };
  }
}

/** 校验持久化回滚状态，避免未知值被当成已完成。 */
function normalizeRollbackResult(value: unknown): ThreadRollbackResult {
  if (value === "pending" || value === "success" || value === "failed" || value === "partial") return value;
  throw new Error(`Invalid rollback result: ${String(value ?? "")}`);
}


