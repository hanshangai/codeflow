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

/** 本机应用版本与更新弹窗同源；缺少事实返回 null，不能借目标工作区Client号代填。 */
export function resolveDesktopAppVersionLabel(details: DesktopUpdateDetails | null | undefined): string | null {
  const shellVersion = details?.current.shellVersion?.trim();
  const bundleVersion = details?.current.bundle?.version.trim();
  if (!shellVersion || !bundleVersion || shellVersion === "unknown" || bundleVersion === "unknown") return null;
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
