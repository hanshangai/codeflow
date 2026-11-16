import type {
  ExecutableToolRegistry,
  FeedbackRecordAction,
  KnowledgeCatalogSnapshot,
  NodeArtifactInput,
  NodeExecutionProfileSnapshot,
  NodePromptBillingContext,
  NodeHumanActionSource,
  NodePromptEnvelope,
  NodePromptIntent,
  NodeRuntimePolicy,
  OrchestrationId,
  RoleExecutionRevision,
  RoleDefinition,
  SkillPromptSnapshot,
  TaskAcceptanceCriterion,
  WorkflowNode,
} from "@codeflowai/shared";
import { replacePlaceholders } from "./assetBundleService.js";
import { XmlNodePromptRenderer, type NodePromptRenderer } from "./promptRenderer.js";

export type BuiltNodePrompt = {
  promptEnvelope: NodePromptEnvelope;
  systemMessage: string;
  developerMessage: string | null;
  userMessage: string;
  continuationUserMessage: string | null;
  feedbackImages: string[];
  renderedInputPreview: string;
  snapshots: {
    runtimePolicy: NodeRuntimePolicy;
    knowledgeCatalogs: KnowledgeCatalogSnapshot[];
    knowledgeWarnings: NodePromptEnvelope["knowledge"]["warnings"];
    artifactInput: NodeArtifactInput;
    toolRegistry: ExecutableToolRegistry | null;
  };
};

type NodePromptBuilderInput = {
  instanceId: OrchestrationId;
  role: RoleDefinition;
  node: WorkflowNode;
  taskTitle: string;
  taskTitlePathSegment?: string | null;
  taskGoal: string;
  taskBackground?: string | null;
  acceptanceCriteria?: TaskAcceptanceCriterion[] | null;
  renderedTaskInput: string;
  feedbackPatch: string | null;
  latestFeedbackPatch: string | null;
  latestFeedbackText?: string | null;
  latestFeedbackAction: FeedbackRecordAction | null;
  latestFeedbackSource?: NodeHumanActionSource | null;
  feedbackImages?: string[] | null;
  runtimePolicy: NodeRuntimePolicy;
  toolRegistry: ExecutableToolRegistry | null;
  roleExecutionRevision?: RoleExecutionRevision | null;
  knowledgeCatalogs: KnowledgeCatalogSnapshot[];
  projectSpecifications?: string | null;
  knowledgeWarnings: NodePromptEnvelope["knowledge"]["warnings"];
  skills?: SkillPromptSnapshot[] | null;
  artifactInput: NodeArtifactInput;
  feedbackArtifactInput?: NodeArtifactInput | null;
  executionProfiles?: NodeExecutionProfileSnapshot[] | null;
  billingContext: NodePromptBillingContext;
  /** 产物路径运行时 token；缺失时路径规则原样进入提示词（由调用方保证不缺失）。 */
  artifactPathTokens?: Record<string, string> | null;
};

/**
 * 只解析产物路径字段：路径规则必须给出平台权威目录，模型不再自行拼接。
 * outputDefinition 与 systemPrompt 里的其它 {{...}} / <...> 是给人看的说明，保持原样。
 */
function resolveOutputDefinitionPaths(
  outputDefinition: RoleDefinition["outputDefinition"],
  tokens: Record<string, string> | null | undefined,
): RoleDefinition["outputDefinition"] {
  if (!outputDefinition || !tokens) return outputDefinition;
  return {
    ...outputDefinition,
    ...(typeof outputDefinition.filePathRule === "string"
      ? { filePathRule: replacePlaceholders(outputDefinition.filePathRule, tokens) }
      : {}),
    ...(Array.isArray(outputDefinition.files)
      ? {
          files: outputDefinition.files.map((file) => ({
            ...file,
            ...(typeof file.pathRule === "string"
              ? { pathRule: replacePlaceholders(file.pathRule, tokens) }
              : {}),
          })),
        }
      : {}),
  };
}

export class NodePromptBuilder {
  constructor(private readonly renderer: NodePromptRenderer = new XmlNodePromptRenderer()) {}

  /** 构建节点 prompt，并携带仅在发送阶段使用的审核反馈图片。 */
  build(input: NodePromptBuilderInput): BuiltNodePrompt {
    const promptEnvelope = buildPromptEnvelope(input);
    const rendered = this.renderer.render(promptEnvelope);

    return {
      promptEnvelope,
      systemMessage: rendered.systemMessage,
      developerMessage: rendered.developerMessage,
      userMessage: rendered.userMessage,
      continuationUserMessage: rendered.continuationUserMessage,
      feedbackImages: normalizePromptFeedbackImages(input.feedbackImages),
      renderedInputPreview: rendered.renderedInputPreview,
      snapshots: {
        runtimePolicy: promptEnvelope.runtime.runtimePolicy,
        knowledgeCatalogs: promptEnvelope.knowledge.catalogs,
        knowledgeWarnings: promptEnvelope.knowledge.warnings,
        artifactInput: {
          artifacts: promptEnvelope.artifacts.upstreamArtifacts,
          fieldBindings: promptEnvelope.task.fieldBindings,
          inputContextId: promptEnvelope.artifacts.inputContextId ?? null,
          inputReferences: promptEnvelope.artifacts.inputReferences ?? null,
        },
        toolRegistry: promptEnvelope.runtime.toolRegistry ?? null,
      },
    };
  }
}

/** 过滤空图片 dataURL，避免把无效占位传入 provider 附件通道。 */
function normalizePromptFeedbackImages(images: string[] | null | undefined): string[] {
  return Array.from(new Set(
    (images ?? [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  ));
}

/** Builds the provider-neutral prompt envelope before renderer-specific XML formatting. */
function buildPromptEnvelope(input: NodePromptBuilderInput): NodePromptEnvelope {
  const taskTitle = String(input.taskTitle ?? "").trim() || String(input.taskGoal ?? "").trim() || "未命名需求";
  const taskTitlePathSegment = String(input.taskTitlePathSegment ?? "").trim() || taskTitle;
  return {
    schemaVersion: "node-prompt-envelope/v1",
    meta: {
      scene: "orchestration-node",
      instanceId: input.instanceId,
      workflowId: input.runtimePolicy.workflowId,
      workflowName: input.runtimePolicy.workflowName,
      nodeId: input.node.id,
      nodeLabel: input.node.label,
      intent: resolvePromptIntent(input.latestFeedbackAction, input.latestFeedbackSource ?? null),
      roleExecutionRevision: input.roleExecutionRevision ?? null,
      billingContext: input.billingContext,
    },
    role: {
      roleId: input.role.id,
      name: input.role.name,
      description: input.role.description ?? null,
      responsibility: input.role.responsibility ?? null,
      systemPrompt: input.role.systemPrompt ?? null,
      formalTemplateName: inferFormalTemplateName(input.role),
      inputDefinition: input.role.inputDefinition,
      outputDefinition: resolveOutputDefinitionPaths(input.role.outputDefinition, input.artifactPathTokens),
    },
    task: {
      title: taskTitle,
      titlePathSegment: taskTitlePathSegment,
      goal: input.taskGoal,
      background: input.taskBackground ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      renderedTaskInput: input.renderedTaskInput,
      fieldBindings: input.artifactInput.fieldBindings,
    },
    artifacts: {
      upstreamArtifacts: input.artifactInput.artifacts,
      feedbackArtifacts: input.feedbackArtifactInput?.artifacts?.length
        ? input.feedbackArtifactInput.artifacts
        : null,
      inputContextId: input.artifactInput.inputContextId ?? null,
      inputReferences: input.artifactInput.inputReferences ?? null,
    },
    knowledge: {
      catalogs: input.knowledgeCatalogs,
      projectSpecifications: input.projectSpecifications ?? null,
      warnings: input.knowledgeWarnings ?? [],
    },
    skills: {
      items: input.skills ?? [],
    },
    review: {
      feedbackPatch: input.feedbackPatch,
      latestFeedbackPatch: input.latestFeedbackPatch,
      latestFeedbackText: input.latestFeedbackText ?? null,
      latestAction: input.latestFeedbackAction,
      latestSource: input.latestFeedbackSource ?? null,
    },
    runtime: {
      runtimePolicy: input.runtimePolicy,
      toolRegistry: input.toolRegistry ?? null,
      executionProfiles: input.executionProfiles ?? null,
    },
  };
}

/** Maps the latest feedback record to the node prompt intent without losing interrupted-run semantics. */
function resolvePromptIntent(
  latestFeedbackAction: FeedbackRecordAction | null,
  latestFeedbackSource: NodeHumanActionSource | null,
): NodePromptIntent {
  if (!latestFeedbackAction) return "execute";
  if (latestFeedbackAction === "resume_with_input" && latestFeedbackSource === "execution") {
    return "resume-interrupted-node";
  }
  if (latestFeedbackAction === "resume_with_input" || latestFeedbackAction === "system_human_input") {
    return "resume-current-node";
  }
  if (latestFeedbackAction === "system_rework") {
    return "rework-upstream-node";
  }
  if (latestFeedbackAction === "system_rework_followup") {
    return "rework-current-node";
  }
  if (latestFeedbackAction === "retry" || latestFeedbackAction === "human_artifact_edit") {
    return "rework-current-node";
  }
  return "execute";
}

function inferFormalTemplateName(role: RoleDefinition): string {
  const resultKey = String(role.outputDefinition.resultKey ?? "").trim();
  const named: Record<string, string> = {
    "baseline-docs": "INIT 基线模板",
    "prd-doc": "PRD 正式模板",
    "ui-spec": "UI 说明模板",
    "arc-doc": "ARC 架构设计模板",
    "dgn-doc": "DGN 技术设计模板",
    "plan-doc": "PLAN 开发计划模板",
    "implementation-report": "DEV 实现报告模板",
    "solution-design-doc": "方案设计文档模板",
    "unit-self-test-report": "单元自测报告模板",
    "code-review-report": "代码评审报告模板",
    "integration-test-report": "集成测试报告模板",
    "code-submit-report": "代码提交报告模板",
    "e2e-report": "E2E 验证报告模板",
    "pr-text": "GIT 交付收口模板",
  };
  if (resultKey && named[resultKey]) {
    return `${named[resultKey]}（结果标识：${resultKey}）`;
  }
  if (resultKey) {
    return `${role.name} 正式模板（结果标识：${resultKey}）`;
  }
  return `${role.name} 正式模板`;
}

