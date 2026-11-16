import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { assertWorkspaceDbReadOnlySchema, CLIENT_DB_SCHEMA_VERSION, migrateClientDb } from "../../apps/desktop/client/src/db/migrateClientDb.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";
import { CLIENT_DB_READER_SCHEMA_VERSION } from "../../apps/desktop/client/src/db/clientDbReaderProtocol.ts";

const EXPECTED_CLIENT_SCHEMA_VERSION = CLIENT_DB_SCHEMA_VERSION;
const ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME = "idx_orch_instances_workspace_intake_display";
const ORCH_INSTANCE_SUMMARY_TABLE_NAME = "orch_instance_summaries";
const ORCH_INSTANCE_SUMMARY_WORKSPACE_INDEX_NAME = "idx_orch_instance_summaries_workspace_display";
const ORCH_INSTANCE_SUMMARY_INTAKE_INDEX_NAME = "idx_orch_instance_summaries_workspace_intake_display";

function tableExists(db: ReturnType<typeof openSqliteDb>, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function indexExists(db: ReturnType<typeof openSqliteDb>, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

/** 读取稳定的列物理合同，避免测试只覆盖表名而遗漏 schema 漂移。 */
function tableColumnContract(db: ReturnType<typeof openSqliteDb>, table: string): unknown[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name?: string;
    type?: string;
    notnull?: number;
    dflt_value?: unknown;
    pk?: number;
  }>).map((column) => [
    String(column.name ?? ""),
    String(column.type ?? ""),
    Number(column.notnull ?? 0),
    column.dflt_value == null ? null : String(column.dflt_value),
    Number(column.pk ?? 0),
  ]);
}

/** 归一复合外键，保留列顺序、目标表和删除动作。 */
function foreignKeyContract(db: ReturnType<typeof openSqliteDb>, table: string): string[] {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id?: number;
    seq?: number;
    table?: string;
    from?: string;
    to?: string;
    on_delete?: string;
  }>;
  const groups = new Map<number, typeof rows>();
  for (const row of rows) {
    const id = Number(row.id ?? -1);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((left, right) => Number(left.seq ?? -1) - Number(right.seq ?? -1));
    const target = String(ordered[0]?.table ?? "");
    const from = ordered.map((row) => String(row.from ?? "")).join(",");
    const to = ordered.map((row) => String(row.to ?? "")).join(",");
    const onDelete = String(ordered[0]?.on_delete ?? "");
    return `${target}:${from}->${to}:${onDelete}`;
  }).sort();
}

/** 读取表上的显式命名索引，排除 SQLite 自动主键索引。 */
function namedIndexes(db: ReturnType<typeof openSqliteDb>, table: string): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
  ).all(table) as Array<{ name?: string }>).map((row) => String(row.name ?? ""));
}

/** 读取已知命名索引的有序列集合。 */
function indexColumns(db: ReturnType<typeof openSqliteDb>, index: string): string[] {
  assert.match(index, /^[a-z0-9_]+$/);
  return (db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name?: string }>)
    .map((row) => String(row.name ?? ""));
}

/** 读取本次运行证据索引合同，供修复及失败回滚比较。 */
function runtimeEvidenceIndexes(db: ReturnType<typeof openSqliteDb>): unknown[] {
  return db.prepare(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?) ORDER BY name`,
  ).all(
    "idx_raw_engine_events_thread_seq",
    "idx_raw_engine_events_thread_tools",
    "idx_orch_prompt_snapshots_instance_node_attempt_created",
  );
}

test("client DB reader schema version matches the migrated writer schema", () => {
  assert.equal(CLIENT_DB_READER_SCHEMA_VERSION, EXPECTED_CLIENT_SCHEMA_VERSION);
});

/** 应用库夹具回到旧版本前移除 v102 独占表，保留各用例正在验证的历史事实。 */
function setApplicationFixtureVersion(db: ReturnType<typeof openSqliteDb>, version: number): void {
  if (version < 102) db.exec("DROP TABLE local_quick_phrases; DROP TABLE local_quick_phrase_collection; DROP TABLE local_model_context_preferences;");
  db.pragma(`user_version = ${version}`);
}

/** 恢复 W96/97 的 22 列本机记录表，并移除当时尚不存在的账号配置表。 */
function restoreLegacyWorkspaceTaskSchema(db: ReturnType<typeof openSqliteDb>): void {
  db.exec(`DROP TABLE scheduled_task_account_configs;
    DROP TABLE scheduled_task_runs;
    CREATE TABLE scheduled_task_runs (
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,client_id TEXT NOT NULL,device_id TEXT NOT NULL,workspace_id TEXT NULL,
      workflow_instance_id TEXT NULL,workflow_name_snapshot TEXT NULL,workflow_version INTEGER NULL,scheduled_at INTEGER NOT NULL,
      started_at INTEGER NULL,finished_at INTEGER NULL,status TEXT NOT NULL CHECK(status IN ('running','success','failed','skipped','timeout')),
      trigger_source TEXT NOT NULL CHECK(trigger_source IN ('schedule','manual')),attempt INTEGER NOT NULL CHECK(attempt>0),duration_ms INTEGER NULL,
      summary TEXT NULL,error_message TEXT NULL,output_excerpt TEXT NULL,created_at INTEGER NOT NULL,source TEXT NOT NULL CHECK(source='local'),
      config_revision INTEGER NOT NULL CHECK(config_revision>0),task_name_snapshot TEXT NOT NULL);
    CREATE INDEX idx_scheduled_task_runs_history ON scheduled_task_runs(task_id,created_at DESC,id DESC);
    CREATE INDEX idx_scheduled_task_runs_device ON scheduled_task_runs(client_id,device_id,created_at DESC,id DESC);`);
}

test("D08 v97 runtime capability remains separate from v98 account history and preserves W96 read-only local capability", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "d08-runtime-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  for (const scope of ["application", "workspace"] as const) {
    const file = path.join(root, `${scope}.db`), db = openSqliteDb(file);
    try {
      migrateClientDb(db, { scope });
      assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
      assert.deepEqual(tableColumnContract(db, "scheduled_task_runtime_states").at(-1), ["last_workflow_sequence", "INTEGER", 0, null, 0]);
      if (scope === "workspace") restoreLegacyWorkspaceTaskSchema(db);
      db.exec("ALTER TABLE scheduled_task_runtime_states DROP COLUMN last_workflow_sequence");
      if (scope === "workspace") db.pragma("user_version = 96");
      else setApplicationFixtureVersion(db, 96);
      const before = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      if (scope === "workspace") {
        assert.equal(assertWorkspaceDbReadOnlySchema(db).schemaVersion, 96);
        assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), before);
      }
      migrateClientDb(db, { scope });
      assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_READER_SCHEMA_VERSION);
      const insert = db.prepare("INSERT INTO scheduled_task_runtime_states(task_id,client_id,device_id,last_workflow_instance_id,last_workflow_sequence,updated_at) VALUES(?,?,?,?,?,?)");
      insert.run("bare", "client", "device", "old", null, 1);
      assert.throws(() => insert.run("other-bare", "client", "device", "old", 1, 1));
      assert.throws(() => insert.run('__account_scheduled_task__:["http://a","u","client","device","t"]', "client", "device", null, 1, 1));
    } finally { db.close(); }
  }
});

for (const version of [96,97]) test(`D08 W${version} Inspector只读阻迁移，v98升级失败回滚且保留原本机历史`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "d08-account-run-migration-"));
  const directory = path.join(root, "workspace"); fs.mkdirSync(directory);
  const app = openClientDb({ dbPath: path.join(root, "app.db") });
  const workspaceId = "migration-client:workspace" as any;
  app.workspaces.upsert({ id: workspaceId, title: "migration", path: directory });
  app.withAccountScheduledTasks(workspaceId, () => {});
  const file = path.join(directory, ".codeflowai", "workspace.db"), db = openSqliteDb(file);
  try {
    restoreLegacyWorkspaceTaskSchema(db);
    if (version === 96) db.exec("ALTER TABLE scheduled_task_runtime_states DROP COLUMN last_workflow_sequence");
    db.exec(`PRAGMA user_version=${version};
      INSERT INTO scheduled_task_runs(id,task_id,client_id,device_id,workspace_id,scheduled_at,started_at,finished_at,status,trigger_source,attempt,duration_ms,summary,created_at,source,config_revision,task_name_snapshot)
      VALUES('local-run','local-task','client','device','migration-client:workspace',1,NULL,1,'skipped','schedule',1,NULL,'保留本机事实',1,'local',1,'旧任务');
      INSERT INTO scheduled_task_runtime_states(task_id,client_id,device_id,running_run_id,updated_at)
      VALUES('__account_scheduled_task__:["http://localhost","old-user","client","device","missing-config"]','client','device','workflow-run',1);`);
    const bytes = fs.readFileSync(file), rows = db.prepare("SELECT * FROM scheduled_task_runs").all();
    assert.deepEqual(app.listAccountScheduledRunning(workspaceId, null), [{ taskId: "missing-config", runId: "workflow-run" }]);
    assert.deepEqual(fs.readFileSync(file), bytes);
    const nativeExec = db.exec.bind(db), failure = new Error("D08_V98_DDL_FAILED"); let fail = true;
    t.mock.method(db, "exec", (sql: string) => { nativeExec(sql); if (fail && sql.includes("CREATE TABLE scheduled_task_runs (")) throw failure; });
    assert.throws(() => migrateClientDb(db, { scope: "workspace" }), cause => cause === failure);
    assert.equal(db.pragma("user_version", { simple: true }), version); assert.deepEqual(db.prepare("SELECT * FROM scheduled_task_runs").all(), rows);
    fail = false; migrateClientDb(db, { scope: "workspace" });
    assert.equal(assertWorkspaceDbReadOnlySchema(db).schemaVersion, CLIENT_DB_SCHEMA_VERSION);
    assert.deepEqual(db.prepare("SELECT id,summary,source,config_revision FROM scheduled_task_runs").all(), [{ id: "local-run", summary: "保留本机事实", source: "local", config_revision: 1 }]);
  } finally { db.close(); app.close(); fs.rmSync(root, { recursive: true }); }
});

/** 独立构造已发布 93 Profile 物理合同，不能由待测迁移生成旧库。 */
function createV93Workspace(db: ReturnType<typeof openSqliteDb>): void {
  db.exec(`CREATE TABLE workspace_execution_profiles (
    scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, user_id TEXT NOT NULL,
    profile_text TEXT NOT NULL, profile_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY (scope_type, scope_id, user_id));
    CREATE INDEX idx_workspace_exec_profiles_user ON workspace_execution_profiles(user_id);
    INSERT INTO workspace_execution_profiles VALUES ('shared_workspace','scope','user','保留正文','stable-hash',1,2);
    PRAGMA application_id = 1128683347; PRAGMA user_version = 93;`);
}

for (const initial of ["NORMAL", "OFF"] as const) {
  test(`D18 writer FULL workspace restores ${initial} before migration and retains existing data`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "writer-full-"));
    t.after(() => fs.rmSync(root, { recursive: true }));
    const db = openSqliteDb(path.join(root, "writer.db"));
    try {
      createV93Workspace(db);
      const before = db.prepare("SELECT * FROM workspace_execution_profiles").all();
      db.pragma(`synchronous = ${initial}`);
      assert.equal(db.pragma("synchronous", { simple: true }), initial === "NORMAL" ? 1 : 0);
      migrateClientDb(db, { scope: "workspace" });
      assert.equal(db.pragma("synchronous", { simple: true }), 2);
      assert.equal(db.pragma("journal_mode", { simple: true }), "delete");
      assert.equal(db.pragma("application_id", { simple: true }), 0x43465753);
      assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
      assert.deepEqual(db.prepare("SELECT * FROM workspace_execution_profiles").all(), before);
      db.pragma(`synchronous = ${initial}`);
      migrateClientDb(db, { scope: "workspace" });
      assert.equal(db.pragma("synchronous", { simple: true }), 2);
      assert.deepEqual(db.prepare("SELECT * FROM workspace_execution_profiles").all(), before);
    } finally { db.close(); }
  });
}

for (const boundary of ["set", "readback-error", "readback"] as const) {
  test(`D18 writer FULL workspace ${boundary} failure stops before journal and schema side effects`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "writer-full-failure-"));
    t.after(() => fs.rmSync(root, { recursive: true }));
    const db = openSqliteDb(path.join(root, "writer.db"));
    try {
      createV93Workspace(db);
      db.pragma("synchronous = OFF");
      const schema = db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all();
      const kind = db.pragma("application_id", { simple: true }), version = db.pragma("user_version", { simple: true });
      const nativePragma = db.pragma.bind(db), calls: string[] = [];
      const failure = Object.assign(new Error("controlled FULL setting rejected"), { code: "CONTROLLED_SQLITE_IO" });
      t.mock.method(db, "pragma", (sql: string, options?: { simple?: boolean }) => {
        calls.push(sql);
        if (sql === "synchronous = FULL" && boundary === "set") throw failure;
        if (sql === "synchronous" && boundary === "readback-error") throw failure;
        if (sql === "synchronous" && boundary === "readback") return 0;
        return nativePragma(sql, options);
      });
      assert.throws(() => migrateClientDb(db, { scope: "workspace" }), error => boundary !== "readback" ? error === failure
        : error instanceof Error && (error as Error & { code?: string }).code === "CLIENT_DB_SYNCHRONOUS_MODE_INVALID");
      assert.equal(calls.some(sql => /journal_mode\s*=|foreign_keys\s*=/u.test(sql)), false);
      assert.equal(nativePragma("journal_mode", { simple: true }), "delete");
      assert.equal(nativePragma("application_id", { simple: true }), kind);
      assert.equal(nativePragma("user_version", { simple: true }), version);
      assert.deepEqual(db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all(), schema);
    } finally { db.close(); }
  });
}

test("D18 writer FULL readonly workspace validation never writes connection settings or files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "writer-full-readonly-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, "workspace.db"), writer = openSqliteDb(file);
  try { createV93Workspace(writer); } finally { writer.close(); }
  const bytes = fs.readFileSync(file), reader = openSqliteDb(file, { readonly: true, fileMustExist: true });
  try {
    reader.pragma("synchronous = OFF");
    const nativePragma = reader.pragma.bind(reader), calls: string[] = [];
    t.mock.method(reader, "pragma", (sql: string, options?: { simple?: boolean }) => { calls.push(sql); return nativePragma(sql, options); });
    assert.equal(assertWorkspaceDbReadOnlySchema(reader).schemaVersion, 93);
    assert.equal(calls.some(sql => sql.includes("=")), false);
    assert.equal(nativePragma("synchronous", { simple: true }), 0);
    assert.equal(nativePragma("journal_mode", { simple: true }), "delete");
  } finally { reader.close(); }
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(root), ["workspace.db"]);
});

test("D18 writer FULL workspace rejects a caller transaction before journal or schema writes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "writer-full-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const db = openSqliteDb(path.join(root, "writer.db"));
  try {
    createV93Workspace(db);
    db.pragma("synchronous = OFF");
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all();
    const nativePragma = db.pragma.bind(db), calls: string[] = [];
    t.mock.method(db, "pragma", (sql: string, options?: { simple?: boolean }) => { calls.push(sql); return nativePragma(sql, options); });
    db.exec("BEGIN");
    try {
      assert.throws(() => migrateClientDb(db, { scope: "workspace" }), error => error instanceof Error
        && (error as Error & { code?: string }).code === "ERR_SQLITE_ERROR");
      assert.equal(calls.some(sql => /journal_mode\s*=|foreign_keys\s*=/u.test(sql)), false);
      assert.deepEqual(db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all(), schema);
    } finally { db.exec("ROLLBACK"); }
    assert.equal(nativePragma("synchronous", { simple: true }), 0);
    assert.equal(nativePragma("journal_mode", { simple: true }), "delete");
  } finally { db.close(); }
});

test("D18 writer FULL workspace invalid kind does not write any connection setting", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "writer-full-kind-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const db = openSqliteDb(path.join(root, "writer.db"));
  try {
    createV93Workspace(db);
    db.pragma("application_id = 44"); db.pragma("synchronous = OFF");
    const nativePragma = db.pragma.bind(db), calls: string[] = [];
    t.mock.method(db, "pragma", (sql: string, options?: { simple?: boolean }) => { calls.push(sql); return nativePragma(sql, options); });
    assert.throws(() => migrateClientDb(db, { scope: "workspace" }));
    assert.equal(calls.some(sql => sql.includes("=")), false);
    assert.equal(nativePragma("synchronous", { simple: true }), 0);
    assert.equal(nativePragma("journal_mode", { simple: true }), "delete");
  } finally { db.close(); }
});

test("workspace 93 upgrades atomically preserving Profile rows and indexes and the expected task tables", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-prefs-migrate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const existing of [false, true]) {
    const db = openSqliteDb(path.join(root, `${existing}.db`));
    try {
      if (existing) createV93Workspace(db);
      const rows = existing ? db.prepare("SELECT * FROM workspace_execution_profiles").all() : [];
      const indexes = existing ? db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='workspace_execution_profiles' AND type='index' ORDER BY name").all() : [];
      migrateClientDb(db, { scope: "workspace" });
      assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
      assert.equal(db.pragma("application_id", { simple: true }), 0x43465753);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
        ["scheduled_task_account_configs","scheduled_task_configs","scheduled_task_runs","scheduled_task_runtime_states","workspace_execution_profiles","workspace_prefs"].map(name=>({name})));
      assert.deepEqual(db.prepare("SELECT * FROM workspace_execution_profiles").all(), rows);
      if (existing) assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='workspace_execution_profiles' AND type='index' ORDER BY name").all(), indexes);
      assert.deepEqual(tableColumnContract(db, "workspace_prefs"), [
        ["workspace_id", "TEXT", 1, null, 1], ["engine", "TEXT", 1, null, 2],
        ["work_mode", "TEXT", 1, "'general'", 0], ["updated_at", "INTEGER", 1, null, 0],
        ["context_window", "INTEGER", 0, null, 0], ["auto_compact_pct", "INTEGER", 0, null, 0],
      ]);
      assert.deepEqual(foreignKeyContract(db, "workspace_prefs"), []);
      migrateClientDb(db, { scope: "workspace" });
    } finally { db.close(); }
  }
});

for (const boundary of ["ddl", "commit"] as const) {
  test(`workspace 93 prefs ${boundary} failure rolls back schema and version without rewriting Profile`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-prefs-rollback-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const db = openSqliteDb(path.join(root, "workspace.db")), nativeExec = DatabaseSync.prototype.exec;
    try {
      createV93Workspace(db);
      const rows = db.prepare("SELECT * FROM workspace_execution_profiles").all();
      const schema = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      let fail = true;
      const failure = new Error(`WORKSPACE_PREFS_${boundary}_FAILED`);
      t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
        if (fail && (boundary === "ddl" ? sql.startsWith("CREATE TABLE workspace_prefs") : sql === "COMMIT")) throw failure;
        nativeExec.call(this, sql);
      });
      assert.throws(() => migrateClientDb(db, { scope: "workspace" }), error => error === failure);
      assert.equal(db.pragma("user_version", { simple: true }), 93);
      assert.equal(db.pragma("application_id", { simple: true }), 0x43465753);
      assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), schema);
      assert.deepEqual(db.prepare("SELECT * FROM workspace_execution_profiles").all(), rows);
      fail = false; migrateClientDb(db, { scope: "workspace" });
      assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
      assert.equal(tableExists(db, "workspace_prefs"), true);
    } finally { db.close(); }
  });
}

for (const invalid of ["wrong-kind", "future", "unmarked", "profile-columns", "profile-key", "missing-prefs", "prefs-view", "prefs-columns", "prefs-key", "prefs-fk"] as const) {
  test(`workspace rejects ${invalid} before changing persistent journal or schema`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-prefs-invalid-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const db = openSqliteDb(path.join(root, "workspace.db"));
    try {
      createV93Workspace(db);
      if (invalid === "wrong-kind") db.pragma("application_id = 44");
      else if (invalid === "future") db.pragma(`user_version = ${CLIENT_DB_SCHEMA_VERSION+1}`);
      else if (invalid === "unmarked") { db.pragma("application_id = 0"); db.pragma("user_version = 0"); }
      else if (invalid === "profile-columns") db.exec("ALTER TABLE workspace_execution_profiles ADD COLUMN unexpected TEXT");
      else if (invalid === "profile-key") {
        db.exec("DROP TABLE workspace_execution_profiles; CREATE TABLE workspace_execution_profiles (scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,user_id TEXT NOT NULL,profile_text TEXT NOT NULL,profile_hash TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
      } else {
        migrateClientDb(db, { scope: "workspace" }); db.exec("DROP TABLE workspace_prefs");
        if (invalid === "prefs-view") db.exec("CREATE VIEW workspace_prefs AS SELECT 1 AS workspace_id");
        else if (invalid !== "missing-prefs") db.exec(`CREATE TABLE workspace_prefs (
          workspace_id TEXT NOT NULL, engine TEXT NOT NULL, work_mode TEXT NOT NULL DEFAULT 'general',
          updated_at INTEGER NOT NULL, context_window INTEGER NULL, auto_compact_pct INTEGER NULL
          ${invalid === "prefs-columns" ? ", extra TEXT" : ""}
          ${invalid === "prefs-key" ? "" : ", PRIMARY KEY(workspace_id,engine)"}
          ${invalid === "prefs-fk" ? ", FOREIGN KEY(workspace_id) REFERENCES workspaces(id)" : ""})`);
      }
      db.pragma("journal_mode = WAL");
      const before = db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all();
      const version = db.pragma("user_version", { simple: true }), kind = db.pragma("application_id", { simple: true });
      assert.throws(() => migrateClientDb(db, { scope: "workspace" }));
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(db.pragma("user_version", { simple: true }), version);
      assert.equal(db.pragma("application_id", { simple: true }), kind);
      assert.deepEqual(db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all(), before);
    } finally { db.close(); }
  });
}

test("application 94 upgrades the original operation evidence column and exact reader without changing prefs rows", () => {
  const db = openSqliteDb(":memory:");
  try {
    migrateClientDb(db);
    db.exec("ALTER TABLE workspace_directory_migrations DROP COLUMN workspace_db_snapshot_json");
    setApplicationFixtureVersion(db, 94);
    const prefs = db.prepare("SELECT * FROM workspace_prefs").all();
    migrateClientDb(db);
    assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
    assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_READER_SCHEMA_VERSION);
    assert.deepEqual(db.prepare("SELECT * FROM workspace_prefs").all(), prefs);
    assert.equal((db.prepare("PRAGMA table_info(workspace_directory_migrations)").all() as Array<{ name: string; type: string; notnull: number }>).some(column => column.name === "workspace_db_snapshot_json" && column.type === "TEXT" && column.notnull === 0), true);
  } finally { db.close(); }
});

test("application migration rejects workspace kind and negative version before persistent journal writes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "client-db-kind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const invalid of ["workspace", "negative"] as const) {
    const db = openSqliteDb(path.join(root, `${invalid}.db`));
    try {
      if (invalid === "workspace") migrateClientDb(db, { scope: "workspace" });
      else db.pragma("user_version = -1");
      const before = db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all();
      assert.throws(() => migrateClientDb(db));
      assert.equal(db.pragma("journal_mode", { simple: true }), "delete");
      assert.deepEqual(db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all(), before);
    } finally { db.close(); }
  }
});

for(const version of [94,95])for(const boundary of ["ddl","commit"] as const)test(`D18 workspace ${version} task ${boundary} failure rolls back all three tables and preserves prefs`,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"workspace-task-upgrade-"));t.after(()=>fs.rmSync(root,{recursive:true}));
  const db=openSqliteDb(path.join(root,"workspace.db")),nativeExec=DatabaseSync.prototype.exec;
  try{
    createV93Workspace(db);
    db.exec(`CREATE TABLE workspace_prefs(workspace_id TEXT NOT NULL,engine TEXT NOT NULL,work_mode TEXT NOT NULL DEFAULT 'general',updated_at INTEGER NOT NULL,context_window INTEGER NULL,auto_compact_pct INTEGER NULL,PRIMARY KEY(workspace_id,engine));
      INSERT INTO workspace_prefs VALUES('workspace','codex','general',1,123,NULL); PRAGMA user_version=${version}`);
    const schema=db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),prefs=db.prepare("SELECT * FROM workspace_prefs").all();
    let fail=true;const error=new Error("CONTROLLED_TASK_UPGRADE_FAILURE");
    t.mock.method(DatabaseSync.prototype,"exec",function(this:DatabaseSync,sql:string){
      if(fail&&(boundary==="ddl"?sql.includes("CREATE TABLE IF NOT EXISTS scheduled_task_runs"):sql==="COMMIT"))throw error;
      nativeExec.call(this,sql);
    });
    assert.throws(()=>migrateClientDb(db,{scope:"workspace"}),cause=>cause===error);
    assert.equal(db.pragma("user_version",{simple:true}),version);assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),schema);
    assert.deepEqual(db.prepare("SELECT * FROM workspace_prefs").all(),prefs);
    fail=false;migrateClientDb(db,{scope:"workspace"});assert.equal(db.pragma("user_version",{simple:true}),CLIENT_DB_SCHEMA_VERSION);
    assert.deepEqual(db.prepare("SELECT * FROM workspace_prefs").all(),prefs);
  }finally{db.close();}
});

test("migrateClientDb creates covering and partial indexes for runtime evidence reads", () => {
  const db = openSqliteDb(":memory:");
  try {
    migrateClientDb(db as any);
    assert.equal(indexExists(db, "idx_raw_engine_events_thread_seq"), true);
    assert.deepEqual(indexColumns(db, "idx_raw_engine_events_thread_seq"), [
      "thread_id", "seq", "workspace_id", "ts", "source",
    ]);
    assert.equal(indexExists(db, "idx_raw_engine_events_thread_tools"), true);
    assert.equal(indexExists(db, "idx_orch_prompt_snapshots_instance_node_attempt_created"), true);

    const timestampPlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT ts FROM raw_engine_events WHERE thread_id = ? ORDER BY seq ASC",
    ).all("thread-runtime") as Array<{ detail?: string }>;
    assert.match(timestampPlan.map((row) => String(row.detail ?? "")).join("\n"), /COVERING INDEX idx_raw_engine_events_thread_seq/i);

    const toolPlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT ts, event_json FROM raw_engine_events
       WHERE thread_id = ? AND (event_json LIKE '%"tool_use"%' OR event_json LIKE '%"tool_result"%')
       ORDER BY seq ASC`,
    ).all("thread-runtime") as Array<{ detail?: string }>;
    assert.match(toolPlan.map((row) => String(row.detail ?? "")).join("\n"), /idx_raw_engine_events_thread_tools/i);

    const snapshotPlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM orch_prompt_snapshots WHERE instance_id = ? AND node_id = ? AND attempt_no = ? ORDER BY created_at ASC",
    ).all("instance-runtime", "node-runtime", 2) as Array<{ detail?: string }>;
    assert.match(snapshotPlan.map((row) => String(row.detail ?? "")).join("\n"), /idx_orch_prompt_snapshots_instance_node_attempt_created/i);
  } finally {
    db.close();
  }
});

test("运行证据索引修复校验完整定义，正确索引重复迁移不重建", async (t) => {
  const cases = [
    {
      name: "覆盖索引意外带有部分谓词",
      index: "idx_raw_engine_events_thread_seq",
      sql: `CREATE INDEX idx_raw_engine_events_thread_seq
        ON raw_engine_events(thread_id, seq, workspace_id, ts, source) WHERE seq > 0`,
    },
    {
      name: "工具索引遗漏结果事件",
      index: "idx_raw_engine_events_thread_tools",
      sql: `CREATE INDEX idx_raw_engine_events_thread_tools
        ON raw_engine_events(thread_id, seq, ts) WHERE event_json LIKE '%"tool_use"%'`,
    },
    {
      name: "工具索引字面量大小写变化",
      index: "idx_raw_engine_events_thread_tools",
      sql: `CREATE INDEX idx_raw_engine_events_thread_tools
        ON raw_engine_events(thread_id, seq, ts)
        WHERE event_json LIKE '%"TOOL_USE"%' OR event_json LIKE '%"TOOL_RESULT"%'`,
    },
    {
      name: "工具索引指向错误表",
      index: "idx_raw_engine_events_thread_tools",
      sql: `CREATE INDEX idx_raw_engine_events_thread_tools
        ON conversation_events(thread_id, seq, ts)
        WHERE event_json LIKE '%"tool_use"%' OR event_json LIKE '%"tool_result"%'`,
    },
    {
      name: "工具索引列顺序错误",
      index: "idx_raw_engine_events_thread_tools",
      sql: `CREATE INDEX idx_raw_engine_events_thread_tools
        ON raw_engine_events(seq, thread_id, ts)
        WHERE event_json LIKE '%"tool_use"%' OR event_json LIKE '%"tool_result"%'`,
    },
    {
      name: "快照索引缺失 attempt 条件",
      index: "idx_orch_prompt_snapshots_instance_node_attempt_created",
      sql: `CREATE INDEX idx_orch_prompt_snapshots_instance_node_attempt_created
        ON orch_prompt_snapshots(instance_id, node_id, created_at ASC)`,
    },
    {
      name: "快照索引排序方向错误",
      index: "idx_orch_prompt_snapshots_instance_node_attempt_created",
      sql: `CREATE INDEX idx_orch_prompt_snapshots_instance_node_attempt_created
        ON orch_prompt_snapshots(instance_id, node_id, attempt_no, created_at DESC)`,
    },
    {
      name: "工具索引缺失",
      index: "idx_raw_engine_events_thread_tools",
      sql: "",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const db = openSqliteDb(":memory:");
      try {
        migrateClientDb(db);
        const expected = runtimeEvidenceIndexes(db);
        db.exec(`DROP INDEX ${scenario.index}`);
        if (scenario.sql) db.exec(scenario.sql);
        migrateClientDb(db);
        assert.deepEqual(runtimeEvidenceIndexes(db), expected);

        const schemaVersion = db.pragma("schema_version", { simple: true });
        migrateClientDb(db);
        assert.equal(db.pragma("schema_version", { simple: true }), schemaVersion);
        assert.deepEqual(runtimeEvidenceIndexes(db), expected);
      } finally {
        db.close();
      }
    });
  }
});

for (const version of [86, EXPECTED_CLIENT_SCHEMA_VERSION]) {
  for (const failedIndex of [
    "idx_raw_engine_events_thread_seq",
    "idx_raw_engine_events_thread_tools",
    "idx_orch_prompt_snapshots_instance_node_attempt_created",
  ]) {
    test(`v${version} 运行证据索引 ${failedIndex} 重建失败时保留旧索引、版本及原始事件`, () => {
      const clientDb = openClientDb({ dbPath: ":memory:" });
      const db = clientDb.db;
      try {
        clientDb.workspaces.upsert({ id: "ws-runtime-index" as any, title: "索引回滚", path: "." });
        clientDb.threads.create({ id: "thread-runtime-index" as any, workspaceId: "ws-runtime-index" as any, engine: "claude", title: "索引回滚" });
        db.prepare(`INSERT INTO raw_engine_events (seq, thread_id, workspace_id, engine, source, event_json, ts)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(1, "thread-runtime-index", "ws-runtime-index", "claude", "test", '{"type":"tool_result"}', 100);
        db.exec(`
          DROP INDEX idx_raw_engine_events_thread_seq;
          DROP INDEX idx_raw_engine_events_thread_tools;
          DROP INDEX idx_orch_prompt_snapshots_instance_node_attempt_created;
          CREATE INDEX idx_raw_engine_events_thread_seq ON raw_engine_events(thread_id, seq);
          CREATE INDEX idx_raw_engine_events_thread_tools ON raw_engine_events(thread_id, seq, ts)
            WHERE event_json LIKE '%"tool_use"%';
          CREATE INDEX idx_orch_prompt_snapshots_instance_node_attempt_created
            ON orch_prompt_snapshots(instance_id, node_id, created_at ASC);
        `);
        setApplicationFixtureVersion(db, version);
        const originalIndexes = runtimeEvidenceIndexes(db);
        const originalEvents = db.prepare("SELECT * FROM raw_engine_events ORDER BY seq").all();
        const failure = new Error(`injected runtime index creation failure: ${failedIndex}`);
        const failingDb = new Proxy(db, {
          get(target, property) {
            if (property === "exec") {
              return (sql: string) => {
                if (new RegExp(`CREATE INDEX\\s+${failedIndex}\\b`).test(sql)) throw failure;
                return target.exec(sql);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });

        assert.throws(() => migrateClientDb(failingDb), (error) => error === failure);
        assert.equal(db.pragma("user_version", { simple: true }), version);
        assert.deepEqual(runtimeEvidenceIndexes(db), originalIndexes);
        assert.deepEqual(db.prepare("SELECT * FROM raw_engine_events ORDER BY seq").all(), originalEvents);

        migrateClientDb(db);
        assert.equal(db.pragma("user_version", { simple: true }), EXPECTED_CLIENT_SCHEMA_VERSION);
        assert.deepEqual(db.prepare("SELECT * FROM raw_engine_events ORDER BY seq").all(), originalEvents);
        const tools = db.prepare(`SELECT seq FROM raw_engine_events
          WHERE thread_id = ? AND (event_json LIKE '%"tool_use"%' OR event_json LIKE '%"tool_result"%')`).all("thread-runtime-index");
        assert.deepEqual(tools, [{ seq: 1 }]);
      } finally {
        clientDb.close();
      }
    });
  }
}

test("plain client SQLite supports the required FTS5 trigram tokenizer", () => {
  const db = openSqliteDb(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE client_fts_probe USING fts5(value, tokenize='trigram')");
    db.prepare("INSERT INTO client_fts_probe(value) VALUES (?)").run("CodeFlow Client");
    assert.deepEqual(db.prepare("SELECT value FROM client_fts_probe WHERE client_fts_probe MATCH ?").all("Flow"), [
      { value: "CodeFlow Client" },
    ]);
  } finally {
    db.close();
  }
});

test("migrateClientDb checkpoints nontransactional boundaries and retries a failed atomic batch", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-atomic-migration-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  try {
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "exec") {
          return (sql: string) => {
            if (sql.includes("CREATE VIRTUAL TABLE IF NOT EXISTS orch_intake_search_fts")) {
              throw new Error("injected FTS5 migration failure");
            }
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    assert.throws(() => migrateClientDb(failingDb as any), /injected FTS5 migration failure/);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), 28);
    assert.equal(tableExists(db, "orch_intake_search_fts"), false);

    migrateClientDb(db as any);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
    assert.equal(tableExists(db, "orch_intake_search_fts"), true);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb recovers a legacy partial schema whose user_version remained zero", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-partial-replay-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  try {
    migrateClientDb(db as any);
    setApplicationFixtureVersion(db, 0);

    migrateClientDb(db as any);

    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
    assert.deepEqual(
      tableColumnContract(db, "turn_file_changes").map((column) => (column as unknown[])[0]).filter((name) => name === "step_key" || name === "accepted_blob_id"),
      ["step_key", "accepted_blob_id"],
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates V81 code attribution outbox contract", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-v81-outbox-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  try {
    migrateClientDb(db as any);
    assert.equal(tableExists(db, "code_attribution_outbox"), true);
    assert.deepEqual(
      tableColumnContract(db, "code_attribution_outbox").map((column) => (column as unknown[])[0]),
      [
        "id", "source_batch_id", "workspace_id", "instance_id", "repository", "commit_sha",
        "content_sha256", "payload_json", "association_id", "association_expires_at", "status",
        "attempt_count", "available_at", "lease_owner", "lease_expires_at", "last_error_code",
        "last_error_message", "created_at", "updated_at",
      ],
    );
    assert.deepEqual(foreignKeyContract(db, "code_attribution_outbox"), [
      "orch_instances:instance_id->id:CASCADE",
      "workspaces:workspace_id->id:CASCADE",
    ]);
    assert.deepEqual(namedIndexes(db, "code_attribution_outbox"), ["idx_code_attribution_outbox_ready"]);
    assert.deepEqual(indexColumns(db, "idx_code_attribution_outbox_ready"), [
      "status", "available_at", "lease_expires_at", "created_at", "id",
    ]);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb repairs a missing V81 outbox after version collision", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-v81-repair-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  try {
    migrateClientDb(db as any);
    db.exec("DROP TABLE code_attribution_outbox");
    assert.equal(tableExists(db, "code_attribution_outbox"), false);
    migrateClientDb(db as any);
    assert.equal(tableExists(db, "code_attribution_outbox"), true);
    assert.equal(indexExists(db, "idx_code_attribution_outbox_ready"), true);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates V82 Client-local retention task contract", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-v82-retention-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  try {
    migrateClientDb(db as any);
    assert.equal(tableExists(db, "code_attribution_retention_tasks"), true);
    assert.deepEqual(
      tableColumnContract(db, "code_attribution_retention_tasks").map((column) => (column as unknown[])[0]),
      [
        "id", "workspace_id", "instance_id", "repository_path", "repository", "commit_sha",
        "file_path", "file_identity_sha256", "retained_lines_json", "retained_ai_added_lines",
        "window_days", "due_at", "status", "attempt_count", "available_at", "lease_owner",
        "lease_expires_at", "last_error_code", "created_at", "updated_at",
      ],
    );
    assert.deepEqual(foreignKeyContract(db, "code_attribution_retention_tasks"), [
      "orch_instances:instance_id->id:CASCADE",
      "workspaces:workspace_id->id:CASCADE",
    ]);
    assert.deepEqual(namedIndexes(db, "code_attribution_retention_tasks"), [
      "idx_code_attribution_retention_tasks_ready",
    ]);
    assert.deepEqual(indexColumns(db, "idx_code_attribution_retention_tasks_ready"), [
      "status", "due_at", "available_at", "lease_expires_at", "created_at", "id",
    ]);
    assert.throws(() => db.prepare(`INSERT INTO code_attribution_retention_tasks (
      id, workspace_id, instance_id, repository_path, repository, commit_sha, file_path,
      file_identity_sha256, retained_lines_json, retained_ai_added_lines, window_days, due_at,
      status, attempt_count, available_at, created_at, updated_at
    ) VALUES ('invalid', 'missing', 'missing', '', 'repo', ?, 'a.ts', ?, '[]', 0, 14, 0,
      'pending', 0, 0, 0, 0)`).run("a".repeat(40), "b".repeat(64)), /constraint/i);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb repairs a missing V82 retention table after version collision", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-v82-repair-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  try {
    migrateClientDb(db as any);
    db.exec("DROP TABLE code_attribution_retention_tasks");
    migrateClientDb(db as any);
    assert.equal(tableExists(db, "code_attribution_retention_tasks"), true);
    assert.equal(indexExists(db, "idx_code_attribution_retention_tasks_ready"), true);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb backfills V80 narrow summaries and intake projections", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-v80-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  const workspaceId = "workspace-v74-backfill";
  const intakeId = "intake-v74-backfill";
  const instanceId = "instance-v74-backfill";
  const intake = {
    id: intakeId,
    workspaceId,
    triggerMode: "manual",
    taskType: "feature",
    title: "V80 回填需求",
    goal: "验证窄摘要和列表投影",
    requester: { source: "ui" },
    createdAt: 1,
    updatedAt: 2,
  };
  const workflow = {
    id: "workflow-v74-backfill",
    workspaceId,
    name: "V80 回填流程",
    description: "",
    nodes: [{ id: "role", type: "role", roleId: "role-v74", label: "执行", position: { x: 0, y: 0 } }],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const nodeStates = {
    role: { nodeId: "role", status: "waiting-approval", retryCount: 0 },
  };

  try {
    migrateClientDb(db as any);
    db.prepare(
      "INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "V80", tempDir, 1, 1);
    db.prepare(
      `INSERT INTO orch_intakes (id, workspace_id, task_type, goal, intake_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(intakeId, workspaceId, "feature", intake.goal, JSON.stringify(intake), 1, 2);
    db.prepare(
      `INSERT INTO orch_instances (
         id, workspace_id, workflow_id, workflow_snapshot_json, proposal_id,
         intake_snapshot_json, role_snapshots_json, toolset_snapshots_json,
         runtime_config_json, artifact_index_json, master_thread_id, status,
         node_states_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', NULL, '{}', NULL, ?, ?, ?, ?)`,
    ).run(
      instanceId,
      workspaceId,
      workflow.id,
      JSON.stringify(workflow),
      JSON.stringify(intake),
      "waiting-approval",
      JSON.stringify(nodeStates),
      1,
      2,
    );
    db.exec(`
      DROP TABLE orch_instance_summaries;
      DELETE FROM orch_intake_list_states;
      DELETE FROM orch_intake_search_fts;
    `);
    setApplicationFixtureVersion(db, 73);

    migrateClientDb(db as any);

    const summary = db.prepare(
      "SELECT workspace_id, intake_id, status, projection_version FROM orch_instance_summaries WHERE instance_id = ?",
    ).get(instanceId);
    assert.deepEqual(summary, {
      workspace_id: workspaceId,
      intake_id: intakeId,
      status: "waiting-approval",
      projection_version: 1,
    });
    const state = db.prepare(
      `SELECT source_kind, list_status, latest_instance_id, instance_count
       FROM orch_intake_list_states WHERE workspace_id = ? AND intake_id = ?`,
    ).get(workspaceId, intakeId);
    assert.deepEqual(state, {
      source_kind: "requirement",
      list_status: "waiting-approval",
      latest_instance_id: instanceId,
      instance_count: 1,
    });
    const searchCount = db.prepare(
      "SELECT COUNT(1) AS total FROM orch_intake_search_fts WHERE workspace_id = ? AND intake_id = ?",
    ).get(workspaceId, intakeId) as { total?: number } | undefined;
    assert.equal(Number(searchCount?.total ?? 0), 1);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb rejects missing intake state and search projections", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-projection-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  const workspaceId = "workspace-projection-integrity";
  const intakeId = "intake-projection-integrity";
  const intake = {
    id: intakeId,
    workspaceId,
    triggerMode: "manual",
    taskType: "feature",
    title: "投影完整性",
    goal: "拒绝静默漏项",
    requester: { source: "ui" },
    createdAt: 1,
    updatedAt: 2,
  };

  try {
    migrateClientDb(db as any);
    db.prepare(
      "INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "projection", tempDir, 1, 1);
    db.prepare(
      `INSERT INTO orch_intakes (id, workspace_id, task_type, goal, intake_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(intakeId, workspaceId, "feature", intake.goal, JSON.stringify(intake), 1, 2);

    assert.throws(
      () => migrateClientDb(db as any),
      (error: any) => error?.code === "ORCH_INTAKE_LIST_PROJECTION_INCOMPLETE"
        && error?.details?.projectionRole === "state",
    );

    db.prepare(
      `INSERT INTO orch_intake_list_states (
         workspace_id, intake_id, source_kind, list_status,
         latest_instance_id, latest_instance_status, instance_count,
         workflow_name, progress_text, updated_at, rebuilt_at
       ) VALUES (?, ?, 'requirement', 'not-started', NULL, NULL, 0, NULL, NULL, ?, ?)`,
    ).run(workspaceId, intakeId, 2, 2);
    assert.throws(
      () => migrateClientDb(db as any),
      (error: any) => error?.code === "ORCH_INTAKE_LIST_PROJECTION_INCOMPLETE"
        && error?.details?.projectionRole === "search",
    );

    db.prepare(
      `INSERT INTO orch_intake_search_fts (intake_id, workspace_id, source_kind, title, summary)
       VALUES (?, ?, 'requirement', ?, ?)`,
    ).run(intakeId, workspaceId, intake.title, intake.goal);
    migrateClientDb(db as any);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb rejects list projection source kind inconsistent with intake facts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-source-integrity-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const workspaceId = "workspace-source-integrity" as any;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "source integrity", path: tempDir });
    const intake = db.orchIntakes.create({
      workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "普通需求来源",
      goal: "错误来源投影必须阻止启动",
      requester: { source: "ui" },
    });
    db.db.prepare(
      "UPDATE orch_intake_list_states SET source_kind = 'scheduled_task' WHERE workspace_id = ? AND intake_id = ?",
    ).run(String(workspaceId), String(intake.id));
    db.db.prepare(
      "DELETE FROM orch_intake_search_fts WHERE workspace_id = ? AND intake_id = ?",
    ).run(String(workspaceId), String(intake.id));
    db.db.prepare(
      `INSERT INTO orch_intake_search_fts (intake_id, workspace_id, source_kind, title, summary)
       VALUES (?, ?, 'scheduled_task', ?, ?)`,
    ).run(String(intake.id), String(workspaceId), intake.title, intake.goal);

    assert.throws(
      () => migrateClientDb(db.db as any),
      (error: any) => error?.code === "ORCH_INTAKE_LIST_PROJECTION_INCOMPLETE"
        && error?.details?.reason === "source_kind_mismatch"
        && error?.details?.field === "sourceKind"
        && error?.details?.expected === "requirement"
        && error?.details?.actual === "scheduled_task",
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb rejects list state inconsistent with narrow instance summaries", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-state-integrity-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const workspaceId = "workspace-state-integrity" as any;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "state integrity", path: tempDir });
    const intake = db.orchIntakes.create({
      workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "列表状态一致性",
      goal: "真实实例不能被投影伪装成未启动",
      requester: { source: "ui" },
    });
    const workflow = {
      id: "workflow-state-integrity",
      workspaceId,
      family: "feature-dev",
      name: "状态一致性流程",
      description: "",
      workflowKnowledgeBundleIds: [],
      nodes: [],
      edges: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    } as any;
    db.orchInstances.create({
      workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      intakeSnapshot: intake,
    });
    db.db.prepare(
      `UPDATE orch_intake_list_states
       SET instance_count = 0,
           latest_instance_id = NULL,
           latest_instance_status = NULL,
           list_status = 'not-started'
       WHERE workspace_id = ? AND intake_id = ?`,
    ).run(String(workspaceId), String(intake.id));

    assert.throws(
      () => migrateClientDb(db.db as any),
      (error: any) => error?.code === "ORCH_INTAKE_LIST_PROJECTION_INCOMPLETE"
        && error?.details?.reason === "state_summary_mismatch"
        && error?.details?.field === "instanceCount"
        && error?.details?.expected === 1
        && error?.details?.actual === 0,
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates controlled experiment evidence tables", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const snapshotColumns = db.prepare("PRAGMA table_info(controlled_experiment_snapshots)").all() as Array<{ name?: string }>;
    const runColumns = db.prepare("PRAGMA table_info(controlled_experiment_runs)").all() as Array<{ name?: string }>;
    const runIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'controlled_experiment_runs' ORDER BY name",
    ).all() as Array<{ name?: string }>;
    const diffSnapshotColumns = db.prepare("PRAGMA table_info(conversation_diff_snapshots)").all() as Array<{ name?: string }>;
    const workItemColumns = db.prepare("PRAGMA table_info(orch_node_work_items)").all() as Array<{ name?: string }>;
    assert.ok(snapshotColumns.some((column) => column.name === "catalog_version"));
    assert.ok(snapshotColumns.some((column) => column.name === "price_snapshot_json"));
    assert.ok(runColumns.some((column) => column.name === "dispatch_token_sha256"));
    assert.ok(runIndexes.some((row) => row.name === "idx_controlled_experiment_runs_recovery"));
    assert.deepEqual(diffSnapshotColumns.map((column) => String(column.name ?? "")), [
      "thread_id",
      "diff_key",
      "event_seq",
      "diff_text",
      "diff_sha256",
      "diff_bytes",
      "updated_at",
    ]);
    assert.ok(workItemColumns.some((column) => column.name === "acceptance_criteria_json"));
    assert.ok(workItemColumns.some((column) => column.name === "completion_checks_json"));
    assert.ok(workItemColumns.some((column) => column.name === "output_sha256"));
    assert.equal(tableExists(db, ORCH_INSTANCE_SUMMARY_TABLE_NAME), true);
    assert.equal(indexExists(db, ORCH_INSTANCE_SUMMARY_WORKSPACE_INDEX_NAME), true);
    assert.equal(indexExists(db, ORCH_INSTANCE_SUMMARY_INTAKE_INDEX_NAME), true);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb repairs catalog_version on existing controlled experiment snapshots", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    db.exec(`
      CREATE TABLE controlled_experiment_snapshots (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        freeze_revision INTEGER NOT NULL,
        workspace_id TEXT NOT NULL,
        sample_id TEXT NOT NULL,
        evaluation_item_id TEXT NOT NULL,
        source_instance_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        prompt_snapshot_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        variant_key TEXT NOT NULL,
        engine TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NULL,
        prompt_envelope_json TEXT NOT NULL,
        system_message TEXT NOT NULL,
        developer_message TEXT NULL,
        user_message TEXT NOT NULL,
        artifact_input_json TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        config_sha256 TEXT NOT NULL,
        prompt_definition_sha256 TEXT NOT NULL,
        price_snapshot_json TEXT NOT NULL,
        price_snapshot_sha256 TEXT NOT NULL,
        freeze_digest TEXT NOT NULL,
        per_run_timeout_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    migrateClientDb(db as any);
    const snapshotColumns = db.prepare("PRAGMA table_info(controlled_experiment_snapshots)").all() as Array<{ name?: string }>;
    assert.ok(snapshotColumns.some((column) => column.name === "catalog_version"));
    migrateClientDb(db as any);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates and repairs the nullable instance asset runtime snapshot column", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);
    const expectedIndexes = namedIndexes(db, "orch_instances");
    const readColumn = () => tableColumnContract(db, "orch_instances")
      .find((column) => Array.isArray(column) && column[0] === "asset_runtime_snapshot_json");
    assert.deepEqual(readColumn(), ["asset_runtime_snapshot_json", "TEXT", 0, null, 0]);

    db.exec("ALTER TABLE orch_instances DROP COLUMN asset_runtime_snapshot_json");
    assert.equal(readColumn(), undefined);
    migrateClientDb(db as any);

    assert.deepEqual(readColumn(), ["asset_runtime_snapshot_json", "TEXT", 0, null, 0]);
    assert.deepEqual(namedIndexes(db, "orch_instances"), expectedIndexes);

    db.exec("ALTER TABLE orch_instances DROP COLUMN asset_runtime_snapshot_json");
    db.prepare("INSERT INTO workspaces(id, title, path, is_deleted, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)")
      .run("ws-v70-runtime-snapshot", "v70 workspace", "D:/v70-runtime-snapshot");
    db.prepare(`
      INSERT INTO orch_instances(
        id, workspace_id, workflow_id, workflow_snapshot_json, proposal_id,
        intake_snapshot_json, role_snapshots_json, toolset_snapshots_json,
        runtime_config_json, artifact_index_json, master_thread_id, status,
        node_states_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', NULL, '{}', NULL, 'pending', '{}', 1, 1)
    `).run(
      "instance-v70-runtime-snapshot",
      "ws-v70-runtime-snapshot",
      "workflow-v70-runtime-snapshot",
      JSON.stringify({
        id: "workflow-v70-runtime-snapshot",
        workspaceId: "ws-v70-runtime-snapshot",
        name: "v70 workflow",
        description: "",
        nodes: [],
        edges: [],
        version: 1,
      }),
      JSON.stringify({
        id: "intake-v70-runtime-snapshot",
        workspaceId: "ws-v70-runtime-snapshot",
        triggerMode: "manual",
        taskType: "feature",
        title: "v70 intake",
        goal: "upgrade",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    setApplicationFixtureVersion(db, 70);
    migrateClientDb(db as any);

    const upgraded = db.prepare("SELECT asset_runtime_snapshot_json FROM orch_instances WHERE id = ?")
      .get("instance-v70-runtime-snapshot") as { asset_runtime_snapshot_json?: unknown } | undefined;
    assert.equal(upgraded?.asset_runtime_snapshot_json, null);
    assert.deepEqual(readColumn(), ["asset_runtime_snapshot_json", "TEXT", 0, null, 0]);
    assert.deepEqual(namedIndexes(db, "orch_instances"), expectedIndexes);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb reconciles divergent v65 and v66 feature schemas", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    db.exec(`
      DROP TABLE controlled_experiment_runs;
      DROP TABLE controlled_experiment_snapshots;
    `);
    setApplicationFixtureVersion(db, 66);
    migrateClientDb(db as any);
    assert.equal(tableExists(db, "controlled_experiment_snapshots"), true);
    assert.equal(tableExists(db, "controlled_experiment_runs"), true);

    db.exec(`
      DROP TABLE orch_node_work_item_events;
      DROP TABLE orch_node_work_items;
      DROP TABLE orch_node_work_item_boards;
    `);
    setApplicationFixtureVersion(db, 65);
    migrateClientDb(db as any);
    assert.equal(tableExists(db, "orch_node_work_item_boards"), true);
    assert.equal(tableExists(db, "orch_node_work_items"), true);
    assert.equal(tableExists(db, "orch_node_work_item_events"), true);
    const workItemColumns = db.prepare("PRAGMA table_info(orch_node_work_items)").all() as Array<{ name?: string }>;
    assert.ok(workItemColumns.some((column) => column.name === "acceptance_criteria_json"));
    assert.ok(workItemColumns.some((column) => column.name === "completion_checks_json"));
    assert.ok(workItemColumns.some((column) => column.name === "output_sha256"));
    assert.equal(indexExists(db, "idx_threads_cleanup_updated_id"), true);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb repairs prompt snapshot schema drift during migration", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE engine_keys (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        engine TEXT NOT NULL,
        provider_id TEXT NULL,
        api_key TEXT NOT NULL,
        base_url TEXT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE orch_instances (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE orch_artifacts (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE orch_prompt_snapshots (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL DEFAULT 1,
        thread_id TEXT NULL,
        turn_id TEXT NULL,
        engine TEXT NOT NULL,
        model TEXT NULL,
        effort TEXT NULL,
        system_message TEXT NOT NULL,
        developer_message TEXT NULL,
        user_message TEXT NOT NULL,
        rendered_input_preview TEXT NOT NULL,
        runtime_policy_json TEXT NOT NULL,
        tool_registry_json TEXT NULL,
        knowledge_catalogs_json TEXT NULL,
        artifact_input_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE orch_asset_generation_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        asset_kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.pragma("user_version = 36");

    migrateClientDb(db as any);

    const columns = db.prepare("PRAGMA table_info(orch_prompt_snapshots)").all() as Array<{ name?: string | null }>;
    assert.ok(columns.some((column) => String(column.name ?? "") === "prompt_envelope_json"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates thread list and running-turn indexes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'thread_turns' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    const threadIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    const threadColumns = db.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: string | null }>;
    const threadColumnNames = new Set(threadColumns.map((column) => String(column.name ?? "")));
    assert.ok(indexes.some((row) => String(row.name ?? "") === "idx_thread_turns_workspace_running"));
    assert.ok(threadIndexes.some((row) => String(row.name ?? "") === "idx_threads_workspace_pinned_updated"));
    assert.ok(threadIndexes.some((row) => String(row.name ?? "") === "idx_threads_cleanup_updated_id"));
    const cleanupIndexColumns = db.prepare("PRAGMA index_info(idx_threads_cleanup_updated_id)").all() as Array<{
      name?: string | null;
    }>;
    assert.deepEqual(cleanupIndexColumns.map((row) => String(row.name ?? "")), ["updated_at", "id"]);
    const promptIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orch_prompt_snapshots' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.deepEqual(promptIndexes.map((row) => String(row.name ?? "")), [
      "idx_orch_prompt_snapshots_instance_node_attempt_created",
      "idx_orch_prompt_snapshots_instance_node_created",
      "idx_orch_prompt_snapshots_thread_instance",
      "sqlite_autoindex_orch_prompt_snapshots_1",
    ]);
    assert.ok(threadColumnNames.has("role_id"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb indexes orchestration instances by intake and display order", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);
  const latestInstanceSql = `
    SELECT oi.id
    FROM orch_instances oi
    WHERE oi.workspace_id = ?
      AND json_extract(oi.intake_snapshot_json, '$.id') = ?
    ORDER BY CASE
               WHEN oi.status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0
               ELSE 1
             END,
             oi.updated_at DESC,
             oi.id DESC
    LIMIT 1
  `;
  const staleProjectionSql = `
    WITH ranked_instances AS (
      SELECT
        json_extract(oi.intake_snapshot_json, '$.id') AS intake_id,
        oi.id AS latest_instance_id,
        oi.status AS latest_instance_status,
        COUNT(*) OVER display_order AS instance_count,
        ROW_NUMBER() OVER display_order AS display_rank
      FROM orch_instances oi
      WHERE oi.workspace_id = ?
      WINDOW display_order AS (
        PARTITION BY json_extract(oi.intake_snapshot_json, '$.id')
        ORDER BY CASE
                   WHEN oi.status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0
                   ELSE 1
                 END,
                 oi.updated_at DESC,
                 oi.id DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      )
    ), actual_instance_projection AS (
      SELECT intake_id, latest_instance_id, latest_instance_status, instance_count
      FROM ranked_instances
      WHERE display_rank = 1
    )
    SELECT 1 AS stale
    FROM actual_instance_projection actual
    RIGHT JOIN orch_intake_list_states s
      ON s.workspace_id = ?
     AND s.source_kind = ?
     AND s.intake_id = actual.intake_id
    INNER JOIN orch_intakes i
      ON i.workspace_id = s.workspace_id
     AND i.id = s.intake_id
    WHERE s.workspace_id = ?
      AND s.source_kind = ?
      AND (
        s.instance_count <> COALESCE(actual.instance_count, 0)
        OR COALESCE(s.latest_instance_id, '') <> COALESCE(actual.latest_instance_id, '')
        OR COALESCE(s.latest_instance_status, '') <> COALESCE(actual.latest_instance_status, '')
      )
    LIMIT 1
  `;

  try {
    migrateClientDb(db as any);

    const indexSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME) as { sql?: string | null } | undefined)?.sql ?? "");
    assert.match(
      indexSql,
      /json_extract\(intake_snapshot_json, '\$\.id'\)[\s\S]*CASE[\s\S]*updated_at DESC,\s*id DESC,\s*status/iu,
    );

    db.exec(`DROP INDEX ${ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME};`);
    setApplicationFixtureVersion(db, 72);
    migrateClientDb(db as any);
    assert.equal(indexExists(db, ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME), true);

    const latestPlan = db.prepare(`EXPLAIN QUERY PLAN ${latestInstanceSql}`).all("workspace-1", "intake-1") as Array<{
      detail?: string | null;
    }>;
    assert.ok(
      latestPlan.some((row) => String(row.detail ?? "").includes(ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME)),
      `${ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME} was not selected: ${JSON.stringify(latestPlan)}`,
    );
    assert.equal(
      latestPlan.some((row) => String(row.detail ?? "").includes("USE TEMP B-TREE FOR ORDER BY")),
      false,
      `display order still required a temp sort: ${JSON.stringify(latestPlan)}`,
    );

    const stalePlan = db.prepare(`EXPLAIN QUERY PLAN ${staleProjectionSql}`).all(
      "workspace-1",
      "workspace-1",
      "requirement",
      "workspace-1",
      "requirement",
    ) as Array<{
      detail?: string | null;
    }>;
    assert.equal(
      stalePlan.filter((row) => String(row.detail ?? "").includes(ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME)).length,
      1,
      `projection health check did not use one workspace index scan: ${JSON.stringify(stalePlan)}`,
    );
    assert.equal(
      stalePlan.some((row) => String(row.detail ?? "").includes("CORRELATED SCALAR SUBQUERY")),
      false,
      `projection health check still contains correlated subqueries: ${JSON.stringify(stalePlan)}`,
    );
    assert.equal(
      stalePlan.some((row) => String(row.detail ?? "").includes("USE TEMP B-TREE")),
      false,
      `projection health check still requires a temp B-tree: ${JSON.stringify(stalePlan)}`,
    );

    db.exec(`DROP INDEX ${ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME};`);
    migrateClientDb(db as any);
    assert.equal(indexExists(db, ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME), true);

    db.exec(`
      DROP INDEX ${ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME};
      CREATE INDEX ${ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME}
        ON orch_instances(workspace_id, status);
    `);
    migrateClientDb(db as any);
    const repairedIndexSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME) as { sql?: string | null } | undefined)?.sql ?? "");
    assert.match(repairedIndexSql, /json_extract\(intake_snapshot_json, '\$\.id'\)/iu);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates client-level custom model catalog", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const columns = db.prepare("PRAGMA table_info(engine_custom_models)").all() as Array<{ name?: string | null }>;
    const columnNames = new Set(columns.map((column) => String(column.name ?? "")));
    assert.ok(columnNames.has("engine"));
    assert.ok(columnNames.has("provider_id"));
    assert.ok(columnNames.has("model_id"));
    assert.ok(columnNames.has("reasoning_efforts_json"));
    assert.ok(columnNames.has("default_reasoning_effort"));
    assert.ok(columnNames.has("supports_fast_mode"));
    assert.ok(columnNames.has("supports_1m_context"));

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'engine_custom_models' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.ok(indexes.some((row) => String(row.name ?? "") === "idx_engine_custom_models_engine_enabled"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates node result contract storage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const artifactFileColumns = db.prepare("PRAGMA table_info(orch_artifact_files)").all() as Array<{ name?: string | null }>;
    const artifactFileColumnNames = new Set(artifactFileColumns.map((column) => String(column.name ?? "")));
    assert.ok(artifactFileColumnNames.has("file_key"));
    assert.ok(artifactFileColumnNames.has("file_role"));
    assert.ok(artifactFileColumnNames.has("format"));
    assert.ok(artifactFileColumnNames.has("contract_key"));
    assert.ok(artifactFileColumnNames.has("summary"));
    assert.ok(artifactFileColumnNames.has("validation_status"));

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('orch_artifact_fields', 'orch_node_context_resolutions') ORDER BY name")
      .all() as Array<{ name?: string | null }>;
    assert.deepEqual(tables.map((row) => String(row.name ?? "")), [
      "orch_artifact_fields",
      "orch_node_context_resolutions",
    ]);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates and repairs orchestration node attempt storage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const columns = db.prepare("PRAGMA table_info(orch_node_attempts)").all() as Array<{ name?: string | null }>;
    const columnNames = new Set(columns.map((column) => String(column.name ?? "")));
    assert.ok(columnNames.has("attempt_no"));
    assert.ok(columnNames.has("submission_json"));
    assert.ok(columnNames.has("submission_hash"));
    assert.ok(columnNames.has("artifact_id"));
    assert.ok(columnNames.has("version"));

    const attemptIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orch_node_attempts' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.ok(attemptIndexes.some((row) => String(row.name ?? "") === "uk_orch_node_attempts_active"));

    const artifactIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orch_artifacts' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.ok(artifactIndexes.some((row) => String(row.name ?? "") === "uk_orch_artifacts_node_attempt"));

    db.exec("DROP TABLE orch_node_attempts");
    migrateClientDb(db as any);
    const repaired = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orch_node_attempts'").get() as { name?: string } | undefined;
    assert.equal(repaired?.name, "orch_node_attempts");
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates orchestration skills table", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const columns = db.prepare("PRAGMA table_info(orch_skills)").all() as Array<{ name?: string | null }>;
    const columnNames = new Set(columns.map((column) => String(column.name ?? "")));
    assert.ok(columnNames.has("id"));
    assert.ok(columnNames.has("workspace_id"));
    assert.ok(columnNames.has("name"));
    assert.ok(columnNames.has("definition_json"));

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orch_skills' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.ok(indexes.some((row) => String(row.name ?? "") === "idx_orch_skills_workspace"));

    const fileColumns = db.prepare("PRAGMA table_info(orch_skill_files)").all() as Array<{ name?: string | null }>;
    const fileColumnNames = new Set(fileColumns.map((column) => String(column.name ?? "")));
    assert.ok(fileColumnNames.has("skill_id"));
    assert.ok(fileColumnNames.has("rel_path"));
    assert.ok(fileColumnNames.has("kind"));
    assert.ok(fileColumnNames.has("content_text"));
    assert.ok(fileColumnNames.has("content_base64"));
    assert.ok(fileColumnNames.has("sha256"));

    const fileIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orch_skill_files' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.ok(fileIndexes.some((row) => String(row.name ?? "") === "idx_orch_skill_files_skill"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates scheduled task workflow instance and migration queue columns", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const columns = db.prepare("PRAGMA table_info(scheduled_task_runtime_states)").all() as Array<{ name?: string | null }>;
    const columnNames = new Set(columns.map((column) => String(column.name ?? "")));
    assert.ok(columnNames.has("last_workflow_instance_id"));
    assert.ok(columnNames.has("queued_scheduled_at"));
    assert.ok(columnNames.has("queued_reason"));
    assert.ok(columnNames.has("queued_operation_id"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates and repairs workspace directory migration storage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const assertMigrationSchema = () => {
      const columns = db.prepare("PRAGMA table_info(workspace_directory_migrations)").all() as Array<{
        name?: string | null;
      }>;
      const columnNames = new Set(columns.map((column) => String(column.name ?? "")));
      for (const required of [
        "operation_id",
        "idempotency_key",
        "workspace_id",
        "source_path",
        "target_path",
        "state",
        "start_attempt_id",
        "start_disposition",
        "start_fence_ack_pending",
        "index_rebuild_generation",
        "index_rebuild_status",
        "excluded_dependency_dir_count",
        "excluded_dependency_dirs_json",
        "state_version",
        "notification_pending",
        "notification_state_version",
        "cancellation_reason",
      ]) assert.ok(columnNames.has(required), `missing migration column: ${required}`);
      for (const indexName of [
        "uk_workspace_directory_migrations_idempotency",
        "uk_workspace_directory_migrations_single_active",
        "idx_workspace_directory_migrations_workspace_updated",
        "idx_workspace_directory_migrations_notification",
        "idx_workspace_directory_migrations_start_fence",
      ]) assert.equal(indexExists(db, indexName), true, `missing migration index: ${indexName}`);
      const activeIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("uk_workspace_directory_migrations_single_active") as { sql?: string | null } | undefined;
      assert.match(String(activeIndex?.sql ?? ""), /WHERE state NOT IN \('completed', 'cancelled', 'failed'\)/);
    };

    assertMigrationSchema();
    db.exec("DROP TABLE workspace_directory_migrations");
    setApplicationFixtureVersion(db, 70);
    migrateClientDb(db as any);
    assertMigrationSchema();
    db.exec(`
      DROP INDEX uk_workspace_directory_migrations_single_active;
      CREATE INDEX uk_workspace_directory_migrations_single_active
        ON workspace_directory_migrations(state);
    `);
    migrateClientDb(db as any);
    const repairedActiveSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("uk_workspace_directory_migrations_single_active") as { sql?: string | null } | undefined;
    assert.match(String(repairedActiveSql?.sql ?? ""), /CREATE UNIQUE INDEX/i);
    assert.match(String(repairedActiveSql?.sql ?? ""), /WHERE state NOT IN \('completed', 'cancelled', 'failed'\)/i);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);

    db.exec(`
      DROP TABLE workspace_directory_migrations;
      CREATE TABLE workspace_directory_migrations (operation_id TEXT PRIMARY KEY);
      PRAGMA user_version = 71;
    `);
    assert.throws(() => migrateClientDb(db as any), /workspace_directory_migrations schema 漂移/);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb upgrades existing artifact file table before creating file-key index", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);
    db.exec(`
      DROP INDEX IF EXISTS idx_orch_artifact_files_artifact_key;
      DROP TABLE orch_artifact_files;
      CREATE TABLE orch_artifact_files (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        staging_path TEXT NULL,
        published_path TEXT NULL,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orch_artifact_files_artifact_created
        ON orch_artifact_files(artifact_id, created_at ASC);
    `);
    setApplicationFixtureVersion(db, 43);

    migrateClientDb(db as any);

    const artifactFileColumns = db.prepare("PRAGMA table_info(orch_artifact_files)").all() as Array<{ name?: string | null }>;
    const artifactFileColumnNames = new Set(artifactFileColumns.map((column) => String(column.name ?? "")));
    assert.ok(artifactFileColumnNames.has("file_key"));
    assert.ok(artifactFileColumnNames.has("file_role"));
    assert.ok(artifactFileColumnNames.has("format"));
    assert.ok(artifactFileColumnNames.has("contract_key"));
    assert.ok(artifactFileColumnNames.has("summary"));
    assert.ok(artifactFileColumnNames.has("validation_status"));

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orch_artifact_files' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.ok(indexes.some((row) => String(row.name ?? "") === "idx_orch_artifact_files_artifact_key"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb backfills engine key providers and preserves disabled providers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        title TEXT NOT NULL,
        session_id TEXT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE orch_instances (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE orch_artifacts (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE orch_asset_generation_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        asset_kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE engine_keys (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        engine TEXT NOT NULL,
        api_key TEXT NOT NULL,
        base_url TEXT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO engine_keys(id, label, engine, api_key, base_url, is_active, created_at, updated_at)
      VALUES
        ('anthropic-1', 'Claude', 'claude', 'sk-ant', NULL, 1, 1, 1),
        ('deepseek-1', 'DeepSeek', 'claude', 'sk-ds-old', 'https://api.deepseek.com/anthropic', 0, 2, 2),
        ('deepseek-2', 'DeepSeek New', 'claude', 'sk-ds-new', 'https://api.deepseek.com/anthropic', 0, 3, 3),
        ('openai-1', 'OpenAI', 'codex', 'sk-openai', NULL, 0, 4, 4);
    `);
    db.pragma("user_version = 40");

    migrateClientDb(db as any);

    const rows = db.prepare("SELECT id, engine, provider_id, is_active FROM engine_keys ORDER BY id").all() as Array<{
      id: string;
      engine: string;
      provider_id: string;
      is_active: number;
    }>;
    assert.deepEqual(rows, [
      { id: "anthropic-1", engine: "claude", provider_id: "anthropic", is_active: 1 },
      { id: "deepseek-1", engine: "claude", provider_id: "deepseek", is_active: 0 },
      { id: "deepseek-2", engine: "claude", provider_id: "deepseek", is_active: 0 },
      { id: "openai-1", engine: "codex", provider_id: "openai", is_active: 0 },
    ]);
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb preserves supported Claude providers when the Client reopens", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);
  let dbOpen = true;
  let reopenedDb: ReturnType<typeof openSqliteDb> | null = null;

  try {
    migrateClientDb(db as any);
    db.exec(`
      INSERT INTO engine_keys(id, label, engine, provider_id, api_key, base_url, is_active, created_at, updated_at)
      VALUES
        ('anthropic-1', 'Anthropic', 'claude', 'anthropic', 'sk-anthropic', 'https://api.anthropic.com', 1, 1, 1),
        ('qwen-1', 'Qwen', 'claude', 'qwen', 'sk-qwen', 'https://portal.qwen.ai/v1', 1, 2, 2),
        ('moonshot-1', 'Moonshot', 'claude', 'moonshot', 'sk-moonshot', 'https://api.moonshot.ai/anthropic', 1, 3, 3),
        ('zai-1', 'Z.AI', 'claude', 'zai', 'sk-zai', 'https://api.z.ai/api/anthropic', 1, 4, 4);
    `);

    db.close();
    dbOpen = false;
    reopenedDb = openSqliteDb(dbPath);
    migrateClientDb(reopenedDb as any);

    const rows = reopenedDb.prepare(`
      SELECT id, provider_id, base_url, is_active
      FROM engine_keys
      ORDER BY id
    `).all();
    assert.deepEqual(rows, [
      { id: "anthropic-1", provider_id: "anthropic", base_url: "https://api.anthropic.com", is_active: 1 },
      { id: "moonshot-1", provider_id: "moonshot", base_url: "https://api.moonshot.ai/anthropic", is_active: 1 },
      { id: "qwen-1", provider_id: "qwen", base_url: "https://portal.qwen.ai/v1", is_active: 1 },
      { id: "zai-1", provider_id: "zai", base_url: "https://api.z.ai/api/anthropic", is_active: 1 },
    ]);
  } finally {
    if (reopenedDb) reopenedDb.close();
    if (dbOpen) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates external reminder notification records tables", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const dingTalkTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dingtalk_reminder_notifications'").get() as { name?: string } | undefined;
    const weComTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wecom_reminder_notifications'").get() as { name?: string } | undefined;
    assert.equal(dingTalkTable?.name, "dingtalk_reminder_notifications");
    assert.equal(weComTable?.name, "wecom_reminder_notifications");
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates path reference columns for drafts and queue items", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const draftColumns = db.prepare("PRAGMA table_info(thread_drafts)").all() as Array<{ name?: string | null }>;
    const queueColumns = db.prepare("PRAGMA table_info(thread_message_queue)").all() as Array<{ name?: string | null }>;
    assert.ok(draftColumns.some((column) => String(column.name ?? "") === "path_references_json"));
    assert.ok(queueColumns.some((column) => String(column.name ?? "") === "path_references_json"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates orchestration assignee template storage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orch_assignee_templates'")
      .all() as Array<{ name?: string | null }>;
    assert.deepEqual(tables.map((row) => String(row.name ?? "")), ["orch_assignee_templates"]);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orch_assignee_templates' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.ok(indexes.some((row) => String(row.name ?? "") === "idx_orch_assignee_templates_workspace_workflow"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates workspace execution profile storage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_execution_profiles'")
      .all() as Array<{ name?: string | null }>;
    assert.deepEqual(tables.map((row) => String(row.name ?? "")), ["workspace_execution_profiles"]);

    const columns = db.prepare("PRAGMA table_info(workspace_execution_profiles)").all() as Array<{ name?: string | null }>;
    const columnNames = new Set(columns.map((column) => String(column.name ?? "")));
    assert.ok(columnNames.has("scope_type"));
    assert.ok(columnNames.has("scope_id"));
    assert.ok(columnNames.has("user_id"));
    assert.ok(columnNames.has("profile_text"));
    assert.ok(columnNames.has("profile_hash"));

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_execution_profiles' ORDER BY name",
    ).all() as Array<{ name?: string | null }>;
    assert.ok(indexes.some((row) => String(row.name ?? "") === "idx_workspace_exec_profiles_user"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates and repairs file blob reference indexes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);
  const expectedIndexes = [
    "idx_thread_draft_attachments_blob_id",
    "idx_thread_message_queue_attachments_blob_id",
    "idx_turn_file_changes_accepted_blob_id",
    "idx_turn_file_changes_after_blob_id",
    "idx_turn_file_changes_before_blob_id",
  ];
  const planCases = [
    ["SELECT 1 FROM thread_draft_attachments WHERE blob_id = ? LIMIT 1", expectedIndexes[0]],
    ["SELECT 1 FROM thread_message_queue_attachments WHERE blob_id = ? LIMIT 1", expectedIndexes[1]],
    ["SELECT 1 FROM turn_file_changes WHERE accepted_blob_id = ? LIMIT 1", expectedIndexes[2]],
    ["SELECT 1 FROM turn_file_changes WHERE after_blob_id = ? LIMIT 1", expectedIndexes[3]],
    ["SELECT 1 FROM turn_file_changes WHERE before_blob_id = ? LIMIT 1", expectedIndexes[4]],
  ] as const;

  try {
    migrateClientDb(db as any);

    /** 精确读取本迁移负责的五个索引，避免 LIKE 通配符误收其他索引。 */
    const readIndexNames = () => (db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${expectedIndexes.map(() => "?").join(", ")}) ORDER BY name`,
    ).all(...expectedIndexes) as Array<{ name?: string | null }>).map((row) => String(row.name ?? ""));
    assert.deepEqual(readIndexNames(), expectedIndexes);

    for (const [sql, indexName] of planCases) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("missing-blob") as Array<{ detail?: string | null }>;
      assert.ok(
        plan.some((row) => String(row.detail ?? "").includes(`USING COVERING INDEX ${indexName}`)),
        `${indexName} was not selected: ${JSON.stringify(plan)}`,
      );
    }

    db.exec(`DROP INDEX ${expectedIndexes[0]}`);
    assert.equal(readIndexNames().includes(expectedIndexes[0]), false);
    migrateClientDb(db as any);
    assert.deepEqual(readIndexNames(), expectedIndexes);

    db.exec(`
      DROP INDEX ${expectedIndexes[0]};
      CREATE UNIQUE INDEX ${expectedIndexes[0]}
        ON thread_draft_attachments(blob_id);
      DROP INDEX ${expectedIndexes[1]};
      CREATE INDEX ${expectedIndexes[1]}
        ON thread_message_queue_attachments(blob_id COLLATE NOCASE);
      DROP INDEX ${expectedIndexes[4]};
      CREATE INDEX ${expectedIndexes[4]} ON turn_file_changes(thread_id);
      DROP INDEX ${expectedIndexes[2]};
      CREATE INDEX ${expectedIndexes[2]}
        ON turn_file_changes(accepted_blob_id)
        WHERE accepted_blob_id IS NULL;
    `);
    migrateClientDb(db as any);
    const repairedDraftIndex = (db.prepare("PRAGMA index_list(thread_draft_attachments)").all() as Array<{
      name?: string | null;
      unique?: number | null;
    }>).find((row) => String(row.name ?? "") === expectedIndexes[0]);
    assert.equal(Number(repairedDraftIndex?.unique ?? -1), 0);
    const repairedQueueKeyColumns = (db.prepare(`PRAGMA index_xinfo(${expectedIndexes[1]})`).all() as Array<{
      name?: string | null;
      coll?: string | null;
      desc?: number | null;
      key?: number | null;
    }>).filter((row) => Number(row.key ?? 0) === 1);
    assert.deepEqual(
      repairedQueueKeyColumns.map((row) => ({
        name: String(row.name ?? ""),
        coll: String(row.coll ?? ""),
        desc: Number(row.desc ?? 0),
      })),
      [{ name: "blob_id", coll: "BINARY", desc: 0 }],
    );
    const repairedBeforeColumns = db.prepare(`PRAGMA index_info(${expectedIndexes[4]})`).all() as Array<{ name?: string | null }>;
    assert.deepEqual(repairedBeforeColumns.map((row) => String(row.name ?? "")), ["before_blob_id"]);
    const repairedAcceptedSql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(expectedIndexes[2]) as { sql?: string | null } | undefined;
    assert.match(String(repairedAcceptedSql?.sql ?? ""), /accepted_blob_id[^]*IS NOT NULL/i);
    for (const [sql, indexName] of planCases) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("missing-blob") as Array<{ detail?: string | null }>;
      assert.ok(
        plan.some((row) => String(row.detail ?? "").includes(`USING COVERING INDEX ${indexName}`)),
        `${indexName} was not selected after repair: ${JSON.stringify(plan)}`,
      );
    }
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateClientDb creates and repairs thread deletion reference indexes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-migration-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);
  const expectedIndexes = [
    {
      name: "idx_orch_prompt_snapshots_thread_instance",
      columns: ["thread_id", "instance_id"],
    },
    {
      name: "idx_orch_node_attempts_thread_instance",
      columns: ["thread_id", "instance_id"],
    },
    {
      name: "idx_orch_asset_generation_jobs_thread_status",
      columns: ["thread_id", "status"],
    },
    {
      name: "idx_orch_instances_master_thread_status",
      columns: ["master_thread_id", "status"],
    },
  ] as const;

  try {
    migrateClientDb(db as any);
    for (const expected of expectedIndexes) {
      const columns = db.prepare(`PRAGMA index_info(${expected.name})`).all() as Array<{ name?: string | null }>;
      assert.deepEqual(columns.map((row) => String(row.name ?? "")), expected.columns);
    }

    db.exec(expectedIndexes.map((expected) => `DROP INDEX ${expected.name};`).join("\n"));
    assert.equal(Number(db.pragma("user_version", { simple: true }) ?? 0), EXPECTED_CLIENT_SCHEMA_VERSION);
    migrateClientDb(db as any);
    for (const expected of expectedIndexes) {
      const columns = db.prepare(`PRAGMA index_info(${expected.name})`).all() as Array<{ name?: string | null }>;
      assert.deepEqual(columns.map((row) => String(row.name ?? "")), expected.columns);
    }
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

