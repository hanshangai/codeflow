import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScheduledTask, ScheduledTaskRun, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { createDesktopUpdateControl } from "../src/runtime/desktopUpdateControl.js";
import { logger } from "../src/logger.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";

for (const logMode of ["ok", "workspace", "drain"] as const) test(`LSLOG 本机真实停止失败归原 W，日志双错保因 ${logMode}`, { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-scheduled-stop-log-")), workspaceId = "local-stop:workspace" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(root, "application.db") }); db.workspaces.upsert({ id: workspaceId, title: "local stop", path: root });
  const ctx = { db, clientId: "local-stop", deviceId: "local-device", localWorkspaceOnly: true, workspaces: new Map([[workspaceId, root]]) } as unknown as ApiHandlerContext;
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: "local-stop", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: "local-device", apiContext: ctx, localApiContext: ctx });
  db.withLocalScheduledTasks(workspaceId, repos => repos.configs.create({ at: 1, config: { id: "local-stop-task", source: "local", clientId: "local-stop", deviceId: "local-device",
    workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId }, name: "stop", description: null, taskType: "script", cronExpr: "0 0 1 1 *", timezone: "UTC", enabled: true,
    payload: { shell: "powershell", contextWorkspaceId: workspaceId, command: "[IO.File]::AppendAllText((Join-Path (Get-Location) 'started'), 'run'); while (!(Test-Path released)) { Start-Sleep -Milliseconds 20 }" },
    concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 15_000 } }));
  const entries: any[] = [], application: any[] = [], physical = db.writeWorkspaceLog, logFailure = false, diagnostic = new Error("PRIVATE_DRAIN_DIAGNOSTIC");
  t.mock.method(db, "writeWorkspaceLog", (id: WorkspaceId, entry: Parameters<typeof physical>[1]) => { entries.push({ id, entry }); if (logMode !== "ok" && entry.message === "scheduled script update stop failed") throw logFailure; physical(id, entry); });
  t.mock.method(logger, "error", (...args: unknown[]) => { application.push(args); if (logMode === "drain" && args[1] === "scheduled update drain failed") throw diagnostic; });
  const running = scheduler.runLocalNow("local-stop-task"); let stoppingMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    await waitFor(() => fs.existsSync(path.join(root, "started")));
    await assert.rejects(scheduler.waitForInFlightWork({ timeoutMs: 20 }), { code: "SCHEDULED_TASK_DRAIN_TIMEOUT" });
    assert.equal(scheduler.hasInFlightWork(), true);
    const spawn = childProcess.spawn, stopCause = Object.assign(new Error("PRIVATE_STOP_CAUSE"), { code: "EACCES" });
    stoppingMock = t.mock.method(childProcess, "spawn", ((command: string, args: readonly string[], options: any) => {
      if (command === "taskkill.exe") throw stopCause; return spawn(command, args, options);
    }) as typeof childProcess.spawn); syncBuiltinESMExports();
    await assert.rejects(scheduler.stopForUpdate({ requestId: "local-stop-request", timeoutMs: 80 }), error => {
      if (logMode !== "ok") {
        assert.ok(error instanceof AggregateError);
        const drain = logMode === "drain" ? error.errors[0] : error;
        if (logMode === "drain") { assert.equal(error.errors[1], diagnostic); assert.equal(error.cause, drain); }
        assert.ok(drain instanceof AggregateError); const aggregate = drain.errors.find(item => item?.code === "SCHEDULED_TASK_EXECUTION_LOG_FAILED");
        assert.ok(aggregate instanceof AggregateError); assert.equal(aggregate.errors[0].cause, stopCause); assert.equal(aggregate.errors[1], false); assert.equal(aggregate.cause, aggregate.errors[0]); }
      else { assert.equal((error as Error & { code: string }).code, "SCHEDULED_TASK_UPDATE_STOP_FAILED"); assert.equal((error as Error).cause, stopCause); }
      return true;
    });
    assert.equal(entries.filter(row => row.entry.message === "scheduled script update stop failed").length, 1);
    assert.equal(entries[0].id, workspaceId); assert.equal(entries[0].entry.data.requestId, "local-stop-request");
    assert.equal(application.filter(row => row[1] === "scheduled script update stop failed").length, 0);
    assert.equal(application.filter(row => row[1] === "scheduled update drain failed").length, logMode === "ok" ? 0 : 1);
    assert.doesNotMatch(JSON.stringify([entries, application]), /PRIVATE_STOP_CAUSE|PRIVATE_DRAIN_DIAGNOSTIC/);
  } finally {
    stoppingMock?.mock.restore(); syncBuiltinESMExports(); fs.writeFileSync(path.join(root, "released"), "ok");
    await running; await scheduler.stopAndDrain(); db.close(); fs.rmSync(root, { recursive: true });
  }
});

type ReportResponse = number | { status: number; text: string; requestId?: string } | void;

/** 等待真实脚本或 HTTP 边界到达指定状态。 */
async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "script boundary timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** 精确查询测试拥有的 PID，其他错误必须显式失败。 */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

/** 使用隔离 SQLite、真实 HTTP 和有限时长 PowerShell，退出时精确清理所拥有的进程。 */
async function fixture(run: (f: {
  scheduler: ScheduledTaskScheduler; control: ReturnType<typeof createDesktopUpdateControl>; root: string;
  reports: ScheduledTaskRun[]; pause(value: boolean): void;
  onReport: { current?: (run: ScheduledTaskRun) => Promise<ReportResponse> };
  db: ReturnType<typeof openClientDb>;
}) => Promise<void>, rootSleepSeconds = 20): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-scheduled-update-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = "client-1:update-stop" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "update stop", path: root });
  const reports: ScheduledTaskRun[] = [], errors: unknown[] = [];
  const onReport: { current?: (run: ScheduledTaskRun) => Promise<ReportResponse> } = {};
  const descendant = Buffer.from("Start-Sleep -Seconds 20", "utf16le").toString("base64");
  const task = {
    id: "script-task", ownerUserId: "user-1", clientId: "client-1", deviceId: "device-1",
    clientNameSnapshot: "client", deviceLabelSnapshot: null, name: "update script", description: null,
    taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: "powershell", contextWorkspaceId: workspaceId, cwdRelative: ".", envRefs: [],
      command: `$p = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-EncodedCommand','${descendant}'; [IO.File]::WriteAllText((Join-Path (Get-Location) 'pids.json'), (@($PID,$p.Id) | ConvertTo-Json -Compress)); Start-Sleep -Seconds ${rootSleepSeconds}; [IO.File]::WriteAllText((Join-Path (Get-Location) 'finished'), 'done')` },
    concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 30_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1,
  } as ScheduledTask;
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let response: ReportResponse = undefined;
      if (body.run) { reports.push(body.run); response = await onReport.current?.(body.run); }
      const status = typeof response === "object" ? response.status : response ?? 200;
      res.writeHead(status, { "Content-Type": "application/json", ...(typeof response === "object" && response.requestId ? { "x-request-id": response.requestId } : {}) });
      res.end(typeof response === "object" ? response.text : JSON.stringify({ ok: status === 200, tasks: [task], serverNow: Date.now(), message: "test report failure" }));
    })().catch(error => { errors.push(error); res.writeHead(500); res.end("test boundary failed"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let paused = false;
  const context: any = {
    db, workspaces: new Map([[workspaceId, root]]), isTaskAdmissionPaused: () => paused,
    sessions: {}, controlledExperiments: { hasInFlightWork: () => false, stopForUpdate: async () => {} },
    orchEngine: { hasInFlightWork: () => false, waitForInFlightWork: async () => {}, existingWorkspace: () => null, listManagedServicesForThread: () => [] },
  };
  const scheduler = new ScheduledTaskScheduler({
    config: { serverWsUrl: `ws://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/ws`, clientId: "client-1", apiKey: "isolated-test" } as any,
    deviceId: "device-1", apiContext: context, isTaskAdmissionPaused: () => paused,
    captureAccountContext: () => ({ serverOrigin: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, ownerUserId: "user-1", clientId: "client-1", deviceId: "device-1", generation: 1, assertCurrent() {} }),
  });
  const control = createDesktopUpdateControl({
    context, requestId: "script-update", timeoutMs: 4_000, scheduledTaskScheduler: scheduler,
    queueDispatcher: { hasInFlightWork: () => false, assertNoFailure() {}, resumeWorkspace: () => {} },
    terminalManager: { hasRunningTerminals: () => false, stopAllForUpdate: async () => {} },
    hasBlockingTransaction: () => false, hasKnowledgeWork: () => false, stopKnowledgeWork: async () => {},
    hasAssetDraftWork: () => false, stopAssetDraftWork: async () => {}, interruptTurn: async () => {},
  });
  try { await run({ scheduler, control, root, reports, pause: value => { paused = value; }, onReport, db }); }
  finally {
    onReport.current = undefined;
    const pidFile = path.join(root, "pids.json");
    if (fs.existsSync(pidFile)) for (const pid of JSON.parse(fs.readFileSync(pidFile, "utf8")) as number[]) {
      if (!alive(pid)) continue;
      const result = childProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      assert.equal(result.error, undefined);
      assert.ok(result.status === 0 || !alive(pid), "owned test process cleanup failed");
    }
    await scheduler.stopAndDrain();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(root, { recursive: true });
    assert.deepEqual(errors, []);
  }
}

test("更新确认前与稍后不杀脚本，确认后真实子树退出且上报失败终态", { skip: process.platform !== "win32" }, async () => {
  await fixture(async ({ scheduler, control, root, pause, reports, db }) => {
    const running = scheduler.runNow("script-task");
    await waitFor(() => fs.existsSync(path.join(root, "pids.json")));
    const pids = JSON.parse(fs.readFileSync(path.join(root, "pids.json"), "utf8")) as number[];
    pause(true);
    assert.deepEqual(await control.prepare(), { hasRunningSessions: true });
    assert.ok(pids.every(alive));
    pause(false);
    await control.resume();
    assert.ok(pids.every(alive));
    pause(true);
    await control.prepare();
    await control.interrupt();
    const result = await running;
    assert.equal(result.status, "failed");
    assert.match(result.errorMessage ?? "", /SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE/);
    assert.ok(pids.every(pid => !alive(pid)));
    assert.equal(fs.existsSync(path.join(root, "finished")), false);
    assert.equal(db.readAccountScheduledTaskState("script-task", { serverOrigin: new URL((scheduler as unknown as { httpBase: string }).httpBase).origin,
      ownerUserId: "user-1", clientId: "client-1", deviceId: "device-1" }).running, null);
    assert.equal(reports.at(-1)?.status, "failed");
    pause(false);
    assert.doesNotThrow(() => scheduler.assertProjectTasksAccepting());
    await scheduler.sync("after-update-stop");
  });
});

test("running 回执迟到时确认取消认领，回执后零进程副作用", { skip: process.platform !== "win32" }, async () => {
  await fixture(async ({ scheduler, control, root, pause, reports, onReport }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    onReport.current = async run => { if (run.status === "running") await pending; };
    const running = scheduler.runNow("script-task");
    await waitFor(() => reports.some(run => run.status === "running"));
    pause(true);
    await control.prepare();
    const stopping = control.interrupt();
    try { await new Promise(resolve => setTimeout(resolve, 30)); }
    finally { release(); }
    await stopping;
    assert.equal((await running).status, "failed");
    assert.equal(fs.existsSync(path.join(root, "pids.json")), false);
  });
});

test("根脚本已关闭但独立子进程存活且上报未结束时拒绝更新，不重杀回收 PID", { skip: process.platform !== "win32" }, async t => {
  await fixture(async ({ scheduler, control, root, pause, onReport, reports }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    onReport.current = async run => { if (run.status === "success") await pending; };
    const running = scheduler.runNow("script-task");
    await waitFor(() => reports.some(run => run.status === "success"));
    const [rootPid, descendantPid] = JSON.parse(fs.readFileSync(path.join(root, "pids.json"), "utf8")) as number[];
    assert.equal(alive(rootPid), false);
    assert.equal(alive(descendantPid), true);
    const originalSpawn = childProcess.spawn;
    let kills = 0;
    const mock = t.mock.method(childProcess, "spawn", ((command: string, args: readonly string[], options: any) => {
      if (command === "taskkill.exe") kills++;
      return originalSpawn(command, args, options);
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    pause(true);
    try {
      assert.deepEqual(await control.prepare(), { hasRunningSessions: true });
      const stopping = assert.rejects(scheduler.stopForUpdate({ requestId: "closed-root-update", timeoutMs: 2_000 }), { code: "SCHEDULED_TASK_UPDATE_STOP_FAILED" });
      release();
      await stopping;
      await running;
      assert.equal(kills, 0);
      assert.equal(alive(descendantPid), true);
      assert.equal(scheduler.hasInFlightWork(), true);
    } finally { release(); mock.mock.restore(); syncBuiltinESMExports(); }
  }, 0);
});

test("确认停止复用原 owner，必须等待失败终态上报完成", { skip: process.platform !== "win32" }, async () => {
  await fixture(async ({ scheduler, root, pause, reports, onReport }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    onReport.current = async run => { if (run.status === "failed") await pending; };
    const running = scheduler.runNow("script-task");
    await waitFor(() => fs.existsSync(path.join(root, "pids.json")));
    pause(true);
    let done = false;
    const first = scheduler.stopForUpdate({ requestId: "concurrent-stop", timeoutMs: 4_000 });
    const second = scheduler.stopForUpdate({ requestId: "concurrent-stop", timeoutMs: 4_000 });
    const stopping = Promise.all([first, second]).then(() => { done = true; });
    try { await waitFor(() => reports.some(run => run.status === "failed")); assert.equal(done, false); }
    finally { release(); }
    await stopping;
    assert.equal((await running).status, "failed");
    assert.equal(reports.filter(run => run.status === "failed").length, 1);
  });
});

test("进程停止后的终态上报失败阻止更新", { skip: process.platform !== "win32" }, async () => {
  await fixture(async ({ scheduler, control, root, pause, onReport }) => {
    onReport.current = async run => run.status === "failed" ? 503 : 200;
    const running = scheduler.runNow("script-task");
    const failedRun = assert.rejects(running, /Scheduled task API failed/);
    await waitFor(() => fs.existsSync(path.join(root, "pids.json")));
    pause(true);
    await control.prepare();
    await assert.rejects(control.interrupt(), { code: "SCHEDULED_TASK_UPDATE_DRAIN_FAILED" });
    await failedRun;
    assert.equal(scheduler.hasInFlightWork(), true);
    await assert.rejects(control.interrupt(), { code: "SCHEDULED_TASK_UPDATE_DRAIN_FAILED" });
  });
});

test("传输错误保留同一个原异常，后台日志保留系统码及指纹但不泄漏正文", async t => {
  const logged = t.mock.method(logger, "error", () => {});
  await fixture(async ({ scheduler }) => {
    const cause = Object.assign(new Error("transport-secret-sentinel"), { code: "ECONNRESET" });
    const mock = t.mock.method(globalThis, "fetch", async () => { throw cause; });
    try {
      await assert.rejects(scheduler.sync("transport-diagnostic"), error => {
        assert.equal((error as Error).cause, cause);
        assert.equal((error as any).reason, "transport_failed");
        assert.doesNotMatch(String(error), /transport-secret-sentinel/);
        return true;
      });
      scheduler.resumeAfterUpdate("transport-diagnostic-request");
      await waitFor(() => logged.mock.calls.some(call => (call.arguments[2] as Record<string, unknown> | undefined)?.code === "SCHEDULED_TASK_UPDATE_RESUME_FAILED"));
      const data = logged.mock.calls.at(-1)?.arguments[2] as any;
      assert.equal(data.error.cause.systemCode, "ECONNRESET");
      assert.match(data.error.cause.fingerprint, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(data), /transport-secret-sentinel/);
      await assert.rejects(scheduler.waitForInFlightWork(), error => (error as Error).cause === cause);
    } finally { mock.mock.restore(); }
  });
});

for (const upstreamRequestId of ["upstream-probe-42", "invalid upstream secret"]) test(`更新上报保留受限上游请求关联 ${upstreamRequestId.includes(" ") ? "invalid" : "valid"}`, { skip: process.platform !== "win32" }, async t => {
  const logged = t.mock.method(logger, "error", () => {});
  await fixture(async ({ scheduler, root, pause, onReport }) => {
    onReport.current = async run => run.status === "failed"
      ? { status: 503, text: '{"ok":false,"message":"upstream-secret-sentinel"}', requestId: upstreamRequestId } : 200;
    const running = scheduler.runNow("script-task");
    let original: any;
    const failedRun = assert.rejects(running, error => { original = error; return true; });
    await waitFor(() => fs.existsSync(path.join(root, "pids.json")));
    pause(true);
    await assert.rejects(scheduler.stopForUpdate({ requestId: "upstream-diagnostic", timeoutMs: 4_000 }), error => {
      assert.ok(error instanceof AggregateError);
      return true;
    });
    await failedRun;
    const expected = upstreamRequestId.includes(" ") ? undefined : "upstream-probe-42";
    assert.equal(original.upstreamRequestId, expected);
    const data = logged.mock.calls.map(call => call.arguments[2] as any).find(data => data?.code === "SCHEDULED_TASK_UPDATE_DRAIN_FAILED");
    assert.ok(data);
    assert.equal(data.cause[0].upstreamRequestId, expected);
    assert.doesNotMatch(JSON.stringify(data), /upstream-secret-sentinel|invalid upstream secret/);
  });
});

test("上报等待超时后保留 owner，原上报成功后可重新确认收口", { skip: process.platform !== "win32" }, async () => {
  await fixture(async ({ scheduler, root, pause, onReport }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    onReport.current = async run => { if (run.status === "failed") await pending; };
    const running = scheduler.runNow("script-task");
    await waitFor(() => fs.existsSync(path.join(root, "pids.json")));
    pause(true);
    try { await assert.rejects(scheduler.stopForUpdate({ requestId: "report-timeout", timeoutMs: 2_000 }), { code: "SCHEDULED_TASK_UPDATE_DRAIN_FAILED" }); }
    finally { release(); }
    assert.equal(scheduler.hasInFlightWork(), true);
    await running;
    await scheduler.stopForUpdate({ requestId: "report-retry", timeoutMs: 2_000 });
    assert.equal(scheduler.hasInFlightWork(), false);
  });
});

test("上报超时后的迟到失败保留真实原因，不能因原 Promise 已删除而放行", { skip: process.platform !== "win32" }, async () => {
  await fixture(async ({ scheduler, root, pause, onReport }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    onReport.current = async run => { if (run.status === "failed") { await pending; return 503; } };
    const running = scheduler.runNow("script-task");
    let original: unknown;
    const failedRun = assert.rejects(running, error => { original = error; return true; });
    await waitFor(() => fs.existsSync(path.join(root, "pids.json")));
    pause(true);
    try { await assert.rejects(scheduler.stopForUpdate({ requestId: "late-failure-timeout", timeoutMs: 2_000 }), { code: "SCHEDULED_TASK_UPDATE_DRAIN_FAILED" }); }
    finally { release(); }
    await failedRun;
    await assert.rejects(scheduler.stopForUpdate({ requestId: "late-failure-retry", timeoutMs: 2_000 }), error => {
      assert.equal((error as any).code, "SCHEDULED_TASK_UPDATE_DRAIN_FAILED");
      assert.ok(error instanceof AggregateError && error.errors.includes(original));
      return true;
    });
  });
});

for (const response of [
  { status: 503, text: '{"ok":false,"message":"remote-secret-sentinel"}' },
  { status: 200, text: "remote-secret-sentinel" },
  { status: 200, text: '{"ok":"remote-secret-sentinel"}' },
]) test(`运行上报拒绝不可信响应且错误不泄漏正文 ${response.status}/${response.text.length}`, async () => {
  await fixture(async ({ scheduler, onReport, root }) => {
    onReport.current = async () => response;
    await assert.rejects(scheduler.runNow("script-task"), error => {
      assert.equal((error as any).code, "SCHEDULED_TASK_API_FAILED");
      assert.equal((error as any).httpStatus, response.status);
      assert.doesNotMatch(String(error), /remote-secret-sentinel/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(root, "pids.json")), false);
  });
});

test("脚本 error 尚未 close 时保留原 owner，终态不能提前上报", async t => {
  await fixture(async ({ scheduler, reports }) => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => false,
      exitCode: null, signalCode: null,
    });
    let spawned = false, done = false;
    const mock = t.mock.method(childProcess, "spawn", (() => { spawned = true; return child; }) as unknown as typeof childProcess.spawn);
    syncBuiltinESMExports();
    const running = scheduler.runNow("script-task").then(run => { done = true; return run; });
    try {
      await waitFor(() => spawned);
      child.emit("error", new Error("script spawn error"));
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(done, false);
      assert.equal(scheduler.hasInFlightWork(), true);
      assert.equal(reports.some(run => run.status === "failed"), false);
    } finally {
      child.emit("close", -1, null);
      mock.mock.restore();
      syncBuiltinESMExports();
      await running;
    }
    assert.equal(scheduler.hasInFlightWork(), false);
    assert.equal(reports.at(-1)?.status, "failed");
  });
});

for (const failure of ["spawn", "nonzero-after-close"] as const) test(`停止工具${failure}失败保留原 owner并阻止再次更新`, { skip: process.platform !== "win32" }, async t => {
  const logged = t.mock.method(logger, "error", () => {});
  await fixture(async ({ scheduler, root, pause, db }) => {
    t.mock.method(db, "writeWorkspaceLog", (_workspaceId: WorkspaceId, entry: Parameters<typeof db.writeWorkspaceLog>[1]) => {
      if (entry.level === "error") logger.error(entry.tag, entry.message, entry.data);
    });
    const running = scheduler.runNow("script-task");
    await waitFor(() => fs.existsSync(path.join(root, "pids.json")));
    const originalSpawn = childProcess.spawn;
    const stopCause = Object.assign(new Error("secret-command-that-must-not-be-logged"), { code: "EACCES" });
    let kills = 0;
    const mock = t.mock.method(childProcess, "spawn", ((command: string, args: readonly string[], options: any) => {
      if (command !== "taskkill.exe") return originalSpawn(command, args, options);
      kills++;
      if (failure === "spawn") throw stopCause;
      const helper = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      const real = originalSpawn(command, args, options);
      real.stdout?.resume(); real.stderr?.resume();
      real.once("error", error => helper.emit("error", error));
      real.once("close", () => { setTimeout(() => helper.emit("close", 128), 100); });
      return helper;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    pause(true);
    try {
      await assert.rejects(scheduler.stopForUpdate({ requestId: "fault-update", timeoutMs: 500 }), error => {
        assert.equal((error as any).code, "SCHEDULED_TASK_UPDATE_STOP_FAILED");
        if (failure === "spawn") assert.equal((error as Error).cause, stopCause);
        return true;
      });
      if (failure === "nonzero-after-close") await running;
      assert.equal(scheduler.hasInFlightWork(), true);
      await assert.rejects(scheduler.stopForUpdate({ requestId: "retry-update", timeoutMs: 500 }), { code: "SCHEDULED_TASK_UPDATE_STOP_FAILED" });
      assert.equal(kills, 1);
      const data = logged.mock.calls.map(call => call.arguments[2] as Record<string, unknown> | undefined)
        .find(value => value?.code === "SCHEDULED_TASK_UPDATE_STOP_FAILED");
      assert.equal(data?.requestId, "fault-update");
      assert.equal(data?.taskId, "script-task");
      assert.ok(data?.runId);
      if (failure === "spawn") {
        assert.equal((data?.error as any).cause.systemCode, "EACCES");
        assert.match((data?.error as any).cause.fingerprint, /^[0-9a-f]{64}$/);
      }
      assert.doesNotMatch(JSON.stringify(data), /secret-command/);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});
