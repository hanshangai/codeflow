/**
 * 会话工作流卡片「已结束折叠成一行摘要」的纯判定。
 *
 * 白名单折叠：只有已验收、执行失败、已终止三种终态才折叠；其余（含 status 为空）一律保留完整卡片，
 * 避免把推荐卡、交接卡、启动中或实例已被清理的卡误收成一行。
 * 人工信号优先：存在待办或待确认返工时永不折叠 —— 否则用户点不到「确认返工」，即使 accepted 已为真。
 */

import { CHAT_WORKFLOW_ACTIVE_STATUSES, type ChatWorkflowView } from "@codeflowai/shared";

/** 该卡是否折叠成一行摘要：已结束且无任何需要人工推进的信号。 */
export function isChatWorkflowCardFoldable(view: ChatWorkflowView): boolean {
  if (view.todos.length > 0 || view.task.rework) return false;
  if (!view.status) return false;
  if (CHAT_WORKFLOW_ACTIVE_STATUSES.has(view.status)) return false;
  if (view.status === "completed") return view.accepted;
  // 余下只有 failed / cancelled 两种终态，都不再需要人工推进。
  return true;
}

/** 折叠行是否处于折叠态：可折叠且用户未手动展开。 */
export function isChatWorkflowCardFolded(view: ChatWorkflowView, expandedTaskIds: ReadonlySet<string>): boolean {
  return isChatWorkflowCardFoldable(view) && !expandedTaskIds.has(view.task.id);
}

/** 渲染前过滤：只剔除「可折叠 且 已隐藏」的卡（安全阀：不可折叠的一律重新出现）。 */
export function visibleChatWorkflowCards(
  views: readonly ChatWorkflowView[],
  hiddenTaskIds: ReadonlySet<string>,
): ChatWorkflowView[] {
  return views.filter(view => !(hiddenTaskIds.has(view.task.id) && isChatWorkflowCardFoldable(view)));
}
