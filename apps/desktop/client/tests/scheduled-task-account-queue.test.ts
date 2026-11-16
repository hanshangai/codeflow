import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import type { ClientScheduledTaskReportRequestBody, LocalScheduledTaskConfigInput, ScheduledTask, ScheduledTaskRun, WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";
import { openClientDb } from "../src/db/clientDb.js";
import { scheduledTaskRuntimeKey } from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";
import { ScheduledTaskScheduler, toErrorLog } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { handleScheduledTaskRunNow } from "../src/app/handlers/scheduledTaskHandlers.js";
import { logger } from "../src/logger.js";

const CLIENT = "queue-client", DEVICE = "queue-device", TASK = "queue-task", WORKSPACE = "queue-client:workspace" as WorkspaceId;
const MINUTE = 60_000, BASE = 1_800_000_000_000;
const OWNER = { serverOrigin: "http://127.0.0.1:1", ownerUserId: "queue-owner", clientId: CLIENT, deviceId: DEVICE };

/** 断言与故障注入使用运行捕获的实际 W 连接。 */
function runtime(db: ReturnType<typeof openClientDb>) {
  return db.withAccountScheduledTasks(WORKSPACE, repos => repos.runtime.getAccount(TASK, OWNER));
}

/** 注入真实物理库故障，不依赖已结束的临时 Repo 对象。 */
function execRuntime(db: ReturnType<typeof openClientDb>, sql: string): void {
  db.withAccountScheduledTasks(WORKSPACE, repos => repos.db.exec(sql));
}

/** 真实脚本以文件门结束；有界等待不依赖测试的计划时间。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 12_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "account queue boundary timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** 构造账号配置，真实脚本记录启动 PID、完成顺序并等待本例释放。 */
function task(command?: string): ScheduledTask {
  const waiting = process.platform === "win32"
    ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'started'), [string]$PID); $limit = [DateTime]::UtcNow.AddSeconds(15); while (!(Test-Path released) -and [DateTime]::UtcNow -lt $limit) { Start-Sleep -Milliseconds 20 }; if (!(Test-Path released)) { exit 9 }; [IO.File]::AppendAllText((Join-Path (Get-Location) 'executed'), 'first' + [Environment]::NewLine)"
    : "echo $$ > started; n=0; while [ ! -e released ] && [ $n -lt 300 ]; do sleep .05; n=$((n+1)); done; [ -e released ] || exit 9; echo first >> executed";
  return { id: TASK, ownerUserId: "queue-owner", clientId: CLIENT, deviceId: DEVICE,
    clientNameSnapshot: "queue client", deviceLabelSnapshot: null, name: "账号排队", description: null,
    taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "powershell" : "sh", contextWorkspaceId: WORKSPACE,
      command: command ?? waiting, cwdRelative: ".", envRefs: [] },
    concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 20_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
}

/** 每例隔离 SQLite/fetch/计划时钟，退出先释放并排空真实脚本，再关闭数据库。 */
async function fixture(t: TestContext, action: (f: {
  db: ReturnType<typeof openClientDb>; scheduler: ScheduledTaskScheduler; root: string;
  reports: ClientScheduledTaskReportRequestBody[]; errors: unknown[][];
  remote: { tasks: ScheduledTask[]; sync?: () => Promise<Response>; nextRuns?: () => Promise<Response> };
  clock: { now: number }; gates: { paused: boolean };
  context: ApiHandlerContext;
  start(): Promise<ScheduledTaskRun>; queue(): Promise<void>; release(): void; lines(): string[];
}) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-queue-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  db.workspaces.upsert({ id: WORKSPACE, title: "account queue", path: root });
  const reports: ClientScheduledTaskReportRequestBody[] = [], errors: unknown[][] = [];
  const remote: { tasks: ScheduledTask[]; sync?: () => Promise<Response>; nextRuns?: () => Promise<Response> } = { tasks: [task()] };
  const clock = { now: BASE + 5_000 }, gates = { paused: false };
  const originalFetch = globalThis.fetch;
  t.mock.method(Date, "now", () => clock.now);
  t.mock.method(logger, "error", (...args: unknown[]) => { errors.push(args); });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:1");
    if (url.pathname.endsWith("/sync")) return remote.sync ? await remote.sync() : Response.json({ ok: true, tasks: remote.tasks, serverNow: clock.now });
    assert.equal(url.pathname, "/api/client/scheduled-tasks/report");
    const body = JSON.parse(String(init?.body)) as ClientScheduledTaskReportRequestBody;
    reports.push(body);
    return !body.run && remote.nextRuns ? await remote.nextRuns() : Response.json({ ok: true, serverNow: clock.now });
  };
  const context = { db, workspaces: new Map([[WORKSPACE, root]]),
  } as unknown as ApiHandlerContext;
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: CLIENT, apiKey: "isolated-queue-key", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: DEVICE, apiContext: context, isTaskAdmissionPaused: () => gates.paused,
    captureAccountContext: () => ({ serverOrigin: "http://127.0.0.1:1", ownerUserId: "queue-owner", clientId: CLIENT, deviceId: DEVICE, generation: 1, assertCurrent() {} }) });
  const owned: Promise<PromiseSettledResult<ScheduledTaskRun>>[] = [];
  const release = () => fs.writeFileSync(path.join(root, "released"), "ok");
  try {
    await action({ root, db, scheduler, reports, errors, remote, clock, gates, context, release,
      /** 通过公开手动入口认领首轮，立即捕获结果以免预期失败成为 unhandled rejection。 */
      start() { const running = scheduler.runNow(TASK); owned.push(running.then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }))); return running; },
      /** 先观察真实脚本，再推进一分钟，以公开 tick 形成账号 queue_one。 */
      async queue() { await waitFor(() => fs.existsSync(path.join(root, "started"))); clock.now = BASE + MINUTE + 5_000; await scheduler.syncAndTick("queue-while-running"); },
      /** 真实文件记录第二轮使用的脚本内容，不以内部 Map 断言代替执行证据。 */
      lines() { return fs.existsSync(path.join(root, "executed")) ? fs.readFileSync(path.join(root, "executed"), "utf8").trim().split(/\r?\n/) : []; },
    });
  } finally {
    remote.sync = undefined; remote.nextRuns = undefined; release();
    const failures: unknown[] = [];
    try { await scheduler.stopAndDrain(); } catch (error) { failures.push(error); }
    await Promise.all(owned);
    globalThis.fetch = originalFetch;
    t.mock.restoreAll();
    try { db.close(); } catch (error) { failures.push(error); }
    try { fs.rmSync(root, { recursive: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "account queue fixture cleanup failed");
  }
}

for (const change of ["disabled", "deleted", "disabled_enabled", "revised"] as const) {
  test(`账号 queue_one 出队使用已同步配置：${change}`, async t => fixture(t, async f => {
    const running = f.start(); await f.queue();
    const originalRunId = runtime(f.db)!.runningRunId;
    f.remote.tasks = change === "deleted" ? [] : [{ ...task(), enabled: change === "revised",
      payload: change === "revised" ? { ...task().payload, command: process.platform === "win32"
        ? "[IO.File]::AppendAllText((Join-Path (Get-Location) 'executed'), 'revised' + [Environment]::NewLine)" : "echo revised >> executed" } : task().payload }];
    await f.scheduler.sync("configuration-change");
    assert.equal(runtime(f.db)?.runningRunId, originalRunId);
    if (change === "disabled_enabled") { f.remote.tasks = [task()]; await f.scheduler.sync("enable-again"); }
    f.release(); assert.equal((await running).status, "success");
    await f.scheduler.waitForInFlightWork();
    assert.deepEqual(f.lines(), change === "revised" ? ["first", "revised"] : ["first"]);
    assert.equal(f.reports.filter(report => report.run?.status === "running").length, change === "revised" ? 2 : 1);
    assert.equal(f.reports.some(report => report.run?.status === "skipped"), false);
    if (change === "revised") assert.equal(f.reports.filter(report => report.run?.status === "running")[1]?.run?.scheduledAt, BASE + MINUTE);
    if (change === "disabled_enabled") {
      await f.scheduler.syncAndTick("same-minute"); await f.scheduler.waitForInFlightWork();
      assert.deepEqual(f.lines(), ["first"]);
      f.clock.now += MINUTE; await f.scheduler.syncAndTick("next-minute"); await f.scheduler.waitForInFlightWork();
      assert.deepEqual(f.lines(), ["first", "first"]);
    }
  }));
}

for (const storageFailure of ["abort", "ignore"] as const) {
test(`已观察停用后的去重${storageFailure}显式拒绝，恢复后先消费旧触发再启用`, async t => fixture(t, async f => {
  const running = f.start(); await f.queue();
  const runId = runtime(f.db)!.runningRunId;
  execRuntime(f.db, `CREATE TRIGGER fail_queue_skip BEFORE UPDATE OF last_scheduled_at ON scheduled_task_runtime_states BEGIN SELECT ${storageFailure === "abort" ? "RAISE(ABORT, 'controlled queue skip failure')" : "RAISE(IGNORE)"}; END`);
  f.remote.tasks = [{ ...task(), enabled: false }];
  await assert.rejects(f.scheduler.sync("disable-storage-failure"), error => {
    assert.equal((error as { code?: string }).code, "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED");
    assert.equal(JSON.stringify(toErrorLog(error)).includes("isolated-queue-key"), false);
    return true;
  });
  assert.equal(runtime(f.db)?.runningRunId, runId);
  assert.equal(runtime(f.db)?.lastScheduledAt, BASE + 5_000);
  assert.equal(f.reports.filter(report => report.run?.status === "running").length, 1);
  execRuntime(f.db, "DROP TRIGGER fail_queue_skip");
  f.remote.tasks = [task()]; await f.scheduler.sync("enable-after-storage-recovery");
  assert.equal(runtime(f.db)?.lastScheduledAt, BASE + MINUTE);
  f.release(); assert.equal((await running).status, "success");
  await f.scheduler.syncAndTick("same-minute-after-recovery"); await f.scheduler.waitForInFlightWork();
  assert.deepEqual(f.lines(), ["first"]);
}));
}

test("停用消费不倒退较晚水位，并保持同 ID 本机配置与持久队列", async t => fixture(t, async f => {
  const account = task();
  const local: LocalScheduledTaskConfigInput = { id: TASK, source: "local", clientId: CLIENT, deviceId: DEVICE,
    name: "本机同 ID", description: null, taskType: account.taskType, cronExpr: account.cronExpr, timezone: account.timezone,
    enabled: true, payload: account.payload, concurrencyPolicy: account.concurrencyPolicy, missedPolicy: account.missedPolicy,
    timeoutMs: account.timeoutMs, workspaceScope: { scopeType: "local_workspace", scopeId: WORKSPACE } };
  f.db.withLocalScheduledTasks(WORKSPACE, repos => repos.configs.create({ config: local, at: 1 }));
  const localKey = scheduledTaskRuntimeKey(TASK, "local");
  f.db.withLocalScheduledTasks(WORKSPACE, repos => repos.runtime.queueForWorkspaceMigration({ taskId: localKey, clientId: CLIENT, deviceId: DEVICE, scheduledAt: 1_000, operationId: "local-operation", at: 2 }));
  const localBefore = f.db.withLocalScheduledTasks(WORKSPACE, repos => repos.runtime.get(localKey));
  const running = f.start(); await f.queue();
  const later = BASE + 3 * MINUTE + 4_000;
  f.db.withAccountScheduledTasks(WORKSPACE, repos => repos.runtime.skipAccount({ taskId: TASK, owner: OWNER, scheduledAt: later, at: later }));
  f.remote.tasks = [{ ...task(), enabled: false }]; await f.scheduler.sync("disabled-after-later-watermark");
  assert.equal(runtime(f.db)?.lastScheduledAt, BASE + 3 * MINUTE);
  assert.deepEqual(f.db.withLocalScheduledTasks(WORKSPACE, repos => repos.runtime.get(localKey)), localBefore);
  assert.equal(f.db.getLocalScheduledTask(TASK)?.enabled, true);
  assert.equal(f.db.listLocalScheduledTaskRuns({ clientId: CLIENT, deviceId: DEVICE, offset: 0, limit: 50 }).total, 0);
  f.release(); await running; assert.deepEqual(f.lines(), ["first"]);
}));

for (const failure of ["network", "json", "rejected"] as const) {
  test(`同步${failure}失败不能当删除消费旧队列`, async t => fixture(t, async f => {
    const running = f.start(); await f.queue();
    f.remote.sync = async () => {
      if (failure === "network") throw new Error("controlled transport failure");
      return failure === "json" ? new Response("invalid json") : Response.json({ ok: false }, { status: 403 });
    };
    await assert.rejects(f.scheduler.sync("failed-configuration-sync"), { code: "SCHEDULED_TASK_API_FAILED" });
    f.remote.sync = undefined; f.release(); await running;
    assert.deepEqual(f.lines(), ["first", "first"]);
  }));
}

test("运行结束等待已有同步的明确拒绝，不能继续沿旧配置派发", async t => fixture(t, async f => {
  const running = f.start(); await f.queue();
  let releaseSync!: () => void, syncing = false;
  const pending = new Promise<void>(resolve => { releaseSync = resolve; });
  f.remote.sync = async () => { syncing = true; await pending; throw new Error("in-flight sync rejected"); };
  const synced = f.scheduler.sync("pending-configuration-sync");
  const syncRejected = assert.rejects(synced, { code: "SCHEDULED_TASK_API_FAILED" });
  try {
    await waitFor(() => syncing); f.release();
    const runId = f.reports.find(report => report.run?.status === "running")!.run!.id;
    await waitFor(() => f.db.getAccountScheduledTaskRun(runId, OWNER)?.run.status === "success");
    assert.equal(f.reports.some(report => report.run?.status === "success"), false);
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally { releaseSync(); }
  await syncRejected;
  await assert.rejects(running, { code: "SCHEDULED_TASK_API_FAILED" });
  assert.deepEqual(f.lines(), ["first"]);
  assert.equal(f.reports.filter(report => report.run?.status === "running").length, 1);
  f.remote.sync = undefined;
  await f.scheduler.syncAndTick("retry-after-explicit-sync-failure"); await f.scheduler.waitForInFlightWork();
  assert.deepEqual(f.lines(), ["first", "first"]);
}));

test("没有排队触发时首轮先提交成功，原同步失败只阻止耐久回执确认", async t => fixture(t, async f => {
  const running = f.start();
  await waitFor(() => fs.existsSync(path.join(f.root, "started")));
  let releaseSync!: () => void, syncing = false;
  const pending = new Promise<void>(resolve => { releaseSync = resolve; });
  f.remote.sync = async () => { syncing = true; await pending; throw new Error("unrelated sync failed"); };
  const synced = f.scheduler.sync("unrelated-pending-sync");
  const syncRejected = assert.rejects(synced, { code: "SCHEDULED_TASK_API_FAILED" });
  const result = running.then(value => ({ value }), error => ({ error }));
  const runId = f.reports.find(report => report.run?.status === "running")!.run!.id;
  let settled = false;
  void result.then(() => { settled = true; });
  try {
    await waitFor(() => syncing); f.release();
    await waitFor(() => f.db.getAccountScheduledTaskRun(runId, OWNER)?.run.status === "success");
    assert.equal(settled, false);
    assert.equal(f.reports.some(report => report.run?.status === "success"), false);
  } finally { releaseSync(); }
  await syncRejected;
  const failed = await result;
  assert.ok("error" in failed);
  assert.equal((failed.error as Error & { code: string }).code, "SCHEDULED_TASK_API_FAILED");
  assert.equal(f.db.getAccountScheduledTaskRun(runId, OWNER)?.run.status, "success");
  assert.equal(f.db.getAccountScheduledTaskRun(runId, OWNER)?.run.reportSettlement, null);
  f.remote.sync = undefined;
  await f.scheduler.sync("recover-original-success");
  assert.equal(f.db.getAccountScheduledTaskRun(runId, OWNER)?.run.reportSettlement, "acknowledged");
  assert.deepEqual(f.lines(), ["first"]);
}));

test("nextRuns 上报失败不撤销已接收停用事实", async t => fixture(t, async f => {
  const running = f.start(); await f.queue();
  f.remote.tasks = [{ ...task(), enabled: false }];
  f.remote.nextRuns = async () => Response.json({ ok: false }, { status: 503 });
  await assert.rejects(f.scheduler.sync("disabled-report-failure"), { code: "SCHEDULED_TASK_API_FAILED" });
  f.remote.nextRuns = undefined; f.remote.tasks = [task()];
  await f.scheduler.sync("enabled-after-report-recovery");
  f.release(); await running;
  await f.scheduler.syncAndTick("same-minute-report-recovery"); await f.scheduler.waitForInFlightWork();
  assert.deepEqual(f.lines(), ["first"]);
}));

test("并发收尾与 tick 等待同一同步后只认领一个最新排队运行", async t => fixture(t, async f => {
  const running = f.start(); await f.queue();
  let releaseSync!: () => void, syncing = false;
  const pending = new Promise<void>(resolve => { releaseSync = resolve; });
  const revised = { ...task(), payload: { ...task().payload, command: process.platform === "win32"
    ? "[IO.File]::AppendAllText((Join-Path (Get-Location) 'executed'), 'concurrent' + [Environment]::NewLine)" : "echo concurrent >> executed" } };
  f.remote.sync = async () => { syncing = true; await pending; return Response.json({ ok: true, tasks: [revised], serverNow: f.clock.now }); };
  const synced = f.scheduler.sync("pending-queue-update");
  const ticked = f.scheduler.syncAndTick("concurrent-queue-drain");
  try {
    await waitFor(() => syncing); f.release();
    await waitFor(() => runtime(f.db)?.runningRunId === null);
  } finally { releaseSync(); }
  await Promise.all([synced, ticked, running]); await f.scheduler.waitForInFlightWork();
  assert.deepEqual(f.lines(), ["first", "concurrent"]);
  assert.equal(f.reports.filter(report => report.run?.status === "running").length, 2);
  assert.equal(f.reports.filter(report => report.run?.status === "running")[1]?.run?.scheduledAt, BASE + MINUTE);
}));

for (const gate of ["paused", "stopped"] as const) {
  test(`在途同步等待后重新核对${gate}准入`, async t => fixture(t, async f => {
    const running = f.start(); await f.queue();
    let releaseSync!: () => void, syncing = false;
    const pending = new Promise<void>(resolve => { releaseSync = resolve; });
    f.remote.sync = async () => { syncing = true; await pending; return Response.json({ ok: true, tasks: [task()], serverNow: f.clock.now }); };
    const synced = f.scheduler.sync("pending-gate-update");
    try {
      await waitFor(() => syncing); f.release();
      await waitFor(() => runtime(f.db)?.runningRunId === null);
      if (gate === "paused") f.gates.paused = true;
      else f.scheduler.stop();
    } finally { releaseSync(); }
    await Promise.all([synced, running]); assert.deepEqual(f.lines(), ["first"]);
  }));
}

test("真实定时入口只记录一次账号停止写失败并保安全上下文", async t => fixture(t, async f => {
  const running = f.start(); await f.queue();
  let interval: (() => void) | undefined;
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { interval = callback; return { unref() {} } as unknown as ReturnType<typeof setInterval>; });
  t.mock.method(globalThis, "clearInterval", () => {});
  f.remote.tasks = [{ ...task(), enabled: false }];
  execRuntime(f.db, "CREATE TRIGGER fail_interval_queue BEFORE UPDATE OF last_scheduled_at ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT, 'SENSITIVE_SCRIPT_BODY'); END");
  f.scheduler.start(); assert.ok(interval); interval();
  await waitFor(() => f.errors.some(args => args[1] === "scheduled task tick failed"));
  const logs = structuredClone(f.errors);
  execRuntime(f.db, "DROP TRIGGER fail_interval_queue");
  await f.scheduler.sync("recover-interval-stop"); f.release(); await running;
  assert.equal(logs.length, 1);
  const safe = (logs[0][2] as { error: Record<string, unknown> }).error;
  assert.equal(safe.systemCode, "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED");
  assert.equal(safe.requestId, `scheduled:${TASK}:${BASE + MINUTE}`);
  assert.equal(safe.taskId, TASK); assert.equal(safe.scheduledAt, BASE + MINUTE);
  assert.equal(safe.clientId, CLIENT); assert.equal(safe.deviceId, DEVICE);
  const storage = safe.cause as Record<string, unknown>;
  assert.equal(storage.systemCode, "ERR_SQLITE_ERROR");
  assert.equal(JSON.stringify(logs).includes("SENSITIVE_SCRIPT_BODY"), false);
  assert.equal(JSON.stringify(logs).includes("isolated-queue-key"), false);
}));

test("原账号手动handler失败只记一次请求日志，仍明确500且不泄漏cause", async t => fixture(t, async f => {
  const running = f.start(); await f.queue();
  f.remote.tasks = [{ ...task(), enabled: false }];
  execRuntime(f.db, "CREATE TRIGGER fail_manual_queue BEFORE UPDATE OF last_scheduled_at ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT, 'SENSITIVE_SCRIPT_BODY'); END");
  const sent: unknown[] = [];
  f.context.scheduledTaskScheduler = f.scheduler;
  f.context.send = message => { sent.push(message); };
  f.context.clientId = CLIENT; f.context.deviceId = DEVICE;
  await handleScheduledTaskRunNow(f.context, { t: "api.req", id: "manual-queue-request", method: "scheduledTasks.runNow", path: "/account", body: { taskId: TASK } });
  const logs = structuredClone(f.errors);
  execRuntime(f.db, "DROP TRIGGER fail_manual_queue");
  await f.scheduler.sync("recover-manual-stop"); f.release(); await running;
  assert.equal((sent[0] as { status: number }).status, 500);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], "account scheduled task run request failed");
  const fields = logs[0][2] as Record<string, unknown>;
  assert.equal(fields.requestId, "manual-queue-request"); assert.equal(fields.taskId, TASK);
  assert.equal(fields.clientId, CLIENT); assert.equal(fields.deviceId, DEVICE);
  const safe = fields.rootCause as Record<string, unknown>;
  assert.equal(safe.systemCode, "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED");
  assert.equal(safe.scheduledAt, BASE + MINUTE);
  assert.equal(JSON.stringify(logs).includes("SENSITIVE_SCRIPT_BODY"), false);
}));

test("调度安全投影保留可检索字段并拒绝任意正文", () => {
  const cause = Object.assign(new Error("SENSITIVE_SCRIPT_BODY"), { code: "ERR_SQLITE_ERROR" });
  const error = Object.assign(new Error("SENSITIVE_OUTER_BODY", { cause }), {
    code: "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED", requestId: `scheduled:${TASK}:${BASE + MINUTE}`,
    taskId: TASK, scheduledAt: BASE + MINUTE, clientId: CLIENT, deviceId: DEVICE,
  });
  const safe = toErrorLog(error).error;
  assert.equal(safe.requestId, error.requestId); assert.equal(safe.scheduledAt, error.scheduledAt);
  assert.equal(safe.clientId, CLIENT); assert.equal(safe.deviceId, DEVICE);
  assert.equal(JSON.stringify(safe).includes("SENSITIVE_"), false);
  const invalid = toErrorLog(Object.assign(error, { requestId: "Bearer secret", clientId: "bad\nvalue", deviceId: "bad space", scheduledAt: -1 })).error;
  assert.equal(invalid.requestId, undefined); assert.equal(invalid.clientId, undefined);
  assert.equal(invalid.deviceId, undefined); assert.equal(invalid.scheduledAt, undefined);
});

test("helloAck原处理块只使用调度安全投影，编排恢复投影保持原样", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const scheduled = source.match(/logClientStep\("error", "scheduled_tasks\.sync_after_hello"[\s\S]*?\n        \}\);/)?.[0];
  assert.ok(scheduled); assert.ok(scheduled.includes("...toScheduledTaskErrorLog(error)"));
  assert.equal(scheduled.includes("toErrorLogValue"), false);
  const recovery = source.match(/logClientStep\("error", "startup\.orchestration_recovery"[\s\S]*?\n\s*\}\);/)?.[0];
  assert.ok(recovery?.includes("error: toErrorLogValue(error)"));
  const logged: unknown[][] = [];
  const applyOriginalBlock = new Function("logClientStep", "config", "deviceIdentity", "toScheduledTaskErrorLog", "error", scheduled);
  const error = Object.assign(new Error("SENSITIVE_HELLO_BODY", { cause: new Error("SENSITIVE_SCRIPT_BODY") }), {
    code: "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED", requestId: "hello-queue-request", clientId: CLIENT, deviceId: DEVICE,
    taskId: TASK, scheduledAt: BASE + MINUTE,
  });
  applyOriginalBlock((...args: unknown[]) => logged.push(args), { clientId: CLIENT }, { deviceId: DEVICE }, toErrorLog, error);
  assert.equal(logged.length, 1);
  const fields = logged[0][4] as { error: Record<string, unknown> };
  assert.equal(fields.error.requestId, "hello-queue-request");
  assert.equal(fields.error.taskId, TASK); assert.equal(fields.error.scheduledAt, BASE + MINUTE);
  assert.equal(JSON.stringify(logged).includes("SENSITIVE_"), false);
});

for (const gate of ["paused", "stopped"] as const) {
  test(`账号出队保持原${gate}准入边界`, async t => fixture(t, async f => {
    const running = f.start(); await f.queue();
    if (gate === "paused") f.gates.paused = true;
    else f.scheduler.stop();
    f.release(); await running;
    assert.deepEqual(f.lines(), ["first"]);
    if (gate !== "stopped") {
      f.gates.paused = false;
      await f.scheduler.syncAndTick("gate-resumed"); await f.scheduler.waitForInFlightWork();
      assert.deepEqual(f.lines(), ["first", "first"]);
    }
  }));
}
