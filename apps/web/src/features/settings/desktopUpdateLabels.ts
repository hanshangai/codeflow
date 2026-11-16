import { formatDesktopVersion, type DesktopBundleUpdatePhase, type DesktopShellUpdatePhase, type DesktopUpdateDetails, type DesktopUpdateResult, type DesktopUpdateState } from "@codeflowai/shared";

/** 产品当前版本必须有运行资源与壳事实；缺失时明确标记，不用内部版本或待更新目标代填。 */
export function formatDesktopCurrentVersion(current: DesktopUpdateDetails["current"] | null): string {
  if (!current) return "未知";
  if (!current.bundle?.version.trim()) return "资源版本未标记";
  if (!current.shellVersion?.trim()) return "桌面壳版本未标记";
  return formatDesktopVersion(current.shellVersion, current.bundle.version)!;
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
