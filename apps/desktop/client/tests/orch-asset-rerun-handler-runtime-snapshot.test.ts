import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type OrchestrationInstance,
} from "../../../../packages/shared/src/index.ts";
import { handleOrchInstancesRerunFromNode } from "../src/app/handlers/orchestrationHandlers.ts";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";

const FROZEN_MODEL = "gpt-6.1-sol";

/** 构造带冻结角色完整图的暂停实例。 */
function createInstance(): OrchestrationInstance {
  const workspaceId = "ws-rerun-snapshot" as any;
  const role = {
    id: "role-rerun-snapshot" as any,
    workspaceId,
    name: "冻结角色",
    description: "冻结角色",
    responsibility: "执行重跑任务",
    systemPrompt: "使用冻结定义",
    inputDefinition: createDefaultRoleInputDefinition(),
    outputDefinition: createDefaultRoleOutputDefinition(),
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    defaultKnowledgeBundleIds: [],
    toolRefs: [],
    kind: "custom" as const,
  };
  const workflow = {
    id: "wf-rerun-snapshot" as any,
    workspaceId,
    family: "feature-dev" as const,
    name: "冻结工作流",
    description: "冻结工作流",
    workflowKnowledgeBundleIds: [],
    nodes: [{
      id: "implementation",
      type: "role" as const,
      roleId: role.id,
      label: "实现",
      position: { x: 0, y: 0 },
    }],
    edges: [],
    version: 1,
  };
  return {
    id: "orch-rerun-snapshot" as any,
    workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake-rerun-snapshot" as any,
      workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "重跑快照",
      goal: "验证重跑只读完整图",
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: {
      authorityMode: "legacy",
      workflow: { assetType: "workflow", assetId: workflow.id, definition: workflow, source: null },
      roles: {
        [role.id]: {
          assetType: "role",
          assetId: role.id,
          definition: role,
          source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 },
        },
      },
      knowledgeBundles: {},
      toolsets: {},
      skills: {},
    },
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: null,
    status: "paused",
    nodeStates: {
      implementation: { nodeId: "implementation", status: "waiting-feedback", retryCount: 0 },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 构造重跑 handler 请求。 */
function createRequest(instance: OrchestrationInstance) {
  return {
    t: "api.req",
    id: "req-rerun-snapshot",
    method: "orch.instances.rerunFromNode",
    body: {
      workspaceId: instance.workspaceId,
      instanceId: instance.id,
      targetNodeId: "implementation",
      roleExecutionOverrides: {
        "role-rerun-snapshot": { model: FROZEN_MODEL },
      },
    },
  } as any;
}

test("重跑补录失败时不写运行覆盖或事件", async () => {
  const instance = createInstance();
  const responses: any[] = [];
  let runtimeConfigWrites = 0;
  let eventWrites = 0;
  let rerunCalls = 0;
  await handleOrchInstancesRerunFromNode({
    db: {
      orchInstances: {
        get: () => instance,
        updateRuntimeConfig() { runtimeConfigWrites += 1; },
      },
      orchEvents: { append() { eventWrites += 1; } },
      orchRoles: { get() { throw new Error("live role repo should not be called"); } },
    },
    workspaces: new Map([[instance.workspaceId, "D:/workspace"]]),
    orchEngine: {
      async ensureAssetRuntimeSnapshotForExecution() { throw new Error("snapshot backfill failed"); },
      validateRerunFromNodeScope() {},
      async rerunFromNode() { rerunCalls += 1; },
    },
    send(message: unknown) { responses.push(message); },
  } as any, createRequest(instance));

  assert.equal(responses[0]?.status, 400);
  assert.match(String(responses[0]?.body?.message ?? ""), /snapshot backfill failed/);
  assert.equal(runtimeConfigWrites, 0);
  assert.equal(eventWrites, 0);
  assert.equal(rerunCalls, 0);
});

test("重跑覆盖只使用实例完整图中的冻结角色", async t => {
  resetEngineModelCatalogRuntimeForTest();
  initializeLocalEngineModelCatalog();
  t.after(() => resetEngineModelCatalogRuntimeForTest());
  const instance = createInstance();
  const responses: any[] = [];
  let persistedRuntimeConfig: unknown = null;
  let eventWrites = 0;
  let rerunCalls = 0;
  await handleOrchInstancesRerunFromNode({
    db: {
      orchInstances: {
        get: () => instance,
        updateRuntimeConfig(_instanceId: string, value: unknown) { persistedRuntimeConfig = value; },
      },
      orchEvents: { append() { eventWrites += 1; } },
      orchRoles: { get() { throw new Error("live role repo should not be called"); } },
    },
    workspaces: new Map([[instance.workspaceId, "D:/workspace"]]),
    orchEngine: {
      async ensureAssetRuntimeSnapshotForExecution() { return instance; },
      validateRerunFromNodeScope() {},
      async rerunFromNode() { rerunCalls += 1; },
    },
    send(message: unknown) { responses.push(message); },
  } as any, createRequest(instance));

  assert.equal(responses[0]?.status, 200);
  assert.equal((persistedRuntimeConfig as any)?.roleExecutionOverrides?.["role-rerun-snapshot"]?.model, FROZEN_MODEL);
  assert.equal(eventWrites, 1);
  assert.equal(rerunCalls, 1);
});
