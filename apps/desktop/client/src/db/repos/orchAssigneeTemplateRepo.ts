import crypto from "node:crypto";
import {
  normalizeAssigneeTemplateStatus,
  normalizeOrchestrationRunPlanAssignees,
  type AssigneeTemplate,
  type WorkspaceId,
  type WorkflowId,
} from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

/** 流程模板处理人模板仓储：负责模板 CRUD 和节点处理人快照规范化。 */
export class OrchAssigneeTemplateRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 按 workspace/workflow 列出模板；workflowId 为空时返回当前 workspace 全部模板。 */
  listByWorkspace(workspaceId: WorkspaceId, workflowId?: WorkflowId | null): AssigneeTemplate[] {
    const normalizedWorkflowId = String(workflowId ?? "").trim();
    const rows = normalizedWorkflowId
      ? this.db
        .prepare(
          `SELECT id, workspace_id, workflow_id, name, version, status, node_assignees_json, created_at, updated_at
           FROM orch_assignee_templates
           WHERE workspace_id = ? AND workflow_id = ?
           ORDER BY status = 'published' DESC, updated_at DESC`,
        )
        .all(String(workspaceId), normalizedWorkflowId) as any[]
      : this.db
        .prepare(
          `SELECT id, workspace_id, workflow_id, name, version, status, node_assignees_json, created_at, updated_at
           FROM orch_assignee_templates
           WHERE workspace_id = ?
           ORDER BY updated_at DESC`,
        )
        .all(String(workspaceId)) as any[];
    return rows.map(rowToTemplate);
  }

  /** 获取单个模板；不存在返回 null。 */
  get(id: string): AssigneeTemplate | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, workflow_id, name, version, status, node_assignees_json, created_at, updated_at
         FROM orch_assignee_templates WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    return row ? rowToTemplate(row) : null;
  }

  /** 创建或更新处理人模板；更新时递增版本，避免运行计划误读旧模板。 */
  upsert(input: Omit<AssigneeTemplate, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string | null; version?: number | null }): AssigneeTemplate {
    const now = Date.now();
    const existing = input.id ? this.get(String(input.id)) : null;
    const id = String(input.id ?? "").trim() || crypto.randomUUID();
    const createdAt = existing?.createdAt ?? now;
    const version = existing ? existing.version + 1 : Number(input.version ?? 1) || 1;
    const template: AssigneeTemplate = {
      id,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      name: String(input.name ?? "").trim(),
      version,
      status: normalizeAssigneeTemplateStatus(input.status),
      nodeAssigneeUserIdsByNodeId: normalizeOrchestrationRunPlanAssignees(input.nodeAssigneeUserIdsByNodeId),
      createdAt,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO orch_assignee_templates
           (id, workspace_id, workflow_id, name, version, status, node_assignees_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           workflow_id = excluded.workflow_id,
           name = excluded.name,
           version = excluded.version,
           status = excluded.status,
           node_assignees_json = excluded.node_assignees_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        template.id,
        String(template.workspaceId),
        String(template.workflowId),
        template.name,
        template.version,
        template.status,
        JSON.stringify(template.nodeAssigneeUserIdsByNodeId),
        template.createdAt,
        template.updatedAt,
      );
    return template;
  }

  /** 删除模板；调用方负责权限判断。 */
  delete(id: string): void {
    this.db.prepare("DELETE FROM orch_assignee_templates WHERE id = ?").run(String(id));
  }
}

function rowToTemplate(row: any): AssigneeTemplate {
  return {
    id: String(row.id ?? ""),
    workspaceId: row.workspace_id as WorkspaceId,
    workflowId: row.workflow_id as WorkflowId,
    name: String(row.name ?? ""),
    version: Number(row.version ?? 1),
    status: normalizeAssigneeTemplateStatus(row.status),
    nodeAssigneeUserIdsByNodeId: normalizeOrchestrationRunPlanAssignees(safeParseJson(row.node_assignees_json, {})),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`处理人模板 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
