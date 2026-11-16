import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

import { createDefaultRoleExecutionConfig, makeWorkspaceIdFromPathDigest, normalizeWorkspacePathForDerivedId, type ApiErrorCode, type ClientToServerMessage, type DesktopApiRequest, type DesktopTerminalEvent, type SharedWorkspaceId, type TerminalAction, type TerminalInfo, type ThreadId, type WorkspaceId } from "@codeflowai/shared";
import { writeTerminalActions } from "../src/terminal/terminalActionsConfig.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import { trackOrdinaryTurnExecution, waitForOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.js";
import { getWorkspaceApiRequestFailureDetails, isWorkspaceApiRequestFailure, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { logger } from "../src/logger.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { isDesktopLocalThreadAssetExecution } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { handleThreadsList } from "../src/app/handlers/threadHandlers.js";
import { handleEnginesStatus } from "../src/app/handlers/engineHandlers.js";
import { createBuiltInRelayCredentialService } from "../src/security/builtInRelayCredentialService.js";
import { DesktopBuiltInRelayRequestError } from "../src/runtime/desktopCloudAccount.js";
import { handleGitStatus, handleGitDiff, handleGitDiffFiles } from "../src/app/handlers/gitHandlers.js";
import * as gitService from "../src/git/gitService.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";

for (const kind of ["getter", "proxy", "head"] as const) test(`GITW metadata ${kind} preserves original evidence without unsafe access or re-read`, async t => {
  const f = await gitLogFixture(t), native = fsPromises.stat, reflection = new Error("REFLECTION_FAILED"), logging = false;
  let getters = 0;
  const statFailure = kind === "proxy" ? new Proxy({}, { getOwnPropertyDescriptor() { throw reflection; } })
    : Object.defineProperty(new Error("PRIVATE_STAT_SECRET"), "message", { get() { getters++; throw new Error("GETTER_EXECUTED"); } });
  t.mock.method(fsPromises, "stat", (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (args[0] === path.join(f.root, "中文🔒.txt")) {
      if (kind === "head") fs.renameSync(path.join(f.root, ".git"), path.join(f.root, ".git-unavailable"));
      throw statFailure;
    }
    return native(...args);
  }) as typeof fsPromises.stat);
  const writes = t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; }), app = t.mock.method(logger, "error", () => {});
  await assert.rejects(f.call({ method: "git.status", body: { workspaceId: f.workspaceId } }), error => {
    assert.ok(error instanceof AggregateError); assert.equal((error as any).code, "GIT_STATUS_METADATA_LOG_FAILED");
    const read = error.errors[0]; assert.ok(read instanceof AggregateError); assert.equal(read.errors[0], statFailure);
    if (kind === "head") { assert.equal(read.errors.length, 2); assert.ok(read.errors[1] instanceof Error); assert.match(read.errors[1].message, /not a git repository/); }
    assert.equal(error.errors[1], kind === "proxy" ? reflection : logging); return true;
  });
  assert.equal(getters, 0); assert.equal(writes.mock.callCount(), kind === "proxy" ? 0 : 1); assert.equal(app.mock.callCount(), 0); assert.equal(f.sent.length, 0);
});

test("GITW real A B bindings share one status subprocess while failed caller cannot poison its peer", async t => {
  const f = await gitLogFixture(t), native = fsPromises.stat, trace = path.join(f.directory, "status.trace"), originalTrace = process.env.GIT_TRACE2_EVENT;
  const statFailure = Object.assign(new Error("PRIVATE_STAT"), { code: "EACCES" }), logging = new Error("LOG_FAILED");
  t.mock.method(fsPromises, "stat", (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (args[0] === path.join(f.root, "中文🔒.txt")) throw statFailure; return native(...args);
  }) as typeof fsPromises.stat);
  const writer = f.db.writeWorkspaceLog.bind(f.db), requests: string[] = [];
  /** 固定物理绑定各写自己的 W；Git 读取路径相同仍必须共用原 pending。 */
  const context = (workspaceId: WorkspaceId, requestId: string) => ({ workspaceId, requestId, clientId: "local-client", method: "git.status",
    writeWorkspaceLog(entry: Parameters<typeof writer>[1]) { requests.push(requestId); if (requestId === "caller-A") throw logging; writer(workspaceId, entry); } });
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    const results = await Promise.allSettled([gitService.status(f.root, null, context(f.workspaceId, "caller-A")), gitService.status(f.root, null, context(f.otherId, "caller-B"))]);
    assert.equal(results[0]!.status, "rejected"); assert.equal(results[1]!.status, "fulfilled");
    assert.deepEqual(requests, ["caller-A", "caller-B"]); assert.equal(profileLogs(f.root).length, 0);
    const rows = profileLogs(f.other); assert.equal(rows.length, 1); assert.equal(rows[0].workspaceId, f.otherId); assert.equal(rows[0].requestId, "caller-B");
    const events = fs.readFileSync(trace, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(events.filter(row => row.event === "start" && row.argv?.[1] === "status").length, 1);
  } finally { if (originalTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = originalTrace; }
});

test("GITW resolved workspace and request survive mutable body and forged shared context", async t => {
  const f = await gitLogFixture(t), native = fsPromises.stat;
  const body = { workspaceId: f.workspaceId };
  f.ctx.localWorkspaceOnly = true;
  f.ctx.sharedFileRequestContext = { workspaceId: f.otherId, requestId: "forged" } as any;
  t.mock.method(fsPromises, "stat", (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (args[0] === path.join(f.root, "中文🔒.txt")) { body.workspaceId = f.otherId; throw Object.assign(new Error("PRIVATE_BODY"), { code: "EACCES" }); }
    return native(...args);
  }) as typeof fsPromises.stat);
  await handleGitStatus(f.ctx, { t: "api.req", id: "trusted-request", path: "", method: "git.status", body });
  const rows = profileLogs(f.root); assert.equal(rows.length, 1); assert.equal(rows[0].workspaceId, f.workspaceId); assert.equal(rows[0].requestId, "trusted-request");
  assert.equal(profileLogs(f.other).length, 0);
});

for (const condition of ["migration", "closing", "unsafe", "close-unconfirmed"] as const) test(`GITW fixed log ${condition} fails explicitly without application replacement`, async t => {
  const f = await gitLogFixture(t), app = t.mock.method(logger, "error", () => {});
  let release: (() => void) | undefined, held: number | undefined, replacementDb: ReturnType<typeof openClientDb> | undefined;
  const nativeClose = fs.closeSync, cause = new Error("CLOSE_UNCONFIRMED");
  if (condition === "migration") {
    f.db.close(); const gate = new WorkspaceOperationGate();
    const db = openClientDb({ dbPath: path.join(f.directory, "client.db"), workspaceOperationGate: gate });
    f.ctx.db = db; replacementDb = db; release = await gate.acquireMigration(f.workspaceId, "git-log-migration");
  } else if (condition === "closing") {
    const nativeRead = fsPromises.readdir;
    t.mock.method(fsPromises, "readdir", (async (...args: Parameters<typeof fsPromises.readdir>) => {
      if (args[0] === f.root) f.db.close(); return nativeRead(...args);
    }) as typeof fsPromises.readdir);
  }
  else if (condition === "unsafe") fs.writeFileSync(path.join(f.root, ".codeflowai"), "not-a-directory");
  else {
    const nativeOpen = fs.openSync;
    t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => { const fd = nativeOpen(...args); if (String(args[0]).startsWith(f.root) && String(args[0]).endsWith(".log")) held = fd; return fd; }) as typeof fs.openSync);
    t.mock.method(fs, "closeSync", (fd: number) => { if (fd === held) throw cause; nativeClose(fd); });
    const close = f.db.close;
    /** 原 owner 必须报告 close 未确认；断言失败结果并验证应用 DB 已真实关闭。 */
    t.mock.method(f.db, "close", () => {
      assert.throws(close, error => error instanceof AggregateError && error.message === "CLIENT_DB_CLOSE_FAILED" && error.errors[0].cause === cause);
      assert.throws(() => f.db.db.prepare("SELECT 1"), /database is not open/);
    });
  }
  try {
    const invoke = () => f.call({ method: "git.diff", body: { workspaceId: f.workspaceId, path: "x", repositoryPath: "../outside" } });
    await assert.rejects(invoke(), error => { assert.ok(error instanceof AggregateError); assert.equal((error as any).code, "GIT_READ_REQUEST_LOG_FAILED"); assert.equal(error.cause, error.errors[0]); return true; });
    const count = condition === "unsafe" ? (assert.equal(fs.statSync(path.join(f.root, ".codeflowai")).isFile(), true), 0) : profileLogs(f.root).length;
    if (condition === "close-unconfirmed") { assert.equal(count, 1); await assert.rejects(invoke(), error => error instanceof AggregateError); assert.equal(profileLogs(f.root).length, 1); }
    else assert.equal(count, 0);
    assert.equal(app.mock.callCount(), 0);
    assert.equal((await f.call({ method: "runtime.info" })).status, 200);
    if (condition !== "closing") assert.equal((await f.call({ method: "git.diff", body: { workspaceId: f.otherId, path: "x", repositoryPath: "../outside" } })).status, 500);
  } finally { release?.(); if (held !== undefined) { const fd = held; held = undefined; nativeClose(fd); } replacementDb?.close(); }
});

test("GITW unknown workspace creates no W log and a validated workspace rejection is recorded once", async t => {
  const f = await gitLogFixture(t);
  assert.equal((await f.call({ method: "git.status", body: { workspaceId: "local-client:unknown" } })).status, 404);
  assert.equal(profileLogs(f.root).length, 0);
  assert.equal((await f.call({ method: "git.diff", body: { workspaceId: f.workspaceId } })).status, 400);
  const logs = profileLogs(f.root);
  assert.equal(logs.length, 1); assert.equal(logs[0].module, "desktop-api");
  assert.equal(logs[0].workspaceId, f.workspaceId);
  assert.equal(profileLogs(f.other).length, 0);
});

test("GITW explicit dispatch rejection preserves read and rejection objects after one response", async t => {
  const f = await gitLogFixture(t), dispatch = { accepted: false, reason: "disconnected", callbackError: null };
  f.ctx.localWorkspaceOnly = true; const sends = t.mock.method(f.ctx, "send", () => dispatch as any);
  await assert.rejects(handleGitDiff(f.ctx, { t: "api.req", id: "dispatch", path: "", method: "git.diff", body: { workspaceId: f.workspaceId, path: "x", repositoryPath: "../outside" } }), error => {
    assert.ok(error instanceof AggregateError); assert.equal((error as any).code, "GIT_READ_RESPONSE_FAILED"); assert.equal(error.errors[1], dispatch); assert.equal(error.cause, error.errors[0]); return true;
  });
  assert.equal(sends.mock.callCount(), 1); assert.equal(profileLogs(f.root).length, 1);
});

for (const kind of ["getter", "proxy"] as const) test(`GITW request description ${kind} never executes unknown accessors`, async t => {
  const f = await gitLogFixture(t), native = fsPromises.readFile, reflection = new Error("REFLECTION_FAILED");
  let getters = 0;
  const original = kind === "proxy" ? new Proxy({}, { getOwnPropertyDescriptor() { throw reflection; } }) : new Error("PRIVATE_BODY");
  if (kind === "getter") for (const key of ["code", "message", "toString"]) Object.defineProperty(original, key, { get() { getters++; throw new Error("GETTER_EXECUTED"); } });
  t.mock.method(fsPromises, "readFile", (async (...args: Parameters<typeof fsPromises.readFile>) => {
    if (args[0] === path.join(f.root, "中文🔒.txt")) throw original; return native(...args);
  }) as typeof fsPromises.readFile);
  if (kind === "proxy") await assert.rejects(f.call({ method: "git.diffFiles", body: { workspaceId: f.workspaceId, path: "中文🔒.txt" } }), error => {
    assert.ok(error instanceof AggregateError); assert.equal((error as any).code, "GIT_READ_REQUEST_LOG_FAILED");
    assert.equal(error.errors[0], original); assert.equal(error.errors[1], reflection); assert.equal(error.cause, original); return true;
  });
  else assert.equal((await f.call({ method: "git.diffFiles", body: { workspaceId: f.workspaceId, path: "中文🔒.txt" } })).status, 500);
  assert.equal(getters, 0); assert.equal(profileLogs(f.root).length, kind === "proxy" ? 0 : 1);
});

/** 两个真实物理工作区只在自有夹具中准备 Git；请求仍经公开 executor。 */
async function gitLogFixture(t: test.TestContext) {
  const f = fixture(t), other = path.join(f.directory, "other"); fs.mkdirSync(other);
  const ids: WorkspaceId[] = [];
  for (const [index, root] of [f.root, other].entries()) {
    execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
    fs.writeFileSync(path.join(root, "中文🔒.txt"), "PRIVATE_FILE_BODY", "utf8");
    const response = await f.call({ method: "workspaces.upsert", body: { title: `Git ${index}`, path: root } });
    ids.push((response.body as any).workspace.id);
  }
  return { ...f, other, workspaceId: ids[0]!, otherId: ids[1]! };
}

for (const method of ["git.status", "git.diff", "git.diffFiles"] as const) test(`GITW ${method} public executor writes only trusted physical A`, async t => {
  const f = await gitLogFixture(t), app = t.mock.method(logger, "error", () => {});
  const response = await f.call({ method, body: { workspaceId: f.workspaceId, repositoryPath: "../outside", ...(method === "git.status" ? {} : { path: "中文🔒.txt" }) } });
  assert.equal(response.status, 500); assert.equal((response.body as any).code, "INTERNAL_ERROR");
  const logs = profileLogs(f.root).filter(row => row.module === "git");
  assert.equal(logs.length, 1); assert.equal(profileLogs(f.other).length, 0); assert.equal(app.mock.callCount(), 0);
  const row = logs[0]!; assert.equal(row.workspaceId, f.workspaceId); assert.equal(row.method, method); assert.equal(row.clientId, "local-client");
  assert.equal(row.code, "INTERNAL_ERROR"); assert.equal(row.errorCode, row.code); assert.ok(row.requestId);
  assert.deepEqual(row.event, { category: "git", action: method, outcome: "fail" });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_FILE_BODY|stack/);
  assert.equal((await f.call({ method, body: { workspaceId: f.otherId, ...(method === "git.status" ? {} : { path: "missing.txt" }) } })).status, 200);
});

test("GITW public metadata warning keeps healthy fields and logs Chinese path without body", async t => {
  const f = await gitLogFixture(t), native = fsPromises.stat;
  const statFailure = Object.assign(new Error("PRIVATE_STAT_BODY\npassword=SECRET"), { code: "EACCES" });
  fs.writeFileSync(path.join(f.root, "healthy.txt"), "healthy", "utf8");
  t.mock.method(fsPromises, "stat", (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (args[0] === path.join(f.root, "中文🔒.txt")) throw statFailure;
    return native(...args);
  }) as typeof fsPromises.stat);
  const app = t.mock.method(logger, "warn", () => {});
  const response = await f.call({ method: "git.status", body: { workspaceId: f.workspaceId } });
  assert.equal(response.status, 200); const body = response.body as any;
  assert.equal(body.fileStats["中文🔒.txt"], undefined); assert.equal(body.fileStats["healthy.txt"].size, 7);
  assert.equal(body.metadataFailures, undefined); const logs = profileLogs(f.root).filter(row => row.module === "git-status");
  assert.equal(logs.length, 1); assert.equal(logs[0].failedSample[0].path, "中文🔒.txt");
  assert.equal(logs[0].failedSample[0].reason.code, "EACCES"); assert.equal(logs[0].workspaceId, f.workspaceId);
  assert.ok(logs[0].requestId); assert.equal(app.mock.callCount(), 0); assert.equal(profileLogs(f.other).length, 0);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|SECRET|stack/);
});

test("GITW public metadata log failure preserves stat objects without read error relog or response", async t => {
  const f = await gitLogFixture(t), native = fsPromises.stat, statFailure = false, logging = new Error("LOG_FAILURE");
  t.mock.method(fsPromises, "stat", (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (args[0] === path.join(f.root, "中文🔒.txt")) throw statFailure;
    return native(...args);
  }) as typeof fsPromises.stat);
  const writes = t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; }), app = t.mock.method(logger, "error", () => {});
  await assert.rejects(f.call({ method: "git.status", body: { workspaceId: f.workspaceId } }), error => {
    assert.ok(error instanceof AggregateError); assert.equal((error as any).code, "GIT_STATUS_METADATA_LOG_FAILED");
    assert.equal(error.message, (error as any).code); assert.equal(error.cause, error.errors[0]);
    assert.equal(error.errors[0].errors[0], statFailure); assert.equal(error.errors[1], logging); return true;
  });
  assert.equal(writes.mock.callCount(), 1); assert.equal(app.mock.callCount(), 0); assert.equal(f.sent.length, 0);
});

for (const method of ["git.status", "git.diff", "git.diffFiles"] as const) for (const businessFailure of [false, true]) {
  test(`GITW ${method} send failure is attempted once business=${businessFailure}`, async t => {
    const f = await gitLogFixture(t), failure = false, handler = method === "git.status" ? handleGitStatus : method === "git.diff" ? handleGitDiff : handleGitDiffFiles;
    const sends = t.mock.method(f.ctx, "send", () => { throw failure; }); f.ctx.localWorkspaceOnly = true;
    const app = t.mock.method(logger, "error", () => {});
    await assert.rejects(handler(f.ctx, { t: "api.req", id: "send-once", path: "", method, body: { workspaceId: f.workspaceId,
      path: "missing.txt", ...(businessFailure ? { repositoryPath: "../outside" } : {}) } }), error => {
      assert.ok(error instanceof AggregateError); assert.equal((error as any).code, "GIT_READ_RESPONSE_FAILED");
      assert.equal(error.errors.at(-1), failure); assert.equal(error.errors.length, businessFailure ? 2 : 1);
      assert.equal(error.cause, error.errors[0]); return true;
    });
    assert.equal(sends.mock.callCount(), 1); assert.equal(app.mock.callCount(), 0);
    assert.equal(profileLogs(f.root).filter(row => row.module === "git").length, businessFailure ? 1 : 0);
  });
}

/** 真实本地 SQLite 与目录隔离，测试不得依赖 Server 或现有用户数据。 */
function fixture(t: test.TestContext) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-desktop-api-")));
  const root = path.join(directory, "project");
  fs.mkdirSync(root);
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sent: ClientToServerMessage[] = [];
  const ctx = { db, clientId: "local-client", workspaces: new Map<WorkspaceId, string>(), threads: new ThreadStore(), send: (message: ClientToServerMessage) => { sent.push(message); } } as ApiHandlerContext;
  let requestNumber = 0;
  const startedAt = Date.now();
  return { ctx, db, root, directory, sent, startedAt,
    /** 经实际统一处理器调用桥接，并为每个请求提供独立关联 ID。 */
    call(request: DesktopApiRequest) {
      requestNumber += 1;
      return executeDesktopApiRequest(ctx, request, { requestId: `request-${requestNumber}`, clientVersion: "1.0.0", startedAt });
    },
  };
}

for (const dispatched of [true, false]) test(`可信本机${dispatched ? "运行" : "准备中"}回合的桌面终止先于数据库预检，保存错误留在原尾链`, async t => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "停止测试", path: f.root } });
  const workspaceId = (created.body as any).workspace.id as WorkspaceId, threadId = "stop-runtime" as ThreadId, turnId = "stop-turn";
  f.ctx.threads.create({ workspaceId, threadId, engine: "codex", title: "停止测试" });
  f.ctx.getActiveThreadTurn = () => ({ turnId, startedAt: 1, source: "runtime" });
  const failure = new Error("DATABASE_UNAVAILABLE");
  let stopped = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const tails: Promise<unknown>[] = [];
  f.ctx.sessions = { beginThreadOperation() { return () => {}; }, async interrupt(_thread: string, _turn: string, options: any) {
    stopped++; options.onStopConfirmed(); throw failure;
  } } as any;
  f.ctx.trackApiTail = tail => { tails.push(tail.then(() => assert.fail("保存失败不得假成功"), error => error)); };
  trackOrdinaryTurnExecution(f.ctx.sessions, { workspaceId, threadId, turnId, localWorkspaceOnly: true }, async execution => {
    if (dispatched) execution.markProviderDispatch();
    await pending;
  });
  await Promise.resolve();
  f.ctx.withDatabase = async () => { assert.equal(stopped, dispatched ? 1 : 0, "停止前不得访问数据库"); throw failure; };
  try {
    const response = await f.call({ method: "turns.interrupt", body: { workspaceId, threadId, turnId } });
    assert.equal(response.status, 200);
    assert.equal((response.body as any).phase, "draining");
    assert.equal(stopped, dispatched ? 1 : 0);
    assert.equal(tails.length, 1);
    const tailFailure = await tails[0];
    assert.ok(tailFailure instanceof AggregateError && tailFailure.errors.includes(failure));
  } finally { release(); await waitForOrdinaryTurnExecution(f.ctx.sessions, { workspaceId, threadId, turnId }); }
});

for (const mismatch of ["unverified-owner", "successor", "workspace"] as const) test(`桌面终止${mismatch}不得绕过原数据库归属校验`, async t => {
  const f = fixture(t), workspaceId = "local-client:ws-stop" as WorkspaceId, threadId = "thread-stop" as ThreadId, turnId = "turn-stop";
  f.ctx.workspaces.set(workspaceId, f.root);
  f.ctx.threads.create({ workspaceId, threadId, engine: "codex", title: "范围检查" });
  f.ctx.getActiveThreadTurn = () => ({ turnId: mismatch === "successor" ? "new-turn" : turnId, startedAt: 1, source: "runtime" });
  let stops = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.ctx.sessions = { async interrupt() { stops++; return true; } } as any;
  trackOrdinaryTurnExecution(f.ctx.sessions, { workspaceId, threadId, turnId, localWorkspaceOnly: mismatch !== "unverified-owner" }, async () => { await pending; });
  const failure = new Error("ORIGINAL_DATABASE_VALIDATION_REQUIRED");
  f.ctx.withDatabase = async () => { throw failure; };
  try {
    await assert.rejects(f.call({ method: "turns.interrupt", body: {
      workspaceId: mismatch === "workspace" ? "local-client:other" : workspaceId, threadId, turnId,
    } }), error => error === failure);
    assert.equal(stops, 0);
  } finally { release(); await waitForOrdinaryTurnExecution(f.ctx.sessions, { workspaceId, threadId, turnId }); }
});

/** 桌面 Profile 诊断从真实物理工作区读取，不替换固定日志入口。 */
function profileLogs(root: string): any[] {
  const directory = path.join(root, ".codeflowai");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

test("desktop Profile diagnostics distinguish wrong kind and broken schema without changing the original cause", async t => {
  const f = fixture(t), log = t.mock.method(logger, "error", () => {});
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Profile", path: f.root } });
  const workspaceId = (created.body as any).workspace.id, directory = path.join(f.root, ".codeflowai"), file = path.join(directory, "workspace.db");
  const responseCode: ApiErrorCode = "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED";
  fs.mkdirSync(directory);
  const causes: Record<string, unknown>[] = [];
  for (const kind of ["foreign", "damaged"] as const) {
    const native = new DatabaseSync(file);
    try {
      native.exec(`PRAGMA application_id=${kind === "foreign" ? 1234 : 0x43465753}; PRAGMA user_version=${CLIENT_DB_SCHEMA_VERSION}`);
    } finally { native.close(); }
    const reason = kind === "foreign" ? "WORKSPACE_DB_KIND_OR_VERSION_UNSUPPORTED" : "WORKSPACE_DB_SCHEMA_INVALID";
    let original: Error | undefined;
    assert.throws(() => f.db.withWorkspaceExecutionProfiles(workspaceId, repo => repo.get({ scopeType: "local_workspace", scopeId: workspaceId }, "local:local-client")), error => {
      assert.ok(error instanceof Error); assert.ok(error.cause instanceof Error);
      original = error.cause; assert.equal(original.message, reason); return true;
    });
    const beforeLogs = profileLogs(f.root).length;
    const response = await f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId } });
    assert.equal(response.status, 500); assert.equal((response.body as any).code, responseCode);
    assert.equal(profileLogs(f.root).length - beforeLogs, 1); assert.equal(log.mock.callCount(), 0);
    const payload = profileLogs(f.root).at(-1)!;
    assert.equal(payload.workspaceId, workspaceId); assert.equal(payload.userId, "local:local-client");
    assert.equal(payload.scopeType, "local_workspace"); assert.equal(payload.scopeId, workspaceId); assert.ok(payload.requestId);
    assert.equal(payload.rootCause.cause.reason, reason); assert.equal(original!.message, reason);
    causes.push(payload.rootCause);
  }
  assert.notDeepEqual(causes[0], causes[1]);
});

test("desktop Profile missing root keeps business and fixed log failure without recreating the root", async t => {
  const f = fixture(t), log = t.mock.method(logger, "error", () => {});
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Profile", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  fs.rmdirSync(f.root);
  await assert.rejects(f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId } }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.cause, error.errors[0]);
    assert.equal(error.errors[0].cause.code, "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE"); assert.equal(error.errors[0].cause.cause.code, "ENOENT");
    assert.equal(error.errors[1].code, "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE"); return true;
  });
  assert.equal(log.mock.callCount(), 0); assert.equal(fs.existsSync(f.root), false);
});

test("desktop Profile tracked private runtime keeps both failures without modifying protected data", async t => {
  const f = fixture(t), log = t.mock.method(logger, "error", () => {});
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Profile", path: f.root } });
  const workspaceId = (created.body as any).workspace.id, directory = path.join(f.root, ".codeflowai");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "workspace.db"), Buffer.alloc(0));
  execFileSync("git", ["init", "-q"], { cwd: f.root, windowsHide: true });
  execFileSync("git", ["add", "--", ".codeflowai/workspace.db"], { cwd: f.root, windowsHide: true });
  const before = fs.readFileSync(path.join(directory, "workspace.db"));
  await assert.rejects(f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId } }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.cause, error.errors[0]);
    assert.equal(error.errors[0].cause.code, "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED"); assert.equal(error.errors[1].code, "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED"); return true;
  });
  assert.equal(log.mock.callCount(), 0); assert.deepEqual(fs.readFileSync(path.join(directory, "workspace.db")), before); assert.equal(profileLogs(f.root).length, 0);
});

for (const method of ["get", "update", "status"] as const) test(`desktop Profile ${method} close failure blocks same workspace logs until original owner cleanup`, async t => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Profile", path: f.root } });
  const workspaceId = (created.body as any).workspace.id, nativeClose = DatabaseSync.prototype.close;
  if (method !== "update") f.db.withWorkspaceExecutionProfiles(workspaceId, repo => repo.upsert({ scope: { scopeType: "local_workspace", scopeId: workspaceId }, userId: "local:local-client", profileText: "PRIVATE_PROFILE_BODY" }));
  const log = t.mock.method(logger, "error", () => {}), failure = Object.assign(new Error("WORKSPACE_DB_SCHEMA_INVALID\nPRIVATE_PROFILE_BODY\npassword=API_SECRET\nstack body"),
    { code: "EACCES", errno: -13, errcode: 13 });
  let blocked = true, held: DatabaseSync | undefined;
  /** 只阻断 A 的原生 close，异工作区仍可独立收口。 */
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (blocked && (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => path.resolve(row.file) === path.join(f.root, ".codeflowai", "workspace.db"))) { held = this; throw failure; }
    nativeClose.call(this);
  });
  try {
    await assert.rejects(f.call({ method: `workspaceExecutionProfile.${method}`, body: { workspaceId, ...(method === "update" ? { profileText: "PRIVATE_PROFILE_BODY" } : {}) } }), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.cause, error.errors[0]);
      assert.equal(error.errors[0].cause, failure); assert.equal(error.errors[1].cause, failure); return true;
    });
    assert.equal(held?.isOpen, true); assert.equal(profileLogs(f.root).length, 0); assert.equal(log.mock.callCount(), 0);
    await assert.rejects(f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId } }), error => error instanceof AggregateError);
    const other = path.join(f.directory, "other"); fs.mkdirSync(other); const otherId = "local-client:other" as WorkspaceId;
    f.db.workspaces.upsert({ id: otherId, title: "B", path: other }); f.ctx.workspaces.set(otherId, other);
    assert.equal((await f.call({ method: "runtime.info" })).status, 200);
    assert.equal((await f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId: otherId } })).status, 200);
  } finally { blocked = false; f.db.close(); }
  assert.equal(held?.isOpen, false);
  const reopened = openClientDb({ dbPath: path.join(f.directory, "client.db") });
  try { assert.equal(reopened.withWorkspaceExecutionProfiles(workspaceId, repo => repo.get({ scopeType: "local_workspace", scopeId: workspaceId }, "local:local-client"))?.profileText, "PRIVATE_PROFILE_BODY"); }
  finally { reopened.close(); }
});

test("desktop Profile storage and logging failure preserve both original errors", async t => {
  const f = fixture(t), created = await f.call({ method: "workspaces.upsert", body: { title: "Profile", path: f.root } });
  const workspaceId = (created.body as any).workspace.id, nativeClose = DatabaseSync.prototype.close;
  const storage = new Error("PRIVATE_PROFILE\npassword=secret"), logging = new Error("LOGGING_ROOT");
  let blocked = true;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (blocked && (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file.endsWith("workspace.db"))) throw storage;
    nativeClose.call(this);
  });
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  try {
    await assert.rejects(f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId } }), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.cause, error.errors[0]);
      assert.equal(error.errors[0].cause, storage); assert.equal(error.errors[1], logging); return true;
    });
  } finally { blocked = false; }
});

test("desktop directory migration and software bridge methods keep local ownership", async t => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Migration", path: f.root } });
  const workspaceId = (created.body as any).workspace.id as WorkspaceId;

  const missing = await f.call({ method: "workspaceDirectoryMigration.get", body: { workspaceId, operationId: "missing" } });
  assert.equal(missing.status, 404);
  for (const target of ["shared:one", "other-client:ws"]) {
    const rejected = await f.call({ method: "workspaceDirectoryMigration.get", body: { workspaceId: target, operationId: "op" } });
    assert.equal(rejected.status, 400);
  }
  const unknownField = await f.call({ method: "software.update.status", body: { forceRefresh: true, workspaceId } });
  assert.equal(unknownField.status, 400);
  const disallowedPackage = await f.call({ method: "software.npm.install", body: { npmPackage: "evil-package" } });
  assert.equal(disallowedPackage.status, 403);
});

test("desktop codeflowai config reads and writes only the hosted local workspace", async t => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Config", path: f.root } });
  const workspaceId = (created.body as any).workspace.id as WorkspaceId;

  const initial = await f.call({ method: "codeflowai.config.get", body: { workspaceId } });
  assert.equal(initial.status, 200); const initialBody = initial.body as any;
  assert.equal(initialBody.ok, true); assert.match(initialBody.path, /codeflowai\.json$/u);

  const saved = await f.call({ method: "codeflowai.config.set", body: { workspaceId,
    config: { paths: { workflowDocsRoot: "codeflow-docs" }, fileIndex: { maxEntries: 50000 } } } });
  assert.equal(saved.status, 200);
  const reread = await f.call({ method: "codeflowai.config.get", body: { workspaceId } });
  assert.equal((reread.body as any).config.fileIndex.maxEntries, 50000);
  assert.equal(JSON.parse(fs.readFileSync(initialBody.path, "utf8")).fileIndex.maxEntries, 50000);

  // 旧版本遗留的 execution 字段在读取归一化时移除并写回。
  const legacy = JSON.parse(fs.readFileSync(initialBody.path, "utf8"));
  legacy.execution = { mode: "auto", language: "en-US" };
  fs.writeFileSync(initialBody.path, JSON.stringify(legacy, null, 2));
  const cleaned = await f.call({ method: "codeflowai.config.get", body: { workspaceId } });
  assert.equal((cleaned.body as any).config.execution, undefined);
  assert.equal(JSON.parse(fs.readFileSync(initialBody.path, "utf8")).execution, undefined);
});

test("desktop codeflowai config rejects unknown fields and shared or foreign workspaces", async t => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Config", path: f.root } });
  const workspaceId = (created.body as any).workspace.id as WorkspaceId;

  const unknownField = await f.call({ method: "codeflowai.config.get", body: { workspaceId, userId: "forged" } });
  assert.equal(unknownField.status, 400);
  assert.match((unknownField.body as any).message, /userId/u);

  const invalidConfig = await f.call({ method: "codeflowai.config.set", body: { workspaceId, config: [] } });
  assert.equal(invalidConfig.status, 400); assert.match((invalidConfig.body as any).message, /config 必须是对象/u);
  const missingConfig = await f.call({ method: "codeflowai.config.set", body: { workspaceId } });
  assert.equal(missingConfig.status, 400);

  for (const target of ["shared:ws", "other-client:ws"]) {
    const rejected = await f.call({ method: "codeflowai.config.get", body: { workspaceId: target } });
    assert.equal(rejected.status, 400);
    assert.match((rejected.body as any).message, /仅支持本机工作区的精确 ID/u);
  }
  const unhosted = await f.call({ method: "codeflowai.config.get", body: { workspaceId: "local-client:missing" } });
  assert.equal(unhosted.status, 404);
});

test("desktop builtin ensure preserves structured key switch conflict without exposing secrets", async t => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Keys", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  const cause = Object.assign(new Error("确认停止运行回合"), { code: "CONFLICT", details: { reason: "running_turns_confirm_required", runningCount: 1 } });
  (f.ctx as any).desktopCloudAccount = { snapshot: () => ({ generation: 1 }), getOwner: () => ({ serverOrigin: 'https://cloud.example.test', ownerUserId: 'owner', accountSessionId: 'session', generation: 1 }) };
  (f.ctx as any).builtInRelayCredentials = { ensure: async () => { throw cause; } };
  const result = await f.call({ method: "engineKeys.builtInRelay.ensure", body: { workspaceId, engine: "codex", providerId: "openai", intent: "manual" } });
  assert.equal(result.status, 409); assert.deepEqual((result.body as any).details, cause.details);
  assert.equal((result.body as any).code, "CONFLICT");
});

test("desktop builtin ensure returns typed HTTP failure with safe diagnostic details", async t => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Keys", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  (f.ctx as any).desktopCloudAccount = { snapshot: () => ({ generation: 1 }), getOwner: () => ({ serverOrigin: 'https://cloud.example.test', ownerUserId: 'owner', accountSessionId: 'session', generation: 1 }) };
  (f.ctx as any).builtInRelayCredentials = { ensure: async () => { throw new DesktopBuiltInRelayRequestError(409, "RELAY_MISCONFIGURED", { providerId: "openai", rawKey: "secret-key" }); } };
  const result = await f.call({ method: "engineKeys.builtInRelay.ensure", body: { workspaceId, engine: "codex", providerId: "openai", intent: "manual" } });
  assert.equal(result.status, 409); assert.equal((result.body as any).code, "RELAY_MISCONFIGURED");
  assert.deepEqual((result.body as any).details, { providerId: "openai" });
  assert.equal(JSON.stringify(result).includes("secret-key"), false);
});

test("desktop cloud bridge rejects renderer identity and invokes only trusted runtime", async t => {
  const f = fixture(t);
  const calls: unknown[] = [];
  const account = { status: "linked", generation: 2, serverOrigin: "https://cloud.example.test", userSummary: null, errorCode: null };
  (f.ctx as any).desktopCloudAccount = {
    snapshot: () => account,
    link: async (body: unknown) => { calls.push(body); return account; },
    unlink: async () => ({ ...account, status: "unlinked" }),
  };
  const denied = await f.call({ method: "runtime.cloudAccount.link", body: { serverOrigin: account.serverOrigin, sessionToken: "temporary-session", userId: "forged" } });
  assert.equal(denied.status, 400); assert.equal(calls.length, 0);
  const linked = await f.call({ method: "runtime.cloudAccount.link", body: { serverOrigin: account.serverOrigin, sessionToken: "temporary-session" } });
  assert.equal(linked.status, 200); assert.deepEqual((linked.body as any).account, account);
  assert.deepEqual(calls, [{ serverOrigin: account.serverOrigin, sessionToken: "temporary-session" }]);
  assert.equal(JSON.stringify(linked.body).includes("temporary-session"), false);
});

test('desktop unknown Key hides old secret and requires explicit re-entry before activation', async t => {
  const f = fixture(t);
  const created = await f.call({ method: 'workspaces.upsert', body: { title: 'Keys', path: f.root } }), workspaceId = (created.body as any).workspace.id;
  const key = f.db.engineKeys.insert({ label: 'legacy', engine: 'claude', providerId: 'anthropic', apiKey: 'legacy-private-secret' });
  f.db.db.prepare("UPDATE engine_keys SET source = 'unknown' WHERE id = ?").run(key.id);
  const listed = await f.call({ method: 'engineKeys.list', body: { workspaceId } });
  const entry = (listed.body as any).keys.find((row: any) => row.id === key.id);
  assert.equal(entry.apiKey, ''); assert.equal(entry.source, 'unknown'); assert.equal(entry.runtimeAvailable, false);
  const activation = await f.call({ method: 'engineKeys.activate', body: { workspaceId, id: key.id } });
  assert.equal(activation.status, 409); assert.equal((activation.body as any).details.reason, 'ENGINE_KEY_SOURCE_REVALIDATION_REQUIRED');
  assert.equal(f.db.engineKeys.get(key.id)?.source, 'unknown');
  assert.equal(f.db.engineKeys.get(key.id)?.apiKey, 'legacy-private-secret');
  const replacement = await f.call({ method: 'engineKeys.upsert', body: { workspaceId, id: key.id, label: 're-entered', engine: 'claude', providerId: 'anthropic', apiKey: 'new-personal-secret' } });
  assert.equal(replacement.status, 200); assert.equal(f.db.engineKeys.get(key.id)?.source, 'user_configured');
});

test('explicit activation of an already active custom Key clears only its deletion intent', async t => {
  const f = fixture(t);
  const created = await f.call({ method: 'workspaces.upsert', body: { title: 'Keys', path: f.root } }), workspaceId = (created.body as any).workspace.id;
  const custom = f.db.engineKeys.insert({ label: 'personal', engine: 'claude', providerId: 'anthropic', apiKey: 'personal-secret' });
  f.db.engineKeys.blockNativeFallback('claude', 'anthropic'); f.db.engineKeys.blockNativeFallback('claude', 'zai');
  const result = await f.call({ method: 'engineKeys.activate', body: { workspaceId, id: custom.id } });
  assert.equal(result.status, 200);
  assert.equal(f.db.engineKeys.isNativeFallbackBlocked('claude', 'anthropic'), false);
  assert.equal(f.db.engineKeys.isNativeFallbackBlocked('claude', 'zai'), true);
});

test('deleting unknown Key preserves the native block after DB reopen until explicit self-config', async t => {
  const f = fixture(t);
  const created = await f.call({ method: 'workspaces.upsert', body: { title: 'Keys', path: f.root } }), workspaceId = (created.body as any).workspace.id;
  const key = f.db.engineKeys.insert({ label: 'legacy', engine: 'claude', providerId: 'anthropic', apiKey: 'legacy-private-secret' });
  f.db.db.prepare("UPDATE engine_keys SET source = 'unknown' WHERE id = ?").run(key.id);
  const standby = f.db.engineKeys.insert({ label: 'standby', engine: 'claude', providerId: 'anthropic', apiKey: 'standby-secret' });
  const result = await f.call({ method: 'engineKeys.delete', body: { workspaceId, id: key.id } });
  assert.equal(result.status, 200);
  assert.equal(f.db.engineKeys.get(standby.id)?.isActive, false);
  const second = openClientDb({ dbPath: path.join(f.directory, 'client.db') });
  try {
    const restarted = createBuiltInRelayCredentialService({ repo: second.engineKeys, getOwner: () => null, assertOwner() {}, requestEnsure: async () => { throw new Error('must not contact Server'); } });
    assert.equal(restarted.isScopeBlocked('claude', 'anthropic'), true);
    assert.throws(() => restarted.acquire({ engine: 'claude', providerId: 'anthropic' }), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
    assert.equal((await f.call({ method: 'engineKeys.activate', body: { workspaceId, id: standby.id } })).status, 200);
    assert.equal(restarted.isScopeBlocked('claude', 'anthropic'), false);
    assert.equal(restarted.acquire({ engine: 'claude', providerId: 'anthropic' }).config?.apiKey, 'standby-secret');
  } finally { second.close(); }
});

/** 预置本机和共享历史，读取必须沿真实仓储执行且不依赖资产就绪。 */
async function historyFixture(t: test.TestContext) {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { workspaceId: "history", title: "History", path: f.root } });
  assert.equal(created.status, 200);
  const workspaceId = (created.body as any).workspace.id as WorkspaceId;
  const threadId = "history-local" as ThreadId;
  const sharedThreadId = "history-shared" as ThreadId;
  const sharedWorkspaceId = "shared-history" as SharedWorkspaceId;
  f.db = f.db.forWorkspace(workspaceId);
  f.db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Alpha local", prefs: { model: "gpt-5.5", effort: "high" } });
  f.db.threads.create({ id: sharedThreadId, workspaceId, engine: "codex", title: "Ahead shared", prefs: { model: "gpt-5.6-terra", effort: "low" }, sharedAcl: { sharedWorkspaceId, ownerUserId: "cloud-user" } });
  f.db.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(100, threadId);
  f.db.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(1000, sharedThreadId);
  for (let seq = 1; seq <= 6; seq += 2) {
    f.db.conversationEvents.appendEnvelope({ schema: 1, seq, ts: 100 + seq, workspaceId, threadId, engine: "codex", type: "thread.started", payload: {} });
    f.db.rawEvents.appendEnvelope({ schema: 1, seq: seq + 1, ts: 100 + seq, workspaceId, threadId, engine: "codex", source: "desktop-history-test", data: { seq }, handled: true, action: "mapped", emittedTypes: ["thread.started"] });
  }
  return { ...f, workspaceId, threadId, sharedThreadId, sharedWorkspaceId };
}

test("desktop RA history and paged lists require persisted known local scope while remote lists stay unchanged", async t => {
  const f = fixture(t);
  const workspaceId = "local-client:requirements" as WorkspaceId;
  f.db.workspaces.upsert({ id: workspaceId, title: "Requirements", path: f.root });
  f.ctx.workspaces.set(workspaceId, f.root);
  f.db = f.db.forWorkspace(workspaceId);
  const ids = ["shared-ra", "local-ra-first", "unknown-ra", "local-ra-last", "missing-ra"];
  for (const [index, id] of ids.entries()) {
    f.db.threads.create({ id: id as ThreadId, workspaceId, engine: "codex", title: `${index}-requirement`, threadSubtype: "requirement-analysis" });
    if (id !== "missing-ra") f.db.orchRequirementAnalysisSessions.create({
      id: id as any, workspaceId, title: id, status: "active", phase: "discover", engine: "codex", runtimeThreadId: id as ThreadId,
      workspaceScope: id === "unknown-ra" ? null : id === "shared-ra"
        ? { scopeType: "shared_workspace", scopeId: "shared" } : { scopeType: "local_workspace", scopeId: workspaceId },
    });
  }
  const before = f.db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions ORDER BY id").all();
  for (const id of ids) {
    for (const method of ["threads.load", "threads.events", "threads.summary", "threads.prefs"] as const) {
      const response = await f.call({ method, body: { workspaceId, threadId: id } });
      assert.equal(response.status, id.startsWith("local-") ? 200 : 404, `${method}: ${id}`);
    }
  }
  const first = await f.call({ method: "threads.list", body: { workspaceId, scope: "orchestration", sort: "title_asc", search: "requirement", limit: 1 } });
  assert.equal(first.status, 200);
  assert.deepEqual((first.body as any).threads.map((item: any) => item.id), ["local-ra-first"]);
  assert.equal((first.body as any).hasMore, true);
  const last = await f.call({ method: "threads.list", body: { workspaceId, scope: "orchestration", sort: "title_asc", search: "requirement", limit: 1, cursor: (first.body as any).nextCursor } });
  assert.deepEqual((last.body as any).threads.map((item: any) => item.id), ["local-ra-last"]);
  assert.equal((last.body as any).hasMore, false);
  assert.equal((last.body as any).nextCursor, null);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions ORDER BY id").all(), before);
  f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = '{broken' WHERE id = 'shared-ra'").run();
  f.sent.length = 0;
  handleThreadsList({ ...f.ctx, db: f.db }, { t: "api.req", id: "remote-ra-list", method: "threads.list", path: "/threads.list", body: { workspaceId, scope: "orchestration", sort: "title_asc" } });
  const remote = f.sent.find(message => message.t === "api.res") as any;
  assert.equal(remote.status, 200);
  assert.deepEqual(remote.body.threads.map((item: any) => item.id), ids);
});

test("desktop RA corrupt list fails once with safe identities and unrelated reads remain available", async t => {
  const f = fixture(t);
  const workspaceId = "local-client:broken-requirement" as WorkspaceId;
  f.db.workspaces.upsert({ id: workspaceId, title: "Broken", path: f.root });
  f.ctx.workspaces.set(workspaceId, f.root);
  f.db = f.db.forWorkspace(workspaceId);
  const threadId = "broken-ra" as ThreadId;
  f.db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Broken", threadSubtype: "requirement-analysis" });
  f.db.orchRequirementAnalysisSessions.create({ id: threadId as any, workspaceId, title: "Broken", status: "active", phase: "discover", engine: "codex", runtimeThreadId: threadId });
  const secret = "PRIVATE_DESKTOP_RA_BODY";
  f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = ?").run(`{${secret}`, threadId);
  const logs: any[][] = [];
  const error = f.db.writeWorkspaceLog;
  f.db.writeWorkspaceLog = (_workspaceId, entry) => { logs.push([entry.tag, entry.message, entry.data]); };
  let response;
  try { response = await f.call({ method: "threads.list", body: { workspaceId, scope: "orchestration" } }); }
  finally { f.db.writeWorkspaceLog = error; }
  assert.equal(response.status, 500);
  assert.equal((response.body as any).ok, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![2].errorCode, "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID");
  assert.equal(logs[0]![2].requestId, "request-1");
  assert.equal(logs[0]![2].sessionId, threadId);
  assert.equal(logs[0]![2].workspaceId, workspaceId);
  assert.doesNotMatch(JSON.stringify({ logs, response }), new RegExp(secret));
  logs.length = 0;
  f.db.writeWorkspaceLog = (_workspaceId, entry) => { logs.push([entry.tag, entry.message, entry.data]); };
  let loaded;
  try { loaded = await f.call({ method: "threads.load", body: { workspaceId, threadId } }); }
  finally { f.db.writeWorkspaceLog = error; }
  assert.equal(loaded.status, 500);
  assert.equal((loaded.body as any).code, "INTERNAL_ERROR");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]![2].errorCode, "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID");
  assert.equal(logs[0]![2].sessionId, threadId);
  assert.equal((f.db.db.prepare("SELECT workspace_scope_json FROM orch_requirement_analysis_sessions WHERE id = ?").get(threadId) as any).workspace_scope_json, `{${secret}`);
  assert.equal((await f.call({ method: "workspaces.list" })).status, 200);
});

/** 真实实例保存当前、讨论和历史节点归属，覆盖终态及多个父实例的交集。 */
async function nodeHistoryFixture(t: test.TestContext) {
  const f = fixture(t);
  const workspaceId = "local-client:nodes" as WorkspaceId;
  f.db.workspaces.upsert({ id: workspaceId, title: "Nodes", path: f.root });
  f.ctx.workspaces.set(workspaceId, f.root);
  f.db = f.db.forWorkspace(workspaceId);
  const workflow = f.db.orchWorkflows.upsert({ id: "", workspaceId, name: "History", description: "History", version: 1,
    nodes: [{ id: "start", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [] });
  let seq = 0;
  /** 节点线程故意不投影共享字段；读取必须依赖父实例而非单一 thread 列。 */
  function thread(id: string, title: string, subtype: "node" | "node-discussion" | null): ThreadId {
    const threadId = id as ThreadId;
    f.db.threads.create({ id: threadId, workspaceId, engine: "codex", title,
      threadType: subtype === "node" ? "orchestration" : "chat", threadSubtype: subtype });
    f.db.conversationEvents.appendEnvelope({ schema: 1, seq: ++seq, ts: 1, workspaceId, threadId, engine: "codex", type: "thread.started", payload: {} });
    f.db.rawEvents.appendEnvelope({ schema: 1, seq: ++seq, ts: 1, workspaceId, threadId, engine: "codex", source: "node-history-test", data: {}, handled: true, action: "mapped", emittedTypes: [] });
    return threadId;
  }
  /** 使用原仓储生成有效父实例，保留两种共享身份及已结束实例的事实。 */
  function parent(threadId: ThreadId, field: "threadId" | "discussionThreadId" | "previousThreadIds", shared: boolean, terminal: boolean, profile = false): void {
    const instance = f.db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
      intakeSnapshot: { id: `intake-${threadId}-${seq++}`, workspaceId, triggerMode: "manual", taskType: "feature", title: "History", goal: "History", createdAt: 1, updatedAt: 1,
        workspaceScope: { scopeType: shared ? "shared_workspace" : "local_workspace", scopeId: shared ? "shared-parent" : workspaceId },
        ...(shared && !profile ? { sharedContext: { sharedWorkspaceId: "shared-parent" } } : {}) } as any,
      ...(profile ? { runtimeConfig: { executionProfileScope: { scopeType: "shared_workspace", scopeId: "shared-parent" } } as any } : {}) });
    const state = { ...instance.nodeStates.start!, [field]: field === "previousThreadIds" ? [threadId] : threadId };
    f.db.orchInstances.updateNodeStates(instance.id, { start: state });
    if (terminal) f.db.orchInstances.updateStatus(instance.id, "completed");
  }
  const allowed: ThreadId[] = [], blocked: ThreadId[] = [];
  for (const field of ["threadId", "discussionThreadId", "previousThreadIds"] as const) {
    for (const terminal of [false, true]) {
      const subtype = field === "discussionThreadId" ? "node-discussion" : "node";
      const id = thread(`local-${field}-${terminal}`, `M-${allowed.length}`, subtype);
      parent(id, field, false, terminal); allowed.push(id);
      const shared = thread(`shared-${field}-${terminal}`, `A-${blocked.length}`, subtype);
      parent(shared, field, true, terminal); blocked.push(shared);
    }
  }
  const orphan = thread("orphan-node", "Z-orphan", "node"); blocked.push(orphan);
  const mixed = thread("mixed-node", "L-mixed", "node");
  parent(mixed, "threadId", false, false); parent(mixed, "previousThreadIds", true, true); blocked.push(mixed);
  const profile = thread("shared-profile-discussion", "Z-profile", "node-discussion");
  parent(profile, "discussionThreadId", true, true, true); blocked.push(profile);
  const multipleLocal = thread("multiple-local-node", "M-6", "node");
  parent(multipleLocal, "threadId", false, true); parent(multipleLocal, "previousThreadIds", false, false); allowed.push(multipleLocal);
  const ordinary = thread("ordinary-local-chat", "M-7", null);
  return { ...f, workspaceId, allowed, blocked, ordinary };
}

test("desktop history requires every node parent to be local, including completed and previous bindings", async t => {
  const f = await nodeHistoryFixture(t);
  for (const threadId of [...f.allowed, ...f.blocked]) {
    const permitted = f.allowed.includes(threadId);
    assert.equal(isDesktopLocalThreadAssetExecution(f.ctx.clientId, f.ctx.workspaces, f.db, threadId), permitted, threadId);
    for (const method of ["threads.load", "threads.events", "threads.summary", "threads.prefs", "threads.latestPrefs"] as const) {
      const response = await f.call({ method, body: { workspaceId: f.workspaceId, threadId, ...(method === "threads.latestPrefs" ? { engine: "codex" } : {}) } });
      assert.equal(response.status, permitted ? 200 : 404, `${method}: ${threadId}: ${JSON.stringify(response.body)}`);
    }
  }
});

test("desktop filters unprojected shared and orphan nodes in SQL before pagination without changing remote lists", async t => {
  const f = await nodeHistoryFixture(t);
  for (const scope of ["all", "orchestration"] as const) {
    const expected = scope === "all" ? [...f.allowed, f.ordinary] : f.allowed;
    let cursor: string | null = null;
    const received: string[] = [];
    do {
      const response = await f.call({ method: "threads.list", body: { workspaceId: f.workspaceId, scope, sort: "title_asc", limit: 2, ...(cursor ? { cursor } : {}) } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const page = response.body as { threads: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
      assert.deepEqual(page.threads.map(item => item.id), expected.slice(received.length, received.length + 2));
      received.push(...page.threads.map(item => item.id));
      assert.equal(page.hasMore, received.length < expected.length);
      assert.equal(Boolean(page.nextCursor), page.hasMore);
      assert.notEqual(page.nextCursor, cursor, "游标必须推进，结束页由 hasMore=false 退出");
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(received, expected);
  }
  const withoutAuthority = f.db.threads.listByWorkspace(f.workspaceId, { localOnly: true, scope: "all" });
  assert.deepEqual(withoutAuthority.threads.map(item => item.id), [f.ordinary], "本机列表缺少可信节点集合时拒绝全部节点");
  f.sent.length = 0;
  handleThreadsList({ ...f.ctx, db: f.db }, { t: "api.req", id: "remote-list", method: "threads.list", path: "/threads", body: { workspaceId: f.workspaceId, scope: "orchestration", sort: "title_asc" } });
  const remote = f.sent.find(message => message.t === "api.res") as Extract<ClientToServerMessage, { t: "api.res" }>;
  assert.equal(remote.status, 200);
  assert.deepEqual(new Set((remote.body as any).threads.map((item: any) => item.id)), new Set([...f.allowed, ...f.blocked]));
});

test("desktop rejects corrupt parent scope JSON before authorizing node history", async t => {
  const f = await nodeHistoryFixture(t);
  const threadId = "shared-threadId-false" as ThreadId;
  const instance = f.db.orchInstances.listByWorkspace(f.workspaceId).find(item => item.nodeStates.start?.threadId === threadId)!;
  const row = f.db.db.prepare("SELECT intake_snapshot_json, runtime_config_json FROM orch_instances WHERE id = ?").get(instance.id) as Record<string, string | null>;
  const cases = [
    ["intake_snapshot_json", '"broken"'],
    ...[null, [], 1, true, { ...instance.intakeSnapshot, sharedContext: "broken" },
      { ...instance.intakeSnapshot, sharedContext: [] }, { ...instance.intakeSnapshot, sharedContext: {} },
      { ...instance.intakeSnapshot, sharedContext: { sharedWorkspaceId: 7 } }].map(value => ["intake_snapshot_json", JSON.stringify(value)]),
    ["runtime_config_json", "{broken"],
    ...["broken", [], 1, true, { executionProfileScope: "broken" }, { executionProfileScope: [] },
      { executionProfileScope: {} }, { executionProfileScope: { scopeType: "unknown", scopeId: "shared-parent" } },
      { executionProfileScope: { scopeType: "shared_workspace", scopeId: 7 } }].map(value => ["runtime_config_json", JSON.stringify(value)]),
  ];
  for (const [column, value] of cases) {
    f.db.db.prepare(`UPDATE orch_instances SET ${column} = ? WHERE id = ?`).run(value, instance.id);
    assert.throws(() => isDesktopLocalThreadAssetExecution(f.ctx.clientId, f.ctx.workspaces, f.db, threadId),
      (error: Error) => error.message.includes(instance.id) && error.message.includes(column!), `${column}: ${value}`);
    for (const method of ["threads.load", "threads.events", "threads.summary", "threads.prefs", "threads.latestPrefs"] as const) {
      const logs: any[][] = [], originalError = f.db.writeWorkspaceLog;
      f.db.writeWorkspaceLog = (_workspaceId, entry) => { logs.push([entry.tag, entry.message, entry.data]); };
      let response;
      try { response = await f.call({ method, body: { workspaceId: f.workspaceId, threadId,
        ...(method === "threads.latestPrefs" ? { engine: "codex" } : {}) } }); }
      finally { f.db.writeWorkspaceLog = originalError; }
      assert.equal(response.status, 500);
      assert.equal((response.body as any).code, "INTERNAL_ERROR");
      assert.equal(logs.length, 1);
      assert.equal(logs[0]![2].instanceId, instance.id);
      assert.equal(logs[0]![2].errorCode, "ORCH_INSTANCE_SCOPE_INVALID");
      assert.equal((f.db.db.prepare(`SELECT ${column} AS value FROM orch_instances WHERE id = ?`).get(instance.id) as any).value, value);
    }
    const listed = await f.call({ method: "threads.list", body: { workspaceId: f.workspaceId, scope: "orchestration" } });
    assert.equal(listed.status, 500, `${column}: ${value}`);
    assert.equal((listed.body as any).ok, false);
    assert.match((listed.body as any).message, new RegExp(instance.id));
    f.db.db.prepare(`UPDATE orch_instances SET ${column} = ? WHERE id = ?`).run(row[column!], instance.id);
  }
  assert.equal((await f.call({ method: "threads.load", body: { workspaceId: f.workspaceId, threadId: f.allowed[0] } })).status, 200);
  assert.equal((await f.call({ method: "workspaces.list" })).status, 200);
});

test("desktop never drops a corrupt shared parent when another parent is local", async t => {
  const f = await nodeHistoryFixture(t);
  const threadId = "mixed-node" as ThreadId;
  const instance = f.db.orchInstances.listByWorkspace(f.workspaceId).find(item => item.nodeStates.start?.previousThreadIds?.includes(threadId))!;
  const original = JSON.stringify(instance.nodeStates);
  for (const raw of ["{broken", ...[null, "broken", [], 1, true, { start: null }, { start: [] }, { start: "broken" },
    { start: { threadId: 7 } }, { start: { discussionThreadId: [] } }, { start: { previousThreadIds: threadId } },
    { start: { previousThreadIds: [threadId, 7] } }].map(value => JSON.stringify(value))]) {
    f.db.db.prepare("UPDATE orch_instances SET node_states_json = ? WHERE id = ?").run(raw, instance.id);
    assert.throws(() => isDesktopLocalThreadAssetExecution(f.ctx.clientId, f.ctx.workspaces, f.db, threadId),
      (error: Error) => error.message.includes(instance.id) && error.message.includes("node_states_json"), raw);
    const logs: any[][] = [], originalError = f.db.writeWorkspaceLog;
    f.db.writeWorkspaceLog = (_workspaceId, entry) => { logs.push([entry.tag, entry.message, entry.data]); };
    let loaded;
    try { loaded = await f.call({ method: "threads.load", body: { workspaceId: f.workspaceId, threadId } }); }
    finally { f.db.writeWorkspaceLog = originalError; }
    assert.equal(loaded.status, 500);
    assert.equal((loaded.body as any).code, "INTERNAL_ERROR");
    assert.equal(logs.length, 1);
    assert.equal(logs[0]![2].instanceId, instance.id);
    assert.equal(logs[0]![2].errorCode, "ORCH_INSTANCE_SCOPE_INVALID");
    assert.equal((f.db.db.prepare("SELECT node_states_json FROM orch_instances WHERE id = ?").get(instance.id) as any).node_states_json, raw);
    const listed = await f.call({ method: "threads.list", body: { workspaceId: f.workspaceId, scope: "orchestration" } });
    assert.equal(listed.status, 500, raw);
    assert.equal((listed.body as any).ok, false);
    f.db.db.prepare("UPDATE orch_instances SET node_states_json = ? WHERE id = ?").run(original, instance.id);
  }
  assert.equal(isDesktopLocalThreadAssetExecution(f.ctx.clientId, f.ctx.workspaces, f.db, threadId), false);
});

test("desktop strict parent scope accepts legacy optional fields and empty node bindings", async t => {
  const f = await nodeHistoryFixture(t);
  const threadId = f.allowed[0]!;
  const instance = f.db.orchInstances.listByWorkspace(f.workspaceId).find(item => item.nodeStates.start?.threadId === threadId)!;
  for (const runtimeConfig of [null, "null", "{}", '{"executionProfileScope":null}', JSON.stringify({ executionProfileScope: { scopeType: "local_workspace", scopeId: f.workspaceId } })]) {
    f.db.db.prepare("UPDATE orch_instances SET runtime_config_json = ?, intake_snapshot_json = ?, node_states_json = ? WHERE id = ?")
      .run(runtimeConfig, JSON.stringify({ ...instance.intakeSnapshot, sharedContext: null }),
        JSON.stringify({ start: { ...instance.nodeStates.start, threadId, discussionThreadId: null, previousThreadIds: null }, empty: {} }), instance.id);
    assert.equal(isDesktopLocalThreadAssetExecution(f.ctx.clientId, f.ctx.workspaces, f.db, threadId), true);
    assert.equal((await f.call({ method: "threads.load", body: { workspaceId: f.workspaceId, threadId } })).status, 200);
  }
});

test("desktop reads persisted local history, summaries and prefs without Server assets", async (t) => {
  const f = await historyFixture(t);
  const body = { workspaceId: f.workspaceId, threadId: f.threadId };
  const loaded = await f.call({ method: "threads.load", body: { ...body, limit: 2 } });
  assert.equal(loaded.status, 200);
  assert.deepEqual((loaded.body as any).events.map((event: any) => event.seq), [3, 5]);
  assert.deepEqual([(loaded.body as any).hasMore, (loaded.body as any).oldestSeq, (loaded.body as any).latestSeq], [true, 3, 5]);
  const earlier = await f.call({ method: "threads.load", body: { ...body, limit: 2, beforeSeq: 3 } });
  assert.equal(earlier.status, 200);
  assert.deepEqual((earlier.body as any).events.map((event: any) => event.seq), [1]);
  assert.equal((earlier.body as any).hasMore, false);
  const raw = await f.call({ method: "threads.events", body: { ...body, limit: 2 } });
  assert.equal(raw.status, 200);
  assert.deepEqual((raw.body as any).events.map((event: any) => event.seq), [6, 4]);
  assert.equal((raw.body as any).nextBeforeSeq, 4);
  const olderRaw = await f.call({ method: "threads.events", body: { ...body, beforeSeq: 4, limit: 2 } });
  assert.deepEqual((olderRaw.body as any).events.map((event: any) => event.seq), [2]);
  const summary = await f.call({ method: "threads.summary", body });
  assert.equal(summary.status, 200);
  assert.equal((summary.body as any).thread.id, f.threadId);
  const prefs = await f.call({ method: "threads.prefs", body });
  assert.equal(prefs.status, 200);
  assert.equal((prefs.body as any).prefs.model, "gpt-5.5");
  const latestPrefs = await f.call({ method: "threads.latestPrefs", body: { workspaceId: f.workspaceId, engine: "codex", threadId: f.threadId } });
  assert.equal(latestPrefs.status, 200, JSON.stringify(latestPrefs.body));
  assert.equal((latestPrefs.body as any).prefs.model, "gpt-5.5");
  assert.deepEqual(f.sent, []);
});

test("desktop filters shared threads before pagination and preserves list filters and local groups", async (t) => {
  const f = await historyFixture(t);
  const secondId = "history-second" as ThreadId;
  f.db.threads.create({ id: secondId, workspaceId: f.workspaceId, engine: "codex", title: "Zulu local" });
  const group = f.db.threads.createGroup({ workspaceId: f.workspaceId, name: "本地分组" });
  f.db.threads.setThreadGroup({ workspaceId: f.workspaceId, threadId: f.threadId, groupId: group.id });
  f.db.threads.createGroup({ workspaceId: f.workspaceId, sharedWorkspaceId: f.sharedWorkspaceId, createdByUserId: "cloud-user", name: "共享分组" });
  const first = await f.call({ method: "threads.list", body: { workspaceId: f.workspaceId, scope: "current", sort: "title_asc", limit: 1 } });
  assert.equal(first.status, 200);
  assert.deepEqual((first.body as any).threads.map((thread: any) => thread.id), [f.threadId]);
  assert.equal((first.body as any).hasMore, true);
  const second = await f.call({ method: "threads.list", body: { workspaceId: f.workspaceId, scope: "current", sort: "title_asc", limit: 1, cursor: (first.body as any).nextCursor } });
  assert.equal(second.status, 200);
  assert.deepEqual((second.body as any).threads.map((thread: any) => thread.id), [secondId]);
  assert.equal((second.body as any).hasMore, false);
  const filtered = await f.call({ method: "threads.list", body: { workspaceId: f.workspaceId, scope: "all", sort: "title_desc", search: "Alpha", groupId: group.id } });
  assert.equal(filtered.status, 200);
  assert.deepEqual((filtered.body as any).threads.map((thread: any) => thread.id), [f.threadId]);
  const groups = await f.call({ method: "threads.groups.list", body: { workspaceId: f.workspaceId } });
  assert.equal(groups.status, 200);
  assert.deepEqual((groups.body as any).groups.map((item: any) => item.id), [group.id]);
});

test("desktop history rejects alias, foreign and shared identities and renderer-controlled scope", async (t) => {
  const f = await historyFixture(t);
  const methods = ["threads.list", "threads.load", "threads.events", "threads.summary", "threads.prefs", "threads.latestPrefs", "threads.groups.list"] as const;
  for (const method of methods) {
    const body = method === "threads.latestPrefs" ? { workspaceId: f.workspaceId, engine: "codex" }
      : ["threads.list", "threads.groups.list"].includes(method) ? { workspaceId: f.workspaceId } : { workspaceId: f.workspaceId, threadId: f.threadId };
    for (const workspaceId of ["history", "foreign:history", "shared:history", "local-client:missing"]) {
      const result = await f.call({ method, body: { ...body, workspaceId } });
      assert.ok(result.status === 400 || result.status === 404, `${method} must reject ${workspaceId}`);
    }
    for (const forged of [{ actorUserId: "cloud-user" }, { actorIsAdmin: true }, { sharedWorkspaceId: f.sharedWorkspaceId }, { localWorkspaceOnly: false }]) {
      assert.equal((await f.call({ method, body: { ...body, ...forged } })).status, 400);
    }
    if (!["threads.list", "threads.groups.list"].includes(method)) {
      assert.equal((await f.call({ method, body: { ...body, threadId: f.sharedThreadId } })).status, 404);
      const otherId = "local-client:other" as WorkspaceId;
      f.db.workspaces.upsert({ id: otherId, title: "Other", path: f.root });
      f.ctx.workspaces.set(otherId, f.root);
      assert.equal((await f.call({ method, body: { ...body, workspaceId: otherId, threadId: f.threadId } })).status, 404);
    }
  }
  for (const body of [{ limit: "2" }, { limit: 1.5 }, { beforeSeq: "3" }, { beforeSeq: Number.NaN }]) {
    assert.equal((await f.call({ method: "threads.events", body: { workspaceId: f.workspaceId, threadId: f.threadId, ...body } })).status, 400);
  }
  for (const body of [{ scope: "invalid" }, { sort: "invalid" }, { cursor: 3 }, { groupId: [] }, { includeArchived: "false" }, { onlyRelatedToMe: "false" }]) {
    assert.equal((await f.call({ method: "threads.list", body: { workspaceId: f.workspaceId, ...body } })).status, 400);
  }
  assert.equal((await f.call({ method: "threads.latestPrefs", body: { workspaceId: f.workspaceId, engine: "unknown" } })).status, 400);
  for (const method of ["threads.create", "threads.sendMessage"]) {
    assert.equal((await f.call({ method, body: { workspaceId: f.workspaceId, threadId: f.threadId } } as unknown as DesktopApiRequest)).status, 400);
  }
});

test("desktop history reports corrupt canonical and raw records as failures and remains usable", async (t) => {
  const f = await historyFixture(t);
  const body = { workspaceId: f.workspaceId, threadId: f.threadId };
  f.db.db.prepare("UPDATE conversation_events SET event_json = ? WHERE thread_id = ? AND seq = 5").run("{broken", f.threadId);
  const loaded = await f.call({ method: "threads.load", body });
  assert.equal(loaded.status, 500);
  assert.equal((loaded.body as any).ok, false);
  f.db.db.prepare("UPDATE raw_engine_events SET event_json = ? WHERE thread_id = ? AND seq = 6").run("{broken", f.threadId);
  const raw = await f.call({ method: "threads.events", body });
  assert.equal(raw.status, 500);
  assert.equal((raw.body as any).ok, false);
  assert.match((raw.body as any).message, /history-local.*6|6.*history-local/);
  assert.equal((await f.call({ method: "threads.summary", body })).status, 200);
  assert.equal((await f.call({ method: "workspaces.list" })).status, 200);
});

test("desktop raw history rejects valid JSON with a corrupt envelope or mismatched row identity", async (t) => {
  const f = await historyFixture(t);
  const row = f.db.db.prepare("SELECT event_json FROM raw_engine_events WHERE thread_id = ? AND seq = 6").get(f.threadId) as { event_json: string };
  const original = JSON.parse(row.event_json);
  for (const invalid of [null, {}, [], { ...original, schema: 2 }, { ...original, seq: 7 }, { ...original, threadId: "other-thread" },
    { ...original, workspaceId: "other-client:history" }, { ...original, engine: "claude" }, { ...original, engine: "unknown" },
    { ...original, ts: "bad" }, { ...original, ts: -1 }, { ...original, ts: 1.5 }, { ...original, source: undefined }, { ...original, source: " " },
    { ...original, data: undefined }, { ...original, handled: undefined }, { ...original, action: "unknown" }, { ...original, emittedTypes: null }, { ...original, emittedTypes: [4] }]) {
    f.db.db.prepare("UPDATE raw_engine_events SET event_json = ? WHERE thread_id = ? AND seq = 6").run(JSON.stringify(invalid), f.threadId);
    const response = await f.call({ method: "threads.events", body: { workspaceId: f.workspaceId, threadId: f.threadId } });
    assert.equal(response.status, 500, JSON.stringify(invalid));
    assert.match((response.body as any).message, /history-local.*6/);
  }
});

test("desktop canonical replay rejects a corrupt envelope or mismatched row identity", async (t) => {
  const f = await historyFixture(t);
  const row = f.db.db.prepare("SELECT event_json FROM conversation_events WHERE thread_id = ? AND seq = 5").get(f.threadId) as { event_json: string };
  const original = JSON.parse(row.event_json);
  for (const invalid of [{ ...original, schema: 2 }, { ...original, workspaceId: "other-client:history" }, { ...original, engine: "claude" },
    { ...original, seq: 7 }, { ...original, threadId: "other-thread" }, null, {}, [], { ...original, payload: undefined },
    { ...original, payload: null }, { ...original, payload: [] }, { ...original, type: undefined }, { ...original, type: " " },
    { ...original, ts: "bad" }, { ...original, ts: -1 }, { ...original, ts: 1.5 }]) {
    f.db.db.prepare("UPDATE conversation_events SET event_json = ? WHERE thread_id = ? AND seq = 5").run(JSON.stringify(invalid), f.threadId);
    const response = await f.call({ method: "threads.load", body: { workspaceId: f.workspaceId, threadId: f.threadId } });
    assert.equal(response.status, 500, JSON.stringify(invalid));
    assert.match((response.body as any).message, /history-local.*5/);
  }
});

for (const method of ["threads.load", "threads.events"] as const) {
  test(`${method} rejects event columns and JSON that agree with each other but disagree with the parent thread`, async (t) => {
    const f = await historyFixture(t);
    const table = method === "threads.load" ? "conversation_events" : "raw_engine_events";
    const seq = method === "threads.load" ? 5 : 6;
    const row = f.db.db.prepare(`SELECT event_json FROM ${table} WHERE thread_id = ? AND seq = ?`).get(f.threadId, seq) as { event_json: string };
    const original = JSON.parse(row.event_json);
    for (const scope of [{ workspaceId: "foreign:workspace", engine: "codex" }, { workspaceId: f.workspaceId, engine: "claude" }, { workspaceId: "foreign:workspace", engine: "claude" }]) {
      // 损坏夹具绕过业务 writer 的 TEMP scope trigger，直接篡改本测试物理库。
      const physical = new DatabaseSync(path.join(f.root, ".codeflowai", "workspace.db"));
      try { physical.prepare(`UPDATE ${table} SET workspace_id = ?, engine = ?, event_json = ? WHERE thread_id = ? AND seq = ?`)
        .run(scope.workspaceId, scope.engine, JSON.stringify({ ...original, ...scope }), f.threadId, seq); }
      finally { physical.close(); }
      const response = await f.call({ method, body: { workspaceId: f.workspaceId, threadId: f.threadId } });
      assert.equal(response.status, 500, JSON.stringify(scope));
      assert.equal((response.body as any).ok, false);
      assert.match((response.body as any).message, new RegExp(`history-local.*${seq}`));
      if (method === "threads.load") {
        await assert.rejects(() => f.db.conversationEvents.listByThreadForReplay(f.threadId), (error: Error) => error.cause instanceof Error);
      } else {
        assert.throws(() => f.db.rawEvents.pageByThread(f.threadId), (error: Error) => error.cause instanceof Error);
      }
    }
  });
}

test("desktop raw history logs the owning request context and original decode failure once", async (t) => {
  const f = await historyFixture(t);
  const errors: Array<{ tag: string; data: any }> = [];
  t.mock.method(logger, "error", (tag: string, _message: string, data?: unknown) => { errors.push({ tag, data }); });
  f.db.db.prepare("UPDATE raw_engine_events SET event_json = ? WHERE thread_id = ? AND seq = 6").run("{broken", f.threadId);
  const response = await f.call({ method: "threads.events", body: { workspaceId: f.workspaceId, threadId: f.threadId, beforeSeq: 7, limit: 1 } });
  assert.equal(response.status, 500);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.tag, "api");
  const data = errors[0]!.data;
  assert.equal(data.code, "THREAD_RAW_EVENTS_LOAD_FAILED");
  assert.equal(data.requestId, "request-2");
  assert.equal(data.workspaceId, f.workspaceId);
  assert.equal(data.threadId, f.threadId);
  assert.equal(data.beforeSeq, 7);
  assert.equal(data.limit, 1);
  assert.match(data.rootCause.message, /history-local.*6/);
  assert.match(data.rootCause.cause, /JSON|property|position/i);
});

test("desktop bridge persists workspace CRUD through the existing handler and returns real local ownership", async (t) => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local project", path: f.root } });
  assert.equal(created.status, 200);
  const digest = crypto.createHash("sha256").update(normalizeWorkspacePathForDerivedId(f.root)).digest("hex");
  const id = `local-client:${makeWorkspaceIdFromPathDigest(digest)}` as WorkspaceId;
  assert.equal((created.body as any).workspace.id, id);
  assert.equal(f.db.workspaces.get(id)?.path, f.root);
  assert.equal(f.ctx.workspaces.get(id), f.root);
  const listed = await f.call({ method: "workspaces.list" });
  assert.deepEqual((listed.body as any).workspaces.map((workspace: any) => [workspace.id, workspace.ownerClientId, workspace.kind]), [[id, "local-client", "local"]]);
  const runtime = await f.call({ method: "runtime.info" });
  assert.deepEqual((runtime.body as any).client, { clientId: "local-client", deviceId: null, name: os.hostname(), version: "1.0.0", platform: process.platform, arch: process.arch, connectedAt: f.startedAt, workspaceIds: [id] });
  assert.equal((await f.call({ method: "workspaces.upsert", body: { workspaceId: id, title: "Renamed", path: f.root } })).status, 200);
  assert.equal(f.db.workspaces.get(id)?.title, "Renamed");
  assert.equal((await f.call({ method: "workspaces.delete", body: { workspaceId: id } })).status, 200);
  assert.equal(f.db.workspaces.get(id), null);
  assert.equal(f.ctx.workspaces.has(id), false);
  assert.deepEqual(f.sent, [], "local control responses must not reach the cloud transport");
});

test("desktop bridge fixes profile scope and actor and rejects renderer identities", async (t) => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  const updated = await f.call({ method: "workspaceExecutionProfile.update", body: { workspaceId, profileText: "Use local tools" } });
  assert.equal(updated.status, 200);
  const profile = (updated.body as any).profile;
  assert.equal(profile.userId, "local:local-client");
  assert.deepEqual(profile.scope, { scopeType: "local_workspace", scopeId: workspaceId });
  assert.equal((await f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId } })).status, 200);
  assert.equal((await f.call({ method: "workspaceExecutionProfile.status", body: { workspaceId } })).status, 200);
  for (const forged of [{ userId: "cloud-user" }, { userIds: ["cloud-user"] }, { profileScopeType: "shared_workspace" }, { profileScopeId: "shared-id" }, { sharedWorkspaceId: "shared-id" }]) {
    const response = await f.call({ method: "workspaceExecutionProfile.update", body: { workspaceId, profileText: "forged", ...forged } });
    assert.equal(response.status, 400);
  }
  assert.equal(f.db.withWorkspaceExecutionProfiles(workspaceId, repo => repo.get({ scopeType: "local_workspace", scopeId: workspaceId }, "local:local-client"))?.profileText, "Use local tools");
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS count FROM workspace_execution_profiles").get() as { count: number }).count, 0);
});

test("desktop bridge refuses shared, foreign and unhosted workspaces while allowing removal of a missing root", async (t) => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const ownId = (created.body as any).workspace.id;
  for (const workspaceId of ["shared:workspace", "other-client:workspace", `other-client:${ownId}`, "local-client:missing"]) {
    const response = await f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId } });
    assert.ok(response.status === 400 || response.status === 404);
  }
  for (const workspaceId of ["shared:workspace", "other-client:workspace", "local-client:foreign:nested"]) {
    assert.equal((await f.call({ method: "workspaces.upsert", body: { workspaceId, title: "forged", path: f.root } })).status, 400);
  }
  f.ctx.workspaces.delete(ownId);
  assert.equal((await f.call({ method: "workspaces.delete", body: { workspaceId: ownId } })).status, 404);
  f.ctx.workspaces.set(ownId, f.root);
  fs.rmdirSync(f.root);
  await assert.rejects(f.call({ method: "workspaceExecutionProfile.get", body: { workspaceId: ownId } }), error => error instanceof AggregateError && error.errors.length === 2);
  assert.equal((await f.call({ method: "workspaces.delete", body: { workspaceId: ownId } })).status, 200);
  assert.equal(f.db.workspaces.get(ownId), null);
});

test("desktop bridge validates method fields and uses actual filesystem directory listing", async (t) => {
  const f = fixture(t);
  assert.equal((await f.call({ method: "clientFs.directoryTree", body: { dirPath: f.directory, showHidden: false } })).status, 200);
  const roots = await f.call({ method: "clientFs.directoryTree", body: { dirPath: null, showHidden: null, depth: 1 } });
  assert.equal(roots.status, 200);
  assert.ok(Array.isArray((roots.body as any).nodes));
  for (const request of [
    { method: "runtime.info", body: { userId: "forged" } },
    { method: "workspaces.list", body: { clientId: "foreign" } },
    { method: "workspaces.upsert", body: { title: 123, path: f.root } },
    { method: "clientFs.directoryTree", body: { dirPath: f.root, showHidden: "false" } },
    { method: "clientFs.directoryTree", body: { dirPath: f.root, depth: "1" } },
    { method: "workspaces.list", body: [] },
  ]) assert.equal((await f.call(request as DesktopApiRequest)).status, 400);
  assert.equal((await f.call({ method: "engines.config.get" } as unknown as DesktopApiRequest)).status, 404);
  await assert.rejects(() => executeDesktopApiRequest(f.ctx, { method: "runtime.info" }, { requestId: "no-version", clientVersion: null, startedAt: f.startedAt }), /DESKTOP_CLIENT_VERSION_REQUIRED/);
});

test("desktop bridge enforces one matching response and forwards non-control messages", async (t) => {
  const f = fixture(t);
  const telemetry = { t: "client.workspacesChanged", workspaceIds: [] } as ClientToServerMessage;
  f.ctx.takeApiResponseDispatch = function (this: ApiHandlerContext) { this.send(telemetry); return null; };
  assert.equal((await f.call({ method: "workspaces.list" })).status, 200);
  assert.deepEqual(f.sent, [telemetry]);
  f.ctx.takeApiResponseDispatch = function (this: ApiHandlerContext) { this.send({ t: "api.res", id: "wrong-id", status: 200, body: {} }); return null; };
  await assert.rejects(() => f.call({ method: "workspaces.list" }), /DESKTOP_API_RESPONSE_INVALID/);
  let attempts = 0;
  const dispatchFailure = new Error("response dispatch failed");
  f.ctx.takeApiResponseDispatch = () => { if (attempts++ === 0) throw dispatchFailure; return null; };
  await assert.rejects(() => f.call({ method: "workspaces.list" }), error => {
    assert.ok(isWorkspaceApiRequestFailure(error));
    assert.equal(error.cause, dispatchFailure);
    const details = getWorkspaceApiRequestFailureDetails(error)!;
    assert.equal(details.responseAttempted, true);
    assert.equal(details.responseDelivered, true);
    return true;
  });
  assert.equal(attempts, 1);
});

test("desktop assets use the existing five local repositories without cloud control responses", async (t) => {
  const f = fixture(t);
  initializeLocalEngineModelCatalog();
  t.after(resetEngineModelCatalogRuntimeForTest);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  const cases = [
    ["roles", "role", "roleId", "roles", { name: "角色", systemPrompt: "Local only", executionConfig: createDefaultRoleExecutionConfig("codex") }],
    ["workflows", "workflow", "workflowId", "workflows", { name: "流程", nodes: [], edges: [] }],
    ["knowledgeBundles", "bundle", "bundleId", "bundles", { name: "知识", scope: "role", sourceRefs: [], content: "Local knowledge" }],
    ["toolsets", "toolset", "toolsetId", "toolsets", { name: "工具", tools: [] }],
    ["skills", "skill", "skillId", "skills", { name: "技能", skillMd: "# Local skill", targetEngines: ["codex"] }],
  ] as const;
  for (const [type, field, idField, listField, definition] of cases) {
    const upsert = `orch.${type}.upsert` as DesktopApiRequest["method"];
    const response = await f.call({ method: upsert, body: { workspaceId, [field]: { ...definition, id: "" } } });
    assert.equal(response.status, 200, `${type}: ${JSON.stringify(response.body)}`);
    const asset = (response.body as any)[field];
    assert.equal(asset.workspaceId, workspaceId);
    assert.equal(asset.kind, "custom");
    const listed = await f.call({ method: `orch.${type}.list` as DesktopApiRequest["method"], body: { workspaceId } });
    assert.equal(listed.status, 200);
    assert.deepEqual((listed.body as any)[listField].map((item: any) => item.id), [asset.id]);
    const updated = await f.call({ method: upsert, body: { workspaceId, [field]: { ...asset, name: "已修改" } } });
    assert.equal(updated.status, 200);
    assert.equal((updated.body as any)[field].name, "已修改");
    assert.equal((await f.call({ method: `orch.${type}.delete` as DesktopApiRequest["method"], body: { workspaceId, [idField]: asset.id } })).status, 200);
    assert.deepEqual((await f.call({ method: `orch.${type}.list` as DesktopApiRequest["method"], body: { workspaceId } })).body, { ok: true, [listField]: [] });
  }
  assert.deepEqual(f.sent, [], "personal asset mutations must not upload to Server");
});

test("desktop asset boundary rejects foreign scope, malformed definitions and builtin write authority", async (t) => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  f.db = f.db.forWorkspace(workspaceId);
  const builtin = f.db.orchToolsets.upsert({ id: "builtin-tools", workspaceId, name: "内置", kind: "builtin", tools: [] } as any);
  const foreignPath = path.join(f.directory, "foreign");
  fs.mkdirSync(foreignPath);
  f.db.workspaces.upsert({ id: "foreign:project" as WorkspaceId, title: "Foreign", path: foreignPath });
  const foreignDb = f.db.forWorkspace("foreign:project");
  const foreign = foreignDb.orchToolsets.upsert({ id: "foreign-tools", workspaceId: "foreign:project", name: "Foreign", tools: [] } as any);
  const call = (body: Record<string, unknown>) => f.call({ method: "orch.toolsets.upsert" as DesktopApiRequest["method"], body });
  for (const forged of [{ allowBuiltinAssetUpdate: true }, { actorUserId: "cloud-user" }, { sharedWorkspaceId: "shared" }, { userId: "cloud-user" }]) {
    assert.equal((await call({ workspaceId, toolset: { ...builtin, name: "changed" }, ...forged })).status, 400);
  }
  for (const toolset of [[], null, "invalid", { id: 12 }, { ...foreign }, { ...builtin, kind: "custom" }, { name: "伪造内置", kind: "builtin" },
    { name: "Foreign nested", workspaceId: "foreign:project" }]) {
    const response = await call({ workspaceId, toolset });
    assert.ok(response.status === 400 || response.status === 403 || response.status === 404, JSON.stringify(toolset));
  }
  for (const id of [builtin.id, foreign.id]) {
    const result = await f.call({ method: "orch.toolsets.delete" as DesktopApiRequest["method"], body: { workspaceId, toolsetId: id } });
    assert.ok(result.status === 403 || result.status === 404, JSON.stringify(result));
  }
  assert.equal(f.db.orchToolsets.get(builtin.id)?.name, "内置");
  assert.equal(foreignDb.orchToolsets.get(foreign.id)?.name, "Foreign");
  assert.equal((await f.call({ method: "orch.toolsets.list" as DesktopApiRequest["method"], body: { workspaceId: "project" } })).status, 400);
});

test("desktop asset references cannot cross workspaces or leave referenced definitions dangling", async (t) => {
  const f = fixture(t);
  initializeLocalEngineModelCatalog();
  t.after(resetEngineModelCatalogRuntimeForTest);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  f.db = f.db.forWorkspace(workspaceId);
  const toolset = f.db.orchToolsets.upsert({ id: "tools", workspaceId, name: "Tools", tools: [{ id: "read", name: "Read" }] } as any);
  const role = f.db.orchRoles.upsert({ id: "role", workspaceId, name: "Role", toolRefs: [{ toolsetId: toolset.id, toolId: "read" }] } as any);
  const otherWorkspaceId = "local-client:other" as WorkspaceId;
  const otherPath = path.join(f.directory, "other");
  fs.mkdirSync(otherPath);
  f.db.workspaces.upsert({ id: otherWorkspaceId, title: "Other", path: otherPath });
  f.ctx.workspaces.set(otherWorkspaceId, otherPath);
  for (const toolRefs of [[{ toolsetId: "missing", toolId: "read" }], [{ toolsetId: toolset.id, toolId: "missing" }]]) {
    const response = await f.call({ method: "orch.roles.upsert" as DesktopApiRequest["method"], body: { workspaceId, role: { ...role, toolRefs } } });
    assert.equal(response.status, 400);
  }
  assert.equal((await f.call({ method: "orch.roles.upsert" as DesktopApiRequest["method"], body: { workspaceId: otherWorkspaceId, role: { name: "Foreign refs", toolRefs: role.toolRefs } } })).status, 400);
  assert.equal((await f.call({ method: "orch.toolsets.delete" as DesktopApiRequest["method"], body: { workspaceId, toolsetId: toolset.id } })).status, 409);
  assert.equal((await f.call({ method: "orch.toolsets.upsert" as DesktopApiRequest["method"], body: { workspaceId, toolset: { ...toolset, tools: [] } } })).status, 409);
  assert.equal(f.db.orchToolsets.get(toolset.id)?.tools.length, 1);
});

test("desktop asset IDs and references reject noncanonical whitespace before writes", async (t) => {
  const f = fixture(t);
  initializeLocalEngineModelCatalog();
  t.after(resetEngineModelCatalogRuntimeForTest);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  f.db = f.db.forWorkspace(workspaceId);
  const skill = f.db.orchSkills.upsert({ id: "skill", workspaceId, name: "Skill", skillMd: "# Skill", targetEngines: ["codex"] } as any);
  const role = { id: "", name: "Role", executionConfig: createDefaultRoleExecutionConfig("codex"), defaultSkillIds: [` ${skill.id} `] };
  assert.equal((await f.call({ method: "orch.roles.upsert", body: { workspaceId, role } })).status, 400);
  assert.deepEqual(f.db.orchRoles.listByWorkspace(workspaceId), []);
  assert.equal((await f.call({ method: "orch.toolsets.upsert", body: { workspaceId, toolset: { id: " padded ", name: "Padded", tools: [] } } })).status, 400);
  assert.equal((await f.call({ method: "orch.skills.delete", body: { workspaceId, skillId: ` ${skill.id} ` } })).status, 400);
  assert.ok(f.db.orchSkills.get(skill.id));
});

test("desktop copies builtin dependencies in one request and keeps permission fields outside the bridge", async (t) => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  f.db = f.db.forWorkspace(workspaceId);
  const tools = f.db.orchToolsets.upsert({ id: "builtin", workspaceId, name: "内置工具", kind: "builtin", tools: [] } as any);
  const body = { workspaceId, assetType: "toolset", assetId: tools.id };
  const response = await f.call({ method: "orch.assets.copy" as DesktopApiRequest["method"], body });
  assert.equal(response.status, 200);
  const imported = (response.body as any).imported;
  assert.equal(imported.toolsets[0].name, "内置工具_复制");
  assert.equal(imported.toolsets[0].kind, "custom");
  assert.equal(imported.rootAssetId, imported.toolsets[0].id);
  assert.equal(f.db.orchToolsets.get(tools.id)?.kind, "builtin");
  for (const invalid of [{ assetType: "invalid" }, { assetId: " builtin " }, { assetId: "missing" }, { workspaceId: "shared:workspace" },
    { allowBuiltinAssetUpdate: true }, { sharedWorkspaceId: "shared" }, { strictDependencies: false }]) {
    const rejected = await f.call({ method: "orch.assets.copy" as DesktopApiRequest["method"], body: { ...body, ...invalid } });
    assert.ok(rejected.status === 400 || rejected.status === 404);
  }
  assert.equal(f.db.orchToolsets.listByWorkspace(workspaceId).length, 2);
});

test("desktop asset groups use local scope and cannot assign foreign or builtin assets", async (t) => {
  const f = fixture(t);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  const group = await f.call({ method: "orch.assetGroups.create", body: { workspaceId, assetType: "toolset", name: "本地分组" } });
  assert.equal(group.status, 200);
  const groupId = (group.body as any).group.id;
  f.db = f.db.forWorkspace(workspaceId);
  const toolset = f.db.orchToolsets.upsert({ id: "custom-tools", workspaceId, name: "Custom", tools: [] } as any);
  assert.equal((await f.call({ method: "orch.assetGroups.assign", body: { workspaceId, assetType: "toolset", assetId: toolset.id, groupId } })).status, 200);
  const listed = await f.call({ method: "orch.assetGroups.list", body: { workspaceId, assetType: "toolset" } });
  assert.equal((listed.body as any).assignments[toolset.id], groupId);
  const builtin = f.db.orchToolsets.upsert({ id: "builtin-tools", workspaceId, name: "Builtin", tools: [], kind: "builtin" } as any);
  assert.equal((await f.call({ method: "orch.assetGroups.assign", body: { workspaceId, assetType: "toolset", assetId: builtin.id, groupId } })).status, 400);
  assert.equal((await f.call({ method: "orch.assetGroups.list", body: { workspaceId: "foreign:workspace", assetType: "toolset" } })).status, 400);
  assert.equal((await f.call({ method: "orch.assetGroups.rename", body: { workspaceId, assetType: "toolset", groupId, name: "新名称" } })).status, 200);
  assert.equal((await f.call({ method: "orch.assetGroups.delete", body: { workspaceId, assetType: "toolset", groupId } })).status, 200);
});

test("desktop engine status returns the effective local catalog without cloud authorization", async (t) => {
  const f = fixture(t);
  initializeLocalEngineModelCatalog();
  t.after(resetEngineModelCatalogRuntimeForTest);
  const created = await f.call({ method: "workspaces.upsert", body: { title: "Local", path: f.root } });
  const workspaceId = (created.body as any).workspace.id;
  const result = await f.call({ method: "engines.status" as DesktopApiRequest["method"], body: { workspaceId } });
  assert.equal(result.status, 200);
  const engines = (result.body as any).engines;
  for (const engine of ["claude", "codex"]) {
    assert.ok(engines.find((item: any) => item.engineType === engine)?.models.length > 0);
  }
  for (const invalid of [{ workspaceId: "other:ws" }, { workspaceId: "missing" }, { sharedWorkspaceId: "shared" }]) {
    assert.ok((await f.call({ method: "engines.status" as DesktopApiRequest["method"], body: { workspaceId, ...invalid } })).status >= 400);
  }
  assert.deepEqual(f.sent, []);
});

test('desktop engine status rejects unvalidated builtin permission and native fallback after deletion', async t => {
  const f = fixture(t); initializeLocalEngineModelCatalog(); t.after(resetEngineModelCatalogRuntimeForTest);
  const created = await f.call({ method: 'workspaces.upsert', body: { title: 'Local', path: f.root } }), workspaceId = (created.body as any).workspace.id;
  const readFile = fs.readFileSync, exists = fs.existsSync;
  const isNativeAuth = (file: unknown) => String(file).replaceAll('\\', '/').endsWith('/.codex/auth.json');
  t.mock.method(fs, 'existsSync', (file: fs.PathLike) => isNativeAuth(file) || exists(file));
  t.mock.method(fs, 'readFileSync', ((file: any, options: any) => isNativeAuth(file) ? options ? '{"OPENAI_API_KEY":"native-test"}' : Buffer.from('{"OPENAI_API_KEY":"native-test"}') : readFile(file, options)) as typeof fs.readFileSync);
  const owner = { serverOrigin: 'https://cloud.example.test', ownerUserId: 'owner-status', accountSessionId: 'session-status', generation: 1 }, secrets = new Map<string, string>();
  const service = createBuiltInRelayCredentialService({ repo: f.db.engineKeys, getOwner: () => owner, assertOwner() {}, releaseOwnerSessions: async () => {}, requestEnsure: async () => ({ providerId: 'openai', keyId: 'status-key', ownerUserId: owner.ownerUserId, rawKey: 'status-secret', baseUrl: 'https://relay.example/v1' }), credentialStore: { get: ref => secrets.get(ref) ?? null, set: (ref, value) => { secrets.set(ref, value); }, delete: ref => { secrets.delete(ref); } } });
  f.ctx.builtInRelayCredentials = service;
  const builtin = await service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'status-ensure' });
  const listed = await f.call({ method: 'engineKeys.list', body: { workspaceId } });
  const entry = (listed.body as any).keys.find((key: any) => key.id === builtin.id);
  assert.equal(entry.apiKey, ''); assert.equal(entry.runtimeAvailable, true); assert.equal(Object.hasOwn(entry, 'secretRef'), false);
  await service.invalidateOwner(owner);
  for (const phase of ['invalidated', 'deleted']) {
    if (phase === 'deleted') await service.delete(builtin.id, 'status-delete');
    const result = await f.call({ method: 'engines.status', body: { workspaceId } });
    assert.equal(result.status, 200);
    const status = (result.body as any).engines.find((engine: any) => engine.engineType === 'codex').providerCredentialStatus.find((provider: any) => provider.providerId === 'openai');
    assert.equal(status.available, false, phase); assert.deepEqual(status.sources, [], phase); assert.match(status.message, /内置.*重验/u);
  }
  f.db.engineKeys.insert({ label: 'personal', engine: 'codex', providerId: 'openai', apiKey: 'personal-secret' });
  const restored = await f.call({ method: 'engines.status', body: { workspaceId } });
  assert.equal((restored.body as any).engines.find((engine: any) => engine.engineType === 'codex').providerCredentialStatus.find((provider: any) => provider.providerId === 'openai').available, true);
});

test('non-desktop status without credential service never advertises managed unknown or blocked native auth', async t => {
  const f = fixture(t), readFile = fs.readFileSync, exists = fs.existsSync;
  const isNativeAuth = (file: unknown) => String(file).replaceAll('\\', '/').endsWith('/.codex/auth.json');
  t.mock.method(fs, 'existsSync', (file: fs.PathLike) => isNativeAuth(file) || exists(file));
  t.mock.method(fs, 'readFileSync', ((file: any, options: any) => isNativeAuth(file) ? options ? '{"OPENAI_API_KEY":"native-test"}' : Buffer.from('{"OPENAI_API_KEY":"native-test"}') : readFile(file, options)) as typeof fs.readFileSync);
  const key = f.db.engineKeys.insert({ label: 'legacy', engine: 'codex', providerId: 'openai', apiKey: 'legacy-secret' });
  f.db.db.prepare("UPDATE engine_keys SET source='unknown' WHERE id=?").run(key.id);
  for (const phase of ['unknown', 'deleted', 'configured']) {
    if (phase === 'deleted') f.db.engineKeys.delete(key.id);
    if (phase === 'configured') f.db.engineKeys.insert({ label: 'explicit', engine: 'codex', providerId: 'openai', apiKey: 'personal-secret' });
    f.sent.length = 0;
    await handleEnginesStatus(f.ctx, { t: 'api.req', id: `status-${phase}`, method: 'engines.status', path: '', body: {} });
    const response = f.sent.at(-1) as any, provider = response.body.engines.find((entry: any) => entry.engineType === 'codex').providerCredentialStatus.find((entry: any) => entry.providerId === 'openai');
    assert.equal(provider.available, phase === 'configured', phase);
    if (phase !== 'configured') assert.deepEqual(provider.sources, [], phase);
  }
});

/** 本机终端的桌面控制面夹具；只替换 manager 和事件发布边界，其余仍走真实入口。 */
function terminalFixture(t: test.TestContext, options: { linked?: boolean } = {}) {
  const f = fixture(t), workspaceId = `local-client:${crypto.randomUUID()}` as WorkspaceId;
  f.ctx.workspaces.set(workspaceId, f.root);
  f.db.workspaces.upsert({ id: workspaceId, title: "Terminal", path: f.root });
  const calls: Array<[string, unknown[]]> = [], events: DesktopTerminalEvent[] = [];
  const info = (id: string): TerminalInfo => ({ id, workspaceId, label: `Terminal ${id}`, shell: "bash", cwd: f.root,
    status: "running", exitCode: null, createdAt: 1, foregroundProcess: null });
  let created: TerminalInfo | null = null;
  const terminalManager = {
    create(input: Record<string, unknown>) { calls.push(["create", [input]]); created = { ...info("term-1"), label: String(input.label ?? "Terminal 1") }; return created; },
    get(id: string) { return id === "term-1" ? created ?? info("term-1") : null; },
    write(id: string, data: string) { calls.push(["write", [id, data]]); },
    resize(id: string, cols: number, rows: number) { calls.push(["resize", [id, cols, rows]]); },
    rename(id: string, label: string) { calls.push(["rename", [id, label]]); return true; },
    close(id: string) { calls.push(["close", [id]]); return true; },
    list() { calls.push(["list", []]); return [{ ...info("term-1"), scrollback: "hello" }]; },
    restoreAll() { calls.push(["restoreAll", []]); return [info("term-2")]; },
    scheduleCommand(id: string, command: string, delay: number) { calls.push(["scheduleCommand", [id, command, delay]]); },
  } as any;
  f.ctx.terminalManager = terminalManager;
  f.ctx.publishTerminalEvent = (event) => { events.push(event); };
  if (options.linked) f.ctx.desktopCloudAccount = { getOwner: () => ({ ownerUserId: "owner" }) } as any;
  return { ...f, workspaceId, events, calls, terminalManager };
}

test("desktop terminal control API covers create/input/resize/rename/close/list/runAction", async t => {
  const f = terminalFixture(t);
  const created = await f.call({ method: "terminal.create", body: { workspaceId: f.workspaceId, requestId: "create-1", label: "Build", shell: "bash" } });
  assert.equal(created.status, 200);
  assert.deepEqual(f.calls[0], ["create", [{ workspaceId: f.workspaceId, requestId: "create-1", label: "Build", shell: "bash", cwd: undefined }]]);

  assert.equal((await f.call({ method: "terminal.input", body: { workspaceId: f.workspaceId, terminalId: "term-1", data: "echo hi" } })).status, 200);
  assert.equal((await f.call({ method: "terminal.resize", body: { workspaceId: f.workspaceId, terminalId: "term-1", cols: 100, rows: 40 } })).status, 200);

  const renamed = await f.call({ method: "terminal.rename", body: { workspaceId: f.workspaceId, terminalId: "term-1", label: "Renamed" } });
  assert.equal(renamed.status, 200);
  assert.deepEqual(f.events.at(-1), { t: "terminal.renamed", clientId: "local-client", workspaceId: f.workspaceId, terminalId: "term-1", label: "Renamed" });

  const closed = await f.call({ method: "terminal.close", body: { workspaceId: f.workspaceId, terminalId: "term-1" } });
  assert.equal(closed.status, 200);
  assert.deepEqual(f.events.at(-1), { t: "terminal.closed", clientId: "local-client", workspaceId: f.workspaceId, terminalId: "term-1" });

  const listed = await f.call({ method: "terminal.list", body: { workspaceId: f.workspaceId, requestId: "list-1" } });
  assert.equal(listed.status, 200);
  const listBody = listed.body as { clientId: string; requestId: string; terminals: Array<TerminalInfo & { clientId: string; scrollback?: string }> };
  assert.equal(listBody.clientId, "local-client");
  assert.equal(listBody.requestId, "list-1");
  assert.deepEqual(listBody.terminals.map((terminal) => terminal.clientId), ["local-client"]);
  assert.equal(listBody.terminals[0]!.scrollback, "hello");

  const action: TerminalAction = { id: "run", label: "Run", command: "echo hi", shell: null, cwd: null,
    icon: null, color: null, order: 0, autoRun: false, enabled: true };
  writeTerminalActions(f.root, [action]);
  const ran = await f.call({ method: "terminal.runAction", body: { workspaceId: f.workspaceId, actionId: "run", requestId: "action-1" } });
  assert.equal(ran.status, 200);
  assert.ok(f.calls.some(([method, args]) => method === "scheduleCommand" && args[0] === "term-1" && args[1] === "echo hi"));
});

test("desktop terminal list restores persisted terminals under the workspace write gate", async t => {
  const f = terminalFixture(t), listed: TerminalInfo[][] = [];
  f.terminalManager.list = () => { const next = listed.shift() ?? []; f.calls.push(["list", [next.length]]); return next; };
  listed.push([], [{ id: "term-2", workspaceId: f.workspaceId, label: "Restored", shell: "bash", cwd: f.root,
    status: "running", exitCode: null, createdAt: 2, foregroundProcess: null, scrollback: "restored" } as any]);
  const result = await f.call({ method: "terminal.list", body: { workspaceId: f.workspaceId, requestId: "list-restore" } });
  assert.equal(result.status, 200);
  assert.ok(f.calls.some(([method]) => method === "restoreAll"));
  assert.deepEqual((result.body as any).terminals.map((terminal: any) => [terminal.id, terminal.clientId]), [["term-2", "local-client"]]);
});

test("desktop terminal control API allows linked accounts and rejects unknown terminals without publishing success", async t => {
  const linked = terminalFixture(t, { linked: true });
  const listed = await linked.call({ method: "terminal.list", body: { workspaceId: linked.workspaceId } });
  assert.equal(listed.status, 200);
  assert.deepEqual(linked.calls.map(([method]) => method), ["list"]);
  assert.deepEqual(linked.events, []);

  const f = terminalFixture(t);
  const missing = await f.call({ method: "terminal.close", body: { workspaceId: f.workspaceId, terminalId: "missing" } });
  assert.equal(missing.status, 404);
  assert.deepEqual(f.events, []);
  assert.ok(!f.calls.some(([method]) => method === "close"));
});

test("desktop terminal control API rejects workspaces outside the local client scope", async t => {
  const f = terminalFixture(t);
  const result = await f.call({ method: "terminal.list", body: { workspaceId: "other-client:workspace" } });
  assert.equal(result.status, 403);
  assert.equal(f.calls.length, 0);
});
