import { createHash } from "node:crypto";

import { CLAUDE_MODELS, CODEX_MODELS } from "./engineCatalog.js";
import type { EngineModelInfo, EngineType } from "./types/engine.js";
import {
  validateEngineModelCatalogRows,
  type EngineModelCatalogItem,
  type EngineModelRuntimeProfileId,
} from "./types/engineModelCatalog.js";

const REQUIRED_THINKING_MODELS = new Set([
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "glm-5.3",
  "glm-5.3-flash",
]);

const INITIAL_ENGINE_MODEL_CATALOG_V1_DIGEST = "1eb9da490779503b2dc7cebf1169b79bb80b757f2dd7429fda7d881f8c47444d";

// v106 写入时该模型的窗口为 1,050,000；运行期目录调整不能改写历史迁移种子。
const v106CodexModels = CODEX_MODELS.map((model) => model.id === "gpt-6.1-sol"
  ? { ...model, contextWindow: 1_050_000, maxContextWindow: 1_050_000 }
  : model);

/** v106 一次性迁移种子；固定摘要阻止未来静态目录变化悄悄改写历史迁移。 */
const initialRows = validateEngineModelCatalogRows([
  ...toSeedRows("claude", CLAUDE_MODELS),
  ...toSeedRows("codex", v106CodexModels),
]);
const initialRowsDigest = createHash("sha256").update(JSON.stringify(initialRows), "utf8").digest("hex");
if (initialRowsDigest !== INITIAL_ENGINE_MODEL_CATALOG_V1_DIGEST) {
  throw new Error("v106 模型目录迁移种子已变化；历史迁移种子禁止随运行期静态目录更新");
}
export const INITIAL_ENGINE_MODEL_CATALOG_V1: readonly EngineModelCatalogItem[] = initialRows;

function toSeedRows(engine: EngineType, models: readonly EngineModelInfo[]): EngineModelCatalogItem[] {
  return models.map((model, index) => {
    const runtimeProfileId = resolveRuntimeProfile(engine, model);
    const transportModelId = resolveTransportModelId(runtimeProfileId, model);
    const tiered = runtimeProfileId === "claude_compatible_tiered";
    return {
      catalogItemId: createSeedCatalogItemId(engine, model.id),
      engine,
      providerId: requireProviderId(model),
      providerLabel: requireProviderLabel(model),
      modelId: model.id,
      displayName: model.displayName,
      description: model.description ?? "",
      inputModalities: [...(model.inputModalities ?? ["text"])],
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((option) => ({ ...option })),
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
      contextWindow: model.contextWindow ?? null,
      maxContextWindow: model.maxContextWindow ?? null,
      supportsFastMode: model.supportsFastMode === true,
      supports1MContext: model.supports1MContext === true,
      isDefault: model.isDefault,
      sortOrder: index + 1,
      runtimeProfileId,
      transportModelId,
      fastTaskModelId: tiered ? "deepseek-flash[1m]" : null,
      subagentModelId: tiered ? "deepseek-flash[1m]" : null,
    };
  });
}

function createSeedCatalogItemId(engine: EngineType, modelId: string): string {
  const digest = createHash("sha256").update(`${engine}\u0000${modelId}`, "utf8").digest("hex").slice(0, 24);
  return `seed:${engine}:${digest}`;
}

function resolveRuntimeProfile(engine: EngineType, model: EngineModelInfo): EngineModelRuntimeProfileId {
  if (engine === "codex" || model.providerId === "anthropic") return "native";
  if (model.providerId === "deepseek" && model.id === "deepseek-v4-pro") return "claude_compatible_tiered";
  if (REQUIRED_THINKING_MODELS.has(model.id.replace(/\[1m\]$/, ""))) return "claude_compatible_required_thinking";
  return "claude_compatible_single_model";
}

function resolveTransportModelId(profile: EngineModelRuntimeProfileId, model: EngineModelInfo): string | null {
  if (profile === "native") return null;
  if (profile === "claude_compatible_tiered") return "deepseek-v4-pro[1m]";
  if (model.contextWindow === 1_000_000 && !model.id.endsWith("[1m]")) return `${model.id}[1m]`;
  return model.id;
}

function requireProviderId(model: EngineModelInfo): NonNullable<EngineModelInfo["providerId"]> {
  if (!model.providerId) throw new Error(`模型迁移种子缺少供应商：${model.id}`);
  return model.providerId;
}

function requireProviderLabel(model: EngineModelInfo): string {
  const label = String(model.providerLabel ?? "").trim();
  if (!label) throw new Error(`模型迁移种子缺少供应商名称：${model.id}`);
  return label;
}
