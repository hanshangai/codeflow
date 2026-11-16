import type { SqliteDb } from "../sqliteTypes.js";
import type { LocalScheduledTaskConfig, WorkspaceId } from "@codeflowai/shared";
import { assertScheduledTaskAccountOwner, type ScheduledTaskAccountOwner } from "./scheduledTaskRunRepo.js";

export type ScheduledTaskMigrationQueueSkipReason = "task_deleted" | "task_disabled" | "workspace_changed";

const MIGRATION_SKIP_PENDING_PREFIX = "workspace_migration_skip_pending:";
const LOCAL_TASK_PREFIX = "__local_scheduled_task__:";
const ACCOUNT_TASK_PREFIX = "__account_scheduled_task__:";

/** 四字段 owner 与外部任务 ID 以 tuple 编码，不接管旧 bare key。 */
export function scheduledTaskAccountRuntimeKey(taskId: string, owner: ScheduledTaskAccountOwner): string {
  assertScheduledTaskAccountOwner(owner);
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("SCHEDULED_TASK_ACCOUNT_RUNTIME_INVALID");
  return ACCOUNT_TASK_PREFIX + JSON.stringify([owner.serverOrigin, owner.ownerUserId, owner.clientId, owner.deviceId, taskId]);
}

/** 本机来源仅编码持久 key；Server 原 key 和外部任务 ID 保持不变。 */
export function scheduledTaskRuntimeKey(taskId: string, source?: "local"): string {
  return source === "local" ? `${LOCAL_TASK_PREFIX}${taskId}` : taskId;
}

export type ScheduledTaskRuntimeState = {
  taskId: string;
  source?: "local" | "account";
  clientId: string;
  deviceId: string;
  lastScheduledAt: number | null;
  lastStartedAt: number | null;
  runningRunId: string | null;
  lastWorkflowInstanceId: string | null;
  lastWorkflowSequence: number | null;
  owner?: ScheduledTaskAccountOwner;
  lastConfigSyncAt: number | null;
  queuedScheduledAt: number | null;
  queuedReason: string | null;
  queuedOperationId: string | null;
  updatedAt: number;
};

type ScheduledTaskRuntimeStateRow = {
  task_id: string;
  client_id: string;
  device_id: string;
  last_scheduled_at: number | null;
  last_started_at: number | null;
  running_run_id: string | null;
  last_workflow_instance_id: string | null;
  last_workflow_sequence?: number | null;
  last_config_sync_at: number | null;
  queued_scheduled_at: number | null;
  queued_reason: string | null;
  queued_operation_id: string | null;
  updated_at: number;
};

/** 定时任务本地运行状态仓储，负责去重和运行中标记。 */
export class ScheduledTaskRuntimeStateRepo {
  /** 复用 ClientDb 持有的同一 SQLite 连接。 */
  constructor(private readonly db: SqliteDb, private readonly workspaceId: WorkspaceId | null = null) {}

  /** 读取单个任务运行状态。 */
  get(taskId: string): ScheduledTaskRuntimeState | null {
    const row = this.db.prepare("SELECT * FROM scheduled_task_runtime_states WHERE task_id = ?").get(taskId) as ScheduledTaskRuntimeStateRow | undefined;
    return row ? toState(row) : null;
  }

  /** 仅枚举本 client 的本机 key；应用库旧工作区须在 SQL 中证明后排除。 */
  listLocalDesktopReinstallStates(clientId: string): ScheduledTaskRuntimeState[] {
    if (typeof clientId !== "string" || !clientId.trim()) throw localReinstallConflict("", "reinstall_owner");
    return (this.db.prepare(`SELECT r.* FROM scheduled_task_runtime_states r
      WHERE r.client_id=? AND substr(r.task_id,1,?)=? ${this.workspaceId === null ? `AND NOT EXISTS (
        SELECT 1 FROM scheduled_task_configs c WHERE c.id=substr(r.task_id,?) AND c.workspace_scope_id IS NOT NULL)` : ""}
      ORDER BY r.task_id`).all(clientId, LOCAL_TASK_PREFIX.length, LOCAL_TASK_PREFIX,
      ...(this.workspaceId === null ? [LOCAL_TASK_PREFIX.length + 1] : [])) as ScheduledTaskRuntimeStateRow[]).map(toState);
  }

  /** 原本机 key 的设备 CAS；缺状态不创建，配置仓储负责成对归属与外层事务。 */
  rebindLocalDevice(input: { taskId: string; clientId: string; oldDeviceId: string; nextDeviceId: string }): void {
    if (![input.taskId, input.clientId, input.oldDeviceId, input.nextDeviceId].every(value => typeof value === "string" && value.trim())
      || input.oldDeviceId === input.nextDeviceId) throw localReinstallConflict(input.taskId, "reinstall_owner");
    const key = scheduledTaskRuntimeKey(input.taskId, "local"), state = this.get(key);
    if (!state) return;
    if (state.source !== "local" || state.clientId !== input.clientId
      || state.deviceId !== input.oldDeviceId && state.deviceId !== input.nextDeviceId) throw localReinstallConflict(input.taskId, "reinstall_owner");
    if (state.deviceId === input.nextDeviceId) return;
    const before = this.db.prepare("SELECT * FROM scheduled_task_runtime_states WHERE task_id=?").get(key) as Record<string, unknown>;
    const changed = this.db.prepare("UPDATE scheduled_task_runtime_states SET device_id=? WHERE task_id=? AND client_id=? AND device_id=?")
      .run(input.nextDeviceId, key, input.clientId, input.oldDeviceId);
    const saved = this.db.prepare("SELECT * FROM scheduled_task_runtime_states WHERE task_id=?").get(key) as Record<string, unknown> | undefined;
    if (Number(changed.changes) !== 1 || !saved
      || Object.entries(before).some(([field, value]) => saved[field] !== (field === "device_id" ? input.nextDeviceId : value))) {
      throw localReinstallConflict(input.taskId, "reinstall_write");
    }
    this.get(key);
  }

  /** 精确 tuple 读取先验证物理行，旧 bare key 不参与账号状态。 */
  getAccount(taskId: string, owner: ScheduledTaskAccountOwner): ScheduledTaskRuntimeState | null {
    return this.get(scheduledTaskAccountRuntimeKey(taskId, owner));
  }

  /** 实际物理库的全部账号事实仅用于快照检查，不授予执行或发送权。 */
  listAccountStates(owner?: ScheduledTaskAccountOwner): ScheduledTaskRuntimeState[] {
    if (owner) assertScheduledTaskAccountOwner(owner);
    const prefix = owner ? ACCOUNT_TASK_PREFIX + JSON.stringify([owner.serverOrigin, owner.ownerUserId, owner.clientId, owner.deviceId]).slice(0,-1) + "," : ACCOUNT_TASK_PREFIX;
    const rows = this.db.prepare(`SELECT * FROM scheduled_task_runtime_states WHERE substr(task_id,1,?)=? ORDER BY task_id`)
      .all(prefix.length, prefix) as ScheduledTaskRuntimeStateRow[];
    return rows.map(toState);
  }

  /** 同一次认领事务消费原迁移延期，不能将旧延期移到其他物理库。 */
  claimAccountQueued(input: { taskId: string; owner: ScheduledTaskAccountOwner; runId: string; scheduledAt: number; startedAt: number; operationId: string }): void {
    this.getAccount(input.taskId, input.owner);
    this.markMigrationQueuedStarted({ ...input, taskId: scheduledTaskAccountRuntimeKey(input.taskId, input.owner),
      clientId: input.owner.clientId, deviceId: input.owner.deviceId });
    if (this.getAccount(input.taskId, input.owner)?.runningRunId !== input.runId) throw accountRuntimeConflict(input.taskId, input.runId, "queue_claim");
  }

  /** 账号跳过保留已有 running 与流程指针，写入后严格核水位。 */
  skipAccount(input: { taskId: string; owner: ScheduledTaskAccountOwner; scheduledAt: number; at: number }): void {
    this.getAccount(input.taskId, input.owner);
    this.markSkipped({ ...input, taskId: scheduledTaskAccountRuntimeKey(input.taskId, input.owner), clientId: input.owner.clientId, deviceId: input.owner.deviceId });
    if (this.getAccount(input.taskId, input.owner)?.lastScheduledAt !== input.scheduledAt) throw accountRuntimeConflict(input.taskId, "", "skip");
  }

  /** 上一流程策略跳过时原子消费原迁移计划点，不伪造配置失效原因。 */
  consumeAccountMigrationSkipped(input: { taskId: string; owner: ScheduledTaskAccountOwner; scheduledAt: number; operationId: string; at: number }): void {
    this.getAccount(input.taskId, input.owner);
    const changed = this.db.prepare(`UPDATE scheduled_task_runtime_states SET last_scheduled_at=?,queued_scheduled_at=NULL,
      queued_reason=NULL,queued_operation_id=NULL,updated_at=? WHERE task_id=? AND client_id=? AND device_id=?
      AND running_run_id IS NULL AND queued_scheduled_at=? AND queued_reason='workspace_migration' AND queued_operation_id=?`)
      .run(input.scheduledAt, input.at, scheduledTaskAccountRuntimeKey(input.taskId, input.owner), input.owner.clientId, input.owner.deviceId, input.scheduledAt, input.operationId);
    if (Number(changed.changes) !== 1 || this.getAccount(input.taskId, input.owner)?.queuedScheduledAt !== null) throw accountRuntimeConflict(input.taskId, "", "queue_skip");
  }

  /** 指针仅由捕获 owner/run CAS 写入；脚本与跳过不修改独立顺序。 */
  updateAccountWorkflow(input: { taskId: string; owner: ScheduledTaskAccountOwner; runId: string; instanceId: string; sequence: number; at: number }): void {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || !input.instanceId.trim()) throw accountRuntimeConflict(input.taskId, input.runId, "workflow_sequence");
    this.getAccount(input.taskId, input.owner);
    const changed = this.db.prepare(`UPDATE scheduled_task_runtime_states SET last_workflow_instance_id=?,last_workflow_sequence=?,updated_at=?
      WHERE task_id=? AND client_id=? AND device_id=? AND running_run_id=?`).run(input.instanceId, input.sequence, input.at,
      scheduledTaskAccountRuntimeKey(input.taskId, input.owner), input.owner.clientId, input.owner.deviceId, input.runId);
    const state = this.getAccount(input.taskId, input.owner);
    if (Number(changed.changes) !== 1 || state?.lastWorkflowInstanceId !== input.instanceId || state.lastWorkflowSequence !== input.sequence) throw accountRuntimeConflict(input.taskId, input.runId, "workflow_pointer");
  }

  /** 仅列 Server 延期；本机记录不得进入 Server operation/删除收敛链。 */
  listMigrationQueued(): ScheduledTaskRuntimeState[] {
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_task_runtime_states
       WHERE queued_scheduled_at IS NOT NULL
         AND queued_operation_id IS NOT NULL
         AND substr(task_id, 1, ?) <> ?
         AND substr(task_id, 1, ?) <> ?
       ORDER BY queued_scheduled_at ASC, task_id ASC
    `).all(LOCAL_TASK_PREFIX.length, LOCAL_TASK_PREFIX, ACCOUNT_TASK_PREFIX.length, ACCOUNT_TASK_PREFIX) as ScheduledTaskRuntimeStateRow[];
    return rows.map(toState);
  }

  /** 当前 owner 原子认领，无条件旧 UPSERT 不得覆盖尚未终结运行。 */
  claimAccount(input: { taskId: string; owner: ScheduledTaskAccountOwner; runId: string; scheduledAt: number; startedAt: number }): void {
    const key = scheduledTaskAccountRuntimeKey(input.taskId, input.owner);
    this.getAccount(input.taskId, input.owner);
    const changed = this.db.prepare(`INSERT INTO scheduled_task_runtime_states
      (task_id, client_id, device_id, last_scheduled_at, last_started_at, running_run_id, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET last_scheduled_at=excluded.last_scheduled_at,last_started_at=excluded.last_started_at,
        running_run_id=excluded.running_run_id,updated_at=excluded.updated_at
      WHERE scheduled_task_runtime_states.running_run_id IS NULL AND scheduled_task_runtime_states.client_id=excluded.client_id
        AND scheduled_task_runtime_states.device_id=excluded.device_id`).run(key, input.owner.clientId, input.owner.deviceId, input.scheduledAt, input.startedAt, input.runId, input.startedAt);
    if (Number(changed.changes) !== 1 || this.get(key)?.runningRunId !== input.runId) throw Object.assign(new Error("账号定时任务运行认领冲突"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: input.taskId, runId: input.runId, field: "account_claim" });
  }

  /** 历史终态事务中精确清 owner/run；任何缺失或写入忽略均失败。 */
  finishAccount(input: { taskId: string; owner: ScheduledTaskAccountOwner; runId: string; finishedAt: number }): void {
    const key = scheduledTaskAccountRuntimeKey(input.taskId, input.owner);
    this.getAccount(input.taskId, input.owner);
    const changed = this.db.prepare(`UPDATE scheduled_task_runtime_states SET running_run_id=NULL,updated_at=?
      WHERE task_id=? AND client_id=? AND device_id=? AND running_run_id=?`).run(input.finishedAt, key, input.owner.clientId, input.owner.deviceId, input.runId);
    if (Number(changed.changes) !== 1 || this.get(key)?.runningRunId !== null) throw Object.assign(new Error("账号定时任务运行终结冲突"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: input.taskId, runId: input.runId, field: "account_finish" });
  }

  /** 从原 running 事实读取本设备本机活动，包含停用或删除配置的运行。 */
  listLocalRunning(input: { clientId: string; deviceId: string }): ScheduledTaskRuntimeState[] {
    const scope = this.workspaceId === null ? "c.workspace_scope_type IS NULL AND c.workspace_scope_id IS NULL"
      : "c.workspace_scope_type = 'local_workspace' AND c.workspace_scope_id = ?";
    return (this.db.prepare(`SELECT r.* FROM scheduled_task_runtime_states r LEFT JOIN scheduled_task_configs c
      ON c.id = substr(r.task_id, ?) WHERE r.client_id = ? AND r.device_id = ?
      AND r.running_run_id IS NOT NULL AND substr(r.task_id, 1, ?) = ? AND (c.id IS NULL OR (${scope})) ORDER BY r.task_id`).all(
      LOCAL_TASK_PREFIX.length + 1, input.clientId, input.deviceId, LOCAL_TASK_PREFIX.length, LOCAL_TASK_PREFIX,
      ...(this.workspaceId === null ? [] : [this.workspaceId]),
    ) as ScheduledTaskRuntimeStateRow[]).map(toState);
  }

  /** 停用或删除在配置事务内消费本机旧延期，保留已认领运行和 Server 同 ID 状态。 */
  consumeLocalQueuedOnConfigStop(config: LocalScheduledTaskConfig, at: number): void {
    if (config.enabled && config.deletedAt === null) return;
    const key = scheduledTaskRuntimeKey(config.id, "local");
    const queued = this.get(key);
    if (!queued || queued.queuedScheduledAt === null) return;
    if (queued.clientId !== config.clientId || queued.deviceId !== config.deviceId) {
      throw Object.assign(new Error("本机延期与配置设备不匹配"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: config.id, field: "queue_owner" });
    }
    if (queued.queuedReason !== "concurrency") parseMigrationSkipPendingReason(queued.queuedReason);
    const lastScheduledAt = Math.max(Math.floor((queued.lastScheduledAt ?? 0) / 60_000) * 60_000, queued.queuedScheduledAt);
    this.consumeLocalQueued(config, queued, at, lastScheduledAt);
  }

  /** 本机并发延期沿原列持久化，停用事务与重启可见同一个待触发事实。 */
  queueLocalConcurrency(input: { taskId: string; clientId: string; deviceId: string; runId: string; scheduledAt: number; at: number }): void {
    const key = scheduledTaskRuntimeKey(input.taskId, "local");
    const changed = this.db.prepare(`UPDATE scheduled_task_runtime_states
      SET queued_scheduled_at = ?, queued_reason = 'concurrency', queued_operation_id = NULL, updated_at = ?
      WHERE task_id = ? AND client_id = ? AND device_id = ? AND running_run_id = ? AND queued_scheduled_at IS NULL`).run(
      input.scheduledAt, input.at, key, input.clientId, input.deviceId, input.runId);
    if (Number(changed.changes) !== 1 || this.get(key)?.queuedScheduledAt !== input.scheduledAt) {
      throw Object.assign(new Error("本机并发延期写入未完成"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: input.taskId, field: "queue_concurrency" });
    }
  }

  /** 出队由 Scheduler 外层历史/认领事务调用，失败不能单独消费待触发事实。 */
  consumeLocalConcurrencyQueued(config: LocalScheduledTaskConfig, scheduledAt: number, at: number): void {
    const queued = this.get(scheduledTaskRuntimeKey(config.id, "local"));
    if (!queued || queued.runningRunId || queued.queuedReason !== "concurrency" || queued.queuedOperationId !== null
      || queued.queuedScheduledAt !== scheduledAt || queued.clientId !== config.clientId || queued.deviceId !== config.deviceId) {
      throw Object.assign(new Error("本机并发延期认领冲突"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: config.id, field: "queue_claim" });
    }
    this.consumeLocalQueued(config, queued, at);
  }

  /** 两种本机延期共用原子消费 SQL；保留 running 并记录已消费触发点。 */
  private consumeLocalQueued(config: LocalScheduledTaskConfig, queued: ScheduledTaskRuntimeState, at: number, lastScheduledAt = queued.queuedScheduledAt): void {
    const key = scheduledTaskRuntimeKey(config.id, "local");
    const changed = this.db.prepare(`UPDATE scheduled_task_runtime_states
      SET last_scheduled_at = ?,
        queued_scheduled_at = NULL, queued_reason = NULL, queued_operation_id = NULL, updated_at = ?
      WHERE task_id = ? AND client_id = ? AND device_id = ? AND queued_scheduled_at = ?
        AND queued_reason IS ? AND queued_operation_id IS ?`).run(lastScheduledAt, at,
      key, config.clientId, config.deviceId, queued.queuedScheduledAt, queued.queuedReason, queued.queuedOperationId);
    if (Number(changed.changes) !== 1 || this.get(key)?.queuedScheduledAt !== null) {
      throw Object.assign(new Error("本机延期消费未完成"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: config.id, field: "queue_consume" });
    }
  }

  /** 为 queue_one 持久化一次迁移延期；同任务只保留最早尚未认领的触发。 */
  queueForWorkspaceMigration(input: {
    taskId: string;
    clientId: string;
    deviceId: string;
    scheduledAt: number;
    operationId: string;
    at: number;
  }): ScheduledTaskRuntimeState {
    const existing = this.get(input.taskId);
    if (
      existing?.queuedOperationId
      && (existing.queuedReason !== "workspace_migration" || existing.queuedOperationId !== input.operationId)
    ) {
      throw new Error(
        `定时任务已有其他延期 owner：taskId=${input.taskId}, queuedOperationId=${existing.queuedOperationId}`,
      );
    }
    this.db.prepare(`
      INSERT INTO scheduled_task_runtime_states (
        task_id, client_id, device_id, queued_scheduled_at, queued_reason, queued_operation_id, updated_at
      ) VALUES (?, ?, ?, ?, 'workspace_migration', ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        client_id = excluded.client_id,
        device_id = excluded.device_id,
        queued_scheduled_at = CASE
          WHEN scheduled_task_runtime_states.queued_scheduled_at IS NULL
            OR excluded.queued_scheduled_at < scheduled_task_runtime_states.queued_scheduled_at
          THEN excluded.queued_scheduled_at
          ELSE scheduled_task_runtime_states.queued_scheduled_at
        END,
        queued_reason = 'workspace_migration',
        queued_operation_id = excluded.queued_operation_id,
        updated_at = excluded.updated_at
    `).run(
      input.taskId,
      input.clientId,
      input.deviceId,
      input.scheduledAt,
      input.operationId,
      input.at,
    );
    const queued = this.get(input.taskId);
    if (!queued || queued.queuedReason !== "workspace_migration" || queued.queuedOperationId !== input.operationId) {
      throw new Error(`定时任务迁移延期持久化失败：taskId=${input.taskId}, operationId=${input.operationId}`);
    }
    return queued;
  }

  /** 标记配置同步完成。 */
  touchConfigSync(input: { clientId: string; deviceId: string; at: number }): void {
    this.db.prepare(`
      INSERT INTO scheduled_task_runtime_states (
        task_id, client_id, device_id, last_config_sync_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        last_config_sync_at = excluded.last_config_sync_at,
        updated_at = excluded.updated_at
    `).run(`__sync__${input.clientId}__${input.deviceId}`, input.clientId, input.deviceId, input.at, input.at);
  }

  /** 标记某个计划时间已开始执行。 */
  markStarted(input: { taskId: string; clientId: string; deviceId: string; scheduledAt: number; runId: string; startedAt: number }): void {
    this.db.prepare(`
      INSERT INTO scheduled_task_runtime_states (
        task_id, client_id, device_id, last_scheduled_at, last_started_at, running_run_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        client_id = excluded.client_id,
        device_id = excluded.device_id,
        last_scheduled_at = excluded.last_scheduled_at,
        last_started_at = excluded.last_started_at,
        running_run_id = excluded.running_run_id,
        updated_at = excluded.updated_at
    `).run(input.taskId, input.clientId, input.deviceId, input.scheduledAt, input.startedAt, input.runId, input.startedAt);
  }

  /** 原子认领匹配 operation 的迁移延期，并同时写入计划时间与 running run。 */
  markMigrationQueuedStarted(input: {
    taskId: string;
    clientId: string;
    deviceId: string;
    scheduledAt: number;
    operationId: string;
    runId: string;
    startedAt: number;
  }): void {
    const changed = this.db.prepare(`
      UPDATE scheduled_task_runtime_states
         SET client_id = ?, device_id = ?, last_scheduled_at = ?, last_started_at = ?,
             running_run_id = ?, queued_scheduled_at = NULL, queued_reason = NULL,
             queued_operation_id = NULL, updated_at = ?
       WHERE task_id = ? AND running_run_id IS NULL
         AND queued_scheduled_at = ? AND queued_reason = 'workspace_migration'
         AND queued_operation_id = ?
    `).run(
      input.clientId,
      input.deviceId,
      input.scheduledAt,
      input.startedAt,
      input.runId,
      input.startedAt,
      input.taskId,
      input.scheduledAt,
      input.operationId,
    );
    if (Number(changed.changes ?? 0) !== 1) {
      throw new Error(`定时任务迁移延期认领冲突：taskId=${input.taskId}, operationId=${input.operationId}`);
    }
  }

  /** 原子持久化迁移延期的 skipped 决策，之后只允许补偿上报或完成清理。 */
  markMigrationQueuedSkipPending(input: {
    taskId: string;
    clientId: string;
    deviceId: string;
    scheduledAt: number;
    operationId: string;
    skipReason: ScheduledTaskMigrationQueueSkipReason;
    at: number;
  }): void {
    const queuedReason = toMigrationSkipPendingReason(input.skipReason);
    const changed = this.db.prepare(`
      UPDATE scheduled_task_runtime_states
         SET client_id = ?, device_id = ?, last_scheduled_at = ?,
             queued_reason = ?, updated_at = ?
       WHERE task_id = ? AND running_run_id IS NULL
         AND queued_scheduled_at = ? AND queued_reason = 'workspace_migration'
         AND queued_operation_id = ?
    `).run(
      input.clientId,
      input.deviceId,
      input.scheduledAt,
      queuedReason,
      input.at,
      input.taskId,
      input.scheduledAt,
      input.operationId,
    );
    if (Number(changed.changes ?? 0) !== 1) {
      throw new Error(`定时任务迁移延期 skipped 决策冲突：taskId=${input.taskId}, operationId=${input.operationId}`);
    }
  }

  /** 完成已持久化 skipped 决策；匹配原因与 owner 后清除延期字段。 */
  completeMigrationQueuedSkip(input: {
    taskId: string;
    scheduledAt: number;
    operationId: string;
    skipReason: ScheduledTaskMigrationQueueSkipReason;
    at: number;
  }): void {
    const queuedReason = toMigrationSkipPendingReason(input.skipReason);
    const changed = this.db.prepare(`
      UPDATE scheduled_task_runtime_states
         SET last_scheduled_at = ?, queued_scheduled_at = NULL, queued_reason = NULL,
             queued_operation_id = NULL, updated_at = ?
       WHERE task_id = ? AND running_run_id IS NULL
         AND queued_scheduled_at = ? AND queued_reason = ?
         AND queued_operation_id = ?
    `).run(
      input.scheduledAt,
      input.at,
      input.taskId,
      input.scheduledAt,
      queuedReason,
      input.operationId,
    );
    if (Number(changed.changes ?? 0) !== 1) {
      throw new Error(`定时任务迁移延期 skipped 完成冲突：taskId=${input.taskId}, operationId=${input.operationId}`);
    }
  }

  /** 标记某个计划时间已处理但未启动运行，避免同一 cron 窗口重复跳过上报。 */
  markSkipped(input: { taskId: string; clientId: string; deviceId: string; scheduledAt: number; at: number }): void {
    this.db.prepare(`
      INSERT INTO scheduled_task_runtime_states (
        task_id, client_id, device_id, last_scheduled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        client_id = excluded.client_id,
        device_id = excluded.device_id,
        last_scheduled_at = excluded.last_scheduled_at,
        updated_at = excluded.updated_at
    `).run(input.taskId, input.clientId, input.deviceId, input.scheduledAt, input.at);
  }

  /** 更新最近一次工作流实例 ID；实例创建后立即写入，供后续自动调度判断。 */
  updateLastWorkflowInstance(input: { taskId: string; clientId: string; deviceId: string; instanceId: string; at: number }): void {
    this.db.prepare(`
      INSERT INTO scheduled_task_runtime_states (
        task_id, client_id, device_id, last_workflow_instance_id, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        client_id = excluded.client_id,
        device_id = excluded.device_id,
        last_workflow_instance_id = excluded.last_workflow_instance_id,
        updated_at = excluded.updated_at
    `).run(input.taskId, input.clientId, input.deviceId, input.instanceId, input.at);
  }

  /** 清理运行中标记，保留最近计划时间用于重启去重。 */
  markFinished(input: { taskId: string; runId: string; finishedAt: number }): void {
    this.db.prepare(`
      UPDATE scheduled_task_runtime_states
      SET running_run_id = NULL, updated_at = ?
      WHERE task_id = ? AND running_run_id = ?
    `).run(input.finishedAt, input.taskId, input.runId);
  }
}

/** 解析持久化的迁移延期 skipped 决策；普通延期返回 null，非法值显式失败。 */
export function parseMigrationSkipPendingReason(value: string | null): ScheduledTaskMigrationQueueSkipReason | null {
  if (value === "workspace_migration") return null;
  if (!value?.startsWith(MIGRATION_SKIP_PENDING_PREFIX)) {
    throw new Error(`定时任务迁移延期原因损坏：${String(value)}`);
  }
  const reason = value.slice(MIGRATION_SKIP_PENDING_PREFIX.length);
  if (reason === "task_deleted" || reason === "task_disabled" || reason === "workspace_changed") {
    return reason;
  }
  throw new Error(`定时任务迁移延期 skipped 原因损坏：${value}`);
}

/** 编码迁移延期 skipped 决策，保持 SQLite 字段可直接排障。 */
function toMigrationSkipPendingReason(reason: ScheduledTaskMigrationQueueSkipReason): string {
  return `${MIGRATION_SKIP_PENDING_PREFIX}${reason}`;
}

/** 还原外部任务 ID，来源由内部编码识别，不授予配置执行权限。 */
function toState(row: ScheduledTaskRuntimeStateRow): ScheduledTaskRuntimeState {
  const local = row.task_id.startsWith(LOCAL_TASK_PREFIX);
  const account = row.task_id.startsWith(ACCOUNT_TASK_PREFIX);
  let accountTaskId: string | null = null;
  let accountOwner: ScheduledTaskAccountOwner | undefined;
  if (account) {
    const tuple: unknown = JSON.parse(row.task_id.slice(ACCOUNT_TASK_PREFIX.length));
    if (!Array.isArray(tuple) || tuple.length !== 5 || tuple.some(value => typeof value !== "string" || !value.trim())
      || tuple[2] !== row.client_id || tuple[3] !== row.device_id) throw new Error("SCHEDULED_TASK_ACCOUNT_RUNTIME_CORRUPT");
    const owner = { serverOrigin: tuple[0], ownerUserId: tuple[1], clientId: tuple[2], deviceId: tuple[3] };
    if (scheduledTaskAccountRuntimeKey(tuple[4], owner) !== row.task_id) throw new Error("SCHEDULED_TASK_ACCOUNT_RUNTIME_CORRUPT");
    accountTaskId = tuple[4];
    accountOwner = owner;
    if ([row.running_run_id, row.last_workflow_instance_id].some(value => value !== null && (typeof value !== "string" || !value.trim()))) throw accountRuntimeConflict(tuple[4], row.running_run_id ?? "", "runtime_id");
    if (row.queued_scheduled_at === null ? row.queued_reason !== null || row.queued_operation_id !== null
      : typeof row.queued_operation_id !== "string" || !row.queued_operation_id.trim()
        || row.queued_reason !== "workspace_migration" && parseMigrationSkipPendingReason(row.queued_reason) === null) throw accountRuntimeConflict(tuple[4], row.running_run_id ?? "", "queue");
  }
  const sequence = nullableNumber(row.last_workflow_sequence);
  if (sequence !== null && (!account || sequence < 1 || !row.last_workflow_instance_id)
    || account && row.last_workflow_instance_id !== null && sequence === null) throw accountRuntimeConflict(accountTaskId ?? row.task_id, row.running_run_id ?? "", "workflow_sequence");
  const queuedScheduledAt = nullableNumber(row.queued_scheduled_at);
  if (local && !(queuedScheduledAt === null ? row.queued_reason === null && row.queued_operation_id === null
    : row.queued_reason === "concurrency" && row.queued_operation_id === null
      || row.queued_reason === "workspace_migration" && typeof row.queued_operation_id === "string" && row.queued_operation_id.trim().length > 0)) {
    throw Object.assign(new Error("本机定时任务持久队列损坏"), {
      code: "SCHEDULED_TASK_RUNTIME_CORRUPT", taskId: row.task_id.slice(LOCAL_TASK_PREFIX.length), field: "queue",
    });
  }
  return {
    taskId: local ? row.task_id.slice(LOCAL_TASK_PREFIX.length) : accountTaskId ?? row.task_id,
    ...(local ? { source: "local" as const } : account ? { source: "account" as const } : {}),
    clientId: row.client_id,
    deviceId: row.device_id,
    lastScheduledAt: nullableNumber(row.last_scheduled_at),
    lastStartedAt: nullableNumber(row.last_started_at),
    runningRunId: row.running_run_id ?? null,
    lastWorkflowInstanceId: row.last_workflow_instance_id ?? null,
    lastWorkflowSequence: sequence,
    ...(accountOwner ? { owner: accountOwner } : {}),
    lastConfigSyncAt: nullableNumber(row.last_config_sync_at),
    queuedScheduledAt,
    queuedReason: row.queued_reason ?? null,
    queuedOperationId: row.queued_operation_id ?? null,
    updatedAt: Number(row.updated_at),
  };
}

/** SQLite 时间与顺序值只接受非负安全整数。 */
function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`定时任务运行状态时间字段损坏：${String(value)}`);
  }
  return numeric;
}

/** 统一账号事实冲突字段，正文与 SQL 不进入异常上下文。 */
function accountRuntimeConflict(taskId: string, runId: string, field: string): Error {
  return Object.assign(new Error("账号定时任务运行事实冲突"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId, runId, field });
}

/** 接续冲突保任务定位，原错误由调用事务向上交给维护边界记录。 */
function localReinstallConflict(taskId: string, field: string): Error {
  return Object.assign(new Error("本机定时任务重装接续冲突"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId, field });
}
