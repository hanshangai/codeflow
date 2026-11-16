import {
  getDefaultEngineProviderId,
  getEngineProviderLabel,
  type EngineModelInfo,
  type EngineModelProviderId,
  type EngineStatus,
  type EngineType,
} from "@codeflowai/shared";

export type EngineKeyActivationState = {
  isSharedWorkspace: boolean;
  hasMaintainedKeys: boolean;
  activeProviderIds: string[];
  keyLoadError?: string | null;
};

export const ENGINE_LABELS: Record<EngineType, string> = {
  claude: "Claude",
  codex: "Codex",
};

const NATIVE_PROVIDER_BY_ENGINE: Record<EngineType, EngineModelProviderId> = {
  claude: "anthropic",
  codex: "openai",
};

/** 兼容新旧 Client，判断本次 CLI 探测是否因超时而结论未知。 */
export function isEngineDetectionTimeout(status: EngineStatus | null | undefined): boolean {
  if (!status) return false;
  if (status.detectionStatus === "timeout") return true;
  return status.detectionStatus == null
    && !status.installed
    && normalizeEngineStatusIssue(status.error).toLowerCase() === "timeout";
}

/** 超时时沿用上次已确认的安装与能力状态，同时保留本次失败详情。 */
export function mergeEngineStatusAfterDetection(
  previous: EngineStatus | null | undefined,
  incoming: EngineStatus,
): EngineStatus {
  if (!isEngineDetectionTimeout(incoming) || !previous?.installed) return incoming;
  return {
    ...incoming,
    installed: true,
    version: previous.version,
    binPath: previous.binPath,
    features: { ...previous.features },
  };
}

/** 明确未安装且不是超时未知态时才允许硬阻断；超时仍按可尝试处理。 */
export function isEngineCliConfirmedMissing(status: EngineStatus | null | undefined): boolean {
  return Boolean(status && !status.installed && !isEngineDetectionTimeout(status));
}

/** 生成 CLI 状态提示；探测超时可尝试，明确缺失则直接阻止发送。 */
export function resolveEngineCliStatusIssue(
  engine: EngineType,
  status: EngineStatus | null | undefined,
): string | null {
  if (!status) return null;
  const label = ENGINE_LABELS[engine];
  if (isEngineDetectionTimeout(status)) {
    if (status.installed) {
      return `提示：${label} CLI 状态刷新超时，已沿用上次可用状态，实际运行以执行结果为准。`;
    }
    return `提示：${label} CLI 状态检测超时，当前状态未知，仍可尝试发送，实际运行以执行结果为准。`;
  }
  if (status.installed) return null;
  return `${label} CLI 未安装或无法启动`;
}

/** 判断输入框是否允许图片；超时时按模型目录判断，不把未知状态误报为不支持。 */
export function resolveEngineImageInputAllowed(
  engine: EngineType,
  status: EngineStatus | null | undefined,
  model: EngineModelInfo | null | undefined,
): boolean {
  const modalities = engine === "codex" ? model?.inputModalities : null;
  const modelAllowsImages = !modalities?.length || modalities.includes("image");
  if (!status || isEngineDetectionTimeout(status)) return modelAllowsImages;
  if (!status.features.imageInput) return false;
  return modelAllowsImages;
}

/** 压缩 CLI 检测返回结果，避免长 stderr 撑开输入区。 */
function normalizeEngineStatusIssue(value: string | null | undefined): string {
  const normalized = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

/** 解析当前引擎可用 provider；返回 null 表示旧 Client 未提供凭据状态，保持兼容展示。 */
export function resolveAvailableModelProviderIds(
  engine: EngineType,
  status: EngineStatus | null | undefined,
  keyState: EngineKeyActivationState,
): EngineModelProviderId[] | null {
  const providerStatus = status?.providerCredentialStatus;
  const ids = new Set<EngineModelProviderId>();
  if (!keyState.keyLoadError) {
    for (const providerId of keyState.activeProviderIds) {
      ids.add(providerId as EngineModelProviderId);
    }
  }
  for (const provider of providerStatus ?? []) {
    if (provider.available) ids.add(provider.providerId);
  }
  if (ids.size > 0) return [...ids];
  if (providerStatus || status?.credentialStatus) return [];
  if (keyState.keyLoadError || keyState.hasMaintainedKeys) return [];
  return null;
}

/** 解析 Host Client 明确返回的凭据不可用提示；旧 Client 未返回状态时不强行拦截。 */
export function resolveEngineCredentialIssue(engine: EngineType, status: EngineStatus | null | undefined): string | null {
  const providerStatus = status?.providerCredentialStatus;
  if (providerStatus) {
    const nativeProviderId = NATIVE_PROVIDER_BY_ENGINE[engine];
    return providerStatus.find((item) => item.providerId === nativeProviderId)?.message
      ?? providerStatus.find((item) => item.message)?.message
      ?? buildMaintainKeyMessage(engine);
  }
  const credential = status?.credentialStatus;
  if (!credential || credential.available) return null;
  return credential.message || buildMaintainKeyMessage(engine);
}

/** 解析 Key 未启用或 Key 状态读取失败导致的不可用提示。 */
export function resolveEngineKeyActivationIssue(
  engine: EngineType,
  status: EngineStatus | null | undefined,
  keyState: EngineKeyActivationState,
): string | null {
  const availableProviderIds = resolveAvailableModelProviderIds(engine, status, keyState);
  if (availableProviderIds?.length) return null;
  if (keyState.keyLoadError) return `无法读取大模型 Key 配置：${keyState.keyLoadError}`;
  if (!keyState.hasMaintainedKeys || keyState.activeProviderIds.length > 0) return null;
  return `${ENGINE_LABELS[engine]} 已维护 Key 但未启用，请到“模型配置”启用 Key。`;
}

/** 汇总引擎执行前的不可用原因，优先给出已维护 Key 未启用的精确提示。 */
export function resolveEngineUnavailableIssue(
  engine: EngineType,
  status: EngineStatus | null | undefined,
  keyState: EngineKeyActivationState,
): string | null {
  const availableProviderIds = resolveAvailableModelProviderIds(engine, status, keyState);
  if (availableProviderIds?.length) return null;
  return resolveEngineKeyActivationIssue(engine, status, keyState)
    ?? resolveEngineCredentialIssue(engine, status);
}

/** 给没有本机原生登录且未启用 Key 的场景提供稳定提示。 */
export function buildMaintainKeyMessage(engine: EngineType): string {
  const label = ENGINE_LABELS[engine];
  const providerLabel = getEngineProviderLabel(getDefaultEngineProviderId(engine));
  if (engine === "codex") {
    return `${label} 未启用，请到“模型配置”新增或启用 ${providerLabel} Key；如果已在本机 Codex OAuth 登录，请刷新引擎状态或检查 Host Client 是否读取到该登录。`;
  }
  return `${label} 未启用，请到“模型配置”新增或启用 ${providerLabel} Key；如果已在本机 Claude OAuth 登录，请刷新引擎状态或检查 Host Client 是否读取到该登录。`;
}
