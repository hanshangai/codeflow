import test from "node:test";
import assert from "node:assert/strict";

import type {
  RoleDefinition,
  RoleId,
  TaskIntake,
  WorkflowDefinition,
  WorkflowProposal,
} from "../../packages/shared/src/index.ts";
import {
  buildStandaloneRoleWorkflowId,
  createDefaultRoleExecutionConfig,
  resolveRoleExecutionConfigForEngine,
} from "../../packages/shared/src/index.ts";
import {
  createProposalFromIntake,
  createProposalFromRole,
} from "../../apps/desktop/client/src/app/handlers/orchestrationHandlers.ts";

function createRole(id: string, name: string): RoleDefinition {
  return {
    id: id as any,
    workspaceId: "client-a:ws-demo" as any,
    name,
    description: `${name} 描述`,
    responsibility: `${name} 职责`,
    systemPrompt: `${name} system prompt`,
    inputDefinition: { instructions: "{{requirement}}", requiredFields: [] },
    outputDefinition: {
      instructions: "",
      deliveryMode: "direct",
      format: "markdown",
      resultKey: null,
      filePathRule: null,
      requiredFields: [],
    },
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    defaultKnowledgeBundleIds: [],
    toolRefs: [],
    kind: "custom",
    createdAt: 1,
    updatedAt: 1,
  };
}

function createWorkflow(id: string, family: WorkflowDefinition["family"], name: string, roleId: string): WorkflowDefinition {
  return {
    id: id as any,
    workspaceId: "client-a:ws-demo" as any,
    family,
    name,
    description: `${name} 描述`,
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "analysis", type: "role", roleId: roleId as any, label: "分析", position: { x: 0, y: 120 } },
      { id: "end", type: "end", label: "结束", position: { x: 0, y: 240 } },
    ],
    edges: [
      { id: "edge-start", sourceNodeId: "start", targetNodeId: "analysis", conditionBranch: null, dataMappings: [] },
      { id: "edge-end", sourceNodeId: "analysis", targetNodeId: "end", conditionBranch: null, dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createIntake(taskType: TaskIntake["taskType"]): TaskIntake {
  return {
    id: "intake-1" as any,
    workspaceId: "client-a:ws-demo" as any,
    triggerMode: "manual",
    taskType,
    title: "验证流程模板选择",
    goal: "验证自动选流",
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

function createCtx(workflows: WorkflowDefinition[], roles: RoleDefinition[]) {
  return {
    db: {
      orchWorkflows: {
        listByWorkspace() {
          return workflows;
        },
      },
      orchRoles: {
        listByWorkspace() {
          return roles;
        },
        get(roleId: string) {
          return roles.find((role) => role.id === roleId) ?? null;
        },
      },
      orchProposals: {
        create(input: Omit<WorkflowProposal, "id" | "createdAt" | "updatedAt">) {
          return {
            ...input,
            id: "proposal-1",
            createdAt: 1,
            updatedAt: 1,
          };
        },
      },
    },
  } as any;
}

/** Reads one time-free role definition for proposal construction tests. */
function createRoleReader(ctx: ReturnType<typeof createCtx>) {
  return (roleId: RoleId) => {
    const role = ctx.db.orchRoles.get(roleId);
    if (!role) return null;
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...runtimeRole } = role;
    return runtimeRole;
  };
}

test("createDefaultRoleExecutionConfig enables both engines and keeps the preferred engine", () => {
  const claudePreferred = createDefaultRoleExecutionConfig("claude");
  const codexPreferred = createDefaultRoleExecutionConfig("codex");

  assert.equal(claudePreferred.preferredEngine, "claude");
  assert.equal(codexPreferred.preferredEngine, "codex");
  assert.deepEqual(claudePreferred.engineProfiles, {
    claude: { enabled: true, mode: "auto", customConfig: null },
    codex: { enabled: true, mode: "auto", customConfig: null },
  });
  assert.deepEqual(codexPreferred.engineProfiles, {
    claude: { enabled: true, mode: "auto", customConfig: null },
    codex: { enabled: true, mode: "auto", customConfig: null },
  });
});

test("createDefaultRoleExecutionConfig keeps orchestration roles on automatic execution and sets Codex to xhigh", () => {
  const claude = resolveRoleExecutionConfigForEngine(createDefaultRoleExecutionConfig("claude"), "claude");
  const codex = resolveRoleExecutionConfigForEngine(createDefaultRoleExecutionConfig("codex"), "codex");

  assert.equal(claude.accessMode, "full-access");
  assert.equal(codex.accessMode, "full-access");
  assert.equal(claude.effort, "high");
  assert.equal(codex.effort, "xhigh");
});

test("createProposalFromIntake materializes the selected workflow template", () => {
  const role = createRole("role-analysis", "需求分析");
  const workflow = createWorkflow("wf-feature", "feature-dev", "Feature 模板", role.id);
  const ctx = createCtx([workflow], [role]);
  const proposal = createProposalFromIntake(
    ctx,
    createIntake("feature"),
    workflow,
    createRoleReader(ctx),
  );

  assert.equal(proposal.draftWorkflow.id, workflow.id);
  assert.equal(proposal.draftWorkflow.name, "Feature 模板");
  assert.match(proposal.rationale, /使用用户选定工作流 Feature 模板 固化本次执行方案/);
  assert.deepEqual(proposal.warnings, []);
  assert.equal(Object.hasOwn(proposal.draftWorkflow, "createdAt"), false);
  assert.equal(Object.hasOwn(proposal.draftWorkflow, "updatedAt"), false);
});

test("createProposalFromIntake keeps the chosen workflow even when同家族存在多个模板", () => {
  const role = createRole("role-analysis", "需求分析");
  const workflowA = createWorkflow("wf-a", "analysis", "分析模板 A", role.id);
  const workflowB = createWorkflow("wf-b", "analysis", "分析模板 B", role.id);
  const ctx = createCtx([workflowA, workflowB], [role]);
  const proposal = createProposalFromIntake(
    ctx,
    createIntake("analysis"),
    workflowB,
    createRoleReader(ctx),
  );

  assert.equal(proposal.draftWorkflow.id, workflowB.id);
  assert.equal(proposal.draftWorkflow.name, workflowB.name);
  assert.match(proposal.rationale, /使用用户选定工作流 分析模板 B 固化本次执行方案/);
  assert.deepEqual(proposal.warnings ?? [], []);
});

test("createProposalFromRole wraps the chosen role into a standalone workflow snapshot", () => {
  const role = createRole("role-ui", "原型设计师");
  const ctx = createCtx([], [role]);
  const proposal = createProposalFromRole(
    ctx,
    createIntake("feature"),
    role,
    createRoleReader(ctx),
  );

  assert.equal(proposal.draftWorkflow.id, buildStandaloneRoleWorkflowId(role.id));
  assert.equal(proposal.draftWorkflow.name, `单角色执行：${role.name}`);
  assert.deepEqual(
    proposal.draftWorkflow.nodes.map((node) => node.id),
    ["start", "role", "end"],
  );
  assert.equal(proposal.draftWorkflow.nodes[1]?.roleId, role.id);
  assert.deepEqual(proposal.draftKnowledgeBindings, []);
  assert.match(proposal.rationale, /使用用户选定角色 原型设计师 固化本次执行方案/);
  assert.deepEqual(proposal.warnings ?? [], []);
  assert.equal(Object.hasOwn(proposal.draftWorkflow, "createdAt"), false);
  assert.equal(Object.hasOwn(proposal.draftWorkflow, "updatedAt"), false);
});
