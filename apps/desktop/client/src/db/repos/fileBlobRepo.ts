import crypto from "node:crypto";
import type { ThreadId } from "@codeflowai/shared";

import type { FileSnapshotEncoding } from "../../fs/textEncoding.js";
import type { SqliteDb } from "../sqliteTypes.js";

export type FileBlobEncoding = FileSnapshotEncoding;

export type FileBlobRecord = {
  blobId: string;
  byteLen: number;
  encoding: FileBlobEncoding;
  data: Buffer;
  createdAt: number;
};

export type FileBlobReference = {
  blobId: string;
  byteLen: number;
};

export type FileBlobCleanupBatchResult = {
  scannedRows: number;
  deletedRows: number;
  deletedBytes: number;
  lastScannedRowId: number;
};

/**
 * file_blobs 的 5 个引用列。引用计数 GC 必须扫全部，任意一处 >0 都不能删。
 * 新增引用源时务必同步更新此清单，否则 GC 会误删被引用的 blob。
 */
const BLOB_REFERENCE_QUERIES: ReadonlyArray<{ readonly sql: string }> = [
  { sql: "SELECT 1 FROM thread_draft_attachments WHERE blob_id = ? LIMIT 1" },
  { sql: "SELECT 1 FROM thread_message_queue_attachments WHERE blob_id = ? LIMIT 1" },
  { sql: "SELECT 1 FROM turn_file_changes WHERE before_blob_id = ? LIMIT 1" },
  { sql: "SELECT 1 FROM turn_file_changes WHERE after_blob_id = ? LIMIT 1" },
  { sql: "SELECT 1 FROM turn_file_changes WHERE accepted_blob_id = ? LIMIT 1" },
];

/** 文件快照内容仓储：以 sha256 作为主键去重存储。 */
export class FileBlobRepo {
  private readonly deleteStmt;
  private readonly referenceStmts;
  private readonly tryDeleteTx;
  private readonly tryDeleteManyTx;

  constructor(private readonly db: SqliteDb) {
    this.deleteStmt = this.db.prepare("DELETE FROM file_blobs WHERE blob_id = ?");
    this.referenceStmts = BLOB_REFERENCE_QUERIES.map((q) => this.db.prepare(q.sql));
    /** 在当前事务内检查全部引用并删除单个无引用 blob。 */
    const tryDelete = (blobId: string): boolean => {
      for (const stmt of this.referenceStmts) {
        const row = stmt.get(blobId);
        if (row !== undefined) return false; // 仍有引用，不删
      }
      const result = this.deleteStmt.run(blobId);
      return Number(result.changes ?? 0) > 0;
    };
    this.tryDeleteTx = this.db.transaction(tryDelete);
    this.tryDeleteManyTx = this.db.transaction((blobIds: ReadonlyArray<string>): string[] => {
      const removed: string[] = [];
      for (const blobId of blobIds) {
        if (tryDelete(blobId)) removed.push(blobId);
      }
      return removed;
    });
  }

  /** 写入（或复用）一个 blob，返回 blobId(sha256)。 */
  put(data: Buffer, encoding: FileBlobEncoding): string {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const blobId = crypto.createHash("sha256").update(buf).digest("hex");
    const now = Date.now();
    this.db
      .prepare("INSERT OR IGNORE INTO file_blobs (blob_id, byte_len, encoding, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(blobId, buf.byteLength, encoding, buf, now);
    return blobId;
  }

  /** 读取 blob（不存在返回 null）。 */
  get(blobId: string): FileBlobRecord | null {
    const id = String(blobId ?? "").trim();
    if (!id) return null;
    const row = this.db
      .prepare("SELECT blob_id, byte_len, encoding, data, created_at FROM file_blobs WHERE blob_id = ?")
      .get(id) as { blob_id: string; byte_len: number; encoding: string; data: Buffer; created_at: number } | undefined;
    if (!row) return null;
    return {
      blobId: String(row.blob_id),
      byteLen: Number(row.byte_len ?? 0),
      encoding: normalizeFileBlobEncoding(row.encoding),
      data: Buffer.from(row.data ?? Buffer.from("")),
      createdAt: Number(row.created_at ?? 0),
    };
  }

  /** 读取当前 Blob 大表 rowid 高水位，后续新增行不进入本轮 GC。 */
  getCleanupHighWaterRowId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM file_blobs").get() as
      | { value?: number | null }
      | undefined;
    return normalizeCleanupRowId(row?.value);
  }

  /** 按 rowid 小窗口扫描，五个引用源均为空时才删除 Blob。 */
  cleanupUnreferencedBatch(
    afterRowId: number,
    throughRowId: number,
    limit: number,
  ): FileBlobCleanupBatchResult {
    const after = normalizeCleanupRowId(afterRowId);
    const through = normalizeCleanupRowId(throughRowId);
    const batchSize = normalizeCleanupBatchSize(limit);
    if (after >= through) {
      return { scannedRows: 0, deletedRows: 0, deletedBytes: 0, lastScannedRowId: after };
    }

    const cleanupTx = this.db.transaction((): FileBlobCleanupBatchResult => {
      const rows = this.db
        .prepare(
          `SELECT rowid AS row_id, blob_id, byte_len
           FROM file_blobs
           WHERE rowid > ? AND rowid <= ?
           ORDER BY rowid ASC
           LIMIT ?`,
        )
        .all(after, through, batchSize) as Array<{ row_id: number; blob_id: string; byte_len: number }>;
      let deletedRows = 0;
      let deletedBytes = 0;
      for (const row of rows) {
        const blobId = String(row.blob_id);
        const referenced = this.referenceStmts.some((statement) => statement.get(blobId) !== undefined);
        if (referenced) continue;
        const result = this.deleteStmt.run(blobId);
        if (Number(result.changes ?? 0) <= 0) continue;
        deletedRows += 1;
        deletedBytes += Math.max(0, Number(row.byte_len ?? 0));
      }
      return {
        scannedRows: rows.length,
        deletedRows,
        deletedBytes,
        lastScannedRowId: rows.length ? Number(rows[rows.length - 1]!.row_id) : after,
      };
    });
    return cleanupTx();
  }

  /** 按 thread 索引收集文件变更、草稿和消息队列的 blob 引用，最后统一去重。 */
  collectReferencedByThreadIds(threadIds: ReadonlyArray<ThreadId>): FileBlobReference[] {
    const normalizedIds = [...new Set(threadIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
    if (!normalizedIds.length) return [];
    const rows = this.db
      .prepare(
        [
          "WITH target_threads(thread_id) AS (",
          "  SELECT DISTINCT CAST(value AS TEXT) FROM json_each(?)",
          "), referenced_blobs(blob_id) AS (",
          "  SELECT before_blob_id FROM turn_file_changes",
          "  WHERE thread_id IN (SELECT thread_id FROM target_threads) AND before_blob_id IS NOT NULL",
          "  UNION ALL SELECT after_blob_id FROM turn_file_changes",
          "  WHERE thread_id IN (SELECT thread_id FROM target_threads) AND after_blob_id IS NOT NULL",
          "  UNION ALL SELECT accepted_blob_id FROM turn_file_changes",
          "  WHERE thread_id IN (SELECT thread_id FROM target_threads) AND accepted_blob_id IS NOT NULL",
          "  UNION ALL SELECT blob_id FROM thread_draft_attachments",
          "  WHERE thread_id IN (SELECT thread_id FROM target_threads)",
          "  UNION ALL SELECT attachment.blob_id FROM thread_message_queue queue_item",
          "    JOIN thread_message_queue_attachments attachment ON attachment.queue_item_id = queue_item.id",
          "  WHERE queue_item.thread_id IN (SELECT thread_id FROM target_threads)",
          "), unique_blobs(blob_id) AS (",
          "  SELECT DISTINCT blob_id FROM referenced_blobs",
          "  WHERE TRIM(CAST(blob_id AS TEXT)) <> ''",
          ")",
          "SELECT unique_blobs.blob_id, COALESCE(file_blobs.byte_len, 0) AS byte_len",
          "FROM unique_blobs",
          "LEFT JOIN file_blobs ON file_blobs.blob_id = unique_blobs.blob_id",
          "ORDER BY unique_blobs.blob_id ASC",
        ].join("\n"),
      )
      .all(JSON.stringify(normalizedIds)) as Array<{ blob_id: string; byte_len: number | null }>;
    return rows.map((row) => ({
      blobId: String(row.blob_id),
      byteLen: Math.max(0, Number(row.byte_len ?? 0)),
    }));
  }

  /**
   * 引用计数 GC：检查 5 个引用列都没有引用此 blob，才物理删除 file_blobs 行。
   * 调用方应在删除某个 attachment 行**之后**调用本方法（依赖最新的引用计数）。
   * 返回是否真的删除了。仍有引用 / blob 不存在时返回 false。
   */
  tryDeleteIfUnreferenced(blobId: string): boolean {
    const id = String(blobId ?? "").trim();
    if (!id) return false;
    return Boolean(this.tryDeleteTx(id));
  }

  /** 批量去重并在一个事务内执行引用检查与删除；返回真实删除的 blob_id 列表。 */
  tryDeleteIfUnreferencedMany(blobIds: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    for (const id of blobIds) {
      const trimmed = String(id ?? "").trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
    }
    if (!seen.size) return [];
    return this.tryDeleteManyTx([...seen]);
  }
}

/** 规整历史 blob 编码值；未知值保守视为 binary，避免误解码成文本。 */
function normalizeFileBlobEncoding(value: unknown): FileBlobEncoding {
  const encoding = String(value ?? "binary").trim();
  if (encoding === "utf8" || encoding === "gb18030" || encoding === "binary") return encoding;
  return "binary";
}

/** 规整 SQLite rowid 高水位。 */
function normalizeCleanupRowId(raw: unknown): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** 限制 Blob 单批扫描行数。 */
function normalizeCleanupBatchSize(raw: unknown): number {
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid blob cleanup batch size: ${String(raw)}`);
  return Math.min(1_000, value);
}
