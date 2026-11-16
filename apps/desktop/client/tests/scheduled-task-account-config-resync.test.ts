import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScheduledTask, WorkspaceId, DesktopAccountScheduledTaskEdit } from "@codeflowai/shared";
import type { ClientConfig } from "../src/config.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { logger } from "../src/logger.js";

/** 使用真实桥、SQLite与Scheduler，仅在账号HTTP边界提供确定响应。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-resync-")); t.mock.method(os, "homedir", () => root);
  const db = openClientDb({ dbPath: path.join(root, "client.db") }), workspaceId = "desktop:project" as WorkspaceId;
  fs.mkdirSync(path.join(root, "workspace")); db.workspaces.upsert({ id: workspaceId, title: "project", path: path.join(root, "workspace") });
  const status = { active: true }, owner = { serverOrigin: "http://127.0.0.1:1", ownerUserId: "A", clientId: "desktop", deviceId: "installation", generation: 1,
    assertCurrent() { if (!status.active) throw new Error("ACCOUNT_STALE"); } };
  let tasks: ScheduledTask[] = [{ id: "account", ownerUserId: "A", clientId: "desktop", deviceId: "installation", deviceKind: "desktop", configRevision: 1,
    clientNameSnapshot: "Desktop", deviceLabelSnapshot: null, name: "原配置", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: false,
    payload: { shell: "cmd", command: "echo SECRET_CONFIG", contextWorkspaceId: workspaceId }, concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 10_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 }];
  const calls: Array<{ action: string; body: any }> = [], logs: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { logs.push(args); });
  let hold: Promise<void> | null = null, floor = 10, failSyncCountdown: number | null = null;
  const ctx = { db, clientId: "desktop", deviceId: "installation", localWorkspaceOnly: true,
    workspaces: new Map([[workspaceId, path.join(root, "workspace")]]), send() {} } as unknown as ApiHandlerContext;
  const schedulerInput: ConstructorParameters<typeof ScheduledTaskScheduler>[0] = { config: { clientId: "desktop", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: "installation", apiContext: ctx, localApiContext: ctx, captureAccountContext: () => status.active ? owner : null,
    requestAccountTasks: async (_owner, action, body) => {
      calls.push({ action, body: structuredClone(body) });
      if (hold) await hold;
      if (action === "sync") {
        if (failSyncCountdown === 0) throw new Error("SYNC_TRANSPORT_DOWN");
        if (failSyncCountdown !== null) failSyncCountdown--;
        return { tasks: structuredClone(tasks), configRevisionFloors: tasks.map(task => ({ taskId: task.id, localRevision: floor })), serverNow: Date.now() };
      }
      if (action === "config") {
        const input = body as any, task = tasks.find(task => task.id === input.taskId)!;
        assert.equal(input.expectedConfigRevision, task.configRevision);
        const updated = { ...task, ...input.config, configRevision: task.configRevision! + 1 };
        tasks = tasks.map(item => item.id === task.id ? updated : item); floor = Math.max(floor, input.localRevision);
        return { taskId: task.id, localRevision: input.localRevision, expectedConfigRevision: input.expectedConfigRevision, deleted: false, task: updated };
      }
      return { serverNow: Date.now() };
    } };
  const scheduler = new ScheduledTaskScheduler(schedulerInput);
  ctx.scheduledTaskScheduler = scheduler;
  let sequence = 0;
  t.after(async () => { try { await scheduler.stopAndDrain(); } finally { db.close(); fs.rmSync(root, { recursive: true }); } });
  return { db, ctx, scheduler, schedulerInput, root, workspaceId, owner, calls, logs, status,
    /** 读取公开桥响应，不跳过本机请求字段白名单。 */
    call(action: string, body: Record<string, unknown> = {}) { return executeDesktopApiRequest(ctx,
      { method: `scheduledTasks.account.${action}`, body } as never, { requestId: `resync-${++sequence}`, clientVersion: "test", startedAt: 1 }) as Promise<{ status: number; body: any }>; },
    /** 仅改变完整Server响应，保持配置和水位一对一。 */
    server(next: ScheduledTask[]) { tasks = structuredClone(next); },
    /** 只中断后续配置HTTP，保留此前完成的真实SQLite修复事实。 */
    failSyncAfter(successes: number) { failSyncCountdown = successes; },
    /** 独立复制当前Server任务，避免探针意外改变权威配置。 */
    task() { return structuredClone(tasks[0]!); },
    /** 损坏可通过JSON约束的快照，保留可信物理归属与计数。 */
    corrupt() { db.withAccountScheduledTasks(workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_account_configs SET snapshot_json='{}'").run()); },
    /** 观察原始行，允许验证坏行在失败时保持原字节。 */
    raw() { return db.withAccountScheduledTasks(workspaceId, repos => repos.db.prepare("SELECT * FROM scheduled_task_account_configs ORDER BY task_id").all()); },
    /** 固定HTTP await竞争点，调用方必须finally释放。 */
    hold() { let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; }); return () => { hold = null; release(); }; },
  };
}

/** 只完成配置同步，不自动启动脚本。 */
async function ready(f: ReturnType<typeof fixture>) { await f.scheduler.sync("initial"); await f.scheduler.waitForInFlightWork(); }

/** 复用服务端完整可编辑字段，不提交身份或落点。 */
function edit(task: ScheduledTask): DesktopAccountScheduledTaskEdit {
  return { name: "pending", description: task.description, taskType: task.taskType, cronExpr: task.cronExpr, timezone: task.timezone,
    enabled: false, payload: task.payload, concurrencyPolicy: task.concurrencyPolicy, missedPolicy: task.missedPolicy, timeoutMs: task.timeoutMs };
}

test("ordinary sync keeps corrupt config failed while explicit desktop resync rebuilds a paused valid snapshot", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); const before = f.raw();
  await assert.rejects(f.scheduler.sync("timer")); await assert.rejects(f.scheduler.waitForInFlightWork()); assert.deepEqual(f.raw(), before);
  const result = await f.call("sync"); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.items[0].task.name, "原配置"); assert.equal(result.body.items[0].stopIntent, "disabled");
  assert.equal(result.body.items[0].localRevision, 10); assert.equal(result.body.items[0].task.enabled, false);
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_CONFIG/);
});

test("explicit resync preserves a valid pending tuple and retries it after rebuilding another corrupt task", async t => {
  const f = fixture(t); await ready(f); const task = f.task(), other = { ...task, id: "other" };
  f.server([task, other]); await ready(f);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => {
    repos.accountConfigs.stage(f.owner, { taskId: "account", expectedLocalRevision: 10, operation: "update", config: edit(task) });
    repos.db.prepare("UPDATE scheduled_task_account_configs SET snapshot_json='{}' WHERE task_id='other'").run();
  });
  const result = await f.call("sync"); assert.equal(result.status, 200, JSON.stringify(result.body));
  const sent = f.calls.filter(call => call.action === "config"); assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.localRevision, 11); assert.equal(sent[0]!.body.expectedConfigRevision, 1);
  assert.equal(result.body.items.find((item: any) => item.task.id === "account").task.name, "pending");
});

for (const stop of [null, "disabled", "deleted"] as const) test(`explicit corrupt resync retains safe revision and ${stop} stop intent`, async t => {
  const f = fixture(t); await ready(f); f.corrupt();
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_account_configs SET local_revision=40,stop_intent=?").run(stop));
  assert.equal((await f.call("sync")).status, 200);
  const saved = f.db.listAccountScheduledTaskConfigs(f.owner)[0]!.snapshot;
  assert.equal(saved.localRevision, 40); assert.equal(saved.stopIntent, stop === "deleted" ? "deleted" : "disabled");
  assert.equal(saved.pending.length, 0); assert.equal(f.calls.some(call => call.action === "config"), false);
});

test("resync removes only corrupt current-owner configs absent from Server and keeps other owners intact", async t => {
  const f = fixture(t); await ready(f); const otherOwner = { ...f.owner, ownerUserId: "B" }, otherTask = { ...f.task(), ownerUserId: "B" };
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.accountConfigs.replace(otherOwner, [{ task: otherTask, localRevision: 55 }]));
  f.corrupt(); f.server([]);
  const result = await f.call("sync"); assert.equal(result.status, 200); assert.equal(result.body.items.length, 0);
  const rows = f.raw() as any[]; assert.equal(rows.length, 1); assert.equal(rows[0].owner_user_id, "B"); assert.equal(rows[0].snapshot_json, "{}");
});

test("invalid Server snapshot never repairs or removes a corrupt local row", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); const before = f.raw();
  f.server([{ ...f.task(), ownerUserId: "wrong" }]);
  assert.equal((await f.call("sync")).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork()); assert.deepEqual(f.raw(), before);
});

test("repair SQL failure keeps corrupt bytes and stops pending config HTTP", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); const before = f.raw();
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.exec("CREATE TRIGGER reject_repair BEFORE DELETE ON scheduled_task_account_configs BEGIN SELECT RAISE(ABORT,'SECRET_REPAIR'); END"));
  assert.equal((await f.call("sync")).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.deepEqual(f.raw(), before); assert.equal(f.calls.some(call => call.action === "config"), false);
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_REPAIR/);
});

test("owner revoked while explicit refresh awaits Server cannot repair local bytes", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); const before = f.raw(), release = f.hold();
  const refresh = f.call("sync");
  try { await new Promise(setImmediate); f.status.active = false; } finally { release(); }
  assert.equal((await refresh).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork()); assert.deepEqual(f.raw(), before);
});

test("repair diagnostic failure logs once and fails before any rebuild", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); const before = f.raw(); let attempts = 0;
  const log = t.mock.method(logger, "error", () => { attempts++; throw new Error("DIAGNOSTIC_DOWN"); });
  try {
    await assert.rejects(f.call("sync")); await assert.rejects(f.scheduler.waitForInFlightWork());
    assert.equal(attempts, 1); assert.deepEqual(f.raw(), before); assert.equal(f.calls.some(call => call.action === "config"), false);
  } finally { log.mock.restore(); }
});

test("explicit resync prechecks all physical sources before repairing or logging a corrupt row", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); const before = f.raw(), count = f.logs.length;
  f.db.withAccountScheduledTasks(null, repos => {
    const other = { ...f.task(), payload: { ...f.task().payload, contextWorkspaceId: undefined } } as ScheduledTask;
    repos.accountConfigs.replace(f.owner, [{ task: other, localRevision: 1 }]);
  });
  assert.equal((await f.call("sync")).status, 409); await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.deepEqual(f.raw(), before); assert.equal(f.logs.length, count + 1);
});

test("concurrent explicit refresh joins the original single-flight and normal sync cannot discard it", async t => {
  const f = fixture(t); await ready(f); const release = f.hold(), count = f.calls.length;
  const timer = f.scheduler.sync("timer");
  for (let i = 0; f.calls.length === count; i++) { assert.ok(i < 100); await new Promise(setImmediate); }
  const explicit = f.call("sync"), another = f.scheduler.sync("another-timer");
  try { await new Promise(setImmediate); } finally { release(); }
  await timer; await another; assert.equal((await explicit).status, 200); await f.scheduler.waitForInFlightWork();
  assert.ok(f.calls.filter(call => call.action === "sync").length >= 4);
});

test("corrupt pending is discarded only by explicit resync and requires a new explicit enable", async t => {
  const f = fixture(t); await ready(f); const task = f.task();
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_account_configs SET pending_json='[{}]',local_revision=41").run());
  const result = await f.call("sync"); assert.equal(result.status, 200); assert.equal(result.body.items[0].stopIntent, "disabled");
  assert.equal(result.body.items[0].pending, false); assert.equal(f.calls.some(call => call.action === "config"), false);
  const enabled = await f.call("update", { taskId: "account", expectedLocalRevision: 41, config: { ...edit(task), enabled: true } });
  assert.equal(enabled.status, 200); assert.equal(enabled.body.item.stopIntent, null); assert.equal(enabled.body.item.task.enabled, true);
  assert.equal(f.calls.find(call => call.action === "config")!.body.localRevision, 42);
});

test("explicit resync cannot move a corrupt task out of its original workspace", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); const before = f.raw();
  f.server([{ ...f.task(), payload: { ...f.task().payload, contextWorkspaceId: undefined } } as ScheduledTask]);
  assert.equal((await f.call("sync")).status, 409); await assert.rejects(f.scheduler.waitForInFlightWork()); assert.deepEqual(f.raw(), before);
});

test("silent SQLite ignored repair insert is detected and the original corrupt row is rolled back", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); const before = f.raw();
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.exec("CREATE TRIGGER ignore_repair BEFORE INSERT ON scheduled_task_account_configs BEGIN SELECT RAISE(IGNORE); END"));
  assert.equal((await f.call("sync")).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork()); assert.deepEqual(f.raw(), before);
});

test("cold Scheduler and reopened SQLite require explicit refresh to repair persisted corruption", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); await f.scheduler.stopAndDrain(); f.db.close();
  const db = openClientDb({ dbPath: path.join(f.root, "client.db") }), ctx = { ...f.ctx, db };
  const scheduler = new ScheduledTaskScheduler({ ...f.schedulerInput, apiContext: ctx, localApiContext: ctx }); ctx.scheduledTaskScheduler = scheduler;
  try {
    await assert.rejects(scheduler.sync("startup")); await assert.rejects(scheduler.waitForInFlightWork());
    const response = await executeDesktopApiRequest(ctx, { method: "scheduledTasks.account.sync", body: {} }, { requestId: "cold-resync", clientVersion: "test", startedAt: 1 });
    assert.equal(response.status, 200); assert.equal((response.body as any).items[0].stopIntent, "disabled"); await scheduler.waitForInFlightWork();
  } finally { await scheduler.stopAndDrain(); db.close(); }
});

test("tasks without workspace repair inside the original application database", async t => {
  const f = fixture(t); await ready(f); const original = f.task(); f.server([]); await ready(f);
  f.server([{ ...original, id: "app-task", payload: { ...original.payload, contextWorkspaceId: undefined } } as ScheduledTask]); await ready(f);
  f.db.withAccountScheduledTasks(null, repos => repos.db.prepare("UPDATE scheduled_task_account_configs SET snapshot_json='{}',local_revision=80").run());
  const result = await f.call("sync"); assert.equal(result.status, 200); assert.equal(result.body.items[0].localRevision, 80);
  assert.equal(result.body.items[0].stopIntent, "disabled");
  const saved = f.db.listAccountScheduledTaskConfigs(f.owner); assert.equal(saved.length, 1); assert.equal(saved[0]!.workspaceId, null);
});

test("repair stop consumes the original queued minute even if the later normal sync fails", async t => {
  const f = fixture(t); await ready(f); f.server([{ ...f.task(), enabled: true }]); await ready(f);
  const state = (f.scheduler as any).state; state.queuedByTaskId.set("account", { scheduledAt: 120_000, workspaceId: f.workspaceId });
  f.corrupt(); f.failSyncAfter(1);
  assert.equal((await f.call("sync")).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(state.queuedByTaskId.has("account"), false); assert.equal(f.db.readAccountScheduledTaskState("account", f.owner).lastScheduledAt, 120_000);
});

test("explicit resync survives corruption observed by an ordinary sync already awaiting HTTP", async t => {
  const f = fixture(t); await ready(f); const release = f.hold(), count = f.calls.length;
  const timer = f.scheduler.sync("timer-before-refresh").then(() => null, error => error);
  let explicit!: ReturnType<typeof f.call>;
  try {
    for (let i = 0; f.calls.length === count; i++) { assert.ok(i < 100); await new Promise(setImmediate); }
    f.corrupt(); explicit = f.call("sync");
  } finally { release(); }
  assert.ok(await timer); assert.equal((await explicit).status, 200); await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(f.scheduler.listAccountConfigs()[0]!.stopIntent, "disabled");
});

test("repair diagnosis includes trusted workspace identity and requestId once", async t => {
  const f = fixture(t); await ready(f); f.corrupt(); assert.equal((await f.call("sync")).status, 200);
  const logs = f.logs.filter(args => args[1] === "explicit account config resync rebuilds corrupt row");
  assert.equal(logs.length, 1); const diagnostic = logs[0]![2] as Record<string, unknown>;
  assert.equal(diagnostic.workspaceId, f.workspaceId); assert.equal(diagnostic.requestId, "resync-1");
});

test("explicit refresh joining an unknown sync failure does not continue with repair side effects", async t => {
  const f = fixture(t); await ready(f); const release = f.hold(), count = f.calls.length;
  f.failSyncAfter(0); const timer = f.scheduler.sync("timer-fails").then(() => null, error => error);
  let explicit!: ReturnType<typeof f.call>;
  try {
    for (let i = 0; f.calls.length === count; i++) { assert.ok(i < 100); await new Promise(setImmediate); }
    explicit = f.call("sync");
  } finally { release(); }
  assert.ok(await timer); assert.equal((await explicit).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(f.calls.length, count + 1);
});

test("two explicit refresh requests serialize after a failed corrupt ordinary sync", async t => {
  const f = fixture(t); await ready(f); const release = f.hold(), count = f.calls.length;
  const timer = f.scheduler.sync("timer-two-refreshes").then(() => null, error => error);
  let first!: ReturnType<typeof f.call>, second!: ReturnType<typeof f.call>;
  try {
    for (let i = 0; f.calls.length === count; i++) { assert.ok(i < 100); await new Promise(setImmediate); }
    f.corrupt(); first = f.call("sync"); second = f.call("sync");
  } finally { release(); }
  assert.ok(await timer); assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(f.logs.filter(args => args[1] === "explicit account config resync rebuilds corrupt row").length, 1);
});

test("joining explicit refresh never retries an ordinary sync SQL failure", async t => {
  const f = fixture(t); await ready(f); const release = f.hold(), count = f.calls.length;
  const timer = f.scheduler.sync("timer-sql-fails").then(() => null, error => error);
  let explicit!: ReturnType<typeof f.call>;
  try {
    for (let i = 0; f.calls.length === count; i++) { assert.ok(i < 100); await new Promise(setImmediate); }
    f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.exec("CREATE TRIGGER reject_ordinary BEFORE DELETE ON scheduled_task_account_configs BEGIN SELECT RAISE(ABORT,'SQL_DOWN'); END"));
    explicit = f.call("sync");
  } finally { release(); }
  assert.ok(await timer); assert.equal((await explicit).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(f.calls.length, count + 1);
});
