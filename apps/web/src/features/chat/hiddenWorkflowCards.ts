/**
 * 会话工作流卡片的「本机隐藏」记录。
 *
 * 隐藏只是本机显示偏好，不删任何业务记录：已结束的卡片收成一行后用户仍可隐藏它，
 * 记录按会话存在 localStorage，刷新与切换会话都仍命中；换设备不生效 —— 这正是「本机」的定义。
 *
 * 与 features/messages/dismissedSystemMessages 同构（持久层 + 会话层内存）：
 * localStorage 不可用（隐私模式/配额）时内存层兜底，本次加载内隐藏生效、刷新后卡片重现。
 * 不直接复用该模块：它的「会话层内存」是为本地一次性通知 id 每次加载重置的陷阱设计的，
 * 而工作流 task.id 是稳定的 DB 行 id，不存在该陷阱。只对齐它的分键、响应式、上限淘汰与降级口径。
 */

import { ref } from "vue";

import { buildMarkerKey, safeReadLocalStorage, safeWriteLocalStorage } from "../../utils/oneShotMarker";

/** 存储键前缀；格式已发布到用户 localStorage，改动即等于让老用户的隐藏记录失效。 */
export const HIDDEN_WORKFLOW_CARD_STORAGE_PREFIX = "codeflow:chat:hidden-workflow-card";
/** 单会话最多保留的隐藏记录数，超出按最旧淘汰（被淘汰的老卡片刷新后重现）。 */
export const MAX_HIDDEN_CARDS_PER_THREAD = 50;

/** 写入后自增；读取方先读它才能建立响应式依赖。 */
const revision = ref(0);

/** 会话层隐藏记录：localStorage 不可用时的唯一落点，仅本次加载内有效。 */
const memoryHiddenTaskIdsByThread = new Map<string, Set<string>>();

/** 构造按会话作用域的存储键；threadId 为空时返回 null。 */
function storageKeyForThread(threadId: string): string | null {
  return buildMarkerKey(HIDDEN_WORKFLOW_CARD_STORAGE_PREFIX, [threadId]);
}

/** 读取某会话已持久化的隐藏 id，按写入先后排列。 */
function readPersistedTaskIds(threadId: string): string[] {
  const key = storageKeyForThread(threadId);
  if (!key) return [];
  return safeReadLocalStorage(key).split("\n").map((id) => id.trim()).filter(Boolean);
}

/** 某会话下已隐藏的卡片 id 集合：持久层 ∪ 会话层。 */
export function hiddenWorkflowTaskIds(threadId: string): ReadonlySet<string> {
  revision.value;
  const normalizedThreadId = String(threadId ?? "").trim();
  const ids = new Set<string>(readPersistedTaskIds(normalizedThreadId));
  const memoryIds = memoryHiddenTaskIdsByThread.get(normalizedThreadId);
  if (memoryIds) for (const id of memoryIds) ids.add(id);
  return ids;
}

/** 记录本机隐藏了某张卡片，幂等；写入失败时降级为仅本次加载内有效。 */
export function hideChatWorkflowCard(threadId: string, taskId: string): void {
  const normalizedThreadId = String(threadId ?? "").trim();
  const normalizedTaskId = String(taskId ?? "").trim();
  if (!normalizedThreadId || !normalizedTaskId) return;

  let memoryIds = memoryHiddenTaskIdsByThread.get(normalizedThreadId);
  if (!memoryIds) {
    memoryIds = new Set<string>();
    memoryHiddenTaskIdsByThread.set(normalizedThreadId, memoryIds);
  }
  memoryIds.add(normalizedTaskId);

  const key = storageKeyForThread(normalizedThreadId);
  if (key) {
    const next = readPersistedTaskIds(normalizedThreadId).filter((id) => id !== normalizedTaskId);
    next.push(normalizedTaskId);
    safeWriteLocalStorage(key, next.slice(-MAX_HIDDEN_CARDS_PER_THREAD).join("\n"));
  }

  revision.value += 1;
}

/** 清空某会话的本机隐藏记录（内存与落盘同清），供单测隔离使用；界面不提供恢复入口。 */
export function clearHiddenWorkflowCards(threadId: string): void {
  const normalizedThreadId = String(threadId ?? "").trim();
  if (!normalizedThreadId) return;
  memoryHiddenTaskIdsByThread.delete(normalizedThreadId);
  const key = storageKeyForThread(normalizedThreadId);
  if (key) safeWriteLocalStorage(key, "");
  revision.value += 1;
}
