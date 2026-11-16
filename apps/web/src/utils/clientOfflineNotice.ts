import { message } from "ant-design-vue";
import type { ActiveWorkspaceRuntimeState } from "../store/presence";

const WORKSPACE_CLIENT_OFFLINE_MESSAGE_KEY = "workspace-client-offline";
const WORKSPACE_CLIENT_OFFLINE_NOTICE = "当前工作区 Client 未连接，连接后会自动恢复。";
const WORKSPACE_CLIENT_OFFLINE_NOTICE_COOLDOWN_MS = 10_000;
let lastWorkspaceClientOfflineNoticeAt = Number.NEGATIVE_INFINITY;

/** 判断错误是否来自当前工作区 Client 离线，供自动刷新链路降噪使用。 */
export function isWorkspaceClientOfflineError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /CLIENT_OFFLINE|client 未连接|Client 未连接|Client 未在线|请先连接 Client/.test(text);
}

/** 按当前工作区运行态生成不可用提示；共享工作区只描述 Host，不引导成员安装 Client。 */
export function resolveWorkspaceRuntimeUnavailableMessage(
  runtime: ActiveWorkspaceRuntimeState,
  messages: { local: string; sharedOffline: string },
): string {
  if (runtime.kind !== "shared") return messages.local;
  if (runtime.status === "unbound") return "共享工作区尚未绑定执行主机，请联系工作区管理员处理。";
  if (runtime.status === "forbidden") return "当前账号暂无该共享工作区访问权限，请联系企业管理员。";
  if (runtime.status === "unknown") return "正在确认共享工作区 Host 状态，请稍后重试。";
  return messages.sharedOffline;
}

/** 用户主动操作遇到工作区 Client 离线时，合并提示并限制短时间重复弹出。 */
export function notifyWorkspaceClientOffline(messageText = WORKSPACE_CLIENT_OFFLINE_NOTICE, now = Date.now()): void {
  if (now >= lastWorkspaceClientOfflineNoticeAt
    && now - lastWorkspaceClientOfflineNoticeAt < WORKSPACE_CLIENT_OFFLINE_NOTICE_COOLDOWN_MS) return;
  lastWorkspaceClientOfflineNoticeAt = now;
  message.info({
    key: WORKSPACE_CLIENT_OFFLINE_MESSAGE_KEY,
    content: messageText,
    duration: 3,
  });
}
