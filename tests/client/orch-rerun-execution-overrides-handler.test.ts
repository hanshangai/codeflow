import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDefaultRoleExecutionConfig,
  type ClientToServerMessage,
  type IntakeId,
  type OrchestrationAssetRuntimeSnapshot,
  type ProposalId,
  type RoleDefinition,
  type RoleId,
  type TaskIntake,
  type WorkflowDefinition,
  type WorkflowId,
  type WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { handleOrchInstancesRerunFromNode } from "../../apps/desktop/client/src/app/handlers/orchestrationHandlers.ts";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";

test.beforeEach(() => initializeLocalEngineModelCatalog());
test.afterEach(() => resetEngineModelCatalogRuntimeForTest());
import type { ApiHandlerContext, ApiRequestMessage } from "../../apps/desktop/client/src/app/handleApiRequest.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

/** 构造直接调用重跑 handler 的最小 Client 环境，记录最终交给引擎的重跑参数。 */
function createHarness() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-orch-rerun-overrides-"));
  const workspaceId = "ws-orch-rerun-overrides" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  const sent: ClientToServerMessage[] = [];
  const rerunCalls: Array<{ instanceId: string; nodeId: string; input: unknown }> = [];
  const rerunScopeValidations: Array<{ instanceId: string; nodeId: string; nodeIds: string[] | null }> = [];
  const ctx = {
    db,
    workspaces: new Map([[workspaceId, workspacePath]]),
    orchEngine: {
      async ensureAssetRuntimeSnapshotForExecution(instanceId: string) {
        const instance = db.orchInstances.get(instanceId);
        assert.ok(instance);
        const roles: OrchestrationAssetRuntimeSnapshot["roles"] = {};
        for (const node of instance.workflowSnapshot.nodes) {
          if (node.type !== "role") continue;
          assert.ok(node.roleId);
          const role = db.orchRoles.get(node.roleId);
          assert.ok(role);
          const { createdAt, updatedAt, ...definition } = role;
          roles[role.id] = { assetType: "role", assetId: role.id, definition, source: { authorityMode: "legacy", createdAt, updatedAt } };
        }
        const assetRuntimeSnapshot: OrchestrationAssetRuntimeSnapshot = {
          authorityMode: "legacy",
          workflow: { assetType: "workflow", assetId: instance.workflowId, definition: instance.workflowSnapshot, source: null },
          roles, knowledgeBundles: {}, toolsets: {}, skills: {},
        };
        return { ...instance, assetRuntimeSnapshot };
      },
      validateRerunFromNodeScope(instanceId: string, nodeId: string, nodeIds: string[] | null): void {
        rerunScopeValidations.push({ instanceId, nodeId, nodeIds });
        if (nodeIds && !nodeIds.includes(nodeId)) throw new Error("精确重跑节点集合必须包含起点");
      },
      async rerunFromNode(instanceId: string, nodeId: string, input: unknown): Promise<void> {
        rerunCalls.push({ instanceId, nodeId, input });
      },
    },
    send(message: ClientToServerMessage): void {
      sent.push(message);
    },
  } as unknown as ApiHandlerContext;

  return {
    db,
    workspaceId,
    ctx,
    rerunCalls,
    rerunScopeValidations,
    async call(instanceId: string, targetNodeId: string, body: Record<string, unknown>) {
      const requestId = `req-${Math.random().toString(36).slice(2)}`;
      await handleOrchInstancesRerunFromNode(ctx, {
        t: "api.req",
        id: requestId,
        method: "orch.instances.rerun-from-node" as never,
        path: "/api/orch/instances/rerun-from-node",
        body: { workspaceId, instanceId, targetNodeId, ...body },
      } as ApiRequestMessage);
      const response = [...sent].reverse().find((item) => item.t === "api.res" && item.id === requestId);
      assert.ok(response, "handler 应返回 api.res");
      assert.equal(response.t, "api.res");
      return response;
    },
    cleanup(): void {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

/** 创建包含一个可执行角色节点和边界节点的实例快照。 */
function createInstance(
  harness: ReturnType<typeof createHarness>,
  status: "pending" | "running" | "cancelled" | "failed" | "completed",
) {
  const roleId = "role-rerun-overrides" as RoleId;
  const role = {
    id: roleId,
    workspaceId: harness.workspaceId,
    name: "执行角色",
    description: "测试角色",
    systemPrompt: "",
    inputDefinition: { instructions: "", requiredFields: [] },
    outputDefinition: {
      instructions: "",
      deliveryMode: "direct",
      format: "markdown",
      resultKey: null,
      filePathRule: null,
      files: [],
      requiredFields: [],
    },
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    defaultKnowledgeBundleIds: [],
    defaultSkillIds: [],
    toolRefs: [],
    kind: "custom",
    createdAt: 1,
    updatedAt: 1,
  } satisfies RoleDefinition;
  harness.db.orchRoles.upsert(role);
  const workflow: WorkflowDefinition = {
    id: "wf-rerun-overrides" as WorkflowId,
    workspaceId: harness.workspaceId,
    family: "feature-dev",
    name: "重跑覆盖测试",
    description: "验证 handler 运行覆盖写入",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "role", type: "role", roleId, label: "执行", position: { x: 0, y: 80 } },
      { id: "end", type: "end", label: "结束", position: { x: 0, y: 160 } },
    ],
    edges: [
      { id: "start-role", sourceNodeId: "start", targetNodeId: "role", dataMappings: [] },
      { id: "role-end", sourceNodeId: "role", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const intake: TaskIntake = {
    id: "intake-rerun-overrides" as IntakeId,
    workspaceId: harness.workspaceId,
    triggerMode: "manual",
    taskType: "feature",
    title: "重跑覆盖测试",
    goal: "验证运行覆盖",
    background: null,
    acceptanceCriteria: null,
    workbenchItemRefs: null,
    seedArtifactRefs: null,
    constraints: null,
    requester: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = harness.db.orchInstances.create({
    workspaceId: harness.workspaceId,
    workflowId: workflow.id,
    workflowSnapshot: workflow,
    proposalId: "proposal-rerun-overrides" as ProposalId,
    intakeSnapshot: intake,
    // 编排执行使用当前工作区的 live Role；历史实例不会冻结 roleSnapshots。
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
  });
  harness.db.orchInstances.updateStatus(instance.id, status);
  return { instance: harness.db.orchInstances.get(instance.id)!, roleId };
}

test("停止实例重跑前写入角色运行覆盖并保留审计事件", async () => {
  const harness = createHarness();
  try {
    const { instance, roleId } = createInstance(harness, "cancelled");
    const response = await harness.call(String(instance.id), "role", {
      threadReusePolicy: "new-thread",
      downstreamThreadReusePolicy: "cascade-new-thread",
      roleExecutionOverrides: {
        [roleId]: {
          engine: "codex",
          model: "gpt-5.6-terra",
          effort: "max",
          contextWindow: 372_000,
          autoCompactPct: 90,
        },
      },
      rerunNodeIds: ["role"],
      applyLatestWorkItemPolicy: true,
    });

    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(harness.rerunCalls.length, 1);
    assert.deepEqual(harness.rerunCalls[0], {
      instanceId: instance.id,
      nodeId: "role",
      input: {
        note: null,
        images: null,
        threadReusePolicy: "new-thread",
        downstreamThreadReusePolicy: "cascade-new-thread",
        rerunNodeIds: ["role"],
        applyLatestWorkItemPolicy: true,
      },
    });
    const loaded = harness.db.orchInstances.get(instance.id);
    assert.deepEqual(loaded?.runtimeConfig?.roleExecutionOverrides?.[roleId], {
      engine: "codex",
      model: "gpt-5.6-terra",
      effort: "max",
      contextWindow: 372_000,
      autoCompactPct: 90,
    });
    const event = harness.db.orchEvents.listByInstance(instance.id).find((item) => item.type === "orchestration.executionOverridesUpdated");
    assert.ok(event);
    assert.deepEqual(JSON.parse(event.payloadJson), {
      instanceId: instance.id,
      nodeId: "role",
      updatedRoleIds: [roleId],
      source: "rerun_from_node",
    });
  } finally {
    harness.cleanup();
  }
});

test("非法精确节点集合在写入运行覆盖前失败", async () => {
  const harness = createHarness();
  try {
    const { instance, roleId } = createInstance(harness, "cancelled");
    const response = await harness.call(String(instance.id), "role", {
      rerunNodeIds: ["end"],
      roleExecutionOverrides: {
        [roleId]: { engine: "codex", model: "gpt-5.6-terra", effort: "max" },
      },
    });
    assert.equal(response.status, 400);
    assert.equal(harness.rerunCalls.length, 0);
    assert.equal(harness.db.orchInstances.get(instance.id)?.runtimeConfig, null);
  } finally {
    harness.cleanup();
  }
});

test("非法工作项策略同步参数在调用重跑引擎前失败", async () => {
  const harness = createHarness();
  try {
    const { instance } = createInstance(harness, "cancelled");
    const response = await harness.call(String(instance.id), "role", {
      applyLatestWorkItemPolicy: "yes",
    });
    assert.equal(response.status, 400);
    assert.equal(harness.rerunCalls.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("失败、已完成和待启动实例也可在重跑前更新运行覆盖", async () => {
  const harness = createHarness();
  try {
    for (const status of ["failed", "completed", "pending"] as const) {
      const { instance, roleId } = createInstance(harness, status);
      const response = await harness.call(String(instance.id), "role", {
        roleExecutionOverrides: {
          [roleId]: { engine: "codex", model: "gpt-5.6-terra", effort: "max" },
        },
      });
      assert.equal(response.status, 200, status);
      assert.equal(harness.db.orchInstances.get(instance.id)?.runtimeConfig?.roleExecutionOverrides?.[roleId]?.effort, "max");
    }
    assert.equal(harness.rerunCalls.length, 3);
  } finally {
    harness.cleanup();
  }
});

test("运行中实例或非角色起点拒绝覆盖，且不调用重跑引擎", async () => {
  const harness = createHarness();
  try {
    const { instance, roleId } = createInstance(harness, "running");
    const runningResponse = await harness.call(String(instance.id), "role", {
      roleExecutionOverrides: { [roleId]: { engine: "codex", model: "gpt-5.6-terra", effort: "max" } },
    });
    assert.equal(runningResponse.status, 409);
    assert.equal(harness.db.orchInstances.get(instance.id)?.runtimeConfig, null);
    assert.equal(harness.rerunCalls.length, 0);

    const roleNodeResponse = await harness.call(String(instance.id), "start", {
      roleExecutionOverrides: { [roleId]: { engine: "codex", model: "gpt-5.6-terra", effort: "max" } },
    });
    assert.equal(roleNodeResponse.status, 400);
    assert.equal(harness.db.orchInstances.get(instance.id)?.runtimeConfig, null);
    assert.equal(harness.rerunCalls.length, 0);
  } finally {
    harness.cleanup();
  }
});
