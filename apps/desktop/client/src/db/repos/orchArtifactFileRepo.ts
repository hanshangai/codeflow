import crypto from "node:crypto";

import type { ArtifactFileEntry, ArtifactId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export class OrchArtifactFileRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 查询某条节点结果记录的文件快照和交付契约元数据。 */
  listByArtifact(artifactId: ArtifactId): ArtifactFileEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, artifact_id, file_key, file_role, format, contract_key, summary, validation_status,
                rel_path, staging_path, published_path, status,
                content_hash, size_bytes, created_at, updated_at
         FROM orch_artifact_files
         WHERE artifact_id = ?
         ORDER BY created_at ASC`,
      )
      .all(String(artifactId)) as any[];
    return rows.map(rowToArtifactFile);
  }

  /** 按 artifact 全量替换文件索引，保持文件列表和当前结果版本一致。 */
  replaceForArtifact(artifactId: ArtifactId, entries: Array<Omit<ArtifactFileEntry, "id" | "createdAt" | "updatedAt" | "artifactId">>): ArtifactFileEntry[] {
    this.db.prepare("DELETE FROM orch_artifact_files WHERE artifact_id = ?").run(String(artifactId));
    const now = Date.now();
    const created = entries.map((entry) => ({
      id: crypto.randomUUID(),
      artifactId,
      fileKey: entry.fileKey ?? null,
      fileRole: normalizeFileRole(entry.fileRole),
      format: entry.format ?? null,
      contractKey: entry.contractKey ?? null,
      summary: entry.summary ?? null,
      validationStatus: entry.validationStatus ?? null,
      relPath: entry.relPath,
      stagingPath: entry.stagingPath ?? null,
      publishedPath: entry.publishedPath ?? null,
      status: entry.status,
      contentHash: entry.contentHash,
      sizeBytes: Number(entry.sizeBytes ?? 0),
      createdAt: now,
      updatedAt: now,
    }));
    const stmt = this.db.prepare(
      `INSERT INTO orch_artifact_files (
        id, artifact_id, file_key, file_role, format, contract_key, summary, validation_status,
        rel_path, staging_path, published_path, status, content_hash, size_bytes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of created) {
      stmt.run(
        entry.id,
        String(entry.artifactId),
        entry.fileKey ?? null,
        entry.fileRole,
        entry.format ?? null,
        entry.contractKey ?? null,
        entry.summary ?? null,
        entry.validationStatus ?? null,
        String(entry.relPath),
        entry.stagingPath ?? null,
        entry.publishedPath ?? null,
        String(entry.status),
        String(entry.contentHash),
        Number(entry.sizeBytes),
        entry.createdAt,
        entry.updatedAt,
      );
    }
    return created;
  }

  updatePublishedPaths(
    artifactId: ArtifactId,
    entries: Array<Pick<ArtifactFileEntry, "id" | "publishedPath" | "status"> & { stagingPath?: string | null }>,
  ): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      "UPDATE orch_artifact_files SET published_path = ?, staging_path = ?, status = ?, updated_at = ? WHERE id = ? AND artifact_id = ?",
    );
    for (const entry of entries) {
      stmt.run(
        entry.publishedPath ?? null,
        entry.stagingPath ?? null,
        String(entry.status),
        now,
        String(entry.id),
        String(artifactId),
      );
    }
  }

  updateStatusByArtifact(artifactId: ArtifactId, status: ArtifactFileEntry["status"]): void {
    this.db
      .prepare("UPDATE orch_artifact_files SET status = ?, updated_at = ? WHERE artifact_id = ?")
      .run(String(status), Date.now(), String(artifactId));
  }

  deleteByArtifact(artifactId: ArtifactId): number {
    const result = this.db.prepare("DELETE FROM orch_artifact_files WHERE artifact_id = ?").run(String(artifactId));
    return Number(result.changes ?? 0);
  }
}

function rowToArtifactFile(row: any): ArtifactFileEntry {
  return {
    id: String(row.id ?? ""),
    artifactId: String(row.artifact_id ?? "") as ArtifactId,
    fileKey: row.file_key ? String(row.file_key) : null,
    fileRole: normalizeFileRole(row.file_role),
    format: row.format ? String(row.format) : null,
    contractKey: row.contract_key ? String(row.contract_key) : null,
    summary: row.summary ? String(row.summary) : null,
    validationStatus: row.validation_status ? String(row.validation_status) as ArtifactFileEntry["validationStatus"] : null,
    relPath: String(row.rel_path ?? ""),
    stagingPath: row.staging_path ? String(row.staging_path) : null,
    publishedPath: row.published_path ? String(row.published_path) : null,
    status: String(row.status ?? "staging") as ArtifactFileEntry["status"],
    contentHash: String(row.content_hash ?? ""),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function normalizeFileRole(value: unknown): NonNullable<ArtifactFileEntry["fileRole"]> {
  return value === "attachment" ? "attachment" : "contract";
}

