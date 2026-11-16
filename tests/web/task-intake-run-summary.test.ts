import test from "node:test";
import assert from "node:assert/strict";

import { deriveOrchestrationInstanceSummary, type OrchestrationInstance, type OrchestrationInstanceSummary, type TaskIntake, type WorkflowDefinition } from "../../packages/shared/src/index.ts";
import { deriveIntakeRunSummary, isIntakePendingForAssignee } from "../../apps/web/src/features/orchestration/task-intake-run-summary.ts";

/** 测试入口模拟列表接口返回的轻量摘要，而不是完整实例。 */
function toSummaries(instances: OrchestrationInstance[]): OrchestrationInstanceSummary[] {
  return instances.map((instance) => deriveOrchestrationInstanceSummary(instance));
}

function createIntake(): TaskIntake {
  return {
    id: "intake-progress" as any,
    workspaceId: "client-a:ws-demo" as any,
    triggerMode: "manual",
    taskType: "feature",
    title: "基线初始化",
    goal: "生成项目基线",
    background: null,
    acceptanceCriteria: null,
    workbenchItemRefs: null,
    seedArtifactRefs: null,
    constraints: null,
    requester: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createWorkflow(): WorkflowDefinition {
  return {
    id: "wf-progress" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "进度展示测试",
    description: "测试左侧需求卡片进度",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "role", type: "role", roleId: "role-init" as any, label: "基线工程师（INIT）", position: { x: 0, y: 120 } },
      { id: "end", type: "end", label: "结束", position: { x: 0, y: 240 } },
    ],
    edges: [
      { id: "start-role", sourceNodeId: "start", targetNodeId: "role", conditionBranch: null, dataMappings: [] },
      { id: "role-end", sourceNodeId: "role", targetNodeId: "end", conditionBranch: null, dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createInstance(status: OrchestrationInstance["status"]): OrchestrationInstance {
  const intake = createIntake();
  const workflow = createWorkflow();
  return {
    id: "orch-progress" as any,
    workspaceId: intake.workspaceId,
    workflowId: workflow.id,
    workflowSnapshot: workflow,
    intakeSnapshot: intake,
    roleSnapshots: {},
    runtimeConfig: null,
    status,
    nodeStates: {
      start: { nodeId: "start", status: "completed", retryCount: 0, completedAt: 10 },
      role: { nodeId: "role", status: status === "completed" ? "completed" : "running", retryCount: 0, startedAt: 11 },
      end: { nodeId: "end", status: status === "completed" ? "completed" : "pending", retryCount: 0 },
    },
    artifactIndex: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

test("deriveIntakeRunSummary excludes START/END from progress totals", () => {
  const summary = deriveIntakeRunSummary(
    "intake-progress" as any,
    toSummaries([createInstance("running")]),
  );

  assert.ok(summary);
  assert.equal(summary.progressDone, 0);
  assert.equal(summary.progressTotal, 1);
  assert.equal(summary.progressText, "已完成 0/1 节点");
  assert.equal(summary.detailText, "基线工程师（INIT） · 运行中");
});

test("isIntakePendingForAssignee matches the active assigned node even while running", () => {
  const instance = createInstance("running");
  instance.nodeStates.role = {
    ...instance.nodeStates.role,
    assigneeUserIds: ["user-pending"],
  };

  assert.equal(isIntakePendingForAssignee("intake-progress" as any, toSummaries([instance]), "user-pending"), true);
  assert.equal(isIntakePendingForAssignee("intake-progress" as any, toSummaries([instance]), "user-missing"), false);
});

test("deriveIntakeRunSummary falls back to independent run initiator as active assignee", () => {
  const instance = createInstance("running");
  instance.runtimeConfig = {
    initiatorUserId: "user-initiator",
  };

  const summary = deriveIntakeRunSummary("intake-progress" as any, toSummaries([instance]));

  assert.ok(summary);
  assert.deepEqual(summary.activeNodeAssigneeUserIds, ["user-initiator"]);
  assert.equal(isIntakePendingForAssignee("intake-progress" as any, toSummaries([instance]), "user-initiator"), true);
});

test("deriveIntakeRunSummary marks completed single-role run as 1/1 instead of 3/3", () => {
  const summary = deriveIntakeRunSummary(
    "intake-progress" as any,
    toSummaries([createInstance("completed")]),
  );

  assert.ok(summary);
  assert.equal(summary.progressDone, 1);
  assert.equal(summary.progressTotal, 1);
  assert.equal(summary.progressText, "已完成 1/1 节点");
  assert.equal(summary.statusLabel, "已完成");
});

test("deriveIntakeRunSummary marks execution-interrupted waiting feedback as exception instead of generic feedback", () => {
  const intake = createIntake();
  const workflow = createWorkflow();
  const instance: OrchestrationInstance = {
    id: "orch-progress-execution-error" as any,
    workspaceId: intake.workspaceId,
    workflowId: workflow.id,
    workflowSnapshot: workflow,
    intakeSnapshot: intake,
    roleSnapshots: {},
    runtimeConfig: null,
    status: "running",
    nodeStates: {
      start: { nodeId: "start", status: "completed", retryCount: 0, completedAt: 10 },
      role: {
        nodeId: "role",
        status: "waiting-feedback",
        humanActionSource: "execution",
        retryCount: 0,
        startedAt: 11,
        error: "stream disconnected before completion",
      },
      end: { nodeId: "end", status: "pending", retryCount: 0 },
    },
    artifactIndex: {},
    createdAt: 1,
    updatedAt: 1,
  };

  const summary = deriveIntakeRunSummary(
    "intake-progress" as any,
    toSummaries([instance]),
  );

  assert.ok(summary);
  assert.equal(summary.statusLabel, "异常中断");
  assert.equal(summary.detailText, "基线工程师（INIT） · 会话异常中断");
});

test("deriveIntakeRunSummary keeps waiting-start instances active and exposes start action", () => {
  const intake = createIntake();
  const workflow = createWorkflow();
  const instance: OrchestrationInstance = {
    id: "orch-progress-waiting-start" as any,
    workspaceId: intake.workspaceId,
    workflowId: workflow.id,
    workflowSnapshot: workflow,
    intakeSnapshot: intake,
    roleSnapshots: {},
    runtimeConfig: null,
    status: "waiting-start",
    nodeStates: {
      start: { nodeId: "start", status: "completed", retryCount: 0, completedAt: 10 },
      role: {
        nodeId: "role",
        status: "waiting-start",
        assigneeUserIds: ["user-pending"],
        retryCount: 0,
        error: "等待人工启动节点",
      },
      end: { nodeId: "end", status: "pending", retryCount: 0 },
    },
    artifactIndex: {},
    createdAt: 1,
    updatedAt: 1,
  };

  const summary = deriveIntakeRunSummary("intake-progress" as any, toSummaries([instance]));

  assert.ok(summary);
  assert.equal(summary.statusLabel, "待启动");
  assert.equal(summary.detailText, "基线工程师（INIT） · 等待人工启动节点");
  assert.equal(summary.waitingActionKind, "start");
  assert.equal(isIntakePendingForAssignee("intake-progress" as any, toSummaries([instance]), "user-pending"), true);
});

test("deriveIntakeRunSummary hides internal work-item recovery wording", () => {
  const intake = createIntake();
  const workflow = createWorkflow();
  const instance: OrchestrationInstance = {
    id: "orch-progress-work-item-error" as any,
    workspaceId: intake.workspaceId,
    workflowId: workflow.id,
    workflowSnapshot: workflow,
    intakeSnapshot: intake,
    roleSnapshots: {},
    runtimeConfig: null,
    status: "waiting-feedback",
    nodeStates: {
      start: { nodeId: "start", status: "completed", retryCount: 0, completedAt: 10 },
      role: {
        nodeId: "role",
        status: "waiting-feedback",
        humanActionSource: "human_input",
        retryCount: 0,
        conclusion: {
          nextAction: "ask_human",
          reviewVerdict: "partial",
          summary: "acceptanceCriteria 为空，Host 拒绝 runtime.workItems.complete（WORK_ITEM_TOOL_FAILED）",
          blockingIssues: null,
          acceptanceChecks: null,
          humanInput: {
            summary: "acceptanceCriteria 为空，Host 拒绝 runtime.workItems.complete（WORK_ITEM_TOOL_FAILED）",
            fields: null,
          },
          rework: null,
          decidedBy: "model",
          decidedAt: 20,
        },
      },
      end: { nodeId: "end", status: "pending", retryCount: 0 },
    },
    artifactIndex: {},
    createdAt: 1,
    updatedAt: 1,
  };

  const summary = deriveIntakeRunSummary("intake-progress" as any, toSummaries([instance]));

  assert.ok(summary);
  assert.equal(summary.detailText, "基线工程师（INIT） · 系统会先自动校对当前节点并重试。你现在不用操作，已完成内容会保留。");
  assert.doesNotMatch(summary.detailText ?? "", /acceptanceCriteria|runtime\.workItems|WORK_ITEM_TOOL_FAILED|平台补齐/u);
});

test("deriveIntakeRunSummary keeps waiting-feedback instances as active and labels human input explicitly", () => {
  const intake = createIntake();
  const workflow = createWorkflow();
  const instance: OrchestrationInstance = {
    id: "orch-progress-human-input" as any,
    workspaceId: intake.workspaceId,
    workflowId: workflow.id,
    workflowSnapshot: workflow,
    intakeSnapshot: intake,
    roleSnapshots: {},
    runtimeConfig: null,
    status: "waiting-feedback",
    nodeStates: {
      start: { nodeId: "start", status: "completed", retryCount: 0, completedAt: 10 },
      role: {
        nodeId: "role",
        status: "waiting-feedback",
        humanActionSource: "human_input",
        assigneeUserIds: ["user-pending", "user-other"],
        retryCount: 0,
        startedAt: 11,
        conclusion: {
          nextAction: "ask_human",
          reviewVerdict: "partial",
          summary: "还缺部署目录",
          blockingIssues: null,
          acceptanceChecks: null,
          humanInput: {
            summary: "请补充部署目录",
            fields: [],
          },
          rework: null,
          decidedBy: "model",
          decidedAt: 20,
        },
      },
      end: { nodeId: "end", status: "pending", retryCount: 0 },
    },
    artifactIndex: {},
    createdAt: 1,
    updatedAt: 1,
  };

  const summary = deriveIntakeRunSummary("intake-progress" as any, toSummaries([instance]));

  assert.ok(summary);
  assert.equal(summary.statusLabel, "待补充");
  assert.equal(summary.detailText, "基线工程师（INIT） · 请补充部署目录");
  assert.deepEqual(summary.activeNodeAssigneeUserIds, ["user-pending", "user-other"]);
  assert.equal(isIntakePendingForAssignee("intake-progress" as any, toSummaries([instance]), "user-pending"), true);
  assert.equal(isIntakePendingForAssignee("intake-progress" as any, toSummaries([instance]), "user-missing"), false);
});
