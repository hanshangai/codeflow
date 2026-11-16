import { matchesThreadListScope, type ThreadId, type ThreadListScope, type ThreadSummary } from "@codeflowai/shared";

export function isKnowledgeConversation(thread: Pick<ThreadSummary, "threadSubtype">): boolean {
  return thread.threadSubtype === "knowledge-conversation";
}

/** 文件工作和历史独立复检线程，继续使用知识协作的范围及写入权限。 */
export function isKnowledgeExecution(thread: Pick<ThreadSummary, "threadSubtype">): boolean {
  return thread.threadSubtype === "knowledge-assets";
}

/** 知识分类同时包含讨论会话和资产执行会话。 */
export function isKnowledgeThread(thread: Pick<ThreadSummary, "threadSubtype">): boolean {
  return isKnowledgeConversation(thread) || isKnowledgeExecution(thread);
}

/** 规格讨论携带所属工作区直接打开原会话，沿用独立线程草稿。 */
export function resolveKnowledgeConversationLocation(thread: Pick<ThreadSummary, "id" | "threadSubtype">, workspaceId: string): {
  path: "/chat";
  query: { workspaceId: string; threadId: ThreadId };
} | null {
  return isKnowledgeConversation(thread)
    ? { path: "/chat", query: { workspaceId, threadId: thread.id } }
    : null;
}

/** 规格讨论和文件工作会话统一直开；规格库链接仍负责文档定位。 */
export function resolveKnowledgeThreadLocation(thread: Pick<ThreadSummary, "id" | "threadSubtype">, workspaceId: string):
  | { path: "/chat"; query: { workspaceId: string; threadId: ThreadId } }
  | null {
  if (isKnowledgeThread(thread)) return { path: "/chat", query: { workspaceId, threadId: thread.id } };
  return null;
}

/** 浏览知识分类或知识页期间的筛选变化不撤销后台研发会话。 */
export function shouldClearPrimarySelectionForListFilter(input: {
  currentScope: ThreadListScope;
  nextScope: ThreadListScope;
  knowledgePageActive: boolean;
  selectedThreadId: ThreadId | null;
  selectedThread: ThreadSummary | null;
}): boolean {
  if (!input.selectedThreadId || input.currentScope === input.nextScope) return false;
  if (input.knowledgePageActive || input.currentScope === "knowledge" || input.nextScope === "knowledge") return false;
  return !input.selectedThread || !matchesThreadListScope(input.selectedThread, input.nextScope);
}
