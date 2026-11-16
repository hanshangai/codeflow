import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { CLIENT_DB_READER_SCHEMA_VERSION } from "../src/db/clientDbReaderProtocol.js";
import { ClientDbReaderError, ClientDbReaderService } from "../src/db/clientDbReaderService.js";
import { assertWorkspaceDbReadOnlySchema, CLIENT_DB_SCHEMA_VERSION, migrateClientDb } from "../src/db/migrateClientDb.js";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.js";
import { logger } from "../src/logger.js";

/** 按目标版本移除新增表，刻意保留索引缺失以识别升级、修复及拒绝写入的边界。 */
function fixture(t: test.TestContext, version: number) {
  const base = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, "codeflow-schema-version-"));
  t.after(() => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith("codeflow-schema-version-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dbPath = path.join(root, "client.db"), db = openSqliteDb(dbPath);
  try {
    migrateClientDb(db);
    if (version < 102) db.exec("DROP TABLE local_quick_phrases; DROP TABLE local_quick_phrase_collection; DROP TABLE local_model_context_preferences;");
    db.exec("CREATE TABLE future_marker(value TEXT); INSERT INTO future_marker VALUES ('保留的原库数据');");
    db.exec("DROP INDEX idx_orch_instances_workspace_intake_display");
    db.pragma("journal_mode = DELETE");
    db.pragma("user_version = " + version);
  } finally { db.close(); }
  return { root, dbPath };
}

/** 核 schema、业务事实及持久 pragma，不把关闭或日志成功当作零写证明。 */
function snapshot(db: SqliteDb) {
  return { schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all(),
    marker: db.prepare("SELECT * FROM future_marker").all(), version: db.pragma("user_version", { simple: true }),
    journal: db.pragma("journal_mode", { simple: true }) };
}

for (const version of [CLIENT_DB_SCHEMA_VERSION + 1, 1_000_000]) {
  test("future application schema is rejected before repair or journal writes: " + version, t => {
    const { root, dbPath } = fixture(t, version), bytes = fs.readFileSync(dbPath);
    const db = openSqliteDb(dbPath), before = snapshot(db);
    let failure: unknown;
    try {
      try { migrateClientDb(db); } catch (error) { failure = error; }
      assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
    assert.ok(fs.readFileSync(dbPath).equals(bytes), "拒绝高版本时主库字节必须保持");
    assert.deepEqual(fs.readdirSync(root), ["client.db"]);
    assert.ok(failure instanceof Error);
    assert.equal((failure as Error & { code: string }).code, "CLIENT_DB_SCHEMA_VERSION_UNSUPPORTED");
    assert.equal((failure as Error & { actualVersion: number }).actualVersion, version);
    assert.equal((failure as Error & { supportedVersion: number }).supportedVersion, CLIENT_DB_SCHEMA_VERSION);
  });
}

test("future application schema public open fails, releases the file and never retries sidecars", t => {
  const { root, dbPath } = fixture(t, CLIENT_DB_SCHEMA_VERSION + 1), bytes = fs.readFileSync(dbPath);
  const warnings: unknown[] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => { warnings.push(args); });
  let opened: ReturnType<typeof openClientDb> | undefined, failure: unknown;
  try { opened = openClientDb({ dbPath }); } catch (error) { failure = error; }
  finally { opened?.close(); }
  assert.ok(fs.readFileSync(dbPath).equals(bytes), "公开开库拒绝后主库字节必须保持");
  assert.deepEqual(fs.readdirSync(root), ["client.db"]);
  assert.equal(warnings.length, 0);
  assert.equal((failure as { code?: string })?.code, "CLIENT_DB_SCHEMA_VERSION_UNSUPPORTED");
  const moved = dbPath + ".retained";
  fs.renameSync(dbPath, moved);
  fs.renameSync(moved, dbPath);
  const reader = openSqliteDb(dbPath, { readonly: true });
  try { assert.equal(snapshot(reader).version, CLIENT_DB_SCHEMA_VERSION + 1); }
  finally { reader.close(); }
});

test("future application schema close failure preserves both causes without repair or retry", t => {
  const { root, dbPath } = fixture(t, CLIENT_DB_SCHEMA_VERSION + 1), bytes = fs.readFileSync(dbPath);
  const close = DatabaseSync.prototype.close, closeError = new Error("close result failure");
  let closes = 0, failure: unknown;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closes++;
    close.call(this);
    throw closeError;
  });
  try { openClientDb({ dbPath }); } catch (error) { failure = error; }
  t.mock.restoreAll();
  assert.ok(fs.readFileSync(dbPath).equals(bytes), "关闭结果失败仍不得改写主库");
  assert.deepEqual(fs.readdirSync(root), ["client.db"]);
  assert.equal(closes, 1);
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.errors[0].code, "CLIENT_DB_SCHEMA_VERSION_UNSUPPORTED");
  assert.equal(failure.errors[1], closeError);
  assert.equal(failure.cause, failure.errors[0]);
});

for (const version of [CLIENT_DB_SCHEMA_VERSION - 1, CLIENT_DB_SCHEMA_VERSION]) {
  test("supported application schema retains upgrade and same-version repair: " + version, t => {
    const { dbPath } = fixture(t, version), db = openClientDb({ dbPath });
    try {
      assert.equal(db.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
      assert.deepEqual(db.db.prepare("SELECT * FROM future_marker").all(), [{ value: "保留的原库数据" }]);
      assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_orch_instances_workspace_intake_display'").get());
      assert.deepEqual(db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local_%' ORDER BY name").all(),
        ["local_model_context_preferences", "local_quick_phrase_collection", "local_quick_phrases"].map(name => ({ name })));
      assert.deepEqual(db.db.prepare("SELECT id, revision FROM local_quick_phrase_collection").all(), [{ id: 1, revision: 0 }]);
    } finally { db.close(); }
  });
}

/** 用真实 writer 同时建立应用库与工作区库，Reader 复用正式文件身份租约。 */
function readerFixture(t: test.TestContext) {
  const base = fs.realpathSync.native(os.tmpdir()), root = fs.mkdtempSync(path.join(base, "codeflow-reader-schema-"));
  const dbPath = path.join(root, "client.db"), db = openClientDb({ dbPath });
  t.after(() => {
    db.close();
    assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith("codeflow-reader-schema-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspaceId = "schema-reader:workspace" as WorkspaceId, workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath); db.workspaces.upsert({ id: workspaceId, title: "Reader schema", path: workspacePath });
  const input = { workspaceId, triggerMode: "manual" as const, taskType: "feature" as const, goal: "真实只读查询",
    workspaceScope: { scopeType: "local_workspace" as const, scopeId: workspaceId } };
  const applicationIntake = db.orchIntakes.create({ ...input, title: "应用库需求" });
  const workspace = db.forWorkspace(workspaceId), workspaceIntake = workspace.orchIntakes.create({ ...input, title: "工作区需求" });
  db.db.pragma("wal_checkpoint(TRUNCATE)");
  return { db, dbPath, root, workspaceId, workspace, workspaceDbPath: path.join(workspacePath, ".codeflowai/workspace.db"), applicationIntake, workspaceIntake };
}

test("v101 workspace upgrades through the local writer without losing intake history", t => {
  const f = readerFixture(t), previous = openSqliteDb(f.workspaceDbPath);
  try { previous.pragma("user_version = 101"); }
  finally { previous.close(); }

  assert.deepEqual(f.workspace.orchIntakes.get(f.workspaceIntake.id), f.workspaceIntake);
  const reader = openSqliteDb(f.workspaceDbPath, { readonly: true });
  try {
    assert.equal(reader.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
    assert.equal(assertWorkspaceDbReadOnlySchema(reader).schemaVersion, CLIENT_DB_SCHEMA_VERSION);
    assert.equal(reader.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_model_context_preferences'").get(), undefined);
  } finally { reader.close(); }
});

test("Reader schema version stays exactly aligned with the writer", () => {
  assert.equal(CLIENT_DB_READER_SCHEMA_VERSION, CLIENT_DB_SCHEMA_VERSION);
});

for (const scope of ["application", "workspace"] as const) {
  test("real Reader reads writer schema and closes without modifying " + scope, async t => {
    const f = readerFixture(t), database = scope === "application" ? f.db.db : f.workspace.db;
    assert.equal(database.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
    const dbPath = scope === "application" ? f.dbPath : f.workspaceDbPath, before = fs.readFileSync(dbPath);
    const fatalErrors: ClientDbReaderError[] = [];
    const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError: error => fatalErrors.push(error),
      acquireWorkspaceSource: scope === "workspace" ? id => f.db.acquireWorkspaceReaderSource(id) : undefined });
    try {
      await reader.ready();
      const result = await reader.listIntakes({ requestId: "schema-current-" + scope, workspaceId: f.workspaceId, sourceKind: "requirement", localWorkspaceOnly: true });
      const expected = scope === "application" ? f.applicationIntake : f.workspaceIntake;
      assert.equal(result.totalCount, 1); assert.deepEqual(result.intakes.map(item => ({ id: item.id, title: item.title })), [{ id: expected.id, title: expected.title }]);
      await reader.close();
      await assert.rejects(reader.ready(), (error: unknown) => error instanceof ClientDbReaderError && error.code === "CLIENT_DB_READER_CLOSED");
      assert.deepEqual(fatalErrors, []); assert.ok(fs.readFileSync(dbPath).equals(before));
    } finally { await reader.close(); }
  });

  for (const version of [CLIENT_DB_SCHEMA_VERSION - 1, CLIENT_DB_SCHEMA_VERSION + 1]) {
    test("real Reader rejects mismatched " + scope + " schema without writes: " + version, async t => {
      const f = readerFixture(t), database = scope === "application" ? f.db.db : openSqliteDb(f.workspaceDbPath);
      database.pragma("user_version = " + version);
      if (scope === "application") database.pragma("wal_checkpoint(TRUNCATE)");
      const dbPath = scope === "application" ? f.dbPath : f.workspaceDbPath, before = fs.readFileSync(dbPath);
      const fatalErrors: ClientDbReaderError[] = [];
      const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError: error => fatalErrors.push(error),
        acquireWorkspaceSource: scope === "workspace" ? id => f.db.acquireWorkspaceReaderSource(id) : undefined });
      /** 版本失败必须携带原 expected/actual，不允许吞错或只返回空列表。 */
      const mismatch = (error: unknown) => {
        assert.ok(error instanceof ClientDbReaderError); assert.equal(error.code, "CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH");
        assert.equal(error.details.expectedSchemaVersion, CLIENT_DB_SCHEMA_VERSION); assert.equal(error.details.actualSchemaVersion, version);
        return true;
      };
      try {
        if (scope === "application") await assert.rejects(reader.ready(), mismatch);
        else {
          await reader.ready();
          await assert.rejects(reader.listIntakes({ requestId: "schema-mismatch-" + version, workspaceId: f.workspaceId }), mismatch);
        }
        assert.ok(fs.readFileSync(dbPath).equals(before)); assert.equal(database.pragma("user_version", { simple: true }), version);
        assert.deepEqual(fatalErrors, []);
        if (scope === "workspace") {
          database.pragma("user_version = " + CLIENT_DB_SCHEMA_VERSION);
          const result = await reader.listIntakes({ requestId: "schema-restored", workspaceId: f.workspaceId });
          assert.deepEqual(result.intakes.map(item => item.id), [f.workspaceIntake.id]);
        }
      } finally {
        try {
          if (scope === "application") await assert.rejects(reader.close(), mismatch);
          else await reader.close();
        } finally { if (scope === "workspace") database.close(); }
      }
    });
  }
}
