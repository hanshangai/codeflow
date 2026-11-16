import type { EngineStatus, EngineType } from "@codeflowai/shared";

export type LocalModelSetupInput = {
  isDesktop: boolean;
  localRuntimeReady: boolean;
  hasActiveSession: boolean;
  desktopCloudAccountLinked: boolean;
  keyStoreLoading: boolean;
  keyStoreError: string | null;
  engineStatusLoading: boolean;
  /** 当前工作区已维护的 Key（含未启用），用于保留“已维护但未启用”的精确提示。 */
  hasKeysByEngine: Record<EngineType, boolean>;
  activeProviderIdsByEngine: Record<EngineType, readonly string[]>;
  statuses: Partial<Record<EngineType, EngineStatus>>;
};

export type LocalModelSetupGuideInput = LocalModelSetupInput & {
  /** 当前是否为本机工作区；浏览器或共享工作区不展示应用级引导。 */
  isDesktopLocalWorkspace: boolean;
  publicView: boolean;
  settingsOpen: boolean;
  workspaceSwitching: boolean;
  authModalOpen: boolean;
  /** 引擎与 Key 状态已完成一次成功刷新，避免把未知态当成未配置。 */
  stateReady: boolean;
};

const ENGINES: EngineType[] = ["claude", "codex"];

/**
 * 仅在桌面本机、未登录，且所有已安装引擎都完全没有 Key/原生登录配置时提示配置模型。
 * 已维护但未启用、原生登录失效或状态读取失败时返回 false，交由引擎级提示说明具体原因。
 */
export function needsLocalModelSetup(input: LocalModelSetupInput): boolean {
  if (!input.isDesktop || !input.localRuntimeReady) return false;
  if (input.hasActiveSession || input.desktopCloudAccountLinked) return false;
  if (input.keyStoreLoading || input.keyStoreError || input.engineStatusLoading) return false;

  // 任一引擎状态未知时保持静默，避免把未加载完的状态当作“未配置”。
  if (ENGINES.some((engine) => !input.statuses[engine])) return false;
  // 未安装引擎的残留 Key/旧凭据不代表可用配置；至少一个引擎可执行才提示。
  const installedEngines = ENGINES.filter((engine) => input.statuses[engine]?.installed);
  if (installedEngines.length === 0) return false;

  return installedEngines.every((engine) => {
    const status = input.statuses[engine]!;
    // 旧 Client 没有凭据事实时不能判定为“无配置”。
    if (status.providerCredentialStatus === undefined && status.credentialStatus === undefined) return false;
    if (input.activeProviderIdsByEngine[engine].length > 0) return false;
    if (input.hasKeysByEngine[engine]) return false;
    if (status.credentialStatus?.available) return false;
    // 曾存在本地登录/凭据但当前不可用：保留引擎级错误，不误报为未配置。
    if (status.credentialStatus && status.credentialStatus.source !== "none") return false;
    const providers = status.providerCredentialStatus;
    if (providers?.some((provider) => provider.available)) return false;
    if (providers?.some((provider) => provider.sources.some((source) => source !== "none"))) return false;
    return true;
  });
}

/** 应用级引导在基础判定之外排除公开页、设置弹窗、工作区切换与登录弹框，并要求状态已刷新。 */
export function shouldShowLocalModelSetupGuide(input: LocalModelSetupGuideInput): boolean {
  if (!input.stateReady || input.publicView || input.settingsOpen || input.workspaceSwitching || input.authModalOpen) return false;
  if (!input.isDesktopLocalWorkspace) return false;
  return needsLocalModelSetup(input);
}
