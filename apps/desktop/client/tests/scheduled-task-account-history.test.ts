import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { ScheduledTask, ScheduledTaskRun, WorkspaceId } from "@codeflowai/shared";
import type { ClientConfig } from "../src/config.js";
import { openClientDb } from "../src/db/clientDb.js";
import type { ScheduledTaskAccountOwner } from "../src/db/repos/scheduledTaskRunRepo.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { logger } from "../src/logger.js";

/** 真实桥/SQLite/Scheduler，历史直接沿原仓储产生，HTTP仅控制当次账号响应。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-history-")); t.mock.method(os, "homedir", () => root);
  const db = openClientDb({ dbPath: path.join(root, "client.db") }), workspaceId = "desktop:history" as WorkspaceId;
  const directory = path.join(root, "workspace"); fs.mkdirSync(directory); db.workspaces.upsert({ id: workspaceId, title: "history", path: directory });
  const status = { active: true }, owner = { serverOrigin: "http://127.0.0.1:1", ownerUserId: "A", clientId: "desktop", deviceId: "installation", generation: 1,
    assertCurrent() { if (!status.active) throw new Error("ACCOUNT_STALE"); } };
  let task: ScheduledTask | null = { id: "account", ownerUserId: "A", clientId: "desktop", deviceId: "installation", deviceKind: "desktop", configRevision: 1,
    clientNameSnapshot: "Desktop", deviceLabelSnapshot: null, name: "账号脚本", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "cmd" : "sh", command: "echo account-history", contextWorkspaceId: workspaceId }, concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 10_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
  const logs: unknown[][] = [], calls: string[] = []; t.mock.method(logger, "error", (...args: unknown[]) => { logs.push(args); });
  let hold: Promise<void> | null = null;
  const ctx = { db, clientId: "desktop", deviceId: "installation", localWorkspaceOnly: true,
    workspaces: new Map([[workspaceId, directory]]), send() {} } as unknown as ApiHandlerContext;
  const input: ConstructorParameters<typeof ScheduledTaskScheduler>[0] = { config: { clientId: "desktop", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: "installation", apiContext: ctx, localApiContext: ctx, captureAccountContext: () => status.active ? owner : null,
    requestAccountTasks: async (_owner, action) => {
      calls.push(action); if (hold) await hold;
      return action === "sync" ? { tasks: task ? [structuredClone(task)] : [], configRevisionFloors: task ? [{ taskId: task.id, localRevision: 0 }] : [], serverNow: Date.now() }
        : { serverNow: Date.now() };
    } };
  const scheduler = new ScheduledTaskScheduler(input); ctx.scheduledTaskScheduler = scheduler; let sequence = 0;
  t.after(async () => { try { await scheduler.stopAndDrain(); } finally { db.close(); fs.rmSync(root, { recursive: true }); } });
  return { root, db, owner, scheduler, input, ctx, workspaceId, logs, calls, status,
    /** 只经原preload白名单与中央handler操作。 */
    call(action: string, body: Record<string, unknown> = {}) { return executeDesktopApiRequest(ctx,
      { method: `scheduledTasks.account.${action}`, body } as never, { requestId: `history-${++sequence}`, clientVersion: "test", startedAt: 1 }) as Promise<{ status: number; body: any }>; },
    /** 保留历史，模拟Server完整清单删除任务。 */
    removeTask() { task = null; },
    /** 当前库原子创建并完成真实历史，不依赖配置副本存在。 */
    seed(id: string, createdAt: number, workspace: WorkspaceId | null = workspaceId, captured: ScheduledTaskAccountOwner = owner) {
      const run: ScheduledTaskRun = { id, taskId: "account", clientId: captured.clientId, deviceId: captured.deviceId, workspaceId: workspace,
        workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null, scheduledAt: createdAt, createdAt, startedAt: createdAt,
        finishedAt: null, durationMs: null, status: "running", triggerSource: "manual", attempt: 1, summary: null, errorMessage: null, outputExcerpt: null };
      db.withAccountScheduledTasks(workspace, repos => repos.db.transaction(() => {
        repos.runs.createAccount({ run, owner: captured, taskName: "历史名称" });
        repos.runs.completeAccount({ ...run, status: "success", finishedAt: createdAt + 1, durationMs: 1, outputExcerpt: "ok" }, captured);
      })());
    },
    /** 确保等待测试异常退出也能释放。 */
    hold() { let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; }); return () => { hold = null; release(); }; },
  };
}

test("account history bridge merges stable pages across physical sources without HTTP or writes", async t => {
  const f = fixture(t); f.seed("w-new", 30); f.seed("app-new", 20, null); f.seed("w-old", 10);
  const before = f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("SELECT * FROM scheduled_task_runs ORDER BY id").all());
  const result = await f.call("runs", { offset: 1, limit: 1 }); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.total, 3); assert.deepEqual(result.body.items.map((item: any) => item.id), ["app-new"]);
  assert.equal(result.body.items[0].taskNameSnapshot, "历史名称"); assert.equal(result.body.items[0].source, "account");
  assert.equal(f.calls.length, 0); assert.deepEqual(f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("SELECT * FROM scheduled_task_runs ORDER BY id").all()), before);
  for (const key of ["serverOrigin", "ownerUserId", "reportSettlement", "reportSettledAt"]) assert.equal(key in result.body.items[0], false);
});

test("account history survives task removal and SQLite reopen", async t => {
  const f = fixture(t); f.seed("deleted-history", 10); f.removeTask();
  await f.scheduler.sync("deleted"); await f.scheduler.waitForInFlightWork();
  assert.equal((await f.call("runs", { taskId: "account" })).body.total, 1);
  await f.scheduler.stopAndDrain(); f.db.close();
  const db = openClientDb({ dbPath: path.join(f.root, "client.db") }), ctx = { ...f.ctx, db };
  const scheduler = new ScheduledTaskScheduler({ ...f.input, apiContext: ctx, localApiContext: ctx }); ctx.scheduledTaskScheduler = scheduler;
  try {
    const result = await executeDesktopApiRequest(ctx, { method: "scheduledTasks.account.runs", body: { taskId: "account" } } as never,
      { requestId: "reopened-history", clientVersion: "test", startedAt: 1 });
    assert.equal(result.status, 200); assert.equal((result.body as any).items[0].id, "deleted-history");
  } finally { await scheduler.stopAndDrain(); db.close(); }
});

test("history query isolates every owner field before decoding other accounts", async t => {
  const f = fixture(t); f.seed("mine", 10);
  const variants = [{ ownerUserId: "B" }, { serverOrigin: "http://other.example" }, { clientId: "other" }, { deviceId: "old" }];
  for (const [index, patch] of variants.entries()) f.seed(`foreign-${index}`, 20 + index, f.workspaceId, { ...f.owner, ...patch });
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_runs SET duration_ms=50 WHERE id LIKE 'foreign-%'").run());
  const result = await f.call("runs"); assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].id, "mine");
  f.status.active = false; assert.equal((await f.call("runs")).status, 500);
});

test("history pagination reads beyond each physical repository 200 row boundary", async t => {
  const f = fixture(t); for (let index = 0; index < 205; index++) f.seed(`w-${String(index).padStart(3, "0")}`, index + 1);
  f.seed("top", 999, null);
  const result = await f.call("runs", { offset: 200, limit: 6 }); assert.equal(result.status, 200);
  assert.equal(result.body.total, 206); assert.deepEqual(result.body.items.map((item: any) => item.id), ["w-005", "w-004", "w-003", "w-002", "w-001", "w-000"]);
});

test("duplicate physical account run identity fails rather than hiding either history", async t => {
  const f = fixture(t); f.seed("same", 1); f.seed("same", 1, null);
  assert.equal((await f.call("runs")).status, 500); assert.equal(f.calls.length, 0);
});

test("corrupt owned history and SQL failure are explicit and preserve their bytes", async t => {
  const f = fixture(t); f.seed("bad", 1);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_runs SET duration_ms=50").run());
  assert.equal((await f.call("runs")).status, 500);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.exec("DROP TABLE scheduled_task_runs"));
  assert.equal((await f.call("runs")).status, 500); assert.equal(f.calls.length, 0);
});

for (const body of [{ ownerUserId: "B" }, { workspaceId: "other" }, { offset: -1 }, { limit: 201 }, { taskId: [] }]) test(`account history rejects invalid renderer fields ${JSON.stringify(body)}`, async t => {
  const f = fixture(t); assert.notEqual((await f.call("runs", body)).status, 200); assert.equal(f.calls.length, 0);
});

test("account runNow bridge uses the original real script execution and durable account history", async t => {
  const f = fixture(t); const result = await f.call("runNow", { taskId: "account" });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.run.status, "success");
  const history = await f.call("runs", { taskId: "account" }); assert.equal(history.status, 200); assert.equal(history.body.total, 1);
  assert.match(history.body.items[0].outputExcerpt, /account-history/); assert.equal(f.db.scheduledTaskConfigs.list({ clientId: "desktop", deviceId: "installation" }).length, 0);
});

test("account runNow awaiting sync rejects a revoked owner before dispatch", async t => {
  const f = fixture(t), release = f.hold(), run = f.call("runNow", { taskId: "account" });
  try { await new Promise(setImmediate); f.status.active = false; } finally { release(); }
  assert.equal((await run).status, 500); await assert.rejects(f.scheduler.waitForInFlightWork());
  assert.equal(f.calls.some(action => action === "report"), false);
});

test("account history filters taskId and stabilizes equal-time ordering without current configs", async t => {
  const f = fixture(t); f.seed("a", 10, null); f.seed("z", 10); f.seed("foreign-task", 20);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_runs SET task_id='other-task' WHERE id='foreign-task'").run());
  const result = await f.call("runs", { taskId: "account" }); assert.equal(result.status, 200);
  assert.equal(result.body.total, 2); assert.deepEqual(result.body.items.map((item: any) => item.id), ["z", "a"]);
  const empty = await f.call("runs", { taskId: "missing", offset: 100 }); assert.equal(empty.status, 200); assert.equal(empty.body.total, 0); assert.deepEqual(empty.body.items, []);
});

test("unknown local-source history is not decoded as an account record", async t => {
  const f = fixture(t); f.seed("mine", 1); f.seed("local", 2);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_runs SET source='local',duration_ms=50,config_revision=1,server_origin=NULL,owner_user_id=NULL WHERE id='local'").run());
  const result = await f.call("runs"); assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].id, "mine");
});

test("history failure diagnosis is attempted once and diagnostic failure remains explicit", async t => {
  const f = fixture(t); f.seed("bad", 1);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_runs SET duration_ms=50").run());
  let attempts = 0; const log = t.mock.method(logger, "error", () => { attempts++; throw new Error("HISTORY_LOG_FAILED"); });
  try { await assert.rejects(f.call("runs")); assert.equal(attempts, 1); assert.equal(f.calls.length, 0); }
  finally { log.mock.restore(); }
});

test("history failure identifies the captured account and does not suggest config resync", async t => {
  const f = fixture(t); f.seed("bad-history", 1);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_runs SET duration_ms=50").run());
  const result = await f.call("runs"); assert.equal(result.status, 500); assert.doesNotMatch(result.body.message, /重新同步/);
  const logs = f.logs.filter(args => args[1] === "account configuration request failed"); assert.equal(logs.length, 1);
  assert.equal((logs[0]![2] as Record<string, unknown>).ownerUserId, "A");
});

test("reading a 200 row account history page avoids repeated physical database opens", async t => {
  const f = fixture(t), owner = f.owner;
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.transaction(() => {
    for (let index = 0; index < 206; index++) {
      const run: ScheduledTaskRun = { id: `batch-${index}`, taskId: "account", clientId: owner.clientId, deviceId: owner.deviceId, workspaceId: f.workspaceId,
        workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null, scheduledAt: index, createdAt: index, startedAt: null,
        finishedAt: index, durationMs: null, status: "skipped", triggerSource: "schedule", attempt: 1, summary: "skipped", errorMessage: null, outputExcerpt: null };
      repos.runs.createAccount({ run, owner, taskName: "batch" });
    }
  })());
  const start = performance.now(), result = await f.call("runs", { limit: 200 });
  assert.equal(result.status, 200); assert.equal(result.body.total, 206); assert.equal(result.body.items.length, 200);
  assert.ok(performance.now() - start < 10_000, "a local 200-row read must finish within 10 seconds");
});

test("history detects an older duplicate beyond another physical source first page", async t => {
  const f = fixture(t); f.seed("collision", 100); f.seed("collision", 1, null); f.seed("top-app", 200, null);
  assert.equal((await f.call("runs", { offset: 0, limit: 1 })).status, 500);
});

test("unfiltered corrupt history diagnostics keep the actual task and run identity", async t => {
  const f = fixture(t); f.seed("bad-owned", 1);
  f.db.withAccountScheduledTasks(f.workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_runs SET duration_ms=50").run());
  assert.equal((await f.call("runs")).status, 500);
  const log = f.logs.find(args => args[1] === "account configuration request failed")![2] as { taskId: string; rootCause: { runId: string } };
  assert.equal(log.taskId, "account"); assert.equal(log.rootCause.runId, "bad-owned");
});
