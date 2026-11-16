import type { EngineModelProviderId, EngineType } from "./engine.js";
import { ENGINE_MODEL_PROVIDERS } from "../engineCatalog.js";

export type RelayPricingEmptyReason = "NO_PRICE_CONFIG";
export type RelayPricingCurrency = "CNY";
export type RelayPricingCostUnit = "micro_yuan";

export type RelayPricingErrorCode =
  | "PRICE_CONFIG_INVALID"
  | "PRICE_CONFIG_CONFLICT"
  | "PRICE_CONFIG_NOT_FOUND";

export type RelayPriceConfiguredBy = {
  userId: string;
  email: string | null;
};

export type RelayModelPriceView = {
  id: string;
  providerId: EngineModelProviderId | null;
  currency: RelayPricingCurrency;
  supplier: string;
  modelVendor: string;
  modelVersion: string;
  multimodal: boolean;
  inputCachedPriceMilliYuanPerMillionTokens: number;
  inputUncachedPriceMilliYuanPerMillionTokens: number;
  outputPriceMilliYuanPerMillionTokens: number;
  remark: string;
  sortOrder: number;
  updatedAt: number;
  configuredBy: RelayPriceConfiguredBy;
};

export type RelayPricingCatalogRow = {
  priceConfigId: string;
  providerId: EngineModelProviderId;
  modelVersion: string;
  currency: RelayPricingCurrency;
  inputCachedPriceMilliYuanPerMillionTokens: number;
  inputUncachedPriceMilliYuanPerMillionTokens: number;
  outputPriceMilliYuanPerMillionTokens: number;
};

/** Server 下发给 Client 的可计价目录；仅包含具备稳定 provider 的价格行。 */
export type RelayPricingCatalogSnapshot = {
  schemaVersion: "relay-pricing-catalog/v1";
  configVersion: number | null;
  capturedAt: number;
  rows: RelayPricingCatalogRow[];
};

/** 每轮模型调用冻结的价格事实，历史成本只允许由此快照复算。 */
export type RelayInvocationPriceSnapshot = RelayPricingCatalogRow & {
  schemaVersion: "relay-invocation-price/v1";
  configVersion: number;
  costUnit: RelayPricingCostUnit;
  capturedAt: number;
};

export type RelayTokenUsageForCost = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
};

/** 按稳定 provider/model 从最新目录冻结本轮调用价格，不匹配时保持 unavailable。 */
export function resolveRelayInvocationPriceSnapshot(input: {
  catalog: RelayPricingCatalogSnapshot | null;
  providerId: EngineModelProviderId;
  model: string | null;
  capturedAt: number;
}): RelayInvocationPriceSnapshot | null {
  const model = String(input.model ?? "").trim().toLowerCase();
  if (!input.catalog || input.catalog.configVersion == null || !model) return null;
  const matches = input.catalog.rows.filter((row) =>
    row.providerId === input.providerId && row.modelVersion.trim().toLowerCase() === model
  );
  if (matches.length !== 1) return null;
  const row = matches[0]!;
  return {
    ...row,
    schemaVersion: "relay-invocation-price/v1",
    configVersion: input.catalog.configVersion,
    costUnit: "micro_yuan",
    capturedAt: input.capturedAt,
  };
}

/** 选择单调最新的目录；旧版本忽略，同版本内容不一致视为合同冲突。 */
export function selectLatestRelayPricingCatalogSnapshot(
  current: RelayPricingCatalogSnapshot | null,
  next: RelayPricingCatalogSnapshot,
): RelayPricingCatalogSnapshot {
  if (!current) return next;
  const currentVersion = current.configVersion;
  const nextVersion = next.configVersion;
  if (currentVersion !== null && (nextVersion === null || nextVersion < currentVersion)) return current;
  if (currentVersion !== null && nextVersion === currentVersion) {
    if (JSON.stringify(current.rows) !== JSON.stringify(next.rows)) {
      throw new Error(`Relay 价格目录版本冲突：version=${currentVersion}`);
    }
    return current;
  }
  return next;
}

/** 以人民币微元计算成本；Claude 输入 token 不含缓存，Codex 输入 token 包含缓存。 */
export function calculateRelayCostMicros(
  engine: EngineType,
  usage: RelayTokenUsageForCost,
  snapshot: RelayInvocationPriceSnapshot,
): number {
  const inputTokens = requireNonNegativeSafeInteger(usage.inputTokens, "inputTokens");
  const outputTokens = requireNonNegativeSafeInteger(usage.outputTokens, "outputTokens");
  const cachedInputTokens = requireNonNegativeSafeInteger(usage.cachedInputTokens, "cachedInputTokens");
  const cacheCreationInputTokens = requireNonNegativeSafeInteger(usage.cacheCreationInputTokens, "cacheCreationInputTokens");
  if (engine === "codex" && cachedInputTokens > inputTokens) {
    throw new Error("Codex cachedInputTokens 不能大于 inputTokens");
  }
  const uncachedInputTokens = engine === "codex"
    ? inputTokens - cachedInputTokens + cacheCreationInputTokens
    : inputTokens + cacheCreationInputTokens;
  const numerator = (
    uncachedInputTokens * requireNonNegativeSafeInteger(snapshot.inputUncachedPriceMilliYuanPerMillionTokens, "inputUncachedPrice")
    + cachedInputTokens * requireNonNegativeSafeInteger(snapshot.inputCachedPriceMilliYuanPerMillionTokens, "inputCachedPrice")
    + outputTokens * requireNonNegativeSafeInteger(snapshot.outputPriceMilliYuanPerMillionTokens, "outputPrice")
  );
  if (!Number.isSafeInteger(numerator)) throw new Error("Relay 成本计算超过安全整数范围");
  return Math.round(numerator / 1_000);
}

/** 校验价格目录的运行时边界，拒绝损坏或未知版本的 Server 消息。 */
export function requireRelayPricingCatalogSnapshot(value: unknown): RelayPricingCatalogSnapshot {
  const record = requireRecord(value, "Relay 价格目录");
  if (record.schemaVersion !== "relay-pricing-catalog/v1") throw new Error("Relay 价格目录版本无效");
  const configVersion = record.configVersion == null ? null : requirePositiveSafeInteger(record.configVersion, "configVersion");
  const capturedAt = requirePositiveSafeInteger(record.capturedAt, "capturedAt");
  if (!Array.isArray(record.rows)) throw new Error("Relay 价格目录 rows 必须为数组");
  if (record.rows.length > 200) throw new Error("Relay 价格目录最多支持 200 行");
  const seen = new Set<string>();
  const rows = record.rows.map((value, index): RelayPricingCatalogRow => {
    const row = requireRecord(value, `Relay 价格目录第 ${index + 1} 行`);
    const priceConfigId = requireText(row.priceConfigId, "priceConfigId");
    const providerId = requireText(row.providerId, "providerId") as EngineModelProviderId;
    if (!ENGINE_MODEL_PROVIDERS[providerId]) throw new Error(`Relay 价格目录第 ${index + 1} 行 providerId 无效`);
    const modelVersion = requireText(row.modelVersion, "modelVersion");
    if (row.currency !== "CNY") throw new Error(`Relay 价格目录第 ${index + 1} 行币种无效`);
    const key = `${providerId}\u0000${modelVersion.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Relay 价格目录第 ${index + 1} 行 provider/model 重复`);
    seen.add(key);
    return {
      priceConfigId,
      providerId,
      modelVersion,
      currency: "CNY",
      inputCachedPriceMilliYuanPerMillionTokens: requireNonNegativeSafeInteger(row.inputCachedPriceMilliYuanPerMillionTokens, "inputCachedPrice"),
      inputUncachedPriceMilliYuanPerMillionTokens: requireNonNegativeSafeInteger(row.inputUncachedPriceMilliYuanPerMillionTokens, "inputUncachedPrice"),
      outputPriceMilliYuanPerMillionTokens: requireNonNegativeSafeInteger(row.outputPriceMilliYuanPerMillionTokens, "outputPrice"),
    };
  });
  if (rows.length > 0 && configVersion == null) throw new Error("非空 Relay 价格目录必须包含配置版本");
  return { schemaVersion: "relay-pricing-catalog/v1", configVersion, capturedAt, rows };
}

/** 校验 Prompt Snapshot 中冻结的单次调用价格，供采集端和 Server 复核共用。 */
export function requireRelayInvocationPriceSnapshot(value: unknown): RelayInvocationPriceSnapshot {
  const record = requireRecord(value, "Relay 调用价格快照");
  if (record.schemaVersion !== "relay-invocation-price/v1") throw new Error("Relay 调用价格快照版本无效");
  if (record.currency !== "CNY" || record.costUnit !== "micro_yuan") throw new Error("Relay 调用价格快照币种或成本单位无效");
  return {
    schemaVersion: "relay-invocation-price/v1",
    priceConfigId: requireText(record.priceConfigId, "priceConfigId"),
    configVersion: requirePositiveSafeInteger(record.configVersion, "configVersion"),
    providerId: requireProviderId(record.providerId, "providerId"),
    modelVersion: requireText(record.modelVersion, "modelVersion"),
    currency: "CNY",
    costUnit: "micro_yuan",
    inputCachedPriceMilliYuanPerMillionTokens: requireNonNegativeSafeInteger(record.inputCachedPriceMilliYuanPerMillionTokens, "inputCachedPrice"),
    inputUncachedPriceMilliYuanPerMillionTokens: requireNonNegativeSafeInteger(record.inputUncachedPriceMilliYuanPerMillionTokens, "inputUncachedPrice"),
    outputPriceMilliYuanPerMillionTokens: requireNonNegativeSafeInteger(record.outputPriceMilliYuanPerMillionTokens, "outputPrice"),
    capturedAt: requirePositiveSafeInteger(record.capturedAt, "capturedAt"),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须为对象`);
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function requireProviderId(value: unknown, label: string): EngineModelProviderId {
  const providerId = requireText(value, label) as EngineModelProviderId;
  if (!ENGINE_MODEL_PROVIDERS[providerId]) throw new Error(`${label}无效`);
  return providerId;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new Error(`${label}必须为非负安全整数`);
  return numberValue;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const numberValue = requireNonNegativeSafeInteger(value, label);
  if (numberValue <= 0) throw new Error(`${label}必须大于 0`);
  return numberValue;
}

export type RelayPricingCurrentResponseBody = {
  rows: RelayModelPriceView[];
  serverNow: number;
  emptyReason: RelayPricingEmptyReason | null;
};
