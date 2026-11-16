import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceId } from "@codeflowai/shared";

import { handleApiRequest } from "../src/app/handleApiRequest.ts";
import {
  WorkspaceOperationGate,
  WorkspaceOperationGateError,
} from "../src/workspace-migration/workspaceOperationGate.ts";

const WORKSPACE_ID = "client:workspace" as WorkspaceId;

test("既有写凭据只在同步续体内排空原工作区，释放后或跨工作区不可重用", async () => {
  const gate = new WorkspaceOperationGate(), other = "client:other" as WorkspaceId;
  const write = gate.beginWrite(WORKSPACE_ID), otherWrite = gate.beginWrite(other);
  const firstMigration = gate.acquireMigration(WORKSPACE_ID, "move-first");
  const secondMigration = gate.acquireMigration(other, "move-other");
  try {
    assert.equal(typeof write.run, "function");
    assert.throws(() => gate.beginWrite(WORKSPACE_ID), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
    write.run(() => {
      assert.throws(() => write(), /WORKSPACE_WRITE_CONTINUATION_ACTIVE/u);
      const nested = gate.beginWrite(WORKSPACE_ID); nested();
      assert.throws(() => gate.beginWrite(other), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
      assert.throws(() => write.run(() => Promise.resolve()), /WORKSPACE_WRITE_CONTINUATION_MUST_BE_SYNCHRONOUS/u);
    });
    assert.throws(() => gate.beginWrite(WORKSPACE_ID), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
  } finally { write(); otherWrite(); (await firstMigration)(); (await secondMigration)(); }
  assert.throws(() => write.run(() => gate.beginWrite(WORKSPACE_ID)()), /WORKSPACE_WRITE_CONTINUATION_RELEASED/u);
  assert.equal(gate.hasActiveWrites(), false);
});

for(const mode of ["acquire","restore"] as const)test(`D18 ${mode} close 未完成拒绝 release，资源关闭后同 owner 可重试释放`,async()=>{
  const gate=new WorkspaceOperationGate();
  const release=mode==="acquire"?await gate.acquireMigration(WORKSPACE_ID,"resource-owner"):gate.restoreMigration(WORKSPACE_ID,"resource-owner");
  const close=gate.beginScheduledTaskOperation(WORKSPACE_ID,"resource-owner","snapshot");
  assert.throws(()=>gate.beginScheduledTaskOperation(WORKSPACE_ID,"foreign-owner","snapshot"));
  assert.throws(()=>release(),/WORKSPACE_DB_HANDOFF_RESOURCES_OPEN/);assert.equal(gate.getMigrationOperationId(WORKSPACE_ID),"resource-owner");
  close();release();assert.equal(gate.getMigrationOperationId(WORKSPACE_ID),null);assert.equal(gate.hasActiveWrites(),false);
});

test("D18 定时有限准入匹配真实 config owner，最终交接拒绝延期且等待既有短资源",async()=>{
  const gate=new WorkspaceOperationGate(),release=await gate.acquireMigration(WORKSPACE_ID,"config:scheduled");
  assert.throws(()=>gate.beginScheduledTaskOperation(WORKSPACE_ID,"other","snapshot"));
  const finish=gate.beginScheduledTaskOperation(WORKSPACE_ID,"config:scheduled","defer");
  let drained=false;const entering=gate.beginFinalHandoff(WORKSPACE_ID,"config:scheduled").then(value=>{drained=true;return value;});
  await Promise.resolve();assert.equal(drained,false);
  assert.throws(()=>gate.beginScheduledTaskOperation(WORKSPACE_ID,"config:scheduled","defer"));
  finish();const handoff=await entering;handoff.complete();release();assert.equal(gate.hasActiveWrites(),false);
});

test("D18 最终交接只允许当前 owner 并保持普通写门禁", async () => {
  const gate = new WorkspaceOperationGate();
  await gate.waitForFinalHandoff(WORKSPACE_ID);
  const release = await gate.acquireMigration(WORKSPACE_ID, "handoff-owner");
  await assert.rejects(gate.beginFinalHandoff(WORKSPACE_ID, "foreign-owner"), { code: "WORKSPACE_MIGRATION_BUSY" });
  const handoff = await gate.beginFinalHandoff(WORKSPACE_ID, "handoff-owner");
  let resumed = false;
  const waiting = gate.waitForFinalHandoff(WORKSPACE_ID).then(() => { resumed = true; });
  await Promise.resolve(); assert.equal(resumed, false);
  assert.throws(() => gate.beginWrite(WORKSPACE_ID), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
  handoff.complete(); await waiting;
  assert.equal(resumed, true); assert.equal(gate.getMigrationOperationId(WORKSPACE_ID), "handoff-owner");
  release(); assert.doesNotThrow(() => gate.beginWrite(WORKSPACE_ID)());
});

test("D18 最终交接失败明确拒绝等待者并保 owner 到安全释放", async () => {
  const gate = new WorkspaceOperationGate();
  const release = await gate.acquireMigration(WORKSPACE_ID, "failed-handoff");
  const handoff = await gate.beginFinalHandoff(WORKSPACE_ID, "failed-handoff");
  const failure = new Error("DB_RESOURCE_NOT_CLOSED");
  const waiting = assert.rejects(gate.waitForFinalHandoff(WORKSPACE_ID), error => error === failure);
  handoff.fail(failure); await waiting;
  await assert.rejects(gate.waitForFinalHandoff(WORKSPACE_ID), error => error === failure);
  assert.equal(gate.getMigrationOperationId(WORKSPACE_ID), "failed-handoff");
  release(); await gate.waitForFinalHandoff(WORKSPACE_ID);
});

test("更新只读查询原短事务计数，不预留迁移或修改活动", () => {
  const gate = new WorkspaceOperationGate();
  assert.equal(gate.hasActiveWrites(), false);
  const release = gate.beginWrite(WORKSPACE_ID);
  assert.equal(gate.hasActiveWrites(), true);
  assert.equal(gate.getMigrationOperationId(WORKSPACE_ID), null);
  assert.deepEqual(gate.listActivities(WORKSPACE_ID), []);
  release();
  assert.equal(gate.hasActiveWrites(), false);
});

test("迁移预留先阻止新写，并等待已登记短事务退出", async () => {
  const gate = new WorkspaceOperationGate();
  const releaseWrite = gate.beginWrite(WORKSPACE_ID);
  let acquired = false;
  const acquiring = gate.acquireMigration(WORKSPACE_ID, "operation-1", { drainTimeoutMs: 1_000 })
    .then((release) => {
      acquired = true;
      return release;
    });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(acquired, false);
  assert.equal(gate.getMigrationOperationId(WORKSPACE_ID), "operation-1");
  assert.throws(
    () => gate.beginWrite(WORKSPACE_ID),
    (error) => error instanceof WorkspaceOperationGateError && error.code === "WORKSPACE_MIGRATION_IN_PROGRESS",
  );

  releaseWrite();
  const releaseMigration = await acquiring;
  assert.equal(acquired, true);
  releaseMigration();
  assert.equal(gate.getMigrationOperationId(WORKSPACE_ID), null);
});

test("短事务排空超时会释放迁移预留，不遗留 owner", async () => {
  const gate = new WorkspaceOperationGate();
  const releaseWrite = gate.beginWrite(WORKSPACE_ID);
  await assert.rejects(
    gate.acquireMigration(WORKSPACE_ID, "operation-timeout", { drainTimeoutMs: 10 }),
    (error) => error instanceof WorkspaceOperationGateError && error.code === "WORKSPACE_MIGRATION_BUSY",
  );
  assert.equal(gate.getMigrationOperationId(WORKSPACE_ID), null);
  releaseWrite();
});

test("长时活动使用稳定类型与资源 ID，并在 release 后移除", () => {
  const gate = new WorkspaceOperationGate();
  const release = gate.beginActivity(WORKSPACE_ID, { type: "test_background_activity", resourceId: "sync-1" });
  assert.deepEqual(gate.listActivities(WORKSPACE_ID), [
    { type: "test_background_activity", resourceId: "sync-1" },
  ]);
  release();
  release();
  assert.deepEqual(gate.listActivities(WORKSPACE_ID), []);
});

test("会启动工作区运行时的 API 在迁移期间统一返回 409", async () => {
  const gate = new WorkspaceOperationGate();
  const release = await gate.acquireMigration(WORKSPACE_ID, "operation-api-gate");
  const responses: any[] = [];
  const diagnostics: unknown[] = [];
  const ctx = {
    workspaceOperationGate: gate,
    workspaces: new Map([[WORKSPACE_ID, "/test/workspace"]]),
    db: {
      /** 本测试只验证门禁，保留真实 API 的工作区作用域与诊断契约。 */
      forWorkspace() { return this; },
      writeWorkspaceLog: (...entry: unknown[]) => diagnostics.push(entry),
    },
    send: (message: unknown) => responses.push(message),
  } as any;
  try {
    await handleApiRequest(ctx, {
      t: "api.req",
      id: "request-send",
      method: "threads.sendMessage",
      path: "/api/threads/send",
      body: { workspaceId: WORKSPACE_ID, threadId: "thread-1", text: "test" },
    } as any);
    await handleApiRequest(ctx, {
      t: "api.req",
      id: "request-orchestration-start",
      method: "orch.instances.start",
      path: "/api/orch/instances/start",
      body: { workspaceId: WORKSPACE_ID, workflowId: "workflow-1" },
    } as any);

    assert.deepEqual(responses.map((response) => ({
      id: response.id,
      status: response.status,
      code: response.body?.code,
    })), [
      { id: "request-send", status: 409, code: "WORKSPACE_MIGRATION_IN_PROGRESS" },
      { id: "request-orchestration-start", status: 409, code: "WORKSPACE_MIGRATION_IN_PROGRESS" },
    ], JSON.stringify(diagnostics));
  } finally {
    release();
  }
});
