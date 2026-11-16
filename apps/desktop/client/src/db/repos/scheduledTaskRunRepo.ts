import type { LocalScheduledTaskRun, ScheduledTaskRun } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import { ScheduledTaskConfigError, ScheduledTaskConfigRepo } from "./scheduledTaskConfigRepo.js";

type RunErrorCode = "SCHEDULED_TASK_RUN_INVALID" | "SCHEDULED_TASK_RUN_CORRUPT"
  | "SCHEDULED_TASK_RUN_CONFIG_CONFLICT" | "SCHEDULED_TASK_RUN_CONFLICT" | "SCHEDULED_TASK_RUN_STORAGE_FAILED";
type ListQuery = { taskId?: string; clientId?: string; deviceId?: string; offset?: number; limit?: number };
const RUN_COLUMNS = {
  id: "id", taskId: "task_id", clientId: "client_id", deviceId: "device_id", workspaceId: "workspace_id",
  workflowInstanceId: "workflow_instance_id", workflowNameSnapshot: "workflow_name_snapshot", workflowVersion: "workflow_version",
  scheduledAt: "scheduled_at", startedAt: "started_at", finishedAt: "finished_at", status: "status", triggerSource: "trigger_source",
  attempt: "attempt", durationMs: "duration_ms", summary: "summary", errorMessage: "error_message", outputExcerpt: "output_excerpt", createdAt: "created_at",
} as const satisfies Record<Exclude<keyof ScheduledTaskRun, "deviceKind">, string>;
const RUN_FIELDS = Object.keys(RUN_COLUMNS) as Array<keyof typeof RUN_COLUMNS>;
const FROZEN_FIELDS = ["id", "taskId", "clientId", "deviceId", "workspaceId", "scheduledAt", "startedAt", "triggerSource", "attempt", "createdAt"] as const;
export type ScheduledTaskAccountOwner = { serverOrigin: string; ownerUserId: string; clientId: string; deviceId: string };
export type AccountScheduledTaskRun = ScheduledTaskRun & ScheduledTaskAccountOwner & { source: "account"; taskNameSnapshot: string;
  reportSettlement: "acknowledged" | "task_deleted" | null; reportSettledAt: number | null };

export class ScheduledTaskRunError extends Error {
  /** 只暴露固定错误码和运行上下文；调用边界负责 requestId 与结构日志。 */
  constructor(readonly code: RunErrorCode, readonly taskId: string, readonly runId: string, readonly field: string,
    readonly rootCauseCode?: string) {
    super(`${code}: taskId=${taskId}, runId=${runId}, field=${field}`);
    this.name = "ScheduledTaskRunError";
  }
}

export class ScheduledTaskRunRepo {
  /** 与原配置仓储共享连接和事务；不承担执行认领或运行去重。 */
  constructor(private readonly db: SqliteDb, private readonly configs: ScheduledTaskConfigRepo) {}

  /** local 读取及未知 source 诊断均先限定实际物理 scope。 */
  private get scopeSql(): string { return this.configs.workspaceId === null ? "workspace_id IS NULL" : "workspace_id = ?"; }

  /** scope 参数来自同连接配置仓储的固定注册 ID。 */
  private get scopeParams(): string[] { return this.configs.workspaceId === null ? [] : [this.configs.workspaceId]; }

  /** 保存原调度器的 running/直接 skipped；重放返回既有事实，新写才复核可执行配置。 */
  create(input: { run: ScheduledTaskRun; expectedConfigRevision: number }): LocalScheduledTaskRun {
    const run = input.run;
    assertRun(run);
    if (run.workspaceId !== this.configs.workspaceId) fail(run, "SCHEDULED_TASK_RUN_CONFIG_CONFLICT", "workspaceId");
    if (!integer(input.expectedConfigRevision, 1)) fail(run, "SCHEDULED_TASK_RUN_INVALID", "expectedConfigRevision");
    if (run.status !== "running" && run.status !== "skipped") fail(run, "SCHEDULED_TASK_RUN_INVALID", "initialStatus");
    return this.execute(run.taskId, run.id, "create", () => this.db.transaction(() => {
      const existing = this.get(run.id);
      if (existing) {
        const fields = run.status === "running" && existing.status !== "running" && existing.status !== "skipped"
          ? FROZEN_FIELDS : RUN_FIELDS;
        if (fields.some((field) => existing[field] !== run[field]) || existing.configRevision !== input.expectedConfigRevision) {
          fail(run, "SCHEDULED_TASK_RUN_CONFLICT", "initialRun");
        }
        return existing;
      }
      const config = this.configs.get(run.taskId);
      if (!config || !config.enabled || config.deletedAt !== null || config.revision !== input.expectedConfigRevision
        || config.clientId !== run.clientId || config.deviceId !== run.deviceId
        || (config.workspaceScope?.scopeId ?? null) !== run.workspaceId) {
        fail(run, "SCHEDULED_TASK_RUN_CONFIG_CONFLICT", "config");
      }
      this.db.prepare(`INSERT INTO scheduled_task_runs (${Object.values(RUN_COLUMNS).join(", ")}, source, config_revision, task_name_snapshot)
        VALUES (${RUN_FIELDS.map(() => "?").join(", ")}, 'local', ?, ?)`).run(
        ...RUN_FIELDS.map((field) => run[field]), config.revision, config.name,
      );
      return this.requireSaved(run);
    })());
  }

  /** 仅以原身份把 running 终结；配置后续停删不影响收尾，相同终态可精确重放。 */
  complete(run: ScheduledTaskRun): LocalScheduledTaskRun {
    assertRun(run);
    if (run.status !== "success" && run.status !== "failed" && run.status !== "timeout") fail(run, "SCHEDULED_TASK_RUN_INVALID", "terminalStatus");
    return this.execute(run.taskId, run.id, "complete", () => this.db.transaction(() => {
      const existing = this.get(run.id);
      if (!existing || FROZEN_FIELDS.some((field) => existing[field] !== run[field])) fail(run, "SCHEDULED_TASK_RUN_CONFLICT", "identity");
      if (existing.status !== "running") {
        if (RUN_FIELDS.some((field) => existing[field] !== run[field])) fail(run, "SCHEDULED_TASK_RUN_CONFLICT", "terminalRun");
        return existing;
      }
      const changed = this.db.prepare(`UPDATE scheduled_task_runs SET workflow_instance_id = ?, workflow_name_snapshot = ?, workflow_version = ?,
        finished_at = ?, status = ?, duration_ms = ?, summary = ?, error_message = ?, output_excerpt = ? WHERE id = ? AND source='local' AND ${this.scopeSql} AND status = 'running'`).run(
        run.workflowInstanceId, run.workflowNameSnapshot, run.workflowVersion, run.finishedAt, run.status, run.durationMs,
        run.summary, run.errorMessage, run.outputExcerpt, run.id, ...this.scopeParams,
      ).changes;
      if (Number(changed) !== 1) fail(run, "SCHEDULED_TASK_RUN_CONFLICT", "status");
      return this.requireSaved(run);
    })());
  }

  /** 严格读取历史；仅记录不存在时返回 null。 */
  get(runId: string): LocalScheduledTaskRun | null {
    if (!nonempty(runId)) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "id");
    return this.execute("", runId, "get", () => {
      const row = this.db.prepare(`SELECT * FROM scheduled_task_runs WHERE id = ? AND source = 'local' AND ${this.scopeSql}`).get(runId, ...this.scopeParams);
      if (row === undefined) {
        const invalid = this.db.prepare(`SELECT * FROM scheduled_task_runs WHERE id = ? AND source NOT IN ('local','account') AND ${this.scopeSql}`).get(runId, ...this.scopeParams);
        if (invalid) decodeRun(invalid as Record<string, unknown>);
      }
      return row === undefined ? null : decodeRun(row as Record<string, unknown>);
    });
  }

  /** 按原运行列表返回筛选后的 total 与稳定倒序页；计数和页面使用同一读取事务。 */
  list(query: ListQuery): { items: LocalScheduledTaskRun[]; total: number } {
    return this.listRuns(query);
  }

  /** 仅内部历史入口跨旧 run 设备读取；当前配置或墓碑必须仍归可信 owner。 */
  listLocalHistory(query: ListQuery & { clientId: string; deviceId: string }): { items: LocalScheduledTaskRun[]; total: number } {
    if (!nonempty(query.clientId) || !nonempty(query.deviceId)) {
      throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", query.taskId ?? "", "", "device");
    }
    return this.listRuns(query, true);
  }

  /** 两种列表共用计数、稳定分页与同步事务；历史口径在解码前收紧配置归属。 */
  private listRuns(query: ListQuery, history = false): { items: LocalScheduledTaskRun[]; total: number } {
    const filters: string[] = ["source = 'local'", this.scopeSql];
    const params: string[] = [...this.scopeParams];
    for (const [field, column] of [["taskId", "task_id"], ["clientId", "client_id"], ["deviceId", "device_id"]] as const) {
      if (query[field] === undefined) continue;
      if (!nonempty(query[field])) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", field);
      if (history && field === "deviceId") continue;
      filters.push(`${column} = ?`);
      params.push(query[field]);
    }
    if (history) {
      filters.push(`EXISTS (SELECT 1 FROM scheduled_task_configs AS config WHERE config.id = scheduled_task_runs.task_id
        AND config.source = 'local' AND config.client_id = ? AND config.device_id = ? AND ${this.configs.scopeSql})`);
      params.push(query.clientId!, query.deviceId!, ...this.configs.scopeParams);
    }
    const offset = query.offset === undefined ? 0 : query.offset;
    const limit = query.limit === undefined ? 50 : query.limit;
    if (!integer(offset) || !integer(limit, 1) || limit > 200) {
      throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", query.taskId ?? "", "", "pagination");
    }
    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    return this.execute(query.taskId ?? "", "", "list", () => this.db.transaction(() => {
      const invalidWhere = history ? filters.map(filter => filter === "source = 'local'" ? "source NOT IN ('local','account')" : filter).join(" AND ")
        : `source NOT IN ('local','account') AND ${this.scopeSql}`;
      const invalid = this.db.prepare(`SELECT * FROM scheduled_task_runs WHERE ${invalidWhere} LIMIT 1`).get(...(history ? params : this.scopeParams));
      if (invalid) decodeRun(invalid as Record<string, unknown>);
      const count = this.db.prepare(`SELECT COUNT(*) AS total FROM scheduled_task_runs${where}`).get(...params) as { total: number };
      const items = this.db.prepare(`SELECT * FROM scheduled_task_runs${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset).map((row) => decodeRun(row as Record<string, unknown>));
      return { items, total: count.total };
    })());
  }

  /** 账号首次认领不读取本机配置；同 runId 只允许精确 owner/事实重放。 */
  createAccount(input: { run: ScheduledTaskRun; owner: ScheduledTaskAccountOwner; taskName: string }): AccountScheduledTaskRun {
    const { run, owner } = input; assertRun(run); assertScheduledTaskAccountOwner(owner);
    if (!nonempty(input.taskName) || run.workspaceId !== this.configs.workspaceId || run.workflowInstanceId !== null || run.workflowNameSnapshot !== null
      || run.workflowVersion !== null || run.clientId !== owner.clientId || run.deviceId !== owner.deviceId
      || run.status !== "running" && run.status !== "skipped") fail(run, "SCHEDULED_TASK_RUN_INVALID", "accountInitial");
    return this.execute(run.taskId, run.id, "createAccount", () => this.db.transaction(() => {
      const existing = this.getAccount(run.id, owner);
      if (existing) {
        const fields = run.status === "running" && existing.status !== "running" ? FROZEN_FIELDS : RUN_FIELDS;
        if (fields.some(field => existing[field] !== run[field]) || existing.taskNameSnapshot !== input.taskName) fail(run, "SCHEDULED_TASK_RUN_CONFLICT", "initialRun");
        return existing;
      }
      this.db.prepare(`INSERT INTO scheduled_task_runs (${Object.values(RUN_COLUMNS).join(", ")}, source, config_revision, task_name_snapshot, server_origin, owner_user_id)
        VALUES (${RUN_FIELDS.map(() => "?").join(", ")}, 'account', NULL, ?, ?, ?)`).run(
        ...RUN_FIELDS.map(field => run[field]), input.taskName, owner.serverOrigin, owner.ownerUserId);
      const saved = this.requireAccount(run.id, owner);
      if (RUN_FIELDS.some(field => saved[field] !== run[field]) || saved.taskNameSnapshot !== input.taskName
        || saved.reportSettlement !== null || saved.reportSettledAt !== null) fail(run, "SCHEDULED_TASK_RUN_STORAGE_FAILED", "read_after_write");
      return saved;
    })());
  }

  /** 同 owner 终结 running，保留先前已观察的删除结算，禁止改写已有终态。 */
  completeAccount(run: ScheduledTaskRun, owner: ScheduledTaskAccountOwner): AccountScheduledTaskRun {
    assertRun(run); assertScheduledTaskAccountOwner(owner);
    if (!["success", "failed", "timeout"].includes(run.status) || run.workspaceId !== this.configs.workspaceId || run.workflowInstanceId !== null
      || run.workflowNameSnapshot !== null || run.workflowVersion !== null) fail(run, "SCHEDULED_TASK_RUN_INVALID", "accountTerminal");
    return this.execute(run.taskId, run.id, "completeAccount", () => this.db.transaction(() => {
      const existing = this.requireAccount(run.id, owner);
      if (FROZEN_FIELDS.some(field => existing[field] !== run[field])) fail(run, "SCHEDULED_TASK_RUN_CONFLICT", "identity");
      if (existing.status !== "running") {
        if (RUN_FIELDS.some(field => existing[field] !== run[field])) fail(run, "SCHEDULED_TASK_RUN_CONFLICT", "terminalRun");
        return existing;
      }
      const changed = this.db.prepare(`UPDATE scheduled_task_runs SET finished_at=?, status=?, duration_ms=?, summary=?, error_message=?, output_excerpt=?
        WHERE id=? AND source='account' AND ${this.scopeSql} AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? AND status='running'`).run(
        run.finishedAt, run.status, run.durationMs, run.summary, run.errorMessage, run.outputExcerpt, run.id, ...this.scopeParams, ...accountOwnerParams(owner));
      if (Number(changed.changes) !== 1) fail(run, "SCHEDULED_TASK_RUN_CONFLICT", "status");
      const saved = this.requireAccount(run.id, owner);
      if (RUN_FIELDS.some(field => saved[field] !== run[field])) fail(run, "SCHEDULED_TASK_RUN_STORAGE_FAILED", "read_after_write");
      return saved;
    })());
  }

  /** 不存在才返回 null；同 ID 属于其他来源或 owner 必须显式冲突。 */
  getAccount(runId: string, owner: ScheduledTaskAccountOwner): AccountScheduledTaskRun | null {
    assertScheduledTaskAccountOwner(owner);
    if (!nonempty(runId)) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "id");
    return this.execute("", runId, "getAccount", () => {
      const row = this.db.prepare(`SELECT * FROM scheduled_task_runs WHERE id=? AND source='account' AND ${this.scopeSql}
        AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=?`).get(runId, ...this.scopeParams, ...accountOwnerParams(owner)) as Record<string, unknown> | undefined;
      if (!row) {
        const identity = this.db.prepare(`SELECT id,task_id,source,server_origin,owner_user_id,client_id,device_id FROM scheduled_task_runs WHERE id=? AND ${this.scopeSql}`)
          .get(runId, ...this.scopeParams) as { task_id: string } | undefined;
        if (identity) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", identity.task_id, runId, "owner");
        return null;
      }
      return decodeAccountRun(row);
    });
  }

  /** 跨库定位只读精确 owner 的身份元数据，不解码其他账号或本机正文。 */
  hasAccount(runId: string, owner: ScheduledTaskAccountOwner): boolean {
    assertScheduledTaskAccountOwner(owner);
    if (!nonempty(runId)) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "id");
    return this.execute("", runId, "hasAccount", () => this.db.prepare(`SELECT id FROM scheduled_task_runs WHERE id=?
      AND source='account' AND ${this.scopeSql} AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=?`)
      .get(runId, ...this.scopeParams, ...accountOwnerParams(owner)) !== undefined);
  }

  /** 缺失任务结算前只探测本owner元数据；无变更时不获取工作区writer。 */
  hasMissingAccount(owner: ScheduledTaskAccountOwner, taskIds: ReadonlySet<string>): boolean {
    assertScheduledTaskAccountOwner(owner);
    return this.execute("", "", "hasMissingAccount", () => {
      const rows = this.db.prepare(`SELECT task_id FROM scheduled_task_runs WHERE source='account' AND ${this.scopeSql}
        AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? AND report_settlement IS NULL`)
        .all(...this.scopeParams, ...accountOwnerParams(owner)) as Array<{ task_id: string }>;
      return rows.some(row => !taskIds.has(row.task_id));
    });
  }

  /** 待报从同一历史行派生，稳定分页；不维护第二份 pending 状态。 */
  listPendingAccount(owner: ScheduledTaskAccountOwner, limit = 100): AccountScheduledTaskRun[] {
    assertScheduledTaskAccountOwner(owner);
    if (!integer(limit, 1) || limit > 200) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "limit");
    return this.execute("", "", "listPendingAccount", () => this.db.prepare(`SELECT * FROM scheduled_task_runs WHERE source='account' AND ${this.scopeSql}
      AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? AND status<>'running' AND report_settlement IS NULL
      ORDER BY created_at, id LIMIT ?`).all(...this.scopeParams, ...accountOwnerParams(owner), limit).map(row => decodeAccountRun(row as Record<string, unknown>)));
  }

  /** 完整owner先过滤再解码；删除后历史仍可读取，计数与倒序页共用只读事务。 */
  listAccountHistory(owner: ScheduledTaskAccountOwner, query: { taskId?: string; offset: number; limit: number }): { items: AccountScheduledTaskRun[]; total: number } {
    assertScheduledTaskAccountOwner(owner);
    if (query.taskId !== undefined && !nonempty(query.taskId) || !integer(query.offset) || !integer(query.limit, 1) || query.limit > 200) {
      throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", query.taskId ?? "", "", "history_query");
    }
    const where = `source='account' AND ${this.scopeSql} AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=?${query.taskId === undefined ? "" : " AND task_id=?"}`;
    const params = [...this.scopeParams, ...accountOwnerParams(owner), ...(query.taskId === undefined ? [] : [query.taskId])];
    return this.execute(query.taskId ?? "", "", "listAccountHistory", () => this.db.transaction(() => {
      const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM scheduled_task_runs WHERE ${where}`).get(...params) as { total: number }).total;
      const items = this.db.prepare(`SELECT * FROM scheduled_task_runs WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
        .all(...params, query.limit, query.offset).map(row => decodeAccountRun(row as Record<string, unknown>));
      return { items, total };
    })());
  }

  /** 批量定位候选历史ID，只读完整owner元数据，避免逐项重开物理库或解码外来正文。 */
  listAccountRunIds(owner: ScheduledTaskAccountOwner, runIds: readonly string[]): string[] {
    assertScheduledTaskAccountOwner(owner);
    if (!runIds.length || runIds.length > 200 || runIds.some(id => !nonempty(id))) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "history_ids");
    return this.execute("", "", "listAccountRunIds", () => (this.db.prepare(`SELECT id FROM scheduled_task_runs WHERE source='account' AND ${this.scopeSql}
      AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? AND id IN (${runIds.map(() => "?").join(",")})`)
      .all(...this.scopeParams, ...accountOwnerParams(owner), ...runIds) as Array<{ id: string }>).map(row => row.id));
  }

  /** 只有 Server 合法 ACK 后精确确认；写后核验失败由同事务回滚。 */
  acknowledgeAccount(runId: string, owner: ScheduledTaskAccountOwner, at: number): void {
    assertScheduledTaskAccountOwner(owner);
    if (!integer(at)) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", runId, "settledAt");
    this.execute("", runId, "acknowledgeAccount", () => this.db.transaction(() => {
      const existing = this.requireAccount(runId, owner);
      if (existing.status === "running" || existing.reportSettlement !== null) fail(existing, "SCHEDULED_TASK_RUN_CONFLICT", "settlement");
      const changed = this.db.prepare(`UPDATE scheduled_task_runs SET report_settlement='acknowledged',report_settled_at=?
        WHERE id=? AND source='account' AND ${this.scopeSql} AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=?
        AND status<>'running' AND report_settlement IS NULL`).run(at, runId, ...this.scopeParams, ...accountOwnerParams(owner));
      const saved = this.requireAccount(runId, owner);
      if (Number(changed.changes) !== 1 || saved.reportSettlement !== "acknowledged" || saved.reportSettledAt !== at) fail(existing, "SCHEDULED_TASK_RUN_STORAGE_FAILED", "acknowledge");
    })());
  }

  /** 完整当前快照缺失只结算已知 run，不永久封禁 taskId；运行收尾保该结算。 */
  discardMissingAccount(owner: ScheduledTaskAccountOwner, taskIds: ReadonlySet<string>, at: number): void {
    assertScheduledTaskAccountOwner(owner);
    if (!integer(at)) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "settledAt");
    this.execute("", "", "discardMissingAccount", () => this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM scheduled_task_runs WHERE source='account' AND ${this.scopeSql} AND server_origin=? AND owner_user_id=?
        AND client_id=? AND device_id=? AND report_settlement IS NULL`).all(...this.scopeParams, ...accountOwnerParams(owner));
      for (const row of rows) {
        const run = decodeAccountRun(row as Record<string, unknown>); if (taskIds.has(run.taskId)) continue;
        const changed = this.db.prepare(`UPDATE scheduled_task_runs SET report_settlement='task_deleted',report_settled_at=? WHERE id=?
          AND source='account' AND ${this.scopeSql} AND server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? AND report_settlement IS NULL`).run(at, run.id, ...this.scopeParams, ...accountOwnerParams(owner));
        const saved = this.requireAccount(run.id, owner);
        if (Number(changed.changes) !== 1 || saved.reportSettlement !== "task_deleted" || saved.reportSettledAt !== at) fail(run, "SCHEDULED_TASK_RUN_STORAGE_FAILED", "discardMissing");
      }
    })());
  }

  /** 写后要求当前 owner 的真实历史存在，不把未保存伪装成功。 */
  private requireAccount(runId: string, owner: ScheduledTaskAccountOwner): AccountScheduledTaskRun {
    const saved = this.getAccount(runId, owner);
    if (!saved) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", "", runId, "read_after_write");
    return saved;
  }

  /** 写后必须回读合法记录，否则由外层事务撤销本次写入。 */
  private requireSaved(run: ScheduledTaskRun): LocalScheduledTaskRun {
    const saved = this.get(run.id);
    if (!saved) fail(run, "SCHEDULED_TASK_RUN_STORAGE_FAILED", "read_after_write");
    return saved;
  }

  /** 显式翻译配置或驱动失败，只保留固定原因码，不传播 payload、SQL 或驱动正文。 */
  private execute<T>(taskId: string, runId: string, operation: string, action: () => T): T {
    try { return action(); } catch (error) {
      if (error instanceof ScheduledTaskRunError) {
        if (!error.taskId && taskId) throw Object.assign(new ScheduledTaskRunError(error.code, taskId, runId, error.field, error.rootCauseCode), { cause: error });
        throw error;
      }
      if (error instanceof ScheduledTaskConfigError) {
        throw Object.assign(new ScheduledTaskRunError(error.code === "SCHEDULED_TASK_CONFIG_STORAGE_FAILED"
          ? "SCHEDULED_TASK_RUN_STORAGE_FAILED" : "SCHEDULED_TASK_RUN_CONFIG_CONFLICT", taskId, runId, error.field,
        error.rootCauseCode ?? error.code), { cause: error });
      }
      const cause = error as { code?: unknown; errcode?: unknown } | null;
      const driverCode = typeof cause?.code === "string" && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : "SQLITE_ERROR";
      throw Object.assign(new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", taskId, runId, operation,
        `${driverCode}${Number.isSafeInteger(cause?.errcode) ? `:${cause!.errcode}` : ""}`), { cause: error });
    }
  }
}

/** 校验原调度器运行形状，坏字段和不一致时间不转换为默认值。 */
function assertRun(run: ScheduledTaskRun, code: RunErrorCode = "SCHEDULED_TASK_RUN_INVALID"): void {
  const check = (valid: boolean, field: string): void => { if (!valid) fail(run, code, field); };
  check(run !== null && typeof run === "object" && !Array.isArray(run), "run");
  check(nonempty(run.id) && nonempty(run.taskId) && nonempty(run.clientId) && nonempty(run.deviceId), "identity");
  check(run.workspaceId === null || nonempty(run.workspaceId), "workspaceId");
  check(run.workflowInstanceId === null || nonempty(run.workflowInstanceId), "workflowInstanceId");
  check(run.workflowNameSnapshot === null || nonempty(run.workflowNameSnapshot), "workflowNameSnapshot");
  check(run.workflowVersion === null || integer(run.workflowVersion, 1), "workflowVersion");
  check(integer(run.scheduledAt) && integer(run.createdAt) && integer(run.attempt, 1), "time_or_attempt");
  check(run.triggerSource === "schedule" || run.triggerSource === "manual", "triggerSource");
  check([run.summary, run.errorMessage, run.outputExcerpt].every((value) => value === null || typeof value === "string"), "resultText");
  if (run.status === "skipped") {
    check(run.startedAt === null && integer(run.finishedAt) && run.finishedAt >= run.createdAt && run.durationMs === null, "skippedTime");
    check(run.workflowNameSnapshot === null && run.workflowVersion === null && nonempty(run.summary)
      && run.errorMessage === null && run.outputExcerpt === null, "skippedResult");
    return;
  }
  check(integer(run.startedAt) && run.startedAt >= run.createdAt, "startedAt");
  if (run.status === "running") {
    check(run.finishedAt === null && run.durationMs === null, "runningTime");
    check(run.workflowInstanceId === null && run.workflowNameSnapshot === null && run.workflowVersion === null
      && run.errorMessage === null && run.outputExcerpt === null, "runningResult");
    return;
  }
  check(run.status === "success" || run.status === "failed" || run.status === "timeout", "status");
  check(integer(run.finishedAt) && run.finishedAt >= run.startedAt! && integer(run.durationMs)
    && run.durationMs === run.finishedAt - run.startedAt!, "terminalTime");
  check(run.workflowInstanceId === null ? run.workflowNameSnapshot === null && run.workflowVersion === null
    : nonempty(run.workflowNameSnapshot) && integer(run.workflowVersion, 1), "workflowResult");
}

/** 从原列严格还原运行与固定元数据，不依赖当前配置或进行 JSON 重放。 */
function decodeRun(row: Record<string, unknown>): LocalScheduledTaskRun {
  const run = Object.fromEntries(RUN_FIELDS.map((field) => [field, row[RUN_COLUMNS[field]]])) as ScheduledTaskRun;
  assertRun(run, "SCHEDULED_TASK_RUN_CORRUPT");
  if (row.source !== "local" || !integer(row.config_revision, 1) || !nonempty(row.task_name_snapshot)) {
    fail(run, "SCHEDULED_TASK_RUN_CORRUPT", "configSnapshot");
  }
  return { ...run, source: "local", configRevision: row.config_revision, taskNameSnapshot: row.task_name_snapshot };
}

/** owner 来自已激活个人权威；origin 必须已规范化且不含凭据、路径或参数。 */
export function assertScheduledTaskAccountOwner(owner: ScheduledTaskAccountOwner): void {
  let validOrigin = false;
  try { const url = new URL(owner?.serverOrigin); validOrigin = ["http:", "https:"].includes(url.protocol) && url.origin === owner.serverOrigin && !url.username && !url.password; }
  catch (cause) { throw Object.assign(new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "ownerOrigin"), { cause }); }
  if (!validOrigin || !nonempty(owner.ownerUserId) || !nonempty(owner.clientId) || !nonempty(owner.deviceId)) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "owner");
}

/** SQL owner 条件固定顺序，不从任务内容补身份。 */
function accountOwnerParams(owner: ScheduledTaskAccountOwner): string[] { return [owner.serverOrigin, owner.ownerUserId, owner.clientId, owner.deviceId]; }

/** 严格还原账号历史及结算；坏来源或字段不转默认值。 */
function decodeAccountRun(row: Record<string, unknown>): AccountScheduledTaskRun {
  const run = Object.fromEntries(RUN_FIELDS.map(field => [field, row[RUN_COLUMNS[field]]])) as ScheduledTaskRun; assertRun(run, "SCHEDULED_TASK_RUN_CORRUPT");
  const owner = { serverOrigin: row.server_origin, ownerUserId: row.owner_user_id, clientId: row.client_id, deviceId: row.device_id } as ScheduledTaskAccountOwner;
  assertScheduledTaskAccountOwner(owner);
  const settlement = row.report_settlement, at = row.report_settled_at;
  if (row.source !== "account" || row.config_revision !== null || !nonempty(row.task_name_snapshot)
    || run.workflowInstanceId !== null || run.workflowNameSnapshot !== null || run.workflowVersion !== null
    || !(settlement === null && at === null || (settlement === "task_deleted" || settlement === "acknowledged" && run.status !== "running") && integer(at))) fail(run, "SCHEDULED_TASK_RUN_CORRUPT", "accountSnapshot");
  return { ...run, ...owner, source: "account", taskNameSnapshot: row.task_name_snapshot, reportSettlement: settlement as AccountScheduledTaskRun["reportSettlement"], reportSettledAt: at as number | null };
}

/** 固定上下文仅取合法实体文本，不在异常中反射运行内容。 */
function fail(run: ScheduledTaskRun, code: RunErrorCode, field: string): never {
  throw new ScheduledTaskRunError(code, nonempty(run?.taskId) ? run.taskId : "", nonempty(run?.id) ? run.id : "", field);
}

/** 文本保持原值，拒绝空白和隐式转换。 */
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 数值必须是非负安全整数；修订与次数指定正数下界。 */
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
