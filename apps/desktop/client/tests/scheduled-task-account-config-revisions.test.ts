import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScheduledTask, WorkspaceId, ClientScheduledTaskConfigWritebackRequestBody, ClientScheduledTaskConfigWritebackResponseBody, DesktopAccountScheduledTaskEdit } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { handleApiRequest } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";
import { logger } from "../src/logger.js";

/** 真实桌面桥/SQLite/Scheduler，只控制已认证云响应和在途HTTP。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-revisions-")); t.mock.method(os, "homedir", () => root);
  const db = openClientDb({ dbPath: path.join(root, "client.db") }), workspaceId = "desktop:project" as WorkspaceId;
  fs.mkdirSync(path.join(root, "workspace")); db.workspaces.upsert({ id: workspaceId, title: "project", path: path.join(root, "workspace") });
  const owner = { serverOrigin: "http://127.0.0.1:1", ownerUserId: "A", clientId: "desktop", deviceId: "installation", generation: 1,
    assertCurrent() { if (!status.active) throw new Error("ACCOUNT_STALE"); } };
  const status = { active: true }, calls: { action: string; body: any }[] = [], logs: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { logs.push(args); });
  let server: ScheduledTask | null = { id: "account", ownerUserId: "A", clientId: "desktop", deviceId: "installation", deviceKind: "desktop", configRevision: 1,
    clientNameSnapshot: "Desktop", deviceLabelSnapshot: null, name: "原配置", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: false,
    payload: { shell: process.platform === "win32" ? "cmd" : "sh", command: "echo account", contextWorkspaceId: workspaceId }, concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 10_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
  let failure: unknown, afterCommit = false, hold: Promise<void> | null = null, floor = 10, corruptAck = false;
  const receipts = new Map<number, ClientScheduledTaskConfigWritebackResponseBody>();
  const ctx = { db, clientId: "desktop", deviceId: "installation", localWorkspaceOnly: true,
    workspaces: new Map([[workspaceId, path.join(root, "workspace")]]), send() {} } as unknown as ApiHandlerContext;
  const schedulerInput: ConstructorParameters<typeof ScheduledTaskScheduler>[0] = { config: { clientId: "desktop", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: "installation", apiContext: ctx, localApiContext: ctx, captureAccountContext: () => status.active ? owner : null,
    requestAccountTasks: async (_owner, action, body) => {
      calls.push({ action, body: structuredClone(body) });
      if (action === "sync") return { tasks: server ? [structuredClone(server)] : [], configRevisionFloors: server ? [{ taskId: server.id, localRevision: floor }] : [], serverNow: Date.now() };
      if (action !== "config") return { serverNow: Date.now() };
      if (hold) await hold;
      if (failure && !afterCommit) throw failure;
      const input = body as ClientScheduledTaskConfigWritebackRequestBody;
      let ack = receipts.get(input.localRevision);
      if (!ack) {
        assert.ok(server); assert.equal(input.expectedConfigRevision, server.configRevision);
        server = input.operation === "delete" ? null : { ...server, ...input.config as DesktopAccountScheduledTaskEdit, configRevision: server.configRevision! + 1 };
        ack = server === null ? { taskId: input.taskId, localRevision: input.localRevision, expectedConfigRevision: input.expectedConfigRevision, deleted: true, task: null }
          : { taskId: input.taskId, localRevision: input.localRevision, expectedConfigRevision: input.expectedConfigRevision, deleted: false, task: structuredClone(server) };
        receipts.set(input.localRevision, ack); floor = Math.max(floor, input.localRevision);
      }
      if (failure) throw failure;
      return structuredClone(corruptAck ? { ...ack, localRevision: ack.localRevision + 1 } : ack);
    } };
  const scheduler = new ScheduledTaskScheduler(schedulerInput);
  ctx.scheduledTaskScheduler = scheduler;
  let sequence = 0;
  t.after(async () => { try { await scheduler.stopAndDrain(); } finally { db.close(); fs.rmSync(root, { recursive: true }); } });
  return { db, ctx, owner, scheduler, schedulerInput, calls, logs, status, workspaceId, root,
    /** 原完整配置只更改指定业务字段。 */
    edit(patch: Record<string, unknown> = {}) {
      const current = server!; return { name: current.name, description: current.description, taskType: current.taskType,
        cronExpr: current.cronExpr, timezone: current.timezone, enabled: current.enabled, payload: current.payload,
        concurrencyPolicy: current.concurrencyPolicy, missedPolicy: current.missedPolicy, timeoutMs: current.timeoutMs, ...patch };
    },
    /** 原桌面白名单与中央handler消费同一请求。 */
    call(action: string, body: Record<string, unknown> = {}) { return executeDesktopApiRequest(ctx,
      { method: `scheduledTasks.account.${action}`, body } as never, { requestId: `revision-${++sequence}`, clientVersion: "test", startedAt: 1 }) as Promise<{ status: number; body: any }>; },
    /** 模拟明确拒绝或丢ACK；业务副作用和回执事实仍可辨认。 */
    fail(error: unknown, committed = false) { failure = error; afterCommit = committed; },
    /** 只破坏ACK修订归属，Server已提交事实和回执仍保持。 */
    invalidAck(value: boolean) { corruptAck = value; },
    /** 固定真实await竞争点，不使用定时睡眠猜测。 */
    hold() { let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; }); return () => { hold = null; release(); }; },
    snapshot() { return server; } };
}

/** 启动完整同步并清理已结束操作，不发真实脚本。 */
async function ready(f: ReturnType<typeof fixture>) { await f.scheduler.syncAndTick("initial"); await f.scheduler.waitForInFlightWork(); }

test("handled config writeback failure stays explicit and durable but does not fail resource shutdown", async t => {
  const f = fixture(t); await ready(f);
  f.fail(Object.assign(new Error("SCHEDULED_TASK_API_FAILED"), { code: "SCHEDULED_TASK_API_FAILED", reason: "invalid_ack", stage: "config_writeback" }), true);
  const response = await f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "durable edit" }) });
  assert.equal(response.status, 500); assert.equal(response.body.ok, false); assert.equal(f.logs.length, 1);
  assert.equal((await f.call("list")).body.items[0].pending, true);
  await f.scheduler.stopAndDrain();
  assert.equal(f.calls.filter(call => call.action === "config").length, 1);
  assert.equal((await f.call("list")).body.items[0].pending, true);
});

test("handled local revision conflict stays 409 with zero writes and permits resource shutdown", async t => {
  const f = fixture(t); await ready(f);
  const before = f.db.listAccountScheduledTaskConfigs(f.owner), calls = f.calls.length;
  const response = await f.call("delete", { taskId: "account", expectedLocalRevision: 9 });
  assert.equal(response.status, 409); assert.equal(response.body.ok, false); assert.equal(f.logs.length, 1);
  assert.deepEqual(f.db.listAccountScheduledTaskConfigs(f.owner), before); assert.equal(f.calls.length, calls);
  await f.scheduler.stopAndDrain();
});

test("handled local revision conflict remains visible to public wait", async t => {
  const f = fixture(t); await ready(f);
  assert.equal((await f.call("delete", { taskId: "account", expectedLocalRevision: 9 })).status, 409);
  await assert.rejects(f.scheduler.waitForInFlightWork());
});

test("unhandled local revision conflict still blocks resource shutdown", async t => {
  const f = fixture(t); await ready(f);
  await assert.rejects(f.scheduler.reviseAccountConfig({ taskId: "account", expectedLocalRevision: 9, operation: "delete" }));
  await assert.rejects(f.scheduler.stopAndDrain()); assert.equal(f.logs.length, 0);
});

test("local revision conflict with failed response delivery still blocks resource shutdown", async t => {
  const f = fixture(t); await ready(f);
  await assert.rejects(handleApiRequest({ ...f.ctx, send() { throw new Error("FAILURE_ENVELOPE_SEND_FAILED"); } }, {
    t: "api.req", id: "cas-send-failure", method: "scheduledTasks.account.delete", path: "/desktop", body: { taskId: "account", expectedLocalRevision: 9 } }));
  assert.equal(f.logs.length, 1); await assert.rejects(f.scheduler.stopAndDrain());
});

test("handled local revision conflict still blocks update switching", async t => {
  const f = fixture(t); await ready(f);
  assert.equal((await f.call("delete", { taskId: "account", expectedLocalRevision: 9 })).status, 409);
  await assert.rejects(f.scheduler.stopForUpdate({ requestId: "cas-update" }));
});

test("other account configuration conflicts still block resource shutdown", async t => {
  const f = fixture(t); await ready(f);
  (f.scheduler as any).state.queuedByTaskId.set("account", { scheduledAt: Date.now(), workspaceId: "other:workspace" });
  assert.equal((await f.call("delete", { taskId: "account", expectedLocalRevision: 10 })).status, 409);
  await assert.rejects(f.scheduler.stopAndDrain());
});

test("local revision conflict diagnostic failure still blocks resource shutdown", async t => {
  const f = fixture(t); await ready(f);
  t.mock.method(logger, "error", () => { throw new Error("DIAGNOSTIC_WRITE_FAILED"); });
  await assert.rejects(f.call("delete", { taskId: "account", expectedLocalRevision: 9 }));
  await assert.rejects(f.scheduler.stopAndDrain());
});

test("config storage failure still fails shutdown after its explicit API failure", async t => {
  const f = fixture(t); await ready(f);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.exec(`CREATE TRIGGER reject_shutdown_stage BEFORE UPDATE OF pending_json ON scheduled_task_account_configs
    BEGIN SELECT RAISE(ABORT,'STORAGE_FAILURE'); END`));
  assert.equal((await f.call("delete", { taskId: "account", expectedLocalRevision: 10 })).status, 500);
  await assert.rejects(f.scheduler.stopAndDrain());
  assert.equal(f.calls.filter(call => call.action === "config").length, 0);
});

test("unhandled config request rejection remains a shutdown failure", async t => {
  const f = fixture(t); await ready(f);
  f.fail(Object.assign(new Error("SCHEDULED_TASK_API_FAILED"), { code: "SCHEDULED_TASK_API_FAILED", reason: "invalid_ack", stage: "config_writeback" }), true);
  await assert.rejects(f.scheduler.reviseAccountConfig({ taskId: "account", expectedLocalRevision: 10, operation: "update", config: f.edit() }));
  await assert.rejects(f.scheduler.stopAndDrain());
  assert.equal(f.logs.length, 0);
});

test("config failure diagnostic failure never qualifies as handled shutdown", async t => {
  const f = fixture(t); await ready(f);
  f.fail(Object.assign(new Error("SCHEDULED_TASK_API_FAILED"), { code: "SCHEDULED_TASK_API_FAILED", reason: "invalid_ack", stage: "config_writeback" }), true);
  t.mock.method(logger, "error", () => { throw new Error("DIAGNOSTIC_WRITE_FAILED"); });
  await assert.rejects(f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit() }));
  await assert.rejects(f.scheduler.stopAndDrain());
  assert.equal((await f.call("list")).body.items[0].pending, true);
});

test("undelivered config failure response must still fail resource shutdown", async t => {
  const f = fixture(t); await ready(f);
  f.fail(Object.assign(new Error("SCHEDULED_TASK_API_FAILED"), { code: "SCHEDULED_TASK_API_FAILED", reason: "invalid_ack", stage: "config_writeback" }), true);
  let attempts = 0;
  await assert.rejects(handleApiRequest({ ...f.ctx, send(message) {
    if (message.t === "api.res") { attempts++; throw new Error("FAILURE_ENVELOPE_SEND_FAILED"); }
    return f.ctx.send(message);
  } }, { t: "api.req", id: "config-send-failure", method: "scheduledTasks.account.update", path: "/desktop",
    body: { taskId: "account", expectedLocalRevision: 10, config: f.edit() } }));
  assert.equal(attempts, 1); assert.equal(f.logs.length, 1);
  await assert.rejects(f.scheduler.stopAndDrain());
});

test("account list and sync expose trusted Host device even before the first task exists", async t => {
  const f = fixture(t);
  const empty = await f.call("list");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { ok: true, clientId: "desktop", deviceId: "installation", items: [] });
  assert.equal(f.calls.length, 0);
  const synced = await f.call("sync");
  assert.equal(synced.status, 200); assert.equal(synced.body.clientId, "desktop"); assert.equal(synced.body.deviceId, "installation");
  assert.equal(synced.body.items[0].task.id, "account");
  assert.equal((await f.call("delete", { taskId: "account", expectedLocalRevision: 10 })).status, 200);
  const emptySync = await f.call("sync");
  assert.equal(emptySync.status, 200);
  assert.deepEqual(emptySync.body, { ok: true, clientId: "desktop", deviceId: "installation", items: [] });
  const count = f.calls.length;
  for (const action of ["list", "sync"]) {
    const forged = await f.call(action, { clientId: "other", deviceId: "forged" });
    assert.equal(forged.status, 400); assert.equal("clientId" in forged.body, false);
  }
  assert.equal(f.calls.length, count);
});

test("account list and sync reject missing Host device before any account HTTP", async t => {
  const f = fixture(t);
  for (const field of ["clientId", "deviceId"] as const) {
    const original = f.ctx[field];
    try {
      for (const value of [undefined, "", " ", " padded ", 42]) {
        (f.ctx as any)[field] = value;
        for (const action of ["list", "sync"]) {
          const result = await f.call(action);
          assert.equal(result.status, 500); assert.equal(result.body.ok, false); assert.equal("items" in result.body, false);
        }
      }
    } finally { (f.ctx as any)[field] = original; }
  }
  assert.equal(f.calls.length, 0);
});

test("account device projection never turns missing owner or storage failure into an empty success", async t => {
  const f = fixture(t); f.status.active = false;
  const unlinked = await f.call("list");
  assert.equal(unlinked.status, 500); assert.equal("clientId" in unlinked.body, false); assert.equal("items" in unlinked.body, false);
  f.status.active = true;
  t.mock.method(f.db, "listAccountScheduledTaskConfigs", () => { throw new Error("DEVICE_VIEW_STORAGE_FAILED"); });
  const broken = await f.call("list");
  assert.equal(broken.status, 500); assert.equal("deviceId" in broken.body, false); assert.equal("items" in broken.body, false);
  assert.equal(f.calls.length, 0);
});

test("desktop account edit saves a local CAS revision before original config HTTP and commits its ACK", async t => {
  const f = fixture(t); await ready(f);
  const listed = await f.call("list"); assert.equal(listed.status, 200); assert.equal(listed.body.items[0].localRevision, 10);
  const result = await f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "新配置" }) });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.item.task.name, "新配置");
  assert.equal(result.body.item.localRevision, 11); assert.equal(result.body.item.pending, false);
  const request = f.calls.find(call => call.action === "config")!; assert.equal(request.body.localRevision, 11); assert.equal(request.body.expectedConfigRevision, 1);
  assert.equal(f.db.scheduledTaskConfigs.list({ clientId: "desktop", deviceId: "installation" }).length, 0);
});

test("local config CAS rejects stale edits without HTTP and revision overflow never wraps", async t => {
  const f = fixture(t); await ready(f); const count = f.calls.length;
  assert.equal((await f.call("update", { taskId: "account", expectedLocalRevision: 9, config: f.edit() })).status, 409);
  await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(f.calls.length, count);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_account_configs SET local_revision=?").run(Number.MAX_SAFE_INTEGER));
  assert.equal((await f.call("update", { taskId: "account", expectedLocalRevision: Number.MAX_SAFE_INTEGER, config: f.edit() })).status, 409);
  await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(f.calls.length, count);
});

test("lost config ACK retains the identical pending tuple and retries once without repeating Server changes", async t => {
  const f = fixture(t); await ready(f); f.fail(Object.assign(new Error("SCHEDULED_TASK_API_FAILED"), { code: "SCHEDULED_TASK_API_FAILED", reason: "transport_failed" }), true);
  const failed = await f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "一次提交" }) }); assert.equal(failed.status, 500);
  await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal((await f.call("list")).body.items[0].pending, true);
  f.fail(undefined); await f.scheduler.sync("retry"); await f.scheduler.waitForInFlightWork();
  const requests = f.calls.filter(call => call.action === "config"); assert.equal(requests.length, 2); assert.deepEqual(requests[0]!.body, requests[1]!.body);
  assert.equal(f.snapshot()!.configRevision, 2); assert.equal((await f.call("list")).body.items[0].pending, false);
});

for (const code of ["FORBIDDEN", "NOT_FOUND", "BAD_REQUEST", "CONFLICT", "UNAUTHORIZED"]) test(`explicit config ${code} restores a stopped valid snapshot and returns failure`, async t => {
  const f = fixture(t); await ready(f);
  f.fail(Object.assign(new Error("SCHEDULED_TASK_API_FAILED"), { code: "SCHEDULED_TASK_API_FAILED", reason: "rejected_response", upstreamCode: code, httpStatus: code === "CONFLICT" ? 409 : 403 }));
  const result = await f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "不应采用", enabled: false }) });
  assert.notEqual(result.status, 200); await assert.rejects(f.scheduler.waitForInFlightWork());
  const item = (await f.call("list")).body.items[0]; assert.equal(item.task.name, "原配置"); assert.equal(item.pending, false);
  assert.equal(item.stopIntent, "disabled"); assert.equal(item.task.enabled, false);
  assert.doesNotMatch(JSON.stringify(f.logs), /不应采用/);
});

test("editing during config await appends a new immutable revision without losing its newer draft", async t => {
  const f = fixture(t); await ready(f); const release = f.hold();
  const first = f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "first" }) });
  for (let i = 0; !f.calls.some(call => call.action === "config"); i++) { assert.ok(i < 100); await new Promise(setImmediate); }
  const second = f.call("update", { taskId: "account", expectedLocalRevision: 11, config: f.edit({ name: "second" }) });
  await new Promise(setImmediate); release();
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  const edits = f.calls.filter(call => call.action === "config"); assert.deepEqual(edits.map(call => [call.body.localRevision, call.body.expectedConfigRevision]), [[11, 1], [12, 2]]);
  assert.equal((await f.call("list")).body.items[0].task.name, "second");
});

test("local delete intent blocks stale configuration and keeps delete ACK retry after Server deletion", async t => {
  const f = fixture(t); await ready(f); f.fail(Object.assign(new Error("SCHEDULED_TASK_API_FAILED"), { code: "SCHEDULED_TASK_API_FAILED", reason: "transport_failed" }), true);
  assert.equal((await f.call("delete", { taskId: "account", expectedLocalRevision: 10 })).status, 500);
  await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal((await f.call("list")).body.items.length, 0); assert.equal(f.snapshot(), null);
  f.fail(undefined); await f.scheduler.sync("retry-delete"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.calls.filter(call => call.action === "config").length, 2); assert.equal((await f.call("list")).body.items.length, 0);
});

test("pending local stop blocks manual execution before HTTP even when old Server config is enabled", async t => {
  const f = fixture(t); await ready(f);
  const release = f.hold(), edit = f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ enabled: false }) });
  for (let i = 0; !f.calls.some(call => call.action === "config"); i++) { assert.ok(i < 100); await new Promise(setImmediate); }
  const current = f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.accountConfigs.list(f.owner)[0]!);
  assert.equal(current.stopIntent, "disabled");
  const count = f.calls.length;
  try {
    assert.throws(() => (f.scheduler as any).accountForTask({ ...current.task, enabled: true }), /SCHEDULED_TASK_ACCOUNT_UNAVAILABLE/);
    assert.equal(f.calls.length, count);
  } finally { release(); await edit; }
});

test("deleted pending task never sends an old terminal result to Server", async t => {
  const f = fixture(t); await ready(f);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.accountConfigs.stage(f.owner, { taskId: "account", expectedLocalRevision: 10, operation: "delete" }));
  const count = f.calls.length;
  const outcome = await (f.scheduler as any).reportRun({ id: "old-result", taskId: "account", clientId: "desktop", deviceId: "installation",
    workspaceId: f.workspaceId, status: "success", scheduledAt: 1, finishedAt: 2 }, f.owner);
  assert.equal(outcome, "task_deleted"); assert.equal(f.calls.length, count);
});

test("Server snapshot cannot overwrite a newer pending edit or clear its stop intent", async t => {
  const f = fixture(t); await ready(f); const old = structuredClone(f.snapshot()!);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.accountConfigs.stage(f.owner,
    { taskId: "account", expectedLocalRevision: 10, operation: "update", config: f.edit({ name: "local-only", enabled: false }) }));
  const tasks = f.db.replaceAccountScheduledTaskConfigs(f.owner, { tasks: [{ ...old, enabled: true }],
    configRevisionFloors: [{ taskId: old.id, localRevision: 30 }], serverNow: 1 });
  assert.equal(tasks.get("account")!.name, "local-only"); assert.equal(tasks.get("account")!.enabled, false);
  const item = (await f.call("list")).body.items[0]; assert.equal(item.localRevision, 30); assert.equal(item.pending, true); assert.equal(item.stopIntent, "disabled");
  await f.scheduler.sync("write-original-pending"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.calls.find(call => call.action === "config")!.body.localRevision, 11);
});

test("a sync captured before a local edit preserves its pending revision when Server floor is lower", async t => {
  const f = fixture(t); await ready(f);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.accountConfigs.stage(f.owner,
    { taskId: "account", expectedLocalRevision: 10, operation: "update", config: f.edit({ name: "newer-pending" }) }));
  const tasks = f.db.replaceAccountScheduledTaskConfigs(f.owner, { tasks: [f.snapshot()!], configRevisionFloors: [{ taskId: "account", localRevision: 0 }], serverNow: 1 });
  assert.equal(tasks.get("account")!.name, "newer-pending"); assert.equal((await f.call("list")).body.items[0].localRevision, 11);
});

test("local config SQL failure rolls back revision and stop intent before any HTTP", async t => {
  const f = fixture(t); await ready(f);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.exec(`CREATE TRIGGER reject_stage BEFORE UPDATE OF pending_json ON scheduled_task_account_configs
    BEGIN SELECT RAISE(ABORT,'SECRET_REVISION'); END`));
  const count = f.calls.length, result = await f.call("delete", { taskId: "account", expectedLocalRevision: 10 });
  assert.equal(result.status, 500); await assert.rejects(f.scheduler.waitForInFlightWork()); assert.equal(f.calls.length, count);
  const item = (await f.call("list")).body.items[0]; assert.equal(item.localRevision, 10); assert.equal(item.pending, false); assert.equal(item.stopIntent, null);
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_REVISION/);
});

for (const bad of ["enabled", "deleted"] as const) test(`corrupt ${bad} stop marker cannot make pending config executable`, async t => {
  const f = fixture(t); await ready(f);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => {
    repos.accountConfigs.stage(f.owner, { taskId: "account", expectedLocalRevision: 10,
      operation: bad === "deleted" ? "delete" : "update", ...(bad === "enabled" ? { config: f.edit({ enabled: false }) } : {}) });
    repos.db.prepare("UPDATE scheduled_task_account_configs SET stop_intent=NULL").run();
  });
  const result = await f.call("list"); assert.equal(result.status, 500);
});

test("local disable consumes the original queued minute before a later enable can revive it", async t => {
  const f = fixture(t); await ready(f); const schedulerState = (f.scheduler as any).state;
  schedulerState.queuedByTaskId.set("account", { scheduledAt: 120_000, workspaceId: f.workspaceId });
  const release = f.hold(), update = f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ enabled: false }) });
  try {
    for (let i = 0; !f.calls.some(call => call.action === "config"); i++) { assert.ok(i < 100); await new Promise(setImmediate); }
    assert.equal(schedulerState.queuedByTaskId.has("account"), false);
    assert.equal(f.db.readAccountScheduledTaskState("account", f.owner).lastScheduledAt, 120_000);
  } finally { release(); await update; }
});

test("reopening SQLite and constructing a cold Scheduler resends the saved exact revision", async t => {
  const f = fixture(t); await ready(f);
  f.fail(Object.assign(new Error("SCHEDULED_TASK_API_FAILED"), { code: "SCHEDULED_TASK_API_FAILED", reason: "transport_failed" }), true);
  assert.equal((await f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "persisted" }) })).status, 500);
  await assert.rejects(f.scheduler.waitForInFlightWork()); await f.scheduler.stopAndDrain(); f.db.close();
  const db = openClientDb({ dbPath: path.join(f.root, "client.db") }), ctx = { ...f.ctx, db };
  const scheduler = new ScheduledTaskScheduler({ ...f.schedulerInput, apiContext: ctx, localApiContext: ctx });
  try {
    f.fail(undefined); await scheduler.sync("cold-retry"); await scheduler.waitForInFlightWork();
    const edits = f.calls.filter(call => call.action === "config"); assert.equal(edits.length, 2); assert.deepEqual(edits[0]!.body, edits[1]!.body);
    assert.equal(scheduler.listAccountConfigs()[0]!.task.name, "persisted"); assert.equal(scheduler.listAccountConfigs()[0]!.pending, false);
  } finally { await scheduler.stopAndDrain(); db.close(); }
});

test("unlink during config HTTP never commits an old owner ACK and later sync replays its tuple", async t => {
  const f = fixture(t); await ready(f); const release = f.hold();
  const update = f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "old-owner" }) });
  for (let i = 0; !f.calls.some(call => call.action === "config"); i++) { assert.ok(i < 100); await new Promise(setImmediate); }
  f.status.active = false; release(); assert.equal((await update).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork());
  const pending = f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.accountConfigs.list(f.owner)[0]!.pending); assert.equal(pending.length, 1);
  f.status.active = true; await f.scheduler.sync("owner-revalidated"); await f.scheduler.waitForInFlightWork();
  assert.equal((await f.call("list")).body.items[0].pending, false); const edits = f.calls.filter(call => call.action === "config"); assert.deepEqual(edits[0]!.body, edits[1]!.body);
});

test("ACK SQLite failure keeps the accepted Server revision pending and retry reuses its receipt", async t => {
  const f = fixture(t); await ready(f);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.exec(`CREATE TRIGGER reject_ack BEFORE UPDATE OF snapshot_json ON scheduled_task_account_configs
    BEGIN SELECT RAISE(ABORT,'SECRET_ACK'); END`));
  assert.equal((await f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "server-committed" }) })).status, 500);
  await assert.rejects(f.scheduler.waitForInFlightWork()); assert.equal((await f.call("list")).body.items[0].pending, true);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.exec("DROP TRIGGER reject_ack"));
  await f.scheduler.sync("ack-storage-recovered"); await f.scheduler.waitForInFlightWork(); assert.equal((await f.call("list")).body.items[0].pending, false);
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_ACK/);
});

test("invalid config ACK never clears pending and valid retry commits the original receipt", async t => {
  const f = fixture(t); await ready(f); f.invalidAck(true);
  assert.equal((await f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "valid-tuple-only" }) })).status, 409);
  await assert.rejects(f.scheduler.waitForInFlightWork()); assert.equal((await f.call("list")).body.items[0].pending, true);
  f.invalidAck(false); await f.scheduler.sync("valid-ack"); await f.scheduler.waitForInFlightWork(); assert.equal((await f.call("list")).body.items[0].pending, false);
});

test("schema99 account snapshots remain readable without mutation until the original writer upgrades101", async t => {
  const f = fixture(t); await ready(f); const file = path.join(f.root, "workspace/.codeflowai/workspace.db");
  const legacy = openSqliteDb(file, { fileMustExist: true });
  try { legacy.exec("ALTER TABLE scheduled_task_account_configs DROP COLUMN pending_json; ALTER TABLE scheduled_task_account_configs DROP COLUMN stop_intent; ALTER TABLE scheduled_task_account_configs DROP COLUMN server_present; PRAGMA user_version=99"); }
  finally { legacy.close(); }
  const bytes = fs.readFileSync(file); assert.equal((await f.call("list")).body.items[0].localRevision, 10); assert.deepEqual(fs.readFileSync(file), bytes);
  const result = await f.call("update", { taskId: "account", expectedLocalRevision: 10, config: f.edit({ name: "upgraded" }) }); assert.equal(result.status, 200);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => { assert.equal(repos.db.pragma("user_version", { simple: true }), 101); });
});
