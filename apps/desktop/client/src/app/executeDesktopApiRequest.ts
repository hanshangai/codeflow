import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  KNOWLEDGE_ASSET_READ_ACTIONS,
  KNOWLEDGE_ASSET_WRITE_ACTIONS,
  makeWorkspaceIdFromPathDigest,
  normalizeThreadListScope,
  normalizeThreadListSort,
  normalizeWorkspacePathForDerivedId,
  parseKnowledgeAssetRequest,
  prefixLocalWorkspaceId,
  type DesktopApiRequest,
  type DesktopApiResponse,
  type KnowledgeAssetAction,
  type OnlineClientInfo,
  type ThreadId,
  type WorkspaceId,
} from "@codeflowai/shared";
import { handleApiRequest, scopeApiHandlerContext, isWorkspaceCoreApiRequest, isThreadHistoryReadApiRequest, isWorkspacePersistenceRecoveryApiRequest, describeWorkspaceApiFailure, WorkspaceApiRequestFailure, type ApiHandlerContext, type ApiRequestMessage } from "./handleApiRequest.js";
import { handleTerminalRuntimeApi } from "./handlers/terminalHandlers.js";
import { logger } from "../logger.js";
import { prepareCodexKeySwitch } from "./handlers/engineKeyHandlers.js";
import { DesktopBuiltInRelayRequestError } from "../runtime/desktopCloudAccount.js";
import { isDesktopLocalThreadAssetExecution } from "../orchestration/orchAssetAuthorityRuntimeReadService.js";
import { getUploadWorkspacePath } from "../fs/fsService.js";
import { assertCompleteOrchAssetBundle, buildActiveServerDefaultAssetIds, exportKnowledgeBundleDependencyBundle, exportRoleDependencyBundle,
  exportSkillDependencyBundle, exportToolsetDependencyBundle, exportWorkflowDependencyBundle } from "../orchestration/assetBundleService.js";
import { executeLocalQuickPhraseRequest } from "./handlers/localQuickPhraseHandlers.js";

const ALLOWED_FIELDS = {
  "runtime.info": [],
  "runtime.activity": [],
  "runtime.builtinAssets.list": ["assetType"],
  "quickPhrases.list": [],
  "quickPhrases.create": ["clientRequestId", "title", "content"],
  "quickPhrases.update": ["id", "title", "content", "version"],
  "quickPhrases.delete": ["id", "version"],
  "quickPhrases.reorder": ["revision", "ids"],
  "engineCustomModels.list": ["workspaceId"],
  "engineCustomModels.upsert": ["workspaceId", "id", "engine", "providerId", "modelId", "displayName", "inputModalities", "supportedReasoningEfforts", "defaultReasoningEffort", "contextWindow", "maxContextWindow", "supportsFastMode", "supports1MContext", "enabled"],
  "engineCustomModels.delete": ["workspaceId", "id"],
  "scheduledTasks.local.list": ["taskType", "enabled", "offset", "limit"],
  "scheduledTasks.local.create": ["name", "description", "taskType", "cronExpr", "timezone", "enabled", "payload", "concurrencyPolicy", "missedPolicy", "timeoutMs"],
  "scheduledTasks.local.update": ["taskId", "expectedRevision", "name", "description", "taskType", "cronExpr", "timezone", "enabled", "payload", "concurrencyPolicy", "missedPolicy", "timeoutMs"],
  "scheduledTasks.local.setEnabled": ["taskId", "expectedRevision", "enabled"],
  "scheduledTasks.local.delete": ["taskId", "expectedRevision"],
  "scheduledTasks.local.runNow": ["taskId"],
  "scheduledTasks.local.runs": ["taskId", "offset", "limit"],
  "scheduledTasks.local.cronPreview": ["cronExpr", "timezone", "count", "afterMs"],
  "scheduledTasks.account.list": [],
  "scheduledTasks.account.update": ["taskId", "expectedLocalRevision", "config"],
  "scheduledTasks.account.delete": ["taskId", "expectedLocalRevision"],
  "scheduledTasks.account.sync": [],
  "scheduledTasks.account.runNow": ["taskId"],
  "scheduledTasks.account.runs": ["taskId", "offset", "limit"],
  "codeflowai.config.get": ["workspaceId"],
  "codeflowai.config.set": ["workspaceId", "config"],
  "software.update.status": ["network", "forceRefresh"],
  "software.npm.install": ["npmPackage", "version", "network"],
  "workspaceDirectoryMigration.prepare": ["workspaceId", "idempotencyKey", "targetParentPath", "targetDirectoryName"],
  "workspaceDirectoryMigration.get": ["workspaceId", "operationId"],
  "workspaceDirectoryMigration.prepareStart": ["workspaceId", "operationId", "startAttemptId", "externalWritesPausedConfirmed", "targetNotSyncManagedConfirmed"],
  "workspaceDirectoryMigration.executeStart": ["workspaceId", "operationId", "startAttemptId", "expectedStateVersion"],
  "workspaceDirectoryMigration.fenceStart": ["workspaceId", "operationId", "startAttemptId", "expectedStateVersion"],
  "workspaceDirectoryMigration.cancel": ["workspaceId", "operationId", "startAttemptId", "expectedStateVersion", "reason"],
  "workspaceDirectoryMigration.recover": ["workspaceId", "operationId", "startAttemptId", "expectedStateVersion"],
  "runtime.cloudAccount.link": ["serverOrigin", "sessionToken"],
  "runtime.cloudAccount.unlink": [],
  "runtime.cloudAccount.status": [],
  "engineKeys.builtInRelay.ensure": ["workspaceId", "engine", "providerId", "intent", "stopRunningTurns"],
  "engines.status": ["workspaceId"],
  "engineKeys.list": ["workspaceId"],
  "engineKeys.upsert": ["workspaceId", "id", "label", "engine", "providerId", "apiKey", "baseUrl", "stopRunningTurns"],
  "engineKeys.test": ["workspaceId", "engine", "providerId", "apiKey", "baseUrl"],
  "engineKeys.delete": ["workspaceId", "id", "stopRunningTurns"],
  "engineKeys.activate": ["workspaceId", "id", "stopRunningTurns"],
  "engineKeys.deactivate": ["workspaceId", "id", "stopRunningTurns"],
  "workspaces.list": [],
  "workspaces.upsert": ["workspaceId", "title", "path"],
  "workspaces.delete": ["workspaceId"],
  "reminders.workspaceSummaries": [],
  "reminders.items": ["workspaceId"],
  "reminders.markRead": ["workspaceId", "entityType", "entityId", "marker"],
  "reminders.ignore": ["workspaceId", "items"],
  "clientFs.directoryTree": ["dirPath", "depth", "showHidden"],
  "workspaceExecutionProfile.get": ["workspaceId"],
  "workspaceExecutionProfile.update": ["workspaceId", "profileText"],
  "workspaceExecutionProfile.status": ["workspaceId"],
  "threads.list": ["workspaceId", "scope", "sort", "search", "groupId", "limit", "cursor", "includeArchived", "onlyRelatedToMe"],
  "threads.create": ["workspaceId", "engine", "title", "threadType", "threadSubtype", "groupId", "initialPrefs", "threadId"],
  "threads.rename": ["workspaceId", "threadId", "title"],
  "threads.archive": ["workspaceId", "threadId", "archived"],
  "threads.delete": ["workspaceId", "threadId"],
  "approvals.respond": ["workspaceId", "threadId", "requestId", "decision", "choice", "note", "knowledgeConversationActorContext"],
  "userInput.respond": ["workspaceId", "threadId", "requestId", "answers", "knowledgeConversationActorContext"],
  "threads.sendMessage": ["workspaceId", "threadId", "turnId", "text", "inputKind", "skillMentions", "workMode", "roleId", "planMode", "accessMode", "model", "effort", "images", "files", "pathReferences", "contextWindow", "autoCompactPct", "serviceTier", "clientItemId", "executionProfileUserId", "executionProfileScopeType", "executionProfileScopeId", "knowledgeConversationActorContext"],
  "threads.updatePrefs": ["workspaceId", "threadId", "prefs"],
  "threads.draft.get": ["workspaceId", "threadId"],
  "threads.draft.save": ["workspaceId", "threadId", "draft", "updatedByWebSessionId"],
  "threads.draft.clear": ["workspaceId", "threadId"],
  "threads.queue.append": ["workspaceId", "threadId", "text", "inputKind", "skillMentions", "images", "files", "pathReferences", "sendOptions", "clientItemId", "originWebSessionId"],
  "threads.queue.list": ["workspaceId", "threadId"],
  "threads.queue.move": ["workspaceId", "threadId", "queueItemId", "direction"],
  "threads.queue.remove": ["workspaceId", "threadId", "queueItemId"],
  "threads.queue.clear": ["workspaceId", "threadId"],
  "threads.queue.resume": ["workspaceId", "threadId"],
  "threads.queue.pause": ["workspaceId", "threadId", "reason"],
  "clientDb.cleanup.status": ["clientId"],
  "clientDb.cleanup.start": ["clientId", "inactiveBefore"],
  "turns.interrupt": ["workspaceId", "threadId", "turnId"],
  "threads.load": ["workspaceId", "threadId", "limit", "beforeSeq", "presentation", "presentationLimit", "presentationBeforePosition"],
  "threads.presentation": ["workspaceId", "threadId", "presentationLimit", "presentationBeforePosition"],
  "threads.process": ["workspaceId", "threadId", "processId", "afterSeq", "cursor", "throughSeq", "limit"],
  "threads.events": ["workspaceId", "threadId", "limit", "beforeSeq"],
  "threads.summary": ["workspaceId", "threadId"],
  "threads.prefs": ["workspaceId", "threadId"],
  "threads.latestPrefs": ["workspaceId", "engine", "threadId"],
  "threads.groups.list": ["workspaceId"],
  "threads.groups.create": ["workspaceId", "name"],
  "threads.groups.rename": ["workspaceId", "groupId", "name"],
  "threads.groups.delete": ["workspaceId", "groupId"],
  "threads.group.assign": ["workspaceId", "threadId", "groupId"],
  "threads.pin": ["workspaceId", "threadId", "pinned"],
  "threads.clear": ["workspaceId", "threadId", "resetSession"],
  "threads.compact": ["workspaceId", "threadId", "accessMode", "contextWindow", "autoCompactPct", "serviceTier", "turnId"],
  "threads.restartCodexAppServer": ["workspaceId", "threadId"],
  "threads.managedServices.list": ["workspaceId", "threadId"],
  "threads.managedServices.stop": ["workspaceId", "threadId", "serviceId"],
  "threads.inputActions.list": ["workspaceId", "threadId", "trigger"],
  "threads.fileChanges.list": ["workspaceId", "threadId"],
  "threads.fileChanges.diff": ["workspaceId", "threadId", "path"],
  "threads.fileChanges.accept": ["workspaceId", "threadId", "paths"],
  "threads.fileChanges.undo": ["workspaceId", "threadId", "paths"],
  "threads.rollback": ["workspaceId", "threadId", "toTurnId", "rollbackFiles", "skipPaths"],
  "threads.rollback.preview": ["workspaceId", "threadId", "toTurnId"],
  "threads.messages.delete": ["workspaceId", "threadId", "itemId"],
  "orch.chat.get": ["workspaceId", "threadId"],
  "orch.chat.settings": ["workspaceId", "threadId", "enabled"],
  "orch.chat.action": ["workspaceId", "threadId", "taskId", "requestId", "action", "expectedVersion", "resultVersion", "nodeId", "nodeVersion", "feedbackAction", "feedback", "targetNodeId"],
  "orch.chat.natural": ["workspaceId", "threadId", "text", "requestId"],
  "orch.chat.rework": ["workspaceId", "threadId", "taskId", "nodeId", "reason"],
  "orch.chat.delete": ["workspaceId", "threadId", "taskId", "expectedVersion", "requestId"],
  "workspacePrefs.get": ["workspaceId"],
  "workspacePrefs.save": ["workspaceId", "prefs"],
  "orch.roles.list": ["workspaceId"],
  "orch.roles.upsert": ["workspaceId", "role"],
  "orch.roles.delete": ["workspaceId", "roleId"],
  "orch.workflows.list": ["workspaceId"],
  "orch.workflows.upsert": ["workspaceId", "workflow"],
  "orch.workflows.delete": ["workspaceId", "workflowId"],
  "orch.knowledgeBundles.list": ["workspaceId"],
  "orch.knowledgeBundles.upsert": ["workspaceId", "bundle"],
  "orch.knowledgeBundles.delete": ["workspaceId", "bundleId"],
  "orch.toolsets.list": ["workspaceId"],
  "orch.toolsets.upsert": ["workspaceId", "toolset"],
  "orch.toolsets.delete": ["workspaceId", "toolsetId"],
  "orch.skills.list": ["workspaceId"],
  "orch.skills.upsert": ["workspaceId", "skill"],
  "orch.skills.delete": ["workspaceId", "skillId"],
  "skills.suites": ["workspaceId", "includeMcpStatus"],
  "skills.install": ["workspaceId", "targets", "suiteId", "suite"],
  "skills.uninstall": ["workspaceId", "targets", "suiteId"],
  "mcp.install": ["workspaceId", "mcpId", "instanceId", "npmPackage", "version", "serverName", "name", "description", "homepage"],
  "mcp.enable": ["workspaceId", "mcpId", "instanceId", "npmPackage", "engine", "version", "serverName", "name", "description", "homepage", "installType", "transportType", "command", "args", "url", "pythonPackage", "runner", "credentialInputs"],
  "mcp.update": ["workspaceId", "mcpId", "instanceId", "npmPackage", "engine", "version", "serverName", "name", "description", "homepage", "installType", "transportType", "command", "args", "url", "pythonPackage", "runner", "credentialInputs"],
  "mcp.test": ["workspaceId", "mcpId", "instanceId", "npmPackage", "engine", "serverName", "name", "description", "homepage"],
  "mcp.import": ["workspaceId", "sources"],
  "mcp.uninstall": ["workspaceId", "mcpId", "instanceId", "npmPackage", "serverName"],
  "mcp.configure": ["workspaceId", "mcpId", "instanceId", "npmPackage", "engine", "serverName", "name", "description", "homepage", "installType", "transportType", "command", "args", "url", "pythonPackage", "runner", "credentialInputs"],
  "mcp.unconfigure": ["workspaceId", "mcpId", "instanceId", "npmPackage", "engine", "serverName"],
  "orch.assets.copy": ["workspaceId", "assetType", "assetId"],
  "orch.assetDrafts.generate": ["workspaceId", "assetKind", "mode", "targetAssetId", "roleSnapshot", "skillSnapshot", "clientRequestId", "prompt", "contextOptions", "enginePreference"],
  "orch.assetDrafts.get": ["workspaceId", "draftId"],
  "orch.assetDrafts.apply": ["workspaceId", "draftId", "expectedJobId", "expectedBaseVersionId", "forceApplyWarnings", "review"],
  "orch.assetDrafts.reject": ["workspaceId", "draftId", "reason", "review"],
  "orch.assetDraftJobs.list": ["workspaceId", "limit"],
  "orch.assetDraftJobs.get": ["workspaceId", "jobId"],
  "orch.assetDraftJobs.delete": ["workspaceId", "jobId"],
  "orch.assetDraftJobs.resume": ["workspaceId", "jobId", "prompt", "selectedPaths", "targetThreadId", "enginePreference"],
  "orch.assetGroups.list": ["workspaceId", "assetType"],
  "orch.assetGroups.create": ["workspaceId", "assetType", "name"],
  "orch.assetGroups.rename": ["workspaceId", "assetType", "groupId", "name"],
  "orch.assetGroups.delete": ["workspaceId", "assetType", "groupId"],
  "orch.assetGroups.assign": ["workspaceId", "assetType", "assetId", "groupId"],
  "orch.requirementAnalysis.sessions.list": ["workspaceId", "limit", "cursor", "search", "statuses", "onlyRelatedToMe"],
  "orch.requirementAnalysis.sessions.create": ["workspaceId", "threadId", "title"],
  "orch.requirementAnalysis.sessions.get": ["workspaceId", "sessionId"],
  "orch.requirementAnalysis.createIntakes": ["workspaceId", "sessionId", "candidateIds", "workflowSelections"],
  "orch.intakes.list": ["workspaceId", "limit", "cursor", "search", "statuses", "sourceKind", "onlyRelatedToMe"],
  "orch.intakes.create": ["workspaceId", "intake"],
  "orch.intakes.upsert": ["workspaceId", "intake"],
  "orch.intakes.delete": ["workspaceId", "intakeId", "forceDeleteRunning"],
  "orch.proposals.list": ["workspaceId", "summaryOnly", "limit", "cursor"],
  "orch.proposals.get": ["workspaceId", "proposalId"],
  "orch.proposals.create": ["workspaceId", "workflowId", "roleId", "intakeId", "intake"],
  "orch.proposals.confirm": ["workspaceId", "proposalId"],
  "orch.instances.list": ["workspaceId", "limit", "cursor", "sourceKind", "onlyRelatedToMe"],
  "orch.instances.get": ["workspaceId", "instanceId"],
  "orch.instances.runtimePatch": ["workspaceId", "instanceId"],
  "orch.instances.start": ["workspaceId", "proposalId", "executionEngineStrategy", "roleExecutionOverrides", "runPlan"],
  "orch.instances.pause": ["workspaceId", "instanceId"],
  "orch.instances.resume": ["workspaceId", "instanceId", "nodeId", "feedback", "artifactIds"],
  "orch.instances.cancel": ["workspaceId", "instanceId"],
  "orch.instances.feedback": ["workspaceId", "instanceId", "nodeId", "action", "targetNodeId", "feedback", "images", "artifactIds"],
  "orch.instances.rerunFromNode": ["workspaceId", "instanceId", "targetNodeId", "note", "images", "threadReusePolicy", "downstreamThreadReusePolicy", "rerunNodeIds", "roleExecutionOverrides", "applyLatestWorkItemPolicy"],
  "orch.nodes.start": ["workspaceId", "instanceId", "nodeId", "feedback"],
  "orch.nodes.skip": ["workspaceId", "instanceId", "nodeId"],
  "orch.nodes.cancel": ["workspaceId", "instanceId", "nodeId"],
  "orch.artifacts.list": ["workspaceId", "instanceId", "includeContent"],
  "orch.artifacts.get": ["workspaceId", "artifactId"],
  "orch.artifacts.revise": ["workspaceId", "instanceId", "nodeId", "artifactId", "note", "answer", "workspaceFiles"],
  "orch.artifactFiles.list": ["workspaceId", "artifactId"],
  "orch.events.list": ["workspaceId", "instanceId", "limit", "includePayload"],
  "orch.promptSnapshots.list": ["workspaceId", "instanceId", "nodeId", "limit", "includeContent"],
  "orch.promptSnapshots.get": ["workspaceId", "promptSnapshotId"],
  "orch.nodeWorkItems.list": ["workspaceId", "instanceId", "nodeId", "search", "statuses", "includeDeleted", "limit", "cursor"],
  "orch.nodeWorkItemEvents.list": ["workspaceId", "instanceId", "nodeId", "itemId", "limit", "cursor"],
  "orch.workflowExecutionDefaults.get": ["workspaceId", "workflowId"],
  "orch.workflowExecutionDefaults.upsert": ["workspaceId", "workflowId", "engine", "model"],
  "orch.workflowExecutionDefaults.delete": ["workspaceId", "workflowId"],
  // 编排扩展方法由 prepareOrchestrationRequestBody 校验关键形状，字段集合随业务演进。
  "orch.assigneeTemplates.list": null,
  "orch.assigneeTemplates.upsert": null,
  "orch.assigneeTemplates.delete": null,
  "orch.assetBundles.export": null,
  "orch.assetBundles.import": null,
  "orch.experiments.freeze": null,
  "orch.experiments.run.start": null,
  "orch.experiments.run.cancel": null,
  "orch.experiments.run.status": null,
  "orch.instances.discussionThread.ensure": null,
  "orch.instances.reassignNode": null,
  "orch.metrics.collect": null,
  "orch.pendingMine.list": null,
  "orch.requirementAnalysis.messages.send": null,
  "orch.requirementAnalysis.sessions.archive": null,
  "orch.runtimeEvidence.get": null,
  "orch.skills.install": ["workspaceId", "skillId", "targets"],
  "orch.skills.installStatus": ["workspaceId", "skillId"],
  "orch.skills.uninstall": ["workspaceId", "skillId", "targets"],
  "fs.tree": ["workspaceId", "dirPath", "depth", "showHidden"],
  "fs.search": ["workspaceId", "query", "limit", "cursor", "includeHidden", "kind"],
  "fs.reindex": ["workspaceId"],
  "fs.stat": ["workspaceId", "path"],
  "fs.downloadFile": ["workspaceId", "path"],
  "fs.readFile": ["workspaceId", "path", "maxBytes"],
  "fs.spreadsheetPreview": ["workspaceId", "path", "sheetName", "maxRows", "maxColumns"],
  "fs.documentPreview": ["workspaceId", "path"],
  "fs.extractAttachment": ["workspaceId", "fileName", "base64"],
  "fs.uploadBegin": ["workspaceId", "targetDir", "fileName", "sizeBytes", "mimeType", "overwrite"],
  "fs.uploadChunk": ["workspaceId", "uploadId", "offset", "base64"],
  "fs.uploadComplete": ["workspaceId", "uploadId"],
  "fs.uploadCancel": ["workspaceId", "uploadId"],
  "terminal.shells.list": ["workspaceId"],
  "terminal.actions.list": ["workspaceId"],
  "terminal.actions.save": ["workspaceId", "actions"],
  "terminal.create": ["workspaceId", "requestId", "label", "shell", "cwd"],
  "terminal.input": ["workspaceId", "terminalId", "data"],
  "terminal.resize": ["workspaceId", "terminalId", "cols", "rows"],
  "terminal.rename": ["workspaceId", "terminalId", "label"],
  "terminal.close": ["workspaceId", "terminalId"],
  "terminal.list": ["workspaceId", "requestId"],
  "terminal.runAction": ["workspaceId", "actionId", "requestId"],
  "git.status": ["workspaceId", "repositoryPath"],
  "git.diff": ["workspaceId", "repositoryPath", "path", "staged"],
  "git.diffFiles": ["workspaceId", "repositoryPath", "path", "staged"],
  "git.stage": ["workspaceId", "repositoryPath", "paths"],
  "git.unstage": ["workspaceId", "repositoryPath", "paths"],
  "git.discard": ["workspaceId", "repositoryPath", "paths"],
  "git.commit": ["workspaceId", "repositoryPath", "message", "amend"],
  "git.log": ["workspaceId", "repositoryPath", "maxCount", "skip", "headCommit"],
  "git.show": ["workspaceId", "repositoryPath", "hash", "includeDiff"],
  "git.showFileDiff": ["workspaceId", "repositoryPath", "hash", "path"],
  "git.branch.list": ["workspaceId", "repositoryPath"],
  "git.branch.create": ["workspaceId", "repositoryPath", "name", "startPoint"],
  "git.branch.switch": ["workspaceId", "repositoryPath", "name"],
  "git.branch.delete": ["workspaceId", "repositoryPath", "name", "force"],
} satisfies Record<Exclude<DesktopApiRequest["method"], `knowledge.assets.${string}`>, readonly string[] | null>;

/** 本机终端控制面方法；只由桌面未关联账号模式分发。 */
const TERMINAL_RUNTIME_METHODS = new Set<DesktopApiRequest["method"]>([
  "terminal.create", "terminal.input", "terminal.resize", "terminal.rename", "terminal.close", "terminal.list", "terminal.runAction",
]);

/** 只将可判定的输入错误翻译为失败响应；运行异常交给生命周期边界记录。 */
class DesktopRequestError extends Error {
  /** 保留输入错误状态，禁止把数据库或文件系统故障伪装成参数错误。 */
  constructor(readonly status: number, message: string) { super(message); }
}

/** 桌面适配器仅在同步参数装配、仓储操作与诊断期间占用数据库许可。 */
function withDesktopDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 桌面只做可信输入装配和响应关联，业务复用既有 Client 处理器与资产服务。 */
export async function executeDesktopApiRequest(ctx: ApiHandlerContext, request: DesktopApiRequest, input: {
  requestId: string;
  clientVersion: string | null;
  startedAt: number;
}): Promise<DesktopApiResponse> {
  let body: Record<string, unknown>;
  try {
    body = await withDesktopDatabase(ctx, input.requestId, () => request.method.startsWith("knowledge.assets.")
      ? prepareKnowledgeAssetRequestBody(ctx, request, input.requestId)
      : prepareRequestBody(ctx, request));
    if (request.method === "orch.assetBundles.export") {
      return await withDesktopDatabase(ctx, input.requestId, () => {
      const workspaceId = body.workspaceId as WorkspaceId;
      const args = { db: scopeApiHandlerContext(ctx, workspaceId).db, workspaceId, strictDependencies: true };
      const bundle = Array.isArray(body.workflowIds) && body.workflowIds.length ? exportWorkflowDependencyBundle({ ...args, workflowIds: body.workflowIds as string[] })
        : Array.isArray(body.roleIds) && body.roleIds.length ? exportRoleDependencyBundle({ ...args, roleIds: body.roleIds as string[] })
        : Array.isArray(body.knowledgeBundleIds) && body.knowledgeBundleIds.length ? exportKnowledgeBundleDependencyBundle({ ...args, knowledgeBundleIds: body.knowledgeBundleIds as string[] })
        : Array.isArray(body.skillIds) && body.skillIds.length ? exportSkillDependencyBundle({ ...args, skillIds: body.skillIds as string[] })
        : exportToolsetDependencyBundle({ ...args, toolsetIds: body.toolsetIds as string[] });
      return { status: 200, body: { ok: true, bundle } };
      });
    }
  }
  catch (error) {
    if (!(error instanceof DesktopRequestError)) throw error;
    await recordDesktopRequestFailure(ctx, request, input.requestId, error.status, error, "DESKTOP_REQUEST_REJECTED");
    const code = error.status === 404 ? "NOT_FOUND" : error.status === 403 ? "FORBIDDEN" : error.status === 409 ? "CONFLICT" : "BAD_REQUEST";
    return { status: error.status, body: { ok: false, code, message: error.message } };
  }
  if (request.method.startsWith("quickPhrases.")) {
    const response = await withDesktopDatabase(ctx, input.requestId, () => executeLocalQuickPhraseRequest(ctx.db.applicationDb, request.method, body));
    if (response.status >= 400) await recordDesktopRequestFailure(ctx, request, input.requestId, response.status, response.body, "LOCAL_QUICK_PHRASE_REJECTED", true);
    return response;
  }
  if (request.method === "runtime.builtinAssets.list") {
    if (!ctx.loadServerDefaultBundles) throw new Error("DESKTOP_BUILTIN_BUNDLES_UNAVAILABLE");
    const bundles = await ctx.loadServerDefaultBundles();
    const type = body.assetType as import("@codeflowai/shared").OrchAssetType;
    const items = bundles.flatMap(bundle => {
      const entries = type === "role" ? bundle.roles.map(entry => ({ sourceId: entry.sourceId, definition: entry.role }))
        : type === "workflow" ? bundle.workflows.map(entry => ({ sourceId: entry.sourceId, definition: entry.workflow }))
        : type === "skill" ? (bundle.skills ?? []).map(entry => ({ sourceId: entry.sourceId, definition: entry.skill }))
        : type === "toolset" ? bundle.toolsets.map(entry => ({ sourceId: entry.sourceId, definition: entry.toolset }))
        : bundle.knowledgeBundles.map(entry => ({ sourceId: entry.sourceId, definition: entry.knowledgeBundle }));
      return entries.map(entry => ({
        assetType: type, assetId: `${bundle.bundleId}:${type}:${entry.sourceId}`, revision: bundle.bundleVersion, scopeType: "builtin",
        contentHash: crypto.createHash("sha256").update(JSON.stringify(entry.definition)).digest("hex"),
        definition: { ...entry.definition, id: entry.sourceId, kind: "builtin" },
      }));
    });
    return { status: 200, body: { ok: true, items } };
  }
  if (request.method.startsWith("runtime.cloudAccount.")) {
    if (!ctx.desktopCloudAccount) throw new Error("DESKTOP_CLOUD_RUNTIME_UNAVAILABLE");
    const account = request.method === "runtime.cloudAccount.link"
      ? await ctx.desktopCloudAccount.link({ serverOrigin: body.serverOrigin as string, sessionToken: body.sessionToken as string })
      : request.method === "runtime.cloudAccount.unlink" ? await ctx.desktopCloudAccount.unlink() : ctx.desktopCloudAccount.snapshot();
    return { status: 200, body: { ok: true, account } };
  }
  if (request.method === "engineKeys.builtInRelay.ensure") {
    if (!ctx.builtInRelayCredentials || !ctx.desktopCloudAccount) throw new Error("DESKTOP_BUILTIN_SERVICE_UNAVAILABLE");
    const owner = ctx.desktopCloudAccount.getOwner();
    if (!owner) throw new Error("DESKTOP_CLOUD_OWNER_STALE_OR_UNAVAILABLE");
    let key: Awaited<ReturnType<typeof ctx.builtInRelayCredentials.ensure>>;
    try {
      key = await ctx.builtInRelayCredentials.ensure({ engine: body.engine as "codex" | "claude", providerId: body.providerId as string, intent: body.intent as "manual" | "auto" | "reset", requestId: input.requestId,
        ...(body.engine === "codex" ? { prepareKeySwitch: async () => { await prepareCodexKeySwitch(ctx, body.stopRunningTurns === true); await ctx.sessions.restartCodexProcesses(); } } : {}) });
    } catch (error) {
      if (error instanceof DesktopBuiltInRelayRequestError) {
        logger[error.status >= 500 ? "error" : "warn"]("desktop-api", "builtin credential request rejected", { errorCode: error.code, requestId: input.requestId, clientId: ctx.clientId, workspaceId: body.workspaceId, providerId: body.providerId, status: error.status, rootCause: error.message });
        return { status: error.status, body: { ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
      }
      const failure = error as { code?: string; details?: Record<string, unknown> };
      if (failure?.code !== "CONFLICT") throw error;
      logger.warn("desktop-api", "builtin key switch requires confirmation", { errorCode: "CONFLICT", requestId: input.requestId, clientId: ctx.clientId, workspaceId: body.workspaceId, reason: failure.details?.reason ?? null, rootCause: "key switch precondition failed" });
      return { status: 409, body: { ok: false, code: "CONFLICT", message: "内置 Key 切换前需要处理运行中的回合", details: failure.details } };
    }
    const runtimeAvailable = ctx.builtInRelayCredentials.isAvailable(key);
    if (key.engine === "codex" && key.providerId === "openai" && runtimeAvailable) ctx.desktopCloudAccount.markBuiltInRelayReady(owner);
    const { secretRef: _secretRef, ...entry } = key;
    return { status: 200, body: { ok: true, key: { ...entry, apiKey: "", runtimeAvailable }, accountGeneration: ctx.desktopCloudAccount.snapshot().generation } };
  }
  if (TERMINAL_RUNTIME_METHODS.has(request.method)) {
    const responses: DesktopApiResponse[] = [];
    let responded = false;
    const terminalContext: ApiHandlerContext = { ...ctx,
      localWorkspaceOnly: true,
      /** 终端控制面只截获本请求的 api.res；其他消息仍交原传输边界。 */
      send(message) {
        if (message.t !== "api.res" || message.id !== input.requestId) return ctx.send(message);
        if (responded) throw new Error("DESKTOP_API_RESPONSE_INVALID: repeated terminal api.res");
        responded = true;
        responses.push({ status: message.status, body: message.body });
      },
    };
    await handleTerminalRuntimeApi(terminalContext, { t: "api.req", id: input.requestId, method: request.method, path: "/desktop", body } as ApiRequestMessage);
    if (!responded || responses.length !== 1) throw new Error("DESKTOP_API_RESPONSE_INVALID: expected one matching terminal api.res");
    const response = responses[0]!;
    if (response.status >= 400) {
      await recordDesktopRequestFailure(ctx, { ...request, body } as DesktopApiRequest, input.requestId, response.status, response.body, "DESKTOP_OPERATION_REJECTED", true);
    }
    return response;
  }
  if (request.method === "runtime.info") {
    if (!input.clientVersion?.trim()) throw new Error("DESKTOP_CLIENT_VERSION_REQUIRED");
    const client: OnlineClientInfo = {
      clientId: ctx.clientId, deviceId: ctx.deviceId ?? null, name: os.hostname(), version: input.clientVersion.trim(),
      platform: process.platform, arch: process.arch, connectedAt: input.startedAt,
      workspaceIds: [...ctx.workspaces.keys()],
    };
    return { status: 200, body: { ok: true, client } };
  }
  if (request.method === "runtime.activity") {
    // 只读快照：退出确认据此提示用户，不触发任何会话或迁移副作用。
    const runningTurns = ctx.sessions.listActiveTurns().flatMap(({ threadId, turnId, engine }) => {
      const thread = ctx.db.threads.get(threadId);
      return thread ? [{
        workspaceId: thread.workspaceId,
        threadId,
        title: thread.title,
        engine,
        turnId,
      }] : [];
    });
    return { status: 200, body: { ok: true, activity: { runningTurns } } };
  }
  const activationKey = request.method === "engineKeys.activate" ? await withDesktopDatabase(ctx, input.requestId, () => ctx.db.engineKeys.get(String(body.id ?? ""))) : null;
  const activationOwner = activationKey?.source === "builtin" && activationKey.engine === "codex" && activationKey.providerId === "openai" ? ctx.desktopCloudAccount?.getOwner() : null;
  const responses: DesktopApiResponse[] = [];
  let invalidResponse = false;
  let failureLogged = false;
  let releaseEarlyResponse!: () => void;
  const earlyResponse = new Promise<void>(resolve => { releaseEarlyResponse = resolve; });
  const scopedContext = await withDesktopDatabase(ctx, input.requestId, () => isWorkspaceCoreApiRequest(request.method) && typeof body.workspaceId === "string" && ctx.workspaces.has(body.workspaceId as WorkspaceId)
    ? scopeApiHandlerContext(ctx, body.workspaceId as WorkspaceId, { readonly: isThreadHistoryReadApiRequest(request.method),
      deferPersistenceCheck: isWorkspacePersistenceRecoveryApiRequest(request.method) }) : ctx);
  const localContext: ApiHandlerContext = {
    ...scopedContext,
    localWorkspaceOnly: true,
    intakeWorkspaceScope: typeof body.workspaceId === "string" ? { scopeType: "local_workspace", scopeId: body.workspaceId } : undefined,
    /** 只保存本请求原 owner 的日志事实，不改变业务响应或错误传播。 */
    onApiFailureLogged() { failureLogged = true; },
    /** api.res 不能泄露到云端；其他消息继续使用原有传输返回值。 */
    send(message) {
      if (message.t !== "api.res") return ctx.send(message);
      if (message.id !== input.requestId) invalidResponse = true;
      if (responses.length > 0) throw new WorkspaceApiRequestFailure([new Error("DESKTOP_API_RESPONSE_INVALID: repeated api.res")], {
        code: "WORKSPACE_API_RESPONSE_FAILED", requestId: input.requestId, method: request.method,
        workspaceId: typeof body.workspaceId === "string" ? body.workspaceId as WorkspaceId : null, responseAttempted: true, responseDelivered: true,
      });
      responses.push({ status: message.status, body: message.body });
      if (!invalidResponse && request.method === "turns.interrupt" && ctx.trackApiTail && message.status === 200
        && (message.body as { phase?: unknown })?.phase === "draining") releaseEarlyResponse();
    },
  };
  const apiRequest: ApiRequestMessage = { t: "api.req", id: input.requestId, method: request.method, path: "/desktop", body };
  const handling = handleApiRequest(localContext, apiRequest).then(() => {
    if (invalidResponse || responses.length !== 1) throw new Error("DESKTOP_API_RESPONSE_INVALID: expected one matching api.res");
  });
  if (request.method === "turns.interrupt" && ctx.trackApiTail) {
    const early = await Promise.race([handling.then(() => false), earlyResponse.then(() => true)]);
    if (early) ctx.trackApiTail(handling, { requestId: input.requestId, method: request.method,
      workspaceId: typeof body.workspaceId === "string" ? body.workspaceId as WorkspaceId : null,
      threadId: typeof body.threadId === "string" ? body.threadId as ThreadId : null });
  } else await handling;
  const response = responses[0]!;
  // 原命令处理器返回目录正文；桌面补齐 HTTP 层原本添加的统一成功信封。
  if (request.method === "threads.inputActions.list" && response.status === 200) {
    const catalog = response.body as { engine?: unknown; actions?: unknown; providerCatalog?: unknown; ok?: unknown };
    if (!catalog || catalog.ok === false || !["codex", "claude"].includes(String(catalog.engine)) || !Array.isArray(catalog.actions)
      || !catalog.providerCatalog || typeof catalog.providerCatalog !== "object") throw new Error("DESKTOP_INPUT_ACTION_CATALOG_INVALID");
    return { ...response, body: { ...catalog, ok: true } };
  }
  // 手动激活沿既有 handler 完成后，才提交相同 owner 的 Key 恢复事实。
  if (activationOwner && response.status === 200 && (response.body as { ok?: boolean }).ok === true) {
    const key = await withDesktopDatabase(ctx, input.requestId, () => ctx.db.engineKeys.get(activationKey!.id));
    if (key?.source === "builtin" && key.engine === "codex" && key.providerId === "openai" && ctx.builtInRelayCredentials?.isAvailable(key)) ctx.desktopCloudAccount!.markBuiltInRelayReady(activationOwner);
  }
  if (response.status >= 400 && !failureLogged) {
    await recordDesktopRequestFailure(ctx, { ...request, body } as DesktopApiRequest, input.requestId, response.status, response.body, "DESKTOP_OPERATION_REJECTED", true);
  }
  if (request.method === "workspaces.list" && response.status === 200) {
    const result = response.body as { ok: boolean; workspaces: Array<{ id: WorkspaceId }> };
    if (!Array.isArray(result.workspaces)) throw new Error("DESKTOP_API_RESPONSE_INVALID: workspace list missing");
    return { ...response, body: { ...result, workspaces: result.workspaces
      .filter((workspace) => isLocalWorkspaceId(ctx, workspace.id) && ctx.workspaces.has(workspace.id))
      .map((workspace) => ({ ...workspace, ownerClientId: ctx.clientId, kind: "local" })) } };
  }
  if (request.method === "threads.create" && response.status === 200) {
    return { ...response, body: { ...(response.body as Record<string, unknown>), threadId: body.threadId, engine: body.engine } };
  }
  return response;
}

/** 最终拒绝沿已核本机注册写W；无可信W时保应用级，日志双错交原请求owner。 */
async function recordDesktopRequestFailure(ctx: ApiHandlerContext, request: DesktopApiRequest, requestId: string, status: number, cause: unknown, fallbackCode: string, workspaceValidated = false): Promise<void> {
  let workspaceId: WorkspaceId | null = null;
  try {
    await withDesktopDatabase(ctx, requestId, () => {
    const body = request?.body as Record<string, unknown> | undefined;
    const candidate = typeof body?.workspaceId === "string" ? body.workspaceId.trim() as WorkspaceId : null;
    if (workspaceValidated && candidate && isLocalWorkspaceId(ctx, candidate) && ctx.workspaces.has(candidate)) {
      const registered = ctx.db.workspaces.get(candidate);
      if (registered && path.resolve(registered.path) === path.resolve(ctx.workspaces.get(candidate)!)) workspaceId = candidate;
    }
    const description = describeWorkspaceApiFailure(cause), code = description.code ?? fallbackCode;
    const data = { code, errorCode: code, requestId, workspaceId, clientId: ctx.clientId, method: request?.method ?? null, status,
      event: { category: "desktop-api", action: request?.method ?? null, outcome: "fail" },
      threadId: body?.threadId ?? null, turnId: body?.turnId ?? null, instanceId: body?.instanceId ?? null,
      proposalId: body?.proposalId ?? null, intakeId: body?.intakeId ?? null, artifactId: body?.artifactId ?? null,
      jobId: body?.jobId ?? null, draftId: body?.draftId ?? null, targetAssetId: body?.targetAssetId ?? null,
      suiteId: body?.suiteId ?? null, skillId: body?.skillId ?? null, mcpId: body?.mcpId ?? null,
      rootCause: description.rootCause };
    const level = status >= 500 ? "error" : "warn";
    if (workspaceId) ctx.db.writeWorkspaceLog(workspaceId, { level, tag: "desktop-api", message: "local operation rejected", data });
    else logger[level]("desktop-api", "local operation rejected", data);
    });
  } catch (failure) {
    throw new WorkspaceApiRequestFailure([cause, failure], { code: "WORKSPACE_API_REQUEST_LOG_FAILED", requestId, workspaceId, method: request?.method ?? "unknown" });
  }
  ctx.onApiFailureLogged?.();
}

/** 按方法重新构造 body；renderer 不能传入 Server actor、共享身份或其他隐式字段。 */
/** 本机规格库不经过 Server：复用公开契约解析，并注入可信本机 actor。 */
function prepareKnowledgeAssetRequestBody(ctx: ApiHandlerContext, request: DesktopApiRequest, requestId: string): Record<string, unknown> {
  const action = request.method.slice("knowledge.assets.".length) as KnowledgeAssetAction;
  if (!([...KNOWLEDGE_ASSET_READ_ACTIONS, ...KNOWLEDGE_ASSET_WRITE_ACTIONS] as readonly string[]).includes(action)) {
    throw new DesktopRequestError(404, "未知知识操作");
  }
  const raw = request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? { ...(request.body as Record<string, unknown>) } : {};
  // Server 注入的 actor 不可信，下面统一使用本机 actor。
  delete raw.actorContext;
  const parsed = parseKnowledgeAssetRequest(action, raw);
  if (!parsed) throw new DesktopRequestError(400, "项目知识请求参数无效");
  const workspaceId = parsed.workspaceId as WorkspaceId;
  if (!isLocalWorkspaceId(ctx, workspaceId) || !ctx.workspaces.has(workspaceId)) throw new DesktopRequestError(403, "规格库仅支持已知本机工作区");
  requireHostedWorkspace(ctx, workspaceId);
  return { ...parsed, actorContext: {
    userId: resolveLocalActorUserId(ctx),
    accountRole: "personal_normal",
    enterpriseId: null,
    requestId,
    permissionScope: "account",
  } };
}

/** 本机入口严格投影字段并核对工作区；业务操作复用原 Client 处理器。 */
function prepareRequestBody(ctx: ApiHandlerContext, request: DesktopApiRequest): Record<string, unknown> {
  if (!request || typeof request !== "object" || request.method.startsWith("knowledge.assets.")
    || !Object.prototype.hasOwnProperty.call(ALLOWED_FIELDS, request.method)) {
    throw new DesktopRequestError(404, "未知桌面请求方法");
  }
  const body = request.body === undefined ? {} : request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DesktopRequestError(400, "请求 body 必须是对象");
  const fields = ALLOWED_FIELDS[request.method as Exclude<DesktopApiRequest["method"], `knowledge.assets.${string}`>] as readonly string[] | null | undefined;
  if (fields === undefined) throw new DesktopRequestError(404, "未知桌面请求方法");
  if (fields !== null) {
    for (const key of Object.keys(body)) if (!fields.includes(key)) throw new DesktopRequestError(400, `桌面请求不接受字段：${key}`);
  }
  if (request.method === "runtime.cloudAccount.link") return { serverOrigin: requiredText(body.serverOrigin, "serverOrigin"), sessionToken: requiredText(body.sessionToken, "sessionToken") };
  if (request.method === "runtime.cloudAccount.unlink" || request.method === "runtime.cloudAccount.status") return {};
  if (request.method === "engineKeys.builtInRelay.ensure") {
    const workspaceId = requiredText(body.workspaceId, "workspaceId");
    if (!isLocalWorkspaceId(ctx, workspaceId) || !ctx.workspaces.has(workspaceId as WorkspaceId)) throw new DesktopRequestError(403, "内置中转仅接收已知本机工作区");
    if (body.engine !== "codex" && body.engine !== "claude") throw new DesktopRequestError(400, "engine 无效");
    if (!["manual", "auto", "reset"].includes(String(body.intent))) throw new DesktopRequestError(400, "intent 无效");
    if (body.stopRunningTurns != null && typeof body.stopRunningTurns !== "boolean") throw new DesktopRequestError(400, "stopRunningTurns 必须是布尔值");
    return { workspaceId, engine: body.engine, providerId: requiredText(body.providerId, "providerId"), intent: body.intent, stopRunningTurns: body.stopRunningTurns === true };
  }
  if (request.method === "runtime.info" || request.method === "runtime.activity" || request.method === "workspaces.list") return {};
  if (request.method.startsWith("quickPhrases.")) return { ...body };
  if (request.method === "runtime.builtinAssets.list") {
    if (!["role", "workflow", "knowledge_bundle", "skill", "toolset"].includes(String(body.assetType))) throw new DesktopRequestError(400, "assetType 无效");
    return { assetType: body.assetType };
  }
  if (request.method === "clientFs.directoryTree") {
    if (body.dirPath != null && typeof body.dirPath !== "string") throw new DesktopRequestError(400, "dirPath 必须是字符串");
    if (body.showHidden != null && typeof body.showHidden !== "boolean") throw new DesktopRequestError(400, "showHidden 必须是布尔值");
    if (body.depth != null && (typeof body.depth !== "number" || !Number.isFinite(body.depth))) throw new DesktopRequestError(400, "depth 必须是数字");
    return { dirPath: body.dirPath ?? "", depth: body.depth, showHidden: body.showHidden === true };
  }
  if (request.method === "workspaces.upsert") {
    const title = requiredText(body.title, "title");
    const root = requiredText(body.path, "path");
    if (!path.isAbsolute(root)) throw new DesktopRequestError(400, "工作区路径必须是绝对路径");
    if (body.workspaceId !== undefined && typeof body.workspaceId !== "string") throw new DesktopRequestError(400, "workspaceId 必须是字符串");
    const rawId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const digest = crypto.createHash("sha256").update(normalizeWorkspacePathForDerivedId(root)).digest("hex");
    const workspaceId = localWorkspaceId(ctx, rawId || makeWorkspaceIdFromPathDigest(digest));
    if (ctx.db.workspaces.get(workspaceId)) requireHostedWorkspace(ctx, workspaceId);
    return { workspaceId, title, path: root };
  }
  if (request.method.startsWith("reminders.")) {
    if (request.method === "reminders.workspaceSummaries") return {};
    const workspaceId = requiredText(body.workspaceId, "workspaceId") as WorkspaceId;
    if (!isLocalWorkspaceId(ctx, workspaceId) || !ctx.workspaces.has(workspaceId)) throw new DesktopRequestError(403, "提醒仅支持已知本机工作区");
    requireHostedWorkspace(ctx, workspaceId);
    return { ...body, workspaceId };
  }
  if (request.method.startsWith("scheduledTasks.local.") || request.method.startsWith("scheduledTasks.account.")) return body;
  if (request.method.startsWith("skills.") || request.method.startsWith("mcp.") || /^orch\.skills\.(install|installStatus|uninstall)$/u.test(request.method)) {
    const workspaceId = assetIdentity(body.workspaceId, "workspaceId") as WorkspaceId;
    if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机工作区的精确 ID");
    requireHostedWorkspace(ctx, workspaceId);
    if (request.method === "skills.suites" && body.includeMcpStatus != null && typeof body.includeMcpStatus !== "boolean") throw new DesktopRequestError(400, "includeMcpStatus 必须是布尔值");
    return { ...body, workspaceId };
  }
  if (request.method.startsWith("threads.") || request.method === "turns.interrupt"
    || request.method === "approvals.respond" || request.method === "userInput.respond") return prepareThreadRequestBody(ctx, request.method, body);
  if (request.method.startsWith("orch.")) {
    const assetMethod = /^orch\.(?:roles|workflows|knowledgeBundles|toolsets|skills|assets|assetGroups)\./u.test(request.method)
      && !/^orch\.skills\.(?:install|installStatus|uninstall)$/u.test(request.method);
    if (assetMethod) return prepareAssetRequestBody(ctx, request.method, body);
    return prepareOrchestrationRequestBody(ctx, request.method, body);
  }
  if (request.method === "workspacePrefs.get" || request.method === "workspacePrefs.save") {
    const workspaceId = assetIdentity(body.workspaceId, "workspaceId") as WorkspaceId;
    if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机工作区的精确 ID");
    requireHostedWorkspace(ctx, workspaceId);
    return { ...body, workspaceId };
  }
  if (request.method.startsWith("fs.") || request.method.startsWith("git.")) {
    const workspaceId = assetIdentity(body.workspaceId, "workspaceId") as WorkspaceId;
    if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机工作区的精确 ID");
    requireHostedWorkspace(ctx, workspaceId);
    // 上传 ID 不能借当前工作区身份写入另一个已创建的传输。
    if (["fs.uploadChunk", "fs.uploadComplete", "fs.uploadCancel"].includes(request.method)) {
      const uploadId = assetIdentity(body.uploadId, "uploadId"), uploadPath = getUploadWorkspacePath(uploadId);
      if (!uploadPath || path.resolve(uploadPath) !== path.resolve(ctx.workspaces.get(workspaceId)!)) throw new DesktopRequestError(403, "上传不属于当前本机工作区");
    }
    return { ...body, workspaceId };
  }
  if (request.method.startsWith("terminal.")) {
    const workspaceId = requiredText(body.workspaceId, "workspaceId") as WorkspaceId;
    if (!isLocalWorkspaceId(ctx, workspaceId) || !ctx.workspaces.has(workspaceId)) throw new DesktopRequestError(403, "终端仅支持已知本机工作区");
    requireHostedWorkspace(ctx, workspaceId);
    return { ...body, workspaceId };
  }
  if (request.method.startsWith("engineKeys.") || request.method.startsWith("engineCustomModels.") || request.method === "engines.status") {
    const workspaceId = assetIdentity(body.workspaceId, "workspaceId") as WorkspaceId;
    if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机工作区的精确 ID");
    requireHostedWorkspace(ctx, workspaceId);
    return { ...body, workspaceId };
  }
  if (request.method === "software.update.status" || request.method === "software.npm.install") return { ...body };
  if (request.method.startsWith("workspaceDirectoryMigration.")) {
    const workspaceId = assetIdentity(body.workspaceId, "workspaceId") as WorkspaceId;
    if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机工作区的精确 ID");
    requireHostedWorkspace(ctx, workspaceId);
    return { ...body, workspaceId };
  }
  if (request.method === "clientDb.cleanup.status" || request.method === "clientDb.cleanup.start") {
    const clientId = requiredText(body.clientId, "clientId");
    if (clientId !== ctx.clientId) throw new DesktopRequestError(403, "清理请求必须指向当前 Client");
    if (request.method === "clientDb.cleanup.status") return { clientId };
    const inactiveBefore = body.inactiveBefore;
    if (typeof inactiveBefore !== "number" || !Number.isSafeInteger(inactiveBefore) || inactiveBefore <= 0 || inactiveBefore >= Date.now()) {
      throw new DesktopRequestError(400, "inactiveBefore 必须是早于当前时间的正整数时间戳");
    }
    return { clientId, inactiveBefore };
  }
  if (request.method === "codeflowai.config.get" || request.method === "codeflowai.config.set") {
    const workspaceId = assetIdentity(body.workspaceId, "workspaceId") as WorkspaceId;
    if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机工作区的精确 ID");
    requireHostedWorkspace(ctx, workspaceId);
    if (request.method === "codeflowai.config.get") return { workspaceId };
    // config 原样交给原 handler 归一化写入；这里只拒绝非对象输入。
    if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) throw new DesktopRequestError(400, "config 必须是对象");
    return { workspaceId, config: body.config };
  }
  const workspaceId = localWorkspaceId(ctx, requiredText(body.workspaceId, "workspaceId"));
  requireHostedWorkspace(ctx, workspaceId);
  if (request.method === "workspaces.delete") return { workspaceId };
  const profile = { workspaceId, userId: `local:${ctx.clientId}`, profileScopeType: "local_workspace", profileScopeId: workspaceId };
  if (request.method === "workspaceExecutionProfile.update") {
    if (typeof body.profileText !== "string") throw new DesktopRequestError(400, "profileText 必须是字符串");
    return { ...profile, profileText: body.profileText };
  }
  return profile;
}

type LocalAssetCollection = "roles" | "workflows" | "knowledgeBundles" | "toolsets" | "skills";
const ASSET_FIELDS = {
  roles: ["role", "roleId"], workflows: ["workflow", "workflowId"], knowledgeBundles: ["bundle", "bundleId"],
  toolsets: ["toolset", "toolsetId"], skills: ["skill", "skillId"],
} as const;

/** 个人资产固定本机归属；原件只读和依赖完整性在进入原处理器前校验。 */
function prepareAssetRequestBody(ctx: ApiHandlerContext, method: DesktopApiRequest["method"], body: Record<string, unknown>): Record<string, unknown> {
  const workspaceId = assetIdentity(body.workspaceId, "workspaceId") as WorkspaceId;
  if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机本地工作区的精确 ID");
  requireHostedWorkspace(ctx, workspaceId);
  ctx = scopeApiHandlerContext(ctx, workspaceId);
  if (method.startsWith("orch.assetGroups.")) {
    const assetType = assetIdentity(body.assetType, "assetType");
    if (!["role", "workflow", "knowledge", "skill", "toolset"].includes(assetType)) throw new DesktopRequestError(400, "assetType 无效");
    const result: Record<string, unknown> = { workspaceId, assetType };
    for (const field of ["name", "groupId", "assetId"]) {
      if (body[field] != null) result[field] = field === "groupId" && body[field] === "" ? "" : assetIdentity(body[field], field);
    }
    return result;
  }
  if (method === "orch.assets.copy") {
    const type = assetIdentity(body.assetType, "assetType");
    const collection = { role: "roles", workflow: "workflows", knowledge_bundle: "knowledgeBundles", toolset: "toolsets", skill: "skills" }[type] as LocalAssetCollection | undefined;
    if (!collection) throw new DesktopRequestError(400, "assetType 无效");
    const assetId = assetIdentity(body.assetId, "assetId");
    const asset = getLocalAsset(ctx, collection, assetId);
    if (!asset || asset.workspaceId !== workspaceId) throw new DesktopRequestError(404, "本机资产不存在");
    return { workspaceId, assetType: type, assetId };
  }
  const [, collection, action] = method.split(".") as [string, LocalAssetCollection, string];
  const [field, idField] = ASSET_FIELDS[collection];
  if (action === "list") return { workspaceId };
  const raw = body[field];
  if (action === "upsert" && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new DesktopRequestError(400, `${field} 必须是对象`);
  const definition = raw as Record<string, unknown>;
  const id = action === "delete" ? assetIdentity(body[idField], idField)
    : definition.id == null || definition.id === "" ? null : assetIdentity(definition.id, `${field}.id`);
  const existing = id ? getLocalAsset(ctx, collection, id) : null;
  if (action === "delete" && !existing) throw new DesktopRequestError(404, "本机资产不存在");
  if (existing && existing.workspaceId !== workspaceId) throw new DesktopRequestError(404, "本机资产不存在");
  if (existing?.kind === "builtin" || (action === "upsert" && definition.kind === "builtin")) throw new DesktopRequestError(403, "内置资产只读，请先复制为个人资产");
  if (action === "delete") {
    if (existing) assertAssetNotReferenced(ctx, workspaceId, collection, id!);
    return { workspaceId, [idField]: id };
  }
  if (definition.workspaceId != null && definition.workspaceId !== workspaceId) throw new DesktopRequestError(400, "资产不属于当前工作区");
  if (definition.kind != null && definition.kind !== "custom") throw new DesktopRequestError(400, "个人资产类型必须为 custom");
  if (definition.builtinGroup != null) throw new DesktopRequestError(400, "个人资产不接受内置分组");
  assertAssetReferences(ctx, workspaceId, collection, definition);
  if (existing && collection === "toolsets") assertAssetNotReferenced(ctx, workspaceId, collection, id!, definition);
  return { workspaceId, [field]: { ...definition, workspaceId, kind: "custom", builtinGroup: null } };
}

/** 标识原样入库，拒绝校验值与持久化值因空白归一化产生分歧。 */
function assetIdentity(value: unknown, field: string): string {
  const normalized = requiredText(value, field);
  if (value !== normalized) throw new DesktopRequestError(400, `${field} 不接受首尾空白`);
  return normalized;
}

/** 仅读取现有仓储，不按 ID 尾部或 renderer 提供的作用域猜测归属。 */
function getLocalAsset(ctx: ApiHandlerContext, collection: LocalAssetCollection, id: string) {
  switch (collection) {
    case "roles": return ctx.db.orchRoles.get(id as any);
    case "workflows": return ctx.db.orchWorkflows.get(id as any);
    case "knowledgeBundles": return ctx.db.orchKnowledgeBundles.get(id as any);
    case "toolsets": return ctx.db.orchToolsets.get(id as any);
    case "skills": return ctx.db.orchSkills.get(id as any);
  }
}

/** 引用须完整且精确属于本机工作区；可逐项检查完整导出闭包。 */
function assertAssetReferences(ctx: ApiHandlerContext, workspaceId: WorkspaceId, collection: LocalAssetCollection, definition: Record<string, unknown>,
  onReference?: (collection: LocalAssetCollection, id: string) => void): void {
  /** 校验一个现有引用，缺失与跨工作区均作为输入失败。 */
  const requireReference = (type: LocalAssetCollection, id: unknown): void => {
    const value = assetIdentity(id, "资产依赖 ID");
    const asset = getLocalAsset(ctx, type, value);
    if (!asset || asset.workspaceId !== workspaceId) throw new DesktopRequestError(400, `资产依赖不存在或不属于当前工作区：${value}`);
    onReference?.(type, value);
  };
  /** 可选依赖列表只接受字符串数组。 */
  const requireReferences = (type: LocalAssetCollection, ids: unknown): void => {
    if (ids == null) return;
    if (!Array.isArray(ids)) throw new DesktopRequestError(400, "资产依赖必须为数组");
    ids.forEach(id => requireReference(type, id));
  };
  if (collection === "roles") {
    requireReferences("knowledgeBundles", definition.defaultKnowledgeBundleIds);
    requireReferences("skills", definition.defaultSkillIds);
    if (definition.toolRefs != null && !Array.isArray(definition.toolRefs)) throw new DesktopRequestError(400, "toolRefs 必须为数组");
    for (const raw of definition.toolRefs as unknown[] ?? []) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DesktopRequestError(400, "工具引用必须为对象");
      const ref = raw as Record<string, unknown>;
      requireReference("toolsets", ref.toolsetId);
      const toolId = assetIdentity(ref.toolId, "toolId");
      if (!ctx.db.orchToolsets.get(ref.toolsetId as any)!.tools.some(tool => tool.id === toolId)) throw new DesktopRequestError(400, `工具不存在：${toolId}`);
    }
  }
  if (collection === "workflows") {
    requireReferences("knowledgeBundles", definition.workflowKnowledgeBundleIds);
    if (!Array.isArray(definition.nodes)) throw new DesktopRequestError(400, "流程 nodes 必须为数组");
    for (const raw of definition.nodes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DesktopRequestError(400, "流程节点必须为对象");
      if (raw.roleId != null) requireReference("roles", raw.roleId);
      requireReferences("knowledgeBundles", raw.knowledgeOverrideBundleIds);
    }
  }
}

/** 拒绝删除被引用资产或移除仍被角色使用的工具，避免留下悬空依赖。 */
function assertAssetNotReferenced(ctx: ApiHandlerContext, workspaceId: WorkspaceId, collection: LocalAssetCollection, id: string, replacement?: Record<string, unknown>): void {
  const roles = ctx.db.orchRoles.listByWorkspace(workspaceId);
  const workflows = ctx.db.orchWorkflows.listByWorkspace(workspaceId);
  const referenced = collection === "roles" ? workflows.some(workflow => workflow.nodes.some(node => node.roleId === id))
    : collection === "knowledgeBundles" ? roles.some(role => role.defaultKnowledgeBundleIds?.includes(id as any))
      || workflows.some(workflow => workflow.workflowKnowledgeBundleIds?.includes(id as any) || workflow.nodes.some(node => node.knowledgeOverrideBundleIds?.includes(id as any)))
    : collection === "skills" ? roles.some(role => role.defaultSkillIds?.includes(id as any))
    : collection === "toolsets" ? roles.some(role => role.toolRefs?.some(ref => ref.toolsetId === id
      && (!replacement || !Array.isArray(replacement.tools) || !replacement.tools.some(tool => tool?.id === ref.toolId))))
    : false;
  if (referenced) throw new DesktopRequestError(409, "资产仍被引用，请先修改引用方");
}

/** 校验本机线程归属；历史沿只读视图校验，知识续聊保留原 actor 与协作边界。 */
function prepareThreadRequestBody(ctx: ApiHandlerContext, method: DesktopApiRequest["method"], rawBody: Record<string, unknown>): Record<string, unknown> {
  const body = { ...rawBody };
  // Server 注入的 Web 会话标识不进入本机执行；知识会话 actor 由本机可信身份覆盖。
  delete body.updatedByWebSessionId;
  delete body.originWebSessionId;
  const workspaceId = requiredText(body.workspaceId, "workspaceId") as WorkspaceId;
  if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机本地工作区的精确 ID");
  requireHostedWorkspace(ctx, workspaceId);
  ctx = scopeApiHandlerContext(ctx, workspaceId, { readonly: isThreadHistoryReadApiRequest(method),
    deferPersistenceCheck: isWorkspacePersistenceRecoveryApiRequest(method) });
  return method === "threads.sendMessage"
    ? ctx.db.withWorkspaceCoreRepos(workspaceId, () => prepareScopedThreadRequestBody(ctx, method, body, workspaceId))
    : prepareScopedThreadRequestBody(ctx, method, body, workspaceId);
}

/** 已校验工作区内同步投影线程参数；发送预检的多次读取复用同一短连接。 */
function prepareScopedThreadRequestBody(ctx: ApiHandlerContext, method: DesktopApiRequest["method"], body: Record<string, unknown>, workspaceId: WorkspaceId): Record<string, unknown> {
  const actorUserId = resolveLocalActorUserId(ctx);
  if (["threads.sendMessage", "threads.queue.append", "approvals.respond", "userInput.respond"].includes(method)) {
    body.knowledgeConversationActorContext = {
      userId: ctx.desktopCloudAccount?.getOwner()?.ownerUserId?.trim() || actorUserId,
      permissionScope: "account",
    };
  }
  if (method === "threads.create") {
    if ((body.threadType != null && body.threadType !== "chat") || body.threadSubtype != null && body.threadSubtype !== "requirement-analysis") throw new DesktopRequestError(400, "仅能直接创建普通或需求分析本机会话");
    const engine = requiredText(body.engine, "engine");
    if (engine !== "claude" && engine !== "codex") throw new DesktopRequestError(400, "engine 无效");
    validateLocalRole(ctx, workspaceId, (body.initialPrefs as Record<string, unknown> | undefined)?.roleId);
    // Server 已创建会话 binding；远程创建必须沿用其 threadId，避免远端与本地 ID 分叉。
    const providedThreadId = body.threadId === undefined || body.threadId === null || body.threadId === ""
      ? null : assetIdentity(body.threadId, "threadId");
    return { ...body, workspaceId, title: requiredText(body.title, "title"), engine, threadId: providedThreadId ?? `thread_${crypto.randomUUID()}`, threadType: "chat", threadSubtype: body.threadSubtype ?? null };
  }
  if (method === "threads.groups.list") return { workspaceId, actorUserId };
  if (method === "threads.groups.create") return { workspaceId, name: requiredText(body.name, "name"), actorUserId };
  if (method === "threads.groups.rename") return { workspaceId, groupId: requiredText(body.groupId, "groupId"), name: requiredText(body.name, "name") };
  if (method === "threads.groups.delete") return { workspaceId, groupId: requiredText(body.groupId, "groupId") };
  if (method === "threads.list") {
    if (body.scope != null && (typeof body.scope !== "string" || normalizeThreadListScope(body.scope) !== body.scope)) throw new DesktopRequestError(400, "scope 无效");
    if (body.sort != null && (typeof body.sort !== "string" || normalizeThreadListSort(body.sort) !== body.sort)) throw new DesktopRequestError(400, "sort 无效");
    for (const field of ["search", "groupId", "cursor"]) {
      if (body[field] != null && typeof body[field] !== "string") throw new DesktopRequestError(400, `${field} 必须是字符串`);
    }
    for (const field of ["includeArchived", "onlyRelatedToMe"]) {
      if (body[field] != null && typeof body[field] !== "boolean") throw new DesktopRequestError(400, `${field} 必须是布尔值`);
    }
    validateHistoryInteger(body.limit, "limit");
    return { workspaceId, actorUserId, scope: body.scope, sort: body.sort, search: body.search, groupId: body.groupId,
      limit: body.limit, cursor: body.cursor, includeArchived: body.includeArchived, onlyRelatedToMe: body.onlyRelatedToMe };
  }
  let threadId: ThreadId | undefined;
  if (method !== "threads.latestPrefs" || body.threadId !== undefined) {
    threadId = requiredText(body.threadId, "threadId") as ThreadId;
    // 删除重试只读取已确认的本机任务；其他方法仍拒绝已隐藏会话。
    if (method === "threads.delete") {
      const deletion = ctx.db.threads.getDeletion(threadId);
      if (deletion?.workspaceId === workspaceId && deletion.sharedWorkspaceId === null) return { workspaceId, threadId };
    }
    const thread = ctx.db.threads.get(threadId);
    if (!thread || thread.workspaceId !== workspaceId) {
      throw new DesktopRequestError(404, "本机本地会话不存在");
    }
    const controlledMutation = method === "threads.sendMessage" || method === "threads.updatePrefs" || method === "turns.interrupt"
      || method === "approvals.respond" || method === "userInput.respond" || method.startsWith("threads.draft.") || method.startsWith("threads.queue.");
    if (controlledMutation && !(thread.threadType === "chat" && (!thread.threadSubtype || thread.threadSubtype === "requirement-analysis" || thread.threadSubtype === "node-discussion" || thread.threadSubtype === "knowledge-conversation")
      || thread.threadType === "orchestration" && (thread.threadSubtype === "node" || thread.threadSubtype === "asset-draft" || thread.threadSubtype === "knowledge-assets"))) throw new DesktopRequestError(400, "该会话尚未接入本机执行入口");
  }
  if (method === "threads.latestPrefs") {
    const engine = requiredText(body.engine, "engine");
    if (engine !== "codex" && engine !== "claude") throw new DesktopRequestError(400, "engine 无效");
    // 可选 threadId 交中央准入；原偏好查询仍只使用工作区与引擎。
    return { workspaceId, engine, ...(threadId ? { threadId } : {}) };
  }
  if (method === "threads.load" || method === "threads.events") {
    validateHistoryInteger(body.limit, "limit");
    validateHistoryInteger(body.beforeSeq, "beforeSeq");
    validateHistoryInteger(body.presentationLimit, "presentationLimit");
    validateHistoryInteger(body.presentationBeforePosition, "presentationBeforePosition");
    if (body.presentation !== undefined && body.presentation !== "lazy") throw new DesktopRequestError(400, "presentation 无效");
    return { workspaceId, threadId, limit: body.limit, beforeSeq: body.beforeSeq,
      presentationLimit: body.presentationLimit, presentationBeforePosition: body.presentationBeforePosition,
      ...(body.presentation === "lazy" ? { presentation: "lazy" } : {}) };
  }
  if (method === "threads.presentation") {
    validateHistoryInteger(body.presentationLimit, "presentationLimit");
    validateHistoryInteger(body.presentationBeforePosition, "presentationBeforePosition");
    return { workspaceId, threadId, presentationLimit: body.presentationLimit, presentationBeforePosition: body.presentationBeforePosition };
  }
  if (method === "threads.process") {
    for (const field of ["afterSeq", "throughSeq", "limit"]) validateHistoryInteger(body[field], field);
    if (body.cursor !== undefined && (typeof body.cursor !== "string" || !body.cursor || body.cursor.length > 512)) throw new DesktopRequestError(400, "cursor 无效");
    return { workspaceId, threadId, processId: requiredText(body.processId, "processId"),
      afterSeq: body.afterSeq, cursor: body.cursor, throughSeq: body.throughSeq, limit: body.limit };
  }
  if (method === "threads.sendMessage" || method === "threads.queue.append") {
    if (typeof body.text !== "string") throw new DesktopRequestError(400, "text 必须是字符串");
    if (method === "threads.sendMessage" && body.turnId != null && body.turnId !== "") {
      const turnId = assetIdentity(body.turnId, "turnId");
      const existing = ctx.db.turns.get(turnId as any);
      if (existing) {
        const replay = typeof body.clientItemId === "string" && body.clientItemId.trim()
          ? ctx.sendIdempotencyCache?.lookup(threadId!, body.clientItemId.trim()) : null;
        if (existing.workspaceId !== workspaceId || existing.threadId !== threadId || replay !== turnId) {
          throw new DesktopRequestError(409, "回合 ID 已使用，请重新发送");
        }
      }
    }
    const roleId = method === "threads.sendMessage" ? body.roleId : (body.sendOptions as Record<string, unknown> | undefined)?.roleId;
    validateLocalRole(ctx, workspaceId, roleId);
    return { ...body, workspaceId, threadId, executionProfileUserId: actorUserId,
      executionProfileScopeType: "local_workspace", executionProfileScopeId: workspaceId };
  }
  if (method === "threads.updatePrefs") validateLocalRole(ctx, workspaceId, (body.prefs as Record<string, unknown> | undefined)?.roleId);
  if (method === "turns.interrupt") {
    const turnId = assetIdentity(body.turnId, "turnId");
    const turn = ctx.db.turns.get(turnId as any);
    if (!turn || turn.threadId !== threadId || turn.workspaceId !== workspaceId) throw new DesktopRequestError(404, "本机会话回合不存在");
  }
  if (method.startsWith("threads.draft.") || method.startsWith("threads.queue.") || method === "threads.updatePrefs" || method === "turns.interrupt") {
    return { ...body, workspaceId, threadId };
  }
  if (method === "approvals.respond" || method === "userInput.respond") {
    if (!(typeof body.requestId === "string" && body.requestId.trim()) && !(typeof body.requestId === "number" && Number.isSafeInteger(body.requestId))) throw new DesktopRequestError(400, "requestId 必须是字符串或安全整数");
    return { ...body, workspaceId, threadId };
  }
  if (method === "threads.rename" || method === "threads.archive" || method === "threads.delete") return { ...body, workspaceId, threadId, actorUserId };
  if (method === "threads.group.assign") return { ...body, workspaceId, threadId, actorUserId };
  if (method === "threads.pin" || method === "threads.clear" || method === "threads.compact"
    || method === "threads.restartCodexAppServer" || method === "threads.managedServices.list" || method === "threads.managedServices.stop") {
    return { ...body, workspaceId, threadId };
  }
  if (method === "threads.inputActions.list" || method === "threads.fileChanges.list" || method === "threads.fileChanges.diff"
    || method === "threads.fileChanges.accept" || method === "threads.fileChanges.undo"
    || method === "threads.rollback" || method === "threads.rollback.preview" || method === "threads.messages.delete") {
    return { ...body, workspaceId, threadId };
  }
  return { workspaceId, threadId };
}

/** 本机固定可信身份与范围；会话工作流先复用线程归属检查，其余交原业务处理器。 */
function prepareOrchestrationRequestBody(ctx: ApiHandlerContext, method: DesktopApiRequest["method"], body: Record<string, unknown>): Record<string, unknown> {
  const workspaceId = assetIdentity(body.workspaceId, "workspaceId") as WorkspaceId;
  if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "仅支持本机工作区的精确 ID");
  requireHostedWorkspace(ctx, workspaceId);
  ctx = scopeApiHandlerContext(ctx, workspaceId);
  if (method.startsWith("orch.chat.")) {
    const threadId = assetIdentity(body.threadId, "threadId") as ThreadId;
    const thread = ctx.db.threads.get(threadId);
    if (!thread || thread.workspaceId !== workspaceId || thread.threadType !== "chat" || thread.threadSubtype
      || !isDesktopLocalThreadAssetExecution(ctx.clientId, ctx.workspaces, ctx.db, threadId)) {
      throw new DesktopRequestError(404, "本机普通会话不存在");
    }
    return { ...body, workspaceId, threadId, actorUserId: resolveLocalActorUserId(ctx),
      executionProfileScope: { scopeType: "local_workspace", scopeId: workspaceId } };
  }
  const actorUserId = `local:${ctx.clientId}`;
  const result: Record<string, unknown> = { ...body, workspaceId };
  if (method === "orch.assetBundles.export") {
    const selections = { roles: "roleIds", workflows: "workflowIds", knowledgeBundles: "knowledgeBundleIds", toolsets: "toolsetIds", skills: "skillIds" } as const;
    const visited = new Set<string>();
    /** 导出前校验完整引用闭包，拒绝缺失或跨工作区依赖。 */
    const validateExportAsset = (collection: LocalAssetCollection, id: string): void => {
      const key = `${collection}:${id}`;
      if (visited.has(key)) return;
      visited.add(key);
      const asset = getLocalAsset(ctx, collection, id);
      if (!asset || asset.workspaceId !== workspaceId) throw new DesktopRequestError(404, "本机资产不存在");
      assertAssetReferences(ctx, workspaceId, collection, asset as unknown as Record<string, unknown>, validateExportAsset);
    };
    let selectedKinds = 0;
    for (const [collection, field] of Object.entries(selections)) {
      const ids = body[field];
      if (ids === undefined) continue;
      if (!Array.isArray(ids)) throw new DesktopRequestError(400, `${field} 必须是数组`);
      if (ids.length) selectedKinds += 1;
      for (const rawId of ids) {
        validateExportAsset(collection as LocalAssetCollection, assetIdentity(rawId, field));
      }
    }
    if (selectedKinds !== 1) throw new DesktopRequestError(400, "每次导出必须选择一种资产类型");
  }
  if (method === "orch.assetBundles.import") {
    const bundle = body.bundle as import("@codeflowai/shared").OrchAssetBundle;
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new DesktopRequestError(400, "bundle 必须是对象");
    if (bundle.source?.kind === "server-default") throw new DesktopRequestError(403, "包内资产只能由桌面安装入口更新");
    const definitions = [
      ...(Array.isArray(bundle.roles) ? bundle.roles.map(entry => entry.role) : []),
      ...(Array.isArray(bundle.workflows) ? bundle.workflows.map(entry => entry.workflow) : []),
      ...(Array.isArray(bundle.knowledgeBundles) ? bundle.knowledgeBundles.map(entry => entry.knowledgeBundle) : []),
      ...(Array.isArray(bundle.toolsets) ? bundle.toolsets.map(entry => entry.toolset) : []),
      ...(Array.isArray(bundle.skills) ? bundle.skills.map(entry => entry.skill) : []),
    ];
    if (definitions.some(definition => definition && (definition.kind != null && definition.kind !== "custom"
      || "builtinGroup" in definition && definition.builtinGroup != null))) throw new DesktopRequestError(403, "个人资产包不接受内置类型或分组");
    assertCompleteOrchAssetBundle(bundle);
    // copy 使用新 UUID，不会写入稳定目标；其余模式仍检查实际映射目标。
    if (body.importMode === "copy") return result;
    const targets = buildActiveServerDefaultAssetIds({ db: ctx.db, workspaceId, bundles: [bundle] });
    for (const [collection, ids] of Object.entries(targets)) {
      if (!(collection in ASSET_FIELDS)) continue;
      for (const id of ids as Set<string>) {
        const existing = getLocalAsset(ctx, collection as LocalAssetCollection, id);
        if (existing?.kind === "builtin") throw new DesktopRequestError(403, "导入不能覆盖内置资产");
      }
    }
  }
  if (["orch.assetDrafts.generate", "orch.assetDraftJobs.resume", "orch.assetDrafts.apply"].includes(method)) {
    const draft = method === "orch.assetDrafts.apply" ? ctx.db.orchAssetDrafts.get(assetIdentity(body.draftId, "draftId")) : null;
    const jobId = method === "orch.assetDraftJobs.resume" ? assetIdentity(body.jobId, "jobId") : draft?.sourceJobId;
    const job = jobId ? ctx.db.orchAssetGenerationJobs.get(jobId) : null;
    const targetId = method === "orch.assetDrafts.generate" ? body.targetAssetId
      : method === "orch.assetDrafts.apply" ? draft?.targetAssetId : job?.workspaceId === workspaceId ? job.targetAssetId : null;
    if (targetId) {
      const assetType = (draft?.assetKind ?? job?.assetKind ?? body.assetKind) === "skill" ? "skill" : "role";
      const id = assetIdentity(targetId, "targetAssetId");
      const asset = getLocalAsset(ctx, assetType === "skill" ? "skills" : "roles", id);
      if (!asset || asset.workspaceId !== workspaceId) throw new DesktopRequestError(404, "本机资产不存在");
      if (asset.kind === "builtin") throw new DesktopRequestError(403, "内置资产只读，请先复制为个人资产");
    }
  }
  if (body.runPlan != null) {
    if (typeof body.runPlan !== "object" || Array.isArray(body.runPlan)) throw new DesktopRequestError(400, "runPlan 必须是对象");
    const runPlan = body.runPlan as Record<string, unknown>;
    if (Object.keys(runPlan).some(key => key !== "runMode" && key !== "skippedNodeIds") || runPlan.runMode != null && runPlan.runMode !== "independent") throw new DesktopRequestError(400, "本机运行只接受独立运行计划");
  }
  // 这里只检查 renderer 字段形状；原 handler 在可信 scope 内读取、校验并翻译领域失败。
  for (const field of ["instanceId", "proposalId", "intakeId", "threadId", "sessionId", "artifactId", "promptSnapshotId"]) {
    if (body[field] != null) assetIdentity(body[field], field);
  }
  if (body.intake != null) {
    if (typeof body.intake !== "object" || Array.isArray(body.intake)) throw new DesktopRequestError(400, "intake 必须是对象");
    const intake = body.intake as Record<string, unknown>;
    result.intake = Object.fromEntries(["id", "triggerMode", "taskType", "title", "goal", "background", "acceptanceCriteria", "workbenchItemRefs", "seedArtifactRefs", "metricEvidenceRefs", "constraints", "executionPlan", "requester"].filter(key => Object.prototype.hasOwnProperty.call(intake, key)).map(key => [key, intake[key]]));
  }
  if (method === "orch.instances.start") return { ...result, initiatorUserId: actorUserId, executionProfileScope: { scopeType: "local_workspace", scopeId: workspaceId } };
  if (method === "orch.nodes.start" || method === "orch.nodes.skip" || method === "orch.instances.feedback") return { ...result, actorUserId };
  if (method === "orch.workflowExecutionDefaults.upsert") return { ...result, updatedByUserId: actorUserId };
  return result;
}

/** 登录后本机会话与知识会话统一使用账号 userId；未登录使用本机 actor。 */
function resolveLocalActorUserId(ctx: ApiHandlerContext): string {
  return ctx.desktopCloudAccount?.getOwner()?.ownerUserId?.trim() || `local:${ctx.clientId}`;
}

/** 普通聊天选择的角色只能来自当前本机工作区，完整依赖仍由运行时严格读取。 */
function validateLocalRole(ctx: ApiHandlerContext, workspaceId: WorkspaceId, value: unknown): void {
  if (value == null || value === "") return;
  const id = assetIdentity(value, "roleId");
  const role = ctx.orchAssetRuntimeRead
    ? ctx.orchAssetRuntimeRead.withWorkspace(workspaceId, session => session.getAsset("role", id)?.definition ?? null, { assetType: "role", assetId: id })
    : ctx.db.orchRoles.get(id as any);
  if (!role || role.workspaceId !== workspaceId) throw new DesktopRequestError(400, "角色不存在或不属于当前工作区");
}

/** 分页只接受安全整数，范围和默认值仍交给原有仓储处理。 */
function validateHistoryInteger(value: unknown, field: string): void {
  if (value != null && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new DesktopRequestError(400, `${field} 必须是安全整数`);
}

/** 非空字符串不做隐式类型转换，避免损坏标识或路径被误当有效输入。 */
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DesktopRequestError(400, `${field} 必须是非空字符串`);
  return value.trim();
}

/** 已命名空间化 ID 必须精确属于本机，不通过历史别名匹配其他机器。 */
function isLocalWorkspaceId(ctx: Pick<ApiHandlerContext, "clientId">, workspaceId: string): boolean {
  const prefix = `${ctx.clientId}:`;
  return workspaceId.startsWith(prefix) && workspaceId.length > prefix.length && !workspaceId.slice(prefix.length).includes(":");
}

/** 新建仅为裸 ID 补本机前缀；共享与跨机器前缀均直接拒绝。 */
function localWorkspaceId(ctx: Pick<ApiHandlerContext, "clientId">, rawId: string): WorkspaceId {
  if (rawId.includes(":") && !isLocalWorkspaceId(ctx, rawId)) throw new DesktopRequestError(400, "仅支持本机本地工作区");
  const workspaceId = prefixLocalWorkspaceId(ctx.clientId, rawId);
  if (!isLocalWorkspaceId(ctx, workspaceId)) throw new DesktopRequestError(400, "工作区 ID 无效");
  return workspaceId as WorkspaceId;
}

/** 确认持久化与运行态归属；根缺失仍可移除，Profile 存储另验真实目录。 */
function requireHostedWorkspace(ctx: ApiHandlerContext, workspaceId: WorkspaceId): void {
  const persisted = ctx.db.workspaces.get(workspaceId);
  const root = ctx.workspaces.get(workspaceId);
  if (!persisted || !root || path.resolve(root) !== path.resolve(persisted.path)) {
    throw new DesktopRequestError(404, "工作区不存在或未由本机承载");
  }
}
