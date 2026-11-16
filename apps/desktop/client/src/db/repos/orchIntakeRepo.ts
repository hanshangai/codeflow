import crypto from "node:crypto";

import {
  normalizeTaskIntakeTitle,
  type IntakeId,
  type NodeExecutionProfileScope,
  type TaskIntake,
  type TaskIntakeSourceKind,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import type { OrchIntakeListStateRepo } from "./orchIntakeListStateRepo.js";

export class OrchIntakeRepoError extends Error {
  /** 固定错误码和记录身份供原处理边界关联，不保存需求正文。 */
  constructor(
    readonly code: "ORCH_INTAKE_SCOPE_INVALID" | "ORCH_INTAKE_SCOPE_CONFLICT" | "ORCH_INTAKE_DATA_INVALID",
    readonly details?: { intakeId: string; workspaceId: string },
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "OrchIntakeRepoError";
  }
}

/** 编排任务入口仓储。 */
export class OrchIntakeRepo {
  constructor(private readonly db: SqliteDb, private readonly listStates: OrchIntakeListStateRepo) {}

  /** 列表与单条读取使用相同的持久归属校验。 */
  listByWorkspace(workspaceId: WorkspaceId): TaskIntake[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, intake_json, created_at, updated_at
         FROM orch_intakes WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC`,
      )
      .all(String(workspaceId)) as any[];
    return rows.map(rowToIntake);
  }

  /** 先按工作区分页，再逐条校验需求和归属事实。 */
  listPageByWorkspace(
    workspaceId: WorkspaceId,
    opts?: { limit?: number; cursor?: string | null; allowedResourceIds?: string[] | null; sourceKind?: TaskIntakeSourceKind | null },
  ): { intakes: TaskIntake[]; hasMore: boolean; nextCursor: string | null } {
    const limit = Math.min(Math.max(1, Number(opts?.limit ?? 100) || 100), 500);
    const cursor = String(opts?.cursor ?? "").trim() || null;
    const allowedIds = normalizeAllowedResourceIds(opts?.allowedResourceIds);
    if (allowedIds && allowedIds.length === 0) return { intakes: [], hasMore: false, nextCursor: null };

    let sql = `SELECT id, workspace_id, intake_json, created_at, updated_at
               FROM orch_intakes
               WHERE workspace_id = ?`;
    const params: Array<string | number> = [String(workspaceId)];

    if (allowedIds) {
      sql += ` AND id IN (${allowedIds.map(() => "?").join(", ")})`;
      params.push(...allowedIds);
    }

    const sourceKind = normalizeTaskIntakeSourceKind(opts?.sourceKind);
    if (sourceKind === "scheduled_task") {
      sql += ` AND (${scheduledIntakePredicateSql()})`;
    } else if (sourceKind === "requirement") {
      sql += ` AND NOT (${scheduledIntakePredicateSql()})`;
    }

    if (cursor) {
      const sep = cursor.indexOf(":");
      if (sep > 0) {
        const cursorSort = Number(cursor.substring(0, sep));
        const cursorId = cursor.substring(sep + 1);
        if (Number.isFinite(cursorSort) && cursorId) {
          sql += " AND (updated_at < ? OR (updated_at = ? AND id < ?))";
          params.push(cursorSort, cursorSort, cursorId);
        }
      }
    }

    sql += " ORDER BY updated_at DESC, id DESC LIMIT ?";
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as any[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const intakes = page.map(rowToIntake);

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1]!;
      nextCursor = `${Number(last.updated_at ?? 0)}:${String(last.id)}`;
    }

    return { intakes, hasMore, nextCursor };
  }

  /** 按 ID 列表读取 intake，并按输入顺序返回；用于派生状态分页后的记录回表。 */
  listByIds(ids: IntakeId[]): TaskIntake[] {
    const normalized = Array.from(new Set(ids.map((item) => String(item ?? "").trim()).filter(Boolean)));
    if (normalized.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, intake_json, created_at, updated_at
         FROM orch_intakes
         WHERE id IN (${normalized.map(() => "?").join(", ")})`,
      )
      .all(...normalized) as any[];
    const byId = new Map(rows.map((row) => [String(row.id), rowToIntake(row)] as const));
    return normalized.map((id) => byId.get(id)).filter((item): item is TaskIntake => Boolean(item));
  }

  /** 读取时校验持久归属，损坏记录不得被编辑洗成未知。 */
  get(id: IntakeId): TaskIntake | null {
    const row = this.db
      .prepare("SELECT id, workspace_id, intake_json, created_at, updated_at FROM orch_intakes WHERE id = ?")
      .get(String(id)) as any | undefined;
    if (!row) return null;
    return rowToIntake(row);
  }

  /** 校验并复制可信归属，与需求事实和列表投影同事务保存。 */
  create(input: Omit<TaskIntake, "id" | "createdAt" | "updatedAt">): TaskIntake {
    const id = crypto.randomUUID() as IntakeId;
    const now = Date.now();
    const intake: TaskIntake = {
      ...input,
      workspaceScope: readIntakeWorkspaceScope(input.workspaceScope, input.workspaceId, id),
      title: normalizeTaskIntakeTitle(input.title, input.goal),
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO orch_intakes (id, workspace_id, task_type, goal, intake_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          String(intake.workspaceId),
          String(intake.taskType ?? "unknown"),
          String(intake.goal ?? ""),
          JSON.stringify(intake),
          now,
          now,
        );
      this.listStates.refreshIntake({ workspaceId: intake.workspaceId, intakeId: intake.id });
    })();
    return intake;
  }

  /** 更新保留既有归属，拒绝重绑或自动认领旧记录，再原子刷新列表。 */
  upsert(input: Omit<TaskIntake, "createdAt" | "updatedAt">): TaskIntake {
    return this.db.transaction(() => {
      const now = Date.now();
      const existing = this.get(input.id);
      const workspaceScope = readIntakeWorkspaceScope(input.workspaceScope, input.workspaceId, input.id);
      const existingScope = existing?.workspaceScope ?? null;
      if (existing && (existing.workspaceId !== input.workspaceId
        || input.workspaceScope !== undefined && (existingScope?.scopeType !== workspaceScope?.scopeType || existingScope?.scopeId !== workspaceScope?.scopeId))) {
        throw scopeFailure("ORCH_INTAKE_SCOPE_CONFLICT", { intakeId: input.id, workspaceId: input.workspaceId });
      }
      const intake: TaskIntake = {
        ...input,
        workspaceScope: existing ? existingScope : workspaceScope,
        title: normalizeTaskIntakeTitle(input.title, input.goal),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.db
        .prepare(
          `INSERT INTO orch_intakes (id, workspace_id, task_type, goal, intake_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             task_type = excluded.task_type,
             goal = excluded.goal,
             intake_json = excluded.intake_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          String(intake.id),
          String(intake.workspaceId),
          String(intake.taskType ?? "unknown"),
          String(intake.goal ?? ""),
          JSON.stringify(intake),
          intake.createdAt,
          intake.updatedAt,
        );
      this.listStates.refreshIntake({ workspaceId: intake.workspaceId, intakeId: intake.id });
      return intake;
    })();
  }

  /** 删除 intake，同时清理列表状态和搜索投影。 */
  delete(id: IntakeId): void {
    const existing = this.get(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM orch_intakes WHERE id = ?").run(String(id));
      if (existing) this.listStates.removeIntake(existing.workspaceId, id);
    })();
  }
}

/** 失败时只抛固定诊断，不把原 JSON 或需求正文放入异常。 */
function rowToIntake(row: any): TaskIntake {
  const details = { intakeId: String(row.id), workspaceId: String(row.workspace_id) };
  let parsed: TaskIntake;
  try {
    parsed = JSON.parse(row.intake_json);
  } catch {
    throw new OrchIntakeRepoError("ORCH_INTAKE_DATA_INVALID", details, { cause: new SyntaxError("Invalid intake JSON") });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.id !== row.id || parsed.workspaceId !== row.workspace_id) throw new OrchIntakeRepoError("ORCH_INTAKE_DATA_INVALID", details);
  let workspaceScope: NodeExecutionProfileScope | null;
  try {
    workspaceScope = readIntakeWorkspaceScope(parsed.workspaceScope, parsed.workspaceId, row.id);
  } catch (cause) {
    throw new OrchIntakeRepoError("ORCH_INTAKE_DATA_INVALID", details, { cause });
  }
  return { ...parsed, workspaceScope, title: normalizeTaskIntakeTitle(parsed.title, parsed.goal),
    id: row.id as IntakeId, createdAt: Number(row.created_at ?? parsed.createdAt ?? 0), updatedAt: Number(row.updated_at ?? parsed.updatedAt ?? 0) };
}

/** 缺省仅表示未知；显式归属必须为规范范围，本机 ID 必须等于记录工作区。 */
export function readIntakeWorkspaceScope(value: unknown, workspaceId: WorkspaceId, intakeId?: string): NodeExecutionProfileScope | null {
  if (value == null) return null;
  const details = intakeId === undefined ? undefined : { intakeId, workspaceId: String(workspaceId) };
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "scopeType") || !Object.hasOwn(value, "scopeId")) throw scopeFailure("ORCH_INTAKE_SCOPE_INVALID", details);
  const { scopeType, scopeId } = value as NodeExecutionProfileScope;
  if ((scopeType !== "local_workspace" && scopeType !== "shared_workspace") || typeof scopeId !== "string"
    || !scopeId || scopeId !== scopeId.trim() || scopeType === "local_workspace" && scopeId !== workspaceId) throw scopeFailure("ORCH_INTAKE_SCOPE_INVALID", details);
  return { scopeType, scopeId };
}

/** 提供可检索的固定错误码，由原 API 或任务边界记录并显式失败。 */
function scopeFailure(code: "ORCH_INTAKE_SCOPE_INVALID" | "ORCH_INTAKE_SCOPE_CONFLICT" | "ORCH_INTAKE_DATA_INVALID", details?: { intakeId: string; workspaceId: string }): OrchIntakeRepoError {
  return new OrchIntakeRepoError(code, details);
}

/** 规范化任务入口来源筛选；未知值按不筛选处理。 */
function normalizeTaskIntakeSourceKind(value: unknown): TaskIntakeSourceKind | null {
  const text = String(value ?? "").trim();
  return text === "requirement" || text === "scheduled_task" ? text : null;
}

/** 定时任务入口的新旧数据识别条件：新数据看 requester.source，旧数据看实例启动事件。 */
function scheduledIntakePredicateSql(): string {
  return `COALESCE(json_extract(intake_json, '$.requester.source'), '') = 'scheduled_task'
    OR EXISTS (
      SELECT 1 FROM orch_instances oi
      WHERE oi.workspace_id = orch_intakes.workspace_id
        AND json_extract(oi.intake_snapshot_json, '$.id') = orch_intakes.id
        AND EXISTS (
          SELECT 1 FROM orch_events oe
          WHERE oe.instance_id = oi.id
            AND oe.type = 'orchestration.instanceStarted'
            AND json_extract(oe.payload_json, '$.triggerSource') = 'scheduled_task'
        )
    )`;
}

/** 规范共享工作区下发的可见需求 ID；undefined 表示不限制，空数组表示无可见项。 */
function normalizeAllowedResourceIds(value: string[] | null | undefined): string[] | null {
  if (value == null) return null;
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

