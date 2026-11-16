import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { LocalScheduledTaskConfigInput, WorkspaceId, WorkflowId } from "@codeflowai/shared";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { ScheduledTaskConfigError, ScheduledTaskConfigRepo } from "../src/db/repos/scheduledTaskConfigRepo.js";
import { ScheduledTaskRunRepo } from "../src/db/repos/scheduledTaskRunRepo.js";
import { ScheduledTaskRuntimeStateRepo, scheduledTaskRuntimeKey } from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";
import { ScheduledTaskScheduler, toErrorLog } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { createClientDbOrchAssetLegacyRuntimeReader, OrchAssetAuthorityRuntimeReadService } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { OrchAssetLaunchSnapshotService } from "../src/orchestration/orchAssetLaunchSnapshotService.js";
import { applyEngineModelCatalogSnapshot, cancelEngineModelCatalogDispatchPause, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "@codeflowai/shared/engine-model-catalog-seed";
import { logger } from "../src/logger.js";
import { createDesktopUpdateControl } from "../src/runtime/desktopUpdateControl.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";

const CLIENT = "local-client", DEVICE = "local-device", WORKSPACE = "local-client:workspace" as WorkspaceId;

test("定时脚本在真实 Writer 许可下认领和结算，运行等待不占数据库许可", async () => fixture(async f => {
  f.db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  const writer = new ClientDbWriterService({ dbPath: path.join(f.root, "client.db"), db: f.appDb, onFatalError() {} });
  await writer.ready();
  const scheduler = new ScheduledTaskScheduler({ config: f.config, deviceId: DEVICE,
    apiContext: f.ctx, localApiContext: f.ctx,
    withLegacyDatabase: (requestId, operation) => writer.withLegacyDatabase(requestId, operation),
  });
  try {
    const running = scheduler.runLocalNow("task-1");
    const alive = await writer.withLegacyDatabase("scheduler-concurrent-read", () => f.appDb.workspaces.get(WORKSPACE));
    assert.equal(alive?.id, WORKSPACE);
    const result = await running;
    assert.equal(result.status, "success");
    const saved = await writer.withLegacyDatabase("scheduler-verify", () => f.appDb.withLocalScheduledTasks(WORKSPACE, repos => repos.runs.get(result.id)));
    assert.equal(saved?.status, "success");
  } finally {
    try { await scheduler.stopAndDrain(); } finally { await writer.close(); }
  }
}));

/** 读取真实固定日志，缺少日志目录表示尚未写入。 */
function workspaceLogs(root: string): string {
  const directory = path.join(root, ".codeflowai");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^client-.*\.log$/.test(name))
    .map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("") : "";
}

/** 既有注入在新的固定 W 写入边界捕获，其他级别仍使用真实日志实现。 */
function mockTaskLog(t: test.TestContext, db: ReturnType<typeof openClientDb>, level: "error" | "warn", action: (...args: any[]) => void): void {
  const write = db.writeWorkspaceLog;
  t.mock.method(db, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: Parameters<typeof write>[1]) => {
    if (entry.level === level) action(entry.tag, entry.message, entry.data);
    else write(workspaceId, entry);
  });
}

/** 原公开请求失败与事后 wait 必须同时观察到同一个原因。 */
async function rejectedOperation(scheduler: ScheduledTaskScheduler, operation: Promise<unknown>, expected: Parameters<typeof assert.rejects>[1]): Promise<void> {
  let failure: unknown;
  await assert.rejects(operation, error => { failure = error; return true; });
  await assert.rejects(scheduler.waitForInFlightWork(), error => error === failure);
  await assert.rejects(Promise.reject(failure), expected);
}

test("LSLOG 真实 SQLite 失败仅写可信 A，B 与应用无同条", async t => fixture(async f => {
  const other = path.join(f.root, "other"); fs.mkdirSync(other);
  f.appDb.workspaces.upsert({ id: `${CLIENT}:other` as WorkspaceId, title: "B", path: other });
  f.db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  const application: unknown[][] = []; t.mock.method(logger, "error", (...args: unknown[]) => { application.push(args); });
  f.db.db.exec("CREATE TRIGGER fail_lslog_claim BEFORE INSERT ON scheduled_task_runs BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL_中文_🔒'); END");
  const failed = f.scheduler.runLocalNow("task-1");
  await assert.rejects(failed, { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  await assert.rejects(f.scheduler.waitForInFlightWork(), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  assert.equal(application.length, 0, "旧实现把同条事务失败写入应用日志");
  const lines = workspaceLogs(f.root).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, 1); assert.equal(lines[0].message, "local scheduled task transaction failed");
  assert.equal(lines[0].workspaceId, WORKSPACE); assert.equal(lines[0].errorCode, "SCHEDULED_TASK_RUN_STORAGE_FAILED");
  assert.equal(workspaceLogs(other), ""); assert.equal(application.length, 0);
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_SQL|🔒/); assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
}));

for (const mode of ["exit", "timeout"] as const) test(`LSLOG 真实脚本 ${mode} 后日志失败保原 running 且事后 wait 可见`, async t => fixture(async f => {
  const command = config().payload as { command: string };
  const suffix = mode === "exit" ? "; exit 7" : "; sleep 8";
  // Windows 超时夹具只用同一 cmd 的内建命令，先写执行标记再等待真实 timer，不依赖 PowerShell 冷启动。
  const payload = mode === "timeout" && process.platform === "win32"
    ? { ...config().payload, shell: "cmd" as const, command: "echo run>>executed & for /l %i in (1,1,2147483647) do @rem wait" }
    : { ...config().payload, command: command.command + suffix };
  f.db.scheduledTaskConfigs.create({ config: config({ timeoutMs: mode === "timeout" ? 2_000 : 10_000,
    payload }), at: 1 });
  const logFailure = new Error("PRIVATE_LOG_FAILURE"), writes: unknown[] = [];
  t.mock.method(f.appDb, "writeWorkspaceLog", (_workspace: WorkspaceId, entry: Parameters<typeof f.appDb.writeWorkspaceLog>[1]) => { writes.push(entry); throw logFailure; });
  let failure: unknown;
  await assert.rejects(f.scheduler.runLocalNow("task-1"), error => {
    failure = error; assert.ok(error instanceof AggregateError);
    assert.equal((error as AggregateError & { code: string }).code, "SCHEDULED_TASK_EXECUTION_LOG_FAILED");
    assert.equal(error.errors[0].code, mode === "exit" ? "SCHEDULED_TASK_SCRIPT_FAILED" : "SCHEDULED_TASK_SCRIPT_TIMEOUT");
    assert.equal(error.errors[1], logFailure); assert.equal(error.cause, error.errors[0]); return true;
  });
  assert.equal(f.scheduler.hasInFlightWork(), false);
  await assert.rejects(f.scheduler.waitForInFlightWork(), error => error === failure);
  assert.equal(writes.length, 1); assert.equal(f.db.scheduledTaskRuns.list({}).items[0].status, "running");
  assert.equal(fs.readFileSync(path.join(f.root, "executed"), "utf8").trim(), "run");
}));

test("LSLOG 安全投影不调用 getter/toString 且保 falsy cause 与普通指纹", () => {
  let reads = 0;
  const hostile = Object.create(null, { code: { get() { reads++; throw new Error("PRIVATE_GETTER"); } },
    toString: { value() { reads++; throw new Error("PRIVATE_STRING"); } } });
  const projected = toErrorLog(new AggregateError([hostile, null, false, 0, "", undefined], "PRIVATE_AGG", { cause: false })).error;
  assert.equal(reads, 0); assert.equal((projected.cause as { type: string }).type, "boolean");
  assert.deepEqual((projected.errors as Array<{ type: string }>).slice(1).map(item => item.type), ["null", "boolean", "number", "string", "undefined"]);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_/);
});

test("LSLOG 自动派发脚本日志失败只尝试一次，原最终尾链事后 wait 保因", async t => fixture(async f => {
  f.db.scheduledTaskConfigs.create({ config: config({ missedPolicy: "run_once_on_reconnect", payload: { ...config().payload, command: "exit 7" } }), at: 1 });
  let original: unknown, writes = 0; const logging = new Error("PRIVATE_AUTOMATIC_LOG");
  const log = (f.scheduler as any).logLocalRunFailure.bind(f.scheduler);
  t.mock.method(f.scheduler as any, "logLocalRunFailure", (...args: unknown[]) => { try { return log(...args); } catch (error) { original = error; throw error; } });
  t.mock.method(f.appDb, "writeWorkspaceLog", () => { writes++; throw logging; });
  await f.scheduler.syncAndTick("automatic-log-tail");
  const deadline = Date.now() + 8_000;
  while (f.scheduler.hasInFlightWork()) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  await assert.rejects(f.scheduler.waitForInFlightWork(), error => {
    assert.equal(error, original); assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], logging); return true;
  });
  assert.equal(writes, 1); assert.equal(f.db.scheduledTaskRuns.list({}).items[0].status, "running");
}));

for (const level of ["warn", "info"] as const) for (const logFails of [false, true]) test(`LSLOG 真实流程前实例 ${level} 日志归 W 且拒写零后续启动 ${logFails}`, async t => fixture(async f => {
  const engine = installWorkflow(f), application: unknown[] = [], logFailure = new Error("PRIVATE_PREVIOUS_LOG");
  t.mock.method(logger, level, (...args: unknown[]) => { application.push(args); });
  try {
    if (level === "info") {
      await f.scheduler.runLocalNow("task-1"); await engine.waitForInFlightWork();
      const workflow = f.db.orchWorkflows.get("local-workflow" as WorkflowId)!;
      f.db.orchWorkflows.upsert({ ...workflow, id: "changed-workflow" as WorkflowId });
    } else f.db.scheduledTaskRuntimeStates.markSkipped({ taskId: scheduledTaskRuntimeKey("task-1", "local"), clientId: CLIENT, deviceId: DEVICE, scheduledAt: 1, at: 1 });
    const current = f.db.scheduledTaskConfigs.get("task-1")!;
    f.db.scheduledTaskConfigs.update({ config: { ...current, missedPolicy: "run_once_on_reconnect", payload: {
      ...current.payload, workflowId: (level === "info" ? "changed-workflow" : "local-workflow") as WorkflowId, skipWhenPreviousInstanceStatuses: ["completed"] } }, expectedRevision: 1, at: 2 });
    f.db.db.prepare("UPDATE scheduled_task_runtime_states SET last_scheduled_at = 1, last_workflow_instance_id = CASE WHEN ? = 'warn' THEN 'missing-instance' ELSE last_workflow_instance_id END").run(level);
    const before = f.db.orchInstances.listByWorkspace(WORKSPACE).length;
    if (logFails) {
      let attempts = 0; t.mock.method(f.appDb, "writeWorkspaceLog", () => { attempts++; throw logFailure; });
      await f.scheduler.syncAndTick("previous-log-failure");
      await assert.rejects(f.scheduler.waitForInFlightWork(), error => {
        assert.ok(error instanceof AggregateError); assert.equal((error as AggregateError & { code: string }).code, "SCHEDULED_TASK_EXECUTION_LOG_FAILED");
        assert.equal(error.errors[1], logFailure); assert.equal(error.cause, error.errors[0]); return true;
      });
      assert.equal(attempts, 1); assert.equal(f.db.orchInstances.listByWorkspace(WORKSPACE).length, before);
    } else {
      await f.scheduler.syncAndTick("previous-log-success"); await f.scheduler.waitForInFlightWork(); await engine.waitForInFlightWork();
      assert.match(workspaceLogs(f.root), level === "warn" ? /previous scheduled workflow instance not found/ : /previous scheduled workflow instance ignored after task target changed/);
      assert.equal(f.db.orchInstances.listByWorkspace(WORKSPACE).length, before + 1);
    }
    assert.equal(application.length, 0);
  } finally { await engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
}));

/** 每例使用真实隔离数据库和脚本目录，任何 HTTP 都直接使测试失败。 */
async function fixture(action: (f: ReturnType<typeof createFixture>) => Promise<void>): Promise<void> {
  const f = createFixture();
  const originalFetch = globalThis.fetch;
  let httpRequests = 0;
  globalThis.fetch = async () => { httpRequests += 1; throw new Error("LOCAL_TASK_MUST_NOT_USE_HTTP"); };
  try { await action(f); assert.equal(httpRequests, 0); }
  finally { globalThis.fetch = originalFetch; await f.scheduler.stopAndDrain(); f.db.close(); fs.rmSync(f.root, { recursive: true }); }
}

/** 装配原 Scheduler 与真实 a1/a2 仓储，不添加账号任务镜像。 */
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-local-schedule-"));
  const gate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath: path.join(root, "client.db"), workspaceOperationGate: gate });
  db.workspaces.upsert({ id: WORKSPACE, title: "local scheduler", path: root });
  db.withLocalScheduledTasks(WORKSPACE, () => {});
  const storage = openSqliteDb(path.join(root, ".codeflowai", "workspace.db"), { fileMustExist: true });
  const runtime = new ScheduledTaskRuntimeStateRepo(storage, WORKSPACE), configs = new ScheduledTaskConfigRepo(storage, runtime, WORKSPACE);
  const localDb = { ...db.forWorkspace(WORKSPACE), db: storage, scheduledTaskConfigs: configs, scheduledTaskRuntimeStates: runtime,
    scheduledTaskRuns: new ScheduledTaskRunRepo(storage, configs),
    /** 先关闭测试持有的实际任务库，再关闭原 ClientDb owner。 */
    close: () => { storage.close(); db.close(); } };
  let paused = false;
  const ctx = { clientId: CLIENT, db, workspaceOperationGate: gate, workspaces: new Map([[WORKSPACE, root]]), localWorkspaceOnly: true,
    sessions: {}, controlledExperiments: { hasInFlightWork: () => false, stopForUpdate: async () => {} },
    isTaskAdmissionPaused: () => paused,
  } as unknown as ApiHandlerContext;
  const config = { clientId: CLIENT, serverWsUrl: "ws://127.0.0.1:1/ws", apiKey: "" } as ClientConfig;
  const scheduler = new ScheduledTaskScheduler({ config, deviceId: DEVICE, apiContext: ctx, localApiContext: ctx, isTaskAdmissionPaused: () => paused });
  return { root, db: localDb, appDb: db, scheduler, ctx, config, pause: (value: boolean) => { paused = value; } };
}

/** 受控脚本仅在本例工作区追加一行，以实际执行次数验证去重。 */
function config(overrides: Partial<LocalScheduledTaskConfigInput> = {}): LocalScheduledTaskConfigInput {
  return { id: "task-1", source: "local", clientId: CLIENT, deviceId: DEVICE,
    workspaceScope: { scopeType: "local_workspace", scopeId: WORKSPACE }, name: "本机任务", description: null,
    taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "powershell" : "sh", contextWorkspaceId: WORKSPACE,
      command: process.platform === "win32" ? "[IO.File]::AppendAllText((Join-Path (Get-Location) 'executed'), 'run' + [Environment]::NewLine)" : "echo run >> executed" },
    concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 10_000, ...overrides };
}

/** 等待原后台派发收口，不以仓储 stub 代替真实脚本。 */
async function settle(scheduler: ScheduledTaskScheduler): Promise<void> { await scheduler.waitForInFlightWork(); }

for (const scope of ["application", "workspace"] as const) test(`ER01 ${scope} 坏配置整次扫描拒绝且安全日志一次`, async t => fixture(async f => {
  const entries: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { entries.push(args); });
  mockTaskLog(t, f.appDb, "error", (...args) => { entries.push(args); });
  const workspaceId = scope === "workspace" ? WORKSPACE : null;
  const bad = config({ id: "task-bad", ...(workspaceId ? {} : { workspaceScope: null, payload: { shell: "sh", command: "PRIVATE_UNUSED_COMMAND" } }) });
  f.appDb.withLocalScheduledTasks(workspaceId, repos => {
    repos.configs.create({ config: bad, at: 1 });
    repos.db.prepare("UPDATE scheduled_task_configs SET payload_json = ? WHERE id = ?").run("{PRIVATE_BAD_SCAN_BODY", bad.id);
  });
  f.db.scheduledTaskConfigs.create({ config: config({ id: "task-good" }), at: 1 });
  const first = f.scheduler.syncAndTick("desktop.ready", "startup-scan-request");
  const second = f.scheduler.syncAndTick("interval", "same-owner");
  assert.equal(second, first);
  let cause: unknown;
  await assert.rejects(first, error => { cause = error; return error instanceof ScheduledTaskConfigError && error.code === "SCHEDULED_TASK_CONFIG_CORRUPT" && error.field === "payload_json"; });
  await f.scheduler.waitForInFlightWork();
  assert.equal(entries.length, 1, "本机列表拒绝必须有一次领域日志");
  assert.match(JSON.stringify(entries), /SCHEDULED_TASK_CONFIG_CORRUPT/);
  assert.match(JSON.stringify(entries), /payload_json/);
  assert.match(JSON.stringify(entries), /startup-scan-request/);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_BAD_SCAN_BODY|PRIVATE_UNUSED_COMMAND/);
  assert.equal(f.scheduler.isIsolatedLocalConfigScanFailure(cause), true);
  const other = new ScheduledTaskScheduler({ config: f.config, deviceId: DEVICE, apiContext: f.ctx, localApiContext: f.ctx });
  assert.equal(other.isIsolatedLocalConfigScanFailure(cause), false);
  for (const fake of [Object.assign(new Error("SCHEDULED_TASK_CONFIG_CORRUPT"), { code: "SCHEDULED_TASK_CONFIG_CORRUPT", scheduledTaskFailureLogged: true }),
    Object.assign(new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CORRUPT", "task-bad", "payload_json"), { scheduledTaskFailureLogged: true }),
    new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", "task-bad", "id"), new AggregateError([cause])]) {
    assert.equal(f.scheduler.isIsolatedLocalConfigScanFailure(fake), false);
  }
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runtime_states").get() as { n: number }).n, 0);
  assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
  await f.scheduler.stopAndDrain();
}));

for (const retryWouldPass of [true, false]) test(`ER01 扫描日志失败保双因且不重记 ${retryWouldPass}`, async t => fixture(async f => {
  let attempts = 0;
  const firstLogError = new Error("FIRST_SCAN_LOG_FAILURE"), secondLogError = new Error("SECOND_SCAN_LOG_FAILURE");
  t.mock.method(logger, "error", () => { attempts++; if (attempts === 1) throw firstLogError; if (!retryWouldPass) throw secondLogError; });
  mockTaskLog(t, f.appDb, "error", () => { attempts++; if (attempts === 1) throw firstLogError; if (!retryWouldPass) throw secondLogError; });
  f.db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  f.db.db.prepare("UPDATE scheduled_task_configs SET payload_json = ?").run("{PRIVATE_SCAN_LOG_BODY");
  await rejectedOperation(f.scheduler, f.scheduler.syncAndTick("desktop.ready", "scan-log-failure"), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal((error as AggregateError & { code: string }).code, "SCHEDULED_TASK_SCAN_LOG_FAILED");
    assert.ok(error.errors[0] instanceof ScheduledTaskConfigError);
    assert.equal(error.errors[1], firstLogError); assert.equal(error.cause, error.errors[0]);
    assert.equal(f.scheduler.isIsolatedLocalConfigScanFailure(error.errors[0]), false);
    assert.equal(f.scheduler.isIsolatedLocalConfigScanFailure(error), false);
    return true;
  });
  assert.equal(attempts, 1); assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
}));

test("ER01 原 timer 修复坏配置后恢复且未知扫描错误交同 owner", async t => fixture(async f => {
  let interval!: () => void;
  t.mock.method(globalThis, "setInterval", ((callback: () => void) => { interval = callback; return { unref() {} }; }) as typeof setInterval);
  t.mock.method(globalThis, "clearInterval", () => {});
  const entries: unknown[][] = [], fatal: unknown[] = [], replacement: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { entries.push(args); });
  mockTaskLog(t, f.appDb, "error", (...args) => { entries.push(args); });
  f.db.scheduledTaskConfigs.create({ config: config({ missedPolicy: "run_once_on_reconnect" }), at: 1 });
  const originalPayload = JSON.stringify(config().payload);
  f.db.db.prepare("UPDATE scheduled_task_configs SET payload_json = ?").run("{PRIVATE_TIMER_BAD_BODY");
  f.scheduler.start({ requestId: "timer-original-owner", fail: cause => { fatal.push(cause); } });
  f.scheduler.start({ requestId: "replacement-owner", fail: cause => { replacement.push(cause); } });
  interval(); await new Promise(setImmediate); await f.scheduler.waitForInFlightWork();
  assert.equal(entries.length, 1); assert.deepEqual(fatal, []); assert.deepEqual(replacement, []);
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  f.db.db.prepare("UPDATE scheduled_task_configs SET payload_json = ?").run(originalPayload);
  interval(); await f.scheduler.waitForInFlightWork();
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  interval(); await f.scheduler.waitForInFlightWork();
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  f.db.db.exec("ALTER TABLE scheduled_task_configs RENAME TO hidden_task_configs");
  interval(); await new Promise(setImmediate); await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(fatal.length, 1); assert.equal(replacement.length, 0);
  assert.equal(f.scheduler.isIsolatedLocalConfigScanFailure(fatal[0]), false);
}));

test("ER01 坏配置伴随真实 close 失败不得隔离且保原资源 owner", async t => fixture(async f => {
  const entries: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { entries.push(args); });
  f.db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  f.db.db.prepare("UPDATE scheduled_task_configs SET payload_json = ?").run("{PRIVATE_CLOSE_BAD_BODY");
  const nativeClose = DatabaseSync.prototype.close, closeError = new Error("CONTROLLED_SCAN_CLOSE_FAILURE");
  let blocked = true, held: DatabaseSync | undefined;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const expected = fs.statSync(path.join(f.root, ".codeflowai", "workspace.db"));
    const matches = (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => {
      if (!row.file) return false;
      const actual = fs.statSync(row.file);
      return actual.dev === expected.dev && actual.ino === expected.ino;
    });
    if (blocked && matches) { held = this; throw closeError; }
    return nativeClose.call(this);
  });
  try {
    await rejectedOperation(f.scheduler, f.scheduler.syncAndTick("desktop.ready"), error => {
      assert.equal(f.scheduler.isIsolatedLocalConfigScanFailure(error), false);
      assert.ok((error as Error).cause instanceof AggregateError);
      const causes = ((error as Error).cause as AggregateError).errors;
      assert.ok(causes[0] instanceof ScheduledTaskConfigError); assert.equal(causes[1], closeError);
      assert.equal(f.scheduler.isIsolatedLocalConfigScanFailure(causes[0]), false); return true;
    });
    assert.equal(entries.length, 0); assert.equal(held?.isOpen, true);
    assert.equal(f.ctx.workspaceOperationGate!.hasActiveWrites(), true);
  } finally { blocked = false; f.appDb.close(); }
  assert.equal(held?.isOpen, false); assert.equal(f.ctx.workspaceOperationGate!.hasActiveWrites(), false);
}));

test("本机手动运行离线保存完整历史，Server 同 ID 状态保持隔离", async () => fixture(async ({ db, appDb, scheduler, root }) => {
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  appDb.scheduledTaskRuntimeStates.markStarted({ taskId: "task-1", clientId: CLIENT, deviceId: DEVICE, scheduledAt: 1, runId: "server-running", startedAt: 1 });
  const run = await scheduler.runLocalNow("task-1");
  assert.equal(run.status, "success");
  assert.equal(db.scheduledTaskRuns.get(run.id)?.taskNameSnapshot, "本机任务");
  assert.equal(db.scheduledTaskRuns.get(run.id)?.configRevision, 1);
  assert.equal(appDb.scheduledTaskRuntimeStates.get("task-1")?.runningRunId, "server-running");
  assert.equal(db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local"))?.runningRunId, null);
  assert.equal(fs.readFileSync(path.join(root, "executed"), "utf8").trim(), "run");
}));

test("本机分钟并发 tick 与重建 Scheduler 不重放同一到期点", async t => fixture(async ({ db, scheduler, config: runtimeConfig, ctx }) => {
  // 仅固定计划分钟，真实脚本与清理仍使用真实计时器。
  t.mock.method(Date, "now", () => 1_800_000_005_000);
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  await Promise.all([scheduler.syncAndTick("ready"), scheduler.syncAndTick("reconnect")]);
  await settle(scheduler);
  assert.equal(db.scheduledTaskRuns.list({}).total, 1);
  const restarted = new ScheduledTaskScheduler({ config: runtimeConfig, deviceId: DEVICE, apiContext: ctx, localApiContext: ctx });
  try { await restarted.syncAndTick("restart"); await settle(restarted); assert.equal(db.scheduledTaskRuns.list({}).total, 1); }
  finally { await restarted.stopAndDrain(); }
}));

test("认领历史写失败时同连接回滚 runtime 且零脚本派发", async () => fixture(async ({ db, scheduler, root }) => {
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  db.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON scheduled_task_runs BEGIN SELECT RAISE(ABORT, 'sensitive SQL body'); END");
  await rejectedOperation(scheduler, scheduler.runLocalNow("task-1"), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  assert.equal(db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local")), null);
  assert.equal(db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(fs.existsSync(path.join(root, "executed")), false);
}));

test("终结历史写失败保留 running，禁止 finally 清理证据", async () => fixture(async ({ db, scheduler }) => {
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  db.db.exec("CREATE TRIGGER fail_complete BEFORE UPDATE ON scheduled_task_runs BEGIN SELECT RAISE(ABORT, 'sensitive SQL body'); END");
  await rejectedOperation(scheduler, scheduler.runLocalNow("task-1"), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  const run = db.scheduledTaskRuns.list({}).items[0];
  assert.equal(run.status, "running");
  assert.equal(db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local"))?.runningRunId, run.id);
}));

test("无内存 owner 的旧 running 阻断本任务，其他本机任务仍执行", async () => fixture(async ({ db, scheduler }) => {
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  db.scheduledTaskConfigs.create({ config: config({ id: "task-2" }), at: 1 });
  db.scheduledTaskRuntimeStates.markStarted({ taskId: scheduledTaskRuntimeKey("task-1", "local"), clientId: CLIENT, deviceId: DEVICE, scheduledAt: 1, runId: "orphan", startedAt: 1 });
  await assert.rejects(scheduler.syncAndTick("restart"), { code: "SCHEDULED_TASK_ORPHAN_RUNNING" });
  await assert.rejects(settle(scheduler), { code: "SCHEDULED_TASK_ORPHAN_RUNNING" });
  assert.equal(db.scheduledTaskRuns.list({ taskId: "task-1" }).total, 0);
  assert.equal(db.scheduledTaskRuns.list({ taskId: "task-2" }).items[0].status, "success");
  assert.equal(db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local"))?.runningRunId, "orphan");
}));

test("D16 重装接续后旧 running 仍拒绝自动与手动执行，其他本机任务可用", async () => fixture(async f => {
  const oldDeviceId = "retained-device", key = scheduledTaskRuntimeKey("task-1", "local");
  f.db.scheduledTaskConfigs.create({ config: config({ deviceId: oldDeviceId }), at: 1 });
  f.db.scheduledTaskConfigs.create({ config: config({ id: "task-2", deviceId: oldDeviceId }), at: 1 });
  f.db.scheduledTaskRuntimeStates.markStarted({ taskId: key, clientId: CLIENT, deviceId: oldDeviceId, scheduledAt: 1, runId: "retained-running", startedAt: 1 });
  const before = f.db.scheduledTaskRuntimeStates.get(key)!;
  assert.deepEqual(f.appDb.rebindLocalScheduledTasksForDesktopReinstall({ clientId: CLIENT, oldDeviceId, nextDeviceId: DEVICE }), { rebound: 2, unchanged: 0 });
  assert.deepEqual(f.db.scheduledTaskRuntimeStates.get(key), { ...before, deviceId: DEVICE });
  await rejectedOperation(f.scheduler, f.scheduler.syncAndTick("reinstall-ready"), { code: "SCHEDULED_TASK_ORPHAN_RUNNING" });
  await rejectedOperation(f.scheduler, f.scheduler.runLocalNow("task-1"), error => {
    const failure = error as Error & { code: string; cause: Error & { cause: { code: string; taskId: string; runId: string } } };
    assert.equal(failure.code, "SCHEDULED_TASK_RUN_STORAGE_FAILED");
    assert.equal(failure.cause.cause.code, "SCHEDULED_TASK_ORPHAN_RUNNING");
    assert.equal(failure.cause.cause.taskId, "task-1"); assert.equal(failure.cause.cause.runId, "retained-running");
    return true;
  });
  assert.equal(f.db.scheduledTaskRuns.list({ taskId: "task-1" }).total, 0);
  assert.equal(f.db.scheduledTaskRuns.list({ taskId: "task-2" }).items[0].status, "success");
  assert.deepEqual(f.db.scheduledTaskRuntimeStates.get(key), { ...before, deviceId: DEVICE });
}));

test("D16 重装接续保留原队列且沿原调度入口恰好执行一次", async t => fixture(async f => {
  const oldDeviceId = "retained-device", key = scheduledTaskRuntimeKey("task-1", "local");
  f.db.scheduledTaskConfigs.create({ config: config({ deviceId: oldDeviceId, cronExpr: "0 0 1 1 *" }), at: 1 });
  f.db.scheduledTaskRuntimeStates.markStarted({ taskId: key, clientId: CLIENT, deviceId: oldDeviceId, scheduledAt: 100, runId: "retained-run", startedAt: 100 });
  f.db.scheduledTaskRuntimeStates.queueLocalConcurrency({ taskId: "task-1", clientId: CLIENT, deviceId: oldDeviceId, runId: "retained-run", scheduledAt: 200, at: 200 });
  f.db.scheduledTaskRuntimeStates.markFinished({ taskId: key, runId: "retained-run", finishedAt: 300 });
  const before = f.db.scheduledTaskRuntimeStates.get(key)!;
  f.appDb.rebindLocalScheduledTasksForDesktopReinstall({ clientId: CLIENT, oldDeviceId, nextDeviceId: DEVICE });
  assert.deepEqual(f.db.scheduledTaskRuntimeStates.get(key), { ...before, deviceId: DEVICE });
  // 固定在年 cron 窗口之外，只验证保留队列的消费次数。
  t.mock.method(Date, "now", () => Date.UTC(2026, 5, 15, 12, 0, 1));
  await f.scheduler.syncAndTick("reinstall-queue"); await settle(f.scheduler);
  await f.scheduler.syncAndTick("reinstall-repeated-ready"); await settle(f.scheduler);
  const runs = f.db.scheduledTaskRuns.list({}).items;
  assert.equal(runs.length, 1); assert.equal(runs[0].scheduledAt, 200); assert.equal(runs[0].status, "success");
  assert.equal(f.db.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, null);
  assert.equal(fs.readFileSync(path.join(f.root, "executed"), "utf8").trim().split(/\r?\n/u).length, 1);
}));

test("D16 重装接续保留已执行 cron 水位，同窗 ready 不重复派发", async () => fixture(async f => {
  const oldDeviceId = "retained-device", clock = Date.now;
  const oldScheduler = new ScheduledTaskScheduler({ config: f.config, deviceId: oldDeviceId, apiContext: f.ctx, localApiContext: f.ctx });
  const minute = Math.floor(clock() / 60_000) * 60_000;
  Date.now = () => minute + 1000;
  try {
    f.db.scheduledTaskConfigs.create({ config: config({ deviceId: oldDeviceId, missedPolicy: "run_once_on_reconnect" }), at: 1 });
    await oldScheduler.syncAndTick("old-ready"); await settle(oldScheduler); await oldScheduler.stopAndDrain();
    const before = f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local"))!;
    assert.equal(before.lastScheduledAt, minute); assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
    f.appDb.rebindLocalScheduledTasksForDesktopReinstall({ clientId: CLIENT, oldDeviceId, nextDeviceId: DEVICE });
    await f.scheduler.syncAndTick("reinstall-ready"); await settle(f.scheduler);
    await f.scheduler.syncAndTick("reinstall-repeated-ready"); await settle(f.scheduler);
    assert.deepEqual(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local")), { ...before, deviceId: DEVICE });
    assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
    assert.equal(f.db.scheduledTaskRuns.list({}).items[0].deviceId, oldDeviceId);
    assert.equal(fs.readFileSync(path.join(f.root, "executed"), "utf8").trim().split(/\r?\n/u).length, 1);
  } finally { Date.now = clock; await oldScheduler.stopAndDrain(); }
}));

test("停用和墓碑配置的持久 running 仍阻止工作区迁移", async () => fixture(async ({ db, scheduler }) => {
  const task = db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  db.scheduledTaskRuntimeStates.markStarted({ taskId: scheduledTaskRuntimeKey(task.id, "local"), clientId: CLIENT, deviceId: DEVICE, scheduledAt: 1, runId: "retained", startedAt: 1 });
  const disabled = db.scheduledTaskConfigs.setEnabled({ taskId: task.id, expectedRevision: 1, enabled: false, at: 2 });
  assert.deepEqual(scheduler.listRunningByWorkspace(WORKSPACE), [{ taskId: task.id, runId: "retained" }]);
  db.scheduledTaskConfigs.delete({ taskId: task.id, expectedRevision: disabled.revision, at: 3 });
  assert.deepEqual(scheduler.listRunningByWorkspace(WORKSPACE), [{ taskId: task.id, runId: "retained" }]);
}));

test("run_once 漏点合并为当前分钟一次，联网 tick 不增加补跑", async () => fixture(async ({ db, scheduler }) => {
  db.scheduledTaskConfigs.create({ config: config({ cronExpr: "0 0 * * *", missedPolicy: "run_once_on_reconnect" }), at: 1 });
  await scheduler.syncAndTick("ready"); await settle(scheduler);
  assert.equal(db.scheduledTaskRuns.list({}).total, 1);
  const run = db.scheduledTaskRuns.list({}).items[0];
  assert.equal(run.scheduledAt, Math.floor(run.startedAt! / 60_000) * 60_000);
  await scheduler.syncAndTick("helloAck"); await settle(scheduler);
  assert.equal(db.scheduledTaskRuns.list({}).total, 1);
}));

test("runtime 认领写失败撤销已插入历史，终结失败撤销终态", async () => fixture(async ({ db, scheduler }) => {
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  db.db.exec("CREATE TRIGGER fail_runtime_claim BEFORE INSERT ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT, 'runtime secret'); END");
  await rejectedOperation(scheduler, scheduler.runLocalNow("task-1"), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  assert.equal(db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local")), null);
  db.db.exec("DROP TRIGGER fail_runtime_claim");
  db.db.exec("CREATE TRIGGER fail_runtime_finish BEFORE UPDATE ON scheduled_task_runtime_states WHEN NEW.running_run_id IS NULL BEGIN SELECT RAISE(ABORT, 'finish secret'); END");
  await rejectedOperation(scheduler, scheduler.runLocalNow("task-1"), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  assert.equal(db.scheduledTaskRuns.list({}).items[0].status, "running");
  assert.equal(db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local"))?.runningRunId, db.scheduledTaskRuns.list({}).items[0].id);
}));

test("runtime 触发器忽略认领写入也必须零派发且撤销历史", async () => fixture(async ({ db, scheduler, root }) => {
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  db.db.exec("CREATE TRIGGER ignore_claim BEFORE INSERT ON scheduled_task_runtime_states BEGIN SELECT RAISE(IGNORE); END");
  await rejectedOperation(scheduler, scheduler.runLocalNow("task-1"), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  assert.equal(db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(fs.existsSync(path.join(root, "executed")), false);
}));

/** 有界等待真实进程创建文件；超时保留可检索测试失败。 */
async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `controlled script did not create ${path.basename(file)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const change of ["disable", "disable_enable", "delete", "revise"] as const) {
  test(`queue_one 出队重读配置：${change}`, async t => fixture(async ({ db, scheduler, root }) => {
    const waiting = process.platform === "win32"
      ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'started'), 'ok'); $limit = [DateTime]::UtcNow.AddSeconds(6); while (!(Test-Path released) -and [DateTime]::UtcNow -lt $limit) { Start-Sleep -Milliseconds 20 }; [IO.File]::AppendAllText((Join-Path (Get-Location) 'executed'), 'first' + [Environment]::NewLine)"
      : "touch started; n=0; while [ ! -e released ] && [ $n -lt 120 ]; do sleep .05; n=$((n+1)); done; echo first >> executed";
    const task = config({ payload: { ...config().payload, command: waiting } });
    db.scheduledTaskConfigs.create({ config: task, at: 1 });
    const running = scheduler.runLocalNow(task.id);
    await waitForFile(path.join(root, "started"));
    // 两次 tick 明确在同一时间窗；真实脚本耗时跨分钟不应变成新的 cron 场景。
    const tickAt = Date.now(); t.mock.method(Date, "now", () => tickAt);
    await scheduler.syncAndTick("queue-while-running");
    if (change === "disable" || change === "disable_enable") {
      db.scheduledTaskConfigs.setEnabled({ taskId: task.id, enabled: false, expectedRevision: 1, at: 2 });
      if (change === "disable_enable") db.scheduledTaskConfigs.setEnabled({ taskId: task.id, enabled: true, expectedRevision: 2, at: 3 });
    }
    else if (change === "delete") db.scheduledTaskConfigs.delete({ taskId: task.id, expectedRevision: 1, at: 2 });
    else db.scheduledTaskConfigs.update({ config: { ...task, payload: { ...task.payload, command: process.platform === "win32"
      ? "[IO.File]::AppendAllText((Join-Path (Get-Location) 'executed'), 'revised' + [Environment]::NewLine)" : "echo revised >> executed" } }, expectedRevision: 1, at: 2 });
    fs.writeFileSync(path.join(root, "released"), "ok");
    await running; await settle(scheduler);
    if (change === "disable_enable") {
      await scheduler.syncAndTick("same-minute-after-enable"); await settle(scheduler);
    }
    assert.deepEqual(fs.readFileSync(path.join(root, "executed"), "utf8").trim().split(/\r?\n/), change === "revise" ? ["first", "revised"] : ["first"]);
    assert.equal(db.scheduledTaskRuns.list({}).total, change === "revise" ? 2 : 1);
    if (change === "revise") assert.equal(db.scheduledTaskRuns.list({}).items[0].configRevision, 2);
  }));
}

test("本机任务不能使用其他设备或非真实本机工作区", async () => fixture(async ({ db, scheduler, ctx }) => {
  db.scheduledTaskConfigs.create({ config: config({ id: "foreign", deviceId: "other" }), at: 1 });
  await rejectedOperation(scheduler, scheduler.runLocalNow("foreign"), { code: "SCHEDULED_TASK_LOCAL_SCOPE_INVALID" });
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  ctx.workspaces.delete(WORKSPACE);
  await rejectedOperation(scheduler, scheduler.runLocalNow("task-1"), { code: "SCHEDULED_TASK_LOCAL_SCOPE_INVALID" });
  assert.equal(db.scheduledTaskRuns.list({}).total, 0);
}));

/** 使用真实本机资产 Reader、完整启动图和编排引擎，流程本身无需外部模型进程。 */
function installWorkflow(f: ReturnType<typeof createFixture>): OrchestrationEngine {
  resetEngineModelCatalogRuntimeForTest();
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] });
  const workflowId = "local-workflow" as WorkflowId;
  f.db.orchWorkflows.upsert({ id: workflowId, workspaceId: WORKSPACE, family: "feature-dev", name: "本机流程", description: "local workflow", version: 1,
    nodes: [{ id: "start", type: "start", label: "start", position: { x: 0, y: 0 } }, { id: "end", type: "end", label: "end", position: { x: 100, y: 0 } }],
    edges: [{ id: "start-end", sourceNodeId: "start", targetNodeId: "end", dataMappings: [] }], workflowKnowledgeBundleIds: [], kind: "custom" });
  const reader = new OrchAssetAuthorityRuntimeReadService(createClientDbOrchAssetLegacyRuntimeReader(f.db, { requireCompleteDefinitions: true }), {
    listAssets() { throw new Error("LOCAL_WORKFLOW_MUST_NOT_READ_SERVER"); },
    getAsset() { throw new Error("LOCAL_WORKFLOW_MUST_NOT_READ_SERVER"); },
    getCacheVersion() { throw new Error("LOCAL_WORKFLOW_MUST_NOT_READ_SERVER"); },
  }, { getRuntimeReadinessRequirement: () => null });
  f.ctx.orchAssetLaunchSnapshot = new OrchAssetLaunchSnapshotService(reader);
  const engine = new OrchestrationEngine({ db: f.appDb.forWorkspace(WORKSPACE), threads: new ThreadStore(), sessions: {} as ApiHandlerContext["sessions"], workspaces: f.ctx.workspaces,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 }, emitConversation() {}, emitRaw() {} });
  f.ctx.orchEngine = engine;
  f.db.scheduledTaskConfigs.create({ config: config({ taskType: "workflow", payload: { contextWorkspaceId: WORKSPACE, workflowId,
    intake: { goal: "本机流程目标", workspaceScope: { scopeType: "shared_workspace", scopeId: "foreign" }, requester: { userId: "foreign" } } as never } }), at: 1 });
  return engine;
}

test("本机流程复用完整本机图和真实后台启动，受理历史记录已触发", async () => fixture(async f => {
  const engine = installWorkflow(f);
  try {
    const run = await f.scheduler.runLocalNow("task-1");
    assert.equal(run.status, "success"); assert.match(run.summary!, /已触发/);
    const instance = f.db.orchInstances.get(run.workflowInstanceId!, { strictScope: true });
    assert.equal(instance?.assetRuntimeSnapshot?.authorityMode, "legacy");
    assert.deepEqual(instance?.intakeSnapshot.workspaceScope, { scopeType: "local_workspace", scopeId: WORKSPACE });
    assert.equal(instance?.runtimeConfig?.initiatorUserId, `local:${CLIENT}`);
    assert.deepEqual(instance?.runtimeConfig?.executionProfileScope, { scopeType: "local_workspace", scopeId: WORKSPACE });
    await engine.waitForInFlightWork();
    assert.equal(f.db.scheduledTaskRuns.get(run.id)?.status, "success");
  } finally { await engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
}));

test("本机模型准备沿原 owner：稍后保留运行，确认打断等待且零迟到实例", async () => fixture(async f => {
  const engine = installWorkflow(f);
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] }, Date.now(), "local-update-wait");
  const running = f.scheduler.runLocalNow("task-1");
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.db.scheduledTaskRuns.list({}).items[0].status, "running");
    assert.equal(f.scheduler.hasInFlightWork(), true);
    f.scheduler.beginUpdateStop("local-update-confirmed");
    await f.scheduler.stopForUpdate({ requestId: "local-update-confirmed", timeoutMs: 2_000 });
    assert.equal((await running).status, "failed");
    assert.equal(f.db.scheduledTaskRuns.list({}).items[0].errorMessage, "SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE");
    cancelEngineModelCatalogDispatchPause("local-update-wait");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.db.orchInstances.listByWorkspace(WORKSPACE).length, 0);
  } finally { cancelEngineModelCatalogDispatchPause("local-update-wait"); await running; await engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
}));

test("本机事务日志保留领域原因码和内部 cause，不输出 SQL/脚本正文", async t => fixture(async ({ db, appDb, scheduler }) => {
  const entries: unknown[][] = [];
  mockTaskLog(t, appDb, "error", (...args: unknown[]) => { entries.push(args); });
  db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  db.db.exec("CREATE TRIGGER private_runtime BEFORE INSERT ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL_COMMAND_PAYLOAD'); END");
  await rejectedOperation(scheduler, scheduler.runLocalNow("task-1"), error => {
    assert.equal((error as { code: string }).code, "SCHEDULED_TASK_RUN_STORAGE_FAILED");
    assert.ok((error as Error).cause);
    return true;
  });
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /PRIVATE_SQL_COMMAND_PAYLOAD|AppendAllText/);
  assert.match(serialized, /rootCauseCode/);
  assert.match(serialized, /requestId/);
  assert.match(serialized, /revision/);
}));

test("D18 真实 tick 事务失败只记一次安全日志",async t=>fixture(async({db,appDb,scheduler})=>{
  const entries:unknown[][]=[];mockTaskLog(t,appDb,"error",(...args:unknown[])=>{entries.push(args);});
  db.scheduledTaskConfigs.create({config:config(),at:1});
  db.db.exec("CREATE TRIGGER fail_tick_once BEFORE INSERT ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT, 'PRIVATE_TICK_SQL'); END");
  await scheduler.syncAndTick("single-log");await assert.rejects(scheduler.waitForInFlightWork(), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  assert.equal(entries.length,1);assert.doesNotMatch(JSON.stringify(entries),/PRIVATE_TICK_SQL/);
}));

test("D18 本机事务日志再失败保留存储及日志双因",async t=>fixture(async({db,appDb,scheduler})=>{
  const logFailure=new Error("CONTROLLED_LOG_FAILURE");mockTaskLog(t,appDb,"error",()=>{throw logFailure;});
  db.scheduledTaskConfigs.create({config:config(),at:1});
  db.db.exec("CREATE TRIGGER fail_transaction_log BEFORE INSERT ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL'); END");
  await rejectedOperation(scheduler,scheduler.runLocalNow("task-1"),error=>{
    assert.ok(error instanceof AggregateError);assert.equal(error.errors[1],logFailure);assert.ok(error.cause);return true;
  });
}));

for(const logMode of ["ok","retry-would-pass","retry-would-fail"] as const)
test(`D18 F1 认领后流程关联失败 ${logMode} 保原错误且不重复日志`,async t=>fixture(async f=>{
  const logFailure=logMode!=="ok";
  const engine=installWorkflow(f),entries:unknown[][]=[];
  const firstLogFailure=new Error("CONTROLLED_FIRST_LOG_FAILURE"),secondLogFailure=new Error("CONTROLLED_SECOND_LOG_FAILURE");
  let attempts=0,dispatches=0,transactionError:unknown,executionError:unknown;
  const originalTransaction=(f.scheduler as any).localTransaction.bind(f.scheduler),originalLog=(f.scheduler as any).logLocalRunFailure.bind(f.scheduler);
  t.mock.method(f.scheduler as any,"localTransaction",(...args:unknown[])=>{
    try{return originalTransaction(...args);}catch(error){transactionError=error;throw error;}
  });
  t.mock.method(f.scheduler as any,"logLocalRunFailure",(...args:unknown[])=>{executionError=args[2];return originalLog(...args);});
  t.mock.method(engine,"startInBackground",async()=>{dispatches++;throw new Error("WORKFLOW_DISPATCH_FORBIDDEN");});
  mockTaskLog(t,f.appDb,"error",(...args:unknown[])=>{
    entries.push(args);attempts++;
    if(logFailure&&attempts===1)throw firstLogFailure;
    if(logMode==="retry-would-fail")throw secondLogFailure;
  });
  f.db.db.exec("CREATE TRIGGER fail_workflow_link_f1 BEFORE UPDATE OF last_workflow_instance_id ON scheduled_task_runtime_states WHEN NEW.last_workflow_instance_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'PRIVATE_F1_WORKFLOW_LINK'); END");
  try {
    if(logFailure)await rejectedOperation(f.scheduler,f.scheduler.runLocalNow("task-1"),error=>{
      assert.equal(error,transactionError);assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].code,"SCHEDULED_TASK_RUN_STORAGE_FAILED");assert.equal(error.errors[1],firstLogFailure);
      assert.equal(error.cause,error.errors[0]);return true;
    });
    else {
      const run=await f.scheduler.runLocalNow("task-1");assert.equal(run.status,"failed");assert.equal(run.errorMessage,"SCHEDULED_TASK_RUN_STORAGE_FAILED");
      assert.equal(entries.length,1);assert.equal((entries[0][2] as {runId:string}).runId,run.id);
    }
    assert.equal(executionError,transactionError);assert.equal(attempts,1);
    assert.equal(f.db.orchInstances.listByWorkspace(WORKSPACE).length,1);assert.equal(dispatches,0);
    const run=f.db.scheduledTaskRuns.list({}).items[0];assert.equal(run.status,logFailure?"running":"failed");
    assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1","local"))?.runningRunId,logFailure?run.id:null);
    assert.doesNotMatch(JSON.stringify(entries),/PRIVATE_F1_WORKFLOW_LINK/);
  } finally {await engine.waitForInFlightWork();resetEngineModelCatalogRuntimeForTest();}
}));

for(const logMode of ["ok","retry-would-pass","retry-would-fail"] as const)
test(`D18 F2 流程启动异常 ${logMode} 保首次日志失败且不继续终结`,async t=>fixture(async f=>{
  const engine=installWorkflow(f),businessError=new Error("CONTROLLED_WORKFLOW_START_FAILURE"),firstLogError=new Error("CONTROLLED_FIRST_EXECUTION_LOG_FAILURE");
  const secondLogError=new Error("CONTROLLED_SECOND_EXECUTION_LOG_FAILURE"),inputs:unknown[]=[],entries:unknown[][]=[];
  let attempts=0,starts=0,innerFailure:unknown;
  const originalLog=(f.scheduler as any).logLocalRunFailure.bind(f.scheduler);
  t.mock.method(f.scheduler as any,"logLocalRunFailure",(...args:unknown[])=>{
    inputs.push(args[2]);try{return originalLog(...args);}catch(error){innerFailure??=error;throw error;}
  });
  t.mock.method(engine,"startInBackground",async()=>{starts++;throw businessError;});
  mockTaskLog(t,f.appDb,"error",(...args:unknown[])=>{
    entries.push(args);attempts++;if(logMode!=="ok"&&attempts===1)throw firstLogError;
    if(logMode==="retry-would-fail")throw secondLogError;
  });
  try{
    if(logMode==="ok"){
      const run=await f.scheduler.runLocalNow("task-1");assert.equal(run.status,"failed");assert.equal(entries.length,1);
      assert.equal((entries[0][2] as {runId:string}).runId,run.id);assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1","local"))?.runningRunId,null);
    }else await rejectedOperation(f.scheduler,f.scheduler.runLocalNow("task-1"),error=>{
      assert.equal(error,innerFailure);assert.ok(error instanceof AggregateError);assert.equal(error.errors.length,2);
      assert.equal(error.errors[0],businessError);assert.equal(error.errors[1],firstLogError);assert.equal(error.cause,businessError);
      assert.equal((error as AggregateError & {code?:string}).code,"SCHEDULED_TASK_EXECUTION_LOG_FAILED");return true;
    });
    assert.equal(inputs[0],businessError);if(logMode!=="ok")assert.equal(inputs[1],innerFailure);
    assert.equal(attempts,1);assert.equal(starts,1);assert.equal(f.db.orchInstances.listByWorkspace(WORKSPACE).length,1);
    const saved=f.db.scheduledTaskRuns.list({}).items[0];assert.equal(saved.status,logMode==="ok"?"failed":"running");
    assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1","local"))?.runningRunId,logMode==="ok"?null:saved.id);
  }finally{await engine.waitForInFlightWork();resetEngineModelCatalogRuntimeForTest();}
}));

test("本机脚本非零退出保存失败态，安全日志关联原运行且不输出脚本正文", async t => fixture(async ({ db, appDb, scheduler }) => {
  const entries: any[][] = [];
  mockTaskLog(t, appDb, "error", (...args: any[]) => { entries.push(args); });
  db.scheduledTaskConfigs.create({ config: config({ payload: { ...config().payload, command: "echo PRIVATE_SCRIPT_BODY; exit 7" } }), at: 1 });
  const run = await scheduler.runLocalNow("task-1");
  assert.equal(run.status, "failed");
  const owned = entries.find(entry => entry[2]?.code === "SCHEDULED_TASK_SCRIPT_FAILED")?.[2];
  assert.equal(owned.runId, run.id); assert.equal(owned.requestId, run.id);
  assert.equal(owned.taskId, run.taskId); assert.equal(owned.exitCode, 7); assert.equal(owned.revision, 1);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_SCRIPT_BODY/);
}));

test("首次 tick 共用安全投影保留配置和聚合根因，不反射任意 SQL 正文", () => {
  const cause = Object.assign(new Error("PRIVATE_SQL_BODY"), { code: "SCHEDULED_TASK_CONFIG_CORRUPT", taskId: "task-safe", field: "payload_json", rootCauseCode: "SQLITE_ERROR:19" });
  const projected = toErrorLog(new AggregateError([cause], "PRIVATE_AGGREGATE_BODY"));
  const root = (projected.error.errors as Array<Record<string, unknown>>)[0];
  assert.equal(root.systemCode, "SCHEDULED_TASK_CONFIG_CORRUPT"); assert.equal(root.taskId, "task-safe");
  assert.equal(root.field, "payload_json"); assert.equal(root.rootCauseCode, "SQLITE_ERROR:19");
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SQL_BODY|PRIVATE_AGGREGATE_BODY/);
});

test("重启可见本机并发延期且出队原子认领失败保队列零派发", async t => fixture(async f => {
  f.db.scheduledTaskConfigs.create({ config: config({ cronExpr: "0 0 1 1 *" }), at: 1 });
  const key = scheduledTaskRuntimeKey("task-1", "local");
  f.db.scheduledTaskRuntimeStates.markStarted({ taskId: key, clientId: CLIENT, deviceId: DEVICE, scheduledAt: 100, runId: "old-run", startedAt: 100 });
  f.db.scheduledTaskRuntimeStates.queueLocalConcurrency({ taskId: "task-1", clientId: CLIENT, deviceId: DEVICE, runId: "old-run", scheduledAt: 200, at: 200 });
  await rejectedOperation(f.scheduler, f.scheduler.syncAndTick("restart-orphan"), { code: "SCHEDULED_TASK_ORPHAN_RUNNING" });
  assert.equal(f.db.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, 200);
  f.db.scheduledTaskRuntimeStates.markFinished({ taskId: key, runId: "old-run", finishedAt: 300 });
  const before = f.db.scheduledTaskRuntimeStates.get(key);
  const logs: unknown[][] = [];
  mockTaskLog(t, f.appDb, "error", (...args: unknown[]) => { logs.push(args); });
  f.db.db.exec("CREATE TRIGGER fail_dequeue_claim BEFORE UPDATE ON scheduled_task_runtime_states WHEN NEW.running_run_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'PRIVATE_DEQUEUE_SQL'); END");
  await f.scheduler.syncAndTick("restart-claim-failed"); await assert.rejects(settle(f.scheduler), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  assert.deepEqual(f.db.scheduledTaskRuntimeStates.get(key), before);
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
  assert.match(JSON.stringify(logs), /SCHEDULED_TASK_RUN_STORAGE_FAILED/);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_DEQUEUE_SQL/);
  f.db.db.exec("DROP TRIGGER fail_dequeue_claim");
  const restarted = new ScheduledTaskScheduler({ config: f.config, deviceId: DEVICE, apiContext: f.ctx, localApiContext: f.ctx });
  try { await restarted.syncAndTick("restart-dequeue"); await settle(restarted); }
  finally { await restarted.stopAndDrain(); }
  assert.equal(f.db.scheduledTaskRuns.list({}).items[0].status, "success");
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  assert.equal(f.db.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, null);
}));

for (const boundary of ["pause", "close"] as const) test(`本机并发延期在 ${boundary} 时保留，恢复沿原入口只出队一次`, async () => fixture(async f => {
  const task = config({ cronExpr: "0 0 1 1 *", missedPolicy: "run_once_on_reconnect" });
  f.db.scheduledTaskConfigs.create({ config: task, at: 1 });
  const key = scheduledTaskRuntimeKey(task.id, "local");
  f.db.scheduledTaskRuntimeStates.markStarted({ taskId: key, clientId: CLIENT, deviceId: DEVICE, scheduledAt: 100, runId: "previous", startedAt: 100 });
  f.db.scheduledTaskRuntimeStates.queueLocalConcurrency({ taskId: task.id, clientId: CLIENT, deviceId: DEVICE, runId: "previous", scheduledAt: 200, at: 200 });
  f.db.scheduledTaskRuntimeStates.markFinished({ taskId: key, runId: "previous", finishedAt: 300 });
  if (boundary === "pause") {
    f.pause(true); await f.scheduler.syncAndTick("update-prepared");
  } else await f.scheduler.stopAndDrain();
  assert.equal(f.db.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, 200);
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  f.pause(false);
  const resumed = boundary === "close" ? new ScheduledTaskScheduler({ config: f.config, deviceId: DEVICE, apiContext: f.ctx, localApiContext: f.ctx }) : f.scheduler;
  try { await resumed.syncAndTick("resumed"); await settle(resumed); }
  finally { if (boundary === "close") await resumed.stopAndDrain(); }
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  assert.equal(f.db.scheduledTaskRuns.list({}).items[0].scheduledAt, 200);
  assert.equal(f.db.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, null);
}));

test("运行中从 queue_one 改 skip 后真实 tick 写更晚跳过，停用消费不倒退水位", async () => fixture(async f => {
  const waiting = process.platform === "win32"
    ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'started'), 'ok'); $limit = [DateTime]::UtcNow.AddSeconds(6); while (!(Test-Path released) -and [DateTime]::UtcNow -lt $limit) { Start-Sleep -Milliseconds 20 }"
    : "touch started; n=0; while [ ! -e released ] && [ $n -lt 120 ]; do sleep .05; n=$((n+1)); done";
  const task = config({ payload: { ...config().payload, command: waiting } });
  f.db.scheduledTaskConfigs.create({ config: task, at: 1 });
  const running = f.scheduler.runLocalNow(task.id);
  const clock = Date.now;
  try {
    await waitForFile(path.join(f.root, "started"));
    const minute = Math.floor(clock() / 60_000) * 60_000;
    await f.scheduler.syncAndTick("queue-first");
    f.db.scheduledTaskConfigs.update({ config: { ...task, concurrencyPolicy: "skip_if_running" }, expectedRevision: 1, at: 2 });
    Date.now = () => minute + 60_000;
    await f.scheduler.syncAndTick("skip-later");
    Date.now = clock;
    f.db.scheduledTaskConfigs.setEnabled({ taskId: task.id, enabled: false, expectedRevision: 2, at: 3 });
    assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey(task.id, "local"))?.lastScheduledAt, minute + 60_000);
    assert.equal(f.db.scheduledTaskRuns.list({}).items.some(run => run.status === "skipped" && run.scheduledAt === minute + 60_000), true);
  } finally { Date.now = clock; fs.writeFileSync(path.join(f.root, "released"), "ok"); await running; }
}));

test("本机扫描已有失败时更新暂停仍返回失败，后续任务零派发", async t => fixture(async f => {
  f.db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  f.db.scheduledTaskConfigs.create({ config: config({ id: "task-2" }), at: 1 });
  f.db.scheduledTaskRuntimeStates.markStarted({ taskId: scheduledTaskRuntimeKey("task-1", "local"), clientId: CLIENT, deviceId: DEVICE, scheduledAt: 1, runId: "orphan", startedAt: 1 });
  mockTaskLog(t, f.appDb, "error", () => { f.pause(true); });
  await rejectedOperation(f.scheduler, f.scheduler.syncAndTick("pause-after-error"), { code: "SCHEDULED_TASK_ORPHAN_RUNNING" });
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
}));

test("本机配置读后修订竞争在同连接认领前失败且不派发", async t => fixture(async f => {
  f.db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  const get = f.appDb.getLocalScheduledTask.bind(f.appDb);
  let first = true;
  t.mock.method(f.appDb, "getLocalScheduledTask", (taskId: string) => {
    const result = get(taskId);
    if (first) {
      first = false;
      const competing = openClientDb({ dbPath: path.join(f.root, "client.db") });
      try { competing.withLocalScheduledTasks(WORKSPACE, repos => repos.configs.setEnabled({ taskId, expectedRevision: 1, enabled: false, at: 2 })); }
      finally { competing.close(); }
    }
    return result;
  });
  await rejectedOperation(f.scheduler, f.scheduler.runLocalNow("task-1"), { code: "SCHEDULED_TASK_RUN_CONFIG_CONFLICT" });
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local")), null);
  assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
}));

for (const change of ["disable", "delete", "revise"] as const) test(`迁移入队复核真实双连接配置竞争：${change}，旧快照零队列`, async t => fixture(async f => {
  f.db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  const gate = f.ctx.workspaceOperationGate!;
  gate.restoreMigration(WORKSPACE, "migration-after-config-read");
  f.ctx.workspaceOperationGate = gate;
  const list = f.appDb.listLocalScheduledTaskConfigs.bind(f.appDb);
  let changed = false;
  t.mock.method(f.appDb, "listLocalScheduledTaskConfigs", (device: { clientId: string; deviceId: string }) => {
    const snapshot = list(device);
    if (!changed) {
      changed = true;
      const competing = openClientDb({ dbPath: path.join(f.root, "client.db") });
      try {
        competing.withLocalScheduledTasks(WORKSPACE, repos => {
          if (change === "disable") repos.configs.setEnabled({ taskId: "task-1", expectedRevision: 1, enabled: false, at: 2 });
          else if (change === "delete") repos.configs.delete({ taskId: "task-1", expectedRevision: 1, at: 2 });
          else repos.configs.update({ config: config({ name: "new revision" }), expectedRevision: 1, at: 2 });
        });
      } finally { competing.close(); }
    }
    return snapshot;
  });
  await rejectedOperation(f.scheduler, f.scheduler.syncAndTick("migration-snapshot-race"), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.message, "SCHEDULED_TASK_SCAN_LOG_FAILED");
    assert.equal(error.errors[0].code, "SCHEDULED_TASK_RUN_CONFIG_CONFLICT"); assert.equal(error.errors[1].code, "WORKSPACE_MIGRATION_IN_PROGRESS"); return true;
  });
  assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local")), null);
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
  if (change === "disable") f.db.scheduledTaskConfigs.setEnabled({ taskId: "task-1", expectedRevision: 2, enabled: true, at: 3 });
  assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskRuntimeKey("task-1", "local")), null);
}));

test("本机持久队列结构损坏必须明确失败，不能按普通触发继续派发", async () => fixture(async f => {
  f.db.scheduledTaskConfigs.create({ config: config(), at: 1 });
  const key = scheduledTaskRuntimeKey("task-1", "local");
  f.db.scheduledTaskRuntimeStates.markSkipped({ taskId: key, clientId: CLIENT, deviceId: DEVICE, scheduledAt: 1, at: 1 });
  f.db.db.prepare("UPDATE scheduled_task_runtime_states SET queued_scheduled_at = 2, queued_reason = 'damaged', queued_operation_id = NULL WHERE task_id = ?").run(key);
  await rejectedOperation(f.scheduler, f.scheduler.syncAndTick("damaged-queue"), { code: "SCHEDULED_TASK_RUNTIME_CORRUPT", field: "queue" });
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
}));

for (const change of ["disable", "delete"] as const) test(`本机迁移延期 ${change} 后消费旧触发，重新启用不补跑`, async () => fixture(async f => {
  const task = config({ cronExpr: "0 0 1 1 *" });
  f.db.scheduledTaskConfigs.create({ config: task, at: 1 });
  const key = scheduledTaskRuntimeKey(task.id, "local");
  f.db.scheduledTaskRuntimeStates.queueForWorkspaceMigration({ taskId: key, clientId: CLIENT, deviceId: DEVICE,
    scheduledAt: 2_000, operationId: "local-migration", at: 2 });
  if (change === "disable") f.db.scheduledTaskConfigs.setEnabled({ taskId: task.id, expectedRevision: 1, enabled: false, at: 3 });
  else f.db.scheduledTaskConfigs.delete({ taskId: task.id, expectedRevision: 1, at: 3 });
  await f.scheduler.syncAndTick("disabled-queue");
  assert.equal(f.db.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, null);
  assert.equal(f.db.scheduledTaskRuntimeStates.get(key)?.lastScheduledAt, 2_000);
  if (change === "disable") {
    f.db.scheduledTaskConfigs.setEnabled({ taskId: task.id, expectedRevision: 2, enabled: true, at: 4 });
    await f.scheduler.syncAndTick("enabled-again"); await settle(f.scheduler);
  }
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
}));

test("本机模型准备由原更新 control 执行 prepare、稍后与确认", async () => fixture(async f => {
  const engine = installWorkflow(f);
  f.db.scheduledTaskConfigs.update({ config: config({ taskType: "workflow", missedPolicy: "run_once_on_reconnect",
    payload: { contextWorkspaceId: WORKSPACE, workflowId: "local-workflow" as WorkflowId } }), expectedRevision: 1, at: 2 });
  const control = createDesktopUpdateControl({ context: f.ctx, requestId: "local-control", timeoutMs: 2_000, scheduledTaskScheduler: f.scheduler,
    queueDispatcher: { hasInFlightWork: () => false, assertNoFailure() {}, resumeWorkspace() {} }, terminalManager: { hasRunningTerminals: () => false, stopAllForUpdate: async () => {} },
    hasBlockingTransaction: () => false, hasKnowledgeWork: () => false, stopKnowledgeWork: async () => {}, hasAssetDraftWork: () => false,
    stopAssetDraftWork: async () => {}, interruptTurn: async () => {} });
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] }, Date.now(), "local-control-wait");
  const running = f.scheduler.runLocalNow("task-1");
  try {
    await new Promise(resolve => setImmediate(resolve));
    f.pause(true);
    assert.deepEqual(await control.prepare!(), { hasRunningSessions: true });
    await assert.rejects(f.scheduler.runLocalNow("task-1"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
    f.pause(false); await control.resume!();
    await f.scheduler.syncAndTick("after-later");
    assert.equal(f.db.scheduledTaskRuns.list({}).items[0].status, "running");
    f.pause(true); await control.prepare!(); await control.interrupt!();
    assert.equal((await running).status, "failed");
    cancelEngineModelCatalogDispatchPause("local-control-wait");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.db.orchInstances.listByWorkspace(WORKSPACE).length, 0);
  } finally { cancelEngineModelCatalogDispatchPause("local-control-wait"); await running; await engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
}));
