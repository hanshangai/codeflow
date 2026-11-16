import {
  createDefaultRoleExecutionCustomConfig,
  resolveRoleExecutionConfigForEngine,
  resolveRoleExecutionConfigForStrategy,
  type EngineModelInfo,
  type EngineType,
  type OrchestrationExecutionEngineStrategy,
  type ResolvedRoleExecutionConfig,
  type RoleExecutionConfig,
  type RoleExecutionCustomConfig,
} from "@codeflowai/shared";

/** 从 Server 动态目录选择默认模型；空目录必须保持为空，不能回退 Shared 静态清单。 */
export function resolveCatalogDefaultModel(models: readonly EngineModelInfo[]): EngineModelInfo | null {
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

/** 角色切换到自定义模式时，以动态目录默认项初始化模型相关字段。 */
export function createCatalogRoleExecutionCustomConfig(
  engine: EngineType,
  models: readonly EngineModelInfo[],
): RoleExecutionCustomConfig {
  const base = createDefaultRoleExecutionCustomConfig(engine);
  const model = resolveCatalogDefaultModel(models);
  return {
    ...base,
    model: model?.id ?? "",
    effort: model?.defaultReasoningEffort ?? "",
  };
}

/** 把 auto 档案的静态兼容默认值替换为 Server 动态目录默认项。 */
export function applyCatalogRoleExecutionDefaults(
  config: ResolvedRoleExecutionConfig,
  models: readonly EngineModelInfo[],
): ResolvedRoleExecutionConfig {
  if (config.sourceMode !== "auto") return config;
  const model = resolveCatalogDefaultModel(models);
  return {
    ...config,
    model: model?.id ?? "",
    effort: model?.defaultReasoningEffort ?? "",
  };
}

export function resolveCatalogRoleExecutionConfigForEngine(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  engine: EngineType,
  models: readonly EngineModelInfo[],
  fallbackPreferredEngine: EngineType = "codex",
): ResolvedRoleExecutionConfig {
  const resolved = resolveRoleExecutionConfigForEngine(raw, engine, fallbackPreferredEngine);
  if (resolved.sourceMode === "auto") return applyCatalogRoleExecutionDefaults(resolved, models);
  const rawCustom = raw?.engineProfiles?.[engine]?.customConfig ?? null;
  const modelId = String(rawCustom?.model ?? "").trim();
  const model = models.find((item) => item.id === modelId) ?? null;
  const hasExplicitEffort = Boolean(
    rawCustom && Object.prototype.hasOwnProperty.call(rawCustom as Record<string, unknown>, "effort"),
  );
  return {
    ...resolved,
    model: modelId,
    effort: hasExplicitEffort
      ? String(rawCustom?.effort ?? "").trim()
      : model?.defaultReasoningEffort ?? "",
  };
}

export function resolveCatalogRoleExecutionConfigForStrategy(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  strategy: OrchestrationExecutionEngineStrategy | null | undefined,
  modelsForEngine: (engine: EngineType) => readonly EngineModelInfo[],
  fallbackEngine: EngineType = "codex",
): ResolvedRoleExecutionConfig {
  const resolved = resolveRoleExecutionConfigForStrategy(raw, strategy, fallbackEngine);
  return resolveCatalogRoleExecutionConfigForEngine(
    raw,
    resolved.engine,
    modelsForEngine(resolved.engine),
    fallbackEngine,
  );
}
