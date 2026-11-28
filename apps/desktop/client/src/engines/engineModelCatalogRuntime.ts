import crypto from "node:crypto";
import {
  getDefaultReasoningEffortForModel,
  getEngineModelInfo,
  getEngineModels,
  mergeEngineModelsWithCustomModels,
  toEngineModelInfoFromCustomModel,
  resolveCatalogDefaultThreadPrefs,
  resolveRetiredEngineModelId,
  resolveRoleExecutionConfigForEngine,
  resolveRoleExecutionConfigForStrategy,
  resolveThreadPrefsWithCatalogDefaults,
  type EngineCustomModelEntry,
  type EngineModelInfo,
  type EngineModelProviderId,
  type EngineType,
  type OrchestrationExecutionEngineStrategy,
  type ResolvedRoleExecutionConfig,
  type ResolvedThreadPrefs,
  type RoleExecutionConfig,
  type ThreadPrefs,
} from "@codeflowai/shared";

/**
 * 模型目录运行时只保留本地内置模型与本机自定义模型。
 * 兼容导出保留到调用点清理完成；不再维护 Server 快照、版本、租约或暂停状态。
 */
const COMPAT_CATALOG_VERSION = 1;

let customModelsByEngine: Record<EngineType, EngineModelInfo[]> = { claude: [], codex: [] };

/** 桌面启动占位；模型恒为本地内置，无需初始化同步状态。 */
export function initializeLocalEngineModelCatalog(): void {}

/** 账号撤销不再影响模型表；保留导出供既有调用点过渡。 */
export function clearDesktopCloudEngineModelCatalog(): void {}

/** 兼容旧调用：不再保存快照，仅回显版本与输入摘要。 */
export function applyEngineModelCatalogSnapshot(
  value: unknown,
  appliedAt = Date.now(),
  operationId?: string,
): { configVersion: number; digest: string; appliedAt: number; operationId?: string } {
  const configVersion = Number((value as { configVersion?: unknown } | null)?.configVersion);
  return {
    configVersion: Number.isSafeInteger(configVersion) && configVersion > 0 ? configVersion : COMPAT_CATALOG_VERSION,
    digest: crypto.createHash("sha256").update(JSON.stringify(value ?? null), "utf8").digest("hex"),
    appliedAt,
    ...(operationId ? { operationId } : {}),
  };
}

/** 更新本地自定义模型；内置模型始终优先且不依赖连接状态。 */
export function setEngineModelCatalogCustomModels(entries: EngineCustomModelEntry[]): void {
  customModelsByEngine = {
    claude: entries.filter((entry) => entry.enabled && entry.engine === "claude").map(toEngineModelInfoFromCustomModel),
    codex: entries.filter((entry) => entry.enabled && entry.engine === "codex").map(toEngineModelInfoFromCustomModel),
  };
}

/** 兼容旧调用：发布暂停已无意义，直接回执。 */
export async function pauseEngineModelCatalogDispatch(input: {
  operationId: string;
  configVersion: number;
  digest: string;
}, pausedAt = Date.now()): Promise<{ operationId: string; configVersion: number; digest: string; pausedAt: number }> {
  const operationId = String(input.operationId ?? "").trim();
  if (!operationId) throw catalogRuntimeError("ENGINE_MODEL_CATALOG_PAUSE_INVALID", "模型目录派发暂停操作缺少 operationId");
  return { operationId, configVersion: input.configVersion, digest: input.digest, pausedAt };
}

/** 兼容旧调用：无暂停状态可取消。 */
export function cancelEngineModelCatalogDispatchPause(_operationId: string): void {}

/** 兼容旧调用：重连不再冻结模型表。 */
export function pauseEngineModelCatalogDispatchForReconnect(_operationId: string): string | null {
  return null;
}

/** 本地模型恒可用，不存在等待目录同步的阶段。 */
export async function waitForEngineModelCatalogDispatchReady(): Promise<void> {}

/** 兼容旧调用：本地模型租约为空操作。 */
export async function acquireEngineModelCatalogDispatchLease(_selection?: { engine: EngineType; model?: string | null }): Promise<{
  configVersion: number;
  digest: string;
  release: () => void;
}> {
  return { configVersion: 0, digest: "local", release: () => {} };
}

/** 兼容旧调用：本地模型在派发期间不会发生目录版本切换。 */
export function assertEngineModelCatalogDispatchLeaseCurrent(
  _expected: { configVersion: number; digest: string },
  _current: { configVersion: number; digest: string },
): void {}

/** 兼容旧调用：无需向 Server 确认目录已应用。 */
export function confirmEngineModelCatalogApplied(_input: {
  operationId?: string | null;
  configVersion: number;
  digest: string;
}): void {}

/** 本地模型没有 Server 运行档案。 */
export function getRuntimeEngineModelCatalogItem(
  _engine: EngineType,
  _modelId: string | null | undefined,
): null {
  return null;
}

/** 从内置 + 自定义模型解析 provider。 */
export function resolveRuntimeEngineModelProviderId(
  engine: EngineType,
  modelId: string | null | undefined,
): EngineModelProviderId {
  const models = getRuntimeEngineModels(engine);
  const normalized = String(modelId ?? "").trim();
  const modelInfo = normalized ? getRuntimeEngineModelInfo(engine, normalized) : models.find((model) => model.isDefault) ?? null;
  if (modelInfo?.providerId) return modelInfo.providerId;
  throw catalogRuntimeError(
    normalized ? "ENGINE_MODEL_NOT_AVAILABLE" : "ENGINE_MODEL_CATALOG_INVALID",
    normalized
      ? `模型「${normalized}」已从当前目录移除，请重新选择模型`
      : `当前 ${engine} 模型目录缺少默认模型`,
  );
}

/** 发送、偏好保存和编排共用本地有效模型表。 */
export function assertRuntimeEngineModelAvailable(engine: EngineType, modelId: string | null | undefined): void {
  const models = getRuntimeEngineModels(engine);
  const normalized = String(modelId ?? "").trim();
  if (!normalized) return;
  if (getEngineModelInfo(engine, normalized, models)) return;
  if (normalized.endsWith("[1m]") && getRuntimeEngineModelInfo(engine, normalized)) return;
  throw catalogRuntimeError("ENGINE_MODEL_NOT_AVAILABLE", `模型「${normalized}」已从当前目录移除，请重新选择模型`);
}

/** 返回内置 + 本机自定义模型。 */
export function getRuntimeEngineModels(engine: EngineType): EngineModelInfo[] {
  return getLocalEngineModels(engine).map(cloneEngineModelInfo);
}

/** 本地模型恒就绪。 */
export function getRuntimeEngineModelsIfReady(engine: EngineType): EngineModelInfo[] | null {
  return getRuntimeEngineModels(engine);
}

/** 从本地模型解析元数据，保留 1M 别名合成。 */
export function getRuntimeEngineModelInfo(
  engine: EngineType,
  modelId: string | null | undefined,
): EngineModelInfo | null {
  const normalized = String(modelId ?? "").trim();
  const models = getRuntimeEngineModels(engine);
  const direct = getEngineModelInfo(engine, normalized, models);
  if (direct || !normalized.endsWith("[1m]")) return direct;
  const base = models.find((model) => model.id === normalized.slice(0, -4));
  if (!base || (!base.supports1MContext
    && base.contextWindow !== 1_000_000 && base.maxContextWindow !== 1_000_000)) return null;
  return {
    ...base,
    id: normalized,
    contextWindow: base.maxContextWindow ?? 1_000_000,
    maxContextWindow: base.maxContextWindow ?? 1_000_000,
  };
}

/** 会话默认项、effort、窗口和 Fast 档位统一从本地模型派生。 */
export function resolveRuntimeThreadPrefsWithCatalogDefaults(
  engine: EngineType,
  prefs?: ThreadPrefs | null,
): ResolvedThreadPrefs {
  return resolveThreadPrefsWithCatalogDefaults(engine, prefs, getRuntimeEngineModels(engine));
}

/** 编排 auto 档案按本地模型解析默认项。 */
export function resolveRuntimeRoleExecutionConfigForEngine(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  engine: EngineType,
  fallbackPreferredEngine: EngineType = "codex",
): ResolvedRoleExecutionConfig {
  return applyRuntimeAutoDefaults(resolveRoleExecutionConfigForEngine(raw, engine, fallbackPreferredEngine));
}

/** 按编排策略选择引擎后，再从本地模型解析 auto 默认项。 */
export function resolveRuntimeRoleExecutionConfigForStrategy(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  strategy: OrchestrationExecutionEngineStrategy | null | undefined,
  fallbackEngine: EngineType = "codex",
): ResolvedRoleExecutionConfig {
  return applyRuntimeAutoDefaults(resolveRoleExecutionConfigForStrategy(raw, strategy, fallbackEngine));
}

function applyRuntimeAutoDefaults(config: ResolvedRoleExecutionConfig): ResolvedRoleExecutionConfig {
  if (config.sourceMode !== "auto") {
    const model = resolveRetiredEngineModelId(config.engine, config.model) ?? config.model;
    assertRuntimeEngineModelAvailable(config.engine, model);
    return { ...config, model };
  }
  const models = getRuntimeEngineModels(config.engine);
  const defaults = resolveCatalogDefaultThreadPrefs(config.engine, models);
  if (!defaults.model) {
    throw catalogRuntimeError("ENGINE_MODEL_CATALOG_INVALID", `当前 ${config.engine} 模型目录缺少默认模型`);
  }
  return {
    ...config,
    model: defaults.model,
    effort: getDefaultReasoningEffortForModel(config.engine, defaults.model, models) ?? "",
  };
}

/** 兼容旧调用：本地模型没有 Server 快照。 */
export function getActiveEngineModelCatalogSnapshot(): null {
  return null;
}

/** 兼容旧调用：本地模型没有目录发布暂停。 */
export function getEngineModelCatalogDispatchPauseOperationId(): string | null {
  return null;
}

/** 仅供单元测试隔离全局自定义模型。 */
export function resetEngineModelCatalogRuntimeForTest(): void {
  customModelsByEngine = { claude: [], codex: [] };
}

/** 沿既有内置优先规则合并本机自定义模型，不另建运行档案。 */
function getLocalEngineModels(engine: EngineType): EngineModelInfo[] {
  return mergeEngineModelsWithCustomModels(engine, getEngineModels(engine), customModelsByEngine[engine]);
}

function cloneEngineModelInfo(model: EngineModelInfo): EngineModelInfo {
  return {
    ...model,
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
    supportedReasoningEfforts: model.supportedReasoningEfforts?.map((option) => ({ ...option })),
  };
}

function catalogRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
