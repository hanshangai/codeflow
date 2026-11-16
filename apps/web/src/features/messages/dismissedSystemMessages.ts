/**
 * 消息区提示条（systemMessage）的「用户已关闭」记录。
 *
 * 提示条不是可删的实体记录，而是渲染层从持久化事件推导出来的（sys_<seq> / orch_<seq>），
 * 关掉后只要重放事件就会重现，因此这里只记住「已关闭的提示 id」，由展示层过滤掉。
 *
 * 分两层是因为 id 稳定性不同：
 * - 持久层（localStorage，按会话）：只存来自事件回放的稳定 id，刷新/切换会话后仍能命中；
 * - 会话层（内存 Map）：本地一次性通知用 sys_<-1,-2,…> 且每次加载从 -1 重置，
 *   写盘会让下次加载的无关新提示复用同一 id 被静默吞掉，故只记内存（本次加载内有效）。
 */

import { ref } from "vue";

import { buildMarkerKey, safeReadLocalStorage, safeWriteLocalStorage } from "../../utils/oneShotMarker";

const STORAGE_PREFIX = "codeflow:chat:dismissed-system-message";
/** 单会话最多保留的持久关闭记录数，超出按最旧淘汰。 */
const MAX_PERSISTED_PER_THREAD = 50;
/** 稳定提示 id：来自事件回放，seq 为正数的 sys_<seq> / orch_<seq>。 */
const DURABLE_ID_PATTERN = /^(?:sys|orch)_\d+$/u;

/** 写入后自增；读取方先读它才能建立响应式依赖（同 app-topbar 的关闭记录写法）。 */
const revision = ref(0);

/** 会话层关闭记录：不写盘，仅本次加载内有效。 */
const memoryDismissedIdsByThread = new Map<string, Set<string>>();

/** 构造按会话作用域的存储键；threadId 为空时返回 null。 */
function storageKeyForThread(threadId: string): string | null {
  return buildMarkerKey(STORAGE_PREFIX, [threadId]);
}

/** 读取某会话已持久化的关闭 id，按写入先后排列。 */
function readPersistedIds(threadId: string): string[] {
  const key = storageKeyForThread(threadId);
  if (!key) return [];
  return safeReadLocalStorage(key).split("\n").map((id) => id.trim()).filter(Boolean);
}

/** 仅稳定 id（来自事件回放）可持久化；本地一次性通知 id 每次加载重用，写盘会误吞日后无关提示。 */
export function isDurableSystemMessageId(itemId: string): boolean {
  return DURABLE_ID_PATTERN.test(String(itemId ?? "").trim());
}

/** 某会话下用户已关闭的提示 id 集合：持久层 ∪ 会话层。 */
export function dismissedSystemMessageIds(threadId: string): ReadonlySet<string> {
  revision.value;
  const normalizedThreadId = String(threadId ?? "").trim();
  const ids = new Set<string>(readPersistedIds(normalizedThreadId));
  const memoryIds = memoryDismissedIdsByThread.get(normalizedThreadId);
  if (memoryIds) for (const id of memoryIds) ids.add(id);
  return ids;
}

/**
 * 记录用户关闭了某提示，幂等。
 * 稳定 id 写盘（写入失败时降级为仅本次加载内有效）；本地一次性通知只记内存。
 */
export function dismissSystemMessage(threadId: string, itemId: string): void {
  const normalizedThreadId = String(threadId ?? "").trim();
  const normalizedItemId = String(itemId ?? "").trim();
  if (!normalizedThreadId || !normalizedItemId) return;

  let memoryIds = memoryDismissedIdsByThread.get(normalizedThreadId);
  if (!memoryIds) {
    memoryIds = new Set<string>();
    memoryDismissedIdsByThread.set(normalizedThreadId, memoryIds);
  }
  memoryIds.add(normalizedItemId);

  if (isDurableSystemMessageId(normalizedItemId)) {
    const key = storageKeyForThread(normalizedThreadId);
    if (key) {
      const next = readPersistedIds(normalizedThreadId).filter((id) => id !== normalizedItemId);
      next.push(normalizedItemId);
      safeWriteLocalStorage(key, next.slice(-MAX_PERSISTED_PER_THREAD).join("\n"));
    }
  }

  revision.value += 1;
}
