import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  NodeExecutionState,
  OrchestrationInstance,
  WorkspaceId,
  WorkflowDefinition,
} from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

/** 创建临时 client DB，用于验证实例运行态补丁的持久化读取形态。 */
function createHarness() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-orch-runtime-patch-"));
  const workspaceId = "ws-orch-runtime-patch" as WorkspaceId;
  const dbPath = path.join(workspacePath, "client.db");
  const db = openClientDb({ dbPath });
  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  return {
    db,
    workspaceId,
    cleanup() {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

/** 构造最小工作流，保持 runSummary 可正常派生。 */
function buildWorkflow(workspaceId: WorkspaceId): WorkflowDefinition {
  return {
    id: "wf-runtime-patch" as any,
    workspaceId,
    family: "feature-dev",
    name: "运行态补丁测试",
    description: "验证轻量运行态响应",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "role", type: "role", roleId: "role-test" as any, label: "执行", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 创建带大字段的实例，便于断言 runtime patch 不泄露详情快照。 */
function createRichInstance(workspaceId: WorkspaceId, workflow: WorkflowDefinition): OrchestrationInstance {
  return {
    id: "instance-runtime-patch" as any,
    workspaceId,
    workflowId: workflow.id,
    proposalId: "proposal-runtime-patch" as any,
    intakeSnapshot: {
      id: "intake-runtime-patch" as any,
      workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "运行态补丁验证",
      goal: "验证轮询接口不会返回大字段",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    roleSnapshots: {
      "role-test": {
        id: "role-test",
        name: "执行",
        systemPrompt: "role snapshot large text",
      },
    } as any,
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: { role: ["artifact-runtime-patch" as any] },
    masterThreadId: "thread-master-runtime-patch" as any,
    status: "running",
    nodeStates: {
      role: {
        nodeId: "role",
        status: "result-submitted",
        attemptId: "attempt-runtime-patch",
        attemptNo: 3,
        submissionId: "attempt-runtime-patch",
        parentExecutionId: "attempt-runtime-patch-parent",
        humanActionSource: null,
        threadId: "thread-role-runtime-patch" as any,
        previousThreadIds: ["thread-role-runtime-patch-old" as any],
        discussionThreadId: "thread-discussion-runtime-patch" as any,
        renderedInput: "rendered input large text",
        output: "output large text",
        promptSnapshotIds: ["prompt-runtime-patch"],
        knowledgeWarnings: ["warning-runtime-patch"],
        gateResults: null,
        conclusion: {
          nextAction: "continue",
          reviewVerdict: "pass",
          summary: "conclusion large text",
          blockingIssues: null,
          acceptanceChecks: [],
          humanInput: null,
          rework: null,
          decidedBy: "model",
          decidedAt: 2,
        },
        retryCount: 1,
        startedAt: 2,
        completedAt: null,
        error: "原 provider 会话明确不可恢复",
        errorCode: "codex_thread_resume_unrecoverable",
        providerThreadId: "provider-thread-runtime-patch",
        recoveryReason: "resume_unavailable_and_read_failed",
        preserveBinding: true,
        userChoiceRequired: true,
        recoveryStrategies: ["retry-existing", "new-thread"],
        branchTaken: null,
        inputArtifactIds: ["artifact-input-runtime-patch" as any],
        outputArtifactIds: ["artifact-runtime-patch" as any],
        activeFeedbackRecordIds: ["feedback-active-runtime-patch" as any],
        feedbackRecordIds: ["feedback-runtime-patch" as any],
      } satisfies NodeExecutionState,
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

test("orch instance runtime patch excludes role snapshots and rich node detail fields", () => {
  const harness = createHarness();
  try {
    const workflow = buildWorkflow(harness.workspaceId);
    const instance = createRichInstance(harness.workspaceId, workflow);
    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      masterThreadId: instance.masterThreadId,
      proposalId: instance.proposalId,
      intakeSnapshot: instance.intakeSnapshot,
      roleSnapshots: instance.roleSnapshots,
      toolsetSnapshots: instance.toolsetSnapshots,
      runtimeConfig: instance.runtimeConfig,
      artifactIndex: instance.artifactIndex,
    });
    harness.db.orchInstances.updateStatus(created.id, "running");
    harness.db.orchInstances.updateNodeStates(created.id, instance.nodeStates);

    const patch = harness.db.orchInstances.getRuntimePatch(created.id);
    assert.ok(patch);
    assert.equal((patch as any).roleSnapshots, undefined);
    assert.equal((patch as any).toolsetSnapshots, undefined);
    assert.equal((patch as any).runtimeConfig, undefined);
    assert.equal((patch.nodeStates.role as any).renderedInput, undefined);
    assert.equal((patch.nodeStates.role as any).output, undefined);
    assert.equal((patch.nodeStates.role as any).conclusion, undefined);
    assert.equal(patch.nodeStates.role.attemptId, "attempt-runtime-patch");
    assert.equal(patch.nodeStates.role.nodeExecutionId, "attempt-runtime-patch");
    assert.equal(patch.nodeStates.role.attemptNo, 3);
    assert.equal(patch.nodeStates.role.submissionId, "attempt-runtime-patch");
    assert.equal(patch.nodeStates.role.parentExecutionId, "attempt-runtime-patch-parent");
    assert.equal(patch.nodeStates.role.threadId, "thread-role-runtime-patch");
    assert.deepEqual(patch.nodeStates.role.previousThreadIds, ["thread-role-runtime-patch-old"]);
    assert.deepEqual(patch.nodeStates.role.promptSnapshotIds, ["prompt-runtime-patch"]);
    assert.equal(patch.nodeStates.role.errorCode, "codex_thread_resume_unrecoverable");
    assert.equal(patch.nodeStates.role.providerThreadId, "provider-thread-runtime-patch");
    assert.equal(patch.nodeStates.role.recoveryReason, "resume_unavailable_and_read_failed");
    assert.equal(patch.nodeStates.role.preserveBinding, true);
    assert.equal(patch.nodeStates.role.userChoiceRequired, true);
    assert.deepEqual(patch.nodeStates.role.recoveryStrategies, ["retry-existing", "new-thread"]);
    const serialized = JSON.stringify(patch);
    assert.equal(serialized.includes("role snapshot large text"), false);
    assert.equal(serialized.includes("rendered input large text"), false);
    assert.equal(serialized.includes("output large text"), false);
    assert.equal(serialized.includes("conclusion large text"), false);
  } finally {
    harness.cleanup();
  }
});

test("orch instance access projection reads only ACL fields and preserves source kind", () => {
  const harness = createHarness();
  try {
    const workflow = buildWorkflow(harness.workspaceId);
    const requirement = createRichInstance(harness.workspaceId, workflow);
    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      proposalId: requirement.proposalId,
      intakeSnapshot: requirement.intakeSnapshot,
    });
    const projection = harness.db.orchInstances.getAccessProjection(created.id);

    assert.deepEqual(projection, {
      id: created.id,
      workspaceId: harness.workspaceId,
      intakeId: requirement.intakeSnapshot.id,
      sourceKind: "requirement",
    });

    const scheduled = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      intakeSnapshot: {
        ...requirement.intakeSnapshot,
        id: "intake-scheduled-runtime-patch" as any,
        requester: { source: "scheduled_task" } as any,
      },
    });
    assert.equal(harness.db.orchInstances.getAccessProjection(scheduled.id)?.sourceKind, "scheduled_task");
  } finally {
    harness.cleanup();
  }
});

test("orch runtime patch cache reuses the same version and reloads external updates", () => {
  const harness = createHarness();
  try {
    const workflow = buildWorkflow(harness.workspaceId);
    const instance = createRichInstance(harness.workspaceId, workflow);
    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      intakeSnapshot: instance.intakeSnapshot,
    });

    const first = harness.db.orchInstances.getRuntimePatch(created.id);
    const cached = harness.db.orchInstances.getRuntimePatch(created.id);
    assert.ok(first);
    assert.strictEqual(cached, first);

    harness.db.db
      .prepare("UPDATE orch_instances SET status = ?, updated_at = ? WHERE id = ?")
      .run("paused", first.updatedAt + 1, String(created.id));
    const refreshed = harness.db.orchInstances.getRuntimePatch(created.id);
    assert.ok(refreshed);
    assert.notStrictEqual(refreshed, first);
    assert.equal(refreshed.status, "paused");
    assert.equal(refreshed.updatedAt, first.updatedAt + 1);
  } finally {
    harness.cleanup();
  }
});

test("orch runtime patch refreshes when workflow snapshot JSON changes", () => {
  const harness = createHarness();
  try {
    const workflow = buildWorkflow(harness.workspaceId);
    const instance = createRichInstance(harness.workspaceId, workflow);
    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      intakeSnapshot: instance.intakeSnapshot,
      roleSnapshots: instance.roleSnapshots,
      toolsetSnapshots: instance.toolsetSnapshots,
      runtimeConfig: instance.runtimeConfig,
      artifactIndex: instance.artifactIndex,
    });
    harness.db.orchInstances.updateStatus(created.id, "running");
    harness.db.orchInstances.updateNodeStates(created.id, instance.nodeStates);

    const first = harness.db.orchInstances.getRuntimePatch(created.id);
    assert.ok(first);
    assert.equal(first.runSummary.progressTotal, 1);
    assert.equal(first.runSummary.activeNodeLabel, "执行");

    const updatedNodeStates: NodeExecutionState = {
      ...instance.nodeStates.role,
      nodeId: "review",
      status: "waiting-start",
      attemptId: null,
      nodeExecutionId: null,
      attemptNo: null,
      submissionId: null,
      parentExecutionId: null,
      humanActionSource: null,
      assigneeUserIds: null,
      threadId: null,
      previousThreadIds: [],
      discussionThreadId: null,
      renderedInput: null,
      output: null,
      promptSnapshotIds: null,
      knowledgeWarnings: null,
      gateResults: null,
      conclusion: null,
      retryCount: 0,
      startedAt: null,
      completedAt: null,
      error: null,
      branchTaken: null,
      inputArtifactIds: null,
      outputArtifactIds: null,
      activeFeedbackRecordIds: null,
      feedbackRecordIds: null,
      manualStartApprovedAt: null,
      manualStartApprovedBy: null,
    } satisfies NodeExecutionState;
    const updatedWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        { id: "review", type: "role", roleId: "role-review" as any, label: "复核", position: { x: 120, y: 0 } },
      ],
      version: 2,
      updatedAt: 2,
    };
    harness.db.db
      .prepare("UPDATE orch_instances SET workflow_snapshot_json = ?, node_states_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(updatedWorkflow), JSON.stringify({ ...instance.nodeStates, review: updatedNodeStates }), first.updatedAt + 1, String(created.id));

    const refreshed = harness.db.orchInstances.getRuntimePatch(created.id);
    assert.ok(refreshed);
    assert.equal(refreshed.runSummary.progressTotal, 2);
    assert.equal(refreshed.runSummary.activeNodeLabel, "复核");
    assert.equal(refreshed.runSummary.activeNodeId, "review");
  } finally {
    harness.cleanup();
  }
});

test("orch node attempt repository adopts a legacy execution id and attempt number", () => {
  const harness = createHarness();
  try {
    const workflow = buildWorkflow(harness.workspaceId);
    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      proposalId: "proposal-legacy-attempt" as any,
      intakeSnapshot: createRichInstance(harness.workspaceId, workflow).intakeSnapshot,
    });

    const attempt = harness.db.orchNodeAttempts.begin({
      instanceId: created.id,
      nodeId: "role",
      id: "legacy-execution-7",
      attemptNo: 7,
    });

    assert.equal(attempt.id, "legacy-execution-7");
    assert.equal(attempt.attemptNo, 7);
    assert.equal(harness.db.orchNodeAttempts.get("legacy-execution-7")?.status, "running");
  } finally {
    harness.cleanup();
  }
});

test("orch instance creation freezes node assignees from run plan", () => {
  const harness = createHarness();
  try {
    const workflow = buildWorkflow(harness.workspaceId);
    const assignmentSnapshot = {
      source: "run_plan" as const,
      nodeAssigneeUserIdsByNodeId: { role: ["user-b", "user-a"] },
      profilePrecheckResults: null,
      frozenAt: 123,
    };
    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      proposalId: "proposal-assignee" as any,
      intakeSnapshot: createRichInstance(harness.workspaceId, workflow).intakeSnapshot,
      runtimeConfig: { assignmentSnapshot },
      nodeAssigneeUserIdsByNodeId: { role: ["user-b", "user-a", "user-a"] },
    });

    assert.deepEqual(created.nodeStates.role.assigneeUserIds, ["user-b", "user-a"]);
    const loaded = harness.db.orchInstances.get(created.id);
    assert.deepEqual(loaded?.nodeStates.role.assigneeUserIds, ["user-b", "user-a"]);
    assert.deepEqual(loaded?.runtimeConfig?.assignmentSnapshot?.nodeAssigneeUserIdsByNodeId, { role: ["user-b", "user-a"] });
  } finally {
    harness.cleanup();
  }
});

test("orch instance creation marks skipped run plan nodes as skipped", () => {
  const harness = createHarness();
  try {
    const workflow = buildWorkflow(harness.workspaceId);
    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      proposalId: "proposal-skipped" as any,
      intakeSnapshot: createRichInstance(harness.workspaceId, workflow).intakeSnapshot,
      skippedNodeIds: ["role"],
    });

    assert.equal(created.nodeStates.role.status, "skipped");
    assert.equal(typeof created.nodeStates.role.completedAt, "number");
    const loaded = harness.db.orchInstances.get(created.id);
    assert.equal(loaded?.nodeStates.role.status, "skipped");
    assert.equal(typeof loaded?.nodeStates.role.completedAt, "number");
  } finally {
    harness.cleanup();
  }
});

test("orch instance runtime config update persists recovered execution overrides", () => {
  const harness = createHarness();
  try {
    const workflow = buildWorkflow(harness.workspaceId);
    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      proposalId: "proposal-runtime-override" as any,
      intakeSnapshot: createRichInstance(harness.workspaceId, workflow).intakeSnapshot,
      runtimeConfig: {
        initiatorUserId: "user-before",
        executionEngineStrategy: "force-codex",
        roleExecutionOverrides: {
          "role-test": { engine: "codex", model: "gpt-5.6-terra", effort: "ultra" },
        },
      },
    });
    harness.db.orchInstances.updateNodeStates(created.id, {
      ...created.nodeStates,
      role: { ...created.nodeStates.role, status: "waiting-start" },
    });
    const beforeSummary = harness.db.orchInstances.listSummariesByWorkspace({
      workspaceId: harness.workspaceId,
    }).instances[0];
    assert.deepEqual(beforeSummary?.runSummary.activeNodeAssigneeUserIds, ["user-before"]);

    harness.db.orchInstances.updateRuntimeConfig(created.id, {
      ...created.runtimeConfig,
      initiatorUserId: "user-after",
      roleExecutionOverrides: {
        "role-test": { engine: "codex", model: "gpt-5.6-terra", effort: "max" },
      },
    });

    const loaded = harness.db.orchInstances.get(created.id);
    assert.equal(loaded?.runtimeConfig?.roleExecutionOverrides?.["role-test"]?.effort, "max");
    assert.equal(loaded?.runtimeConfig?.roleExecutionOverrides?.["role-test"]?.model, "gpt-5.6-terra");
    const afterSummary = harness.db.orchInstances.listSummariesByWorkspace({
      workspaceId: harness.workspaceId,
    }).instances[0];
    assert.deepEqual(afterSummary?.runSummary.activeNodeAssigneeUserIds, ["user-after"]);
  } finally {
    harness.cleanup();
  }
});
