import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { DesktopApiRequest, WorkspaceId, LocalScheduledTaskConfig, ScheduledTaskRun } from "@codeflowai/shared";
import { scheduledTaskRuntimeKey, scheduledTaskAccountRuntimeKey } from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { ScheduledTaskConfigError } from "../src/db/repos/scheduledTaskConfigRepo.js";
import { logger } from "../src/logger.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import type { ClientConfig } from "../src/config.js";

/** 原桥与真实物理库共用同一 gate；每例独占目录和可信工作区。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-scheduled-storage-"));
  const a = path.join(root, "a"), b = path.join(root, "b"); fs.mkdirSync(a); fs.mkdirSync(b);
  const aId = "storage-client:a" as WorkspaceId, bId = "storage-client:b" as WorkspaceId;
  const gate = new WorkspaceOperationGate(), db = openClientDb({ dbPath: path.join(root, "application.db"), workspaceOperationGate: gate });
  db.workspaces.upsert({ id: aId, title: "A", path: a }); db.workspaces.upsert({ id: bId, title: "B", path: b });
  const ctx = { db, clientId: "storage-client", deviceId: "storage-device", localWorkspaceOnly: true,
    workspaceOperationGate: gate, workspaces: new Map([[aId, a], [bId, b]]), send: () => {} } as unknown as ApiHandlerContext;
  let seq = 0;
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true }); });
  return { root, a, b, aId, bId, gate, db, ctx,
    /** 请求沿真实桌面白名单与中央分发，不模拟仓储或落点。 */
    call: (action: string, body: Record<string, unknown> = {}) => executeDesktopApiRequest(ctx,
      { method: `scheduledTasks.local.${action}`, body } as DesktopApiRequest,
      { requestId: `storage-${++seq}`, clientVersion: "1.0.0", startedAt: 1 }) as Promise<{ status: number; body: any }> };
}

/** 只传原桥允许的业务字段，身份和 scope 由 Host 派生。 */
function input(workspaceId?: WorkspaceId): Record<string, unknown> {
  return { name: "工作区定时任务", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: "sh", command: "true", ...(workspaceId ? { contextWorkspaceId: workspaceId } : {}) },
    concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 10_000 };
}

test("工作区任务经原 handler 仅写物理工作区三表", async t => {
  const f = fixture(t), response = await f.call("create", input(f.aId));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const file = path.join(f.a, ".codeflowai", "workspace.db");
  assert.equal(fs.existsSync(file), true, "真实 handler 必须在注册工作区创建 workspace.db");
  const physical = openSqliteDb(file, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(physical.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
      ["scheduled_task_account_configs", "scheduled_task_configs", "scheduled_task_runs", "scheduled_task_runtime_states", "workspace_execution_profiles", "workspace_prefs"].map(name => ({ name })));
    assert.equal((physical.prepare("SELECT id FROM scheduled_task_configs").get() as any).id, response.body.task.id);
  } finally { physical.close(); }
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_configs").get() as any).n, 0);
});

/** 真实桥创建后仅提取成功事实，错误响应原样参与断言。 */
async function createTask(f: ReturnType<typeof fixture>, workspaceId?: WorkspaceId): Promise<LocalScheduledTaskConfig> {
  const response = await f.call("create", input(workspaceId));
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.task;
}

/** 用原 skipped 形状构造历史，不启动脚本或引擎。 */
function skipped(task: LocalScheduledTaskConfig, id: string, at: number): ScheduledTaskRun {
  return { id, taskId: task.id, clientId: task.clientId, deviceId: task.deviceId, workspaceId: task.workspaceScope?.scopeId ?? null,
    workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null, scheduledAt: at, startedAt: null,
    finishedAt: at, status: "skipped", triggerSource: "schedule", attempt: 1, durationMs: null,
    summary: "跳过", errorMessage: null, outputExcerpt: null, createdAt: at };
}

test("D16 F4 全来源接续含注册墓碑，只改device且原历史API在新设备可见", async t => {
  const f = fixture(t), tasks = [await createTask(f), await createTask(f, f.aId), await createTask(f, f.bId)];
  const before = tasks.map((task, index) => f.db.withLocalScheduledTasks(task.workspaceScope?.scopeId ?? null, repos => {
    repos.runs.create({ run: skipped(task, `reinstall-history-${index}`, 90), expectedConfigRevision: 1 });
    if (index === 2) repos.configs.delete({ taskId: task.id, expectedRevision: 1, at: task.updatedAt + 1 });
    const key = scheduledTaskRuntimeKey(task.id, "local");
    repos.runtime.markStarted({ taskId: key, clientId: task.clientId, deviceId: task.deviceId, runId: `retained-${index}`, scheduledAt: 100, startedAt: 101 });
    repos.runtime.queueLocalConcurrency({ taskId: task.id, clientId: task.clientId, deviceId: task.deviceId, runId: `retained-${index}`, scheduledAt: 200, at: 102 });
    return { config: repos.db.prepare("SELECT * FROM scheduled_task_configs").all(), runtime: repos.db.prepare("SELECT * FROM scheduled_task_runtime_states").all(),
      runs: repos.db.prepare("SELECT * FROM scheduled_task_runs").all() };
  }));
  f.db.workspaces.delete(f.bId);
  const request = { clientId: tasks[0]!.clientId, oldDeviceId: tasks[0]!.deviceId, nextDeviceId: "reinstalled-device" };
  assert.deepEqual(f.db.rebindLocalScheduledTasksForDesktopReinstall(request), { rebound: 3, unchanged: 0 });
  for (const [index, task] of tasks.entries()) f.db.withLocalScheduledTasks(task.workspaceScope?.scopeId ?? null, repos => {
    for (const [table, field] of [["scheduled_task_configs", "config"], ["scheduled_task_runtime_states", "runtime"]] as const) {
      assert.deepEqual(repos.db.prepare(`SELECT * FROM ${table}`).all(), before[index]![field].map(row => ({ ...(row as Record<string, unknown>), device_id: request.nextDeviceId })));
    }
    assert.deepEqual(repos.db.prepare("SELECT * FROM scheduled_task_runs").all(), before[index]!.runs);
  }, true);
  assert.deepEqual(f.db.rebindLocalScheduledTasksForDesktopReinstall(request), { rebound: 0, unchanged: 3 });
  assert.equal(f.db.listLocalScheduledTaskRuns({ clientId: request.clientId, deviceId: request.nextDeviceId, offset: 0, limit: 50 }).total, 3);
  assert.equal(f.gate.hasActiveWrites(), false);
});

for (const fault of ["half_pair", "third_device", "foreign_runtime", "orphan", "unknown_source", "collision", "bad_scope"] as const)
test(`D16 F4 全来源预检${fault}失败，前序应用库和工作区保持零写`, async t => {
  const f = fixture(t), app = await createTask(f), task = await createTask(f, f.aId);
  f.db.withLocalScheduledTasks(f.aId, repos => {
    const key = scheduledTaskRuntimeKey(fault === "orphan" ? "orphan-task" : task.id, "local");
    if (fault !== "bad_scope") repos.runtime.markSkipped({ taskId: key, clientId: fault === "foreign_runtime" ? "foreign-client" : task.clientId,
      deviceId: fault === "half_pair" ? "reinstalled-device" : task.deviceId, scheduledAt: 200, at: 201 });
    if (fault === "third_device") repos.db.prepare("UPDATE scheduled_task_configs SET device_id='third-device'").run();
    if (fault === "unknown_source") repos.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE scheduled_task_configs SET source='future-source'; PRAGMA ignore_check_constraints=OFF");
    if (fault === "bad_scope") repos.db.prepare("UPDATE scheduled_task_configs SET workspace_scope_id=?").run(f.bId);
  });
  if (fault === "collision") f.db.withLocalScheduledTasks(f.bId, repos => {
    repos.configs.create({ config: { ...task, clientId: "foreign-client", workspaceScope: { scopeType: "local_workspace", scopeId: f.bId },
      payload: { ...task.payload, contextWorkspaceId: f.bId } }, at: task.createdAt });
    repos.configs.delete({ taskId: task.id, expectedRevision: 1, at: task.createdAt + 1 });
  });
  const before = f.db.db.prepare("SELECT * FROM scheduled_task_configs").all();
  const workspaceBefore = f.db.withLocalScheduledTasks(f.aId, repos => ({ configs: repos.db.prepare("SELECT * FROM scheduled_task_configs").all(),
    runtime: repos.db.prepare("SELECT * FROM scheduled_task_runtime_states").all() }));
  assert.throws(() => f.db.rebindLocalScheduledTasksForDesktopReinstall({ clientId: app.clientId, oldDeviceId: app.deviceId, nextDeviceId: "reinstalled-device" }));
  assert.deepEqual(f.db.db.prepare("SELECT * FROM scheduled_task_configs").all(), before);
  assert.deepEqual(f.db.withLocalScheduledTasks(f.aId, repos => ({ configs: repos.db.prepare("SELECT * FROM scheduled_task_configs").all(),
    runtime: repos.db.prepare("SELECT * FROM scheduled_task_runtime_states").all() })), workspaceBefore);
  assert.equal(f.gate.hasActiveWrites(), false);
});

test("D16 F4 existingOnly拒绝缺文件且不创建父目录", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reinstall-existing-only-")), target = path.join(root, "missing-parent", "application.db");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let opened: ReturnType<typeof openClientDb> | undefined;
  try { assert.throws(() => { opened = openClientDb({ dbPath: target, existingOnly: true }); }); }
  finally { opened?.close(); }
  assert.equal(fs.existsSync(path.dirname(target)), false);
});

test("D16 F4 同库全任务回滚，前库已提交可跨库重入且不改已接续事实", async t => {
  const f = fixture(t), app = await createTask(f), a = await createTask(f, f.aId), b = await createTask(f, f.bId);
  const b2 = await createTask(f, f.bId);
  f.db.db.prepare("UPDATE workspaces SET updated_at=CASE WHEN id=? THEN 2 ELSE 1 END").run(f.aId);
  const secondId = [b.id, b2.id].sort()[1]!;
  f.db.withLocalScheduledTasks(f.bId, repos => repos.db.exec(`CREATE TRIGGER reinstall_second_failure BEFORE UPDATE OF device_id
    ON scheduled_task_configs WHEN OLD.id='${secondId}' BEGIN SELECT RAISE(ABORT,'REINSTALL_SECOND_FAILURE'); END`));
  const before = f.db.withLocalScheduledTasks(f.bId, repos => repos.db.prepare("SELECT * FROM scheduled_task_configs ORDER BY id").all());
  const request = { clientId: app.clientId, oldDeviceId: app.deviceId, nextDeviceId: "reinstalled-device" };
  assert.throws(() => f.db.rebindLocalScheduledTasksForDesktopReinstall(request));
  assert.equal(f.db.getLocalScheduledTask(app.id)?.deviceId, request.nextDeviceId);
  assert.equal(f.db.getLocalScheduledTask(a.id)?.deviceId, request.nextDeviceId);
  assert.deepEqual(f.db.withLocalScheduledTasks(f.bId, repos => repos.db.prepare("SELECT * FROM scheduled_task_configs ORDER BY id").all()), before);
  const appAfter = f.db.db.prepare("SELECT * FROM scheduled_task_configs").all();
  f.db.withLocalScheduledTasks(f.bId, repos => repos.db.exec("DROP TRIGGER reinstall_second_failure"));
  assert.deepEqual(f.db.rebindLocalScheduledTasksForDesktopReinstall(request), { rebound: 2, unchanged: 2 });
  assert.deepEqual(f.db.db.prepare("SELECT * FROM scheduled_task_configs").all(), appAfter);
  assert.equal(f.gate.hasActiveWrites(), false);
});

test("D16 F4 外来client/账号/应用旧W坏正文不解码不写入，合法无库和旧版无三表不创建", async t => {
  const f = fixture(t), app = await createTask(f); await createTask(f, f.aId);
  f.db.withLocalScheduledTasks(f.aId, repos => repos.db.prepare("UPDATE scheduled_task_configs SET client_id='foreign-client',payload_json='{'").run());
  f.db.withWorkspacePrefs(f.bId, () => {});
  const bFile = path.join(f.b, ".codeflowai", "workspace.db"), bDb = openSqliteDb(bFile, { fileMustExist: true });
  try { bDb.exec("DROP TABLE scheduled_task_account_configs; DROP TABLE scheduled_task_configs; DROP TABLE scheduled_task_runs; DROP TABLE scheduled_task_runtime_states; PRAGMA user_version=95"); }
  finally { bDb.close(); }
  const emptyRoot = path.join(f.root, "empty-workspace"), emptyId = "storage-client:empty" as WorkspaceId;
  fs.mkdirSync(emptyRoot); f.db.workspaces.upsert({ id: emptyId, title: "empty", path: emptyRoot });
  f.db.db.exec(`INSERT INTO scheduled_task_configs SELECT 'old-app-workspace',source,client_id,device_id,
    'local_workspace','old-workspace',name,description,task_type,cron_expr,timezone,enabled,'{',concurrency_policy,
    missed_policy,timeout_ms,revision,deleted_at,created_at,updated_at FROM scheduled_task_configs LIMIT 1`);
  f.db.scheduledTaskRuntimeStates.markSkipped({ taskId: scheduledTaskRuntimeKey("old-app-workspace", "local"),
    clientId: app.clientId, deviceId: "third-device", scheduledAt: 1, at: 1 });
  f.db.scheduledTaskRuntimeStates.markSkipped({ taskId: "__account_scheduled_task__:invalid-json", clientId: app.clientId,
    deviceId: app.deviceId, scheduledAt: 1, at: 1 });
  const foreignBefore = f.db.withLocalScheduledTasks(f.aId, repos => repos.db.prepare("SELECT * FROM scheduled_task_configs").all());
  const runtimeBefore = f.db.db.prepare("SELECT * FROM scheduled_task_runtime_states").all();
  const oldBefore = f.db.db.prepare("SELECT * FROM scheduled_task_configs WHERE id='old-app-workspace'").get();
  assert.deepEqual(f.db.rebindLocalScheduledTasksForDesktopReinstall({ clientId: app.clientId, oldDeviceId: app.deviceId, nextDeviceId: "reinstalled-device" }), { rebound: 1, unchanged: 0 });
  assert.deepEqual(f.db.withLocalScheduledTasks(f.aId, repos => repos.db.prepare("SELECT * FROM scheduled_task_configs").all()), foreignBefore);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM scheduled_task_runtime_states").all(), runtimeBefore);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM scheduled_task_configs WHERE id='old-app-workspace'").get(), oldBefore);
  assert.equal(fs.existsSync(path.join(emptyRoot, ".codeflowai")), false);
  const old = openSqliteDb(bFile, { readonly: true, fileMustExist: true });
  try { assert.equal(old.pragma("user_version", { simple: true }), 95); }
  finally { old.close(); }
});

for (const mutation of ["remove", "replace"] as const) test(`D16 F4 探测后${mutation}工作区库显式失败且不重建`, async t => {
  const f = fixture(t), task = await createTask(f, f.aId), prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
  const file = path.join(f.a, ".codeflowai", "workspace.db"), held = `${file}.retained`, canonicalFile = fs.realpathSync.native(file);
  let closes = 0, mutated = false;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const matches = (prepare.call(this, "PRAGMA database_list").all() as Array<{file: string}>).some(row => row.file && fs.realpathSync.native(row.file) === canonicalFile);
    const result = close.call(this);
    if (matches && ++closes === 3) {
      fs.renameSync(file, held); mutated = true;
      if (mutation === "replace") fs.copyFileSync(held, file);
    }
    return result;
  });
  assert.throws(() => f.db.rebindLocalScheduledTasksForDesktopReinstall({ clientId: task.clientId, oldDeviceId: task.deviceId, nextDeviceId: "reinstalled-device" }));
  assert.equal(mutated, true);
  assert.equal(fs.existsSync(file), mutation === "replace");
  const retained = openSqliteDb(held, { readonly: true, fileMustExist: true });
  try { assert.equal((retained.prepare("SELECT device_id FROM scheduled_task_configs").get() as {device_id: string}).device_id, task.deviceId); }
  finally { retained.close(); }
  assert.equal(f.gate.hasActiveWrites(), false);
});

test("D16 F4 existingOnly不进入坏sidecar隔离重试且保原文件名", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reinstall-no-quarantine-")), file = path.join(root, "application.db");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, "not-a-database", "utf8");
  fs.writeFileSync(`${file}-wal`, "retained-bad-wal", "utf8"); fs.writeFileSync(`${file}-shm`, "retained-bad-shm", "utf8");
  fs.writeFileSync(`${file}-journal`, "retained-bad-journal", "utf8");
  const names = fs.readdirSync(root), mainBefore = fs.readFileSync(file), walBefore = fs.readFileSync(`${file}-wal`), journalBefore = fs.readFileSync(`${file}-journal`);
  assert.throws(() => openClientDb({ dbPath: file, existingOnly: true }));
  assert.deepEqual(fs.readdirSync(root), names);
  assert.deepEqual(fs.readFileSync(file), mainBefore); assert.deepEqual(fs.readFileSync(`${file}-wal`), walBefore);
  assert.deepEqual(fs.readFileSync(`${file}-journal`), journalBefore);
});

for (const suffix of ["", "-wal", "-shm", "-journal"] as const) test(`D16 F4 existingOnly拒绝${suffix || "主库"}硬链接且不写其他文件`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reinstall-single-link-")), file = path.join(root, "application.db");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const setup = openClientDb({ dbPath: file }); setup.close();
  const target = `${file}${suffix}`;
  if (suffix) fs.writeFileSync(target, "retained-sidecar", "utf8");
  fs.linkSync(target, `${target}.linked`);
  const before = fs.readFileSync(target);
  let opened: ReturnType<typeof openClientDb> | undefined;
  try { assert.throws(() => { opened = openClientDb({ dbPath: file, existingOnly: true }); }); }
  finally { opened?.close(); }
  assert.deepEqual(fs.readFileSync(target), before);
});

test("D16 F4 写入与close双错保主副因和gate，其他工作区可用且真实关闭后才释放", async t => {
  const f = fixture(t), task = await createTask(f, f.aId), close = DatabaseSync.prototype.close, prepare = DatabaseSync.prototype.prepare;
  const file = path.join(f.a, ".codeflowai", "workspace.db"), cleanup = new Error("REINSTALL_CLOSE_FAILED");
  f.db.withLocalScheduledTasks(f.aId, repos => repos.db.exec("CREATE TRIGGER reinstall_write_failure BEFORE UPDATE OF device_id ON scheduled_task_configs BEGIN SELECT RAISE(ABORT,'REINSTALL_WRITE_FAILED'); END"));
  let closes = 0, blocked = true;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const matches = (prepare.call(this, "PRAGMA database_list").all() as Array<{file: string}>).some(row => row.file && fs.realpathSync.native(row.file) === fs.realpathSync.native(file));
    if (matches && ++closes >= 4 && blocked) throw cleanup;
    return close.call(this);
  });
  try {
    assert.throws(() => f.db.rebindLocalScheduledTasksForDesktopReinstall({ clientId: task.clientId, oldDeviceId: task.deviceId, nextDeviceId: "reinstalled-device" }), error => {
      assert.ok(error instanceof Error && error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 2); assert.strictEqual(error.cause.errors[1], cleanup);
      assert.ok(error.cause.errors[0] instanceof ScheduledTaskConfigError);
      assert.equal(error.cause.errors[0].code, "SCHEDULED_TASK_CONFIG_STORAGE_FAILED");
      return true;
    });
    assert.equal(f.gate.hasActiveWrites(), true);
    assert.throws(() => f.db.withWorkspacePrefs(f.aId, () => {}));
    f.db.withWorkspacePrefs(f.bId, () => {});
    assert.throws(() => f.db.close(), /CLIENT_DB_CLOSE_FAILED/);
    assert.equal(f.gate.hasActiveWrites(), true);
  } finally { blocked = false; f.db.close(); }
  assert.equal(f.gate.hasActiveWrites(), false);
});

/** 只在指定真实连接的定位 SQL 注入底层故障，其他 SQL 与关闭沿原实现。 */
function failMetadataRead(t: test.TestContext, file: string, fault: unknown) {
  const prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
  const state = { armed: true, reads: 0, closes: 0 };
  /** 通过原生 database_list 核物理文件，不依赖调用方传入的 scope。 */
  const matches = (db: DatabaseSync): boolean => (prepare.call(db, "PRAGMA database_list").all() as Array<{ file: string }>)
    .some(row => row.file && path.resolve(row.file) === path.resolve(file));
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    if (state.armed && /^SELECT\s+client_id\s*,\s*device_id\s+FROM\s+scheduled_task_configs\b/.test(sql.trim()) && matches(this)) {
      state.reads++; throw fault;
    }
    return prepare.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (matches(this)) state.closes++;
    return close.call(this);
  });
  return state;
}

for (const scope of ["application", "workspace"] as const) for (const kind of ["driver", "null", "undefined"] as const)
test(`LH F1 真实 ${scope} 定位故障 ${kind} 经原配置边界保因并安全失败`, async t => {
  const f = fixture(t), task = await createTask(f, scope === "workspace" ? f.aId : undefined);
  const fault = kind === "driver" ? Object.assign(new Error("PRIVATE_METADATA_BODY"), { code: "SQLITE_BUSY", errcode: 5 })
    : kind === "null" ? null : undefined;
  const file = scope === "workspace" ? path.join(f.a, ".codeflowai", "workspace.db") : path.join(f.root, "application.db");
  const injection = failMetadataRead(t, file, fault), logs: Array<Record<string, unknown>> = [];
  const logError = logger.error, workspaceLog = f.db.writeWorkspaceLog;
  t.mock.method(logger, "error", (tag: string, message: string, data?: unknown) => { logs.push(data as Record<string, unknown>); logError(tag, message, data); });
  t.mock.method(f.db, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: Parameters<typeof workspaceLog>[1]) => {
    if (entry.level === "error") logs.push(entry.data as Record<string, unknown>);
    workspaceLog(workspaceId, entry);
  });
  /** get 与 history 公开消费必须保领域上下文和原始 falsy/对象原因。 */
  const failure = (error: unknown): boolean => {
    assert.ok(error instanceof ScheduledTaskConfigError);
    assert.equal(error.code, "SCHEDULED_TASK_CONFIG_STORAGE_FAILED"); assert.equal(error.taskId, task.id);
    assert.equal(error.field, "getIdentity"); assert.equal(error.rootCauseCode, kind === "driver" ? "SQLITE_BUSY:5" : "SQLITE_ERROR");
    assert.strictEqual(error.cause, fault);
    assert.equal((error as Error & { workspaceId?: string }).workspaceId, scope === "workspace" ? f.aId : undefined);
    return true;
  };
  assert.throws(() => f.db.getLocalScheduledTask(task.id), failure);
  assert.throws(() => f.db.listLocalScheduledTaskRuns({ clientId: task.clientId, deviceId: task.deviceId,
    taskId: task.id, offset: 0, limit: 50 }), failure);
  const response = await f.call("runs", { taskId: task.id });
  assert.equal(response.status, 500); assert.equal(response.body.details.reason, "SCHEDULED_TASK_CONFIG_STORAGE_FAILED");
  assert.equal(response.body.details.field, "getIdentity"); assert.equal(logs.length, 1);
  assert.match(logs[0]!.requestId as string, /^storage-\d+$/); assert.equal(logs[0]!.taskId, task.id);
  assert.equal(logs[0]!.clientId, task.clientId); assert.equal(logs[0]!.deviceId, task.deviceId);
  assert.doesNotMatch(JSON.stringify({ logs, response }), /PRIVATE_METADATA_BODY/);
  assert.equal(injection.reads, 3); assert.equal(injection.closes, scope === "workspace" ? 3 : 0);
  assert.equal(f.gate.hasActiveWrites(), false);
  f.db.withWorkspacePrefs(f.bId, () => {});
  injection.armed = false; assert.deepEqual(f.db.getLocalScheduledTask(task.id), task);
});

test("LH F1 W 元数据故障伴随真实 close 失败保领域原因与资源 owner", async t => {
  const f = fixture(t), task = await createTask(f, f.aId), close = DatabaseSync.prototype.close;
  const cleanup = new Error("METADATA_CLOSE_FAILED"); let blocked = true, held: DatabaseSync | undefined;
  failMetadataRead(t, path.join(f.a, ".codeflowai", "workspace.db"), null);
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const target = (this.prepare("PRAGMA database_list").all() as Array<{file: string}>).some(row =>
      row.file && path.resolve(row.file) === path.resolve(f.a, ".codeflowai", "workspace.db"));
    if (blocked && target) { held = this; throw cleanup; }
    return close.call(this);
  });
  try {
    assert.throws(() => f.db.getLocalScheduledTask(task.id), error => {
      assert.ok(error instanceof Error && error.cause instanceof AggregateError);
      const combined = error.cause, primary = combined.errors[0];
      assert.equal(combined.errors.length, 2); assert.strictEqual(combined.errors[1], cleanup);
      assert.ok(primary instanceof ScheduledTaskConfigError); assert.strictEqual(combined.cause, primary);
      assert.equal(primary.code, "SCHEDULED_TASK_CONFIG_STORAGE_FAILED"); assert.equal(primary.taskId, task.id);
      assert.equal(primary.field, "getIdentity"); assert.equal(primary.rootCauseCode, "SQLITE_ERROR");
      assert.strictEqual(primary.cause, null); assert.equal((primary as Error & {workspaceId?: string}).workspaceId, f.aId);
      return true;
    });
    assert.equal(held?.isOpen, true); assert.equal(f.gate.hasActiveWrites(), true);
    f.db.withWorkspacePrefs(f.bId, () => {});
  } finally { blocked = false; f.db.close(); }
  assert.equal(held?.isOpen, false); assert.equal(f.gate.hasActiveWrites(), false);
});

test("D16 原历史 API 按当前配置归属读取应用与 A/B 的旧设备事实且零写入", async t => {
  const f = fixture(t), app = await createTask(f), a = await createTask(f, f.aId), b = await createTask(f, f.bId);
  const tasks = [app, a, b], oldRuns = tasks.map((task, index) => skipped(task, `old-${index}`, 100 + index));
  for (const [index, task] of tasks.entries()) f.db.withLocalScheduledTasks(task.workspaceScope?.scopeId as WorkspaceId ?? null, repos => {
    repos.runs.create({ run: oldRuns[index]!, expectedConfigRevision: 1 });
    repos.runtime.markStarted({ taskId: scheduledTaskRuntimeKey(task.id, "local"), clientId: task.clientId,
      deviceId: task.deviceId, scheduledAt: 100, runId: oldRuns[index]!.id, startedAt: 100 });
    if (task === a) repos.configs.delete({ taskId: task.id, expectedRevision: 1, at: task.updatedAt + 1 });
    repos.db.prepare("UPDATE scheduled_task_configs SET device_id='next-device' WHERE id=?").run(task.id);
  });
  f.db.db.prepare("UPDATE workspaces SET is_deleted=1 WHERE id=?").run(f.bId);
  f.ctx.deviceId = "next-device";
  /** 三表、注册与事件逐行快照，查询不得改写任何执行或配置事实。 */
  const facts = () => ({ sources: [null, f.aId, f.bId].map(scope => f.db.withLocalScheduledTasks(scope, repos =>
    ["scheduled_task_configs", "scheduled_task_runs", "scheduled_task_runtime_states"].map(table =>
      repos.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()), true)),
    application: ["workspaces", "conversation_events", "raw_engine_events", "thread_turns"].map(table =>
      f.db.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()) });
  const before = facts(), page = await f.call("runs");
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.total, 3, "当前设备配置必须开放同 Client 的旧设备历史");
  assert.deepEqual(page.body.items.map((run: ScheduledTaskRun) => [run.id, run.deviceId]),
    [["old-2", "storage-device"], ["old-1", "storage-device"], ["old-0", "storage-device"]]);
  for (const [index, task] of tasks.entries()) {
    const single = await f.call("runs", { taskId: task.id });
    assert.equal(single.status, 200); assert.equal(single.body.total, 1);
    assert.deepEqual(single.body.items[0], f.db.withLocalScheduledTasks(task.workspaceScope?.scopeId as WorkspaceId ?? null,
      repos => repos.runs.get(oldRuns[index]!.id), true));
  }
  assert.deepEqual(facts(), before); assert.equal(f.gate.hasActiveWrites(), false);
});

test("D16 原历史入口不解码外来归属正文，当前配置损坏仍失败", async t => {
  const f = fixture(t), current = await createTask(f), foreign = await createTask(f, f.aId);
  f.db.withLocalScheduledTasks(null, repos => {
    repos.runs.create({ run: skipped(current, "current", 100), expectedConfigRevision: 1 });
    repos.db.prepare("UPDATE scheduled_task_configs SET device_id='next-device' WHERE id=?").run(current.id);
  });
  f.db.withLocalScheduledTasks(f.aId, repos => {
    repos.runs.create({ run: skipped(foreign, "foreign", 101), expectedConfigRevision: 1 });
    repos.db.prepare("UPDATE scheduled_task_configs SET device_id='third-device',payload_json='{PRIVATE_FOREIGN_CONFIG' WHERE id=?").run(foreign.id);
    repos.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE scheduled_task_runs SET attempt='PRIVATE_FOREIGN_RUN'");
  });
  f.ctx.deviceId = "next-device";
  const page = await f.call("runs"); assert.equal(page.status, 200); assert.equal(page.body.total, 1);
  assert.deepEqual(page.body.items.map((run: ScheduledTaskRun) => run.id), ["current"]);
  const hidden = await f.call("runs", { taskId: foreign.id });
  assert.equal(hidden.status, 200); assert.deepEqual(hidden.body.items, []); assert.equal(hidden.body.total, 0);
  f.db.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db.db.prepare("UPDATE scheduled_task_configs SET workspace_scope_type='local_workspace' WHERE id=?").run(current.id);
  assert.throws(() => f.db.getLocalScheduledTask(current.id), { code: "SCHEDULED_TASK_CONFIG_CORRUPT", field: "workspaceScope" });
  for (const body of [{}, {taskId: current.id}]) {
    const response = await f.call("runs", body); assert.equal(response.status, 500);
    assert.equal(response.body.details.field, "workspaceScope");
  }
});

test("D16 ClientDb 历史拒绝空 owner 与非法任务或分页，不读取为无归属列表", t => {
  const f = fixture(t), valid = { clientId: "storage-client", deviceId: "storage-device", offset: 0, limit: 50 };
  for (const invalid of [{ clientId: "" }, { deviceId: " " }, { clientId: undefined }, { deviceId: null },
    { taskId: "" }, { taskId: " " }, { offset: -1 }, { limit: 0 }, { limit: 201 }, { offset: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => f.db.listLocalScheduledTaskRuns({ ...valid, ...invalid } as never), { code: "SCHEDULED_TASK_CONFIG_INVALID" });
  }
});

test("A/B 与应用无 scope 隔离，旧应用坏工作区行及 runtime 不参与任何新读取", async t => {
  const f = fixture(t), a = await createTask(f, f.aId), b = await createTask(f, f.bId), app = await createTask(f);
  const original = f.db.db.prepare("SELECT * FROM scheduled_task_configs WHERE id=?").get(app.id) as Record<string, unknown>;
  const columns = Object.keys(original);
  f.db.db.prepare(`INSERT INTO scheduled_task_configs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(
    ...columns.map(column => column === "id" ? "old-workspace" : column === "workspace_scope_type" ? "local_workspace"
      : column === "workspace_scope_id" ? f.aId : column === "payload_json" ? "{PRIVATE_OLD_JSON" : original[column]));
  f.db.db.prepare("INSERT INTO scheduled_task_runtime_states(task_id,client_id,device_id,running_run_id,queued_scheduled_at,queued_reason,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(scheduledTaskRuntimeKey("old-workspace", "local"), app.clientId, app.deviceId, "old-running", 1, "PRIVATE_BAD_QUEUE", 1);
  const before = f.db.db.prepare("SELECT * FROM scheduled_task_configs WHERE id='old-workspace'").get();
  assert.deepEqual((await f.call("list")).body.items.map((task: LocalScheduledTaskConfig) => task.id).sort(), [a.id,b.id,app.id].sort());
  assert.equal(f.db.getLocalScheduledTask("old-workspace"), null);
  assert.deepEqual(f.db.scheduledTaskRuntimeStates.listLocalRunning({ clientId: app.clientId, deviceId: app.deviceId }), []);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM scheduled_task_configs WHERE id='old-workspace'").get(), before);
});

test("裸 ID 和墓碑跨库碰撞时列表、历史和修改均显式冲突且零副作用", async t => {
  const f = fixture(t), task = await createTask(f,f.aId);
  f.db.withLocalScheduledTasks(f.bId,repos => repos.configs.create({config:{...task,workspaceScope:{scopeType:"local_workspace",scopeId:f.bId},
    payload:{...task.payload,contextWorkspaceId:f.bId}},at:task.createdAt}));
  f.db.withLocalScheduledTasks(f.bId,repos => repos.configs.delete({taskId:task.id,expectedRevision:1,at:task.updatedAt+1}));
  for (const [action,body] of [["list",{}],["runs",{}],["runs",{taskId:task.id}],["delete",{taskId:task.id,expectedRevision:1}]] as const) {
    const response=await f.call(action,body); assert.equal(response.status,409); assert.equal(response.body.details.field,"physical_task_id_collision");
  }
  assert.equal(f.db.withLocalScheduledTasks(f.aId,repos=>repos.configs.get(task.id))?.revision,1);
  assert.equal(f.db.withLocalScheduledTasks(f.bId,repos=>repos.configs.get(task.id))?.revision,2);
});

for (const foreign of ["application-device", "workspace-client-tombstone"] as const)
test(`D18 F1 异身份 ${foreign} 裸 ID 冲突阻止自动和手动副作用`, async t => {
  const f=fixture(t),task=await createTask(f,f.aId),scope=foreign==="application-device"?null:f.bId;
  t.mock.method(Date,"now",()=>1_800_000_005_000);
  f.db.withLocalScheduledTasks(scope,repos=>{
    repos.configs.create({at:1,config:{...task,clientId:foreign==="application-device"?task.clientId:"foreign-client",deviceId:"foreign-device",
      workspaceScope:scope?{scopeType:"local_workspace",scopeId:scope}:null,
      payload:scope?{shell:"sh",command:"true",contextWorkspaceId:scope}:{shell:"sh",command:"true"}}});
    if(scope)repos.configs.delete({taskId:task.id,expectedRevision:1,at:2});
    repos.db.prepare("UPDATE scheduled_task_configs SET payload_json='{PRIVATE_FOREIGN_CONFIG' WHERE id=?").run(task.id);
  });
  const scheduler=new ScheduledTaskScheduler({config:{clientId:task.clientId,serverWsUrl:"ws://127.0.0.1:1/ws"} as ClientConfig,
    deviceId:task.deviceId,apiContext:f.ctx,localApiContext:f.ctx});
  let http=0;const failures:unknown[]=[];
  t.mock.method(globalThis,"fetch",async()=>{http++;throw new Error("LOCAL_HTTP_FORBIDDEN");});
  /** 业务拒绝与 drain 必须保留同一原错误，不能把预期失败当清理成功。 */
  const conflict=(error:unknown):boolean=>{
    assert.equal((error as {code:string}).code,"SCHEDULED_TASK_CONFIG_CONFLICT");
    assert.equal((error as {field:string}).field,"physical_task_id_collision");failures.push(error);return true;
  };
  try {
    await assert.rejects(scheduler.syncAndTick("foreign-physical-collision"),conflict);
    await assert.rejects(scheduler.runLocalNow(task.id),conflict);
    assert.throws(()=>f.db.listLocalScheduledTaskConfigs({clientId:task.clientId,deviceId:task.deviceId}),{code:"SCHEDULED_TASK_CONFIG_CONFLICT"});
    for (const body of [{}, {taskId:task.id}]) {
      const response = await f.call("runs", body); assert.equal(response.status, 409);
      assert.equal(response.body.details.field, "physical_task_id_collision");
    }
    for(const physical of [null,f.aId,f.bId])f.db.withLocalScheduledTasks(physical,repos=>{
      assert.equal((repos.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs").get() as {n:number}).n,0);
      assert.equal((repos.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runtime_states").get() as {n:number}).n,0);
    });
    assert.equal(http,0);
  } finally { await assert.rejects(scheduler.stopAndDrain(),error=>{
    assert.ok(error instanceof AggregateError);assert.equal(error.errors.length,2);
    for(const [index,failure] of failures.entries())assert.strictEqual(error.errors[index],failure);return true;
  }); }
});

test("历史每库前 K 分块超过 200，跨库相同 runId 事实保留且页序稳定", async t => {
  const f=fixture(t), a=await createTask(f,f.aId), b=await createTask(f,f.bId);
  for (const task of [a,b]) f.db.withLocalScheduledTasks(task.workspaceScope!.scopeId as WorkspaceId,repos=>repos.db.transaction(()=>{
    for(let i=0;i<260;i++) repos.runs.create({run:skipped(task,`run-${String(i).padStart(3,"0")}`,i+1),expectedConfigRevision:1});
    repos.db.prepare("UPDATE scheduled_task_configs SET device_id='next-device' WHERE id=?").run(task.id);
  })());
  f.ctx.deviceId = "next-device";
  const page=await f.call("runs",{offset:205,limit:100}); assert.equal(page.status,200); assert.equal(page.body.total,520);
  const expected=[a,b].flatMap(task=>Array.from({length:260},(_,i)=>skipped(task,`run-${String(i).padStart(3,"0")}`,i+1)))
    .sort((x,y)=>y.createdAt-x.createdAt || (x.workspaceId!<y.workspaceId! ? -1:1)).slice(205,305);
  assert.deepEqual(page.body.items.map((run:ScheduledTaskRun)=>[run.id,run.workspaceId]),expected.map(run=>[run.id,run.workspaceId]));
  assert.equal(page.body.items.every((run: ScheduledTaskRun) => run.deviceId === "storage-device"), true);
  assert.equal((await f.call("runs",{offset:Number.MAX_SAFE_INTEGER,limit:2})).status,400);
});

test("合法无库与旧支持版本无任务不写库，新版缺表和孤 sidecar 显式失败", async t => {
  const f=fixture(t);
  assert.deepEqual((await f.call("list")).body.items,[]); assert.equal(fs.existsSync(path.join(f.a,".codeflowai")),false);
  f.db.withWorkspacePrefs(f.aId,()=>{});
  const file=path.join(f.a,".codeflowai","workspace.db"), physical=openSqliteDb(file,{fileMustExist:true});
  try { physical.exec("DROP TABLE scheduled_task_account_configs; DROP TABLE scheduled_task_configs; DROP TABLE scheduled_task_runs; DROP TABLE scheduled_task_runtime_states; PRAGMA user_version=95"); }
  finally { physical.close(); }
  assert.equal((await f.call("list")).status,200);
  const old=openSqliteDb(file,{fileMustExist:true});try { assert.equal(old.pragma("user_version",{simple:true}),95);old.pragma("user_version=96"); }finally { old.close(); }
  assert.equal((await f.call("list")).status,500);
  fs.mkdirSync(path.join(f.b,".codeflowai"));fs.writeFileSync(path.join(f.b,".codeflowai","workspace.db-wal"),"orphan","utf8");
  assert.throws(()=>f.db.listLocalScheduledRunning(f.bId,{clientId:"storage-client",deviceId:"storage-device"},null));
});

test("软删注册保留历史和已认领终态，物理根缺失不隐藏历史", async t => {
  const f=fixture(t),task=await createTask(f,f.aId),run={...skipped(task,"retained",100),status:"running" as const,startedAt:100,finishedAt:null,summary:"任务开始执行"};
  f.db.withLocalScheduledTasks(f.aId,repos=>repos.runs.create({run,expectedConfigRevision:1}));
  f.db.db.prepare("UPDATE workspaces SET is_deleted=1 WHERE id=?").run(f.aId);
  const final={...run,status:"success" as const,finishedAt:200,durationMs:100,summary:"完成"};
  f.db.withLocalScheduledTasks(f.aId,repos=>repos.runs.complete(final),true);
  assert.equal((await f.call("runs",{taskId:task.id})).body.items[0].status,"success");
  assert.throws(()=>f.db.withLocalScheduledTasks(f.aId,()=>{}));
  fs.renameSync(f.a,path.join(f.root,"detached"));
  assert.equal((await f.call("runs")).status,500);
});

test("当前 config owner 只读 running，固定延期可写且普通 CRUD 不获写豁免", async t => {
  const f=fixture(t),task=await createTask(f,f.aId),key=scheduledTaskRuntimeKey(task.id,"local");
  f.db.withLocalScheduledTasks(f.aId,repos=>repos.runtime.markStarted({taskId:key,clientId:task.clientId,deviceId:task.deviceId,scheduledAt:1,runId:"running",startedAt:1}));
  const release=await f.gate.acquireMigration(f.aId,"config:request");
  try {
    assert.deepEqual(f.db.listLocalScheduledRunning(f.aId,{clientId:task.clientId,deviceId:task.deviceId},"config:request"),[{taskId:task.id,runId:"running"}]);
    assert.throws(()=>f.db.listLocalScheduledRunning(f.aId,{clientId:task.clientId,deviceId:task.deviceId},"wrong"));
    f.db.deferLocalScheduledTask({task,operationId:"config:request",scheduledAt:120_000,at:120_000});
    assert.equal(f.db.getLocalScheduledTaskRuntime(task)?.queuedScheduledAt,120_000);
    const before=f.db.getLocalScheduledTask(task.id),failures:unknown[]=[];
    const beginWrite=f.gate.beginWrite.bind(f.gate);
    /** 保留真实 gate 拒绝对象，核业务与日志双错均未被响应成功掩盖。 */
    t.mock.method(f.gate,"beginWrite",(...args:Parameters<typeof beginWrite>)=>{
      try{return beginWrite(...args);}catch(error){failures.push(error);throw error;}
    });
    await assert.rejects(f.call("delete",{taskId:task.id,expectedRevision:1}),error=>{
      assert.ok(error instanceof AggregateError);assert.equal((error as {code?:string}).code,"SCHEDULED_TASK_REQUEST_LOG_FAILED");
      assert.equal(failures.length,2);assert.equal(error.errors.length,2);assert.strictEqual(error.cause,failures[0]);
      for(const [index,failure] of failures.entries()){
        assert.strictEqual(error.errors[index],failure);
        assert.equal((failure as {code:string}).code,"WORKSPACE_MIGRATION_IN_PROGRESS");
        assert.deepEqual((failure as {details:unknown}).details,{workspaceId:f.aId,operationId:"config:request"});
      }
      return true;
    });
    assert.deepEqual(f.db.getLocalScheduledTask(task.id),before);f.db.withWorkspacePrefs(f.bId,()=>{});
    assert.equal(f.gate.getMigrationOperationId(f.aId),"config:request");assert.equal(f.gate.hasActiveWrites(),false);
  } finally { release(); }
});

test("三表 close 失败共用原资源 owner，阻同工作区 Profile/prefs 且其他工作区仍可用", async t => {
  const f=fixture(t),task=await createTask(f,f.aId),nativeClose=DatabaseSync.prototype.close;
  const business=new Error("TASK_CALLBACK_FAILED"),cleanup=new Error("TASK_CLOSE_FAILED");let blocked=true,held:DatabaseSync|undefined;
  t.mock.method(DatabaseSync.prototype,"close",function(this:DatabaseSync){
    if (!blocked) return nativeClose.call(this);
    const matches=(this.prepare("PRAGMA database_list").all() as Array<{file:string}>).some(row=>row.file && fs.realpathSync.native(row.file)===fs.realpathSync.native(path.join(f.a,".codeflowai","workspace.db")));
    if(blocked&&matches){held=this;throw cleanup;}return nativeClose.call(this);
  });
  try {
    assert.throws(()=>f.db.withLocalScheduledTasks(f.aId,()=>{throw business;}),error=>{
      assert.ok((error as Error).cause instanceof AggregateError);assert.deepEqual(((error as Error).cause as AggregateError).errors,[business,cleanup]);return true;
    });
    assert.equal(held?.isOpen,true);assert.equal(f.gate.hasActiveWrites(),true);
    assert.throws(()=>f.db.withWorkspacePrefs(f.aId,()=>{}));assert.throws(()=>f.db.withWorkspaceExecutionProfiles(f.aId,()=>{}));
    assert.throws(()=>f.db.getLocalScheduledTaskRuntime(task));
    f.db.withWorkspacePrefs(f.bId,()=>{});
  } finally {blocked=false;f.db.close();}
  assert.equal(held?.isOpen,false);assert.equal(f.gate.hasActiveWrites(),false);
});

test("固定 skipped 水位写入被忽略时回滚历史，不释放仍未关闭的 owner", async t => {
  const f=fixture(t),task=await createTask(f,f.aId);
  f.db.withLocalScheduledTasks(f.aId,repos=>repos.db.exec("CREATE TRIGGER ignore_skip BEFORE INSERT ON scheduled_task_runtime_states BEGIN SELECT RAISE(IGNORE); END"));
  const release=await f.gate.acquireMigration(f.aId,"config:skip");
  try {
    assert.throws(()=>f.db.deferLocalScheduledTask({task,operationId:"config:skip",scheduledAt:100,at:100,skippedRun:skipped(task,"ignored",100)}));
    assert.equal(f.db.listLocalScheduledTaskRuns({clientId:task.clientId,deviceId:task.deviceId,offset:0,limit:50}).total,0);
    assert.equal(f.db.getLocalScheduledTaskRuntime(task),null);
  }finally {release();}
});

test("应用无 scope 与工作区 callback 同样拒绝异步返回",t=>{
  const f=fixture(t);
  for(const id of [null,f.aId])assert.throws(()=>f.db.withLocalScheduledTasks(id,(()=>Promise.resolve()) as never),/WORKSPACE_PROFILE_CALLBACK_MUST_BE_SYNCHRONOUS|工作区执行 Profile 存储失败/);
  assert.equal(f.gate.hasActiveWrites(),false);
});

const ACCOUNT = { serverOrigin: "http://127.0.0.1:1", ownerUserId: "owner-a", clientId: "storage-client", deviceId: "storage-device" };

test("D08 同 owner 跨 A/B/应用取最大水位且旧 bare 与异 owner 不接管", t => {
  const f = fixture(t), taskId = "account-task";
  for (const [scope, at] of [[f.aId, 10], [f.bId, 30], [null, 20]] as const) f.db.withAccountScheduledTasks(scope, repos => {
    repos.runtime.claimAccount({ taskId, owner: ACCOUNT, runId: `run-${at}`, scheduledAt: at, startedAt: at });
    repos.runtime.finishAccount({ taskId, owner: ACCOUNT, runId: `run-${at}`, finishedAt: at + 1 });
  });
  f.db.scheduledTaskRuntimeStates.markStarted({ taskId, clientId: ACCOUNT.clientId, deviceId: ACCOUNT.deviceId, runId: "old-bare", scheduledAt: 999, startedAt: 999 });
  f.db.db.prepare("INSERT INTO scheduled_task_runtime_states(task_id,client_id,device_id,updated_at) VALUES(?,?,?,?)")
    .run('__account_scheduled_task__:["http://127.0.0.1:1","other-owner","storage-client","storage-device",', ACCOUNT.clientId, ACCOUNT.deviceId, 1);
  const state = f.db.readAccountScheduledTaskState(taskId, ACCOUNT);
  assert.equal(state.lastScheduledAt, 30); assert.equal(state.running, null); assert.equal(state.locations.length, 3);
  assert.deepEqual(f.db.listAccountScheduledMigrationQueued(ACCOUNT), [], "异 owner 损坏行不能进入当前 owner 解码");
  assert.equal(f.db.scheduledTaskRuntimeStates.get(taskId)?.runningRunId, "old-bare");
});

test("D08 多 running 与多迁移延期位置显式冲突，W98 无历史仍以 runtime 阻迁移", t => {
  const f = fixture(t), taskId = "collision";
  for (const scope of [f.aId, f.bId]) f.db.withAccountScheduledTasks(scope, repos => repos.runtime.claimAccount({ taskId, owner: ACCOUNT, runId: scope, scheduledAt: 1, startedAt: 1 }));
  assert.throws(() => f.db.readAccountScheduledTaskState(taskId, ACCOUNT), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT" });
  f.db.withAccountScheduledTasks(f.bId, repos => repos.runtime.finishAccount({ taskId, owner: ACCOUNT, runId: f.bId, finishedAt: 2 }));
  for (const scope of [f.aId, f.bId]) f.db.withAccountScheduledTasks(scope, repos => repos.runtime.queueForWorkspaceMigration({
    taskId: scheduledTaskAccountRuntimeKey(taskId, ACCOUNT), clientId: ACCOUNT.clientId, deviceId: ACCOUNT.deviceId, scheduledAt: 3, operationId: "operation", at: 3 }));
  assert.throws(() => f.db.readAccountScheduledTaskState(taskId, ACCOUNT), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT" });
  const physical = openSqliteDb(path.join(f.a, ".codeflowai", "workspace.db"), { readonly: true, fileMustExist: true });
  try { assert.equal(physical.prepare("PRAGMA table_info(scheduled_task_runs)").all().length, 26); }
  finally { physical.close(); }
  assert.deepEqual(f.db.listAccountScheduledRunning(f.aId, null), [{ taskId, runId: f.aId }]);
});

test("D08 workflow 指针独立于脚本水位，最大序号重复异指针与溢出显式失败", t => {
  const f = fixture(t), taskId = "pointer";
  for (const [scope, sequence] of [[f.aId, 1], [f.bId, 2]] as const) f.db.withAccountScheduledTasks(scope, repos => {
    repos.runtime.claimAccount({ taskId, owner: ACCOUNT, runId: scope, scheduledAt: 100, startedAt: 100 });
    repos.runtime.updateAccountWorkflow({ taskId, owner: ACCOUNT, runId: scope, instanceId: `instance-${sequence}`, sequence, at: 100 });
    repos.runtime.finishAccount({ taskId, owner: ACCOUNT, runId: scope, finishedAt: 100 });
    repos.runtime.skipAccount({ taskId, owner: ACCOUNT, scheduledAt: 200 + sequence, at: 200 });
  });
  assert.equal(f.db.readAccountScheduledTaskState(taskId, ACCOUNT).lastWorkflowInstanceId, "instance-2");
  f.db.withAccountScheduledTasks(f.aId, repos => repos.db.prepare("UPDATE scheduled_task_runtime_states SET last_workflow_sequence=2 WHERE task_id=?").run(scheduledTaskAccountRuntimeKey(taskId, ACCOUNT)));
  assert.throws(() => f.db.readAccountScheduledTaskState(taskId, ACCOUNT), { code: "SCHEDULED_TASK_RUNTIME_CORRUPT" });
  f.db.withAccountScheduledTasks(f.aId, repos => {
    assert.throws(() => repos.runtime.updateAccountWorkflow({ taskId, owner: ACCOUNT, runId: f.aId, instanceId: "x", sequence: Number.MAX_SAFE_INTEGER + 1, at: 300 }), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT" });
    assert.throws(() => repos.db.prepare("UPDATE scheduled_task_runtime_states SET last_workflow_sequence=0 WHERE task_id=?").run(scheduledTaskAccountRuntimeKey(taskId, ACCOUNT)));
  });
});

test("D08 账号固定延期在迁移 owner 可写，普通写拒绝，软删仅允许捕获运行收尾", async t => {
  const f = fixture(t), taskId = "retained-account";
  f.db.withAccountScheduledTasks(f.aId, repos => repos.runtime.claimAccount({ taskId, owner: ACCOUNT, runId: "retained", scheduledAt: 1, startedAt: 1 }));
  const release = await f.gate.acquireMigration(f.aId, "config:account");
  try {
    assert.deepEqual(f.db.listAccountScheduledRunning(f.aId, "config:account"), [{ taskId, runId: "retained" }]);
    assert.throws(() => f.db.withAccountScheduledTasks(f.aId, () => {}));
    f.db.deferAccountScheduledTask({ workspaceId: f.aId, taskId, owner: ACCOUNT, operationId: "config:account", scheduledAt: 2, at: 2, skipped: false });
  } finally { release(); }
  f.db.db.prepare("UPDATE workspaces SET is_deleted=1 WHERE id=?").run(f.aId);
  assert.throws(() => f.db.withAccountScheduledTasks(f.aId, () => {}));
  f.db.withAccountScheduledTasks(f.aId, repos => repos.runtime.finishAccount({ taskId, owner: ACCOUNT, runId: "retained", finishedAt: 3 }), true);
  assert.equal(f.db.readAccountScheduledTaskState(taskId, ACCOUNT).running, null);
  for (const scope of [null, f.bId]) assert.throws(() => f.db.withAccountScheduledTasks(scope, (() => Promise.resolve()) as never));
});

test("D08 账号 callback 与 close 失败保双因并持有原 gate，其他工作区仍可用", t => {
  const f = fixture(t), originalClose = DatabaseSync.prototype.close;
  const business = new Error("ACCOUNT_CALLBACK_FAILED"), close = new Error("ACCOUNT_CLOSE_FAILED");
  f.db.withAccountScheduledTasks(f.aId, () => {});
  let held: DatabaseSync | undefined, blocked = true;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (!blocked) return originalClose.call(this);
    const owns = (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file && fs.realpathSync.native(row.file) === fs.realpathSync.native(path.join(f.a, ".codeflowai", "workspace.db")));
    if (blocked && owns) { held = this; throw close; }
    return originalClose.call(this);
  });
  try {
    assert.throws(() => f.db.withAccountScheduledTasks(f.aId, () => { throw business; }), error => {
      assert.ok((error as Error).cause instanceof AggregateError); assert.deepEqual(((error as Error).cause as AggregateError).errors, [business, close]); return true;
    });
    assert.equal(held?.isOpen, true); assert.equal(f.gate.hasActiveWrites(), true);
    assert.throws(() => f.db.readAccountScheduledTaskState("close", ACCOUNT));
    f.db.withAccountScheduledTasks(f.bId, () => {});
  } finally { blocked = false; f.db.close(); }
  assert.equal(held?.isOpen, false); assert.equal(f.gate.hasActiveWrites(), false);
});

/** 账号skipped沿原运行形状，只由显式owner和物理位置决定隔离。 */
function accountSkipped(workspaceId: WorkspaceId | null, id: string, at: number): ScheduledTaskRun {
  return { id, taskId: "account-task", clientId: ACCOUNT.clientId, deviceId: ACCOUNT.deviceId, workspaceId,
    workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null, scheduledAt: at, startedAt: null,
    finishedAt: at, status: "skipped", triggerSource: "schedule", attempt: 1, durationMs: null,
    summary: "账号跳过", errorMessage: null, outputExcerpt: null, createdAt: at };
}

test("D08 account pending跨A/B/应用稳定合页，同ID已结算或页外冲突均拒绝", t => {
  const f = fixture(t);
  for (const [scope,id,at] of [[f.aId,"a",2],[f.bId,"b",1],[null,"c",2]] as const) f.db.withAccountScheduledTasks(scope,
    repos => repos.runs.createAccount({ run: accountSkipped(scope,id,at), owner: ACCOUNT, taskName: "pending" }));
  assert.deepEqual(f.db.listPendingAccountScheduledTaskRuns(ACCOUNT,2).map(item => [item.workspaceId,item.run.id]), [[f.bId,"b"],[f.aId,"a"]]);
  f.db.withAccountScheduledTasks(f.bId, repos => {
    repos.runs.createAccount({ run: accountSkipped(f.bId,"a",99), owner: ACCOUNT, taskName: "settled collision" });
    repos.runs.acknowledgeAccount("a", ACCOUNT,100);
  });
  assert.throws(() => f.db.getAccountScheduledTaskRun("a", ACCOUNT), { code:"SCHEDULED_TASK_RUN_CONFLICT",field:"physical_run_id_collision" });
  assert.throws(() => f.db.listPendingAccountScheduledTaskRuns(ACCOUNT,2), { code:"SCHEDULED_TASK_RUN_CONFLICT",field:"physical_run_id_collision" });
  assert.equal(f.db.withAccountScheduledTasks(f.aId,repos=>repos.runs.getAccount("a",ACCOUNT))?.reportSettlement,null);
});

test("D08 account SQL先隔scope及owner，异owner/local坏正文与旧应用W行不被接管", async t => {
  const f = fixture(t), local = await createTask(f,f.bId), foreign = {...ACCOUNT,ownerUserId:"foreign"};
  f.db.withAccountScheduledTasks(f.aId,repos=>repos.runs.createAccount({run:accountSkipped(f.aId,"same",1),owner:ACCOUNT,taskName:"current"}));
  f.db.withLocalScheduledTasks(f.bId,repos=> {
    repos.runs.create({run:{...skipped(local,"same",1)},expectedConfigRevision:1});
    repos.runs.createAccount({run:accountSkipped(f.bId,"foreign",2),owner:foreign,taskName:"foreign"});
    repos.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE scheduled_task_runs SET attempt='PRIVATE_BAD_BODY'");
    assert.throws(()=>repos.runs.getAccount("foreign",ACCOUNT),{code:"SCHEDULED_TASK_RUN_CONFLICT",field:"owner"});
  });
  assert.equal(f.db.getAccountScheduledTaskRun("same",ACCOUNT)?.workspaceId,f.aId);
  assert.deepEqual(f.db.listPendingAccountScheduledTaskRuns(ACCOUNT).map(item=>item.run.id),["same"]);
  f.db.scheduledTaskRuns.createAccount({run:accountSkipped(null,"legacy",3),owner:ACCOUNT,taskName:"legacy"});
  f.db.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db.db.prepare("UPDATE scheduled_task_runs SET workspace_id=?,attempt='PRIVATE_BAD_BODY' WHERE id='legacy'").run(f.aId);
  assert.equal(f.db.scheduledTaskRuns.getAccount("legacy",ACCOUNT),null);
  assert.equal(f.db.getAccountScheduledTaskRun("legacy",ACCOUNT),null);
  assert.deepEqual(f.db.listPendingAccountScheduledTaskRuns(ACCOUNT).map(item=>item.run.id),["same"]);
  f.db.db.exec("PRAGMA ignore_check_constraints=OFF");
  assert.throws(()=>f.db.scheduledTaskRuns.createAccount({run:accountSkipped(null,"legacy",3),owner:ACCOUNT,taskName:"collision"}),{code:"SCHEDULED_TASK_RUN_STORAGE_FAILED"});
  assert.equal((f.db.db.prepare("SELECT attempt FROM scheduled_task_runs WHERE id='legacy'").get() as {attempt:string}).attempt,"PRIVATE_BAD_BODY");
});

test("D08 W98 Inspector不依当前配置或账号，严格核关联历史并保无run workflow阻断", t => {
  const f=fixture(t),run={...accountSkipped(f.aId,"inspector",1),status:"running",startedAt:1,finishedAt:null,summary:"运行"} as ScheduledTaskRun;
  f.db.withAccountScheduledTasks(f.aId,repos=>{
    repos.runs.createAccount({run,owner:ACCOUNT,taskName:"inspector"});
    repos.runtime.claimAccount({taskId:run.taskId,owner:ACCOUNT,runId:run.id,scheduledAt:1,startedAt:1});
  });
  f.db.workspaces.delete(f.aId);
  assert.deepEqual(f.db.listAccountScheduledRunning(f.aId,null),[{taskId:run.taskId,runId:run.id}]);
  f.db.withAccountScheduledTasks(f.aId,repos=>repos.runs.completeAccount({...run,status:"success",finishedAt:2,durationMs:1},ACCOUNT),true);
  assert.throws(()=>f.db.listAccountScheduledRunning(f.aId,null),{code:"SCHEDULED_TASK_RUN_CONFLICT",field:"runtime_run"});
});
