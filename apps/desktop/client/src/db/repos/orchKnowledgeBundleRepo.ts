import crypto from "node:crypto";

import { normalizeOrchAssetDefinitionKind, type KnowledgeBundleDefinition, type KnowledgeBundleId, type WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 编排知识库仓储。 */
export class OrchKnowledgeBundleRepo {
  constructor(private readonly db: SqliteDb) {}

  listByWorkspace(workspaceId: WorkspaceId): KnowledgeBundleDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, name, scope, definition_json, created_at, updated_at
         FROM orch_knowledge_bundles WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(String(workspaceId)) as any[];
    return rows.map(rowToBundle);
  }

  /** 完整复制先验证原始知识定义；默认读取仍兼容已有旧数据。 */
  get(id: KnowledgeBundleId, options?: { requireCompleteDefinition?: boolean }): KnowledgeBundleDefinition | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, name, scope, definition_json, created_at, updated_at
         FROM orch_knowledge_bundles WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    if (!row) return null;
    if (options?.requireCompleteDefinition) assertCompleteKnowledgeRow(row);
    return rowToBundle(row);
  }

  /** 创建或更新知识包，并与迁移冻结检查处于同一事务。 */
  upsert(input: Omit<KnowledgeBundleDefinition, "createdAt" | "updatedAt">): KnowledgeBundleDefinition {
    return this.db.transaction(() => {
      assertKnowledgeBundleShape(input);
      const now = Date.now();
      const existing = input.id ? this.get(input.id) : null;
      const id = input.id || (crypto.randomUUID() as KnowledgeBundleId);
      const createdAt = existing?.createdAt ?? now;
      const normalizedInput = {
        ...input,
        kind: normalizeOrchAssetDefinitionKind(input.kind ?? existing?.kind),
      } satisfies Omit<KnowledgeBundleDefinition, "createdAt" | "updatedAt">;
      const persisted = { ...normalizedInput, id, createdAt, updatedAt: now } satisfies KnowledgeBundleDefinition;

      this.db
        .prepare(
          `INSERT INTO orch_knowledge_bundles (id, workspace_id, name, scope, definition_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             scope = excluded.scope,
             definition_json = excluded.definition_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          String(normalizedInput.workspaceId),
          String(normalizedInput.name ?? ""),
          normalizedInput.scope,
          JSON.stringify(persisted),
          createdAt,
          now,
        );

      return persisted;
    })();
  }

  /** 删除知识包，并在活动迁移冻结存在时显式失败。 */
  delete(id: KnowledgeBundleId): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM orch_knowledge_bundles WHERE id = ?").run(String(id));
    })();
  }
}

/** 禁止损坏正文通过默认空 sourceRefs 伪装成完整知识包。 */
function assertCompleteKnowledgeRow(row: { id: string; workspace_id: string; definition_json: string }): void {
  const value = JSON.parse(row.definition_json) as KnowledgeBundleDefinition;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value.id != null && value.id !== row.id) || (value.workspaceId != null && value.workspaceId !== row.workspace_id)
    || !Array.isArray(value.sourceRefs) || value.sourceRefs.some(source => !source || typeof source !== "object")
    || !["workflow", "role", "shared"].includes(value.scope)) throw new Error(`知识包原始定义非法：${row.id}`);
}

/** 校验知识包权威结构字段，拒绝把缺失值写成另一份 SQL 事实。 */
function assertKnowledgeBundleShape(
  input: Pick<KnowledgeBundleDefinition, "scope" | "sourceRefs">,
): void {
  if (input.scope !== "workflow" && input.scope !== "role" && input.scope !== "shared") {
    throw new Error(`知识包 scope 非法：${String(input.scope)}`);
  }
  if (!Array.isArray(input.sourceRefs)) {
    throw new Error("知识包 sourceRefs 非法：必须为数组");
  }
}

function rowToBundle(row: any): KnowledgeBundleDefinition {
  const parsed = safeParseJson<KnowledgeBundleDefinition | null>(row.definition_json, null);
  if (parsed && typeof parsed === "object") {
    return {
      ...parsed,
      id: row.id as KnowledgeBundleId,
      workspaceId: row.workspace_id as WorkspaceId,
      kind: normalizeOrchAssetDefinitionKind(parsed.kind),
      createdAt: Number(row.created_at ?? parsed.createdAt ?? 0),
      updatedAt: Number(row.updated_at ?? parsed.updatedAt ?? 0),
    };
  }
  return {
    id: row.id as KnowledgeBundleId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: String(row.name ?? ""),
    scope: (row.scope ?? "shared") as KnowledgeBundleDefinition["scope"],
    description: "",
    sourceRefs: [],
    kind: "custom",
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

