import type { TerminalListFailure } from "../../store/terminal";

/** 格式化账号级终端加载失败详情，保留 Client、工作区和错误原因。 */
export function formatTerminalListFailures(failures: TerminalListFailure[]): string {
  return failures
    .map((failure) => `${failure.clientId || "未知 Client"}/${failure.workspaceId || "未知工作区"}：${failure.message}`)
    .join("\n");
}

/** 仅允许当前创建请求对应的错误清除本窗口等待状态。 */
export function shouldClearPendingCreate(pendingRequestId: string | null, errorRequestId?: string): boolean {
  return Boolean(errorRequestId && errorRequestId === pendingRequestId);
}

/** 按工具栏可用宽度计算 Tab 容量，并预留溢出菜单按钮宽度。 */
export function calculateTerminalTabCapacity(barWidth: number, toolsWidth: number, terminalCount: number): number {
  const tabWidth = 138;
  const moreButtonWidth = 32;
  const availableWithoutMore = Math.max(0, barWidth - toolsWidth);
  const needsMore = terminalCount * tabWidth > availableWithoutMore;
  const availableForTabs = Math.max(0, availableWithoutMore - (needsMore ? moreButtonWidth : 0));
  return Math.max(1, Math.floor(availableForTabs / tabWidth));
}

/** 选择顶部可见 Tab，并保证当前终端在溢出时仍然可见。 */
export function selectDisplayedTerminalKeys(keys: string[], activeKey: string | null, capacity: number): string[] {
  if (!Number.isFinite(capacity) || keys.length <= capacity) return keys;
  const displayed = keys.slice(0, capacity);
  if (activeKey && keys.includes(activeKey) && !displayed.includes(activeKey)) {
    displayed[displayed.length - 1] = activeKey;
  }
  return displayed;
}
