import type {
  EngineType,
  KnowledgeBundleId,
  RoleDefinition,
  RoleId,
  TaskIntake,
  WorkflowFamily,
  WorkflowProposal,
  WorkflowRuntimeDefinition,
} from "@codeflowai/shared";
import { createStandaloneRoleWorkflow as buildStandaloneRoleWorkflow } from "@codeflowai/shared";

type RuntimeRoleDefinition = Omit<RoleDefinition, "createdAt" | "updatedAt">;

type ProposalBuilderContext = {
  db: {
    orchProposals: {
      create(input: Omit<WorkflowProposal, "id" | "createdAt" | "updatedAt">): WorkflowProposal;
    };
  };
  getRole(roleId: RoleId): RuntimeRoleDefinition | null;
};

/** Creates a proposal from one already-authorized workflow runtime snapshot. */
export function createProposalFromIntake(
  ctx: ProposalBuilderContext,
  intake: TaskIntake,
  selectedWorkflow: WorkflowRuntimeDefinition,
  rationaleOverride?: string | null,
): WorkflowProposal {
  const family = toWorkflowFamily(intake.taskType);
  const workflow = materializeProposalWorkflow(selectedWorkflow, family, intake.goal);
  const warnings = workflow.nodes.some((node) => node.type === "role" && node.roleId)
    ? []
    : ["当前提案没有角色节点，启动前请先补充流程模板定义"];
  const rationale = String(rationaleOverride ?? "").trim() || `使用用户选定工作流 ${selectedWorkflow.name} 固化本次执行方案`;
  return ctx.db.orchProposals.create({
    workspaceId: intake.workspaceId,
    intakeId: intake.id,
    intakeSnapshot: intake,
    status: "draft",
    recommendedFamily: workflow.family ?? family,
    rationale,
    draftWorkflow: workflow,
    draftRoleBindings: workflow.nodes
      .filter((node) => node.type === "role" && node.roleId)
      .map((node) => ({
        nodeId: node.id,
        roleId: node.roleId as RoleId,
        engine: null as EngineType | null,
      })),
    draftKnowledgeBindings: workflow.nodes
      .filter((node) => node.type === "role")
      .map((node) => {
        const role = node.roleId ? ctx.getRole(node.roleId as RoleId) : null;
        if (node.roleId && !role) throw new Error(`工作流节点引用的角色不存在：${node.roleId}`);
        return {
          nodeId: node.id,
          bundleIds: node.knowledgeOverrideBundleIds ?? role?.defaultKnowledgeBundleIds ?? [],
        };
      })
      .filter((item) => item.bundleIds.length > 0)
      .map((item) => ({
        nodeId: item.nodeId,
        bundleIds: item.bundleIds as KnowledgeBundleId[],
      })),
    warnings,
    requiresConfirmation: intake.constraints?.requireUserConfirmation !== false,
  });
}

/** Creates a standalone-workflow proposal from one already-authorized role runtime snapshot. */
export function createProposalFromRole(
  ctx: ProposalBuilderContext,
  intake: TaskIntake,
  role: RuntimeRoleDefinition,
  rationaleOverride?: string | null,
): WorkflowProposal {
  const family = toWorkflowFamily(intake.taskType);
  const workflow = stripWorkflowAssetTimes(buildStandaloneRoleWorkflow({
    workspaceId: intake.workspaceId,
    role,
    family,
    description: `按单角色方式直接运行 ${role.name}。`,
  }));
  const rationale = String(rationaleOverride ?? "").trim() || `使用用户选定角色 ${role.name} 固化本次执行方案`;
  return ctx.db.orchProposals.create({
    workspaceId: intake.workspaceId,
    intakeId: intake.id,
    intakeSnapshot: intake,
    status: "draft",
    recommendedFamily: workflow.family ?? family,
    rationale,
    draftWorkflow: workflow,
    draftRoleBindings: [
      {
        nodeId: "role",
        roleId: role.id,
        engine: null as EngineType | null,
      },
    ],
    draftKnowledgeBindings: (role.defaultKnowledgeBundleIds?.length ?? 0) > 0
      ? [{ nodeId: "role", bundleIds: role.defaultKnowledgeBundleIds as KnowledgeBundleId[] }]
      : [],
    warnings: [],
    requiresConfirmation: intake.constraints?.requireUserConfirmation !== false,
  });
}

/** Maps one intake task type to the workflow family used by generated proposals. */
export function toWorkflowFamily(taskType: TaskIntake["taskType"]): WorkflowFamily {
  if (taskType === "bugfix") return "bugfix";
  if (taskType === "analysis") return "analysis";
  return "feature-dev";
}

/** Materializes a proposal snapshot while discarding asset-only presentation timestamps. */
function materializeProposalWorkflow(
  workflow: WorkflowRuntimeDefinition,
  family: WorkflowFamily,
  goal: string | null,
): WorkflowRuntimeDefinition {
  const runtimeWorkflow = stripWorkflowAssetTimes(workflow);
  return {
    ...runtimeWorkflow,
    family: runtimeWorkflow.family ?? family,
    description: runtimeWorkflow.description || (goal ? `基于目标生成的编排草案：${goal}` : ""),
  };
}

/** Removes repository-owned asset timestamps from one generated workflow snapshot. */
function stripWorkflowAssetTimes(workflow: WorkflowWithOptionalAssetTimes): WorkflowRuntimeDefinition {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...snapshot } = workflow;
  return snapshot;
}

type WorkflowWithOptionalAssetTimes = WorkflowRuntimeDefinition & {
  createdAt?: number;
  updatedAt?: number;
};

