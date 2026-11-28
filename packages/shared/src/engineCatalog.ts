import type {
  AccessMode,
  CodexServiceTier,
  EngineCustomModelEntry,
  EngineModelInfo,
  EngineModelProviderId,
  EngineType,
  InputModality,
  ReasoningEffort,
  ReasoningEffortOption,
} from "./types/engine.js";
import type { ThreadPrefs } from "./types/http.js";

const CLAUDE_EFFORTS_STANDARD: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  { reasoningEffort: "low", description: "快速响应，减少思考" },
  { reasoningEffort: "medium", description: "均衡思考与速度" },
  { reasoningEffort: "high", description: "深度思考，更强推理" },
];

const CLAUDE_EFFORTS_ADVANCED: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  ...CLAUDE_EFFORTS_STANDARD,
  { reasoningEffort: "xhigh", description: "扩展思考，适合复杂编码与代理任务" },
  { reasoningEffort: "max", description: "最大思考强度，适用于最高复杂度任务" },
];

const DEEPSEEK_EFFORTS: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  { reasoningEffort: "low", description: "快速响应，减少思考" },
  { reasoningEffort: "high", description: "标准深度思考，适合常规工程任务" },
  { reasoningEffort: "max", description: "最大思考强度，适合复杂代理与编码任务" },
];

const KIMI_K3_EFFORTS: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  { reasoningEffort: "low", description: "低强度思考" },
  { reasoningEffort: "high", description: "深度思考" },
  { reasoningEffort: "max", description: "最大思考强度" },
];

const KIMI_K31_EFFORTS: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  { reasoningEffort: "low", description: "低强度思考" },
  { reasoningEffort: "medium", description: "均衡思考与速度" },
  { reasoningEffort: "high", description: "深度思考" },
  { reasoningEffort: "max", description: "最大思考强度" },
];

const GLM_EFFORTS: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  { reasoningEffort: "low", description: "轻量思考，适合简单任务" },
  { reasoningEffort: "high", description: "增强思考，适合日常编码" },
  { reasoningEffort: "max", description: "深度思考，适合复杂工程任务" },
];

const CODEX_EFFORTS_LOW_TO_MAX: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  { reasoningEffort: "low", description: "低强度思考" },
  { reasoningEffort: "medium", description: "均衡思考与速度" },
  { reasoningEffort: "high", description: "深度思考" },
  { reasoningEffort: "xhigh", description: "最强思考，适合复杂任务" },
  { reasoningEffort: "max", description: "最大思考强度" },
];

const CODEX_EFFORTS_LOW_TO_ULTRA: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  ...CODEX_EFFORTS_LOW_TO_MAX,
  { reasoningEffort: "ultra", description: "极限思考，适合最复杂代理任务" },
];

// GPT-6 Luna 支持 none、low、medium、high、xhigh、max。
const CODEX_EFFORTS_GPT6: NonNullable<EngineModelInfo["supportedReasoningEfforts"]> = [
  { reasoningEffort: "none", description: "禁用思考，极速响应" },
  { reasoningEffort: "low", description: "低强度思考" },
  { reasoningEffort: "medium", description: "均衡思考与速度" },
  { reasoningEffort: "high", description: "深度思考" },
  { reasoningEffort: "xhigh", description: "最强思考，适合复杂任务" },
  { reasoningEffort: "max", description: "最大思考强度" },
];

const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  none: "禁用思考，极速响应",
  minimal: "极简思考",
  low: "低强度思考",
  medium: "均衡思考与速度",
  high: "深度思考",
  xhigh: "最强思考，适合复杂任务",
  max: "最大思考强度",
  ultra: "极限思考，适合最复杂代理任务",
};

const REASONING_EFFORT_ORDER: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export const ENGINE_MODEL_PROVIDERS: Record<EngineModelProviderId, { providerId: EngineModelProviderId; providerLabel: string; engines: EngineType[] }> = {
  anthropic: { providerId: "anthropic", providerLabel: "Anthropic Claude", engines: ["claude"] },
  deepseek: { providerId: "deepseek", providerLabel: "DeepSeek", engines: ["claude"] },
  moonshot: { providerId: "moonshot", providerLabel: "Moonshot / Kimi", engines: ["claude"] },
  openai: { providerId: "openai", providerLabel: "OpenAI", engines: ["codex"] },
  qwen: { providerId: "qwen", providerLabel: "Qwen Cloud", engines: ["claude"] },
  zai: { providerId: "zai", providerLabel: "Z.AI / 智谱", engines: ["claude"] },
};

/** 各供应商官方 Base URL；Web 表单和 Client 连接测试共用同一份默认值。 */
export const ENGINE_PROVIDER_BASE_URLS: Record<EngineModelProviderId, string> = {
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/anthropic",
  moonshot: "https://api.moonshot.ai/anthropic",
  openai: "https://api.openai.com/v1",
  qwen: "https://token-plan.maas.qwencloudapi.com/apps/anthropic",
  zai: "https://api.z.ai/api/anthropic",
};

const MODEL_PROVIDER_ANTHROPIC = pickEngineModelProvider("anthropic");
const MODEL_PROVIDER_DEEPSEEK = pickEngineModelProvider("deepseek");
const MODEL_PROVIDER_MOONSHOT = pickEngineModelProvider("moonshot");
const MODEL_PROVIDER_OPENAI = pickEngineModelProvider("openai");
const MODEL_PROVIDER_QWEN = pickEngineModelProvider("qwen");
const MODEL_PROVIDER_ZAI = pickEngineModelProvider("zai");

export const CLAUDE_MODELS: EngineModelInfo[] = [
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-fable-5-2",
    displayName: "Claude Fable 5.2",
    description: "适合高难度推理与长时间代理任务",
    isDefault: true,
    supportedReasoningEfforts: CLAUDE_EFFORTS_ADVANCED,
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-fable-5-1",
    displayName: "Claude Fable 5.1",
    description: "Anthropic Fable 系列模型，原生支持 1M 上下文，适合最复杂的长链路代理任务",
    isDefault: false,
    supportedReasoningEfforts: CLAUDE_EFFORTS_ADVANCED,
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    description: "Anthropic 最新 Opus 旗舰，原生支持 1M 上下文，适合复杂推理与长时间代理任务",
    isDefault: false,
    supportedReasoningEfforts: CLAUDE_EFFORTS_ADVANCED,
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    description: "Anthropic Opus 系列旗舰，适合复杂推理与长时间代理任务",
    isDefault: false,
    supportedReasoningEfforts: CLAUDE_EFFORTS_ADVANCED,
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    contextWindow: 200_000,
  },
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-opus-5[1m]",
    displayName: "Claude Opus 5 1M",
    description: "Opus 5 的 1M 上下文变体",
    isDefault: false,
    supportedReasoningEfforts: CLAUDE_EFFORTS_ADVANCED,
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    description: "兼顾编码能力与响应速度",
    isDefault: false,
    supportedReasoningEfforts: CLAUDE_EFFORTS_ADVANCED,
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    description: "Sonnet 系列最新模型，原生支持 1M 上下文，适合日常编码与代理任务",
    isDefault: false,
    supportedReasoningEfforts: CLAUDE_EFFORTS_ADVANCED,
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    description: "适合高吞吐、低延迟任务",
    isDefault: false,
    supportedReasoningEfforts: CLAUDE_EFFORTS_STANDARD,
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ANTHROPIC,
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    description: "最快响应速度，轻量任务首选",
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text", "image"],
    contextWindow: 200_000,
  },
  {
    ...MODEL_PROVIDER_DEEPSEEK,
    id: "deepseek-flash",
    displayName: "DeepSeek V4.1 Flash 1M",
    description: "DeepSeek 多模态模型，官方上下文 1M，支持图片理解与长程代理任务",
    isDefault: false,
    supportedReasoningEfforts: DEEPSEEK_EFFORTS,
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_DEEPSEEK,
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro 1M",
    description: "DeepSeek V4 Pro 正式版（0813），适合复杂代理与编码任务",
    isDefault: false,
    supportedReasoningEfforts: DEEPSEEK_EFFORTS,
    defaultReasoningEffort: "high",
    inputModalities: ["text"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_MOONSHOT,
    id: "kimi-k3.1-pro",
    displayName: "Kimi K3.1 Pro",
    description: "适合长时间编码与多模态代理任务",
    isDefault: false,
    supportedReasoningEfforts: KIMI_K31_EFFORTS,
    defaultReasoningEffort: "max",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_MOONSHOT,
    id: "kimi-k3.1-pro-highspeed",
    displayName: "Kimi K3.1 Pro Highspeed",
    description: "Kimi K3.1 Pro 的高速版本",
    isDefault: false,
    supportedReasoningEfforts: KIMI_K31_EFFORTS,
    defaultReasoningEffort: "max",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_MOONSHOT,
    id: "kimi-k3",
    displayName: "Kimi K3",
    description: "Moonshot 旗舰模型，适合长程编码、视觉理解与工具调用任务",
    isDefault: false,
    supportedReasoningEfforts: KIMI_K3_EFFORTS,
    defaultReasoningEffort: "max",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ZAI,
    id: "glm-5.4",
    displayName: "GLM-5.4",
    description: "智谱 Coding Plan 模型，适合复杂编码与视觉任务",
    isDefault: false,
    supportedReasoningEfforts: GLM_EFFORTS,
    defaultReasoningEffort: "max",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ZAI,
    id: "glm-5.3",
    displayName: "GLM-5.3",
    description: "Z.AI 旗舰文本模型，支持 1M 上下文，面向复杂软件工程与长程代理任务",
    isDefault: false,
    supportedReasoningEfforts: GLM_EFFORTS,
    defaultReasoningEffort: "max",
    inputModalities: ["text"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_ZAI,
    id: "glm-5.3-flash",
    displayName: "GLM-5.3 Flash",
    description: "Z.AI 原生多模态快速模型，支持图片输入与 1M 上下文，强制开启思考",
    isDefault: false,
    supportedReasoningEfforts: GLM_EFFORTS,
    defaultReasoningEffort: "max",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_QWEN,
    id: "qwen4-max",
    displayName: "Qwen4 Max",
    description: "适合复杂推理、编码与视觉任务",
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text", "image"],
    contextWindow: 983_616,
  },
  {
    ...MODEL_PROVIDER_QWEN,
    id: "qwen3.8-max",
    displayName: "Qwen3.8 Max",
    description: "适合长文档与复杂编码",
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text", "image"],
    contextWindow: 1_015_808,
  },
  {
    ...MODEL_PROVIDER_QWEN,
    id: "qwen3.8-flash",
    displayName: "Qwen3.8 Flash",
    description: "适合低延迟编码与视觉任务",
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text", "image"],
    contextWindow: 1_015_808,
  },
];

// 2026-09-10：旧 Flash 模型本体已退役，官方暂时接受旧 ID 并由 V4.1 Flash 服务。
// 不再作为新会话候选；仅为历史配置保留窗口、模态与 effort 元数据，不改写保存的模型 ID（保留原 ID 并标注下线）。
const CLAUDE_LEGACY_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash[1m]": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "deepseek-v4-flash-vision-exp[1m]": "deepseek-flash",
};

// 2026-09-18：Flash 双条目合并为单一条目（官方 Flash 本身即 1M）。
// 历史配置里的显式 [1m] 变体按静默别名归一为合并后的条目，不提示下线。
const CLAUDE_SILENT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "deepseek-flash[1m]": "deepseek-flash",
};

/** 本次移出内置目录的型号只用于迁移已保存的偏好。 */
const RETIRED_THREAD_MODELS: Record<EngineType, Readonly<Record<string, string>>> = {
  codex: {
    "gpt-5.5": "gpt-6.2-sol",
    "gpt-5.6-sol": "gpt-6.2-sol",
    "gpt-5.6-terra": "gpt-6.2-astra",
    "gpt-5.6-luna": "gpt-6-luna",
    "gpt-6-sol": "gpt-6.1-sol",
  },
  claude: {
    "claude-fable-5": "claude-fable-5-2",
    "claude-fable-5[1m]": "claude-fable-5-2",
    "claude-opus-4-8": "claude-opus-5-5",
    "claude-opus-4-8[1m]": "claude-opus-5-5",
    "claude-opus-4-7": "claude-opus-5-5",
    "claude-opus-4-7[1m]": "claude-opus-5-5",
    "claude-opus-4-6": "claude-opus-5-5",
    "claude-opus-4-6[1m]": "claude-opus-5-5",
    "claude-opus-4-5-20251101": "claude-opus-5-5",
    "claude-sonnet-4-6": "claude-sonnet-5-5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-5-5",
    "kimi-k2.7-code": "kimi-k3.1-pro",
    "kimi-k2.7-code-highspeed": "kimi-k3.1-pro-highspeed",
    "kimi-k2.6": "kimi-k3",
    "glm-5.1": "glm-5.4",
    "glm-5-turbo": "glm-5.4",
    "glm-4.7": "glm-5.4",
    "qwen3.7-max": "qwen3.8-max",
    "qwen3.6-flash": "qwen3.8-flash",
  },
};

export const CODEX_MODELS: EngineModelInfo[] = [
  {
    ...MODEL_PROVIDER_OPENAI,
    id: "gpt-6.2-sol",
    displayName: "GPT-6.2 Sol",
    description: "适合日常编码与代理任务",
    isDefault: true,
    supportedReasoningEfforts: CODEX_EFFORTS_LOW_TO_ULTRA,
    defaultReasoningEffort: "xhigh",
    inputModalities: ["text", "image"],
    contextWindow: 500_000,
    baseContextWindow: 500_000,
    maxContextWindow: 872_000,
    supportsFastMode: true,
    supports1MContext: true,
  },
  {
    ...MODEL_PROVIDER_OPENAI,
    id: "gpt-6.2-astra",
    displayName: "GPT-6.2 Astra",
    description: "适合复杂编码、调试与长程代理任务",
    isDefault: false,
    supportedReasoningEfforts: CODEX_EFFORTS_LOW_TO_ULTRA,
    defaultReasoningEffort: "xhigh",
    inputModalities: ["text", "image"],
    contextWindow: 272_000,
    baseContextWindow: 272_000,
    maxContextWindow: 872_000,
    supportsFastMode: true,
    supports1MContext: true,
  },
  {
    ...MODEL_PROVIDER_OPENAI,
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    description: "GPT-6 Sol 升级版，接近 Astra 的智能水平，适合复杂编码、计算机使用与专业工作",
    isDefault: false,
    supportedReasoningEfforts: CODEX_EFFORTS_LOW_TO_MAX,
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    contextWindow: 1_000_000,
    baseContextWindow: 500_000,
    supportsFastMode: true,
    supports1MContext: true,
    maxContextWindow: 1_000_000,
  },
  {
    ...MODEL_PROVIDER_OPENAI,
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    description: "适合复杂代理与高要求任务",
    isDefault: false,
    supportedReasoningEfforts: CODEX_EFFORTS_LOW_TO_ULTRA,
    defaultReasoningEffort: "xhigh",
    inputModalities: ["text", "image"],
    contextWindow: 272_000,
    baseContextWindow: 272_000,
    supportsFastMode: true,
    supports1MContext: true,
    maxContextWindow: 872_000,
  },
  {
    ...MODEL_PROVIDER_OPENAI,
    id: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    description: "Codex 高效模型，适合聚焦、重复与高吞吐任务",
    isDefault: false,
    supportedReasoningEfforts: CODEX_EFFORTS_GPT6,
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    contextWindow: 1_050_000,
    supportsFastMode: true,
    supports1MContext: true,
    maxContextWindow: 1_050_000,
  },
];

export const PRODUCT_DEFAULT_THREAD_PREFS: Readonly<{
  accessMode: AccessMode;
  planMode: boolean;
}> = {
  accessMode: "full-access",
  planMode: false,
};

export const PRODUCT_DEFAULT_AUTO_COMPACT_PCT = 95;

export type ResolvedThreadPrefs = {
  model: string | null;
  effort: string | null;
  accessMode: AccessMode;
  planMode: boolean;
  autoCompactPct: number;
  contextWindow: number;
  serviceTier: CodexServiceTier | null;
};

function pickEngineModelProvider(providerId: EngineModelProviderId): { providerId: EngineModelProviderId; providerLabel: string } {
  const provider = ENGINE_MODEL_PROVIDERS[providerId];
  return { providerId: provider.providerId, providerLabel: provider.providerLabel };
}

/** 返回模型供应商展示信息，未知值统一落到“其他模型”。 */
export function resolveEngineModelProvider(model: EngineModelInfo | null | undefined): { providerId: string; providerLabel: string } {
  const providerId = String(model?.providerId ?? "").trim();
  const providerLabel = String(model?.providerLabel ?? "").trim();
  if (providerId && providerLabel) return { providerId, providerLabel };

  const modelId = String(model?.id ?? "").toLowerCase();
  if (modelId.startsWith("deepseek-")) return pickEngineModelProvider("deepseek");
  if (modelId.startsWith("kimi-")) return pickEngineModelProvider("moonshot");
  if (modelId.startsWith("glm-")) return pickEngineModelProvider("zai");
  if (modelId.startsWith("qwen")) return pickEngineModelProvider("qwen");
  if (modelId.startsWith("claude-")) return pickEngineModelProvider("anthropic");
  if (modelId.startsWith("gpt-") || modelId.startsWith("codex-")) return pickEngineModelProvider("openai");
  return { providerId: "other", providerLabel: "其他模型" };
}

/** 解析指定模型的供应商；目录缺失时按模型 id 前缀兜底。 */
export function getEngineModelProviderId(
  engine: EngineType,
  modelId: string | null | undefined,
  models?: EngineModelInfo[] | null,
): string | null {
  const normalizedModelId = String(modelId ?? "").trim();
  if (!normalizedModelId) return getDefaultEngineProviderId(engine);
  const model = getEngineModelInfo(engine, normalizedModelId, models) ?? {
    id: normalizedModelId,
    displayName: normalizedModelId,
    isDefault: false,
  };
  return resolveEngineModelProvider(model).providerId || null;
}

/** 返回引擎默认供应商：Claude 默认 Anthropic，Codex 默认 OpenAI。 */
export function getDefaultEngineProviderId(engine: EngineType): EngineModelProviderId {
  return engine === "codex" ? "openai" : "anthropic";
}

/** 校验供应商是否可用于指定执行引擎。 */
export function isEngineProviderAllowed(engine: EngineType, providerId: string | null | undefined): providerId is EngineModelProviderId {
  const normalized = String(providerId ?? "").trim() as EngineModelProviderId;
  const provider = ENGINE_MODEL_PROVIDERS[normalized];
  return Boolean(provider && provider.engines.includes(engine));
}

/** 归一化 Key 的供应商；空值使用引擎默认供应商，非法值返回 null。 */
export function normalizeEngineKeyProviderId(
  engine: EngineType,
  providerId: string | null | undefined,
): EngineModelProviderId | null {
  const normalized = String(providerId ?? "").trim();
  const resolved = (normalized || getDefaultEngineProviderId(engine)) as EngineModelProviderId;
  return isEngineProviderAllowed(engine, resolved) ? resolved : null;
}

/** 供应商展示名；未知值原样返回，避免提示丢失信息。 */
export function getEngineProviderLabel(providerId: string | null | undefined): string {
  const normalized = String(providerId ?? "").trim() as EngineModelProviderId;
  return ENGINE_MODEL_PROVIDERS[normalized]?.providerLabel ?? normalized;
}

/** 按供应商过滤模型；allowedProviderIds 为 null/undefined 时表示不限制。 */
export function filterEngineModelsByProviderIds(
  models: EngineModelInfo[],
  allowedProviderIds?: Iterable<string> | null,
): EngineModelInfo[] {
  if (!allowedProviderIds) return models;
  const allowed = new Set(Array.from(allowedProviderIds, (item) => String(item).trim()).filter(Boolean));
  if (!allowed.size) return [];
  return models.filter((model) => allowed.has(resolveEngineModelProvider(model).providerId));
}

/** 归一化 reasoning effort，非法值返回 null，避免把未知档位透传给引擎。 */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "none"
    || normalized === "minimal"
    || normalized === "low"
    || normalized === "medium"
    || normalized === "high"
    || normalized === "xhigh"
    || normalized === "max"
    || normalized === "ultra"
  ) {
    return normalized;
  }
  return null;
}

/** 返回指定 engine/provider 当前可配置的 reasoning effort 候选。 */
export function getSupportedReasoningEffortsForProvider(
  engine: EngineType,
  providerId: string | null | undefined,
): ReasoningEffortOption[] {
  const normalizedProviderId = normalizeEngineKeyProviderId(engine, providerId);
  if (!normalizedProviderId) return [];
  const supported = new Set<ReasoningEffort>();
  for (const model of getEngineModels(engine)) {
    if (resolveEngineModelProvider(model).providerId !== normalizedProviderId) continue;
    for (const option of model.supportedReasoningEfforts ?? []) {
      const effort = normalizeReasoningEffort(option.reasoningEffort);
      if (effort) supported.add(effort);
    }
  }
  return REASONING_EFFORT_ORDER
    .filter((effort) => supported.has(effort))
    .map((effort) => ({
      reasoningEffort: effort,
      description: REASONING_EFFORT_DESCRIPTIONS[effort],
    }));
}

/** 校验指定 effort 是否在 engine/provider 的可配置候选内。 */
export function isReasoningEffortSupportedForProvider(
  engine: EngineType,
  providerId: string | null | undefined,
  effort: unknown,
): effort is ReasoningEffort {
  const normalizedEffort = normalizeReasoningEffort(effort);
  if (!normalizedEffort) return false;
  return getSupportedReasoningEffortsForProvider(engine, providerId)
    .some((option) => option.reasoningEffort === normalizedEffort);
}

/** 归一化输入模态；空值默认 text，非法值被丢弃。 */
export function normalizeInputModalities(values: unknown): InputModality[] {
  const rawValues = Array.isArray(values) ? values : [];
  const normalized = new Set<InputModality>();
  for (const value of rawValues) {
    const item = String(value ?? "").trim();
    if (item === "text" || item === "image") normalized.add(item);
  }
  if (!normalized.size) normalized.add("text");
  return [...normalized];
}

/** 将自定义模型的 effort 配置归一化为目录选项；空数组表示运行时不发送 effort。 */
export function normalizeReasoningEffortOptions(values: unknown): ReasoningEffortOption[] {
  const rawValues = Array.isArray(values) ? values : [];
  const seen = new Set<ReasoningEffort>();
  const normalized: ReasoningEffortOption[] = [];
  for (const value of rawValues) {
    const effort = normalizeReasoningEffort(
      typeof value === "object" && value !== null
        ? (value as { reasoningEffort?: unknown }).reasoningEffort
        : value,
    );
    if (!effort || seen.has(effort)) continue;
    const rawDescription = typeof value === "object" && value !== null
      ? String((value as { description?: unknown }).description ?? "").trim()
      : "";
    seen.add(effort);
    normalized.push({
      reasoningEffort: effort,
      description: rawDescription || REASONING_EFFORT_DESCRIPTIONS[effort],
    });
  }
  return normalized;
}

/** 将 Client 自定义模型定义转换为统一模型目录项。 */
export function toEngineModelInfoFromCustomModel(entry: EngineCustomModelEntry): EngineModelInfo {
  const provider = ENGINE_MODEL_PROVIDERS[entry.providerId];
  const contextWindow = Number(entry.contextWindow ?? 0);
  const maxContextWindow = Number(entry.maxContextWindow ?? 0);
  const info: EngineModelInfo = {
    id: entry.modelId,
    displayName: entry.displayName || entry.modelId,
    description: "Client 自定义模型",
    providerId: entry.providerId,
    providerLabel: provider?.providerLabel ?? entry.providerId,
    isDefault: false,
    inputModalities: normalizeInputModalities(entry.inputModalities),
    supportedReasoningEfforts: normalizeReasoningEffortOptions(entry.supportedReasoningEfforts),
    defaultReasoningEffort: normalizeReasoningEffort(entry.defaultReasoningEffort),
  };
  if (Number.isFinite(contextWindow) && contextWindow > 0) info.contextWindow = Math.round(contextWindow);
  if (Number.isFinite(maxContextWindow) && maxContextWindow > 0) info.maxContextWindow = Math.round(maxContextWindow);
  if (entry.supportsFastMode) info.supportsFastMode = true;
  if (entry.supports1MContext) info.supports1MContext = true;
  return info;
}

/** 合并内置模型与 Client 自定义模型；内置 ID 优先，避免覆盖产品默认语义。 */
export function mergeEngineModelsWithCustomModels(
  _engine: EngineType,
  builtInModels: EngineModelInfo[],
  customModels?: EngineModelInfo[] | null,
): EngineModelInfo[] {
  const merged = [...builtInModels];
  const seen = new Set(merged.map((model) => model.id));
  for (const model of customModels ?? []) {
    const modelId = String(model?.id ?? "").trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    merged.push({ ...model, id: modelId, isDefault: false });
  }
  return merged;
}

export function getEngineModels(engine: EngineType): EngineModelInfo[] {
  return engine === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
}

export function resolveEngineModels(
  engine: EngineType,
  models?: EngineModelInfo[] | null,
): EngineModelInfo[] {
  return Array.isArray(models) && models.length > 0 ? models : getEngineModels(engine);
}

export function getDefaultEngineModel(
  engine: EngineType,
  models?: EngineModelInfo[] | null,
): EngineModelInfo | null {
  const resolved = resolveEngineModels(engine, models);
  return resolved.find((item) => item.isDefault) ?? resolved[0] ?? null;
}

export function getEngineModelInfo(
  engine: EngineType,
  modelId: string | null | undefined,
  models?: EngineModelInfo[] | null,
): EngineModelInfo | null {
  const normalizedModelId = String(modelId ?? "").trim();
  if (!normalizedModelId) return null;
  const resolved = resolveEngineModels(engine, models);
  const model = resolved.find((item) => item.id === normalizedModelId);
  if (model) return model;
  // 同模型历史别名（如 deepseek-flash[1m]）静默归一：返回合并后的条目本身，不标注下线、不改写保存的 ID。
  const aliasedId = engine === "claude" ? CLAUDE_SILENT_MODEL_ALIASES[normalizedModelId] : null;
  if (aliasedId) return resolved.find((item) => item.id === aliasedId) ?? null;
  const replacementId = engine === "claude" ? CLAUDE_LEGACY_MODEL_REPLACEMENTS[normalizedModelId] : null;
  const replacement = replacementId ? resolved.find((item) => item.id === replacementId) : null;
  return replacement ? {
    ...replacement,
    id: normalizedModelId,
    displayName: `${normalizedModelId}（已下线）`,
    description: `旧模型已退役，官方兼容入口暂由 ${replacement.displayName} 服务；新会话请选择 ${replacementId}`,
    isDefault: false,
  } : null;
}

export function getDefaultReasoningEffortForModel(
  engine: EngineType,
  modelId: string | null | undefined,
  models?: EngineModelInfo[] | null,
): ReasoningEffort | null {
  const model = getEngineModelInfo(engine, modelId, models);
  if (!model) return null;
  return model.defaultReasoningEffort
    ?? model.supportedReasoningEfforts?.[0]?.reasoningEffort
    ?? null;
}

/** 严格校验显式 effort；未知模型仅校验全局枚举，合法 1M 别名复用基型能力。 */
export function assertReasoningEffortSupportedForModel(
  engine: EngineType,
  modelId: string | null | undefined,
  effort: unknown,
  models?: EngineModelInfo[] | null,
): void {
  const rawEffort = String(effort ?? "").trim();
  if (!rawEffort) return;
  const normalizedEffort = normalizeReasoningEffort(rawEffort);
  if (!normalizedEffort) throw new Error(`不支持的思考强度「${rawEffort}」`);

  const normalizedModelId = String(modelId ?? "").trim();
  let model = normalizedModelId
    ? getEngineModelInfo(engine, normalizedModelId, models)
    : getDefaultEngineModel(engine, models);
  if (!model && normalizedModelId.endsWith("[1m]")) {
    const baseModel = getEngineModelInfo(engine, normalizedModelId.slice(0, -4), models);
    if (baseModel && (baseModel.supports1MContext || Number(baseModel.contextWindow ?? 0) >= 1_000_000)) {
      model = baseModel;
    }
  }
  if (!model) return;
  const supported = model.supportedReasoningEfforts ?? [];
  if (!supported.some((item) => item.reasoningEffort === normalizedEffort)) {
    throw new Error(`模型「${model.id}」不支持思考强度「${normalizedEffort}」`);
  }
}

/** 按目录最大窗口生成会话默认值；Fast 由用户显式开启。 */
export function resolveCatalogDefaultThreadPrefs(
  engine: EngineType,
  models?: EngineModelInfo[] | null,
): ResolvedThreadPrefs {
  const defaultModel = getDefaultEngineModel(engine, models);
  const modelId = defaultModel?.id ?? null;
  return {
    model: modelId,
    effort: getDefaultReasoningEffortForModel(engine, modelId, models),
    accessMode: PRODUCT_DEFAULT_THREAD_PREFS.accessMode,
    planMode: PRODUCT_DEFAULT_THREAD_PREFS.planMode,
    autoCompactPct: PRODUCT_DEFAULT_AUTO_COMPACT_PCT,
    contextWindow: getModelContextWindowBounds(engine, defaultModel).maxContextWindow,
    serviceTier: null,
  };
}

/** 解析已知退役型号，再按实际选中的模型补齐窗口、思考强度和服务档位。 */
export function resolveThreadPrefsWithCatalogDefaults(
  engine: EngineType,
  prefs?: ThreadPrefs | null,
  models?: EngineModelInfo[] | null,
): ResolvedThreadPrefs {
  const defaults = resolveCatalogDefaultThreadPrefs(engine, models);
  const model = String(prefs?.model ?? "").trim() || defaults.model;
  const modelInfo = getEngineModelInfo(engine, model, models)
    ?? (model ? getEngineModelInfo(engine, RETIRED_THREAD_MODELS[engine][model], models) : null);
  const resolvedModel = modelInfo?.id ?? model;
  const modelEffort = getDefaultReasoningEffortForModel(engine, resolvedModel, models);
  const effort = resolveThreadPrefsReasoningEffort(
    modelInfo,
    normalizeReasoningEffort(prefs?.effort),
    modelEffort,
    normalizeReasoningEffort(defaults.effort),
  );
  const accessMode = prefs?.accessMode === "read-only" || prefs?.accessMode === "current" || prefs?.accessMode === "full-access"
    ? prefs.accessMode
    : defaults.accessMode;
  const planMode = prefs?.planMode != null ? Boolean(prefs.planMode) : defaults.planMode;
  const rawAutoCompactPct = Number(prefs?.autoCompactPct);
  const autoCompactPct = Number.isFinite(rawAutoCompactPct) && rawAutoCompactPct >= 50 && rawAutoCompactPct <= 99
    ? Math.round(rawAutoCompactPct)
    : defaults.autoCompactPct;
  const contextWindow = normalizeThreadContextWindow(engine, resolvedModel, prefs?.contextWindow, models);
  const serviceTier = normalizeCodexServiceTier(
    engine, resolvedModel, prefs?.serviceTier, models,
  );
  return {
    model: resolvedModel,
    effort,
    accessMode,
    planMode,
    autoCompactPct,
    contextWindow,
    serviceTier,
  };
}

/** 解析线程 effort：目录已知时只保留该模型声明支持的档位。 */
function resolveThreadPrefsReasoningEffort(
  modelInfo: EngineModelInfo | null,
  prefsEffort: ReasoningEffort | null,
  modelEffort: ReasoningEffort | null,
  defaultEffort: ReasoningEffort | null,
): ReasoningEffort | null {
  if (!modelInfo) return prefsEffort ?? defaultEffort;
  if (!prefsEffort) return modelEffort;
  const supported = modelInfo.supportedReasoningEfforts ?? [];
  return supported.some((item) => item.reasoningEffort === prefsEffort) ? prefsEffort : modelEffort;
}

/** 仅在 Codex 且当前模型声明支持 Fast 时保留 fast，否则显式清空。 */
export function normalizeCodexServiceTier(
  engine: EngineType,
  modelId: string | null,
  rawServiceTier: CodexServiceTier | string | null | undefined,
  models?: EngineModelInfo[] | null,
): CodexServiceTier | null {
  if (engine !== "codex" || rawServiceTier !== "fast") return null;
  const normalizedModelId = String(modelId ?? "").trim();
  const modelInfo = normalizedModelId
    ? getEngineModelInfo(engine, normalizedModelId, models)
    : getDefaultEngineModel(engine, models);
  return modelInfo?.supportsFastMode === true ? "fast" : null;
}

/** 会话默认使用目录最大窗口，未声明最大值时使用目录基础容量。 */
export function getModelContextWindowBounds(engine: EngineType, modelInfo: EngineModelInfo | null | undefined): {
  defaultContextWindow: number; minContextWindow: number; maxContextWindow: number;
} {
  const maxContextWindow = Number(modelInfo?.maxContextWindow ?? modelInfo?.contextWindow ?? 200_000);
  const defaultContextWindow = maxContextWindow;
  return { defaultContextWindow, maxContextWindow, minContextWindow: Math.min(engine === "claude" ? 100_000 : 1, maxContextWindow) };
}

/** 没有声明阈值时明确说明，不能从默认上下文推断计费规则。 */
export function getModelContextBillingHint(modelInfo: Pick<EngineModelInfo, "doubleBillingThreshold"> | null | undefined): string {
  const threshold = modelInfo?.doubleBillingThreshold;
  return threshold != null && Number.isSafeInteger(threshold) && threshold > 0
    ? `实际输入上下文超过 ${threshold.toLocaleString()} tokens 时，按双倍计费。`
    : "当前模型未配置双倍计费阈值，费用以供应商实际计费规则为准。";
}

/** 按模型最大能力派生窗口；保留历史参数签名，但不再应用用户覆盖值。 */
export function normalizeThreadContextWindow(
  engine: EngineType,
  modelId: string | null,
  _rawContextWindow: number | null | undefined,
  models?: EngineModelInfo[] | null,
): number {
  const modelInfo = getEngineModelInfo(engine, modelId, models) ?? getDefaultEngineModel(engine, models);
  return getModelContextWindowBounds(engine, modelInfo).maxContextWindow;
}
