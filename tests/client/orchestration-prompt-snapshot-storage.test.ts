import test from "node:test";
import assert from "node:assert/strict";

import type {
  NodeExecutionState,
  OrchestrationInstance,
  WorkflowNode,
  WorkspaceId,
} from "@codeflowai/shared";

import { OrchestrationEngine } from "../../apps/desktop/client/src/orchestration/orchestrationEngine.ts";

const WORKSPACE_ID = "ws-prompt-snapshot-storage" as WorkspaceId;

/** 构造带完整渲染输入的最小实例和节点。 */
function createFixture(renderedInput: string): { instance: OrchestrationInstance; node: WorkflowNode } {
  const node: WorkflowNode = {
    id: "node-storage",
    type: "role",
    roleId: "role-storage" as any,
    label: "存储节点",
    position: { x: 0, y: 0 },
  };
  const nodeState: NodeExecutionState = {
    nodeId: node.id,
    status: "running",
    renderedInput,
    promptSnapshotIds: null,
    retryCount: 0,
  };
  const instance = {
    id: "instance-storage",
    workspaceId: WORKSPACE_ID,
    workflowId: "workflow-storage",
    proposalId: null,
    intakeSnapshot: {
      id: "intake-storage",
      workspaceId: WORKSPACE_ID,
      triggerMode: "manual",
      taskType: "feature",
      title: "提示词存储",
      goal: "验证完整提示词只长期保存在 Prompt Snapshot",
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: {
      id: "workflow-storage",
      workspaceId: WORKSPACE_ID,
      name: "提示词存储流程",
      description: "",
      nodes: [node],
      edges: [],
      version: 1,
    },
    assetRuntimeSnapshot: null,
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: null,
    status: "running",
    nodeStates: { [node.id]: nodeState },
    createdAt: 1,
    updatedAt: 1,
  } as OrchestrationInstance;
  return { instance, node };
}

/** 构造只覆盖 Prompt Snapshot 持久化边界的引擎上下文。 */
function createHarness(instance: OrchestrationInstance, options?: { snapshotError?: Error }) {
  const snapshots: any[] = [];
  const persistedStates: Array<Record<string, NodeExecutionState>> = [];
  const events: any[] = [];
  const engine = new OrchestrationEngine({
    db: {
      orchPromptSnapshots: {
        create(input: Record<string, unknown>) {
          if (options?.snapshotError) throw options.snapshotError;
          const snapshot = { id: "snapshot-storage", ...input };
          snapshots.push(snapshot);
          return snapshot;
        },
      },
      orchInstances: {
        get: () => instance,
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          persistedStates.push(structuredClone(nodeStates));
          instance.nodeStates = nodeStates;
        },
      },
      orchEvents: {
        append(input: Record<string, unknown>) {
          const event = { id: `event-${events.length + 1}`, ...input };
          events.push(event);
          return event;
        },
      },
    },
  } as any);
  return { engine, snapshots, persistedStates, events };
}

/** 构造 createPromptSnapshot 所需的最小完整输入。 */
function createSnapshotInput(renderedInputPreview: string): any {
  return {
    threadId: null,
    turnId: null,
    engine: "codex",
    model: "gpt-5",
    effort: "medium",
    promptEnvelope: { meta: { roleExecutionRevision: null } },
    systemMessage: "system",
    developerMessage: "developer",
    userMessage: "user",
    renderedInputPreview,
    runtimePolicy: {},
    toolRegistry: null,
    knowledgeCatalogs: [],
    knowledgeWarnings: [],
    artifactInput: null,
  };
}

test("successful prompt snapshot persistence clears duplicated node renderedInput", () => {
  const renderedInput = "完整提示词".repeat(100_000);
  const { instance, node } = createFixture(renderedInput);
  const harness = createHarness(instance);

  const snapshot = (harness.engine as any).createPromptSnapshot(
    instance,
    node,
    createSnapshotInput(renderedInput),
  );

  assert.equal(snapshot.renderedInputPreview, renderedInput);
  assert.equal(harness.snapshots[0]?.renderedInputPreview, renderedInput);
  assert.equal(instance.nodeStates[node.id]?.renderedInput, null);
  assert.deepEqual(instance.nodeStates[node.id]?.promptSnapshotIds, ["snapshot-storage"]);
  assert.equal(harness.persistedStates.length, 1);
  assert.equal(harness.persistedStates[0]?.[node.id]?.renderedInput, null);
  assert.deepEqual(harness.persistedStates[0]?.[node.id]?.promptSnapshotIds, ["snapshot-storage"]);
  assert.equal(harness.events.length, 1);
});

test("failed prompt snapshot persistence keeps node renderedInput for diagnosis", () => {
  const renderedInput = "快照写入失败前的完整提示词";
  const { instance, node } = createFixture(renderedInput);
  const harness = createHarness(instance, { snapshotError: new Error("snapshot insert failed") });

  assert.throws(
    () => (harness.engine as any).createPromptSnapshot(
      instance,
      node,
      createSnapshotInput(renderedInput),
    ),
    /snapshot insert failed/,
  );
  assert.equal(instance.nodeStates[node.id]?.renderedInput, renderedInput);
  assert.equal(instance.nodeStates[node.id]?.promptSnapshotIds, null);
  assert.equal(harness.persistedStates.length, 0);
  assert.equal(harness.events.length, 0);
});
