import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ScheduledTask, ScheduledTaskRun, WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext } from "../src/app/handleApiRequest.ts";
import type { ClientConfig } from "../src/config.ts";
import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { ScheduledTaskRuntimeStateRepo, scheduledTaskRuntimeKey, scheduledTaskAccountRuntimeKey } from "../src/db/repos/scheduledTaskRuntimeStateRepo.ts";
import { ScheduledTaskConfigRepo } from "../src/db/repos/scheduledTaskConfigRepo.js";
import { openSqliteDb } from "../src/db/sqliteDb.ts";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.ts";
import { logger } from "../src/logger.ts";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";

const CLIENT_ID = "client-1";
const DEVICE_ID = "device-1";
const WORKSPACE_ID = "client-1:workspace-1" as WorkspaceId;
const OTHER_WORKSPACE_ID = "client-1:workspace-2" as WorkspaceId;
const ACCOUNT_OWNER = { serverOrigin: "http://127.0.0.1:39280", ownerUserId: "user-1", clientId: CLIENT_ID, deviceId: DEVICE_ID };

/** 本片独立本机夹具使用真实 A/B 注册和 SQLite，不启动账号同步。 */
function localLogFixture(t: test.TestContext, unconfirmedLogClose = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-local-log-gate-")), a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b); const gate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath: path.join(root, "application.db"), workspaceOperationGate: gate });
  db.workspaces.upsert({ id: WORKSPACE_ID, title: "A", path: a }); db.workspaces.upsert({ id: OTHER_WORKSPACE_ID, title: "B", path: b });
  const ctx = { db, clientId: CLIENT_ID, deviceId: DEVICE_ID, localWorkspaceOnly: true, workspaceOperationGate: gate,
    workspaces: new Map([[WORKSPACE_ID, a], [OTHER_WORKSPACE_ID, b]]) } as unknown as ApiHandlerContext;
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: CLIENT_ID, serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: DEVICE_ID, apiContext: ctx, localApiContext: ctx });
  for (const [workspaceId, id] of [[WORKSPACE_ID, "local-a"], [OTHER_WORKSPACE_ID, "local-b"]] as const) db.withLocalScheduledTasks(workspaceId,
    repos => repos.configs.create({ at: 1, config: { id, source: "local", clientId: CLIENT_ID, deviceId: DEVICE_ID,
      workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId }, name: id, description: null, taskType: "script", cronExpr: "0 0 1 1 *", timezone: "UTC", enabled: true,
      payload: { shell: process.platform === "win32" ? "powershell" : "sh", command: "exit 0", contextWorkspaceId: workspaceId }, concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 10_000 } }));
  t.after(async () => {
    try { await scheduler.stopAndDrain(); }
    finally {
      if (unconfirmedLogClose) assert.throws(() => db.close(), { message: "CLIENT_DB_CLOSE_FAILED" });
      else db.close();
      fs.rmSync(root, { recursive: true });
    }
  });
  return { root, a, b, db, ctx, gate, scheduler };
}

/** 仅检查本例实际固定日志。 */
function localLogText(root: string): string {
  return fs.readdirSync(path.join(root, ".codeflowai")).filter(name => /^client-.*\.log$/.test(name))
    .map(name => fs.readFileSync(path.join(root, ".codeflowai", name), "utf8")).join("");
}

test("LSLOG 同 W 迁移拒写保因、异 W 继续，注册新根后只写新根", async t => {
  const f = localLogFixture(t), release = f.gate.restoreMigration(WORKSPACE_ID, "local-log-move");
  try {
    await assert.rejects(f.scheduler.runLocalNow("local-a"), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
    await assert.rejects(f.scheduler.waitForInFlightWork(), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
    assert.equal((await f.scheduler.runLocalNow("local-b")).status, "success");
  } finally { release(); }
  const newRoot = path.join(f.root, "new-a"); fs.cpSync(f.a, newRoot, { recursive: true });
  f.db.workspaces.upsert({ id: WORKSPACE_ID, title: "A", path: newRoot }); f.ctx.workspaces.set(WORKSPACE_ID, newRoot);
  f.db.withLocalScheduledTasks(WORKSPACE_ID, repos => repos.db.exec("CREATE TRIGGER fail_new_log_root BEFORE INSERT ON scheduled_task_runs BEGIN SELECT RAISE(ABORT, 'PRIVATE_NEW_ROOT_SQL'); END"));
  await assert.rejects(f.scheduler.runLocalNow("local-a"), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  await assert.rejects(f.scheduler.waitForInFlightWork(), { code: "SCHEDULED_TASK_RUN_STORAGE_FAILED" });
  assert.equal(localLogText(f.a), ""); assert.match(localLogText(newRoot), /local scheduled task transaction failed/); assert.equal(localLogText(f.b), "");
});

test("LSLOG 实际日志 close 未确认只挡同 W，原 close 明确失败且新 owner 可写", async t => {
  const f = localLogFixture(t, true), closeFailure = new Error("CONTROLLED_LOCAL_LOG_CLOSE");
  f.db.withLocalScheduledTasks(WORKSPACE_ID, repos => repos.db.exec("CREATE TRIGGER fail_log_close BEFORE INSERT ON scheduled_task_runs BEGIN SELECT RAISE(ABORT, 'PRIVATE_CLOSE_SQL'); END"));
  const nativeClose = fs.closeSync; let blocked = true;
  t.mock.method(fs, "closeSync", (fd: number) => { nativeClose(fd); if (blocked) { blocked = false; throw closeFailure; } });
  await assert.rejects(f.scheduler.runLocalNow("local-a"), error => {
    assert.ok(error instanceof AggregateError); assert.equal((error as AggregateError & { code: string }).code, "SCHEDULED_TASK_TRANSACTION_LOG_FAILED");
    assert.equal(error.errors[1], closeFailure); return true;
  });
  await assert.rejects(f.scheduler.waitForInFlightWork(), { code: "SCHEDULED_TASK_TRANSACTION_LOG_FAILED" });
  assert.equal(f.gate.hasActiveWrites(), true);
  f.db.writeWorkspaceLog(OTHER_WORKSPACE_ID, { level: "error", tag: "scheduled-tasks", message: "other workspace remains writable" });
  assert.match(localLogText(f.b), /other workspace remains writable/);
  assert.throws(() => f.db.writeWorkspaceLog(WORKSPACE_ID, { level: "error", tag: "scheduled-tasks", message: "blocked same workspace" }), error => {
    assert.equal((error as Error & { code: string }).code, "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED");
    assert.equal(((error as Error).cause as Error & { code: string }).code, "WORKSPACE_LOG_CLOSE_UNCONFIRMED"); return true;
  });
  assert.throws(() => f.db.close(), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.message, "CLIENT_DB_CLOSE_FAILED"); assert.equal(error.errors[0].cause, closeFailure); return true;
  });
  assert.equal(f.gate.hasActiveWrites(), true, "未确认 fd 不得擅自释放原 owner");
  const reopened = openClientDb({ dbPath: path.join(f.root, "application.db") });
  try { reopened.writeWorkspaceLog(WORKSPACE_ID, { level: "error", tag: "scheduled-tasks", message: "after confirmed resource cleanup" }); }
  finally { reopened.close(); }
  assert.match(localLogText(f.a), /after confirmed resource cleanup/);
});

for (const entry of ["resumeWorkspace", "resumeAfterUpdate", "timer"] as const) test(`LSLOG ${entry} 最终诊断失败先结算后 wait 保原两因且零孤儿拒绝`, async t => {
  const f = localLogFixture(t), diagnostic = new Error("PRIVATE_BACKGROUND_DIAGNOSTIC"), unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); }; process.on("unhandledRejection", listener); t.after(() => process.off("unhandledRejection", listener));
  f.db.withLocalScheduledTasks(WORKSPACE_ID, repos => repos.db.exec("ALTER TABLE scheduled_task_configs RENAME TO hidden_local_configs"));
  t.mock.method(logger, "error", () => { throw diagnostic; });
  if (entry === "timer") {
    let interval!: () => void; t.mock.method(globalThis, "setInterval", ((callback: () => void) => { interval = callback; return { unref() {} }; }) as typeof setInterval);
    t.mock.method(globalThis, "clearInterval", () => {}); f.scheduler.start(); interval();
  } else if (entry === "resumeWorkspace") f.scheduler.resumeWorkspace(WORKSPACE_ID, "local-log-resume");
  else f.scheduler.resumeAfterUpdate("local-log-resume");
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.scheduler.hasInFlightWork(), false);
  await assert.rejects(f.scheduler.waitForInFlightWork(), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], diagnostic); assert.equal(error.cause, error.errors[0]);
    assert.equal(error.errors[0].code, "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED"); return true;
  });
  await new Promise(setImmediate); assert.deepEqual(unhandled, []);
});

/** 账号延期断言固定在原 W 位置，保持原 scheduledAt 与跳过合同。 */
function accountRuntime(db: ClientDb) {
  return db.withAccountScheduledTasks(WORKSPACE_ID, repos => repos.runtime.getAccount("task-1", ACCOUNT_OWNER));
}

test("D18 已算 scheduledAt 跨最终 handoff 和后续 tick 保留，完成后只认领一次原触发",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scheduled-handoff-")),gate=new WorkspaceOperationGate();
  const db=openClientDb({dbPath:path.join(root,"client.db"),workspaceOperationGate:gate});db.workspaces.upsert({id:WORKSPACE_ID,title:"workspace",path:root});
  const ctx={db,clientId:CLIENT_ID,deviceId:DEVICE_ID,localWorkspaceOnly:true,workspaceOperationGate:gate,workspaces:new Map([[WORKSPACE_ID,root]])} as unknown as ApiHandlerContext;
  let now=1_800_000_005_000; t.mock.method(Date,"now",()=>now);
  const scheduler=new ScheduledTaskScheduler({config:{clientId:CLIENT_ID,serverWsUrl:"ws://127.0.0.1:1/ws"} as ClientConfig,deviceId:DEVICE_ID,apiContext:ctx,localApiContext:ctx});
  let http=0;t.mock.method(globalThis,"fetch",async()=>{http++;throw new Error("LOCAL_HTTP_FORBIDDEN");});
  try{
    db.withLocalScheduledTasks(WORKSPACE_ID,repos=>repos.configs.create({at:1,config:{id:"handoff-task",source:"local",clientId:CLIENT_ID,deviceId:DEVICE_ID,
      workspaceScope:{scopeType:"local_workspace",scopeId:WORKSPACE_ID},name:"handoff",description:null,taskType:"script",cronExpr:"* * * * *",timezone:"UTC",enabled:true,
      payload:{shell:process.platform==="win32"?"powershell":"sh",command:"exit 0",contextWorkspaceId:WORKSPACE_ID},concurrencyPolicy:"queue_one",missedPolicy:"skip_missed",timeoutMs:10_000}}));
    const release=await gate.acquireMigration(WORKSPACE_ID,"directory-owner"),handoff=await gate.beginFinalHandoff(WORKSPACE_ID,"directory-owner");
    const first=scheduler.syncAndTick("before-handoff");
    await new Promise(resolve=>setImmediate(resolve));
    const second=scheduler.syncAndTick("pending-tick");now+=60_000;
    assert.equal(db.listLocalScheduledTaskRuns({clientId:CLIENT_ID,deviceId:DEVICE_ID,offset:0,limit:50}).total,0);
    handoff.complete();release();await Promise.all([first,second]);await scheduler.waitForInFlightWork();
    const history=db.listLocalScheduledTaskRuns({clientId:CLIENT_ID,deviceId:DEVICE_ID,offset:0,limit:50}).items;
    assert.equal(history.filter(run=>run.scheduledAt===1_800_000_000_000).length,1);assert.equal(http,0);
  }finally{await scheduler.stopAndDrain();db.close();fs.rmSync(root,{recursive:true});}
});

for(const change of ["disable","delete","revise","pause","stop","owner","handoff-failure","resource-close"] as const)
test(`D18 等待最终交接期间 ${change} 后零非法派发`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scheduled-handoff-boundary-")),gate=new WorkspaceOperationGate();
  const db=openClientDb({dbPath:path.join(root,"application.db"),workspaceOperationGate:gate});db.workspaces.upsert({id:WORKSPACE_ID,title:"workspace",path:root});
  let paused=false;const ctx={db,clientId:CLIENT_ID,deviceId:DEVICE_ID,localWorkspaceOnly:true,workspaceOperationGate:gate,workspaces:new Map([[WORKSPACE_ID,root]]),isTaskAdmissionPaused:()=>paused} as unknown as ApiHandlerContext;
  const scheduler=new ScheduledTaskScheduler({config:{clientId:CLIENT_ID,serverWsUrl:"ws://127.0.0.1:1/ws"} as ClientConfig,deviceId:DEVICE_ID,apiContext:ctx,localApiContext:ctx,isTaskAdmissionPaused:()=>paused});
  t.mock.method(Date,"now",()=>1_800_000_005_000);let release:()=>void=()=>{},releaseNext:()=>void=()=>{},failure:unknown;
  try{
    db.withLocalScheduledTasks(WORKSPACE_ID,repos=>repos.configs.create({at:1,config:{id:"waiting",source:"local",clientId:CLIENT_ID,deviceId:DEVICE_ID,workspaceScope:{scopeType:"local_workspace",scopeId:WORKSPACE_ID},
      name:"waiting",description:null,taskType:"script",cronExpr:"* * * * *",timezone:"UTC",enabled:true,payload:{shell:process.platform==="win32"?"powershell":"sh",command:"exit 0",contextWorkspaceId:WORKSPACE_ID},
      concurrencyPolicy:"queue_one",missedPolicy:"skip_missed",timeoutMs:1000}}));
    release=await gate.acquireMigration(WORKSPACE_ID,"old-owner");const handoff=await gate.beginFinalHandoff(WORKSPACE_ID,"old-owner");
    const tick=scheduler.syncAndTick("waiting-boundary");const settled=tick.then(()=>undefined,error=>{failure=error;});
    await new Promise(resolve=>setImmediate(resolve));
    if(change==="disable"||change==="delete"||change==="revise"){
      const physical=openSqliteDb(path.join(root,".codeflowai","workspace.db"),{fileMustExist:true});
      try{
        const repo=new ScheduledTaskConfigRepo(physical,new ScheduledTaskRuntimeStateRepo(physical,WORKSPACE_ID),WORKSPACE_ID);
        if(change==="disable")repo.setEnabled({taskId:"waiting",expectedRevision:1,enabled:false,at:2});
        else if(change==="delete")repo.delete({taskId:"waiting",expectedRevision:1,at:2});
        else repo.update({config:{...repo.get("waiting")!,name:"revised"},expectedRevision:1,at:2});
      }finally{physical.close();}
    }else if(change==="pause")paused=true;
    else if(change==="stop")scheduler.stop();
    else if(change==="owner"){handoff.complete();release();releaseNext=gate.restoreMigration(WORKSPACE_ID,"next-owner");}
    else {handoff.fail(new Error(change==="resource-close"?"WORKSPACE_DB_HANDOFF_RESOURCES_OPEN":"CONTROLLED_HANDOFF_FAILED"));}
    if(!["owner","handoff-failure","resource-close"].includes(change)){handoff.complete();release();}
    await settled;
    if(change==="owner") await scheduler.waitForInFlightWork();
    else await assert.rejects(scheduler.waitForInFlightWork(), error => error === failure);
    assert.equal(db.listLocalScheduledTaskRuns({clientId:CLIENT_ID,deviceId:DEVICE_ID,offset:0,limit:50}).total,0);
    const current=db.getLocalScheduledTask("waiting")!;
    if(change==="owner")assert.equal(db.getLocalScheduledTaskRuntime(current)?.queuedOperationId,"next-owner");
    else {assert.ok(failure,"等待后的拒绝不能伪装成功");assert.equal(db.getLocalScheduledTaskRuntime(current),null);}
  }finally{releaseNext();release();await scheduler.stopAndDrain();db.close();fs.rmSync(root,{recursive:true});}
});

test("Server 延期扫描不读取本机 operation，也不把同 ID 本机项按删除收敛", async () => {
  await withSchedulerFixture([], async ({ db, scheduler, reports }) => {
    const key = scheduledTaskRuntimeKey("task-1", "local");
    db.scheduledTaskRuntimeStates.queueForWorkspaceMigration({ taskId: key, clientId: CLIENT_ID, deviceId: DEVICE_ID,
      scheduledAt: 3_000, operationId: "local-operation-not-in-server-scan", at: 3 });
    await scheduler.sync("server-only");
    assert.equal(db.scheduledTaskRuntimeStates.get(key)?.queuedOperationId, "local-operation-not-in-server-scan");
    assert.equal(db.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, 3_000);
    assert.equal(reports.some(report => report.run?.scheduledAt === 3_000), false);
    assert.equal(db.scheduledTaskRuntimeStates.listMigrationQueued().length, 0);
  });
});

test("更新暂停期间不创建计划，解除后复用原调度器", async () => {
  let paused = false;
  await withSchedulerFixture([], async ({ db, root }) => {
    let projectTicks = 0;
    const scheduler = createTestScheduler(db, root, () => paused, async () => { projectTicks++; });
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (...args) => { requests++; return await originalFetch(...args); };
    try {
      scheduler.start();
      paused = true;
      await scheduler.syncAndTick("update-paused");
      assert.equal(requests, 0);
      assert.equal(projectTicks, 0);
      await assert.rejects(scheduler.runNow("task-1"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
      assert.throws(() => scheduler.assertProjectTasksAccepting(), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
      assert.equal(requests, 0);
      paused = false;
      await scheduler.syncAndTick("update-resumed");
      assert.equal(projectTicks, 1);
      assert.ok(requests > 0);
      assert.doesNotThrow(() => scheduler.assertProjectTasksAccepting());
    } finally { globalThis.fetch = originalFetch; await scheduler.stopAndDrain(); }
  });
});

test("更新稍后立即唤醒原调度但不等待项目扫描，后台owner仍可排空", async () => {
  await withSchedulerFixture([], async ({ db, root }) => {
    let release!: () => void, started = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const scheduler = createTestScheduler(db, root, () => false, async () => { started = true; await pending; });
    try {
      assert.equal(scheduler.resumeAfterUpdate("update-resume-test"), undefined);
      await waitFor(() => started);
      assert.equal(scheduler.hasInFlightWork(), true);
    } finally { release(); await scheduler.stopAndDrain(); }
    assert.equal(scheduler.hasInFlightWork(), false);
  });
});

test("稍后恢复的后台扫描失败保留到明确排空边界，不能只日志后遗忘", async t => {
  await withSchedulerFixture([], async ({ db, root }) => {
    const cause = new Error("UPDATE_RESUME_PROJECT_SCAN_FAILED");
    const logged = t.mock.method(logger, "error", () => {});
    const scheduler = createTestScheduler(db, root, () => false, async () => { throw cause; });
    scheduler.resumeAfterUpdate("resume-failure-request");
    await waitFor(() => logged.mock.calls.some(call => (call.arguments[2] as { code?: string } | undefined)?.code === "SCHEDULED_TASK_UPDATE_RESUME_FAILED"));
    assert.equal(scheduler.hasInFlightWork(), false, "a settled failure is not a running session");
    await assert.rejects(scheduler.stopAndDrain(), error => error === cause || error instanceof AggregateError && error.errors.includes(cause));
  });
});

test("手动计划同步期间更新暂停，不认领新运行", async () => {
  let paused = false;
  await withSchedulerFixture([createTask()], async ({ db, root, reports }) => {
    const scheduler = createTestScheduler(db, root, () => paused);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { const result = await originalFetch(...args); paused = true; return result; };
    try {
      await assert.rejects(scheduler.runNow("task-1"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
      assert.equal(accountRuntime(db)?.runningRunId, null);
      assert.equal(reports.some(body => body.run?.status === "running"), false);
    } finally { globalThis.fetch = originalFetch; await scheduler.stopAndDrain(); }
  });
});

test("更新暂停不打断已认领运行及其终态上报", async () => {
  let paused = false;
  await withSchedulerFixture([createTask()], async ({ db, root, reports }) => {
    const scheduler = createTestScheduler(db, root, () => paused);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ScheduledTaskApiReport;
      if (body.run?.status === "running") paused = true;
      return await originalFetch(input, init);
    };
    try {
      const run = await scheduler.runNow("task-1");
      assert.equal(run.status, "success");
      assert.equal(reports.filter(body => body.run?.status === "running").length, 1);
      assert.equal(reports.filter(body => body.run?.status === "success").length, 1);
      assert.equal(accountRuntime(db)?.runningRunId, null);
      await assert.rejects(scheduler.runNow("task-1"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
    } finally { globalThis.fetch = originalFetch; await scheduler.stopAndDrain(); }
  });
});

test("自动同步期间暂停保留延期，恢复后才认领执行", async () => {
  let paused = false;
  await withSchedulerFixture([createTask()], async ({ db, root, reports }) => {
    const scheduler = createTestScheduler(db, root, () => paused);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { const result = await originalFetch(...args); paused = true; return result; };
    try {
      await scheduler.syncAndTick("pause-during-sync");
      assert.equal(accountRuntime(db)?.queuedScheduledAt, 2_000);
      assert.equal(accountRuntime(db)?.runningRunId, null);
      assert.equal(reports.some(body => body.run), false);
      globalThis.fetch = originalFetch;
      paused = false;
      await scheduler.syncAndTick("resume-after-sync");
      await scheduler.waitForInFlightWork();
      assert.equal(reports.some(body => body.run?.status === "success"), true);
      assert.equal(accountRuntime(db)?.queuedScheduledAt, null);
      assert.equal(reports.filter(body => body.run?.scheduledAt === 2_000 && body.run.status === "success").length, 1);
    } finally { globalThis.fetch = originalFetch; await scheduler.stopAndDrain(); }
  });
});

test("任务暂停时跳过新调度，恢复后无需重建 Scheduler 或 Client", async () => {
  let paused = false;
  await withSchedulerFixture([], async ({ scheduler }) => {
    scheduler.start();
    await scheduler.syncAndTick("tasks-active");
    paused = true;
    const fetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("任务暂停时不应发起调度同步"); };
    try { await scheduler.syncAndTick("tasks-paused"); }
    finally { globalThis.fetch = fetch; }
    paused = false;
    assert.doesNotThrow(() => scheduler.start());
    await scheduler.syncAndTick("tasks-resumed");
  }, () => paused);
});

test("queue_one 迁移延期持久化最早触发，并在认领时原子写 running", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-scheduled-migration-"));
  const db = openSqliteDb(path.join(root, "client.db"));
  try {
    migrateClientDb(db);
    const repo = new ScheduledTaskRuntimeStateRepo(db);
    repo.queueForWorkspaceMigration({
      taskId: "task-1",
      clientId: "client-1",
      deviceId: "device-1",
      scheduledAt: 2_000,
      operationId: "operation-1",
      at: 10,
    });
    repo.queueForWorkspaceMigration({
      taskId: "task-1",
      clientId: "client-1",
      deviceId: "device-1",
      scheduledAt: 3_000,
      operationId: "operation-1",
      at: 11,
    });
    assert.equal(repo.get("task-1")?.queuedScheduledAt, 2_000);
    assert.equal(repo.listMigrationQueued().length, 1);

    repo.markMigrationQueuedStarted({
      taskId: "task-1",
      clientId: "client-1",
      deviceId: "device-1",
      scheduledAt: 2_000,
      operationId: "operation-1",
      runId: "run-1",
      startedAt: 20,
    });
    const running = repo.get("task-1");
    assert.equal(running?.lastScheduledAt, 2_000);
    assert.equal(running?.runningRunId, "run-1");
    assert.equal(running?.queuedScheduledAt, null);
    assert.equal(running?.queuedOperationId, null);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("queue_one 迁移延期先持久化 skipped 决策再清除 owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-scheduled-migration-skip-"));
  const db = openSqliteDb(path.join(root, "client.db"));
  try {
    migrateClientDb(db);
    const repo = new ScheduledTaskRuntimeStateRepo(db);
    repo.queueForWorkspaceMigration({
      taskId: "task-1",
      clientId: CLIENT_ID,
      deviceId: DEVICE_ID,
      scheduledAt: 2_000,
      operationId: "operation-1",
      at: 10,
    });

    repo.markMigrationQueuedSkipPending({
      taskId: "task-1",
      clientId: CLIENT_ID,
      deviceId: DEVICE_ID,
      scheduledAt: 2_000,
      operationId: "operation-1",
      skipReason: "task_disabled",
      at: 20,
    });

    const pending = repo.get("task-1");
    assert.equal(pending?.lastScheduledAt, 2_000);
    assert.equal(pending?.queuedScheduledAt, 2_000);
    assert.equal(pending?.queuedReason, "workspace_migration_skip_pending:task_disabled");

    repo.completeMigrationQueuedSkip({
      taskId: "task-1",
      scheduledAt: 2_000,
      operationId: "operation-1",
      skipReason: "task_disabled",
      at: 21,
    });

    const skipped = repo.get("task-1");
    assert.equal(skipped?.lastScheduledAt, 2_000);
    assert.equal(skipped?.queuedScheduledAt, null);
    assert.equal(skipped?.queuedOperationId, null);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("queue_one 迁移延期期间任务删除后清除延期并保留本地 skipped 去重状态", async () => {
  await withSchedulerFixture([], async ({ db, scheduler, reports }) => {
    await scheduler.sync("test_deleted");

    const runtime = accountRuntime(db);
    assert.equal(runtime?.lastScheduledAt, 2_000);
    assert.equal(runtime?.queuedScheduledAt, null);
    assert.equal(reports.some((body) => body.run != null), false);
  });
});

test("queue_one 迁移延期期间任务禁用后上报 skipped 并清除延期", async () => {
  await withSchedulerFixture([createTask({ enabled: false })], async ({ db, scheduler, reports }) => {
    await scheduler.sync("test_disabled");

    const run = reports.find((body) => body.run)?.run as ScheduledTaskRun | undefined;
    assert.equal(run?.status, "skipped");
    assert.equal(run?.workspaceId, WORKSPACE_ID);
    assert.match(String(run?.summary), /任务已禁用/);
    assert.equal(accountRuntime(db)?.queuedScheduledAt, null);
  });
});

test("queue_one 迁移延期期间任务改到其他工作区后按原工作区上报 skipped", async () => {
  const moved = createTask({ workspaceId: OTHER_WORKSPACE_ID });
  await withSchedulerFixture([moved], async ({ db, scheduler, reports }) => {
    await scheduler.sync("test_workspace_changed");

    const run = reports.find((body) => body.run)?.run as ScheduledTaskRun | undefined;
    assert.equal(run?.status, "skipped");
    assert.equal(run?.workspaceId, WORKSPACE_ID);
    assert.match(String(run?.summary), /其他工作区/);
    assert.equal(accountRuntime(db)?.queuedScheduledAt, null);
  });
});

test("迁移延期 skipped 本地收敛失败整体回滚且零HTTP，恢复保存后补报", async () => {
  await withSchedulerFixture([createTask({ enabled: false })], async ({ db, scheduler, reports }) => {
    db.withAccountScheduledTasks(WORKSPACE_ID, repos => repos.db.exec("CREATE TRIGGER fail_complete BEFORE UPDATE OF queued_scheduled_at ON scheduled_task_runtime_states WHEN NEW.queued_scheduled_at IS NULL BEGIN SELECT RAISE(ABORT,'injected local convergence failure'); END"));

    await assert.rejects(scheduler.sync("test_retry_first"), error => JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("injected local convergence failure"));
    assert.equal(accountRuntime(db)?.queuedScheduledAt, 2_000);
    assert.equal(accountRuntime(db)?.queuedReason, "workspace_migration");
    assert.equal(reports.filter(body => body.run).length, 0);
    assert.equal(db.listPendingAccountScheduledTaskRuns(ACCOUNT_OWNER).length, 0);
    db.withAccountScheduledTasks(WORKSPACE_ID, repos => repos.db.exec("DROP TRIGGER fail_complete"));

    await scheduler.sync("test_retry_second");

    const runs = reports.flatMap((body) => body.run ? [body.run] : []);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "skipped");
    assert.equal(accountRuntime(db)?.queuedScheduledAt, null);
  });
});

test("迁移延期 skipped 决策在 Client 重启和配置恢复后不会反转执行", async () => {
  const tasks = [createTask({ enabled: false })];
  await withSchedulerFixture(tasks, async ({ db, scheduler, reports, root }) => {
    const successfulFetch = globalThis.fetch;
    let failSkipReport = true;
    globalThis.fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as ScheduledTaskApiReport;
      if (pathname === "/api/client/scheduled-tasks/report" && body.run && failSkipReport) {
        failSkipReport = false;
        return jsonResponse({ ok: false, message: "injected skip report failure" }, 500);
      }
      return await successfulFetch(input, init);
    };

    await assert.rejects(scheduler.sync("test_report_failure"), { code: "SCHEDULED_TASK_API_FAILED", httpStatus: 500 });
    assert.equal(accountRuntime(db)?.queuedReason, null);
    assert.equal(db.listPendingAccountScheduledTaskRuns(ACCOUNT_OWNER)[0]?.run.status, "skipped");

    scheduler.stop();
    db.close();
    tasks[0] = createTask({ enabled: true });
    globalThis.fetch = successfulFetch;
    const restartedDb = openClientDb({ dbPath: path.join(root, "client.db") });
    const restartedScheduler = createTestScheduler(restartedDb, root);
    try {
      await restartedScheduler.sync("test_report_retry_after_restart");

      const runs = reports.flatMap((body) => body.run ? [body.run] : []);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "skipped");
      assert.match(String(runs[0]?.summary), /任务已禁用/);
      assert.equal(accountRuntime(restartedDb)?.queuedScheduledAt, null);
    } finally {
      restartedScheduler.stop();
      restartedDb.close();
    }
  });
});

test("queue_one 迁移延期期间同工作区配置更新后按最新配置补跑一次", async () => {
  const updated = createTask({ name: "updated task", command: "echo updated" });
  await withSchedulerFixture([updated], async ({ db, scheduler }) => {
    const resumed: Array<{ task: ScheduledTask; scheduledAt: number }> = [];
    const mutableScheduler = scheduler as unknown as {
      state: { tasks: Map<string, ScheduledTask>; tickPending: boolean; tickRunning: boolean };
      tick: () => Promise<void>;
      runScriptTask: (
        task: ScheduledTask,
        runId: string,
        scheduledAt: number,
        startedAt: number,
        triggerSource: ScheduledTaskRun["triggerSource"],
      ) => Promise<ScheduledTaskRun>;
    };
    mutableScheduler.runScriptTask = async (task, runId, scheduledAt, startedAt, triggerSource) => {
      resumed.push({ task, scheduledAt });
      return buildSuccessfulRun(task, runId, scheduledAt, startedAt, triggerSource);
    };

    mutableScheduler.state.tasks = new Map([["task-1", createTask({ command: "echo stale" })]]);
    mutableScheduler.state.tickRunning = true;
    const concurrentSync = scheduler.sync("test_concurrent_sync");
    assert.equal(mutableScheduler.state.tickPending, true);
    await mutableScheduler.tick();
    assert.equal(resumed.length, 0);
    await concurrentSync;

    mutableScheduler.state.tickRunning = false;
    mutableScheduler.state.tickPending = false;
    await scheduler.syncAndTick("test_latest_config");
    await waitFor(() => resumed.length === 1 && accountRuntime(db)?.runningRunId == null);

    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]?.scheduledAt, 2_000);
    assert.equal(resumed[0]?.task.name, "updated task");
    assert.equal((resumed[0]?.task.payload as { command?: string }).command, "echo updated");
    assert.equal(accountRuntime(db)?.queuedScheduledAt, null);

    await scheduler.sync("test_latest_config_not_requeued");
    assert.equal(resumed.length, 1);
  });
});

test("stopAndDrain 等待 tick 脱离的迁移补跑完成后再返回", async () => {
  await withSchedulerFixture([createTask()], async ({ scheduler }) => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const mutableScheduler = scheduler as unknown as {
      runScriptTask: (
        task: ScheduledTask,
        runId: string,
        scheduledAt: number,
        startedAt: number,
        triggerSource: ScheduledTaskRun["triggerSource"],
      ) => Promise<ScheduledTaskRun>;
    };
    mutableScheduler.runScriptTask = async (task, runId, scheduledAt, startedAt, triggerSource) => {
      started.resolve();
      await release.promise;
      return buildSuccessfulRun(task, runId, scheduledAt, startedAt, triggerSource);
    };

    const tickOwner = scheduler.syncAndTick("test_shutdown_drain");
    await started.promise;
    await tickOwner;

    let drainSettled = false;
    const drain = scheduler.stopAndDrain();
    void drain.then(
      () => { drainSettled = true; },
      () => { drainSettled = true; },
    );
    await Promise.resolve();
    assert.equal(drainSettled, false);

    release.resolve();
    await drain;
    assert.equal(drainSettled, true);
    await assert.rejects(scheduler.sync("after_stop"), /调度器正在停止/);
    await assert.rejects(scheduler.syncAndTick("after_stop"), /调度器正在停止/);
    await assert.rejects(scheduler.runNow("task-1"), /调度器正在停止/);
    assert.throws(() => scheduler.start(), /调度器正在停止/);
  });
});

test("stopAndDrain 显式汇总 tick 脱离任务失败", async () => {
  await withSchedulerFixture([createTask()], async ({ scheduler }) => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const mutableScheduler = scheduler as unknown as {
      runMigrationQueuedTask: () => Promise<ScheduledTaskRun>;
    };
    mutableScheduler.runMigrationQueuedTask = async () => {
      started.resolve();
      await release.promise;
      throw new Error("injected detached task failure");
    };

    const tickOwner = scheduler.syncAndTick("test_shutdown_failure");
    await started.promise;
    await tickOwner;
    const drain = scheduler.stopAndDrain();
    release.resolve();

    await assert.rejects(drain, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(String(error.errors[0]), /injected detached task failure/);
      return true;
    });
  });
});

type ScheduledTaskApiReport = {
  nextRuns?: unknown;
  run?: ScheduledTaskRun | null;
};

test("更新活动查询覆盖无工作区脚本及其异步运行收口", async () => {
  const task = createTask();
  (task.payload as { contextWorkspaceId: WorkspaceId | null }).contextWorkspaceId = null;
  await withSchedulerFixture([task], async ({ scheduler, reports }) => {
    assert.equal(scheduler.hasInFlightWork(), false);
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ScheduledTaskApiReport;
      if (body.run?.status === "running") { started(); await gate; }
      return await originalFetch(input, init);
    };
    const pending = scheduler.runNow(task.id);
    try {
      await running;
      assert.equal(scheduler.hasInFlightWork(), true);
      assert.deepEqual(scheduler.listRunningByWorkspace(WORKSPACE_ID), []);
    } finally { release(); globalThis.fetch = originalFetch; }
    await pending;
    assert.equal(scheduler.hasInFlightWork(), false);
    assert.equal(reports.filter(report => report.run?.status === "running").length, 1);
  });
});

test("更新活动查询等待同步失败收口且不吞错误", async () => {
  await withSchedulerFixture([], async ({ scheduler }) => {
    const originalFetch = globalThis.fetch;
    let rejectSync!: (error: Error) => void;
    globalThis.fetch = async () => await new Promise<Response>((_resolve, reject) => { rejectSync = reject; });
    const pending = scheduler.syncAndTick("update-activity-failure");
    try {
      await waitFor(() => typeof rejectSync === "function");
      assert.equal(scheduler.hasInFlightWork(), true);
      const rejection = assert.rejects(pending, { code: "SCHEDULED_TASK_API_FAILED", reason: "transport_failed" });
      rejectSync(new Error("sync-failed"));
      await rejection;
      assert.equal(scheduler.hasInFlightWork(), false);
    } finally { globalThis.fetch = originalFetch; }
  });
});

/** 创建带持久迁移延期的 Scheduler，并隔离全局 fetch。 */
async function withSchedulerFixture(
  tasks: ScheduledTask[],
  run: (fixture: {
    db: ClientDb;
    scheduler: ScheduledTaskScheduler;
    reports: ScheduledTaskApiReport[];
    root: string;
  }) => Promise<void>,
  isTaskAdmissionPaused?: () => boolean,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-scheduled-config-"));
  fs.mkdirSync(path.join(root, "source"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  db.workspaces.upsert({
    id: WORKSPACE_ID,
    title: "workspace",
    path: path.join(root, "source"),
  });
  const operation = db.workspaceDirectoryMigrations.create({
    operationId: "operation-1",
    idempotencyKey: "idem-operation-1",
    workspaceId: WORKSPACE_ID,
    sourcePath: path.join(root, "source"),
    targetParentPath: path.join(root, "target-parent"),
    targetPath: path.join(root, "target-parent", "source"),
    now: 1,
  }).operation;
  db.withAccountScheduledTasks(WORKSPACE_ID, repos => repos.runtime.queueForWorkspaceMigration({
    taskId: scheduledTaskAccountRuntimeKey("task-1", ACCOUNT_OWNER),
    clientId: CLIENT_ID,
    deviceId: DEVICE_ID,
    scheduledAt: 2_000,
    operationId: operation.operationId,
    at: 2,
  }));
  const reports: ScheduledTaskApiReport[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/client/scheduled-tasks/sync") {
      return jsonResponse({ ok: true, tasks, serverNow: Date.now() });
    }
    if (pathname === "/api/client/scheduled-tasks/report") {
      reports.push(JSON.parse(String(init?.body ?? "{}")) as ScheduledTaskApiReport);
      return jsonResponse({ ok: true, serverNow: Date.now() });
    }
    return jsonResponse({ ok: false, message: "not found" }, 404);
  };
  const scheduler = createTestScheduler(db, root, isTaskAdmissionPaused);
  try {
    await run({ db, scheduler, reports, root });
  } finally {
    globalThis.fetch = originalFetch;
    scheduler.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 用指定 Client DB 创建不实际占用工作区写锁的测试 Scheduler。 */
function createTestScheduler(db: ClientDb, root: string, isTaskAdmissionPaused?: () => boolean, tickProjectTasks?: () => Promise<void>): ScheduledTaskScheduler {
  return new ScheduledTaskScheduler({
    captureAccountContext: () => ({ serverOrigin: "http://127.0.0.1:39280", ownerUserId: "user-1", clientId: CLIENT_ID, deviceId: DEVICE_ID, generation: 1, assertCurrent() {} }),
    config: {
      serverWsUrl: "ws://127.0.0.1:39280/ws/client",
      apiKey: "test-key",
      clientId: CLIENT_ID,
    } as ClientConfig,
    deviceId: DEVICE_ID,
    isTaskAdmissionPaused,
    tickProjectTasks,
    apiContext: {
      db,
      workspaces: new Map([[WORKSPACE_ID, path.join(root, "source")]]),
      workspaceOperationGate: {
        getMigrationOperationId: () => null,
        beginWrite: () => () => {},
      },
    } as unknown as ApiHandlerContext,
  });
}

/** 构造服务端同步返回的脚本定时任务。 */
function createTask(input: {
  enabled?: boolean;
  workspaceId?: WorkspaceId;
  name?: string;
  command?: string;
} = {}): ScheduledTask {
  return {
    id: "task-1",
    ownerUserId: "user-1",
    clientId: CLIENT_ID,
    deviceId: DEVICE_ID,
    clientNameSnapshot: "client",
    deviceLabelSnapshot: null,
    name: input.name ?? "task",
    description: null,
    taskType: "script",
    cronExpr: "* * * * *",
    timezone: "UTC",
    enabled: input.enabled ?? true,
    payload: {
      shell: "powershell",
      command: input.command ?? "echo test",
      contextWorkspaceId: input.workspaceId ?? WORKSPACE_ID,
      cwdRelative: ".",
      envRefs: [],
    },
    concurrencyPolicy: "queue_one",
    missedPolicy: "skip_missed",
    timeoutMs: 60_000,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastSyncAt: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

/** 构造脚本执行桩的成功结果，保留 Scheduler 的认领和上报路径。 */
function buildSuccessfulRun(
  task: ScheduledTask,
  runId: string,
  scheduledAt: number,
  startedAt: number,
  triggerSource: ScheduledTaskRun["triggerSource"],
): ScheduledTaskRun {
  const finishedAt = startedAt + 1;
  return {
    id: runId,
    taskId: task.id,
    clientId: task.clientId,
    deviceId: task.deviceId,
    workspaceId: WORKSPACE_ID,
    workflowInstanceId: null,
    workflowNameSnapshot: null,
    workflowVersion: null,
    scheduledAt,
    startedAt,
    finishedAt,
    status: "success",
    triggerSource,
    attempt: 1,
    durationMs: 1,
    summary: "test success",
    errorMessage: null,
    outputExcerpt: null,
    createdAt: startedAt,
  };
}

/** 创建可由测试精确释放的 Promise 门。 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** 等待异步 dispatch 完成本地终态收敛。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待异步定时任务收敛超时：${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 构造 Scheduler postJson 可识别的 JSON 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
