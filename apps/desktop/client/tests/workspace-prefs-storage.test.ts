import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceId } from "@codeflowai/shared";
import { openClientDb, type ClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { migrateClientDb, CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";
import { handleWorkspacePrefsGet, handleWorkspacePrefsSave } from "../src/app/handlers/workspacePrefsHandlers.js";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { WorkspacePrefsRepo } from "../src/db/repos/workspacePrefsRepo.js";
import { logger, flushClientLogger } from "../src/logger.js";

/** 每例使用真实注册表、物理目录和共用门禁，结束时关闭所有连接。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prefs-storage-"));
  const a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  const gate = new WorkspaceOperationGate(), dbPath = path.join(root, "application.db");
  const db = openClientDb({ dbPath, workspaceOperationGate: gate });
  const aId = "client:a" as WorkspaceId, bId = "client:b" as WorkspaceId;
  db.workspaces.upsert({ id: aId, title: "A", path: a });
  db.workspaces.upsert({ id: bId, title: "B", path: b });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, a, b, aId, bId, gate, db, dbPath };
}

/** 直接调用原 handler，只提供它拥有的请求边界；不模拟仓储。 */
function request(db: ClientDb, workspaceId: WorkspaceId, prefs?: unknown[]) {
  const responses: any[] = [];
  const ctx = { db, workspaces: new Map([[workspaceId, "ignored-request-path"]]), send: (message: unknown) => responses.push(message) } as unknown as ApiHandlerContext;
  const req = { t: "api.req", id: "prefs-request", method: prefs === undefined ? "workspacePrefs.get" : "workspacePrefs.save", body: { workspaceId, prefs } } as ApiRequestMessage;
  (prefs === undefined ? handleWorkspacePrefsGet : handleWorkspacePrefsSave)(ctx, req);
  assert.equal(responses.length, 1);
  return responses[0];
}

test("prefs failure consumer writes one closed workspace log and no application duplicate", async t => {
  const f = fixture(t), responses: any[] = [];
  let marked = 0;
  t.mock.method(WorkspacePrefsRepo.prototype, "listByWorkspace", () => { throw new Error("private-consumer-cause"); });
  const ctx = { db: f.db, workspaces: new Map([[f.aId, "untrusted-request-path"]]),
    onApiFailureLogged: () => { marked++; }, send: (response: unknown) => { responses.push(response); } } as unknown as ApiHandlerContext;
  handleWorkspacePrefsGet(ctx, { t: "api.req", id: "prefs-workspace-consumer", method: "workspacePrefs.get", body: { workspaceId: f.aId } } as ApiRequestMessage);
  await flushClientLogger();
  const applicationDir = process.env.CODEFLOWAI_CLIENT_LOG_DIR!;
  const application = fs.readdirSync(applicationDir).filter(name => name.endsWith(".log"))
    .flatMap(name => fs.readFileSync(path.join(applicationDir, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  assert.equal(application.filter(line => line.requestId === "prefs-workspace-consumer").length, 0, "business failure must leave the application destination");
  const names = fs.readdirSync(path.join(f.a, ".codeflowai")).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name));
  assert.equal(names.length, 1);
  const bytes = fs.readFileSync(path.join(f.a, ".codeflowai", names[0]!));
  const lines = bytes.toString("utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(JSON.parse(lines[0]!)).filter(([key]) => ["errorCode", "requestId", "workspaceId", "module"].includes(key))), {
    module: "workspace-prefs", errorCode: "WORKSPACE_PREFS_STORAGE_FAILED", requestId: "prefs-workspace-consumer", workspaceId: f.aId,
  });
  assert.doesNotMatch(bytes.toString("utf8"), /private-consumer-cause/);
  assert.equal(fs.existsSync(path.join(f.b, ".codeflowai")), false);
  assert.equal(responses.length, 1); assert.equal(responses[0].status, 500); assert.equal(marked, 1);
  assert.equal(f.gate.hasActiveWrites(), false);
  const release = await f.gate.acquireMigration(f.aId, "closed-log", { drainTimeoutMs: 100 }); release();
  assert.deepEqual(fs.readFileSync(path.join(f.a, ".codeflowai", names[0]!)), bytes);
});

test("original prefs handler stores in physical workspace and leaves application rows untouched", t => {
  const f = fixture(t);
  const saved = request(f.db, f.aId, [{ engine: "codex", workMode: "legacy", contextWindow: 123, autoCompactPct: 45 }]);
  assert.equal(saved.status, 200);
  assert.equal((f.db.db.prepare("SELECT count(*) AS count FROM workspace_prefs").get() as { count: number }).count, 0);
  const physical = openSqliteDb(path.join(f.a, ".codeflowai", "workspace.db"), { readonly: true });
  try { assert.equal((physical.prepare("SELECT context_window FROM workspace_prefs").get() as { context_window: number }).context_window, 123); }
  finally { physical.close(); }
  assert.deepEqual(request(f.db, f.bId).body.prefs, []);
  const second = openClientDb({ dbPath: f.dbPath });
  try { assert.deepEqual(request(second, f.aId).body.prefs, saved.body.prefs); }
  finally { second.close(); }
  for (const root of [f.a, f.b]) assert.deepEqual(fs.readdirSync(path.join(root, ".codeflowai")).filter(name => name.endsWith(".log")), []);
});

test("original prefs handler does not read or migrate old application prefs with the same key", t => {
  const f = fixture(t);
  f.db.db.prepare("INSERT INTO workspace_prefs VALUES (?,?,?,?,?,?)").run(f.aId, "codex", "general", 1, 900, 80);
  const before = f.db.db.prepare("SELECT * FROM workspace_prefs").all();
  assert.deepEqual(request(f.db, f.aId).body.prefs, []);
  request(f.db, f.aId, [{ engine: "codex", workMode: "general", contextWindow: 44 }]);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM workspace_prefs").all(), before);
});

test("real version 93 Profile workspace gains prefs without replacing Profile data", t => {
  const f = fixture(t), file = path.join(f.root, "v93.db"), db = openSqliteDb(file);
  try {
    db.exec(`CREATE TABLE workspace_execution_profiles (
      scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, user_id TEXT NOT NULL,
      profile_text TEXT NOT NULL, profile_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (scope_type, scope_id, user_id));
      INSERT INTO workspace_execution_profiles VALUES ('shared_workspace','scope','user','正文','hash',1,2);
      PRAGMA application_id = 1128683347; PRAGMA user_version = 93;`);
    const before = db.prepare("SELECT * FROM workspace_execution_profiles").all();
    migrateClientDb(db, { scope: "workspace" });
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_prefs'").get());
    assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
    assert.deepEqual(db.prepare("SELECT * FROM workspace_execution_profiles").all(), before);
  } finally { db.close(); }
});

test("prefs preserve filtering, null fields, empty batches and general mode for both engines", t => {
  const f = fixture(t);
  assert.deepEqual(request(f.db, f.aId, []).body.prefs, []);
  assert.deepEqual(request(f.db, f.aId, [
    { engine: "codex", workMode: "old", contextWindow: 64000, autoCompactPct: 70 },
    { engine: "claude", workMode: "plan", contextWindow: null, autoCompactPct: "invalid" },
    { engine: "codex" }, { engine: 42, workMode: "general" }, null,
  ]).body.prefs, [
    { engine: "codex", workMode: "general", contextWindow: 64000, autoCompactPct: 70 },
    { engine: "claude", workMode: "general", contextWindow: null, autoCompactPct: null },
  ]);
  request(f.db, f.bId, [{ engine: "codex", workMode: "general", contextWindow: 1 }]);
  assert.equal(request(f.db, f.aId).body.prefs.find((pref: any) => pref.engine === "codex").contextWindow, 64000);
  assert.equal(request(f.db, f.bId).body.prefs[0].contextWindow, 1);
  assert.equal((f.db as unknown as { workspacePrefs?: unknown }).workspacePrefs, undefined);
});

test("prefs retain original nontransactional batch semantics while reporting a partial write as failure", t => {
  const f = fixture(t), upsert = WorkspacePrefsRepo.prototype.upsert;
  const logs: unknown[] = [];
  const writeLog = f.db.writeWorkspaceLog;
  t.mock.method(f.db, "writeWorkspaceLog", (...args: Parameters<typeof writeLog>) => { logs.push(args); writeLog(...args); });
  t.mock.method(WorkspacePrefsRepo.prototype, "upsert", function(this: WorkspacePrefsRepo, input: Parameters<typeof upsert>[0]) {
    if (input.engine === "claude") throw new Error("secret-body-must-not-leak");
    return upsert.call(this, input);
  });
  const response = request(f.db, f.aId, [
    { engine: "codex", workMode: "general", contextWindow: 12 }, { engine: "claude", workMode: "general" },
  ]);
  assert.equal(response.status, 500); assert.equal(response.body.code, "INTERNAL_ERROR");
  assert.deepEqual(request(f.db, f.aId).body.prefs, [{ engine: "codex", workMode: "general", contextWindow: 12, autoCompactPct: null }]);
  assert.equal(logs.length, 1); assert.doesNotMatch(JSON.stringify(logs), /secret-body/);
});

for (const unsafe of ["missing-root", "deleted", "main-hardlink", "directory-link", "tracked-main", "log-hardlink", "log-link"] as const) {
  test(`prefs handler preserves business and workspace log safety for ${unsafe}`, t => {
    const f = fixture(t), directory = path.join(f.a, ".codeflowai"), protectedFile = path.join(f.root, "protected");
    fs.writeFileSync(protectedFile, "protected", "utf8");
    if (unsafe === "missing-root") fs.rmdirSync(f.a);
    else if (unsafe === "deleted") f.db.workspaces.delete(f.aId);
    else if (unsafe === "directory-link") {
      const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
      fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.mkdirSync(directory);
      if (unsafe === "main-hardlink" || unsafe === "log-hardlink" || unsafe === "log-link") {
        fs.linkSync(protectedFile, path.join(directory, "workspace.db"));
        if (unsafe === "log-hardlink" || unsafe === "log-link") {
          const date = new Date(), suffix = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
          const logFile = path.join(directory, `client-${suffix}.1.log`);
          if (unsafe === "log-hardlink") fs.linkSync(protectedFile, logFile);
          else if (process.platform === "win32") {
            const outside = path.join(f.root, "log-target"); fs.mkdirSync(outside);
            fs.symlinkSync(outside, logFile, "junction");
          } else fs.symlinkSync(protectedFile, logFile, "file");
        }
      }
      else {
        fs.writeFileSync(path.join(directory, "workspace.db"), "tracked", "utf8");
        execFileSync("git", ["init", "-q"], { cwd: f.a, windowsHide: true });
        execFileSync("git", ["add", "--", ".codeflowai/workspace.db"], { cwd: f.a, windowsHide: true });
      }
    }
    for (const prefs of [undefined, [{ engine: "codex", workMode: "general" }]]) {
      if (unsafe === "main-hardlink") {
        const response = request(f.db, f.aId, prefs);
        assert.equal(response.status, 500); assert.equal(response.body.code, "INTERNAL_ERROR");
      } else assert.throws(() => request(f.db, f.aId, prefs), error => {
        assert.ok(error instanceof AggregateError); assert.equal(error.message, "WORKSPACE_PREFS_FAILURE_LOG_FAILED");
        assert.equal(error.errors.length, 2); assert.equal(error.cause, error.errors[0]); return true;
      });
    }
    if (unsafe === "main-hardlink") {
      const logs = fs.readdirSync(directory).filter(name => name.endsWith(".log")).flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
      assert.equal(logs.length, 2);
      for (const log of logs) assert.deepEqual({ errorCode: log.errorCode, requestId: log.requestId, workspaceId: log.workspaceId }, {
        errorCode: "WORKSPACE_PREFS_STORAGE_FAILED", requestId: "prefs-request", workspaceId: f.aId,
      });
    }
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "protected");
    assert.equal(f.gate.hasActiveWrites(), false);
    assert.equal((f.db.db.prepare("SELECT count(*) AS count FROM workspace_prefs").get() as { count: number }).count, 0);
  });
}

test("prefs logging marks the failure once, retains both logger causes and does not catch response errors", t => {
  const f = fixture(t), storage = new Error("private-prefs"), logging = new Error("logger-down"), sending = new Error("transport-down");
  const responses: unknown[] = [], order: string[] = [];
  const ctx = { db: f.db, workspaces: new Map([[f.aId, f.a]]), onApiFailureLogged: () => { order.push("marked"); },
    send: (response: unknown) => { order.push("sent"); responses.push(response); } } as unknown as ApiHandlerContext;
  const req = { t: "api.req", id: "log-request", method: "workspacePrefs.get", body: { workspaceId: f.aId } } as ApiRequestMessage;
  t.mock.method(WorkspacePrefsRepo.prototype, "listByWorkspace", () => { throw storage; });
  const writeLog = f.db.writeWorkspaceLog;
  const log = t.mock.method(f.db, "writeWorkspaceLog", (...args: Parameters<typeof writeLog>) => { writeLog(...args); order.push("logged"); });
  handleWorkspacePrefsGet(ctx, req);
  assert.deepEqual(order, ["logged", "marked", "sent"]); assert.equal(responses.length, 1);
  assert.doesNotMatch(JSON.stringify(log.mock.calls[0]?.arguments), /private-prefs/);
  log.mock.mockImplementation(() => { throw logging; });
  assert.throws(() => handleWorkspacePrefsGet(ctx, req), error => {
    assert.ok(error instanceof AggregateError); assert.equal((error.errors[0] as Error).cause, storage);
    assert.equal(error.errors[1], logging); assert.equal(error.cause, error.errors[0]); return true;
  });
  assert.equal(responses.length, 1);
  log.mock.mockImplementation((...args: Parameters<typeof writeLog>) => { writeLog(...args); order.push("logged"); });
  ctx.send = () => { throw sending; };
  assert.throws(() => handleWorkspacePrefsGet(ctx, req), error => error === sending);
  assert.equal(log.mock.callCount(), 3, "send failure must not produce another storage log");
});

test("prefs success response failures escape without a storage log", t => {
  const f = fixture(t), sending = new Error("transport-down"), log = t.mock.method(f.db, "writeWorkspaceLog");
  const ctx = { db: f.db, workspaces: new Map([[f.aId, f.a]]), send: () => { throw sending; } } as unknown as ApiHandlerContext;
  assert.throws(() => handleWorkspacePrefsSave(ctx, { t: "api.req", id: "send", method: "workspacePrefs.save", body: { workspaceId: f.aId, prefs: [] } } as ApiRequestMessage), error => error === sending);
  assert.equal(log.mock.callCount(), 0);
});

for (const method of ["workspacePrefs.get", "workspacePrefs.save"] as const) {
  test(`${method} central dispatch rejects the original logging aggregate and releases storage resources`, async t => {
    const f = fixture(t), business = new Error("private-storage-cause"), logging = new Error("private-logging-cause");
    const responses: unknown[] = [];
    let marked = 0, storageFailure: unknown;
    const withPrefs = f.db.withWorkspacePrefs;
    /** 观察真实物理库边界的原异常身份，随后原样交 handler 和中央分发。 */
    f.db.withWorkspacePrefs = (id, operation) => {
      try { return withPrefs(id, operation); }
      catch (error) { storageFailure = error; throw error; }
    };
    if (method === "workspacePrefs.get") t.mock.method(WorkspacePrefsRepo.prototype, "listByWorkspace", () => { throw business; });
    else t.mock.method(WorkspacePrefsRepo.prototype, "upsert", () => { throw business; });
    const log = t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
    const ctx = { db: f.db, workspaces: new Map([[f.aId, f.a]]), workspaceOperationGate: f.gate,
      onApiFailureLogged: () => { marked++; }, send: (response: unknown) => { responses.push(response); } } as unknown as ApiHandlerContext;
    await assert.rejects(handleApiRequest(ctx, { t: "api.req", id: method, method,
      body: { workspaceId: f.aId, prefs: [{ engine: "codex", workMode: "general" }] } } as ApiRequestMessage), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, storageFailure); assert.equal(error.errors[0], storageFailure);
      assert.equal((storageFailure as Error).cause, business); assert.equal(error.errors[1], logging);
      return true;
    });
    assert.equal(log.mock.callCount(), 1); assert.equal(marked, 0); assert.deepEqual(responses, []);
    assert.equal(f.gate.hasActiveWrites(), false);
    const release = await f.gate.acquireMigration(f.aId, "after-logging-failure", { drainTimeoutMs: 100 });
    release();
  });

  test(`${method} central dispatch preserves one logged INTERNAL_ERROR response for ordinary storage failure`, async t => {
    const f = fixture(t), business = new Error("private-normal-cause"), responses: any[] = [];
    let marked = 0;
    if (method === "workspacePrefs.get") t.mock.method(WorkspacePrefsRepo.prototype, "listByWorkspace", () => { throw business; });
    else t.mock.method(WorkspacePrefsRepo.prototype, "upsert", () => { throw business; });
    const log = t.mock.method(f.db, "writeWorkspaceLog");
    const ctx = { db: f.db, workspaces: new Map([[f.aId, f.a]]), workspaceOperationGate: f.gate,
      onApiFailureLogged: () => { marked++; }, send: (response: unknown) => { responses.push(response); } } as unknown as ApiHandlerContext;
    await handleApiRequest(ctx, { t: "api.req", id: method, method,
      body: { workspaceId: f.aId, prefs: [{ engine: "codex", workMode: "general" }] } } as ApiRequestMessage);
    assert.equal(log.mock.callCount(), 1); assert.equal(marked, 1); assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 500); assert.equal(responses[0].body.code, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(log.mock.calls[0]?.arguments), /private-normal-cause/);
    assert.equal(f.gate.hasActiveWrites(), false);
  });
}

test("prefs get and save retain the original central migration 409 response", async t => {
  const f = fixture(t), release = f.gate.restoreMigration(f.aId, "migration");
  const log = t.mock.method(f.db, "writeWorkspaceLog"), warn = t.mock.method(logger, "warn", () => {});
  try {
    for (const method of ["workspacePrefs.get", "workspacePrefs.save"]) {
      const responses: any[] = [];
      const ctx = { db: f.db, workspaces: new Map([[f.aId, f.a]]), workspaceOperationGate: f.gate, send: (response: unknown) => { responses.push(response); } } as unknown as ApiHandlerContext;
      await handleApiRequest(ctx, { t: "api.req", id: method, method, body: { workspaceId: f.aId, prefs: [] } } as ApiRequestMessage);
      assert.equal(responses.length, 1); assert.equal(responses[0].status, 409);
      assert.equal(responses[0].body.code, "WORKSPACE_MIGRATION_IN_PROGRESS");
    }
    assert.equal(log.mock.callCount(), 0); assert.equal(warn.mock.callCount(), 2);
  } finally { release(); }
});

for (const first of ["profile", "prefs"] as const) {
  test(`${first} close failure blocks the other entry in the same workspace until original owner cleanup`, t => {
    const f = fixture(t), close = DatabaseSync.prototype.close;
    let blocked = true, held: DatabaseSync | undefined;
    const log = t.mock.method(f.db, "writeWorkspaceLog");
    t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
      const belongs = (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file === path.join(f.a, ".codeflowai", "workspace.db"));
      if (belongs && blocked) { held = this; throw new Error("close-private-detail"); }
      close.call(this);
    });
    const scope = { scopeType: "shared_workspace" as const, scopeId: "shared" };
    try {
      if (first === "profile") assert.throws(() => f.db.withWorkspaceExecutionProfiles(f.aId, repo => repo.upsert({ scope, userId: "user", profileText: "committed" })));
      else assert.throws(() => request(f.db, f.aId, [{ engine: "codex", workMode: "general", contextWindow: 77 }]), { message: "WORKSPACE_PREFS_FAILURE_LOG_FAILED" });
      assert.equal(held?.isOpen, true); assert.equal(f.gate.hasActiveWrites(), true);
      assert.throws(() => request(f.db, f.aId), { message: "WORKSPACE_PREFS_FAILURE_LOG_FAILED" });
      assert.throws(() => f.db.withWorkspaceExecutionProfiles(f.aId, repo => repo.get(scope, "user")));
      assert.deepEqual(request(f.db, f.bId).body.prefs, []);
      assert.throws(() => f.db.close(), { message: "CLIENT_DB_CLOSE_FAILED" });
      assert.equal(f.gate.hasActiveWrites(), true); assert.equal(held?.isOpen, true);
      blocked = false; f.db.close();
      assert.equal(held?.isOpen, false); assert.equal(f.gate.hasActiveWrites(), false);
      const reopened = openClientDb({ dbPath: f.dbPath });
      try {
        if (first === "profile") assert.equal(reopened.withWorkspaceExecutionProfiles(f.aId, repo => repo.get(scope, "user"))?.profileText, "committed");
        else assert.equal(request(reopened, f.aId).body.prefs[0].contextWindow, 77);
      } finally { reopened.close(); }
      assert.ok(log.mock.callCount() > 0);
    } finally { blocked = false; f.db.close(); }
  });
}

test("prefs initialization plus native cleanup failure retains both causes and blocks Profile", t => {
  const f = fixture(t), exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  const initialization = new Error("prefs-init-secret"), cleanup = new Error("prefs-close-secret");
  let blocked = true, held: DatabaseSync | undefined;
  /** 只在物理工作区连接注入故障，保留原 SQLite 清理回调。 */
  const belongs = (db: DatabaseSync) => (db.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file === path.join(f.a, ".codeflowai", "workspace.db"));
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (blocked && sql.startsWith("PRAGMA busy_timeout") && belongs(this)) throw initialization;
    exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (blocked && belongs(this)) { held = this; throw cleanup; }
    close.call(this);
  });
  try {
    assert.throws(() => f.db.withWorkspacePrefs(f.aId, repo => repo.listByWorkspace(f.aId)), error => {
      const cause = (error as Error).cause; assert.ok(cause instanceof AggregateError);
      assert.deepEqual(cause.errors, [initialization, cleanup]); return true;
    });
    assert.equal(held?.isOpen, true);
    assert.throws(() => f.db.withWorkspaceExecutionProfiles(f.aId, () => {}));
    assert.deepEqual(f.db.withWorkspacePrefs(f.bId, repo => repo.listByWorkspace(f.bId)), []);
  } finally { blocked = false; f.db.close(); }
  assert.equal(held?.isOpen, false); assert.equal(f.gate.hasActiveWrites(), false);
});

test("prefs reject asynchronous callbacks and file replacement after close without leaking gates", t => {
  const f = fixture(t);
  assert.throws(() => f.db.withWorkspacePrefs(f.aId, (() => Promise.resolve([])) as unknown as () => []));
  assert.equal(f.gate.hasActiveWrites(), false);
  const close = DatabaseSync.prototype.close, file = path.join(f.a, ".codeflowai", "workspace.db");
  const log = t.mock.method(f.db, "writeWorkspaceLog");
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const belongs = (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file === file);
    close.call(this);
    if (belongs) { fs.renameSync(file, `${file}.retained`); fs.writeFileSync(file, "replacement", "utf8"); }
  });
  assert.equal(request(f.db, f.aId).status, 500);
  assert.equal(log.mock.callCount(), 1); assert.equal(f.gate.hasActiveWrites(), false);
});

for (const resource of ["workspace-log", "git-exclude"] as const) {
  test(`原失败 owner 保留 ${resource} close 未确认且不盲重试 fd`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prefs-log-owner-")), a = path.join(root, "a"), b = path.join(root, "b");
    fs.mkdirSync(a); fs.mkdirSync(b);
    if (resource === "git-exclude") execFileSync("git", ["init", "-q"], { cwd: a, windowsHide: true });
    const gate = new WorkspaceOperationGate(), db = openClientDb({ dbPath: path.join(root, "application.db"), workspaceOperationGate: gate });
    const aId = "client:a" as WorkspaceId, bId = "client:b" as WorkspaceId;
    db.workspaces.upsert({ id: aId, title: "A", path: a }); db.workspaces.upsert({ id: bId, title: "B", path: b });
    const open = fs.openSync, close = fs.closeSync;
    const failure = new Error("owned-close-unconfirmed"), target = resource === "git-exclude" ? path.join(a, ".git", "info", "exclude") : undefined;
    let held: number | undefined, owned = false, closes = 0;
    const openMock = t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args), name = String(args[0]);
      if (name === target || resource === "workspace-log" && name.startsWith(path.join(a, ".codeflowai")) && name.endsWith(".log")) { held = fd; owned = true; }
      return fd;
    }) as typeof fs.openSync);
    const closeMock = t.mock.method(fs, "closeSync", (fd: number) => {
      if (owned && fd === held) { closes++; throw failure; }
      close(fd);
    });
    try {
      if (resource === "workspace-log") {
        const list = WorkspacePrefsRepo.prototype.listByWorkspace;
        t.mock.method(WorkspacePrefsRepo.prototype, "listByWorkspace", function(this: WorkspacePrefsRepo, id: WorkspaceId) {
          if (id === aId) throw new Error("private-owner-business");
          return list.call(this, id);
        });
        assert.throws(() => request(db, aId), { message: "WORKSPACE_PREFS_FAILURE_LOG_FAILED" });
      } else assert.throws(() => db.writeWorkspaceLog(aId, { level: "error", tag: "prefs", message: "failed", data: { requestId: "owned-request" } }));
      assert.equal(owned, true); assert.ok(held !== undefined); assert.equal(fs.fstatSync(held).isFile(), true);
      assert.equal(gate.hasActiveWrites(), true);
      assert.throws(() => db.withWorkspacePrefs(aId, repo => repo.listByWorkspace(aId)));
      assert.throws(() => db.writeWorkspaceLog(aId, { level: "error", tag: "prefs", message: "blocked" }));
      db.writeWorkspaceLog(bId, { level: "error", tag: "prefs", message: "other-workspace" });
      assert.deepEqual(db.withWorkspacePrefs(bId, repo => repo.listByWorkspace(bId)), []);
      await assert.rejects(gate.acquireMigration(aId, "blocked-owner", { drainTimeoutMs: 20 }));
      assert.throws(() => db.close(), error => {
        assert.ok(error instanceof AggregateError); assert.equal(error.message, "CLIENT_DB_CLOSE_FAILED");
        const retained = error.errors[0] as Error & { workspaceId: WorkspaceId; requestId: string; phase: string };
        assert.equal(retained.workspaceId, aId); assert.equal(retained.requestId, resource === "workspace-log" ? "prefs-request" : "owned-request");
        assert.equal(retained.phase, resource === "workspace-log" ? "workspace-log-close" : "git-exclude-close"); assert.equal(retained.cause, failure);
        return true;
      });
      assert.equal(closes, 1, "ClientDb.close must never retry an uncertain numeric fd");
      assert.equal(gate.hasActiveWrites(), true);
      assert.throws(() => db.db.prepare("SELECT 1"), "application database must close independently");
    } finally {
      openMock.mock.restore(); closeMock.mock.restore();
      if (owned && held !== undefined) { close(held); owned = false; }
      assert.equal(owned, false);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("workspace logging respects migration reservation, filtering and ClientDb closing", t => {
  const f = fixture(t), previous = process.env.CODEFLOWAI_CLIENT_LOG_LEVEL;
  process.env.CODEFLOWAI_CLIENT_LOG_LEVEL = "fatal";
  try { f.db.writeWorkspaceLog(f.aId, { level: "error", tag: "prefs", message: "filtered" }); }
  finally { if (previous === undefined) delete process.env.CODEFLOWAI_CLIENT_LOG_LEVEL; else process.env.CODEFLOWAI_CLIENT_LOG_LEVEL = previous; }
  assert.equal(fs.existsSync(path.join(f.a, ".codeflowai")), false);
  const release = f.gate.restoreMigration(f.aId, "reserved");
  try { assert.throws(() => f.db.writeWorkspaceLog(f.aId, { level: "error", tag: "prefs", message: "blocked" })); }
  finally { release(); }
  assert.equal(fs.existsSync(path.join(f.a, ".codeflowai")), false);
  f.db.close();
  assert.throws(() => f.db.writeWorkspaceLog(f.aId, { level: "error", tag: "prefs", message: "closed" }));
});

test("prefs legally filtered failure still marks and returns the original 500 without a log file", t => {
  const f = fixture(t), previous = process.env.CODEFLOWAI_CLIENT_LOG_LEVEL, responses: any[] = [];
  let marked = 0;
  t.mock.method(WorkspacePrefsRepo.prototype, "listByWorkspace", () => { throw new Error("filtered-business"); });
  process.env.CODEFLOWAI_CLIENT_LOG_LEVEL = "fatal";
  try {
    handleWorkspacePrefsGet({ db: f.db, workspaces: new Map([[f.aId, f.a]]), onApiFailureLogged: () => { marked++; },
      send: (response: unknown) => { responses.push(response); } } as unknown as ApiHandlerContext,
    { t: "api.req", id: "filtered-prefs", method: "workspacePrefs.get", body: { workspaceId: f.aId } } as ApiRequestMessage);
  } finally { if (previous === undefined) delete process.env.CODEFLOWAI_CLIENT_LOG_LEVEL; else process.env.CODEFLOWAI_CLIENT_LOG_LEVEL = previous; }
  assert.equal(marked, 1); assert.equal(responses.length, 1); assert.equal(responses[0].status, 500);
  assert.deepEqual(fs.readdirSync(path.join(f.a, ".codeflowai")).filter(name => name.endsWith(".log")), []);
});

test("nested same-workspace SQLite cleanup retains only the failed operation gate", t => {
  const f = fixture(t), close = DatabaseSync.prototype.close;
  let failOnce = true, held: DatabaseSync | undefined;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const belongs = (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file === path.join(f.a, ".codeflowai", "workspace.db"));
    if (belongs && failOnce) { failOnce = false; held = this; throw new Error("nested-close-failed"); }
    close.call(this);
  });
  assert.throws(() => f.db.withWorkspacePrefs(f.aId, () => f.db.withWorkspacePrefs(f.aId, repo => repo.listByWorkspace(f.aId))));
  assert.equal(held?.isOpen, true); assert.equal(f.gate.hasActiveWrites(), true);
  f.db.close();
  assert.equal(held?.isOpen, false);
  assert.equal(f.gate.hasActiveWrites(), false, "outer successful close must release its own gate even when inner resource is retained");
});
