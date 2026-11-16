import type { SqliteDb } from "../sqliteTypes.js";

export type PersistedWorkspacePref = {
  workspaceId: string;
  engine: string;
  workMode: string;
  contextWindow: number | null;
  autoCompactPct: number | null;
  updatedAt: number;
};

type Row = {
  workspace_id: string;
  engine: string;
  work_mode: string;
  context_window: number | null;
  auto_compact_pct: number | null;
  updated_at: number;
};

function toPref(r: Row): PersistedWorkspacePref {
  return {
    workspaceId: r.workspace_id,
    engine: r.engine,
    workMode: "general",
    contextWindow: r.context_window ?? null,
    autoCompactPct: r.auto_compact_pct ?? null,
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/** 工作区级偏好仓储：按 workspace + engine 维度持久化 workMode 等设置。 */
export class WorkspacePrefsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 按 workspace 列出所有偏好。 */
  listByWorkspace(workspaceId: string): PersistedWorkspacePref[] {
    const rows = this.db
      .prepare("SELECT workspace_id, engine, work_mode, context_window, auto_compact_pct, updated_at FROM workspace_prefs WHERE workspace_id = ?")
      .all(workspaceId) as Row[];
    return rows.map(toPref);
  }

  /** 插入或更新单条偏好。 */
  upsert(input: { workspaceId: string; engine: string; workMode: string; contextWindow?: number | null; autoCompactPct?: number | null }): PersistedWorkspacePref {
    const now = Date.now();
    const cw = input.contextWindow ?? null;
    const acp = input.autoCompactPct ?? null;
    this.db
      .prepare(
        `INSERT INTO workspace_prefs (workspace_id, engine, work_mode, context_window, auto_compact_pct, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, engine) DO UPDATE SET work_mode = excluded.work_mode, context_window = excluded.context_window, auto_compact_pct = excluded.auto_compact_pct, updated_at = excluded.updated_at`,
      )
      .run(input.workspaceId, input.engine, "general", cw, acp, now);
    return { workspaceId: input.workspaceId, engine: input.engine, workMode: "general", contextWindow: cw, autoCompactPct: acp, updatedAt: now };
  }

  /** 批量插入或更新偏好。 */
  upsertMany(inputs: Array<{ workspaceId: string; engine: string; workMode: string; contextWindow?: number | null; autoCompactPct?: number | null }>): PersistedWorkspacePref[] {
    return inputs.map((i) => this.upsert(i));
  }
}
