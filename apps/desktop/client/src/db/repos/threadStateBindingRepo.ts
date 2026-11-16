import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type PersistedThreadStateBinding = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  stateRelPath: string;
  stateId: string;
  createdAt: number;
  updatedAt: number;
};

/** thread ↔ STATE 绑定仓储：保留历史绑定数据的最小持久层。 */
export class ThreadStateBindingRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 查询某 thread 的绑定；不存在返回 null。 */
  getByThreadId(threadId: ThreadId): PersistedThreadStateBinding | null {
    const row = this.db
      .prepare(
        "SELECT thread_id, workspace_id, state_rel_path, state_id, created_at, updated_at FROM thread_state_bindings WHERE thread_id = ?",
      )
      .get(String(threadId)) as
      | {
          thread_id: string;
          workspace_id: string;
          state_rel_path: string;
          state_id: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      threadId: row.thread_id as ThreadId,
      workspaceId: row.workspace_id as WorkspaceId,
      stateRelPath: String(row.state_rel_path ?? ""),
      stateId: String(row.state_id ?? ""),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  /** 列出 workspace 下所有绑定。 */
  listByWorkspace(workspaceId: WorkspaceId): PersistedThreadStateBinding[] {
    const rows = this.db
      .prepare(
        "SELECT thread_id, workspace_id, state_rel_path, state_id, created_at, updated_at FROM thread_state_bindings WHERE workspace_id = ? ORDER BY updated_at DESC",
      )
      .all(String(workspaceId)) as Array<{
      thread_id: string;
      workspace_id: string;
      state_rel_path: string;
      state_id: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      threadId: r.thread_id as ThreadId,
      workspaceId: r.workspace_id as WorkspaceId,
      stateRelPath: String(r.state_rel_path ?? ""),
      stateId: String(r.state_id ?? ""),
      createdAt: Number(r.created_at ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    }));
  }

  /** 新增或更新绑定（幂等）。 */
  upsert(input: { threadId: ThreadId; workspaceId: WorkspaceId; stateRelPath: string; stateId: string }): PersistedThreadStateBinding {
    const now = Date.now();
    const threadId = String(input.threadId ?? "").trim();
    const workspaceId = String(input.workspaceId ?? "").trim();
    const stateRelPath = String(input.stateRelPath ?? "").trim();
    const stateId = String(input.stateId ?? "").trim();
    if (!threadId || !workspaceId || !stateRelPath || !stateId) {
      throw new Error("Invalid binding: threadId/workspaceId/stateRelPath/stateId required");
    }

    this.db
      .prepare(
        `
          INSERT INTO thread_state_bindings (thread_id, workspace_id, state_rel_path, state_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            state_rel_path = excluded.state_rel_path,
            state_id = excluded.state_id,
            updated_at = excluded.updated_at
        `,
      )
      .run(threadId, workspaceId, stateRelPath, stateId, now, now);

    const existing = this.getByThreadId(threadId as ThreadId);
    if (existing) return existing;
    return {
      threadId: threadId as ThreadId,
      workspaceId: workspaceId as WorkspaceId,
      stateRelPath,
      stateId,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 删除绑定（不存在则忽略）。 */
  deleteByThreadId(threadId: ThreadId): void {
    this.db.prepare("DELETE FROM thread_state_bindings WHERE thread_id = ?").run(String(threadId));
  }
}


