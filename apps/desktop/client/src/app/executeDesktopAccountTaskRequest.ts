import type { ApiErrorCode, ClientToServerMessage, DesktopApiRequest } from "@codeflowai/shared";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "./handleApiRequest.js";
import { executeDesktopApiRequest } from "./executeDesktopApiRequest.js";
import type { DesktopCloudAccountOwner } from "../runtime/desktopCloudAccount.js";
import { logger } from "../logger.js";

type Response = Extract<ClientToServerMessage, { t: "api.res" }>;
const FIELDS: Record<string, readonly string[]> = {
  "workspaces.list": [], "orch.workflows.list": ["workspaceId"],
  "reminders.workspaceSummaries": [], "scheduledTasks.runNow": ["taskId"],
};

/** 通过唯一本地处理器执行账号任务，并只回传当前请求的响应。 */
async function runLocalAccountTask(ctx: ApiHandlerContext, req: ApiRequestMessage, owner: DesktopCloudAccountOwner): Promise<Response> {
  const cloud = ctx.desktopCloudAccount;
  if (!cloud) throw new Error("DESKTOP_CLOUD_ACCOUNT_REQUIRED");
  const responses: Response[] = [];
  await handleApiRequest({ ...ctx, localWorkspaceOnly: true,
    send(message) {
      if (message.t === "api.res") { responses.push(message); return; }
      cloud.assertOwner(owner); return ctx.send(message);
    },
  }, req);
  cloud.assertOwner(owner);
  if (responses.length !== 1 || responses[0]!.id !== req.id) throw new Error("DESKTOP_ACCOUNT_TASK_RPC_RESPONSE_INVALID");
  return responses[0]!;
}

/** 云账号请求复用统一桌面API校验与处理器，并在操作前后核对原账号归属。 */
export async function executeDesktopAccountTaskRequest(ctx: ApiHandlerContext, req: ApiRequestMessage, input: {
  owner: DesktopCloudAccountOwner; clientVersion: string | null; startedAt: number;
}): Promise<Response> {
  const cloud = ctx.desktopCloudAccount;
  if (!cloud) throw new Error("DESKTOP_CLOUD_ACCOUNT_REQUIRED");
  cloud.assertOwner(input.owner);
  /** 输入失败只记安全身份和方法，正文与会话令牌不进入日志。 */
  const reject = (status: number, code: ApiErrorCode, message: string): Response => {
    logger.warn("desktop-account-tasks", "account task RPC rejected", {
      errorCode: "DESKTOP_ACCOUNT_TASK_RPC_REJECTED", requestId: req.id, clientId: ctx.clientId, deviceId: ctx.deviceId,
      ownerUserId: input.owner.ownerUserId, generation: input.owner.generation,
      method: /^[A-Za-z][A-Za-z0-9.]{0,119}$/u.test(req.method) ? req.method : null,
      rootCause: { code, status },
    });
    return { t: "api.res", id: req.id, status, body: { ok: false, code, message } };
  };
  const knownTask = Object.prototype.hasOwnProperty.call(FIELDS, req.method);
  const body = req.body ?? {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return reject(400, "BAD_REQUEST", "任务请求参数无效");
  if (knownTask && Object.keys(body).some(key => !FIELDS[req.method]!.includes(key))) return reject(400, "BAD_REQUEST", "任务请求参数无效");
  if (req.method === "reminders.workspaceSummaries") return await runLocalAccountTask(ctx, { ...req, body: {} }, input.owner);
  if (req.method !== "scheduledTasks.runNow") {
    const forwardedBody = { ...(body as Record<string, unknown>) };
    // Server 会在 threads.list 附带已认证账号身份；与本机账号不一致视为伪造，一致时剔除并由本机重新解析。
    if (req.method === "threads.list" && forwardedBody.actorUserId !== undefined) {
      if (String(forwardedBody.actorUserId ?? "").trim() !== input.owner.ownerUserId) return reject(400, "BAD_REQUEST", "任务请求参数无效");
      delete forwardedBody.actorUserId;
    }
    // 会话工作流的 Server 身份与执行范围由本机重新解析；身份不一致视为伪造，其余字段剔除后交给原桌面校验。
    if (req.method.startsWith("orch.chat.")) {
      if (forwardedBody.actorUserId !== undefined && String(forwardedBody.actorUserId ?? "").trim() !== input.owner.ownerUserId)
        return reject(400, "BAD_REQUEST", "任务请求参数无效");
      delete forwardedBody.actorUserId;
      delete forwardedBody.executionProfileScope;
      delete forwardedBody.sharedRequirementContext;
    }
    const result = await executeDesktopApiRequest(ctx, { method: req.method as DesktopApiRequest["method"], body: forwardedBody },
      { requestId: req.id, clientVersion: input.clientVersion, startedAt: input.startedAt });
    cloud.assertOwner(input.owner);
    return { t: "api.res", id: req.id, ...result };
  }
  const taskId = (body as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string" || !taskId.trim() || taskId !== taskId.trim()) return reject(400, "BAD_REQUEST", "taskId 无效");
  return await runLocalAccountTask(ctx, { ...req, body: { taskId } }, input.owner);
}
