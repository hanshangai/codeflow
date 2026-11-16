import type { SqliteDb } from "../sqliteTypes.js";

export type PersistedTerminalConfig = {
  id: string;
  workspaceId: string;
  label: string;
  shell: string | null;
  cwd: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string;
  workspace_id: string;
  label: string;
  shell: string | null;
  cwd: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

function toConfig(r: Row): PersistedTerminalConfig {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    label: r.label,
    shell: r.shell ?? null,
    cwd: r.cwd ?? null,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/** 终端配置仓储：持久化终端的 shell/label/cwd，Client 重启后可自动恢复。 */
export class TerminalConfigRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 按 workspace 列出所有终端配置（sortOrder 升序）。 */
  listByWorkspace(workspaceId: string): PersistedTerminalConfig[] {
    const rows = this.db
      .prepare(
        "SELECT id, workspace_id, label, shell, cwd, sort_order, created_at, updated_at FROM terminal_configs WHERE workspace_id = ? ORDER BY sort_order, created_at",
      )
      .all(workspaceId) as Row[];
    return rows.map(toConfig);
  }

  /** 插入一条终端配置。 */
  insert(input: { id: string; workspaceId: string; label: string; shell: string | null; cwd: string | null }): PersistedTerminalConfig {
    const now = Date.now();
    const maxOrder = (
      this.db
        .prepare("SELECT MAX(sort_order) AS m FROM terminal_configs WHERE workspace_id = ?")
        .get(input.workspaceId) as { m: number | null } | undefined
    )?.m ?? -1;

    this.db
      .prepare(
        "INSERT INTO terminal_configs (id, workspace_id, label, shell, cwd, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.workspaceId, input.label, input.shell, input.cwd, maxOrder + 1, now, now);

    return {
      id: input.id,
      workspaceId: input.workspaceId,
      label: input.label,
      shell: input.shell,
      cwd: input.cwd,
      sortOrder: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 更新终端配置（label）。 */
  updateLabel(id: string, label: string): void {
    this.db
      .prepare("UPDATE terminal_configs SET label = ?, updated_at = ? WHERE id = ?")
      .run(label, Date.now(), id);
  }

  /** 删除一条终端配置。 */
  delete(id: string): number {
    const res = this.db.prepare("DELETE FROM terminal_configs WHERE id = ?").run(id);
    return Number(res.changes ?? 0);
  }

  /** 删除 workspace 下所有终端配置。 */
  deleteByWorkspace(workspaceId: string): number {
    const res = this.db.prepare("DELETE FROM terminal_configs WHERE workspace_id = ?").run(workspaceId);
    return Number(res.changes ?? 0);
  }
}
