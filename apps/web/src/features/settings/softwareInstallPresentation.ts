import { compareNumericVersion, type SoftwareInstallEnvironment, type SoftwareUpdateStatus } from "@codeflowai/shared";

/** 判断当前安装环境是否启用应用私有安装模式。 */
export function isPrivateInstallMode(environment: SoftwareInstallEnvironment | null | undefined): boolean {
  return environment?.installMode === "private";
}

/** 将私有清单给出的安装体积格式化为界面文案；不可展示的值返回空字符串。 */
export function formatCliInstallSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  return `约 ${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * 安装按钮文案。
 * 私有模式下已安装且无更新时允许重新安装，避免用户被“已安装”禁用状态卡住。
 */
export function privateInstallActionLabel(item: SoftwareUpdateStatus, privateMode: boolean): string {
  if (privateMode) {
    if (!item.installed) return "安装";
    if (item.updateAvailable || privateInstallUpdateAvailable(item, true)) return "更新";
    return "重新安装";
  }
  if (!item.installed) return "安装";
  if (item.updateAvailable) return "更新";
  return "已安装";
}

/** 私有模式清单版本高于当前安装版本时按更新展示；降级或同版本仍使用重新安装。 */
export function privateInstallUpdateAvailable(item: SoftwareUpdateStatus, privateMode: boolean): boolean {
  return privateMode && Boolean(item.installed && item.currentVersion && item.latestVersion
    && compareNumericVersion(item.latestVersion, item.currentVersion) > 0);
}
