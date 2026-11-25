import { describeUserFacingError, formatDesktopVersion, type DesktopBundleUpdatePhase, type DesktopShellUpdatePhase, type DesktopUpdateDetails, type DesktopUpdateResult, type DesktopUpdateState } from "@codeflowai/shared";

/** 产品当前版本必须有运行资源与壳事实；缺失时明确标记，不用内部版本或待更新目标代填。 */
export function formatDesktopCurrentVersion(current: DesktopUpdateDetails["current"] | null): string {
  if (!current) return "未知";
  if (!current.bundle?.version.trim()) return "资源版本未标记";
  if (!current.shellVersion?.trim()) return "桌面壳版本未标记";
  return formatDesktopVersion(current.shellVersion, current.bundle.version)!;
}

export type DesktopUpdateOutcome = { tone: "success" | "error" | "warning" | "info"; title: string; detail: string };

/** 弹框与设置页共用宿主事实；历史目标不改变无更新结论，未知结果不能推成下载中或成功。 */
export function resolveDesktopUpdateOutcome(input: {
  details: DesktopUpdateDetails | null; state: DesktopUpdateState | null; isMacDesktop: boolean; checking?: boolean;
}): DesktopUpdateOutcome {
  const { details: value, state, isMacDesktop } = input;
  const failure = state?.updateCheckFailure ?? state?.shellUpdateFailure ?? value?.bundle.failure ?? value?.shell.failure;
  const running = input.checking || state?.checking || state?.operation === "checking" || state?.operation === "downloading" || state?.operation === "updating";
  if (running) {
    const phase = (value?.bundle.result === "unknown" ? value.bundle.phase : null)
      ?? (value?.shell.result === "unknown" ? value.shell.phase : null);
    const title = phase === "download" || state?.operation === "downloading" ? "正在下载更新"
      : phase && ["verify", "compatibility", "health"].includes(phase) ? "正在校验更新"
      : phase && !["discovery", "read-active"].includes(phase) ? "正在准备更新" : "正在检查更新";
    return { tone: failure ? "warning" : "info", title, detail: failure
      ? "部分更新失败：" + describeUserFacingError(failure.rootCause, "请在更新设置查看诊断。") + "其他更新仍在继续。"
      : "你可以继续使用 CodeFlow，更新会在后台继续。" };
  }
  const applied = value?.bundle.result === "healthy" ? "应用内容已更新，桌面壳更新未完成。" : "";
  if (failure) return { tone: "error", title: "更新未完成", detail: applied
    + describeUserFacingError(failure.rootCause, "更新失败，请重试或查看诊断。") };
  if (!value) return { tone: "info", title: "尚未检查更新", detail: "点击检查更新，获取可用版本。" };
  const channels = [value.bundle, value.shell];
  const latest = (result: DesktopUpdateResult) => result === "none" || result === "same";
  const failed = channels.find(channel => channel.result === "failure" || channel.result === "unavailable");
  if (failed) {
    const phase = failed.phase;
    const title = phase === "download" ? "下载更新失败" : phase === "verify" || phase === "compatibility" ? "更新校验失败"
      : phase === "discovery" || phase === "read-active" || !phase ? "检查更新失败" : "更新未完成";
    return { tone: "error", title, detail: applied + "请重试；如果仍然失败，可在更新设置查看诊断。" };
  }
  if (channels.some(channel => channel.result === "restored")) {
    return { tone: "warning", title: "更新未完成", detail: "新版本未通过健康检查，已恢复原版本。" };
  }
  if (channels.some(channel => channel.result === "revoked")) {
    return { tone: "warning", title: "更新未完成", detail: "该更新已被撤回，请重新检查可用版本。" };
  }
  if (channels.some(channel => channel.result === "prepared" && channel.target)) {
    return { tone: "success", title: "新版本已下载，重启后生效",
      detail: !isMacDesktop && value.bundle.result === "prepared" && value.shell.result === "prepared"
        ? "资源和桌面壳已下载并校验完成，一次重启即可完成更新。"
        : !isMacDesktop && value.bundle.result === "prepared"
          ? "应用内容已下载并校验完成，重启后生效，并继续检查桌面壳更新。"
          : "更新已下载并校验完成，可以立即重启，也可以稍后重启。" };
  }
  if (channels.some(channel => channel.result === "cancelled" || channel.result === "postponed")) {
    return { tone: "warning", title: "更新未完成", detail: channels.some(channel => channel.result === "cancelled")
      ? "本次更新已取消，继续使用当前版本。" : "本次更新已暂缓，可以稍后重新检查。" };
  }
  if (channels.some(channel => channel.result === "manual_required")) {
    return { tone: "info", title: "需要手动安装更新", detail: (isMacDesktop && (latest(value.bundle.result) || value.bundle.result === "healthy")
      ? `${value.bundle.result === "healthy" ? "应用内容已更新" : "应用内容已是最新"}，macOS 桌面程序` : "当前桌面程序") + "请通过完整安装包手动更新。" };
  }
  if (latest(value.bundle.result) && latest(value.shell.result)) {
    return { tone: "success", title: "当前已是最新版本", detail: "无需下载或安装更新" };
  }
  if ((latest(value.bundle.result) || value.bundle.result === "healthy") && (latest(value.shell.result) || value.shell.result === "healthy")) {
    return { tone: "success", title: "更新已生效", detail: "你正在使用更新后的版本。" };
  }
  if (channels.every(channel => channel.result === "unknown" && !channel.requestId && !channel.phase && !channel.target)) {
    return { tone: "info", title: "尚未检查更新", detail: "点击检查更新，获取可用版本。" };
  }
  const incomplete = value.shell.result === "unknown" && (latest(value.bundle.result) || value.bundle.result === "healthy")
    ? `${value.bundle.result === "healthy" ? "应用内容已更新" : "应用内容已是最新"}，桌面壳尚未检查，检查结果不完整，请重新检查。`
    : "更新检查结果不完整，请重新检查。";
  return { tone: "error", title: "检查更新失败", detail: incomplete };
}

/** 更新操作/结果/阶段的统一中文文案，设置页与托盘弹框共用。 */
export const desktopUpdateOperationLabels: Record<DesktopUpdateState["operation"], string> = {
  idle: "空闲", starting: "启动中", exiting: "退出中", checking: "检查中", updating: "更新中", downloading: "下载中", flushing: "补报中",
};

export const desktopUpdateResultLabels: Record<DesktopUpdateResult, string> = {
  unknown: "尚未取得结果", none: "未发现可用更新", same: "目标与当前版本相同", postponed: "本轮暂缓",
  revoked: "目标已撤销", failure: "更新失败", prepared: "已准备，等待重启", healthy: "已激活，健康检查通过", restored: "已回退恢复", unavailable: "更新不可用",
  manual_required: "需要人工处理", cancelled: "已取消",
};

export const desktopBundlePhaseLabels: Record<DesktopBundleUpdatePhase, string> = {
  discovery: "查询目标", download: "下载应用资源", prepare: "准备更新", "read-active": "读取当前资源", verify: "验证资源",
  compatibility: "检查兼容性", "prepare-directory": "准备资源目录", drain: "等待在途操作结束", "restart-client": "重启 Client",
  "reload-web": "重载 Web", health: "健康检查", activate: "激活资源", rollback: "回退资源",
};

export const desktopShellPhaseLabels: Record<DesktopShellUpdatePhase, string> = {
  prepare: "准备壳更新", download: "下载桌面壳", install: "安装桌面壳", health: "健康检查", handoff: "交接桌面壳",
  "admission-intent": "记录更新准入", recovery: "恢复桌面壳",
};
