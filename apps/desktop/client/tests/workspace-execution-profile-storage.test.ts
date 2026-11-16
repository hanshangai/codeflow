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
import { WorkspaceOperationGate, WorkspaceOperationGateError } from "../src/workspace-migration/workspaceOperationGate.js";
import { WorkspaceExecutionProfileRepo } from "../src/db/repos/workspaceExecutionProfileRepo.js";
import { handleApiRequest, getWorkspaceApiRequestFailureDetails, isWorkspaceApiRequestFailure,
  type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { flushClientLogger, logger } from "../src/logger.js";

const workspaceKind = 0x43465753;
const scope = { scopeType: "shared_workspace" as const, scopeId: "business-scope" };

/** 原 ClientDb 与迁移共用 gate；全部真实文件位于独占临时目录。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-storage-"));
  const a = path.join(root, "a"), b = path.join(root, "b"); fs.mkdirSync(a); fs.mkdirSync(b);
  const gate = new WorkspaceOperationGate(), dbPath = path.join(root, "application.db");
  const db = openClientDb({ dbPath, workspaceOperationGate: gate } as Parameters<typeof openClientDb>[0]);
  const aId = "client:a" as WorkspaceId, bId = "client:b" as WorkspaceId;
  db.workspaces.upsert({ id: aId, title: "A", path: a }); db.workspaces.upsert({ id: bId, title: "B", path: b });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, a, b, aId, bId, gate, db, dbPath };
}

/** 测试沿真实同步入口操作，异步回调仅在对应运行时拒绝测试中强制注入。 */
function profiles<T>(db: ClientDb, id: WorkspaceId, callback: (repo: WorkspaceExecutionProfileRepo) => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
  return db.withWorkspaceExecutionProfiles(id, callback);
}

/** 只读固定日志文件；空目录代表尚无该消费者副作用。 */
function logRows(directory: string): Record<string, any>[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^client-.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

/** 原中央入口保留物理workspace与业务scope，响应和mark均可观察。 */
function apiFixture(t: test.TestContext) {
  const f = fixture(t), responses: any[] = []; let marked = 0;
  const ctx = { db: f.db, workspaces: new Map([[f.aId, f.a], [f.bId, f.b]]), workspaceOperationGate: f.gate,
    onApiFailureLogged() { marked++; }, send(message: unknown) { responses.push(message); } } as unknown as ApiHandlerContext;
  return { ...f, ctx, responses, marked: () => marked,
    /** 每次调用真实分发器，不绕过业务仓储。 */
    call(method: string, id = method, body: Record<string, unknown> = {}) {
      return handleApiRequest(ctx, { t: "api.req", id, method, body: { workspaceId: f.aId, userId: "用户😀", profileScopeType: scope.scopeType,
        profileScopeId: scope.scopeId, profileText: "PRIVATE_PROFILE_BODY", ...body } } as ApiRequestMessage);
    } };
}

for (const [method, repositoryMethod] of [["get", "get"], ["update", "upsert"], ["status", "listStatuses"]] as const) {
  test(`Profile API ${method} failure writes only its physical workspace log`, async t => {
    const f = apiFixture(t), id = `Profile-中文😀-${method}`;
    t.mock.method(WorkspaceExecutionProfileRepo.prototype, repositoryMethod, () => { throw Object.assign(new Error("PRIVATE_ERROR password=API_SECRET"), { code: "EIO" }); });
    await f.call(`workspaceExecutionProfile.${method}`, id);
    await flushClientLogger();
    assert.equal(logRows(process.env.CODEFLOWAI_CLIENT_LOG_DIR!).filter(row => row.requestId === id).length, 0, "Profile business failure must leave application logs");
    const rows = logRows(path.join(f.a, ".codeflowai")); assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.module, "workspace-profile"); assert.equal(row.level, "ERROR");
    assert.equal(row.code, "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED"); assert.equal(row.errorCode, row.code);
    assert.deepEqual(row.event, { category: "workspace-profile", action: `workspaceExecutionProfile.${method}`, outcome: "fail" });
    assert.equal(row.requestId, id); assert.equal(row.workspaceId, f.aId); assert.equal(row.userId, "用户😀");
    assert.equal(row.scopeType, "shared_workspace"); assert.equal(row.scopeId, "business-scope"); assert.equal(row.rootCause.cause.code, "EIO");
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE_|API_SECRET|password|stack/);
    assert.equal(fs.existsSync(path.join(f.b, ".codeflowai")), false); assert.equal(fs.existsSync(path.join(f.root, "business-scope")), false);
    assert.equal(f.responses.length, 1); assert.equal(f.responses[0].status, 500); assert.equal(f.marked(), 1); assert.equal(f.gate.hasActiveWrites(), false);
    const release = await f.gate.acquireMigration(f.aId, id, { drainTimeoutMs: 100 }); release();
    assert.deepEqual(logRows(path.join(f.a, ".codeflowai")), rows);
  });
}

test("Profile API success missing Profile and legal validation responses create no failure log", async t => {
  const f = apiFixture(t);
  await f.call("workspaceExecutionProfile.get"); assert.equal(f.responses.at(-1).body.profile.source, "missing");
  await f.call("workspaceExecutionProfile.update", "save", { profileText: "中文😀" });
  await f.call("workspaceExecutionProfile.status"); assert.equal(f.responses.at(-1).body.statuses[0].hasProfile, true);
  assert.deepEqual(f.responses.map(row => row.status), [200, 200, 200]);
  await f.call("workspaceExecutionProfile.get", "invalid-user", { userId: "" });
  await f.call("workspaceExecutionProfile.update", "invalid-profile", { profileText: "x".repeat(12_001) });
  await f.call("workspaceExecutionProfile.status", "unknown-workspace", { workspaceId: "not-hosted" });
  assert.deepEqual(f.responses.slice(3).map(row => row.status), [400, 400, 404]);
  assert.equal(logRows(path.join(f.a, ".codeflowai")).length, 0); assert.equal(f.marked(), 0);
});

test("Profile API original migration rejection keeps 409 warn mark and zero workspace log", async t => {
  const f = apiFixture(t), warnings = t.mock.method(logger, "warn", () => {}), errors = t.mock.method(logger, "error", () => {});
  const workspaceLogs = t.mock.method(f.db, "writeWorkspaceLog"), release = f.gate.restoreMigration(f.aId, "move");
  try {
    for (const method of ["get", "update", "status"]) await f.call(`workspaceExecutionProfile.${method}`);
    assert.deepEqual(f.responses.map(row => row.status), [409, 409, 409]);
    assert.ok(f.responses.every(row => row.body.code === "WORKSPACE_MIGRATION_IN_PROGRESS"));
    assert.equal(warnings.mock.callCount(), 3); assert.equal(f.marked(), 3); assert.equal(logRows(path.join(f.a, ".codeflowai")).length, 0);
    for (const [index, method] of ["get", "update", "status"].entries()) {
      const call = warnings.mock.calls[index]!, data = call.arguments[2] as Record<string, any>;
      assert.equal(call.arguments[0], "workspace-migration");
      assert.equal(data.requestId, `workspaceExecutionProfile.${method}`); assert.equal(data.method, data.requestId);
      assert.equal(data.errorCode, "WORKSPACE_MIGRATION_IN_PROGRESS"); assert.equal(data.workspaceId, f.aId);
      assert.equal(data.operationId, "move"); assert.equal(data.userId, "用户😀");
      assert.equal(data.scopeType, scope.scopeType); assert.equal(data.scopeId, scope.scopeId);
      assert.equal(data.rootCause.code, data.errorCode);
      assert.deepEqual(data.event, { category: "workspace-migration", action: data.method, outcome: "fail" });
      assert.doesNotMatch(JSON.stringify(data), /PRIVATE_PROFILE_BODY/);
    }
    assert.equal(workspaceLogs.mock.callCount(), 0); assert.equal(errors.mock.callCount(), 0);
    await f.call("workspaceExecutionProfile.get", "other-workspace", { workspaceId: f.bId });
    assert.equal(f.responses.at(-1).status, 200); assert.equal(f.marked(), 3);
    assert.equal(f.gate.hasActiveWrites(), false);
  } finally { release(); }
  await f.call("workspaceExecutionProfile.update", "after-migration");
  assert.equal(f.responses.at(-1).status, 200); assert.equal(f.marked(), 3);
  assert.equal(profiles(f.db, f.aId, repo => repo.get(scope, "用户😀"))?.profileText, "PRIVATE_PROFILE_BODY");
});

for (const logging of [undefined, new Error("PRIVATE_MIGRATION_LOG")] as const) {
  test(`Profile API migration diagnostic failure retains both causes: ${typeof logging}`, async t => {
    const f = apiFixture(t), warnings = t.mock.method(logger, "warn", () => { throw logging; });
    const workspaceLogs = t.mock.method(f.db, "writeWorkspaceLog"), errors = t.mock.method(logger, "error", () => {});
    const release = f.gate.restoreMigration(f.aId, "move");
    try {
      await assert.rejects(f.call("workspaceExecutionProfile.update", "migration-log-failed"), error => {
        assert.ok(isWorkspaceApiRequestFailure(error));
        assert.equal(error.errors.length, 2); assert.equal(error.cause, error.errors[0]); assert.equal(error.errors[1], logging);
        assert.ok(error.errors[0] instanceof WorkspaceOperationGateError);
        assert.equal(error.errors[0].code, "WORKSPACE_MIGRATION_IN_PROGRESS");
        assert.deepEqual(getWorkspaceApiRequestFailureDetails(error), { code: "WORKSPACE_API_REQUEST_LOG_FAILED",
          requestId: "migration-log-failed", workspaceId: f.aId, method: "workspaceExecutionProfile.update",
          responseAttempted: false, responseDelivered: false });
        return true;
      });
      assert.equal(warnings.mock.callCount(), 1); assert.equal(workspaceLogs.mock.callCount(), 0); assert.equal(errors.mock.callCount(), 0);
      assert.equal(f.responses.length, 0); assert.equal(f.marked(), 0); assert.equal(f.gate.hasActiveWrites(), false);
      assert.equal(fs.existsSync(path.join(f.a, ".codeflowai")), false);
    } finally { release(); }
    await f.call("workspaceExecutionProfile.update", "recovered");
    assert.equal(f.responses.at(-1).status, 200);
    assert.equal(f.gate.hasActiveWrites(), false);
  });
}

test("Profile API legal log filtering still marks and sends its original failure", async t => {
  const f = apiFixture(t), previous = process.env.CODEFLOWAI_CLIENT_LOG_LEVEL;
  process.env.CODEFLOWAI_CLIENT_LOG_LEVEL = "fatal";
  t.after(() => { if (previous === undefined) delete process.env.CODEFLOWAI_CLIENT_LOG_LEVEL; else process.env.CODEFLOWAI_CLIENT_LOG_LEVEL = previous; });
  t.mock.method(WorkspaceExecutionProfileRepo.prototype, "get", () => { throw new Error("private"); });
  await f.call("workspaceExecutionProfile.get");
  assert.equal(f.responses[0].status, 500); assert.equal(f.marked(), 1); assert.equal(logRows(path.join(f.a, ".codeflowai")).length, 0);
});

for (const original of [undefined, null, false, 0, "", new Error("PRIVATE_BUSINESS")] as const) {
  test(`Profile API keeps original business and logging objects without retry or rollback: ${typeof original}-${String(original)}`, async t => {
    const f = apiFixture(t), logging = Object.assign(new Error("PRIVATE_LOGGING"), { code: "ENOSPC" });
    const nativeUpsert = WorkspaceExecutionProfileRepo.prototype.upsert; let attempts = 0;
    t.mock.method(WorkspaceExecutionProfileRepo.prototype, "upsert", function(this: WorkspaceExecutionProfileRepo, input: Parameters<WorkspaceExecutionProfileRepo["upsert"]>[0]) {
      attempts++; nativeUpsert.call(this, input); throw original;
    });
    t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
    const app = t.mock.method(logger, "error", () => {});
    await assert.rejects(f.call("workspaceExecutionProfile.update"), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.message, "WORKSPACE_PROFILE_FAILURE_LOG_FAILED");
      assert.equal(error.cause, error.errors[0]); assert.equal(error.errors[0].cause, original); assert.equal(error.errors[1], logging); return true;
    });
    assert.equal(attempts, 1); assert.equal(f.marked(), 0); assert.equal(f.responses.length, 0); assert.equal(app.mock.callCount(), 0);
    assert.equal(profiles(f.db, f.aId, repo => repo.get(scope, "用户😀"))?.profileText, "PRIVATE_PROFILE_BODY");
    assert.equal(f.gate.hasActiveWrites(), false);
  });
}

for (const kind of ["success", "validation", "rejected-dispatch", "failure-response"] as const) {
  test(`Profile API attempts one response and retains the request failure for ${kind}`, async t => {
    const f = apiFixture(t), first = new Error("FIRST_SEND_PRIVATE"), businessFailure = new Error("BUSINESS_PRIVATE");
    const rejected = { accepted: false, messageType: "api.res", readyState: 1, bufferedAmount: 0, bytes: 1,
      reason: "queue_full", queuedAt: 1, callbackError: null };
    let business = 0; const get = WorkspaceExecutionProfileRepo.prototype.get;
    t.mock.method(WorkspaceExecutionProfileRepo.prototype, "get", function(this: WorkspaceExecutionProfileRepo, ...args: Parameters<WorkspaceExecutionProfileRepo["get"]>) {
      business++; if (kind === "failure-response") throw businessFailure; return get.apply(this, args);
    });
    f.ctx.send = message => { f.responses.push(message); if (kind === "rejected-dispatch") return rejected; throw first; };
    await assert.rejects(f.call("workspaceExecutionProfile.get", kind, kind === "validation" ? { userId: "" } : {}), error => {
      assert.ok(isWorkspaceApiRequestFailure(error));
      const code = kind === "failure-response" ? "WORKSPACE_API_REQUEST_TRANSLATION_FAILED" : "WORKSPACE_API_RESPONSE_FAILED";
      assert.deepEqual(getWorkspaceApiRequestFailureDetails(error), { code, requestId: kind, workspaceId: f.aId,
        method: "workspaceExecutionProfile.get", responseAttempted: true, responseDelivered: false });
      assert.equal(error.cause, error.errors[0]);
      if (kind === "failure-response") {
        assert.equal(error.errors.length, 2); assert.equal((error.errors[0] as Error).cause, businessFailure); assert.equal(error.errors[1], first);
      } else assert.deepEqual(error.errors, [kind === "rejected-dispatch" ? rejected : first]);
      return true;
    });
    assert.equal(f.responses.length, 1); assert.equal(f.responses[0].status, kind === "failure-response" ? 500 : kind === "validation" ? 400 : 200);
    assert.equal(business, kind === "validation" ? 0 : 1); assert.equal(f.marked(), 1);
    const rows = logRows(path.join(f.a, ".codeflowai"));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.requestId, kind);
    assert.equal(rows[0]!.workspaceId, f.aId); assert.doesNotMatch(JSON.stringify(rows), /FIRST_SEND_PRIVATE|BUSINESS_PRIVATE|PRIVATE_PROFILE_BODY/);
    assert.equal(f.gate.hasActiveWrites(), false);
    t.mock.restoreAll();
    f.ctx.send = message => { f.responses.push(message); };
    await f.call("workspaceExecutionProfile.update", `${kind}-next`);
    assert.equal(f.responses.length, 2); assert.equal(f.responses.at(-1).status, 200); assert.equal(f.marked(), 1);
    assert.equal(profiles(f.db, f.aId, repo => repo.get(scope, "用户😀"))?.profileText, "PRIVATE_PROFILE_BODY");
    assert.equal(f.gate.hasActiveWrites(), false); assert.deepEqual(logRows(path.join(f.a, ".codeflowai")), rows);
  });
}

test("Profile API send error code accessor failure retains the original request failure", async t => {
  const f = apiFixture(t), original = new Error("PRIVATE_SEND"), diagnostic = new Error("PRIVATE_CODE_GETTER");
  Object.defineProperty(original, "code", { get() { throw diagnostic; } });
  f.ctx.send = response => { f.responses.push(response); throw original; };
  await assert.rejects(f.call("workspaceExecutionProfile.get"), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [original, diagnostic]); assert.equal(error.cause, original); return true;
  });
  assert.equal(f.responses.length, 1); assert.equal(f.responses[0].status, 200); assert.equal(f.marked(), 0);
  assert.equal(logRows(path.join(f.a, ".codeflowai")).length, 0); assert.equal(f.gate.hasActiveWrites(), false);
});

test("Profile API real workspace log fsync failure preserves both errors without retry", async t => {
  const f = apiFixture(t), business = new Error("PRIVATE_BUSINESS"), logging = new Error("PRIVATE_FSYNC");
  let attempts = 0; t.mock.method(WorkspaceExecutionProfileRepo.prototype, "get", () => { attempts++; throw business; });
  const sync = t.mock.method(fs, "fsyncSync", () => { throw logging; }), app = t.mock.method(logger, "error", () => {});
  await assert.rejects(f.call("workspaceExecutionProfile.get"), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].cause, business); assert.equal(error.errors[1], logging); return true;
  });
  assert.equal(attempts, 1); assert.equal(sync.mock.callCount(), 1); assert.equal(f.responses.length, 0); assert.equal(f.marked(), 0);
  assert.equal(app.mock.callCount(), 0); assert.equal(f.gate.hasActiveWrites(), false); assert.equal(logRows(path.join(f.a, ".codeflowai")).length, 1);
});

for (const unsafe of ["missing-root", "directory-link", "log-link", "log-hardlink", "tracked-log"] as const) {
  test(`Profile API preserves two failures and protected contents for ${unsafe}`, async t => {
    const f = apiFixture(t), directory = path.join(f.a, ".codeflowai"), protectedFile = path.join(f.root, "protected");
    fs.writeFileSync(protectedFile, "protected", "utf8");
    const date = new Date(), suffix = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    if (unsafe === "missing-root") fs.rmdirSync(f.a);
    else if (unsafe === "directory-link") {
      const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, directory, "junction");
    } else {
      fs.mkdirSync(directory); const log = path.join(directory, `client-${suffix}.1.log`);
      if (unsafe === "log-hardlink") fs.linkSync(protectedFile, log);
      else if (unsafe === "log-link") {
        const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, log, "junction");
      }
      else { fs.writeFileSync(log, "protected", "utf8"); execFileSync("git", ["init", "-q"], { cwd: f.a, windowsHide: true }); execFileSync("git", ["add", "--", `.codeflowai/client-${suffix}.1.log`], { cwd: f.a, windowsHide: true }); }
    }
    const failedGet = t.mock.method(WorkspaceExecutionProfileRepo.prototype, "get", () => { throw new Error("PRIVATE_BUSINESS"); });
    const app = t.mock.method(logger, "error", () => {});
    await assert.rejects(f.call("workspaceExecutionProfile.get"), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2); assert.equal(error.cause, error.errors[0]); return true;
    });
    assert.equal(f.responses.length, 0); assert.equal(f.marked(), 0); assert.equal(app.mock.callCount(), 0);
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "protected"); assert.equal(f.gate.hasActiveWrites(), false);
    if (unsafe === "missing-root") assert.equal(fs.existsSync(f.a), false);
    failedGet.mock.restore();
    assert.equal(profiles(f.db, f.bId, repo => repo.get(scope, "user")), null);
  });
}

test("Profile API workspace database hardlink failure can still use a safe workspace log", async t => {
  const f = apiFixture(t), directory = path.join(f.a, ".codeflowai"), protectedFile = path.join(f.root, "protected");
  fs.mkdirSync(directory); fs.writeFileSync(protectedFile, "protected", "utf8"); fs.linkSync(protectedFile, path.join(directory, "workspace.db"));
  await f.call("workspaceExecutionProfile.get"); assert.equal(f.responses[0].status, 500); assert.equal(f.marked(), 1);
  assert.equal(logRows(directory).length, 1); assert.equal(fs.readFileSync(protectedFile, "utf8"), "protected");
});

test("workspace Profiles persist only in their physical workspace and never adopt application rows", t => {
  const f = fixture(t);
  f.db.db.prepare("INSERT INTO workspace_execution_profiles VALUES (?,?,?,?,?,?,?)").run(scope.scopeType, scope.scopeId, "user", "old private profile", "old", 1, 1);
  assert.equal(profiles(f.db, f.aId, repo => repo.get(scope, "user")), null);
  profiles(f.db, f.aId, repo => repo.upsert({ scope, userId: "user", profileText: "A profile" }));
  profiles(f.db, f.bId, repo => repo.upsert({ scope, userId: "user", profileText: "B profile" }));
  assert.equal(profiles(f.db, f.aId, repo => repo.get(scope, "user"))?.profileText, "A profile");
  assert.equal(profiles(f.db, f.bId, repo => repo.get(scope, "user"))?.profileText, "B profile");
  assert.equal((f.db.db.prepare("SELECT profile_text FROM workspace_execution_profiles").get() as any).profile_text, "old private profile");
  assert.equal((f.db as any).workspaceExecutionProfiles, undefined);
  const physical = openSqliteDb(path.join(f.a, ".codeflowai", "workspace.db"), { readonly: true });
  try {
    assert.equal(physical.pragma("journal_mode", { simple: true }), "delete");
    assert.equal(physical.pragma("application_id", { simple: true }), workspaceKind);
    assert.equal(physical.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
    assert.deepEqual(physical.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
      ["scheduled_task_account_configs", "scheduled_task_configs", "scheduled_task_runs", "scheduled_task_runtime_states", "workspace_execution_profiles", "workspace_prefs"].map(name => ({ name })));
  } finally { physical.close(); }
  const second = openClientDb({ dbPath: f.dbPath });
  try { assert.equal(profiles(second, f.aId, repo => repo.get(scope, "user"))?.profileText, "A profile"); }
  finally { second.close(); }
});

test("workspace Profile reads obey the original migration gate and missing roots never fall back", t => {
  const f = fixture(t), release = f.gate.restoreMigration(f.aId, "move");
  try { assert.throws(() => profiles(f.db, f.aId, repo => repo.get(scope, "user")), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" }); }
  finally { release(); }
  fs.rmdirSync(f.a);
  assert.throws(() => profiles(f.db, f.aId, repo => repo.get(scope, "user")));
  assert.equal(fs.existsSync(f.a), false);
  f.db.workspaces.delete(f.bId);
  assert.throws(() => profiles(f.db, f.bId, repo => repo.get(scope, "user")));
  assert.equal(fs.existsSync(path.join(f.b, ".codeflowai")), false);
});

for (const callback of [() => Promise.resolve("later"), () => ({ then() {} })]) {
  test("workspace Profile operations reject asynchronous callbacks and release the original gate", t => {
    const f = fixture(t);
    let called = false;
    assert.throws(() => profiles(f.db, f.aId, () => { called = true; return callback() as unknown as string; }), error => {
      assert.equal((error as { code: string }).code, "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED");
      assert.equal((error as Error).cause instanceof Error && ((error as Error).cause as Error).message, "WORKSPACE_PROFILE_CALLBACK_MUST_BE_SYNCHRONOUS");
      return true;
    });
    assert.equal(called, true);
    assert.equal(f.gate.hasActiveWrites(), false);
  });
}

test("workspace Profile close failure retains a live connection and blocks only its workspace until cleanup", t => {
  const f = fixture(t), nativeClose = DatabaseSync.prototype.close;
  let failClose = true, held: DatabaseSync | undefined, opens = 0;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const names = this.prepare("PRAGMA database_list").all() as Array<{ file: string }>;
    if (names.some(row => row.file.endsWith("workspace.db"))) { opens++; if (failClose) { held = this; throw new Error("close blocked"); } }
    return nativeClose.call(this);
  });
  assert.throws(() => profiles(f.db, f.aId, repo => repo.upsert({ scope, userId: "user", profileText: "committed" })));
  assert.equal(held?.isOpen, true); assert.equal(f.gate.hasActiveWrites(), true);
  const before = opens;
  assert.throws(() => profiles(f.db, f.aId, repo => repo.get(scope, "user")));
  assert.equal(opens, before, "blocked workspace must not open another connection");
  failClose = false;
  assert.equal(profiles(f.db, f.bId, repo => repo.get(scope, "user")), null);
  f.db.close(); assert.equal(held?.isOpen, false); assert.equal(f.gate.hasActiveWrites(), false);
  assert.throws(() => profiles(f.db, f.bId, repo => repo.get(scope, "user")));
});

test("workspace Profile operation validates file identity after native close before reporting success", t => {
  const f = fixture(t), nativeClose = DatabaseSync.prototype.close;
  const file = path.join(f.a, ".codeflowai", "workspace.db");
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const matches = (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file === file);
    nativeClose.call(this);
    if (matches) { fs.renameSync(file, `${file}.retained`); fs.writeFileSync(file, "replacement", "utf8"); }
  });
  assert.throws(() => profiles(f.db, f.aId, repo => repo.get(scope, "user")), { code: "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED" });
  assert.equal(f.gate.hasActiveWrites(), false);
});

test("workspace Profile callback and native close errors preserve both causes until owner cleanup", t => {
  const f = fixture(t), nativeClose = DatabaseSync.prototype.close;
  const business = new Error("PROFILE_CALLBACK_ROOT"), cleanup = new Error("PROFILE_CLOSE_ROOT");
  let blocked = true;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (blocked && (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file.endsWith("workspace.db"))) throw cleanup;
    nativeClose.call(this);
  });
  try {
    assert.throws(() => profiles(f.db, f.aId, () => { throw business; }), error => {
      const cause = (error as Error).cause;
      assert.ok(cause instanceof AggregateError); assert.equal(cause.cause, business);
      assert.deepEqual(cause.errors, [business, cleanup]); return true;
    });
    assert.equal(f.gate.hasActiveWrites(), true);
    assert.throws(() => f.db.close(), { message: "CLIENT_DB_CLOSE_FAILED" });
    assert.throws(() => f.db.db.prepare("SELECT 1"), "application connection must close independently");
    assert.equal(f.gate.hasActiveWrites(), true);
  } finally { blocked = false; f.db.close(); }
  assert.equal(f.gate.hasActiveWrites(), false);
});

test("workspace Profile initialization and real native cleanup failure transfer the live resource to ClientDb", t => {
  const f = fixture(t), nativeExec = DatabaseSync.prototype.exec, nativeClose = DatabaseSync.prototype.close;
  const initialization = new Error("PROFILE_INIT_ROOT"), cleanup = new Error("PROFILE_INIT_CLOSE_ROOT");
  let blocked = true, held: DatabaseSync | undefined;
  /** 只注入当前工作区的原生初始化与关闭边界。 */
  const belongs = (db: DatabaseSync) => (db.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file.endsWith("workspace.db"));
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (blocked && sql.startsWith("PRAGMA busy_timeout") && belongs(this)) throw initialization;
    return nativeExec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (blocked && belongs(this)) { held = this; throw cleanup; }
    nativeClose.call(this);
  });
  try {
    assert.throws(() => profiles(f.db, f.aId, repo => repo.get(scope, "user")), error => {
      const cause = (error as Error).cause;
      assert.ok(cause instanceof AggregateError); assert.deepEqual(cause.errors, [initialization, cleanup]); return true;
    });
    assert.equal(held?.isOpen, true); assert.equal(f.gate.hasActiveWrites(), true);
    assert.throws(() => profiles(f.db, f.aId, repo => repo.get(scope, "user")));
  } finally { blocked = false; f.db.close(); }
  assert.equal(held?.isOpen, false); assert.equal(f.gate.hasActiveWrites(), false);
});

test("workspace Profile initialization COMMIT failure rolls back marker and schema and retries cleanly", t => {
  const f = fixture(t), nativeExec = DatabaseSync.prototype.exec, failure = new Error("COMMIT_ROOT");
  let failCommit = true;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (failCommit && sql === "COMMIT" && (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file.endsWith("workspace.db"))) throw failure;
    nativeExec.call(this, sql);
  });
  assert.throws(() => profiles(f.db, f.aId, repo => repo.get(scope, "user")), error => (error as Error).cause === failure);
  const raw = openSqliteDb(path.join(f.a, ".codeflowai", "workspace.db"));
  try {
    assert.equal(raw.pragma("application_id", { simple: true }), 0); assert.equal(raw.pragma("user_version", { simple: true }), 0);
    assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(), []);
  } finally { raw.close(); }
  assert.equal(f.gate.hasActiveWrites(), false); failCommit = false;
  assert.equal(profiles(f.db, f.aId, repo => repo.get(scope, "user")), null);
});

for (const unsafe of ["main-hardlink", "sidecar-hardlink", "orphan-sidecar", "directory-link", "tracked-main"] as const) {
  test(`workspace Profile rejects ${unsafe} without opening or changing protected contents`, t => {
    const f = fixture(t), directory = path.join(f.a, ".codeflowai"), protectedFile = path.join(f.root, "protected");
    fs.writeFileSync(protectedFile, "protected", "utf8");
    if (unsafe === "directory-link") {
      const external = path.join(f.root, "outside"); fs.mkdirSync(external);
      fs.symlinkSync(external, directory, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.mkdirSync(directory);
      const main = path.join(directory, "workspace.db");
      if (unsafe === "main-hardlink") fs.linkSync(protectedFile, main);
      else if (unsafe === "sidecar-hardlink") { fs.writeFileSync(main, Buffer.alloc(0)); fs.linkSync(protectedFile, `${main}-wal`); }
      else if (unsafe === "orphan-sidecar") fs.writeFileSync(`${main}-journal`, "orphan", "utf8");
      else {
        fs.writeFileSync(main, "tracked", "utf8");
        execFileSync("git", ["init", "-q"], { cwd: f.a, windowsHide: true });
        execFileSync("git", ["add", "--", ".codeflowai/workspace.db"], { cwd: f.a, windowsHide: true });
      }
    }
    let called = false;
    assert.throws(() => profiles(f.db, f.aId, () => { called = true; }));
    assert.equal(called, false); assert.equal(fs.readFileSync(protectedFile, "utf8"), "protected");
    assert.equal(f.gate.hasActiveWrites(), false);
  });
}

for (const kind of ["application", "foreign", "future", "unmarked", "view", "marked-damaged", "marked-view", "marked-no-key"] as const) {
  test(`workspace migration rejects ${kind} before changing journal or schema`, t => {
    const f = fixture(t), file = path.join(f.root, `${kind}.db`), db = openSqliteDb(file);
    try {
      db.pragma("journal_mode = WAL");
      if (kind === "application") migrateClientDb(db);
      else if (kind === "view") db.exec("CREATE VIEW protected AS SELECT 1 AS value");
      else if (kind === "unmarked") db.exec("CREATE TABLE protected(value TEXT)");
      else { db.pragma(`application_id = ${kind === "foreign" ? 1234 : workspaceKind}`); db.pragma(`user_version = ${kind === "marked-damaged" ? CLIENT_DB_SCHEMA_VERSION : CLIENT_DB_SCHEMA_VERSION + 1}`); }
      if (kind === "marked-view" || kind === "marked-no-key") {
        db.pragma(`user_version = ${CLIENT_DB_SCHEMA_VERSION}`);
        db.exec(kind === "marked-view"
          ? "CREATE VIEW workspace_execution_profiles AS SELECT '' AS scope_type, '' AS scope_id, '' AS user_id, '' AS profile_text, '' AS profile_hash, 1 AS created_at, 1 AS updated_at"
          : "CREATE TABLE workspace_execution_profiles(scope_type TEXT,scope_id TEXT,user_id TEXT,profile_text TEXT,profile_hash TEXT,created_at INTEGER,updated_at INTEGER)");
      }
      const before = db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all();
      assert.throws(() => (migrateClientDb as any)(db, { scope: "workspace" }));
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.deepEqual(db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all(), before);
    } finally { db.close(); }
  });
}
