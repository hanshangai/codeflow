import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureWorkspaceCoreQueueTables, migrateClientDb } from "../src/db/migrateClientDb.js";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.js";

const coreTables = `threads thread_turns turn_file_changes conversation_events raw_engine_events
  conversation_diff_snapshots conversation_message_deletions knowledge_conversations thread_drafts
  thread_draft_attachments thread_message_queue thread_message_queue_attachments thread_queue_states
  thread_reminder_states thread_rollbacks thread_state_bindings file_blobs thread_groups reminder_receipts
  reminder_ignores dingtalk_reminder_notifications wecom_reminder_notifications meta
  orch_requirement_analysis_sessions orch_requirement_analysis_messages orch_requirement_candidate_drafts
  orch_requirement_analysis_search_fts orch_list_status_count_cache chat_workflow_tasks chat_workflow_actions
  chat_workflow_settings orch_intakes orch_proposals orch_intake_list_states orch_intake_search_fts
  orch_instances orch_instance_summaries orch_artifacts orch_artifact_files orch_artifact_fields orch_events
  orch_feedback_records orch_gate_evaluation_runs orch_prompt_snapshots orch_node_context_resolutions
  orch_node_attempts orch_node_work_item_boards orch_node_work_items orch_node_work_item_events
  code_attribution_outbox code_attribution_retention_tasks orch_asset_generation_jobs orch_asset_job_events
  orch_asset_drafts orch_asset_versions orch_roles orch_workflows orch_knowledge_bundles orch_toolsets
  orch_skills orch_skill_files orch_asset_groups orch_asset_group_assignments`.trim().split(/\s+/).sort();
const presentationTables = ["conversation_presentations", "conversation_presentation_items"];

/** 真实临时文件保留 DELETE/WAL 迁移语义，测试结束统一关闭。 */
function database(t: test.TestContext, scope: "application" | "workspace"): SqliteDb {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-core-schema-"));
  const db = openSqliteDb(path.join(root, "database.db"));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  migrateClientDb(db, { scope });
  return db;
}

/** 比较语义列，忽略迁移历史造成的物理列顺序。 */
function columns(db: SqliteDb, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
    .map(({ cid: _cid, ...column }) => column).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** FK 按列语义比较；跨文件的注册 FK 由应用 scope 负责。 */
function foreignKeys(db: SqliteDb, table: string) {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<Record<string, unknown>>)
    .filter(key => key.table !== "workspaces").map(({ id: _id, seq: _seq, ...key }) => JSON.stringify(key)).sort();
}

/** 完整 master 快照用于证明失败不会留下半套 DDL。 */
function schema(db: SqliteDb) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
}

test("工作区创建完整核心闭包及展示索引，应用身份与counter不复制", t => {
  const db = database(t, "workspace");
  const initial = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  ensureWorkspaceCoreQueueTables(db);
  assert.equal(coreTables.length, 63);
  const expected = [...coreTables, ...presentationTables, ...initial.map(row => row.name)].sort();
  const actual = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'sqlite_sequence' AND name NOT GLOB '*_fts_*'")
    .all() as Array<{ name: string }>).map(row => row.name).sort();
  assert.deepEqual(actual, expected);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='event_seq'").get(), undefined);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const before = schema(db);
  ensureWorkspaceCoreQueueTables(db);
  assert.deepEqual(schema(db), before);
});

test("工作区闭包复用应用当前列、索引和本地FK，保留原约束语义", t => {
  const app = database(t, "application");
  const workspace = database(t, "workspace");
  ensureWorkspaceCoreQueueTables(workspace);
  for (const table of [...coreTables, ...presentationTables]) {
    assert.deepEqual(columns(workspace, table), columns(app, table), `${table} columns`);
    assert.deepEqual(foreignKeys(workspace, table), foreignKeys(app, table), `${table} foreign keys`);
    const indexes = (db: SqliteDb) => (db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name").all(table) as Array<{ name: string; sql: string | null }>)
      .map(row => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").trim() ?? null }));
    assert.deepEqual(indexes(workspace), indexes(app), `${table} indexes`);
  }
});

test("分组名称按本机和各共享区隔离，未新增group或blob外键", t => {
  const db = database(t, "workspace");
  ensureWorkspaceCoreQueueTables(db);
  const insert = db.prepare("INSERT INTO thread_groups(id, workspace_id, shared_workspace_id, name, name_key, created_at, updated_at) VALUES(?, 'w', ?, '同名', 'same', 1, 1)");
  insert.run("local", null);
  insert.run("shared-a", "a");
  insert.run("shared-b", "b");
  assert.throws(() => insert.run("local-duplicate", null), /UNIQUE/);
  assert.throws(() => insert.run("shared-duplicate", "a"), /UNIQUE/);
  assert.deepEqual(foreignKeys(db, "threads"), []);
  assert.equal(foreignKeys(db, "turn_file_changes").length, 1);
  assert.equal(foreignKeys(db, "thread_draft_attachments").length, 1);
  assert.equal(foreignKeys(db, "thread_message_queue_attachments").length, 1);
});

test("旧半套核心结构写前拒绝并保留已有表和数据", t => {
  const db = database(t, "workspace");
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO threads VALUES('old', '保留记录');");
  const before = schema(db);
  assert.throws(() => ensureWorkspaceCoreQueueTables(db), /WORKSPACE_CORE_SCHEMA_INVALID:threads/);
  assert.deepEqual(schema(db), before);
  assert.deepEqual(db.prepare("SELECT * FROM threads").all(), [{ id: "old", title: "保留记录" }]);
});

test("核心建表中途失败会整体回滚并保留原五表", t => {
  const db = database(t, "workspace");
  const before = schema(db);
  const failure = new Error("schema-injected-failure");
  const exec = db.exec.bind(db);
  db.exec = sql => {
    if (/CREATE TABLE IF NOT EXISTS orch_roles/.test(sql)) throw failure;
    exec(sql);
  };
  assert.throws(() => ensureWorkspaceCoreQueueTables(db), error => error === failure);
  assert.deepEqual(schema(db), before);
});

test("拒绝未知核心版本和已损坏结构，禁止覆盖修复成表面成功", t => {
  const db = database(t, "workspace");
  ensureWorkspaceCoreQueueTables(db);
  db.prepare("UPDATE meta SET value='999' WHERE key='workspace_core_schema_version'").run();
  const before = schema(db);
  assert.throws(() => ensureWorkspaceCoreQueueTables(db), /WORKSPACE_CORE_SCHEMA_VERSION_UNSUPPORTED/);
  assert.deepEqual(schema(db), before);
  db.prepare("UPDATE meta SET value='1' WHERE key='workspace_core_schema_version'").run();
  db.exec("DROP TABLE orch_asset_groups");
  assert.throws(() => ensureWorkspaceCoreQueueTables(db), /WORKSPACE_CORE_SCHEMA_INVALID:orch_asset_groups/);
});
