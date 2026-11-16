import {
  assertReasoningEffortSupportedForModel,
  toEngineModelInfoFromCustomModel,
  type EngineType,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import { assertRuntimeEngineModelAvailable, getRuntimeEngineModels, getRuntimeEngineModelsIfReady } from "./engineModelCatalogRuntime.js";

type EngineModelCapabilityDb = {
  engineCustomModels?: Pick<ClientDb["engineCustomModels"], "getByEngineModel">;
};

/** 优先按动态目录校验；目录尚未同步时仅用本地自定义模型完成启动期校验。 */
export function assertClientReasoningEffortSupported(
  db: EngineModelCapabilityDb,
  engine: EngineType,
  modelId: string | null | undefined,
  effort: unknown,
): void {
  const normalizedModelId = String(modelId ?? "").trim();
  const runtimeModels = getRuntimeEngineModelsIfReady(engine);
  if (!runtimeModels) {
    const baseModelId = normalizedModelId.endsWith("[1m]") ? normalizedModelId.slice(0, -4) : normalizedModelId;
    const custom = db.engineCustomModels?.getByEngineModel(engine, baseModelId);
    if (custom?.enabled) {
      assertReasoningEffortSupportedForModel(engine, normalizedModelId, effort, [toEngineModelInfoFromCustomModel(custom)]);
      return;
    }
  }
  assertRuntimeEngineModelAvailable(engine, normalizedModelId);
  assertReasoningEffortSupportedForModel(engine, normalizedModelId, effort, runtimeModels ?? getRuntimeEngineModels(engine));
}
