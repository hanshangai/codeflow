import crypto from "node:crypto";

import type { ArtifactId, NodeResultField, OrchestrationId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 节点结果字段索引仓储。 */
export class OrchArtifactFieldRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 查询某条节点结果记录下的全部输出字段。 */
  listByArtifact(artifactId: ArtifactId): NodeResultField[] {
    const rows = this.db
      .prepare(
        `SELECT id, artifact_id, instance_id, node_id, result_name, field_key, label,
                value_type, value_json, value_preview, required, source, validation_status,
                created_at, updated_at
         FROM orch_artifact_fields
         WHERE artifact_id = ?
         ORDER BY field_key ASC`,
      )
      .all(String(artifactId)) as any[];
    return rows.map(rowToArtifactField);
  }

  /** 按 artifact 全量替换字段索引，保证同一版本结果的字段事实一致。 */
  replaceForArtifact(
    artifactId: ArtifactId,
    entries: Array<Omit<NodeResultField, "id" | "createdAt" | "updatedAt" | "artifactId">>,
  ): NodeResultField[] {
    this.db.prepare("DELETE FROM orch_artifact_fields WHERE artifact_id = ?").run(String(artifactId));
    const now = Date.now();
    const created = entries.map((entry) => ({
      ...entry,
      id: crypto.randomUUID(),
      artifactId,
      createdAt: now,
      updatedAt: now,
    }));
    const stmt = this.db.prepare(
      `INSERT INTO orch_artifact_fields (
        id, artifact_id, instance_id, node_id, result_name, field_key, label,
        value_type, value_json, value_preview, required, source, validation_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of created) {
      stmt.run(
        entry.id,
        String(entry.artifactId),
        String(entry.instanceId),
        String(entry.nodeId),
        String(entry.resultName),
        String(entry.fieldKey),
        entry.label ?? null,
        String(entry.valueType),
        String(entry.valueJson),
        entry.valuePreview ?? null,
        entry.required ? 1 : 0,
        String(entry.source),
        String(entry.validationStatus),
        entry.createdAt,
        entry.updatedAt,
      );
    }
    return created;
  }

  /** 删除某条节点结果记录关联的字段索引。 */
  deleteByArtifact(artifactId: ArtifactId): number {
    const result = this.db.prepare("DELETE FROM orch_artifact_fields WHERE artifact_id = ?").run(String(artifactId));
    return Number(result.changes ?? 0);
  }
}

function rowToArtifactField(row: any): NodeResultField {
  return {
    id: String(row.id ?? ""),
    artifactId: String(row.artifact_id ?? "") as ArtifactId,
    instanceId: String(row.instance_id ?? "") as OrchestrationId,
    nodeId: String(row.node_id ?? ""),
    resultName: String(row.result_name ?? ""),
    fieldKey: String(row.field_key ?? ""),
    label: row.label ? String(row.label) : null,
    valueType: String(row.value_type ?? "text") as NodeResultField["valueType"],
    valueJson: String(row.value_json ?? "null"),
    valuePreview: row.value_preview ? String(row.value_preview) : null,
    required: Boolean(Number(row.required ?? 0)),
    source: String(row.source ?? "model") as NodeResultField["source"],
    validationStatus: String(row.validation_status ?? "valid") as NodeResultField["validationStatus"],
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}
