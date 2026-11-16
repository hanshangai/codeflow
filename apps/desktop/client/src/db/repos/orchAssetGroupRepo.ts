import crypto from "node:crypto";
import type { OrchAssetGroup, OrchAssetGroupType, WorkspaceId } from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

/** 通用资产分组仓储，按工作区和资产类型隔离分组及关联。 */
export class OrchAssetGroupRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 返回指定资产类型的分组和资产关联。 */
  list(workspaceId: WorkspaceId, assetType: OrchAssetGroupType): { groups: OrchAssetGroup[]; assignments: Record<string, string> } {
    const groups = this.db.prepare(`SELECT * FROM orch_asset_groups WHERE workspace_id = ? AND asset_type = ? ORDER BY name_key, created_at`).all(String(workspaceId), assetType) as any[];
    const rows = this.db.prepare(`SELECT asset_id, group_id FROM orch_asset_group_assignments WHERE workspace_id = ? AND asset_type = ?`).all(String(workspaceId), assetType) as any[];
    return { groups: groups.map(toGroup), assignments: Object.fromEntries(rows.map((row) => [String(row.asset_id), String(row.group_id)])) };
  }

  /** 创建同类型内名称唯一的分组。 */
  create(workspaceId: WorkspaceId, assetType: OrchAssetGroupType, name: string): OrchAssetGroup {
    return this.db.transaction(() => {
      const normalized = normalizeName(name, assetType);
      const now = Date.now();
      const group: OrchAssetGroup = { id: `ag_${crypto.randomUUID()}`, workspaceId, assetType, name: normalized, createdAt: now, updatedAt: now };
      this.db.prepare(`INSERT INTO orch_asset_groups(id, workspace_id, asset_type, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(group.id, String(workspaceId), assetType, normalized, normalized.toLocaleLowerCase(), now, now);
      return group;
    })();
  }

  /** 重命名分组，并校验其工作区和类型归属。 */
  rename(workspaceId: WorkspaceId, assetType: OrchAssetGroupType, groupId: string, name: string): OrchAssetGroup {
    return this.db.transaction(() => {
      const normalized = normalizeName(name, assetType);
      const now = Date.now();
      const existing = this.db.prepare(`SELECT * FROM orch_asset_groups WHERE id = ? AND workspace_id = ? AND asset_type = ?`).get(groupId, String(workspaceId), assetType) as any | undefined;
      if (!existing) throw new Error("资产分组不存在");
      const result = this.db.prepare(`UPDATE orch_asset_groups SET name = ?, name_key = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND asset_type = ?`).run(normalized, normalized.toLocaleLowerCase(), now, groupId, String(workspaceId), assetType);
      if (!Number(result.changes ?? 0)) throw new Error("资产分组不存在");
      return { ...toGroup(existing), name: normalized, updatedAt: now };
    })();
  }

  /** 删除分组；关联通过外键级联删除。 */
  delete(workspaceId: WorkspaceId, assetType: OrchAssetGroupType, groupId: string): void {
    this.db.transaction(() => {
      const result = this.db.prepare(`DELETE FROM orch_asset_groups WHERE id = ? AND workspace_id = ? AND asset_type = ?`).run(groupId, String(workspaceId), assetType);
      if (!Number(result.changes ?? 0)) throw new Error("资产分组不存在");
    })();
  }

  /** 设置资产分组；空 groupId 表示移回未分组。 */
  assign(workspaceId: WorkspaceId, assetType: OrchAssetGroupType, assetId: string, groupId?: string | null): void {
    this.db.transaction(() => {
      if (!groupId) {
        this.db.prepare(`DELETE FROM orch_asset_group_assignments WHERE workspace_id = ? AND asset_type = ? AND asset_id = ?`).run(String(workspaceId), assetType, assetId);
        return;
      }
      const group = this.db.prepare(`SELECT id FROM orch_asset_groups WHERE id = ? AND workspace_id = ? AND asset_type = ?`).get(groupId, String(workspaceId), assetType);
      if (!group) throw new Error("资产分组不存在");
      this.db.prepare(`INSERT INTO orch_asset_group_assignments(workspace_id, asset_type, asset_id, group_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, asset_type, asset_id) DO UPDATE SET group_id = excluded.group_id, updated_at = excluded.updated_at`).run(String(workspaceId), assetType, assetId, groupId, Date.now());
    })();
  }

  /** 删除单个资产的分组关联，用于资产删除事务。 */
  deleteAssignment(workspaceId: WorkspaceId, assetType: OrchAssetGroupType, assetId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM orch_asset_group_assignments WHERE workspace_id = ? AND asset_type = ? AND asset_id = ?`).run(String(workspaceId), assetType, assetId);
    })();
  }
}

/** 校验用户分组名称，并为 Agent 保留系统知识库分组名称。 */
function normalizeName(name: string, assetType: OrchAssetGroupType): string {
  const value = String(name).trim();
  if (!value || value.length > 60) throw new Error("分组名称长度应为 1-60 个字符");
  if (["全部分组", "未分组"].includes(value.toLocaleLowerCase())) throw new Error("分组名称不能使用“全部分组”或“未分组”");
  if (assetType === "role" && value === "知识库") throw new Error("Agent 分组名称不能使用系统内置分组“知识库”");
  return value;
}

function toGroup(row: any): OrchAssetGroup {
  return { id: String(row.id), workspaceId: String(row.workspace_id) as WorkspaceId, assetType: String(row.asset_type) as OrchAssetGroupType, name: String(row.name), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
