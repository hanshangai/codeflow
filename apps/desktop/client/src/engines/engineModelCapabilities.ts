import { assertReasoningEffortSupportedForModel, type EngineType } from "@codeflowai/shared";

import { assertRuntimeEngineModelAvailable, getRuntimeEngineModels } from "./engineModelCatalogRuntime.js";

type EngineModelCapabilityDb = { engineCustomModels?: unknown };

/** 按本地内置 + 自定义模型校验 effort；数据库参数保留给既有调用点。 */
export function assertClientReasoningEffortSupported(
  _db: EngineModelCapabilityDb,
  engine: EngineType,
  modelId: string | null | undefined,
  effort: unknown,
): void {
  const normalizedModelId = String(modelId ?? "").trim();
  assertRuntimeEngineModelAvailable(engine, normalizedModelId);
  assertReasoningEffortSupportedForModel(engine, normalizedModelId, effort, getRuntimeEngineModels(engine));
}
