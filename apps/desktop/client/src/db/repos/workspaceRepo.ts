import type { WorkspaceId } from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

export type PersistedWorkspace = {
  id: WorkspaceId;
  title: string;
  path: string;
  isDeleted: boolean;
  createdAt: number;
  updatedAt: number;
};

/** workspace 仓储：负责本地 SQLite 的 CRUD。 */
export class WorkspaceRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 统计所有 workspace 数量（含软删除项，用于 bootstrap 判断）。 */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(1) AS c FROM workspaces").get() as { c: number };
    return Number(row?.c ?? 0);
  }

  /** 列出可见 workspace；includeDeleted=true 时包含软删除项。 */
  list(opts?: { includeDeleted?: boolean }): PersistedWorkspace[] {
    const where = opts?.includeDeleted ? "" : "WHERE is_deleted = 0";
    const rows = this.db
      .prepare(`SELECT id, title, path, is_deleted, created_at, updated_at FROM workspaces ${where} ORDER BY updated_at DESC`)
      .all() as Array<{ id: string; title: string; path: string; is_deleted: number; created_at: number; updated_at: number }>;
    return rows.map((r) => ({
      id: r.id as WorkspaceId,
      title: String(r.title ?? ""),
      path: String(r.path ?? ""),
      isDeleted: Number(r.is_deleted ?? 0) === 1,
      createdAt: Number(r.created_at ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    }));
  }

  /** 创建或更新 workspace（同 id 覆盖 title/path，并恢复软删除项）。 */
  upsert(input: { id: WorkspaceId; title: string; path: string }): PersistedWorkspace {
    const now = Date.now();
    const id = String(input.id ?? "").trim();
    const title = String(input.title ?? "").trim();
    const p = String(input.path ?? "").trim();
    if (!id || !title || !p) throw new Error("Invalid workspace: id/title/path required");

    const existing = this.getIncludingDeleted(id as WorkspaceId);
    if (!existing) {
      this.db
        .prepare("INSERT INTO workspaces (id, title, path, is_deleted, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
        .run(id, title, p, now, now);
      return { id: id as WorkspaceId, title, path: p, isDeleted: false, createdAt: now, updatedAt: now };
    }

    this.db
      .prepare("UPDATE workspaces SET title = ?, path = ?, is_deleted = 0, updated_at = ? WHERE id = ?")
      .run(title, p, now, id);
    return { ...existing, title, path: p, isDeleted: false, updatedAt: now };
  }

  /** 获取可见 workspace；不存在或已软删除则返回 null。 */
  get(id: WorkspaceId): PersistedWorkspace | null {
    return this.getById(id, false);
  }

  /** 获取 workspace，包含已软删除项；用于恢复或迁移。 */
  getIncludingDeleted(id: WorkspaceId): PersistedWorkspace | null {
    return this.getById(id, true);
  }

  /** 按 id 获取 workspace，并按调用方需要决定是否包含软删除项。 */
  private getById(id: WorkspaceId, includeDeleted: boolean): PersistedWorkspace | null {
    const whereDeleted = includeDeleted ? "" : " AND is_deleted = 0";
    const row = this.db
      .prepare(`SELECT id, title, path, is_deleted, created_at, updated_at FROM workspaces WHERE id = ?${whereDeleted}`)
      .get(String(id)) as { id: string; title: string; path: string; is_deleted: number; created_at: number; updated_at: number } | undefined;
    if (!row) return null;
    return {
      id: row.id as WorkspaceId,
      title: String(row.title ?? ""),
      path: String(row.path ?? ""),
      isDeleted: Number(row.is_deleted ?? 0) === 1,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  /** 软删除 workspace：仅从运行态和列表移除，保留历史数据。 */
  delete(id: WorkspaceId): number {
    const res = this.db.prepare("UPDATE workspaces SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0").run(Date.now(), String(id));
    return Number(res.changes ?? 0);
  }

  /** 物理删除 workspace：仅供内部迁移/明确清理使用，会触发外键级联。 */
  hardDelete(id: WorkspaceId): number {
    return this.db.transaction(() => {
      const res = this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(String(id));
      return Number(res.changes ?? 0);
    })();
  }

  /** 迁移 workspaceId，并同步更新所有带 workspace_id 列的业务表。 */
  migrateWorkspaceId(oldId: WorkspaceId, newId: WorkspaceId): void {
    this.db.transaction(() => {
      const oldWorkspace = this.getIncludingDeleted(oldId);
      if (!oldWorkspace) return;
      const existingTarget = this.getIncludingDeleted(newId);
      if (existingTarget) throw new Error(`workspaceId 迁移目标已存在：${String(newId)}`);
      this.insertMigratedWorkspace(newId, oldWorkspace);
      const tables = this.listWorkspaceIdTables();
      for (const table of tables) {
        const quoted = quoteSqlIdentifier(table);
        this.db.prepare(`UPDATE ${quoted} SET workspace_id = ? WHERE workspace_id = ?`).run(String(newId), String(oldId));
      }
      this.rewriteWorkspaceIdEventJson(oldId, newId);
      this.assertNoWorkspaceIdResidual(oldId, tables);
      this.assertNoWorkspaceIdEventJsonResidual(oldId, newId);
      this.hardDelete(oldId);
    })();
  }

  /** 写入迁移后的 workspace 主表行，保留软删除状态和时间戳。 */
  private insertMigratedWorkspace(id: WorkspaceId, workspace: PersistedWorkspace): void {
    this.db
      .prepare("INSERT INTO workspaces (id, title, path, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(String(id), workspace.title, workspace.path, workspace.isDeleted ? 1 : 0, workspace.createdAt, workspace.updatedAt);
  }

  /** 列出所有包含 workspace_id 列的业务表。 */
  private listWorkspaceIdTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name?: string | null }>;
    return rows
      .map((row) => String(row.name ?? "").trim())
      .filter((table) => table && table !== "workspaces" && this.tableHasColumn(table, "workspace_id"));
  }

  /** 判断指定表是否包含某列。 */
  private tableHasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all() as Array<{ name?: string | null }>;
    return rows.some((row) => String(row.name ?? "") === column);
  }

  /** 确认旧 workspaceId 已从所有关联表迁走。 */
  private assertNoWorkspaceIdResidual(oldId: WorkspaceId, tables: string[]): void {
    const residual = tables
      .map((table) => {
        const row = this.db.prepare(`SELECT COUNT(1) AS c FROM ${quoteSqlIdentifier(table)} WHERE workspace_id = ?`).get(String(oldId)) as { c: number };
        return { table, count: Number(row?.c ?? 0) };
      })
      .filter((item) => item.count > 0);
    if (!residual.length) return;
    const detail = residual.map((item) => `${item.table}:${item.count}`).join(", ");
    throw new Error(`workspaceId 迁移后仍存在旧引用：${detail}`);
  }

  /** 同步改写事件 envelope 内的 workspaceId，保证历史回放与 SQL 列一致。 */
  private rewriteWorkspaceIdEventJson(oldId: WorkspaceId, newId: WorkspaceId): void {
    for (const table of EVENT_JSON_TABLES) {
      const quoted = quoteSqlIdentifier(table);
      const rows = this.db
        .prepare(`SELECT seq, event_json FROM ${quoted} WHERE workspace_id = ? ORDER BY seq ASC`)
        .all(String(newId)) as Array<{ seq: number; event_json: string }>;
      const update = this.db.prepare(`UPDATE ${quoted} SET event_json = ? WHERE seq = ?`);
      for (const row of rows) {
        const envelope = parseEventJsonForMigration(table, row.seq, row.event_json);
        if (String(envelope.workspaceId ?? "") !== String(oldId)) continue;
        envelope.workspaceId = String(newId);
        update.run(JSON.stringify(envelope), Number(row.seq));
      }
    }
  }

  /** 确认事件 JSON 的顶层 workspaceId 已迁移，避免 replay 继续返回旧 workspaceId。 */
  private assertNoWorkspaceIdEventJsonResidual(oldId: WorkspaceId, newId: WorkspaceId): void {
    const residual: string[] = [];
    for (const table of EVENT_JSON_TABLES) {
      const quoted = quoteSqlIdentifier(table);
      const rows = this.db
        .prepare(`SELECT seq, event_json FROM ${quoted} WHERE workspace_id = ? ORDER BY seq ASC`)
        .all(String(newId)) as Array<{ seq: number; event_json: string }>;
      for (const row of rows) {
        const envelope = parseEventJsonForMigration(table, row.seq, row.event_json);
        if (String(envelope.workspaceId ?? "") === String(oldId)) {
          residual.push(`${table}:${Number(row.seq)}`);
        }
      }
    }
    if (!residual.length) return;
    throw new Error(`workspaceId 迁移后事件 JSON 仍存在旧引用：${residual.join(", ")}`);
  }
}

const EVENT_JSON_TABLES = ["conversation_events", "raw_engine_events"] as const;

/** 解析事件 JSON；迁移期遇到坏数据必须显式失败，避免制造双 workspaceId 事实。 */
function parseEventJsonForMigration(table: string, seq: number, raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("event_json is not an object");
    }
    return parsed as Record<string, any>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`workspaceId 迁移无法解析事件 JSON：${table}:${Number(seq)} ${message}`);
  }
}

/** 转义 SQLite 标识符，表名来自本地 schema。 */
function quoteSqlIdentifier(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

