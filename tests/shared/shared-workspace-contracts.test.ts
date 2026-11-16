import test from "node:test";
import assert from "node:assert/strict";

import {
  getSharedWorkspaceOperationPolicy,
  isTransientSharedWorkspaceWorkflowUsePayload,
  isSharedWorkspaceOperationKey,
  resolveSharedWorkspaceAssetMetadata,
  normalizeSharedWorkspaceAssetAction,
  resolveSharedWorkspaceEffectiveOperationPolicy,
  SHARED_WORKSPACE_COMMAND_SERVER_RESOLVED_POLICY_FIELDS,
  SHARED_WORKSPACE_ERROR_CODES,
  SHARED_WORKSPACE_ERROR_STATUS,
  SHARED_WORKSPACE_HOST_RPC_METHODS,
  SHARED_WORKSPACE_OPERATION_KEYS,
  buildSharedWorkspaceHostRpcPayload,
  isSharedWorkspaceHostRpcMethod,
  resolveSharedWorkspaceHostRpcBody,
  toSharedWorkspacePublicHostView,
} from "../../packages/shared/src/index.ts";
import type {
  SharedWorkspaceCommandRequest,
  SharedWorkspaceHostBindingInternalView,
  SharedWorkspaceOperationKey,
} from "../../packages/shared/src/index.ts";

test("shared workspace operation policy covers the DGN operation keys", () => {
  const expectedOperationKeys: SharedWorkspaceOperationKey[] = [
    "workspace.fs.tree",
    "workspace.fs.read",
    "workspace.fs.write",
    "workspace.git.status",
    "workspace.git.write",
    "terminal.session.read",
    "terminal.action",
    "context.thread.create",
    "context.thread.acl.sync",
    "context.thread_groups.list",
    "context.thread_groups.create",
    "context.thread_groups.rename",
    "context.thread_groups.delete",
    "context.thread.group.assign",
    "context.thread.rename",
    "context.thread.archive",
    "context.thread.pin",
    "context.thread.update_prefs",
    "context.thread.prefs",
    "context.thread.latest_prefs",
    "context.thread.input_actions.list",
    "context.thread.draft.get",
    "context.thread.draft.save",
    "context.thread.draft.clear",
    "context.thread.rollback.preview",
    "context.thread.rollback",
    "context.thread.delete",
    "context.thread.message.delete",
    "context.thread.clear",
    "context.thread.interrupt",
    "context.thread.compact",
    "context.thread.approval.respond",
    "context.thread.user_input.respond",
    "context.thread.file_changes.list",
    "context.thread.file_changes.diff",
    "context.thread.file_changes.accept",
    "context.thread.file_changes.undo",
    "context.thread.managed_services.list",
    "context.thread.managed_services.stop",
    "context.thread.queue.append",
    "context.thread.queue.list",
    "context.thread.queue.move",
    "context.thread.queue.remove",
    "context.thread.queue.clear",
    "context.thread.queue.resume",
    "context.thread.queue.pause",
    "ai.thread.send.personal",
    "ai.thread.send.shared",
    "context.detail.read",
    "context.list",
    "orch.asset.read",
    "orch.asset.write",
    "orch.workflow.use",
    "skills.read",
    "skills.manage",
    "toolset.read",
    "toolset.manage",
    "team.publish",
    "asset.clone_to_private",
  ];

  assert.deepEqual(SHARED_WORKSPACE_OPERATION_KEYS, expectedOperationKeys);
  assert.equal(isSharedWorkspaceOperationKey("workspace.fs.write"), true);
  assert.equal(isSharedWorkspaceOperationKey("workspace.unknown"), false);

  const fsWrite = getSharedWorkspaceOperationPolicy("workspace.fs.write");
  assert.equal(fsWrite?.lockRequired, true);
  assert.equal(fsWrite?.usageRequired, false);
  assert.equal(fsWrite?.auditAction, "shared_workspace.fs_write");
  assert.equal(fsWrite?.handlerId, "fs.write");

  const personalAi = getSharedWorkspaceOperationPolicy("ai.thread.send.personal");
  assert.equal(personalAi?.lockRequired, false);
  assert.equal(personalAi?.usageRequired, true);
  assert.equal(personalAi?.toolPolicyKey, "ai.personal.readonly");

  const sharedAi = getSharedWorkspaceOperationPolicy("ai.thread.send.shared");
  assert.equal(sharedAi?.lockRequired, false);
  assert.equal(sharedAi?.usageRequired, true);
  assert.equal(sharedAi?.toolPolicyKey, "ai.shared.write");

  const skillsRead = getSharedWorkspaceOperationPolicy("skills.read");
  assert.equal(skillsRead?.lockRequired, false);
  assert.equal(skillsRead?.auditAction, "shared_workspace.skills_read");

  const toolsetRead = getSharedWorkspaceOperationPolicy("toolset.read");
  assert.equal(toolsetRead?.lockRequired, false);
  assert.equal(toolsetRead?.auditAction, "shared_workspace.toolset_read");

  const contextList = getSharedWorkspaceOperationPolicy("context.list");
  assert.equal(contextList?.lockRequired, false);
  assert.equal(contextList?.usageRequired, false);
  assert.equal(contextList?.auditAction, "shared_workspace.context_list");
  assert.equal(contextList?.handlerId, "context.list");

  const contextCreate = getSharedWorkspaceOperationPolicy("context.thread.create");
  assert.equal(contextCreate?.lockRequired, false);
  assert.equal(contextCreate?.usageRequired, false);
  assert.equal(contextCreate?.assetEffect, "use");
  assert.equal(contextCreate?.maintenanceDefinitionRequired, false);
  assert.equal(contextCreate?.handlerId, "thread.create");

  const contextAclSync = getSharedWorkspaceOperationPolicy("context.thread.acl.sync");
  assert.equal(contextAclSync?.lockRequired, false);
  assert.equal(contextAclSync?.usageRequired, false);
  assert.equal(contextAclSync?.auditAction, "shared_workspace.context_acl_sync");
  assert.equal(contextAclSync?.handlerId, "thread.acl.sync");

  const contextRename = getSharedWorkspaceOperationPolicy("context.thread.rename");
  assert.equal(contextRename?.lockRequired, false);
  assert.equal(contextRename?.assetEffect, "shared_write_side_effect");
  assert.equal(contextRename?.handlerId, "thread.rename");

  const contextDraftSave = getSharedWorkspaceOperationPolicy("context.thread.draft.save");
  assert.equal(contextDraftSave?.lockRequired, false);
  assert.equal(contextDraftSave?.handlerId, "thread.draft.save");

  const contextQueueAppend = getSharedWorkspaceOperationPolicy("context.thread.queue.append");
  assert.equal(contextQueueAppend?.usageRequired, true);
  assert.equal(contextQueueAppend?.toolPolicyKey, "ai.shared.write");
  assert.equal(contextQueueAppend?.handlerId, "thread.queue.append");

  const contextQueueList = getSharedWorkspaceOperationPolicy("context.thread.queue.list");
  assert.equal(contextQueueList?.usageRequired, false);
  assert.equal(contextQueueList?.assetEffect, "read");

  const contextRollbackPreview = getSharedWorkspaceOperationPolicy("context.thread.rollback.preview");
  assert.equal(contextRollbackPreview?.lockRequired, false);
  assert.equal(contextRollbackPreview?.assetEffect, "read");
  assert.equal(contextRollbackPreview?.handlerId, "thread.rollback.preview");

  const contextRollback = getSharedWorkspaceOperationPolicy("context.thread.rollback");
  assert.equal(contextRollback?.lockRequired, false);
  assert.equal(contextRollback?.assetEffect, "shared_write_side_effect");
  assert.equal(contextRollback?.handlerId, "thread.rollback");

  const contextDelete = getSharedWorkspaceOperationPolicy("context.thread.delete");
  assert.equal(contextDelete?.lockRequired, false);
  assert.equal(contextDelete?.assetEffect, "shared_write_side_effect");
  assert.equal(contextDelete?.handlerId, "thread.delete");
  assert.equal(contextDelete?.auditAction, "shared_workspace.context_delete");
  assert.deepEqual(
    resolveSharedWorkspaceAssetMetadata("context.thread.delete", { threadId: "thread_delete_asset" }),
    { assetType: "team_view", assetId: "thread_delete_asset", assetAction: "delete" },
  );

  const contextCompact = getSharedWorkspaceOperationPolicy("context.thread.compact");
  assert.equal(contextCompact?.operationType, "ai.write");
  assert.equal(contextCompact?.usageRequired, true);
  assert.equal(contextCompact?.handlerId, "thread.compact");

  const contextFileChangesDiff = getSharedWorkspaceOperationPolicy("context.thread.file_changes.diff");
  assert.equal(contextFileChangesDiff?.operationType, "context.read");
  assert.equal(contextFileChangesDiff?.assetEffect, "read");
  assert.equal(contextFileChangesDiff?.handlerId, "thread.file_changes.diff");

  const contextFileChangesUndo = getSharedWorkspaceOperationPolicy("context.thread.file_changes.undo");
  assert.equal(contextFileChangesUndo?.operationType, "context.write");
  assert.equal(contextFileChangesUndo?.assetEffect, "shared_write_side_effect");
  assert.equal(contextFileChangesUndo?.handlerId, "thread.file_changes.undo");

  const contextApprovalRespond = getSharedWorkspaceOperationPolicy("context.thread.approval.respond");
  assert.equal(contextApprovalRespond?.operationType, "context.write");
  assert.equal(contextApprovalRespond?.handlerId, "thread.approval.respond");

  const contextManagedServicesStop = getSharedWorkspaceOperationPolicy("context.thread.managed_services.stop");
  assert.equal(contextManagedServicesStop?.assetEffect, "shared_write_side_effect");
  assert.equal(contextManagedServicesStop?.handlerId, "thread.managed_services.stop");

  const contextClear = getSharedWorkspaceOperationPolicy("context.thread.clear");
  assert.equal(contextClear?.lockRequired, false);
  assert.equal(contextClear?.handlerId, "thread.clear");
  assert.equal(contextClear?.auditAction, "shared_workspace.context_clear");

  const contextPrefsRead = getSharedWorkspaceOperationPolicy("context.thread.prefs");
  assert.equal(contextPrefsRead?.lockRequired, false);
  assert.equal(contextPrefsRead?.handlerId, "thread.prefs");

  const contextInputActionsRead = getSharedWorkspaceOperationPolicy("context.thread.input_actions.list");
  assert.equal(contextInputActionsRead?.operationType, "context.read");
  assert.equal(contextInputActionsRead?.usageRequired, false);
  assert.equal(contextInputActionsRead?.auditAction, "shared_workspace.context_input_actions_read");
  assert.equal(contextInputActionsRead?.handlerId, "thread.input_actions.list");

  const orchWrite = getSharedWorkspaceOperationPolicy("orch.asset.write");
  assert.equal(orchWrite?.assetEffect, "maintain_definition");
  assert.equal(orchWrite?.maintenanceDefinitionRequired, true);

  const orchUse = getSharedWorkspaceOperationPolicy("orch.workflow.use");
  assert.equal(orchUse?.assetEffect, "use");
  assert.equal(orchUse?.maintenanceDefinitionRequired, false);
  assert.equal(orchUse?.lockRequired, false);
  assert.equal(orchUse?.usageRequired, true);

  assert.equal(isTransientSharedWorkspaceWorkflowUsePayload({ method: "orch.instances.runtimePatch" }), true);
  assert.equal(isTransientSharedWorkspaceWorkflowUsePayload({ method: "orch.instances.start", action: "start" }), false);
  const transientOrchUse = resolveSharedWorkspaceEffectiveOperationPolicy("orch.workflow.use", {
    method: "orch.instances.runtimePatch",
    action: "update",
  });
  assert.equal(transientOrchUse?.usageRequired, false);
  assert.equal(transientOrchUse?.assetEffect, "use");
  const writeOrchUse = resolveSharedWorkspaceEffectiveOperationPolicy("orch.workflow.use", {
    method: "orch.instances.start",
    action: "start",
  });
  assert.equal(writeOrchUse?.usageRequired, true);

  const clone = getSharedWorkspaceOperationPolicy("asset.clone_to_private");
  assert.equal(clone?.assetEffect, "private_clone");
  assert.equal(clone?.cloneToPrivateDisabled, true);
});


test("web command contract keeps policy classification server-owned", () => {
  const webCommand: SharedWorkspaceCommandRequest = {
    operationId: "op-1",
    operationKey: "workspace.fs.write",
    lockToken: "lock-token",
    lockVersion: 3,
    payload: { path: "README.md", action: "write" },
  };

  assert.deepEqual(SHARED_WORKSPACE_COMMAND_SERVER_RESOLVED_POLICY_FIELDS, [
    "operationType",
    "lockRequired",
    "effectiveLockRequired",
    "usageRequired",
    "auditAction",
    "handlerId",
    "toolPolicyKey",
    "assetEffect",
    "maintenanceDefinitionRequired",
    "cloneToPrivateDisabled",
  ]);

  for (const field of SHARED_WORKSPACE_COMMAND_SERVER_RESOLVED_POLICY_FIELDS) {
    assert.equal(Object.hasOwn(webCommand, field), false);
  }
});

test("shared workspace host RPC contract uses explicit local methods and nested bodies", () => {
  for (const method of [
    "orch.roles.upsert",
    "orch.roles.delete",
    "orch.workflows.upsert",
    "orch.assigneeTemplates.list",
    "orch.assetDrafts.generate",
    "orch.assetDraftJobs.list",
    "orch.assetDraftJobs.get",
    "orch.assetDraftJobs.delete",
    "orch.assetDraftJobs.resume",
    "orch.assetDrafts.get",
    "orch.assetDrafts.apply",
    "orch.assetDrafts.reject",
    "orch.knowledgeBundles.upsert",
    "orch.toolsets.upsert",
    "orch.chat.delete",
    "orch.instances.start",
    "orch.instances.reassignNode",
    "orch.nodes.start",
    "skills.install",
    "mcp.configure",
    "mcp.update",
    "mcp.test",
  ]) {
    assert.equal(isSharedWorkspaceHostRpcMethod(method), true, method);
    assert.equal(SHARED_WORKSPACE_HOST_RPC_METHODS.includes(method as any), true, method);
  }
  assert.equal(isSharedWorkspaceHostRpcMethod("orch.assigneeTemplates.preview"), false);
  assert.equal(isSharedWorkspaceHostRpcMethod("workspace.fs.write"), false);

  const payload = buildSharedWorkspaceHostRpcPayload({
    method: "orch.roles.upsert",
    path: "/orch/roles/upsert",
    action: "update",
    assetType: "agent",
    assetId: "role_rpc",
    body: {
      role: { id: "role_rpc", name: "RPC Role" },
      sharedWorkspaceLockToken: "lock-token",
      sharedWorkspaceLockVersion: 3,
    },
  });

  assert.equal(payload.method, "orch.roles.upsert");
  assert.equal(payload.assetType, "agent");
  assert.equal(payload.assetId, "role_rpc");
  assert.equal(payload.sharedWorkspaceLockToken, "lock-token");
  assert.equal(payload.sharedWorkspaceLockVersion, 3);
  assert.deepEqual(resolveSharedWorkspaceHostRpcBody(payload), {
    role: { id: "role_rpc", name: "RPC Role" },
    sharedWorkspaceLockToken: "lock-token",
    sharedWorkspaceLockVersion: 3,
  });
});

test("shared MCP route actions map to existing audit action categories", () => {
  assert.equal(normalizeSharedWorkspaceAssetAction("mcp_install"), "install");
  assert.equal(normalizeSharedWorkspaceAssetAction("mcp_uninstall"), "uninstall");
  assert.equal(normalizeSharedWorkspaceAssetAction("mcp_import"), "import");
  assert.equal(normalizeSharedWorkspaceAssetAction("test"), "use");
  assert.equal(normalizeSharedWorkspaceAssetAction("mcp_test"), "use");
  assert.equal(normalizeSharedWorkspaceAssetAction("mcp_configure"), "update");
});

test("shared workspace error catalog exposes expected status codes", () => {
  assert.equal(SHARED_WORKSPACE_ERROR_STATUS.SHARED_WORKSPACE_NOT_FOUND, 404);
  assert.equal(SHARED_WORKSPACE_ERROR_STATUS.SHARED_WORKSPACE_FORBIDDEN, 403);
  assert.equal(SHARED_WORKSPACE_ERROR_STATUS.SHARED_WORKSPACE_HOST_UNAVAILABLE, 409);
  assert.equal(SHARED_WORKSPACE_ERROR_STATUS.SHARED_WORKSPACE_TOOL_LOCK_REQUIRED, 409);
  assert.equal(SHARED_WORKSPACE_ERROR_STATUS.SHARED_WORKSPACE_HOST_TIMEOUT, 504);
  assert.equal(SHARED_WORKSPACE_ERROR_STATUS.SHARED_WORKSPACE_ASSET_MAINTENANCE_FORBIDDEN, 403);
  assert.equal(SHARED_WORKSPACE_ERROR_STATUS.SHARED_WORKSPACE_PRIVATE_CLONE_DISABLED, 403);

  const expectedCodes = [
    "SHARED_WORKSPACE_OPERATION_UNKNOWN",
    "SHARED_WORKSPACE_LOCK_REQUIRED",
    "SHARED_WORKSPACE_LOCK_STALE",
    "SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN",
  ] as const;

  for (const code of expectedCodes) {
    assert.equal(SHARED_WORKSPACE_ERROR_CODES.includes(code), true);
  }
});

test("host private routing fields are stripped from web public host view", () => {
  const internalHost: SharedWorkspaceHostBindingInternalView = {
    id: "binding-1",
    sharedWorkspaceId: "sw-1",
    enterpriseId: "enterprise-1",
    hostUserId: "user-host",
    hostClientId: "client-host",
    hostKeyHash: "secret-key-hash",
    localWorkspaceId: "workspace-host",
    localWorkspaceLabel: "Host workspace",
    localWorkspacePathHint: "Z:/code/project",
    capabilitySnapshot: {
      fs: true,
      git: true,
      terminal: true,
      ai: true,
      orchestration: true,
      skills: true,
      toolsets: true,
      notes: true,
      capturedAt: 1,
    },
    status: "online",
    lastSeenAt: 2,
    heartbeatExpiresAt: 3,
    boundAt: 1,
    updatedAt: 2,
  };

  const publicHost = toSharedWorkspacePublicHostView(internalHost);
  assert.equal(Object.hasOwn(publicHost, "hostKeyHash"), false);
  assert.equal(Object.hasOwn(publicHost, "localWorkspacePathHint"), false);
  assert.equal(JSON.stringify(publicHost).includes("Z:/code/project"), false);
  assert.equal(publicHost.hostClientId, "client-host");
  assert.equal(publicHost.localWorkspaceId, "workspace-host");
});
