import crypto from "node:crypto";

import type { OrchestrationId, ThreadId, WorkspaceId } from "@codeflowai/shared";

/** 会话工作流活动事件：只用于 Web 局部刷新承载会话行的活动时间，不写入编排事件日志。 */
export const CHAT_WORKFLOW_ACTIVITY_EVENT_TYPE = "orchestration.chatWorkflowActivity";

type ChatWorkflowActivityEvent = {
  id: string;
  instanceId: OrchestrationId;
  nodeId?: string | null;
  type: string;
  payloadJson: string;
  createdAt: number;
};

/** 同步承载会话活动时间所需的最小宿主能力，供编排引擎与会话工作流服务共用。 */
export type ChatWorkflowActivityHost = {
  /** 与会话自身事件同一写入入口：更新 threads.updated_at。 */
  touchThread: (threadId: ThreadId, updatedAt: number) => void;
  /** 推送给订阅该工作区的 Web；未注入时只落库。 */
  emitOrchestration?: (workspaceId: WorkspaceId, event: ChatWorkflowActivityEvent) => void;
};

/**
 * 静默同步承载工作流的会话活动时间：更新承载会话的 updated_at，并向 Web 推送轻量活动事件。
 *
 * - 不写入任何会话流消息，避免把已去除的回执噪音重新引入；
 * - 实例尚未创建时（推荐阶段）只更新时间、不推送：Server 侧要求事件携带非空 instanceId；
 * - 返回本次写入的时间戳。
 */
export function notifyChatWorkflowThreadActivity(input: {
  host: ChatWorkflowActivityHost;
  workspaceId: WorkspaceId;
  threadId: string;
  instanceId: string | null;
  taskId: string;
}): number {
  const updatedAt = Date.now();
  input.host.touchThread(input.threadId as ThreadId, updatedAt);
  const instanceId = String(input.instanceId ?? "").trim();
  if (!instanceId) return updatedAt;
  input.host.emitOrchestration?.(input.workspaceId, {
    id: crypto.randomUUID(),
    instanceId: instanceId as OrchestrationId,
    nodeId: null,
    type: CHAT_WORKFLOW_ACTIVITY_EVENT_TYPE,
    payloadJson: JSON.stringify({
      instanceId,
      threadId: input.threadId,
      taskId: input.taskId,
      updatedAt,
    }),
    createdAt: updatedAt,
  });
  return updatedAt;
}
