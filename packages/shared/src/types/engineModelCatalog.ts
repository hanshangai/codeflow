import type {
  EngineModelInfo,
  EngineModelProviderId,
  EngineType,
  InputModality,
  ReasoningEffort,
  ReasoningEffortOption,
} from "./engine.js";

export const ENGINE_MODEL_CATALOG_SCHEMA_VERSION = "engine-model-catalog/v1" as const;

export type EngineModelRuntimeProfileId =
  | "native"
  | "claude_compatible_single_model"
  | "claude_compatible_tiered"
  | "claude_compatible_required_thinking";

export type EngineModelCatalogItem = {
  catalogItemId: string;
  engine: EngineType;
  providerId: EngineModelProviderId;
  providerLabel: string;
  modelId: string;
  displayName: string;
  description: string;
  inputModalities: InputModality[];
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort | null;
  contextWindow: number | null;
  maxContextWindow: number | null;
  /** 双倍计费的实际输入上下文阈值；空值表示未声明该计费规则。 */
  doubleBillingThreshold?: number | null;
  supportsFastMode: boolean;
  supports1MContext: boolean;
  isDefault: boolean;
  sortOrder: number;
  runtimeProfileId: EngineModelRuntimeProfileId;
  transportModelId: string | null;
  fastTaskModelId: string | null;
  subagentModelId: string | null;
};

export type EngineModelCatalogSnapshot = {
  schemaVersion: typeof ENGINE_MODEL_CATALOG_SCHEMA_VERSION;
  configVersion: number;
  capturedAt: number;
  rows: EngineModelCatalogItem[];
};

export type EngineModelCatalogAppliedAck = {
  configVersion: number;
  digest: string;
  appliedAt: number;
  operationId?: string;
};

/** Client 在目录事务提交前进入派发暂停态后的回执。 */
export type EngineModelCatalogDispatchPauseAck = {
  operationId: string;
  configVersion: number;
  digest: string;
  pausedAt: number;
};

export type EngineModelCatalogSyncState = "applied" | "waiting" | "unsupported" | "offline";

export type EngineModelCatalogValidationIssue = {
  field: string;
  message: string;
};

export class EngineModelCatalogValidationError extends Error {
  readonly code = "ENGINE_MODEL_CATALOG_INVALID";

  constructor(readonly issues: EngineModelCatalogValidationIssue[]) {
    super(issues[0]?.message ?? "模型目录无效");
    this.name = "EngineModelCatalogValidationError";
  }
}

const ENGINES: readonly EngineType[] = ["claude", "codex"];
const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];
const INPUT_MODALITIES: readonly InputModality[] = ["text", "image"];
const RUNTIME_PROFILES: readonly EngineModelRuntimeProfileId[] = [
  "native",
  "claude_compatible_single_model",
  "claude_compatible_tiered",
  "claude_compatible_required_thinking",
];
const PROVIDER_ENGINES: Record<EngineModelProviderId, readonly EngineType[]> = {
  anthropic: ["claude"],
  deepseek: ["claude"],
  moonshot: ["claude"],
  openai: ["codex"],
  qwen: ["claude"],
  zai: ["claude"],
};
const PROVIDER_RUNTIME_PROFILES: Record<EngineModelProviderId, readonly EngineModelRuntimeProfileId[]> = {
  anthropic: ["native"],
  deepseek: ["claude_compatible_single_model", "claude_compatible_tiered"],
  moonshot: ["claude_compatible_single_model", "claude_compatible_required_thinking"],
  openai: ["native"],
  qwen: ["claude_compatible_single_model", "claude_compatible_required_thinking"],
  zai: ["claude_compatible_single_model", "claude_compatible_required_thinking"],
};
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/;
const CATALOG_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

/** 校验完整目录并返回按引擎、顺序归一化的独立副本。 */
export function validateEngineModelCatalogRows(input: unknown): EngineModelCatalogItem[] {
  const issues: EngineModelCatalogValidationIssue[] = [];
  if (!Array.isArray(input)) {
    throw new EngineModelCatalogValidationError([{ field: "rows", message: "模型目录必须为数组" }]);
  }
  if (input.length < 1 || input.length > 500) {
    issues.push({ field: "rows", message: "模型目录必须包含 1 到 500 个模型" });
  }

  const normalized = input.map((row, index) => normalizeRow(row, index, issues));
  const catalogItemIds = new Set<string>();
  const engineModelIds = new Set<string>();

  for (const [index, row] of normalized.entries()) {
    if (catalogItemIds.has(row.catalogItemId)) {
      issues.push({ field: `rows.${index}.catalogItemId`, message: "目录项 ID 不能重复" });
    }
    catalogItemIds.add(row.catalogItemId);

    const engineModelKey = `${row.engine}:${row.modelId.toLowerCase()}`;
    if (engineModelIds.has(engineModelKey)) {
      issues.push({ field: `rows.${index}.modelId`, message: "同一引擎的模型 ID 不能重复" });
    }
    engineModelIds.add(engineModelKey);
  }

  for (const engine of ENGINES) validateEngineRows(engine, normalized.filter((row) => row.engine === engine), issues);
  if (issues.length > 0) throw new EngineModelCatalogValidationError(issues);

  return normalized
    .sort((left, right) => ENGINES.indexOf(left.engine) - ENGINES.indexOf(right.engine) || left.sortOrder - right.sortOrder)
    .map((row) => cloneEngineModelCatalogItem(row));
}

/** 将目录行转换为现有引擎状态接口消费的模型元数据。 */
export function engineModelCatalogRowsToModelInfo(
  rows: readonly EngineModelCatalogItem[],
  engine: EngineType,
): EngineModelInfo[] {
  return rows
    .filter((row) => row.engine === engine)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((row) => ({
      id: row.modelId,
      displayName: row.displayName,
      description: row.description,
      providerId: row.providerId,
      providerLabel: row.providerLabel,
      isDefault: row.isDefault,
      supportedReasoningEfforts: row.supportedReasoningEfforts.map((option) => ({ ...option })),
      defaultReasoningEffort: row.defaultReasoningEffort,
      inputModalities: [...row.inputModalities],
      contextWindow: row.contextWindow ?? undefined,
      maxContextWindow: row.maxContextWindow ?? undefined,
      doubleBillingThreshold: row.doubleBillingThreshold,
      supportsFastMode: row.supportsFastMode,
      supports1MContext: row.supports1MContext,
    }));
}

/**
 * v1 摘要保持既有执行字段集合，覆盖 schema、版本和规范化行。
 * capturedAt 和仅用于计费提示的 doubleBillingThreshold 不参与；新增展示字段不能改变
 * 旧 Client 的摘要算法。阈值变更仍递增 configVersion，并随完整目录推送给 Web/Client。
 */
export function serializeEngineModelCatalogDigestPayload(snapshot: unknown): string {
  const parsed = cloneEngineModelCatalogSnapshot(snapshot);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    configVersion: parsed.configVersion,
    rows: parsed.rows.map((row) => ({
      catalogItemId: row.catalogItemId,
      engine: row.engine,
      providerId: row.providerId,
      providerLabel: row.providerLabel,
      modelId: row.modelId,
      displayName: row.displayName,
      description: row.description,
      inputModalities: row.inputModalities,
      supportedReasoningEfforts: row.supportedReasoningEfforts,
      defaultReasoningEffort: row.defaultReasoningEffort,
      contextWindow: row.contextWindow,
      maxContextWindow: row.maxContextWindow,
      supportsFastMode: row.supportsFastMode,
      supports1MContext: row.supports1MContext,
      isDefault: row.isDefault,
      sortOrder: row.sortOrder,
      runtimeProfileId: row.runtimeProfileId,
      transportModelId: row.transportModelId,
      fastTaskModelId: row.fastTaskModelId,
      subagentModelId: row.subagentModelId,
    })),
  });
}

export function cloneEngineModelCatalogSnapshot(snapshot: unknown): EngineModelCatalogSnapshot {
  if (!isRecord(snapshot)) {
    throw new EngineModelCatalogValidationError([{ field: "catalog", message: "模型目录快照必须为对象" }]);
  }
  if (snapshot.schemaVersion !== ENGINE_MODEL_CATALOG_SCHEMA_VERSION) {
    throw new EngineModelCatalogValidationError([{ field: "schemaVersion", message: "模型目录协议版本不受支持" }]);
  }
  if (typeof snapshot.configVersion !== "number" || !Number.isSafeInteger(snapshot.configVersion) || snapshot.configVersion < 1) {
    throw new EngineModelCatalogValidationError([{ field: "configVersion", message: "模型目录版本无效" }]);
  }
  if (typeof snapshot.capturedAt !== "number" || !Number.isSafeInteger(snapshot.capturedAt) || snapshot.capturedAt < 0) {
    throw new EngineModelCatalogValidationError([{ field: "capturedAt", message: "模型目录时间无效" }]);
  }
  return {
    schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
    configVersion: snapshot.configVersion as number,
    capturedAt: snapshot.capturedAt as number,
    rows: validateEngineModelCatalogRows(snapshot.rows),
  };
}

/** 严格解析 Client 应用回执，避免不可信 WS 数据进入版本匹配逻辑。 */
export function parseEngineModelCatalogAppliedAck(input: unknown): EngineModelCatalogAppliedAck {
  if (!isRecord(input)) {
    throw new EngineModelCatalogValidationError([{ field: "ack", message: "模型目录应用回执必须为对象" }]);
  }
  const issues: EngineModelCatalogValidationIssue[] = [];
  if (!Number.isSafeInteger(input.configVersion) || Number(input.configVersion) < 1) {
    issues.push({ field: "configVersion", message: "模型目录应用版本无效" });
  }
  if (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)) {
    issues.push({ field: "digest", message: "模型目录摘要无效" });
  }
  if (!Number.isSafeInteger(input.appliedAt) || Number(input.appliedAt) < 0) {
    issues.push({ field: "appliedAt", message: "模型目录应用时间无效" });
  }
  const operationId = input.operationId == null ? "" : String(input.operationId).trim();
  if (input.operationId != null && (!operationId || operationId.length > 200)) {
    issues.push({ field: "operationId", message: "模型目录应用操作 ID 无效" });
  }
  if (issues.length) throw new EngineModelCatalogValidationError(issues);
  return {
    configVersion: input.configVersion as number,
    digest: input.digest as string,
    appliedAt: input.appliedAt as number,
    ...(operationId ? { operationId } : {}),
  };
}

function normalizeRow(
  input: unknown,
  index: number,
  issues: EngineModelCatalogValidationIssue[],
): EngineModelCatalogItem {
  const field = (name: keyof EngineModelCatalogItem) => `rows.${index}.${name}`;
  if (!isRecord(input)) issues.push({ field: `rows.${index}`, message: "模型目录项必须为对象" });
  const source = isRecord(input) ? input : {};
  const catalogItemId = readString(source.catalogItemId, field("catalogItemId"), issues);
  const engine = readString(source.engine, field("engine"), issues) as EngineType;
  const providerId = readString(source.providerId, field("providerId"), issues) as EngineModelProviderId;
  const providerLabel = readString(source.providerLabel, field("providerLabel"), issues);
  const modelId = readString(source.modelId, field("modelId"), issues);
  const displayName = readString(source.displayName, field("displayName"), issues);
  const description = readString(source.description, field("description"), issues);
  const inputModalities = readInputModalities(source.inputModalities, field("inputModalities"), issues);
  const supportedReasoningEfforts = readReasoningEfforts(source.supportedReasoningEfforts, field("supportedReasoningEfforts"), issues);
  const defaultReasoningEffort = readNullableString(source.defaultReasoningEffort, field("defaultReasoningEffort"), issues) as ReasoningEffort | null;
  const runtimeProfileId = readString(source.runtimeProfileId, field("runtimeProfileId"), issues) as EngineModelRuntimeProfileId;
  const transportModelId = readNullableString(source.transportModelId, field("transportModelId"), issues);
  const fastTaskModelId = readNullableString(source.fastTaskModelId, field("fastTaskModelId"), issues);
  const subagentModelId = readNullableString(source.subagentModelId, field("subagentModelId"), issues);
  const contextWindow = readNullableNumber(source.contextWindow, field("contextWindow"), issues);
  const maxContextWindow = readNullableNumber(source.maxContextWindow, field("maxContextWindow"), issues);
  const doubleBillingThreshold = source.doubleBillingThreshold == null
    ? null : readNullableNumber(source.doubleBillingThreshold, field("doubleBillingThreshold"), issues);
  const supportsFastMode = readBoolean(source.supportsFastMode, field("supportsFastMode"), issues);
  const supports1MContext = readBoolean(source.supports1MContext, field("supports1MContext"), issues);
  const isDefault = readBoolean(source.isDefault, field("isDefault"), issues);
  const sortOrder = readNumber(source.sortOrder, field("sortOrder"), issues);

  if (!CATALOG_ITEM_ID_PATTERN.test(catalogItemId)) issues.push({ field: field("catalogItemId"), message: "目录项 ID 格式无效" });
  if (!ENGINES.includes(engine)) issues.push({ field: field("engine"), message: "引擎无效" });
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_ENGINES, providerId)) {
    issues.push({ field: field("providerId"), message: "供应商无效" });
  } else if (!PROVIDER_ENGINES[providerId].includes(engine)) {
    issues.push({ field: field("providerId"), message: "供应商不支持当前引擎" });
  }
  if (!providerLabel || providerLabel.length > 120) issues.push({ field: field("providerLabel"), message: "供应商名称长度必须为 1 到 120" });
  validateModelId(modelId, field("modelId"), issues, false);
  if (!displayName || displayName.length > 160) issues.push({ field: field("displayName"), message: "展示名长度必须为 1 到 160" });
  if (description.length > 1000) issues.push({ field: field("description"), message: "说明不能超过 1000 个字符" });
  if (!inputModalities.includes("text")) issues.push({ field: field("inputModalities"), message: "输入模态必须包含 text" });
  if (inputModalities.some((item) => !INPUT_MODALITIES.includes(item))) issues.push({ field: field("inputModalities"), message: "输入模态无效" });
  if (supportedReasoningEfforts.some((item) => !REASONING_EFFORTS.includes(item.reasoningEffort))) {
    issues.push({ field: field("supportedReasoningEfforts"), message: "思考强度无效" });
  }
  if (defaultReasoningEffort !== null && !supportedReasoningEfforts.some((item) => item.reasoningEffort === defaultReasoningEffort)) {
    issues.push({ field: field("defaultReasoningEffort"), message: "默认思考强度必须属于支持列表" });
  }
  validateNullablePositiveInteger(contextWindow, field("contextWindow"), issues);
  validateNullablePositiveInteger(maxContextWindow, field("maxContextWindow"), issues);
  validateNullablePositiveInteger(doubleBillingThreshold, field("doubleBillingThreshold"), issues);
  if (maxContextWindow !== null && (contextWindow === null || maxContextWindow < contextWindow)) {
    issues.push({ field: field("maxContextWindow"), message: "最大上下文窗口不能小于默认上下文窗口" });
  }
  if (engine === "claude" && [contextWindow, maxContextWindow].some((value) =>
    value !== null && (value < 100_000 || value > 1_000_000))) {
    issues.push({ field: field("contextWindow"), message: "Claude 当前支持的上下文窗口范围为 100,000 到 1,000,000 tokens" });
  }
  // 默认窗口本身已达到 1M 时，最大窗口可以与默认窗口相等；此时模型已经具备 1M 能力，
  // 不存在需要再向上扩展的区间。默认窗口低于 1M 时仍要求最大窗口严格更大。
  const validOneMillionContextBounds = contextWindow !== null && maxContextWindow !== null
    && maxContextWindow >= contextWindow
    && (maxContextWindow > contextWindow || contextWindow >= 1_000_000);
  if (supports1MContext && !validOneMillionContextBounds) {
    issues.push({ field: field("maxContextWindow"), message: "扩展上下文上限必须大于默认上下文" });
  }
  if (engine !== "codex" && supportsFastMode) issues.push({ field: field("supportsFastMode"), message: "Fast 模式仅适用于 Codex" });
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 1) issues.push({ field: field("sortOrder"), message: "展示顺序必须为正整数" });
  if (!RUNTIME_PROFILES.includes(runtimeProfileId)) issues.push({ field: field("runtimeProfileId"), message: "运行档案无效" });
  if (runtimeProfileId !== "native" && engine !== "claude") issues.push({ field: field("runtimeProfileId"), message: "兼容运行档案仅适用于 Claude" });
  if (Object.prototype.hasOwnProperty.call(PROVIDER_RUNTIME_PROFILES, providerId)
    && !PROVIDER_RUNTIME_PROFILES[providerId].includes(runtimeProfileId)) {
    issues.push({ field: field("runtimeProfileId"), message: "供应商与运行档案不匹配" });
  }
  validateModelId(transportModelId, field("transportModelId"), issues, true);
  validateModelId(fastTaskModelId, field("fastTaskModelId"), issues, true);
  validateModelId(subagentModelId, field("subagentModelId"), issues, true);
  if (runtimeProfileId === "claude_compatible_tiered") {
    if (!transportModelId || !fastTaskModelId || !subagentModelId) {
      issues.push({ field: field("runtimeProfileId"), message: "分层运行档案必须配置主模型、快速任务和子代理模型 ID" });
    }
  } else if (fastTaskModelId || subagentModelId) {
    issues.push({ field: field("runtimeProfileId"), message: "当前运行档案不能配置分层模型 ID" });
  }

  return {
    catalogItemId,
    engine,
    providerId,
    providerLabel,
    modelId,
    displayName,
    description,
    inputModalities,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    contextWindow,
    maxContextWindow,
    ...(doubleBillingThreshold != null ? { doubleBillingThreshold } : {}),
    supportsFastMode,
    supports1MContext,
    isDefault,
    sortOrder,
    runtimeProfileId,
    transportModelId,
    fastTaskModelId,
    subagentModelId,
  };
}

function validateEngineRows(
  engine: EngineType,
  rows: readonly EngineModelCatalogItem[],
  issues: EngineModelCatalogValidationIssue[],
): void {
  if (rows.length < 1) {
    issues.push({ field: "rows", message: `${engine} 至少需要一个模型` });
    return;
  }
  if (rows.filter((row) => row.isDefault).length !== 1) {
    issues.push({ field: "rows", message: `${engine} 必须且只能有一个默认模型` });
  }
  const ordered = [...rows].sort((left, right) => left.sortOrder - right.sortOrder);
  ordered.forEach((row, index) => {
    if (row.sortOrder !== index + 1) issues.push({ field: "rows", message: `${engine} 的展示顺序必须从 1 连续递增` });
  });
  const completedProviders = new Set<EngineModelProviderId>();
  let activeProvider: EngineModelProviderId | null = null;
  for (const row of ordered) {
    if (activeProvider === row.providerId) continue;
    if (completedProviders.has(row.providerId)) {
      issues.push({ field: "rows", message: `${engine} 的同供应商模型必须连续排列` });
      break;
    }
    if (activeProvider) completedProviders.add(activeProvider);
    activeProvider = row.providerId;
  }
}

function cloneEngineModelCatalogItem(row: EngineModelCatalogItem): EngineModelCatalogItem {
  return {
    ...row,
    inputModalities: [...row.inputModalities],
    supportedReasoningEfforts: row.supportedReasoningEfforts.map((option) => ({ ...option })),
  };
}

function readReasoningEfforts(value: unknown, field: string, issues: EngineModelCatalogValidationIssue[]): ReasoningEffortOption[] {
  if (!Array.isArray(value)) {
    issues.push({ field, message: "思考强度必须为数组" });
    return [];
  }
  const byEffort = new Map<ReasoningEffort, ReasoningEffortOption>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      issues.push({ field: `${field}.${index}`, message: "思考强度项必须为对象" });
      continue;
    }
    const effort = readString(item.reasoningEffort, `${field}.${index}.reasoningEffort`, issues) as ReasoningEffort;
    const description = readString(item.description, `${field}.${index}.description`, issues);
    if (byEffort.has(effort)) issues.push({ field, message: "思考强度不能重复" });
    else byEffort.set(effort, { reasoningEffort: effort, description });
  }
  return [...byEffort.values()];
}

function readInputModalities(value: unknown, field: string, issues: EngineModelCatalogValidationIssue[]): InputModality[] {
  if (!Array.isArray(value)) {
    issues.push({ field, message: "输入模态必须为数组" });
    return [];
  }
  const result: InputModality[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") issues.push({ field: `${field}.${index}`, message: "输入模态必须为字符串" });
    else if (!result.includes(item as InputModality)) result.push(item as InputModality);
  }
  return result;
}

function readString(value: unknown, field: string, issues: EngineModelCatalogValidationIssue[]): string {
  if (typeof value !== "string") {
    issues.push({ field, message: "字段必须为字符串" });
    return "";
  }
  return value.trim();
}

function readNullableString(value: unknown, field: string, issues: EngineModelCatalogValidationIssue[]): string | null {
  if (value === null) return null;
  return readString(value, field, issues) || null;
}

function readBoolean(value: unknown, field: string, issues: EngineModelCatalogValidationIssue[]): boolean {
  if (typeof value !== "boolean") {
    issues.push({ field, message: "字段必须为布尔值" });
    return false;
  }
  return value;
}

function readNumber(value: unknown, field: string, issues: EngineModelCatalogValidationIssue[]): number {
  if (typeof value !== "number") {
    issues.push({ field, message: "字段必须为数字" });
    return Number.NaN;
  }
  return value;
}

function readNullableNumber(value: unknown, field: string, issues: EngineModelCatalogValidationIssue[]): number | null {
  if (value === null) return null;
  return readNumber(value, field, issues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateModelId(
  value: string | null,
  field: string,
  issues: EngineModelCatalogValidationIssue[],
  nullable: boolean,
): void {
  if (nullable && value === null) return;
  if (!value || value.length > 160 || !MODEL_ID_PATTERN.test(value)) {
    issues.push({ field, message: "模型 ID 格式无效" });
  }
}

function validateNullablePositiveInteger(
  value: number | null | undefined,
  field: string,
  issues: EngineModelCatalogValidationIssue[],
): void {
  if (value === null || value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > POSTGRES_INTEGER_MAX) {
    issues.push({ field, message: `上下文窗口必须为 1 到 ${POSTGRES_INTEGER_MAX} 的整数` });
  }
}
