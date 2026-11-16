import crypto from "node:crypto";

import type { Artifact, ArtifactId, OrchestrationId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 编排工件仓储。 */
export class OrchArtifactRepo {
  constructor(private readonly db: SqliteDb) {}

  get(id: ArtifactId): Artifact | null {
    const row = this.db
      .prepare(
        `SELECT id, instance_id, node_id, kind, version, title, schema_ref,
                status, content_json, metadata_json, persistence_mode, payload_mode,
                workspace_status, workspace_base_dir, staging_path, published_path,
                content_hash, manifest_json, created_at, updated_at
         FROM orch_artifacts WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    return row ? rowToArtifact(row) : null;
  }

  listByInstance(instanceId: OrchestrationId): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, node_id, kind, version, title, schema_ref,
                status, content_json, metadata_json, persistence_mode, payload_mode,
                workspace_status, workspace_base_dir, staging_path, published_path,
                content_hash, manifest_json, created_at, updated_at
         FROM orch_artifacts WHERE instance_id = ? ORDER BY created_at ASC`,
      )
      .all(String(instanceId)) as any[];
    return rows.map((row) => rowToArtifact(row));
  }

  listByNode(instanceId: OrchestrationId, nodeId: string): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, node_id, kind, version, title, schema_ref,
                status, content_json, metadata_json, persistence_mode, payload_mode,
                workspace_status, workspace_base_dir, staging_path, published_path,
                content_hash, manifest_json, created_at, updated_at
         FROM orch_artifacts
         WHERE instance_id = ? AND node_id = ?
         ORDER BY version ASC, created_at ASC`,
      )
      .all(String(instanceId), String(nodeId)) as any[];
    return rows.map((row) => rowToArtifact(row));
  }

  /** 只读取实例产物元数据，避免列表请求解析并复制全部正文 JSON。 */
  listSummariesByInstance(instanceId: OrchestrationId): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, node_id, kind, version, title, schema_ref,
                status, metadata_json, persistence_mode, payload_mode,
                workspace_status, workspace_base_dir, staging_path, published_path,
                content_hash, manifest_json, created_at, updated_at
         FROM orch_artifacts WHERE instance_id = ? ORDER BY created_at ASC`,
      )
      .all(String(instanceId)) as any[];
    return rows.map((row) => rowToArtifact(row, { includeContent: false }));
  }

  /** 读取产物归属投影，供权限校验避免加载 content_json。 */
  getAccessProjection(id: ArtifactId): { id: ArtifactId; instanceId: OrchestrationId } | null {
    const row = this.db
      .prepare("SELECT id, instance_id FROM orch_artifacts WHERE id = ?")
      .get(String(id)) as { id?: string; instance_id?: string } | undefined;
    if (!row) return null;
    return {
      id: row.id as ArtifactId,
      instanceId: row.instance_id as OrchestrationId,
    };
  }

  /** 按节点 Attempt 查找已写工件，供崩溃恢复和重复收尾幂等复用。 */
  getByNodeAttempt(instanceId: OrchestrationId, attemptId: string): Artifact | null {
    const row = this.db
      .prepare(
        `SELECT id, instance_id, node_id, kind, version, title, schema_ref,
                status, content_json, metadata_json, persistence_mode, payload_mode,
                workspace_status, workspace_base_dir, staging_path, published_path,
                content_hash, manifest_json, created_at, updated_at
         FROM orch_artifacts
         WHERE instance_id = ?
           AND json_valid(metadata_json)
           AND json_extract(metadata_json, '$.nodeAttemptId') = ?
         LIMIT 1`,
      )
      .get(String(instanceId), String(attemptId)) as any | undefined;
    return row ? rowToArtifact(row) : null;
  }

  create(input: Omit<Artifact, "id" | "createdAt" | "updatedAt">): Artifact {
    const id = crypto.randomUUID() as ArtifactId;
    const now = Date.now();
    const artifact: Artifact = { ...input, id, createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO orch_artifacts (id, instance_id, node_id, kind, version, title, schema_ref,
                status, content_json, metadata_json, persistence_mode, payload_mode,
                workspace_status, workspace_base_dir, staging_path, published_path,
                content_hash, manifest_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(artifact.instanceId),
        String(artifact.nodeId),
        String(artifact.kind),
        Number(artifact.version ?? 1),
        String(artifact.title ?? ""),
        artifact.schemaRef ?? null,
        String(artifact.status),
        String(artifact.contentJson ?? ""),
        artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        artifact.persistenceMode ?? null,
        artifact.payloadMode ?? null,
        artifact.workspaceStatus ?? null,
        artifact.workspaceBaseDir ?? null,
        artifact.stagingPath ?? null,
        artifact.publishedPath ?? null,
        artifact.contentHash ?? null,
        artifact.manifest ? JSON.stringify(artifact.manifest) : null,
        now,
        now,
      );
    return artifact;
  }

  updateStatus(id: ArtifactId, status: Artifact["status"]): void {
    this.db
      .prepare("UPDATE orch_artifacts SET status = ?, updated_at = ? WHERE id = ?")
      .run(String(status), Date.now(), String(id));
  }

  updateWorkspace(id: ArtifactId, input: {
    status?: Artifact["status"];
    workspaceStatus?: Artifact["workspaceStatus"];
    stagingPath?: string | null;
    publishedPath?: string | null;
    contentHash?: string | null;
    manifest?: Artifact["manifest"] | null;
  }): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if ("status" in input) {
      assignments.push("status = ?");
      values.push(input.status ?? null);
    }
    if ("workspaceStatus" in input) {
      assignments.push("workspace_status = ?");
      values.push(input.workspaceStatus ?? null);
    }
    if ("stagingPath" in input) {
      assignments.push("staging_path = ?");
      values.push(input.stagingPath ?? null);
    }
    if ("publishedPath" in input) {
      assignments.push("published_path = ?");
      values.push(input.publishedPath ?? null);
    }
    if ("contentHash" in input) {
      assignments.push("content_hash = ?");
      values.push(input.contentHash ?? null);
    }
    if ("manifest" in input) {
      assignments.push("manifest_json = ?");
      values.push(input.manifest === undefined ? null : JSON.stringify(input.manifest));
    }
    if (!assignments.length) return;
    assignments.push("updated_at = ?");
    values.push(Date.now(), String(id));
    this.db
      .prepare(
        `UPDATE orch_artifacts
         SET ${assignments.join(", ")}
         WHERE id = ?`,
      )
      .run(...values);
  }

  deleteByInstance(instanceId: OrchestrationId): number {
    const result = this.db.prepare("DELETE FROM orch_artifacts WHERE instance_id = ?").run(String(instanceId));
    return Number(result.changes ?? 0);
  }
}

/** 将 SQLite 行映射为产物；摘要查询以空串标记正文尚未加载。 */
function rowToArtifact(row: any, options: { includeContent?: boolean } = {}): Artifact {
  return {
    id: row.id as ArtifactId,
    instanceId: row.instance_id as OrchestrationId,
    nodeId: String(row.node_id ?? ""),
    kind: String(row.kind ?? ""),
    version: Number(row.version ?? 1),
    title: String(row.title ?? ""),
    schemaRef: row.schema_ref ? String(row.schema_ref) : null,
    status: (row.status ?? "draft") as Artifact["status"],
    contentJson: options.includeContent === false ? "" : String(row.content_json ?? ""),
    metadata: safeParseJson<Record<string, unknown> | null>(row.metadata_json, null),
    persistenceMode: row.persistence_mode ? String(row.persistence_mode) as Artifact["persistenceMode"] : undefined,
    payloadMode: row.payload_mode ? String(row.payload_mode) as Artifact["payloadMode"] : undefined,
    workspaceStatus: row.workspace_status ? String(row.workspace_status) as Artifact["workspaceStatus"] : null,
    workspaceBaseDir: row.workspace_base_dir ? String(row.workspace_base_dir) : null,
    stagingPath: row.staging_path ? String(row.staging_path) : null,
    publishedPath: row.published_path ? String(row.published_path) : null,
    contentHash: row.content_hash ? String(row.content_hash) : null,
    manifest: safeParseJson<Artifact["manifest"] | null>(row.manifest_json, null),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
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

