import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type OrchestrationAssetRuntimeSnapshot,
  type TaskIntake,
  type WorkflowRuntimeDefinition,
  type WorkspaceId,
} from "../../../../packages/shared/src/index.ts";
import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { OrchInstanceSummaryProjectionReader } from "../src/db/orchInstanceSummaryProjection.ts";
import { OrchEventRepo } from "../src/db/repos/orchEventRepo.ts";
import { OrchIntakeListStateRepo } from "../src/db/repos/orchIntakeListStateRepo.ts";
import { OrchInstanceRepo } from "../src/db/repos/orchInstanceRepo.ts";
import { WorkspaceRepo } from "../src/db/repos/workspaceRepo.ts";
import { openSqliteDb } from "../src/db/sqliteDb.ts";
import { OrchAssetLegacyInstanceBackfillService } from "../src/orchestration/orchAssetLegacyInstanceBackfillService.ts";

const WORKSPACE_ID = "ws-legacy-backfill" as WorkspaceId;

/** 打开一个真实迁移后的内存库，并创建历史无完整图实例。 */
function createHarness(server = false) {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  new WorkspaceRepo(db).upsert({ id: WORKSPACE_ID, title: "兼容补录", path: "D:/legacy-backfill" });
  const instanceSummaries = new OrchInstanceSummaryProjectionReader(db);
  const intakeListStates = new OrchIntakeListStateRepo(db, instanceSummaries);
  const orchInstances = new OrchInstanceRepo(db, intakeListStates, instanceSummaries);
  const orchEvents = new OrchEventRepo(db);
  const fixture = createFixture(server);
  const instance = orchInstances.create({
    workspaceId: WORKSPACE_ID,
    workflowId: fixture.workflow.id,
    workflowSnapshot: fixture.workflow,
    intakeSnapshot: fixture.intake,
  });
  orchInstances.updateStatus(instance.id, "running");
  return { db, orchInstances, orchEvents, fixture, instance: orchInstances.get(instance.id)! };
}

/** 构造一个最小且依赖闭合的 Server 权威运行图。 */
function createFixture(server: boolean) {
  const workflow: WorkflowRuntimeDefinition = {
    id: "wf-legacy-backfill" as any,
    workspaceId: WORKSPACE_ID,
    family: "feature-dev",
    name: "兼容补录工作流",
    description: "升级后补录完整运行图",
    nodes: [{
      id: "implementation",
      type: "role",
      roleId: "role-legacy-backfill" as any,
      label: "实现",
      position: { x: 0, y: 0 },
    }],
    edges: [],
    version: 1,
  };
  const snapshot: OrchestrationAssetRuntimeSnapshot = {
    authorityMode: server ? "server" : "legacy",
    workflow: {
      assetType: "workflow",
      assetId: workflow.id,
      definition: workflow,
      source: null,
    },
    roles: {
      "role-legacy-backfill": {
        assetType: "role",
        assetId: "role-legacy-backfill",
        definition: {
          id: "role-legacy-backfill" as any,
          workspaceId: WORKSPACE_ID,
          name: "升级兼容角色",
          description: "用于历史实例补录",
          responsibility: "执行历史流程",
          systemPrompt: "按冻结定义执行",
          inputDefinition: createDefaultRoleInputDefinition(),
          outputDefinition: createDefaultRoleOutputDefinition(),
          gateCriteria: [],
          executionConfig: createDefaultRoleExecutionConfig("codex"),
          defaultKnowledgeBundleIds: [],
          defaultSkillIds: [],
          toolRefs: [],
          kind: "custom",
        },
        source: server ? serverSource(11) : { authorityMode: "legacy", createdAt: 1, updatedAt: 1 },
      },
    },
    knowledgeBundles: {},
    toolsets: {},
    skills: {},
  };
  const intake: TaskIntake = {
    id: "intake-legacy-backfill" as any,
    workspaceId: WORKSPACE_ID,
    triggerMode: "manual",
    taskType: "feature",
    title: "兼容补录",
    goal: "验证历史实例升级补录",
    createdAt: 1,
    updatedAt: 1,
  };
  return { workflow, snapshot, intake };
}

/** 构造稳定的 Server 来源元数据。 */
function serverSource(syncChangeSeq: number) {
  return {
    authorityMode: "server" as const,
    metadata: {
      revision: 4,
      scopeType: "user" as const,
      syncChangeSeq,
      contentHash: "a".repeat(64),
      cacheStatus: "ready" as const,
    },
  };
}

test("历史非终态实例补录完整图和捕获事件，重复调用不覆盖", () => {
  const harness = createHarness();
  let launchCalls = 0;
  const service = new OrchAssetLegacyInstanceBackfillService(
    harness as any,
    {
      createFromWorkflow() {
        launchCalls += 1;
        return structuredClone(harness.fixture.snapshot);
      },
    },
  );
  try {
    const first = service.ensureForExecution(harness.instance.id);
    const persistedAfterFirst = harness.orchInstances.get(harness.instance.id)!;
    const firstJson = JSON.stringify(persistedAfterFirst.assetRuntimeSnapshot);
    const second = service.ensureForExecution(harness.instance.id);
    const events = harness.orchEvents.listByInstance(harness.instance.id);

    assert.equal(first?.roles["role-legacy-backfill"]?.definition.name, "升级兼容角色");
    assert.equal(second?.roles["role-legacy-backfill"]?.definition.name, "升级兼容角色");
    assert.equal(launchCalls, 1);
    assert.equal(JSON.stringify(harness.orchInstances.get(harness.instance.id)?.assetRuntimeSnapshot), firstJson);
    assert.equal(Object.hasOwn(persistedAfterFirst.roleSnapshots?.["role-legacy-backfill"] ?? {}, "createdAt"), false);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "orchestration.assetRuntimeSnapshotBackfilled");
    const payload = JSON.parse(events[0]!.payloadJson);
    assert.equal(payload.source, "legacy_upgrade");
    assert.equal(payload.authorityMode, "legacy");
    assert.equal(payload.capturedAt, events[0]?.createdAt);
  } finally {
    harness.db.close();
  }
});

test("历史 Server 运行图显式拒绝执行且不改写已有实例或事件", () => {
  const harness = createHarness(true);
  harness.orchInstances.backfillAssetRuntimeSnapshot(harness.instance.id, harness.fixture.snapshot);
  const before = harness.orchInstances.get(harness.instance.id);
  const service = new OrchAssetLegacyInstanceBackfillService(harness as any, {
    createFromWorkflow() { throw new Error("UNEXPECTED_LOCAL_BACKFILL"); },
  });
  try {
    assert.throws(() => service.ensureForExecution(harness.instance.id),
      (error: unknown) => (error as { code?: string }).code === "ASSET_CACHE_EXECUTION_REMOVED");
    assert.deepEqual(harness.orchInstances.get(harness.instance.id), before);
    assert.deepEqual(harness.orchEvents.listByInstance(harness.instance.id), []);
  } finally { harness.db.close(); }
});

test("完整图解析失败时保持历史实例和事件零写入", () => {
  const harness = createHarness();
  const service = new OrchAssetLegacyInstanceBackfillService(harness as any, {
    createFromWorkflow() {
      throw new Error("authority cache unavailable");
    },
  });
  try {
    assert.throws(() => service.ensureForExecution(harness.instance.id), /authority cache unavailable/);
    assert.equal(harness.orchInstances.get(harness.instance.id)?.assetRuntimeSnapshot, null);
    assert.equal(harness.orchEvents.listByInstance(harness.instance.id).length, 0);
  } finally {
    harness.db.close();
  }
});

test("补录事件写入失败时完整图和兼容快照整体回滚", () => {
  const harness = createHarness();
  const service = new OrchAssetLegacyInstanceBackfillService({
    db: harness.db,
    orchInstances: harness.orchInstances,
    orchEvents: {
      append() {
        throw new Error("event append failed");
      },
    } as any,
  }, {
    createFromWorkflow() {
      return structuredClone(harness.fixture.snapshot);
    },
  });
  try {
    assert.throws(() => service.ensureForExecution(harness.instance.id), /event append failed/);
    const persisted = harness.orchInstances.get(harness.instance.id);
    assert.equal(persisted?.assetRuntimeSnapshot, null);
    assert.deepEqual(persisted?.roleSnapshots, {});
    assert.equal(harness.orchEvents.listByInstance(harness.instance.id).length, 0);
  } finally {
    harness.db.close();
  }
});

test("终态历史实例跳过补录且不读取当前权威资产", () => {
  const harness = createHarness();
  harness.orchInstances.updateStatus(harness.instance.id, "completed");
  let launchCalls = 0;
  const service = new OrchAssetLegacyInstanceBackfillService(harness as any, {
    createFromWorkflow() {
      launchCalls += 1;
      return structuredClone(harness.fixture.snapshot);
    },
  });
  try {
    assert.equal(service.ensureForExecution(harness.instance.id), null);
    assert.equal(launchCalls, 0);
    assert.equal(harness.orchInstances.get(harness.instance.id)?.assetRuntimeSnapshot, null);
    assert.equal(harness.orchEvents.listByInstance(harness.instance.id).length, 0);
  } finally {
    harness.db.close();
  }
});
