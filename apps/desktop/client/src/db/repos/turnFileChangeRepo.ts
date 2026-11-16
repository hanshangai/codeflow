import type { ThreadId, TurnId } from "@codeflowai/shared";

import type { FileBlobRepo } from "./fileBlobRepo.js";
import type { SqliteDb } from "../sqliteTypes.js";

export type FileChangeOp = "create" | "modify" | "delete";

export type TurnFileChangeRecord = {
  id: number;
  threadId: ThreadId;
  turnId: TurnId;
  path: string;
  op: FileChangeOp;
  beforeBlobId: string | null;
  afterBlobId: string | null;
  beforeExists: boolean;
  afterExists: boolean;
  diffText: string | null;
  capturedAt: number;
  stepKey: string | null;
};

export type AggregatedThreadFileChange = {
  path: string;
  status: "created" | "modified" | "deleted";
  /** 基线快照：会话第一次触碰该文件时的状态。 */
  baseBeforeExists: boolean;
  baseBeforeBlobId: string | null;
  /** 当前快照：会话最后一次触碰该文件后的状态。 */
  currentAfterExists: boolean;
  currentAfterBlobId: string | null;
  lastTurnId: TurnId;
  lastChangedAt: number;
  stepKey: string | null;
  /** 已接受的 blob id（用户点击"接受"后记录的 afterBlobId；未接受为 null）。 */
  acceptedBlobId: string | null;
  /** 当前快照是否已被接受（acceptedBlobId 与 currentAfterBlobId 相同时为 true）。 */
  isAccepted: boolean;
};

/** turn 文件变更仓储：一条记录对应“某 turn 对某文件的最终 before/after”。 */
export class TurnFileChangeRepo {
  constructor(
    private readonly db: SqliteDb,
    /** 可选：注入后 deleteByThread / deleteAfterTurnEndSeq 等会顺手对释放出来的 blob 做引用计数 GC。 */
    private readonly blobs?: FileBlobRepo,
  ) {}

  /** 收集某 thread 全部 blob_id（before/after/accepted），用于删除前快照引用。 */
  private collectBlobIdsByThread(threadId: ThreadId): string[] {
    const rows = this.db
      .prepare(
        "SELECT before_blob_id, after_blob_id, accepted_blob_id FROM turn_file_changes WHERE thread_id = ?",
      )
      .all(String(threadId)) as Array<{ before_blob_id: string | null; after_blob_id: string | null; accepted_blob_id: string | null }>;
    const ids: string[] = [];
    for (const row of rows) {
      if (row.before_blob_id) ids.push(String(row.before_blob_id));
      if (row.after_blob_id) ids.push(String(row.after_blob_id));
      if (row.accepted_blob_id) ids.push(String(row.accepted_blob_id));
    }
    return ids;
  }

  /** 收集某 thread 在某 endSeq 之后的全部 blob_id，用于 rollback 删前 GC。 */
  private collectBlobIdsAfterEndSeq(threadId: ThreadId, endSeqInclusive: number): string[] {
    const rows = this.db
      .prepare(
        [
          "SELECT before_blob_id, after_blob_id, accepted_blob_id",
          "  FROM turn_file_changes",
          " WHERE thread_id = ? AND turn_id IN (",
          "   SELECT turn_id FROM thread_turns WHERE thread_id = ? AND end_event_seq IS NOT NULL AND end_event_seq > ?",
          " )",
        ].join("\n"),
      )
      .all(String(threadId), String(threadId), Number(endSeqInclusive)) as Array<{
        before_blob_id: string | null;
        after_blob_id: string | null;
        accepted_blob_id: string | null;
      }>;
    const ids: string[] = [];
    for (const row of rows) {
      if (row.before_blob_id) ids.push(String(row.before_blob_id));
      if (row.after_blob_id) ids.push(String(row.after_blob_id));
      if (row.accepted_blob_id) ids.push(String(row.accepted_blob_id));
    }
    return ids;
  }

  /** 获取某 turn+path 的变更记录（不存在返回 null）。 */
  get(threadId: ThreadId, turnId: TurnId, filePath: string): TurnFileChangeRecord | null {
    const row = this.db
      .prepare(
        [
          "SELECT id, thread_id, turn_id, path, op, before_blob_id, after_blob_id, before_exists, after_exists, diff_text, captured_at, step_key",
          "FROM turn_file_changes WHERE thread_id = ? AND turn_id = ? AND path = ?",
        ].join("\n"),
      )
      .get(String(threadId), String(turnId), String(filePath)) as
      | {
          id: number;
          thread_id: string;
          turn_id: string;
          path: string;
          op: string;
          before_blob_id: string | null;
          after_blob_id: string | null;
          before_exists: number;
          after_exists: number;
          diff_text: string | null;
          captured_at: number;
          step_key: string | null;
        }
      | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  /** 首次写入 before（同 turn 同 path 仅首个有效）。 */
  captureBefore(input: {
    threadId: ThreadId;
    turnId: TurnId;
    path: string;
    beforeExists: boolean;
    beforeBlobId: string | null;
    capturedAt: number;
    stepKey?: string | null;
  }): void {
    const existing = this.get(input.threadId, input.turnId, input.path);
    if (!existing) {
      const op: FileChangeOp = input.beforeExists ? "modify" : "create";
      this.db
        .prepare(
          [
            "INSERT INTO turn_file_changes (thread_id, turn_id, path, op, before_blob_id, after_blob_id, before_exists, after_exists, diff_text, captured_at, step_key)",
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
          ].join("\n"),
        )
        .run(
          String(input.threadId),
          String(input.turnId),
          String(input.path),
          op,
          input.beforeBlobId,
          input.beforeBlobId,
          input.beforeExists ? 1 : 0,
          input.beforeExists ? 1 : 0,
          Number(input.capturedAt ?? Date.now()),
          input.stepKey ?? null,
        );
      return;
    }

    // 若此前 beforeExists=1 但缺 blobId，允许补齐一次。
    if (existing.beforeExists && !existing.beforeBlobId && input.beforeBlobId) {
      this.db
        .prepare("UPDATE turn_file_changes SET before_blob_id = ? WHERE id = ?")
        .run(String(input.beforeBlobId), Number(existing.id));
    }
  }

  /** 写入 after（每次完成都覆盖 after；op 由 before/after 推导）。 */
  captureAfter(input: {
    threadId: ThreadId;
    turnId: TurnId;
    path: string;
    afterExists: boolean;
    afterBlobId: string | null;
    diffText?: string | null;
    capturedAt: number;
    stepKey?: string | null;
  }): void {
    const existing = this.get(input.threadId, input.turnId, input.path);
    if (!existing) {
      const beforeExists = input.afterExists;
      const op: FileChangeOp = beforeExists ? "modify" : "delete";
      this.db
        .prepare(
          [
            "INSERT INTO turn_file_changes (thread_id, turn_id, path, op, before_blob_id, after_blob_id, before_exists, after_exists, diff_text, captured_at, step_key)",
            "VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
          ].join("\n"),
        )
        .run(
          String(input.threadId),
          String(input.turnId),
          String(input.path),
          op,
          input.afterBlobId,
          beforeExists ? 1 : 0,
          input.afterExists ? 1 : 0,
          input.diffText ?? null,
          Number(input.capturedAt ?? Date.now()),
          input.stepKey ?? null,
        );
      return;
    }

    const op: FileChangeOp = computeOp(existing.beforeExists, input.afterExists);
    this.db
      .prepare("UPDATE turn_file_changes SET op = ?, after_blob_id = ?, after_exists = ?, diff_text = COALESCE(?, diff_text), captured_at = ?, step_key = COALESCE(?, step_key) WHERE id = ?")
      .run(
        op,
        input.afterBlobId,
        input.afterExists ? 1 : 0,
        input.diffText ?? null,
        Number(input.capturedAt ?? Date.now()),
        input.stepKey ?? null,
        Number(existing.id),
      );
  }

  /** 列出某 turn 的文件变更（按 id 升序）。 */
  listByThreadAndTurn(threadId: ThreadId, turnId: TurnId): TurnFileChangeRecord[] {
    const rows = this.db
      .prepare(
        [
          "SELECT id, thread_id, turn_id, path, op, before_blob_id, after_blob_id, before_exists, after_exists, diff_text, captured_at, step_key",
          "FROM turn_file_changes WHERE thread_id = ? AND turn_id = ? ORDER BY id ASC",
        ].join("\n"),
      )
      .all(String(threadId), String(turnId)) as any[];
    return rows.map(mapRow);
  }

  /** 列出某 thread 的全部文件变更（按 id 升序）。 */
  listByThread(threadId: ThreadId): TurnFileChangeRecord[] {
    const rows = this.db
      .prepare(
        [
          "SELECT id, thread_id, turn_id, path, op, before_blob_id, after_blob_id, before_exists, after_exists, diff_text, captured_at, step_key",
          "FROM turn_file_changes WHERE thread_id = ? ORDER BY id ASC",
        ].join("\n"),
      )
      .all(String(threadId)) as any[];
    return rows.map(mapRow);
  }

  /** 列出某 thread 中指定 path 的全部变更（按 id 升序）。 */
  listByThreadAndPath(threadId: ThreadId, filePath: string): TurnFileChangeRecord[] {
    const rows = this.db
      .prepare(
        [
          "SELECT id, thread_id, turn_id, path, op, before_blob_id, after_blob_id, before_exists, after_exists, diff_text, captured_at, step_key",
          "FROM turn_file_changes WHERE thread_id = ? AND path = ? ORDER BY id ASC",
        ].join("\n"),
      )
      .all(String(threadId), String(filePath)) as any[];
    return rows.map(mapRow);
  }

  /** 聚合 thread 的文件变更（按 path 聚合基线与当前状态）。 */
  listAggregatedByThread(threadId: ThreadId): AggregatedThreadFileChange[] {
    const rows = this.db
      .prepare(
        [
          "SELECT agg.path AS path,",
          "  first.before_exists AS baseBeforeExists, first.before_blob_id AS baseBeforeBlobId,",
          "  last.after_exists AS currentAfterExists, last.after_blob_id AS currentAfterBlobId,",
          "  last.turn_id AS lastTurnId, last.captured_at AS lastChangedAt,",
          "  last.step_key AS stepKey,",
          "  acc.accepted_blob_id AS acceptedBlobId",
          "FROM (",
          "  SELECT path, MIN(id) AS firstId, MAX(id) AS lastId",
          "  FROM turn_file_changes WHERE thread_id = ?",
          "  GROUP BY path",
          ") agg",
          "JOIN turn_file_changes first ON first.id = agg.firstId",
          "JOIN turn_file_changes last ON last.id = agg.lastId",
          "LEFT JOIN (",
          "  SELECT path, accepted_blob_id FROM turn_file_changes",
          "  WHERE thread_id = ? AND accepted_blob_id IS NOT NULL",
          "  GROUP BY path HAVING id = MAX(id)",
          ") acc ON acc.path = agg.path",
          "ORDER BY last.captured_at DESC",
        ].join("\n"),
      )
      .all(String(threadId), String(threadId)) as Array<{
      path: string;
      baseBeforeExists: number;
      baseBeforeBlobId: string | null;
      currentAfterExists: number;
      currentAfterBlobId: string | null;
      lastTurnId: string;
      lastChangedAt: number;
      stepKey: string | null;
      acceptedBlobId: string | null;
    }>;

    const out: AggregatedThreadFileChange[] = [];
    for (const r of rows) {
      const baseBeforeExists = Boolean(r.baseBeforeExists ?? 0);
      const currentAfterExists = Boolean(r.currentAfterExists ?? 0);
      const baseBeforeBlobId = r.baseBeforeBlobId ? String(r.baseBeforeBlobId) : null;
      const currentAfterBlobId = r.currentAfterBlobId ? String(r.currentAfterBlobId) : null;
      const acceptedBlobId = r.acceptedBlobId ? String(r.acceptedBlobId) : null;

      const status = computeStatus(baseBeforeExists, baseBeforeBlobId, currentAfterExists, currentAfterBlobId);
      if (!status) continue; // 无净变更

      out.push({
        path: String(r.path ?? ""),
        status,
        baseBeforeExists,
        baseBeforeBlobId,
        currentAfterExists,
        currentAfterBlobId,
        lastTurnId: String(r.lastTurnId ?? "") as TurnId,
        lastChangedAt: Number(r.lastChangedAt ?? 0),
        stepKey: r.stepKey == null ? null : String(r.stepKey),
        acceptedBlobId,
        isAccepted: acceptedBlobId != null && acceptedBlobId === currentAfterBlobId,
      });
    }
    return out;
  }

  /** 接受某 thread+path 的文件变更：将最新行的 accepted_blob_id 设为当前 after_blob_id。 */
  acceptFileChange(threadId: ThreadId, filePath: string): { accepted: boolean; acceptedBlobId: string | null } {
    const row = this.db
      .prepare(
        [
          "SELECT id, after_blob_id FROM turn_file_changes",
          "WHERE thread_id = ? AND path = ? ORDER BY id DESC LIMIT 1",
        ].join("\n"),
      )
      .get(String(threadId), String(filePath)) as { id: number; after_blob_id: string | null } | undefined;
    if (!row) return { accepted: false, acceptedBlobId: null };
    const blobId = row.after_blob_id ? String(row.after_blob_id) : null;
    this.db
      .prepare("UPDATE turn_file_changes SET accepted_blob_id = ? WHERE id = ?")
      .run(blobId, Number(row.id));
    return { accepted: true, acceptedBlobId: blobId };
  }

  /** 获取某 thread+path 的最新 accepted_blob_id（未接受返回 null）。 */
  getAcceptedBlobId(threadId: ThreadId, filePath: string): string | null {
    const row = this.db
      .prepare(
        [
          "SELECT accepted_blob_id FROM turn_file_changes",
          "WHERE thread_id = ? AND path = ? AND accepted_blob_id IS NOT NULL",
          "ORDER BY id DESC LIMIT 1",
        ].join("\n"),
      )
      .get(String(threadId), String(filePath)) as { accepted_blob_id: string | null } | undefined;
    if (!row || !row.accepted_blob_id) return null;
    return String(row.accepted_blob_id);
  }

  /** 删除某 thread 的所有文件变更（同时对释放的 blob 做引用计数 GC）。 */
  deleteByThread(threadId: ThreadId): number {
    const blobIds = this.blobs ? this.collectBlobIdsByThread(threadId) : [];
    const res = this.db.prepare("DELETE FROM turn_file_changes WHERE thread_id = ?").run(String(threadId));
    const changes = Number(res.changes ?? 0);
    if (changes > 0 && this.blobs && blobIds.length > 0) this.blobs.tryDeleteIfUnreferencedMany(blobIds);
    return changes;
  }

  /** 删除某 thread 中指定 path 的所有文件变更（GC 未做：用得少且需要补 SELECT）。 */
  deleteByThreadAndPath(threadId: ThreadId, filePath: string): number {
    const blobIds = this.blobs
      ? (this.db
          .prepare(
            "SELECT before_blob_id, after_blob_id, accepted_blob_id FROM turn_file_changes WHERE thread_id = ? AND path = ?",
          )
          .all(String(threadId), String(filePath)) as Array<{ before_blob_id: string | null; after_blob_id: string | null; accepted_blob_id: string | null }>)
          .flatMap((r) => [r.before_blob_id, r.after_blob_id, r.accepted_blob_id])
          .filter((id): id is string => Boolean(id))
      : [];
    const res = this.db.prepare("DELETE FROM turn_file_changes WHERE thread_id = ? AND path = ?").run(String(threadId), String(filePath));
    const changes = Number(res.changes ?? 0);
    if (changes > 0 && this.blobs && blobIds.length > 0) this.blobs.tryDeleteIfUnreferencedMany(blobIds);
    return changes;
  }

  /** 删除某 thread 在某 turn 之后的文件变更（rollback 使用）；同时对释放的 blob 做引用计数 GC。 */
  deleteAfterTurnEndSeq(threadId: ThreadId, endSeqInclusive: number): number {
    const blobIds = this.blobs ? this.collectBlobIdsAfterEndSeq(threadId, endSeqInclusive) : [];
    const res = this.db
      .prepare(
        [
          "DELETE FROM turn_file_changes",
          "WHERE thread_id = ? AND turn_id IN (",
          "  SELECT turn_id FROM thread_turns WHERE thread_id = ? AND end_event_seq IS NOT NULL AND end_event_seq > ?",
          ")",
        ].join("\n"),
      )
      .run(String(threadId), String(threadId), Number(endSeqInclusive));
    const changes = Number(res.changes ?? 0);
    if (changes > 0 && this.blobs && blobIds.length > 0) this.blobs.tryDeleteIfUnreferencedMany(blobIds);
    return changes;
  }
}

function computeOp(beforeExists: boolean, afterExists: boolean): FileChangeOp {
  if (!beforeExists && afterExists) return "create";
  if (beforeExists && !afterExists) return "delete";
  return "modify";
}

function computeStatus(
  baseBeforeExists: boolean,
  baseBeforeBlobId: string | null,
  currentAfterExists: boolean,
  currentAfterBlobId: string | null,
): "created" | "modified" | "deleted" | null {
  if (!baseBeforeExists && currentAfterExists) return "created";
  if (baseBeforeExists && !currentAfterExists) return "deleted";
  if (baseBeforeExists && currentAfterExists) {
    if (!baseBeforeBlobId || !currentAfterBlobId) return "modified";
    return baseBeforeBlobId === currentAfterBlobId ? null : "modified";
  }
  return null;
}

function mapRow(row: any): TurnFileChangeRecord {
  return {
    id: Number(row.id ?? 0),
    threadId: String(row.thread_id ?? "") as ThreadId,
    turnId: String(row.turn_id ?? "") as TurnId,
    path: String(row.path ?? ""),
    op: (String(row.op ?? "modify") as FileChangeOp) || "modify",
    beforeBlobId: row.before_blob_id == null ? null : String(row.before_blob_id),
    afterBlobId: row.after_blob_id == null ? null : String(row.after_blob_id),
    beforeExists: Boolean(row.before_exists ?? 0),
    afterExists: Boolean(row.after_exists ?? 0),
    diffText: row.diff_text == null ? null : String(row.diff_text),
    capturedAt: Number(row.captured_at ?? 0),
    stepKey: row.step_key == null ? null : String(row.step_key),
  };
}

