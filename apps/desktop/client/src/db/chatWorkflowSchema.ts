import type { SqliteDb } from "./sqliteTypes.js";

export function createChatWorkflowTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_workflow_settings (
      thread_id TEXT PRIMARY KEY, recommendation_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_workflow_tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL, instance_id TEXT NULL UNIQUE,
      state TEXT NOT NULL, version INTEGER NOT NULL, task_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_workflow_tasks_thread ON chat_workflow_tasks(thread_id, created_at);
    CREATE TABLE IF NOT EXISTS chat_workflow_actions (
      request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, actor_user_id TEXT NOT NULL,
      input_hash TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}
