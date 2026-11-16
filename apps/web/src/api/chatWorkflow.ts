import type { ChatWorkflowActionInput, ChatWorkflowSnapshot, ChatWorkflowView } from "@codeflowai/shared";
import { requestJson, type ApiRequestContext } from "./request";

/** 读取会话流程快照，允许面板切换或进入后台时取消旧查询。 */
export const getChatWorkflow = (ctx: ApiRequestContext, workspaceId: string, threadId: string, signal?: AbortSignal) =>
  requestJson<ChatWorkflowSnapshot>(ctx, { method: "POST", path: "/api/orch/chat/get", body: { workspaceId, threadId }, signal });

export const setChatWorkflowEnabled = (ctx: ApiRequestContext, workspaceId: string, threadId: string, enabled: boolean) =>
  requestJson<ChatWorkflowSnapshot>(ctx, { method: "POST", path: "/api/orch/chat/settings", body: { workspaceId, threadId, enabled } });

export const actOnChatWorkflow = (ctx: ApiRequestContext, body: ChatWorkflowActionInput) =>
  requestJson<{ view: ChatWorkflowView }>(ctx, { method: "POST", path: "/api/orch/chat/action", body });

export const planChatWorkflowRework = (ctx: ApiRequestContext, body: { workspaceId: string; threadId: string; taskId: string; nodeId: string; reason: string }) =>
  requestJson<{ view: ChatWorkflowView }>(ctx, { method: "POST", path: "/api/orch/chat/rework", body });

/** 硬删未启动的推荐卡及其关联需求与提案；删除不可恢复，必须带 expectedVersion 以拦截过期卡片。 */
export const deleteChatWorkflow = (ctx: ApiRequestContext, body: { workspaceId: string; threadId: string; taskId: string; expectedVersion: number; requestId: string }) =>
  requestJson<{ removed: { taskId: string } }>(ctx, { method: "POST", path: "/api/orch/chat/delete", body });

export const respondToChatWorkflow = (ctx: ApiRequestContext, body: { workspaceId: string; threadId: string; text: string; requestId: string }) =>
  requestJson<{ handled: boolean; view?: ChatWorkflowView; action?: ChatWorkflowActionInput["action"]; feedbackAction?: ChatWorkflowActionInput["feedbackAction"] }>(ctx, { method: "POST", path: "/api/orch/chat/natural", body });
