import fs from "node:fs";
import path from "node:path";

import {
  getThreadEntryVisibility,
  getSharedWorkspaceOperationPolicy,
  isSharedWorkspaceHostRpcMethod,
  matchesThreadListScope,
  normalizeThreadListSort,
  normalizeThreadListScope,
  resolveSharedWorkspaceEffectiveOperationPolicy,
  resolveSharedWorkspaceHostRpcBody,
  workspaceIdsContainMatch,
  type SharedWorkspaceCommandEnvelope,
  type SharedWorkspaceContextListItem,
  type SharedThreadAclSyncItem,
  type SharedWorkspaceErrorCode,
  type SharedWorkspaceId,
  type SharedWorkspaceOperationKey,
  type ThreadId,
  type ThreadListScope,
  type ThreadListSort,
  type WorkspaceId,
} from "@codeflowai/shared";

import { handleApiRequest, scopeApiHandlerContext, isWorkspacePersistenceRecoveryApiRequest, WorkspaceApiRequestFailure, type ApiHandlerContext, type ApiRequestMessage } from "../handleApiRequest.js";
import { resolveThreadRunningState, resolveThreadRunningStateMap, resolveThreadWorkflowStateMap } from "../threadRunningState.js";
import type { ClientToServerMessage } from "../../protocol/messages.js";
import type { WorkspacePathIndexChange } from "../../fs/workspacePathIndexService.js";
import { readTerminalActions } from "../../terminal/terminalActionsConfig.js";
import { SharedThreadAclWorkspaceMismatchError } from "../../db/repos/threadRepo.js";
import { logger } from "../../logger.js";
import { knowledgeTaskOwnerThreadIds } from "../../knowledge/knowledgeConversationService.js";
import { WorkspaceOperationGateError } from "../../workspace-migration/workspaceOperationGate.js";
import { WorkspacePathIndexPathError } from "../../fs/workspacePathIndexConfig.js";
import { resolveWorkspaceReadPath } from "../../fs/fsHelpers.js";

type ApiResponseMessage = Extract<ClientToServerMessage, { t: "api.res" }>;

/** 共享Host仅在同步授权、仓储和投影期间取得许可，API及历史异步等待在许可外。 */
function withSharedDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

const GIT_WRITE_METHODS = new Set([
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.commit",
  "git.branch.create",
  "git.branch.switch",
  "git.branch.delete",
]);

const GIT_READ_METHODS = new Set([
  "git.status",
  "git.diff",
  "git.diffFiles",
  "git.log",
  "git.show",
  "git.showFileDiff",
  "git.branch.list",
]);

const PERSONAL_AI_READ_TOOL_ALLOWLIST = new Set<SharedWorkspaceOperationKey>([
  "workspace.fs.tree",
  "workspace.fs.read",
  "workspace.git.status",
  "terminal.session.read",
  "orch.asset.read",
  "skills.read",
  "toolset.read",
  "context.detail.read",
  "context.list",
]);

const PERSONAL_AI_WRITE_TOOL_DENYLIST = new Set<SharedWorkspaceOperationKey>([
  "workspace.fs.write",
  "workspace.git.write",
  "terminal.action",
  "orch.workflow.use",
  "orch.asset.write",
  "skills.manage",
  "toolset.manage",
  "team.publish",
  "ai.thread.send.shared",
  "asset.clone_to_private",
]);

const DEFAULT_CONTEXT_DETAIL_EVENT_LIMIT = 500;
const MAX_CONTEXT_DETAIL_EVENT_LIMIT = 500;

const SHARED_ORCH_INSTANCE_READ_METHODS = new Set<string>([
  "orch.instances.get",
  "orch.instances.runtimePatch",
  "orch.artifacts.list",
  "orch.events.list",
  "orch.runtimeEvidence.get",
  "orch.promptSnapshots.list",
]);

const SHARED_ORCH_ARTIFACT_READ_METHODS = new Set<string>([
  "orch.artifacts.get",
  "orch.artifactFiles.list",
]);

/** 共享封套只把停止与纯线程元数据映射到原API；正文、草稿和过程保留屏障。 */
function sharedPersistenceRecoveryMethod(envelope: SharedWorkspaceCommandEnvelope): string {
  if (envelope.operationKey === "context.thread.interrupt") return "turns.interrupt";
  const payload = asRecord(envelope.payload);
  return envelope.operationKey === "context.detail.read" && payload.resourceType === "thread"
    && payload.includeEvents === false && !payload.includeDraft && !payload.detailMode && payload.presentation !== "lazy"
    ? "threads.summary" : "";
}

/** 验证 Server 封套及写权后复用 Host 入口；文件操作不按目录区分成员与所有者。 */
export async function handleSharedWorkspaceCommand(
  ctx: ApiHandlerContext,
  envelope: SharedWorkspaceCommandEnvelope,
): Promise<void> {
  ctx.send({
    t: "sharedWorkspace.route.ack",
    message: {
      routeEventId: String(envelope.routeEventId ?? ""),
      operationId: envelope.operationId,
      ackAt: Date.now(),
      progressSummary: { acceptedByHost: true },
    },
  } as any);

  const routeEventId = String(envelope.routeEventId ?? envelope.operationId ?? "").trim();
  let failureLogged = false;
  try {
    validateEnvelope(ctx, envelope);
    const localWorkspaceId = String(envelope.localWorkspaceId) as WorkspaceId;
    ctx = await withSharedDatabase(ctx, envelope.operationId, () => scopeApiHandlerContext(ctx, localWorkspaceId, {
      deferPersistenceCheck: isWorkspacePersistenceRecoveryApiRequest(sharedPersistenceRecoveryMethod(envelope)),
    }));
    const releaseWrite = ctx.workspaceOperationGate?.beginWrite(localWorkspaceId) ?? (() => {});
    let result: unknown;
    try {
      result = await executeSharedWorkspaceOperation({ ...ctx,
        onApiFailureLogged: () => { failureLogged = true; ctx.onApiFailureLogged?.(); },
        sharedFileRequestContext: { requestId: envelope.operationId, routeEventId, sharedWorkspaceId: envelope.sharedWorkspaceId,
          actorUserId: envelope.actorUserId, hostBindingId: envelope.hostBindingId },
        intakeWorkspaceScope: {
        scopeType: "shared_workspace", scopeId: envelope.sharedWorkspaceId,
      } }, envelope);
    } finally {
      releaseWrite();
    }
    ctx.send({
      t: "sharedWorkspace.route.result",
      message: {
        routeEventId,
        operationId: envelope.operationId,
        ...buildSharedWorkspaceRouteResultMeta(envelope),
        status: "succeeded",
        completedAt: Date.now(),
        result,
      },
    } satisfies ClientToServerMessage);
  } catch (error) {
    if (!failureLogged && ["workspace.fs.tree", "workspace.fs.read", "workspace.fs.write", "workspace.git.status"].includes(envelope.operationKey)) {
      const mapped = toSharedWorkspaceHostError(error);
      logger[mapped.status >= 500 ? "error" : "warn"]("fs", "shared workspace file access failed", {
        code: error instanceof WorkspacePathIndexPathError ? error.diagnosticCode : mapped.code,
        requestId: envelope.operationId, routeEventId, clientId: ctx.clientId,
        workspaceId: envelope.localWorkspaceId, sharedWorkspaceId: envelope.sharedWorkspaceId,
        actorUserId: envelope.actorUserId, hostBindingId: envelope.hostBindingId,
        rootCause: error instanceof WorkspacePathIndexPathError ? error.systemCode : mapped.code,
      });
      ctx.onApiFailureLogged?.();
    }
    ctx.send({
      t: "sharedWorkspace.route.result",
      message: {
        routeEventId,
        operationId: envelope.operationId,
        ...buildSharedWorkspaceRouteResultMeta(envelope),
        status: "failed",
        completedAt: Date.now(),
        error: toSharedWorkspaceHostError(error),
      },
    } satisfies ClientToServerMessage);
  }
}

/** 只回传共享路由归因元数据，帮助 Server 统计流量来源且不暴露 payload。 */
function buildSharedWorkspaceRouteResultMeta(
  envelope: SharedWorkspaceCommandEnvelope,
): { operationKey: SharedWorkspaceOperationKey; method: string | null } {
  const payload = asRecord(envelope.payload);
  return {
    operationKey: envelope.operationKey,
    method: optionalString(payload.method),
  };
}

/** Validates the server-derived route envelope before any Host-side side effect runs. */
function validateEnvelope(ctx: ApiHandlerContext, envelope: SharedWorkspaceCommandEnvelope): void {
  const localWorkspaceId = String(envelope.localWorkspaceId ?? "").trim() as any;
  if (!localWorkspaceId || !workspaceIdsContainMatch(ctx.workspaces.keys(), localWorkspaceId)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_UNAVAILABLE", "host client 未承载该本地 workspace", 409);
  }
  const expected = resolveSharedWorkspaceEffectiveOperationPolicy(envelope.operationKey, envelope.payload);
  if (
    !expected
    || expected.handlerId !== envelope.policy.handlerId
    || expected.operationType !== envelope.policy.operationType
    || expected.lockRequired !== envelope.policy.lockRequired
    || expected.effectiveLockRequired !== envelope.policy.effectiveLockRequired
    || expected.usageRequired !== envelope.policy.usageRequired
    || expected.auditAction !== envelope.policy.auditAction
    || expected.toolPolicyKey !== envelope.policy.toolPolicyKey
    || expected.assetEffect !== envelope.policy.assetEffect
    || expected.maintenanceDefinitionRequired !== envelope.policy.maintenanceDefinitionRequired
    || expected.cloneToPrivateDisabled !== envelope.policy.cloneToPrivateDisabled
  ) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "共享工作区操作策略与 host 预期不一致", 400);
  }
  validateSharedAiChildToolAuthorization(envelope);
  if (envelope.policy.cloneToPrivateDisabled || envelope.policy.assetEffect === "private_clone") {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PRIVATE_CLONE_DISABLED", "共享资产不支持克隆到个人私域自改", 403);
  }
  if (envelope.policy.maintenanceDefinitionRequired || envelope.policy.assetEffect === "maintain_definition") {
    assertServerAuthorizedAssetMaintenance(envelope);
  }
  if (envelope.policy.effectiveLockRequired && (!envelope.lockToken || envelope.lockVersion == null)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_LOCK_REQUIRED", "共享写操作缺少有效写权上下文", 409);
  }
}

function validateSharedAiChildToolAuthorization(envelope: SharedWorkspaceCommandEnvelope): void {
  if (envelope.operationKey !== "ai.thread.send.shared") return;
  const payload = asRecord(envelope.payload);
  for (const rawToolKey of collectPersonalAiToolKeys(payload)) {
    const childPolicy = getSharedWorkspaceOperationPolicy(rawToolKey);
    if (!childPolicy) {
      throw new SharedWorkspaceHostError(
        "SHARED_WORKSPACE_OPERATION_UNKNOWN",
        "共享 AI 子工具不在共享工作区操作列表内",
        400,
        { toolOperationKey: rawToolKey },
      );
    }
    if (childPolicy.cloneToPrivateDisabled || childPolicy.assetEffect === "private_clone") {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PRIVATE_CLONE_DISABLED", "共享资产不支持克隆到个人私域自改", 403);
    }
    if (childPolicy.maintenanceDefinitionRequired || childPolicy.assetEffect === "maintain_definition") {
      assertServerAuthorizedAssetMaintenance(envelope);
    }
  }
}

/** Host 只校验 Server 派生授权结果；成员策略打开时 actorAssetRole 仍保持 member。 */
function assertServerAuthorizedAssetMaintenance(envelope: SharedWorkspaceCommandEnvelope): void {
  if (envelope.authorization?.authorizationResult !== "allowed") {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_ASSET_MAINTENANCE_FORBIDDEN", "当前角色仅可使用共享资产，不能维护资产定义", 403);
  }
}

async function executeSharedWorkspaceOperation(
  ctx: ApiHandlerContext,
  envelope: SharedWorkspaceCommandEnvelope,
): Promise<unknown> {
  const payload = asRecord(envelope.payload);
  const workspaceId = envelope.localWorkspaceId;
  // 已确认删除的重试不再同步活会话 ACL；原任务范围必须匹配可信封套。
  if (envelope.operationKey === "context.thread.delete") {
    const threadId = String(payload.threadId ?? "").trim() as ThreadId;
    const deletion = await withSharedDatabase(ctx, envelope.operationId, () => ctx.db.threads.getDeletion(threadId));
    if (deletion) {
      if (deletion.workspaceId !== workspaceId || deletion.sharedWorkspaceId !== envelope.sharedWorkspaceId) {
        throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "删除任务不属于当前共享工作区", 403);
      }
      return await invokeApi(ctx, "threads.delete", { workspaceId, threadId });
    }
  }
  const absent = await withSharedDatabase(ctx, envelope.operationId, () => {
    if (isMissingSharedThreadDelete(ctx, envelope, payload)) return true;
    syncSharedThreadAclFromTrustedPayload(ctx, workspaceId, envelope, payload);
    if (envelope.operationKey === "ai.thread.send.personal") assertPersonalAiPayloadReadonly(payload);
    assertSharedThreadOperationAccess(ctx, workspaceId, envelope, payload);
    return false;
  });
  if (absent) {
    return { ok: true, alreadyAbsent: true };
  }
  switch (envelope.operationKey) {
    case "workspace.fs.tree":
      return await invokeApi(ctx, "fs.tree", { ...payload, workspaceId });
    case "workspace.fs.read":
      return await executeFsRead(ctx, workspaceId, payload);
    case "workspace.fs.write":
      return await withSharedDatabase(ctx, envelope.operationId, () => executeFsWrite(ctx, workspaceId, payload));
    case "workspace.git.status":
      return await executeGitRead(ctx, workspaceId, payload);
    case "workspace.git.write":
      return await executeGitWrite(ctx, workspaceId, payload);
    case "terminal.session.read":
      return await withSharedDatabase(ctx, envelope.operationId, () => readTerminalSession(ctx, workspaceId));
    case "terminal.action":
      return await withSharedDatabase(ctx, envelope.operationId, () => executeTerminalAction(ctx, workspaceId, payload));
    case "context.thread.create":
      return await invokeApi(ctx, "threads.create", {
        ...payload,
        workspaceId,
        sharedThreadAcl: buildSharedThreadAclFromEnvelope(envelope),
      });
    case "context.thread.acl.sync":
      return await withSharedDatabase(ctx, envelope.operationId, () => syncSharedThreadAcl(ctx, envelope));
    case "context.thread_groups.list":
      return await invokeApi(ctx, "threads.groups.list", {
        ...payload,
        workspaceId,
        ...buildSharedThreadGroupContext(envelope),
      });
    case "context.thread_groups.create":
      return await invokeApi(ctx, "threads.groups.create", {
        ...payload,
        workspaceId,
        ...buildSharedThreadGroupContext(envelope),
      });
    case "context.thread_groups.rename":
      return await invokeApi(ctx, "threads.groups.rename", {
        ...payload,
        workspaceId,
        ...buildSharedThreadGroupContext(envelope),
      });
    case "context.thread_groups.delete":
      return await invokeApi(ctx, "threads.groups.delete", {
        ...payload,
        workspaceId,
        ...buildSharedThreadGroupContext(envelope),
      });
    case "context.thread.group.assign":
      return await invokeApi(ctx, "threads.group.assign", {
        ...payload,
        workspaceId,
        ...buildSharedThreadGroupContext(envelope),
      });
    case "context.thread.rename":
      return await invokeApi(ctx, "threads.rename", { ...payload, workspaceId });
    case "context.thread.archive":
      return await invokeApi(ctx, "threads.archive", { ...payload, workspaceId });
    case "context.thread.pin":
      return await invokeApi(ctx, "threads.pin", { ...payload, workspaceId });
    case "context.thread.update_prefs":
      return await invokeApi(ctx, "threads.updatePrefs", { ...payload, workspaceId });
    case "context.thread.prefs":
      return await invokeApi(ctx, "threads.prefs", { ...payload, workspaceId });
    case "context.thread.latest_prefs":
      return await invokeApi(ctx, "threads.latestPrefs", { ...payload, workspaceId });
    case "context.thread.input_actions.list":
      return await invokeApi(ctx, "threads.inputActions.list", { ...payload, workspaceId });
    case "context.thread.draft.get":
      return await invokeApi(ctx, "threads.draft.get", { ...payload, workspaceId });
    case "context.thread.draft.save":
      return await invokeApi(ctx, "threads.draft.save", { ...payload, workspaceId });
    case "context.thread.draft.clear":
      return await invokeApi(ctx, "threads.draft.clear", { ...payload, workspaceId });
    case "context.thread.rollback.preview":
      return await invokeApi(ctx, "threads.rollback.preview", { ...payload, workspaceId });
    case "context.thread.rollback":
      return await invokeApi(ctx, "threads.rollback", { ...payload, workspaceId });
    case "context.thread.delete":
      return await invokeApi(ctx, "threads.delete", { ...payload, workspaceId });
    case "context.thread.message.delete":
      return await invokeApi(ctx, "threads.messages.delete", { ...payload, workspaceId });
    case "context.thread.clear":
      return await invokeApi(ctx, "threads.clear", { ...payload, workspaceId });
    case "context.thread.interrupt":
      return await invokeApi(ctx, "turns.interrupt", { ...payload, workspaceId });
    case "context.thread.compact":
      return await invokeApi(ctx, "threads.compact", { ...payload, workspaceId });
    case "context.thread.approval.respond":
      return await invokeApi(ctx, "approvals.respond", { ...payload, workspaceId, knowledgeConversationActorContext: buildKnowledgeConversationActorContext(envelope), ...buildSharedQueueAppendContext(envelope) });
    case "context.thread.user_input.respond":
      return await invokeApi(ctx, "userInput.respond", { ...payload, workspaceId, ...buildSharedQueueAppendContext(envelope) });
    case "context.thread.file_changes.list":
      return await invokeApi(ctx, "threads.fileChanges.list", { ...payload, workspaceId });
    case "context.thread.file_changes.diff":
      return await invokeApi(ctx, "threads.fileChanges.diff", { ...payload, workspaceId });
    case "context.thread.file_changes.accept":
      return await invokeApi(ctx, "threads.fileChanges.accept", { ...payload, workspaceId });
    case "context.thread.file_changes.undo":
      return await invokeApi(ctx, "threads.fileChanges.undo", { ...payload, workspaceId });
    case "context.thread.managed_services.list":
      return await invokeApi(ctx, "threads.managedServices.list", { ...payload, workspaceId });
    case "context.thread.managed_services.stop":
      return await invokeApi(ctx, "threads.managedServices.stop", { ...payload, workspaceId });
    case "context.thread.queue.append":
      return await invokeApi(ctx, "threads.queue.append", {
        ...payload,
        workspaceId,
        ...buildSharedQueueAppendContext(envelope),
      });
    case "context.thread.queue.list":
      return await invokeApi(ctx, "threads.queue.list", { ...payload, workspaceId });
    case "context.thread.queue.move":
      return await invokeApi(ctx, "threads.queue.move", { ...payload, workspaceId });
    case "context.thread.queue.remove":
      return await invokeApi(ctx, "threads.queue.remove", { ...payload, workspaceId });
    case "context.thread.queue.clear":
      return await invokeApi(ctx, "threads.queue.clear", { ...payload, workspaceId });
    case "context.thread.queue.resume":
      return await invokeApi(ctx, "threads.queue.resume", { ...payload, workspaceId });
    case "context.thread.queue.pause":
      return await invokeApi(ctx, "threads.queue.pause", { ...payload, workspaceId });
    case "ai.thread.send.personal":
      return await invokeApi(ctx, "threads.sendMessage", {
        ...payload,
        workspaceId,
        knowledgeConversationActorContext: buildKnowledgeConversationActorContext(envelope),
        accessMode: "read-only",
        sharedWorkspaceId: envelope.sharedWorkspaceId,
        sharedWorkspaceOperationId: envelope.operationId,
        sharedWorkspaceRouteEventId: envelope.routeEventId ?? null,
        sharedWorkspaceOperationKey: envelope.operationKey,
        sharedWorkspaceToolPolicyKey: envelope.policy.toolPolicyKey,
        sharedWorkspaceLockToken: envelope.lockToken ?? null,
        sharedWorkspaceLockVersion: envelope.lockVersion ?? null,
        sharedWorkspaceAllowSharedUpgrade: Boolean(envelope.allowSharedUpgrade),
      });
    case "ai.thread.send.shared":
      return await invokeApi(ctx, "threads.sendMessage", {
        ...payload,
        workspaceId,
        knowledgeConversationActorContext: buildKnowledgeConversationActorContext(envelope),
        sharedWorkspaceId: envelope.sharedWorkspaceId,
        sharedWorkspaceOperationId: envelope.operationId,
        sharedWorkspaceRouteEventId: envelope.routeEventId ?? null,
        sharedWorkspaceOperationKey: envelope.operationKey,
        sharedWorkspaceToolPolicyKey: envelope.policy.toolPolicyKey,
        sharedWorkspaceLockToken: envelope.lockToken ?? null,
        sharedWorkspaceLockVersion: envelope.lockVersion ?? null,
        sharedWorkspaceAllowSharedUpgrade: Boolean(envelope.allowSharedUpgrade),
      });
    case "context.detail.read":
      return readContextDetail(ctx, workspaceId, payload, envelope);
    case "context.list":
      await ctx.flushLocalEvents?.(workspaceId as WorkspaceId);
      return await withSharedDatabase(ctx, envelope.operationId, () => readContextList(ctx, workspaceId, payload, envelope));
    case "orch.asset.read":
    case "orch.asset.write":
    case "orch.workflow.use":
      return await executeSharedHostRpc(ctx, workspaceId, payload, envelope);
    case "skills.read":
    case "skills.manage":
      return await executeSharedHostRpc(ctx, workspaceId, payload, envelope);
    case "toolset.read":
    case "toolset.manage":
      return await executeSharedHostRpc(ctx, workspaceId, payload, envelope);
    case "team.publish":
      return executeTeamPublish(ctx, workspaceId, payload);
    case "asset.clone_to_private":
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PRIVATE_CLONE_DISABLED", "共享资产不支持克隆到个人私域自改", 403);
    default:
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", `host 暂不支持共享工作区操作：${envelope.operationKey}`, 400);
  }
}

/** 仅把 Host 数据库已确认不存在的共享会话删除视为幂等成功。 */
function isMissingSharedThreadDelete(
  ctx: ApiHandlerContext,
  envelope: SharedWorkspaceCommandEnvelope,
  payload: Record<string, unknown>,
): boolean {
  if (envelope.operationKey !== "context.thread.delete") return false;
  const threadId = String(payload.threadId ?? "").trim() as ThreadId;
  return Boolean(threadId) && !ctx.db.threads.get(threadId);
}

/** 队列 append 持久化共享工具策略上下文，后续自动消费时继续走共享权限边界。 */
function buildKnowledgeConversationActorContext(envelope: SharedWorkspaceCommandEnvelope) {
  return {
    userId: envelope.actorUserId,
    permissionScope: envelope.authorization?.canMaintainAssets === true ? "shared_asset_admin" : "shared_member",
  };
}

function buildSharedQueueAppendContext(envelope: SharedWorkspaceCommandEnvelope): Record<string, unknown> {
  return {
    sharedWorkspaceId: envelope.sharedWorkspaceId,
    sharedWorkspaceOperationId: envelope.operationId,
    sharedWorkspaceRouteEventId: envelope.routeEventId ?? null,
    sharedWorkspaceOperationKey: envelope.operationKey,
    sharedWorkspaceToolPolicyKey: envelope.policy.toolPolicyKey,
    sharedWorkspaceLockToken: envelope.lockToken ?? null,
    sharedWorkspaceLockVersion: envelope.lockVersion ?? null,
    sharedWorkspaceAllowSharedUpgrade: Boolean(envelope.allowSharedUpgrade),
  };
}

function readTerminalSession(ctx: ApiHandlerContext, workspaceId: string): Record<string, unknown> {
  const terminalManager = ctx.terminalManager;
  if (!terminalManager) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_UNAVAILABLE", "host terminal manager 未启用", 409);
  }
  const workspacePath = ctx.workspaces.get(workspaceId as any);
  if (!workspacePath) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_UNAVAILABLE", "未知 host workspace", 409);
  }
  let terminals = terminalManager.list(workspaceId);
  if (!terminals.length) {
    const restored = terminalManager.restoreAll(workspaceId);
    if (restored.length) terminals = terminalManager.list(workspaceId);
  }
  return {
    ok: true,
    terminals,
    actions: readTerminalActions(workspacePath),
  };
}

function executeTerminalAction(ctx: ApiHandlerContext, workspaceId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const terminalManager = ctx.terminalManager;
  if (!terminalManager) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_UNAVAILABLE", "host terminal manager 未启用", 409);
  }
  const workspacePath = ctx.workspaces.get(workspaceId as any);
  if (!workspacePath) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_UNAVAILABLE", "未知 host workspace", 409);
  }
  const action = String(payload.action ?? payload.kind ?? "").trim();
  if (action === "create") {
    const terminal = terminalManager.create({
      workspaceId,
      label: optionalString(payload.label) ?? undefined,
      shell: optionalString(payload.shell) ?? undefined,
      cwd: optionalString(payload.cwd) ?? undefined,
    });
    return { ok: true, action, terminal };
  }
  if (action === "input" || action === "write") {
    const terminalId = requiredString(payload.terminalId, "terminalId");
    terminalManager.write(terminalId, String(payload.data ?? ""));
    return { ok: true, action: "input", terminalId };
  }
  if (action === "resize") {
    const terminalId = requiredString(payload.terminalId, "terminalId");
    terminalManager.resize(terminalId, positiveInt(payload.cols, 120), positiveInt(payload.rows, 30));
    return { ok: true, action, terminalId };
  }
  if (action === "rename") {
    const terminalId = requiredString(payload.terminalId, "terminalId");
    const renamed = terminalManager.rename(terminalId, requiredString(payload.label, "label"));
    if (!renamed) throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_UNAVAILABLE", "终端不存在", 409);
    return { ok: true, action, terminalId };
  }
  if (action === "close") {
    const terminalId = requiredString(payload.terminalId, "terminalId");
    const closed = terminalManager.close(terminalId);
    if (!closed) throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_UNAVAILABLE", "终端不存在", 409);
    return { ok: true, action, terminalId };
  }
  if (action === "runAction") {
    const actionId = requiredString(payload.actionId, "actionId");
    const savedAction = readTerminalActions(workspacePath).find((item) => item.id === actionId);
    if (!savedAction) throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", `未知 terminal action：${actionId}`, 400);
    const terminal = terminalManager.create({
      workspaceId,
      label: savedAction.label,
      shell: savedAction.shell || undefined,
      cwd: savedAction.cwd || undefined,
    });
    if (savedAction.command) {
      setTimeout(() => terminalManager.write(terminal.id, `${savedAction.command}\r`), 500);
    }
    return { ok: true, action, actionId, terminal };
  }
  const command = optionalString(payload.command);
  if (action === "runCommand" || command) {
    const terminal = terminalManager.create({
      workspaceId,
      label: optionalString(payload.label) ?? "Shared terminal",
      shell: optionalString(payload.shell) ?? undefined,
      cwd: optionalString(payload.cwd) ?? undefined,
    });
    if (command) {
      setTimeout(() => terminalManager.write(terminal.id, `${command}\r`), 500);
    }
    return { ok: true, action: "runCommand", terminal };
  }
  throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "不支持的 terminal.action", 400);
}

/** Executes a shared Host RPC by method, leaving shared auth decisions to the server envelope. */
async function executeSharedHostRpc(
  ctx: ApiHandlerContext,
  workspaceId: string,
  payload: Record<string, unknown>,
  envelope: SharedWorkspaceCommandEnvelope,
): Promise<unknown> {
  const method = String(payload.method ?? "").trim();
  if (!method) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "共享工作区 Host RPC method 不能为空", 400);
  }
  if (!isSharedWorkspaceHostRpcMethod(method)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", `不支持的共享 Host RPC 方法：${method}`, 400);
  }
  const body = resolveSharedWorkspaceHostRpcBody(payload);
  if (method.startsWith("orch.chat.")) {
    try {
      const threadId = requiredString(body.threadId, "threadId");
      const thread = await withSharedDatabase(ctx, envelope.operationId, () => ctx.db.threads.get(threadId as ThreadId));
      if (!thread || String(thread.workspaceId) !== workspaceId) {
        throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "线程不存在或不属于绑定 workspace", 403);
      }
      resolveSharedThreadAccess(thread, envelope, method === "orch.chat.get" ? "read" : "write");
      body.actorUserId = envelope.actorUserId;
      if (method === "orch.chat.action" && body.action === "dismiss") Object.assign(body, buildSharedQueueAppendContext(envelope));
    } catch (error) {
      logger.error("chat-workflow", "shared chat workflow access rejected", {
        code: error instanceof SharedWorkspaceHostError ? error.code : "CHAT_WORKFLOW_ACCESS_FAILED",
        requestId: envelope.operationId, sharedWorkspaceId: envelope.sharedWorkspaceId,
        workspaceId, threadId: body.threadId, actorUserId: envelope.actorUserId, method,
        cause: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  const resourceAccess = await withSharedDatabase(ctx, envelope.operationId, () => resolveSharedOrchestrationResourceAccess(ctx, workspaceId, envelope, method, body));
  const normalizedBody = normalizeSharedOrchestrationRpcBody(method, body);
  const allowedResourceIds = parseAllowedResourceIds(body.allowedResourceIds ?? payload.allowedResourceIds);
  const restrictRequirementResources = isRequirementResourceRestrictionEnabled(method, normalizedBody);
  if (allowedResourceIds && allowedResourceIds.size === 0 && restrictRequirementResources) {
    return emptyRestrictedRequirementList(method);
  }
  const requestPayload = buildSharedHostRpcRequestPayload(
    method,
    normalizedBody,
    workspaceId,
    restrictRequirementResources ? allowedResourceIds : null,
    envelope,
  );
  const result = await invokeApi(ctx, method, requestPayload);
  const filtered = filterRestrictedRequirementListResult(method, result, restrictRequirementResources ? allowedResourceIds : null);
  return decorateSharedOrchestrationRpcResult(method, filtered, resourceAccess);
}

type SharedOrchestrationResourceAccess = {
  context: Record<string, unknown> | null;
  readOnly: boolean;
  sourceKind: "requirement" | "scheduled_task";
};

/** 共享编排读接口在 Host 本地做最终资源边界校验，Server 不再预拉完整实例做 ACL。 */
function resolveSharedOrchestrationResourceAccess(
  ctx: ApiHandlerContext,
  workspaceId: string,
  envelope: SharedWorkspaceCommandEnvelope,
  method: string,
  body: Record<string, unknown>,
): SharedOrchestrationResourceAccess | null {
  if (SHARED_ORCH_INSTANCE_READ_METHODS.has(method)) {
    const instanceId = requiredString(body.instanceId, "instanceId");
    return resolveSharedOrchestrationInstanceAccess(ctx, workspaceId, envelope, instanceId, body);
  }
  if (SHARED_ORCH_ARTIFACT_READ_METHODS.has(method)) {
    const artifactId = requiredString(body.artifactId, "artifactId");
    const artifact = ctx.db.orchArtifacts.getAccessProjection(artifactId as any);
    if (!artifact) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "编排产物不存在或不属于绑定 workspace", 403);
    }
    return resolveSharedOrchestrationInstanceAccess(ctx, workspaceId, envelope, String(artifact.instanceId), body);
  }
  if (method === "orch.promptSnapshots.get") {
    const promptSnapshotId = requiredString(body.promptSnapshotId, "promptSnapshotId");
    const snapshot = ctx.db.orchPromptSnapshots.get(promptSnapshotId);
    if (!snapshot) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "提示快照不存在或不属于绑定 workspace", 403);
    }
    return resolveSharedOrchestrationInstanceAccess(ctx, workspaceId, envelope, String(snapshot.instanceId), body);
  }
  return null;
}

/** 读取轻量实例投影并用 Server 下发的真实共享上下文校验资源可见性。 */
function resolveSharedOrchestrationInstanceAccess(
  ctx: ApiHandlerContext,
  workspaceId: string,
  envelope: SharedWorkspaceCommandEnvelope,
  instanceId: string,
  body: Record<string, unknown>,
): SharedOrchestrationResourceAccess {
  const projection = ctx.db.orchInstances.getAccessProjection(instanceId as any);
  if (!projection || String(projection.workspaceId) !== String(workspaceId)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "编排实例不存在或不属于绑定 workspace", 403);
  }
  if (projection.sourceKind === "scheduled_task") {
    return { context: null, readOnly: false, sourceKind: "scheduled_task" };
  }
  const context = resolveAllowedRequirementContextForInstance(projection.intakeId, envelope, body);
  return {
    context,
    readOnly: Boolean(context.readOnly),
    sourceKind: "requirement",
  };
}

/** 共享编排列表类接口统一在 Host 端兜底裁剪，避免旧 Server 下发大包请求。 */
function normalizeSharedOrchestrationRpcBody(method: string, body: Record<string, unknown>): Record<string, unknown> {
  if (method === "orch.events.list") {
    return { ...body, limit: positiveInt(body.limit, 200, 500), includePayload: false };
  }
  if (method === "orch.runtimeEvidence.get") {
    const nodeId = String(body.nodeId ?? "").trim();
    if (body.promptSnapshotId != null && typeof body.promptSnapshotId !== "string") {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "promptSnapshotId 必须为字符串", 400);
    }
    const promptSnapshotId = String(body.promptSnapshotId ?? "").trim();
    if (promptSnapshotId.length > 200) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "promptSnapshotId 不能超过 200 个字符", 400);
    }
    const rawAttemptNo = body.attemptNo;
    const attemptNo = rawAttemptNo == null || String(rawAttemptNo).trim() === "" ? null : Number(rawAttemptNo);
    if (attemptNo !== null && (!Number.isInteger(attemptNo) || attemptNo <= 0)) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "attemptNo 必须为正整数", 400);
    }
    if (attemptNo !== null && !nodeId) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "按执行轮次查询时必须同时提供 nodeId", 400);
    }
    const rawLimit = body.limit;
    const limit = rawLimit == null || String(rawLimit).trim() === "" ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "limit 必须为 1-100 的整数", 400);
    }
    return { ...body, nodeId: nodeId || null, attemptNo, promptSnapshotId: promptSnapshotId || null, limit };
  }
  if (method === "orch.promptSnapshots.list") {
    const limit = positiveOptionalInt(body.limit);
    return {
      ...body,
      ...(limit ? { limit: Math.min(limit, 500) } : {}),
      includeContent: false,
    };
  }
  return body;
}

/** 给实例类响应附加 Host 派生的共享只读上下文，保持 UI 权限展示稳定。 */
function decorateSharedOrchestrationRpcResult(
  method: string,
  result: unknown,
  access: SharedOrchestrationResourceAccess | null,
): unknown {
  if (!access) return result;
  const record = asRecord(result);
  if (method === "orch.instances.get") {
    const instance = asRecord(record.instance);
    return {
      ...record,
      instance: decorateSharedOrchestrationInstance(instance, access),
    };
  }
  if (method === "orch.instances.runtimePatch") {
    const patch = asRecord(record.patch);
    return {
      ...record,
      patch: access.context ? { ...patch, sharedContext: access.context, readOnly: access.readOnly } : patch,
    };
  }
  return result;
}

/** 给完整实例快照附加共享只读上下文，供 Web 禁用写操作入口。 */
function decorateSharedOrchestrationInstance(
  instance: Record<string, unknown>,
  access: SharedOrchestrationResourceAccess,
): Record<string, unknown> {
  if (!access.context) {
    return access.sourceKind === "scheduled_task" ? { ...instance, sourceKind: access.sourceKind } : instance;
  }
  return {
    ...instance,
    sourceKind: access.sourceKind,
    intakeSnapshot: {
      ...asRecord(instance.intakeSnapshot),
      sharedContext: access.context,
      readOnly: access.readOnly,
    },
    sharedContext: access.context,
    readOnly: access.readOnly,
  };
}

/** 从 Server 授权上下文中命中实例绑定需求，未命中即拒绝。 */
function resolveAllowedRequirementContextForInstance(
  requirementId: string | null,
  envelope: SharedWorkspaceCommandEnvelope,
  body: Record<string, unknown>,
): SharedWorkspaceContextListItem {
  if (!requirementId) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "流程实例缺少需求上下文", 403);
  }
  const contexts = parseAllowedRequirementContexts(body.allowedRequirementContexts, envelope);
  const context = contexts.get(requirementId);
  if (!context) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "无权查看该共享需求上下文", 403, {
      resourceType: "requirement",
      resourceId: requirementId,
    });
  }
  return context;
}

/** 解析 Server 下发的真实需求上下文，只接受当前共享工作区的 requirement 资源。 */
function parseAllowedRequirementContexts(
  value: unknown,
  envelope: SharedWorkspaceCommandEnvelope,
): Map<string, SharedWorkspaceContextListItem> {
  const contexts = new Map<string, SharedWorkspaceContextListItem>();
  if (!Array.isArray(value)) return contexts;
  for (const item of value) {
    const record = asRecord(item);
    const resourceId = optionalString(record.resourceId);
    if (!resourceId) continue;
    if (String(record.sharedWorkspaceId ?? "").trim() !== envelope.sharedWorkspaceId) continue;
    if (String(record.resourceType ?? "").trim() !== "requirement") continue;
    contexts.set(resourceId, {
      id: String(record.id ?? `server_req_${envelope.sharedWorkspaceId}_${resourceId}`) as SharedWorkspaceContextListItem["id"],
      sharedWorkspaceId: envelope.sharedWorkspaceId as SharedWorkspaceContextListItem["sharedWorkspaceId"],
      enterpriseId: String(record.enterpriseId ?? ""),
      hostWorkspaceId: String(record.hostWorkspaceId ?? "") as SharedWorkspaceContextListItem["hostWorkspaceId"],
      resourceType: "requirement",
      resourceId,
      ownerUserId: String(record.ownerUserId ?? ""),
      visibility: normalizeSharedContextVisibility(record.visibility),
      participantUserIds: normalizeUserIdList(record.participantUserIds),
      titleSummary: String(record.titleSummary ?? resourceId),
      createdAt: Number(record.createdAt ?? 0),
      updatedAt: Number(record.updatedAt ?? 0),
      publishedAt: record.publishedAt == null ? null : Number(record.publishedAt),
      relatedToMe: Boolean(record.relatedToMe),
      relatedReasons: normalizeSharedContextRelatedReasons(record.relatedReasons),
      readOnly: Boolean(record.readOnly),
    });
  }
  return contexts;
}

/** 规范化共享上下文可见性，非法值按最保守 participants 处理。 */
function normalizeSharedContextVisibility(value: unknown): SharedWorkspaceContextListItem["visibility"] {
  const text = String(value ?? "").trim();
  return text === "private" || text === "participants" || text === "team" ? text : "participants";
}

/** 规范化共享上下文关联原因，避免 Host 继续传播非法枚举。 */
function normalizeSharedContextRelatedReasons(value: unknown): SharedWorkspaceContextListItem["relatedReasons"] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SharedWorkspaceContextListItem["relatedReasons"][number] =>
    item === "owner" || item === "participant" || item === "todo" || item === "mention" || item === "trigger",
  );
}

/** 规范化用户 ID 列表，避免重复处理人影响相关性判断。 */
function normalizeUserIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function isRestrictedRequirementListMethod(method: string): boolean {
  return method === "orch.intakes.list" || method === "orch.requirementAnalysis.sessions.list";
}

/** 定时编排列表不绑定共享需求上下文，Host 侧只按 workspace 和来源筛选。 */
function isRequirementResourceRestrictionEnabled(method: string, payload: Record<string, unknown>): boolean {
  return isRestrictedRequirementListMethod(method) && String(payload.sourceKind ?? "").trim() !== "scheduled_task";
}

/** 共享需求列表把服务端可见资源集交给 Host handler，确保分页前过滤。 */
function buildSharedHostRpcRequestPayload(
  method: string,
  payload: Record<string, unknown>,
  workspaceId: string,
  allowedResourceIds: Set<string> | null,
  envelope: SharedWorkspaceCommandEnvelope,
): Record<string, unknown> {
  if (!allowedResourceIds || !isRestrictedRequirementListMethod(method)) return { ...payload, workspaceId };
  return {
    ...payload,
    workspaceId,
    allowedResourceIds: Array.from(allowedResourceIds),
  };
}

function filterRestrictedRequirementListResult(
  method: string,
  result: unknown,
  allowedResourceIds: Set<string> | null,
): unknown {
  if (!allowedResourceIds || !isRestrictedRequirementListMethod(method)) return result;
  const key = method === "orch.intakes.list" ? "intakes" : "sessions";
  const record = asRecord(result);
  const items = Array.isArray(record[key]) ? record[key] : [];
  const filteredItems = items.filter((item) => allowedResourceIds.has(String(asRecord(item).id ?? "")));
  const matchedIds = new Set(filteredItems.map((item) => String(asRecord(item).id ?? "")).filter(Boolean));
  const completed = Array.from(allowedResourceIds).every((id) => matchedIds.has(id));
  return {
    ...record,
    [key]: filteredItems,
    ...(completed ? { hasMore: false, nextCursor: null } : {}),
  };
}

function emptyRestrictedRequirementList(method: string): Record<string, unknown> {
  return method === "orch.intakes.list"
    ? { ok: true, intakes: [], hasMore: false, nextCursor: null }
    : { ok: true, sessions: [], hasMore: false, nextCursor: null };
}

function parseAllowedResourceIds(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  return new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean));
}

function executeTeamPublish(_ctx: ApiHandlerContext, workspaceId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const resourceType = requiredString(payload.resourceType, "resourceType");
  const resourceId = requiredString(payload.resourceId, "resourceId");
  return {
    ok: true,
    action: "team.publish",
    workspaceId,
    resourceType,
    resourceId,
    visibility: "team",
    publishedAt: Date.now(),
  };
}

function assertPersonalAiPayloadReadonly(payload: Record<string, unknown>): void {
  const requestedToolKeys = collectPersonalAiToolKeys(payload);
  for (const rawToolKey of requestedToolKeys) {
    const toolPolicy = getSharedWorkspaceOperationPolicy(rawToolKey);
    if (!toolPolicy) {
      throw new SharedWorkspaceHostError(
        "SHARED_WORKSPACE_OPERATION_UNKNOWN",
        "个人 AI 会话中的工具不在只读允许列表内",
        400,
        { toolOperationKey: rawToolKey },
      );
    }
    const toolKey = toolPolicy.operationKey;
    if (PERSONAL_AI_WRITE_TOOL_DENYLIST.has(toolKey)) {
      throw new SharedWorkspaceHostError(
        "SHARED_WORKSPACE_TOOL_LOCK_REQUIRED",
        "个人 AI 会话中的写工具需要切换到共享写入上下文",
        409,
        { toolOperationKey: toolKey },
      );
    }
    if (!PERSONAL_AI_READ_TOOL_ALLOWLIST.has(toolKey)) {
      throw new SharedWorkspaceHostError(
        "SHARED_WORKSPACE_OPERATION_UNKNOWN",
        "个人 AI 会话中的工具不在只读允许列表内",
        400,
        { toolOperationKey: toolKey },
      );
    }
  }
}

function collectPersonalAiToolKeys(payload: Record<string, unknown>): string[] {
  const rawValues = [
    payload.toolOperationKey,
    payload.requestedToolOperationKey,
    payload.toolOperationKeys,
    payload.requestedToolOperationKeys,
    payload.hostToolOperationKeys,
  ];
  const keys: string[] = [];
  for (const raw of rawValues) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      const key = String(value ?? "").trim();
      if (key) keys.push(key);
    }
  }
  return Array.from(new Set(keys));
}

/** 截取本请求响应；停止证明可提前返回，保存尾链仍交唯一API owner跟踪。 */
async function invokeApi(ctx: ApiHandlerContext, method: string, body: Record<string, unknown>): Promise<unknown> {
  const id = `sw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const holder: { response: ApiResponseMessage | null } = { response: null };
  let releaseEarly!: () => void;
  const earlyResponse = new Promise<void>(resolve => { releaseEarly = resolve; });
  const childCtx: ApiHandlerContext = {
    ...ctx,
    send: (msg) => {
      if (msg.t === "api.res" && msg.id === id) {
        if (holder.response) throw new WorkspaceApiRequestFailure([new Error("SHARED_HOST_REPEATED_API_RESPONSE")], {
          code: "WORKSPACE_API_RESPONSE_FAILED", requestId: id, method, workspaceId: body.workspaceId as WorkspaceId,
          responseAttempted: true, responseDelivered: true,
        });
        holder.response = msg;
        if (ctx.trackApiTail && method === "turns.interrupt" && msg.status === 200 && (msg.body as { phase?: unknown })?.phase === "draining") releaseEarly();
        return;
      }
      return ctx.send(msg);
    },
  };
  const handling = handleApiRequest(childCtx, {
    t: "api.req",
    id,
    method,
    path: "/shared-workspace/host-command",
    body,
  } satisfies ApiRequestMessage);
  if (ctx.trackApiTail && method === "turns.interrupt") {
    const early = await Promise.race([handling.then(() => false), earlyResponse.then(() => true)]);
    if (early) ctx.trackApiTail(handling, { requestId: id, method, workspaceId: body.workspaceId as WorkspaceId,
      threadId: typeof body.threadId === "string" ? body.threadId as ThreadId : null });
  } else await handling;
  const response = holder.response;
  if (!response) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_TIMEOUT", "host handler 未返回结果", 504);
  }
  if (Number(response.status) >= 400) {
    const body = asRecord(response.body);
    if (body.code === "SHARED_WORKSPACE_FORBIDDEN") {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_FORBIDDEN", String(body.message), 403);
    }
    if (method.startsWith("mcp.") && typeof body.errorCode === "string" && body.errorCode.trim()) {
      throw new SharedWorkspaceHostError(
        "SHARED_WORKSPACE_HOST_UNAVAILABLE",
        String(body.message ?? "MCP 操作失败"),
        Number(response.status),
        response.body,
      );
    }
    throw new SharedWorkspaceHostError(
      "SHARED_WORKSPACE_HOST_UNAVAILABLE",
      String(body.message ?? "host handler 执行失败"),
      Number(response.status),
      response.body,
    );
  }
  return response.body;
}

/** 文件读取及下载分片映射到 Host 工作区，保持原处理器的失败边界。 */
async function executeFsRead(ctx: ApiHandlerContext, workspaceId: string, payload: Record<string, unknown>): Promise<unknown> {
  const method = String(payload.method ?? "fs.readFile").trim();
  if (method === "fs.stat") return await invokeApi(ctx, "fs.stat", { ...payload, workspaceId });
  if (method === "fs.search") return await invokeApi(ctx, "fs.search", { ...payload, workspaceId });
  if (method === "fs.reindex") return await invokeApi(ctx, "fs.reindex", { ...payload, workspaceId });
  if (method === "fs.readFile") return await invokeApi(ctx, "fs.readFile", { ...payload, workspaceId });
  if (method === "fs.downloadFile") return await invokeApi(ctx, "fs.downloadFile", { ...payload, workspaceId });
  if (method === "fs.downloadStat") return await invokeApi(ctx, "fs.downloadStat", { ...payload, workspaceId });
  if (method === "fs.downloadChunk") return await invokeApi(ctx, "fs.downloadChunk", { ...payload, workspaceId });
  if (method === "fs.spreadsheetPreview") return await invokeApi(ctx, "fs.spreadsheetPreview", { ...payload, workspaceId });
  if (method === "fs.documentPreview") return await invokeApi(ctx, "fs.documentPreview", { ...payload, workspaceId });
  if (method === "fs.extractAttachment") return await invokeApi(ctx, "fs.extractAttachment", { ...payload, workspaceId });
  throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "不支持的文件读取操作", 400);
}

async function executeGitRead(ctx: ApiHandlerContext, workspaceId: string, payload: Record<string, unknown>): Promise<unknown> {
  const method = String(payload.method ?? "git.status").trim();
  if (!GIT_READ_METHODS.has(method)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "不支持的 git 读取操作", 400);
  }
  return await invokeApi(ctx, method, { ...payload, workspaceId });
}

async function executeGitWrite(ctx: ApiHandlerContext, workspaceId: string, payload: Record<string, unknown>): Promise<unknown> {
  const method = String(payload.method ?? "").trim();
  if (!GIT_WRITE_METHODS.has(method)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "不支持的 git 写操作", 400);
  }
  return await invokeApi(ctx, method, { ...payload, workspaceId });
}

/** 共享文件写入复核源与目标的真实工作区边界，成功后同步增量索引。 */
function executeFsWrite(ctx: ApiHandlerContext, workspaceId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const workspacePath = ctx.workspaces.get(workspaceId as any);
  if (!workspacePath) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_HOST_UNAVAILABLE", "未知 host workspace", 409);
  }
  const action = String(payload.action ?? "write").trim();
  const targetPath = assertWorkspaceRelativePath(workspacePath, String(payload.path ?? ""));
  const targetRelPath = toWorkspaceRelPath(workspacePath, targetPath);
  resolveWorkspaceReadPath(workspacePath, targetPath, true);
  if (action === "delete") {
    fs.rmSync(targetPath, { recursive: true, force: true });
    applyWorkspaceIndexChanges(ctx, workspaceId, workspacePath, [{ type: "delete", path: targetRelPath }]);
    return { ok: true, action: "delete" };
  }
  if (action === "rename") {
    const nextPath = assertWorkspaceRelativePath(workspacePath, String(payload.newPath ?? ""));
    const nextRelPath = toWorkspaceRelPath(workspacePath, nextPath);
    resolveWorkspaceReadPath(workspacePath, nextPath, true);
    fs.mkdirSync(path.dirname(nextPath), { recursive: true });
    fs.renameSync(targetPath, nextPath);
    applyWorkspaceIndexChanges(ctx, workspaceId, workspacePath, [{ type: "rename", fromPath: targetRelPath, toPath: nextRelPath }]);
    return { ok: true, action: "rename" };
  }
  const content = typeof payload.content === "string" ? payload.content : "";
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  applyWorkspaceIndexChanges(ctx, workspaceId, workspacePath, [{ type: "upsert", path: targetRelPath }]);
  return { ok: true, action: "write", bytes: Buffer.byteLength(content, "utf8") };
}

/** 共享历史须先flush；纯元数据摘要仍可诊断保存失败，ACL和分页边界不变。 */
async function readContextDetail(
  ctx: ApiHandlerContext,
  workspaceId: string,
  payload: Record<string, unknown>,
  envelope: SharedWorkspaceCommandEnvelope,
): Promise<Record<string, unknown>> {
  const resourceType = String(payload.resourceType ?? "").trim();
  const resourceId = String(payload.resourceId ?? "").trim();
  if (resourceType === "thread" && resourceId) {
    if (!isWorkspacePersistenceRecoveryApiRequest(sharedPersistenceRecoveryMethod(envelope))) {
      await ctx.flushLocalEvents?.(workspaceId as WorkspaceId, resourceId as ThreadId);
    }
    const thread = await withSharedDatabase(ctx, envelope.operationId, () => ctx.db.threads.get(resourceId as any));
    if (!thread || String(thread.workspaceId) !== String(workspaceId)) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "线程不存在或不属于绑定 workspace", 403);
    }
    const sharedAccess = resolveSharedThreadAccess(thread, envelope, "read");
    const includeThread = payload.includeThread !== false;
    const includeEvents = shouldIncludeContextDetailEvents(payload);
    const limit = normalizeContextDetailEventLimit(payload.limit);
    const rawBeforeSeq = payload.beforeSeq == null ? null : Number(payload.beforeSeq);
    const beforeSeq = rawBeforeSeq != null && Number.isFinite(rawBeforeSeq) && rawBeforeSeq > 0
      ? Math.floor(rawBeforeSeq)
      : null;
    const rawPresentationLimit = payload.presentationLimit == null ? null : Number(payload.presentationLimit);
    const presentationLimit = rawPresentationLimit != null && Number.isFinite(rawPresentationLimit) && rawPresentationLimit > 0
      ? Math.min(200, Math.floor(rawPresentationLimit)) : null;
    const rawPresentationBefore = payload.presentationBeforePosition == null ? null : Number(payload.presentationBeforePosition);
    const presentationBeforePosition = rawPresentationBefore != null && Number.isFinite(rawPresentationBefore) && rawPresentationBefore > 0
      ? Math.floor(rawPresentationBefore) : null;
    const includeDraft = includeThread && Boolean(payload.includeDraft) && !sharedAccess.readOnly;
    const response: Record<string, unknown> = {
      ok: true,
      resourceType,
      resourceId,
      sharedContext: sharedAccess.context,
      readOnly: sharedAccess.readOnly,
    };
    if (includeThread) {
      await withSharedDatabase(ctx, envelope.operationId, () => {
      const runningByThreadId = ctx.db.turns?.listRunningByWorkspace?.(workspaceId as any) ?? {};
      response.thread = thread;
      response.hasRealTurnActivity = ctx.db.turns?.hasAnyByThread?.(thread.id) ?? false;
      response.running = resolveThreadRunningState(ctx, { workspaceId: workspaceId as WorkspaceId, threadId: thread.id, runningByThreadId });
      response.visibility = getThreadEntryVisibility(thread);
      response.draft = includeDraft ? ctx.db.threadDrafts.get(thread.id) : null;
      response.prefs = {
        model: thread.model,
        effort: thread.effort,
        accessMode: thread.accessMode,
        planMode: thread.planMode,
        autoCompactPct: thread.autoCompactPct,
        contextWindow: thread.contextWindow,
        serviceTier: thread.serviceTier,
      };
      response.managedServices = { visible: true, threadId: thread.id };
      });
    }
    if (payload.detailMode === "presentation" || payload.detailMode === "process" || payload.presentation === "lazy") {
      try {
        await ctx.db.conversationEvents.ensurePresentation(thread.id, { withDatabase: operation => withSharedDatabase(ctx, envelope.operationId, operation) });
        if (payload.detailMode === "process") {
          Object.assign(response, await withSharedDatabase(ctx, envelope.operationId, () => ctx.db.conversationEvents.readProcess(thread.id, String(payload.processId ?? ""), {
            afterSeq: payload.afterSeq as number | undefined, cursor: payload.cursor as string | undefined,
            throughSeq: payload.throughSeq as number | undefined, limit: payload.limit as number | undefined,
          })));
        } else {
          const presentation = await withSharedDatabase(ctx, envelope.operationId, () => presentationLimit
            ? ctx.db.conversationEvents.readPresentationPage(thread.id, { messageLimit: presentationLimit, beforePosition: presentationBeforePosition })
            : ctx.db.conversationEvents.readPresentation(thread.id));
          response.presentation = presentation;
          response.events = [];
          response.hasMore = false;
          response.oldestSeq = null;
          response.latestSeq = presentation.version;
          response.rawEventCount = 0;
          response.deletedMessageIds = presentation.state.deletedMessageIds;
        }
      } catch (error) {
        logger.error("api", "shared thread presentation read failed", { code: "THREAD_PRESENTATION_READ_FAILED",
          requestId: envelope.operationId, routeEventId: envelope.routeEventId, workspaceId, threadId: resourceId,
          processId: payload.processId, rootCause: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    } else if (includeEvents) {
      let replay;
      try {
        replay = await ctx.db.conversationEvents.listByThreadForReplay(resourceId as any, {
          limit,
          withDatabase: operation => withSharedDatabase(ctx, envelope.operationId, operation),
          ...(beforeSeq != null ? { beforeSeq } : {}),
        });
      } catch (error) {
        logger.error("api", "shared thread history load failed", {
          code: "THREAD_HISTORY_LOAD_FAILED", requestId: envelope.operationId, routeEventId: envelope.routeEventId,
          sharedWorkspaceId: envelope.sharedWorkspaceId, workspaceId, threadId: resourceId, beforeSeq, limit,
          rootCause: error instanceof Error ? { message: error.message, cause: error.cause instanceof Error ? error.cause.message : error.cause } : String(error),
        });
        throw error;
      }
      const events = replay.events;
      response.events = events;
      response.hasMore = replay.hasMore;
      response.oldestSeq = replay.oldestSeq;
      response.latestSeq = replay.latestSeq;
      response.rawEventCount = replay.rawEventCount;
      response.deletedMessageIds = await withSharedDatabase(ctx, envelope.operationId, () => ctx.db.conversationEvents.listDeletedMessageIds(resourceId as any));
    }
    return response;
  }
  return { ok: true, resourceType, resourceId, detail: null, readOnly: true };
}

/** 判定 context.detail.read 是否需要携带历史事件；兼容未传 includeEvents 的旧 Server。 */
function shouldIncludeContextDetailEvents(payload: Record<string, unknown>): boolean {
  if (typeof payload.includeEvents === "boolean") return payload.includeEvents;
  return hasOwn(payload, "limit") || hasOwn(payload, "beforeSeq") || hasOwn(payload, "includeDraft");
}

/** 归一化 Host 端历史事件窗口，防止旧 Server 或异常参数触发大包。 */
function normalizeContextDetailEventLimit(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_CONTEXT_DETAIL_EVENT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONTEXT_DETAIL_EVENT_LIMIT;
  return Math.min(MAX_CONTEXT_DETAIL_EVENT_LIMIT, Math.max(1, Math.floor(parsed)));
}

/** Object.hasOwn 的窄封装，避免旧运行时兼容性差异。 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function readContextList(
  ctx: ApiHandlerContext,
  workspaceId: string,
  payload: Record<string, unknown>,
  envelope: SharedWorkspaceCommandEnvelope,
): Record<string, unknown> {
  const resourceType = String(payload.resourceType ?? "").trim();
  if (resourceType !== "thread") {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "context.list 暂只支持 thread 资源", 400);
  }
  const sharedThreadAclSync = applyInlineSharedThreadAclSync(ctx, workspaceId, payload, envelope);
  const scope = parseThreadListScope(payload.scope);
  const sort = parseThreadListSort(payload.sort);
  const includeArchived = parseBoolean(payload.includeArchived, false);
  const search = optionalString(payload.search) ?? "";
  const groupId = optionalString(payload.groupId);
  const limit = positiveOptionalInt(payload.limit);
  const cursor = optionalString(payload.cursor);
  const restrictResourceIds = Array.isArray(payload.allowedResourceIds);
  const allowedResourceIds = new Set(
    (restrictResourceIds ? payload.allowedResourceIds as unknown[] : [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  );
  if (restrictResourceIds && allowedResourceIds.size === 0) {
    return { ok: true, resourceType, threads: [], runningByThreadId: {}, workflowByThreadId: {}, hasMore: false, nextCursor: null };
  }
  const onlyRelatedToMe = parseBoolean(payload.onlyRelatedToMe, true);
  const actorIsAdmin = envelope.authorization.actorAssetRole !== "member";
  const result = ctx.db.threads.listByWorkspace(workspaceId as any, {
    scope,
    sort,
    includeArchived,
    search,
    groupId: restrictResourceIds ? null : groupId,
    limit: restrictResourceIds ? Math.max(allowedResourceIds.size, 500) : (limit ?? undefined),
    cursor: restrictResourceIds ? null : cursor,
    threadListOnly: true,
    sharedWorkspaceId: restrictResourceIds ? null : envelope.sharedWorkspaceId,
    sharedActorUserId: restrictResourceIds ? null : envelope.actorUserId,
    sharedOnlyRelatedToMe: !restrictResourceIds && !actorIsAdmin && onlyRelatedToMe,
    knowledgeActorUserId: envelope.actorUserId,
    knowledgeSharedWorkspaceId: envelope.sharedWorkspaceId,
    emptyKnowledgeOwnerThreadIds: scope === "current" || scope === "orchestration" ? [] : knowledgeTaskOwnerThreadIds(ctx.workspaces.get(workspaceId as WorkspaceId)!),
  });
  const threads = result.threads.filter((thread) => {
    if (restrictResourceIds && !allowedResourceIds.has(String(thread.id))) return false;
    return getThreadEntryVisibility(thread).threadList && (!scope || matchesThreadListScope(thread, scope));
  }).map((thread) => restrictResourceIds ? thread : decorateSharedThreadSummary(ctx, thread, envelope));
  const runningByThreadId = threads.length
    ? filterRunningThreads(resolveThreadRunningStateMap(ctx, { workspaceId: workspaceId as WorkspaceId, threads }), threads)
    : {};
  const workflowByThreadId = threads.length
    ? resolveThreadWorkflowStateMap(ctx, { workspaceId: workspaceId as WorkspaceId, threads })
    : {};
  return {
    ok: true,
    resourceType,
    ...(sharedThreadAclSync ? { sharedThreadAclSync } : {}),
    threads,
    runningByThreadId,
    workflowByThreadId,
    hasMore: restrictResourceIds ? false : result.hasMore,
    nextCursor: restrictResourceIds ? null : result.nextCursor,
  };
}

/** 严格校验并原子应用 context.list 内联 ACL；字段缺省时保持旧 Host 行为。 */
function applyInlineSharedThreadAclSync(
  ctx: ApiHandlerContext,
  workspaceId: string,
  payload: Record<string, unknown>,
  envelope: SharedWorkspaceCommandEnvelope,
): { applied: true; processed: number; updated: number; missing: number; stale: number } | null {
  if (!hasOwn(payload, "sharedThreadAclSyncItems")) return null;
  const items = normalizeSharedThreadAclSyncItems(payload.sharedThreadAclSyncItems, envelope.sharedWorkspaceId);
  const result = applySharedThreadAclBatch(ctx, envelope, workspaceId as WorkspaceId, items);
  return { applied: true, ...result };
}

/** 用 Server 下发的可信 ACL 修正 Host 本地 thread owner，供校验和通知路由复用。 */
function syncSharedThreadAclFromTrustedPayload(
  ctx: ApiHandlerContext,
  workspaceId: string,
  envelope: SharedWorkspaceCommandEnvelope,
  payload: Record<string, unknown>,
): void {
  if (!("sharedThreadAcl" in payload)) return;
  const threadId = String(payload.threadId ?? "").trim();
  const raw = payload.sharedThreadAcl;
  if (!threadId || !raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "共享会话 ACL 载荷无效", 403);
  }
  const record = raw as Record<string, unknown>;
  const sharedWorkspaceId = String(record.sharedWorkspaceId ?? "").trim();
  const ownerUserId = String(record.ownerUserId ?? "").trim();
  if (sharedWorkspaceId !== envelope.sharedWorkspaceId || !ownerUserId) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "共享会话 ACL 与命令不匹配", 403);
  }
  const thread = ctx.db.threads.get(threadId as any);
  if (!thread || String(thread.workspaceId) !== String(workspaceId)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "共享会话 ACL 目标线程不存在", 403);
  }
  const visibility = record.visibility === "private" || record.visibility === "team" ? record.visibility : "participants";
  const participantUserIds = Array.isArray(record.participantUserIds)
    ? record.participantUserIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const updatedAt = Number(record.updatedAt);
  const ok = ctx.db.threads.setSharedAcl(threadId as any, {
    sharedWorkspaceId,
    ownerUserId,
    visibility,
    participantUserIds,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : Date.now(),
  });
  if (!ok) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "共享会话 ACL 同步失败", 403);
  }
}

/** 从共享路由 envelope 派生分组操作上下文。 */
function buildSharedThreadGroupContext(envelope: SharedWorkspaceCommandEnvelope): Record<string, unknown> {
  return {
    sharedWorkspaceId: envelope.sharedWorkspaceId,
    actorUserId: envelope.actorUserId,
    actorIsAdmin: envelope.authorization.actorAssetRole !== "member",
  };
}

/** 从服务端 envelope 派生新共享会话 ACL，避免信任前端 payload。 */
function buildSharedThreadAclFromEnvelope(envelope: SharedWorkspaceCommandEnvelope): Record<string, unknown> {
  return {
    sharedWorkspaceId: envelope.sharedWorkspaceId,
    ownerUserId: envelope.actorUserId,
    visibility: "participants",
    participantUserIds: [],
    updatedAt: envelope.createdAt || Date.now(),
  };
}

/** 同步服务端旧关系表导出的 ACL；只更新 Host 本地已存在的 thread。 */
function syncSharedThreadAcl(ctx: ApiHandlerContext, envelope: SharedWorkspaceCommandEnvelope): Record<string, unknown> {
  const payload = asRecord(envelope.payload);
  const resourceType = String(payload.resourceType ?? "thread").trim();
  if (resourceType !== "thread") {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_OPERATION_UNKNOWN", "共享会话 ACL 同步仅支持 thread", 400);
  }
  const items = normalizeSharedThreadAclSyncItems(payload.items, envelope.sharedWorkspaceId);
  const result = applySharedThreadAclBatch(ctx, envelope, envelope.localWorkspaceId, items);
  return { ok: true, resourceType, updated: result.updated, skipped: result.missing + result.stale };
}

/** 原子应用共享 ACL；workspace 不一致时补齐 Host 路由上下文后继续抛错。 */
function applySharedThreadAclBatch(
  ctx: ApiHandlerContext,
  envelope: SharedWorkspaceCommandEnvelope,
  workspaceId: WorkspaceId,
  items: readonly SharedThreadAclSyncItem[],
) {
  try {
    return ctx.db.threads.setSharedAclMany({
      workspaceId,
      sharedWorkspaceId: envelope.sharedWorkspaceId,
      items,
    });
  } catch (error) {
    if (error instanceof SharedThreadAclWorkspaceMismatchError) {
      logger.error("shared-workspace", "shared thread ACL workspace mismatch", {
        event: error.code,
        hostClientId: ctx.clientId,
        operationId: envelope.operationId,
        routeEventId: String(envelope.routeEventId ?? "").trim() || null,
        operationKey: envelope.operationKey,
        sharedWorkspaceId: envelope.sharedWorkspaceId,
        ...error.context,
      });
    }
    throw error;
  }
}

/** 在 Host 本地执行 thread 操作前，用本地共享 ACL 做最终授权。 */
function assertSharedThreadOperationAccess(
  ctx: ApiHandlerContext,
  workspaceId: string,
  envelope: SharedWorkspaceCommandEnvelope,
  payload: Record<string, unknown>,
): void {
  const target = resolveSharedThreadOperationTarget(envelope.operationKey, payload);
  if (!target) return;
  const thread = ctx.db.threads.get(target.threadId as any);
  if (!thread || String(thread.workspaceId) !== String(workspaceId)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "线程不存在或不属于绑定 workspace", 403);
  }
  resolveSharedThreadAccess(thread, envelope, target.mode);
}

/** 从操作 key 和 payload 中识别需要 Host 本地 ACL 校验的 thread 目标。 */
function resolveSharedThreadOperationTarget(
  operationKey: SharedWorkspaceOperationKey,
  payload: Record<string, unknown>,
): { threadId: string; mode: "read" | "write" } | null {
  if (operationKey === "context.detail.read") {
    const resourceType = String(payload.resourceType ?? "").trim();
    const resourceId = String(payload.resourceId ?? "").trim();
    return resourceType === "thread" && resourceId ? { threadId: resourceId, mode: "read" } : null;
  }
  if (operationKey === "context.list" || operationKey === "context.thread.create" || operationKey === "context.thread.acl.sync") {
    return null;
  }
  const threadId = String(payload.threadId ?? "").trim();
  if (!threadId) return null;
  if (READ_THREAD_OPERATION_KEYS.has(operationKey)) return { threadId, mode: "read" };
  if (WRITE_THREAD_OPERATION_KEYS.has(operationKey)) return { threadId, mode: "write" };
  return null;
}

const READ_THREAD_OPERATION_KEYS = new Set<SharedWorkspaceOperationKey>([
  "context.thread.prefs",
  "context.thread.latest_prefs",
  "context.thread.input_actions.list",
  "context.thread.draft.get",
  "context.thread.rollback.preview",
  "context.thread.file_changes.list",
  "context.thread.file_changes.diff",
  "context.thread.managed_services.list",
  "context.thread.queue.list",
  "ai.thread.send.personal",
]);

const WRITE_THREAD_OPERATION_KEYS = new Set<SharedWorkspaceOperationKey>([
  "context.thread.message.delete",
  "context.thread.rename",
  "context.thread.archive",
  "context.thread.pin",
  "context.thread.update_prefs",
  "context.thread.draft.save",
  "context.thread.draft.clear",
  "context.thread.rollback",
  "context.thread.delete",
  "context.thread.clear",
  "context.thread.interrupt",
  "context.thread.compact",
  "context.thread.approval.respond",
  "context.thread.user_input.respond",
  "context.thread.file_changes.accept",
  "context.thread.file_changes.undo",
  "context.thread.managed_services.stop",
  "context.thread.queue.append",
  "context.thread.queue.move",
  "context.thread.queue.remove",
  "context.thread.queue.clear",
  "context.thread.queue.resume",
  "context.thread.queue.pause",
  "ai.thread.send.shared",
]);

/** 按 Host 本地 ACL 计算读写权限；写入无权限时直接拒绝。 */
function resolveSharedThreadAccess(
  thread: any,
  envelope: SharedWorkspaceCommandEnvelope,
  mode: "read" | "write",
): { context: Record<string, unknown>; readOnly: boolean } {
  const sharedWorkspaceId = String(thread.sharedWorkspaceId ?? "").trim();
  const ownerUserId = String(thread.ownerUserId ?? "").trim();
  if (!sharedWorkspaceId || sharedWorkspaceId !== String(envelope.sharedWorkspaceId) || !ownerUserId) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "线程未绑定该共享工作区 ACL", 403);
  }
  const participantUserIds = Array.isArray(thread.sharedParticipantUserIds)
    ? thread.sharedParticipantUserIds.map((item: unknown) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const relatedReasons: string[] = [];
  if (ownerUserId === envelope.actorUserId) relatedReasons.push("owner");
  if (participantUserIds.includes(envelope.actorUserId)) relatedReasons.push("participant");
  const relatedToMe = relatedReasons.length > 0;
  if (thread.threadSubtype === "knowledge-conversation" && !relatedToMe) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "只能访问自己拥有或参与的知识会话", 403);
  }
  const actorIsAdmin = envelope.authorization.actorAssetRole !== "member";
  const readOnly = !actorIsAdmin && !relatedToMe;
  if (mode === "write" && readOnly) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", "只能操作与自己有关的共享会话", 403);
  }
  return {
    context: buildSharedThreadContext(thread, envelope, participantUserIds, relatedToMe, relatedReasons, readOnly),
    readOnly,
  };
}

/** 构造返回给 Web 的本地共享会话上下文，保持列表和详情字段一致。 */
function buildSharedThreadContext(
  thread: any,
  envelope: SharedWorkspaceCommandEnvelope,
  participantUserIds: string[],
  relatedToMe: boolean,
  relatedReasons: string[],
  readOnly: boolean,
): Record<string, unknown> {
  const visibility = thread.sharedVisibility === "private" || thread.sharedVisibility === "team"
    ? thread.sharedVisibility
    : "participants";
  return {
    id: `local_acl_${envelope.sharedWorkspaceId}_${String(thread.id)}`,
    sharedWorkspaceId: envelope.sharedWorkspaceId,
    enterpriseId: "",
    hostWorkspaceId: thread.workspaceId,
    resourceType: "thread",
    resourceId: thread.id,
    ownerUserId: thread.ownerUserId,
    visibility,
    participantUserIds,
    titleSummary: thread.title,
    createdAt: Number(thread.createdAt ?? Date.now()),
    updatedAt: Number(thread.sharedAclUpdatedAt ?? thread.updatedAt ?? Date.now()),
    publishedAt: null,
    relatedToMe,
    relatedReasons,
    readOnly,
  };
}

/** 为 Host 本地列表项补充共享 ACL 上下文，同时保留可见 thread id。 */
function decorateSharedThreadSummary(
  ctx: ApiHandlerContext,
  thread: any,
  envelope: SharedWorkspaceCommandEnvelope,
): Record<string, unknown> & { id: ThreadId } {
  const threadId = String(thread.id ?? "") as ThreadId;
  const persisted = ctx.db.threads.get(threadId as any);
  if (!persisted) return { ...thread, id: threadId };
  const access = resolveSharedThreadAccess(persisted, envelope, "read");
  return { ...thread, id: threadId, sharedContext: access.context, readOnly: access.readOnly };
}

/** 严格规整 ACL 同步项，任一非法或重复项都会阻止整批写入。 */
function normalizeSharedThreadAclSyncItems(raw: unknown, expectedSharedWorkspaceId: string): SharedThreadAclSyncItem[] {
  if (!Array.isArray(raw)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "共享会话 ACL 同步项必须是数组", 400);
  }
  const seenThreadIds = new Set<string>();
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "共享会话 ACL 同步单项格式无效", 400, { index });
    }
    const record = value as Record<string, unknown>;
    const sharedWorkspaceId = typeof record.sharedWorkspaceId === "string" ? record.sharedWorkspaceId.trim() : "";
    const threadId = typeof record.threadId === "string" ? record.threadId.trim() : "";
    const ownerUserId = typeof record.ownerUserId === "string" ? record.ownerUserId.trim() : "";
    const visibility = record.visibility;
    const updatedAt = record.updatedAt;
    if (sharedWorkspaceId !== expectedSharedWorkspaceId || !threadId || !ownerUserId) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "共享会话 ACL 同步项缺少必要字段", 400, { index });
    }
    if (seenThreadIds.has(threadId)) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "共享会话 ACL 同步项包含重复 thread", 400, { index, threadId });
    }
    if (visibility !== "private" && visibility !== "participants" && visibility !== "team") {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "共享会话 ACL 同步项 visibility 无效", 400, { index, threadId });
    }
    if (!Array.isArray(record.participantUserIds)
      || record.participantUserIds.some((item) => typeof item !== "string" || !item.trim())) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "共享会话 ACL 同步项 participantUserIds 无效", 400, { index, threadId });
    }
    if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
      throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "共享会话 ACL 同步项 updatedAt 无效", 400, { index, threadId });
    }
    seenThreadIds.add(threadId);
    return {
      sharedWorkspaceId: sharedWorkspaceId as SharedWorkspaceId,
      threadId: threadId as ThreadId,
      ownerUserId,
      visibility,
      participantUserIds: Array.from(new Set(record.participantUserIds.map((item) => item.trim()))).sort(),
      updatedAt,
    };
  });
}

function assertWorkspaceRelativePath(workspacePath: string, rawRelativePath: string): string {
  const relativePath = String(rawRelativePath ?? "").trim();
  if (!relativePath) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "path 不能为空", 400);
  }
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "path 超出 host workspace 边界", 400);
  }
  return resolved;
}

/** 将已校验的绝对路径转为 POSIX workspace 相对路径。 */
function toWorkspaceRelPath(workspacePath: string, absPath: string): string {
  const root = path.resolve(workspacePath);
  const relPath = path.relative(root, path.resolve(absPath));
  if (!relPath || relPath === "." || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", "path 超出 host workspace 边界", 400);
  }
  return relPath.split(path.sep).join("/");
}

/** 将共享文件写操作同步到 Host 本地路径索引；索引未启用时不改变写入结果。 */
function applyWorkspaceIndexChanges(
  ctx: ApiHandlerContext,
  workspaceId: string,
  workspacePath: string,
  changes: WorkspacePathIndexChange[],
): void {
  if (!ctx.workspacePathIndex) return;
  ctx.workspacePathIndex.applyChanges(workspaceId as WorkspaceId, workspacePath, changes);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function positiveOptionalInt(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const integer = Math.floor(parsed);
  return integer > 0 ? integer : null;
}

function parseThreadListScope(value: unknown): ThreadListScope | null {
  if (value == null || String(value).trim() === "") return null;
  return normalizeThreadListScope(value, "all");
}

/** 解析共享 Host 会话列表排序；缺省与普通列表一致。 */
function parseThreadListSort(value: unknown): ThreadListSort {
  return normalizeThreadListSort(value, "activity_desc");
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  return fallback;
}

function filterRunningThreads(
  runningByThreadId: Record<string, unknown>,
  threads: Array<{ id: ThreadId }>,
): Record<string, unknown> {
  const visibleThreadIds = new Set(threads.map((thread) => String(thread.id)));
  return Object.fromEntries(Object.entries(runningByThreadId).filter(([threadId]) => visibleThreadIds.has(threadId)));
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new SharedWorkspaceHostError("SHARED_WORKSPACE_PAYLOAD_REDACTED", `${field} 不能为空`, 400);
  return text;
}

/** 解析正整数；max 存在时用于共享路由大包裁剪。 */
function positiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(parsed)), max);
}

class SharedWorkspaceHostError extends Error {
  constructor(
    readonly code: SharedWorkspaceErrorCode,
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SharedWorkspaceHostError";
  }
}

/** 将 Host 本地错误映射为共享协议错误，保留 ACL 对账详情且不伪装成离线。 */
export function toSharedWorkspaceHostError(error: unknown) {
  if ((error as { code?: string } | null)?.code === "FILE_TRANSFER_PATH_INVALID") {
    return { code: "SHARED_WORKSPACE_PAYLOAD_REDACTED" as const, message: "文件路径超出工作区边界", status: 400 as const };
  }
  if (error instanceof WorkspacePathIndexPathError) {
    return { code: "SHARED_WORKSPACE_HOST_UNAVAILABLE" as const, message: "无法确认共享文件路径的真实目标", status: 500 as const,
      detail: { code: error.diagnosticCode, systemCode: error.systemCode } };
  }
  if (error instanceof SharedWorkspaceHostError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status as any,
      detail: error.detail,
    };
  }
  if (error instanceof SharedThreadAclWorkspaceMismatchError) {
    return {
      code: "SHARED_WORKSPACE_ACL_WORKSPACE_MISMATCH" as const,
      message: error.message,
      status: 409 as const,
      detail: error.context,
    };
  }
  if (error instanceof WorkspaceOperationGateError) {
    return {
      code: "SHARED_WORKSPACE_HOST_UNAVAILABLE" as const,
      message: error.message,
      status: 409 as const,
      detail: { code: error.code, ...error.details },
    };
  }
  return {
    code: "SHARED_WORKSPACE_HOST_UNAVAILABLE" as const,
    message: error instanceof Error ? error.message : String(error),
    status: 409 as const,
  };
}
