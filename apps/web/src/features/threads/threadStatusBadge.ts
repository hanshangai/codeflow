import type { ChatWorkflowActiveStatus, ThreadWorkflowState } from "@codeflowai/shared";

/** 会话列表行标签色调；与 thread-list.vue 的 `thread-list__status-badge--<tone>` 一一对应。 */
export type ThreadListStatusTone = "running" | "info" | "warning" | "danger" | "success" | "neutral";
export type ThreadListStatusBadge = {
  label: string;
  tone: ThreadListStatusTone;
};

/**
 * 会话工作流活跃档位 → 列表行标签。
 * 文案用会话列表自身的词汇（待确认/待补充），与工作流面板词表（待审核等）不同，两者不共用。
 * 记录类型在编译期覆盖全部活跃档位：共享枚举新增状态时会直接报错，而不是运行时退化为无标签。
 */
const CHAT_WORKFLOW_BADGES: Record<ChatWorkflowActiveStatus, ThreadListStatusBadge> = {
  running: { label: "运行中", tone: "running" },
  "waiting-approval": { label: "待确认", tone: "info" },
  "waiting-feedback": { label: "待补充", tone: "warning" },
  "waiting-start": { label: "待启动", tone: "info" },
  paused: { label: "已暂停", tone: "neutral" },
  pending: { label: "等待执行", tone: "neutral" },
};

/** 活跃工作流对应的列表行标签；无活跃工作流或档位未知时返回 null（不显示标签）。 */
export function resolveChatWorkflowBadge(workflow: ThreadWorkflowState | null | undefined): ThreadListStatusBadge | null {
  if (!workflow) return null;
  return CHAT_WORKFLOW_BADGES[workflow.status] ?? null;
}

/** 会话行标签判定的全部输入；由调用方从 store 与提醒状态解析后传入。 */
export type ThreadRowStatusInput = {
  /** 会话级提醒；每个会话至多一条，命中时覆盖其他一切来源。 */
  reminder: ThreadListStatusBadge | null;
  /** 会话内 turn 的人工待办态。 */
  pendingInteraction: "approval" | "userInput" | null;
  /** 会话内是否有正在流式处理的回复。 */
  conversationProcessing: boolean;
  /** 是否有运行中的 turn（列表 hint 或权威运行态）。 */
  hasRunningTurn: boolean;
  /** 会话工作流活跃态；null 表示无活跃工作流。 */
  workflow: ThreadWorkflowState | null;
};

/**
 * 会话行标签判定链：提醒 → turn 待办 → 活跃工作流 → turn 运行中。
 * turn 待办排在活跃工作流之前：它是「眼前必须处理」的会话内交互，被跨线程聚合的标签盖住会漏操作。
 * 活跃工作流排在 turn 运行中之前，与删除门禁同源，避免出现「行上没有标签却删不掉会话」。
 */
export function resolveThreadRowStatusBadge(input: ThreadRowStatusInput): ThreadListStatusBadge | null {
  if (input.reminder) return input.reminder;
  if (input.pendingInteraction === "approval") return { label: "待确认", tone: "info" };
  if (input.pendingInteraction === "userInput") return { label: "待补充", tone: "warning" };
  const workflowBadge = resolveChatWorkflowBadge(input.workflow);
  if (workflowBadge) return workflowBadge;
  if (input.conversationProcessing) return { label: "运行中", tone: "running" };
  if (input.hasRunningTurn) return { label: "运行中", tone: "running" };
  return null;
}
