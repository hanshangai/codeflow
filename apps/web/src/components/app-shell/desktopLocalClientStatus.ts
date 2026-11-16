import { describeUserFacingError, formatDesktopVersion, type DesktopRuntimeStatus, type DesktopUpdateDetails } from "@codeflowai/shared";

export type DesktopLocalPopoverInput = {
  isDesktop: boolean;
  hasActiveSession: boolean;
  isCurrentSharedWorkspace: boolean;
};

/** 桌面未登录本机模式没有 Server presence，Client 管理不适用，改展示本机应用状态。 */
export function shouldShowDesktopLocalClientPopover(input: DesktopLocalPopoverInput): boolean {
  return input.isDesktop && !input.hasActiveSession && !input.isCurrentSharedWorkspace;
}

/** 本机版本优先取桌面运行时事实，其次使用服务端下发版本。 */
export function resolveDesktopClientVersionLabel(
  desktopVersion: string | null | undefined,
  serverVersion: string | null | undefined,
): string {
  return desktopVersion?.trim() || serverVersion?.trim() || "未知";
}

/** 本机应用版本与更新弹窗同源；旧壳缺少壳或资源版本时返回 null 由调用方回退。 */
export function resolveDesktopAppVersionLabel(details: DesktopUpdateDetails | null | undefined): string | null {
  const shellVersion = details?.current.shellVersion?.trim();
  const bundleVersion = details?.current.bundle?.version.trim();
  if (!shellVersion || !bundleVersion) return null;
  return formatDesktopVersion(shellVersion, bundleVersion);
}

/** 区分启动/停止等瞬态与真实失败，避免未就绪时一律提示重启。 */
export function resolveDesktopRuntimeStatusHint(input: {
  ready: boolean;
  status: DesktopRuntimeStatus | null | undefined;
  error: string | null | undefined;
}): string | null {
  if (input.ready) return null;
  switch (input.status) {
    case "starting":
    case "running":
      return "本机运行环境正在启动，请稍候。";
    case "draining":
      return "本机运行环境正在停止或切换，请稍候。";
    case "stopped":
      return "本机运行环境已停止，请重新启动 CodeFlow。";
    case "failed":
      return describeUserFacingError(input.error, "本机运行环境启动失败，请重启 CodeFlow 后重试。", true);
    default:
      return describeUserFacingError(input.error, "本机运行环境未就绪，请稍后重试。", true);
  }
}
