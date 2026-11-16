export type EngineType = "claude" | "codex";

export type AccessMode = "read-only" | "current" | "full-access";

/** Codex app-server 支持的服务档位；当前产品只开放 Fast，不暴露 Flex。 */
export type CodexServiceTier = "fast";

export type EngineModelProviderId = "anthropic" | "deepseek" | "moonshot" | "openai" | "qwen" | "zai";

export type EngineModelProviderInfo = {
  providerId: EngineModelProviderId;
  providerLabel: string;
};

/** 模型可声明的思考强度。不同模型支持的档位由模型配置决定。 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ReasoningEffortOption = {
  reasoningEffort: ReasoningEffort;
  description: string;
};

export type InputModality = "text" | "image";

export type EngineFeatures = {
  streaming: boolean;
  reasoning: boolean;
  toolUse: boolean;
  imageInput: boolean;
  sessionContinuation: boolean;
};

export type EngineCliDetectionStatus = "available" | "unavailable" | "timeout";

export type EngineCredentialSource = "codeflow_key" | "local_oauth" | "local_api_key" | "none";

export type EngineCredentialStatus = {
  available: boolean;
  source: EngineCredentialSource;
  /** 凭据不可用或读取异常时的短提示；不得包含密钥原文。 */
  message: string | null;
};

export type EngineProviderCredentialStatus = {
  providerId: EngineModelProviderId;
  available: boolean;
  sources: EngineCredentialSource[];
  /** 当前 provider 不可用时的短提示；不得包含密钥原文。 */
  message: string | null;
};

export type EngineModelInfo = {
  id: string;
  displayName: string;
  description?: string;
  /** 模型供应商标识，用于 UI 分组展示与 provider-aware 凭据选择。 */
  providerId?: EngineModelProviderId;
  /** 模型供应商展示名，用于 UI 分组展示与提示。 */
  providerLabel?: string;
  isDefault: boolean;
  /** 可选：按模型给出支持的 reasoning effort（若未知可为空）。 */
  supportedReasoningEfforts?: ReasoningEffortOption[];
  /** 可选：默认 reasoning effort（若未知可为空）。 */
  defaultReasoningEffort?: ReasoningEffort | null;
  /** 可选：输入模态（用于判断图片输入是否可用）。 */
  inputModalities?: InputModality[];
  /** 模型基础容量（token 数）；未声明最大容量时使用。 */
  contextWindow?: number;
  /** Codex 专属：是否支持 Fast mode 服务档位。 */
  supportsFastMode?: boolean;
  /** 是否支持扩展上下文（1M beta） */
  supports1MContext?: boolean;
  /** 模型最大上下文容量；会话自动使用，省略时使用基础容量。 */
  maxContextWindow?: number;
  /** 实际输入上下文超过此 token 数时按双倍计费；仅用于显示上游计费规则。 */
  doubleBillingThreshold?: number | null;
};

/** Client 级自定义模型定义；只描述目录元数据，不包含凭据。 */
export type EngineCustomModelEntry = {
  id: string;
  engine: EngineType;
  providerId: EngineModelProviderId;
  modelId: string;
  displayName: string;
  inputModalities: InputModality[];
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort | null;
  contextWindow: number | null;
  maxContextWindow: number | null;
  supportsFastMode: boolean;
  supports1MContext: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type EngineStatus = {
  engineType: EngineType;
  installed: boolean;
  version: string | null;
  binPath: string | null;
  features: EngineFeatures;
  models: EngineModelInfo[];
  /** CLI 探测结论；timeout 表示本次结果未知，不等同于未安装。 */
  detectionStatus?: EngineCliDetectionStatus;
  /** 本次 CLI 探测耗时，供生产排障使用。 */
  detectionDurationMs?: number;
  /** Host Client 探测到的执行凭据状态，用于 UI 禁用与发送前校验。 */
  credentialStatus?: EngineCredentialStatus;
  /** Host Client 按 provider 汇总的可执行凭据状态，用于模型列表过滤。 */
  providerCredentialStatus?: EngineProviderCredentialStatus[];
  error: string | null;
};

export type TokenUsageSnapshot = {
  inputTokens: number | null;
  outputTokens: number | null;
  /** cache_read_input_tokens（从缓存读取的输入 token 数）。 */
  cachedInputTokens: number | null;
  /** cache_creation_input_tokens（写入缓存的输入 token 数）。 */
  cacheCreationInputTokens: number | null;
  /** 引擎原生 total_tokens；Codex 用于当前上下文窗口占用。 */
  totalTokens?: number | null;
  /** 引擎原生 reasoning_output_tokens；仅作明细展示。 */
  reasoningOutputTokens?: number | null;
  modelContextWindow: number | null;
};

export type TokenUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number | null;
  reasoningOutputTokens: number | null;
};

/** Web 侧聚合状态：区分"当前上下文快照"与"会话累计消耗"。 */
export type TokenUsageState = {
  /** 当前上下文快照（同轮内 merge-max，跨轮 replace） */
  current: TokenUsageSnapshot;
  /** 会话累计（已完成轮次的 token 总和） */
  cumulative: TokenUsageTotals;
  /** 当前轮的峰值追踪器（turn.completed 时刷入 cumulative 并归零） */
  turnPeak: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number };
};

export function createEmptyTokenUsageState(): TokenUsageState {
  return {
    current: { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null, totalTokens: null, reasoningOutputTokens: null, modelContextWindow: null },
    cumulative: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: null, reasoningOutputTokens: null },
    turnPeak: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
  };
}
