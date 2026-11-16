import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { DesktopApiRequest, WorkspaceId, WorkflowId } from "@codeflowai/shared";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { ScheduledTaskConfigRepo } from "../src/db/repos/scheduledTaskConfigRepo.js";
import { ScheduledTaskRunRepo } from "../src/db/repos/scheduledTaskRunRepo.js";
import { ScheduledTaskRuntimeStateRepo, scheduledTaskRuntimeKey } from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { createDesktopLifecycle, readDesktopClientHealth } from "../src/runtime/desktopLifecycle.js";
import { createDesktopUpdateControl } from "../src/runtime/desktopUpdateControl.js";
import { logger } from "../src/logger.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { createClientDbOrchAssetLegacyRuntimeReader, OrchAssetAuthorityRuntimeReadService } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { OrchAssetLaunchSnapshotService } from "../src/orchestration/orchAssetLaunchSnapshotService.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";

test("桌面任务配置在真实Writer短许可内CRUD，存储失败诊断同样取得许可", async t => {
  const f = fixture(t);
  const writer = new ClientDbWriterService({ db: f.appDb, dbPath: path.join(f.root, "client.db"), onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    f.ctx.withDatabase = (requestId, operation) => writer.withLegacyDatabase(requestId, operation);
    const task = await create(f);
    assert.equal((await f.call("list")).status, 200);
    assert.equal((await f.call("runs", { taskId: task.id })).status, 200);
    assert.equal((await f.call("setEnabled", { taskId: task.id, expectedRevision: 1, enabled: false })).status, 200);
    assert.equal((await f.call("update", { ...input(), taskId: task.id, expectedRevision: 2 })).status, 200);
    assert.equal((await f.call("delete", { taskId: task.id, expectedRevision: 3 })).status, 200);
    assert.equal((await f.call("create", input({ cronExpr: "invalid" }))).status, 400);
  } finally { await writer.close(); }
});

const CLIENT = "bridge-client", DEVICE = "bridge-device", WORKSPACE = "bridge-client:workspace" as WorkspaceId;

/** 测试沿原固定 W 边界捕获日志，未指定级别继续真实写入。 */
function mockWorkspaceLog(t: test.TestContext, f: ReturnType<typeof fixture>, level: "error" | "warn", logs: any[][]): void {
  const write = f.appDb.writeWorkspaceLog;
  t.mock.method(f.appDb, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: Parameters<typeof write>[1]) => {
    if (entry.level === level) logs.push([entry.tag, entry.message, entry.data]);
    else write(workspaceId, entry);
  });
}

test("LSLOG create 核 W 后 cron 失败仅写 A，日志双错经真实 executor 保因", async t => {
  const f = fixture(t), entries: Array<{ workspaceId: WorkspaceId; entry: any }> = [];
  const logError = new Error("PRIVATE_REQUEST_LOG_FAILURE");
  t.mock.method(f.appDb, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: Parameters<typeof f.appDb.writeWorkspaceLog>[1]) => { entries.push({ workspaceId, entry }); throw logError; });
  await assert.rejects(f.call("create", input({ cronExpr: "not cron" })), error => {
    assert.ok(error instanceof AggregateError); assert.equal((error as AggregateError & { code: string }).code, "SCHEDULED_TASK_REQUEST_LOG_FAILED");
    assert.equal(error.errors[1], logError); assert.equal(error.cause, error.errors[0]);
    assert.equal(error.errors[0].reason, "SCHEDULED_TASK_LOCAL_CRON_INVALID"); return true;
  });
  assert.equal(entries.length, 1); assert.equal(entries[0]!.workspaceId, WORKSPACE);
  assert.equal(entries[0]!.entry.data.requestId, "local-task-1"); assert.equal(f.sent.length, 0);
});

test("LSLOG 无 W 与未知请求保应用，伪造 workspaceId 和访问器不改变落点", async t => {
  const f = fixture(t), writes: unknown[] = [], app: any[][] = []; let getters = 0;
  t.mock.method(f.appDb, "writeWorkspaceLog", (...args: unknown[]) => { writes.push(args); });
  t.mock.method(logger, "error", (...args: unknown[]) => { app.push(args); }); t.mock.method(logger, "warn", (...args: unknown[]) => { app.push(args); });
  assert.equal((await f.call("create", input({ cronExpr: "bad cron", payload: { shell: "sh", command: "PRIVATE_无W_🔒" } }))).status, 400);
  assert.equal((await f.call("runNow", { taskId: "unknown" })).status, 404);
  const failure = Object.create(null, { code: { get() { getters++; throw new Error("PRIVATE_GETTER"); } },
    workspaceId: { value: WORKSPACE }, toString: { value() { getters++; return "PRIVATE_BODY"; } } });
  t.mock.method(f.appDb, "listLocalScheduledTaskConfigs", () => { throw failure; });
  assert.equal((await f.call("list")).status, 500);
  assert.equal(getters, 0); assert.equal(writes.length, 0); assert.equal(app.length, 3); assert.doesNotMatch(JSON.stringify(app), /PRIVATE_|🔒/);
});

/** 各例只使用临时 SQLite 和原 Scheduler，任何 HTTP 都使本例失败。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-local-task-bridge-"));
  const gate = new WorkspaceOperationGate();
  let db = openClientDb({ dbPath: path.join(root, "client.db"), workspaceOperationGate: gate });
  db.workspaces.upsert({ id: WORKSPACE, title: "本机桥", path: root });
  /** 测试直接注入和断言均使用实际任务库，产品 ctx 始终保留原 ClientDb。 */
  const openTaskDb = () => {
    db.withLocalScheduledTasks(WORKSPACE, () => {});
    const storage = openSqliteDb(path.join(root, ".codeflowai", "workspace.db"), { fileMustExist: true });
    const runtime = new ScheduledTaskRuntimeStateRepo(storage, WORKSPACE), configs = new ScheduledTaskConfigRepo(storage, runtime, WORKSPACE);
    return { ...db, db: storage, scheduledTaskConfigs: configs, scheduledTaskRuntimeStates: runtime,
      scheduledTaskRuns: new ScheduledTaskRunRepo(storage, configs) };
  };
  let taskDb = openTaskDb();
  const sent: unknown[] = [];
  const ctx = { db, workspaceOperationGate: gate, clientId: CLIENT, deviceId: DEVICE, localWorkspaceOnly: true, workspaces: new Map([[WORKSPACE, root]]),
    sessions: {}, controlledExperiments: { hasInFlightWork: () => false, stopForUpdate: async () => {} },
    send: (message: unknown) => { sent.push(message); },
  } as unknown as ApiHandlerContext;
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: CLIENT, serverWsUrl: "ws://127.0.0.1:1/ws", apiKey: "" } as ClientConfig,
    deviceId: DEVICE, apiContext: ctx, localApiContext: ctx, isTaskAdmissionPaused: () => ctx.isTaskAdmissionPaused?.() ?? false });
  ctx.scheduledTaskScheduler = scheduler;
  let http = 0, sequence = 0;
  t.mock.method(globalThis, "fetch", async () => { http++; throw new Error("LOCAL_TASK_MUST_NOT_USE_HTTP"); });
  t.after(async () => { await scheduler.stopAndDrain(); taskDb.db.close(); db.close(); fs.rmSync(root, { recursive: true }); assert.equal(http, 0); });
  return { root, ctx, scheduler, sent, get db() { return taskDb; }, get appDb() { return db; },
    /** 重开相同临时数据库，证明桥接写入不依赖内存列表。 */
    reopen() { taskDb.db.close(); db.close(); db = openClientDb({ dbPath: path.join(root, "client.db"), workspaceOperationGate: gate }); ctx.db = db; taskDb = openTaskDb(); },
    /** 请求走真实桌面白名单和唯一中央分发器。 */
    async call(method: string, body: Record<string, unknown> = {}) {
      return await executeDesktopApiRequest(ctx, { method: `scheduledTasks.local.${method}`, body } as DesktopApiRequest,
        { requestId: `local-task-${++sequence}`, clientVersion: "1.0.0", startedAt: 1 }) as { status: number; body: any };
    },
  };
}

/** 创建参数只包含可编辑字段，所有身份均应由 Host 派生。 */
function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "本机任务", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "powershell" : "sh", contextWorkspaceId: WORKSPACE,
      command: process.platform === "win32" ? "[IO.File]::AppendAllText((Join-Path (Get-Location) 'executed'), 'run' + [Environment]::NewLine)" : "echo run >> executed" },
    concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 10_000, ...overrides };
}

/** 从真实成功响应取配置，失败时优先给出原响应。 */
async function create(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const response = await f.call("create", input(overrides));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.task as import("@codeflowai/shared").LocalScheduledTaskConfig;
}

test("免账号桥完整 CRUD/CAS 重开后仍保留真实墓碑和历史", async t => {
  const f = fixture(t), task = await create(f);
  assert.match(task.id, /^[0-9a-f-]{36}$/);
  assert.equal(task.source, "local"); assert.equal(task.clientId, CLIENT); assert.equal(task.deviceId, DEVICE);
  assert.deepEqual(task.workspaceScope, { scopeType: "local_workspace", scopeId: WORKSPACE });
  assert.equal("ownerUserId" in task, false);
  const executed = await f.call("runNow", { taskId: task.id });
  assert.equal(executed.status, 200); assert.equal(executed.body.run.status, "success");
  assert.equal(fs.readFileSync(path.join(f.root, "executed"), "utf8").trim(), "run");
  const revised = await f.call("update", { ...input({ name: "修订后" }), taskId: task.id, expectedRevision: 1 });
  assert.equal(revised.status, 200); assert.equal(revised.body.task.revision, 2);
  const conflict = await f.call("setEnabled", { taskId: task.id, expectedRevision: 1, enabled: false });
  assert.equal(conflict.status, 409); assert.equal(f.db.scheduledTaskConfigs.get(task.id)?.enabled, true);
  const stopped = await f.call("setEnabled", { taskId: task.id, expectedRevision: 2, enabled: false });
  assert.equal(stopped.status, 200); assert.equal(stopped.body.task.revision, 3);
  f.reopen();
  const list = await f.call("list", { enabled: false, taskType: "script", offset: 0, limit: 1 });
  assert.equal(list.status, 200); assert.equal(list.body.total, 1); assert.equal(list.body.items[0].name, "修订后");
  const deleted = await f.call("delete", { taskId: task.id, expectedRevision: 3 });
  assert.equal(deleted.status, 200); assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.task.revision, 4); assert.ok(deleted.body.task.deletedAt); assert.equal(deleted.body.task.enabled, false);
  assert.deepEqual((await f.call("list")).body.items, []);
  const history = await f.call("runs", { taskId: task.id });
  assert.equal(history.status, 200); assert.equal(history.body.total, 1); assert.equal(history.body.items[0].configRevision, 1);
  assert.equal(history.body.items[0].taskNameSnapshot, "本机任务");
});

for (const field of ["id", "source", "clientId", "deviceId", "ownerUserId", "workspaceScope", "actorUserId", "executionProfileScope"]) {
  test(`renderer 不得声明任务可信字段 ${field}`, async t => {
    const f = fixture(t);
    assert.equal((await f.call("create", { ...input(), [field]: "forged" })).status, 400);
    assert.equal(f.db.scheduledTaskConfigs.list({ clientId: CLIENT, deviceId: DEVICE }).length, 0);
  });
}

for (const workspace of ["shared:workspace", "foreign:workspace", "workspace", `${WORKSPACE}:alias`]) test(`拒绝非精确本机 scope ${workspace}`, async t => {
  const f = fixture(t), payload = input().payload as Record<string, unknown>;
  assert.equal((await f.call("create", input({ payload: { ...payload, contextWorkspaceId: workspace } }))).status, 400);
});

test("持久化 path 和运行 Map 不一致时拒绝，脚本可显式无 scope", async t => {
  const f = fixture(t);
  f.ctx.workspaces.set(WORKSPACE, path.join(f.root, "other"));
  assert.equal((await f.call("create", input())).status, 404);
  const task = await create(f, { payload: { shell: "sh", command: "echo local" } });
  assert.equal(task.workspaceScope, null);
});

for (const missing of ["device", "local", "both"] as const) test(`中央本机入口拒绝缺少可信上下文 ${missing}`, async t => {
  const f = fixture(t), sent: any[] = [];
  const ctx = { ...f.ctx, send: (message: unknown) => { sent.push(message); } };
  if (missing !== "local") delete ctx.deviceId;
  if (missing !== "device") delete ctx.localWorkspaceOnly;
  await handleApiRequest(ctx, { t: "api.req", id: "server-forgery", method: "scheduledTasks.local.create", path: "/server", body: input() });
  assert.equal(sent[0].status, 403); assert.equal(sent[0].body.code, "FORBIDDEN");
  assert.equal(f.db.scheduledTaskConfigs.list({ clientId: CLIENT, deviceId: DEVICE }).length, 0);
});

test("跨设备配置不能编辑或执行，列表和历史只查可信设备", async t => {
  const f = fixture(t), own = await create(f);
  f.db.scheduledTaskConfigs.create({ config: { ...own, id: "foreign", deviceId: "other" }, at: Date.now() });
  for (const [method, body] of [["runNow", { taskId: "foreign" }], ["delete", { taskId: "foreign", expectedRevision: 1 }],
    ["setEnabled", { taskId: "foreign", expectedRevision: 1, enabled: false }], ["update", { ...input(), taskId: "foreign", expectedRevision: 1 }]] as const) {
    assert.equal((await f.call(method, body)).status, 404);
  }
  assert.equal((await f.call("list")).body.total, 1);
  assert.deepEqual((await f.call("runs", { taskId: "foreign" })).body, { ok: true, items: [], total: 0 });
  assert.equal(f.db.scheduledTaskConfigs.get("foreign")?.revision, 1);
});

test("修改 scope 由原仓储归属锁拒绝且零写入", async t => {
  const f = fixture(t), task = await create(f), other = `${CLIENT}:other` as WorkspaceId;
  f.db.workspaces.upsert({ id: other, title: "Other", path: f.root }); f.ctx.workspaces.set(other, f.root);
  const changed = await f.call("update", { ...input({ payload: { ...(input().payload as object), contextWorkspaceId: other } }), taskId: task.id, expectedRevision: 1 });
  assert.equal(changed.status, 409); assert.equal(changed.body.details.reason, "SCHEDULED_TASK_CONFIG_OWNERSHIP_IMMUTABLE");
  assert.deepEqual(f.db.scheduledTaskConfigs.get(task.id), task);
});

test("保存工作区路径必须与原 Scheduler 的精确口径一致", async t => {
  const f = fixture(t);
  f.ctx.workspaces.set(WORKSPACE, `${f.root}${path.sep}.`);
  assert.equal((await f.call("create", input())).status, 404);
  assert.equal(f.db.scheduledTaskConfigs.list({ clientId: CLIENT, deviceId: DEVICE }).length, 0);
});

test("未知 Intl 故障不能伪装 cron 输入错误或有效的预览响应", async t => {
  const f = fixture(t), failure = new Error("PRIVATE_INTL_FAILURE"), logs: any[][] = [];
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  mockWorkspaceLog(t, f, "error", logs);
  t.mock.method(Intl, "DateTimeFormat", () => { throw failure; });
  const save = await f.call("create", input());
  const preview = await f.call("cronPreview", { cronExpr: "* * * * *", timezone: "UTC" });
  assert.equal(save.status, 500); assert.equal(preview.status, 500);
  assert.equal(save.body.code, "INTERNAL_ERROR"); assert.equal(preview.body.code, "INTERNAL_ERROR");
  assert.equal(logs.length, 2); assert.equal(typeof logs[0][2].rootCause.fingerprint, "string");
  assert.doesNotMatch(JSON.stringify({ logs, save, preview }), /PRIVATE_INTL_FAILURE/);
});

test("可判定 cron 输入失败保留安全 cause，预览失败也有所属诊断", async t => {
  const f = fixture(t), logs: any[][] = [];
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  mockWorkspaceLog(t, f, "warn", logs);
  assert.equal((await f.call("create", input({ cronExpr: "0 0 31 2 *" }))).status, 400);
  const preview = await f.call("cronPreview", { cronExpr: "0 0 31 2 *" });
  assert.equal(preview.status, 200); assert.equal(preview.body.valid, false);
  assert.equal(logs.length, 2);
  assert.equal(typeof logs[0][2].rootCause.cause.fingerprint, "string");
  assert.equal(typeof logs[1][2].rootCause.cause.fingerprint, "string");
});

for (const bad of [{ cronExpr: "0 0 31 2 *" }, { timezone: "Invalid/Zone" }, { timezone: " UTC " }, { timeoutMs: 0 },
  { payload: { shell: "sh", command: "echo local", workspaceScope: { scopeType: "shared_workspace", scopeId: "forged" } } }]) {
  test(`无可执行点或非法配置保存失败 ${JSON.stringify(bad)}`, async t => {
    const f = fixture(t), response = await f.call("create", input(bad));
    assert.equal(response.status, 400); assert.equal(response.body.code, "BAD_REQUEST");
    assert.equal(f.db.scheduledTaskConfigs.list({ clientId: CLIENT, deviceId: DEVICE }).length, 0);
  });
}

test("cronPreview 沿原 DTO；不可执行表达式明确 valid=false", async t => {
  const f = fixture(t);
  const preview = await f.call("cronPreview", { cronExpr: "0 0 * * *", timezone: "UTC", count: 2, afterMs: Date.UTC(2026, 9, 25, 1) });
  assert.equal(preview.status, 200); assert.deepEqual(preview.body, { ok: true, valid: true, message: null, nextRunAts: [Date.UTC(2026, 9, 26), Date.UTC(2026, 9, 27)] });
  const impossible = await f.call("cronPreview", { cronExpr: "0 0 31 2 *" });
  assert.equal(impossible.status, 200); assert.equal(impossible.body.valid, false); assert.deepEqual(impossible.body.nextRunAts, []);
  assert.equal((await f.call("cronPreview", { cronExpr: "* * * * *", count: "2" })).status, 400);
});

test("坏记录和存储错误返回固定失败并仅记录一次安全 requestId 诊断", async t => {
  const f = fixture(t), task = await create(f), logs: any[][] = [];
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  mockWorkspaceLog(t, f, "error", logs);
  f.db.db.prepare("UPDATE scheduled_task_configs SET payload_json = ? WHERE id = ?").run("PRIVATE_SQL_SCRIPT_SECRET", task.id);
  const response = await f.call("list");
  assert.equal(response.status, 500); assert.equal(response.body.code, "INTERNAL_ERROR");
  assert.equal(response.body.details.reason, "SCHEDULED_TASK_CONFIG_CORRUPT");
  assert.equal(logs.length, 1); assert.equal(logs[0][2].requestId, "local-task-2");
  assert.equal(logs[0][2].taskId, task.id); assert.equal(logs[0][2].deviceId, DEVICE);
  assert.doesNotMatch(JSON.stringify({ logs, response }), /PRIVATE_SQL_SCRIPT_SECRET|AppendAllText/);
});

test("运行记录损坏和 SQLite 写入失败显式失败，固定日志不泄露正文", async t => {
  const f = fixture(t), task = await create(f), logs: any[][] = [];
  await f.call("runNow", { taskId: task.id });
  t.mock.method(logger, "error", (...args: any[]) => { logs.push(args); });
  mockWorkspaceLog(t, f, "error", logs);
  f.db.db.prepare("UPDATE scheduled_task_runs SET workflow_version = ? WHERE task_id = ?").run("PRIVATE_BAD_RUN", task.id);
  const history = await f.call("runs", { taskId: task.id });
  assert.equal(history.status, 500); assert.equal(history.body.details.reason, "SCHEDULED_TASK_RUN_CORRUPT");
  f.db.db.exec("CREATE TRIGGER fail_local_create BEFORE INSERT ON scheduled_task_configs BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL_TRIGGER'); END");
  const write = await f.call("create", input());
  assert.equal(write.status, 500); assert.equal(write.body.details.reason, "SCHEDULED_TASK_CONFIG_STORAGE_FAILED");
  assert.equal(f.db.scheduledTaskConfigs.list({ clientId: CLIENT, deviceId: DEVICE }).length, 1);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(log => log[2].requestId), ["local-task-3", "local-task-4"]);
  assert.doesNotMatch(JSON.stringify({ logs, history, write }), /PRIVATE_BAD_RUN|PRIVATE_SQL_TRIGGER|AppendAllText/);
});

test("创建缺少原必填字段不得补默认，坏分页不得宽松转换", async t => {
  const f = fixture(t);
  for (const field of Object.keys(input())) {
    const missing = input(); delete missing[field];
    assert.equal((await f.call("create", missing)).status, 400, field);
  }
  for (const query of [{ offset: -1 }, { limit: 0 }, { limit: 201 }, { offset: "0" }, { limit: null }]) {
    assert.equal((await f.call("list", query)).status, 400);
    assert.equal((await f.call("runs", query)).status, 400);
  }
  assert.equal(f.db.scheduledTaskConfigs.list({ clientId: CLIENT, deviceId: DEVICE }).length, 0);
});

test("无法执行的当前配置不能重新启用，但停用和删除不依赖 next 扫描", async t => {
  const f = fixture(t), task = await create(f);
  f.db.db.prepare("UPDATE scheduled_task_configs SET cron_expr = ? WHERE id = ?").run("0 0 31 2 *", task.id);
  assert.equal((await f.call("setEnabled", { taskId: task.id, expectedRevision: 1, enabled: false })).status, 200);
  assert.equal((await f.call("setEnabled", { taskId: task.id, expectedRevision: 2, enabled: true })).status, 400);
  assert.equal(f.db.scheduledTaskConfigs.get(task.id)?.revision, 2);
  assert.equal((await f.call("delete", { taskId: task.id, expectedRevision: 2 })).status, 200);
});

test("runNow 进入异步准备后发生更新暂停时必须零认领零派发", async t => {
  const f = fixture(t), task = await create(f);
  let entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const runLocalNow = f.scheduler.runLocalNow.bind(f.scheduler);
  t.mock.method(f.scheduler, "runLocalNow", (taskId: string) => { const work = runLocalNow(taskId); entered(); return work; });
  const pending = f.call("runNow", { taskId: task.id });
  await preparing;
  f.ctx.isTaskAdmissionPaused = () => true;
  const response = await pending;
  await assert.rejects(f.scheduler.waitForInFlightWork(), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
  assert.equal(response.status, 409); assert.equal(response.body.code, "CONFLICT");
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
});

test("工作区迁移门禁保原业务原因和日志拒写双因，零历史零派发", async t => {
  const f = fixture(t), task = await create(f), logs: any[][] = [];
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  const gate = f.ctx.workspaceOperationGate!, release = gate.restoreMigration(WORKSPACE, "migration-owner");
  f.ctx.workspaceOperationGate = gate;
  try {
    await assert.rejects(f.call("runNow", { taskId: task.id }), error => {
      assert.ok(error instanceof AggregateError); assert.equal((error as AggregateError & { code: string }).code, "SCHEDULED_TASK_REQUEST_LOG_FAILED");
      assert.equal(error.errors[0].code, "WORKSPACE_MIGRATION_IN_PROGRESS"); assert.equal(error.errors[1].code, "WORKSPACE_MIGRATION_IN_PROGRESS");
      assert.equal(error.errors[0].details.operationId, "migration-owner"); return true;
    });
    await assert.rejects(f.scheduler.waitForInFlightWork(), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
    assert.equal(f.db.scheduledTaskRuns.list({}).total, 0); assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
    assert.equal(logs.length, 0);
  } finally { release(); }
});

test("配置和运行不依赖遗留同步状态，更新暂停仍挡新执行", async t => {
  const f = fixture(t);
  const task = await create(f);
  assert.equal((await f.call("list")).status, 200); assert.equal((await f.call("runs")).status, 200);
  assert.equal((await f.call("cronPreview", { cronExpr: "* * * * *", count: 1 })).status, 200);
  const executed = await f.call("runNow", { taskId: task.id });
  assert.equal(executed.status, 200);
  assert.equal(executed.body.run.status, "success");
  f.ctx.isTaskAdmissionPaused = () => true;
  assert.equal((await f.call("runNow", { taskId: task.id })).status, 409);
  const stopped = await f.call("setEnabled", { taskId: task.id, expectedRevision: 1, enabled: false });
  assert.equal(stopped.status, 200);
  assert.equal((await f.call("update", { ...input({ enabled: false }), taskId: task.id, expectedRevision: 2 })).status, 200);
  assert.equal((await f.call("delete", { taskId: task.id, expectedRevision: 3 })).status, 200);
});

test("执行失败以原 run 事实返回，调度缺失明确 503", async t => {
  const f = fixture(t), task = await create(f, { payload: { shell: process.platform === "win32" ? "powershell" : "sh", command: "exit 7" } });
  const result = await f.call("runNow", { taskId: task.id });
  assert.equal(result.status, 200); assert.equal(result.body.run.status, "failed");
  assert.equal(f.appDb.listLocalScheduledTaskRuns({ clientId: CLIENT, deviceId: DEVICE, offset: 0, limit: 50 }).items.find(run => run.id === result.body.run.id)?.status, "failed");
  delete f.ctx.scheduledTaskScheduler;
  const missing = await f.call("runNow", { taskId: task.id });
  assert.equal(missing.status, 503); assert.equal(missing.body.code, "INTERNAL_ERROR");
  assert.equal(missing.body.details.reason, "SCHEDULED_TASK_SCHEDULER_UNAVAILABLE");
});

test("本机脚本超时响应保留原 timeout 事实与耐久历史", async t => {
  const f = fixture(t), task = await create(f, { payload: waitingPayload(), timeoutMs: 20 });
  const response = await f.call("runNow", { taskId: task.id });
  assert.equal(response.status, 200); assert.equal(response.body.run.status, "timeout");
  assert.equal(f.db.scheduledTaskRuns.get(response.body.run.id)?.status, "timeout");
  assert.equal(f.scheduler.hasInFlightWork(), false);
});

/** 等待真实受控脚本进入执行，超时直接失败而不继续后续断言。 */
async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!fs.existsSync(file)) { assert.ok(Date.now() < deadline, "script start not observed"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

/** 脚本只通过本例文件门闩结束，更新确认沿原进程 owner 中断。 */
function waitingPayload() {
  return { shell: process.platform === "win32" ? "powershell" : "sh", contextWorkspaceId: WORKSPACE,
    command: process.platform === "win32"
      ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'started'), 'ok'); while (!(Test-Path released)) { Start-Sleep -Milliseconds 20 }; [IO.File]::AppendAllText((Join-Path (Get-Location) 'executed'), 'first' + [Environment]::NewLine)"
      : "touch started; while [ ! -e released ]; do sleep .05; done; echo first >> executed" };
}

test("桥接停用再启用原子消费旧 queue_one，不补跑旧分钟", async t => {
  const f = fixture(t), task = await create(f, { payload: waitingPayload() });
  const pending = f.call("runNow", { taskId: task.id });
  await waitForFile(path.join(f.root, "started"));
  try {
    await f.scheduler.syncAndTick("queue-while-running");
    assert.ok(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey(task.id, "local"))?.queuedScheduledAt);
    assert.equal((await f.call("setEnabled", { taskId: task.id, expectedRevision: 1, enabled: false })).status, 200);
    assert.equal((await f.call("setEnabled", { taskId: task.id, expectedRevision: 2, enabled: true })).status, 200);
  } finally { fs.writeFileSync(path.join(f.root, "released"), "ok"); await pending; }
  await f.scheduler.waitForInFlightWork(); await f.scheduler.syncAndTick("same-minute"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  assert.equal(fs.readFileSync(path.join(f.root, "executed"), "utf8").trim(), "first");
});

test("真实长 runNow 不阻塞 prepare，cancel 保运行，interrupt 等原 Scheduler 清理和 IPC 投递", async t => {
  const f = fixture(t), task = await create(f, { payload: waitingPayload() }), sent: any[] = [], callbacks: Array<() => void> = [];
  let closed = 0;
  const channel = Object.assign(new EventEmitter(), { send(message: any, callback: (error: Error | null) => void) {
    sent.push(message);
    if (message.id === "running") callbacks.push(() => callback(null)); else callback(null);
  } });
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected shutdown failure") });
  f.ctx.isTaskAdmissionPaused = () => lifecycle.isTaskAdmissionPaused();
  f.ctx.orchEngine = { hasInFlightWork: () => false, existingWorkspace: () => null, listManagedServicesForThread: () => [], waitForInFlightWork: async () => {} } as unknown as ApiHandlerContext["orchEngine"];
  const update = createDesktopUpdateControl({ context: f.ctx, requestId: "parent", timeoutMs: 2_000,
    queueDispatcher: { hasInFlightWork: () => false, assertNoFailure() {}, resumeWorkspace() {} }, scheduledTaskScheduler: f.scheduler,
    terminalManager: { hasRunningTerminals: () => false, stopAllForUpdate: async () => {} },
    hasBlockingTransaction: () => false, hasKnowledgeWork: () => false, stopKnowledgeWork: async () => {}, hasAssetDraftWork: () => false, stopAssetDraftWork: async () => {}, interruptTurn: async () => {} });
  await lifecycle.ready(async () => { closed++; await lifecycle.drainRequests(); }, () => readDesktopClientHealth(f.db.db, "1.0.0"),
    (request, requestId) => executeDesktopApiRequest(f.ctx, request, { requestId, startedAt: 1, clientVersion: "1.0.0" }), update);
  /** 原 IPC 请求仍保留独立关联，不等待尚未结束的 runNow 响应。 */
  const emit = (id: string, method: string, body?: Record<string, unknown>) => channel.emit("message", { t: "desktop.api.req", requestId: "parent", id, request: { method, ...(body ? { body } : {}) } });
  emit("running", "scheduledTasks.local.runNow", { taskId: task.id });
  await waitForFile(path.join(f.root, "started"));
  try {
    emit("prepare", "runtime.update.prepare"); await new Promise(setImmediate);
    assert.deepEqual(sent.find(message => message.id === "prepare")?.response.body, { ok: true, hasRunningSessions: true });
    emit("cancel", "runtime.update.cancel"); await new Promise(setImmediate);
    assert.equal(sent.find(message => message.id === "cancel")?.response.status, 200);
    assert.equal(f.db.scheduledTaskRuns.list({}).items[0].status, "running"); assert.equal(f.scheduler.hasInFlightWork(), true);
    emit("prepare-again", "runtime.update.prepare"); await new Promise(setImmediate);
    assert.equal(sent.find(message => message.id === "prepare-again")?.response.body.hasRunningSessions, true);
    emit("interrupt", "runtime.update.interrupt");
    await f.scheduler.waitForInFlightWork();
    const interruptDeadline = Date.now() + 2_000;
    while (!sent.some(message => message.id === "interrupt") && Date.now() < interruptDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.find(message => message.id === "interrupt")?.response.status, 200);
    assert.equal(sent.find(message => message.id === "running")?.response.body.run.status, "failed");
    assert.equal(f.db.scheduledTaskRuns.list({}).items[0].status, "failed"); assert.equal(f.scheduler.hasInFlightWork(), false);
    let drained = false;
    const draining = lifecycle.drainRequests().then(() => { drained = true; });
    await new Promise(setImmediate); assert.equal(drained, false);
    callbacks.shift()!(); await draining; assert.equal(drained, true); assert.equal(closed, 0);
  } finally {
    fs.writeFileSync(path.join(f.root, "released"), "ok");
    for (const callback of callbacks.splice(0)) callback();
    await f.scheduler.waitForInFlightWork(); await lifecycle.drainRequests();
  }
});

test("本机流程桥复用真实本机启动图，intake 不能覆盖 actor/scope/Profile", async t => {
  const f = fixture(t); initializeLocalEngineModelCatalog();
  const workspaceDb = f.appDb.forWorkspace(WORKSPACE);
  const workflowId = "bridge-workflow" as WorkflowId;
  workspaceDb.orchWorkflows.upsert({ id: workflowId, workspaceId: WORKSPACE, family: "feature-dev", name: "本机流程", description: "bridge", version: 1,
    nodes: [{ id: "start", type: "start", label: "start", position: { x: 0, y: 0 } }, { id: "end", type: "end", label: "end", position: { x: 100, y: 0 } }],
    edges: [{ id: "start-end", sourceNodeId: "start", targetNodeId: "end", dataMappings: [] }], workflowKnowledgeBundleIds: [], kind: "custom" });
  const reader = new OrchAssetAuthorityRuntimeReadService(createClientDbOrchAssetLegacyRuntimeReader(f.appDb, { requireCompleteDefinitions: true }), {
    listAssets() { throw new Error("NO_SERVER"); }, getAsset() { throw new Error("NO_SERVER"); }, getCacheVersion() { throw new Error("NO_SERVER"); },
  }, { getRuntimeReadinessRequirement: () => null });
  f.ctx.orchAssetLaunchSnapshot = new OrchAssetLaunchSnapshotService(reader);
  const engine = new OrchestrationEngine({ db: f.appDb, threads: new ThreadStore(), sessions: f.ctx.sessions, workspaces: f.ctx.workspaces,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 }, emitConversation() {}, emitRaw() {} });
  f.ctx.orchEngine = engine;
  try {
    const task = await create(f, { taskType: "workflow", payload: { workflowId, contextWorkspaceId: WORKSPACE,
      intake: { goal: "本机目标", workspaceScope: { scopeType: "shared_workspace", scopeId: "forged" }, actorUserId: "forged", executionProfileScope: { scopeType: "shared_workspace", scopeId: "forged" } } } });
    const response = await f.call("runNow", { taskId: task.id });
    assert.equal(response.status, 200); assert.equal(response.body.run.status, "success"); assert.match(response.body.run.summary, /已触发/);
    const instance = workspaceDb.orchInstances.get(response.body.run.workflowInstanceId, { strictScope: true });
    assert.ok(instance, "定时流程实例必须保存在可信工作区库");
    assert.equal(f.appDb.orchInstances.get(instance.id), null);
    assert.ok(workspaceDb.orchIntakes.get(instance.intakeSnapshot.id));
    assert.equal(f.appDb.orchIntakes.get(instance.intakeSnapshot.id), null);
    assert.ok(workspaceDb.orchEvents.listByInstance(instance.id).length > 0);
    assert.equal(f.appDb.orchEvents.listByInstance(instance.id).length, 0);
    assert.deepEqual(instance?.intakeSnapshot.workspaceScope, { scopeType: "local_workspace", scopeId: WORKSPACE });
    assert.equal(instance?.runtimeConfig?.initiatorUserId, `local:${CLIENT}`);
    assert.deepEqual(instance?.runtimeConfig?.executionProfileScope, { scopeType: "local_workspace", scopeId: WORKSPACE });
  } finally { await engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
});
