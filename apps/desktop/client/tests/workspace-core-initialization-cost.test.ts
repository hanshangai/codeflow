import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openClientDb } from "../src/db/clientDb.js";
import { ensureWorkspaceCoreQueueTables, migrateClientDb } from "../src/db/migrateClientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";

/** 独立真实库保留逐次开关连接；计数只观测元数据开销，不设墙钟门槛。 */
function fixture(t: test.TestContext, cache = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-init-cost-"));
  const gate = new WorkspaceOperationGate();
  const application = openClientDb({ dbPath: path.join(directory, "application.db"), workspaceOperationGate: gate,
    ...(cache ? { workspaceConnectionCache: { onError(error: unknown) { throw error; } } } : {}) });
  const workspaceId = "initialization:workspace";
  application.workspaces.upsert({ id: workspaceId, title: "初始化", path: directory });
  const view = application.forWorkspace(workspaceId);
  view.threads.create({ id: "thread", workspaceId, engine: "claude", title: "保留" });
  t.after(() => { application.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { application, view, workspaceId, gate, filename: path.join(directory, ".codeflowai", "workspace.db") };
}

/** 原因链保留存储边界包装，避免只按外层文案误认注入失败。 */
function hasCause(error: unknown, expected: unknown): boolean {
  return error === expected || error instanceof Error && hasCause(error.cause, expected);
}

test("核心检查的主表查询量保持有界，同时每次发现后续结构故障", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-core-metadata-"));
  const db = openSqliteDb(path.join(directory, "workspace.db"));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  migrateClientDb(db, { scope: "workspace" });
  ensureWorkspaceCoreQueueTables(db);
  const prepare = db.prepare.bind(db);
  let masterReads = 0;
  t.mock.method(db, "prepare", (sql: string) => {
    if (/sqlite_master/iu.test(sql)) masterReads++;
    return prepare(sql);
  });
  ensureWorkspaceCoreQueueTables(db);
  assert.ok(masterReads <= 32, `重复主表查询过多：${masterReads}`);
  db.exec("DROP TABLE code_attribution_retention_tasks");
  assert.throws(() => ensureWorkspaceCoreQueueTables(db), /WORKSPACE_CORE_SCHEMA_INVALID:code_attribution_retention_tasks/u);
});

test("Worker缓存复用真实连接和scope，显式排空后释放迁移门禁", t => {
  const { application, view, workspaceId, gate } = fixture(t, true);
  const prototype = Object.getPrototypeOf(application.applicationDb), exec = prototype.exec, close = prototype.close;
  let scopes = 0, closes = 0;
  t.mock.method(prototype, "exec", function(this: typeof application.applicationDb, sql: string) {
    if (/CREATE TEMP TRIGGER/u.test(sql)) scopes++;
    return exec.call(this, sql);
  });
  t.mock.method(prototype, "close", function(this: typeof application.applicationDb) { closes++; return close.call(this); });
  assert.equal(view.threads.get("thread")?.title, "保留");
  view.threads.rename("thread", "复用写入");
  assert.equal(view.threads.get("thread")?.title, "复用写入");
  assert.equal(scopes, 0); assert.equal(closes, 0);
  assert.equal(gate.hasActiveWrites(), true);
  application.closeWorkspaceConnections(workspaceId);
  assert.equal(closes, 1); assert.equal(gate.hasActiveWrites(), false);
  assert.equal(view.threads.get("thread")?.title, "复用写入");
  assert.equal(scopes, 1);
});

test("Worker缓存发现外部schema变更时关闭旧连接，禁止沿旧scope继续", t => {
  const { application, view, filename } = fixture(t, true);
  const external = openSqliteDb(filename);
  external.exec("CREATE TABLE injected_change(value TEXT)"); external.close();
  assert.throws(() => view.threads.rename("thread", "不应提交"), /WORKSPACE_CORE_CONNECTION_SCHEMA_CHANGED/u);
  assert.equal(view.threads.get("thread")?.title, "保留");
  application.closeWorkspaceConnections();
});

test("缓存关闭失败冻结所属W，显式重试关闭后才释放资源", t => {
  const { application, view, workspaceId, gate } = fixture(t, true);
  const prototype = Object.getPrototypeOf(application.applicationDb), close = prototype.close;
  let fail = true;
  t.mock.method(prototype, "close", function(this: typeof application.applicationDb) {
    if (fail) { fail = false; throw new Error("injected_cached_close_failure"); }
    return close.call(this);
  });
  assert.throws(() => application.closeWorkspaceConnections(workspaceId), /injected_cached_close_failure/u);
  assert.throws(() => view.threads.rename("thread", "不应继续"));
  assert.equal(gate.hasActiveWrites(), true);
  application.closeWorkspaceConnections(workspaceId);
  assert.equal(gate.hasActiveWrites(), false);
});

test("元数据集合保持本地父表大小写与核心首错顺序", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-core-parent-"));
  const db = openSqliteDb(path.join(directory, "workspace.db"));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  migrateClientDb(db, { scope: "workspace" });
  ensureWorkspaceCoreQueueTables(db);
  db.exec("PRAGMA foreign_keys=OFF; DROP TABLE threads; CREATE TABLE local_parent(id TEXT PRIMARY KEY); CREATE TABLE threads(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES local_parent(id));");
  ensureWorkspaceCoreQueueTables(db);
  db.exec("DROP TABLE threads; CREATE TABLE threads(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES LOCAL_PARENT(id)); DROP TABLE code_attribution_retention_tasks;");
  assert.throws(() => ensureWorkspaceCoreQueueTables(db), /WORKSPACE_CORE_SCHEMA_INVALID:threads/u);
  db.exec("DROP TABLE threads; CREATE TABLE threads(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES workspaces(id));");
  assert.throws(() => ensureWorkspaceCoreQueueTables(db), /WORKSPACE_CORE_SCHEMA_INVALID:threads/u);
});

test("每次连接的scope元数据与DDL调用量有界，跨工作区写入仍被拒绝", t => {
  const { application, view, workspaceId, gate } = fixture(t);
  const prototype = Object.getPrototypeOf(application.applicationDb);
  const prepare = prototype.prepare, exec = prototype.exec;
  let tableReads = 0, triggerExecs = 0;
  t.mock.method(prototype, "prepare", function (this: typeof application.applicationDb, sql: string) {
    if (/^PRAGMA table_info\(/iu.test(sql)) tableReads++;
    return prepare.call(this, sql);
  });
  t.mock.method(prototype, "exec", function (this: typeof application.applicationDb, sql: string) {
    if (/CREATE TEMP TRIGGER/iu.test(sql)) triggerExecs++;
    return exec.call(this, sql);
  });
  assert.equal(view.threads.get("thread")?.title, "保留");
  assert.ok(tableReads <= 32, `重复列查询过多：${tableReads}`);
  assert.equal(triggerExecs, 1);
  assert.throws(() => view.threads.create({ id: "other", workspaceId: "untrusted", engine: "claude", title: "拒绝" }), /WORKSPACE_CORE_SCOPE_MISMATCH/u);
  assert.throws(() => view.db.prepare("UPDATE threads SET workspace_id='untrusted' WHERE id='thread'").run(), /WORKSPACE_CORE_SCOPE_MISMATCH/u);
  assert.equal(view.threads.get("thread")?.workspaceId, workspaceId);
  assert.equal(view.threads.get("other"), null);
  assert.deepEqual(gate.listActivities(workspaceId), []);
});

test("scope初始化失败中止业务，原连接关闭后下一次请求仍可用", t => {
  const { application, view, filename, workspaceId, gate } = fixture(t);
  const prototype = Object.getPrototypeOf(application.applicationDb), exec = prototype.exec;
  const failure = new Error("scope-initialization-injected");
  let injected = false;
  t.mock.method(prototype, "exec", function (this: typeof application.applicationDb, sql: string) {
    if (!injected && /CREATE TEMP TRIGGER/iu.test(sql)) { injected = true; throw failure; }
    return exec.call(this, sql);
  });
  assert.throws(() => view.threads.rename("thread", "不得写入"), error => hasCause(error, failure));
  const reader = openSqliteDb(filename, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(reader.prepare("SELECT title FROM threads WHERE id='thread'").get(), { title: "保留" }); }
  finally { reader.close(); }
  assert.equal(view.threads.get("thread")?.title, "保留");
  assert.deepEqual(gate.listActivities(workspaceId), []);
});

test("同步核心入口与嵌套视图共用连接，离开回调后重新检查并关闭", t => {
  const { application, view, workspaceId, gate } = fixture(t);
  const prototype = Object.getPrototypeOf(application.applicationDb), exec = prototype.exec, close = prototype.close;
  let triggerExecs = 0, closes = 0;
  t.mock.method(prototype, "exec", function (this: typeof application.applicationDb, sql: string) {
    if (/CREATE TEMP TRIGGER/iu.test(sql)) triggerExecs++;
    return exec.call(this, sql);
  });
  t.mock.method(prototype, "close", function (this: typeof application.applicationDb) {
    closes++;
    return close.call(this);
  });
  application.withWorkspaceCoreRepos(workspaceId, repos => {
    assert.equal(repos.threads.get("thread")?.title, "保留");
    assert.equal(view.threads.get("thread")?.workspaceId, workspaceId);
    view.withWorkspaceCoreRepos(workspaceId, nested => {
      assert.equal(nested.threads.get("thread")?.title, "保留");
      assert.equal(application.forWorkspace(workspaceId).threads.get("thread")?.title, "保留");
    });
    assert.equal(closes, 0);
  });
  assert.equal(triggerExecs, 1);
  assert.equal(closes, 1);
  assert.equal(view.threads.get("thread")?.title, "保留");
  assert.equal(triggerExecs, 2);
  assert.equal(closes, 2);
  assert.deepEqual(gate.listActivities(workspaceId), []);
});

test("同步连接复用保留归属约束、失败清理和异步回调拒绝", t => {
  const { application, view, workspaceId, gate } = fixture(t);
  const failure = new Error("event-index-failed");
  assert.throws(() => application.withWorkspaceCoreRepos(workspaceId, () => {
    assert.throws(() => view.threads.create({ id: "foreign", workspaceId: "untrusted", engine: "claude", title: "拒绝" }), /WORKSPACE_CORE_SCOPE_MISMATCH/u);
    throw failure;
  }), error => hasCause(error, failure));
  assert.throws(() => application.withWorkspaceCoreRepos(workspaceId, (() => Promise.resolve()) as any), /WORKSPACE_PROFILE_CALLBACK_MUST_BE_SYNCHRONOUS/u);
  assert.equal(view.threads.get("foreign"), null);
  assert.equal(view.threads.get("thread")?.title, "保留");
  assert.deepEqual(gate.listActivities(workspaceId), []);
});

test("已建工作区的同步操作不重新编译全部仓储SQL", t => {
  const { application, workspaceId } = fixture(t);
  const prototype = Object.getPrototypeOf(application.applicationDb), prepare = prototype.prepare;
  const sql: string[] = [];
  t.mock.method(prototype, "prepare", function (this: typeof application.applicationDb, query: string) {
    sql.push(query);
    return prepare.call(this, query);
  });
  application.withWorkspaceCoreRepos(workspaceId, repos => assert.equal(repos.threads.get("thread")?.title, "保留"));
  assert.equal(sql.filter(query => /INSERT OR IGNORE INTO conversation_events/u.test(query)).length, 0, "单次线程读取不得编译事件写入或其它仓储语句");
});

test("主库和sidecar在同一检查阶段批量复核目录，仍逐文件检查身份", t => {
  const { application, view, filename } = fixture(t);
  const original = fs.realpathSync.native;
  let directoryChecks = 0, fileChecks = 0;
  t.mock.method(fs.realpathSync, "native", ((filePath: fs.PathLike, ...args: any[]) => {
    if (path.resolve(String(filePath)) === path.dirname(filename)) directoryChecks++;
    if (path.resolve(String(filePath)) === filename) fileChecks++;
    return (original as any)(filePath, ...args);
  }) as typeof original);
  application.withWorkspaceCoreRepos("initialization:workspace", () => assert.equal(view.threads.get("thread")?.title, "保留"));
  assert.ok(directoryChecks <= 20, `重复目录复核过多：${directoryChecks}`);
  assert.ok(fileChecks >= 4, "主库须在打开前、打开后及收口阶段重新校验");
});

test("复用工作区仓储仍拒绝外部修改的附加结构版本", t => {
  const { application, filename, workspaceId } = fixture(t);
  const external = openSqliteDb(filename);
  external.prepare("UPDATE meta SET value='2' WHERE key='workspace_additional_schema_version'").run();
  external.close();
  let ran = false;
  assert.throws(() => application.withWorkspaceCoreRepos(workspaceId, () => { ran = true; }), error => {
    let current: unknown = error;
    while (current instanceof Error) {
      if (current.message === "WORKSPACE_ADDITIONAL_SCHEMA_VERSION_UNSUPPORTED") return true;
      current = current.cause;
    }
    return false;
  });
  assert.equal(ran, false);
});
