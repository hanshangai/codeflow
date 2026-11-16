import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";
import { scheduledTaskRuntimeKey } from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";
import { handleCodeflowaiConfigSet } from "../src/app/handlers/codeflowaiHandlers.js";
import { defaultCodeflowaiConfig } from "../src/codeflowai/codeflowaiConfig.js";
import { WorkspaceMigrationActivityInspector } from "../src/workspace-migration/workspaceMigrationActivityInspector.ts";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.ts";

const WORKSPACE_ID = "client:workspace" as WorkspaceId;
const THREAD_ID = "thread-1" as ThreadId;
const ACTIVE_ORCHESTRATION_NODE_STATUSES = [
  "queued",
  "running",
  "result-submitted",
  "finalizing",
  "artifact-writing",
  "gate-checking",
] as const;

test("D18 原文档根 config owner 查询真实工作区墓碑 running 不自锁且拒绝保存",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"scheduled-inspector-owner-")),gate=new WorkspaceOperationGate();
  const db=openClientDb({dbPath:path.join(root,"application.db"),workspaceOperationGate:gate});db.workspaces.upsert({id:WORKSPACE_ID,title:"workspace",path:root});
  const sent:any[]=[],ctx={db,clientId:"client",deviceId:"device",localWorkspaceOnly:true,workspaces:new Map([[WORKSPACE_ID,root]]),workspaceOperationGate:gate,
    send:(message:unknown)=>{sent.push(message);}} as unknown as ApiHandlerContext;
  const scheduler=new ScheduledTaskScheduler({config:{clientId:"client",serverWsUrl:"ws://127.0.0.1:1/ws"} as ClientConfig,deviceId:"device",apiContext:ctx,localApiContext:ctx});
  ctx.workspaceMigrationActivityInspector=new WorkspaceMigrationActivityInspector({db,gate,scheduledTaskScheduler:scheduler});
  try{
    db.withLocalScheduledTasks(WORKSPACE_ID,repos=>{
      repos.configs.create({at:1,config:{id:"task",source:"local",clientId:"client",deviceId:"device",workspaceScope:{scopeType:"local_workspace",scopeId:WORKSPACE_ID},
        name:"task",description:null,taskType:"script",cronExpr:"* * * * *",timezone:"UTC",enabled:true,payload:{shell:"sh",command:"true",contextWorkspaceId:WORKSPACE_ID},concurrencyPolicy:"queue_one",missedPolicy:"skip_missed",timeoutMs:1000}});
      repos.runtime.markStarted({taskId:scheduledTaskRuntimeKey("task","local"),clientId:"client",deviceId:"device",runId:"retained",scheduledAt:1,startedAt:1});
      repos.configs.delete({taskId:"task",expectedRevision:1,at:2});
    });
    await handleCodeflowaiConfigSet(ctx,{t:"api.req",id:"docs-owner",method:"codeflowai.config.set",path:"/local",body:{workspaceId:WORKSPACE_ID,config:{...defaultCodeflowaiConfig(),paths:{workflowDocsRoot:"other-docs"}}}});
    assert.equal(sent[0].status,409);assert.equal(sent[0].body.code,"WORKSPACE_MIGRATION_BUSY");
    assert.equal(sent[0].body.message.includes("工作区仍有运行中"),true);assert.equal(gate.getMigrationOperationId(WORKSPACE_ID),null);
  }finally{await scheduler.stopAndDrain();db.close();fs.rmSync(root,{recursive:true});}
});

test("D08 无当前快照且切号后 Inspector 仍从 W97 全 owner runtime 阻止迁移", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-inspector-")), gate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath: path.join(root, "app.db"), workspaceOperationGate: gate });
  db.workspaces.upsert({ id: WORKSPACE_ID, title: "account", path: root });
  const owner = { serverOrigin: "http://127.0.0.1:1", ownerUserId: "old-owner", clientId: "old-client", deviceId: "old-device" };
  const context = { db, workspaces: new Map([[WORKSPACE_ID, root]]), workspaceOperationGate: gate } as unknown as ApiHandlerContext;
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: "new-client", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig, deviceId: "new-device", apiContext: context });
  const inspector = new WorkspaceMigrationActivityInspector({ db, gate, scheduledTaskScheduler: scheduler });
  try {
    db.withAccountScheduledTasks(WORKSPACE_ID, repos => repos.runtime.claimAccount({ taskId: "deleted-script", owner, runId: "old-account-running", scheduledAt: 1, startedAt: 1 }));
    db.workspaces.delete(WORKSPACE_ID);
    const release = await gate.acquireMigration(WORKSPACE_ID, "inspect-account");
    try {
      const groups = inspector.inspect(WORKSPACE_ID);
      assert.deepEqual(groups.find(group => group.type === "scheduled_task")?.resourceIds, ["old-account-running"]);
    } finally { release(); }
  } finally { await scheduler.stopAndDrain(); db.close(); fs.rmSync(root, { recursive: true }); }
});

test("活动检查器汇总现有持久化和运行时事实，不把 pending 队列误判为 blocker", () => {
  const gate = new WorkspaceOperationGate();
  gate.beginActivity(WORKSPACE_ID, { type: "test_background_activity", resourceId: "sync-1" });
  const db = {
    turns: {
      listRunningByWorkspace: () => ({ [THREAD_ID]: { runningTurnId: "turn-1", runningTurnStartedAt: 1 } }),
    },
    orchInstances: {
      listByWorkspace: () => [
        { id: "orch-running", status: "running", nodeStates: {} },
        { id: "orch-completed", status: "completed", nodeStates: {} },
      ],
    },
    threads: {
      listByWorkspace: () => ({ threads: [{ id: THREAD_ID }], hasMore: false, nextCursor: null }),
    },
    threadMessageQueue: {
      listActiveByThread: () => [
        { id: "queue-pending", status: "pending" },
        { id: "queue-sending", status: "sending" },
      ],
    },
    controlledExperiments: {
      listRunningForSessionGate: () => [
        { workspaceId: WORKSPACE_ID, turnId: "experiment-turn" },
        { workspaceId: "client:other", turnId: "other-turn" },
      ],
    },
    orchAssetGenerationJobs: {
      listByStatuses: () => [
        { workspaceId: WORKSPACE_ID, id: "asset-job" },
        { workspaceId: "client:other", id: "other-job" },
      ],
    },
  } as unknown as ClientDb;
  const inspector = new WorkspaceMigrationActivityInspector({
    db,
    gate,
    terminalManager: {
      list: () => [
        { id: "term-running", status: "running" },
        { id: "term-exited", status: "exited" },
      ],
    } as any,
    orchEngine: {
      listManagedServicesForThread: () => [
        { serviceId: "service-ready", status: "ready" },
        { serviceId: "service-stopped", status: "stopped" },
      ],
    } as any,
    queueRuntime: {
      listInFlightByWorkspace: () => [{ threadId: THREAD_ID, resourceId: "thread:thread-1" }],
    },
    scheduledTaskScheduler: {
      listRunningByWorkspace: () => [{ taskId: "task-1", runId: "run-1" }],
    } as any,
    dbCleanup: { isRunning: () => true } as any,
    listActiveRollbackThreadIds: () => [THREAD_ID],
  });

  assert.deepEqual(inspector.inspect(WORKSPACE_ID), [
    { type: "asset_generation_job", count: 1, resourceIds: ["asset-job"] },
    { type: "controlled_experiment", count: 1, resourceIds: ["experiment-turn"] },
    { type: "history_cleanup", count: 1, resourceIds: ["client_db_cleanup"] },
    { type: "managed_service", count: 1, resourceIds: ["service-ready"] },
    { type: "orchestration_instance", count: 1, resourceIds: ["orch-running"] },
    { type: "queue_dispatch", count: 2, resourceIds: ["queue-sending", "thread:thread-1"] },
    { type: "rollback", count: 1, resourceIds: [THREAD_ID] },
    { type: "scheduled_task", count: 1, resourceIds: ["run-1"] },
    { type: "terminal", count: 1, resourceIds: ["term-running"] },
    { type: "test_background_activity", count: 1, resourceIds: ["sync-1"] },
    { type: "turn", count: 1, resourceIds: [`${THREAD_ID}:turn-1`] },
  ]);
});

test("活动检查器放行纯等待和暂停流程，但阻止等待摘要下仍在执行的并行节点", () => {
  const db = {
    turns: { listRunningByWorkspace: () => ({}) },
    orchInstances: {
      listByWorkspace: () => [
        { id: "orch-pending", status: "pending", nodeStates: { start: { status: "pending" } } },
        { id: "orch-paused", status: "paused", nodeStates: { role: { status: "waiting-feedback" } } },
        { id: "orch-waiting-start", status: "waiting-start", nodeStates: { role: { status: "waiting-start" } } },
        { id: "orch-waiting-approval", status: "waiting-approval", nodeStates: { role: { status: "waiting-approval" } } },
        { id: "orch-waiting-feedback", status: "waiting-feedback", nodeStates: { role: { status: "waiting-feedback" } } },
        ...ACTIVE_ORCHESTRATION_NODE_STATUSES.map((status) => ({
          id: `orch-waiting-with-${status}`,
          status: "waiting-feedback",
          nodeStates: {
            waitingRole: { status: "waiting-feedback" },
            activeRole: { status },
          },
        })),
        { id: "orch-completed-with-active-node", status: "completed", nodeStates: { role: { status: "finalizing" } } },
        { id: "orch-failed-with-active-node", status: "failed", nodeStates: { role: { status: "artifact-writing" } } },
        { id: "orch-cancelled-with-active-node", status: "cancelled", nodeStates: { role: { status: "gate-checking" } } },
      ],
    },
    threads: {
      listByWorkspace: () => ({ threads: [], hasMore: false, nextCursor: null }),
    },
    threadMessageQueue: { listActiveByThread: () => [] },
    controlledExperiments: { listRunningForSessionGate: () => [] },
    orchAssetGenerationJobs: { listByStatuses: () => [] },
  } as unknown as ClientDb;
  const inspector = new WorkspaceMigrationActivityInspector({
    db,
    gate: new WorkspaceOperationGate(),
  });

  assert.deepEqual(inspector.inspect(WORKSPACE_ID), [
    {
      type: "orchestration_instance",
      count: 9,
      resourceIds: [
        "orch-cancelled-with-active-node",
        "orch-completed-with-active-node",
        "orch-failed-with-active-node",
        "orch-waiting-with-artifact-writing",
        "orch-waiting-with-finalizing",
        "orch-waiting-with-gate-checking",
        "orch-waiting-with-queued",
        "orch-waiting-with-result-submitted",
        "orch-waiting-with-running",
      ],
    },
  ]);
});
