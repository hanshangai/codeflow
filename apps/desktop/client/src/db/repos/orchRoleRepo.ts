import crypto from "node:crypto";
import {
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  createDefaultRoleExecutionConfig,
  normalizeOrchAssetDefinitionKind,
  type RoleId,
  type WorkspaceId,
  type RoleDefinition,
  type RoleExecutionConfig,
  normalizeRoleInputDefinition,
  normalizeRoleOutputDefinition,
  normalizeRoleExecutionConfig,
} from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

const EMPTY_INPUT = createDefaultRoleInputDefinition();
const EMPTY_OUTPUT = createDefaultRoleOutputDefinition();
const EMPTY_EXEC: RoleExecutionConfig = createDefaultRoleExecutionConfig("codex");

/** 编排角色仓储：负责 orch_roles 表的 CRUD。 */
export class OrchRoleRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 列出某 workspace 的所有角色（按 updated_at DESC）。 */
  listByWorkspace(workspaceId: WorkspaceId): RoleDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, definition_json, kind, created_at, updated_at
         FROM orch_roles WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(String(workspaceId)) as any[];
    return rows.map(rowToRole);
  }

  /** 完整图读取先校验原始定义与依赖，不通过兼容映射掩盖损坏。 */
  get(id: RoleId, options?: { requireCompleteDefinition?: boolean }): RoleDefinition | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, definition_json, kind, created_at, updated_at
         FROM orch_roles WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    if (!row) return null;
    if (options?.requireCompleteDefinition) assertCompleteRoleRow(row);
    return rowToRole(row);
  }

  /** 创建或更新角色；请求省略内置分组时沿用既有归属，避免编辑配置时丢失系统分类。 */
  upsert(input: Omit<RoleDefinition, "createdAt" | "updatedAt">): RoleDefinition {
    return this.db.transaction(() => {
      const now = Date.now();
      const existing = input.id ? this.get(input.id) : null;
      const id = input.id || (crypto.randomUUID() as RoleId);
      const createdAt = existing?.createdAt ?? now;

      const normalizedExecutionConfig = normalizeRoleExecutionConfig(input.executionConfig, input.executionConfig?.preferredEngine ?? "codex");
      const normalizedInput = {
        ...input,
        builtinGroup: input.builtinGroup === undefined ? existing?.builtinGroup ?? null : input.builtinGroup,
        kind: normalizeOrchAssetDefinitionKind(input.kind ?? existing?.kind),
        inputDefinition: normalizeRoleInputDefinition(input.inputDefinition),
        outputDefinition: normalizeRoleOutputDefinition(input.outputDefinition),
        executionConfig: normalizedExecutionConfig,
      } satisfies Omit<RoleDefinition, "createdAt" | "updatedAt">;

      this.db
        .prepare(
          `INSERT INTO orch_roles (id, workspace_id, name, description, system_prompt,
                  execution_config_json, definition_json, kind, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, description = excluded.description,
             system_prompt = excluded.system_prompt,
             execution_config_json = excluded.execution_config_json,
             definition_json = excluded.definition_json,
             kind = excluded.kind, updated_at = excluded.updated_at`,
        )
        .run(
          id,
          String(normalizedInput.workspaceId),
          String(normalizedInput.name ?? ""),
          String(normalizedInput.description ?? ""),
          String(normalizedInput.systemPrompt ?? ""),
          JSON.stringify(normalizedInput.executionConfig),
          JSON.stringify(normalizedInput),
          String(normalizedInput.kind ?? "custom"),
          createdAt,
          now,
        );
      return { ...normalizedInput, id, createdAt, updatedAt: now } as RoleDefinition;
    })();
  }

  /** 删除角色。 */
  delete(id: RoleId): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM orch_roles WHERE id = ?").run(String(id));
    })();
  }
}

/** 角色可选依赖保留原类型；复制不得遗漏任何被错误归一化的引用。 */
function assertCompleteRoleRow(row: { id: string; workspace_id: string; definition_json: string }): void {
  const value = JSON.parse(row.definition_json) as RoleDefinition;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.name !== "string" || !value.name.trim() || typeof value.systemPrompt !== "string"
    || (value.id != null && value.id !== row.id) || (value.workspaceId != null && value.workspaceId !== row.workspace_id)) {
    throw new Error(`角色原始定义身份非法：${row.id}`);
  }
  for (const ids of [value.defaultKnowledgeBundleIds, value.defaultSkillIds]) {
    if (ids != null && (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim()))) {
      throw new Error(`角色原始依赖非法：${row.id}`);
    }
  }
  if (value.toolRefs != null && (!Array.isArray(value.toolRefs) || value.toolRefs.some(ref => !ref
    || typeof ref.toolsetId !== "string" || !ref.toolsetId.trim() || typeof ref.toolId !== "string" || !ref.toolId.trim()))) {
    throw new Error(`角色原始工具依赖非法：${row.id}`);
  }
}

function rowToRole(row: any): RoleDefinition {
  const full = safeParseJson<RoleDefinition | null>(row.definition_json, null);
  if (!full || typeof full !== "object") {
    throw new Error(`角色定义缺少 definition_json：${String(row.id ?? "")}`);
  }
  return {
    ...full,
    id: row.id as RoleId,
    workspaceId: row.workspace_id as WorkspaceId,
    kind: normalizeOrchAssetDefinitionKind(full.kind ?? row.kind),
    inputDefinition: normalizeRoleInputDefinition(full.inputDefinition ?? EMPTY_INPUT),
    outputDefinition: normalizeRoleOutputDefinition(full.outputDefinition ?? EMPTY_OUTPUT),
    executionConfig: normalizeRoleExecutionConfig(full.executionConfig ?? EMPTY_EXEC, full.executionConfig?.preferredEngine ?? "codex"),
    createdAt: Number(row.created_at ?? full.createdAt ?? 0),
    updatedAt: Number(row.updated_at ?? full.updatedAt ?? 0),
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

