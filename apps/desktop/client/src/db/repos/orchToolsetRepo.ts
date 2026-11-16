import crypto from "node:crypto";

import { normalizeOrchAssetDefinitionKind, type ToolsetDefinition, type ToolsetId, type WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 编排工具集仓储。 */
export class OrchToolsetRepo {
  constructor(private readonly db: SqliteDb) {}

  listByWorkspace(workspaceId: WorkspaceId): ToolsetDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, name, description, definition_json, created_at, updated_at
         FROM orch_toolsets WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(String(workspaceId)) as any[];
    return rows.map(rowToToolset);
  }

  /** 完整图读取拒绝损坏原定义，避免默认空 tools 掩盖依赖缺失。 */
  get(id: ToolsetId, options?: { requireCompleteDefinition?: boolean }): ToolsetDefinition | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, name, description, definition_json, created_at, updated_at
         FROM orch_toolsets WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    if (!row) return null;
    if (options?.requireCompleteDefinition) assertCompleteToolsetRow(row);
    return rowToToolset(row);
  }

  /** 创建或更新工具集，并与迁移冻结检查处于同一事务。 */
  upsert(input: Omit<ToolsetDefinition, "createdAt" | "updatedAt">): ToolsetDefinition {
    return this.db.transaction(() => {
      const now = Date.now();
      const existing = input.id ? this.get(input.id) : null;
      const id = input.id || (crypto.randomUUID() as ToolsetId);
      const createdAt = existing?.createdAt ?? now;
      const normalizedInput = {
        ...input,
        kind: normalizeOrchAssetDefinitionKind(input.kind ?? existing?.kind),
      } satisfies Omit<ToolsetDefinition, "createdAt" | "updatedAt">;

      this.db
        .prepare(
          `INSERT INTO orch_toolsets (id, workspace_id, name, description, definition_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             definition_json = excluded.definition_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          String(normalizedInput.workspaceId),
          String(normalizedInput.name ?? ""),
          String(normalizedInput.description ?? ""),
          JSON.stringify({ ...normalizedInput, id, createdAt, updatedAt: now }),
          createdAt,
          now,
        );

      return { ...normalizedInput, id, createdAt, updatedAt: now };
    })();
  }

  /** 删除工具集，并在活动迁移冻结存在时显式失败。 */
  delete(id: ToolsetId): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM orch_toolsets WHERE id = ?").run(String(id));
    })();
  }
}

/** 原始工具清单须有唯一标识，内部角色引用随后由整图校验解析。 */
function assertCompleteToolsetRow(row: { id: string; workspace_id: string; definition_json: string }): void {
  const value = JSON.parse(row.definition_json) as ToolsetDefinition;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value.id != null && value.id !== row.id) || (value.workspaceId != null && value.workspaceId !== row.workspace_id)
    || !Array.isArray(value.tools)) throw new Error(`工具集原始定义非法：${row.id}`);
  const ids = new Set<string>();
  for (const tool of value.tools) {
    if (!tool || typeof tool.id !== "string" || !tool.id.trim() || ids.has(tool.id)) throw new Error(`工具集原始工具非法：${row.id}`);
    ids.add(tool.id);
  }
}

function rowToToolset(row: any): ToolsetDefinition {
  const parsed = safeParseJson<ToolsetDefinition | null>(row.definition_json, null);
  if (parsed && typeof parsed === "object") {
    return {
      ...parsed,
      id: row.id as ToolsetId,
      workspaceId: row.workspace_id as WorkspaceId,
      kind: normalizeOrchAssetDefinitionKind(parsed.kind),
      createdAt: Number(row.created_at ?? parsed.createdAt ?? 0),
      updatedAt: Number(row.updated_at ?? parsed.updatedAt ?? 0),
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
    };
  }
  return {
    id: row.id as ToolsetId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    tools: [],
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

