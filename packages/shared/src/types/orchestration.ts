import type { AccessMode, CodexServiceTier, EngineCredentialSource, EngineModelProviderId, EngineType } from "./engine.js";
import { PRODUCT_DEFAULT_AUTO_COMPACT_PCT, resolveCatalogDefaultThreadPrefs } from "../engineCatalog.js";
import type { SharedWorkspaceContextListItem } from "./sharedWorkspace";
import type { RelayInvocationPriceSnapshot } from "./relayPricing";
import type {
  AssetDraftId,
  AssetGenerationJobId,
  AssetJobEventId,
  AssetVersionId,
  ArtifactId,
  FeedbackRecordId,
  IntakeId,
  KnowledgeBundleId,
  OrchestrationEventId,
  OrchestrationId,
  ProposalId,
  RequirementAnalysisMessageId,
  RequirementAnalysisSessionId,
  RequirementCandidateId,
  RoleId,
  SkillId,
  ThreadId,
  TurnId,
  ToolId,
  ToolsetId,
  WorkflowId,
  WorkspaceId,
} from "./ids.js";

// ── Shared Enums / Tags ──────────────────────────────────────────

export const WORKFLOW_FAMILIES = ["feature-dev", "generic-kb", "bugfix", "analysis"] as const;
export type WorkflowFamily = (typeof WORKFLOW_FAMILIES)[number];

/** 流程类型缺省值：缺失时由调用方补上，避免出现"没有流程类型"的流程。 */
export const DEFAULT_WORKFLOW_FAMILY: WorkflowFamily = "feature-dev";

/**
 * 同一节点自动回退的缺省轮次上限：达到后不再自动回退，停在人工决策点。
 * 未在 reworkPolicy.maxReworkRounds 显式声明的节点使用该值。
 */
export const DEFAULT_MAX_REWORK_ROUNDS = 3;

/**
 * 归一化流程类型：历史取值 technical-dev 已并入 feature-dev；
 * 空值与未知取值返回 null，由调用方补缺省值或交给校验层显式拒绝。
 */
export function normalizeWorkflowFamily(raw: unknown): WorkflowFamily | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (value === "technical-dev") return DEFAULT_WORKFLOW_FAMILY;
  return (WORKFLOW_FAMILIES as readonly string[]).includes(value) ? (value as WorkflowFamily) : null;
}
export type TaskType = "feature" | "bugfix" | "analysis" | "unknown";
export type IntakeTriggerMode = "manual" | "dialog" | "api";
export type TaskIntakeRequesterSource = "ui" | "chat" | "api" | "scheduled_task";
export type TaskIntakeSourceKind = "requirement" | "scheduled_task";
export type ProposalStatus = "draft" | "confirmed" | "rejected" | "superseded";

export type KnowledgeSourceKind =
  | "manual-text"
  | "inline-doc"
  | "workspace-file"
  | "workspace-dir"
  | "workbench-doc"
  | "workbench-dir";

export type OrchestrationApprovalMode = "auto" | "manual";
export type NodeStartMode = "auto" | "manual";
export type ConditionDecisionMode = "auto" | "manual";
export type ArtifactOutputMode = "text" | "structured" | "file" | "file-set";
export type ArtifactPersistenceMode = "db-only" | "workspace-only" | "dual-write";
export type ArtifactWorkspaceStatus = "none" | "staging" | "published" | "discarded";

export const ORCH_ASSET_GROUP_TYPES = ["workflow", "role", "knowledge", "skill", "toolset"] as const;
export type OrchAssetGroupType = (typeof ORCH_ASSET_GROUP_TYPES)[number];
export type OrchAssetGroup = {
  id: string;
  workspaceId: WorkspaceId;
  assetType: OrchAssetGroupType;
  name: string;
  /** 系统内置分组仅用于筛选，不允许维护或手动分配。 */
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
};

// ── Prompt / Gate / Execution Settings ──────────────────────────

export type RoleFieldType = "text" | "markdown" | "json" | "file-path";
export type RoleOutputDeliveryMode = "direct" | "file" | "file-set";
export type RoleOutputFormat = "markdown" | "json" | "yaml" | "text" | "html" | "javascript" | "css" | "sql" | "image";
export type AttachmentKind = "source" | "document" | "data" | "image" | "diff" | "patch" | "log" | "archive" | "binary" | "unknown";
/** 兼容旧版附件 format 入参；新提交应优先使用 AttachmentKind。 */
export type AttachmentFormat =
  | RoleOutputFormat
  | "source"
  | "diff"
  | "patch"
  | "log"
  | "binary"
  | "archive"
  | "unknown";

export type RoleFieldDefinition = {
  key: string;
  label: string;
  valueType: RoleFieldType;
  required: boolean;
  description?: string | null;
  example?: string | null;
};

export type RoleOutputFileDefinition = {
  /** 稳定交付项标识，用于模型提交、文件索引和下游引用；旧数据缺失时由 normalizer 生成。 */
  key?: string | null;
  /** 文件或文件夹在交付清单中的名称，例如“主报告”“原型目录”“截图索引”。 */
  name: string;
  /** 单个交付项的格式；留空表示沿用 outputDefinition.format。 */
  format?: RoleOutputFormat | null;
  /** 当格式没有唯一后缀或业务允许多后缀时，声明可接受扩展名。 */
  allowedExtensions?: string[] | null;
  /** 这个交付项自己的路径规则。 */
  pathRule?: string | null;
  /** 这个交付项的用途、内容要求或补充说明。 */
  description?: string | null;
  /** 是否要求本轮必须交付该项。 */
  required: boolean;
};

export type RoleInputDefinition = {
  /** 角色如何理解当前节点输入，可使用模板变量做 prompt 工程。 */
  instructions: string;
  /** 明确声明本角色必须看到哪些输入字段/路径。 */
  requiredFields: RoleFieldDefinition[];
};

export type RoleOutputDefinition = {
  /** 角色输出说明；仅在 direct 交付时作为正文要求。 */
  instructions: string;
  /** 直接回复、单文件还是文件集合。 */
  deliveryMode: RoleOutputDeliveryMode;
  /** 输出文本/文件的格式要求。 */
  format: RoleOutputFormat;
  /** 编排内部用于标识这一类结果的键，例如 solution-plan / test-report。 */
  resultKey?: string | null;
  /** 文件输出时给角色的整体路径/落地规则说明；保留该字段以兼容旧角色。 */
  filePathRule?: string | null;
  /** 文件交付时的明细配置；单文件和多文件共用一套模型。 */
  files?: RoleOutputFileDefinition[] | null;
  /** 输出中必须覆盖的字段，例如 changedFiles / verificationSummary。 */
  requiredFields: RoleFieldDefinition[];
};

export type GateCriterion = {
  id: string;
  label: string;
  /** ai=LLM评估, regex=正则匹配, json-schema=结构校验。 */
  type: "ai" | "regex" | "json-schema";
  /** 对应 type 的配置（prompt/pattern/schema）。 */
  config: string;
  /** true=阻断工作流, false=仅警告。 */
  blocking: boolean;
};

export type TaskAcceptanceCriterion = {
  /** 需求级稳定标识，供模型在 acceptanceChecks 中回填。 */
  id: string;
  /** 人类看到的验收项原文。 */
  text: string;
  /** true=阻断继续执行；false=仅提示。 */
  blocking: boolean;
};

export type NodeReviewVerdict = "pass" | "fail" | "partial";
export type NodeNextAction = "continue" | "rework" | "ask_human" | "stop";
export type AcceptanceCheckVerdict = "pass" | "fail" | "not_evaluated";

export type NodeAcceptanceCheck = {
  criterionId?: string | null;
  label: string;
  verdict: AcceptanceCheckVerdict;
  blocking: boolean;
  evidence?: string | null;
};

export type NodeHumanInputField = {
  key: string;
  label: string;
  valueType: RoleFieldType;
  required: boolean;
  description?: string | null;
};

export type NodeHumanInputRequest = {
  summary: string;
  fields?: NodeHumanInputField[] | null;
};

export type NodeReworkDirective = {
  targetNodeId: string;
  reason: string;
  /** 精确重跑集合；可选仅用于读取历史数据，新模型提交必须显式提供。 */
  rerunNodeIds?: string[] | null;
  /** 受影响节点已有工作项看板时，显式声明需要原子重开的工作项范围。 */
  workItemScopes?: NodeWorkItemReworkScope[] | null;
};

export type NodeFinalAnswerControl = {
  nextAction: NodeNextAction;
  reason?: string | null;
};

export type NodeFinalAnswerReview = {
  verdict: NodeReviewVerdict;
  summary: string;
  blockingIssues?: string[] | null;
};

export type NodeExecutionConclusion = {
  nextAction: NodeNextAction;
  reviewVerdict: NodeReviewVerdict;
  summary?: string | null;
  blockingIssues?: string[] | null;
  acceptanceChecks?: NodeAcceptanceCheck[] | null;
  humanInput?: NodeHumanInputRequest | null;
  rework?: NodeReworkDirective | null;
  decidedBy: "model" | "human";
  decidedAt: number;
};

export type RoleExecutionProfileMode = "auto" | "custom";

export type RoleExecutionCustomConfig = {
  model: string;
  effort: string;
  /** 运行该角色时传给底层引擎的访问模式。 */
  accessMode: AccessMode;
  /** 自动压缩阈值（百分比 50-99），null 表示使用产品默认值 90%。Codex 会在运行时换算为 token 阈值。 */
  autoCompactPct?: number | null;
  /** 上下文窗口覆盖值（token 数），null 表示使用模型默认值。Claude/Codex 的实际生效方式由各自引擎适配层决定。 */
  contextWindow?: number | null;
  maxRetries?: number | null;
  /** Codex 服务档位覆盖；"fast" 表示该角色默认走 Fast 档。 */
  serviceTier?: CodexServiceTier | null;
};

export type RoleExecutionEngineProfile = {
  enabled: boolean;
  mode: RoleExecutionProfileMode;
  customConfig?: RoleExecutionCustomConfig | null;
};

export type RoleExecutionConfig = {
  preferredEngine: EngineType;
  engineProfiles: Record<EngineType, RoleExecutionEngineProfile>;
};

export type ResolvedRoleExecutionConfig = RoleExecutionCustomConfig & {
  engine: EngineType;
  sourceMode: RoleExecutionProfileMode;
  maxRetries: number;
};

// ── Knowledge / Tooling ──────────────────────────────────────────

export type ArtifactBinding = {
  sourceNodeId?: string | null;
  sourceArtifactKind?: string | null;
  targetField?: string | null;
  required?: boolean;
};

export type NodeInputReferenceSelector =
  | { type: "result-summary" }
  | { type: "field"; fieldKey: string }
  | { type: "file"; fileKey?: string | null; path?: string | null }
  | { type: "file-set"; baseDir?: string | null }
  | { type: "result-record" };

export type NodeInputReference = {
  id: string;
  targetKey: string;
  sourceNodeId: string;
  sourceResultName: string;
  sourceArtifactId?: ArtifactId | null;
  sourceSelector: NodeInputReferenceSelector;
  expectedValueType?: RoleFieldType | null;
  expectedFormat?: RoleOutputFormat | null;
  allowedExtensions?: string[] | null;
  versionPolicy?: "latest-consumable" | "specific-artifact" | "latest-from-source" | null;
  statusPolicy?: "default-consumable" | "allow-draft-for-retry" | "allow-explicit-artifact" | null;
  runtimeOverrideSource?: "feedback" | "retry" | "human_revision" | "system_rework" | null;
  autoGenerated?: boolean;
  required: boolean;
  promptMode: "reference-only" | "inline-value" | "inline-summary";
  maxInlineChars?: number | null;
  description?: string | null;
};

export type KnowledgeSourceRef = {
  id: string;
  kind: KnowledgeSourceKind;
  title: string;
  description?: string | null;
  /** 文件/目录型知识只记录引用位置；真实读取交给引擎原生能力。 */
  ref?: string | null;
  /** 正文型知识会直接内联到 prompt。 */
  inlineBody?: string | null;
  enabled: boolean;
};

export type OrchAssetDefinitionKind = "builtin" | "custom";

export function normalizeOrchAssetDefinitionKind(raw: unknown): OrchAssetDefinitionKind {
  return raw === "builtin" ? "builtin" : "custom";
}

export type KnowledgeBundleDefinition = {
  id: KnowledgeBundleId;
  workspaceId: WorkspaceId;
  name: string;
  scope: "workflow" | "role" | "shared";
  description: string;
  sourceRefs: KnowledgeSourceRef[];
  kind?: OrchAssetDefinitionKind | null;
  createdAt: number;
  updatedAt: number;
};

/** Knowledge bundle content frozen for runtime use without asset presentation timestamps. */
export type KnowledgeBundleRuntimeDefinition = Omit<KnowledgeBundleDefinition, "createdAt" | "updatedAt">;

export type KnowledgeResolverWarning = {
  bundleId: KnowledgeBundleId;
  sourceId: string;
  code: string;
  message: string;
};

export type InlineKnowledgeItem = {
  bundleId: KnowledgeBundleId;
  bundleName?: string | null;
  sourceId: string;
  sourceKey: string;
  sourceKind: Extract<KnowledgeSourceKind, "manual-text" | "inline-doc">;
  title: string;
  description?: string | null;
  bodyText: string;
  injectedAt: number;
  contentHash: string;
  truncated: boolean;
};

export type RuntimeKnowledgeSource = {
  bundleId: KnowledgeBundleId;
  bundleName?: string | null;
  sourceId: string;
  sourceKey: string;
  sourceKind: Exclude<KnowledgeSourceKind, "manual-text" | "inline-doc">;
  title: string;
  description?: string | null;
  originRef: string;
  workspaceRelPath: string;
  targetType: "file" | "directory";
};

export type KnowledgeCatalogSnapshot = {
  bundleId: KnowledgeBundleId;
  bundleName?: string | null;
  scope: KnowledgeBundleDefinition["scope"];
  createdAt: number;
  inlineItems: InlineKnowledgeItem[];
  runtimeSources: RuntimeKnowledgeSource[];
  warnings?: KnowledgeResolverWarning[] | null;
};

export type ToolRuntime = "shell" | "python" | "node" | "java" | "prompt" | "builtin";

export type ToolEnvPolicy = {
  inheritWorkspaceEnv: boolean;
  extraEnv?: Record<string, string> | null;
};

export type ToolDefinition = {
  id: ToolId;
  name: string;
  description: string;
  runtime: ToolRuntime;
  invocationHint: string;
  code: string;
  inputSchema?: string | null;
  outputSchema?: string | null;
  timeoutMs?: number | null;
  workingDirectory?: string | null;
  requiresWrite?: boolean;
  envPolicy?: ToolEnvPolicy | null;
};

export type ToolRef = {
  toolsetId: ToolsetId;
  toolId: ToolId;
  alias?: string | null;
  usageGuidance?: string | null;
  required?: boolean;
};

export type ToolsetDefinition = {
  id: ToolsetId;
  workspaceId: WorkspaceId;
  name: string;
  description: string;
  tools: ToolDefinition[];
  kind?: OrchAssetDefinitionKind | null;
  createdAt: number;
  updatedAt: number;
};

/** Toolset content frozen for runtime use without asset presentation timestamps. */
export type ToolsetRuntimeDefinition = Omit<ToolsetDefinition, "createdAt" | "updatedAt">;

export type SkillTargetEngine = Extract<EngineType, "codex" | "claude">;

export type SkillPackageFileKind = "skill-md" | "script" | "reference" | "asset" | "metadata";

export type SkillPackageFile = {
  relPath: string;
  kind: SkillPackageFileKind;
  contentText?: string | null;
  contentBase64?: string | null;
  contentType?: string | null;
  sizeBytes: number;
  sha256: string;
};

export type SkillScriptRuntime = Extract<ToolRuntime, "shell" | "python" | "node">;

export type SkillScriptEntrypoint = {
  id: string;
  name: string;
  description: string;
  scriptPath: string;
  runtime: SkillScriptRuntime;
  inputSchema?: string | null;
  outputSchema?: string | null;
  timeoutMs?: number | null;
  requiresWrite?: boolean;
  exposeAsTool?: boolean;
};

export type SkillDefinition = {
  id: SkillId;
  workspaceId: WorkspaceId;
  name: string;
  slug?: string | null;
  description: string;
  trigger: string;
  instructions: string;
  targetEngines: SkillTargetEngine[];
  tags?: string[] | null;
  kind?: OrchAssetDefinitionKind | null;
  packageVersion?: number | null;
  skillMd?: string | null;
  files?: SkillPackageFile[] | null;
  scripts?: SkillScriptEntrypoint[] | null;
  installTargets?: SkillTargetEngine[] | null;
  autoInstall?: boolean | null;
  packageHash?: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Complete Skill package frozen for runtime use without asset presentation timestamps. */
export type SkillRuntimeDefinition = Omit<SkillDefinition, "createdAt" | "updatedAt" | "skillMd" | "files" | "packageHash"> & {
  skillMd: string;
  files: SkillPackageFile[];
  packageHash: string;
};

export type SkillPromptSnapshot = Pick<
  SkillDefinition,
  | "id"
  | "name"
  | "slug"
  | "description"
  | "trigger"
  | "instructions"
  | "targetEngines"
  | "tags"
  | "packageVersion"
  | "skillMd"
  | "files"
  | "scripts"
  | "installTargets"
  | "autoInstall"
  | "packageHash"
  | "updatedAt"
>;

export type ToolUsagePolicyValidationIssue = {
  code: "EMPTY" | "TOO_SHORT" | "BARE_COMMAND" | "TOO_VAGUE";
  message: string;
};

export type RoleSystemPromptValidationIssue = {
  code: "EMPTY" | "TOO_SHORT" | "TOO_VAGUE";
  message: string;
};

export type RoleDefinitionSemanticsValidationIssue = {
  code: string;
  fieldPath: string;
  message: string;
};

export type KnowledgeBundleDescriptionValidationIssue = {
  code: "EMPTY" | "TOO_SHORT" | "TOO_VAGUE";
  message: string;
};

/** 保留工具说明校验入口，但不再用语义质量判断阻断配置保存或 AI 草案提交。 */
export function validateToolInvocationHint(raw: string | null | undefined): ToolUsagePolicyValidationIssue[] {
  void raw;
  return [];
}

/** 保留角色系统提示词校验入口，但允许用户和 AI 自由定义提示词强度。 */
export function validateRoleSystemPrompt(raw: string | null | undefined): RoleSystemPromptValidationIssue[] {
  void raw;
  return [];
}

/** 保留角色语义校验入口，但不再按角色名称关键词强制要求特定职责文本。 */
export function validateRoleDefinitionSemantics(
  raw: Pick<RoleDefinition, "name" | "description" | "responsibility" | "systemPrompt" | "inputDefinition" | "outputDefinition"> | null | undefined,
): RoleDefinitionSemanticsValidationIssue[] {
  void raw;
  return [];
}

/** 保留知识库描述校验入口，但描述质量不再阻断资产保存。 */
export function validateKnowledgeBundleDescription(raw: string | null | undefined): KnowledgeBundleDescriptionValidationIssue[] {
  void raw;
  return [];
}

// ── Role / Workflow Definitions ──────────────────────────────────

export type RoleDefinition = {
  id: RoleId;
  workspaceId: WorkspaceId;
  name: string;
  description: string;
  responsibility?: string | null;
  /** 注入 AI 的系统提示词。 */
  systemPrompt: string;
  /** 角色输入定义：统一承载输入说明与必须字段。 */
  inputDefinition: RoleInputDefinition;
  /** 角色输出定义：统一承载 direct 输出说明、文件交付规则与关键字段。 */
  outputDefinition: RoleOutputDefinition;
  /** 角色内置门禁规则。 */
  gateCriteria: GateCriterion[];
  /** 执行时引擎、模型与权限相关配置。 */
  executionConfig: RoleExecutionConfig;
  defaultKnowledgeBundleIds?: KnowledgeBundleId[];
  defaultSkillIds?: SkillId[];
  toolRefs?: ToolRef[];
  kind: OrchAssetDefinitionKind;
  /** 内置 Agent 的系统分组标识。 */
  builtinGroup?: "knowledge" | "lightweight-loop" | null;
  createdAt: number;
  updatedAt: number;
};

/** Role content frozen for runtime use without asset presentation timestamps. */
export type RoleRuntimeDefinition = Omit<RoleDefinition, "createdAt" | "updatedAt">;

export type WorkflowNodeType = "role" | "condition" | "parallel-fork" | "parallel-join" | "start" | "end";
export type OrchestrationRunMode = "independent" | "collaborative";

export type NodeWorkItemCompletionPolicy = {
  /** 完成工作项时必须提供至少一条可复核证据；验收条件为空仍保留证据要求。 */
  requireEvidence: boolean;
  /** 有验收条件时完成项须逐项提交检查记录；空条件项可省略检查记录。 */
  requireAcceptanceChecks: boolean;
  /** 工作项声明 outputPath 时，由 Host 校验文件并保存当前 SHA256。 */
  verifyOutputPath: boolean;
};

export type NodeWorkItemPolicy = {
  /** 同一节点会话内严格按工作项顺序执行。 */
  mode: "sequential";
  /** 可选严格完成合同；缺省保持旧工作流兼容行为。 */
  completion?: NodeWorkItemCompletionPolicy | null;
  /** 节点返工时无条件随范围一起重开的稳定 clientKey。 */
  reworkAlwaysClientKeys?: string[] | null;
  /** 达到该完成数后切换底层上下文；节点、看板和 Attempt 保持不变。 */
  maxItemsPerThread?: number | null;
};

/** 归一化节点工作项策略；未知模式不进入运行时。 */
export function normalizeNodeWorkItemPolicy(value: unknown): NodeWorkItemPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (String(record.mode ?? "").trim() !== "sequential") return null;
  const completionRecord = record.completion && typeof record.completion === "object" && !Array.isArray(record.completion)
    ? record.completion as Record<string, unknown>
    : null;
  const reworkAlwaysClientKeys = Array.isArray(record.reworkAlwaysClientKeys)
    ? Array.from(new Set(record.reworkAlwaysClientKeys.map((item) => String(item ?? "").trim()).filter(Boolean))).slice(0, 100)
    : [];
  const parsedMaxItemsPerThread = Number(record.maxItemsPerThread);
  const maxItemsPerThread = Number.isSafeInteger(parsedMaxItemsPerThread)
    && parsedMaxItemsPerThread >= 1
    && parsedMaxItemsPerThread <= 2_000
    ? parsedMaxItemsPerThread
    : null;
  return {
    mode: "sequential",
    ...(completionRecord
      ? {
          completion: {
            requireEvidence: completionRecord.requireEvidence === true,
            requireAcceptanceChecks: completionRecord.requireAcceptanceChecks === true,
            verifyOutputPath: completionRecord.verifyOutputPath === true,
          },
        }
      : {}),
    ...(reworkAlwaysClientKeys.length ? { reworkAlwaysClientKeys } : {}),
    ...(maxItemsPerThread != null ? { maxItemsPerThread } : {}),
  };
}

export type NodeWorkItemStatus = "pending" | "in_progress" | "completed";

export type NodeWorkItemAcceptanceCriterion = {
  id: string;
  label: string;
};

export type NodeWorkItemCompletionCheck = {
  criterionId: string;
  evidence: string;
};

export type NodeWorkItemReworkScope = {
  nodeId: string;
  mode: "all" | "selected";
  /** selected 模式使用稳定 sourceKey 定位同一业务工作项，禁止按标题或自然语言猜测。 */
  sourceKeys?: string[] | null;
};

export type NodeWorkItem = {
  id: string;
  instanceId: OrchestrationId;
  nodeId: string;
  clientKey: string;
  title: string;
  description: string | null;
  sourceKey: string | null;
  outputPath: string | null;
  sortOrder: number;
  status: NodeWorkItemStatus;
  resultSummary: string | null;
  evidence: string[];
  acceptanceCriteria: NodeWorkItemAcceptanceCriterion[];
  completionChecks: NodeWorkItemCompletionCheck[];
  outputSha256: string | null;
  version: number;
  startedAt: number | null;
  completedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type NodeWorkItemSummary = {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  deleted: number;
  progressPercent: number;
  boardVersion: number;
  updatedAt: number | null;
};

export type NodeWorkItemBoard = {
  instanceId: OrchestrationId;
  nodeId: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type NodeWorkItemEventType =
  | "board_created"
  | "item_created"
  | "item_updated"
  | "item_started"
  | "item_reopened"
  | "item_completed"
  | "item_deleted";

export type NodeWorkItemEvent = {
  id: number;
  instanceId: OrchestrationId;
  nodeId: string;
  itemId: string | null;
  type: NodeWorkItemEventType;
  itemVersion: number | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
};

/** 判断输入是否为有效运行模式。 */
export function isOrchestrationRunMode(value: unknown): value is OrchestrationRunMode {
  return value === "independent" || value === "collaborative";
}

/** 归一化本次运行模式；缺省按独立运行处理。 */
export function normalizeOrchestrationRunMode(
  value: unknown,
  fallback: OrchestrationRunMode = "independent",
): OrchestrationRunMode {
  return isOrchestrationRunMode(value) ? value : fallback;
}

export type AssigneeTemplateStatus = "draft" | "published" | "archived";

export function isAssigneeTemplateStatus(value: unknown): value is AssigneeTemplateStatus {
  return value === "draft" || value === "published" || value === "archived";
}

/** 规范化处理人模板状态；显式非法输入应由调用方先拒绝。 */
export function normalizeAssigneeTemplateStatus(value: unknown, fallback: AssigneeTemplateStatus = "draft"): AssigneeTemplateStatus {
  return isAssigneeTemplateStatus(value) ? value : fallback;
}

export type AssigneeTemplate = {
  id: string;
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  name: string;
  version: number;
  status: AssigneeTemplateStatus;
  /** 模板层节点处理人绑定；实例启动后会复制到运行计划并冻结。 */
  nodeAssigneeUserIdsByNodeId: Record<string, string[]>;
  createdAt: number;
  updatedAt: number;
};

/**
 * 工作区级的流程执行默认值：每条流程在本工作区最多一条。
 * 配置后该流程内所有角色统一按此引擎与模型执行，强制覆盖角色自身 executionConfig；
 * 它不写入流程定义本体，因此内置流程同样可配置，且内置资产重新发布不会覆盖它。
 */
export type WorkflowExecutionDefault = {
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  /** 强制使用的执行引擎。 */
  engine: EngineType;
  /** 强制使用的模型 ID；必须存在于当前工作区已应用的模型目录。 */
  model: string;
  /** 最近一次修改人；为空表示未记录来源。 */
  updatedByUserId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CredentialGrantStatus = "active" | "revoked" | "expired";

export type CredentialGrant = {
  id: string;
  userId: string;
  workspaceId?: WorkspaceId | null;
  scope: string;
  operation: string;
  status: CredentialGrantStatus;
  expiresAt?: number | null;
  updatedAt: number;
};

export type UserExecutionProfile = {
  userId: string;
  displayName?: string | null;
  /** AI 可读取的非敏感画像摘要，不能包含 token、密码、私钥等凭据明文。 */
  aiReadableSummary?: string | null;
  runtimeIdentity?: {
    gitName?: string | null;
    gitEmail?: string | null;
  } | null;
  credentialGrantRefs?: Array<Pick<CredentialGrant, "id" | "scope" | "operation" | "status" | "expiresAt">> | null;
  updatedAt: number;
};

export type UserExecutionProfilePrecheckStatus =
  | "passed"
  | "missing_profile"
  | "missing_credential_grant"
  | "not_required";

export type UserExecutionProfilePrecheckResult = {
  userId: string;
  nodeId?: string | null;
  status: UserExecutionProfilePrecheckStatus;
  missingItems?: string[] | null;
  profileSnapshotRef?: string | null;
  credentialGrantRefs?: string[] | null;
  checkedAt?: number | null;
};

export type NodeExecutionProfileScope = {
  scopeType: "local_workspace" | "shared_workspace";
  scopeId: string;
};

export type NodeExecutionProfileSnapshot = {
  userId: string;
  scope: NodeExecutionProfileScope;
  profileText: string;
  profileHash?: string | null;
  updatedAt?: number | null;
};

export type OrchestrationRunPlan = {
  runMode?: OrchestrationRunMode | null;
  assigneeTemplateId?: string | null;
  /** 本次启动前人工选择跳过的流程节点；start/end 不允许跳过。 */
  skippedNodeIds?: string[] | null;
  /** 本次启动最终采用的节点处理人覆盖；只接受 workflow 中可执行节点。 */
  nodeAssigneeUserIdsByNodeId?: Record<string, string[] | null | undefined> | null;
  /** Profile 预检结果只保存状态和引用，不保存敏感凭据。 */
  profilePrecheckResults?: UserExecutionProfilePrecheckResult[] | null;
};

export type InstanceAssignmentSnapshot = {
  source: "run_plan";
  assigneeTemplateId?: string | null;
  nodeAssigneeUserIdsByNodeId: Record<string, string[]>;
  profilePrecheckResults?: UserExecutionProfilePrecheckResult[] | null;
  frozenAt: number;
};

/** 规范化运行计划里的单节点处理人列表。 */
export function normalizeOrchestrationRunPlanAssigneeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

/** 规范化运行计划里的节点处理人映射，过滤空节点和空处理人。 */
export function normalizeOrchestrationRunPlanAssignees(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [rawNodeId, rawAssignees] of Object.entries(value as Record<string, unknown>)) {
    const nodeId = String(rawNodeId ?? "").trim();
    const assignees = normalizeOrchestrationRunPlanAssigneeList(rawAssignees);
    if (nodeId && assignees.length > 0) out[nodeId] = assignees;
  }
  return out;
}

/** 规范化运行计划里的启动跳过节点列表，过滤空值并去重。 */
export function normalizeOrchestrationRunPlanSkippedNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  /** role 节点关联的角色。 */
  roleId?: RoleId | null;
  /** condition 节点的判断表达式/prompt。 */
  conditionExpr?: string | null;
  /** condition 节点分支决策方式；manual 表示运行到此处等待人工选择出边。 */
  conditionDecisionMode?: ConditionDecisionMode | null;
  label: string;
  /** 画布坐标。 */
  position: { x: number; y: number };
  /** 节点级输入引用；新流程唯一数据流配置入口。 */
  inputReferences?: NodeInputReference[] | null;
  /** @deprecated 旧节点输入绑定，只能作为迁移来源。 */
  inputBindings?: ArtifactBinding[] | null;
  outputWritePolicy?: OutputWritePolicy | null;
  outputArtifactMode?: ArtifactOutputMode | null;
  outputResultKey?: string | null;
  knowledgeOverrideBundleIds?: KnowledgeBundleId[] | null;
  /** 节点满足前置条件后的启动方式；manual 表示需要人工点击后才进入执行。 */
  startMode?: NodeStartMode | null;
  /** 人工启动节点在运行态展示的启动前置提示说明；仅 startMode=manual 时生效。 */
  manualStartPrompt?: string | null;
  approvalMode?: OrchestrationApprovalMode | null;
  failPolicy?: "stop" | "wait-feedback" | "skip" | null;
  /** 大批量任务启用后，由同一节点 Agent 在同一会话内按顺序维护和完成工作项。 */
  workItemPolicy?: NodeWorkItemPolicy | null;
  reworkPolicy?: {
    /**
     * 允许当前节点把问题定向退回到哪些上游节点。
     * 为空时，引擎会退化为“当前节点所有上游 role 节点”。
     */
    allowedTargetNodeIds?: string[] | null;
    /**
     * 当前节点退回指定目标时要精确失效的节点集合。
     * 每个集合必须包含目标节点；未声明的目标仍按目标及全部下游处理。
     */
    affectedNodeIdsByTargetNodeId?: Record<string, string[] | null> | null;
    /**
     * 当前节点允许发起的自动回退轮次上限（按该节点已发起的回退次数计）。
     * 达到上限后引擎不再自动回退，停在人工决策点；人工确认的回退不受此限制。
     * 缺省为 DEFAULT_MAX_REWORK_ROUNDS。
     */
    maxReworkRounds?: number | null;
  } | null;
};

export type WorkflowNodeSpec = WorkflowNode;

export type DataMapping = {
  sourceField: string;
  targetField: string;
};

export type WorkflowEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  /** condition 节点出边的分支标签。 */
  conditionBranch?: string | null;
  /** @deprecated 上游输出→下游输入的旧字段映射，只能作为迁移来源。 */
  dataMappings: DataMapping[];
  /**
   * 编辑器自动布局生成的持久化折线路径；只用于画布展示，不参与流程执行。
   * 节点位置或连线结构变化后由编辑器清除并重新计算。
   */
  routePoints?: Array<{ x: number; y: number }> | null;
};

/** Workflow content frozen for proposal or execution without asset presentation timestamps. */
export type WorkflowRuntimeDefinition = {
  id: WorkflowId;
  workspaceId: WorkspaceId;
  family?: WorkflowFamily | null;
  name: string;
  description: string;
  workflowKnowledgeBundleIds?: KnowledgeBundleId[] | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  kind?: OrchAssetDefinitionKind | null;
  version: number;
};

/** Persisted workflow asset definition with its repository-owned presentation timestamps. */
export type WorkflowDefinition = WorkflowRuntimeDefinition & {
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationRuntimeAssetType = "role" | "workflow" | "knowledge_bundle" | "toolset" | "skill";

export type OrchestrationRuntimeAssetDefinitionByType = {
  role: RoleRuntimeDefinition;
  workflow: WorkflowRuntimeDefinition;
  knowledge_bundle: KnowledgeBundleRuntimeDefinition;
  toolset: ToolsetRuntimeDefinition;
  skill: SkillRuntimeDefinition;
};

export type OrchestrationRuntimeAssetSource =
  | { authorityMode: "legacy"; createdAt: number; updatedAt: number }
  | {
    authorityMode: "server";
    metadata: {
      revision: number;
      scopeType: "builtin" | "user" | "shared_workspace";
      syncChangeSeq: number;
      contentHash: string;
      cacheStatus: "ready";
    };
  };

export type OrchestrationRuntimeAssetSnapshotEntry<T extends OrchestrationRuntimeAssetType> = {
  assetType: T;
  assetId: string;
  definition: OrchestrationRuntimeAssetDefinitionByType[T];
  source: OrchestrationRuntimeAssetSource | null;
};

/** 仅解析历史缓存来源以保留记录；该结构不再授予执行资格。 */
export type OrchAssetExecutionAuthorization = {
  serverOrigin: string;
  userId: string;
  deviceId: string;
  clientId: string;
  hostBindingId: string;
  hostScopeEpoch: number;
  sharedWorkspaceId: string;
  runtimeWorkspaceId: string;
  contextKey: string;
  authorityEpoch: number;
  appliedChangeSeq: number;
  revisionSetHash: string;
  snapshotHash: string;
};

/** 历史来源必须是精确数据字段；拒绝访问器、附加字段和非规范标识。 */
export function readOrchAssetExecutionAuthorization(input: unknown): OrchAssetExecutionAuthorization {
  const fields = ["serverOrigin", "userId", "deviceId", "clientId", "hostBindingId", "hostScopeEpoch",
    "sharedWorkspaceId", "runtimeWorkspaceId", "contextKey", "authorityEpoch", "appliedChangeSeq", "revisionSetHash", "snapshotHash"] as const;
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error("ASSET_EXECUTION_HISTORY_INVALID:record");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !(fields as readonly string[]).includes(key))) {
    throw new Error("ASSET_EXECUTION_HISTORY_INVALID:fields");
  }
  const result: Record<string, string | number> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error(`ASSET_EXECUTION_HISTORY_INVALID:${field}`);
    const value: unknown = descriptor.value;
    if (["hostScopeEpoch", "authorityEpoch", "appliedChangeSeq"].includes(field)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`ASSET_EXECUTION_HISTORY_INVALID:${field}`);
    } else if (typeof value !== "string" || !value || value !== value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)
      || (["revisionSetHash", "snapshotHash"].includes(field) && !/^[a-f0-9]{64}$/.test(value))) {
      throw new Error(`ASSET_EXECUTION_HISTORY_INVALID:${field}`);
    }
    result[field] = value as string | number;
  }
  const origin = result.serverOrigin as string;
  if (!URL.canParse(origin)) throw new Error("ASSET_EXECUTION_HISTORY_INVALID:serverOrigin");
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
    throw new Error("ASSET_EXECUTION_HISTORY_INVALID:serverOrigin");
  }
  return result as OrchAssetExecutionAuthorization;
}

/** 启动时冻结完整本地资产图，历史记录仍保留原来源。 */
export type OrchestrationAssetRuntimeSnapshot = {
  authorityMode: "legacy" | "server";
  /** 固定本次缓存来源，恢复或后续派发不能借用另一账号的相同资产。 */
  executionAuthorization?: OrchAssetExecutionAuthorization;
  workflow: OrchestrationRuntimeAssetSnapshotEntry<"workflow">;
  roles: Record<string, OrchestrationRuntimeAssetSnapshotEntry<"role">>;
  knowledgeBundles: Record<string, OrchestrationRuntimeAssetSnapshotEntry<"knowledge_bundle">>;
  toolsets: Record<string, OrchestrationRuntimeAssetSnapshotEntry<"toolset">>;
  skills: Record<string, OrchestrationRuntimeAssetSnapshotEntry<"skill">>;
};

export const STANDALONE_ROLE_WORKFLOW_PREFIX = "standalone-role:";

export function buildStandaloneRoleWorkflowId(roleId: RoleId | string): WorkflowId {
  const normalizedRoleId = String(roleId ?? "").trim();
  return `${STANDALONE_ROLE_WORKFLOW_PREFIX}${normalizedRoleId}` as WorkflowId;
}

export function parseStandaloneRoleWorkflowId(workflowId: WorkflowId | string | null | undefined): RoleId | null {
  const normalizedWorkflowId = String(workflowId ?? "").trim();
  if (!normalizedWorkflowId.startsWith(STANDALONE_ROLE_WORKFLOW_PREFIX)) return null;
  const roleId = normalizedWorkflowId.slice(STANDALONE_ROLE_WORKFLOW_PREFIX.length).trim();
  return roleId ? (roleId as RoleId) : null;
}

export function createStandaloneRoleWorkflow(args: {
  workspaceId: WorkspaceId;
  role: Pick<RoleDefinition, "id" | "name" | "defaultKnowledgeBundleIds" | "kind">;
  family?: WorkflowFamily | null;
  name?: string | null;
  description?: string | null;
}): WorkflowDefinition {
  const roleName = String(args.role?.name ?? "").trim() || "未命名角色";
  return {
    id: buildStandaloneRoleWorkflowId(args.role.id),
    workspaceId: args.workspaceId,
    family: args.family ?? "feature-dev",
    name: String(args.name ?? "").trim() || `单角色执行：${roleName}`,
    description: String(args.description ?? "").trim() || `直接运行角色 ${roleName}，不经过多节点流程编排。`,
    workflowKnowledgeBundleIds: [...(args.role.defaultKnowledgeBundleIds ?? [])],
    // 单角色流程继承角色类型，Server 才能在不持有内置资产包时识别内置角色。
    kind: args.role.kind === "builtin" ? "builtin" : "custom",
    nodes: [
      { id: "start", type: "start", label: "START", position: { x: 96, y: 88 } },
      { id: "role", type: "role", roleId: args.role.id, label: roleName, position: { x: 400, y: 88 }, inputBindings: [] },
      { id: "end", type: "end", label: "END", position: { x: 704, y: 88 } },
    ],
    edges: [
      { id: "start-role", sourceNodeId: "start", targetNodeId: "role", dataMappings: [] },
      { id: "role-end", sourceNodeId: "role", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

// ── Intake / Proposal ────────────────────────────────────────────

export type TaskIntakeExecutionPlan = {
  /** 需求侧默认执行入口；这里只保存草稿偏好，不代表已启动的运行实例。 */
  targetType: "workflow" | "role";
  workflowId?: WorkflowId | null;
  roleId?: RoleId | null;
  executionEngineStrategy?: OrchestrationExecutionEngineStrategy | null;
  roleExecutionOverrides?: Record<string, OrchestrationRoleExecutionOverride> | null;
  /** 协作处理人等运行计划草稿；启动实例时会重新校验并冻结。 */
  runPlan?: OrchestrationRunPlan | null;
  updatedAt?: number | null;
};

export type TaskIntakeMetricEvidenceSummary = {
  evaluatedCount: number;
  coverageRate: number | null;
  passRate: number | null;
};

export type TaskIntakeMetricEvidenceConclusion = "improved" | "regressed" | "no_detectable_change" | null;

export type TaskIntakeMetricCohortSnapshot = {
  cohortKey: string;
  criterion: string;
  evaluatorId: string;
  evaluatorVersion: string;
  workflowSnapshotHash: string;
  roleSnapshotHash: string;
  nodeId: string;
  promptDefinitionHash: string;
  engine: string;
  model?: string | null;
  effort?: string | null;
  current: TaskIntakeMetricEvidenceSummary | null;
  comparison: TaskIntakeMetricEvidenceSummary | null;
  /** 该精确配置在创建时的双周期结论，不代表基线与候选之间的因果差异。 */
  conclusion: TaskIntakeMetricEvidenceConclusion;
};

export const TASK_INTAKE_METRIC_REVIEW_STATUSES = [
  "candidate_unbound", "waiting_observation", "ready_to_evaluate", "insufficient_evidence", "verified_improved", "not_improved",
] as const;
export type TaskIntakeMetricReviewStatus = (typeof TASK_INTAKE_METRIC_REVIEW_STATUSES)[number];
export type TaskIntakeMetricReviewTerminalStatus = Extract<TaskIntakeMetricReviewStatus, "insufficient_evidence" | "verified_improved" | "not_improved">;

export const TASK_INTAKE_METRIC_REVIEW_REASONS = [
  "metric_version_unavailable", "metric_version_mismatch", "comparability_policy_mismatch", "baseline_cohort_missing",
  "candidate_cohort_missing", "cohort_identity_mismatch", "baseline_sample_below_minimum", "candidate_sample_below_minimum",
  "baseline_evidence_incomplete", "candidate_evidence_incomplete", "baseline_interval_unavailable", "candidate_interval_unavailable",
] as const;
export type TaskIntakeMetricReviewReason = (typeof TASK_INTAKE_METRIC_REVIEW_REASONS)[number];

export type TaskIntakeMetricComparabilityPolicy = {
  minEvaluatedSamples: number;
  requiredCoverageRate: number;
  confidenceLevel: number;
};

export type TaskIntakeMetricReviewSummary = {
  factCount: number;
  eligibleCount: number;
  evaluatedCount: number;
  passedCount: number;
  failedCount: number;
  missingEvidenceCount: number;
  notEvaluatedCount: number;
  coverageRate: number | null;
  passRate: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
};

export type TaskIntakeMetricReviewCohortEvidence = {
  cohortKey: string;
  summary: TaskIntakeMetricReviewSummary;
};

export type TaskIntakeMetricReviewSnapshot = {
  reviewId: string;
  evidenceFingerprint: string;
  status: TaskIntakeMetricReviewTerminalStatus;
  reasonCodes: TaskIntakeMetricReviewReason[];
  baselinePeriod: { from: number; to: number };
  candidatePeriod: { from: number; to: number };
  baseline: TaskIntakeMetricReviewCohortEvidence | null;
  candidate: TaskIntakeMetricReviewCohortEvidence | null;
  metricSchemaVersion: number;
  metricDefinitionVersion: string;
  comparabilityPolicy: TaskIntakeMetricComparabilityPolicy;
  evaluatedAt: number;
};

export type TaskIntakeLegacyMetricEvidenceRef = {
  kind: "orchestration_evaluation_cohort";
  scopeKind: "mine" | "enterprise" | "super_admin_user" | "super_admin_enterprise" | "shared_workspace";
  scopeId?: string | null;
  cohortKey: string;
  criterion: string;
  evaluatorId: string;
  evaluatorVersion: string;
  workflowSnapshotHash: string;
  roleSnapshotHash: string;
  /** 新版稳定实验身份；旧证据引用允许缺失。 */
  nodeId?: string | null;
  promptDefinitionHash?: string | null;
  /** 单次 Prompt 审计身份；新版聚合引用允许缺失。 */
  promptHash?: string | null;
  engine: string;
  model?: string | null;
  /** 实际模型推理强度；旧证据引用允许缺失。 */
  effort?: string | null;
  currentPeriod: { from: number; to: number };
  comparisonPeriod: { from: number; to: number };
  current: TaskIntakeMetricEvidenceSummary | null;
  comparison: TaskIntakeMetricEvidenceSummary | null;
  conclusion: TaskIntakeMetricEvidenceConclusion;
  /** 本轮改进希望验证的业务假设；旧需求允许缺失。 */
  hypothesis?: string | null;
  /** 候选 Workflow、Role、Prompt 或工具版本说明；旧需求允许缺失。 */
  targetVersion?: string | null;
  /** 创建改进需求时冻结的未来观察窗口；旧需求允许缺失。 */
  observationWindow?: { from: number; to: number } | null;
  createdAt: number;
};

export type TaskIntakeMetricCohortPairEvidenceRef = {
  kind: "orchestration_evaluation_cohort_pair";
  scopeKind: "mine" | "enterprise" | "super_admin_user" | "super_admin_enterprise" | "shared_workspace";
  scopeId?: string | null;
  currentPeriod: { from: number; to: number };
  comparisonPeriod: { from: number; to: number };
  baseline: TaskIntakeMetricCohortSnapshot;
  candidate: TaskIntakeMetricCohortSnapshot;
  /** 创建候选对时的指标版本；旧候选对允许缺失，但不得跨版本输出复评结论。 */
  metricSchemaVersion?: number | null;
  metricDefinitionVersion?: string | null;
  comparabilityPolicy?: TaskIntakeMetricComparabilityPolicy | null;
  hypothesis?: string | null;
  /** 候选配置的业务说明，不参与结构化 cohort 身份。 */
  targetVersion?: string | null;
  observationWindow?: { from: number; to: number } | null;
  /** 按时间追加的复评证据；相同指纹不重复保存。 */
  reviews?: TaskIntakeMetricReviewSnapshot[] | null;
  createdAt: number;
};

export type TaskIntakeMetricEvidenceRef = TaskIntakeLegacyMetricEvidenceRef | TaskIntakeMetricCohortPairEvidenceRef;

export type TaskIntake = {
  id: IntakeId;
  workspaceId: WorkspaceId;
  /** 可信入口保存的工作区归属；缺失或 null 表示历史归属未知。 */
  workspaceScope?: NodeExecutionProfileScope | null;
  triggerMode: IntakeTriggerMode;
  taskType: TaskType;
  title: string;
  goal: string;
  background?: string | null;
  acceptanceCriteria?: TaskAcceptanceCriterion[] | null;
  workbenchItemRefs?: string[] | null;
  seedArtifactRefs?: ArtifactId[] | null;
  metricEvidenceRefs?: TaskIntakeMetricEvidenceRef[] | null;
  constraints?: {
    requireUserConfirmation?: boolean;
    nodeApprovalMode?: OrchestrationApprovalMode;
  } | null;
  /** 用户为这条需求保存的默认执行配置，可稍后再启动。 */
  executionPlan?: TaskIntakeExecutionPlan | null;
  requester?: {
    userId?: string | null;
    source?: TaskIntakeRequesterSource | null;
  } | null;
  /** 共享工作区上下文；存在时用于区分本人相关需求和只读团队需求。 */
  sharedContext?: SharedWorkspaceContextListItem | null;
  /** 共享工作区只读标记；true 表示当前账号只能查看，不能编辑、删除或执行该需求。 */
  readOnly?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type NodeThreadReusePolicy = "reuse-existing" | "new-thread";

/** Provider 原线程恢复失败后允许展示给用户的显式策略。 */
export type NodeThreadRecoveryStrategy = "retry-existing" | "new-thread";

export type DownstreamThreadReusePolicy = "preserve-existing" | "cascade-new-thread";

export type RoleExecutionRevision = {
  roleId: RoleId;
  roleUpdatedAt: number;
  rolePromptHash: string;
  roleKnowledgeHash: string;
  skillBindingHash: string;
  roleRuntimeHash: string;
  roleValidationHash: string;
  toolBindingHash: string;
};

export type OrchestrationRuntimeConflictCode =
  | "ROLE_PROMPT_REVISION_CONFLICT"
  | "THREAD_REUSE_CONFLICT";

export type OrchestrationRuntimeConflictBody = {
  ok: false;
  code: OrchestrationRuntimeConflictCode;
  message: string;
  nodeId?: string | null;
  threadId?: ThreadId | null;
  currentRevision?: RoleExecutionRevision | null;
  lastAttemptRevision?: RoleExecutionRevision | null;
  availablePolicies?: NodeThreadReusePolicy[] | null;
};

/** Carries orchestration conflicts that require an explicit human policy choice. */
export class OrchestrationRuntimeConflictError extends Error {
  readonly code: OrchestrationRuntimeConflictCode;
  readonly nodeId: string | null;
  readonly threadId: ThreadId | null;
  readonly currentRevision: RoleExecutionRevision | null;
  readonly lastAttemptRevision: RoleExecutionRevision | null;
  readonly availablePolicies: NodeThreadReusePolicy[] | null;

  constructor(input: Omit<OrchestrationRuntimeConflictBody, "ok">) {
    super(input.message);
    this.name = "OrchestrationRuntimeConflictError";
    this.code = input.code;
    this.nodeId = input.nodeId ?? null;
    this.threadId = input.threadId ?? null;
    this.currentRevision = input.currentRevision ?? null;
    this.lastAttemptRevision = input.lastAttemptRevision ?? null;
    this.availablePolicies = input.availablePolicies ?? null;
  }
}

/** Narrows thrown values to orchestration runtime conflicts without relying on realms. */
export function isOrchestrationRuntimeConflictError(error: unknown): error is OrchestrationRuntimeConflictError {
  return Boolean(
    error
    && typeof error === "object"
    && ((error as any).code === "ROLE_PROMPT_REVISION_CONFLICT" || (error as any).code === "THREAD_REUSE_CONFLICT")
    && typeof (error as any).message === "string",
  );
}

/** Converts a conflict error into the stable HTTP response body shape. */
export function toOrchestrationRuntimeConflictBody(error: OrchestrationRuntimeConflictError): OrchestrationRuntimeConflictBody {
  return {
    ok: false,
    code: error.code,
    message: error.message,
    nodeId: error.nodeId,
    threadId: error.threadId,
    currentRevision: error.currentRevision,
    lastAttemptRevision: error.lastAttemptRevision,
    availablePolicies: error.availablePolicies,
  };
}

/** Builds the execution-affecting role revision stored with every node prompt snapshot. */
export function buildRoleExecutionRevision(
  role: RoleDefinition,
  toolsets: ToolsetDefinition[] = [],
  skills: SkillDefinition[] = [],
): RoleExecutionRevision {
  return {
    roleId: role.id,
    roleUpdatedAt: Number(role.updatedAt ?? 0),
    rolePromptHash: hashStableValue({
      name: role.name,
      description: role.description,
      responsibility: role.responsibility ?? null,
      systemPrompt: role.systemPrompt,
      inputDefinition: role.inputDefinition,
      outputDefinition: role.outputDefinition,
    }),
    roleKnowledgeHash: hashStableValue({
      defaultKnowledgeBundleIds: role.defaultKnowledgeBundleIds ?? [],
    }),
    skillBindingHash: hashStableValue({
      defaultSkillIds: role.defaultSkillIds ?? [],
      skills: normalizeRevisionSkills(role, skills),
    }),
    roleRuntimeHash: hashStableValue(role.executionConfig),
    roleValidationHash: hashStableValue(role.gateCriteria ?? []),
    toolBindingHash: hashStableValue({
      toolRefs: role.toolRefs ?? [],
      toolsets: normalizeRevisionToolsets(role, toolsets),
    }),
  };
}

/** Keeps skill revision input limited to fields that affect model behavior. */
function normalizeRevisionSkills(role: RoleDefinition, skills: SkillDefinition[]): unknown[] {
  const referencedIds = new Set((role.defaultSkillIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean));
  return [...skills]
    .filter((skill) => referencedIds.has(String(skill.id)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      instructions: skill.instructions,
      targetEngines: skill.targetEngines,
      tags: skill.tags ?? [],
      packageHash: skill.packageHash ?? null,
      scripts: (skill.scripts ?? []).map((script) => ({
        id: script.id,
        scriptPath: script.scriptPath,
        runtime: script.runtime,
        exposeAsTool: Boolean(script.exposeAsTool),
        requiresWrite: Boolean(script.requiresWrite),
        timeoutMs: script.timeoutMs ?? null,
        inputSchema: script.inputSchema ?? null,
        outputSchema: script.outputSchema ?? null,
      })),
      files: (skill.files ?? []).map((file) => ({
        relPath: file.relPath,
        kind: file.kind,
        sha256: file.sha256,
      })),
      updatedAt: skill.updatedAt,
    }));
}

/** Keeps tool revision input limited to fields that affect exposed tool capability. */
function normalizeRevisionToolsets(role: RoleDefinition, toolsets: ToolsetDefinition[]): unknown[] {
  const referencedToolIdsByToolsetId = new Map<string, Set<string>>();
  for (const ref of role.toolRefs ?? []) {
    const toolsetId = String(ref.toolsetId ?? "").trim();
    const toolId = String(ref.toolId ?? "").trim();
    if (!toolsetId || !toolId) continue;
    const toolIds = referencedToolIdsByToolsetId.get(toolsetId) ?? new Set<string>();
    toolIds.add(toolId);
    referencedToolIdsByToolsetId.set(toolsetId, toolIds);
  }

  return [...toolsets]
    .filter((toolset) => referencedToolIdsByToolsetId.has(String(toolset.id)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((toolset) => ({
      id: toolset.id,
      workspaceId: toolset.workspaceId,
      name: toolset.name,
      description: toolset.description,
      kind: toolset.kind ?? null,
      tools: [...(toolset.tools ?? [])]
        .filter((tool) => referencedToolIdsByToolsetId.get(String(toolset.id))?.has(String(tool.id)))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          runtime: tool.runtime,
          invocationHint: tool.invocationHint,
          code: tool.code,
          inputSchema: tool.inputSchema ?? null,
          outputSchema: tool.outputSchema ?? null,
          timeoutMs: tool.timeoutMs ?? null,
          workingDirectory: tool.workingDirectory ?? null,
          requiresWrite: Boolean(tool.requiresWrite),
          envPolicy: tool.envPolicy ?? null,
        })),
    }));
}

/** Hashes deterministic JSON with a browser-safe FNV-1a variant. */
function hashStableValue(value: unknown): string {
  const raw = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Serializes JSON-like values with sorted object keys for repeatable hashes. */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export const TASK_INTAKE_TITLE_MAX_LENGTH = 60;

export function normalizeTaskIntakeTitle(raw: unknown, fallbackGoal?: unknown): string {
  const explicit = normalizeSingleLineText(raw);
  const fallback = normalizeSingleLineText(fallbackGoal);
  const candidate = explicit || fallback || "未命名需求";
  const sliced = Array.from(candidate).slice(0, TASK_INTAKE_TITLE_MAX_LENGTH).join("").trim();
  return sliced || "未命名需求";
}

export function getTaskIntakeTitle(input: Pick<TaskIntake, "title" | "goal"> | null | undefined): string {
  return normalizeTaskIntakeTitle(input?.title, input?.goal);
}

// ── Requirement Analysis Assistant ───────────────────────────────

export type RequirementAnalysisSessionStatus = "active" | "completed" | "archived";
export type RequirementAnalysisMessageRole = "user" | "assistant" | "system";
export type RequirementAnalysisPhase = "discover" | "clarify" | "split" | "recommend" | "confirm" | "done";
export type RequirementAnalysisComplexity = "small" | "standard" | "large" | "unknown";
export type RequirementAnalysisUiScope = "none" | "light" | "heavy" | "unknown";
export type RequirementAnalysisArchitectureRisk = "low" | "medium" | "high" | "unknown";
export type RequirementAnalysisAssetGapKind = "workflow" | "role" | "knowledge-bundle" | "toolset";
export type RequirementCandidateCreationState = "draft" | "created";
export type RequirementAnalysisQuestionImpact =
  | "scope"
  | "acceptance"
  | "workflow"
  | "ui-scope"
  | "architecture"
  | "assets"
  | "delivery";

export type RequirementAnalysisAssetGap = {
  kind: RequirementAnalysisAssetGapKind;
  severity: "blocking" | "warning";
  code: string;
  message: string;
  suggestion?: string | null;
};

export type RequirementAnalysisQuestion = {
  id: string;
  question: string;
  reason: string;
  impact: RequirementAnalysisQuestionImpact;
};

export type RequirementCandidateClarificationOption = {
  id: string;
  label: string;
  value: string;
  recommended?: boolean;
};

export type RequirementCandidateClarificationItem = {
  question: string;
  reason: string;
  suggestion: string;
  impact: RequirementAnalysisQuestionImpact;
  options: RequirementCandidateClarificationOption[];
  allowCustom?: boolean;
  answerPlaceholder?: string | null;
};

export type RequirementCandidateSizeAssessment = {
  model?: "legacy-matrix-v1" | "functional-size-v2";
  size: RequirementAnalysisComplexity;
  score: number;
  summary: string;
  reasoning: string;
  signals: {
    functionalProcessCount: number;
    domainEntityCount: number;
    stateTransitionCount: number;
    interactionSurfaceCount: number;
    externalIntegrationCount: number;
    asyncConsistencyRiskCount: number;
    clientSurfaceCount: number;
  };
  legacySignals?: {
    menuCount: number;
    featurePointCount: number;
    businessFlowCount: number;
    interactionPointCount: number;
    integrationCount: number;
    platformCount: number;
  } | null;
};

export type RequirementCandidatePhasingAssessment = {
  model?: "legacy-mmf-fallback-v1" | "mmf-phase-gate-v2";
  scopeDecision: "fit" | "needs-split";
  deliverySlice: "single-phase" | "phase-1" | "follow-up";
  summary: string;
  reasoning: string;
  signals: {
    benefitHypothesisCount: number;
    acceptanceLoopCount: number;
    actorSurfaceCount: number;
    externalSystemCount: number;
    newCoreModelCount: number;
  };
  outOfScope: string[];
};

export type RequirementAnalysisSuggestedAction = {
  type: "wait-user-reply" | "ready-to-create" | "needs-assets" | "review-candidates";
  targetCandidateIds?: RequirementCandidateId[] | null;
  note?: string | null;
};

export type RequirementAnalysisSession = {
  id: RequirementAnalysisSessionId;
  workspaceId: WorkspaceId;
  /** 可信入口保存的工作区归属；缺失或 null 表示历史归属未知。 */
  workspaceScope?: NodeExecutionProfileScope | null;
  title: string;
  status: RequirementAnalysisSessionStatus;
  phase: RequirementAnalysisPhase;
  engine: EngineType;
  model?: string | null;
  effort?: string | null;
  runtimeThreadId?: ThreadId | null;
  engineSessionId?: string | null;
  latestTurnSummary?: string | null;
  latestAssistantReply?: string | null;
  candidateCount?: number;
  readyCandidateCount?: number;
  createdCandidateCount?: number;
  pendingCandidateCount?: number;
  /** 共享工作区上下文；存在时用于区分本人相关草稿和只读团队草稿。 */
  sharedContext?: SharedWorkspaceContextListItem | null;
  /** 共享工作区只读标记；true 表示当前账号只能查看，不能继续对话或生成正式需求。 */
  readOnly?: boolean;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
};

export type RequirementAnalysisMessage = {
  id: RequirementAnalysisMessageId;
  sessionId: RequirementAnalysisSessionId;
  role: RequirementAnalysisMessageRole;
  content: string;
  structuredPayloadJson?: string | null;
  createdAt: number;
};

export type RequirementCandidateDraft = {
  id: RequirementCandidateId;
  sessionId: RequirementAnalysisSessionId;
  creationState: RequirementCandidateCreationState;
  createdIntakeId?: IntakeId | null;
  createdProposalId?: ProposalId | null;
  title: string;
  goal: string;
  background?: string | null;
  acceptanceCriteria?: TaskAcceptanceCriterion[] | null;
  splitSource: "single" | "split-from-batch";
  complexity: RequirementAnalysisComplexity;
  uiScope: RequirementAnalysisUiScope;
  architectureRisk: RequirementAnalysisArchitectureRisk;
  recommendedWorkflowId?: WorkflowId | null;
  recommendedWorkflowName?: string | null;
  recommendedWorkflowReason: string;
  recommendedApproach: string;
  recommendedRoleIds: RoleId[];
  recommendedKnowledgeBundleIds: KnowledgeBundleId[];
  phasingAssessment: RequirementCandidatePhasingAssessment;
  sizeAssessment: RequirementCandidateSizeAssessment;
  assetGaps: RequirementAnalysisAssetGap[];
  clarificationItems: RequirementCandidateClarificationItem[];
  assumptions: string[];
  openQuestions: string[];
  readyToCreate: boolean;
  displayOrder?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type RequirementAnalysisAssistantCandidatePayload = {
  candidateId: RequirementCandidateId;
  title: string;
  goal: string;
  background?: string | null;
  acceptanceCriteria?: TaskAcceptanceCriterion[] | null;
  splitSource: "single" | "split-from-batch";
  complexity: RequirementAnalysisComplexity;
  uiScope: RequirementAnalysisUiScope;
  architectureRisk: RequirementAnalysisArchitectureRisk;
  recommendedWorkflowId?: WorkflowId | null;
  recommendedWorkflowName?: string | null;
  recommendedWorkflowReason: string;
  recommendedApproach: string;
  recommendedRoleIds: RoleId[];
  recommendedKnowledgeBundleIds: KnowledgeBundleId[];
  phasingAssessment: RequirementCandidatePhasingAssessment;
  sizeAssessment: RequirementCandidateSizeAssessment;
  assetGaps: RequirementAnalysisAssetGap[];
  clarificationItems: RequirementCandidateClarificationItem[];
  assumptions: string[];
  openQuestions: string[];
  readyToCreate: boolean;
};

export type RequirementAnalysisCandidateMutation =
  | {
    op: "create";
    candidateId?: RequirementCandidateId | string | null;
    candidate: Partial<RequirementAnalysisAssistantCandidatePayload> & {
      title?: string;
      goal?: string;
    };
  }
  | {
    op: "update";
    candidateId: RequirementCandidateId;
    patch: Partial<RequirementAnalysisAssistantCandidatePayload>;
  }
  | {
    op: "delete";
    candidateId: RequirementCandidateId;
    reason: string;
  };

export type RequirementAnalysisAssistantPayload = {
  schemaVersion: "requirement-analysis-assistant/v1" | "requirement-analysis-assistant/v2";
  phase: RequirementAnalysisPhase;
  conversationSummary: string;
  assistantReply: string;
  needUserInput: boolean;
  questions: RequirementAnalysisQuestion[];
  candidates: RequirementAnalysisAssistantCandidatePayload[];
  /** v2 patch 提交时模型基于的候选集合 hash，用于防止旧上下文覆盖新草稿。 */
  baseCandidateSetHash?: string | null;
  /** 平台合并并校验后的候选集合 hash。 */
  candidateSetHash?: string | null;
  /** v2 中模型提交的本轮候选变更；最终 candidates 仍由平台合并后生成。 */
  candidateMutations?: RequirementAnalysisCandidateMutation[] | null;
  nextAction: RequirementAnalysisSuggestedAction;
};

export type WorkflowProposal = {
  id: ProposalId;
  workspaceId: WorkspaceId;
  intakeId: IntakeId;
  intakeSnapshot: TaskIntake;
  status: ProposalStatus;
  recommendedFamily: WorkflowFamily;
  rationale: string;
  draftWorkflow: WorkflowRuntimeDefinition;
  draftRoleBindings: Array<{
    nodeId: string;
    roleId: RoleId;
    engine?: EngineType | null;
  }>;
  draftKnowledgeBindings: Array<{
    nodeId: string;
    bundleIds: KnowledgeBundleId[];
  }>;
  warnings?: string[] | null;
  requiresConfirmation: boolean;
  confirmedAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

/** 列表只携带方案身份和执行目标，完整需求与流程快照由详情接口读取。 */
export type WorkflowProposalSummary = Pick<WorkflowProposal,
  "id" | "workspaceId" | "intakeId" | "status" | "createdAt" | "updatedAt"
> & Pick<TaskIntake, "sharedContext" | "readOnly"> & { draftWorkflow: Pick<WorkflowRuntimeDefinition, "id" | "name"> };

// ── Runtime / Instance / Artifact ───────────────────────────────

export type OrchestrationStatus =
  | "pending"
  | "running"
  | "paused"
  | "waiting-start"
  | "waiting-approval"
  | "waiting-feedback"
  | "completed"
  | "failed"
  | "cancelled";

export type ManagedServiceStatus = "starting" | "ready" | "exited" | "stopped";

export type ManagedServiceSnapshot = {
  serviceId: string;
  displayName?: string | null;
  source?: "platform" | "engine";
  stopSupported?: boolean;
  status: ManagedServiceStatus;
  pid: number | null;
  command: string;
  args: string[];
  workingDirectory: string;
  startupTimeoutMs: number;
  readySummary: string | null;
  startedAt: number;
  readyAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
};

export type NodeExecutionStatus =
  | "pending"
  | "ready"
  | "queued"
  | "running"
  | "result-submitted"
  | "finalizing"
  | "artifact-writing"
  | "gate-checking"
  | "waiting-start"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting-feedback"
  | "cancelled";

export type NodeHumanActionSource =
  | "approval"
  | "gate"
  | "execution"
  | "review"
  | "human_input"
  | "branch_decision";

export type GateEvaluationOutcome = "pass" | "fail" | "error";

export type GateEvidence = {
  sourceId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  explanation?: string | null;
};

export type GateResult = {
  criterionId: string;
  passed: boolean;
  message: string;
  /** 结果来源和终态；旧数据缺失时按 passed 推导。 */
  outcome?: GateEvaluationOutcome | null;
  evaluatorKind?: "deterministic" | "ai" | null;
  evidence?: GateEvidence[] | null;
  errorCode?: string | null;
  evaluationRunId?: string | null;
  evaluationCallId?: string | null;
  evaluationThreadId?: ThreadId | null;
  evaluationTurnId?: TurnId | null;
  promptSnapshotId?: string | null;
};

export type ArtifactManifest = {
  summary?: string | null;
  changedFiles?: string[] | null;
  files?: Array<{
    fileKey?: string | null;
    fileRole?: "contract" | "attachment" | null;
    contractKey?: string | null;
    relPath: string;
    summary?: string | null;
    format?: string | null;
  }> | null;
};

export type ArtifactRevisionSource = "model" | "human";
export type NodeResultCompletion = "complete" | "partial" | "decision";
export type NodeResultValidationStatus = "not_validated" | "valid" | "invalid" | "warning";

export type NodeResultMetadata = {
  completion?: NodeResultCompletion | null;
  nextAction?: NodeNextAction | null;
  validationStatus?: NodeResultValidationStatus | null;
  validationReport?: unknown;
  consumable?: boolean | null;
  contractVersion?: string | null;
};

export type ArtifactRevisionMetadata = {
  source: ArtifactRevisionSource;
  basedOnArtifactId?: ArtifactId | null;
  basedOnVersion?: number | null;
  basedOnStatus?: "draft" | "approved" | "rejected" | "superseded" | null;
  note?: string | null;
  editedAt?: number | null;
};

export type ArtifactMetadata = Record<string, unknown> & {
  roleId?: string | null;
  threadId?: string | null;
  /** 生成该工件的节点 Attempt，用于收尾重放时幂等复用。 */
  nodeAttemptId?: string | null;
  artifactWritePolicy?: OutputWritePolicy | null;
  revision?: ArtifactRevisionMetadata | null;
  nodeResult?: NodeResultMetadata | null;
};

export type ArtifactFileEntry = {
  id: string;
  artifactId: ArtifactId;
  fileKey?: string | null;
  fileRole?: "contract" | "attachment" | null;
  format?: string | null;
  contractKey?: string | null;
  summary?: string | null;
  validationStatus?: NodeResultValidationStatus | null;
  relPath: string;
  stagingPath?: string | null;
  publishedPath?: string | null;
  status: Exclude<ArtifactWorkspaceStatus, "none">;
  contentHash: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
};

export type Artifact = {
  id: ArtifactId;
  instanceId: OrchestrationId;
  nodeId: string;
  kind: string;
  version: number;
  title: string;
  schemaRef?: string | null;
  status: "draft" | "approved" | "rejected" | "superseded";
  contentJson: string;
  metadata?: ArtifactMetadata | null;
  persistenceMode?: ArtifactPersistenceMode;
  payloadMode?: ArtifactOutputMode;
  workspaceStatus?: ArtifactWorkspaceStatus | null;
  workspaceBaseDir?: string | null;
  stagingPath?: string | null;
  publishedPath?: string | null;
  contentHash?: string | null;
  manifest?: ArtifactManifest | null;
  createdAt: number;
  updatedAt: number;
};

/** 节点会话恢复时仅覆盖下一轮执行的模型参数，不改写实例级角色配置。 */
export type NodeFeedbackExecutionOverride = {
  model: string;
  effort?: string | null;
  autoCompactPct?: number | null;
  contextWindow?: number | null;
  serviceTier?: CodexServiceTier | null;
};

export type FeedbackRecord = {
  id: FeedbackRecordId;
  instanceId: OrchestrationId;
  nodeId: string;
  action: FeedbackRecordAction;
  /** 记录触发本次反馈的等待来源，用于恢复执行时区分异常续跑与普通人工补充。 */
  source?: NodeHumanActionSource | null;
  feedback?: string | null;
  /** 人工反馈附带的图片 dataURL，随下一轮节点会话一起发送。 */
  images?: string[] | null;
  artifactIds?: ArtifactId[] | null;
  /** 节点会话输入栏选择的一次性执行参数，仅对该反馈触发的恢复轮次生效。 */
  executionOverride?: NodeFeedbackExecutionOverride | null;
  createdAt: number;
};

export type NodeExecutionState = {
  nodeId: string;
  status: NodeExecutionStatus;
  /** 当前节点执行轮次的持久化 Attempt；与 nodeExecutionId 指向同一标识。 */
  attemptId?: string | null;
  /** 当前执行轮次的稳定标识；由持久化 Attempt ID 提供。 */
  nodeExecutionId?: string | null;
  /** 当前节点执行轮次，从 1 开始；由持久化 Attempt 仓储单调递增。 */
  attemptNo?: number | null;
  /** submitNodeResult 已持久化后的稳定提交标识。 */
  submissionId?: string | null;
  /** 触发当前轮次的上一执行标识；首轮执行为空。 */
  parentExecutionId?: string | null;
  /** 当前节点等待人工动作时，标记这次介入是审核、门禁失败、执行异常还是模型主动请求。 */
  humanActionSource?: NodeHumanActionSource | null;
  /** 实例启动时冻结的节点处理人，避免流程模板后续变更影响已运行实例。 */
  assigneeUserIds?: string[] | null;
  /** 该节点的子线程。 */
  threadId?: ThreadId | null;
  /** 新建节点会话后保留的历史子线程，用于审计和回看旧上下文。 */
  previousThreadIds?: ThreadId[] | null;
  /** 该节点的讨论 sidecar 线程。 */
  discussionThreadId?: ThreadId | null;
  /** 渲染后的输入。 */
  renderedInput?: string | null;
  /** 原始文本产出，供监控界面和门禁检查使用。 */
  output?: string | null;
  promptSnapshotIds?: string[] | null;
  knowledgeWarnings?: string[] | null;
  gateResults?: GateResult[] | null;
  /** 当前 AI 门禁物理调用；权威状态由评估运行仓储保存。 */
  activeGateEvaluation?: ActiveGateEvaluation | null;
  conclusion?: NodeExecutionConclusion | null;
  retryCount: number;
  /** 该节点已发起的回退轮次；用于自动回退轮次上限判定，人工授权的回退同样计入。 */
  reworkCount?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  error?: string | null;
  /** 当前节点失败的稳定错误码；恢复策略不得依赖展示文案判断。 */
  errorCode?: string | null;
  /** 恢复失败对应的原 provider thread；不得用它替换 CodeFlow threadId。 */
  providerThreadId?: string | null;
  /** Provider resume/read 裁决给出的稳定原因，仅供诊断与审计。 */
  recoveryReason?: string | null;
  /** true 表示恢复失败后仍须保留原 provider binding。 */
  preserveBinding?: boolean | null;
  /** true 表示 provider 已明确不可恢复，必须由用户选择后续策略。 */
  userChoiceRequired?: boolean | null;
  /** 经过严格窄化的用户可选恢复策略。 */
  recoveryStrategies?: NodeThreadRecoveryStrategy[] | null;
  /** 已消费过一次平台自动恢复的反馈记录，防止同一输入重复执行。 */
  autoRecoveredFeedbackRecordIds?: FeedbackRecordId[] | null;
  /** condition 节点选择的分支。 */
  branchTaken?: string | null;
  inputArtifactIds?: ArtifactId[] | null;
  outputArtifactIds?: ArtifactId[] | null;
  /** 当前仍需注入后续 prompt 的活动反馈记录。 */
  activeFeedbackRecordIds?: FeedbackRecordId[] | null;
  /** 节点工作项轻量汇总；完整列表通过分页接口读取。 */
  workItemSummary?: NodeWorkItemSummary | null;
  /** 该节点的反馈审计历史。 */
  feedbackRecordIds?: FeedbackRecordId[] | null;
  /** 人工启动门禁的放行时间；重跑/重试会清空，避免新一轮绕过启动确认。 */
  manualStartApprovedAt?: number | null;
  /** 人工启动门禁的放行人；为空表示当前调用链未提供用户身份。 */
  manualStartApprovedBy?: string | null;
};

export type ActiveGateEvaluation = {
  evaluationRunId: string;
  evaluationCallId: string;
  retryOrdinal: number;
  statusVersion: number;
  artifactId: ArtifactId;
  nodeAttemptId: string;
  threadId: ThreadId;
  turnId: TurnId;
  promptSnapshotId: string;
  startedAt: number;
};

export type OrchestrationRuntimeConfig = {
  requireProposalConfirmation?: boolean;
  defaultNodeApprovalMode?: OrchestrationApprovalMode;
  /** guided 保留节点人工门禁；unattended 只跳过启动与审批，Agent ask_human 仍进入待反馈。 */
  interactionMode?: OrchestrationInteractionMode;
  executionEngineStrategy?: OrchestrationExecutionEngineStrategy;
  /** 本次流程实例启动前冻结的角色执行覆盖，不回写角色模板。 */
  roleExecutionOverrides?: Record<string, OrchestrationRoleExecutionOverride> | null;
  /** 人工重跑时显式同步的节点工作项策略；不改写历史 workflowSnapshot。 */
  nodeWorkItemPolicyOverrides?: Record<string, NodeWorkItemPolicy> | null;
  /** 本次运行读取工作区 Profile 的作用域；共享工作区固定使用 shared_workspace。 */
  executionProfileScope?: NodeExecutionProfileScope | null;
  /** 独立运行没有节点处理人时使用的发起人账号。 */
  initiatorUserId?: string | null;
  /** 协作运行启动前冻结的处理人与 Profile 预检事实。 */
  assignmentSnapshot?: InstanceAssignmentSnapshot | null;
};

export type OrchestrationInteractionMode = "guided" | "unattended";

export type OrchestrationExecutionEngineStrategy =
  | "follow-role"
  | "force-codex"
  | "force-claude"
  | "smart-planning";

export type OrchestrationRoleExecutionOverride = {
  engine?: EngineType | null;
  model?: string | null;
  effort?: string | null;
  autoCompactPct?: number | null;
  contextWindow?: number | null;
  serviceTier?: CodexServiceTier | null;
};

export type ExecutableToolDescriptor = {
  toolsetId: ToolsetId;
  toolsetName: string;
  toolId: ToolId;
  name: string;
  alias?: string | null;
  description: string;
  runtime: ToolRuntime;
  usageGuidance?: string | null;
  invocationHint?: string | null;
  code: string;
  inputSchema?: string | null;
  outputSchema?: string | null;
  timeoutMs?: number | null;
  workingDirectory?: string | null;
  permissions: {
    requiresWrite: boolean;
  };
  envPolicy?: ToolEnvPolicy | null;
  required?: boolean;
};

export type ExecutableToolRegistry = {
  tools: ExecutableToolDescriptor[];
};

export type NodeRuntimePolicy = {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  nodeLabel: string;
  approvalMode: OrchestrationApprovalMode;
  executionEngine: EngineType;
  executionProfileMode?: RoleExecutionProfileMode | null;
  executionProfileLabel?: string | null;
  accessMode: AccessMode;
  autoCompactPct?: number | null;
  contextWindow?: number | null;
  toolRuntimePolicy: {
    allowedToolIds: string[];
    requiresWorkspaceWrite: boolean;
  };
  artifactPolicy: {
    persistenceMode: ArtifactPersistenceMode;
    outputMode: ArtifactOutputMode;
    primaryKind: string | null;
  };
};

export type NodeArtifactInput = {
  artifacts: Array<{
    artifactId: string;
    kind: string;
    nodeId: string;
    title: string;
    version: number;
    status?: Artifact["status"] | string;
    summaryText?: string | null;
    textContent: string;
    workspaceFiles?: string[] | null;
    fields?: Array<{
      key: string;
      label?: string | null;
      valueType: RoleFieldType;
      valueText: string;
      valuePreview?: string | null;
      required: boolean;
      validationStatus: NodeResultFieldValidationStatus;
      truncated?: boolean;
    }> | null;
    workspaceFileRefs?: Array<{
      fileKey?: string | null;
      path: string;
      summary?: string | null;
      format?: string | null;
      validationStatus?: NodeResultValidationStatus | null;
    }> | null;
    workspaceAttachmentRefs?: Array<{
      key?: string | null;
      path: string;
      summary?: string | null;
      kind?: AttachmentKind | null;
      format?: string | null;
      validationStatus?: NodeResultValidationStatus | null;
    }> | null;
  }>;
  fieldBindings: Record<string, string>;
  /** Attempt-scoped input resolution frozen before prompt rendering. */
  inputContextId?: string | null;
  /** Structural evidence for expected inputs that actually reached this prompt. */
  inputReferences?: NodePromptInputReferenceSnapshot[] | null;
};

export type NodePromptInputReferenceSnapshot = {
  inputId: string;
  targetKey: string;
  required: boolean;
  selectorType: NodeInputReferenceSelector["type"];
  promptMode: NodeInputReference["promptMode"];
  status: ResolvedNodeInput["status"];
  errorCode?: string | null;
  sourceArtifactId?: ArtifactId | null;
  sourceFieldKey?: string | null;
};

export type ResolvedNodeInput = {
  inputId: string;
  targetKey: string;
  required: boolean;
  status: "resolved" | "missing" | "invalid";
  errorCode?: string | null;
  errorMessage?: string | null;
  config: NodeInputReference;
  source?: {
    nodeId: string;
    artifactId: ArtifactId;
    resultName: string;
    version: number;
    status: Artifact["status"] | string;
  } | null;
  value?:
    | { type: "inline"; text: string }
    | { type: "field"; fieldKey: string; valueJson: string; preview?: string | null }
    | {
        type: "file";
        fileKey?: string | null;
        artifactFileId?: string | null;
        relPath: string;
        workspacePath: string;
        summary?: string | null;
        format?: string | null;
        sizeBytes?: number | null;
        contentHash?: string | null;
        readRequired: boolean;
      }
    | { type: "file-set"; baseDir?: string | null; files: NodeResultFileRef[]; summary?: string | null }
    | { type: "result-summary"; summary?: string | null }
    | null;
  promptText: string;
};

export type NodeResultReference = {
  nodeId: string;
  artifactId: ArtifactId;
  resultName: string;
  version: number;
  status: Artifact["status"] | string;
};

export type ResolvedNodeContext = {
  schemaVersion: "node-context/v1";
  contextId: string;
  instanceId: OrchestrationId;
  nodeId: string;
  attemptNo: number;
  status: "resolved" | "missing_required" | "invalid";
  createdAt: number;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  } | null;
  task: {
    title: string;
    titlePathSegment: string;
    goal: string;
    background?: string | null;
  };
  inputs: ResolvedNodeInput[];
  upstreamResults: NodeResultReference[];
  feedback?: {
    latestAction?: string | null;
    text?: string | null;
  } | null;
};

export type NodeContextResolutionRecord = {
  id: string;
  instanceId: OrchestrationId;
  nodeId: string;
  attemptNo: number;
  status: ResolvedNodeContext["status"];
  context: ResolvedNodeContext;
  error?: ResolvedNodeContext["error"];
  createdAt: number;
};

export type OutputWritePolicy = {
  persistenceMode?: ArtifactPersistenceMode | null;
  baseDir?: string | null;
  overwritePolicy?: "reject" | "create-versioned-copy" | "overwrite" | null;
};

export function getArtifactWritePolicyFromMetadata(
  artifact: Pick<Artifact, "metadata"> | null | undefined,
): OutputWritePolicy | null {
  const raw = artifact?.metadata && typeof artifact.metadata === "object"
    ? (artifact.metadata as ArtifactMetadata).artifactWritePolicy
    : null;
  if (!raw || typeof raw !== "object") return null;
  return {
    persistenceMode: raw.persistenceMode ?? null,
    baseDir: raw.baseDir ?? null,
    overwritePolicy: raw.overwritePolicy ?? null,
  };
}

export function getArtifactRevisionMetadata(
  artifact: Pick<Artifact, "metadata"> | null | undefined,
): ArtifactRevisionMetadata | null {
  const raw = artifact?.metadata && typeof artifact.metadata === "object"
    ? (artifact.metadata as ArtifactMetadata).revision
    : null;
  if (!raw || typeof raw !== "object") return null;
  const source = String(raw.source ?? "").trim();
  if (source !== "model" && source !== "human") return null;
  const basedOnArtifactId = String(raw.basedOnArtifactId ?? "").trim() || null;
  const basedOnVersion = Number(raw.basedOnVersion);
  const basedOnStatus = String(raw.basedOnStatus ?? "").trim();
  return {
    source,
    basedOnArtifactId,
    basedOnVersion: Number.isFinite(basedOnVersion) ? Math.max(1, Math.round(basedOnVersion)) : null,
    basedOnStatus:
      basedOnStatus === "draft" || basedOnStatus === "approved" || basedOnStatus === "rejected" || basedOnStatus === "superseded"
        ? basedOnStatus
        : null,
    note: String(raw.note ?? "").trim() || null,
    editedAt: Number.isFinite(Number(raw.editedAt)) ? Math.round(Number(raw.editedAt)) : null,
  };
}

export type NodeExecutionFile = {
  key?: string | null;
  path: string;
  content?: string | null;
  summary?: string | null;
};

export type NodeExecutionAttachment = {
  key?: string | null;
  path: string;
  content?: string | null;
  summary?: string | null;
  kind?: AttachmentKind | null;
  format?: AttachmentFormat | null;
  language?: string | null;
};

export type NodeExecutionEnvelopeBase = {
  summary?: string | null;
  changedFiles?: string[] | null;
  fields?: Record<string, unknown> | null;
  attachments?: NodeExecutionAttachment[] | null;
};

export type NodeExecutionEnvelope =
  | (NodeExecutionEnvelopeBase & { mode: "text"; text: string })
  | (NodeExecutionEnvelopeBase & { mode: "structured"; data: unknown })
  | (NodeExecutionEnvelopeBase & { mode: "file"; file: NodeExecutionFile })
  | (NodeExecutionEnvelopeBase & { mode: "file-set"; files: NodeExecutionFile[] });

export type NodeResultContractValidationResult = {
  accepted: boolean;
  completion: NodeResultCompletion;
  consumable: boolean;
  contractVersion: "node-result-contract/v1";
  normalizedAnswer: NodeExecutionEnvelope;
  normalizedFields: NodeResultField[];
  normalizedFiles: NodeResultFileRef[];
  fieldResults: NodeResultFieldValidationResult[];
  fileResults: NodeResultFileValidationResult[];
  blockingIssues: NodeContractValidationIssue[];
  recoverableIssues: NodeContractValidationIssue[];
  warnings: NodeContractValidationIssue[];
};

export type NodeFinalAnswerPayload = {
  answer: NodeExecutionEnvelope;
  control: NodeFinalAnswerControl;
  review: NodeFinalAnswerReview;
  acceptanceChecks?: NodeAcceptanceCheck[] | null;
  humanInput?: NodeHumanInputRequest | null;
  rework?: NodeReworkDirective | null;
};

export type NodePromptIntent =
  | "execute"
  | "resume-current-node"
  | "resume-interrupted-node"
  | "rework-current-node"
  | "rework-upstream-node";

export type NodePromptRoleContext = {
  roleId: RoleId;
  name: string;
  description?: string | null;
  responsibility?: string | null;
  systemPrompt?: string | null;
  formalTemplateName: string;
  inputDefinition: RoleInputDefinition;
  outputDefinition: RoleOutputDefinition;
};

export type NodePromptTaskContext = {
  title: string;
  titlePathSegment?: string | null;
  goal: string;
  background?: string | null;
  acceptanceCriteria?: TaskAcceptanceCriterion[] | null;
  renderedTaskInput: string;
  fieldBindings: Record<string, string>;
};

export type NodePromptArtifactContext = {
  upstreamArtifacts: NodeArtifactInput["artifacts"];
  feedbackArtifacts?: NodeArtifactInput["artifacts"] | null;
  inputContextId?: string | null;
  inputReferences?: NodePromptInputReferenceSnapshot[] | null;
};

export type NodePromptKnowledgeContext = {
  catalogs: KnowledgeCatalogSnapshot[];
  /** 已采用项目规格与确定读取纪律；每次节点执行由项目事实源重新读取。 */
  projectSpecifications?: string | null;
  warnings?: KnowledgeResolverWarning[] | null;
};

export type NodePromptSkillContext = {
  items: SkillPromptSnapshot[];
};

export type NodePromptReviewContext = {
  feedbackPatch?: string | null;
  latestFeedbackPatch?: string | null;
  latestFeedbackText?: string | null;
  latestAction?: FeedbackRecordAction | null;
  latestSource?: NodeHumanActionSource | null;
};

export type NodePromptRuntimeContext = {
  runtimePolicy: NodeRuntimePolicy;
  toolRegistry?: ExecutableToolRegistry | null;
  executionProfiles?: NodeExecutionProfileSnapshot[] | null;
};

/** Captures the provider, credential route, and optional Relay price selected for one model call. */
export type NodePromptBillingContext = {
  providerId: EngineModelProviderId;
  credentialSource: EngineCredentialSource;
  priceSnapshot?: RelayInvocationPriceSnapshot | null;
  capturedAt: number;
};

export type NodePromptEnvelope = {
  schemaVersion: "node-prompt-envelope/v1";
  meta: {
    scene: "orchestration-node";
    instanceId: OrchestrationId;
    workflowId: WorkflowId;
    workflowName: string;
    nodeId: string;
    nodeLabel: string;
    intent: NodePromptIntent;
    roleExecutionRevision?: RoleExecutionRevision | null;
    billingContext?: NodePromptBillingContext | null;
  };
  role: NodePromptRoleContext;
  task: NodePromptTaskContext;
  artifacts: NodePromptArtifactContext;
  knowledge: NodePromptKnowledgeContext;
  skills?: NodePromptSkillContext | null;
  review: NodePromptReviewContext;
  runtime: NodePromptRuntimeContext;
};

export type NodePromptSnapshot = {
  id: string;
  instanceId: OrchestrationId;
  nodeId: string;
  attemptNo: number;
  threadId?: ThreadId | null;
  turnId?: string | null;
  engine: EngineType;
  model?: string | null;
  effort?: string | null;
  promptEnvelope: NodePromptEnvelope;
  roleExecutionRevision?: RoleExecutionRevision | null;
  systemMessage: string;
  developerMessage?: string | null;
  userMessage: string;
  renderedInputPreview: string;
  runtimePolicy: NodeRuntimePolicy;
  toolRegistry?: ExecutableToolRegistry | null;
  knowledgeCatalogs: KnowledgeCatalogSnapshot[];
  knowledgeWarnings?: KnowledgeResolverWarning[] | null;
  artifactInput: NodeArtifactInput;
  /** 区分普通节点执行与 AI 门禁评估提示词。历史数据缺失时按 node-execution 处理。 */
  purpose?: "node-execution" | "gate-evaluation" | null;
  /** false 表示 list 只返回了轻量摘要，完整内容需按 id 读取。 */
  contentLoaded?: boolean | null;
  createdAt: number;
};

export const DEFAULT_ROLE_EXECUTION_CUSTOM_CONFIG: Record<EngineType, RoleExecutionCustomConfig> = {
  claude: buildDefaultRoleExecutionCustomConfig("claude"),
  codex: buildDefaultRoleExecutionCustomConfig("codex"),
};

export function createDefaultRoleExecutionCustomConfig(engine: EngineType): RoleExecutionCustomConfig {
  const base = DEFAULT_ROLE_EXECUTION_CUSTOM_CONFIG[engine];
  return { ...base };
}

export function createDefaultRoleExecutionProfile(
  engine: EngineType,
  options?: { enabled?: boolean; mode?: RoleExecutionProfileMode },
): RoleExecutionEngineProfile {
  const mode = options?.mode === "custom" ? "custom" : "auto";
  return {
    enabled: Boolean(options?.enabled),
    mode,
    customConfig: mode === "custom" ? createDefaultRoleExecutionCustomConfig(engine) : null,
  };
}

export function createDefaultRoleExecutionConfig(preferredEngine: EngineType = "codex"): RoleExecutionConfig {
  const preferred = preferredEngine === "claude" ? "claude" : "codex";
  return {
    preferredEngine: preferred,
    engineProfiles: {
      claude: createDefaultRoleExecutionProfile("claude", { enabled: true }),
      codex: createDefaultRoleExecutionProfile("codex", { enabled: true }),
    },
  };
}

function buildDefaultRoleExecutionCustomConfig(engine: EngineType): RoleExecutionCustomConfig {
  const defaults = resolveCatalogDefaultThreadPrefs(engine);
  return {
    model: defaults.model ?? "",
    effort: defaults.effort ?? "",
    accessMode: defaults.accessMode,
    autoCompactPct: PRODUCT_DEFAULT_AUTO_COMPACT_PCT,
    contextWindow: null,
    maxRetries: 0,
    serviceTier: null,
  };
}

export function normalizeOrchestrationExecutionEngineStrategy(
  raw: unknown,
  fallback: OrchestrationExecutionEngineStrategy = "follow-role",
): OrchestrationExecutionEngineStrategy {
  const value = String(raw ?? "").trim();
  if (value === "follow-role" || value === "force-codex" || value === "force-claude" || value === "smart-planning") {
    return value;
  }
  return fallback;
}

export function createDefaultRoleInputDefinition(): RoleInputDefinition {
  return {
    instructions: "{{requirement}}",
    requiredFields: [],
  };
}

export function createDefaultRoleOutputDefinition(): RoleOutputDefinition {
  return {
    instructions: "",
    deliveryMode: "direct",
    format: "markdown",
    resultKey: null,
    filePathRule: null,
    files: [],
    requiredFields: [],
  };
}

export function createDefaultRoleOutputFileDefinition(): RoleOutputFileDefinition {
  return {
    key: null,
    name: "",
    format: null,
    allowedExtensions: null,
    pathRule: null,
    description: null,
    required: true,
  };
}

export function normalizeRoleFieldDefinitions(raw: RoleFieldDefinition[] | null | undefined): RoleFieldDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((field, index) => ({
    key: String(field?.key ?? "").trim() || `field_${index + 1}`,
    label: String(field?.label ?? "").trim() || `字段 ${index + 1}`,
    valueType: field?.valueType === "markdown" || field?.valueType === "json" || field?.valueType === "file-path"
      ? field.valueType
      : "text",
    required: Boolean(field?.required),
    description: String(field?.description ?? "").trim() || null,
    example: String(field?.example ?? "").trim() || null,
  }));
}

export function normalizeRoleInputDefinition(raw: Partial<RoleInputDefinition> | RoleInputDefinition | null | undefined): RoleInputDefinition {
  return {
    instructions: String(raw?.instructions ?? "").replace(/\r\n/g, "\n"),
    requiredFields: normalizeRoleFieldDefinitions(raw?.requiredFields),
  };
}

function normalizeRoleOutputFormatValue(raw: unknown): RoleOutputFormat | null {
  const value = String(raw ?? "").trim();
  switch (value) {
    case "markdown":
    case "json":
    case "yaml":
    case "text":
    case "html":
    case "javascript":
    case "css":
    case "sql":
    case "image":
      return value;
    default:
      return null;
  }
}

/** 归一化文件交付项 key，保证旧配置也能获得稳定引用标识。 */
export function normalizeRoleOutputFileKey(raw: unknown, fallbackParts: Array<unknown>, index: number): string {
  const candidates = [raw, ...fallbackParts, `file-${index + 1}`];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "")
      .trim()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalized) return normalized.slice(0, 64);
  }
  return `file-${index + 1}`;
}

/** 归一化允许后缀，统一保存为小写且带点的扩展名。 */
export function normalizeRoleOutputAllowedExtensions(raw: unknown): string[] | null {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,;]+/)
      : [];
  const normalized = values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`))
    .filter((value) => /^\.[a-z0-9][a-z0-9._-]*$/.test(value));
  const unique = Array.from(new Set(normalized));
  return unique.length ? unique : null;
}

export function normalizeRoleOutputFileDefinitions(
  raw: RoleOutputFileDefinition[] | null | undefined,
  options?: {
    deliveryMode?: RoleOutputDeliveryMode | null | undefined;
    fallbackFormat?: RoleOutputFormat | null | undefined;
    legacyFilePathRule?: string | null | undefined;
    legacyInstructions?: string | null | undefined;
  },
): RoleOutputFileDefinition[] {
  if (options?.deliveryMode === "direct") return [];
  const fallbackFormat = normalizeRoleOutputFormatValue(options?.fallbackFormat) ?? "markdown";
  const normalized: RoleOutputFileDefinition[] = [];
  const usedKeys = new Set<string>();
  if (Array.isArray(raw)) {
    raw.forEach((file, index) => {
      const baseKey = normalizeRoleOutputFileKey(file?.key, [
        file?.name,
        file?.pathRule,
        options?.deliveryMode === "file" ? "main" : null,
      ], index);
      let key = baseKey;
      let dedupeIndex = 2;
      while (usedKeys.has(key)) {
        key = `${baseKey}-${dedupeIndex}`;
        dedupeIndex += 1;
      }
      const name = String(file?.name ?? "").trim();
      const format = String(file?.format ?? "").trim();
      const pathRule = String(file?.pathRule ?? "").trim() || null;
      const description = String(file?.description ?? "").trim() || null;
      const formatValue = normalizeRoleOutputFormatValue(format);
      const allowedExtensions = normalizeRoleOutputAllowedExtensions(file?.allowedExtensions);
      const meaningful = Boolean(file?.key || name || pathRule || description || formatValue || allowedExtensions);
      if (!meaningful) return;
      usedKeys.add(key);
      normalized.push({
        key,
        name: name || (options?.deliveryMode === "file" ? "交付文件" : `交付项 ${index + 1}`),
        format: formatValue,
        allowedExtensions,
        pathRule,
        description,
        required: file?.required !== false,
      });
    });
  }

  if (normalized.length > 0) return normalized;

  if (options?.deliveryMode === "file" || options?.deliveryMode === "file-set") {
    const legacyFilePathRule = String(options?.legacyFilePathRule ?? "").trim() || null;
    const legacyInstructions = String(options?.legacyInstructions ?? "").replace(/\r\n/g, "\n").trim() || null;
    if (legacyFilePathRule || legacyInstructions) {
      const migratedDescriptionParts = [
        legacyInstructions,
        options.deliveryMode === "file-set"
          ? "这条配置由旧的整体交付规则自动迁移而来，不代表只能交付一个文件；如需分别约束主文档、附件或目录，请继续补充交付项。"
          : null,
      ].filter(Boolean);
      return [{
        key: "main",
        name: options.deliveryMode === "file" ? "交付文件" : "默认交付项（待拆分）",
        format: fallbackFormat,
        allowedExtensions: null,
        pathRule: legacyFilePathRule,
        description: migratedDescriptionParts.length ? migratedDescriptionParts.join("\n\n") : null,
        required: true,
      }];
    }
  }
  return [];
}

export function normalizeRoleOutputDefinition(raw: Partial<RoleOutputDefinition> | RoleOutputDefinition | null | undefined): RoleOutputDefinition {
  const deliveryMode = String(raw?.deliveryMode ?? "").trim();
  const format = String(raw?.format ?? "").trim();
  const normalizedDeliveryMode = deliveryMode === "file" || deliveryMode === "file-set" ? deliveryMode : "direct";
  const normalizedFormat = normalizeRoleOutputFormatValue(format) ?? "markdown";
  const normalizedFiles = normalizeRoleOutputFileDefinitions(raw?.files, {
    deliveryMode: normalizedDeliveryMode,
    fallbackFormat: normalizedFormat,
    legacyFilePathRule: raw?.filePathRule,
    legacyInstructions: raw?.instructions,
  });
  const normalizedFilePathRule = String(raw?.filePathRule ?? "").trim()
    || (normalizedDeliveryMode === "file" ? normalizedFiles[0]?.pathRule ?? "" : "");
  return {
    instructions: String(raw?.instructions ?? "").replace(/\r\n/g, "\n"),
    deliveryMode: normalizedDeliveryMode,
    format: normalizedFormat,
    resultKey: String(raw?.resultKey ?? "").trim() || null,
    filePathRule: normalizedFilePathRule || null,
    files: normalizedFiles,
    requiredFields: normalizeRoleFieldDefinitions(raw?.requiredFields),
  };
}

export function inferRoleArtifactOutputMode(outputDefinition: RoleOutputDefinition | null | undefined): ArtifactOutputMode {
  const normalized = normalizeRoleOutputDefinition(outputDefinition);
  if (normalized.deliveryMode === "file") return "file";
  if (normalized.deliveryMode === "file-set") return "file-set";
  return normalized.format === "json" || normalized.format === "yaml" ? "structured" : "text";
}

export function normalizeRoleExecutionConfig(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  fallbackPreferredEngine: EngineType = "codex",
): RoleExecutionConfig {
  const fallbackEngine = fallbackPreferredEngine === "claude" ? "claude" : "codex";
  let preferredEngine = raw?.preferredEngine === "claude" || raw?.preferredEngine === "codex"
    ? raw.preferredEngine
    : fallbackEngine;
  const rawProfiles = raw?.engineProfiles ?? null;
  const engineProfiles: Record<EngineType, RoleExecutionEngineProfile> = {
    claude: normalizeRoleExecutionProfile(rawProfiles?.claude, "claude", true),
    codex: normalizeRoleExecutionProfile(rawProfiles?.codex, "codex", true),
  };

  if (!engineProfiles.claude.enabled && !engineProfiles.codex.enabled) {
    engineProfiles[preferredEngine].enabled = true;
  }
  if (!engineProfiles[preferredEngine].enabled) {
    preferredEngine = engineProfiles.codex.enabled ? "codex" : "claude";
  }
  return {
    preferredEngine,
    engineProfiles,
  };
}

export function resolveRoleExecutionConfigForStrategy(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  strategy: OrchestrationExecutionEngineStrategy | null | undefined,
  fallbackEngine: EngineType = "codex",
): ResolvedRoleExecutionConfig {
  const normalized = normalizeRoleExecutionConfig(raw, fallbackEngine);
  const normalizedStrategy = normalizeOrchestrationExecutionEngineStrategy(strategy, "follow-role");
  const targetEngine: EngineType =
    normalizedStrategy === "force-codex"
      ? "codex"
      : normalizedStrategy === "force-claude"
        ? "claude"
        : normalized.preferredEngine;
  return resolveRoleExecutionConfigForEngine(normalized, targetEngine);
}

export function getEnabledRoleExecutionEngines(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  fallbackPreferredEngine: EngineType = "codex",
): EngineType[] {
  const normalized = normalizeRoleExecutionConfig(raw, fallbackPreferredEngine);
  return (["claude", "codex"] as EngineType[]).filter((engine) => normalized.engineProfiles[engine].enabled);
}

export function isRoleExecutionEngineEnabled(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  engine: EngineType,
  fallbackPreferredEngine: EngineType = "codex",
): boolean {
  const normalized = normalizeRoleExecutionConfig(raw, fallbackPreferredEngine);
  return normalized.engineProfiles[engine].enabled;
}

export function resolveRoleExecutionConfigForEngine(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  engine: EngineType,
  fallbackPreferredEngine: EngineType = "codex",
): ResolvedRoleExecutionConfig {
  const normalized = normalizeRoleExecutionConfig(raw, fallbackPreferredEngine);
  const targetEngine = engine === "claude" ? "claude" : "codex";
  const profile = normalized.engineProfiles[targetEngine];
  if (!profile.enabled) {
    throw new Error(`目标引擎未启用：${targetEngine}`);
  }
  if (profile.mode === "auto") {
    const defaults = createDefaultRoleExecutionCustomConfig(targetEngine);
    return {
      engine: targetEngine,
      sourceMode: "auto",
      model: defaults.model,
      effort: defaults.effort,
      accessMode: defaults.accessMode,
      autoCompactPct: defaults.autoCompactPct ?? null,
      contextWindow: defaults.contextWindow ?? null,
      maxRetries: defaults.maxRetries ?? 0,
      serviceTier: defaults.serviceTier ?? null,
    };
  }
  const custom = normalizeRoleExecutionCustomConfig(profile.customConfig, targetEngine);
  return {
    engine: targetEngine,
    sourceMode: "custom",
    model: custom.model,
    effort: custom.effort,
    accessMode: custom.accessMode,
    autoCompactPct: custom.autoCompactPct ?? null,
    contextWindow: custom.contextWindow ?? null,
    maxRetries: custom.maxRetries ?? 0,
    serviceTier: custom.serviceTier ?? null,
  };
}

function normalizeRoleExecutionProfile(
  raw: Partial<RoleExecutionEngineProfile> | RoleExecutionEngineProfile | null | undefined,
  engine: EngineType,
  defaultEnabled: boolean,
): RoleExecutionEngineProfile {
  const mode = raw?.mode === "custom" ? "custom" : "auto";
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : defaultEnabled,
    mode,
    customConfig: mode === "custom"
      ? normalizeRoleExecutionCustomConfig(raw?.customConfig, engine)
      : null,
  };
}

/** 归一化角色自定义执行配置；显式空 effort 表示运行时不发送思考强度。 */
function normalizeRoleExecutionCustomConfig(
  raw: Partial<RoleExecutionCustomConfig> | RoleExecutionCustomConfig | null | undefined,
  engine: EngineType,
): RoleExecutionCustomConfig {
  const defaults = createDefaultRoleExecutionCustomConfig(engine);
  const hasRawObject = Boolean(raw && typeof raw === "object");
  const hasEffort = hasRawObject && Object.prototype.hasOwnProperty.call(raw as Record<string, unknown>, "effort");
  const model = String(raw?.model ?? "").trim();
  const effort = String(raw?.effort ?? "").trim();
  const accessMode = String(raw?.accessMode ?? "").trim();
  const autoCompactPct = Number(raw?.autoCompactPct);
  const contextWindow = Number(raw?.contextWindow);
  const maxRetries = Number(raw?.maxRetries);
  // 只识别显式 "fast"：其它取值一律视为未开启，避免把非法档位带进执行链路。
  const serviceTier = raw?.serviceTier === "fast" ? "fast" : null;
  return {
    model: model || defaults.model,
    effort: hasEffort ? effort : defaults.effort,
    accessMode: accessMode === "read-only" || accessMode === "current" || accessMode === "full-access"
      ? accessMode
      : defaults.accessMode,
    autoCompactPct: Number.isFinite(autoCompactPct) && autoCompactPct >= 50 && autoCompactPct <= 99
      ? Math.round(autoCompactPct)
      : defaults.autoCompactPct ?? PRODUCT_DEFAULT_AUTO_COMPACT_PCT,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.round(contextWindow)
      : null,
    maxRetries: Number.isFinite(maxRetries) ? Math.max(0, Math.round(maxRetries)) : defaults.maxRetries ?? 0,
    serviceTier,
  };
}

function normalizeSingleLineText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type OrchestrationInstance = {
  id: OrchestrationId;
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  proposalId?: ProposalId | null;
  /** 执行时冻结的任务入口快照。 */
  intakeSnapshot: TaskIntake;
  /** 执行时冻结的工作流快照。 */
  workflowSnapshot: WorkflowRuntimeDefinition;
  /** 启动时冻结或升级兼容补录的完整权威资产图；尚未补录的旧实例允许为空。 */
  assetRuntimeSnapshot?: OrchestrationAssetRuntimeSnapshot | null;
  /** 遗留轻量角色快照；新实例只保存无展示时间的运行定义。 */
  roleSnapshots?: Record<string, RoleRuntimeDefinition> | null;
  /** 遗留轻量工具集快照；新实例只保存无展示时间的运行定义。 */
  toolsetSnapshots?: Record<string, ToolsetRuntimeDefinition> | null;
  runtimeConfig?: OrchestrationRuntimeConfig | null;
  artifactIndex?: Record<string, ArtifactId[]> | null;
  /** 遗留兼容：旧实例可能仍绑定过主线程，新实例应为 null。 */
  masterThreadId?: ThreadId | null;
  status: OrchestrationStatus;
  nodeStates: Record<string, NodeExecutionState>;
  /** 共享工作区上下文；存在时用于让实例详情继承需求只读边界。 */
  sharedContext?: SharedWorkspaceContextListItem | null;
  /** 共享工作区只读标记；true 表示当前账号只能查看，不能推进该流程。 */
  readOnly?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type NodeResultFieldSource = "model" | "system" | "human";
export type NodeResultFieldValidationStatus = "valid" | "missing" | "invalid";

export type NodeResultField = {
  id: string;
  artifactId: ArtifactId;
  instanceId: OrchestrationId;
  nodeId: string;
  resultName: string;
  fieldKey: string;
  label?: string | null;
  valueType: RoleFieldType;
  valueJson: string;
  valuePreview?: string | null;
  required: boolean;
  source: NodeResultFieldSource;
  validationStatus: NodeResultFieldValidationStatus;
  createdAt: number;
  updatedAt: number;
};

export type NodeResultFileRef = {
  artifactId: ArtifactId;
  fileKey?: string | null;
  source?: "contract" | "attachment";
  contractKey?: string | null;
  relPath: string;
  workspacePath: string;
  summary?: string | null;
  kind?: AttachmentKind | null;
  format?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  readRequired: boolean;
};

export type NodeResultFileSetRef = {
  artifactId: ArtifactId;
  baseDir?: string | null;
  files: NodeResultFileRef[];
  summary?: string | null;
};

export type NodeContractValidationIssue = {
  code: string;
  message: string;
  path?: string | null;
  severity: "blocking" | "recoverable" | "warning";
  details?: unknown;
};

export type NodeResultFieldValidationResult = {
  fieldKey: string;
  status: NodeResultFieldValidationStatus;
  issue?: NodeContractValidationIssue | null;
};

export type NodeResultFileValidationResult = {
  fileKey?: string | null;
  source?: "contract" | "attachment";
  path?: string | null;
  status: NodeResultValidationStatus;
  issue?: NodeContractValidationIssue | null;
};

export type NodeExecutionRuntimePatch = Pick<
  NodeExecutionState,
  | "nodeId"
  | "status"
  | "attemptId"
  | "nodeExecutionId"
  | "attemptNo"
  | "submissionId"
  | "parentExecutionId"
  | "humanActionSource"
  | "assigneeUserIds"
  | "threadId"
  | "previousThreadIds"
  | "discussionThreadId"
  | "promptSnapshotIds"
  | "knowledgeWarnings"
  | "gateResults"
  | "retryCount"
  | "startedAt"
  | "completedAt"
  | "error"
  | "errorCode"
  | "providerThreadId"
  | "recoveryReason"
  | "preserveBinding"
  | "userChoiceRequired"
  | "recoveryStrategies"
  | "branchTaken"
  | "inputArtifactIds"
  | "outputArtifactIds"
  | "activeFeedbackRecordIds"
  | "workItemSummary"
  | "feedbackRecordIds"
  | "manualStartApprovedAt"
  | "manualStartApprovedBy"
>;

export type OrchestrationRunSummaryTone = "neutral" | "info" | "success" | "warning" | "danger";

export type OrchestrationWaitingActionKind =
  | "start"
  | "approval"
  | "branch_decision"
  | "human_input"
  | "review_decision"
  | "gate_failure"
  | "execution_error"
  | "feedback";

export type OrchestrationRunSummary = {
  instanceId: OrchestrationId;
  statusLabel: string;
  statusTone: OrchestrationRunSummaryTone;
  progressDone: number;
  progressTotal: number;
  progressRatio: number;
  progressText: string;
  detailText: string | null;
  activeNodeId: string | null;
  activeNodeLabel: string | null;
  activeNodeStatus: NodeExecutionStatus | null;
  /** 当前活跃节点的有效处理人；协作运行优先使用冻结处理人，独立运行回退到发起人。 */
  activeNodeAssigneeUserIds?: string[] | null;
  waitingActionKind: OrchestrationWaitingActionKind | null;
  artifactCount: number;
};

export type OrchestrationInstanceSummary = {
  id: OrchestrationId;
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  proposalId?: ProposalId | null;
  intakeId: IntakeId;
  intakeTitle: string;
  intakeGoalPreview: string;
  workflowName?: string | null;
  status: OrchestrationStatus;
  runSummary: OrchestrationRunSummary;
  /** 共享工作区上下文；存在时用于区分本人相关执行和只读团队执行。 */
  sharedContext?: SharedWorkspaceContextListItem | null;
  /** 共享工作区只读标记；true 表示当前账号只能查看，不能推进该流程。 */
  readOnly?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationInstanceRuntimePatch = {
  id: OrchestrationId;
  workspaceId: WorkspaceId;
  /** 实例所属流程；展示层据此把节点名解析到当前定义，执行仍用实例冻结快照。 */
  workflowId?: WorkflowId | null;
  /** 共享工作区 runtime-patch 权限校验所需的轻量需求归属。 */
  intakeId?: IntakeId | null;
  /** 实例来源；用于共享定时任务编排跳过普通需求上下文校验。 */
  sourceKind?: TaskIntakeSourceKind | null;
  status: OrchestrationStatus;
  runSummary: OrchestrationRunSummary;
  artifactIndex?: Record<string, ArtifactId[]> | null;
  nodeStates: Record<string, NodeExecutionRuntimePatch>;
  updatedAt: number;
};

export type OrchestrationInstanceSummaryOptions = {
  artifactCount?: number | null;
  goalPreviewLength?: number | null;
};

/** 从完整编排实例派生列表摘要，避免列表接口下发详情级快照。 */
export function deriveOrchestrationInstanceSummary(
  instance: OrchestrationInstance,
  options: OrchestrationInstanceSummaryOptions = {},
): OrchestrationInstanceSummary {
  const intakeTitle = getTaskIntakeTitle(instance.intakeSnapshot);
  return {
    id: instance.id,
    workspaceId: instance.workspaceId,
    workflowId: instance.workflowId,
    proposalId: instance.proposalId ?? null,
    intakeId: instance.intakeSnapshot.id,
    intakeTitle,
    intakeGoalPreview: normalizeSummaryPreviewText(instance.intakeSnapshot.goal, options.goalPreviewLength ?? 120),
    workflowName: String(instance.workflowSnapshot?.name ?? "").trim() || null,
    status: instance.status,
    runSummary: deriveOrchestrationRunSummary(instance, options),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

/** 从完整编排实例派生运行摘要，保持列表态和执行监控的状态口径一致。 */
export function deriveOrchestrationRunSummary(
  instance: OrchestrationInstance,
  options: OrchestrationInstanceSummaryOptions = {},
): OrchestrationRunSummary {
  const nodeStates = instance.workflowSnapshot.nodes
    .filter((node) => isSummaryProgressNode(node))
    .map((node) => ({ node, state: instance.nodeStates[node.id] ?? null }))
    .filter((entry): entry is { node: WorkflowNode; state: NodeExecutionState } => Boolean(entry.state));

  const artifactCount = Number.isFinite(Number(options.artifactCount))
    ? Math.max(0, Math.round(Number(options.artifactCount)))
    : countSummaryArtifacts(instance.artifactIndex);
  const progressTotal = nodeStates.length;
  const progressDone = nodeStates.filter(({ state }) => isSummaryCompletedProgressStatus(state.status)).length;
  const displayProgressDone = instance.status === "completed" ? progressTotal : progressDone;
  const progressRatio = progressTotal > 0 ? Math.min(1, displayProgressDone / progressTotal) : 0;
  const progressText = progressTotal > 0 ? `已完成 ${displayProgressDone}/${progressTotal} 节点` : "暂无流程节点";

  if (instance.status === "completed") {
    return buildOrchestrationRunSummary(instance, {
      artifactCount,
      statusLabel: "已完成",
      statusTone: "success",
      progressDone: displayProgressDone,
      progressTotal,
      progressRatio,
      progressText,
      detailText: "当前执行已完成",
    });
  }

  const waitingFeedback = findFirstSummaryNodeByStatus(nodeStates, "waiting-feedback");
  if (waitingFeedback) {
    const descriptor = resolveSummaryWorkbenchDescriptor(waitingFeedback.state);
    return buildOrchestrationRunSummary(instance, {
      artifactCount,
      statusLabel: descriptor.statusLabel,
      statusTone: descriptor.attentionKind === "execution_error" ? "danger" : "warning",
      progressDone: displayProgressDone,
      progressTotal,
      progressRatio,
      progressText,
      detailText: `${waitingFeedback.node.label} · ${descriptor.detailLabel ?? descriptor.statusLabel}`,
      activeNodeId: waitingFeedback.node.id,
      activeNodeLabel: waitingFeedback.node.label,
      activeNodeStatus: waitingFeedback.state.status,
      waitingActionKind: descriptor.attentionKind ?? "feedback",
    });
  }

  const waitingStart = findFirstSummaryNodeByStatus(nodeStates, "waiting-start");
  if (waitingStart) {
    const descriptor = resolveSummaryWorkbenchDescriptor(waitingStart.state);
    return buildOrchestrationRunSummary(instance, {
      artifactCount,
      statusLabel: descriptor.statusLabel,
      statusTone: "warning",
      progressDone: displayProgressDone,
      progressTotal,
      progressRatio,
      progressText,
      detailText: `${waitingStart.node.label} · ${descriptor.detailLabel ?? descriptor.statusLabel}`,
      activeNodeId: waitingStart.node.id,
      activeNodeLabel: waitingStart.node.label,
      activeNodeStatus: waitingStart.state.status,
      waitingActionKind: "start",
    });
  }

  const waitingApproval = findFirstSummaryNodeByStatus(nodeStates, "waiting-approval");
  if (waitingApproval) {
    const descriptor = resolveSummaryWorkbenchDescriptor(waitingApproval.state);
    return buildOrchestrationRunSummary(instance, {
      artifactCount,
      statusLabel: descriptor.statusLabel,
      statusTone: "info",
      progressDone: displayProgressDone,
      progressTotal,
      progressRatio,
      progressText,
      detailText: `${waitingApproval.node.label} · ${descriptor.detailLabel ?? descriptor.statusLabel}`,
      activeNodeId: waitingApproval.node.id,
      activeNodeLabel: waitingApproval.node.label,
      activeNodeStatus: waitingApproval.state.status,
      waitingActionKind: "approval",
    });
  }

  const runningNode = nodeStates.find(({ state }) => isSummaryRunningLikeStatus(state.status)) ?? null;
  if (runningNode) {
    return buildOrchestrationRunSummary(instance, {
      artifactCount,
      statusLabel: instance.status === "paused" ? "已暂停" : "执行中",
      statusTone: instance.status === "paused" ? "warning" : "info",
      progressDone: displayProgressDone,
      progressTotal,
      progressRatio,
      progressText,
      detailText: `${runningNode.node.label} · ${summaryNodeStatusLabel(runningNode.state.status)}`,
      activeNodeId: runningNode.node.id,
      activeNodeLabel: runningNode.node.label,
      activeNodeStatus: runningNode.state.status,
    });
  }

  const resumableNode = findSummaryResumableNode(nodeStates);
  if (resumableNode && progressDone > 0) {
    const paused = instance.status === "paused";
    return buildOrchestrationRunSummary(instance, {
      artifactCount,
      statusLabel: paused ? "已暂停" : "待继续",
      statusTone: paused ? "warning" : "info",
      progressDone: displayProgressDone,
      progressTotal,
      progressRatio,
      progressText,
      detailText: `${resumableNode.node.label} · ${paused ? "已暂停，等待恢复" : "等待继续执行"}`,
      activeNodeId: resumableNode.node.id,
      activeNodeLabel: resumableNode.node.label,
      activeNodeStatus: resumableNode.state.status,
    });
  }

  if (instance.status === "failed") {
    const failedNode = findFirstSummaryNodeByStatus(nodeStates, "failed");
    return buildOrchestrationRunSummary(instance, {
      artifactCount,
      statusLabel: "失败",
      statusTone: "danger",
      progressDone: displayProgressDone,
      progressTotal,
      progressRatio,
      progressText,
      detailText: failedNode ? `${failedNode.node.label} · 执行失败` : "执行失败",
      activeNodeId: failedNode?.node.id ?? null,
      activeNodeLabel: failedNode?.node.label ?? null,
      activeNodeStatus: failedNode?.state.status ?? null,
    });
  }

  if (instance.status === "cancelled") {
    return buildOrchestrationRunSummary(instance, {
      artifactCount,
      statusLabel: "已取消",
      statusTone: "neutral",
      progressDone: displayProgressDone,
      progressTotal,
      progressRatio,
      progressText,
      detailText: "本次执行已取消",
    });
  }

  return buildOrchestrationRunSummary(instance, {
    artifactCount,
    statusLabel: "待开始",
    statusTone: "neutral",
    progressDone: displayProgressDone,
    progressTotal,
    progressRatio,
    progressText,
    detailText: "等待流程启动",
  });
}

type OrchestrationRunSummaryInput = Omit<OrchestrationRunSummary, "instanceId" | "artifactCount"> & {
  artifactCount: number;
};

function buildOrchestrationRunSummary(
  instance: OrchestrationInstance,
  input: Partial<OrchestrationRunSummaryInput> & Pick<OrchestrationRunSummaryInput, "artifactCount" | "statusLabel" | "statusTone" | "progressDone" | "progressTotal" | "progressRatio" | "progressText" | "detailText">,
): OrchestrationRunSummary {
  return {
    instanceId: instance.id,
    activeNodeId: input.activeNodeId ?? null,
    activeNodeLabel: input.activeNodeLabel ?? null,
    activeNodeStatus: input.activeNodeStatus ?? null,
    activeNodeAssigneeUserIds: input.activeNodeId ? resolveSummaryAssigneeUserIds(instance, input.activeNodeId) : [],
    waitingActionKind: input.waitingActionKind ?? null,
    artifactCount: input.artifactCount,
    statusLabel: input.statusLabel,
    statusTone: input.statusTone,
    progressDone: input.progressDone,
    progressTotal: input.progressTotal,
    progressRatio: input.progressRatio,
    progressText: input.progressText,
    detailText: input.detailText,
  };
}

/** 解析列表摘要可展示的当前处理人，避免前端重复理解协作/独立运行差异。 */
function resolveSummaryAssigneeUserIds(instance: OrchestrationInstance, activeNodeId: string): string[] {
  const assigneeUserIds = normalizeSummaryAssigneeUserIds(instance.nodeStates?.[activeNodeId]?.assigneeUserIds);
  if (assigneeUserIds.length) return assigneeUserIds;
  const initiatorUserId = String(instance.runtimeConfig?.initiatorUserId ?? "").trim();
  return initiatorUserId ? [initiatorUserId] : [];
}

/** 规范化摘要中的处理人 ID，避免列表层暴露重复或空值。 */
function normalizeSummaryAssigneeUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function normalizeSummaryPreviewText(raw: unknown, maxLength: number): string {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.max(1, Math.round(maxLength)) : 120;
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/** 判断错误是否属于当前 Agent 可以核对并重试的确定性编排合同问题。 */
export function isOrchestrationDeterministicRecoveryDiagnostic(value: unknown): boolean {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return false;
  const contractMarker = /WORK_ITEM_(?:TOOL_FAILED|NOT_FOUND|VERSION_CONFLICT|SEQUENCE_CONFLICT|OUT_OF_ORDER|IDENTITY_LOCKED|BOARD_NOT_FOUND|REWORK_SCOPE_MISMATCH|REWORK_CONFLICT)|runtime\.workItems\.|runtime\.submitNodeResult|(?:acceptanceCriteria|completionChecks|outputPath|sourceKey|expectedVersion|file\.key)|工作项(?:看板|工具)|验收条件/i;
  const escalationMarker = /请联系(?:系统)?管理员|后台(?:处理|修复|补齐|修正)/i;
  const failureMarker = /错误|失败|拒绝|非法|无效|缺少|不一致|冲突|无法|未通过|为空|校验|修复|补齐|修正|rejected|failed|invalid|conflict/i;
  return (contractMarker.test(text) || escalationMarker.test(text)) && failureMarker.test(text);
}

/** 将已知的编排内部诊断转换成用户能直接理解的短提示；原始诊断仍保留在运行态供排查。 */
export function resolveOrchestrationUserFacingMessage(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const defaultText = String(fallback ?? "").replace(/\s+/g, " ").trim() || "当前节点需要人工处理";
  if (!text) return defaultText;

  if (/WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED/i.test(text)) {
    return "系统正在整理当前节点的处理上下文，会继续使用原来的工作项和进度。你现在不用操作，已完成内容会保留。";
  }
  if (isOrchestrationDeterministicRecoveryDiagnostic(text)) {
    return "系统会先自动校对当前节点并重试。你现在不用操作，已完成内容会保留。";
  }
  if (
    /snapshot_verify_failed/i.test(text)
    || /本轮资料检查发现问题|需要先修复固定资料/.test(text)
    || (
      /冻结输入快照|完整冻结输入快照/i.test(text)
      && /manifest|source|sqliteDb|工作项|看板|文件集合/i.test(text)
    )
  ) {
    return "当前节点暂时读不到已保存资料。请不要重跑或新建流程，当前进度会保留。";
  }
  if (/definition\.scope/i.test(text) && /非法|无效|范围/i.test(text)) {
    return "当前节点暂时读不到知识库设置。请不要重跑或新建流程，当前进度会保留。";
  }

  // 只拦截已确认的内部字段标记，普通业务原因继续原样显示，避免过度防御。
  if (/(?:outputPath|sourceKey|acceptanceCriteria|sqliteDb|in_progress|runtime\.workItems\.)/i.test(text)) {
    return "当前节点的流程设置需要重新核对。请不要重跑或新建流程，当前进度会保留。";
  }
  return text;
}

function countSummaryArtifacts(index: Record<string, ArtifactId[]> | null | undefined): number {
  const ids = new Set<string>();
  for (const values of Object.values(index ?? {})) {
    for (const id of values ?? []) {
      const normalized = String(id ?? "").trim();
      if (normalized) ids.add(normalized);
    }
  }
  return ids.size;
}

function findFirstSummaryNodeByStatus(
  nodes: Array<{ node: WorkflowNode; state: NodeExecutionState }>,
  status: NodeExecutionStatus,
): { node: WorkflowNode; state: NodeExecutionState } | null {
  return nodes.find((entry) => entry.state.status === status) ?? null;
}

function isSummaryProgressNode(node: WorkflowNode): boolean {
  return node.type !== "start" && node.type !== "end";
}

function isSummaryCompletedProgressStatus(status: NodeExecutionStatus): boolean {
  return status === "completed" || status === "skipped";
}

function isSummaryRunningLikeStatus(status: NodeExecutionStatus): boolean {
  return status === "running"
    || status === "result-submitted"
    || status === "finalizing"
    || status === "artifact-writing"
    || status === "gate-checking";
}

function findSummaryResumableNode(
  nodes: Array<{ node: WorkflowNode; state: NodeExecutionState }>,
): { node: WorkflowNode; state: NodeExecutionState } | null {
  return nodes.find((entry) =>
    entry.state.status === "ready" || entry.state.status === "queued" || entry.state.status === "pending",
  ) ?? null;
}

type SummaryWorkbenchDescriptor = {
  attentionKind: OrchestrationWaitingActionKind | null;
  statusLabel: string;
  detailLabel: string | null;
};

/** 解析等待态节点在列表摘要中的状态文案和待处理类型。 */
function resolveSummaryWorkbenchDescriptor(state: NodeExecutionState): SummaryWorkbenchDescriptor {
  const hasReviewableResult = Boolean(
    state.conclusion
    || (state.outputArtifactIds?.length ?? 0) > 0
    || (state.gateResults?.length ?? 0) > 0
    || String(state.output ?? "").trim(),
  );
  const attentionKind = resolveSummaryAttentionKind(state, hasReviewableResult);
  if (state.status === "waiting-approval") {
    const awaitingRework = state.conclusion?.nextAction === "rework";
    return {
      attentionKind: "approval",
      statusLabel: awaitingRework ? "待确认退回" : "待审核",
      detailLabel: awaitingRework ? "建议退回，等待人工确认" : "等待人工审核",
    };
  }
  if (state.status === "waiting-start") {
    return {
      attentionKind: "start",
      statusLabel: "待启动",
      detailLabel: resolveOrchestrationUserFacingMessage(state.error, "等待人工启动"),
    };
  }
  if (state.status === "waiting-feedback") {
    switch (attentionKind) {
      case "human_input":
        return { attentionKind, statusLabel: "待补充", detailLabel: resolveSummaryHumanInputReason(state) };
      case "branch_decision":
        return { attentionKind, statusLabel: "待选分支", detailLabel: resolveSummaryBranchDecisionReason(state) };
      case "review_decision":
        return { attentionKind, statusLabel: "待决策", detailLabel: resolveSummaryReviewDecisionReason(state) };
      case "gate_failure":
        return { attentionKind, statusLabel: "门禁未过", detailLabel: resolveSummaryGateFailureReason(state) };
      case "execution_error": {
        const autoRecovery = isOrchestrationDeterministicRecoveryDiagnostic(
          state.conclusion?.humanInput?.summary ?? state.conclusion?.summary ?? state.error,
        );
        return {
          attentionKind,
          statusLabel: autoRecovery ? "系统处理中" : "异常中断",
          detailLabel: autoRecovery
            ? "系统会先自动校对当前节点并重试。你现在不用操作，已完成内容会保留。"
            : "会话异常中断",
        };
      }
      default:
        return { attentionKind: attentionKind ?? "feedback", statusLabel: "待处理", detailLabel: resolveSummaryGenericFeedbackReason(state) };
    }
  }
  return { attentionKind: null, statusLabel: summaryNodeStatusLabel(state.status), detailLabel: summaryNodeStatusLabel(state.status) };
}

/** 根据节点状态和人工来源推导列表层待处理动作类型。 */
function resolveSummaryAttentionKind(
  state: NodeExecutionState,
  hasReviewableResult: boolean,
): OrchestrationWaitingActionKind | null {
  const source = state.humanActionSource ?? null;
  if (state.status === "waiting-approval") return "approval";
  if (state.status === "waiting-start") return "start";
  if (state.status !== "waiting-feedback") return null;
  if ((state.conclusion?.nextAction === "ask_human" || state.conclusion?.nextAction === "stop")
    && isOrchestrationDeterministicRecoveryDiagnostic(
      state.conclusion?.humanInput?.summary ?? state.conclusion?.summary ?? state.error,
    )) {
    return "execution_error";
  }
  if (source === "branch_decision") return "branch_decision";
  if (source === "human_input") return "human_input";
  if (source === "review") return "review_decision";
  if (source === "gate") return "gate_failure";
  if (source === "execution") return hasReviewableResult ? "feedback" : "execution_error";
  if (state.conclusion?.nextAction === "ask_human") return "human_input";
  if (state.conclusion?.nextAction === "stop") return "review_decision";
  if ((state.gateResults?.length ?? 0) > 0) return "gate_failure";
  if (String(state.error ?? "").trim() && !hasReviewableResult) return "execution_error";
  return "feedback";
}

/** 提取人工补充原因并隐藏已识别的内部诊断。 */
function resolveSummaryHumanInputReason(state: NodeExecutionState): string {
  return resolveOrchestrationUserFacingMessage(
    state.conclusion?.humanInput?.summary
    ?? state.conclusion?.summary
    ?? state.error
    ?? "等待补充信息",
    "等待补充信息",
  );
}

/** 提取运行摘要里的人工分支等待原因，缺省使用稳定短文案。 */
function resolveSummaryBranchDecisionReason(state: NodeExecutionState): string {
  return resolveOrchestrationUserFacingMessage(
    state.error ?? state.conclusion?.summary,
    "等待人工选择分支",
  );
}

/** 提取人工决策原因并保持普通业务说明原样。 */
function resolveSummaryReviewDecisionReason(state: NodeExecutionState): string {
  return resolveOrchestrationUserFacingMessage(
    state.conclusion?.summary ?? state.error,
    "等待人工决策",
  );
}

/** 提取首条未通过门禁的说明并转换为用户提示。 */
function resolveSummaryGateFailureReason(state: NodeExecutionState): string {
  const failed = (state.gateResults ?? []).find((item) => !item.passed);
  return resolveOrchestrationUserFacingMessage(
    failed?.message ?? state.error,
    "未通过门禁检查",
  );
}

/** 提取通用反馈原因；空值使用稳定的默认提示。 */
function resolveSummaryGenericFeedbackReason(state: NodeExecutionState): string {
  return resolveOrchestrationUserFacingMessage(
    state.conclusion?.summary
    ?? state.error
    ?? "等待人工处理",
    "等待人工处理",
  );
}

function summaryNodeStatusLabel(status: NodeExecutionStatus | null | undefined): string {
  const map: Record<NodeExecutionStatus, string> = {
    pending: "等待",
    ready: "就绪",
    queued: "排队",
    running: "运行中",
    "result-submitted": "结果已提交",
    finalizing: "正在收尾",
    "artifact-writing": "写入结果",
    "gate-checking": "门禁检查",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核",
    "waiting-feedback": "等待反馈",
    completed: "已完成",
    failed: "失败",
    skipped: "跳过",
    cancelled: "已取消",
  };
  if (!status) return "等待";
  return map[status] ?? status;
}

export type OrchestrationEventRecord = {
  id: OrchestrationEventId;
  instanceId: OrchestrationId;
  nodeId?: string | null;
  type: string;
  payloadJson: string;
  createdAt: number;
};

// ── Asset Draft / AI-assisted Asset Authoring ───────────────────

export type AssetKind = "role" | "knowledge-bundle" | "toolset" | "skill";
export type AssetDraftMode = "create" | "revise";
export type AssetDraftStatus = "awaiting_review" | "applied" | "rejected";
export type AssetGenerationJobStatus =
  | "queued"
  | "planning"
  | "collecting_context"
  | "generating"
  | "validating"
  | "awaiting_input"
  | "awaiting_review"
  | "failed"
  | "cancelled"
  | "applied"
  | "rejected";

export type AssetGenerationProgress = {
  stage?: AssetGenerationJobStatus | null;
  headline: string;
  detail?: string | null;
  percent?: number | null;
};

export type AssetGenerationFailure = {
  code: string;
  stage: "planning" | "collecting_context" | "generating" | "parsing" | "validating" | "persisting";
  message: string;
  userHint?: string | null;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null> | null;
  engineMessage?: string | null;
};

export type AssetValidationIssue = {
  code: string;
  severity: "error" | "warning";
  fieldPath: string;
  message: string;
  suggestion?: string | null;
  source: "schema" | "reference" | "tooling" | "quality";
  blocking: boolean;
};

export type RoleDraftDefinition = Omit<RoleDefinition, "id" | "workspaceId" | "createdAt" | "updatedAt" | "kind"> & {
  defaultKnowledgeBundleIds: KnowledgeBundleId[];
  toolRefs: ToolRef[];
  kind: "custom";
};

export type RoleDraftPayload = {
  assetKind: "role";
  schemaVersion: "role-draft/v2";
  mode: AssetDraftMode;
  targetAssetId?: RoleId | null;
  baseVersionId?: AssetVersionId | null;
  draft: RoleDraftDefinition;
  rationale: {
    summary: string;
    keyDecisions: string[];
    assumptions?: string[] | null;
    risks?: string[] | null;
  };
  referenceSummary: {
    roleIds: RoleId[];
    knowledgeBundleIds: KnowledgeBundleId[];
    toolsetIds: ToolsetId[];
    selectedPaths: string[];
  };
};

export type SkillDraftDefinition = Omit<SkillDefinition, "id" | "workspaceId" | "createdAt" | "updatedAt" | "kind" | "packageHash"> & {
  kind: "custom";
  packageHash?: null;
};

export type SkillDraftPatchOperation =
  | { op: "set"; path: "name" | "slug" | "description" | "trigger" | "instructions" | "targetEngines" | "tags" | "installTargets" | "skillMd"; value: unknown }
  | { op: "unset"; path: "slug" | "tags" | "installTargets" | "skillMd" }
  | { op: "upsert-file"; file: SkillPackageFile }
  | { op: "delete-file"; relPath: string }
  | { op: "upsert-script"; script: SkillScriptEntrypoint; contentText?: string | null }
  | { op: "delete-script"; id?: string | null; scriptPath?: string | null };

export type SkillDraftPayload = {
  assetKind: "skill";
  schemaVersion: "skill-draft/v1";
  mode: AssetDraftMode;
  targetAssetId?: SkillId | null;
  baseVersionId?: AssetVersionId | null;
  draft: SkillDraftDefinition;
  patches?: SkillDraftPatchOperation[] | null;
  rationale: {
    summary: string;
    keyDecisions: string[];
    assumptions?: string[] | null;
    risks?: string[] | null;
  };
  referenceSummary: {
    skillIds: SkillId[];
    selectedPaths: string[];
  };
};

export type AssetDraftEngineInfo = {
  engine: "claude" | "codex";
  model?: string | null;
  effort?: string | null;
};

export type AssetGenerationInteractionReason =
  | "missing_user_input"
  | "clarification_required"
  | "approval_required"
  | "plan_mode_transition_required";

export type AssetGenerationInteractionRequest = {
  kind: "input" | "approval";
  reason: AssetGenerationInteractionReason;
  requestId?: number | string | null;
  header: string;
  prompt: string;
  requestedAt: number;
};

export type AssetDraft = {
  id: AssetDraftId;
  workspaceId: WorkspaceId;
  assetKind: AssetKind;
  mode: AssetDraftMode;
  status: AssetDraftStatus;
  targetAssetId?: string | null;
  baseVersionId?: AssetVersionId | null;
  sourceJobId: AssetGenerationJobId;
  prompt: string;
  payloadJson: string;
  validationIssues?: AssetValidationIssue[] | null;
  rationale?: string | null;
  engineInfo?: AssetDraftEngineInfo | null;
  createdAt: number;
  updatedAt: number;
};

export type AssetGenerationJob = {
  id: AssetGenerationJobId;
  workspaceId: WorkspaceId;
  assetKind: "role" | "skill";
  mode: AssetDraftMode;
  status: AssetGenerationJobStatus;
  targetAssetId?: string | null;
  clientRequestId?: string | null;
  baseVersionId?: AssetVersionId | null;
  draftId?: AssetDraftId | null;
  threadId?: ThreadId | null;
  prompt: string;
  requestJson?: string | null;
  interactionRequest?: AssetGenerationInteractionRequest | null;
  progress?: AssetGenerationProgress | null;
  failure?: AssetGenerationFailure | null;
  createdAt: number;
  updatedAt: number;
};

export type RoleAssetGenerationJob = AssetGenerationJob & {
  assetKind: "role";
  targetAssetId?: RoleId | null;
};

export type SkillAssetGenerationJob = AssetGenerationJob & {
  assetKind: "skill";
  targetAssetId?: SkillId | null;
};

export type AssetVersion = {
  id: AssetVersionId;
  workspaceId: WorkspaceId;
  assetKind: AssetKind;
  assetId: string;
  version: number;
  sourceDraftId?: AssetDraftId | null;
  snapshotJson: string;
  createdAt: number;
};

export type AssetJobEventType =
  | "orch.assetDraft.jobQueued"
  | "orch.assetDraft.statusChanged"
  | "orch.assetDraft.contextCollected"
  | "orch.assetDraft.engineInvoked"
  | "orch.assetDraft.parseCompleted"
  | "orch.assetDraft.validationCompleted"
  | "orch.assetDraft.draftCreated"
  | "orch.assetDraft.failed"
  | "orch.assetDraft.applied"
  | "orch.assetDraft.rejected";

export type AssetJobStatusChangedPayload = {
  from: AssetGenerationJobStatus | null;
  to: AssetGenerationJobStatus;
  headline: string;
  detail?: string | null;
  percent?: number | null;
};

export type AssetJobContextCollectedPayload = {
  selectedPathCount: number;
  includedFileCount: number;
  totalChars: number;
  truncated: boolean;
};

export type AssetJobEngineInvokedPayload = {
  engine: "claude" | "codex";
  model?: string | null;
  effort?: string | null;
  threadId?: ThreadId | null;
};

export type AssetJobValidationCompletedPayload = {
  errorCount: number;
  warningCount: number;
};

export type AssetJobFailedPayload = {
  code: string;
  stage: string;
  retryable: boolean;
  message: string;
};

export type AssetJobEventPayload =
  | AssetJobStatusChangedPayload
  | AssetJobContextCollectedPayload
  | AssetJobEngineInvokedPayload
  | AssetJobValidationCompletedPayload
  | AssetJobFailedPayload
  | { draftId: AssetDraftId }
  | { roleId: RoleId; versionId: AssetVersionId; draftId: AssetDraftId }
  | { skillId: SkillId; versionId: AssetVersionId; draftId: AssetDraftId }
  | { draftId: AssetDraftId; reason?: string | null };

export type AssetJobEventRecord = {
  id: AssetJobEventId;
  jobId: AssetGenerationJobId;
  type: AssetJobEventType;
  payloadJson: string;
  createdAt: number;
};

export type AssetJobEventView = {
  id: AssetJobEventId;
  jobId: AssetGenerationJobId;
  type: AssetJobEventType;
  payload: AssetJobEventPayload;
  createdAt: number;
};

export type RoleDraftDiffSectionKey = "basic" | "io" | "gates" | "knowledge" | "tools" | "config";

export type RoleDraftDiffItem = {
  path: string;
  label: string;
  valueType: "text" | "long-text" | "json" | "ref-list" | "enum" | "boolean";
  changeType: "added" | "removed" | "modified" | "unchanged";
  beforeValue?: unknown;
  afterValue?: unknown;
  beforeLabel?: string | null;
  afterLabel?: string | null;
  note?: string | null;
};

export type RoleDraftDiffSection = {
  key: RoleDraftDiffSectionKey;
  label: string;
  changeCount: number;
  items: RoleDraftDiffItem[];
};

export type RoleDraftComparison = {
  mode: AssetDraftMode;
  targetRoleId?: RoleId | null;
  baseVersionId?: AssetVersionId | null;
  hasChanges: boolean;
  summary: {
    added: number;
    removed: number;
    modified: number;
    warnings: number;
  };
  sections: RoleDraftDiffSection[];
};

export type SkillDraftDiffSectionKey = "overview" | "content" | "files" | "scripts" | "install";

export type SkillDraftDiffItem = RoleDraftDiffItem;

export type SkillDraftDiffSection = {
  key: SkillDraftDiffSectionKey;
  label: string;
  changeCount: number;
  items: SkillDraftDiffItem[];
};

export type SkillDraftComparison = {
  mode: AssetDraftMode;
  targetSkillId?: SkillId | null;
  baseVersionId?: AssetVersionId | null;
  hasChanges: boolean;
  summary: {
    added: number;
    removed: number;
    modified: number;
    warnings: number;
  };
  sections: SkillDraftDiffSection[];
};

// ── Feedback / Control ───────────────────────────────────────────

export type FeedbackAction =
  | "approve"
  | "retry"
  | "override"
  | "skip"
  | "abort"
  | "resume_with_input"
  | "choose_branch"
  | "cancel"
  | "rework_to_target"
  | "reevaluate_gates";
export type FeedbackRecordAction =
  | FeedbackAction
  | "manual_start_context"
  | "system_rework"
  | "system_rework_followup"
  | "system_human_input"
  | "system_approval_note"
  | "human_artifact_edit";

export function normalizeTaskAcceptanceCriteria(raw: unknown): TaskAcceptanceCriterion[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw
    .map((item, index) => normalizeSingleAcceptanceCriterion(item, index))
    .filter((item): item is TaskAcceptanceCriterion => Boolean(item));
  return items.length ? items : null;
}

export function createTaskAcceptanceCriteriaFromLines(lines: string[] | null | undefined): TaskAcceptanceCriterion[] | null {
  if (!Array.isArray(lines)) return null;
  return normalizeTaskAcceptanceCriteria(lines);
}

function normalizeSingleAcceptanceCriterion(raw: unknown, index: number): TaskAcceptanceCriterion | null {
  if (typeof raw === "string") {
    const text = normalizeAcceptanceCriterionText(raw);
    if (!text) return null;
    return {
      id: `ac_${index + 1}`,
      text,
      blocking: true,
    };
  }

  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<TaskAcceptanceCriterion> & { label?: string | null };
  const text = normalizeAcceptanceCriterionText(item.text ?? item.label ?? "");
  if (!text) return null;
  const id = String(item.id ?? "").trim() || `ac_${index + 1}`;
  return {
    id,
    text,
    blocking: item.blocking !== false,
  };
}

function normalizeAcceptanceCriterionText(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  const normalized = text.replace(/^[-*+\d.)\s]+/, "").trim();
  return normalized || text.trim();
}
