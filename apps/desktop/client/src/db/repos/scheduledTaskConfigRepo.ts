import {
  assertValidTimeZone,
  isScheduledTaskWorkflowSkipStatus,
  validateCronExpression,
  type LocalScheduledTaskConfig,
  type LocalScheduledTaskConfigInput,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import { scheduledTaskRuntimeKey, type ScheduledTaskRuntimeStateRepo } from "./scheduledTaskRuntimeStateRepo.js";

type ConfigErrorCode = "SCHEDULED_TASK_CONFIG_INVALID" | "SCHEDULED_TASK_CONFIG_CORRUPT"
  | "SCHEDULED_TASK_CONFIG_CONFLICT" | "SCHEDULED_TASK_CONFIG_OWNERSHIP_IMMUTABLE" | "SCHEDULED_TASK_CONFIG_STORAGE_FAILED";
type Device = Pick<LocalScheduledTaskConfigInput, "clientId" | "deviceId">;
type Mutation = { taskId: string; expectedRevision: number; at: number };

export class ScheduledTaskConfigError extends Error {
  /** 固定错误码和实体上下文，不把配置正文或解析异常原文带出仓储。 */
  constructor(readonly code: ConfigErrorCode, readonly taskId: string, readonly field: string,
    readonly rootCauseCode?: string) {
    super(`${code}: taskId=${taskId}, field=${field}`);
    this.name = "ScheduledTaskConfigError";
  }
}

export class ScheduledTaskConfigRepo {
  /** 复用同连接的原 runtime 仓储；配置与停止延期消费必须同事务。 */
  constructor(private readonly db: SqliteDb, private readonly runtime: ScheduledTaskRuntimeStateRepo,
    readonly workspaceId: WorkspaceId | null = null) {}

  /** 物理 scope 在 SQL 解码前限定，旧应用库工作区行不参与读取。 */
  get scopeSql(): string {
    return this.workspaceId === null ? "workspace_scope_type IS NULL AND workspace_scope_id IS NULL"
      : "workspace_scope_type = 'local_workspace' AND workspace_scope_id = ?";
  }

  /** 仅传固定注册工作区 ID，不从 payload 或请求推断 SQL 条件。 */
  get scopeParams(): string[] { return this.workspaceId === null ? [] : [this.workspaceId]; }

  /** 重装接续在原配置事务内只迁移设备归属。 */
  rebindDesktopDevice(input: { taskId: string; clientId: string; oldDeviceId: string; nextDeviceId: string }): boolean {
    if (![input.taskId, input.clientId, input.oldDeviceId, input.nextDeviceId].every(nonempty)
      || input.oldDeviceId === input.nextDeviceId) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", input.taskId, "reinstall_owner");
    return this.execute(input.taskId, "rebindDesktopDevice", () => this.db.transaction(() => {
      const config = this.get(input.taskId), runtime = this.runtime.get(scheduledTaskRuntimeKey(input.taskId, "local"));
      if (!config || config.clientId !== input.clientId
        || config.deviceId !== input.oldDeviceId && config.deviceId !== input.nextDeviceId
        || runtime && (runtime.source !== "local" || runtime.clientId !== config.clientId || runtime.deviceId !== config.deviceId)) {
        throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", input.taskId, "reinstall_owner");
      }
      if (config.deviceId === input.nextDeviceId) return false;
      const before = this.db.prepare("SELECT * FROM scheduled_task_configs WHERE id=?").get(input.taskId) as Record<string, unknown>;
      const key = scheduledTaskRuntimeKey(input.taskId, "local");
      const runtimeBefore = this.db.prepare("SELECT * FROM scheduled_task_runtime_states WHERE task_id=?").get(key) as Record<string, unknown> | undefined;
      const changed = this.db.prepare(`UPDATE scheduled_task_configs SET device_id=?
        WHERE id=? AND client_id=? AND device_id=? AND ${this.scopeSql}`)
        .run(input.nextDeviceId, input.taskId, input.clientId, input.oldDeviceId, ...this.scopeParams);
      if (Number(changed.changes) !== 1) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", input.taskId, "reinstall_owner");
      this.runtime.rebindLocalDevice(input);
      this.requireSaved(input.taskId);
      const saved = this.db.prepare("SELECT * FROM scheduled_task_configs WHERE id=?").get(input.taskId) as Record<string, unknown>;
      const runtimeSaved = this.db.prepare("SELECT * FROM scheduled_task_runtime_states WHERE task_id=?").get(key) as Record<string, unknown> | undefined;
      if (Object.entries(before).some(([field, value]) => saved[field] !== (field === "device_id" ? input.nextDeviceId : value))
        || (runtimeBefore ? !runtimeSaved || Object.entries(runtimeBefore).some(([field, value]) => runtimeSaved[field] !== (field === "device_id" ? input.nextDeviceId : value)) : runtimeSaved !== undefined)) {
        throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", input.taskId, "reinstall_write");
      }
      return true;
    })());
  }

  /** 接续预检先由 SQL 限定当前 client/scope，墓碑与第三设备仍严格校验。 */
  listDesktopReinstallCandidates(input: { clientId: string; oldDeviceId: string; nextDeviceId: string }): LocalScheduledTaskConfig[] {
    if (![input.clientId, input.oldDeviceId, input.nextDeviceId].every(nonempty) || input.oldDeviceId === input.nextDeviceId) {
      throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", "", "reinstall_owner");
    }
    return this.execute("", "listDesktopReinstallCandidates", () => {
      this.assertApplicationScopePair("client_id=?", [input.clientId]);
      if (this.workspaceId !== null) {
        const invalid = this.db.prepare(`SELECT id FROM scheduled_task_configs WHERE client_id=?
          AND NOT (workspace_scope_type IS 'local_workspace' AND workspace_scope_id IS ?) LIMIT 1`)
          .get(input.clientId, this.workspaceId) as { id: string } | undefined;
        if (invalid) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", invalid.id, "reinstall_scope");
      }
      return this.db.prepare(`SELECT * FROM scheduled_task_configs WHERE client_id=? AND ${this.scopeSql} ORDER BY id`)
        .all(input.clientId, ...this.scopeParams).map(row => {
          const config = decodeConfig(row as Record<string, unknown>);
          if (config.deviceId !== input.oldDeviceId && config.deviceId !== input.nextDeviceId) {
            throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", config.id, "reinstall_owner");
          }
          return config;
        });
    });
  }

  /** 新建本机配置；同 ID 包括墓碑均拒绝覆盖。 */
  create(input: { config: LocalScheduledTaskConfigInput; at: number }): LocalScheduledTaskConfig {
    assertConfig(input.config);
    if ((input.config.workspaceScope?.scopeId ?? null) !== this.workspaceId) {
      throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_OWNERSHIP_IMMUTABLE", input.config.id, "ownership");
    }
    assertTimestamp(input.at, input.config.id);
    const payload = encodePayload(input.config);
    return this.execute(input.config.id, "create", () => this.db.transaction(() => {
      if (this.get(input.config.id)) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", input.config.id, "id");
      const config = input.config;
      this.db.prepare(`INSERT INTO scheduled_task_configs (
        id, source, client_id, device_id, workspace_scope_type, workspace_scope_id,
        name, description, task_type, cron_expr, timezone, enabled, payload_json,
        concurrency_policy, missed_policy, timeout_ms, revision, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`).run(
        config.id, config.source, config.clientId, config.deviceId,
        config.workspaceScope?.scopeType ?? null, config.workspaceScope?.scopeId ?? null,
        config.name, config.description, config.taskType, config.cronExpr, config.timezone, config.enabled,
        payload, config.concurrencyPolicy, config.missedPolicy, config.timeoutMs, input.at, input.at,
      );
      return this.requireSaved(config.id);
    })());
  }

  /** 读取完整证据，包含已删除记录；不存在才返回 null。 */
  get(taskId: string): LocalScheduledTaskConfig | null {
    if (!nonempty(taskId)) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", "", "id");
    return this.execute(taskId, "get", () => {
      this.assertApplicationScopePair("id = ?", [taskId]);
      const row = this.db.prepare(`SELECT * FROM scheduled_task_configs WHERE id = ? AND ${this.scopeSql}`).get(taskId, ...this.scopeParams);
      return row === undefined ? null : decodeConfig(row as Record<string, unknown>);
    });
  }

  /** 定位仅读身份并复用原存储错误边界；应用坏 scope 配对留给唯一配置严格解码。 */
  getIdentity(taskId: string): Pick<LocalScheduledTaskConfig, "clientId" | "deviceId"> | null {
    if (!nonempty(taskId)) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", "", "id");
    return this.execute(taskId, "getIdentity", () => {
      const row = this.db.prepare(`SELECT client_id,device_id FROM scheduled_task_configs
        WHERE id = ? AND ${this.workspaceId === null ? "workspace_scope_id IS NULL" : this.scopeSql}`)
        .get(taskId, ...this.scopeParams) as { client_id: string; device_id: string } | undefined;
      return row === undefined ? null : { clientId: row.client_id, deviceId: row.device_id };
    });
  }

  /** 读取设备的未删除配置；筛选前严格校验包括墓碑在内的原始记录。 */
  list(device: Device, includeDeleted = false): LocalScheduledTaskConfig[] {
    if (!nonempty(device.clientId) || !nonempty(device.deviceId)) {
      throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", "", "device");
    }
    return this.execute("", "list", () => {
      this.assertApplicationScopePair("client_id = ? AND device_id = ?", [device.clientId, device.deviceId]);
      return this.db.prepare(`SELECT * FROM scheduled_task_configs
      WHERE client_id = ? AND device_id = ? AND ${this.scopeSql} ORDER BY updated_at DESC, id ASC`).all(device.clientId, device.deviceId, ...this.scopeParams)
        .map((row) => decodeConfig(row as Record<string, unknown>)).filter((config) => includeDeleted || config.deletedAt === null);
    });
  }

  /** 仅诊断应用当前行缺 ID 的非法 scope 配对；不读任何有 scope_id 的旧工作区正文。 */
  private assertApplicationScopePair(where: string, params: string[]): void {
    if (this.workspaceId !== null) return;
    const invalid = this.db.prepare(`SELECT id,workspace_scope_type,workspace_scope_id FROM scheduled_task_configs
      WHERE workspace_scope_id IS NULL AND workspace_scope_type IS NOT NULL AND ${where} LIMIT 1`).get(...params) as {id:string}|undefined;
    if (invalid) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CORRUPT",invalid.id,"workspaceScope");
  }

  /** 仅返回当前启用且未删除的本机配置，不推断云端或账号授权。 */
  listSchedulable(device: Device): LocalScheduledTaskConfig[] {
    return this.list(device).filter((config) => config.enabled);
  }

  /** 按修订原子编辑；Client、设备和工作区归属创建后固定。 */
  update(input: { config: LocalScheduledTaskConfigInput; expectedRevision: number; at: number }): LocalScheduledTaskConfig {
    assertConfig(input.config);
    const config = input.config;
    const payload = encodePayload(config);
    return this.mutate({ taskId: config.id, expectedRevision: input.expectedRevision, at: input.at }, (existing) => {
      if (existing.clientId !== config.clientId || existing.deviceId !== config.deviceId
        || existing.workspaceScope?.scopeType !== config.workspaceScope?.scopeType
        || existing.workspaceScope?.scopeId !== config.workspaceScope?.scopeId) {
        throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_OWNERSHIP_IMMUTABLE", config.id, "ownership");
      }
      return this.db.prepare(`UPDATE scheduled_task_configs SET
        name = ?, description = ?, task_type = ?, cron_expr = ?, timezone = ?, enabled = ?, payload_json = ?,
        concurrency_policy = ?, missed_policy = ?, timeout_ms = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND deleted_at IS NULL`).run(
        config.name, config.description, config.taskType, config.cronExpr, config.timezone, config.enabled, payload,
        config.concurrencyPolicy, config.missedPolicy, config.timeoutMs, input.at, config.id, input.expectedRevision,
      ).changes;
    });
  }

  /** 按修订原子启停，不允许改变已删除记录。 */
  setEnabled(input: Mutation & { enabled: boolean }): LocalScheduledTaskConfig {
    if (typeof input.enabled !== "boolean") throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", input.taskId, "enabled");
    return this.mutate(input, () => this.db.prepare(`UPDATE scheduled_task_configs
      SET enabled = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL`).run(input.enabled, input.at, input.taskId, input.expectedRevision).changes);
  }

  /** 按修订写删除墓碑并停用，原配置正文与创建时间保留。 */
  delete(input: Mutation): LocalScheduledTaskConfig {
    return this.mutate(input, () => this.db.prepare(`UPDATE scheduled_task_configs
      SET enabled = 0, deleted_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL`).run(input.at, input.at, input.taskId, input.expectedRevision).changes);
  }

  /** CAS 写入后同步消费停删配置的旧延期，任何消费失败撤销整个配置事务。 */
  private mutate(input: Mutation, write: (existing: LocalScheduledTaskConfig) => number | bigint | undefined): LocalScheduledTaskConfig {
    assertTimestamp(input.at, input.taskId);
    if (!integer(input.expectedRevision, 1)) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", input.taskId, "expectedRevision");
    return this.execute(input.taskId, "mutate", () => this.db.transaction(() => {
      const existing = this.get(input.taskId);
      if (!existing || existing.deletedAt !== null || existing.revision !== input.expectedRevision) {
        throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", input.taskId, "revision");
      }
      if (input.at < existing.updatedAt || existing.revision >= Number.MAX_SAFE_INTEGER) {
        throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", input.taskId, "revision_or_time");
      }
      if (Number(write(existing)) !== 1) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", input.taskId, "revision");
      const saved = this.requireSaved(input.taskId);
      this.runtime.consumeLocalQueuedOnConfigStop(saved, input.at);
      return saved;
    })());
  }

  /** 写后回读必须存在且合法，否则由外层事务撤销写入。 */
  private requireSaved(taskId: string): LocalScheduledTaskConfig {
    const saved = this.get(taskId);
    if (!saved) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_STORAGE_FAILED", taskId, "read_after_write");
    return saved;
  }

  /** SQLite 失败显式抛出固定码，只保留驱动原因码，避免触发器正文泄漏配置。 */
  private execute<T>(taskId: string, operation: string, action: () => T): T {
    try { return action(); } catch (error) {
      if (error instanceof ScheduledTaskConfigError) throw error;
      const cause = error as { code?: unknown; errcode?: unknown } | null;
      const driverCode = typeof cause?.code === "string" && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : "SQLITE_ERROR";
      throw Object.assign(new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_STORAGE_FAILED", taskId, operation,
        `${driverCode}${Number.isSafeInteger(cause?.errcode) ? `:${cause!.errcode}` : ""}`), { cause: error });
    }
  }
}

/** 校验复用任务字段及本机范围，不给坏值补默认配置。 */
function assertConfig(config: Omit<LocalScheduledTaskConfigInput, "payload"> & { payload: unknown },
  code: ConfigErrorCode = "SCHEDULED_TASK_CONFIG_INVALID"): void {
  const taskId = nonempty(config?.id) ? config.id : "";
  const check = (valid: boolean, field: string): void => {
    if (!valid) throw new ScheduledTaskConfigError(code, taskId, field);
  };
  check(record(config), "config");
  check(nonempty(config.id) && nonempty(config.clientId) && nonempty(config.deviceId), "identity");
  check(config.source === "local" && !("ownerUserId" in config), "source");
  check(nonempty(config.name) && (config.description === null || typeof config.description === "string"), "name_or_description");
  check(config.taskType === "script" || config.taskType === "workflow", "taskType");
  check(nonempty(config.cronExpr) && validateCronExpression(config.cronExpr).ok, "cronExpr");
  check(nonempty(config.timezone) && config.timezone === config.timezone.trim(), "timezone");
  try { assertValidTimeZone(config.timezone); } catch { throw new ScheduledTaskConfigError(code, taskId, "timezone"); }
  check(typeof config.enabled === "boolean", "enabled");
  check(config.concurrencyPolicy === "skip_if_running" || config.concurrencyPolicy === "queue_one", "concurrencyPolicy");
  check(config.missedPolicy === "skip_missed" || config.missedPolicy === "run_once_on_reconnect", "missedPolicy");
  check(integer(config.timeoutMs, 1) && config.timeoutMs <= 86_400_000, "timeoutMs");
  const scope = config.workspaceScope;
  check(scope === null || record(scope) && scope.scopeType === "local_workspace" && nonempty(scope.scopeId), "workspaceScope");
  const payload = config.payload as unknown as Record<string, unknown>;
  check(record(payload), "payload");
  const context = payload.contextWorkspaceId;
  check(context === undefined || context === null || nonempty(context), "payload.contextWorkspaceId");
  check((scope?.scopeId ?? null) === (context ?? null), "workspaceScope.contextWorkspaceId");
  if (config.taskType === "script") {
    check(["powershell", "cmd", "bash", "sh"].includes(payload.shell as string), "payload.shell");
    check(nonempty(payload.command), "payload.command");
    check(payload.cwdRelative == null || typeof payload.cwdRelative === "string", "payload.cwdRelative");
    check(payload.envRefs == null || Array.isArray(payload.envRefs) && payload.envRefs.every(
      (item) => nonempty(item) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item)), "payload.envRefs");
  } else {
    check(nonempty(payload.workflowId) && nonempty(context) && scope !== null, "payload.workflow");
    check(payload.workflowVersionPolicy == null || payload.workflowVersionPolicy === "latest", "payload.workflowVersionPolicy");
    check(payload.intake == null || record(payload.intake), "payload.intake");
    check(payload.runMode == null || payload.runMode === "normal", "payload.runMode");
    check(payload.approvalMode == null || payload.approvalMode === "default", "payload.approvalMode");
    check(payload.interactionMode == null || payload.interactionMode === "guided" || payload.interactionMode === "unattended", "payload.interactionMode");
    check(payload.skipWhenPreviousInstanceStatuses == null || Array.isArray(payload.skipWhenPreviousInstanceStatuses)
      && payload.skipWhenPreviousInstanceStatuses.every(isScheduledTaskWorkflowSkipStatus), "payload.skipWhenPreviousInstanceStatuses");
  }
}

/** JSON 编码失败或自定义 toJSON 破坏字段时，在写入前显式拒绝。 */
function encodePayload(config: LocalScheduledTaskConfigInput): string {
  let payload: string;
  let decoded: unknown;
  try {
    payload = JSON.stringify(config.payload);
    decoded = JSON.parse(payload);
  } catch { throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", config.id, "payload_json"); }
  assertConfig({ ...config, payload: decoded });
  return payload;
}

/** 严格解码 SQLite 原值，损坏 JSON/布尔/时间不转换成成功默认值。 */
function decodeConfig(row: Record<string, unknown>): LocalScheduledTaskConfig {
  const taskId = nonempty(row.id) ? row.id : "";
  const fail = (field: string): never => { throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CORRUPT", taskId, field); };
  if (row.enabled !== 0 && row.enabled !== 1) fail("enabled");
  if (!integer(row.revision, 1) || !integer(row.created_at) || !integer(row.updated_at)
    || Number(row.updated_at) < Number(row.created_at)
    || row.deleted_at !== null && (!integer(row.deleted_at) || row.deleted_at !== row.updated_at || row.enabled !== 0)) fail("revision_or_time");
  let payload: unknown;
  try {
    if (typeof row.payload_json !== "string") fail("payload_json");
    payload = JSON.parse(row.payload_json as string);
  } catch { fail("payload_json"); }
  const config = {
    id: row.id, source: row.source, clientId: row.client_id, deviceId: row.device_id,
    workspaceScope: row.workspace_scope_type === null && row.workspace_scope_id === null ? null : {
      scopeType: row.workspace_scope_type, scopeId: row.workspace_scope_id,
    },
    name: row.name, description: row.description, taskType: row.task_type, cronExpr: row.cron_expr, timezone: row.timezone,
    enabled: row.enabled === 1, payload, concurrencyPolicy: row.concurrency_policy, missedPolicy: row.missed_policy, timeoutMs: row.timeout_ms,
    revision: row.revision, deletedAt: row.deleted_at, createdAt: row.created_at, updatedAt: row.updated_at,
  } as LocalScheduledTaskConfig;
  assertConfig(config, "SCHEDULED_TASK_CONFIG_CORRUPT");
  return config;
}

/** 判定非空文本，保持原始配置值不做隐式类型转换。 */
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 判定 JSON 对象，不把数组和 null 当配置对象。 */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 数值字段必须是安全整数，拒绝字符串或非有限值。 */
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** 写操作时间由调用方提供，非法值在事务前失败。 */
function assertTimestamp(at: number, taskId: string): void {
  if (!integer(at)) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", taskId, "at");
}
