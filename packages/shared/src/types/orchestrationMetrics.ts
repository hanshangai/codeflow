import type { EngineCredentialSource, EngineModelProviderId } from "./engine.js";
import type { OrchestrationId, WorkspaceId } from "./ids.js";

export const ORCHESTRATION_METRIC_SCOPE_KINDS = [
  "mine",
  "shared_workspace",
  "enterprise",
  "super_admin_user",
  "super_admin_enterprise",
] as const;

export type OrchestrationMetricScopeKind = (typeof ORCHESTRATION_METRIC_SCOPE_KINDS)[number];

export const ORCHESTRATION_METRIC_STATUSES = [
  "pending",
  "running",
  "paused",
  "waiting-start",
  "waiting-approval",
  "waiting-feedback",
  "completed",
  "failed",
  "cancelled",
] as const;

export type OrchestrationMetricStatus = (typeof ORCHESTRATION_METRIC_STATUSES)[number];

export const ORCHESTRATION_METRIC_FRESHNESS_STATUSES = [
  "fresh",
  "stale",
  "offline",
  "error",
  "empty",
  "generating",
] as const;

export type OrchestrationMetricFreshnessStatus = (typeof ORCHESTRATION_METRIC_FRESHNESS_STATUSES)[number];

export const ORCHESTRATION_METRIC_QUALITY_EVENT_TYPES = [
  "failed",
  "interrupted",
  "retry",
  "rework",
  "review_rejected",
  "validation_failed",
  "evidence_missing",
  "ineffective_loop",
] as const;

export type OrchestrationMetricQualityEventType = (typeof ORCHESTRATION_METRIC_QUALITY_EVENT_TYPES)[number];

export type OrchestrationMetricValidationStatus = "passed" | "failed" | "partial" | "not_evaluated" | "unknown";
export const ORCHESTRATION_METRIC_CONTRACT_TYPES = ["gate", "artifact", "acceptance", "output_field", "runtime_evidence"] as const;
export type OrchestrationMetricContractType = (typeof ORCHESTRATION_METRIC_CONTRACT_TYPES)[number];
export const ORCHESTRATION_METRIC_CONTRACT_EVALUATION_STATUSES = ["passed", "failed", "not_evaluated", "missing_evidence"] as const;
export type OrchestrationMetricContractEvaluationStatus = (typeof ORCHESTRATION_METRIC_CONTRACT_EVALUATION_STATUSES)[number];
export const ORCHESTRATION_METRIC_CONFORMANCE_RESULTS = ["conformant", "legal_skip", "manual_override", "deviation", "not_evaluated"] as const;
export type OrchestrationMetricConformanceResult = (typeof ORCHESTRATION_METRIC_CONFORMANCE_RESULTS)[number];
export const ORCHESTRATION_METRIC_CONFORMANCE_DEVIATIONS = ["missing_required", "repeat_execution", "invalid_branch", "unexpected_execution"] as const;
export type OrchestrationMetricConformanceDeviation = (typeof ORCHESTRATION_METRIC_CONFORMANCE_DEVIATIONS)[number];

export const ORCHESTRATION_METRIC_SCHEMA_VERSION = 20;
export const ORCHESTRATION_METRIC_DEFINITION_VERSION = "2026-07-20.24";
export const ORCHESTRATION_METRIC_DELIVERY_DEFINITION_VERSION = "2026-07-18.delivery.1";
export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DEFINITION_VERSION = "2026-08-19.code-attribution.1";
export const ORCHESTRATION_METRIC_DESCRIPTIVE_DEFINITION_VERSION = "2026-08-28.descriptive.1";

export type OrchestrationMetricDefinition = {
  metricId: string;
  metricVersion: string;
  grain: "scope" | "instance" | "node" | "trace" | "context_compaction" | "agent_handoff" | "quality_event" | "state_segment" | "contract" | "delivery" | "code_attribution";
  numerator: string;
  denominator: string;
  eligibilityRule: string;
  timeBasis: string;
  requiredFacts: readonly string[];
  qualityRule: string;
  privacyRule: string;
  owner: string;
};

export const ORCHESTRATION_METRIC_DEFINITIONS = {
  observedVerifiedSuccessRate: {
    metricId: "orchestration.observed_verified_success_rate",
    metricVersion: ORCHESTRATION_METRIC_DESCRIPTIVE_DEFINITION_VERSION,
    grain: "instance",
    numerator: "验证通过且不存在阻断性质量事件的已覆盖终态实例数",
    denominator: "具备完整验证证据的可评价终态实例数",
    eligibilityRule: "实例已进入终态、不是用户取消，且具备完整验证证据",
    timeBasis: "实例完成时间",
    requiredFacts: ["instance", "validation", "quality_event"],
    qualityRule: "验证覆盖不完整时展示总体上下界；来源不完整时边界仅代表已记录终态，不生成严格总体结论",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  verifiedSuccessRate: {
    metricId: "orchestration.verified_success_rate",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "instance",
    numerator: "验证通过且不存在阻断性质量事件的已完成实例数",
    denominator: "排除用户取消后的终态实例数",
    eligibilityRule: "实例已进入终态，且终态不是用户取消",
    timeBasis: "实例完成时间",
    requiredFacts: ["instance", "validation", "quality_event"],
    qualityRule: "仅当验证覆盖完整时才输出可判定的主成功率",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  validationCoverageRate: {
    metricId: "orchestration.validation_coverage_rate",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "instance",
    numerator: "具备完整验证证据的可评价终态实例数",
    denominator: "排除用户取消后的终态实例数",
    eligibilityRule: "实例已进入终态，且终态不是用户取消",
    timeBasis: "实例完成时间",
    requiredFacts: ["instance", "validation", "quality_event"],
    qualityRule: "缺失验证证据的实例不计入已覆盖分子",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  firstPassRate: {
    metricId: "orchestration.first_pass_rate",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "instance",
    numerator: "验证成功且未发生重试、返工或评审驳回的实例数",
    denominator: "排除用户取消后的终态实例数",
    eligibilityRule: "实例已进入终态，且终态不是用户取消",
    timeBasis: "实例完成时间",
    requiredFacts: ["instance", "validation", "quality_event"],
    qualityRule: "仅当验证覆盖完整时才输出可判定的主成功率",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  observedFirstPassRate: {
    metricId: "orchestration.observed_first_pass_rate",
    metricVersion: ORCHESTRATION_METRIC_DESCRIPTIVE_DEFINITION_VERSION,
    grain: "instance",
    numerator: "验证成功且未发生重试、返工或评审驳回的已覆盖终态实例数",
    denominator: "具备完整验证证据的可评价终态实例数",
    eligibilityRule: "实例已进入终态、不是用户取消，且具备完整验证证据",
    timeBasis: "实例完成时间",
    requiredFacts: ["instance", "validation", "quality_event"],
    qualityRule: "验证覆盖不完整时展示总体上下界；来源不完整时边界仅代表已记录终态，不生成严格总体结论",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  observedContractPassRate: {
    metricId: "orchestration.observed_contract_pass_rate",
    metricVersion: ORCHESTRATION_METRIC_DESCRIPTIVE_DEFINITION_VERSION,
    grain: "contract",
    numerator: "评价通过的已评价必需契约数",
    denominator: "已完成评价的必需契约数",
    eligibilityRule: "契约为必需项，且评价状态为通过或失败",
    timeBasis: "契约评价时间",
    requiredFacts: ["contract_fact"],
    qualityRule: "契约覆盖不完整时展示已评价样本比例及已记录总体上下界，不生成严格总体结论",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  contractEvidenceCoverage: {
    metricId: "orchestration.contract_evidence_coverage",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "contract",
    numerator: "已完成证据评价的必需契约事实数",
    denominator: "全部必需契约事实数",
    eligibilityRule: "契约被标记为必需",
    timeBasis: "契约评价时间",
    requiredFacts: ["contract_fact"],
    qualityRule: "未采集到契约事实时指标不可判定",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  contractPassRate: {
    metricId: "orchestration.contract_pass_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "contract",
    numerator: "评价为通过的必需契约事实数", denominator: "全部必需契约事实数", eligibilityRule: "契约被标记为必需",
    timeBasis: "契约评价时间", requiredFacts: ["contract_fact"], qualityRule: "契约证据覆盖不完整时通过率不可判定",
    privacyRule: "受范围权限和最小分组样本数限制", owner: "orchestration",
  },
  gateCoverageRate: {
    metricId: "orchestration.gate_coverage_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "contract",
    numerator: "已评价的必需 Gate 契约数", denominator: "全部必需 Gate 契约数", eligibilityRule: "契约类型为 Gate 且标记为必需",
    timeBasis: "Gate 评价时间", requiredFacts: ["contract_fact"], qualityRule: "缺失 Gate 契约事实时不可判定",
    privacyRule: "受范围权限限制", owner: "orchestration",
  },
  artifactCoverageRate: {
    metricId: "orchestration.artifact_coverage_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "contract",
    numerator: "具备有效证据的必需 Artifact 契约数", denominator: "全部必需 Artifact 契约数", eligibilityRule: "契约类型为 Artifact 且标记为必需",
    timeBasis: "Artifact 评价时间", requiredFacts: ["contract_fact"], qualityRule: "草稿、已替代或缺失产物不计为覆盖",
    privacyRule: "只聚合非敏感契约状态，不集中保存产物正文", owner: "orchestration",
  },
  acceptanceCoverageRate: {
    metricId: "orchestration.acceptance_coverage_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "contract",
    numerator: "已评价的必需验收契约数", denominator: "全部必需验收契约数", eligibilityRule: "契约类型为 Acceptance 且标记为必需",
    timeBasis: "验收评价时间", requiredFacts: ["contract_fact"], qualityRule: "未评价验收项保留在分母",
    privacyRule: "受范围权限限制", owner: "orchestration",
  },
  runtimeEvidenceCoverageRate: {
    metricId: "orchestration.runtime_evidence_coverage_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "contract",
    numerator: "Prompt、Turn、conversation 与 raw trace 均完整的运行证据契约数", denominator: "全部必需运行证据契约数",
    eligibilityRule: "契约类型为 Runtime Evidence 且标记为必需", timeBasis: "Trace 完成时间", requiredFacts: ["contract_fact", "trace_fact"],
    qualityRule: "任一证据范围缺失时不计为覆盖", privacyRule: "Server 只保存引用和计数，不保存正文", owner: "orchestration",
  },
  conformanceRate: {
    metricId: "orchestration.conformance_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "node",
    numerator: "严格符合或合法跳过的节点事实数", denominator: "严格符合、合法跳过和流程偏离的已评价节点事实数",
    eligibilityRule: "节点符合性已完成评价，人工覆盖单独展示", timeBasis: "符合性观测时间", requiredFacts: ["conformance_fact"],
    qualityRule: "事实截断或工作流快照不一致时不可判定", privacyRule: "受范围权限限制", owner: "orchestration",
  },
  modelCallCount: {
    metricId: "orchestration.model_call_count", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "trace",
    numerator: "具有 current 来源 Token 更新事件的模型调用数", denominator: "不适用", eligibilityRule: "Trace 绑定唯一 Prompt Snapshot 与 Turn",
    timeBasis: "模型调用完成时间", requiredFacts: ["trace_fact"], qualityRule: "缺失 Turn 边界或 Token 事件时 Trace 标记不完整",
    privacyRule: "不集中保存 Prompt 与模型正文", owner: "orchestration",
  },
  tokenUsage: {
    metricId: "orchestration.token_usage", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "trace",
    numerator: "未命中缓存输入、命中缓存输入、输出、推理输出和总 Token", denominator: "不适用", eligibilityRule: "Trace 具有可信 Token 使用事件",
    timeBasis: "模型调用完成时间", requiredFacts: ["trace_fact"], qualityRule: "缺失 Token 事实时不使用零值代替",
    privacyRule: "只保存计数和调用归属", owner: "orchestration",
  },
  toolSuccessRate: {
    metricId: "orchestration.tool_success_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "trace",
    numerator: "成功完成的工具调用数", denominator: "具有明确完成终态的工具调用数", eligibilityRule: "工具开始与完成事件位于同一 Prompt Snapshot Turn",
    timeBasis: "工具完成事件时间", requiredFacts: ["trace_fact", "conversation_event"], qualityRule: "未闭合工具调用不进入分母并标记 Trace 不完整",
    privacyRule: "只保存调用计数和受限证据引用", owner: "orchestration",
  },
  contextCompactionCount: {
    metricId: "orchestration.context_compaction_count", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "context_compaction",
    numerator: "持久化上下文压缩事实数", denominator: "不适用", eligibilityRule: "Claude context.compacted 或 Codex compacted=true 事件可稳定归属到编排节点线程",
    timeBasis: "压缩事件时间", requiredFacts: ["context_compaction_fact", "conversation_event"], qualityRule: "不得从 Token 变化或文本内容猜测压缩",
    privacyRule: "只保存事件身份、归属和终态，不保存压缩摘要或会话正文", owner: "orchestration",
  },
  compactedTraceCount: {
    metricId: "orchestration.compacted_trace_count", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "context_compaction",
    numerator: "存在压缩事实关联的唯一 Prompt Snapshot 数", denominator: "不适用", eligibilityRule: "压缩后的首个明确结果 Turn 绑定本实例 Prompt Snapshot",
    timeBasis: "压缩事件时间", requiredFacts: ["context_compaction_fact", "trace_fact"], qualityRule: "无法绑定 Trace 时保留压缩事实但不反推 Trace",
    privacyRule: "只保存 Prompt Snapshot 引用，不保存 Prompt 正文", owner: "orchestration",
  },
  postCompactionSuccessRate: {
    metricId: "orchestration.post_compaction_success_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "context_compaction",
    numerator: "压缩后首个明确 Turn 正常完成的压缩事实数", denominator: "已观测到 completed 或 error 结果的压缩事实数",
    eligibilityRule: "压缩事实已观测到首个非压缩终态 Turn", timeBasis: "结果 Turn 完成时间", requiredFacts: ["context_compaction_fact", "conversation_event"],
    qualityRule: "没有已观测结果时返回 null；压缩动作自身的 completed 不得作为 Codex 压缩后结果", privacyRule: "只聚合终态，不保存回复正文", owner: "orchestration",
  },
  requiredArtifactAvailabilityRate: {
    metricId: "orchestration.required_artifact_availability_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "agent_handoff",
    numerator: "已解析到可消费 Artifact 或字段的必需输入引用数", denominator: "冻结 inputReferences 中的必需引用数",
    eligibilityRule: "role 节点 attempt 具有非空冻结 inputReferences", timeBasis: "节点输入解析或首个 Prompt Snapshot 时间",
    requiredFacts: ["agent_handoff_fact", "node_context_resolution"], qualityRule: "执行前阻断保留在分母；零分母返回 null",
    privacyRule: "只保存结构化身份、集合和错误码，不保存 Artifact 正文", owner: "orchestration",
  },
  requiredPromptInjectionRate: {
    metricId: "orchestration.required_prompt_injection_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "agent_handoff",
    numerator: "首个 Prompt Snapshot 明确冻结的必需引用数", denominator: "冻结 inputReferences 中的必需引用数",
    eligibilityRule: "role 节点 attempt 具有非空冻结 inputReferences", timeBasis: "节点输入解析或首个 Prompt Snapshot 时间",
    requiredFacts: ["agent_handoff_fact", "prompt_snapshot"], qualityRule: "没有 Prompt Snapshot 的阻断 attempt 分子为零且不从分母排除",
    privacyRule: "只保存 Prompt Snapshot 引用和输入身份，不保存 Prompt 正文", owner: "orchestration",
  },
  requiredFieldConsumptionRate: {
    metricId: "orchestration.required_field_consumption_rate", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "agent_handoff",
    numerator: "Prompt Snapshot 明确冻结来源 Artifact 与字段键的必需字段引用数", denominator: "冻结 inputReferences 中必需 field selector 数",
    eligibilityRule: "role 节点 attempt 具有必需 field selector", timeBasis: "首个 Prompt Snapshot 时间",
    requiredFacts: ["agent_handoff_fact", "prompt_snapshot", "artifact_field"], qualityRule: "没有必需字段引用时返回 null，不从自然语言 Prompt 猜测消费",
    privacyRule: "只保存字段引用身份，不保存字段值", owner: "orchestration",
  },
  ineffectiveLoopCount: {
    metricId: "orchestration.ineffective_loop_count", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "quality_event",
    numerator: "无进展证据时同一工具路径从第三次连续重复开始的次数", denominator: "不适用", eligibilityRule: "工具名、输入、终态和输出均相同",
    timeBasis: "重复工具完成时间", requiredFacts: ["trace_fact", "evaluation_fact", "quality_event"], qualityRule: "评估事实与节点质量事件计数必须守恒",
    privacyRule: "不保存工具输入输出正文", owner: "orchestration",
  },
  agentActiveDuration: {
    metricId: "orchestration.agent_active_duration", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "state_segment",
    numerator: "Agent 资源活动区间持续时间", denominator: "不适用", eligibilityRule: "状态区间类型为 agent_active",
    timeBasis: "资源活动事件时间", requiredFacts: ["state_segment"], qualityRule: "流动效率计算使用区间并集，不直接累加重叠时长",
    privacyRule: "受范围权限限制", owner: "orchestration",
  },
  toolActiveDuration: {
    metricId: "orchestration.tool_active_duration", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "state_segment",
    numerator: "已闭合工具调用区间持续时间", denominator: "不适用", eligibilityRule: "状态区间类型为 tool_active",
    timeBasis: "工具开始与完成事件时间", requiredFacts: ["state_segment", "conversation_event"], qualityRule: "缺少成对事件时不输出猜测时长",
    privacyRule: "受范围权限限制", owner: "orchestration",
  },
  humanWaitDuration: {
    metricId: "orchestration.human_wait_duration", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "state_segment",
    numerator: "等待审批与等待反馈周期区间持续时间", denominator: "不适用", eligibilityRule: "状态区间属于 waiting_approval 或 waiting_feedback",
    timeBasis: "周期状态事件时间", requiredFacts: ["state_segment"], qualityRule: "与资源活动重叠时按互斥分类优先级处理",
    privacyRule: "受范围权限限制", owner: "orchestration",
  },
  queueDuration: {
    metricId: "orchestration.queue_duration", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "state_segment",
    numerator: "排队周期区间持续时间", denominator: "不适用", eligibilityRule: "状态区间类型为 queue",
    timeBasis: "周期状态事件时间", requiredFacts: ["state_segment"], qualityRule: "状态通道冲突时不可输出确定结论",
    privacyRule: "受范围权限限制", owner: "orchestration",
  },
  pausedDuration: {
    metricId: "orchestration.paused_duration", metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION, grain: "state_segment",
    numerator: "实例暂停周期区间持续时间", denominator: "不适用", eligibilityRule: "状态区间类型为 paused",
    timeBasis: "暂停事件时间", requiredFacts: ["state_segment"], qualityRule: "暂停与资源活动重叠时标记一致性冲突",
    privacyRule: "受范围权限限制", owner: "orchestration",
  },
  flowEfficiency: {
    metricId: "orchestration.flow_efficiency",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "state_segment",
    numerator: "资源活动状态区间去重后的持续时间并集",
    denominator: "实例墙钟总时长",
    eligibilityRule: "实例墙钟时长大于零",
    timeBasis: "状态区间事件时间",
    requiredFacts: ["instance", "state_segment"],
    qualityRule: "重叠的资源活动只计算一次，冲突的周期状态必须报告",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  terminalActiveSamples: {
    metricId: "orchestration.terminal_and_active_sample_count",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "instance",
    numerator: "终态实例数与非终态样本数",
    denominator: "筛选范围内的全部实例数",
    eligibilityRule: "实例符合当前范围和筛选条件",
    timeBasis: "终态结果按完成时间归属，非终态样本按启动时间归属",
    requiredFacts: ["instance"],
    qualityRule: "非终态样本数不等同于基于历史区间重叠计算的在制品数量",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  periodEndWip: {
    metricId: "orchestration.period_end_wip",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "instance",
    numerator: "周期结束前已启动且截至该时点仍未进入终态的实例数",
    denominator: "不适用",
    eligibilityRule: "实例启动时间已知，且早于所选周期结束时点",
    timeBasis: "所选周期结束时点",
    requiredFacts: ["instance"],
    qualityRule: "潜在未结束实例缺少启动时间时，指标不可判定",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  deliveryCycleTime: {
    metricId: "orchestration.delivery_cycle_time",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "instance",
    numerator: "有效终态实例时长的中位数、第 75、第 90 和第 95 百分位数",
    denominator: "持续时间大于零的终态实例",
    eligibilityRule: "状态为完成、失败或取消，且持续时间大于零",
    timeBasis: "实例完成时间",
    requiredFacts: ["instance"],
    qualityRule: "没有符合条件的终态样本时，时长指标不可判定",
    privacyRule: "受范围权限和最小分组样本数限制",
    owner: "orchestration",
  },
  dataQualityState: {
    metricId: "orchestration.data_quality_state",
    metricVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    grain: "scope",
    numerator: "无单一分子（状态型指标）",
    denominator: "无单一分母；范围覆盖以当前授权来源为判断总体",
    eligibilityRule: "每次指标响应都按授权来源和已采集事实独立判断范围覆盖、必要证据、数据时效和事实一致性",
    timeBasis: "最近观测时间",
    requiredFacts: ["collection_coverage", "fact_validation"],
    qualityRule: "四个维度独立展示且不合并评分；范围未全量更新时，已采集证据完整也不能解释为整体数据完整",
    privacyRule: "受范围权限限制",
    owner: "orchestration",
  },
  deploymentFrequency: {
    metricId: "orchestration.delivery.deployment_frequency",
    metricVersion: ORCHESTRATION_METRIC_DELIVERY_DEFINITION_VERSION,
    grain: "delivery",
    numerator: "成功的生产环境部署次数",
    denominator: "所选周期的自然日数",
    eligibilityRule: "事实类型为部署、环境为生产、状态为成功，且外部批次已完成对账匹配",
    timeBasis: "交付事件发生时间",
    requiredFacts: ["delivery", "reconciliation"],
    qualityRule: "至少一个已匹配外部批次覆盖所选周期后，指标才可判定",
    privacyRule: "受范围权限限制，且不持久化外部原始载荷",
    owner: "delivery",
  },
  leadTimeForChanges: {
    metricId: "orchestration.delivery.lead_time_for_changes",
    metricVersion: ORCHESTRATION_METRIC_DELIVERY_DEFINITION_VERSION,
    grain: "delivery",
    numerator: "关联提交到成功生产部署之间的耗时",
    denominator: "已通过对账精确关联提交的成功生产部署",
    eligibilityRule: "匹配批次内的部署与提交具有相同代码库和提交哈希",
    timeBasis: "部署事件时间减去提交事件时间",
    requiredFacts: ["commit", "deployment", "reconciliation"],
    qualityRule: "未关联提交的部署仍保留展示，但不推测变更前置时间",
    privacyRule: "受范围权限限制",
    owner: "delivery",
  },
  changeFailureRate: {
    metricId: "orchestration.delivery.change_failure_rate",
    metricVersion: ORCHESTRATION_METRIC_DELIVERY_DEFINITION_VERSION,
    grain: "delivery",
    numerator: "失败或已关联回滚、恢复事件的生产部署数",
    denominator: "全部终态生产部署数",
    eligibilityRule: "部署身份和补救关联均明确且已完成对账",
    timeBasis: "部署事件发生时间",
    requiredFacts: ["deployment", "rollback", "recovery", "reconciliation"],
    qualityRule: "未完成对账的事实不能用于判定变更失败率",
    privacyRule: "受范围权限限制",
    owner: "delivery",
  },
  failedDeploymentRecoveryTime: {
    metricId: "orchestration.delivery.failed_deployment_recovery_time",
    metricVersion: ORCHESTRATION_METRIC_DELIVERY_DEFINITION_VERSION,
    grain: "delivery",
    numerator: "受影响部署到首次成功回滚或恢复之间的耗时",
    denominator: "具有明确补救关联的失败生产部署",
    eligibilityRule: "补救事件的关联外部 ID 指向受影响部署",
    timeBasis: "补救事件时间减去部署事件时间",
    requiredFacts: ["deployment", "rollback", "recovery", "reconciliation"],
    qualityRule: "未恢复故障计入故障数，但恢复时长保持不可判定",
    privacyRule: "受范围权限限制",
    owner: "delivery",
  },
  deploymentReworkRate: {
    metricId: "orchestration.delivery.deployment_rework_rate",
    metricVersion: ORCHESTRATION_METRIC_DELIVERY_DEFINITION_VERSION,
    grain: "delivery",
    numerator: "被外部来源明确标记为返工的成功生产部署数",
    denominator: "成功生产部署总数",
    eligibilityRule: "返工标记由外部交付数据源明确提供",
    timeBasis: "交付事件发生时间",
    requiredFacts: ["deployment", "reconciliation"],
    qualityRule: "缺少返工分类时，返工率不可判定",
    privacyRule: "受范围权限限制",
    owner: "delivery",
  },
  aiCodeContributionShare: {
    metricId: "orchestration.code_attribution.ai_contribution_share",
    metricVersion: ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DEFINITION_VERSION,
    grain: "code_attribution",
    numerator: "证据完整且最终进入提交的 AI 来源非空新增代码行数",
    denominator: "AI 轨迹与提交差异证据均完整的提交非空新增代码行数",
    eligibilityRule: "代码归因质量状态为 complete，且提交新增行数大于零",
    timeBasis: "提交时间",
    requiredFacts: ["code_attribution_fact", "commit"],
    qualityRule: "缺少 AI 轨迹、提交差异或实例关联时标记未覆盖，不得计为人工代码",
    privacyRule: "Server 只保存计数、哈希和受限证据引用，不保存源码正文",
    owner: "delivery",
  },
  aiOutputAdoptionRate: {
    metricId: "orchestration.code_attribution.ai_output_adoption_rate",
    metricVersion: ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DEFINITION_VERSION,
    grain: "code_attribution",
    numerator: "证据完整且最终进入提交的 AI 来源非空新增代码行数",
    denominator: "同一归因范围内 AI 生成的非空新增代码行数",
    eligibilityRule: "代码归因质量状态为 complete，且 AI 生成新增行数大于零",
    timeBasis: "AI 生成事件与提交时间",
    requiredFacts: ["code_attribution_fact", "trace_fact", "commit"],
    qualityRule: "候选行必须来自 AI 生成证据，比例按汇总分子分母计算",
    privacyRule: "Server 不保存 AI 输出正文，只保存脱敏行数与证据哈希",
    owner: "delivery",
  },
  aiCodeRetentionRate: {
    metricId: "orchestration.code_attribution.ai_code_retention_rate",
    metricVersion: ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DEFINITION_VERSION,
    grain: "code_attribution",
    numerator: "观察时间点经 Git 行来源仍归属于目标 commit 的已采纳 AI 非空代码行数",
    denominator: "提交时已采纳的 AI 来源非空新增代码行数",
    eligibilityRule: "7 天或 30 天观察窗口已结束且留存证据完整",
    timeBasis: "提交后 7 天或 30 天观察点",
    requiredFacts: ["code_attribution_fact", "retention_observation"],
    qualityRule: "观察窗口未到或观察证据缺失时返回 null，不使用零值代替",
    privacyRule: "仅保存留存计数、观察证据哈希和脱敏文件身份，不保存文件路径或正文",
    owner: "delivery",
  },
  codeAttributionCollectionCoverage: {
    metricId: "orchestration.code_attribution.collection_coverage",
    metricVersion: ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DEFINITION_VERSION,
    grain: "code_attribution",
    numerator: "AI 轨迹、提交差异和实例关联均完整的提交非空新增代码行数",
    denominator: "所选范围内符合统计资格的提交非空新增代码行数",
    eligibilityRule: "提交事实位于授权范围且未因二进制、生成文件或历史取代被排除",
    timeBasis: "提交时间",
    requiredFacts: ["code_attribution_fact", "commit", "reconciliation"],
    qualityRule: "未安装 Hook、不支持工具和单侧证据缺失均降低覆盖率，不得归类为人工",
    privacyRule: "群体聚合继承编排度量统一隐私抑制",
    owner: "delivery",
  },
} as const satisfies Record<string, OrchestrationMetricDefinition>;

export type OrchestrationMetricScopeDescriptor = {
  scopeKind: OrchestrationMetricScopeKind;
  scopeId?: string | null;
  label?: string | null;
};

export type OrchestrationMetricScopeOption = OrchestrationMetricScopeDescriptor & {
  description?: string | null;
  isDefault?: boolean;
  requiresSelection?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
};

export const ORCHESTRATION_METRIC_EXPERIMENT_COMPARABILITIES = ["all", "comparable", "incomparable"] as const;
export type OrchestrationMetricExperimentComparability = (typeof ORCHESTRATION_METRIC_EXPERIMENT_COMPARABILITIES)[number];

export type OrchestrationMetricFilters = {
  scopeKind?: OrchestrationMetricScopeKind;
  scopeId?: string | null;
  from?: number | null;
  to?: number | null;
  workflowIds?: string[] | null;
  workflowSnapshotHashes?: string[] | null;
  statuses?: OrchestrationMetricStatus[] | null;
  page?: number | null;
  pageSize?: number | null;
  cursor?: string | null;
  limit?: number | null;
  compareMode?: OrchestrationMetricCompareMode;
  compareFrom?: number | null;
  compareTo?: number | null;
  nodeIds?: string[] | null;
  roleStages?: string[] | null;
  qualityEventTypes?: OrchestrationMetricQualityEventType[] | null;
  contractTypes?: OrchestrationMetricContractType[] | null;
  contractEvaluationStatuses?: OrchestrationMetricContractEvaluationStatus[] | null;
  conformanceResults?: OrchestrationMetricConformanceResult[] | null;
  conformanceDeviations?: OrchestrationMetricConformanceDeviation[] | null;
  engines?: string[] | null;
  models?: string[] | null;
  costDimension?: OrchestrationMetricCostDimension | null;
  codeAttributionDimension?: OrchestrationMetricCodeAttributionDimension | null;
  repositories?: string[] | null;
  languages?: string[] | null;
  codeAttributionQualityStatuses?: OrchestrationMetricCodeAttributionQualityStatus[] | null;
  codeAttributionReconciliationStatuses?: OrchestrationMetricCodeAttributionReconciliationStatus[] | null;
  evaluationCriteria?: OrchestrationMetricEvaluationCriterion[] | null;
  experimentComparability?: OrchestrationMetricExperimentComparability | null;
  experimentCohortKey?: string | null;
  dimension?: OrchestrationMetricDimension;
  timezone?: string | null;
};

export type OrchestrationMetricCompareMode = "none" | "previous_period" | "previous_year" | "custom";
export type OrchestrationMetricDimension = "time" | "workflow" | "node" | "role_stage" | "status" | "quality_event";
export type OrchestrationMetricBucketUnit = "day" | "week" | "month";
export const ORCHESTRATION_METRIC_BOTTLENECK_SIGNALS = ["duration", "rework", "failure", "validation_failure", "composite"] as const;
export type OrchestrationMetricBottleneckSignal = (typeof ORCHESTRATION_METRIC_BOTTLENECK_SIGNALS)[number];
export const ORCHESTRATION_METRIC_BOTTLENECK_COMPONENT_SIGNALS = [
  "active_duration",
  "wait_duration",
  "first_pass_rate",
  "rework_rate",
  "review_rejection_rate",
  "gate_validation_failure_rate",
] as const;
export type OrchestrationMetricBottleneckComponentSignal = (typeof ORCHESTRATION_METRIC_BOTTLENECK_COMPONENT_SIGNALS)[number];
export type OrchestrationMetricBottleneckComponentStatus = "available" | "insufficient_samples" | "missing_facts";
export type OrchestrationMetricBottleneckRankingStatus = "ranked" | "insufficient_samples" | "incomplete_signals" | "version_unavailable" | "privacy_suppressed";
export const ORCHESTRATION_METRIC_CORRELATION_METRICS = ["duration", "rework", "review_rejection", "validation_failure"] as const;
export type OrchestrationMetricCorrelationMetric = (typeof ORCHESTRATION_METRIC_CORRELATION_METRICS)[number];
export const ORCHESTRATION_METRIC_CORRELATION_EXCLUSION_REASONS = [
  "missing_duration",
  "non_positive_duration",
  "indeterminate_validation",
  "invalid_metric_value",
] as const;
export type OrchestrationMetricCorrelationExclusionReason = (typeof ORCHESTRATION_METRIC_CORRELATION_EXCLUSION_REASONS)[number];
export type OrchestrationMetricCorrelationCalculationStatus = "available" | "insufficient_samples" | "zero_variance" | "privacy_suppressed";
export type OrchestrationMetricPartialReason = "instance_limit" | "node_limit" | "quality_event_limit" | "contract_fact_limit" | "conformance_fact_limit" | "state_segment_limit" | "missing_duration" | "missing_timestamp" | "missing_validation" | "missing_raw_trace" | "invalid_payload" | "collection_failed" | "collection_truncated" | "offline_source" | "small_sample" | "state_segment_conflict";

export const ORCHESTRATION_METRIC_STATE_SEGMENT_TYPES = [
  "queue",
  "agent_active",
  "tool_active",
  "waiting_start",
  "waiting_approval",
  "waiting_feedback",
  "paused",
  "artifact_writing",
  "gate_checking",
] as const;

export type OrchestrationMetricStateSegmentType = (typeof ORCHESTRATION_METRIC_STATE_SEGMENT_TYPES)[number];
export type OrchestrationMetricStateSegmentClass = "cycle_state" | "resource_activity";

export type OrchestrationMetricDataQuality = {
  coverage: "complete" | "partial" | "unavailable";
  completeness: "complete" | "partial" | "error";
  freshness: OrchestrationMetricFreshnessStatus;
  consistency: "valid" | "conflicted" | "error";
  reasons: OrchestrationMetricPartialReason[];
};

export type OrchestrationMetricPrivacy = {
  status: "visible" | "suppressed";
  policy: "single_user_exempt" | "shared_workspace_exempt" | "minimum_distinct_users" | "unrestricted";
  reason: null | "below_minimum" | "threshold_unproven";
  minDistinctUsers: 0 | 5;
  detailsAllowed: boolean;
};

export type OrchestrationMetricStatisticsReason =
  | "incomplete_validation"
  | "insufficient_samples"
  | "incomplete_evidence"
  | "zero_variance"
  | "incomparable_periods"
  | "partial_facts";

export type OrchestrationMetricStatistics = {
  status: "available" | "indeterminate";
  reasons: OrchestrationMetricStatisticsReason[];
};

export type OrchestrationMetricDefinitionComparison = {
  legacyDefinitionVersion: "legacy";
  currentDefinitionVersion: string;
  legacySuccessRate: number | null;
  currentSuccessRate: number | null;
  delta: number | null;
  comparable: boolean;
  sampleCount: number;
};

export type OrchestrationMetricAnalysisMetadata = {
  generatedAt: number;
  metricSchemaVersion: number;
  metricDefinitionVersion: string;
  eventTimeWatermark: number | null;
  observedAt: number | null;
  bucketUnit: OrchestrationMetricBucketUnit;
  sampleCount: number;
  partial: boolean;
  partialReasons: OrchestrationMetricPartialReason[];
  coverage: OrchestrationMetricCoverage;
  dataQuality: OrchestrationMetricDataQuality;
  statistics: OrchestrationMetricStatistics;
  privacy: OrchestrationMetricPrivacy;
  thresholds: { bottleneckMinSamples: 5; correlationMinSamples: 20; privacyMinGroupSize: 0 };
};

export type OrchestrationMetricComparison = {
  mode: OrchestrationMetricCompareMode;
  current: { from: number | null; to: number | null };
  comparison: { from: number | null; to: number | null } | null;
};

export type OrchestrationMetricAnalysisBucket = {
  key: string;
  label: string;
  sampleCount: number;
  current: OrchestrationMetricSummaryCards;
  comparison: OrchestrationMetricSummaryCards | null;
  delta: { totalTasks: number | null; successRate: number | null; avgDurationMs: number | null };
  privacy?: OrchestrationMetricPrivacy;
  comparisonPrivacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricAnalysisResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  filters: OrchestrationMetricFilters;
  comparison: OrchestrationMetricComparison;
  cards: OrchestrationMetricSummaryCards;
  comparisonCards: OrchestrationMetricSummaryCards | null;
  series: OrchestrationMetricAnalysisBucket[];
  breakdowns: OrchestrationMetricAnalysisBucket[];
  metadata: OrchestrationMetricAnalysisMetadata;
};

export type OrchestrationMetricBottleneckItem = {
  key: string;
  workflowSnapshotHash: string;
  nodeId: string;
  label: string;
  sampleCount: number;
  current: number | null;
  baseline: number | null;
  deviation: number | null;
  score: number | null;
  rank: number | null;
  rankingStatus: OrchestrationMetricBottleneckRankingStatus;
  signals: Partial<Record<OrchestrationMetricBottleneckSignal, number>>;
  components: Record<OrchestrationMetricBottleneckComponentSignal, {
    value: number | null;
    baseline: number | null;
    riskScore: number | null;
    weight: number;
    sampleCount: number;
    status: OrchestrationMetricBottleneckComponentStatus;
  }>;
  workflowId?: string | null;
  privacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricBottleneckResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  selectedSignal: OrchestrationMetricBottleneckSignal;
  items: OrchestrationMetricBottleneckItem[];
  total: number;
  page: number;
  pageSize: number;
  metadata: OrchestrationMetricAnalysisMetadata;
};

export type OrchestrationMetricCorrelationPoint = {
  key: string;
  instanceId: string;
  x: number;
  y: number;
  workflowName: string;
};

export type OrchestrationMetricCorrelationSampleStats = {
  totalSampleCount: number;
  validSampleCount: number | null;
  excludedSampleCount: number | null;
  exclusionCounts: Record<OrchestrationMetricCorrelationExclusionReason, number | null>;
};

export type OrchestrationMetricCorrelationResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  xMetric: OrchestrationMetricCorrelationMetric;
  yMetric: OrchestrationMetricCorrelationMetric;
  points: OrchestrationMetricCorrelationPoint[];
  sampleStats: OrchestrationMetricCorrelationSampleStats;
  calculationStatus: OrchestrationMetricCorrelationCalculationStatus;
  pearson: number | null;
  spearman: number | null;
  warning: string | null;
  metadata: OrchestrationMetricAnalysisMetadata;
};

export type OrchestrationMetricNodeDetailItem = {
  instance: OrchestrationMetricDetailItem;
  workflowSnapshotHash: string;
  nodeId: string;
  nodeExecutionId: string;
  attemptNo: number;
  parentExecutionId?: string | null;
  nodeLabel: string;
  nodeType?: string | null;
  roleStageId?: string | null;
  roleStageName?: string | null;
  status: string;
  durationMs?: number | null;
  qualityFlags: OrchestrationMetricQualityEventType[];
  routeTarget?: OrchestrationMetricRouteTarget | null;
};

export type OrchestrationMetricNodeDetailsResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  items: OrchestrationMetricNodeDetailItem[];
  total: number;
  page: number;
  pageSize: number;
  metadata: OrchestrationMetricAnalysisMetadata;
};

export type OrchestrationMetricContractDetailItem = {
  instance: OrchestrationMetricDetailItem;
  nodeId?: string | null;
  nodeExecutionId?: string | null;
  workflowSnapshotHash: string;
  contractType: OrchestrationMetricContractType;
  contractKey: string;
  contractVersion: string;
  required: boolean;
  evaluationStatus: OrchestrationMetricContractEvaluationStatus;
  passed?: boolean | null;
  evidenceRef?: string | null;
  evaluatorId: string;
  evaluatorVersion: string;
  evaluatedAt?: number | null;
  factRevision: number;
  routeTarget?: OrchestrationMetricRouteTarget | null;
};

export type OrchestrationMetricContractDetailsResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  items: OrchestrationMetricContractDetailItem[];
  total: number;
  page: number;
  pageSize: number;
  metadata: OrchestrationMetricAnalysisMetadata;
};

export type OrchestrationMetricFlowBreakdownItem = {
  segmentType: OrchestrationMetricStateSegmentType | "unclassified";
  label: string;
  sampleCount: number;
  durationMs: number | null;
  ratio: number | null;
  privacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricFlowInstanceItem = {
  instanceId: string;
  workflowName: string;
  titleSummary: string;
  wallClockDurationMs: number;
  activeDurationMs: number;
  humanWaitDurationMs: number;
  queueDurationMs: number;
  pausedDurationMs: number;
  unclassifiedDurationMs: number;
  flowEfficiency: number | null;
  actualPath: Array<{
    nodeId: string;
    nodeLabel: string;
    nodeExecutionId: string;
    attemptNo: number;
    status: string;
    occurredAt: number | null;
  }>;
  reworkLoops: Array<{
    nodeId: string;
    nodeLabel: string;
    executionCount: number;
    maxAttemptNo: number;
  }>;
  routeTarget: OrchestrationMetricRouteTarget;
};

/** Describes one eligible duration sample set with the shared nearest-rank contract. */
export type OrchestrationMetricDurationDistribution = {
  sampleCount: number;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p75DurationMs: number | null;
  p90DurationMs: number | null;
  p95DurationMs: number | null;
};

export type OrchestrationMetricFlowResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  totals: {
    sampleCount: number;
    wallClockDurationMs: number | null;
    activeDurationMs: number | null;
    humanWaitDurationMs: number | null;
    queueDurationMs: number | null;
    pausedDurationMs: number | null;
    unclassifiedDurationMs: number | null;
    flowEfficiency: number | null;
  };
  durationDistributions: {
    wallClock: OrchestrationMetricDurationDistribution;
    active: OrchestrationMetricDurationDistribution;
    humanWait: OrchestrationMetricDurationDistribution;
    queue: OrchestrationMetricDurationDistribution;
    paused: OrchestrationMetricDurationDistribution;
    unclassified: OrchestrationMetricDurationDistribution;
  };
  breakdown: OrchestrationMetricFlowBreakdownItem[];
  items: OrchestrationMetricFlowInstanceItem[];
  total: number;
  page: number;
  pageSize: number;
  metadata: OrchestrationMetricAnalysisMetadata;
};

export type OrchestrationMetricConformanceDetailItem = {
  instance: OrchestrationMetricDetailItem;
  workflowSnapshotHash: string;
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  observedStatus: string;
  result: OrchestrationMetricConformanceResult;
  deviationType?: OrchestrationMetricConformanceDeviation | null;
  executionCount: number;
  branchSourceNodeId?: string | null;
  branchTaken?: string | null;
  evidenceRef: string;
  factRevision: number;
  routeTarget: OrchestrationMetricRouteTarget;
};

export type OrchestrationMetricConformanceResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  totals: {
    evaluatedNodeCount: number | null;
    conformantNodeCount: number | null;
    legalSkipCount: number | null;
    manualOverrideCount: number | null;
    deviationCount: number | null;
    conformanceRate: number | null;
  };
  items: OrchestrationMetricConformanceDetailItem[];
  total: number;
  page: number;
  pageSize: number;
  metadata: OrchestrationMetricAnalysisMetadata;
};

export type OrchestrationMetricExportDataset = "summary" | "instances" | "nodes" | "costs" | "audit_bundle";
export type OrchestrationMetricExportFormat = "csv" | "json";
export type OrchestrationMetricExportStatus = "queued" | "running" | "succeeded" | "failed" | "expired" | "cancelled";

export type OrchestrationMetricExportJob = {
  id: string;
  dataset: OrchestrationMetricExportDataset;
  format: OrchestrationMetricExportFormat;
  status: OrchestrationMetricExportStatus;
  rowCount: number;
  contentSha256: string;
  errorCode: string;
  errorMessage: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  expiresAt: number;
  downloadUrl: string | null;
};

export type OrchestrationMetricExportCreateRequest = {
  filters: OrchestrationMetricFilters;
  dataset: OrchestrationMetricExportDataset;
  idempotencyKey: string;
};

export type OrchestrationMetricWorkflowOption = {
  workflowId: string;
  workflowName: string;
  count: number | null;
};

export type OrchestrationMetricFilterOption = {
  value: string;
  label: string;
  count: number | null;
};

export type OrchestrationMetricStatusOption = {
  status: OrchestrationMetricStatus;
  label: string;
  count: number | null;
};

export type OrchestrationMetricFreshness = {
  status: OrchestrationMetricFreshnessStatus;
  generatedAt?: number | null;
  refreshedAt?: number | null;
  nextRefreshAvailableAt?: number | null;
  message?: string | null;
  source?: "server_snapshot" | "client_collect" | "fallback_snapshot";
};

export type OrchestrationMetricCoverage = {
  sourceCount: number;
  /** 当前刷新时存在可路由 Client 的来源数；旧快照可能缺失。 */
  connectedSourceCount?: number;
  /** 至少成功返回一页事实的来源数；旧快照可能缺失。 */
  responsiveSourceCount?: number;
  /** 完成全部分页和成功水位确认的来源数；旧快照可能缺失。 */
  successfulSourceCount?: number;
  /** 在线但本次未完整采集的来源数；旧快照可能缺失。 */
  collectionFailedSourceCount?: number;
  /** 兼容字段；新快照与 connectedSourceCount 含义一致。 */
  onlineSourceCount: number;
  offlineSourceCount: number;
  instanceCount: number;
  missingStartedAtCount: number;
  missingCompletedAtCount: number;
  missingValidationCount: number;
  missingRawTraceCount: number;
  invalidPayloadCount: number;
  truncatedSourceCount: number;
  latestSourceUpdatedAt?: number | null;
  collectedAt?: number | null;
};

export type OrchestrationMetricRateEnvelope = {
  metricId: string;
  metricVersion: string;
  status: "complete" | "partial" | "unavailable";
  populationStatus: "authorized_scope" | "recorded_facts";
  numerator: number;
  observedDenominator: number;
  eligibleDenominator: number;
  missingCount: number;
  observedRate: number | null;
  lowerBound: number | null;
  upperBound: number | null;
};

export type OrchestrationMetricSummaryCards = {
  totalTasks: number;
  completedTasks: number | null;
  completionRate: number | null;
  eligibleTasks: number | null;
  validationCoveredTasks: number | null;
  validationCoverageRate: number | null;
  successfulTasks: number | null;
  successRate: number | null;
  /** 描述性结果；严格 successRate 继续只在完整覆盖时输出。 */
  observedSuccess?: OrchestrationMetricRateEnvelope | null;
  failedOrInterruptedTasks: number | null;
  reworkOrRejectedCount: number | null;
  durationSampleCount: number;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p75DurationMs: number | null;
  p90DurationMs: number | null;
  p95DurationMs: number | null;
  /** 严格按查询周期结束时点计算；旧版服务响应可能缺失。 */
  periodEndWipTasks?: number | null;
  /** 因缺少 startedAt 无法归类的期末 WIP 候选数。 */
  periodEndWipUnresolvedTasks?: number | null;
  /** 不晚于最近事实观测时间的实际 WIP 计算时点。 */
  periodEndAt?: number | null;
  /** 严格 WIP 的可用状态；旧版服务响应可能缺失。 */
  periodEndWipStatus?: "available" | "missing_started_at" | "missing_observation" | "observation_before_range" | "partial_coverage";
};

export type OrchestrationMetricTrendBucket = {
  bucketStart: number;
  bucketEnd: number;
  totalTasks: number;
  completedTasks: number | null;
  eligibleTasks: number | null;
  validationCoveredTasks: number | null;
  successfulTasks: number | null;
  successRate: number | null;
  failedOrInterruptedTasks: number | null;
  durationSampleCount: number;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p75DurationMs: number | null;
  p90DurationMs: number | null;
  p95DurationMs: number | null;
  privacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricNodeDurationBucket = {
  nodeId: string;
  nodeLabel: string;
  nodeType?: string | null;
  sampleCount: number;
  durationSampleCount: number;
  failureCount: number | null;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p75DurationMs: number | null;
  p90DurationMs: number | null;
  p95DurationMs: number | null;
  privacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricRoleStageBucket = {
  roleStageId: string;
  roleStageName: string;
  sampleCount: number;
  durationSampleCount: number;
  instanceCount: number;
  failureCount: number | null;
  retryCount: number | null;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p75DurationMs: number | null;
  p90DurationMs: number | null;
  p95DurationMs: number | null;
  privacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricQualityEventBucket = {
  eventType: OrchestrationMetricQualityEventType;
  label: string;
  sampleCount?: number;
  count: number | null;
  privacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricValidationOverview = {
  sampleCount?: number;
  checkedCount: number | null;
  passedCount: number | null;
  failedCount: number | null;
  notEvaluatedCount: number | null;
  passRate: number | null;
  coverageRate: number | null;
};

export type OrchestrationMetricSpecificationOverview = {
  eligibleTasks: number | null;
  validationCoveredTasks: number | null;
  successfulTasks: number | null;
  firstPassTasks: number | null;
  validationCoverageRate: number | null;
  successRate: number | null;
  firstPassRate: number | null;
  /** 描述性结果；严格 firstPassRate 继续只在完整覆盖时输出。 */
  observedFirstPass?: OrchestrationMetricRateEnvelope | null;
  retryAffectedTasks: number | null;
  reworkAffectedTasks: number | null;
  rejectionAffectedTasks: number | null;
  contractFacts?: number | null;
  requiredContractFacts?: number | null;
  evaluatedContractFacts?: number | null;
  passedContractFacts?: number | null;
  contractEvidenceCoverageRate?: number | null;
  contractPassRate?: number | null;
  observedContractPass?: OrchestrationMetricRateEnvelope | null;
};

export type OrchestrationMetricSpecificationTrendBucket = {
  bucketStart: number;
  bucketEnd: number;
  sampleCount?: number;
  privacy?: OrchestrationMetricPrivacy;
  categories: Array<{
    category: "gate" | "artifact" | "acceptance" | "runtime_evidence";
    requiredCount: number | null;
    evaluatedCount: number | null;
    passedCount: number | null;
    coverageRate: number | null;
    passRate: number | null;
  }>;
};

export type OrchestrationMetricSummary = {
  metricSchemaVersion: number;
  metricDefinitionVersion: string;
  scope: OrchestrationMetricScopeDescriptor;
  filters: OrchestrationMetricFilters;
  eventTimeWatermark: number | null;
  observedAt: number | null;
  bucketUnit: OrchestrationMetricBucketUnit;
  cards: OrchestrationMetricSummaryCards;
  trend: OrchestrationMetricTrendBucket[];
  nodeDurations: OrchestrationMetricNodeDurationBucket[];
  /** schema 9 起按冻结角色身份聚合；旧版响应可能缺失。 */
  roleStages?: OrchestrationMetricRoleStageBucket[] | null;
  qualityEvents: OrchestrationMetricQualityEventBucket[];
  validation: OrchestrationMetricValidationOverview;
  /** 新服务提供的结果规格质量汇总；旧版响应可能缺失。 */
  specification?: OrchestrationMetricSpecificationOverview | null;
  specificationTrend: OrchestrationMetricSpecificationTrendBucket[];
  workflowOptions: OrchestrationMetricWorkflowOption[];
  workflowSnapshotOptions: OrchestrationMetricFilterOption[];
  roleStageOptions: OrchestrationMetricFilterOption[];
  modelOptions: OrchestrationMetricFilterOption[];
  statusOptions: OrchestrationMetricStatusOption[];
  freshness: OrchestrationMetricFreshness;
  coverage: OrchestrationMetricCoverage;
  dataQuality: OrchestrationMetricDataQuality;
  statistics: OrchestrationMetricStatistics;
  privacy: OrchestrationMetricPrivacy;
  definitionComparison: OrchestrationMetricDefinitionComparison;
};

export type OrchestrationMetricRouteTarget = {
  workspaceId: string;
  intakeId?: string | null;
  instanceId: string;
  nodeId?: string | null;
  sharedWorkspaceId?: string | null;
};

export type OrchestrationMetricDetailItem = {
  sourceUserId?: string | null;
  sourceEnterpriseId?: string | null;
  instanceId: string;
  workspaceId: string;
  workflowId: string;
  workflowName: string;
  titleSummary: string;
  status: OrchestrationMetricStatus;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  nodeCount: number;
  retryCount: number;
  reworkCount: number;
  rejectionCount: number;
  validationStatus: OrchestrationMetricValidationStatus;
  validationCheckedCount: number;
  validationPassedCount: number;
  qualityEventCount: number;
  updatedAt: number;
  routeTarget?: OrchestrationMetricRouteTarget | null;
};

export type OrchestrationMetricDetailsResponseBody = {
  scope: OrchestrationMetricScopeDescriptor;
  items: OrchestrationMetricDetailItem[];
  total: number;
  page: number;
  pageSize: number;
  freshness: OrchestrationMetricFreshness;
};

export type OrchestrationMetricScopesResponseBody = {
  scopes: OrchestrationMetricScopeOption[];
  defaultScope: OrchestrationMetricScopeDescriptor;
};

export type OrchestrationMetricRefreshResponseBody = {
  refreshInProgress: boolean;
  summary: OrchestrationMetricSummary;
};

export const ORCHESTRATION_METRIC_SOURCE_HEALTH_STATUSES = ["succeeded", "truncated", "error", "offline"] as const;
export type OrchestrationMetricSourceHealthStatus = (typeof ORCHESTRATION_METRIC_SOURCE_HEALTH_STATUSES)[number];
export type OrchestrationMetricSourceCollectionMode = "incremental" | "full";
export type OrchestrationMetricSourceIssueCode = "collection_truncated" | "collection_error" | "source_offline";

/** Public source-health row with internal account identity and raw diagnostics removed. */
export type OrchestrationMetricSourceHealthItem = {
  sourceKey: string;
  workspaceId: string;
  online: boolean;
  metricSchemaVersion: number | null;
  metricDefinitionVersion: string | null;
  eventTimeWatermark: number | null;
  observedAt: number | null;
  lastMode: OrchestrationMetricSourceCollectionMode | null;
  lastStatus: OrchestrationMetricSourceHealthStatus | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastIncrementalAt: number | null;
  lastFullAt: number | null;
  requestId: string | null;
  issueCode: OrchestrationMetricSourceIssueCode | null;
  issueMessage: string | null;
  canRetry: boolean;
};

export type OrchestrationMetricDeliveryReconciliationReason = "record_count_mismatch" | "content_digest_mismatch" | "status_inconsistent";

/** Deterministic diagnosis for one unreconciled delivery batch. */
export type OrchestrationMetricUnreconciledBatch = {
  id: string;
  sourceSystem: string;
  sourceBatchId: string;
  periodFrom: number;
  periodTo: number;
  sourceRecordCount: number;
  acceptedRecordCount: number;
  reasons: OrchestrationMetricDeliveryReconciliationReason[];
  reasonMessage: string;
  updatedAt: number;
};

export type OrchestrationMetricSourcesResponseBody = {
  sources: OrchestrationMetricSourceHealthItem[];
  unreconciledBatches: OrchestrationMetricUnreconciledBatch[];
  generatedAt: number;
};

export type OrchestrationMetricSourceRetryResponseBody = {
  sourceKey: string;
  requestId: string;
  status: "succeeded";
};

export type OrchestrationMetricScopeCandidateKind = "user" | "enterprise";

export type OrchestrationMetricScopeCandidate = {
  kind: OrchestrationMetricScopeCandidateKind;
  id: string;
  label: string;
  description?: string | null;
};

export type OrchestrationMetricScopeCandidatesResponseBody = {
  items: OrchestrationMetricScopeCandidate[];
  total: number;
};

export type OrchestrationMetricInstanceFact = {
  sourceUserId?: string | null;
  sourceEnterpriseId?: string | null;
  sourceWorkspaceId: string;
  sourceInstanceId: string;
  sourceFingerprint: string;
  workflowId: string;
  workflowName: string;
  intakeId?: string | null;
  titleSummary: string;
  status: OrchestrationMetricStatus;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  nodeCount: number;
  retryCount: number;
  reworkCount: number;
  rejectionCount: number;
  validationStatus: OrchestrationMetricValidationStatus;
  validationCheckedCount: number;
  validationPassedCount: number;
  artifactCount: number;
  conversationEventCount: number;
  rawEngineEventCount: number;
  updatedAt: number;
};

export type OrchestrationMetricNodeFact = {
  sourceInstanceId: string;
  workflowSnapshotHash: string;
  nodeId: string;
  nodeExecutionId: string;
  attemptNo: number;
  parentExecutionId?: string | null;
  nodeLabel: string;
  nodeType?: string | null;
  roleStageId: string;
  roleStageName: string;
  status: string;
  attemptCount: number;
  retryCount: number;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  hasGateFailure: boolean;
  hasValidationFailure: boolean;
  qualityFlags: OrchestrationMetricQualityEventType[];
};

export type OrchestrationMetricQualityEventFact = {
  sourceInstanceId: string;
  nodeId?: string | null;
  eventType: OrchestrationMetricQualityEventType;
  eventSource: "instance" | "node" | "feedback" | "event" | "artifact" | "validation" | "trace";
  eventCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type OrchestrationMetricStateSegmentFact = {
  sourceInstanceId: string;
  nodeId?: string | null;
  nodeExecutionId?: string | null;
  attemptNo?: number | null;
  parentExecutionId?: string | null;
  segmentId: string;
  segmentType: OrchestrationMetricStateSegmentType;
  segmentClass: OrchestrationMetricStateSegmentClass;
  startedAt: number;
  endedAt?: number | null;
  durationMs?: number | null;
  sourceEventFrom: string;
  sourceEventTo?: string | null;
  sourceFingerprint: string;
};

export type OrchestrationMetricContractFact = {
  sourceInstanceId: string;
  nodeId?: string | null;
  nodeExecutionId?: string | null;
  workflowSnapshotHash: string;
  contractType: OrchestrationMetricContractType;
  contractKey: string;
  contractVersion: string;
  required: boolean;
  evaluationStatus: OrchestrationMetricContractEvaluationStatus;
  passed?: boolean | null;
  evidenceRef?: string | null;
  evaluatorId: string;
  evaluatorVersion: string;
  evaluatedAt?: number | null;
  sourceFingerprint: string;
};

export type OrchestrationMetricConformanceFact = {
  sourceInstanceId: string;
  workflowSnapshotHash: string;
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  observedStatus: string;
  result: OrchestrationMetricConformanceResult;
  deviationType?: OrchestrationMetricConformanceDeviation | null;
  executionCount: number;
  branchSourceNodeId?: string | null;
  branchTaken?: string | null;
  evidenceRef: string;
  observedAt: number;
  sourceFingerprint: string;
};

export type OrchestrationMetricTraceEvidenceStatus = "complete" | "incomplete";
export type OrchestrationMetricCostStatus = "available" | "unavailable";
export type OrchestrationMetricEvaluationKind = "deterministic" | "human" | "trace_grader";
export type OrchestrationMetricEvaluationStatus = "passed" | "failed" | "not_evaluated" | "missing_evidence";
export const ORCHESTRATION_METRIC_EVALUATION_SET_KINDS = ["benchmark", "online_sample"] as const;
export type OrchestrationMetricEvaluationSetKind = (typeof ORCHESTRATION_METRIC_EVALUATION_SET_KINDS)[number];
export const ORCHESTRATION_METRIC_EVALUATION_CRITERIA = ["trace_evidence_integrity", "tool_path_efficiency"] as const;
export type OrchestrationMetricEvaluationCriterion = (typeof ORCHESTRATION_METRIC_EVALUATION_CRITERIA)[number];

/** One orchestration prompt turn bound to canonical conversation and raw-engine evidence. */
export type OrchestrationMetricTraceFact = {
  sourceInstanceId: string;
  nodeId: string;
  nodeExecutionId: string;
  attemptNo: number;
  promptSnapshotId: string;
  workflowSnapshotHash: string;
  roleId: string;
  roleSnapshotHash: string;
  promptDefinitionHash: string;
  promptHash: string;
  threadId: string;
  turnId: string;
  engine: string;
  providerId?: string | null;
  credentialSource?: EngineCredentialSource | null;
  model?: string | null;
  effort?: string | null;
  startedAt: number;
  completedAt?: number | null;
  durationMs?: number | null;
  modelCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** 本机采集逐字段标记全部用量事件均有记录；缺少标记时该字段未知。 */
  tokenUsageCoverage?: { inputTokens: boolean; outputTokens: boolean; totalTokens: boolean };
  toolCallCount: number;
  toolSuccessCount: number;
  toolFailureCount: number;
  costStatus: OrchestrationMetricCostStatus;
  /** Snapshot currency micro-units; schema v12 currently fixes the currency to CNY. */
  estimatedCostMicros?: number | null;
  priceSnapshotJson?: string | null;
  evidenceStatus: OrchestrationMetricTraceEvidenceStatus;
  evidenceReasons: string[];
  sourceFingerprint: string;
};

export type OrchestrationMetricContextCompactionKind = "automatic" | "manual";
export type OrchestrationMetricPostCompactionOutcome = "completed" | "error" | "not_observed";

/** One persisted context-compaction event and its first explicit post-compaction turn outcome. */
export type OrchestrationMetricContextCompactionFact = {
  sourceInstanceId: string;
  nodeId: string;
  nodeExecutionId?: string | null;
  promptSnapshotId?: string | null;
  threadId: string;
  compactionTurnId: string;
  compactionEventSeq: number;
  compactionKind: OrchestrationMetricContextCompactionKind;
  engine: string;
  model?: string | null;
  compactedAt: number;
  postCompactionOutcome: OrchestrationMetricPostCompactionOutcome;
  outcomeTurnId?: string | null;
  outcomeAt?: number | null;
  sourceFingerprint: string;
};

/** Exact aggregate over all authorized context-compaction facts in the current filter scope. */
export type OrchestrationMetricContextCompactionSummary = {
  compactionCount: number | null;
  compactedTraceCount: number | null;
  outcomeObservedCount: number | null;
  successfulOutcomeCount: number | null;
  postCompactionSuccessRate: number | null;
};

export type OrchestrationMetricAgentHandoffResolutionStatus = "resolved" | "missing_required" | "invalid";
export type OrchestrationMetricAgentHandoffMissingReason = { inputId: string; errorCode: string };

/** One attempt-scoped structured input contract and its first prompt injection evidence. */
export type OrchestrationMetricAgentHandoffFact = {
  sourceInstanceId: string;
  nodeId: string;
  nodeExecutionId: string;
  attemptNo: number;
  inputContextId: string;
  promptSnapshotId?: string | null;
  resolutionStatus: OrchestrationMetricAgentHandoffResolutionStatus;
  expectedReferenceIds: string[];
  availableReferenceIds: string[];
  injectedReferenceIds: string[];
  expectedFieldReferenceIds: string[];
  consumedFieldReferenceIds: string[];
  missingReasons: OrchestrationMetricAgentHandoffMissingReason[];
  observedAt: number;
  sourceFingerprint: string;
};

/** Exact aggregate over all authorized attempt-scoped handoff facts. */
export type OrchestrationMetricAgentHandoffSummary = {
  attemptCount: number | null;
  blockedAttemptCount: number | null;
  expectedReferenceCount: number | null;
  availableReferenceCount: number | null;
  artifactAvailabilityRate: number | null;
  injectedReferenceCount: number | null;
  promptInjectionRate: number | null;
  expectedFieldReferenceCount: number | null;
  consumedFieldReferenceCount: number | null;
  fieldConsumptionRate: number | null;
};

/** Versioned evaluation result over one bounded orchestration evidence scope. */
export type OrchestrationMetricEvaluationFact = {
  sourceInstanceId: string;
  nodeId?: string | null;
  nodeExecutionId?: string | null;
  promptSnapshotId?: string | null;
  evaluationKey: string;
  evaluationKind: OrchestrationMetricEvaluationKind;
  evaluatorId: string;
  evaluatorVersion: string;
  criterion: string;
  evaluationStatus: OrchestrationMetricEvaluationStatus;
  score?: number | null;
  evidenceScopeJson: string;
  evidenceRef?: string | null;
  /** Server-side evaluation set that selected this fact; Client collection must leave it empty. */
  evaluationSetId?: string | null;
  /** Frozen set item identity used to prevent a score from drifting to another Trace. */
  evaluationItemId?: string | null;
  /** Authenticated operator that last supplied a human score. */
  reviewerUserId?: string | null;
  explanation: string;
  evaluatedAt: number;
  sourceFingerprint: string;
};

export type OrchestrationMetricEvaluationSetSelectionRule = {
  ruleVersion: "prompt_snapshot_id_asc_v1";
  filters: Pick<OrchestrationMetricFilters, "from" | "to" | "workflowIds" | "statuses" | "engines" | "models">;
  candidateCount: number;
  sampleSize: number;
};

export type OrchestrationMetricEvaluationSetSummary = {
  id: string;
  kind: OrchestrationMetricEvaluationSetKind;
  name: string;
  description: string;
  scope: OrchestrationMetricScopeDescriptor;
  criterion: OrchestrationMetricEvaluationCriterion;
  evaluatorId: string;
  evaluatorVersion: string;
  selectionRule: OrchestrationMetricEvaluationSetSelectionRule;
  itemCount: number;
  labeledCount: number;
  humanRatedCount: number;
  targetEvaluatedCount: number;
  agreementCount: number;
  agreementRate: number | null;
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationMetricEvaluationSetItem = {
  id: string;
  evaluationSetId: string;
  sourceWorkspaceId: string;
  sourceInstanceId: string;
  nodeId: string;
  nodeExecutionId: string;
  promptSnapshotId: string;
  workflowSnapshotHash: string;
  roleSnapshotHash: string;
  promptDefinitionHash: string;
  promptHash: string;
  engine: string;
  model: string | null;
  effort: string | null;
  traceStartedAt: number;
  expectedStatus: Exclude<OrchestrationMetricEvaluationStatus, "not_evaluated"> | null;
  targetEvaluationStatus: OrchestrationMetricEvaluationStatus | null;
  humanEvaluationStatus: Exclude<OrchestrationMetricEvaluationStatus, "not_evaluated"> | null;
  humanExplanation: string | null;
  reviewerUserId: string | null;
  evaluatedAt: number | null;
};

export type OrchestrationMetricEvaluationSetsResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  items: OrchestrationMetricEvaluationSetSummary[];
};

export type OrchestrationMetricEvaluationSetItemsResponse = {
  evaluationSet: OrchestrationMetricEvaluationSetSummary;
  items: OrchestrationMetricEvaluationSetItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type OrchestrationMetricEvaluationCohortSummary = {
  factCount: number;
  eligibleCount: number | null;
  evaluatedCount: number | null;
  passedCount: number | null;
  failedCount: number | null;
  missingEvidenceCount: number | null;
  notEvaluatedCount: number | null;
  coverageRate: number | null;
  passRate: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
};

export type OrchestrationMetricEvaluationCohortItem = {
  cohortKey: string;
  workflowSnapshotHash: string;
  nodeId: string;
  roleSnapshotHash: string;
  promptDefinitionHash: string;
  engine: string;
  model: string | null;
  effort: string | null;
  evaluatorId: string;
  evaluatorVersion: string;
  criterion: string;
  current: OrchestrationMetricEvaluationCohortSummary | null;
  comparison: OrchestrationMetricEvaluationCohortSummary | null;
  comparable: boolean;
  incompatibilityReasons: string[];
  passRateDelta: number | null;
  conclusion: "improved" | "regressed" | "no_detectable_change" | null;
  privacy?: OrchestrationMetricPrivacy;
  comparisonPrivacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricExperimentsResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  currentPeriod: { from: number; to: number };
  comparisonPeriod: { from: number; to: number };
  currentTotals: OrchestrationMetricEvaluationCohortSummary;
  comparisonTotals: OrchestrationMetricEvaluationCohortSummary;
  cohorts: OrchestrationMetricEvaluationCohortItem[];
  total: number;
  page: number;
  pageSize: number;
  generatedAt: number;
  metricSchemaVersion: number;
  metricDefinitionVersion: string;
  statistics: OrchestrationMetricStatistics;
  privacy: OrchestrationMetricPrivacy;
  comparisonPrivacy: OrchestrationMetricPrivacy;
  comparabilityPolicy: { minEvaluatedSamples: 20; requiredCoverageRate: 1; confidenceLevel: 0.95 };
};

export type OrchestrationMetricCostCalculationStatus = "available" | "indeterminate" | "no_data" | "privacy_suppressed";
export type OrchestrationMetricCostIndeterminateReason = "missing_pricing_evidence" | "non_billable_credential" | "privacy_suppressed";
export const ORCHESTRATION_METRIC_COST_DIMENSIONS = ["workflow", "node", "role", "model"] as const;
export type OrchestrationMetricCostDimension = (typeof ORCHESTRATION_METRIC_COST_DIMENSIONS)[number];
export type OrchestrationMetricUnitCostStatus = "available" | "indeterminate" | "not_applicable" | "no_successful_delivery" | "privacy_suppressed";

export type OrchestrationMetricCostGroup = {
  dimension: OrchestrationMetricCostDimension;
  dimensionKey: string;
  dimensionLabel: string;
  workflowSnapshotHash: string | null;
  nodeId: string | null;
  roleId: string | null;
  roleSnapshotHash: string | null;
  engine: string;
  providerId: EngineModelProviderId | null;
  credentialSource: EngineCredentialSource | null;
  model: string | null;
  traceCount: number;
  modelCallCount: number | null;
  /** Provider input count kept for compatibility; UI/export use normalized uncachedInputTokens. */
  inputTokens: number | null;
  /** Input tokens not served from an existing cache, including cache creation input. */
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  /** Input tokens served from an existing cache. */
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  toolCallCount: number | null;
  toolFailureCount: number | null;
  durationTraceCount: number | null;
  activeDurationMs: number | null;
  validationEligibleInstanceCount: number | null;
  validationCoveredInstanceCount: number | null;
  validationSuccessfulInstanceCount: number | null;
  validationCoverageRate: number | null;
  validationSuccessRate: number | null;
  firstPassInstanceCount: number | null;
  firstPassRate: number | null;
  retryAffectedInstanceCount: number | null;
  ineffectiveLoopCount: number | null;
  costCalculationStatus: OrchestrationMetricCostCalculationStatus;
  costIndeterminateReasons: OrchestrationMetricCostIndeterminateReason[];
  pricedTraceCount: number | null;
  unpricedTraceCount: number | null;
  pricingCoverageRate: number | null;
  totalCostMicros: number | null;
  unitSuccessfulDeliveryCostStatus: OrchestrationMetricUnitCostStatus;
  unitSuccessfulDeliveryCostMicros: number | null;
  privacy?: OrchestrationMetricPrivacy;
};

/** One time bucket for the overview token-consumption trend. */
export type OrchestrationMetricCostTrendBucket = {
  bucketStart: number;
  bucketEnd: number;
  traceCount: number | null;
  modelCallCount: number | null;
  /** Input tokens not served from an existing cache, including cache creation input. */
  uncachedInputTokens: number | null;
  /** Input tokens served from an existing cache. */
  cachedInputTokens: number | null;
  /** Provider input count retained for compatibility with older trend consumers. */
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  privacy?: OrchestrationMetricPrivacy;
};

/** Public Trace row with an authorized target for exact runtime-evidence lookup. */
export type OrchestrationMetricCostTraceItem = OrchestrationMetricTraceFact & {
  routeTarget: OrchestrationMetricRouteTarget;
};

export type OrchestrationMetricCostsResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  dimension: OrchestrationMetricCostDimension;
  totals: OrchestrationMetricCostGroup;
  /** Older Server responses may omit this field while the overview contract rolls out. */
  trend?: OrchestrationMetricCostTrendBucket[];
  contextCompaction: OrchestrationMetricContextCompactionSummary;
  agentHandoff: OrchestrationMetricAgentHandoffSummary;
  groups: OrchestrationMetricCostGroup[];
  items: OrchestrationMetricCostTraceItem[];
  total: number;
  page: number;
  pageSize: number;
  metadata: OrchestrationMetricAnalysisMetadata;
};

export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_QUALITY_STATUSES = ["complete", "partial", "unavailable"] as const;
export type OrchestrationMetricCodeAttributionQualityStatus = (typeof ORCHESTRATION_METRIC_CODE_ATTRIBUTION_QUALITY_STATUSES)[number];
export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_QUALITY_REASONS = [
  "ai_trace_missing",
  "commit_diff_missing",
  "association_missing",
  "hook_not_installed",
  "unsupported_tool",
  "patch_snapshot_missing",
  "patch_snapshot_corrupt",
  "patch_superseded",
  "history_rewritten",
  "binary_file",
  "generated_file",
  "merge_commit",
  "ambiguous_attribution",
  "execution_reference_missing",
  "retention_observation_pending",
  "retention_observation_missing",
] as const;
export type OrchestrationMetricCodeAttributionQualityReason = (typeof ORCHESTRATION_METRIC_CODE_ATTRIBUTION_QUALITY_REASONS)[number];
export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_EXTERNAL_SOURCE_PREFIX = "external_code_attribution:" as const;
export type OrchestrationMetricCodeAttributionExternalSourceSystem =
  `${typeof ORCHESTRATION_METRIC_CODE_ATTRIBUTION_EXTERNAL_SOURCE_PREFIX}${string}`;
export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_EXTERNAL_COVERAGE_STATES = [
  "complete",
  "hook_not_installed",
  "unsupported_tool",
  "ai_trace_missing",
  "commit_diff_missing",
  "association_missing",
  "history_rewritten",
] as const;
export type OrchestrationMetricCodeAttributionExternalCoverageState =
  (typeof ORCHESTRATION_METRIC_CODE_ATTRIBUTION_EXTERNAL_COVERAGE_STATES)[number];
export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_RECONCILIATION_STATUSES = [
  "ai_trace_received",
  "commit_received",
  "matched",
  "partial",
  "superseded",
  "excluded",
  "failed",
] as const;
export type OrchestrationMetricCodeAttributionReconciliationStatus = (typeof ORCHESTRATION_METRIC_CODE_ATTRIBUTION_RECONCILIATION_STATUSES)[number];

/** Recomputable line totals for one file or aggregate range at one optional retention window. */
export type OrchestrationMetricCodeAttributionLineCounts = {
  aiGeneratedAddedLines: number;
  aiCandidateAddedLines: number;
  retainedAiAddedLines: number;
  committedAddedLines: number;
  eligibleCommittedAddedLines: number;
  coveredCommittedAddedLines: number;
  stillPresentAiAddedLines: number | null;
};

/** Ratios derived from aggregate numerators and denominators; retention is bound to an explicit window. */
export type OrchestrationMetricCodeAttributionRates = {
  aiContributionShare: number | null;
  aiOutputAdoptionRate: number | null;
  aiCodeRetentionRate: number | null;
  collectionCoverageRate: number | null;
  retentionWindowDays: OrchestrationMetricCodeAttributionRetentionWindowDays | null;
};

/** One source-code-free execution identity that directly contributed Patch evidence to a file fact. */
export type OrchestrationMetricCodeAttributionExecutionRef = {
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  promptSnapshotId: string;
  threadId: string;
  turnId: string;
  evidenceSha256: string;
};

/** One source-code-free attribution fact linked to an authorized commit and orchestration instance. */
export type OrchestrationMetricCodeAttributionFact = Omit<
  OrchestrationMetricCodeAttributionLineCounts,
  "stillPresentAiAddedLines"
> & {
  id: string;
  sourceSystem: string;
  sourceBatchId: string;
  sourceWorkspaceId: string;
  sourceInstanceId: string;
  repository: string;
  commitSha: string;
  fileIdentitySha256: string;
  language: string | null;
  qualityStatus: OrchestrationMetricCodeAttributionQualityStatus;
  qualityReasons: OrchestrationMetricCodeAttributionQualityReason[];
  reconciliationStatus: OrchestrationMetricCodeAttributionReconciliationStatus;
  aiEvidenceSha256: string | null;
  commitEvidenceSha256: string | null;
  evidenceRef: string | null;
  executionRefs: OrchestrationMetricCodeAttributionExecutionRef[];
  observedAt: number;
  createdAt: number;
  updatedAt: number;
};

/** Client-to-Server attribution payload with a CodeFlow-issued instance association proof. */
export type OrchestrationMetricCodeAttributionIngestFact = Omit<
  OrchestrationMetricCodeAttributionFact,
  "id" | "sourceSystem" | "sourceBatchId" | "reconciliationStatus" | "createdAt" | "updatedAt"
>;

export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_COMMIT_DISPOSITIONS = ["matched", "partial", "excluded"] as const;
export type OrchestrationMetricCodeAttributionCommitDisposition =
  (typeof ORCHESTRATION_METRIC_CODE_ATTRIBUTION_COMMIT_DISPOSITIONS)[number];

/** Commit-level identity and quality envelope retained even when no file fact is eligible. */
export type OrchestrationMetricCodeAttributionCommitObservation = {
  sourceWorkspaceId: string;
  sourceInstanceId: string;
  repository: string;
  commitSha: string;
  disposition: OrchestrationMetricCodeAttributionCommitDisposition;
  qualityStatus: OrchestrationMetricCodeAttributionQualityStatus;
  qualityReasons: OrchestrationMetricCodeAttributionQualityReason[];
  commitEvidenceSha256: string;
  observedAt: number;
};

/** Atomic Client-to-Server batch; the association proof is excluded from content identity. */
export type OrchestrationMetricCodeAttributionIngestBatchInput = {
  associationId: string;
  sourceSystem: string;
  sourceBatchId: string;
  sourceRecordCount: number;
  sourceContentSha256: string;
  commit: OrchestrationMetricCodeAttributionCommitObservation;
  facts: OrchestrationMetricCodeAttributionIngestFact[];
};

/** Vendor-neutral, source-code-free input normalized by one external AI Hook adapter. */
export type OrchestrationMetricCodeAttributionExternalAdapterBatchInput = Omit<
  OrchestrationMetricCodeAttributionIngestBatchInput,
  "sourceSystem"
> & {
  adapterId: string;
};

/** Authoritative commit identity mapped into the existing delivery-batch event contract. */
export type OrchestrationMetricCodeAttributionExternalDeliveryCommitInput = {
  associationId: string;
  externalId: string;
  sourceWorkspaceId: string;
  sourceInstanceId: string;
  repository: string;
  commitSha: string;
  committedAt: number;
  evidenceRef: string;
};

/** Explicit Client RPC input for collecting one authoritative Git commit. */
export type OrchestrationMetricCodeAttributionCommitCollectRequest = {
  workspaceId: WorkspaceId;
  repositoryPath?: string | null;
  commitSha: string;
  instanceId: OrchestrationId;
  associationId: string;
  associationExpiresAt: number;
};

/** Source-code-free receipt for a queued or idempotently replayed local commit batch. */
export type OrchestrationMetricCodeAttributionCommitCollectResponse = {
  outboxId: string;
  sourceBatchId: string;
  contentSha256: string;
  repository: string;
  commitSha: string;
  factCount: number;
  qualityStatus: OrchestrationMetricCodeAttributionQualityStatus;
  qualityReasons: OrchestrationMetricCodeAttributionQualityReason[];
  replayed: boolean;
};

export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_RETENTION_WINDOWS = [7, 30] as const;
export type OrchestrationMetricCodeAttributionRetentionWindowDays = (typeof ORCHESTRATION_METRIC_CODE_ATTRIBUTION_RETENTION_WINDOWS)[number];
export type OrchestrationMetricCodeAttributionRetentionUnavailableReason = Extract<
  OrchestrationMetricCodeAttributionQualityReason,
  "history_rewritten" | "retention_observation_missing"
>;

type OrchestrationMetricCodeAttributionRetentionObservationBase = {
  id: string;
  attributionFactId: string;
  windowDays: OrchestrationMetricCodeAttributionRetentionWindowDays;
  createdAt: number;
};

/** One immutable retention observation whose unavailable state cannot carry a false zero. */
export type OrchestrationMetricCodeAttributionRetentionObservation =
  | OrchestrationMetricCodeAttributionRetentionObservationBase & {
    stillPresentAiAddedLines: number;
    qualityStatus: "complete";
    qualityReasons: [];
    retentionEvidenceSha256: string;
    evidenceRef: string;
    observedAt: number;
  }
  | OrchestrationMetricCodeAttributionRetentionObservationBase & {
    stillPresentAiAddedLines: null;
    qualityStatus: "unavailable";
    qualityReasons: [OrchestrationMetricCodeAttributionRetentionUnavailableReason, ...OrchestrationMetricCodeAttributionRetentionUnavailableReason[]];
    retentionEvidenceSha256: null;
    evidenceRef: null;
    observedAt: null;
  };

type OrchestrationMetricCodeAttributionRetentionIngestIdentity = {
  observationId: string;
  sourceWorkspaceId: string;
  sourceInstanceId: string;
  repository: string;
  commitSha: string;
  fileIdentitySha256: string;
  windowDays: OrchestrationMetricCodeAttributionRetentionWindowDays;
};

/** Client observation resolved to its immutable Server fact by the full attribution identity. */
export type OrchestrationMetricCodeAttributionRetentionIngestInput =
  | OrchestrationMetricCodeAttributionRetentionIngestIdentity & {
    stillPresentAiAddedLines: number;
    qualityStatus: "complete";
    qualityReasons: [];
    retentionEvidenceSha256: string;
    evidenceRef: string;
    observedAt: number;
  }
  | OrchestrationMetricCodeAttributionRetentionIngestIdentity & {
    stillPresentAiAddedLines: null;
    qualityStatus: "unavailable";
    qualityReasons: [OrchestrationMetricCodeAttributionRetentionUnavailableReason, ...OrchestrationMetricCodeAttributionRetentionUnavailableReason[]];
    retentionEvidenceSha256: null;
    evidenceRef: null;
    observedAt: null;
  };

/** Server receipt used to settle one local retention observation lease. */
export type OrchestrationMetricCodeAttributionRetentionIngestReceipt =
  OrchestrationMetricCodeAttributionRetentionObservation & {
    sourceWorkspaceId: string;
    sourceInstanceId: string;
    repository: string;
    commitSha: string;
    fileIdentitySha256: string;
  };

/** Idempotent source batch whose facts are accepted atomically after association and digest checks. */
export type OrchestrationMetricCodeAttributionBatch = {
  id: string;
  sourceSystem: string;
  sourceBatchId: string;
  scope: OrchestrationMetricScopeDescriptor;
  sourceRecordCount: number;
  acceptedRecordCount: number;
  sourceContentSha256: string;
  contentSha256: string;
  reconciliationStatus: OrchestrationMetricCodeAttributionReconciliationStatus;
  createdAt: number;
  updatedAt: number;
};

export const ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DIMENSIONS = [
  "requirement",
  "instance",
  "workflow",
  "workspace",
  "repository",
  "language",
] as const;
export type OrchestrationMetricCodeAttributionDimension =
  (typeof ORCHESTRATION_METRIC_CODE_ATTRIBUTION_DIMENSIONS)[number];

/** One explicit retention window whose denominator contains only completed observations. */
export type OrchestrationMetricCodeAttributionRetentionAggregate = {
  windowDays: OrchestrationMetricCodeAttributionRetentionWindowDays;
  stillPresentAiAddedLines: number | null;
  observedRetainedAiAddedLines: number | null;
  retentionRate: number | null;
  status: OrchestrationMetricCodeAttributionQualityStatus;
  qualityReasons: OrchestrationMetricCodeAttributionQualityReason[];
  completeObservationCount: number | null;
  pendingObservationCount: number | null;
  missingObservationCount: number | null;
  latestObservedAt: number | null;
};

/** Descriptive delivery signals joined by the full attribution commit identity. */
export type OrchestrationMetricCodeAttributionDeliveryQuality = {
  linkedCommitCount: number | null;
  reworkCommitCount: number | null;
  rollbackCommitCount: number | null;
  recoveryCommitCount: number | null;
};

/** Aggregate numerators, denominators, quality counts, and ratios for one code-attribution group. */
export type OrchestrationMetricCodeAttributionAggregate = Omit<
  OrchestrationMetricCodeAttributionRates,
  "aiCodeRetentionRate" | "retentionWindowDays"
> & {
  aiGeneratedAddedLines: number | null;
  aiCandidateAddedLines: number | null;
  retainedAiAddedLines: number | null;
  committedAddedLines: number | null;
  eligibleCommittedAddedLines: number | null;
  coveredCommittedAddedLines: number | null;
  factCount: number;
  commitCount: number;
  completeFactCount: number | null;
  partialFactCount: number | null;
  unavailableFactCount: number | null;
  matchedFactCount: number | null;
  pendingFactCount: number | null;
  excludedFactCount: number | null;
  distinctUserCount: number | null;
  latestObservedAt: number | null;
  retention7Day: OrchestrationMetricCodeAttributionRetentionAggregate;
  retention30Day: OrchestrationMetricCodeAttributionRetentionAggregate;
  deliveryQuality: OrchestrationMetricCodeAttributionDeliveryQuality;
};

export type OrchestrationMetricCodeAttributionGroup = OrchestrationMetricCodeAttributionAggregate & {
  dimension: OrchestrationMetricCodeAttributionDimension;
  dimensionKey: string;
  dimensionLabel: string;
  privacy?: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricCodeAttributionTrendBucket = OrchestrationMetricCodeAttributionAggregate & {
  bucketStart: number;
  bucketEnd: number;
  privacy?: OrchestrationMetricPrivacy;
};

/** One paged commit summary with deterministic orchestration evidence targets and no source text. */
export type OrchestrationMetricCodeAttributionCommitItem = OrchestrationMetricCodeAttributionAggregate & {
  sourceBatchId: string;
  workspaceId: string;
  instanceId: string;
  intakeId: string | null;
  workflowId: string;
  workflowName: string;
  titleSummary: string;
  repository: string;
  commitSha: string;
  qualityStatus: OrchestrationMetricCodeAttributionQualityStatus;
  qualityReasons: OrchestrationMetricCodeAttributionQualityReason[];
  reconciliationStatus: OrchestrationMetricCodeAttributionReconciliationStatus;
  executionRefs: OrchestrationMetricCodeAttributionExecutionRef[];
  routeTarget: OrchestrationMetricRouteTarget;
  observedAt: number;
};

/** Authorized code-attribution analysis used by the page and the audit evidence bundle. */
export type OrchestrationMetricCodeAttributionResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  filters: OrchestrationMetricFilters;
  dimension: OrchestrationMetricCodeAttributionDimension;
  totals: OrchestrationMetricCodeAttributionAggregate;
  trend: OrchestrationMetricCodeAttributionTrendBucket[];
  groups: OrchestrationMetricCodeAttributionGroup[];
  items: OrchestrationMetricCodeAttributionCommitItem[];
  total: number;
  page: number;
  pageSize: number;
  coverageStatus: OrchestrationMetricCodeAttributionQualityStatus;
  coverageReasons: OrchestrationMetricCodeAttributionQualityReason[];
  generatedAt: number;
  metricDefinitionVersion: string;
  privacy: OrchestrationMetricPrivacy;
};

export const ORCHESTRATION_METRIC_DELIVERY_FACT_KINDS = ["commit", "pull_request", "test_run", "deployment", "rollback", "recovery"] as const;
export type OrchestrationMetricDeliveryFactKind = (typeof ORCHESTRATION_METRIC_DELIVERY_FACT_KINDS)[number];
export const ORCHESTRATION_METRIC_DELIVERY_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export type OrchestrationMetricDeliveryStatus = (typeof ORCHESTRATION_METRIC_DELIVERY_STATUSES)[number];
export type OrchestrationMetricDeliveryReconciliationStatus = "matched" | "unreconciled";

/** One explicit delivery-system event linked to a CodeFlow orchestration instance. */
export type OrchestrationMetricDeliveryFact = {
  id: string;
  sourceSystem: string;
  sourceBatchId: string;
  externalId: string;
  sourceWorkspaceId: string;
  sourceInstanceId: string;
  kind: OrchestrationMetricDeliveryFactKind;
  status: OrchestrationMetricDeliveryStatus;
  environment: string | null;
  repository: string;
  commitSha: string | null;
  pullRequestId: string | null;
  relatedExternalId: string | null;
  isRework: boolean | null;
  eventAt: number;
  evidenceRef: string;
  reconciliationStatus: OrchestrationMetricDeliveryReconciliationStatus;
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationMetricDeliveryBatch = {
  id: string;
  sourceSystem: string;
  sourceBatchId: string;
  scope: OrchestrationMetricScopeDescriptor;
  periodFrom: number;
  periodTo: number;
  sourceRecordCount: number;
  acceptedRecordCount: number;
  sourceContentSha256: string;
  contentSha256: string;
  reconciliationStatus: OrchestrationMetricDeliveryReconciliationStatus;
  createdAt: number;
  updatedAt: number;
};

/** One external delivery event plus its CodeFlow-issued instance association proof. */
export type OrchestrationMetricDeliveryIngestEvent = Omit<
  OrchestrationMetricDeliveryFact,
  "id" | "sourceSystem" | "sourceBatchId" | "reconciliationStatus" | "createdAt" | "updatedAt"
> & {
  associationId: string;
};

/** Short-lived association proof returned for one authorized orchestration instance. */
export type OrchestrationMetricDeliveryAssociation = {
  associationId: string;
  expiresAt: number;
};

export type OrchestrationMetricDoraValue = {
  status: "available" | "unavailable";
  value: number | null;
  unit: "count" | "per_day" | "milliseconds" | "rate";
  sampleSize: number;
  reason: string | null;
};

export type OrchestrationMetricDeliveryResponse = {
  scope: OrchestrationMetricScopeDescriptor;
  period: { from: number; to: number };
  reconciliation: {
    status: "matched" | "unreconciled" | "not_configured";
    matchedBatchCount: number | null;
    unreconciledBatchCount: number | null;
    latestMatchedAt: number | null;
  };
  dora: {
    deploymentFrequency: OrchestrationMetricDoraValue;
    leadTimeForChanges: OrchestrationMetricDoraValue;
    changeFailureRate: OrchestrationMetricDoraValue;
    failedDeploymentRecoveryTime: OrchestrationMetricDoraValue;
    deploymentReworkRate: OrchestrationMetricDoraValue;
  };
  counts: Record<OrchestrationMetricDeliveryFactKind, number | null>;
  trend: Array<{
    bucketStartAt: number;
    bucketEndAt: number;
    deploymentFrequency: OrchestrationMetricDoraValue;
    leadTimeForChanges: OrchestrationMetricDoraValue;
    changeFailureRate: OrchestrationMetricDoraValue;
    failedDeploymentRecoveryTime: OrchestrationMetricDoraValue;
    deploymentReworkRate: OrchestrationMetricDoraValue;
  }>;
  facts: OrchestrationMetricDeliveryFact[];
  batches: OrchestrationMetricDeliveryBatch[];
  total: number;
  page: number;
  pageSize: number;
  generatedAt: number;
  metricSchemaVersion: number;
  metricDefinitionVersion: string;
  deliveryDefinitionVersion: string;
  statistics: OrchestrationMetricStatistics;
  privacy: OrchestrationMetricPrivacy;
};

export type OrchestrationMetricCollectRequest = {
  /** 一次授权采集轮次及其固定分页快照。 */
  roundId?: string | null;
  snapshotId?: string | null;
  workspaceId: string;
  scope: OrchestrationMetricScopeDescriptor;
  filters?: Pick<OrchestrationMetricFilters, "from" | "to" | "workflowIds" | "statuses">;
  allowedResourceIds?: string[] | null;
  cursor?: string | null;
  limit?: number | null;
  sinceUpdatedAt?: number | null;
};

export type OrchestrationMetricCollectResponse = {
  snapshotId?: string;
  metricSchemaVersion: number;
  metricDefinitionVersion: string;
  collectedAt: number;
  sourceWorkspaceId: string;
  instances: OrchestrationMetricInstanceFact[];
  nodes: OrchestrationMetricNodeFact[];
  qualityEvents: OrchestrationMetricQualityEventFact[];
  stateSegments: OrchestrationMetricStateSegmentFact[];
  contractFacts?: OrchestrationMetricContractFact[];
  conformanceFacts?: OrchestrationMetricConformanceFact[];
  traceFacts?: OrchestrationMetricTraceFact[];
  contextCompactionFacts?: OrchestrationMetricContextCompactionFact[];
  agentHandoffFacts?: OrchestrationMetricAgentHandoffFact[];
  evaluationFacts?: OrchestrationMetricEvaluationFact[];
  coverage: OrchestrationMetricCoverage;
  hasMore: boolean;
  nextCursor?: string | null;
};
