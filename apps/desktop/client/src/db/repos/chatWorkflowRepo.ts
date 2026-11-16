import type { ChatWorkflowTask } from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

/** 卡片删除结果：taskIds 供调用方记日志，skippedInvalidJsonCount 为 task_json 非法而无法判定归属的行数。 */
export type ChatWorkflowCardRemoval = { taskIds: string[]; skippedInvalidJsonCount: number };

/** 独立于会话生命周期，删除源会话不级联删除执行关联和验收记录。 */
export class ChatWorkflowRepo {
  constructor(private readonly db: SqliteDb) {}

  isEnabled(threadId: string): boolean {
    const row = this.db.prepare("SELECT recommendation_enabled AS enabled FROM chat_workflow_settings WHERE thread_id = ?").get(threadId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  setEnabled(threadId: string, enabled: boolean): void {
    this.db.prepare("INSERT INTO chat_workflow_settings (thread_id, recommendation_enabled) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET recommendation_enabled = excluded.recommendation_enabled").run(threadId, enabled ? 1 : 0);
  }

  get(id: string): ChatWorkflowTask | null {
    const row = this.db.prepare("SELECT task_json FROM chat_workflow_tasks WHERE id = ?").get(id) as { task_json: string } | undefined;
    return row ? JSON.parse(row.task_json) as ChatWorkflowTask : null;
  }

  list(threadId: string): ChatWorkflowTask[] {
    const rows = this.db.prepare("SELECT task_json FROM chat_workflow_tasks WHERE thread_id = ? ORDER BY created_at DESC, id DESC").all(threadId) as Array<{ task_json: string }>;
    return rows.map(row => JSON.parse(row.task_json) as ChatWorkflowTask);
  }

  /** 按实例反查绑定的源会话与任务（instance_id 有唯一索引）；普通编排实例未绑定任务时返回 null。 */
  findBindingByInstanceId(instanceId: string): { threadId: string; taskId: string } | null {
    const row = this.db.prepare("SELECT id, thread_id FROM chat_workflow_tasks WHERE instance_id = ?").get(instanceId) as { id: string; thread_id: string } | undefined;
    const threadId = String(row?.thread_id ?? "").trim();
    const taskId = String(row?.id ?? "").trim();
    return threadId && taskId ? { threadId, taskId } : null;
  }

  create(task: ChatWorkflowTask): void {
    this.db.prepare("INSERT INTO chat_workflow_tasks (id, workspace_id, thread_id, source_turn_id, instance_id, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.workspaceId, task.threadId, task.sourceTurnId, task.instanceId, task.state, task.version, JSON.stringify(task), task.createdAt, task.updatedAt);
  }

  /** 正常启动与恢复共用同一关联操作；已关联同一实例时不再递增版本。 */
  linkInstance(taskId: string, instanceId: string): ChatWorkflowTask {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("会话工作流任务不存在");
      if (current.instanceId === instanceId && current.state === "linked") return current;
      if (current.instanceId && current.instanceId !== instanceId) {
        throw Object.assign(new Error("任务已关联其他工作流实例"), { code: "CHAT_WORKFLOW_INSTANCE_CONFLICT", status: 409 });
      }
      return this.update({ ...current, state: "linked", instanceId }, current.version);
    })();
  }

  /** 恢复没有本进程活动操作的启动；同步事务内核对实例和请求记录。 */
  recoverStarts(threadId?: string, activeTaskIds: ReadonlySet<string> = new Set()): Array<{ taskId: string; instanceId: string | null; requestIds: string[] }> {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT task_json FROM chat_workflow_tasks
        WHERE (state = 'starting' OR (state = 'recommended' AND instance_id IS NULL))
        ${threadId ? "AND thread_id = ?" : ""}`).all(...(threadId ? [threadId] : [])) as Array<{ task_json: string }>;
      const recovered: Array<{ taskId: string; instanceId: string | null; requestIds: string[] }> = [];
      for (const row of rows) {
        const task = JSON.parse(row.task_json) as ChatWorkflowTask;
        if (activeTaskIds.has(task.id)) continue;
        const instance = task.proposalId ? this.db.prepare("SELECT id FROM orch_instances WHERE workspace_id = ? AND proposal_id = ? ORDER BY created_at LIMIT 1")
          .get(task.workspaceId, task.proposalId) as { id: string } | undefined : undefined;
        if (!instance && task.state !== "starting") continue;
        if (instance) this.linkInstance(task.id, instance.id);
        else this.update({ ...task, state: "recommended" }, task.version);
        const pending = this.db.prepare("SELECT request_id FROM chat_workflow_actions WHERE task_id = ? AND state = 'processing'").all(task.id) as Array<{ request_id: string }>;
        this.db.prepare("UPDATE chat_workflow_actions SET state = ?, updated_at = ? WHERE task_id = ? AND state = 'processing'")
          .run(instance ? "completed" : "interrupted", Date.now(), task.id);
        recovered.push({ taskId: task.id, instanceId: instance?.id ?? null, requestIds: pending.map(action => action.request_id) });
      }
      return recovered;
    })();
  }

  /**
   * 列出全部卡片引用的流程 id 及其工作区，供权威资产删除后的卡片回收比对。
   * 非法 JSON 行无法判定归属，不参与比对；调用方按工作区分组，不做跨工作区隐式删除。
   */
  listWorkflowRefs(): Array<{ workspaceId: string; taskId: string; workflowId: string }> {
    const rows = this.db.prepare(`SELECT id, workspace_id, json_extract(task_json, '$.workflow.id') AS workflow_id
      FROM chat_workflow_tasks
      WHERE json_valid(task_json) AND json_extract(task_json, '$.workflow.id') IS NOT NULL`).all() as Array<{ id: string; workspace_id: string; workflow_id: string }>;
    return rows.map(row => ({ workspaceId: String(row.workspace_id), taskId: String(row.id), workflowId: String(row.workflow_id) }));
  }

  /**
   * 按需求删除会话工作流卡片（含其操作回执）。
   * 命中键取 task_json.intakeId：state='starting' 时 instance_id 仍为 NULL，按实例删会漏掉这类卡。
   */
  deleteByIntakeIds(workspaceId: string, intakeIds: readonly string[]): ChatWorkflowCardRemoval {
    return this.deleteByTaskJsonValue(workspaceId, "$.intakeId", intakeIds);
  }

  /** 按流程删除会话工作流卡片（含其操作回执）。 */
  deleteByWorkflowIds(workspaceId: string, workflowIds: readonly string[]): ChatWorkflowCardRemoval {
    return this.deleteByTaskJsonValue(workspaceId, "$.workflow.id", workflowIds);
  }

  /**
   * 按 task_json 内字段的值命中卡片并删除。
   * 非法 JSON 行由 CASE WHEN json_valid 兜底跳过（json_extract 遇非法 JSON 会抛错并回滚整个删除事务），
   * 跳过行数如实上报给调用方记日志。必须同事务删除 chat_workflow_actions，
   * 否则残留 request_id 会让后续同 requestId 的重试命中不一致的快照。
   */
  private deleteByTaskJsonValue(workspaceId: string, jsonPath: string, values: readonly string[]): ChatWorkflowCardRemoval {
    const keys = [...new Set(values.map(value => String(value ?? "").trim()).filter(Boolean))];
    if (!keys.length) return { taskIds: [], skippedInvalidJsonCount: 0 };
    return this.db.transaction(() => {
      const placeholders = keys.map(() => "?").join(", ");
      const skippedInvalidJsonCount = Number((this.db.prepare(
        "SELECT COUNT(1) AS count FROM chat_workflow_tasks WHERE workspace_id = ? AND NOT json_valid(task_json)").get(workspaceId) as { count: number } | undefined)?.count ?? 0);
      const taskIds = (this.db.prepare(`SELECT id FROM chat_workflow_tasks WHERE workspace_id = ? AND CASE WHEN json_valid(task_json) THEN json_extract(task_json, '${jsonPath}') END IN (${placeholders})`)
        .all(workspaceId, ...keys) as Array<{ id: string }>).map(row => String(row.id));
      if (!taskIds.length) return { taskIds, skippedInvalidJsonCount };
      this.deleteTaskIds(taskIds);
      return { taskIds, skippedInvalidJsonCount };
    })();
  }

  /**
   * 硬删单张卡片及其操作回执，返回是否命中（按 workspace_id + id 双重限定，不跨工作区误删）。
   * 未命中不伪装成功，由调用方显式失败。
   */
  deleteTask(workspaceId: string, taskId: string): boolean {
    const id = String(taskId ?? "").trim();
    if (!id) return false;
    return this.db.transaction(() => {
      const hit = this.db.prepare("SELECT 1 AS hit FROM chat_workflow_tasks WHERE workspace_id = ? AND id = ?").get(workspaceId, id);
      if (!hit) return false;
      this.deleteTaskIds([id]);
      return true;
    })();
  }

  /** 列出仍引用该需求的卡片 id，供删除前的「一卡一需求」引用校验使用；非法 JSON 行无法归属，不参与命中。 */
  listTaskIdsByIntakeId(workspaceId: string, intakeId: string): string[] {
    const key = String(intakeId ?? "").trim();
    if (!key) return [];
    const rows = this.db.prepare(`SELECT id FROM chat_workflow_tasks
      WHERE workspace_id = ? AND CASE WHEN json_valid(task_json) THEN json_extract(task_json, '$.intakeId') END = ?`).all(workspaceId, key) as Array<{ id: string }>;
    return rows.map(row => String(row.id));
  }

  /** 删除顺序契约只在这里维护：先删操作回执，再删卡片，调用方不得另写一份。 */
  private deleteTaskIds(taskIds: readonly string[]): void {
    const placeholders = taskIds.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM chat_workflow_actions WHERE task_id IN (${placeholders})`).run(...taskIds);
    this.db.prepare(`DELETE FROM chat_workflow_tasks WHERE id IN (${placeholders})`).run(...taskIds);
  }

  update(task: ChatWorkflowTask, expectedVersion: number): ChatWorkflowTask {
    const next = { ...task, version: expectedVersion + 1, updatedAt: Date.now() };
    const result = this.db.prepare("UPDATE chat_workflow_tasks SET instance_id = ?, state = ?, version = ?, task_json = ?, updated_at = ? WHERE id = ? AND version = ?")
      .run(next.instanceId, next.state, next.version, JSON.stringify(next), next.updatedAt, next.id, expectedVersion);
    if (!result.changes) throw Object.assign(new Error("工作流卡片已更新，请刷新后操作"), { code: "CHAT_WORKFLOW_VERSION_CONFLICT", status: 409 });
    return next;
  }
}
