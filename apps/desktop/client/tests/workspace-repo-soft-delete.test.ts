import test from "node:test";
import assert from "node:assert/strict";

import type { WorkspaceId } from "@codeflowai/shared";

import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { WorkspaceRepo } from "../src/db/repos/workspaceRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";

const WORKSPACE_ID = "test:workspace-soft-delete" as WorkspaceId;
const MIGRATED_WORKSPACE_ID = "client-test:workspace-soft-delete" as WorkspaceId;

/** 创建带迁移 schema 的内存 DB 与 workspace 仓储。 */
function setupDb(): { db: SqliteDb; repo: WorkspaceRepo } {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  return { db, repo: new WorkspaceRepo(db) };
}

/** 写入最小关联数据，用于验证 workspace 删除是否触发级联。 */
function seedWorkspaceData(db: SqliteDb, repo: WorkspaceRepo): void {
  repo.upsert({ id: WORKSPACE_ID, title: "soft delete ws", path: "/tmp/workspace-soft-delete" });
  db.prepare("INSERT INTO threads (id, workspace_id, engine, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("thread-soft-delete", String(WORKSPACE_ID), "codex", "soft delete thread", 1, 1);
  db.prepare("INSERT INTO terminal_configs (id, workspace_id, label, shell, cwd, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("terminal-soft-delete", String(WORKSPACE_ID), "soft delete terminal", null, null, 0, 1, 1);
}

/** 统计指定表内某 workspace 的行数。 */
function countByWorkspace(db: SqliteDb, table: "threads" | "terminal_configs"): number {
  const row = db.prepare(`SELECT COUNT(1) AS c FROM ${table} WHERE workspace_id = ?`).get(String(WORKSPACE_ID)) as { c: number };
  return Number(row?.c ?? 0);
}

/** 写入覆盖多类 workspace_id 表的最小数据，用于验证 id 迁移不丢数据。 */
function seedWorkspaceMigrationData(db: SqliteDb): void {
  db.prepare("INSERT INTO terminal_configs (id, workspace_id, label, shell, cwd, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("terminal-migrate", String(WORKSPACE_ID), "terminal", null, null, 0, 1, 1);
  db.prepare("INSERT INTO workspace_prefs (workspace_id, engine, work_mode, updated_at) VALUES (?, ?, ?, ?)")
    .run(String(WORKSPACE_ID), "codex", "general", 1);
  db.prepare("INSERT INTO thread_state_bindings (thread_id, workspace_id, state_rel_path, state_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("thread-soft-delete", String(WORKSPACE_ID), ".state", "state-1", 1, 1);
  db.prepare("INSERT INTO thread_reminder_states (thread_id, workspace_id, updated_at) VALUES (?, ?, ?)")
    .run("thread-soft-delete", String(WORKSPACE_ID), 1);
  db.prepare("INSERT INTO reminder_receipts (entity_type, workspace_id, entity_id, read_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("thread", String(WORKSPACE_ID), "thread-soft-delete", 1, 1);
  db.prepare("INSERT INTO reminder_ignores (workspace_id, reminder_id, marker, ignored_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(String(WORKSPACE_ID), "reminder-1", "marker", 1, 1);
  db.prepare("INSERT INTO thread_drafts (thread_id, workspace_id, updated_at) VALUES (?, ?, ?)")
    .run("thread-soft-delete", String(WORKSPACE_ID), 1);
  db.prepare("INSERT INTO thread_message_queue (id, thread_id, workspace_id, position, send_options_json, enqueued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("queue-1", "thread-soft-delete", String(WORKSPACE_ID), 1, "{}", 1, 1);
  db.prepare("INSERT INTO thread_queue_states (thread_id, workspace_id, updated_at) VALUES (?, ?, ?)")
    .run("thread-soft-delete", String(WORKSPACE_ID), 1);
  db.prepare("INSERT INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "thread-soft-delete", String(WORKSPACE_ID), "codex", "turn.started", JSON.stringify({
      seq: 1,
      ts: 1,
      workspaceId: WORKSPACE_ID,
      threadId: "thread-soft-delete",
      engine: "codex",
      type: "turn.started",
      payload: { turnId: "turn-1" },
    }), 1);
  db.prepare("INSERT INTO raw_engine_events (seq, thread_id, workspace_id, engine, source, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "thread-soft-delete", String(WORKSPACE_ID), "codex", "app-server", JSON.stringify({
      seq: 1,
      ts: 1,
      workspaceId: WORKSPACE_ID,
      threadId: "thread-soft-delete",
      engine: "codex",
      source: "app-server",
      payload: { type: "raw-test" },
    }), 1);
  db.prepare("INSERT INTO orch_roles (id, workspace_id, name, description, system_prompt, execution_config_json, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("role-1", String(WORKSPACE_ID), "role", "", "", "{}", "{}", 1, 1);
  db.prepare("INSERT INTO orch_workflows (id, workspace_id, name, description, nodes_json, edges_json, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("workflow-1", String(WORKSPACE_ID), "workflow", "", "[]", "[]", "{}", 1, 1);
  db.prepare("INSERT INTO orch_instances (id, workspace_id, workflow_id, workflow_snapshot_json, intake_snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("instance-1", String(WORKSPACE_ID), "workflow-1", "{}", "{}", 1, 1);
  db.prepare("INSERT INTO orch_asset_generation_jobs (id, workspace_id, asset_kind, mode, status, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("job-1", String(WORKSPACE_ID), "role", "create", "pending", "prompt", 1, 1);
  db.prepare("INSERT INTO orch_requirement_analysis_sessions (id, workspace_id, title, last_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("req-1", String(WORKSPACE_ID), "requirement", 1, 1, 1);
}

/** 列出当前 schema 中所有包含 workspace_id 的业务表。 */
function listWorkspaceIdTables(db: SqliteDb): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name?: string | null }>;
  return rows
    .map((row) => String(row.name ?? "").trim())
    .filter((table) => table && table !== "workspaces" && tableHasColumn(db, table, "workspace_id"));
}

/** 判断表是否包含指定列。 */
function tableHasColumn(db: SqliteDb, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all() as Array<{ name?: string | null }>;
  return rows.some((row) => String(row.name ?? "") === column);
}

/** 统计指定 workspaceId 在所有 workspace_id 表里的引用总数。 */
function countWorkspaceReferences(db: SqliteDb, workspaceId: WorkspaceId): number {
  return listWorkspaceIdTables(db).reduce((total, table) => {
    const row = db.prepare(`SELECT COUNT(1) AS c FROM ${quoteSqlIdentifier(table)} WHERE workspace_id = ?`).get(String(workspaceId)) as { c: number };
    return total + Number(row?.c ?? 0);
  }, 0);
}

/** 读取事件 JSON 中的顶层 workspaceId，用于验证 replay/raw 事实同步迁移。 */
function listEventJsonWorkspaceIds(db: SqliteDb, table: "conversation_events" | "raw_engine_events"): string[] {
  const rows = db.prepare(`SELECT event_json FROM ${table} ORDER BY seq ASC`).all() as Array<{ event_json: string }>;
  return rows.map((row) => String(JSON.parse(row.event_json).workspaceId ?? ""));
}

/** 转义 SQLite 标识符，表名来自测试库 schema。 */
function quoteSqlIdentifier(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

test("WorkspaceRepo delete 仅软删除 workspace，不级联删除历史数据", () => {
  const { db, repo } = setupDb();
  try {
    seedWorkspaceData(db, repo);

    assert.equal(repo.delete(WORKSPACE_ID), 1);
    assert.equal(repo.count(), 1);
    assert.equal(repo.get(WORKSPACE_ID), null);
    assert.equal(repo.getIncludingDeleted(WORKSPACE_ID)?.isDeleted, true);
    assert.deepEqual(repo.list().map((workspace) => workspace.id), []);
    assert.deepEqual(repo.list({ includeDeleted: true }).map((workspace) => workspace.id), [WORKSPACE_ID]);
    assert.equal(countByWorkspace(db, "threads"), 1);
    assert.equal(countByWorkspace(db, "terminal_configs"), 1);
  } finally {
    db.close();
  }
});

test("WorkspaceRepo upsert 会恢复同 id 的软删除 workspace", () => {
  const { db, repo } = setupDb();
  try {
    seedWorkspaceData(db, repo);
    repo.delete(WORKSPACE_ID);

    const restored = repo.upsert({ id: WORKSPACE_ID, title: "restored ws", path: "/tmp/restored-workspace" });

    assert.equal(restored.isDeleted, false);
    assert.equal(restored.title, "restored ws");
    assert.equal(repo.get(WORKSPACE_ID)?.isDeleted, false);
    assert.deepEqual(repo.list().map((workspace) => workspace.id), [WORKSPACE_ID]);
    assert.equal(countByWorkspace(db, "threads"), 1);
    assert.equal(countByWorkspace(db, "terminal_configs"), 1);
  } finally {
    db.close();
  }
});

test("WorkspaceRepo hardDelete 保留原物理删除语义并触发外键级联", () => {
  const { db, repo } = setupDb();
  try {
    seedWorkspaceData(db, repo);

    assert.equal(repo.hardDelete(WORKSPACE_ID), 1);
    assert.equal(repo.count(), 0);
    assert.equal(repo.getIncludingDeleted(WORKSPACE_ID), null);
    assert.equal(countByWorkspace(db, "threads"), 0);
    assert.equal(countByWorkspace(db, "terminal_configs"), 0);
  } finally {
    db.close();
  }
});

test("WorkspaceRepo migrateWorkspaceId 迁移全部 workspace_id 表并保留软删除状态", () => {
  const { db, repo } = setupDb();
  try {
    seedWorkspaceData(db, repo);
    seedWorkspaceMigrationData(db);
    repo.delete(WORKSPACE_ID);
    const beforeCount = countWorkspaceReferences(db, WORKSPACE_ID);
    assert.ok(beforeCount > 0);

    repo.migrateWorkspaceId(WORKSPACE_ID, MIGRATED_WORKSPACE_ID);

    assert.equal(repo.getIncludingDeleted(WORKSPACE_ID), null);
    assert.equal(repo.get(MIGRATED_WORKSPACE_ID), null);
    assert.equal(repo.getIncludingDeleted(MIGRATED_WORKSPACE_ID)?.isDeleted, true);
    assert.equal(countWorkspaceReferences(db, WORKSPACE_ID), 0);
    assert.equal(countWorkspaceReferences(db, MIGRATED_WORKSPACE_ID), beforeCount);
    assert.deepEqual(listEventJsonWorkspaceIds(db, "conversation_events"), [MIGRATED_WORKSPACE_ID]);
    assert.deepEqual(listEventJsonWorkspaceIds(db, "raw_engine_events"), [MIGRATED_WORKSPACE_ID]);
  } finally {
    db.close();
  }
});
