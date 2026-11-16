import type {
  ConversationApprovalRequest,
  ConversationItem,
  ConversationUserInputRequest,
  ThreadId,
  TokenUsageState,
} from "../index.js";

export type TodolistRow = {
  step: string;
  status: string;
  statusLabel: string;
  statusColor: "green" | "blue" | "default";
};

export type ThreadConversationState = {
  threadId: ThreadId;
  items: ConversationItem[];
  /** 会话级删除事实，阻止迟到正文和分页缓存恢复消息。 */
  deletedMessageIds?: Set<string>;
  tokenUsage: TokenUsageState | null;
  runningTurnId: string | null;
  /** turn 开始时间戳（用于 UI 展示耗时）。 */
  runningTurnStartedAt: number | null;
  /** 已完成的 turnId 集合（用于控制”回滚”按钮仅对 completed turn 生效）。 */
  completedTurnIds: Record<string, true>;
  /** 引擎侧会话标识（用于 resume / 排障展示）。 */
  engineSessionId: string | null;
  /** 当前会话最新的 todolist 状态（由 todowrite/update_plan 工具事件驱动更新）。 */
  currentTodolist: { explanation: string; rows: TodolistRow[] } | null;
  /** 引擎会话已永久失效，此会话仅供查看。 */
  invalidated: boolean;
  /** 内部索引：itemId → items 数组中的对象引用，用于 O(1) 查找（不对外暴露）。 */
  _indexById: Map<string, ConversationItem>;
  /** Codex 原始 assistant itemId → turn 级 transcript itemId。 */
  _assistantTranscriptIdByItemId: Map<string, string>;
  /** Codex turnId → turn 级 transcript itemId。 */
  _assistantTranscriptIdByTurnId: Map<string, string>;
};

export type PendingInteractionItem = ConversationApprovalRequest | ConversationUserInputRequest;
export type PendingInteractionDisplayOwner = "assistant-helper" | "timeline";

/** 判断会话是否正在运行中（turn 已开始且尚未完成/出错）。 */
export function isConversationRunning(conv: ThreadConversationState | null | undefined): boolean {
  return Boolean(conv?.runningTurnId && conv?.runningTurnStartedAt);
}

function isPendingInteractionItem(item: ConversationItem | null | undefined): item is PendingInteractionItem {
  if (!item) return false;
  if (item.kind === "approvalRequest") return item.state === "pending";
  if (item.kind === "userInputRequest") return item.state === "pending";
  return false;
}

/** 异步问题独立于回合存活；同步交互只在运行回合内待处理。 */
export function getPendingInteractionItems(conv: ThreadConversationState | null | undefined): PendingInteractionItem[] {
  if (!conv?.items?.length) return [];
  return conv.items.filter((item): item is PendingInteractionItem => isPendingInteractionItem(item)
    && (Boolean(conv.runningTurnId) || item.kind === "userInputRequest" && item.delivery === "async"));
}

export function getPendingUserInputItems(conv: ThreadConversationState | null | undefined): ConversationUserInputRequest[] {
  return getPendingInteractionItems(conv).filter((item): item is ConversationUserInputRequest => item.kind === "userInputRequest");
}

export function getConversationItemsForMessageList(
  conv: ThreadConversationState | null | undefined,
  opts?: { pendingInteractionOwner?: PendingInteractionDisplayOwner },
): ConversationItem[] {
  const items = conv?.items ?? [];
  if ((opts?.pendingInteractionOwner ?? "timeline") !== "assistant-helper") return items;
  return items.filter((item) => !isPendingInteractionItem(item));
}

export function getPendingInteractionState(conv: ThreadConversationState | null | undefined): "approval" | "userInput" | null {
  const items = getPendingInteractionItems(conv);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "approvalRequest") return "approval";
    if (item.kind === "userInputRequest") return "userInput";
  }
  return null;
}

/** 异步提问允许引擎继续执行，不能显示为等待用户后暂停。 */
export function isConversationAwaitingInteraction(conv: ThreadConversationState | null | undefined): boolean {
  return getPendingInteractionItems(conv).some(item => item.kind !== "userInputRequest" || item.delivery !== "async");
}

export function isConversationActivelyProcessing(conv: ThreadConversationState | null | undefined): boolean {
  return isConversationRunning(conv) && !isConversationAwaitingInteraction(conv);
}

