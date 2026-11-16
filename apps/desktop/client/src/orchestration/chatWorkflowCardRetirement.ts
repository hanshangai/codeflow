import type { ChatWorkflowRepo } from "../db/repos/chatWorkflowRepo.js";
import type { ClientDb } from "../db/clientDb.js";

/**
 * Server 权威资产模式下回收「流程已不存在」的会话卡片：权威资产图是卡片流程的唯一真值，
 * Server 侧删掉流程后卡片只靠冻结快照仍会显示成点不动的幽灵卡，这里按工作区把死卡清掉。
 *
 * 只比对不写入之外的判定完全交给调用方注入的 listVisibleWorkflowIds：
 * 返回 null 表示该工作区不在 Server 权威模式（legacy 资产不属于本函数职责），直接跳过。
 */
export function retireChatWorkflowCardsWithoutWorkflowAsset(args: {
  repo: Pick<ChatWorkflowRepo, "listWorkflowRefs" | "deleteByWorkflowIds">;
  /** 返回该工作区当前可见的流程 id；工作区不在 Server 权威模式时返回 null。 */
  listVisibleWorkflowIds(workspaceId: string): Set<string> | null;
  /** 由原owner固定W诊断；成功删除后的写失败必须原值传播。 */
  writeWorkspaceLog: ClientDb["writeWorkspaceLog"];
}): void {
  const refsByWorkspace = new Map<string, Array<{ taskId: string; workflowId: string }>>();
  for (const ref of args.repo.listWorkflowRefs()) {
    const refs = refsByWorkspace.get(ref.workspaceId);
    if (refs) refs.push(ref);
    else refsByWorkspace.set(ref.workspaceId, [{ taskId: ref.taskId, workflowId: ref.workflowId }]);
  }
  for (const [workspaceId, refs] of refsByWorkspace) {
    const visibleWorkflowIds = args.listVisibleWorkflowIds(workspaceId);
    if (!visibleWorkflowIds) continue;
    const missingWorkflowIds = [...new Set(refs.filter(ref => !visibleWorkflowIds.has(ref.workflowId)).map(ref => ref.workflowId))];
    if (!missingWorkflowIds.length) continue;
    const removal = args.repo.deleteByWorkflowIds(workspaceId, missingWorkflowIds);
    args.writeWorkspaceLog(workspaceId, { level: "info", tag: "chat-workflow", message: "chat workflow cards retired because their workflow asset no longer exists", data: {
      code: "CHAT_WORKFLOW_CARD_RETIRED",
      requestId: `card-retirement:${workspaceId}`,
      workspaceId,
      workflowIds: missingWorkflowIds,
      taskIds: removal.taskIds,
      removedCount: removal.taskIds.length,
      skippedInvalidJsonCount: removal.skippedInvalidJsonCount,
      cause: "workflow asset missing from Server-authoritative cache",
    } });
  }
}
