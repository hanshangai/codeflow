import { resolveChatWorkflowNaturalAction, type ChatWorkflowActionInput, type ChatWorkflowView } from "@codeflowai/shared";
import { rejectPausedTaskAdmission, type ApiHandlerContext, type ApiRequestMessage } from "../handleApiRequest.js";
import { ChatWorkflowService, chatWorkflowError } from "../../orchestration/chatWorkflowService.js";
import { logger } from "../../logger.js";
import { readSharedWorkspaceToolExecutionContext } from "../sharedWorkspaceToolPolicy.js";

/** 复用会话工作流服务；本机入口承担 Server 原有的自然意图解析与启动准备。 */
export async function handleChatWorkflowRequest(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = String(body.workspaceId ?? "");
  const threadId = String(body.threadId ?? "");
  const actorUserId = String(body.actorUserId ?? "");
  let taskId = body.taskId;
  /** 同步卡片投影与准备独立准入，action 的异步执行由原服务 owner 协调。 */
  const database = <T>(operation: () => T): Promise<T> => ctx.withDatabase ? ctx.withDatabase(req.id, operation) : Promise.resolve(operation());
  try {
    if (!actorUserId) throw chatWorkflowError("CHAT_WORKFLOW_ACTOR_REQUIRED", "缺少操作人身份", 403);
    const service = await database(() => {
      const service = new ChatWorkflowService(ctx);
      service.requireThread(workspaceId, threadId);
      return service;
    });
    let result: unknown;
    if (req.method === "orch.chat.get") result = await database(() => service.snapshot(workspaceId, threadId, actorUserId));
    else if (req.method === "orch.chat.settings") {
      if (typeof body.enabled !== "boolean") throw chatWorkflowError("CHAT_WORKFLOW_INPUT_INVALID", "推荐开关必须是布尔值", 400);
      result = await database(() => {
        service.repo.setEnabled(threadId, body.enabled as boolean);
        return service.snapshot(workspaceId, threadId, actorUserId);
      });
    } else if (req.method === "orch.chat.prepare") result = { view: await database(() => service.prepareStart(workspaceId, threadId, String(body.taskId ?? ""), Number(body.expectedVersion), actorUserId)) };
    else if (req.method === "orch.chat.rework") result = { view: await database(() => service.planRework(workspaceId, threadId, String(body.taskId ?? ""), String(body.nodeId ?? ""), String(body.reason ?? ""), actorUserId)) };
    else if (req.method === "orch.chat.delete") {
      const removed = await database(() => service.remove(workspaceId, threadId, String(body.taskId ?? ""), Number(body.expectedVersion), actorUserId));
      logger.info("chat-workflow", "chat workflow card deleted", {
        code: "CHAT_WORKFLOW_CARD_DELETED", requestId: req.id, callerRequestId: String(body.requestId ?? "").trim() || null,
        workspaceId, threadId, taskId: removed.taskId, actorUserId,
        cancelledContinuationQueueItemId: removed.cancelledContinuationQueueItemId, deletedIntakeId: removed.deletedIntakeId,
      });
      result = { removed: { taskId: removed.taskId } };
    } else if (req.method === "orch.chat.action" || (req.method === "orch.chat.natural" && ctx.localWorkspaceOnly === true)) {
      const natural = req.method === "orch.chat.natural";
      let command = { ...body } as unknown as ChatWorkflowActionInput;
      if (natural) {
        const text = String(body.text ?? "");
        const resolved = text.length <= 2000 ? await database(() => resolveChatWorkflowNaturalAction(text, service.snapshot(workspaceId, threadId, actorUserId))) : null;
        if (!resolved) {
          ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, handled: false } });
          return;
        }
        command = { ...resolved, workspaceId, threadId, requestId: String(body.requestId ?? "") };
        taskId = resolved.taskId;
        if (rejectPausedTaskAdmission(ctx, { ...req, method: "orch.chat.action", body: command })) return;
      }
      let startedView: ChatWorkflowView | undefined;
      if (ctx.localWorkspaceOnly === true && command.action === "start") {
        if (!command.requestId) throw chatWorkflowError("CHAT_WORKFLOW_IDENTITY_REQUIRED", "操作缺少真实用户或请求标识", 400);
        await database(() => {
          const task = service.requireTask(workspaceId, threadId, command.taskId);
          if (task.instanceId) startedView = service.view(task, actorUserId);
          else command.expectedVersion = service.prepareStart(workspaceId, threadId, task.id, command.expectedVersion, actorUserId).task.version;
        });
      }
      const view = startedView ?? await service.action(command, actorUserId, {
        executionProfileScope: body.executionProfileScope,
        sharedRequirementContext: body.sharedRequirementContext,
        sharedWorkspaceToolContext: readSharedWorkspaceToolExecutionContext(body),
      });
      result = natural ? { view, handled: true, action: command.action, feedbackAction: command.feedbackAction } : { view };
    } else throw chatWorkflowError("CHAT_WORKFLOW_METHOD_INVALID", "未知会话工作流方法", 400);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...(result as object) } });
  } catch (error) {
    const code = String((error as { code?: string }).code ?? "CHAT_WORKFLOW_FAILED");
    const message = error instanceof Error ? error.message : String(error);
    logger.error("chat-workflow", "chat workflow request failed", { code, requestId: req.id, callerRequestId: String(body.requestId ?? "").trim() || null,
      workspaceId, threadId, taskId, actorUserId, operation: req.method, cause: message });
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: Number((error as { status?: number }).status ?? 500), body: { ok: false, code, message } });
  }
}
