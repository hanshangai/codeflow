import { type ThreadQueuePauseReason } from "@codeflowai/shared";

/**
 * 主按钮是否允许提交：
 * - allowDuringRunning=true：即使 active turn 在跑也可提交（提交即入队，由 chat-composer 决定走 send 还是 enqueue）
 * - allowDuringRunning=false：保持原行为（旧调用点兼容）
 */
export function shouldAllowComposerSend(input: {
  disabled: boolean;
  connected: boolean;
  hasWebSession: boolean;
  /** 仅真实本机普通聊天可独立于云端会话发送。 */
  localReady?: boolean;
  sending: boolean;
  hasModelRequirement: boolean;
  hasSelectedModel: boolean;
  hasContent: boolean;
  runningTurnId: string | null;
  allowDuringRunning?: boolean;
}): boolean {
  if (input.disabled) return false;
  if (!input.localReady && (!input.connected || !input.hasWebSession)) return false;
  if (input.sending) return false;
  if (input.runningTurnId && !input.allowDuringRunning) return false;
  if (input.hasModelRequirement && !input.hasSelectedModel) return false;
  return input.hasContent;
}

/**
 * Enter 触发提交；带辅助键的 Enter 留给换行；输入法组合期间一律不提交。
 * 运行中是否允许 Enter 由 allowDuringRunning 决定（与 shouldAllowComposerSend 对齐）。
 */
export function shouldSubmitOnEnter(input: {
  key: string;
  isComposing: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  runningTurnId: string | null;
  allowDuringRunning?: boolean;
}): boolean {
  if (input.key !== "Enter") return false;
  if (input.isComposing) return false;
  if (input.shiftKey || input.ctrlKey || input.metaKey || input.altKey) return false;
  if (input.runningTurnId && !input.allowDuringRunning) return false;
  return true;
}

/**
 * 当前 send 是否应该走"入队"而不是"立即发送"。
 * 规则：节点线程始终入队；其他线程在 runningTurnId 存在或队列非空时入队，否则直接 send。
 *
 * 例外：队列因「用户中断」暂停时，用户再次发消息说明要继续执行这个会话——
 * 此时走直发，由宿主端先恢复队列并投递待发送项，避免新消息也排在被暂停的队列后面。
 * 只认 user_stop：用户显式暂停（user_pause）或失败类暂停不允许被新输入解除。
 */
export function shouldEnqueueInsteadOfSend(input: {
  threadSubtype?: string | null;
  runningTurnId: string | null;
  queueLength: number;
  /** 队列当前的暂停原因；未暂停时为 null。 */
  queuePausedReason?: ThreadQueuePauseReason | null;
}): boolean {
  if (input.threadSubtype === "node") return true;
  if (input.runningTurnId) return true;
  if (input.queueLength > 0) return input.queuePausedReason !== "user_stop";
  return false;
}
