import type { KnowledgeConversationSummary, KnowledgeGenerationRunView } from "@codeflowai/shared";

/** 主会话展示所需的关联事实，任务与协作状态仍以原接口为准。 */
export type KnowledgeThreadContext = {
  ownerThreadId: string;
  nodeId: string | null;
  title: string;
  kind: "规格讨论" | "知识规划" | "文件工作" | "复检";
  active: boolean;
  busy: boolean;
  generationThreadId: string | null;
};

/** 按原线程关联讨论、规划和文档任务；规划仅展示批任务状态，不开放续聊。 */
export function resolveKnowledgeThreadContext(
  threadId: string,
  conversations: KnowledgeConversationSummary[],
  runs: KnowledgeGenerationRunView[],
): KnowledgeThreadContext | null {
  const discussion = conversations.find(item => item.threadId === threadId);
  let result: KnowledgeThreadContext | null = discussion ? {
    ownerThreadId: discussion.threadId, nodeId: discussion.nodeId, title: discussion.title,
    kind: "规格讨论", active: discussion.active, busy: false, generationThreadId: null,
  } : null;
  if (!result) for (const run of runs) {
    const planning = run.planningThreadId === threadId;
    const item = run.items.find(item => item.executionThreadId === threadId || item.review?.executionThreadId === threadId);
    if (!planning && !item) continue;
    const ownerThreadId = run.ownerThreadId ?? run.threadId;
    if (!ownerThreadId) return null;
    const owner = conversations.find(item => item.threadId === ownerThreadId);
    result = {
      ownerThreadId, nodeId: planning ? run.nodeId : item!.nodeId, title: planning ? "筛选与组织项目知识" : item!.title,
      kind: planning ? "知识规划" : item!.executionThreadId === threadId ? "文件工作" : "复检",
      active: owner?.active === true, busy: false,
      generationThreadId: planning ? null : item!.executionThreadId ?? item!.review?.parentThreadId ?? null,
    };
    break;
  }
  if (!result) return null;
  result.busy = runs.some(run => run.adoptions?.some(receipt => !receipt.completed && !receipt.cancelled)) || runs.some(run => {
    const related = result.kind === "规格讨论"
      ? (run.ownerThreadId ?? run.threadId) === threadId
      : run.planningThreadId === threadId || run.threadId === threadId || run.items.some(item => item.executionThreadId === threadId || item.review?.executionThreadId === threadId);
    return related && run.active;
  });
  return result;
}
