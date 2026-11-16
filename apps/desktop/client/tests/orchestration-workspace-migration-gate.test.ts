import assert from "node:assert/strict";
import test from "node:test";

import type { OrchestrationId, WorkspaceId } from "@codeflowai/shared";

import type { ClientDb } from "../src/db/clientDb.ts";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.ts";
import { WorkspaceMigrationActivityInspector } from "../src/workspace-migration/workspaceMigrationActivityInspector.ts";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.ts";

const WORKSPACE_ID = "client:workspace" as WorkspaceId;
const INSTANCE_ID = "orch-waiting" as OrchestrationId;

test("编排后台续跑在定时器交接完成前登记稳定的工作区活动", async () => {
  const gate = new WorkspaceOperationGate();
  const instance = { id: INSTANCE_ID, workspaceId: WORKSPACE_ID };
  const db = {
    turns: { listRunningByWorkspace: () => ({}) },
    orchInstances: {
      get: (instanceId: OrchestrationId) => instanceId === INSTANCE_ID ? instance : null,
      listByWorkspace: () => [],
    },
    threads: { listByWorkspace: () => ({ threads: [], hasMore: false, nextCursor: null }) },
    threadMessageQueue: { listActiveByThread: () => [] },
    controlledExperiments: { listRunningForSessionGate: () => [] },
    orchAssetGenerationJobs: { listByStatuses: () => [] },
  } as unknown as ClientDb;
  const engine = new OrchestrationEngine({
    db,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    emitConversation() {},
    emitRaw() {},
    beginWorkspaceActivity: (workspaceId, instanceId) => gate.beginActivity(workspaceId, {
      type: "orchestration_instance",
      resourceId: instanceId,
    }),
  });
  let finishFirstTask!: () => void;
  let finishSecondTask!: () => void;
  const firstTaskPending = new Promise<void>((resolve) => { finishFirstTask = resolve; });
  const secondTaskPending = new Promise<void>((resolve) => { finishSecondTask = resolve; });
  let startedTaskCount = 0;

  (engine as any).scheduleDatabaseContinuation(
    INSTANCE_ID,
    async () => {
      startedTaskCount += 1;
      await firstTaskPending;
    },
    (error: unknown) => assert.fail(String(error)),
  );
  (engine as any).scheduleDatabaseContinuation(
    INSTANCE_ID,
    async () => {
      startedTaskCount += 1;
      await secondTaskPending;
    },
    (error: unknown) => assert.fail(String(error)),
  );

  assert.deepEqual(gate.listActivities(WORKSPACE_ID), [
    { type: "orchestration_instance", resourceId: INSTANCE_ID },
  ]);
  const inspector = new WorkspaceMigrationActivityInspector({ db, gate });
  assert.deepEqual(inspector.inspect(WORKSPACE_ID), [
    { type: "orchestration_instance", count: 1, resourceIds: [INSTANCE_ID] },
  ]);

  const releaseMigration = await gate.acquireMigration(WORKSPACE_ID, "migration-1", { drainTimeoutMs: 1_000 });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(startedTaskCount, 2);
  assert.equal(gate.getMigrationOperationId(WORKSPACE_ID), "migration-1");
  assert.equal(gate.listActivities(WORKSPACE_ID).length, 1);

  finishFirstTask();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gate.listActivities(WORKSPACE_ID).length, 1);

  finishSecondTask();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(gate.listActivities(WORKSPACE_ID), []);
  releaseMigration();
});
