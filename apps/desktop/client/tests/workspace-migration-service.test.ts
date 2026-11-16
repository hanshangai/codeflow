import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { WorkspaceId } from "@codeflowai/shared";

import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import { openSqliteDb } from "../src/db/sqliteDb.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";
import { WorkspacePathIndexService } from "../src/fs/workspacePathIndexService.ts";
import { WorkspaceMigrationIndexCoordinatorService } from "../src/workspace-migration/workspaceMigrationIndexCoordinator.ts";
import { createWorkspaceMigrationRuntimeCallbacks } from "../src/workspace-migration/workspaceMigrationRuntimeCallbacks.ts";
import type { WorkspaceDirectoryMigrationRecord } from "../src/db/repos/workspaceDirectoryMigrationRepo.ts";
import { logger } from "../src/logger.ts";
import type { StorageClassifier } from "../src/workspace-migration/storageClassifier.ts";
import { WorkspaceMigrationActivityInspector } from "../src/workspace-migration/workspaceMigrationActivityInspector.ts";
import {
  WorkspaceMigrationService,
  recoverWorkspaceMigrationsBeforeMap,
} from "../src/workspace-migration/workspaceMigrationService.ts";
import {
  WorkspaceMigrationFileClientError,
  WorkspaceMigrationFileWorkerClient,
} from "../src/workspace-migration/workspaceMigrationFileWorkerClient.ts";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.ts";
import { toWorkspaceDirectoryMigrationOperation } from "../src/workspace-migration/workspaceMigrationView.ts";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { handleWorkspacePrefsGet, handleWorkspacePrefsSave } from "../src/app/handlers/workspacePrefsHandlers.ts";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import type { ClientConfig } from "../src/config.js";
import type { LocalScheduledTaskConfigInput } from "@codeflowai/shared";
import { terminateCliProcessTree } from "../src/app/handlers/engineHandlers.js";

test("真实Writer启用时目录迁移预检与取消逐段准入，文件Worker等待不持许可", async () => {
  const ctx = setup(), writer = new ClientDbWriterService({ dbPath: path.join(ctx.root, "client.db"), db: ctx.db, workspaceOperationGate: ctx.gate, onFatalError(error) { assert.fail(String(error)); } });
  const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate,
    withLegacyDatabase: <T>(requestId: string, operation: () => T) => writer.withLegacyDatabase(requestId, operation),
    activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(),
    indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) }, workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    onOperationChanged(operation) { ctx.db.workspaceDirectoryMigrations.require(operation.operationId); },
    queueDispatcher: { resumeWorkspace() { ctx.db.workspaces.get(ctx.workspaceId); } },
  });
  try {
    await writer.ready();
    const prepared = await service.prepare({ requestId: "writer-migration", workspaceId: ctx.workspaceId, idempotencyKey: "writer-migration", targetParentPath: ctx.targetParentPath, targetDirectoryName: "migrated" });
    await service.waitForIdle(prepared.operationId);
    assert.equal(await writer.withLegacyDatabase("verify-preflight", () => ctx.db.workspaceDirectoryMigrations.require(prepared.operationId).state), "awaiting_confirmation");
    const cancelled = await service.cancel({ requestId: "writer-cancel", operationId: prepared.operationId });
    assert.equal(cancelled.state, "cancelled");
    const retry = await service.prepare({ requestId: "writer-migration-retry", workspaceId: ctx.workspaceId, idempotencyKey: "writer-migration-retry", targetParentPath: ctx.targetParentPath, targetDirectoryName: "migrated" });
    await service.waitForIdle(retry.operationId);
    const accepted = await writer.withLegacyDatabase("accept-migration", () => service.prepareStartAttempt({ operationId: retry.operationId,
      startAttemptId: "writer-attempt", externalWritesPausedConfirmed: true, targetNotSyncManagedConfirmed: true }));
    await writer.withLegacyDatabase("execute-migration", () => service.executeStart({ requestId: "writer-execute", operationId: accepted.operationId,
      startAttemptId: "writer-attempt", expectedStateVersion: accepted.stateVersion }));
    await service.waitForIdle(accepted.operationId);
    const completed = await writer.withLegacyDatabase("verify-completed", () => ctx.db.workspaceDirectoryMigrations.require(accepted.operationId));
    assert.equal(completed.state, "completed", JSON.stringify(completed.errorDetails) + completed.errorMessage);
    assert.equal(await writer.withLegacyDatabase("verify-path", () => ctx.db.workspaces.get(ctx.workspaceId)?.path), ctx.targetPath);
  } finally { await service.stopAndDrain(); await writer.close(); ctx.close(); }
});

test("真实Writer启用时人工恢复保留文件验证owner并逐段提交目标路径", async () => {
  const ctx = setup();
  let operation = await seedTargetReadyOperation(ctx, "writer-recover");
  operation = ctx.db.workspaceDirectoryMigrations.transitionState({ operationId: operation.operationId, expectedState: "target_ready",
    expectedStateVersion: operation.stateVersion, nextState: "recovery_required", now: 10 });
  const writer = new ClientDbWriterService({ dbPath: path.join(ctx.root, "client.db"), db: ctx.db, workspaceOperationGate: ctx.gate, onFatalError(error) { assert.fail(String(error)); } });
  const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate,
    withLegacyDatabase: <T>(requestId: string, operation: () => T) => writer.withLegacyDatabase(requestId, operation),
    activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(),
    indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) }, workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
  });
  try {
    await writer.ready();
    await writer.withLegacyDatabase("restore-recovery-owner", () => service.restoreExclusiveLocks());
    const recovered = await service.recover({ requestId: "writer-recover", operationId: operation.operationId });
    assert.equal(recovered.state, "completed");
    assert.equal(await writer.withLegacyDatabase("verify-recovery-path", () => ctx.db.workspaces.get(ctx.workspaceId)?.path), ctx.targetPath);
  } finally { await service.stopAndDrain(); await writer.close(); ctx.close(); }
});

test("迁移prepare等待许可时关闭沿原running排空，不创建迟到操作", async () => {
  const ctx = setup();
  let allow!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { allow = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate,
    withLegacyDatabase: async <T>(_requestId: string, operation: () => T) => { entered(); await gate; return operation(); },
    activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(),
    indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) }, workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
  });
  try {
    const preparing = service.prepare({ requestId: "close-pending-prepare", workspaceId: ctx.workspaceId, idempotencyKey: "close-pending-prepare", targetParentPath: ctx.targetParentPath, targetDirectoryName: "migrated" });
    const prepared = Promise.allSettled([preparing]);
    await waiting;
    let drained = false;
    const closing = service.stopAndDrain().then(() => { drained = true; });
    const closed = Promise.allSettled([closing]);
    await new Promise(resolve => setImmediate(resolve));
    const finishedEarly = drained;
    allow();
    const result = (await prepared)[0]!;
    const closingResult = (await closed)[0]!;
    assert.equal(finishedEarly, false);
    assert.equal(result.status, "rejected");
    assert.equal(closingResult.status, "rejected", "关闭owner仍需显式交付已接收prepare的取消结果");
    assert.equal(ctx.db.workspaceDirectoryMigrations.listActive().length, 0);
  } finally { allow(); await Promise.allSettled([service.stopAndDrain()]); ctx.close(); }
});

test("真实Writer与索引生命周期在迁移独占前排空，提交后原generation在目标完成", async () => {
  const ctx = setup(), workspaces = new Map([[ctx.workspaceId, ctx.sourcePath]]);
  ctx.db.configureWorkspaceLogResolver(id => workspaces.get(id) ?? null);
  const writer = new ClientDbWriterService({ dbPath: path.join(ctx.root, "client.db"), db: ctx.db, workspaceOperationGate: ctx.gate, onFatalError(error) { assert.fail(String(error)); } });
  const withLegacyDatabase = <T>(requestId: string, operation: () => T) => writer.withLegacyDatabase(requestId, operation);
  const pathIndex = new WorkspacePathIndexService({ warmupDelayMs: 0, writeWorkspaceLog: (id, entry) => ctx.db.writeWorkspaceLog(id, entry) });
  const coordinator = new WorkspaceMigrationIndexCoordinatorService({ db: ctx.db, pathIndex, withLegacyDatabase, timeoutCheckIntervalMs: 0 });
  const hooks = createWorkspaceMigrationRuntimeCallbacks({ db: ctx.db, gate: ctx.gate, withLegacyDatabase, pathIndex,
    sessions: { async disposeThread() {} }, onWorkspacesChanged() {} });
  const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate, withLegacyDatabase, workspaces, ...hooks,
    activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(), indexCoordinator: coordinator });
  try {
    await writer.ready();
    pathIndex.scheduleWarmup(workspaces);
    const operation = await service.prepare({ requestId: "writer-index-migration", workspaceId: ctx.workspaceId, idempotencyKey: "writer-index-migration", targetParentPath: ctx.targetParentPath, targetDirectoryName: "migrated" });
    await service.waitForIdle(operation.operationId);
    const accepted = await withLegacyDatabase("accept-index-migration", () => service.prepareStartAttempt({ operationId: operation.operationId,
      startAttemptId: "writer-index-attempt", externalWritesPausedConfirmed: true, targetNotSyncManagedConfirmed: true }));
    await withLegacyDatabase("execute-index-migration", () => service.executeStart({ requestId: "writer-index-execute", operationId: accepted.operationId,
      startAttemptId: "writer-index-attempt", expectedStateVersion: accepted.stateVersion }));
    await service.waitForIdle(accepted.operationId);
    await pathIndex.waitForIdle();
    await coordinator.waitForIdle();
    const final = await withLegacyDatabase("verify-index-migration", () => ctx.db.workspaceDirectoryMigrations.require(operation.operationId));
    assert.equal(final.state, "completed", final.errorMessage ?? "迁移未完成");
    assert.equal(final.indexRebuildStatus, "ready");
    assert.equal(workspaces.get(ctx.workspaceId), ctx.targetPath);
  } finally { await service.stopAndDrain(); await coordinator.dispose(); await pathIndex.dispose(); await writer.close(); ctx.close(); }
});

test("D18 原 Service 长复制跨三次 tick 的 queue/skip 三表随最终交接进入目标",async t=>{
  const ctx=setup(),workspaces=new Map([[ctx.workspaceId,ctx.sourcePath]]);
  const api={db:ctx.db,clientId:"client",deviceId:"device",localWorkspaceOnly:true,workspaces,workspaceOperationGate:ctx.gate} as unknown as ApiHandlerContext;
  let clock=1_800_000_005_000;t.mock.method(Date,"now",()=>clock);
  const scheduler=new ScheduledTaskScheduler({config:{clientId:"client",serverWsUrl:"ws://127.0.0.1:1/ws"} as ClientConfig,deviceId:"device",apiContext:api,localApiContext:api});
  let copied!:()=>void,continueCopy!:()=>void;const reachedCopy=new Promise<void>(resolve=>{copied=resolve;}),released=new Promise<void>(resolve=>{continueCopy=resolve;});
  const realWorker=new WorkspaceMigrationFileWorkerClient();
  /** 真实 copy/Worker exit 后暂停服务消费结果，让原 tick 跨多个业务分钟。 */
  const worker=new Proxy(realWorker,{get(target,property,receiver){
    if(property==="copy")return(...args:Parameters<WorkspaceMigrationFileWorkerClient["copy"]>)=>{
      const task=target.copy(...args);return{...task,promise:task.promise.then(async result=>{await task.closed;copied();await released;return result;})};
    };
    const value=Reflect.get(target,property,receiver);return typeof value==="function"?value.bind(target):value;
  }});
  const service=new WorkspaceMigrationService({db:ctx.db,gate:ctx.gate,workspaces,fileWorker:worker,
    activityInspector:new WorkspaceMigrationActivityInspector({db:ctx.db,gate:ctx.gate,scheduledTaskScheduler:scheduler}),
    storageClassifier:createStorageClassifier(),indexCoordinator:{reserveForMigration:async()=>({kind:"not_applicable"})}});
  try{
    for(const policy of ["queue_one","skip_if_running"] as const){
      const config:LocalScheduledTaskConfigInput={id:policy,source:"local",clientId:"client",deviceId:"device",workspaceScope:{scopeType:"local_workspace",scopeId:ctx.workspaceId},
        name:policy,description:null,taskType:"script",cronExpr:"* * * * *",timezone:"UTC",enabled:true,payload:{shell:process.platform==="win32"?"powershell":"sh",command:"exit 0",contextWorkspaceId:ctx.workspaceId},
        concurrencyPolicy:policy,missedPolicy:"skip_missed",timeoutMs:10_000};
      ctx.db.withLocalScheduledTasks(ctx.workspaceId,repos=>repos.configs.create({config,at:1}));
    }
    const prepared=await prepareAcceptedInput(service,ctx,"scheduled-three-ticks");
    service.executeStart({requestId:"scheduled-copy",operationId:prepared.operationId,startAttemptId:"attempt-scheduled-three-ticks",expectedStateVersion:prepared.stateVersion});
    await reachedCopy;
    for(let i=0;i<3;i++){clock=1_800_000_005_000+i*60_000;await scheduler.syncAndTick("copy-tick");}
    assert.equal(ctx.db.getLocalScheduledTaskRuntime(ctx.db.getLocalScheduledTask("queue_one")!)?.queuedScheduledAt,1_800_000_000_000);
    assert.equal(ctx.db.listLocalScheduledTaskRuns({clientId:"client",deviceId:"device",offset:0,limit:50}).total,3);
    continueCopy();await service.waitForIdle(prepared.operationId);
    assert.equal(ctx.db.workspaceDirectoryMigrations.require(prepared.operationId).state,"completed");assert.equal(workspaces.get(ctx.workspaceId),ctx.targetPath);
    await scheduler.syncAndTick("after-copy");await scheduler.waitForInFlightWork();
    const history=ctx.db.listLocalScheduledTaskRuns({clientId:"client",deviceId:"device",offset:0,limit:50});
    assert.equal(history.items.filter(run=>run.taskId==="queue_one").length,1);assert.equal(history.items.filter(run=>run.taskId==="skip_if_running").length,3);
    const target=openSqliteDb(path.join(ctx.targetPath,".codeflowai","workspace.db"),{readonly:true,fileMustExist:true});
    try{assert.equal((target.prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs").get() as {n:number}).n,4);}finally{target.close();}
  }finally{continueCopy();await service.stopAndDrain();await scheduler.stopAndDrain();ctx.close();}
});

/** 两个独立进程分别在通知屏障后关库退出和冷恢复；不加载完整桌面启动入口。 */
async function runScheduledTaskHandoffProcess(root: string, phase: "seed" | "recover"): Promise<{ pid: number; phase: string; proof: unknown }> {
  const entry=path.join(root,"scheduled-handoff-process.mjs");
  if(phase==="seed"){
    fs.symlinkSync(fileURLToPath(new URL("../node_modules",import.meta.url)),path.join(root,"node_modules"),"junction");
    fs.writeFileSync(entry,`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openClientDb } from ${JSON.stringify(new URL("../src/db/clientDb.ts",import.meta.url).href)};
import { openSqliteDb } from ${JSON.stringify(new URL("../src/db/sqliteDb.ts",import.meta.url).href)};
import { WorkspaceOperationGate } from ${JSON.stringify(new URL("../src/workspace-migration/workspaceOperationGate.ts",import.meta.url).href)};
import { WorkspaceMigrationService, recoverWorkspaceMigrationsBeforeMap } from ${JSON.stringify(new URL("../src/workspace-migration/workspaceMigrationService.ts",import.meta.url).href)};
import { WorkspaceMigrationActivityInspector } from ${JSON.stringify(new URL("../src/workspace-migration/workspaceMigrationActivityInspector.ts",import.meta.url).href)};
import { ScheduledTaskScheduler } from ${JSON.stringify(new URL("../src/scheduled-tasks/scheduledTaskScheduler.ts",import.meta.url).href)};
import { executeDesktopApiRequest } from ${JSON.stringify(new URL("../src/app/executeDesktopApiRequest.ts",import.meta.url).href)};
const [phase,root]=process.argv.slice(2),source=path.join(root,'source'),parent=path.join(root,'target-parent'),target=path.join(parent,'migrated');
const workspaceId='client:workspace',gate=new WorkspaceOperationGate(),db=openClientDb({dbPath:path.join(root,'client.db'),workspaceOperationGate:gate});
const sourceFile=path.join(source,'.codeflowai','workspace.db'),checkpoint=path.join(root,'handoff-checkpoint.json');
Date.now=()=>1_800_000_005_000;
let http=0;globalThis.fetch=async()=>{http++;throw new Error('LOCAL_HTTP_FORBIDDEN');};
const storageClassifier={assertSupportedTarget:async realPath=>({platform:process.platform,realPath,mountPoint:path.parse(realPath).root,fileSystemType:process.platform==='win32'?'ntfs':'ext4',deviceIds:['test-device'],busTypes:['test-bus']})};
const workspaces=new Map(db.workspaces.list().map(item=>[item.id,item.path]));
const api={db,clientId:'client',deviceId:'device',localWorkspaceOnly:true,workspaces,workspaceOperationGate:gate};
const scheduler=new ScheduledTaskScheduler({config:{clientId:'client',serverWsUrl:'ws://127.0.0.1:1/ws'},deviceId:'device',apiContext:api,localApiContext:api});api.scheduledTaskScheduler=scheduler;
// 只比较三表必要事实，避免把配置正文带入进程诊断。
const tableFacts=file=>{const reader=openSqliteDb(file,{readonly:true,fileMustExist:true});try{return {
  configs:reader.prepare('SELECT id,revision,enabled FROM scheduled_task_configs ORDER BY id').all(),
  runs:reader.prepare('SELECT id,task_id,status,scheduled_at FROM scheduled_task_runs ORDER BY id').all(),
  runtime:reader.prepare('SELECT task_id,last_scheduled_at,running_run_id,queued_scheduled_at,queued_operation_id FROM scheduled_task_runtime_states ORDER BY task_id').all(),
};}finally{reader.close();}};
// 源库字节不能因交接后的目标写入或冷恢复而变化。
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let proof;
if(phase==='seed'){
  for(const policy of ['queue_one','skip_if_running'])db.withLocalScheduledTasks(workspaceId,repos=>repos.configs.create({at:1,config:{
    id:policy,source:'local',clientId:'client',deviceId:'device',workspaceScope:{scopeType:'local_workspace',scopeId:workspaceId},name:policy,description:null,taskType:'script',
    cronExpr:'* * * * *',timezone:'UTC',enabled:true,payload:{contextWorkspaceId:workspaceId,shell:process.platform==='win32'?'powershell':'sh',command:'exit 0'},
    concurrencyPolicy:policy,missedPolicy:'skip_missed',timeoutMs:10000}}));
  let committed;const reached=new Promise(resolve=>{committed=resolve;}),blocked=new Promise(()=>{});
  const service=new WorkspaceMigrationService({db,gate,workspaces,storageClassifier,indexCoordinator:{reserveForMigration:async()=>({kind:'not_applicable'})},
    activityInspector:new WorkspaceMigrationActivityInspector({db,gate,scheduledTaskScheduler:scheduler}),onCommittedPath:async()=>{committed();await blocked;}});
  const prepared=await service.prepare({requestId:'f1-target',workspaceId,idempotencyKey:'f1-target',targetParentPath:parent,targetDirectoryName:'migrated'});
  await service.waitForIdle(prepared.operationId);const scanned=db.workspaceDirectoryMigrations.require(prepared.operationId);
  assert.equal(scanned.state,'awaiting_confirmation',JSON.stringify(scanned));
  const accepted=service.prepareStartAttempt({operationId:prepared.operationId,startAttemptId:'f1-target-attempt',externalWritesPausedConfirmed:true,targetNotSyncManagedConfirmed:true});
  service.executeStart({requestId:'f1-target',operationId:accepted.operationId,startAttemptId:'f1-target-attempt',expectedStateVersion:accepted.stateVersion});
  await Promise.race([reached,service.waitForIdle(accepted.operationId).then(()=>{throw new Error('F1_COMMIT_BARRIER_NOT_REACHED');})]);
  assert.equal(db.workspaceDirectoryMigrations.require(accepted.operationId).state,'finalizing');
  assert.equal(db.workspaces.get(workspaceId).path,target);assert.equal(workspaces.get(workspaceId),target);
  assert.equal(gate.getMigrationOperationId(workspaceId),accepted.operationId);await gate.waitForFinalHandoff(workspaceId);
  const sourceHash=hash(sourceFile),sourceBefore=tableFacts(sourceFile);
  for(const action of ['setEnabled','runNow']){
    let original;
    await assert.rejects(executeDesktopApiRequest(api,{method:'scheduledTasks.local.'+action,body:{taskId:'queue_one',...(action==='setEnabled'?{expectedRevision:1,enabled:false}:{})}},
      {requestId:'f1-gate-'+action,clientVersion:'1.0.0',startedAt:1}),error=>{
      assert.ok(error instanceof AggregateError);assert.equal(error.code,'SCHEDULED_TASK_REQUEST_LOG_FAILED');
      original=error.errors[0];assert.equal(original.code,'WORKSPACE_MIGRATION_IN_PROGRESS');assert.equal(error.errors[1].code,'WORKSPACE_MIGRATION_IN_PROGRESS');return true;
    });
    if(action==='runNow')await assert.rejects(scheduler.waitForInFlightWork(),error=>error===original);
  }
  await scheduler.syncAndTick('committed-notification-await');await scheduler.waitForInFlightWork();
  const targetFacts=tableFacts(path.join(target,'.codeflowai','workspace.db'));
  assert.equal(targetFacts.configs.length,2);assert.equal(targetFacts.runs.length,1);assert.equal(targetFacts.runs[0].status,'skipped');
  assert.equal(targetFacts.runtime.length,2);assert.equal(targetFacts.runtime.find(row=>row.queued_scheduled_at!==null).queued_scheduled_at,1_800_000_000_000);
  assert.equal(targetFacts.runtime.find(row=>row.queued_scheduled_at!==null).queued_operation_id,accepted.operationId);
  assert.equal(sourceBefore.runs.length,0);assert.equal(sourceBefore.runtime.length,0);assert.deepEqual(tableFacts(sourceFile),sourceBefore);assert.equal(hash(sourceFile),sourceHash);
  fs.writeFileSync(checkpoint,JSON.stringify({operationId:accepted.operationId,sourceHash,sourceBefore,targetFacts,pid:process.pid})+'\\n','utf8');
  proof={operationId:accepted.operationId,owner:gate.getMigrationOperationId(workspaceId),sourceHash,sourceBefore,targetFacts,crudFailure:'SCHEDULED_TASK_REQUEST_LOG_FAILED',manualFailure:'SCHEDULED_TASK_REQUEST_LOG_FAILED'};
}else{
  const saved=JSON.parse(fs.readFileSync(checkpoint,'utf8'));assert.notEqual(process.pid,saved.pid);
  assert.equal(db.workspaceDirectoryMigrations.require(saved.operationId).state,'finalizing');
  const recovery=await recoverWorkspaceMigrationsBeforeMap({db,requestId:'f1-cold-recovery',storageClassifier});assert.deepEqual(recovery.blockedWorkspaceIds,[]);
  assert.equal(db.workspaces.get(workspaceId).path,target);assert.deepEqual(tableFacts(path.join(target,'.codeflowai','workspace.db')),saved.targetFacts);
  const service=new WorkspaceMigrationService({db,gate,workspaces,storageClassifier,indexCoordinator:{reserveForMigration:async()=>({kind:'not_applicable'})},
    activityInspector:new WorkspaceMigrationActivityInspector({db,gate,scheduledTaskScheduler:scheduler})});
  service.restoreExclusiveLocks();assert.equal(gate.getMigrationOperationId(workspaceId),saved.operationId);
  service.resumeFinalization('f1-cold-finalize');await service.waitForIdle(saved.operationId);assert.equal(db.workspaceDirectoryMigrations.require(saved.operationId).state,'completed');
  await scheduler.syncAndTick('f1-cold-tick');await scheduler.waitForInFlightWork();
  await scheduler.syncAndTick('f1-same-minute');await scheduler.waitForInFlightWork();
  const history=db.listLocalScheduledTaskRuns({clientId:'client',deviceId:'device',offset:0,limit:50});assert.equal(history.total,2);
  assert.deepEqual(history.items.map(run=>[run.taskId,run.status,run.scheduledAt]).sort(),[['queue_one','success',1_800_000_000_000],['skip_if_running','skipped',1_800_000_000_000]]);
  const task=db.getLocalScheduledTask('queue_one'),runtime=db.getLocalScheduledTaskRuntime(task);assert.equal(runtime.queuedScheduledAt,null);assert.equal(runtime.runningRunId,null);
  assert.deepEqual(tableFacts(sourceFile),saved.sourceBefore);assert.equal(hash(sourceFile),saved.sourceHash);await service.stopAndDrain();
  proof={seedPid:saved.pid,operationId:saved.operationId,recovered:recovery.blockedWorkspaceIds.length===0,state:db.workspaceDirectoryMigrations.require(saved.operationId).state,
    history:history.items.map(run=>({taskId:run.taskId,status:run.status,scheduledAt:run.scheduledAt})),queuedScheduledAt:runtime.queuedScheduledAt,runningRunId:runtime.runningRunId,sourceHash:hash(sourceFile)};
}
assert.equal(http,0);await scheduler.stopAndDrain();db.close();console.log('D18_F1_RESULT='+JSON.stringify({pid:process.pid,phase,proof}));
`,"utf8");
  }
  const child=spawn(process.execPath,["--conditions=development","--import","tsx",entry,phase,root],{
    env:{...process.env,CODEFLOWAI_CLIENT_LOG_DIR:path.join(root,`${phase}-logs`)},windowsHide:true,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"],
  });
  let stdout="",stderr="";child.stdout.setEncoding("utf8").on("data",value=>{stdout+=value;});child.stderr.setEncoding("utf8").on("data",value=>{stderr+=value;});
  let spawnFailure:unknown,timer:ReturnType<typeof setTimeout>|undefined;
  const closed=new Promise<number|null>(resolve=>{child.once("error",error=>{spawnFailure=error;});child.once("close",resolve);});
  try {
    const outcome=await Promise.race([closed.then(code=>({code})),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),60_000);})]);
    if(outcome===null){
      const timeout=new Error(`F1_${phase}_PROCESS_TIMEOUT`);let cleanupCause:unknown;
      const failure=await terminateCliProcessTree(child,{strictTreeConfirmation:true,timeoutMs:10_000,onFailure:cause=>{cleanupCause=cause;}});
      if(failure!==null)throw Object.assign(new AggregateError([timeout,new Error(failure,{cause:cleanupCause})],"F1_PROCESS_CLEANUP_UNCONFIRMED",{cause:timeout}),
        {resourcePending:true,pid:child.pid,root});
      await closed;throw timeout;
    }
    if(spawnFailure)throw spawnFailure;
    if(outcome.code!==0)throw Object.assign(new Error(`F1 ${phase} process failed: exit=${outcome.code}; ${stderr}\n${stdout}`),{resourcePending:true,pid:child.pid,root});
    const result=stdout.split(/\r?\n/).find(line=>line.startsWith("D18_F1_RESULT="));
    if(!result)throw Object.assign(new Error("F1_PROCESS_COMPLETION_UNCONFIRMED"),{resourcePending:true,pid:child.pid,root});
    return JSON.parse(result.slice("D18_F1_RESULT=".length)) as {pid:number;phase:string;proof:unknown};
  } finally {if(timer!==undefined)clearTimeout(timer);}
}

test("D18 F1 通知 await 只写目标三表，独立进程冷恢复不覆写且队列只执行一次",async t=>{
  const ctx=setup();ctx.db.close();let resourcePending=false;
  try {
    const seed=await runScheduledTaskHandoffProcess(ctx.root,"seed"),recovery=await runScheduledTaskHandoffProcess(ctx.root,"recover");
    assert.notEqual(seed.pid,recovery.pid);assert.equal(seed.phase,"seed");assert.equal(recovery.phase,"recover");
    t.diagnostic(JSON.stringify({seed,recovery}));
  } catch(error){resourcePending=(error as {resourcePending?:boolean}|null)?.resourcePending===true;throw error;}
  finally {if(!resourcePending)fs.rmSync(ctx.root,{recursive:true});}
});

type TestContext = {
  root: string;
  sourcePath: string;
  targetParentPath: string;
  targetPath: string;
  workspaceId: WorkspaceId;
  gate: WorkspaceOperationGate;
  db: ClientDb;
  close: () => void;
};

/** 创建真实临时 Client DB、源目录和目标父目录。 */
function setup(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-workspace-migration-service-"));
  const sourcePath = path.join(root, "source");
  const targetParentPath = path.join(root, "target-parent");
  const targetPath = path.join(targetParentPath, "migrated");
  fs.mkdirSync(path.join(sourcePath, "nested"), { recursive: true });
  fs.mkdirSync(targetParentPath, { recursive: true });
  fs.writeFileSync(path.join(sourcePath, "README.md"), "workspace migration\n", "utf8");
  fs.writeFileSync(path.join(sourcePath, "nested", "data.txt"), "content\n", "utf8");
  const gate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath: path.join(root, "client.db"), workspaceOperationGate: gate });
  const workspaceId = "client:workspace" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "workspace", path: sourcePath });
  return {
    root,
    sourcePath,
    targetParentPath,
    targetPath,
    workspaceId,
    gate,
    db,
    close: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 测试只替换固定磁盘证明，文件能力仍走真实 Worker probe。 */
function createStorageClassifier(): StorageClassifier {
  return {
    assertSupportedTarget: async (targetParentPath: string) => ({
      platform: process.platform,
      realPath: targetParentPath,
      mountPoint: path.parse(targetParentPath).root,
      fileSystemType: process.platform === "win32" ? "ntfs" : "ext4",
      deviceIds: ["test-device"],
      busTypes: ["test-bus"],
    }),
  } as StorageClassifier;
}

/** 创建使用真实 Worker 和 not_applicable 索引终态的服务。 */
function createService(ctx: TestContext, gate = ctx.gate): WorkspaceMigrationService {
  const workspaces = new Map<WorkspaceId, string>([[ctx.workspaceId, ctx.sourcePath]]);
  return new WorkspaceMigrationService({
    db: ctx.db,
    gate,
    activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
    storageClassifier: createStorageClassifier(),
    indexCoordinator: {
      reserveForMigration: async () => ({ kind: "not_applicable" }),
    },
    workspaces,
  });
}

/** 真实 Worker 先返回已取得的结果，保留事件循环直到原取消标记后延迟退出。 */
function resultBeforeExitWorker(ctx: TestContext, result: unknown): WorkspaceMigrationFileWorkerClient {
  const workerPath = path.join(ctx.root, "result-before-exit.cjs");
  fs.writeFileSync(workerPath, [
    "const fs = require('node:fs');",
    "const { parentPort, workerData } = require('node:worker_threads');",
    `parentPort.postMessage({ type: 'result', taskId: workerData.taskId, result: ${JSON.stringify(result)} });`,
    `fs.writeFileSync(${JSON.stringify(path.join(ctx.root, "result-posted"))}, 'posted');`,
    "const timer = setInterval(() => { if (Atomics.load(new Int32Array(workerData.cancelBuffer), 0)) { clearInterval(timer); setTimeout(() => parentPort.close(), 150); } }, 10);",
  ].join("\n"), "utf8");
  return new WorkspaceMigrationFileWorkerClient({ workerPath });
}

/** 等待本夹具的真实 Worker 已发 result，失败保留明确边界。 */
async function waitForPostedResult(ctx: TestContext): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(path.join(ctx.root, "result-posted")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(path.join(ctx.root, "result-posted")));
  await new Promise(resolve => setTimeout(resolve, 30));
}

test("D18 预检 result 早于真实 exit 时 stopAndDrain 仍取消并等待该 Worker", async () => {
  const ctx = setup();
  try {
    const worker = new WorkspaceMigrationFileWorkerClient();
    const scanTask = worker.scan({ sourceRoot: ctx.sourcePath, targetRoot: ctx.targetPath, targetFileSystemType: process.platform === "win32" ? "ntfs" : "ext4", includeContentHashes: false, targetCaseSensitive: process.platform !== "win32" });
    const scan = await scanTask.promise; await scanTask.closed;
    const held = resultBeforeExitWorker(ctx, scan);
    worker.scan = held.scan.bind(held);
    const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate, fileWorker: worker,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) }, workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]) });
    const operation = await service.prepare({ requestId: "preflight-exit", workspaceId: ctx.workspaceId, idempotencyKey: "preflight-exit", targetParentPath: ctx.targetParentPath, targetDirectoryName: "migrated" });
    await waitForPostedResult(ctx);
    assert.equal(ctx.db.workspaceDirectoryMigrations.require(operation.operationId).state, "scanning");
    const started = Date.now(); await service.stopAndDrain();
    assert.ok(Date.now() - started >= 100);
    assert.equal(ctx.db.workspaceDirectoryMigrations.require(operation.operationId).state, "cancelled");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
  } finally { ctx.close(); }
});

test("D18 人工恢复 probe result 早于 exit 时关闭仍跟踪原任务且禁止提交", async () => {
  const ctx = setup();
  try {
    let operation = await seedTargetReadyOperation(ctx, "recovery-exit");
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({ operationId: operation.operationId, expectedState: "target_ready", expectedStateVersion: operation.stateVersion, nextState: "recovery_required", now: 10 });
    const worker = new WorkspaceMigrationFileWorkerClient();
    const probeTask = worker.probe({ targetParent: ctx.targetParentPath, operationToken: operation.operationId, requiresSymlink: false });
    const probe = await probeTask.promise; await probeTask.closed;
    const held = resultBeforeExitWorker(ctx, probe); worker.probe = held.probe.bind(held);
    const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate, fileWorker: worker,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) }, workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]) });
    service.restoreExclusiveLocks();
    const recovering = service.recover({ requestId: "recover-exit", operationId: operation.operationId });
    const rejected = assert.rejects(recovering, /WORKSPACE_MIGRATION_STOPPED/);
    await waitForPostedResult(ctx);
    const started = Date.now(); const draining = assert.rejects(service.stopAndDrain(), /WORKSPACE_MIGRATION_DRAIN_FAILED/);
    await Promise.all([rejected, draining]);
    assert.ok(Date.now() - started >= 100);
    assert.equal(ctx.db.workspaceDirectoryMigrations.require(operation.operationId).state, "recovery_required");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
  } finally { ctx.close(); }
});

/** 把预检操作推进为 prepared，返回当前 stateVersion。 */
async function prepareAcceptedInput(
  service: WorkspaceMigrationService,
  ctx: TestContext,
  key: string,
): Promise<WorkspaceDirectoryMigrationRecord> {
  const operation = await service.prepare({
    requestId: `prepare-${key}`,
    workspaceId: ctx.workspaceId,
    idempotencyKey: key,
    targetParentPath: ctx.targetParentPath,
    targetDirectoryName: "migrated",
  });
  assert.equal(operation.state, "scanning");
  await service.waitForIdle(operation.operationId);
  const scanned = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
  assert.equal(scanned.state, "awaiting_confirmation");
  return service.prepareStartAttempt({
    operationId: scanned.operationId,
    startAttemptId: `attempt-${key}`,
    externalWritesPausedConfirmed: true,
    targetNotSyncManagedConfirmed: true,
  });
}

/** 构造 publish_intent 持久状态及同摘要 staging，供启动恢复矩阵测试。 */
async function seedPublishIntentOperation(ctx: TestContext, operationId: string): Promise<WorkspaceDirectoryMigrationRecord> {
  const worker = new WorkspaceMigrationFileWorkerClient();
  const stagingPath = path.join(ctx.targetParentPath, `.migrated.codeflow-migration-${operationId}`);
  fs.cpSync(ctx.sourcePath, stagingPath, { recursive: true });
  const sourceScan = await worker.scan({
    sourceRoot: ctx.sourcePath,
    targetRoot: ctx.targetPath,
    targetFileSystemType: process.platform === "win32" ? "ntfs" : "ext4",
    includeContentHashes: true,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;
  const stagingScan = await worker.scan({
    sourceRoot: stagingPath,
    targetRoot: stagingPath,
    targetFileSystemType: process.platform === "win32" ? "ntfs" : "ext4",
    includeContentHashes: true,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;
  let operation = ctx.db.workspaceDirectoryMigrations.create({
    operationId,
    idempotencyKey: `key-${operationId}`,
    workspaceId: ctx.workspaceId,
    sourcePath: ctx.sourcePath,
    targetParentPath: ctx.targetParentPath,
    targetPath: ctx.targetPath,
    now: 1,
  }).operation;
  operation = ctx.db.workspaceDirectoryMigrations.transitionState({
    operationId,
    expectedState: "scanning",
    expectedStateVersion: operation.stateVersion,
    nextState: "awaiting_confirmation",
    now: 2,
  });
  operation = ctx.db.workspaceDirectoryMigrations.prepareStartAttempt({
    operationId,
    startAttemptId: `attempt-${operationId}`,
    externalWritesPausedConfirmed: true,
    targetNotSyncManagedConfirmed: true,
    now: 3,
  });
  operation = ctx.db.workspaceDirectoryMigrations.acceptStartAttempt({
    operationId,
    startAttemptId: `attempt-${operationId}`,
    expectedStateVersion: operation.stateVersion,
    now: 4,
  });
  operation = ctx.db.workspaceDirectoryMigrations.updateCurrentState({
    operationId,
    expectedState: "preparing",
    expectedStateVersion: operation.stateVersion,
    patch: {
      stagingPath,
      sourceFileCount: sourceScan.summary.fileCount,
      sourceDirectoryCount: sourceScan.summary.directoryCount,
      sourceTotalBytes: sourceScan.summary.totalBytes,
      excludedDependencyDirectoryCount: sourceScan.summary.excludedDependencyDirectoryCount,
      excludedDependencyDirectories: sourceScan.summary.excludedDependencyDirectories,
      sourceManifestHash: sourceScan.summary.manifestHash,
      terminalCwdSnapshot: {},
    },
    now: 5,
  });
  operation = ctx.db.workspaceDirectoryMigrations.transitionState({
    operationId,
    expectedState: "preparing",
    expectedStateVersion: operation.stateVersion,
    nextState: "copying",
    now: 6,
  });
  operation = ctx.db.workspaceDirectoryMigrations.transitionState({
    operationId,
    expectedState: "copying",
    expectedStateVersion: operation.stateVersion,
    nextState: "verifying",
    now: 7,
  });
  return ctx.db.workspaceDirectoryMigrations.transitionState({
    operationId,
    expectedState: "verifying",
    expectedStateVersion: operation.stateVersion,
    nextState: "publish_intent",
    patch: { verifiedTargetManifestHash: stagingScan.summary.manifestHash },
    now: 8,
  });
}

/** 构造已发布且待提交路径的 target_ready 持久状态。 */
async function seedTargetReadyOperation(ctx: TestContext, operationId: string): Promise<WorkspaceDirectoryMigrationRecord> {
  const operation = await seedPublishIntentOperation(ctx, operationId);
  const stagingPath = operation.stagingPath!;
  fs.renameSync(stagingPath, operation.targetPath);
  for (const relativePath of operation.excludedDependencyDirectories) {
    fs.rmSync(path.join(operation.targetPath, relativePath), { recursive: true, force: true });
  }
  return ctx.db.workspaceDirectoryMigrations.transitionState({
    operationId,
    expectedState: "publish_intent",
    expectedStateVersion: operation.stateVersion,
    nextState: "target_ready",
    now: 9,
  });
}

/** 在首次恢复校验开始时上报条件排除目录结构事件，用于验证旧持久事实不会提前放行。 */
function createConditionalChangeReportingWorker(sourcePath: string, relativePath: string): {
  worker: WorkspaceMigrationFileWorkerClient;
  wasReported: () => boolean;
} {
  const realWorker = new WorkspaceMigrationFileWorkerClient();
  let sourceCallbacks: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>[1] | null = null;
  let reported = false;
  const worker = new Proxy(realWorker, {
    get(target, property, receiver) {
      if (property === "watch") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>) => {
          if (args[0].watchRoot === sourcePath) sourceCallbacks = args[1];
          return {
            taskId: `controlled-watch-${args[0].watchRoot}`,
            ready: Promise.resolve(),
            closed: Promise.resolve(),
            stop: async () => undefined,
            terminate: async () => 0,
          };
        };
      }
      if (property === "verify") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["verify"]>) => {
          if (!reported) {
            assert.ok(sourceCallbacks, "source watcher must be ready before recovery verification");
            sourceCallbacks.onChanged({ eventType: "rename", relativePath });
            reported = true;
          }
          return target.verify(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { worker, wasReported: () => reported };
}

/** 构造源 watcher 故障 Worker，验证恢复不能把监听错误当作真实变更清理目标。 */
function createWatcherFailureWorker(sourcePath: string): WorkspaceMigrationFileWorkerClient {
  const realWorker = new WorkspaceMigrationFileWorkerClient();
  return new Proxy(realWorker, {
    get(target, property, receiver) {
      if (property === "watch") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>) => {
          const [command, callbacks] = args;
          if (command.watchRoot === sourcePath) {
            queueMicrotask(() => callbacks.onError(new WorkspaceMigrationFileClientError(
              "WORKSPACE_MIGRATION_VERIFY_FAILED",
              "源目录监听溢出",
              { reason: "watcher_overflow", sourceChangedPaths: ["C:\\Users\\Free\\secret.txt"] },
            )));
          }
          return {
            taskId: `watcher-failure-${command.watchRoot}`,
            ready: Promise.resolve(),
            closed: Promise.resolve(),
            stop: async () => undefined,
            terminate: async () => 0,
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 在权威源扫描完成后注入结构事件，验证清单未变化时不会误阻止迁移。 */
function createUnchangedSourceRenameWorker(sourcePath: string): WorkspaceMigrationFileWorkerClient {
  const realWorker = new WorkspaceMigrationFileWorkerClient();
  let sourceCallbacks: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>[1] | null = null;
  let reported = false;
  return new Proxy(realWorker, {
    get(target, property, receiver) {
      if (property === "watch") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>) => {
          if (args[0].watchRoot === sourcePath) sourceCallbacks = args[1];
          return target.watch(...args);
        };
      }
      if (property === "copy") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["copy"]>) => {
          if (args[0].sourceRoot === sourcePath && !reported) {
            assert.ok(sourceCallbacks, "source watcher must be ready before copy");
            sourceCallbacks.onChanged({ eventType: "change", relativePath: "README.md" });
            reported = true;
          }
          return target.copy(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 在发布后的最终复核窗口注册另一个 workspace，模拟 commit 前 owner 竞态。 */
function createCommitRootConflictWorker(
  targetPath: string,
  registerConflict: () => void,
): WorkspaceMigrationFileWorkerClient {
  const realWorker = new WorkspaceMigrationFileWorkerClient();
  let publishedVerificationCount = 0;
  return new Proxy(realWorker, {
    get(target, property, receiver) {
      if (property === "verify") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["verify"]>) => {
          if (path.resolve(args[0].targetRoot) === path.resolve(targetPath)) {
            publishedVerificationCount += 1;
            if (publishedVerificationCount === 2) registerConflict();
          }
          return target.verify(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 在已提交目标清单验证完成后注册另一 workspace，覆盖 finalization 前的 owner 竞态。 */
function createCommittedValidationRootConflictWorker(
  targetPath: string,
  registerConflict: () => void,
): WorkspaceMigrationFileWorkerClient {
  const realWorker = new WorkspaceMigrationFileWorkerClient();
  let registered = false;
  return new Proxy(realWorker, {
    get(target, property, receiver) {
      if (property === "scan") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["scan"]>) => {
          const task = target.scan(...args);
          if (registered || path.resolve(args[0].sourceRoot) !== path.resolve(targetPath)) return task;
          return {
            ...task,
            promise: task.promise.then((result) => {
              registerConflict();
              registered = true;
              return result;
            }),
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 在 target_ready 校验期间注入索引库事件，并统计是否触发额外清单复核。 */
function createIndexCacheChangeReportingWorker(sourcePath: string, targetPath: string): {
  worker: WorkspaceMigrationFileWorkerClient;
  scanCount: () => number;
} {
  const realWorker = new WorkspaceMigrationFileWorkerClient();
  let sourceCallbacks: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>[1] | null = null;
  let targetCallbacks: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>[1] | null = null;
  let reported = false;
  let scans = 0;
  const worker = new Proxy(realWorker, {
    get(target, property, receiver) {
      if (property === "watch") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>) => {
          if (args[0].watchRoot === sourcePath) sourceCallbacks = args[1];
          if (args[0].watchRoot === targetPath) targetCallbacks = args[1];
          return {
            taskId: `index-cache-watch-${args[0].watchRoot}`,
            ready: Promise.resolve(),
            closed: Promise.resolve(),
            stop: async () => undefined,
            terminate: async () => 0,
          };
        };
      }
      if (property === "verify") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["verify"]>) => {
          if (!reported) {
            assert.ok(sourceCallbacks);
            assert.ok(targetCallbacks);
            sourceCallbacks.onChanged({ eventType: "rename", relativePath: "codeflowai/file-index.db-wal" });
            targetCallbacks.onChanged({ eventType: "change", relativePath: "codeflowai/file-index.db-shm" });
            sourceCallbacks.onChanged({ eventType: "rename", relativePath: ".codeflowai/file-index.db-wal" });
            targetCallbacks.onChanged({ eventType: "change", relativePath: ".codeflowai/file-index.db-shm" });
            reported = true;
          }
          return target.verify(...args);
        };
      }
      if (property === "scan") {
        return (...args: Parameters<WorkspaceMigrationFileWorkerClient["scan"]>) => {
          scans += 1;
          return target.scan(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { worker, scanCount: () => scans };
}

test("迁移详情把活动资源类型转换为明确中文原因", () => {
  const ctx = setup();
  try {
    const gate = new WorkspaceOperationGate();
    const release = gate.beginActivity(ctx.workspaceId, { type: "turn", resourceId: "thread-1:turn-1" });
    let operation = ctx.db.workspaceDirectoryMigrations.create({
      idempotencyKey: "activity-view",
      workspaceId: ctx.workspaceId,
      sourcePath: ctx.sourcePath,
      targetParentPath: ctx.targetParentPath,
      targetPath: ctx.targetPath,
      now: 1,
    }).operation;
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "scanning",
      expectedStateVersion: operation.stateVersion,
      nextState: "awaiting_confirmation",
      now: 2,
    });
    const view = toWorkspaceDirectoryMigrationOperation(operation, {
      db: ctx.db,
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
    });
    assert.equal(view.canStart, false);
    assert.equal(view.blockers[0]?.message, "1 个会话正在执行，请先停止后再迁移。");
    release();
  } finally {
    ctx.close();
  }
});

test("真实工作区 Profile 与偏好在原迁移门禁内复制并从已提交的新目录读取", async t => {
  const ctx = setup();
  const scope = { scopeType: "shared_workspace" as const, scopeId: "shared-business" };
  try {
    ctx.db.withWorkspaceExecutionProfiles(ctx.workspaceId, repo => repo.upsert({ scope, userId: "profile-user", profileText: "before move" }));
    const responses: any[] = [];
    const api = { db: ctx.db, workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]), workspaceOperationGate: ctx.gate,
      send: (response: unknown) => { responses.push(response); } } as unknown as ApiHandlerContext;
    /** 同一原 handler 始终通过注册事实定位目录，API map 不作为开库路径。 */
    const prefsRequest = (method: string, contextWindow = 55) => ({ t: "api.req", id: method, method,
      body: { workspaceId: ctx.workspaceId, prefs: [{ engine: "codex", workMode: "general", contextWindow }] } } as ApiRequestMessage);
    await handleWorkspacePrefsSave(api, prefsRequest("workspacePrefs.save"));
    assert.equal(responses.pop().status, 200);
    const service = createService(ctx);
    const prepared = await prepareAcceptedInput(service, ctx, "profile");
    service.executeStart({ requestId: "profile-start", operationId: prepared.operationId,
      startAttemptId: "attempt-profile", expectedStateVersion: prepared.stateVersion });
    assert.throws(() => ctx.db.withWorkspaceExecutionProfiles(ctx.workspaceId, repo => repo.get(scope, "profile-user")), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
    const warnings = t.mock.method(logger, "warn", () => {});
    for (const method of ["workspacePrefs.get", "workspacePrefs.save"]) {
      await handleApiRequest(api, prefsRequest(method));
      const response = responses.pop();
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "WORKSPACE_MIGRATION_IN_PROGRESS");
      const diagnostic = warnings.mock.calls.at(-1)!.arguments[2] as any;
      assert.equal(diagnostic.requestId, method);
      assert.equal(diagnostic.workspaceId, ctx.workspaceId);
      assert.equal(diagnostic.operationId, prepared.operationId);
      assert.equal(diagnostic.errorCode, "WORKSPACE_MIGRATION_IN_PROGRESS");
    }
    assert.equal(warnings.mock.calls.length, 2);
    warnings.mock.restore();
    await service.waitForIdle(prepared.operationId);
    assert.equal(ctx.db.workspaceDirectoryMigrations.require(prepared.operationId).state, "completed");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.targetPath);
    assert.equal(ctx.db.withWorkspaceExecutionProfiles(ctx.workspaceId, repo => repo.get(scope, "profile-user"))?.profileText, "before move");
    await handleWorkspacePrefsGet(api, prefsRequest("workspacePrefs.get"));
    assert.equal(responses.pop().body.prefs[0].contextWindow, 55);
    await handleWorkspacePrefsSave(api, prefsRequest("workspacePrefs.save", 88));
    assert.equal(responses.pop().status, 200);
    ctx.db.withWorkspaceExecutionProfiles(ctx.workspaceId, repo => repo.upsert({ scope, userId: "profile-user", profileText: "after move" }));
    const source = openClientDb({ dbPath: path.join(ctx.root, "source-reader.db") });
    try {
      source.workspaces.upsert({ id: ctx.workspaceId, path: ctx.sourcePath, title: "old source" });
      assert.equal(source.withWorkspaceExecutionProfiles(ctx.workspaceId, repo => repo.get(scope, "profile-user"))?.profileText, "before move");
      assert.equal(source.withWorkspacePrefs(ctx.workspaceId, repo => repo.listByWorkspace(ctx.workspaceId))[0]?.contextWindow, 55);
    } finally { source.close(); }
  } finally { ctx.close(); }
});

test("D18 树复制期间已提交的源偏好由最终数据库交接携带", async () => {
  const ctx = setup();
  let changed = false;
  /** 复用真实树复制，仅在其进度边界提交合法的源 SQLite 事务。 */
  class UpdatingWorker extends WorkspaceMigrationFileWorkerClient {
    override copy(input: Parameters<WorkspaceMigrationFileWorkerClient["copy"]>[0], options?: Parameters<WorkspaceMigrationFileWorkerClient["copy"]>[1]) {
      return super.copy(input, { onProgress: progress => {
        options?.onProgress?.(progress);
        if (changed) return;
        changed = true;
        const source = openSqliteDb(path.join(ctx.sourcePath, ".codeflowai", "workspace.db"), { fileMustExist: true });
        try { source.prepare("UPDATE workspace_prefs SET context_window = 88, updated_at = 2 WHERE workspace_id = ?").run(ctx.workspaceId); }
        finally { source.close(); }
      } });
    }
  }
  const workspaces = new Map([[ctx.workspaceId, ctx.sourcePath]]);
  const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate, workspaces,
    activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }),
    storageClassifier: createStorageClassifier(), fileWorker: new UpdatingWorker(),
    indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) } });
  try {
    ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.upsert({ workspaceId: ctx.workspaceId, engine: "codex", workMode: "general", contextWindow: 55 }));
    const prepared = await prepareAcceptedInput(service, ctx, "handoff-copy");
    service.executeStart({ requestId: "handoff-copy", operationId: prepared.operationId, startAttemptId: "attempt-handoff-copy", expectedStateVersion: prepared.stateVersion });
    await service.waitForIdle(prepared.operationId);
    assert.equal(changed, true);
    assert.equal(ctx.db.workspaceDirectoryMigrations.require(prepared.operationId).state, "completed");
    assert.equal(workspaces.get(ctx.workspaceId), ctx.targetPath);
    assert.equal(ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.listByWorkspace(ctx.workspaceId))[0]?.contextWindow, 88);
  } finally { ctx.close(); }
});

test("D18 真实路径提交后目标合法原位写入仍可从原启动入口恢复", async () => {
  const ctx = setup();
  let committed!: () => void, resume!: () => void;
  const reachedCommit = new Promise<void>(resolve => { committed = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate, workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }),
    storageClassifier: createStorageClassifier(), indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
    onCommittedPath: async () => { committed(); await resumed; } });
  let operationId: string | undefined;
  try {
    ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.upsert({ workspaceId: ctx.workspaceId, engine: "codex", workMode: "general", contextWindow: 55 }));
    const prepared = await prepareAcceptedInput(service, ctx, "handoff-committed");
    operationId = prepared.operationId;
    service.executeStart({ requestId: "handoff-committed", operationId, startAttemptId: "attempt-handoff-committed", expectedStateVersion: prepared.stateVersion });
    await Promise.race([reachedCommit, service.waitForIdle(operationId).then(() => {
      if (ctx.db.workspaces.get(ctx.workspaceId)?.path !== ctx.targetPath) throw new Error(`MIGRATION_NOT_COMMITTED:${JSON.stringify(ctx.db.workspaceDirectoryMigrations.require(operationId!))}`);
    })]);
    const target = openSqliteDb(path.join(ctx.targetPath, ".codeflowai", "workspace.db"), { fileMustExist: true });
    try { target.prepare("UPDATE workspace_prefs SET context_window = 99, updated_at = 3 WHERE workspace_id = ?").run(ctx.workspaceId); }
    finally { target.close(); }
    const recovery = await recoverWorkspaceMigrationsBeforeMap({ db: ctx.db, requestId: "handoff-restart", storageClassifier: createStorageClassifier() });
    assert.deepEqual(recovery.blockedWorkspaceIds, []);
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.targetPath);
  } finally {
    resume();
    if (operationId) await service.waitForIdle(operationId);
    ctx.close();
  }
});

for (const change of ["source-static", "target-static", "during-reconcile"] as const) {
  test(`D18 snapshot 后 ${change} 变化不得被父目录事件复核清掉`, async () => {
    const ctx = setup();
    let sourceCallbacks: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>[1] | undefined;
    let targetCallbacks: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>[1] | undefined;
    let snapshotDone = false, injected = false;
    const worker = new WorkspaceMigrationFileWorkerClient();
    const snapshot = worker.snapshotWorkspaceDb.bind(worker), scan = worker.scan.bind(worker);
    worker.watch = (input, callbacks) => {
      if (input.watchRoot === ctx.sourcePath) sourceCallbacks = callbacks; else targetCallbacks = callbacks;
      return { taskId: `watch:${input.watchRoot}`, ready: Promise.resolve(), closed: Promise.resolve(), stop: async () => undefined, terminate: async () => 0 };
    };
    worker.snapshotWorkspaceDb = input => {
      const task = snapshot(input);
      return { ...task, promise: task.promise.then(result => {
        snapshotDone = true;
        assert.ok(targetCallbacks); targetCallbacks.onChanged({ eventType: "change", relativePath: ".codeflowai" });
        if (change === "source-static") {
          fs.writeFileSync(path.join(ctx.sourcePath, ".codeflowai", "unmanaged.sqlite"), "external-static");
          assert.ok(sourceCallbacks); sourceCallbacks.onChanged({ eventType: "rename", relativePath: ".codeflowai/unmanaged.sqlite" });
          injected = true;
        } else if (change === "target-static") {
          fs.writeFileSync(path.join(ctx.targetPath, ".codeflowai", "events.jsonl"), "external-static"); injected = true;
        }
        return result;
      }) };
    };
    worker.scan = (input, options) => {
      const task = scan(input, options);
      if (!snapshotDone || change !== "during-reconcile" || injected || input.sourceRoot !== ctx.targetPath) return task;
      return { ...task, promise: task.promise.then(result => {
        fs.writeFileSync(path.join(ctx.targetPath, ".codeflowai", "late.json"), "late-static");
        assert.ok(targetCallbacks); targetCallbacks.onChanged({ eventType: "rename", relativePath: ".codeflowai/late.json" });
        injected = true; return result;
      }) };
    };
    const workspaces = new Map([[ctx.workspaceId, ctx.sourcePath]]);
    const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate, fileWorker: worker, workspaces,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) } });
    try {
      ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.upsert({ workspaceId: ctx.workspaceId, engine: "codex", workMode: "general", contextWindow: 55 }));
      const prepared = await prepareAcceptedInput(service, ctx, change);
      service.executeStart({ requestId: change, operationId: prepared.operationId, startAttemptId: `attempt-${change}`, expectedStateVersion: prepared.stateVersion });
      await service.waitForIdle(prepared.operationId);
      assert.equal(injected, true);
      const failed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
      assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
      assert.equal(workspaces.get(ctx.workspaceId), ctx.sourcePath);
      assert.notEqual(failed.state, "completed");
      if (change === "during-reconcile") assert.equal((failed.errorDetails as Record<string, unknown>)?.targetDirty, true);
      if (change !== "source-static") assert.equal(failed.state, "recovery_required");
    } finally { ctx.close(); }
  });
}

for (const artifact of ["absent", "main", "temporary", "owned-root"] as const) {
  test(`D18 原启动恢复 pending ${artifact} 只在可证明无库时安全回源`, async () => {
    const ctx = setup();
    try {
      const operation = await seedTargetReadyOperation(ctx, `pending-${artifact}`);
      ctx.db.db.prepare("UPDATE workspace_directory_migrations SET workspace_db_snapshot_json = ? WHERE operation_id = ?").run(JSON.stringify({ formatVersion: 1, state: "pending" }), operation.operationId);
      let unknown: string | undefined;
      if (artifact === "owned-root") ctx.db.workspaces.upsert({ id: "client:other-owner" as WorkspaceId, title: "other owner", path: ctx.targetPath });
      if (artifact === "main" || artifact === "temporary") {
        fs.mkdirSync(path.join(ctx.targetPath, ".codeflowai"));
        unknown = path.join(ctx.targetPath, ".codeflowai", artifact === "main" ? "workspace.db" : `workspace.db-pending-${artifact}.snapshot`);
        fs.writeFileSync(unknown, "unknown-owner");
      }
      const result = await recoverWorkspaceMigrationsBeforeMap({ db: ctx.db, requestId: `pending-${artifact}`, storageClassifier: createStorageClassifier() });
      const current = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
      assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
      assert.equal(fs.existsSync(ctx.sourcePath), true);
      assert.equal(current.state, artifact === "absent" ? "failed" : "recovery_required");
      assert.deepEqual(result.blockedWorkspaceIds, artifact === "absent" ? [] : [ctx.workspaceId]);
      if (unknown) assert.equal(fs.readFileSync(unknown, "utf8"), "unknown-owner");
      else assert.equal(fs.existsSync(ctx.targetPath), artifact === "owned-root");
      if (artifact === "owned-root") assert.equal(current.errorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
    } finally { ctx.close(); }
  });
}

test("D18 固定交接预算同时覆盖 snapshot 和静态复核，超时取消并等待复核 Worker exit", async () => {
  const ctx = setup(), worker = new WorkspaceMigrationFileWorkerClient();
  const scan = worker.scan.bind(worker), snapshot = worker.snapshotWorkspaceDb.bind(worker);
  let targetCallbacks: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>[1] | undefined;
  let snapshotDone = false, heldTask: ReturnType<WorkspaceMigrationFileWorkerClient["scan"]> | undefined;
  let scanned: Awaited<ReturnType<WorkspaceMigrationFileWorkerClient["scan"]>["promise"]> | undefined;
  let service!: WorkspaceMigrationService;
  worker.watch = (input, callbacks) => {
    if (input.watchRoot !== ctx.sourcePath) targetCallbacks = callbacks;
    return { taskId: input.watchRoot, ready: Promise.resolve(), closed: Promise.resolve(), stop: async () => undefined, terminate: async () => 0 };
  };
  worker.snapshotWorkspaceDb = input => {
    const task = snapshot(input);
    return { ...task, promise: task.promise.then(result => {
      snapshotDone = true;
      // 仅缩短本测试运行态剩余预算，生产 30 秒常量不改变。
      const runtime = (service as unknown as { runtimes: Map<string, { handoffDeadline: number }> }).runtimes.get(input.operationId);
      assert.ok(runtime); runtime.handoffDeadline = Date.now() + 500;
      assert.ok(targetCallbacks); targetCallbacks.onChanged({ eventType: "change", relativePath: ".codeflowai" });
      return result;
    }) };
  };
  worker.scan = (input, options) => {
    if (snapshotDone) {
      assert.ok(scanned);
      const held = resultBeforeExitWorker(ctx, scanned); heldTask = held.scan(input); return heldTask;
    }
    const task = scan(input, options);
    return { ...task, promise: task.promise.then(result => { scanned = result; return result; }) };
  };
  const workspaces = new Map([[ctx.workspaceId, ctx.sourcePath]]);
  service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate, fileWorker: worker, workspaces,
    activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(),
    indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) } });
  try {
    const prepared = await prepareAcceptedInput(service, ctx, "handoff-budget");
    service.executeStart({ requestId: "handoff-budget", operationId: prepared.operationId, startAttemptId: "attempt-handoff-budget", expectedStateVersion: prepared.stateVersion });
    await service.waitForIdle(prepared.operationId);
    const failed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(failed.state, "recovery_required"); assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
    assert.equal(workspaces.get(ctx.workspaceId), ctx.sourcePath); assert.ok(heldTask); await heldTask.closed;
    await assert.rejects(ctx.gate.waitForFinalHandoff(ctx.workspaceId));
  } finally { ctx.close(); }
});

for (const fault of ["evidence-cas", "commit"] as const) {
  test(`D18 ${fault} 故障保持源和 Map，ready 过期恢复只清副本`, async t => {
    const ctx = setup();
    const workspaces = new Map([[ctx.workspaceId, ctx.sourcePath]]);
    const service = new WorkspaceMigrationService({ db: ctx.db, gate: ctx.gate, workspaces,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate: ctx.gate }), storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) } });
    try {
      ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.upsert({ workspaceId: ctx.workspaceId, engine: "codex", workMode: "general", contextWindow: 55 }));
      const prepared = await prepareAcceptedInput(service, ctx, fault);
      const repo = ctx.db.workspaceDirectoryMigrations;
      let injected = false;
      const update = repo.updateCurrentState.bind(repo);
      if (fault === "evidence-cas") t.mock.method(repo, "updateCurrentState", (input: Parameters<typeof repo.updateCurrentState>[0]) => {
        if (input.patch.workspaceDbSnapshot) { injected = true; throw new Error("EVIDENCE_CAS_FAILED"); }
        return update(input);
      });
      else t.mock.method(repo, "commitPath", () => { injected = true; throw new Error("PATH_COMMIT_FAILED"); });
      service.executeStart({ requestId: fault, operationId: prepared.operationId, startAttemptId: `attempt-${fault}`, expectedStateVersion: prepared.stateVersion });
      await service.waitForIdle(prepared.operationId);
      assert.equal(injected, true); assert.equal(repo.require(prepared.operationId).state, "recovery_required");
      assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath); assert.equal(workspaces.get(ctx.workspaceId), ctx.sourcePath);
      assert.equal(repo.require(prepared.operationId).workspaceDbSnapshot?.state, fault === "commit" ? "ready" : "pending");
      t.mock.restoreAll();
      if (fault === "commit") {
        ctx.db.db.prepare("UPDATE workspace_directory_migrations SET state = 'target_ready' WHERE operation_id = ?").run(prepared.operationId);
        const source = openSqliteDb(path.join(ctx.sourcePath, ".codeflowai", "workspace.db"));
        try { source.exec("UPDATE workspace_prefs SET context_window = 88"); } finally { source.close(); }
        const recovery = await recoverWorkspaceMigrationsBeforeMap({ db: ctx.db, requestId: "stale-ready", storageClassifier: createStorageClassifier() });
        assert.deepEqual(recovery.blockedWorkspaceIds, []);
        assert.equal(repo.require(prepared.operationId).state, "failed"); assert.equal(fs.existsSync(ctx.targetPath), false);
      }
    } finally { ctx.close(); }
  });
}

test("迁移整体进度按阶段保留校验、切换和收尾区间", () => {
  const ctx = setup();
  try {
    const operation = ctx.db.workspaceDirectoryMigrations.create({
      idempotencyKey: "phase-weighted-progress",
      workspaceId: ctx.workspaceId,
      sourcePath: ctx.sourcePath,
      targetParentPath: ctx.targetParentPath,
      targetPath: ctx.targetPath,
      now: 1,
    }).operation;
    /** 基于同一持久记录投影指定阶段，隔离验证进度映射。 */
    const progressFor = (
      state: WorkspaceDirectoryMigrationRecord["state"],
      copiedBytes = 100,
    ) => toWorkspaceDirectoryMigrationOperation({
      ...operation,
      state,
      sourceTotalBytes: 100,
      copiedBytes,
    }, {
      db: ctx.db,
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    }).progressPct;

    assert.equal(progressFor("preparing", 0), 5);
    assert.equal(progressFor("copying", 0), 10);
    assert.equal(progressFor("copying", 50), 38);
    assert.equal(progressFor("copying"), 65);
    assert.equal(progressFor("verifying"), 70);
    assert.equal(progressFor("publish_intent"), 82);
    assert.equal(progressFor("target_ready"), 90);
    assert.equal(progressFor("path_committed"), 95);
    assert.equal(progressFor("finalizing"), 98);
    assert.equal(progressFor("completed"), 100);
  } finally {
    ctx.close();
  }
});

test("源目录事件经清单复核未发现内容变化时继续迁移", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker: createUnchangedSourceRenameWorker(ctx.sourcePath),
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    });
    const prepared = await prepareAcceptedInput(service, ctx, "unchanged-rename-event");
    service.executeStart({
      requestId: "start-unchanged-rename-event",
      operationId: prepared.operationId,
      startAttemptId: "attempt-unchanged-rename-event",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);
    assert.equal(ctx.db.workspaceDirectoryMigrations.require(prepared.operationId).state, "completed");
  } finally {
    ctx.close();
  }
});

test("完整迁移复制文件、原子切换 path 与终端 cwd，并保留源目录", async () => {
  const ctx = setup();
  try {
    fs.mkdirSync(path.join(ctx.sourcePath, "apps", "docs", "node_modules", "@multica", "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.sourcePath, "apps", "docs", "node_modules", "@multica", "ui", "package.json"),
      "{}\n",
      "utf8",
    );
    fs.mkdirSync(path.join(ctx.sourcePath, "service", "target"), { recursive: true });
    fs.writeFileSync(path.join(ctx.sourcePath, "service", "pom.xml"), "<project />\n", "utf8");
    fs.writeFileSync(path.join(ctx.sourcePath, "service", "target", "app.jar"), "generated\n", "utf8");
    ctx.db.terminalConfigs.insert({
      id: "terminal-1",
      workspaceId: ctx.workspaceId,
      label: "Terminal",
      shell: null,
      cwd: path.join(ctx.sourcePath, "nested"),
    });
    const gate = ctx.gate;
    const workspaces = new Map<WorkspaceId, string>([[ctx.workspaceId, ctx.sourcePath]]);
    const realWorker = new WorkspaceMigrationFileWorkerClient();
    let dependencyAddedDuringCopy = false;
    const fileWorker = new Proxy(realWorker, {
      get(target, property, receiver) {
        if (property === "copy") {
          return (...args: Parameters<WorkspaceMigrationFileWorkerClient["copy"]>) => {
            fs.mkdirSync(path.join(ctx.sourcePath, "node_modules"));
            fs.writeFileSync(path.join(ctx.sourcePath, "node_modules", "late-package.json"), "{}\n", "utf8");
            fs.writeFileSync(path.join(ctx.sourcePath, "service", "target", "late.jar"), "generated later\n", "utf8");
            dependencyAddedDuringCopy = true;
            return target.copy(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker,
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces,
    });
    const prepared = await prepareAcceptedInput(service, ctx, "complete");
    assert.equal(prepared.excludedDependencyDirectoryCount, 2);
    assert.deepEqual(prepared.excludedDependencyDirectories, ["apps/docs/node_modules", "service/target"]);
    const accepted = service.executeStart({
      requestId: "start-complete",
      operationId: prepared.operationId,
      startAttemptId: "attempt-complete",
      expectedStateVersion: prepared.stateVersion,
    });
    assert.equal(accepted.state, "preparing");
    await service.waitForIdle(prepared.operationId);

    const completed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(completed.state, "completed");
    assert.equal(completed.indexRebuildStatus, "not_applicable");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.targetPath);
    assert.equal(workspaces.get(ctx.workspaceId), ctx.targetPath);
    assert.equal(ctx.db.terminalConfigs.listByWorkspace(ctx.workspaceId)[0]?.cwd, "nested");
    assert.equal(fs.readFileSync(path.join(ctx.targetPath, "nested", "data.txt"), "utf8"), "content\n");
    assert.equal(fs.existsSync(path.join(ctx.targetPath, "apps", "docs", "node_modules")), false);
    assert.equal(fs.existsSync(path.join(ctx.targetPath, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(ctx.targetPath, "service", "target")), false);
    assert.equal(dependencyAddedDuringCopy, true);
    assert.equal(completed.excludedDependencyDirectoryCount, 3);
    assert.deepEqual(completed.excludedDependencyDirectories, ["apps/docs/node_modules", "node_modules", "service/target"]);
    assert.equal(fs.existsSync(ctx.sourcePath), true);
    assert.equal(gate.getMigrationOperationId(ctx.workspaceId), null);
  } finally {
    ctx.close();
  }
});

test("迁移 prepare 拒绝已属于另一 workspace 的目标物理根", async (t) => {
  const ctx = setup();
  const warningLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "warn", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") warningLogs.push(data as Record<string, unknown>);
  });
  try {
    fs.mkdirSync(ctx.targetPath);
    const otherWorkspaceId = "client:workspace:prepare-owner" as WorkspaceId;
    ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "target owner", path: ctx.targetPath });
    const workspaces = new Map<WorkspaceId, string>([
      [ctx.workspaceId, ctx.sourcePath],
      [otherWorkspaceId, ctx.targetPath],
    ]);
    const gate = new WorkspaceOperationGate();
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces,
    });

    await assert.rejects(
      service.prepare({
        requestId: "prepare-root-owner-conflict",
        workspaceId: ctx.workspaceId,
        idempotencyKey: "prepare-root-owner-conflict",
        targetParentPath: ctx.targetParentPath,
        targetDirectoryName: "migrated",
      }),
      (error: any) => (
        error?.code === "WORKSPACE_MIGRATION_TARGET_CONFLICT"
        && error?.details?.reason === "workspace_root_already_registered"
        && error?.details?.phase === "prepare"
      ),
    );
    const logged = warningLogs.find((entry) => entry.code === "workspace_migration_target_root_conflict");
    assert.equal(logged?.requestId, "prepare-root-owner-conflict");
    assert.equal(logged?.workspaceId, ctx.workspaceId);
    assert.equal(logged?.operationId, null);
    assert.equal(logged?.phase, "prepare");
    assert.equal(logged?.indexPath, path.join(fs.realpathSync.native(ctx.targetPath), ".codeflowai", "file-index.db"));
  } finally {
    ctx.close();
  }
});

test("迁移 commit 前发现并发 root owner 时保持恢复态且不启动索引", async (t) => {
  const ctx = setup();
  const warningLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "warn", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") warningLogs.push(data as Record<string, unknown>);
  });
  try {
    const gate = ctx.gate;
    const workspaces = new Map<WorkspaceId, string>([[ctx.workspaceId, ctx.sourcePath]]);
    const otherWorkspaceId = "client:workspace:commit-owner" as WorkspaceId;
    let reservationCount = 0;
    let conflictRegistered = false;
    const fileWorker = createCommitRootConflictWorker(ctx.targetPath, () => {
      assert.equal(fs.existsSync(ctx.targetPath), true, "竞态必须发生在目标发布后");
      ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "concurrent owner", path: ctx.targetPath });
      workspaces.set(otherWorkspaceId, ctx.targetPath);
      conflictRegistered = true;
    });
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker,
      storageClassifier: createStorageClassifier(),
      indexCoordinator: {
        reserveForMigration: async () => {
          reservationCount += 1;
          return { kind: "not_applicable" };
        },
      },
      workspaces,
    });
    const prepared = await prepareAcceptedInput(service, ctx, "commit-root-owner-conflict");
    service.executeStart({
      requestId: "start-commit-root-owner-conflict",
      operationId: prepared.operationId,
      startAttemptId: "attempt-commit-root-owner-conflict",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);

    const blocked = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(conflictRegistered, true);
    assert.equal(blocked.state, "recovery_required");
    assert.equal(blocked.errorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
    assert.equal((blocked.errorDetails as Record<string, unknown> | null)?.reason, "workspace_root_already_registered");
    assert.equal((blocked.errorDetails as Record<string, unknown> | null)?.phase, "commit");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
    assert.equal(workspaces.get(ctx.workspaceId), ctx.sourcePath);
    assert.equal(reservationCount, 0);
    assert.equal(fs.existsSync(path.join(ctx.targetPath, ".codeflowai", "file-index.db")), false);
    const logged = warningLogs.find((entry) => (
      entry.code === "workspace_migration_target_root_conflict" && entry.phase === "commit"
    ));
    assert.equal(logged?.requestId, "start-commit-root-owner-conflict");
    assert.equal(logged?.operationId, prepared.operationId);
    assert.equal(logged?.workspaceId, ctx.workspaceId);
  } finally {
    ctx.close();
  }
});

test("迁移 publish 前发现并发注册的计划目标 root owner 时不发布 staging", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    const workspaces = new Map<WorkspaceId, string>([[ctx.workspaceId, ctx.sourcePath]]);
    const otherWorkspaceId = "client:workspace:publish-owner" as WorkspaceId;
    let reservationCount = 0;
    let conflictRegistered = false;
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      storageClassifier: createStorageClassifier(),
      indexCoordinator: {
        reserveForMigration: async () => {
          reservationCount += 1;
          return { kind: "not_applicable" };
        },
      },
      workspaces,
      onOperationChanged: (operation) => {
        if (operation.state !== "publish_intent" || conflictRegistered) return;
        assert.equal(fs.existsSync(operation.targetPath), false);
        ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "planned target owner", path: operation.targetPath });
        workspaces.set(otherWorkspaceId, operation.targetPath);
        conflictRegistered = true;
      },
    });
    const prepared = await prepareAcceptedInput(service, ctx, "publish-root-owner-conflict");
    service.executeStart({
      requestId: "start-publish-root-owner-conflict",
      operationId: prepared.operationId,
      startAttemptId: "attempt-publish-root-owner-conflict",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);

    const blocked = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(conflictRegistered, true);
    assert.equal(blocked.state, "recovery_required");
    assert.equal(blocked.errorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
    assert.equal((blocked.errorDetails as Record<string, unknown> | null)?.phase, "publish");
    assert.equal(fs.existsSync(ctx.targetPath), false);
    assert.equal(Boolean(blocked.stagingPath && fs.existsSync(blocked.stagingPath)), true);
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
    assert.equal(reservationCount, 0);
  } finally {
    ctx.close();
  }
});

test("迁移先持久化 generation，完成并释放独占后才启动 Worker", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    let workerStarted = false;
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      storageClassifier: createStorageClassifier(),
      indexCoordinator: {
        reserveForMigration: async (operation) => ({
          kind: "pending",
          generation: 41,
          start: () => {
            const persisted = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
            assert.equal(persisted.state, "completed");
            assert.equal(gate.getMigrationOperationId(operation.workspaceId), null);
            assert.equal(persisted.indexRebuildStatus, "pending");
            assert.equal(persisted.indexRebuildGeneration, 41);
            workerStarted = true;
          },
          cancel: () => undefined,
        }),
      },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    });
    const prepared = await prepareAcceptedInput(service, ctx, "index-two-phase");
    service.executeStart({
      requestId: "start-index-two-phase",
      operationId: prepared.operationId,
      startAttemptId: "attempt-index-two-phase",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);

    const completed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(workerStarted, true);
    assert.equal(completed.state, "completed");
    assert.equal(completed.indexRebuildStatus, "pending");
    assert.equal(completed.indexRebuildGeneration, 41);
  } finally {
    ctx.close();
  }
});

test("状态事件回调失败不改变本地状态机并最终释放门禁", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    let callbackCount = 0;
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
      onOperationChanged: () => {
        callbackCount += 1;
        throw new Error("test notification failure");
      },
    });
    const prepared = await prepareAcceptedInput(service, ctx, "notification-failure");
    service.executeStart({
      requestId: "start-notification-failure",
      operationId: prepared.operationId,
      startAttemptId: "attempt-notification-failure",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);

    const completed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(completed.state, "completed");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.targetPath);
    assert.equal(gate.getMigrationOperationId(ctx.workspaceId), null);
    assert.ok(callbackCount > 0);
  } finally {
    ctx.close();
  }
});

test("path_committed 后 watcher 关闭失败显式隔离且保持已提交目标", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    const realWorker = new WorkspaceMigrationFileWorkerClient();
    let injected = false;
    const fileWorker = new Proxy(realWorker, {
      get(target, property, receiver) {
        if (property === "watch") {
          return (...args: Parameters<WorkspaceMigrationFileWorkerClient["watch"]>) => {
            const watcher = target.watch(...args);
            const command = args[0];
            if (command.watchRoot !== ctx.targetPath) return watcher;
            return {
              ready: watcher.ready,
              stop: async () => {
                await watcher.stop();
                if (!injected) {
                  injected = true;
                  throw new Error("test watcher stop failure");
                }
              },
            };
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker,
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    });
    const prepared = await prepareAcceptedInput(service, ctx, "watcher-stop-after-commit");
    service.executeStart({
      requestId: "start-watcher-stop-after-commit",
      operationId: prepared.operationId,
      startAttemptId: "attempt-watcher-stop-after-commit",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);

    const completed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(injected, true);
    assert.equal(completed.state, "recovery_required");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.targetPath);
    assert.equal(gate.getMigrationOperationId(ctx.workspaceId), prepared.operationId);
  } finally {
    ctx.close();
  }
});

test("准备迁移拒绝相对父路径和目标文件系统保留根名称", async () => {
  const ctx = setup();
  try {
    const service = createService(ctx);
    await assert.rejects(
      service.prepare({
        requestId: "prepare-relative-target",
        workspaceId: ctx.workspaceId,
        idempotencyKey: "relative-target",
        targetParentPath: "relative-parent",
        targetDirectoryName: "migrated",
      }),
      (error: any) => error?.code === "WORKSPACE_MIGRATION_TARGET_INVALID",
    );

    const gate = new WorkspaceOperationGate();
    const ntfsClassifier = {
      assertSupportedTarget: async (targetParentPath: string) => ({
        platform: process.platform,
        realPath: targetParentPath,
        mountPoint: path.parse(targetParentPath).root,
        fileSystemType: "ntfs",
        deviceIds: ["test-device"],
        busTypes: ["test-bus"],
      }),
    } as StorageClassifier;
    const ntfsService = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      storageClassifier: ntfsClassifier,
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    });
    let operation: WorkspaceDirectoryMigrationRecord | null = null;
    try {
      operation = await ntfsService.prepare({
        requestId: "prepare-reserved-target",
        workspaceId: ctx.workspaceId,
        idempotencyKey: "reserved-target",
        targetParentPath: ctx.targetParentPath,
        targetDirectoryName: "CON",
      });
    } catch (error: any) {
      assert.equal(error?.code, "WORKSPACE_MIGRATION_TARGET_INVALID");
    }
    if (operation) {
      await ntfsService.waitForIdle(operation.operationId);
      const failed = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
      assert.equal(failed.state, "failed");
      assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_TARGET_INVALID");
    }
  } finally {
    ctx.close();
  }
});

test("独占预留后发现长时活动会落为 ACTIVE_RESOURCES 并释放门禁", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    const service = createService(ctx, gate);
    const prepared = await prepareAcceptedInput(service, ctx, "blocked");
    const releaseActivity = gate.beginActivity(ctx.workspaceId, { type: "test_background_activity", resourceId: "sync-1" });
    service.executeStart({
      requestId: "start-blocked",
      operationId: prepared.operationId,
      startAttemptId: "attempt-blocked",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);
    const failed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_ACTIVE_RESOURCES");
    assert.deepEqual((failed.errorDetails as any)?.blockers, [
      { type: "test_background_activity", count: 1, resourceIds: ["sync-1"] },
    ]);
    assert.equal(gate.getMigrationOperationId(ctx.workspaceId), null);
    releaseActivity();
  } finally {
    ctx.close();
  }
});

test("scanning 阶段可取消 Worker，并收敛为 cancelled", async () => {
  const ctx = setup();
  try {
    let scanStarted!: () => void;
    const started = new Promise<void>((resolve) => { scanStarted = resolve; });
    let rejectScan!: (error: unknown) => void;
    const scanPromise = new Promise<never>((_resolve, reject) => { rejectScan = reject; });
    const fileWorker = {
      probe: () => ({
        taskId: "probe",
        promise: Promise.resolve({
          realTargetParent: ctx.targetParentPath,
          availableBytes: 1024 * 1024 * 1024,
          caseSensitive: process.platform !== "win32",
          symlinkSupported: false,
        }),
        cancel: () => {},
        terminate: async () => 0,
      }),
      scan: () => {
        scanStarted();
        return {
          taskId: "scan",
          promise: scanPromise,
          cancel: () => rejectScan(new WorkspaceMigrationFileClientError(
            "WORKSPACE_MIGRATION_FILE_CANCELLED",
            "cancelled",
            { reason: "cancelled" },
          )),
          terminate: async () => 0,
        };
      },
    } as unknown as WorkspaceMigrationFileWorkerClient;
    const gate = new WorkspaceOperationGate();
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker,
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    });
    const operation = await service.prepare({
      requestId: "prepare-cancel",
      workspaceId: ctx.workspaceId,
      idempotencyKey: "cancel-scan",
      targetParentPath: ctx.targetParentPath,
      targetDirectoryName: "migrated",
    });
    await started;
    const cancelled = await service.cancel({ requestId: "cancel-scan", operationId: operation.operationId });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.cancellationReason, "user_cancelled");
  } finally {
    ctx.close();
  }
});

test("target_ready 后源变化时仅在目标摘要仍匹配后清理目标并回源失败", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.upsert({ workspaceId: ctx.workspaceId, engine: "codex", workMode: "general", contextWindow: 31 }));
    let sourceChanged = false;
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
      onOperationChanged: (operation) => {
        if (operation.state !== "target_ready" || sourceChanged) return;
        sourceChanged = true;
        fs.appendFileSync(path.join(ctx.sourcePath, "README.md"), "changed\n", "utf8");
      },
    });
    const prepared = await prepareAcceptedInput(service, ctx, "source-change");
    service.executeStart({
      requestId: "start-source-change",
      operationId: prepared.operationId,
      startAttemptId: "attempt-source-change",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);
    const failed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_SOURCE_CHANGED");
    assert.deepEqual(
      (failed.errorDetails as any)?.sourceChangedPaths?.map((value: string) => value.toLowerCase()),
      ["readme.md"],
    );
    assert.equal(fs.existsSync(ctx.targetPath), false);
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
    assert.equal(gate.getMigrationOperationId(ctx.workspaceId), null);
    assert.equal(ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.listByWorkspace(ctx.workspaceId))[0]?.contextWindow, 31);
  } finally {
    ctx.close();
  }
});

test("目标隔离复核期间原路径被重建时不会误删外部内容", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    const realWorker = new WorkspaceMigrationFileWorkerClient();
    let sourceChanged = false;
    let externalTargetCreated = false;
    const fileWorker = new Proxy(realWorker, {
      get(target, property, receiver) {
        if (property === "scan") {
          return (command: Parameters<WorkspaceMigrationFileWorkerClient["scan"]>[0]) => {
            const task = target.scan(command);
            if (!path.basename(command.sourceRoot).includes(".codeflow-cleanup-")) return task;
            return {
              ...task,
              promise: task.promise.then((result) => {
                fs.mkdirSync(ctx.targetPath, { recursive: true });
                fs.writeFileSync(path.join(ctx.targetPath, "external.txt"), "external\n", "utf8");
                externalTargetCreated = true;
                return result;
              }),
            };
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker,
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
      onOperationChanged: (operation) => {
        if (operation.state !== "target_ready" || sourceChanged) return;
        sourceChanged = true;
        fs.appendFileSync(path.join(ctx.sourcePath, "README.md"), "changed\n", "utf8");
      },
    });
    const prepared = await prepareAcceptedInput(service, ctx, "target-recreated");
    service.executeStart({
      requestId: "start-target-recreated",
      operationId: prepared.operationId,
      startAttemptId: "attempt-target-recreated",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);

    const failed = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_SOURCE_CHANGED");
    assert.equal(externalTargetCreated, true);
    assert.equal(fs.readFileSync(path.join(ctx.targetPath, "external.txt"), "utf8"), "external\n");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
  } finally {
    ctx.close();
  }
});

test("目标隔离清理发现外部 node_modules 时恢复目标并进入恢复态", async () => {
  const ctx = setup();
  try {
    const gate = ctx.gate;
    const realWorker = new WorkspaceMigrationFileWorkerClient();
    let sourceChanged = false;
    let cleanupDependencyInjected = false;
    const fileWorker = new Proxy(realWorker, {
      get(target, property, receiver) {
        if (property === "scan") {
          return (command: Parameters<WorkspaceMigrationFileWorkerClient["scan"]>[0]) => {
            if (path.basename(command.sourceRoot).includes(".codeflow-cleanup-")) {
              fs.mkdirSync(path.join(command.sourceRoot, "node_modules"));
              fs.writeFileSync(path.join(command.sourceRoot, "node_modules", "external.txt"), "external\n", "utf8");
              cleanupDependencyInjected = true;
            }
            return target.scan(command);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker,
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
      onOperationChanged: (operation) => {
        if (operation.state !== "target_ready" || sourceChanged) return;
        sourceChanged = true;
        fs.appendFileSync(path.join(ctx.sourcePath, "README.md"), "changed\n", "utf8");
      },
    });
    const prepared = await prepareAcceptedInput(service, ctx, "target-cleanup-node-modules");
    service.executeStart({
      requestId: "start-target-cleanup-node-modules",
      operationId: prepared.operationId,
      startAttemptId: "attempt-target-cleanup-node-modules",
      expectedStateVersion: prepared.stateVersion,
    });
    await service.waitForIdle(prepared.operationId);

    const isolated = ctx.db.workspaceDirectoryMigrations.require(prepared.operationId);
    assert.equal(cleanupDependencyInjected, true);
    assert.equal(isolated.state, "recovery_required");
    assert.equal(isolated.errorCode, "WORKSPACE_MIGRATION_RECOVERY_REQUIRED");
    assert.equal(fs.readFileSync(path.join(ctx.targetPath, "node_modules", "external.txt"), "utf8"), "external\n");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
  } finally {
    ctx.close();
  }
});

test("启动恢复时 publish_intent staging 校验失败会安全清理并落 failed", async () => {
  const ctx = setup();
  try {
    const operation = await seedPublishIntentOperation(ctx, "operation-publish-staging-invalid");
    assert.ok(operation.stagingPath);
    fs.appendFileSync(path.join(operation.stagingPath, "README.md"), "staging changed\n", "utf8");

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-publish-staging-invalid",
      storageClassifier: createStorageClassifier(),
    });
    const failed = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_VERIFY_FAILED");
    assert.equal(fs.existsSync(operation.stagingPath), false);
    assert.deepEqual(recovered.blockedWorkspaceIds, []);
  } finally {
    ctx.close();
  }
});

test("启动恢复在 publish_intent 发布前拒绝已注册的计划目标 root owner", async () => {
  const ctx = setup();
  try {
    const operation = await seedPublishIntentOperation(ctx, "operation-publish-root-owner-conflict");
    const otherWorkspaceId = "client:workspace:startup-publish-owner" as WorkspaceId;
    ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "startup planned owner", path: operation.targetPath });

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-publish-root-owner-conflict",
      storageClassifier: createStorageClassifier(),
    });
    const blocked = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(blocked.state, "recovery_required");
    assert.equal(blocked.errorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
    assert.equal((blocked.errorDetails as Record<string, unknown> | null)?.phase, "publish");
    assert.equal((blocked.errorDetails as Record<string, unknown> | null)?.recoveryMode, "startup");
    assert.equal(fs.existsSync(operation.targetPath), false);
    assert.equal(Boolean(operation.stagingPath && fs.existsSync(operation.stagingPath)), true);
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
    assert.deepEqual(recovered.blockedWorkspaceIds, [ctx.workspaceId]);
  } finally {
    ctx.close();
  }
});

test("启动恢复时 publish_intent 已发布目标先补 target_ready 再收敛源变化", async () => {
  const ctx = setup();
  try {
    const operation = await seedPublishIntentOperation(ctx, "operation-publish-target-source-changed");
    assert.ok(operation.stagingPath);
    fs.renameSync(operation.stagingPath, operation.targetPath);
    fs.appendFileSync(path.join(ctx.sourcePath, "README.md"), "source changed after publish\n", "utf8");

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-publish-target-source-changed",
      storageClassifier: createStorageClassifier(),
    });
    const failed = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_SOURCE_CHANGED");
    assert.equal(fs.existsSync(operation.targetPath), false);
    assert.deepEqual(recovered.blockedWorkspaceIds, []);
  } finally {
    ctx.close();
  }
});

test("target_ready 启动恢复不提前信任持久化条件排除目录", async () => {
  const ctx = setup();
  try {
    fs.mkdirSync(path.join(ctx.sourcePath, "service", "target"), { recursive: true });
    fs.writeFileSync(path.join(ctx.sourcePath, "service", "pom.xml"), "<project />\n", "utf8");
    fs.writeFileSync(path.join(ctx.sourcePath, "service", "target", "app.jar"), "generated\n", "utf8");
    const operation = await seedTargetReadyOperation(ctx, "operation-target-ready-conditional-change");
    assert.deepEqual(operation.excludedDependencyDirectories, ["service/target"]);
    const reporting = createConditionalChangeReportingWorker(ctx.sourcePath, "service/target/app.jar");

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-target-ready-conditional-change",
      fileWorker: reporting.worker,
      storageClassifier: createStorageClassifier(),
    });

    const failed = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(reporting.wasReported(), true);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_SOURCE_CHANGED");
    assert.equal(fs.existsSync(operation.targetPath), false);
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
    assert.deepEqual(recovered.blockedWorkspaceIds, []);
  } finally {
    ctx.close();
  }
});

test("target_ready 启动恢复忽略源和目标索引库 watcher 事件", async () => {
  const ctx = setup();
  try {
    ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.upsert({ workspaceId: ctx.workspaceId, engine: "codex", workMode: "general", contextWindow: 41 }));
    const operation = await seedTargetReadyOperation(ctx, "operation-target-ready-index-cache-events");
    for (const root of [ctx.sourcePath, ctx.targetPath]) {
      fs.mkdirSync(path.join(root, "codeflowai"), { recursive: true });
      fs.writeFileSync(path.join(root, "codeflowai", "file-index.db-wal"), "cache", "utf8");
      fs.writeFileSync(path.join(root, "codeflowai", "file-index.db-shm"), "cache", "utf8");
    }
    const reporting = createIndexCacheChangeReportingWorker(ctx.sourcePath, ctx.targetPath);

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-target-ready-index-cache-events",
      fileWorker: reporting.worker,
      storageClassifier: createStorageClassifier(),
    });

    const committed = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(reporting.scanCount(), 1);
    assert.equal(committed.state, "path_committed", JSON.stringify({
      errorCode: committed.errorCode,
      errorMessage: committed.errorMessage,
      errorDetails: committed.errorDetails,
    }));
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.targetPath);
    assert.deepEqual(recovered.blockedWorkspaceIds, []);
    ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.upsert({ workspaceId: ctx.workspaceId, engine: "codex", workMode: "general", contextWindow: 99 }));
    assert.equal(ctx.db.withWorkspacePrefs(ctx.workspaceId, repo => repo.listByWorkspace(ctx.workspaceId))[0]?.contextWindow, 99);
    const source = openClientDb({ dbPath: path.join(ctx.root, "source-reader.db") });
    try {
      source.workspaces.upsert({ id: ctx.workspaceId, title: "old source", path: ctx.sourcePath });
      assert.equal(source.withWorkspacePrefs(ctx.workspaceId, repo => repo.listByWorkspace(ctx.workspaceId))[0]?.contextWindow, 41);
    } finally { source.close(); }
  } finally {
    ctx.close();
  }
});

test("target_ready 启动恢复在 commit 前拒绝并发 root owner", async () => {
  const ctx = setup();
  try {
    const operation = await seedTargetReadyOperation(ctx, "operation-target-ready-root-owner-conflict");
    const otherWorkspaceId = "client:workspace:startup-commit-owner" as WorkspaceId;
    ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "startup commit owner", path: operation.targetPath });

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-target-ready-root-owner-conflict",
      storageClassifier: createStorageClassifier(),
    });
    const blocked = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(blocked.state, "recovery_required");
    assert.equal(blocked.errorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
    assert.equal((blocked.errorDetails as Record<string, unknown> | null)?.phase, "commit");
    assert.equal((blocked.errorDetails as Record<string, unknown> | null)?.recoveryMode, "startup");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
    assert.equal(fs.existsSync(operation.targetPath), true);
    assert.deepEqual(recovered.blockedWorkspaceIds, [ctx.workspaceId]);
  } finally {
    ctx.close();
  }
});

test("finalizing pending 启动恢复发现 root owner 冲突时先隔离且不进入索引恢复", async () => {
  const ctx = setup();
  try {
    let operation = await seedTargetReadyOperation(ctx, "operation-finalizing-root-owner-conflict");
    operation = ctx.db.workspaceDirectoryMigrations.commitPath({
      operationId: operation.operationId,
      expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion,
      terminalCwdTargets: {},
      now: 10,
    });
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "path_committed",
      expectedStateVersion: operation.stateVersion,
      nextState: "finalizing",
      now: 11,
    });
    operation = ctx.db.workspaceDirectoryMigrations.setIndexRebuildPending({
      operationId: operation.operationId,
      expectedState: "finalizing",
      expectedStateVersion: operation.stateVersion,
      generation: 41,
      phase: "queued",
      lastProgressAt: 12,
      now: 12,
    });
    const otherWorkspaceId = "client:workspace:startup-finalizing-owner" as WorkspaceId;
    ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "startup finalizing owner", path: operation.targetPath });

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-finalizing-root-owner-conflict",
      storageClassifier: createStorageClassifier(),
    });
    const blocked = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(blocked.state, "recovery_required");
    assert.equal(blocked.errorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
    assert.equal(blocked.indexRebuildStatus, "pending");
    assert.equal(
      ctx.db.workspaceDirectoryMigrations.listActive().some((item) => (
        item.state === "finalizing" && item.indexRebuildStatus === "pending"
      )),
      false,
    );
    assert.deepEqual(recovered.blockedWorkspaceIds, [ctx.workspaceId]);
  } finally {
    ctx.close();
  }
});

test("启动恢复会 fence prepared attempt，并保留待 ACK tombstone", async () => {
  const ctx = setup();
  try {
    let operation = ctx.db.workspaceDirectoryMigrations.create({
      idempotencyKey: "startup-prepared",
      workspaceId: ctx.workspaceId,
      sourcePath: ctx.sourcePath,
      targetParentPath: ctx.targetParentPath,
      targetPath: ctx.targetPath,
      now: 1,
    }).operation;
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "scanning",
      expectedStateVersion: operation.stateVersion,
      nextState: "awaiting_confirmation",
      now: 2,
    });
    operation = ctx.db.workspaceDirectoryMigrations.prepareStartAttempt({
      operationId: operation.operationId,
      startAttemptId: "attempt-startup",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 3,
    });

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-test",
      storageClassifier: createStorageClassifier(),
    });
    const cancelled = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.startDisposition, "fenced");
    assert.equal(cancelled.startFenceAckPending, true);
    assert.deepEqual(recovered.blockedWorkspaceIds, []);
    assert.equal(ctx.db.workspaceDirectoryMigrations.listStartFenceTombstones().length, 1);
  } finally {
    ctx.close();
  }
});

test("启动恢复清理 copying staging 后回源为 interrupted failed", async () => {
  const ctx = setup();
  try {
    let operation = ctx.db.workspaceDirectoryMigrations.create({
      operationId: "operation-copying",
      idempotencyKey: "startup-copying",
      workspaceId: ctx.workspaceId,
      sourcePath: ctx.sourcePath,
      targetParentPath: ctx.targetParentPath,
      targetPath: ctx.targetPath,
      now: 1,
    }).operation;
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "scanning",
      expectedStateVersion: operation.stateVersion,
      nextState: "awaiting_confirmation",
      now: 2,
    });
    operation = ctx.db.workspaceDirectoryMigrations.prepareStartAttempt({
      operationId: operation.operationId,
      startAttemptId: "attempt-copying",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 3,
    });
    operation = ctx.db.workspaceDirectoryMigrations.acceptStartAttempt({
      operationId: operation.operationId,
      startAttemptId: "attempt-copying",
      expectedStateVersion: operation.stateVersion,
      now: 4,
    });
    const stagingPath = path.join(ctx.targetParentPath, ".migrated.codeflow-migration-operation-copying");
    fs.mkdirSync(stagingPath);
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "preparing",
      expectedStateVersion: operation.stateVersion,
      nextState: "copying",
      patch: { stagingPath },
      now: 5,
    });

    await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-copying-test",
      storageClassifier: createStorageClassifier(),
    });
    const failed = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_INTERRUPTED");
    assert.equal(fs.existsSync(stagingPath), false);
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
  } finally {
    ctx.close();
  }
});

test("启动恢复遇到 copying 缺少 staging 的证据冲突时隔离工作区", async () => {
  const ctx = setup();
  try {
    let operation = ctx.db.workspaceDirectoryMigrations.create({
      operationId: "operation-copying-conflict",
      idempotencyKey: "startup-copying-conflict",
      workspaceId: ctx.workspaceId,
      sourcePath: ctx.sourcePath,
      targetParentPath: ctx.targetParentPath,
      targetPath: ctx.targetPath,
      now: 1,
    }).operation;
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "scanning",
      expectedStateVersion: operation.stateVersion,
      nextState: "awaiting_confirmation",
      now: 2,
    });
    operation = ctx.db.workspaceDirectoryMigrations.prepareStartAttempt({
      operationId: operation.operationId,
      startAttemptId: "attempt-copying-conflict",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 3,
    });
    operation = ctx.db.workspaceDirectoryMigrations.acceptStartAttempt({
      operationId: operation.operationId,
      startAttemptId: "attempt-copying-conflict",
      expectedStateVersion: operation.stateVersion,
      now: 4,
    });
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "preparing",
      expectedStateVersion: operation.stateVersion,
      nextState: "copying",
      now: 5,
    });

    const recovered = await recoverWorkspaceMigrationsBeforeMap({
      db: ctx.db,
      requestId: "startup-copying-conflict-test",
      storageClassifier: createStorageClassifier(),
    });
    const isolated = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(isolated.state, "recovery_required");
    assert.equal(isolated.errorCode, "WORKSPACE_MIGRATION_RECOVERY_REQUIRED");
    assert.deepEqual(recovered.blockedWorkspaceIds, [ctx.workspaceId]);
  } finally {
    ctx.close();
  }
});

test("recovery_required 发现残留 staging 时保持隔离并拒绝提交", async () => {
  const ctx = setup();
  try {
    const service = createService(ctx);
    let operation = ctx.db.workspaceDirectoryMigrations.create({
      operationId: "operation-recover-staging",
      idempotencyKey: "recover-staging",
      workspaceId: ctx.workspaceId,
      sourcePath: ctx.sourcePath,
      targetParentPath: ctx.targetParentPath,
      targetPath: ctx.targetPath,
      now: 1,
    }).operation;
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "scanning",
      expectedStateVersion: operation.stateVersion,
      nextState: "awaiting_confirmation",
      now: 2,
    });
    operation = ctx.db.workspaceDirectoryMigrations.prepareStartAttempt({
      operationId: operation.operationId,
      startAttemptId: "attempt-recover-staging",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 3,
    });
    operation = ctx.db.workspaceDirectoryMigrations.acceptStartAttempt({
      operationId: operation.operationId,
      startAttemptId: "attempt-recover-staging",
      expectedStateVersion: operation.stateVersion,
      now: 4,
    });
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "preparing",
      expectedStateVersion: operation.stateVersion,
      nextState: "recovery_required",
      now: 5,
    });
    const stagingPath = path.join(ctx.targetParentPath, ".migrated.codeflow-migration-operation-recover-staging");
    fs.mkdirSync(stagingPath);

    await assert.rejects(
      service.recover({ requestId: "recover-staging-request", operationId: operation.operationId }),
      (error: any) => error?.code === "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
    );
    const isolated = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(isolated.state, "recovery_required");
    assert.equal(fs.existsSync(stagingPath), true);
  } finally {
    ctx.close();
  }
});

test("人工恢复在验证和 commit 前拒绝并发 root owner 且不启动索引", async () => {
  const ctx = setup();
  try {
    let operation = await seedTargetReadyOperation(ctx, "operation-manual-recovery-root-owner-conflict");
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion,
      nextState: "recovery_required",
      now: 10,
    });
    const otherWorkspaceId = "client:workspace:manual-recovery-owner" as WorkspaceId;
    ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "manual recovery owner", path: operation.targetPath });
    const workspaces = new Map<WorkspaceId, string>([
      [ctx.workspaceId, ctx.sourcePath],
      [otherWorkspaceId, operation.targetPath],
    ]);
    let reservationCount = 0;
    const gate = new WorkspaceOperationGate();
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      storageClassifier: createStorageClassifier(),
      indexCoordinator: {
        reserveForMigration: async () => {
          reservationCount += 1;
          return { kind: "not_applicable" };
        },
      },
      workspaces,
    });

    await assert.rejects(
      service.recover({ requestId: "manual-recovery-root-owner-conflict", operationId: operation.operationId }),
      (error: any) => (
        error?.code === "WORKSPACE_MIGRATION_TARGET_CONFLICT"
        && error?.details?.phase === "commit"
        && error?.details?.recoveryMode === "manual"
      ),
    );
    const blocked = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(blocked.state, "recovery_required");
    assert.equal(blocked.errorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
    assert.equal(fs.existsSync(operation.targetPath), true);
    assert.equal(reservationCount, 0);
  } finally {
    ctx.close();
  }
});

test("已提交路径人工恢复在验证期间出现 root owner 时不进入 finalizing 或启动索引", async () => {
  const ctx = setup();
  try {
    let operation = await seedTargetReadyOperation(ctx, "operation-committed-recovery-root-owner-race");
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion,
      nextState: "recovery_required",
      now: 10,
    });
    ctx.db.workspaces.upsert({ id: ctx.workspaceId, title: "workspace", path: operation.targetPath });
    const workspaces = new Map<WorkspaceId, string>([[ctx.workspaceId, operation.targetPath]]);
    const otherWorkspaceId = "client:workspace:committed-recovery-owner" as WorkspaceId;
    let reservationCount = 0;
    const fileWorker = createCommittedValidationRootConflictWorker(operation.targetPath, () => {
      ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "concurrent committed owner", path: operation.targetPath });
      workspaces.set(otherWorkspaceId, operation.targetPath);
    });
    const gate = new WorkspaceOperationGate();
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker,
      storageClassifier: createStorageClassifier(),
      indexCoordinator: {
        reserveForMigration: async () => {
          reservationCount += 1;
          return { kind: "not_applicable" };
        },
      },
      workspaces,
    });

    await assert.rejects(
      service.recover({ requestId: "committed-recovery-root-owner-race", operationId: operation.operationId }),
      (error: any) => error?.code === "WORKSPACE_MIGRATION_TARGET_CONFLICT",
    );
    const blocked = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(blocked.state, "recovery_required");
    assert.equal(blocked.errorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
    assert.equal(blocked.indexRebuildStatus, "not_started");
    assert.equal(reservationCount, 0);
  } finally {
    ctx.close();
  }
});

test("人工恢复不提前信任持久化条件排除目录", async () => {
  const ctx = setup();
  try {
    fs.mkdirSync(path.join(ctx.sourcePath, "service", "target"), { recursive: true });
    fs.writeFileSync(path.join(ctx.sourcePath, "service", "pom.xml"), "<project />\n", "utf8");
    fs.writeFileSync(path.join(ctx.sourcePath, "service", "target", "app.jar"), "generated\n", "utf8");
    let operation = await seedTargetReadyOperation(ctx, "operation-recover-conditional-change");
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion,
      nextState: "recovery_required",
      now: 10,
    });
    const reporting = createConditionalChangeReportingWorker(ctx.sourcePath, "service/target/app.jar");
    const gate = new WorkspaceOperationGate();
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker: reporting.worker,
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    });

    await assert.rejects(
      service.recover({ requestId: "recover-conditional-change", operationId: operation.operationId }),
      (error: any) => error?.code === "WORKSPACE_MIGRATION_SOURCE_CHANGED",
    );
    const isolated = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(reporting.wasReported(), true);
    assert.equal(isolated.state, "recovery_required");
    assert.equal(isolated.errorCode, "WORKSPACE_MIGRATION_SOURCE_CHANGED");
    assert.equal(fs.existsSync(operation.targetPath), true);
    assert.equal(ctx.db.workspaces.get(ctx.workspaceId)?.path, ctx.sourcePath);
  } finally {
    ctx.close();
  }
});

test("人工恢复遇到源 watcher 故障时保留目标并进入 recovery_required", async () => {
  const ctx = setup();
  try {
    let operation = await seedTargetReadyOperation(ctx, "operation-recover-watcher-error");
    operation = ctx.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion,
      nextState: "recovery_required",
      now: 10,
    });
    const gate = new WorkspaceOperationGate();
    const service = new WorkspaceMigrationService({
      db: ctx.db,
      gate,
      activityInspector: new WorkspaceMigrationActivityInspector({ db: ctx.db, gate }),
      fileWorker: createWatcherFailureWorker(ctx.sourcePath),
      storageClassifier: createStorageClassifier(),
      indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
      workspaces: new Map([[ctx.workspaceId, ctx.sourcePath]]),
    });

    await assert.rejects(
      service.recover({ requestId: "recover-watcher-error", operationId: operation.operationId }),
      (error: any) => error?.code === "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
    );
    const isolated = ctx.db.workspaceDirectoryMigrations.require(operation.operationId);
    assert.equal(isolated.state, "recovery_required");
    assert.equal(isolated.errorCode, "WORKSPACE_MIGRATION_RECOVERY_REQUIRED");
    assert.equal((isolated.errorDetails as any)?.watcherErrorCode, "WORKSPACE_MIGRATION_VERIFY_FAILED");
    assert.equal(fs.existsSync(operation.targetPath), true);
  } finally {
    ctx.close();
  }
});
