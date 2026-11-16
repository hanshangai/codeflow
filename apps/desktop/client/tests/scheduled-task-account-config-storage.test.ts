import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientScheduledTaskSyncResponseBody, ScheduledTask, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { assertWorkspaceDbReadOnlySchema, migrateClientDb, CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";

/** 原Scheduler与真实分库；云只提供可信owner和完整响应。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-config-"));
  t.mock.method(os, "homedir", () => root);
  const file = path.join(root, "client.db"), db = openClientDb({ dbPath: file });
  const a = "desktop:a" as WorkspaceId, b = "desktop:b" as WorkspaceId;
  for (const workspace of [a, b]) {
    const directory = path.join(root, workspace.split(":")[1]!); fs.mkdirSync(directory);
    db.workspaces.upsert({ id: workspace, title: workspace, path: directory });
  }
  const owner = { serverOrigin: "http://127.0.0.1:1", ownerUserId: "A", clientId: "desktop", deviceId: "installation" };
  const status = { linked: true, generation: 1 }, calls: string[] = [], logs: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { logs.push(args); });
  let response: ClientScheduledTaskSyncResponseBody = { tasks: [], configRevisionFloors: [], serverNow: 1 };
  const ctx = { db, localWorkspaceOnly: true, clientId: owner.clientId, deviceId: owner.deviceId,
    workspaces: new Map(db.workspaces.list().map(workspace => [workspace.id, workspace.path])) } as unknown as ApiHandlerContext;
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: owner.clientId, serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: owner.deviceId, apiContext: ctx, localApiContext: ctx,
    captureAccountContext: () => status.linked ? { ...owner, generation: status.generation,
      assertCurrent() { assert.equal(status.linked, true); } } : null,
    requestAccountTasks: async (_owner, action) => { calls.push(action); return action === "sync" ? response : { serverNow: 1 }; } });
  t.after(async () => { try { await scheduler.stopAndDrain(); } finally { db.close(); fs.rmSync(root, { recursive: true }); } });
  return { root, file, db, a, b, owner, status, scheduler, calls, logs,
    /** 整轮响应保持同一任务/水位集合，不把缺水位补为0。 */
    set(tasks: ScheduledTask[], floors = tasks.map(task => ({ taskId: task.id, localRevision: 0 }))) {
      response = { tasks, configRevisionFloors: floors, serverNow: 1 };
    },
    /** 非法云响应仅用于验证写入前拒绝。 */
    raw(value: ClientScheduledTaskSyncResponseBody) { response = value; } };
}

/** 任务配置完整且停用，存储测试不发起真实脚本。 */
function task(id: string, workspaceId?: WorkspaceId): ScheduledTask {
  return { id, ownerUserId: "A", clientId: "desktop", deviceId: "installation", deviceKind: "desktop", configRevision: 1,
    clientNameSnapshot: "Desktop", deviceLabelSnapshot: null, name: "账号任务", description: null, taskType: "script",
    cronExpr: "* * * * *", timezone: "UTC", enabled: false,
    payload: { shell: process.platform === "win32" ? "cmd" : "sh", command: "echo account", ...(workspaceId ? { contextWorkspaceId: workspaceId } : {}) },
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 10_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
}

/** 真实回读保留归属、水位和完整快照，不依赖Scheduler私有缓存。 */
function stored(f: ReturnType<typeof fixture>, workspaceId: WorkspaceId | null = null) {
  return f.db.withAccountScheduledTasks(workspaceId, repos => {
    assert.ok(repos.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_task_account_configs'").get(), "账号完整快照必须落SQLite");
    return repos.db.prepare("SELECT * FROM scheduled_task_account_configs ORDER BY task_id").all() as Record<string, unknown>[];
  });
}

/** 公开wait消费原Scheduler保留的已断言失败，不将预期错误留给关闭阶段。 */
async function rejectSync(f: ReturnType<typeof fixture>, reason: string): Promise<void> {
  await assert.rejects(f.scheduler.syncAndTick(reason));
  await assert.rejects(f.scheduler.waitForInFlightWork());
}

test("desktop sync commits account configuration to the fixed physical source and survives reopen", async t => {
  const f = fixture(t), app = task("app"), workspace = task("workspace", f.a);
  f.set([app, workspace], [{ taskId: app.id, localRevision: 8 }, { taskId: workspace.id, localRevision: 3 }]);
  await f.scheduler.syncAndTick("snapshot");
  const appRows = stored(f), workspaceRows = stored(f, f.a);
  assert.deepEqual(appRows.map(row => row.task_id), ["app"]); assert.deepEqual(workspaceRows.map(row => row.task_id), ["workspace"]);
  assert.equal(appRows[0]!.local_revision, 8); assert.equal(workspaceRows[0]!.local_revision, 3);
  assert.deepEqual(JSON.parse(workspaceRows[0]!.snapshot_json as string), workspace);
  assert.equal(f.db.scheduledTaskConfigs.list({ clientId: "desktop", deviceId: "installation" }).length, 0);
  const reader = openSqliteDb(path.join(f.root, "a/.codeflowai/workspace.db"), { readonly: true, fileMustExist: true });
  try { assert.equal(reader.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION); assert.equal((reader.prepare("SELECT task_id FROM scheduled_task_account_configs").get() as { task_id: string }).task_id, workspace.id); }
  finally { reader.close(); }
  await f.scheduler.stopAndDrain(); f.db.close();
  const reopened = openClientDb({ dbPath: f.file });
  try { assert.deepEqual(reopened.withAccountScheduledTasks(f.a, repos => repos.db.prepare("SELECT * FROM scheduled_task_account_configs").all()), workspaceRows); }
  finally { reopened.close(); }
});

test("account snapshot sync retains higher local revision floors and separates all owner fields", async t => {
  const f = fixture(t), config = task("same"); f.set([config], [{ taskId: config.id, localRevision: 20 }]);
  await f.scheduler.syncAndTick("first");
  f.set([{ ...config, name: "新名称", configRevision: 2 }]); await f.scheduler.syncAndTick("lower-floor");
  assert.equal(stored(f)[0]!.local_revision, 20); assert.equal(JSON.parse(stored(f)[0]!.snapshot_json as string).name, "新名称");
  for (const patch of [{ ownerUserId: "B" }, { serverOrigin: "http://127.0.0.1:2" }, { deviceId: "other-device" }, { clientId: "other-client" }]) {
    const owner = { ...f.owner, ...patch }, next = { ...config, ownerUserId: owner.ownerUserId, clientId: owner.clientId, deviceId: owner.deviceId };
    f.db.replaceAccountScheduledTaskConfigs(owner, { tasks: [next], configRevisionFloors: [{ taskId: next.id, localRevision: 1 }], serverNow: 1 });
  }
  assert.equal(stored(f).length, 5);
  f.set([]); await f.scheduler.syncAndTick("removed"); assert.equal(stored(f).length, 4);
});

for (const kind of ["missing-floor", "duplicate-floor", "bad-floor", "missing-revision", "ordinary-domain", "wrong-owner", "bad-payload", "local-source"] as const) {
  test(`desktop invalid ${kind} snapshot fails before writing or reporting`, async t => {
    const f = fixture(t), original = task("original"); f.set([original]); await f.scheduler.syncAndTick("valid");
    const before = stored(f), bad = task("bad"), response: ClientScheduledTaskSyncResponseBody = { tasks: [bad], configRevisionFloors: [{ taskId: bad.id, localRevision: 0 }], serverNow: 1 };
    if (kind === "missing-floor") delete response.configRevisionFloors;
    if (kind === "duplicate-floor") response.configRevisionFloors!.push({ taskId: bad.id, localRevision: 0 });
    if (kind === "bad-floor") response.configRevisionFloors![0]!.localRevision = -1;
    if (kind === "missing-revision") delete bad.configRevision;
    if (kind === "ordinary-domain") bad.deviceKind = "client";
    if (kind === "wrong-owner") bad.ownerUserId = "B";
    if (kind === "bad-payload") bad.payload = { shell: "cmd", command: "" };
    if (kind === "local-source") Object.assign(bad, { source: "local" });
    f.raw(response); const count = f.calls.length;
    await rejectSync(f, "invalid");
    assert.deepEqual(stored(f), before); assert.deepEqual(f.calls.slice(count), ["sync"]); assert.equal(f.logs.length, 1);
  });
}

test("account snapshot rejects workspace rebinding and cross-source duplicate identity before writes", async t => {
  const f = fixture(t), config = task("fixed", f.a); f.set([config]); await f.scheduler.syncAndTick("first");
  const before = stored(f, f.a); f.set([task(config.id, f.b)]);
  await rejectSync(f, "move"); assert.deepEqual(stored(f, f.a), before);
  assert.equal(fs.existsSync(path.join(f.root, "b/.codeflowai/workspace.db")), false);
  f.db.withAccountScheduledTasks(f.b, repos => repos.db.prepare(`INSERT INTO scheduled_task_account_configs
    (server_origin,owner_user_id,client_id,device_id,task_id,workspace_id,snapshot_json,local_revision)
    SELECT ?,?,?,?,?,?,?,?`).run(f.owner.serverOrigin, "A", "desktop", "installation", config.id, f.b, JSON.stringify(task(config.id, f.b)), 0));
  f.set([config]); await rejectSync(f, "duplicate"); assert.deepEqual(stored(f, f.a), before);
});

test("account snapshot SQL failure rolls back its source and prevents reports until full sync recovers", async t => {
  const f = fixture(t), first = task("first"), second = task("second", f.a); f.set([first, second]); await f.scheduler.syncAndTick("first");
  const before = stored(f, f.a);
  f.db.withAccountScheduledTasks(f.a, repos => repos.db.exec(`CREATE TRIGGER reject_config BEFORE INSERT ON scheduled_task_account_configs
    BEGIN SELECT RAISE(ABORT,'SECRET_SQL_CONFIG'); END`));
  f.set([{ ...first, name: "应用已提交" }, { ...second, name: "工作区必须回滚" }]); const count = f.calls.length;
  await rejectSync(f, "sql-failed"); assert.deepEqual(stored(f, f.a), before);
  assert.deepEqual(f.calls.slice(count), ["sync"]); assert.equal(f.logs.length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_SQL_CONFIG|工作区必须回滚/);
  f.db.withAccountScheduledTasks(f.a, repos => repos.db.exec("DROP TRIGGER reject_config"));
  await f.scheduler.syncAndTick("recovered"); assert.equal(JSON.parse(stored(f, f.a)[0]!.snapshot_json as string).name, "工作区必须回滚");
});

test("corrupt persisted account JSON fails explicitly without replacing it and unlink never uses it", async t => {
  const f = fixture(t), config = task("corrupt"); f.set([config]); await f.scheduler.syncAndTick("first");
  f.db.db.prepare("UPDATE scheduled_task_account_configs SET snapshot_json=?").run('{"secret":"SECRET_CONFIG"}');
  const before = stored(f); await rejectSync(f, "corrupt"); assert.deepEqual(stored(f), before);
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_CONFIG/);
  f.status.linked = false; f.status.generation++; const count = f.calls.length;
  await f.scheduler.syncAndTick("unlinked"); assert.equal(f.calls.length, count); assert.deepEqual(stored(f), before);
});

test("workspace schema98 remains readonly and upgrades through the original writer without moving data", t => {
  const f = fixture(t);
  f.db.withAccountScheduledTasks(f.a, repos => repos.db.exec("INSERT INTO workspace_prefs(workspace_id,engine,work_mode,updated_at) VALUES ('desktop:a','codex','general',1)"));
  const file = path.join(f.root, "a/.codeflowai/workspace.db"), old = openSqliteDb(file, { fileMustExist: true });
  try { old.exec("DROP TABLE scheduled_task_account_configs; PRAGMA user_version=98"); }
  finally { old.close(); }
  const before = fs.readFileSync(file), reader = openSqliteDb(file, { readonly: true, fileMustExist: true });
  try { assert.equal(assertWorkspaceDbReadOnlySchema(reader).schemaVersion, 98); }
  finally { reader.close(); }
  assert.deepEqual(fs.readFileSync(file), before);
  const response = { tasks: [task("upgrade", f.a)], configRevisionFloors: [{ taskId: "upgrade", localRevision: Number.MAX_SAFE_INTEGER }], serverNow: 1 };
  f.db.replaceAccountScheduledTaskConfigs(f.owner, response);
  f.db.withAccountScheduledTasks(f.a, repos => {
    assert.equal(assertWorkspaceDbReadOnlySchema(repos.db).schemaVersion, CLIENT_DB_SCHEMA_VERSION);
    assert.equal((repos.db.prepare("SELECT work_mode FROM workspace_prefs").get() as { work_mode: string }).work_mode, "general");
    assert.equal(repos.accountConfigs.list(f.owner)[0]!.localRevision, Number.MAX_SAFE_INTEGER);
  });
});

test("workspace schema99 rejects a malformed account configuration table before changing pragma", t => {
  const f = fixture(t); f.db.withAccountScheduledTasks(f.a, () => {});
  const file = path.join(f.root, "a/.codeflowai/workspace.db"), db = openSqliteDb(file, { fileMustExist: true });
  try {
    db.exec("DROP TABLE scheduled_task_account_configs; CREATE TABLE scheduled_task_account_configs(task_id TEXT)");
    const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    assert.throws(() => migrateClientDb(db, { scope: "workspace" }), /WORKSPACE_DB_SCHEMA_INVALID/);
    assert.deepEqual(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), before);
    assert.equal(db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  } finally { db.close(); }
});

for (const fault of ["ignore", "rewrite"] as const) test(`account snapshot detects ${fault} after write and rolls the source back`, async t => {
  const f = fixture(t), config = task("readback"); f.set([config]); await f.scheduler.syncAndTick("first");
  const before = stored(f);
  f.db.db.exec(fault === "ignore" ? `CREATE TRIGGER corrupt_write BEFORE INSERT ON scheduled_task_account_configs BEGIN SELECT RAISE(IGNORE); END`
    : `CREATE TRIGGER corrupt_write AFTER INSERT ON scheduled_task_account_configs BEGIN UPDATE scheduled_task_account_configs
      SET snapshot_json=json_set(snapshot_json,'$.name','changed-by-trigger') WHERE task_id=NEW.task_id; END`);
  f.set([{ ...config, name: "expected-name" }]); await rejectSync(f, fault); assert.deepEqual(stored(f), before);
});

test("removed workspace directory does not fail the next account snapshot sync", async t => {
  const f = fixture(t), config = task("stale", f.a);
  f.set([config]); await f.scheduler.syncAndTick("first");
  f.db.workspaces.delete(f.a);
  fs.rmSync(path.join(f.root, "a"), { recursive: true, force: true });
  f.set([]);
  await f.scheduler.syncAndTick("after-delete");
  await f.scheduler.stopAndDrain();
  assert.equal(f.logs.length, 0);
});
