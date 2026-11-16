import { KNOWLEDGE_ASSET_READ_ACTIONS, KNOWLEDGE_ASSET_WRITE_ACTIONS } from "@codeflowai/shared";
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
/** 同账号远程设备可操作本机会话；控制类、账号类、安装更新类方法不在允许范围。 */
const REMOTE_ACCOUNT_TASK_METHODS = new Set<string>([
  "workspaces.list",
  "engines.status",
  "threads.list", "threads.groups.list", "threads.summary", "threads.load", "threads.events",
  "threads.prefs", "threads.latestPrefs",
  "threads.create", "threads.sendMessage", "threads.updatePrefs", "threads.rename", "threads.archive", "threads.delete",
  "threads.groups.create", "threads.groups.rename", "threads.groups.delete", "threads.group.assign",
  "threads.pin", "threads.clear", "threads.compact", "threads.restartCodexAppServer",
  "threads.managedServices.list", "threads.managedServices.stop",
  "threads.inputActions.list", "threads.fileChanges.list", "threads.fileChanges.diff",
  "threads.fileChanges.accept", "threads.fileChanges.undo", "threads.rollback", "threads.rollback.preview",
  "threads.messages.delete", "workspacePrefs.get", "workspacePrefs.save",
  "workspaceExecutionProfile.get", "workspaceExecutionProfile.status", "workspaceExecutionProfile.update",
  "codeflowai.config.get", "codeflowai.config.set",
  "threads.draft.get", "threads.draft.save", "threads.draft.clear",
  "threads.queue.append", "threads.queue.list", "threads.queue.move", "threads.queue.remove", "threads.queue.clear",
  "threads.queue.resume", "threads.queue.pause",
  "clientDb.cleanup.status", "clientDb.cleanup.start",
  "turns.interrupt", "approvals.respond", "userInput.respond",
  "fs.tree", "fs.search", "fs.stat", "fs.readFile", "fs.spreadsheetPreview", "fs.documentPreview", "fs.downloadFile",
  "git.status", "git.diff", "git.diffFiles", "git.log", "git.show", "git.showFileDiff", "git.branch.list",
  "reminders.workspaceSummaries", "reminders.items", "reminders.markRead", "reminders.ignore",
  "orch.roles.list", "orch.roles.upsert", "orch.roles.delete",
  "orch.workflows.list", "orch.workflows.upsert", "orch.workflows.delete",
  "orch.knowledgeBundles.list", "orch.knowledgeBundles.upsert", "orch.knowledgeBundles.delete",
  "orch.toolsets.list", "orch.toolsets.upsert", "orch.toolsets.delete",
  "orch.skills.list", "orch.skills.upsert", "orch.skills.delete", "orch.skills.install", "orch.skills.installStatus", "orch.skills.uninstall",
  "orch.assets.copy",
  "orch.assetDrafts.generate", "orch.assetDrafts.get", "orch.assetDrafts.apply", "orch.assetDrafts.reject",
  "orch.assetDraftJobs.list", "orch.assetDraftJobs.get", "orch.assetDraftJobs.delete", "orch.assetDraftJobs.resume",
  "orch.assetGroups.list", "orch.assetGroups.create", "orch.assetGroups.rename", "orch.assetGroups.delete", "orch.assetGroups.assign",
  "orch.assigneeTemplates.list", "orch.assigneeTemplates.upsert", "orch.assigneeTemplates.delete",
  "orch.assetBundles.export", "orch.assetBundles.import",
  "orch.experiments.freeze", "orch.experiments.run.start", "orch.experiments.run.cancel", "orch.experiments.run.status",
  "orch.requirementAnalysis.sessions.list", "orch.requirementAnalysis.sessions.create", "orch.requirementAnalysis.sessions.get",
  "orch.requirementAnalysis.sessions.archive", "orch.requirementAnalysis.createIntakes", "orch.requirementAnalysis.messages.send",
  "orch.intakes.list", "orch.intakes.create", "orch.intakes.upsert", "orch.intakes.delete",
  "orch.pendingMine.list",
  "orch.proposals.list", "orch.proposals.get", "orch.proposals.create", "orch.proposals.confirm",
  "orch.instances.list", "orch.instances.get", "orch.instances.runtimePatch", "orch.instances.start", "orch.instances.pause",
  "orch.instances.resume", "orch.instances.cancel", "orch.instances.feedback", "orch.instances.rerunFromNode",
  "orch.instances.reassignNode", "orch.instances.discussionThread.ensure",
  "orch.nodes.start", "orch.nodes.skip", "orch.nodes.cancel",
  "orch.artifacts.list", "orch.artifacts.get", "orch.artifacts.revise", "orch.artifactFiles.list",
  "orch.events.list", "orch.promptSnapshots.list", "orch.promptSnapshots.get",
  "orch.nodeWorkItems.list", "orch.nodeWorkItemEvents.list",
  "orch.metrics.collect", "orch.runtimeEvidence.get",
  "orch.workflowExecutionDefaults.get", "orch.workflowExecutionDefaults.upsert", "orch.workflowExecutionDefaults.delete",
]);

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

/** 云连接只读任务资产或运行原账号任务，复用桌面校验与中央处理器，不开放通用本机API。 */
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
  const knowledgeAction = req.method.startsWith("knowledge.assets.") ? req.method.slice("knowledge.assets.".length) : null;
  const knownKnowledge = knowledgeAction !== null
    && ([...KNOWLEDGE_ASSET_READ_ACTIONS, ...KNOWLEDGE_ASSET_WRITE_ACTIONS] as readonly string[]).includes(knowledgeAction);
  if (!knownTask && !REMOTE_ACCOUNT_TASK_METHODS.has(req.method) && !knownKnowledge) return reject(403, "FORBIDDEN", "桌面云连接不支持此任务操作");
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
    const result = await executeDesktopApiRequest(ctx, { method: req.method as DesktopApiRequest["method"], body: forwardedBody },
      { requestId: req.id, clientVersion: input.clientVersion, startedAt: input.startedAt });
    cloud.assertOwner(input.owner);
    return { t: "api.res", id: req.id, ...result };
  }
  const taskId = (body as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string" || !taskId.trim() || taskId !== taskId.trim()) return reject(400, "BAD_REQUEST", "taskId 无效");
  return await runLocalAccountTask(ctx, { ...req, body: { taskId } }, input.owner);
}
