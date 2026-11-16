import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LocalScheduledTaskConfigInput, ScheduledTask, ClientScheduledTaskReportRequestBody } from "@codeflowai/shared";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { openClientDb } from "../src/db/clientDb.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";

/** 两来源使用真实SQLite和脚本，只控制云合同，不另建timer或运行状态。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dual-tasks-")); t.mock.method(os, "homedir", () => root);
  let now = 1_800_000_005_000; t.mock.method(Date, "now", () => now);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const identity = { linked: false, generation: 1 }, gates = { paused: false }, calls: { action: string; body: unknown }[] = [];
  const failure = new Error("CONTROLLED_CLOUD_TASK_FAILED"), captureFailure = new Error("CONTROLLED_CAPTURE_FAILED");
  let rejecting = false, brokenCapture = false;
  const local: LocalScheduledTaskConfigInput = { id: "same-id", source: "local", clientId: "desktop", deviceId: "installation", workspaceScope: null,
    name: "本机任务", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "cmd" : "sh", command: "echo local" }, concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 10_000 };
  db.scheduledTaskConfigs.create({ config: local, at: 1 });
  const { source: _source, workspaceScope: _scope, ...fields } = local;
  const task: ScheduledTask = { ...fields, name: "账号任务", ownerUserId: "A", deviceKind: "desktop", configRevision: 1, clientNameSnapshot: "Desktop", deviceLabelSnapshot: null,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
  const context = { db, localWorkspaceOnly: true, clientId: "desktop", deviceId: "installation", workspaces: new Map() } as unknown as ApiHandlerContext;
  const owner = { serverOrigin: "http://127.0.0.1:1", ownerUserId: "A", clientId: "desktop", deviceId: "installation" };
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: "desktop", serverWsUrl: "ws://127.0.0.1:1/ws", apiKey: "forbidden" } as ClientConfig,
    deviceId: "installation", apiContext: context, localApiContext: context, isTaskAdmissionPaused: () => gates.paused,
    captureAccountContext: () => {
      if (brokenCapture) throw captureFailure;
      if (!identity.linked) return null;
      const generation = identity.generation;
      return { ...owner, generation, assertCurrent() { if (!identity.linked || generation !== identity.generation) throw new Error("ACCOUNT_STALE"); } };
    },
    requestAccountTasks: async (_owner, action, body) => {
      calls.push({ action, body }); if (rejecting) throw failure;
      return action === "sync" ? { tasks: [task], configRevisionFloors: [{ taskId: task.id, localRevision: 0 }], serverNow: now } : { serverNow: now };
    },
  });
  t.after(async () => {
    try { await scheduler.stopAndDrain(); }
    finally { db.close(); fs.rmSync(root, { recursive: true }); }
  });
  return { db, scheduler, identity, gates, calls, owner, failure, captureFailure,
    /** 下一分钟只改变计划时钟，不调整真实脚本/停止等待预算。 */
    nextMinute() { now += 60_000; },
    /** 云失败是显式输入，恢复仍走原sync。 */
    rejectCloud(value: boolean) { rejecting = value; },
    /** getter异常属于真实故障，不能当未关联忽略。 */
    failCapture(value: boolean) { brokenCapture = value; } };
}

test("desktop dual task sources keep local offline and schedule both same IDs once on the original tick", async t => {
  const f = fixture(t);
  await f.scheduler.syncAndTick("offline"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1); assert.equal(f.calls.length, 0);
  f.identity.linked = true;
  await Promise.all([f.scheduler.syncAndTick("linked"), f.scheduler.syncAndTick("same-minute")]); await f.scheduler.waitForInFlightWork();
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  const accountRuns = f.calls.filter(call => call.action === "report" && (call.body as ClientScheduledTaskReportRequestBody).run?.status === "success");
  assert.equal(accountRuns.length, 1);
  assert.equal(f.db.listPendingAccountScheduledTaskRuns(f.owner).length, 0);
  f.identity.linked = false; f.identity.generation++; f.nextMinute();
  const previous = f.calls.length;
  await f.scheduler.syncAndTick("unlinked"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 2); assert.equal(f.calls.length, previous);
});

test("desktop dual task sources clear a captured account on unlink without stopping local work", async t => {
  const f = fixture(t); f.identity.linked = true;
  await f.scheduler.syncAndTick("linked"); await f.scheduler.waitForInFlightWork();
  f.identity.linked = false; f.identity.generation++; f.nextMinute();
  const count = f.calls.length;
  await f.scheduler.syncAndTick("unlinked"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.calls.length, count); assert.equal(f.db.scheduledTaskRuns.list({}).total, 2);
});

test("desktop dual task sources preserve unexpected owner failures instead of treating them as an unlinked account", async t => {
  const f = fixture(t); f.identity.linked = true; f.failCapture(true);
  await assert.rejects(f.scheduler.syncAndTick("capture-failed"), error => error === f.captureFailure);
  await assert.rejects(f.scheduler.waitForInFlightWork(), error => error === f.captureFailure);
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1); assert.equal(f.calls.length, 0);
  f.failCapture(false); await f.scheduler.syncAndTick("capture-recovered"); await f.scheduler.waitForInFlightWork();
  assert.ok(f.calls.some(call => (call.body as ClientScheduledTaskReportRequestBody).run?.status === "success"));
});

test("desktop dual task sources expose cloud failure while local work proceeds and recovery uses the same scheduler", async t => {
  const f = fixture(t); f.identity.linked = true; f.rejectCloud(true);
  await assert.rejects(f.scheduler.syncAndTick("cloud-failed"));
  await f.scheduler.waitForInFlightWork();
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  f.rejectCloud(false); await f.scheduler.syncAndTick("cloud-recovered"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  assert.ok(f.calls.some(call => (call.body as ClientScheduledTaskReportRequestBody).run?.status === "success"));
  f.gates.paused = true; f.nextMinute(); const count = f.calls.length;
  await f.scheduler.syncAndTick("update-paused"); assert.equal(f.calls.length, count);
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 1);
  f.gates.paused = false; await f.scheduler.stopAndDrain();
  await assert.rejects(f.scheduler.syncAndTick("closed"));
});
