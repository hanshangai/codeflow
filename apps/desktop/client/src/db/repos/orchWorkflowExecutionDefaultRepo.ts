import type {
  EngineType,
  WorkflowExecutionDefault,
  WorkflowId,
  WorkspaceId,
} from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

/**
 * 工作区级流程执行默认值仓储：按 (workspaceId, workflowId) 单例读写。
 * 只承载引擎与模型，不写流程定义本体；写入前由调用方校验模型仍在模型目录中。
 */
export class OrchWorkflowExecutionDefaultRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 读取某流程在本工作区的执行默认值；未配置时返回 null。 */
  get(workspaceId: WorkspaceId, workflowId: WorkflowId): WorkflowExecutionDefault | null {
    const row = this.db
      .prepare(
        `SELECT workspace_id, workflow_id, engine, model, updated_by_user_id, created_at, updated_at
         FROM orch_workflow_execution_defaults
         WHERE workspace_id = ? AND workflow_id = ?`,
      )
      .get(String(workspaceId), String(workflowId)) as any | undefined;
    return row ? rowToWorkflowExecutionDefault(row) : null;
  }

  /** 写入执行默认值；重复保存覆盖同一行并保留首次创建时间。 */
  upsert(input: {
    workspaceId: WorkspaceId;
    workflowId: WorkflowId;
    engine: EngineType;
    model: string;
    updatedByUserId?: string | null;
  }): WorkflowExecutionDefault {
    const now = Date.now();
    const existing = this.get(input.workspaceId, input.workflowId);
    const record: WorkflowExecutionDefault = {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      engine: input.engine,
      model: String(input.model ?? "").trim(),
      updatedByUserId: input.updatedByUserId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO orch_workflow_execution_defaults
           (workspace_id, workflow_id, engine, model, updated_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, workflow_id) DO UPDATE SET
           engine = excluded.engine,
           model = excluded.model,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        String(record.workspaceId),
        String(record.workflowId),
        record.engine,
        record.model,
        record.updatedByUserId ?? null,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  /** 清除执行默认值；调用方负责权限判断。 */
  delete(workspaceId: WorkspaceId, workflowId: WorkflowId): void {
    this.db
      .prepare("DELETE FROM orch_workflow_execution_defaults WHERE workspace_id = ? AND workflow_id = ?")
      .run(String(workspaceId), String(workflowId));
  }
}

/** 行记录映射；引擎值域异常时显式失败，不静默回落默认引擎。 */
function rowToWorkflowExecutionDefault(row: any): WorkflowExecutionDefault {
  const engine = String(row.engine ?? "").trim();
  if (engine !== "claude" && engine !== "codex") {
    throw new Error(`流程执行默认值引擎非法：${engine || "(空)"}`);
  }
  return {
    workspaceId: row.workspace_id as WorkspaceId,
    workflowId: row.workflow_id as WorkflowId,
    engine,
    model: String(row.model ?? ""),
    updatedByUserId: row.updated_by_user_id == null ? null : String(row.updated_by_user_id),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}
