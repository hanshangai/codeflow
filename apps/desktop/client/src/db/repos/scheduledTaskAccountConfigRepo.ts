import type { ScheduledTask, WorkspaceId, DesktopAccountScheduledTaskEdit, DesktopAccountScheduledTaskMutation,
  ClientScheduledTaskConfigWritebackRequestBody, ClientScheduledTaskConfigWritebackResponseBody } from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";
import { assertScheduledTaskAccountOwner, type ScheduledTaskAccountOwner } from "./scheduledTaskRunRepo.js";
import { validateAccountTaskSnapshot, applyAccountTaskEdit } from "../../scheduled-tasks/scheduledTaskAccountSnapshot.js";

export type AccountScheduledTaskConfigRevision = Omit<ClientScheduledTaskConfigWritebackRequestBody, "clientId" | "deviceId">;
export type AccountScheduledTaskConfigSnapshot = { task: ScheduledTask; localRevision: number;
  pending: AccountScheduledTaskConfigRevision[]; stopIntent: "disabled" | "deleted" | null; serverPresent: boolean };
export type AccountScheduledTaskConfigInspection = { taskId: string } & ({ snapshot: AccountScheduledTaskConfigSnapshot }
  | { snapshot: null; corruption: ScheduledTaskAccountConfigError; localRevision: number; stopIntent: "disabled" | "deleted" });
type ConfigCode = "SCHEDULED_TASK_ACCOUNT_CONFIG_CORRUPT" | "SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT" | "SCHEDULED_TASK_ACCOUNT_CONFIG_STORAGE_FAILED";

export class ScheduledTaskAccountConfigError extends Error {
  /** 固定诊断字段，不把配置JSON或SQLite触发器正文带给上层。 */
  constructor(readonly code: ConfigCode, readonly taskId: string, readonly field: string, readonly rootCauseCode?: string) {
    super(code); this.name = "ScheduledTaskAccountConfigError";
  }
}

export class ScheduledTaskAccountConfigRepo {
  /** 仓储只拥有当前物理库的账号快照，连接和工作区由唯一opener提供。 */
  constructor(private readonly db: SqliteDb, private readonly workspaceId: WorkspaceId | null) {}

  /** 严格读取当前完整owner；旧版本没有此能力时由ClientDb显式识别。 */
  list(owner: ScheduledTaskAccountOwner): AccountScheduledTaskConfigSnapshot[] {
    assertScheduledTaskAccountOwner(owner);
    return this.execute("", "list", () => this.readRows(owner).map(row => this.decode(row, owner)));
  }

  /** 主动重新同步仅识别配置损坏；物理归属和SQL故障不进入修复计划。 */
  inspectForResync(owner: ScheduledTaskAccountOwner): AccountScheduledTaskConfigInspection[] {
    assertScheduledTaskAccountOwner(owner);
    return this.execute("", "resync_inspect", () => this.readRows(owner).map(row => {
      if (typeof row.task_id !== "string" || !row.task_id.trim() || row.workspace_id !== this.workspaceId
        || row.server_origin !== owner.serverOrigin || row.owner_user_id !== owner.ownerUserId || row.client_id !== owner.clientId || row.device_id !== owner.deviceId) {
        throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", "", "resync_identity");
      }
      try { return { taskId: row.task_id, snapshot: this.decode(row, owner) }; }
      catch (corruption) {
        if (!(corruption instanceof ScheduledTaskAccountConfigError) || corruption.code !== "SCHEDULED_TASK_ACCOUNT_CONFIG_CORRUPT") throw corruption;
        return { taskId: row.task_id, snapshot: null, corruption,
          localRevision: Number.isSafeInteger(row.local_revision) && Number(row.local_revision) >= 0 ? Number(row.local_revision) : 0,
          stopIntent: row.stop_intent === "deleted" ? "deleted" : "disabled" };
      }
    }));
  }

  /** 所有读取共用完整owner SQL；精确99版本显式投影其尚未支持的字段。 */
  private readRows(owner: ScheduledTaskAccountOwner): Record<string, unknown>[] {
    const legacy = Number(this.db.pragma("user_version", { simple: true })) === 99;
    return this.db.prepare(`SELECT *${legacy ? ", '[]' AS pending_json,NULL AS stop_intent,1 AS server_present" : ""} FROM scheduled_task_account_configs
      WHERE server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? ORDER BY task_id`).all(...ownerParams(owner)) as Record<string, unknown>[];
  }

  /** 同owner原子替换并回读；主动刷新只重建预检已记录的坏行且保持暂停。 */
  replace(owner: ScheduledTaskAccountOwner, snapshots: Array<Pick<AccountScheduledTaskConfigSnapshot, "task" | "localRevision">>,
    repairTaskIds?: ReadonlySet<string>): AccountScheduledTaskConfigSnapshot[] {
    assertScheduledTaskAccountOwner(owner);
    return this.execute("", "replace", () => this.db.transaction(() => {
      const previous = new Map<string, AccountScheduledTaskConfigSnapshot>();
      const inspected = repairTaskIds ? this.inspectForResync(owner) : this.list(owner).map(snapshot => ({ taskId: snapshot.task.id, snapshot }));
      for (const item of inspected) {
        if (item.snapshot) previous.set(item.taskId, item.snapshot);
        else {
          if (!repairTaskIds!.has(item.taskId)) throw item.corruption;
          const current = snapshots.find(snapshot => snapshot.task.id === item.taskId);
          if (current) previous.set(item.taskId, { task: current.task, localRevision: item.localRevision, pending: [], stopIntent: item.stopIntent, serverPresent: true });
        }
      }
      const encoded = snapshots.map(snapshot => {
        const old = previous.get(snapshot.task.id);
        const row = { server_origin: owner.serverOrigin, owner_user_id: owner.ownerUserId, client_id: owner.clientId, device_id: owner.deviceId,
          task_id: snapshot.task.id, workspace_id: this.workspaceId, snapshot_json: JSON.stringify(snapshot.task), local_revision: Math.max(snapshot.localRevision, old?.localRevision ?? 0),
          pending_json: JSON.stringify(old?.pending ?? []), stop_intent: old?.stopIntent ?? null, server_present: 1 };
        this.decode(row, owner);
        return row;
      });
      for (const old of previous.values()) {
        if (snapshots.some(snapshot => snapshot.task.id === old.task.id) || !old.pending.length && old.stopIntent === null) continue;
        encoded.push({ server_origin: owner.serverOrigin, owner_user_id: owner.ownerUserId, client_id: owner.clientId, device_id: owner.deviceId,
          task_id: old.task.id, workspace_id: this.workspaceId, snapshot_json: JSON.stringify(old.task), local_revision: old.localRevision,
          pending_json: JSON.stringify(old.pending), stop_intent: old.stopIntent, server_present: 0 });
      }
      if (new Set(encoded.map(row => row.task_id)).size !== encoded.length) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", "", "duplicate_task");
      this.db.prepare("DELETE FROM scheduled_task_account_configs WHERE server_origin=? AND owner_user_id=? AND client_id=? AND device_id=?").run(...ownerParams(owner));
      const insert = this.db.prepare("INSERT INTO scheduled_task_account_configs VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      for (const row of encoded) this.execute(row.task_id, "write", () => insert.run(...ownerParams(owner), row.task_id, row.workspace_id, row.snapshot_json, row.local_revision,
        row.pending_json, row.stop_intent, row.server_present));
      const saved = this.list(owner), expected = new Map(encoded.map(row => [row.task_id, row]));
      if (saved.length !== expected.size) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_STORAGE_FAILED", "", "read_after_write");
      for (const snapshot of saved) {
        const row = expected.get(snapshot.task.id);
        if (!row || JSON.stringify(snapshot.task) !== row.snapshot_json || snapshot.localRevision !== row.local_revision
          || JSON.stringify(snapshot.pending) !== row.pending_json || snapshot.stopIntent !== row.stop_intent || Number(snapshot.serverPresent) !== row.server_present) {
          throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_STORAGE_FAILED", snapshot.task.id, "read_after_write");
        }
      }
      return saved;
    })());
  }

  /** 本地CAS递增并保存不可变回写tuple；连续编辑沿待发序列分配Server基线。 */
  stage(owner: ScheduledTaskAccountOwner, input: DesktopAccountScheduledTaskMutation & { operation: "update" | "delete"; config?: DesktopAccountScheduledTaskEdit }): AccountScheduledTaskConfigSnapshot {
    return this.execute(input.taskId, "stage", () => this.db.transaction(() => {
      const current = this.require(owner, input.taskId);
      if (!Number.isSafeInteger(input.expectedLocalRevision) || current.localRevision !== input.expectedLocalRevision || current.localRevision >= Number.MAX_SAFE_INTEGER
        || !current.serverPresent || current.stopIntent === "deleted") throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", input.taskId, "local_revision");
      const effective = effectiveAccountTask(current), baseline = current.pending.at(-1)?.expectedConfigRevision ?? current.task.configRevision!;
      const expectedConfigRevision = current.pending.length ? baseline + 1 : baseline;
      if (!Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision >= Number.MAX_SAFE_INTEGER) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", input.taskId, "config_revision");
      const next = input.operation === "update" ? applyAccountTaskEdit(effective, input.config!) : effective;
      const revision: AccountScheduledTaskConfigRevision = { taskId: input.taskId, localRevision: current.localRevision + 1, expectedConfigRevision,
        operation: input.operation, ...(input.operation === "update" ? { config: structuredClone(input.config!) } : {}) };
      const pending = [...current.pending, revision], stop = input.operation === "delete" ? "deleted" : next.enabled ? null : "disabled";
      this.db.prepare(`UPDATE scheduled_task_account_configs SET local_revision=?,pending_json=?,stop_intent=?
        WHERE server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? AND task_id=? AND local_revision=?`)
        .run(revision.localRevision, JSON.stringify(pending), stop, ...ownerParams(owner), input.taskId, current.localRevision);
      const saved = this.require(owner, input.taskId);
      if (saved.localRevision !== revision.localRevision || JSON.stringify(saved.pending) !== JSON.stringify(pending) || saved.stopIntent !== stop) {
        throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_STORAGE_FAILED", input.taskId, "stage_readback");
      }
      return saved;
    })());
  }

  /** ACK只移除原首修订；后续编辑和停止意图原样保留，不借用新owner。 */
  acknowledge(owner: ScheduledTaskAccountOwner, revision: AccountScheduledTaskConfigRevision, ack: ClientScheduledTaskConfigWritebackResponseBody): void {
    this.execute(revision.taskId, "acknowledge", () => this.db.transaction(() => {
      const current = this.require(owner, revision.taskId);
      if (JSON.stringify(current.pending[0]) !== JSON.stringify(revision) || ack.taskId !== revision.taskId || ack.localRevision !== revision.localRevision
        || ack.expectedConfigRevision !== revision.expectedConfigRevision || ack.deleted !== (revision.operation === "delete")) {
        throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", revision.taskId, "ack_tuple");
      }
      if (!ack.deleted) {
        validateAccountTaskSnapshot({ tasks: [ack.task], serverNow: 0 }, owner, true);
        if (ack.task.id !== revision.taskId || ack.task.configRevision !== revision.expectedConfigRevision + 1
          || (ack.task.payload.contextWorkspaceId ?? null) !== this.workspaceId) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", revision.taskId, "ack_task");
      } else if (ack.task !== null) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", revision.taskId, "ack_deleted");
      const pending = current.pending.slice(1), task = ack.deleted ? current.task : ack.task;
      this.writeState(owner, { ...current, task, pending, serverPresent: !ack.deleted });
    })());
  }

  /** 明确业务拒绝后丢本任务全部修订；删除恢复可见暂停配置，停止意图不能被清除。 */
  reject(owner: ScheduledTaskAccountOwner, revision: AccountScheduledTaskConfigRevision): void {
    this.execute(revision.taskId, "reject", () => this.db.transaction(() => {
      const current = this.require(owner, revision.taskId);
      if (JSON.stringify(current.pending[0]) !== JSON.stringify(revision)) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", revision.taskId, "rejection_tuple");
      this.writeState(owner, { ...current, pending: [], stopIntent: current.stopIntent === "deleted" ? "disabled" : current.stopIntent });
    })());
  }

  /** 状态更新必须精确回读，驱动或触发器拒写不能伪成功。 */
  private writeState(owner: ScheduledTaskAccountOwner, state: AccountScheduledTaskConfigSnapshot): void {
    this.db.prepare(`UPDATE scheduled_task_account_configs SET snapshot_json=?,pending_json=?,stop_intent=?,server_present=?
      WHERE server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? AND task_id=?`)
      .run(JSON.stringify(state.task), JSON.stringify(state.pending), state.stopIntent, state.serverPresent, ...ownerParams(owner), state.task.id);
    if (JSON.stringify(this.require(owner, state.task.id)) !== JSON.stringify(state)) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_STORAGE_FAILED", state.task.id, "state_readback");
  }

  /** 任何修改都基于当前完整owner的真实行，不创建或接管任务。 */
  private require(owner: ScheduledTaskAccountOwner, taskId: string): AccountScheduledTaskConfigSnapshot {
    const current = this.list(owner).find(snapshot => snapshot.task.id === taskId);
    if (!current) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", taskId, "task_missing");
    return current;
  }

  /** JSON、主键、完整任务和物理归属任一不符都拒绝整轮快照。 */
  private decode(row: Record<string, unknown>, owner: ScheduledTaskAccountOwner): AccountScheduledTaskConfigSnapshot {
    const taskId = typeof row.task_id === "string" ? row.task_id : "";
    const corrupt = (field: string): never => { throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CORRUPT", taskId, field); };
    if (row.server_origin !== owner.serverOrigin || row.owner_user_id !== owner.ownerUserId || row.client_id !== owner.clientId
      || row.device_id !== owner.deviceId || row.workspace_id !== this.workspaceId || !Number.isSafeInteger(row.local_revision) || Number(row.local_revision) < 0) corrupt("identity_or_revision");
    let task: ScheduledTask;
    try {
      if (typeof row.snapshot_json !== "string") return corrupt("snapshot_json");
      task = JSON.parse(row.snapshot_json) as ScheduledTask;
      validateAccountTaskSnapshot({ tasks: [task], serverNow: 0 }, owner, true);
    } catch { return corrupt("snapshot"); }
    if (task.id !== taskId || (task.payload.contextWorkspaceId ?? null) !== this.workspaceId) corrupt("workspace_or_task");
    let pending: AccountScheduledTaskConfigRevision[];
    try {
      pending = JSON.parse(row.pending_json as string) as AccountScheduledTaskConfigRevision[];
      if (!Array.isArray(pending)) return corrupt("pending");
      let previousRevision = 0, previousBaseline = 0;
      for (const [index, revision] of pending.entries()) {
        if (!revision || typeof revision !== "object" || Array.isArray(revision) || revision.taskId !== taskId
          || !Number.isSafeInteger(revision.localRevision) || revision.localRevision <= previousRevision || revision.localRevision > Number(row.local_revision)
          || !Number.isSafeInteger(revision.expectedConfigRevision) || revision.expectedConfigRevision < 1
          || index > 0 && revision.expectedConfigRevision !== previousBaseline + 1
          || !["update", "delete"].includes(revision.operation) || index < pending.length - 1 && revision.operation === "delete"
          || Object.keys(revision).some(key => !["taskId", "localRevision", "expectedConfigRevision", "operation", "config"].includes(key))) return corrupt("pending");
        if (revision.operation === "update") applyAccountTaskEdit(task, revision.config as DesktopAccountScheduledTaskEdit);
        else if (revision.config !== undefined) return corrupt("pending");
        previousRevision = revision.localRevision; previousBaseline = revision.expectedConfigRevision;
      }
    } catch { return corrupt("pending"); }
    if (![null, "disabled", "deleted"].includes(row.stop_intent as string | null) || row.server_present !== 0 && row.server_present !== 1) corrupt("stop_or_presence");
    const latest = pending.at(-1);
    if (latest && (latest.operation === "delete" ? row.stop_intent !== "deleted"
      : latest.config!.enabled ? row.stop_intent !== null : row.stop_intent !== "disabled")) corrupt("pending_stop");
    return { task, localRevision: Number(row.local_revision), pending, stopIntent: row.stop_intent as AccountScheduledTaskConfigSnapshot["stopIntent"], serverPresent: row.server_present === 1 };
  }

  /** SQLite错误显式上抛，仅公开驱动码，保留cause供原边界生成安全指纹。 */
  private execute<T>(taskId: string, field: string, action: () => T): T {
    try { return action(); } catch (cause) {
      if (cause instanceof ScheduledTaskAccountConfigError) throw cause;
      const raw = cause as { code?: unknown; errcode?: unknown } | null;
      const code = typeof raw?.code === "string" && /^[A-Z0-9_]+$/.test(raw.code) ? raw.code : "SQLITE_ERROR";
      throw Object.assign(new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_STORAGE_FAILED", taskId, field,
        `${code}${Number.isSafeInteger(raw?.errcode) ? `:${raw!.errcode}` : ""}`), { cause });
    }
  }
}

/** SQL完整owner的顺序固定，不从快照正文补造身份。 */
function ownerParams(owner: ScheduledTaskAccountOwner): string[] { return [owner.serverOrigin, owner.ownerUserId, owner.clientId, owner.deviceId]; }

/** 最新本地修订覆盖显示配置；独立停删意图始终阻止新运行。 */
export function effectiveAccountTask(snapshot: AccountScheduledTaskConfigSnapshot): ScheduledTask {
  const latest = snapshot.pending.at(-1);
  const task = latest?.operation === "update" ? applyAccountTaskEdit(snapshot.task, latest.config as DesktopAccountScheduledTaskEdit) : snapshot.task;
  return snapshot.stopIntent !== null ? { ...task, enabled: false } : task;
}
