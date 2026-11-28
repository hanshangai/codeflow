import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import type { ScheduledTask, ScheduledTaskRun, ClientScheduledTaskReportRequestBody, OrchestrationAssetRuntimeSnapshot, WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ScheduledTaskScheduler, toErrorLog } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { handleScheduledTaskRunNow } from "../src/app/handlers/scheduledTaskHandlers.js";
import { logger } from "../src/logger.js";
import { scheduledTaskAccountRuntimeKey } from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";
import { resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";

type LegacyDatabaseGuard = NonNullable<ConstructorParameters<typeof ScheduledTaskScheduler>[0]["withLegacyDatabase"]>;

const CLIENT = "durable-client", DEVICE = "durable-device", USER = "durable-user", TASK = "durable-task";
const ORIGIN = "http://127.0.0.1:1";
const OWNER = { serverOrigin: ORIGIN, ownerUserId: USER, clientId: CLIENT, deviceId: DEVICE };

/** 无工作区脚本只在本例重定向的用户目录写入运行证据。 */
function task(command?: string): ScheduledTask {
  return { id: TASK, ownerUserId: USER, clientId: CLIENT, deviceId: DEVICE, clientNameSnapshot: "durable client",
    deviceLabelSnapshot: null, name: "耐久补报", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "powershell" : "sh", contextWorkspaceId: null, cwdRelative: ".", envRefs: [],
      command: command ?? (process.platform === "win32" ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'executed'), 'ok')" : "printf ok > executed") },
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 10_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
}

/** 使用真实 SQLite、脚本和流程实例；传输与资产输入受控，每例排空后释放。 */
async function fixture(t: TestContext, action: (f: { root: string; file: string; db: ReturnType<typeof openClientDb>;
  scheduler: ScheduledTaskScheduler; apiContext: ApiHandlerContext; reports: ClientScheduledTaskReportRequestBody[]; remote: { terminalFails: boolean; runningFails: boolean;
    tasks: ScheduledTask[]; ack?: unknown; syncCalls: number; onSync?: () => Promise<void>; onReport?: (body: ClientScheduledTaskReportRequestBody) => Promise<void> };
  identity: { user: string; generation: number; current: boolean }; createScheduler(db?: ReturnType<typeof openClientDb>, withLegacyDatabase?: LegacyDatabaseGuard): ScheduledTaskScheduler;
}) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-durable-")), file = path.join(root, "client.db");
  const schedulers: ScheduledTaskScheduler[] = [];
  let closingDb: ReturnType<typeof openClientDb> | null = null, primary: { error: unknown } | null = null;
  try {
  t.mock.method(os, "homedir", () => root);
  const gate = new WorkspaceOperationGate(), db = openClientDb({ dbPath: file, workspaceOperationGate: gate });
  closingDb = db;
  const apiContext = { db, workspaces: new Map(), workspaceOperationGate: gate } as unknown as ApiHandlerContext;
  const reports: ClientScheduledTaskReportRequestBody[] = [], remote = { terminalFails: true, runningFails: false, tasks: [task()], syncCalls: 0 } as { terminalFails: boolean; runningFails: boolean;
    tasks: ScheduledTask[]; ack?: unknown; syncCalls: number; onSync?: () => Promise<void>; onReport?: (body: ClientScheduledTaskReportRequestBody) => Promise<void> };
  const identity = { user: USER, generation: 1, current: true };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(url.origin, ORIGIN);
    if (url.pathname.endsWith("/sync")) { remote.syncCalls++; await remote.onSync?.(); return Response.json({ ok: true, tasks: remote.tasks, serverNow: Date.now() }); }
    const body = JSON.parse(String(init?.body)) as ClientScheduledTaskReportRequestBody; reports.push(body);
    await remote.onReport?.(body);
    if (body.run && (body.run.status === "running" ? remote.runningFails : remote.terminalFails)) throw new Error("controlled lost response");
    return Response.json(body.run && body.run.status !== "running" ? remote.ack ?? { ok: true, serverNow: Date.now() } : { ok: true, serverNow: Date.now() });
  });
  /** 重启只换连接和调度实例，复用既有暂停入口及持久事实。 */
  const createScheduler = (target = db, withLegacyDatabase?: LegacyDatabaseGuard): ScheduledTaskScheduler => {
    const scheduler = new ScheduledTaskScheduler({ config: { clientId: CLIENT, apiKey: "fixture-key", serverWsUrl: ORIGIN.replace("http:", "ws:") + "/ws" } as ClientConfig,
      deviceId: DEVICE, apiContext: target === db ? apiContext : { ...apiContext, db: target },
      withLegacyDatabase,
      isTaskAdmissionPaused: () => apiContext.isTaskAdmissionPaused?.() === true,
      captureAccountContext: () => { const generation = identity.generation, user = identity.user;
        const assertCurrent = () => { if (!identity.current || identity.generation !== generation || identity.user !== user) throw Object.assign(new Error("controlled stale owner"), { code: "SCHEDULED_TASK_ACCOUNT_STALE" }); };
        assertCurrent(); return { ...OWNER, ownerUserId: user, generation, assertCurrent }; },
    }); schedulers.push(scheduler); return scheduler;
  };
  const scheduler = createScheduler();
  await action({ root, file, db, scheduler, apiContext, reports, remote, identity, createScheduler }); }
  catch (error) { primary = { error }; }
  finally {
    const failures: unknown[] = primary ? [primary.error] : [];
    for (const item of schedulers) try { await item.stopAndDrain(); } catch (error) { failures.push(error); }
    try { closingDb?.close(); } catch (error) { failures.push(error); }
    t.mock.restoreAll();
    try { fs.rmSync(root, { recursive: true }); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "durable fixture and cleanup failed");
  }
}

test("账号任务在真实 Writer 许可下同步认领结算，HTTP 上报不持许可", async t => fixture(t, async f => {
  const workspace = useWorkspace(f);
  f.remote.terminalFails = false;
  const writer = new ClientDbWriterService({ dbPath: f.file, db: f.db, onFatalError() {} });
  await writer.ready();
  const scheduler = f.createScheduler(f.db, (requestId, operation) => writer.withLegacyDatabase(requestId, operation));
  f.remote.onReport = async body => {
    assert.throws(() => f.db.workspaces.list(), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    if (body.run?.status === "success") {
      const saved = await writer.withLegacyDatabase("verify-before-account-ack", () => f.db.getAccountScheduledTaskRun(body.run!.id, OWNER));
      assert.equal(saved?.workspaceId, workspace.id);
      assert.equal(saved?.run.status, "success");
    }
  };
  try {
    const run = await scheduler.runNow(TASK);
    assert.equal(run.status, "success");
    const saved = await writer.withLegacyDatabase("verify-account-settlement", () => f.db.getAccountScheduledTaskRun(run.id, OWNER));
    assert.equal(saved?.run.reportSettlement, "acknowledged");
  } finally { try { await scheduler.stopAndDrain(); } finally { await writer.close(); } }
}));

test("账号在等待 Writer 许可时撤销，旧 HTTP 成功不能提交结算 ACK", async t => fixture(t, async f => {
  useWorkspace(f);
  f.remote.terminalFails = false;
  const writer = new ClientDbWriterService({ dbPath: f.file, db: f.db, onFatalError() {} });
  await writer.ready();
  let revokeAtDatabase = false;
  f.remote.onReport = async body => { if (body.run?.status === "success") revokeAtDatabase = true; };
  const scheduler = f.createScheduler(f.db, (requestId, operation) => {
    if (revokeAtDatabase) { revokeAtDatabase = false; f.identity.current = false; }
    return writer.withLegacyDatabase(requestId, operation);
  });
  try {
    await assert.rejects(scheduler.runNow(TASK));
    const terminal = f.reports.find(body => body.run?.status === "success")!.run!;
    const saved = await writer.withLegacyDatabase("verify-revoked-ack", () => f.db.getAccountScheduledTaskRun(terminal.id, OWNER));
    assert.equal(saved?.run.reportSettlement, null);
  } finally { try { await scheduler.stopAndDrain(); } finally { await writer.close(); } }
}));

test("D08 工作区脚本终态丢响应后关闭重开仍保存原成功结果", async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:durable-w` as WorkspaceId, directory = path.join(f.root, "durable-w");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "durable", path: directory });
  f.apiContext.workspaces.set(workspaceId, directory);
  f.remote.tasks = [{ ...task(), payload: { ...task().payload, contextWorkspaceId: workspaceId } }];
  await assert.rejects(f.scheduler.runNow(TASK));
  const terminal = f.reports.find(body => body.run?.status === "success")!.run!;
  assert.equal(fs.readFileSync(path.join(directory, "executed"), "utf8"), "ok");
  const physical = openSqliteDb(path.join(directory, ".codeflowai", "workspace.db"), { readonly: true, fileMustExist: true });
  try {
    assert.equal((physical.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE id=? AND status='success'").get(terminal.id) as { n: number }).n, 1,
      "真实工作区必须在终态 HTTP 之前耐久保存成功历史");
  } finally { physical.close(); }
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs").get() as { n: number }).n, 0);
  await f.scheduler.stopAndDrain(); f.db.close();
  const reopened = openClientDb({ dbPath: f.file });
  try {
    f.remote.terminalFails = false; const scheduler = f.createScheduler(reopened);
    await scheduler.sync("workspace-restart");
    const saved = reopened.withAccountScheduledTasks(workspaceId, repos => repos.runs.getAccount(terminal.id, OWNER));
    assert.equal(saved?.reportSettlement, "acknowledged");
    assert.deepEqual(f.reports.filter(body => body.run?.status === "success").map(body => body.run), [terminal, terminal]);
    await scheduler.stopAndDrain();
  } finally { reopened.close(); }
}));

/** 为工作区定向故障用例注册真实物理根并保留原公开Scheduler入口。 */
function useWorkspace(f: Parameters<Parameters<typeof fixture>[1]>[0], command?: string): { id: WorkspaceId; directory: string } {
  const id = `${CLIENT}:durable-cases` as WorkspaceId, directory = path.join(f.root,"durable-cases");
  fs.mkdirSync(directory); f.db.workspaces.upsert({id,title:"durable cases",path:directory}); f.apiContext.workspaces.set(id,directory);
  const config = task(command); f.remote.tasks = [{...config,payload:{...config.payload,contextWorkspaceId:id}}];
  return {id,directory};
}

for (const outcome of ["failed","timeout"] as const) test(`D08 工作区真实脚本${outcome}先保存再补报`, async t => fixture(t, async f => {
  const workspace = useWorkspace(f,outcome === "failed" ? "exit 7" : process.platform === "win32" ? "Start-Sleep -Seconds 3" : "sleep 3");
  f.remote.tasks[0]!.timeoutMs = outcome === "timeout" ? 1000 : 10000; f.remote.terminalFails = false;
  const run=await f.scheduler.runNow(TASK),saved=f.db.getAccountScheduledTaskRun(run.id,OWNER);
  assert.equal(run.status,outcome); assert.equal(saved?.workspaceId,workspace.id); assert.equal(saved?.run.reportSettlement,"acknowledged");
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs").get() as {n:number}).n,0);
}));

test("D18 账号工作区脚本失败日志落真实W且应用日志无同条", async t => fixture(t, async f => {
  const workspace = useWorkspace(f, "exit 7");
  const application: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { application.push(args); });
  f.remote.terminalFails = false;
  const run = await f.scheduler.runNow(TASK);
  assert.equal(run.status, "failed");
  const directory = path.join(workspace.directory, ".codeflowai");
  const logs = fs.readdirSync(directory).filter(name => /^client-.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  assert.equal(logs.filter((entry: any) => entry.message === "scheduled script failed").length, 1);
  assert.equal(logs[0].workspaceId, workspace.id);
  assert.equal(application.filter(args => String(args[1] ?? "") === "scheduled script failed").length, 0);
}));

for (const logFailure of [undefined, null, false, 0, "", Number.NaN, new Error("ACCOUNT_WORKSPACE_LOG_FAILED")])
test(`D18 账号工作区失败日志拒写${String(logFailure)}停止终态结算和终态回执`, async t => fixture(t, async f => {
  const workspace = useWorkspace(f, "exit 7");
  f.remote.terminalFails = false;
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logFailure; });
  let original: unknown;
  await assert.rejects(f.scheduler.runNow(TASK), error => {
    original = error;
    assert.ok(error instanceof AggregateError);
    assert.ok(Object.is(error.errors[1], logFailure));
    return true;
  });
  await assert.rejects(f.scheduler.waitForInFlightWork(), error => error === original);
  const running = f.reports.filter(body => body.run?.status === "running");
  assert.equal(running.length, 1);
  assert.equal(f.reports.some(body => body.run && body.run.status !== "running"), false);
  const saved = f.db.getAccountScheduledTaskRun(running[0]!.run!.id, OWNER);
  assert.equal(saved?.workspaceId, workspace.id);
  assert.equal(saved?.run.status, "running");
}));

test("D18 账号请求消费原W诊断失败时不重复应用日志或发送伪回执", async t => fixture(t, async f => {
  useWorkspace(f, "exit 7");
  const original = new Error("ACCOUNT_REQUEST_LOG_FAILED"), sent: unknown[] = [], application: unknown[] = [];
  f.remote.terminalFails = false;
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw original; });
  t.mock.method(logger, "error", (...args: unknown[]) => { application.push(args); });
  f.apiContext.scheduledTaskScheduler = f.scheduler;
  f.apiContext.send = message => { sent.push(message); };
  let failure: unknown;
  await assert.rejects(handleScheduledTaskRunNow(f.apiContext, { t: "api.req", id: "account-request", method: "scheduledTasks.runNow", path: "/", body: { taskId: TASK } }), error => {
    failure = error; assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], original); return true;
  });
  await assert.rejects(f.scheduler.waitForInFlightWork(), error => error === failure);
  assert.deepEqual(sent, []); assert.deepEqual(application, []);
}));

for (const stage of ["claim-history","claim-runtime","finish-history","finish-runtime"] as const)
test(`D08 工作区${stage}故障同库回滚且零后续HTTP`, async t => fixture(t,async f=>{
  const w=useWorkspace(f); f.remote.terminalFails=false;
  f.db.withAccountScheduledTasks(w.id,repos=>repos.db.exec(stage === "claim-history"
    ? "CREATE TRIGGER fault BEFORE INSERT ON scheduled_task_runs BEGIN SELECT RAISE(ABORT,'CLAIM_HISTORY'); END"
    : stage === "claim-runtime" ? "CREATE TRIGGER fault BEFORE INSERT ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT,'CLAIM_RUNTIME'); END"
      : stage === "finish-history" ? "CREATE TRIGGER fault BEFORE UPDATE OF status ON scheduled_task_runs BEGIN SELECT RAISE(IGNORE); END"
        : "CREATE TRIGGER fault BEFORE UPDATE OF running_run_id ON scheduled_task_runtime_states WHEN NEW.running_run_id IS NULL BEGIN SELECT RAISE(IGNORE); END"));
  await assert.rejects(f.scheduler.runNow(TASK));
  f.db.withAccountScheduledTasks(w.id,repos=>{
    const rows=repos.db.prepare("SELECT id,status FROM scheduled_task_runs").all() as Array<{id:string;status:string}>;
    assert.equal(rows.length,stage.startsWith("claim")?0:1);
    if(rows.length){assert.equal(rows[0]!.status,"running");assert.equal(repos.runtime.getAccount(TASK,OWNER)?.runningRunId,rows[0]!.id);}
    else assert.equal(repos.runtime.getAccount(TASK,OWNER),null);
  });
  assert.equal(f.reports.filter(body=>body.run).length,stage.startsWith("claim")?0:1);
  assert.equal(fs.existsSync(path.join(w.directory,"executed")),!stage.startsWith("claim"));
}));

for (const ack of [{ok:true},{ok:true,serverNow:-1},"cas"] as const)
test(`D08 工作区非法ACK或本地CAS失败保原pending ${JSON.stringify(ack)}`,async t=>fixture(t,async f=>{
  const w=useWorkspace(f);f.remote.terminalFails=false;
  if(ack==="cas")f.db.withAccountScheduledTasks(w.id,repos=>repos.db.exec("CREATE TRIGGER ack_fault BEFORE UPDATE OF report_settlement ON scheduled_task_runs BEGIN SELECT RAISE(IGNORE); END"));
  else f.remote.ack=ack;
  await assert.rejects(f.scheduler.runNow(TASK));
  const pending=f.db.listPendingAccountScheduledTaskRuns(OWNER);assert.equal(pending.length,1);assert.equal(pending[0]!.workspaceId,w.id);
  if(ack==="cas")f.db.withAccountScheduledTasks(w.id,repos=>repos.db.exec("DROP TRIGGER ack_fault"));else delete f.remote.ack;
  await f.scheduler.sync("workspace-ack-recovery");
  assert.equal(f.db.getAccountScheduledTaskRun(pending[0]!.run.id,OWNER)?.run.reportSettlement,"acknowledged");
  const sent=f.reports.filter(body=>body.run?.status==="success").map(body=>body.run);assert.deepEqual(sent,[sent[0],sent[0]]);
}));

for(const change of ["owner","disabled","deleted","workspace-type"] as const)
test(`D08 工作区已派发脚本${change}后仍在捕获原库收尾`,async t=>fixture(t,async f=>{
  const w=useWorkspace(f,process.platform==="win32"?"[IO.File]::WriteAllText('started','ok'); while (!(Test-Path 'release')) { Start-Sleep -Milliseconds 20 }":"touch started; while [ ! -f release ]; do sleep .05; done");
  f.remote.terminalFails=false;
  const running=f.scheduler.runNow(TASK).then(value=>({value}),error=>({error}));
  await waitFor(()=>fs.existsSync(path.join(w.directory,"started")));
  let primary:unknown;
  try {
    if(change==="owner"){f.identity.user="owner-B";f.identity.generation++;f.remote.tasks=[{...task(),ownerUserId:"owner-B"}];}
    else {
      if(change==="workspace-type"){
        const other=`${CLIENT}:changed-workspace` as WorkspaceId,directory=path.join(f.root,"changed-workspace");
        fs.mkdirSync(directory);f.db.workspaces.upsert({id:other,title:"changed",path:directory});f.apiContext.workspaces.set(other,directory);
        f.remote.tasks=[{...task(),taskType:"workflow",payload:{workflowId:"changed",contextWorkspaceId:other}}];
      }else f.remote.tasks=change==="deleted"?[]:[{...f.remote.tasks[0]!,enabled:false}];
      if(change==="deleted")f.db.workspaces.delete(w.id);
      await f.scheduler.sync("changed-during-workspace-script");
    }
  } catch(error){primary=error;}
  finally {fs.writeFileSync(path.join(w.directory,"release"),"ok");}
  const result=await running;if(primary)throw primary;
  if(change==="owner")assert.ok("error" in result);else assert.equal("value" in result?result.value.status:null,"success");
  const rows=f.db.withAccountScheduledTasks(w.id,repos=>repos.db.prepare("SELECT id,status,owner_user_id,report_settlement FROM scheduled_task_runs").all(),true) as Array<{id:string;status:string;owner_user_id:string;report_settlement:string|null}>;
  assert.equal(rows.length,1);assert.equal(rows[0]!.status,"success");assert.equal(rows[0]!.owner_user_id,USER);
  assert.equal(rows[0]!.report_settlement,change==="owner"?null:change==="deleted"?"task_deleted":"acknowledged");
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs").get() as {n:number}).n,0);
  if(change==="owner"){assert.equal(f.remote.syncCalls,1);f.identity.user=USER;f.identity.generation++;f.remote.tasks=[{...task(),enabled:false}];await f.scheduler.sync("original-owner-return");}
}));

test("D08 跨库删除结算首错停止后续HTTP，已提交保留且恢复原sync收敛",async t=>fixture(t,async f=>{
  const w=useWorkspace(f);f.remote.terminalFails=false;
  const old={id:"missing-app",taskId:"missing",clientId:CLIENT,deviceId:DEVICE,workspaceId:null,
    workflowInstanceId:null,workflowNameSnapshot:null,workflowVersion:null,scheduledAt:1,startedAt:null,finishedAt:1,status:"skipped",triggerSource:"schedule",attempt:1,durationMs:null,summary:"skip",errorMessage:null,outputExcerpt:null,createdAt:1} as ScheduledTaskRun;
  f.db.scheduledTaskRuns.createAccount({run:old,owner:OWNER,taskName:"missing"});
  f.db.withAccountScheduledTasks(w.id,repos=>{
    repos.runs.createAccount({run:{...old,id:"missing-w",workspaceId:w.id},owner:OWNER,taskName:"missing"});
    repos.db.exec("CREATE TRIGGER settlement_fault BEFORE UPDATE OF report_settlement ON scheduled_task_runs BEGIN SELECT RAISE(ABORT,'W_SETTLEMENT_FAILED'); END");
  });
  f.remote.tasks=[];await assert.rejects(f.scheduler.sync("cross-db-settlement-fault"));assert.equal(f.reports.length,0);
  assert.equal(f.db.scheduledTaskRuns.getAccount(old.id,OWNER)?.reportSettlement,"task_deleted");
  assert.equal(f.db.getAccountScheduledTaskRun("missing-w",OWNER)?.run.reportSettlement,null);
  f.db.withAccountScheduledTasks(w.id,repos=>repos.db.exec("DROP TRIGGER settlement_fault"));await f.scheduler.sync("cross-db-settlement-recovery");
  assert.equal(f.db.getAccountScheduledTaskRun("missing-w",OWNER)?.run.reportSettlement,"task_deleted");assert.equal(f.reports.some(body=>body.run),false);
}));

test("D08 工作区账号脚本在 running 回执前同库保存认领历史与runtime", async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:routing-a` as WorkspaceId, directory = path.join(f.root, "routing-a");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "routing", path: directory });
  f.apiContext.workspaces.set(workspaceId, directory);
  f.remote.tasks = [{ ...task(), payload: { ...task().payload, contextWorkspaceId: workspaceId } }];
  f.remote.terminalFails = false;
  let checked = false;
  f.remote.onReport = async body => {
    if (body.run?.status !== "running") return;
    const file = path.join(directory, ".codeflowai", "workspace.db");
    assert.equal(fs.existsSync(file), true, "running 回执必须先有真实 W runtime");
    const physical = openSqliteDb(file, { readonly: true, fileMustExist: true });
    try { assert.equal((physical.prepare("SELECT running_run_id FROM scheduled_task_runtime_states WHERE task_id=?").get(scheduledTaskAccountRuntimeKey(TASK, OWNER)) as { running_run_id: string }).running_run_id, body.run.id); }
    finally { physical.close(); }
    assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runtime_states WHERE task_id NOT LIKE '__sync__%'").get() as { n: number }).n, 0);
    checked = true;
  };
  const run = await f.scheduler.runNow(TASK);
  assert.equal(checked, true); assert.equal(run.status, "success");
  assert.equal(fs.readFileSync(path.join(directory, "executed"), "utf8"), "ok");
  assert.equal(f.db.getAccountScheduledTaskRun(run.id,OWNER)?.run.reportSettlement,"acknowledged");
  assert.equal(f.db.scheduledTaskRuns.listPendingAccount(OWNER).length, 0, "工作区历史不得写入应用库");
}));

test("D08 原 workflow 迁移延期变型为 script 后仍消费 W 原计划点", async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:queued-a` as WorkspaceId, directory = path.join(f.root, "queued-a");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "queued", path: directory });
  f.apiContext.workspaces.set(workspaceId, directory);
  const operation = f.db.workspaceDirectoryMigrations.create({ operationId: "d08-queued", idempotencyKey: "d08-queued", workspaceId,
    sourcePath: directory, targetParentPath: path.join(f.root, "target"), targetPath: path.join(f.root, "target", "queued-a"), now: 1 }).operation;
  const now = 1_800_000_005_000; t.mock.method(Date, "now", () => now);
  f.remote.terminalFails = false;
  f.remote.tasks = [{ ...task(), taskType: "workflow", concurrencyPolicy: "queue_one", payload: { workflowId: "queued-workflow", contextWorkspaceId: workspaceId } }];
  const release = await f.apiContext.workspaceOperationGate!.acquireMigration(workspaceId, operation.operationId);
  try {
    await f.scheduler.syncAndTick("workflow-defer");
    const file = path.join(directory, ".codeflowai", "workspace.db");
    assert.equal(fs.existsSync(file), true, "原 workflow 延期应持久化到 W");
    const physical = openSqliteDb(file, { readonly: true, fileMustExist: true });
    try { assert.equal((physical.prepare("SELECT queued_scheduled_at FROM scheduled_task_runtime_states WHERE task_id=?").get(scheduledTaskAccountRuntimeKey(TASK, OWNER)) as { queued_scheduled_at: number }).queued_scheduled_at, 1_800_000_000_000); }
    finally { physical.close(); }
  } finally { release(); }
  f.remote.tasks = [{ ...task(), payload: { ...task().payload, contextWorkspaceId: workspaceId } }];
  await f.scheduler.syncAndTick("workflow-to-script"); await f.scheduler.waitForInFlightWork();
  assert.equal(fs.readFileSync(path.join(directory, "executed"), "utf8"), "ok");
  assert.equal(f.reports.filter(body => body.run?.status === "running" && body.run.scheduledAt === 1_800_000_000_000).length, 1);
}));

/** 固定资产输入，保留真实实例创建、原引擎执行与物理 runtime 路由。 */
function installWorkflow(f: Parameters<Parameters<typeof fixture>[1]>[0]) {
  resetEngineModelCatalogRuntimeForTest();
  const workflowId = "d08-workflow", starts: string[] = [];
  f.apiContext.orchAssetLaunchSnapshot = { createFromWorkflowId: (workspaceId: WorkspaceId) => {
    const workflow = { id: workflowId, workspaceId, family: "feature-dev", name: "d08", description: "d08", version: 1,
      nodes: [{ id: "start", type: "start", label: "start", position: { x: 0, y: 0 } }, { id: "end", type: "end", label: "end", position: { x: 1, y: 0 } }],
      edges: [{ id: "edge", sourceNodeId: "start", targetNodeId: "end", dataMappings: [] }] };
    return { authorityMode: "server", workflow: { assetType: "workflow", assetId: workflowId, definition: workflow,
      source: { authorityMode: "server", metadata: { revision: 1, scopeType: "user", syncChangeSeq: 1, contentHash: "a".repeat(64), cacheStatus: "ready" } } },
      roles: {}, knowledgeBundles: {}, toolsets: {}, skills: {} } as unknown as OrchestrationAssetRuntimeSnapshot;
  } } as unknown as ApiHandlerContext["orchAssetLaunchSnapshot"];
  const engine = new OrchestrationEngine({ db: f.db, threads: new ThreadStore(), sessions: {} as any, workspaces: f.apiContext.workspaces,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 }, emitConversation() {}, emitRaw() {} });
  for (const workspaceId of f.apiContext.workspaces.keys()) {
    const child = engine.forWorkspace(workspaceId), start = child.start.bind(child);
    child.start = async id => { starts.push(id); await start(id); };
  }
  f.apiContext.orchEngine = engine;
  return { engine, starts, workflowId };
}

test("D18 账号流程启动和日志双错保原runtime认领，不执行finally结算或终态HTTP", async t => fixture(t, async f => {
  const workspace = useWorkspace(f), workflow = installWorkflow(f);
  const business = new Error("ACCOUNT_WORKFLOW_START_FAILED"), logging = new Error("ACCOUNT_WORKFLOW_LOG_FAILED");
  f.remote.tasks = [{ ...task(), taskType: "workflow", payload: { workflowId: workflow.workflowId, contextWorkspaceId: workspace.id } }];
  f.remote.terminalFails = false;
  t.mock.method(workflow.engine.forWorkspace(workspace.id), "start", async () => { throw business; });
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw logging; });
  try {
    let original: unknown;
    await assert.rejects(f.scheduler.runNow(TASK), error => {
      original = error; assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], business); assert.equal(error.errors[1], logging); assert.equal(error.cause, business); return true;
    });
    await assert.rejects(f.scheduler.waitForInFlightWork(), error => error === original);
    const running = f.reports.find(body => body.run?.status === "running")!.run!;
    assert.equal(f.db.readAccountScheduledTaskState(TASK, OWNER).running?.runtime.runningRunId, running.id);
    assert.equal(f.reports.some(body => body.run && body.run.status !== "running"), false);
    assert.equal(f.db.forWorkspace(workspace.id).orchInstances.listByWorkspace(workspace.id).length, 1);
    assert.equal(f.db.orchInstances.listByWorkspace(workspace.id).length, 0);
  } finally { await workflow.engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
}));

for (const boundary of ["previous", "migration-previous", "migration-policy"] as const)
test(`D08 ${boundary === "migration-policy" ? "耐久script" : "F1 非耐久workflow"} ${boundary} skipped 失败后沿原事实恢复重报`, async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:skip-${boundary}` as WorkspaceId, directory = path.join(f.root, "skip");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "skip", path: directory }); f.apiContext.workspaces.set(workspaceId, directory);
  t.mock.method(Date, "now", () => 1_800_000_005_000);
  const workflow = boundary !== "migration-policy";
  f.remote.tasks = [workflow ? { ...task(), taskType: "workflow", concurrencyPolicy: boundary === "migration-previous" ? "queue_one" : "skip_if_running",
    payload: { workflowId: "previous-workflow", contextWorkspaceId: workspaceId, skipWhenPreviousInstanceStatuses: ["failed"] } }
    : { ...task(), payload: { ...task().payload, contextWorkspaceId: workspaceId } }];
  f.db.withAccountScheduledTasks(workspaceId, repos => {
    repos.runtime.claimAccount({ taskId: TASK, owner: OWNER, runId: "previous-run", scheduledAt: 1, startedAt: 1 });
    if (workflow) repos.runtime.updateAccountWorkflow({ taskId: TASK, owner: OWNER, runId: "previous-run", instanceId: "previous-instance", sequence: 1, at: 1 });
    repos.runtime.finishAccount({ taskId: TASK, owner: OWNER, runId: "previous-run", finishedAt: 2 });
  });
  if (workflow) t.mock.method(f.db.forWorkspace(workspaceId).orchInstances, "get", () => ({ id: "previous-instance", workflowId: "previous-workflow", workspaceId, status: "failed" }) as ReturnType<typeof f.db.orchInstances.get>);
  let release = () => {};
  if (boundary !== "previous") {
    const operation = f.db.workspaceDirectoryMigrations.create({ operationId: `f1-${boundary}`, idempotencyKey: `f1-${boundary}`, workspaceId,
      sourcePath: directory, targetParentPath: path.join(f.root, "target"), targetPath: path.join(f.root, "target", "skip"), now: 1 }).operation;
    release = await f.apiContext.workspaceOperationGate!.acquireMigration(workspaceId, operation.operationId);
    if (boundary === "migration-previous") { await f.scheduler.syncAndTick("queue-before-previous-skip"); release(); }
  }
  try {
    if (boundary === "migration-policy") await assert.rejects(f.scheduler.syncAndTick("skip-report-failed"));
    else { await f.scheduler.syncAndTick("skip-report-failed"); await assert.rejects(f.scheduler.waitForInFlightWork()); }
    const failed = f.db.readAccountScheduledTaskState(TASK, OWNER);
    assert.equal(failed.lastScheduledAt, workflow ? 1 : 1_800_000_000_000, "workflow保报告后消费；script以原子历史保证可恢复");
    assert.equal(failed.queued?.runtime.queuedScheduledAt ?? null, boundary === "migration-previous" ? 1_800_000_000_000 : null);
    assert.equal(f.reports.filter(body => body.run?.status === "skipped").length, 1);
    f.remote.terminalFails = false;
    if (!workflow) {
      await assert.rejects(f.scheduler.sync("skip-http-success-ack-gated"));
      assert.equal(f.db.listPendingAccountScheduledTaskRuns(OWNER).length, 1, "HTTP成功但普通ACK被迁移gate拒绝仍保pending");
      release();
    }
    await f.scheduler.syncAndTick("skip-report-recovered"); await f.scheduler.waitForInFlightWork();
    const complete = f.db.readAccountScheduledTaskState(TASK, OWNER);
    const skips = f.reports.filter(body => body.run?.status === "skipped");
    assert.equal(skips.length, workflow ? 2 : 3, "同分钟恢复必须重报原 skipped");
    if (!workflow) assert.deepEqual(skips.map(body => body.run), [skips[0]!.run,skips[0]!.run,skips[0]!.run]);
    assert.equal(complete.lastScheduledAt, 1_800_000_000_000); assert.equal(complete.queued, null);
    assert.equal(complete.locations.length, 1); assert.equal(complete.locations[0]?.workspaceId, workspaceId);
    release();
    f.db.withAccountScheduledTasks(workspaceId, repos => assert.equal((repos.db.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs").get() as { n: number }).n, workflow ? 0 : 1));
  } finally { release(); }
}));

for (const change of ["owner", "workspace"] as const)
test(`D08 F1 非耐久 skipped 回执期间变更 ${change} 仅按捕获边界收尾`, async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:skip-stale` as WorkspaceId, directory = path.join(f.root, "stale");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "stale", path: directory }); f.apiContext.workspaces.set(workspaceId, directory);
  t.mock.method(Date, "now", () => 1_800_000_005_000);
  f.remote.tasks = [{ ...task(), taskType: "workflow", payload: { workflowId: "previous-workflow", contextWorkspaceId: workspaceId, skipWhenPreviousInstanceStatuses: ["failed"] } }];
  f.db.withAccountScheduledTasks(workspaceId, repos => {
    repos.runtime.claimAccount({ taskId: TASK, owner: OWNER, runId: "previous-run", scheduledAt: 1, startedAt: 1 });
    repos.runtime.updateAccountWorkflow({ taskId: TASK, owner: OWNER, runId: "previous-run", instanceId: "previous-instance", sequence: 1, at: 1 });
    repos.runtime.finishAccount({ taskId: TASK, owner: OWNER, runId: "previous-run", finishedAt: 2 });
  });
  t.mock.method(f.db.forWorkspace(workspaceId).orchInstances, "get", () => ({ id: "previous-instance", workflowId: "previous-workflow", workspaceId, status: "failed" }) as ReturnType<typeof f.db.orchInstances.get>);
  f.remote.terminalFails = false;
  const otherWorkspace = `${CLIENT}:skip-new-workspace` as WorkspaceId, otherDirectory = path.join(f.root, "new-workspace");
  if (change === "workspace") { fs.mkdirSync(otherDirectory); f.db.workspaces.upsert({ id: otherWorkspace, title: "new", path: otherDirectory }); f.apiContext.workspaces.set(otherWorkspace, otherDirectory); }
  f.remote.onReport = async body => {
    if (body.run?.status !== "skipped") return;
    if (change === "owner") { f.identity.user = "new-owner"; f.identity.generation++; }
    else {
      // 暂停后续自动派发，只核本次旧回执仍在捕获的工作区收尾。
      f.apiContext.isTaskAdmissionPaused = () => true;
      f.remote.tasks = [{ ...f.remote.tasks[0]!, payload: { workflowId: "previous-workflow", contextWorkspaceId: otherWorkspace, skipWhenPreviousInstanceStatuses: ["failed"] } }];
      await f.scheduler.sync("workspace-changed-during-skip");
    }
  };
  await f.scheduler.syncAndTick("skip-boundary-changed");
  if (change === "owner") await assert.rejects(f.scheduler.waitForInFlightWork(), { code: "SCHEDULED_TASK_ACCOUNT_STALE" });
  else await f.scheduler.waitForInFlightWork();
  const state = f.db.readAccountScheduledTaskState(TASK, OWNER);
  assert.equal(state.lastScheduledAt, change === "owner" ? 1 : 1_800_000_000_000);
  assert.equal(state.locations.length, 1); assert.equal(state.locations[0]?.workspaceId, workspaceId);
  assert.equal(f.db.readAccountScheduledTaskState(TASK, { ...OWNER, ownerUserId: "new-owner" }).locations.length, 0);
}));

test("D08 F1 工作区 script 并发 skipped 失败同分钟重报且保原 running", async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:skip-concurrency` as WorkspaceId, directory = path.join(f.root, "concurrency");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "concurrency", path: directory }); f.apiContext.workspaces.set(workspaceId, directory);
  let now = 1_800_000_005_000; t.mock.method(Date, "now", () => now);
  const command = process.platform === "win32" ? "[IO.File]::WriteAllText('started','ok'); while (!(Test-Path 'release')) { Start-Sleep -Milliseconds 20 }" : "touch started; while [ ! -f release ]; do sleep .05; done";
  f.remote.tasks = [{ ...task(command), payload: { ...task(command).payload, contextWorkspaceId: workspaceId } }];
  const running = f.scheduler.runNow(TASK), settled = running.then(value => ({ value }), error => ({ error }));
  // 保留断言主错与脚本排空副错，确保收尾失败也使测试失败。
  let primary: { error: unknown } | undefined;
  try {
    await waitFor(() => fs.existsSync(path.join(directory, "started"))); now += 60_000;
    const before = f.db.readAccountScheduledTaskState(TASK, OWNER);
    await assert.rejects(f.scheduler.syncAndTick("concurrency-skip-fails"));
    const failed = f.db.readAccountScheduledTaskState(TASK, OWNER);
    assert.equal(failed.lastScheduledAt, 1_800_000_060_000); assert.equal(failed.running?.runtime.runningRunId, before.running?.runtime.runningRunId);
    assert.equal(f.db.listPendingAccountScheduledTaskRuns(OWNER)[0]?.run.status, "skipped");
    f.remote.terminalFails = false;
    await f.scheduler.syncAndTick("concurrency-skip-recovers"); await f.scheduler.syncAndTick("concurrency-skip-deduplicates");
    assert.equal(f.reports.filter(body => body.run?.status === "skipped").length, 2);
    assert.equal(f.db.readAccountScheduledTaskState(TASK, OWNER).lastScheduledAt, 1_800_000_060_000);
    assert.equal(f.db.readAccountScheduledTaskState(TASK, OWNER).running?.runtime.runningRunId, before.running?.runtime.runningRunId);
  } catch (error) { primary = { error }; }
  finally {
    const failures: unknown[] = primary ? [primary.error] : [];
    try { f.remote.terminalFails = false; fs.writeFileSync(path.join(directory, "release"), "ok"); }
    catch (error) { failures.push(error); }
    const result = await settled;
    if ("error" in result) failures.push(result.error);
    else try { assert.equal(result.value.status, "success", "首轮真实脚本必须成功收尾"); }
    catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "并发 skipped 断言与首轮脚本收尾失败");
  }
}));

test("D08 原 script 延期变 workflow 使用同 W 最新配置与原 scheduledAt", async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:queued-workflow` as WorkspaceId, directory = path.join(f.root, "queued-workflow");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "queued", path: directory }); f.apiContext.workspaces.set(workspaceId, directory);
  const operation = f.db.workspaceDirectoryMigrations.create({ operationId: "script-to-workflow", idempotencyKey: "script-to-workflow", workspaceId,
    sourcePath: directory, targetParentPath: path.join(f.root, "target"), targetPath: path.join(f.root, "target", "queued"), now: 1 }).operation;
  const w = installWorkflow(f); f.remote.terminalFails = false; t.mock.method(Date, "now", () => 1_800_000_005_000);
  try {
    f.remote.tasks = [{ ...task(), concurrencyPolicy: "queue_one", payload: { ...task().payload, contextWorkspaceId: workspaceId } }];
    const release = await f.apiContext.workspaceOperationGate!.acquireMigration(workspaceId, operation.operationId);
    try { await f.scheduler.syncAndTick("script-defer"); } finally { release(); }
    f.remote.tasks = [{ ...task(), taskType: "workflow", payload: { workflowId: w.workflowId, contextWorkspaceId: workspaceId } }];
    await f.scheduler.syncAndTick("latest-workflow"); await f.scheduler.waitForInFlightWork();
    assert.equal(w.starts.length, 1); assert.equal(fs.existsSync(path.join(directory, "executed")), false);
    const state = f.db.readAccountScheduledTaskState(TASK, OWNER);
    assert.equal(state.queued, null); assert.equal(state.lastScheduledAt, 1_800_000_000_000); assert.equal(state.lastWorkflowSequence, 1);
  } finally { await w.engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
}));

test("D08 A→B→A 同时钟且插入 script 后 previous 只看最大 workflow sequence", async t => fixture(t, async f => {
  const a = `${CLIENT}:sequence-a` as WorkspaceId, b = `${CLIENT}:sequence-b` as WorkspaceId;
  for (const id of [a,b]) { const directory = path.join(f.root, id.endsWith("a") ? "a" : "b"); fs.mkdirSync(directory); f.db.workspaces.upsert({ id, title: id, path: directory }); f.apiContext.workspaces.set(id, directory); }
  const w = installWorkflow(f); f.remote.terminalFails = false;
  let now = 1_800_000_005_000; t.mock.method(Date, "now", () => now);
  const config = (workspaceId: WorkspaceId): ScheduledTask => ({ ...task(), taskType: "workflow", payload: { workflowId: w.workflowId, contextWorkspaceId: workspaceId, skipWhenPreviousInstanceStatuses: ["completed"] } });
  try {
    f.remote.tasks = [config(a)]; const one = await f.scheduler.runNow(TASK);
    f.remote.tasks = [config(b)]; const two = await f.scheduler.runNow(TASK);
    assert.notEqual(one.workflowInstanceId, two.workflowInstanceId);
    f.remote.tasks = [{ ...task(), payload: { ...task().payload, contextWorkspaceId: a } }]; await f.scheduler.runNow(TASK);
    assert.equal(f.db.readAccountScheduledTaskState(TASK, OWNER).lastWorkflowInstanceId, two.workflowInstanceId);
    f.remote.tasks = [config(a)]; now += 60_000;
    await f.scheduler.syncAndTick("return-a-after-script"); await f.scheduler.waitForInFlightWork();
    const state = f.db.readAccountScheduledTaskState(TASK, OWNER);
    assert.equal(w.starts.length, 3, "B 是最后引用且 workspace 不匹配，应创建 A3；不能回选 A1 跳过");
    assert.equal(state.lastWorkflowSequence, 3); assert.notEqual(state.lastWorkflowInstanceId, one.workflowInstanceId);
    f.db.withAccountScheduledTasks(a, repos => repos.db.prepare("UPDATE scheduled_task_runtime_states SET last_workflow_instance_id=? WHERE task_id=?")
      .run("missing-latest", scheduledTaskAccountRuntimeKey(TASK, OWNER)));
    now += 60_000; await f.scheduler.syncAndTick("missing-latest-do-not-fallback"); await f.scheduler.waitForInFlightWork();
    assert.equal(w.starts.length, 4, "最大引用缺失应按原 missing→null，不能回选旧引用");
  } finally { await w.engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
}));

for (const failure of ["overflow", "pointer-cas"] as const) test(`D08 workflow ${failure} 在真实消费者阻止 engine.start`, async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:sequence-failure` as WorkspaceId, directory = path.join(f.root, "workflow-failure");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "workflow", path: directory }); f.apiContext.workspaces.set(workspaceId, directory);
  const w = installWorkflow(f); f.remote.terminalFails = false;
  f.remote.tasks = [{ ...task(), taskType: "workflow", payload: { workflowId: w.workflowId, contextWorkspaceId: workspaceId } }];
  f.db.withAccountScheduledTasks(workspaceId, repos => {
    if (failure === "pointer-cas") repos.db.exec("CREATE TRIGGER ignore_pointer BEFORE UPDATE OF last_workflow_sequence ON scheduled_task_runtime_states BEGIN SELECT RAISE(IGNORE); END");
    else {
      repos.runtime.claimAccount({ taskId: TASK, owner: OWNER, runId: "old", scheduledAt: 1, startedAt: 1 });
      repos.runtime.updateAccountWorkflow({ taskId: TASK, owner: OWNER, runId: "old", instanceId: "old-instance", sequence: Number.MAX_SAFE_INTEGER, at: 1 });
      repos.runtime.finishAccount({ taskId: TASK, owner: OWNER, runId: "old", finishedAt: 2 });
    }
  });
  try {
    const run = await f.scheduler.runNow(TASK); assert.equal(run.status, "failed"); assert.equal(w.starts.length, 0);
    assert.equal(f.db.forWorkspace(workspaceId).orchInstances.listByWorkspace(workspaceId).length, failure === "overflow" ? 0 : 1);
  } finally { await w.engine.waitForInFlightWork(); resetEngineModelCatalogRuntimeForTest(); }
}));

test("D08 A→B→无工作区自动计划不得重放全 scope 已消费分钟", async t => fixture(t, async f => {
  const a = `${CLIENT}:watermark-a` as WorkspaceId, b = `${CLIENT}:watermark-b` as WorkspaceId;
  for (const id of [a,b]) { const directory = path.join(f.root, id.endsWith("a") ? "a" : "b"); fs.mkdirSync(directory); f.db.workspaces.upsert({ id, title: id, path: directory }); f.apiContext.workspaces.set(id, directory); }
  t.mock.method(Date, "now", () => 1_800_000_005_000); f.remote.terminalFails = false;
  f.remote.tasks = [{ ...task(), payload: { ...task().payload, contextWorkspaceId: a } }]; await f.scheduler.runNow(TASK);
  f.remote.tasks = [{ ...task(), payload: { ...task().payload, contextWorkspaceId: b } }]; await f.scheduler.syncAndTick("moved-b"); await f.scheduler.waitForInFlightWork();
  f.remote.tasks = [task()]; await f.scheduler.syncAndTick("moved-app"); await f.scheduler.waitForInFlightWork();
  assert.equal(f.reports.filter(body => body.run?.status === "running").length, 1);
  assert.equal(f.db.readAccountScheduledTaskState(TASK, OWNER).locations.length, 1);
}));

test("D08 最终 handoff 等待在 callback 外，释放后仅执行原分钟一次", async t => fixture(t, async f => {
  const workspaceId = `${CLIENT}:handoff` as WorkspaceId, directory = path.join(f.root, "handoff");
  fs.mkdirSync(directory); f.db.workspaces.upsert({ id: workspaceId, title: "handoff", path: directory }); f.apiContext.workspaces.set(workspaceId, directory);
  const gate = f.apiContext.workspaceOperationGate!, release = await gate.acquireMigration(workspaceId, "handoff-owner");
  const handoff = await gate.beginFinalHandoff(workspaceId, "handoff-owner");
  t.mock.method(Date, "now", () => 1_800_000_005_000); f.remote.terminalFails = false;
  f.remote.tasks = [{ ...task(), concurrencyPolicy: "queue_one", payload: { ...task().payload, contextWorkspaceId: workspaceId } }];
  const tick = f.scheduler.syncAndTick("account-handoff");
  let completed = false;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(gate.hasActiveWrites(), false); assert.equal(f.reports.some(body => body.run?.status === "running"), false);
    handoff.complete(); completed = true; release(); await tick; await f.scheduler.waitForInFlightWork();
    assert.equal(f.reports.filter(body => body.run?.status === "running" && body.run.scheduledAt === 1_800_000_000_000).length, 1);
  } finally { if (!completed) handoff.complete(); release(); await tick; }
}));

for (const logFails of [false,true]) test(`D08 延期 operation 与物理 W 不匹配停止后续 HTTP，日志失败=${logFails} 保双因`, async t => fixture(t, async f => {
  const a = `${CLIENT}:operation-a` as WorkspaceId, b = `${CLIENT}:operation-b` as WorkspaceId;
  for (const id of [a,b]) { const directory = path.join(f.root, id.endsWith("a") ? "a" : "b"); fs.mkdirSync(directory); f.db.workspaces.upsert({ id, title: id, path: directory }); f.apiContext.workspaces.set(id, directory); }
  const operation = f.db.workspaceDirectoryMigrations.create({ operationId: "wrong-location", idempotencyKey: "wrong-location", workspaceId: a,
    sourcePath: f.apiContext.workspaces.get(a)!, targetParentPath: path.join(f.root, "target"), targetPath: path.join(f.root, "target", "a"), now: 1 }).operation;
  f.db.withAccountScheduledTasks(b, repos => repos.runtime.queueForWorkspaceMigration({ taskId: scheduledTaskAccountRuntimeKey(TASK, OWNER),
    clientId: CLIENT, deviceId: DEVICE, scheduledAt: 60_000, operationId: operation.operationId, at: 1 }));
  f.remote.tasks = [{ ...task(), enabled: false, payload: { ...task().payload, contextWorkspaceId: b } }];
  const logs: unknown[][] = [], logError = new Error("D08_LOG_WRITE_FAILED");
  t.mock.method(f.db, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: Parameters<typeof f.db.writeWorkspaceLog>[1]) => {
    assert.equal(workspaceId, b); logs.push([entry.tag, entry.message, entry.data]); if (logFails) throw logError;
  });
  let original: unknown;
  await assert.rejects(f.scheduler.sync("wrong-location"), error => {
    original = error;
    if (logFails) { assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], logError); assert.equal(error.errors[0].code, "SCHEDULED_TASK_RUNTIME_CONFLICT"); }
    else assert.equal((error as { code: string }).code, "SCHEDULED_TASK_RUNTIME_CONFLICT");
    return true;
  });
  if (logFails) await assert.rejects(f.scheduler.waitForInFlightWork(), error => error === original);
  assert.equal(logs.length, 1); assert.equal(f.reports.length, 0);
  assert.equal(f.db.readAccountScheduledTaskState(TASK, OWNER).queued?.workspaceId, b);
  assert.equal(JSON.stringify(logs).includes("fixture-key"), false);
}));

test("D08 无工作区 b8 删除结算与停止队列水位仍在原应用事务回滚", async t => fixture(t, async f => {
  let now = 1_800_000_005_000; t.mock.method(Date, "now", () => now); f.remote.terminalFails = false;
  const command = process.platform === "win32" ? "[IO.File]::WriteAllText('started','ok'); while (!(Test-Path 'release')) { Start-Sleep -Milliseconds 20 }" : "touch started; while [ ! -f release ]; do sleep .05; done";
  f.remote.tasks = [{ ...task(command), concurrencyPolicy: "queue_one" }];
  const running = f.scheduler.runNow(TASK), settled = running.then(value => ({ value }), error => ({ error }));
  const directory = path.join(f.root, ".codeflowai", "scheduled-tasks");
  try {
    await waitFor(() => fs.existsSync(path.join(directory, "started"))); now += 60_000;
    await f.scheduler.syncAndTick("queued-b8");
    f.db.scheduledTaskRuns.createAccount({ owner: OWNER, taskName: "missing", run: { id: "missing-pending", taskId: "missing-task", clientId: CLIENT, deviceId: DEVICE,
      workspaceId: null, workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null, scheduledAt: now, startedAt: null, finishedAt: now,
      status: "skipped", triggerSource: "schedule", attempt: 1, durationMs: null, summary: "skipped", errorMessage: null, outputExcerpt: null, createdAt: now } });
    f.db.db.exec("CREATE TRIGGER fail_b8_queue BEFORE UPDATE OF last_scheduled_at ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT,'B8_QUEUE_FAIL'); END");
    f.remote.tasks = [{ ...f.remote.tasks[0]!, enabled: false }];
    await assert.rejects(f.scheduler.sync("b8-atomic-failure"), { code: "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED" });
    assert.equal(f.db.scheduledTaskRuns.getAccount("missing-pending", OWNER)?.reportSettlement, null, "原应用事务必须一起回滚删除结算");
  } finally {
    f.db.db.exec("DROP TRIGGER IF EXISTS fail_b8_queue"); fs.writeFileSync(path.join(directory, "release"), "ok");
    await settled;
  }
}));

test("账号真实脚本终态发送失败后仍先耐久保存，重开可见成功事实", async t => fixture(t, async f => {
  await assert.rejects(f.scheduler.runNow(TASK));
  assert.equal(fs.readFileSync(path.join(f.root, ".codeflowai/scheduled-tasks/executed"), "utf8"), "ok");
  const reopened = openClientDb({ dbPath: f.file });
  try {
    const rows = reopened.db.prepare("SELECT * FROM scheduled_task_runs WHERE task_id = ?").all(TASK) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1, "真实成功终态必须在发送前持久保存");
    assert.equal(rows[0]?.status, "success");
    assert.equal(rows[0]?.report_settlement, null);
  } finally { reopened.close(); }
}));

/** 等待真实子进程文件，失败有界结束，避免依赖微任务轮数。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const limit = performance.now() + 10_000;
  while (!predicate()) { assert.ok(performance.now() < limit, "durable script timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("旧 owner 脚本自然完成仅保存旧历史，不唤醒新 owner 同步", async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  f.remote.tasks = [task(process.platform === "win32"
    ? "[IO.File]::WriteAllText('started','ok'); while (!(Test-Path 'release')) { Start-Sleep -Milliseconds 20 }"
    : "touch started; while [ ! -f release ]; do sleep .05; done")];
  const running = f.scheduler.runNow(TASK).then(value => ({ value }), error => ({ error }));
  const dir = path.join(f.root, ".codeflowai/scheduled-tasks"); await waitFor(() => fs.existsSync(path.join(dir, "started")));
  f.identity.user = "owner-B"; f.identity.generation++;
  f.remote.tasks = [ { ...task(), ownerUserId: "owner-B" } ];
  fs.writeFileSync(path.join(dir, "release"), "ok");
  const result = await running; assert.ok("error" in result);
  assert.equal(f.remote.syncCalls, 1, "旧 owner 完成不能触发新 owner HTTP 同步");
  const rows = f.db.db.prepare("SELECT * FROM scheduled_task_runs").all() as Array<Record<string, unknown>>;
  assert.equal(rows[0]?.owner_user_id, USER); assert.equal(rows[0]?.status, "success"); assert.equal(rows[0]?.report_settlement, null);
}));

test("原 sync 末轮完成与 Promise 清理之间的微任务唤醒仍包含新一轮", async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  const scheduler = f.scheduler as unknown as { performSync(reason: string): Promise<void> };
  const perform = scheduler.performSync.bind(f.scheduler); let wake: Promise<void> | undefined;
  t.mock.method(scheduler, "performSync", async (reason: string) => {
    await perform(reason);
    if (reason === "first") queueMicrotask(() => queueMicrotask(() => { wake = f.scheduler.sync("late-wake"); }));
  });
  await f.scheduler.sync("first");
  assert.ok(wake); await wake;
  assert.equal(f.remote.syncCalls, 2, "末轮后的唤醒不能等待旧已结算 Promise 而丢失");
}));

test("ACK 丢失重启按原 sync 重发同一终态并精确确认，local 列表隔离", async t => fixture(t, async f => {
  await assert.rejects(f.scheduler.runNow(TASK));
  const first = f.reports.find(body => body.run?.status === "success")!.run!;
  f.remote.terminalFails = false; await f.scheduler.stopAndDrain();
  const reopened = openClientDb({ dbPath: f.file });
  try {
    const restarted = f.createScheduler(reopened); await restarted.sync("restart");
    const sent = f.reports.filter(body => body.run?.status === "success"); assert.equal(sent.length, 2);
    assert.deepEqual(sent[1]?.run, first);
    assert.equal(reopened.scheduledTaskRuns.getAccount(first.id, OWNER)?.reportSettlement, "acknowledged");
    assert.deepEqual(reopened.scheduledTaskRuns.list({}), { items: [], total: 0 });
    await restarted.stopAndDrain();
  } finally { reopened.close(); }
}));

for (const ack of [{ ok: true }, { ok: true, serverNow: -1 }, { ok: true, serverNow: 1.5 }]) test(`非法 ACK 不确认结果：${JSON.stringify(ack)}`, async t => fixture(t, async f => {
  await assert.rejects(f.scheduler.runNow(TASK)); f.remote.terminalFails = false; f.remote.ack = ack;
  const count = f.reports.filter(body => body.run?.status === "success").length;
  await assert.rejects(f.scheduler.sync("bad-ack"));
  assert.equal(f.reports.filter(body => body.run?.status === "success").length, count + 1, "坏 ACK 必须来自实际终态 HTTP");
  const pending = f.db.scheduledTaskRuns.listPendingAccount(OWNER); assert.equal(pending.length, 1); assert.equal(pending[0]?.status, "success");
}));

test("running 坏 ACK 明确拒绝且零脚本副作用", async t => fixture(t, async f => {
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); if (body.run?.status === "running") return Response.json({ ok: true });
    return original(input, init);
  });
  await assert.rejects(f.scheduler.runNow(TASK)); assert.equal(fs.existsSync(path.join(f.root, ".codeflowai/scheduled-tasks/executed")), false);
  const saved = f.db.db.prepare("SELECT * FROM scheduled_task_runs").all() as Array<Record<string, unknown>>;
  assert.equal(saved[0]?.status, "failed");
}));

for (const change of ["disabled", "deleted", "reassigned", "unchanged"] as const) test(`running ACK 等待期间完整快照 ${change} 后只派发仍有效的运行`, async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  const logs: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { logs.push(args); });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.remote.onReport = async body => { if (body.run?.status === "running") await held; };
  const running = f.scheduler.runNow(TASK).then(value => ({ value }), error => ({ error }));
  try {
    await waitFor(() => f.reports.some(body => body.run?.status === "running"));
    const runId = f.reports.find(body => body.run?.status === "running")!.run!.id;
    f.remote.tasks = change === "disabled" ? [{ ...task(), enabled: false }] : change === "unchanged" ? [task()] : [];
    await f.scheduler.sync("observed-before-running-ack");
    if (change === "reassigned") { f.remote.tasks = [task()]; await f.scheduler.sync("same-id-reassigned-before-ack"); }
    const executed = path.join(f.root, ".codeflowai/scheduled-tasks/executed");
    assert.equal(fs.existsSync(executed), false);
    release(); const result = await running;
    assert.ok("value" in result, "未派发失败应保留原执行结果合同");
    const run = result.value!;
    assert.equal(fs.existsSync(executed), change === "unchanged", "已观察停删的旧运行不能启动真实脚本");
    assert.equal(run.status, change === "unchanged" ? "success" : "failed");
    if (change !== "unchanged") assert.match(run.errorMessage ?? "", /SCHEDULED_TASK_ACCOUNT_UNAVAILABLE/);
    assert.equal(f.db.scheduledTaskRuns.getAccount(runId, OWNER)?.status, run.status);
    assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskAccountRuntimeKey(TASK, OWNER))?.runningRunId, null);
    assert.equal(f.db.scheduledTaskRuns.getAccount(runId, OWNER)?.reportSettlement, change === "disabled" || change === "unchanged" ? "acknowledged" : "task_deleted");
    const terminal = f.reports.filter(body => body.run?.id === runId && body.run.status !== "running");
    assert.equal(terminal.length, change === "disabled" || change === "unchanged" ? 1 : 0);
    assert.equal(logs.length, change === "unchanged" ? 0 : 1, "派发拒绝只在处理边界记录一次");
    if (change !== "unchanged") {
      const fields = logs[0]![2] as Record<string, unknown>;
      assert.equal(fields.code, "SCHEDULED_TASK_ACCOUNT_UNAVAILABLE"); assert.equal(fields.requestId, runId);
      assert.equal(fields.ownerUserId, USER); assert.equal(fields.serverOrigin, ORIGIN); assert.equal(fields.clientId, CLIENT); assert.equal(fields.deviceId, DEVICE);
      assert.equal(fields.taskId, TASK); assert.equal(fields.runId, runId); assert.equal(fields.stage, "dispatch");
      assert.equal((fields.rootCause as { systemCode: string }).systemCode, "SCHEDULED_TASK_ACCOUNT_UNAVAILABLE");
      assert.equal(JSON.stringify(logs).includes("WriteAllText"), false); assert.equal(JSON.stringify(logs).includes("fixture-key"), false);
    }
    if (change === "reassigned") {
      f.remote.onReport = undefined;
      const fresh = await f.scheduler.runNow(TASK);
      assert.notEqual(fresh.id, runId); assert.equal(fresh.status, "success"); assert.equal(fs.readFileSync(executed, "utf8"), "ok");
      assert.equal(f.db.scheduledTaskRuns.getAccount(runId, OWNER)?.reportSettlement, "task_deleted");
    }
  } finally { release(); await running; }
}));

test("派发拒绝日志写入失败保双因并显式失败，原running保留且零派发", async t => fixture(t, async f => {
  const logError = new Error("controlled private log failure");
  t.mock.method(logger, "error", () => { throw logError; }); f.remote.terminalFails = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.remote.onReport = async body => { if (body.run?.status === "running") await held; };
  const running = f.scheduler.runNow(TASK).then(value => ({ value }), error => ({ error }));
  try {
    await waitFor(() => f.reports.some(body => body.run?.status === "running"));
    const runId = f.reports.find(body => body.run?.status === "running")!.run!.id;
    f.remote.tasks = [{ ...task(), enabled: false }]; await f.scheduler.sync("disabled-before-log-failure");
    release(); const result = await running;
    assert.ok("error" in result); assert.ok(result.error instanceof AggregateError);
    assert.equal(result.error.errors[0]?.code, "SCHEDULED_TASK_ACCOUNT_UNAVAILABLE"); assert.equal(result.error.errors[1], logError);
    await assert.rejects(f.scheduler.waitForInFlightWork(), error => error === result.error);
    assert.equal(fs.existsSync(path.join(f.root, ".codeflowai/scheduled-tasks/executed")), false);
    assert.equal(f.db.scheduledTaskRuns.getAccount(runId, OWNER)?.status, "running");
    assert.equal(f.db.scheduledTaskRuns.getAccount(runId, OWNER)?.reportSettlement, null);
    assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskAccountRuntimeKey(TASK, OWNER))?.runningRunId, runId);
    assert.equal(f.reports.some(body => body.run?.status === "failed"), false);
  } finally { release(); await running; }
}));

for (const change of ["disabled", "deleted"] as const) test(`执行中完整快照 ${change} 后自然成功，停用可补报、删除不补报`, async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  f.remote.tasks = [task(process.platform === "win32" ? "[IO.File]::WriteAllText('started','ok'); while (!(Test-Path 'release')) { Start-Sleep -Milliseconds 20 }" : "touch started; while [ ! -f release ]; do sleep .05; done")];
  const running = f.scheduler.runNow(TASK); const dir = path.join(f.root, ".codeflowai/scheduled-tasks");
  await waitFor(() => fs.existsSync(path.join(dir, "started"))); f.remote.tasks = change === "deleted" ? [] : [{ ...f.remote.tasks[0]!, enabled: false }]; await f.scheduler.sync("stop-while-running");
  fs.writeFileSync(path.join(dir, "release"), "ok"); const run = await running;
  assert.equal(run.status, "success"); assert.equal(f.db.scheduledTaskRuns.getAccount(run.id, OWNER)?.reportSettlement, change === "deleted" ? "task_deleted" : "acknowledged");
  assert.equal(f.reports.filter(body => body.run?.status === "success").length, change === "deleted" ? 0 : 1);
}));

test("两个真实脚本并发完成和慢 sync 仍逐条单飞补报，无漏唤醒", async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  const command = process.platform === "win32" ? "while (!(Test-Path 'release')) { Start-Sleep -Milliseconds 20 }; Write-Output ok" : "while [ ! -f release ]; do sleep .05; done; echo ok";
  f.remote.tasks = [task(command), { ...task(command), id: "second-task" }];
  const one = f.scheduler.runNow(TASK), two = f.scheduler.runNow("second-task");
  await waitFor(() => f.reports.filter(body => body.run?.status === "running").length === 2);
  let release!: () => void, entered = false; const pending = new Promise<void>(resolve => { release = resolve; });
  f.remote.onSync = async () => { entered = true; await pending; };
  const sync = f.scheduler.sync("slow-completion-sync"); await waitFor(() => entered);
  fs.writeFileSync(path.join(f.root, ".codeflowai/scheduled-tasks/release"), "ok");
  await waitFor(() => (f.db.db.prepare("SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE status='success'").get() as { count: number }).count === 2);
  let inFlight = 0, maximum = 0;
  f.remote.onReport = async body => { if (body.run?.status === "success") { inFlight++; maximum = Math.max(maximum, inFlight); await new Promise(resolve => setTimeout(resolve, 15)); inFlight--; } };
  release(); await Promise.all([sync, one, two]);
  assert.equal(maximum, 1); assert.equal(f.reports.filter(body => body.run?.status === "success").length, 2);
  assert.deepEqual(f.db.scheduledTaskRuns.listPendingAccount(OWNER), []);
}));

for (const outcome of ["failed", "timeout"] as const) test(`真实脚本${outcome}先耐久后补报，执行结果不被投递覆盖`, async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  f.remote.tasks = [{ ...task(outcome === "failed" ? "exit 7" : process.platform === "win32" ? "Start-Sleep -Seconds 3" : "sleep 3"), timeoutMs: outcome === "timeout" ? 1000 : 10000 }];
  const run = await f.scheduler.runNow(TASK);
  assert.equal(run.status, outcome); assert.equal(f.db.scheduledTaskRuns.getAccount(run.id, OWNER)?.status, outcome);
  assert.equal(f.db.scheduledTaskRuns.getAccount(run.id, OWNER)?.reportSettlement, "acknowledged");
}));

test("并发跳过沿同事务耐久并由原 sync 补报，保原运行 owner", async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  const initial = Date.now(), minute = Math.floor(initial / 60000) * 60000;
  t.mock.method(Date, "now", () => initial);
  f.remote.tasks = [task(process.platform === "win32" ? "[IO.File]::WriteAllText('started','ok'); while (!(Test-Path 'release')) { Start-Sleep -Milliseconds 20 }" : "touch started; while [ ! -f release ]; do sleep .05; done")];
  const running = f.scheduler.runNow(TASK), dir = path.join(f.root, ".codeflowai/scheduled-tasks");
  await waitFor(() => fs.existsSync(path.join(dir, "started")));
  t.mock.method(Date, "now", () => minute + 65000);
  let skippedRun: ClientScheduledTaskReportRequestBody["run"] | undefined;
  f.remote.onReport = async body => { if (body.run?.status === "skipped") {
    skippedRun = body.run;
    const other = openClientDb({ dbPath: f.file });
    try { assert.equal(other.scheduledTaskRuns.getAccount(body.run.id, OWNER)?.status, "skipped");
      assert.ok(other.scheduledTaskRuntimeStates.get(scheduledTaskAccountRuntimeKey(TASK, OWNER))?.runningRunId); }
    finally { other.close(); }
  } };
  await f.scheduler.syncAndTick("skip-while-running");
  assert.ok(skippedRun); assert.equal(f.db.scheduledTaskRuns.getAccount(skippedRun.id, OWNER)?.reportSettlement, "acknowledged");
  fs.writeFileSync(path.join(dir, "release"), "ok"); await running;
}));

test("同用户另一 origin 的 pending 不会被当前 Server 补报或删除结算", async t => fixture(t, async f => {
  const otherOwner = { ...OWNER, serverOrigin: "https://other.test" }, now = Date.now();
  const run: ScheduledTaskRun = { id: "other-origin-run", taskId: TASK, clientId: CLIENT, deviceId: DEVICE, workspaceId: null,
    workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null, scheduledAt: now, startedAt: now, finishedAt: null,
    status: "running", triggerSource: "manual", attempt: 1, durationMs: null, summary: "started", errorMessage: null, outputExcerpt: null, createdAt: now };
  f.db.scheduledTaskRuns.createAccount({ run, owner: otherOwner, taskName: "other" });
  f.db.scheduledTaskRuns.completeAccount({ ...run, status: "success", finishedAt: now + 1, durationMs: 1 }, otherOwner);
  f.remote.tasks = []; f.remote.terminalFails = false; await f.scheduler.sync("current-origin-empty");
  assert.equal(f.reports.some(body => body.run?.id === run.id), false);
  assert.equal(f.db.scheduledTaskRuns.getAccount(run.id, otherOwner)?.reportSettlement, null);
}));

test("终态 COMMIT 先于 HTTP，本地 ACK 故障保 pending 并同事实重发", async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  f.remote.onReport = async body => { if (body.run?.status === "success") {
    const other = openClientDb({ dbPath: f.file });
    try { assert.equal(other.scheduledTaskRuns.getAccount(body.run.id, OWNER)?.status, "success"); }
    finally { other.close(); }
  } };
  f.db.db.exec("CREATE TRIGGER ack_fail BEFORE UPDATE OF report_settlement ON scheduled_task_runs WHEN NEW.report_settlement='acknowledged' BEGIN SELECT RAISE(ABORT,'private ack failure'); END");
  await assert.rejects(f.scheduler.runNow(TASK));
  assert.equal(f.db.scheduledTaskRuns.listPendingAccount(OWNER).length, 1);
  const first = f.reports.find(body => body.run?.status === "success")!.run;
  f.db.db.exec("DROP TRIGGER ack_fail"); await f.scheduler.sync("ack-retry");
  assert.deepEqual(f.reports.filter(body => body.run?.status === "success").map(body => body.run), [first, first]);
  assert.equal(f.db.scheduledTaskRuns.listPendingAccount(OWNER).length, 0);
}));

for (const failure of ["history", "runtime"] as const) test(`终态事务${failure}故障整体回滚、保 running 且零 terminal HTTP`, async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  f.db.db.exec(failure === "history"
    ? "CREATE TRIGGER terminal_fail BEFORE UPDATE OF status ON scheduled_task_runs BEGIN SELECT RAISE(ABORT,'private terminal failure'); END"
    : "CREATE TRIGGER terminal_fail BEFORE UPDATE OF running_run_id ON scheduled_task_runtime_states WHEN NEW.running_run_id IS NULL BEGIN SELECT RAISE(ABORT,'private runtime failure'); END");
  await assert.rejects(f.scheduler.runNow(TASK));
  const rows = f.db.db.prepare("SELECT * FROM scheduled_task_runs").all() as Array<Record<string, unknown>>;
  assert.equal(rows[0]?.status, "running"); assert.equal(f.db.scheduledTaskRuntimeStates.get(scheduledTaskAccountRuntimeKey(TASK, OWNER))?.runningRunId, rows[0]?.id);
  assert.equal(f.reports.some(body => body.run && body.run.status !== "running"), false);
}));

test("完整快照缺失旧 pending 永不补报，同 ID 重新分配只执行新 run", async t => fixture(t, async f => {
  await assert.rejects(f.scheduler.runNow(TASK)); const old = f.db.scheduledTaskRuns.listPendingAccount(OWNER)[0]!;
  f.remote.tasks = []; f.remote.terminalFails = false; await f.scheduler.sync("deleted");
  assert.equal(f.db.scheduledTaskRuns.getAccount(old.id, OWNER)?.reportSettlement, "task_deleted");
  const terminalCount = f.reports.filter(body => body.run?.status === "success").length;
  f.remote.tasks = [task()]; const fresh = await f.scheduler.runNow(TASK); assert.notEqual(fresh.id, old.id);
  assert.equal(f.reports.filter(body => body.run?.status === "success").length, terminalCount + 1);
  assert.equal(f.db.scheduledTaskRuns.getAccount(fresh.id, OWNER)?.reportSettlement, "acknowledged");
}));

test("坏完整快照不能结算删除，停用项仍可补报", async t => fixture(t, async f => {
  await assert.rejects(f.scheduler.runNow(TASK)); const old = f.db.scheduledTaskRuns.listPendingAccount(OWNER)[0]!;
  f.remote.tasks = [task(), task()]; await assert.rejects(f.scheduler.sync("duplicate-snapshot"));
  assert.equal(f.db.scheduledTaskRuns.getAccount(old.id, OWNER)?.reportSettlement, null);
  f.remote.tasks = [{ ...task(), enabled: false }]; f.remote.terminalFails = false; await f.scheduler.sync("disabled");
  assert.equal(f.db.scheduledTaskRuns.getAccount(old.id, OWNER)?.reportSettlement, "acknowledged");
}));

test("配置变型不能绕过原 account running，重启孤儿不重演脚本", async t => fixture(t, async f => {
  f.remote.terminalFails = false;
  f.db.db.exec("CREATE TRIGGER terminal_fail BEFORE UPDATE OF status ON scheduled_task_runs BEGIN SELECT RAISE(ABORT,'private terminal failure'); END");
  await assert.rejects(f.scheduler.runNow(TASK));
  f.remote.tasks = [{ ...task(), taskType: "workflow", payload: { workflowId: "workflow-1", contextWorkspaceId: "workspace-1" } }];
  await assert.rejects(f.scheduler.runNow(TASK), { code: "SCHEDULED_TASK_ORPHAN_RUNNING" });
  assert.equal(f.reports.filter(body => body.run?.status === "running").length, 1);
}));

test("同 taskId 另账号不消费旧 owner pending，恢复原 owner 才补报", async t => fixture(t, async f => {
  await assert.rejects(f.scheduler.runNow(TASK)); const old = f.db.scheduledTaskRuns.listPendingAccount(OWNER)[0]!;
  f.remote.terminalFails = false; f.identity.user = "owner-B"; f.identity.generation++;
  f.remote.tasks = [{ ...task(), ownerUserId: "owner-B" }]; await f.scheduler.sync("owner-B");
  assert.equal(f.db.scheduledTaskRuns.getAccount(old.id, OWNER)?.reportSettlement, null);
  assert.equal(f.reports.filter(body => body.run?.status === "success").length, 1);
  f.identity.user = USER; f.identity.generation++; f.remote.tasks = [task()]; await f.scheduler.sync("owner-A-return");
  assert.equal(f.db.scheduledTaskRuns.getAccount(old.id, OWNER)?.reportSettlement, "acknowledged");
}));

for (const workspace of [false,true]) for (const stage of ["terminal-http", "ack-storage", "stale"] as const) test(`原手动处理边界${workspace?"工作区":"无工作区"}只记录一次安全账号关联：${stage}`, async t => fixture(t, async f => {
  const location=workspace?useWorkspace(f):null;
  const logs: unknown[][] = [], sent: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { logs.push(args); });
  if (location) t.mock.method(f.db, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: Parameters<typeof f.db.writeWorkspaceLog>[1]) => {
    assert.equal(workspaceId, location.id); if (entry.level === "error") logs.push([entry.tag, entry.message, entry.data]);
  });
  if (stage === "ack-storage") {
    f.remote.terminalFails = false;
    f.db.withAccountScheduledTasks(location?.id??null,repos=>repos.db.exec("CREATE TRIGGER ack_fail BEFORE UPDATE OF report_settlement ON scheduled_task_runs WHEN NEW.report_settlement='acknowledged' BEGIN SELECT RAISE(ABORT,'SECRET_RESULT_BODY'); END"));
  }
  if (stage === "stale") f.remote.onReport = async body => { if (body.run?.status === "running") f.identity.current = false; };
  const context = { scheduledTaskScheduler: f.scheduler, clientId: CLIENT, deviceId: DEVICE, send: (message: unknown) => { sent.push(message); } } as unknown as ApiHandlerContext;
  await handleScheduledTaskRunNow(context, { t: "api.req", id: "account-failure-request", method: "scheduledTasks.runNow", path: "/account", body: { taskId: TASK } });
  assert.equal((sent[0] as { status: number }).status, 500); assert.equal(logs.length, 1);
  const fields = logs[0]?.[2] as { rootCause: ReturnType<typeof toErrorLog>["error"] };
  assert.equal(fields.rootCause.ownerUserId, USER); assert.equal(fields.rootCause.serverOrigin, ORIGIN);
  assert.equal(fields.rootCause.clientId, CLIENT); assert.equal(fields.rootCause.deviceId, DEVICE); assert.equal(fields.rootCause.taskId, TASK);
  if(location)assert.equal(fields.rootCause.workspaceId,location.id);
  assert.ok(fields.rootCause.runId); assert.ok(fields.rootCause.requestId); assert.ok(fields.rootCause.stage);
  for (const secret of ["fixture-key", "SECRET_RESULT_BODY", "WriteAllText", "controlled lost response"]) assert.equal(JSON.stringify(logs).includes(secret), false);
}));

for(const change of ["missing","settled"] as const) test(`D08 待报候选${change}重核实际历史且零terminal HTTP`,async t=>fixture(t,async f=>{
  const w=useWorkspace(f);await assert.rejects(f.scheduler.runNow(TASK));f.remote.terminalFails=false;
  const native=f.db.listPendingAccountScheduledTaskRuns.bind(f.db),before=f.reports.filter(body=>body.run?.status==="success").length;
  t.mock.method(f.db,"listPendingAccountScheduledTaskRuns",(...args:Parameters<typeof native>)=>{
    const candidates=native(...args);
    if(candidates.length)f.db.withAccountScheduledTasks(w.id,repos=>{
      if(change==="missing")repos.db.prepare("DELETE FROM scheduled_task_runs WHERE id=?").run(candidates[0]!.run.id);
      else repos.runs.acknowledgeAccount(candidates[0]!.run.id,OWNER,Date.now());
    });
    return candidates;
  });
  if(change==="missing")await assert.rejects(f.scheduler.sync("missing-pending-history"),{code:"SCHEDULED_TASK_RUN_STORAGE_FAILED"});
  else await f.scheduler.sync("settled-pending-history");
  assert.equal(f.reports.filter(body=>body.run?.status==="success").length,before);
}));

test("账号 running 回执失败不派发脚本并耐久保存派发前失败", async t => fixture(t, async f => {
  f.remote.runningFails = true;
  await assert.rejects(f.scheduler.runNow(TASK));
  assert.equal(fs.existsSync(path.join(f.root, ".codeflowai/scheduled-tasks/executed")), false);
  const rows = f.db.db.prepare("SELECT * FROM scheduled_task_runs WHERE task_id = ?").all(TASK) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, "派发前失败仍须留耐久历史");
  assert.equal(rows[0]?.status, "failed");
}));
