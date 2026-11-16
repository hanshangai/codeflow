import type { HostRpcHttpResultMessage, HostRpcHttpTask } from "@codeflowai/shared";

import { handleApiRequest, type ApiHandlerContext } from "./handleApiRequest.js";
import { handleSharedWorkspaceCommand } from "./handlers/sharedWorkspaceHandlers.js";

/** HTTP 命令复用现有处理器，只截取控制响应；其他消息透传真实发送结果。 */
export async function executeHostRpcHttpTask(ctx: ApiHandlerContext, task: HostRpcHttpTask): Promise<HostRpcHttpResultMessage[]> {
  const responses: HostRpcHttpResultMessage[] = [];
  const httpContext: ApiHandlerContext = {
    ...ctx,
    send(message) {
      if (task.message.t === "api.req" && message.t === "api.res") {
        if (message.id !== task.message.id) throw new Error(`Host RPC api.res id 不匹配：${message.id}`);
        responses.push(message);
        return;
      }
      if (task.message.t === "sharedWorkspace.command"
        && (message.t === "sharedWorkspace.route.ack" || message.t === "sharedWorkspace.route.result")) {
        if (message.message.routeEventId !== task.message.envelope.routeEventId) {
          throw new Error(`Host RPC routeEventId 不匹配：${message.message.routeEventId}`);
        }
        responses.push(message);
        return;
      }
      return ctx.send(message);
    },
  };
  if (task.message.t === "api.req") await handleApiRequest(httpContext, task.message);
  else await handleSharedWorkspaceCommand(httpContext, task.message.envelope);
  return responses;
}
