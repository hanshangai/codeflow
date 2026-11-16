import type { ClientId, KeyHash, ThreadId, WebSessionId, WorkspaceId } from "./ids";
import type { WorkspaceDirectoryMigrationHostMaintenance } from "./workspaceDirectoryMigration";

export type SharedWorkspaceId = string;
export type SharedWorkspaceMemberId = string;
export type SharedWorkspaceInviteId = string;
export type SharedWorkspaceHostBindingId = string;
export type SharedWorkspaceRemoteSessionId = string;
export type SharedWorkspaceContextId = string;
export type SharedWorkspaceWriteLockId = string;
export type SharedWorkspaceTakeoverRequestId = string;
export type SharedWorkspaceRouteEventId = string;
export type SharedWorkspaceOperationId = string;
export type WorkspaceFileTransferId = string;

export const SHARED_WORKSPACE_LIFECYCLE_STATUSES = ["pending_host", "active", "deleted"] as const;
export type SharedWorkspaceLifecycleStatus = (typeof SHARED_WORKSPACE_LIFECYCLE_STATUSES)[number];

export const SHARED_WORKSPACE_HOST_STATUSES = ["unbound", "online", "offline"] as const;
export type SharedWorkspaceHostStatus = (typeof SHARED_WORKSPACE_HOST_STATUSES)[number];

export const SHARED_WORKSPACE_MEMBER_ROLES = ["workspace_admin", "member"] as const;
export type SharedWorkspaceMemberRole = (typeof SHARED_WORKSPACE_MEMBER_ROLES)[number];

export const SHARED_WORKSPACE_MEMBER_STATUSES = ["active", "left"] as const;
export type SharedWorkspaceMemberStatus = (typeof SHARED_WORKSPACE_MEMBER_STATUSES)[number];

export const SHARED_WORKSPACE_INVITE_STATUSES = ["effective", "revoked"] as const;
export type SharedWorkspaceInviteStatus = (typeof SHARED_WORKSPACE_INVITE_STATUSES)[number];

export const SHARED_WORKSPACE_LOCK_STATUSES = ["free", "held", "transferring", "unavailable"] as const;
export type SharedWorkspaceLockStatus = (typeof SHARED_WORKSPACE_LOCK_STATUSES)[number];

export const SHARED_WORKSPACE_TAKEOVER_STATUSES = ["pending", "approved", "rejected", "timeout", "cancelled"] as const;
export type SharedWorkspaceTakeoverStatus = (typeof SHARED_WORKSPACE_TAKEOVER_STATUSES)[number];

export const SHARED_WORKSPACE_ROUTE_STATUSES = ["queued", "routed", "ack", "succeeded", "failed", "cancelled"] as const;
export type SharedWorkspaceRouteStatus = (typeof SHARED_WORKSPACE_ROUTE_STATUSES)[number];

export const SHARED_WORKSPACE_EFFECTIVE_ASSET_ROLES = ["enterprise_admin", "workspace_admin", "member"] as const;
export type SharedWorkspaceEffectiveAssetRole = (typeof SHARED_WORKSPACE_EFFECTIVE_ASSET_ROLES)[number];

export type SharedWorkspaceAssetPermissions = {
  effectiveAssetRole: SharedWorkspaceEffectiveAssetRole;
  maintenanceScope: "workspace_all";
  canReadAssets: boolean;
  canUseAssets: boolean;
  canMaintainAssets: boolean;
  canCloneToPrivate: false;
  canAcquireAssetMaintenanceLock: boolean;
  maintenanceGrantSource?: "role" | "all_members" | "selected_member" | null;
  deniedReason?: "member_maintenance_denied" | "private_clone_disabled" | null;
};

export type SharedWorkspaceEntryStatus = "available" | "host_unbound" | "host_offline" | "client_offline" | "forbidden";

export type SharedWorkspaceAccessMode = "member_remote_use" | "asset_admin";

export type SharedWorkspaceDirectEntry = {
  sharedWorkspaceId: SharedWorkspaceId;
  displayName: string;
  currentUserRole: SharedWorkspaceEffectiveAssetRole;
  effectiveAssetRole: SharedWorkspaceEffectiveAssetRole;
  hostStatus: SharedWorkspaceHostStatus;
  /** Host owner 可见的承载端标识；用于共享入口定位运行时 Client，不包含 hostKeyHash。 */
  hostClientId?: ClientId | null;
  /** Host owner 可见的本地工作区 ID；用于重连后按 workspace alias 反查 Client。 */
  hostLocalWorkspaceId?: WorkspaceId | null;
  hostLabel?: string | null;
  /** Host 本地目录迁移维护态；仅用于成员入口展示和门禁提示。 */
  hostMaintenance?: WorkspaceDirectoryMigrationHostMaintenance | null;
  hostOwnerName?: string | null;
  hostOwnerEmail?: string | null;
  workspaceAdminName?: string | null;
  workspaceAdminEmail?: string | null;
  isHostOwner: boolean;
  assetPermissions: SharedWorkspaceAssetPermissions;
};

export type SharedWorkspaceFileTransferPolicy = {
  uploadEnabled: boolean;
  downloadEnabled: boolean;
  maxFileSizeBytes: number;
  uploadRateLimitBytesPerSecond: number;
  downloadRateLimitBytesPerSecond: number;
  maxConcurrentTransfers: number;
};

export const SHARED_WORKSPACE_ASSET_MAINTENANCE_MODES = ["all_members", "selected_members"] as const;
export type SharedWorkspaceAssetMaintenanceMode = (typeof SHARED_WORKSPACE_ASSET_MAINTENANCE_MODES)[number];

export type SharedWorkspaceAssetMaintenancePolicy = {
  mode: SharedWorkspaceAssetMaintenanceMode;
  authorizedMemberUserIds: string[];
  /** 兼容旧开关语义；由 mode 派生，读取旧数据时仍作为输入。 */
  memberAssetMaintenanceEnabled: boolean;
};

export type SharedWorkspaceAssetMaintenanceAuthorizedMember = {
  userId: string;
  displayName: string;
  email: string;
  role?: SharedWorkspaceMemberRole | null;
  status?: SharedWorkspaceMemberStatus | null;
  effective: boolean;
  disabledReason?: SharedWorkspaceUsageEligibilityReason | "not_active_shared_member" | "admin_default_maintainer" | null;
  usageEligibility?: SharedWorkspaceUsageEligibilitySnapshot | null;
};

export type WorkspaceFileTransferDirection = "upload" | "download";
export type WorkspaceFileTransferStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "rejected";
export type WorkspaceFileTransferScope = "local" | "shared";

export type WorkspaceFileTransferEventItem = {
  id: WorkspaceFileTransferId;
  transferId: string;
  scope: WorkspaceFileTransferScope;
  sharedWorkspaceId?: SharedWorkspaceId | null;
  enterpriseId?: string | null;
  workspaceId: WorkspaceId;
  actorUserId: string;
  actorDisplayName?: string | null;
  actorEmail?: string | null;
  direction: WorkspaceFileTransferDirection;
  status: WorkspaceFileTransferStatus;
  filePath: string;
  fileName: string;
  mimeType?: string | null;
  sizeBytes: number;
  transferredBytes: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  clientId?: ClientId | null;
  auditLogId?: string | null;
  rateLimitBytesPerSecond: number;
  startedAt?: number | null;
  completedAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type SharedWorkspaceFileTransferPolicyResponseBody = {
  policy: SharedWorkspaceFileTransferPolicy;
};

export type UpdateSharedWorkspaceFileTransferPolicyRequestBody = Partial<SharedWorkspaceFileTransferPolicy>;

export type SharedWorkspaceAssetMaintenancePolicyResponseBody = {
  sharedWorkspaceId?: SharedWorkspaceId;
  enterpriseId?: string;
  policy: SharedWorkspaceAssetMaintenancePolicy;
  authorizedMembers: SharedWorkspaceAssetMaintenanceAuthorizedMember[];
};

export type UpdateSharedWorkspaceAssetMaintenancePolicyRequestBody = Partial<SharedWorkspaceAssetMaintenancePolicy>;

export type SharedWorkspaceFileTransfersQuery = {
  direction?: WorkspaceFileTransferDirection;
  status?: WorkspaceFileTransferStatus;
  actorUserId?: string;
  keyword?: string;
  from?: number;
  to?: number;
  offset?: number;
  limit?: number;
};

export type SharedWorkspaceFileTransfersResponseBody = {
  items: WorkspaceFileTransferEventItem[];
  total: number;
};

export const SHARED_WORKSPACE_ASSET_TYPES = [
  "workflow",
  "agent",
  "knowledge_bundle",
  "skill",
  "toolset",
  "team_view",
  "unknown",
] as const;
export type SharedWorkspaceAssetType = (typeof SHARED_WORKSPACE_ASSET_TYPES)[number];

export const SHARED_WORKSPACE_ASSET_ACTIONS = [
  "read",
  "use",
  "create",
  "update",
  "delete",
  "import",
  "install",
  "uninstall",
  "publish",
  "clone_to_private",
] as const;
export type SharedWorkspaceAssetAction = (typeof SHARED_WORKSPACE_ASSET_ACTIONS)[number];

export const SHARED_WORKSPACE_HOST_RPC_METHODS = [
  "orch.roles.list",
  "orch.assetGroups.list",
  "orch.assetGroups.create",
  "orch.assetGroups.rename",
  "orch.assetGroups.delete",
  "orch.assetGroups.assign",
  "orch.roles.upsert",
  "orch.roles.delete",
  "orch.workflows.list",
  "orch.workflows.upsert",
  "orch.workflows.delete",
  "orch.assigneeTemplates.list",
  "orch.workflowExecutionDefaults.get",
  "orch.workflowExecutionDefaults.upsert",
  "orch.workflowExecutionDefaults.delete",
  "orch.knowledgeBundles.list",
  "orch.knowledgeBundles.upsert",
  "orch.knowledgeBundles.delete",
  "orch.toolsets.list",
  "orch.toolsets.upsert",
  "orch.toolsets.delete",
  "orch.skills.list",
  "orch.skills.upsert",
  "orch.skills.delete",
  "orch.skills.installStatus",
  "orch.skills.install",
  "orch.skills.uninstall",
  "orch.assetBundles.export",
  "orch.assetBundles.import",
  "orch.assetDrafts.generate",
  "orch.assetDraftJobs.list",
  "orch.assetDraftJobs.get",
  "orch.assetDraftJobs.delete",
  "orch.assetDraftJobs.resume",
  "orch.assetDrafts.get",
  "orch.assetDrafts.apply",
  "orch.assetDrafts.reject",
  "orch.intakes.list",
  "orch.intakes.create",
  "orch.intakes.upsert",
  "orch.intakes.delete",
  "orch.pendingMine.list",
  "orch.requirementAnalysis.sessions.list",
  "orch.requirementAnalysis.sessions.create",
  "orch.requirementAnalysis.sessions.get",
  "orch.requirementAnalysis.sessions.archive",
  "orch.requirementAnalysis.messages.send",
  "orch.requirementAnalysis.createIntakes",
  "orch.proposals.list",
  "orch.chat.get",
  "orch.chat.settings",
  "orch.chat.prepare",
  "orch.chat.action",
  "orch.chat.rework",
  "orch.chat.delete",
  "orch.proposals.get",
  "orch.proposals.create",
  "orch.proposals.confirm",
  "orch.assigneeTemplates.upsert",
  "orch.assigneeTemplates.delete",
  "orch.instances.list",
  "orch.instances.get",
  "orch.instances.runtimePatch",
  "orch.instances.start",
  "orch.instances.pause",
  "orch.instances.resume",
  "orch.instances.cancel",
  "orch.instances.reassignNode",
  "orch.instances.feedback",
  "orch.instances.rerunFromNode",
  "orch.instances.discussionThread.ensure",
  "orch.metrics.collect",
  "orch.nodes.start",
  "orch.nodes.skip",
  "orch.nodes.cancel",
  "orch.artifacts.list",
  "orch.artifacts.get",
  "orch.artifactFiles.list",
  "orch.artifacts.revise",
  "orch.events.list",
  "orch.nodeWorkItems.list",
  "orch.nodeWorkItemEvents.list",
  "orch.runtimeEvidence.get",
  "orch.promptSnapshots.list",
  "orch.promptSnapshots.get",
  "skills.suites",
  "skills.install",
  "skills.uninstall",
  "mcp.install",
  "mcp.enable",
  "mcp.update",
  "mcp.test",
  "mcp.import",
  "mcp.configure",
  "mcp.unconfigure",
  "mcp.uninstall",
] as const;

export type SharedWorkspaceHostRpcMethod = (typeof SHARED_WORKSPACE_HOST_RPC_METHODS)[number];

export type SharedWorkspaceHostRpcPayload = {
  method: SharedWorkspaceHostRpcMethod | string;
  path?: string;
  body?: Record<string, unknown>;
  assetType?: SharedWorkspaceAssetType | string;
  assetId?: string;
  action?: SharedWorkspaceAssetAction | string;
  lockToken?: string;
  lockVersion?: number;
  sharedWorkspaceLockToken?: string;
  sharedWorkspaceLockVersion?: number;
};

const SHARED_WORKSPACE_HOST_RPC_METHOD_SET = new Set<string>(SHARED_WORKSPACE_HOST_RPC_METHODS);

/** Checks whether a shared Host RPC method is allowed to invoke the local Host API. */
export function isSharedWorkspaceHostRpcMethod(value: string): value is SharedWorkspaceHostRpcMethod {
  return SHARED_WORKSPACE_HOST_RPC_METHOD_SET.has(value);
}

/** Builds the shared Host RPC envelope payload while keeping auth/audit metadata top-level. */
export function buildSharedWorkspaceHostRpcPayload(input: {
  method: SharedWorkspaceHostRpcMethod;
  path?: string;
  body?: Record<string, unknown>;
  assetType?: SharedWorkspaceAssetType | string;
  assetId?: string | null;
  action?: SharedWorkspaceAssetAction | string;
}): SharedWorkspaceHostRpcPayload {
  const payload: SharedWorkspaceHostRpcPayload = {
    method: input.method,
    body: input.body ?? {},
  };
  if (input.path) payload.path = input.path;
  if (input.assetType) payload.assetType = input.assetType;
  if (input.assetId) payload.assetId = input.assetId;
  if (input.action) payload.action = input.action;

  const lockToken = readOptionalString(input.body?.lockToken ?? input.body?.sharedWorkspaceLockToken);
  if (lockToken) payload.sharedWorkspaceLockToken = lockToken;
  const lockVersion = readOptionalNonNegativeInteger(input.body?.lockVersion ?? input.body?.sharedWorkspaceLockVersion);
  if (lockVersion !== null) payload.sharedWorkspaceLockVersion = lockVersion;
  return payload;
}

/** Extracts the local Host API body from a shared Host RPC payload. */
export function resolveSharedWorkspaceHostRpcBody(payload: unknown): Record<string, unknown> {
  const record = asSharedWorkspaceRecord(payload);
  const body = record.body;
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

export type SharedWorkspaceAssetEffect =
  | "none"
  | "read"
  | "use"
  | "shared_write_side_effect"
  | "maintain_definition"
  | "private_clone";

export type SharedWorkspaceAssetAuthorizationResult = "allowed" | "denied" | "not_applicable";

export type SharedWorkspaceAssetAuthorizationContext = {
  actorAssetRole: SharedWorkspaceEffectiveAssetRole;
  /** Server 按当前维护策略派生；不能仅按角色判断，成员也可能被授权维护。 */
  canMaintainAssets?: boolean;
  authorizationResult: SharedWorkspaceAssetAuthorizationResult;
  authorizationReason: string;
  assetType: SharedWorkspaceAssetType;
  assetId: string;
  assetAction: SharedWorkspaceAssetAction;
};

export const SHARED_WORKSPACE_ERROR_STATUS = {
  SHARED_WORKSPACE_NOT_FOUND: 404,
  SHARED_WORKSPACE_FORBIDDEN: 403,
  SHARED_WORKSPACE_MEMBER_REQUIRED: 403,
  SHARED_WORKSPACE_ADMIN_REQUIRED: 403,
  SHARED_WORKSPACE_USAGE_BLOCKED: 409,
  SHARED_WORKSPACE_HOST_UNAVAILABLE: 409,
  SHARED_WORKSPACE_ACL_WORKSPACE_MISMATCH: 409,
  SHARED_WORKSPACE_LOCK_REQUIRED: 409,
  SHARED_WORKSPACE_LOCK_CONFLICT: 409,
  SHARED_WORKSPACE_LOCK_STALE: 409,
  SHARED_WORKSPACE_TAKEOVER_NOT_PENDING: 409,
  SHARED_WORKSPACE_OPERATION_UNKNOWN: 400,
  SHARED_WORKSPACE_TOOL_LOCK_REQUIRED: 409,
  SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN: 403,
  SHARED_WORKSPACE_HOST_TIMEOUT: 504,
  SHARED_WORKSPACE_PAYLOAD_REDACTED: 400,
  SHARED_WORKSPACE_ASSET_MAINTENANCE_FORBIDDEN: 403,
  SHARED_WORKSPACE_PRIVATE_CLONE_DISABLED: 403,
} as const;

export type SharedWorkspaceErrorCode = keyof typeof SHARED_WORKSPACE_ERROR_STATUS;

export const SHARED_WORKSPACE_ERROR_CODES = Object.keys(SHARED_WORKSPACE_ERROR_STATUS) as SharedWorkspaceErrorCode[];

export type SharedWorkspaceErrorView = {
  code: SharedWorkspaceErrorCode;
  message: string;
  status: (typeof SHARED_WORKSPACE_ERROR_STATUS)[SharedWorkspaceErrorCode];
  detail?: unknown;
};

export const SHARED_WORKSPACE_OPERATION_KEYS = [
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
] as const;

export type SharedWorkspaceOperationKey = (typeof SHARED_WORKSPACE_OPERATION_KEYS)[number];

export type SharedWorkspaceOperationType =
  | "fs.read"
  | "fs.write"
  | "git.read"
  | "git.write"
  | "terminal.read"
  | "terminal.write"
  | "context.write"
  | "ai.write"
  | "context.read"
  | "orch.read"
  | "orch.write"
  | "orch.use"
  | "skills.read"
  | "skills.write"
  | "toolset.read"
  | "toolset.write"
  | "team.write"
  | "asset.clone";

export type SharedWorkspaceToolPolicyKey = "ai.personal.readonly" | "ai.shared.write";

export type SharedWorkspaceAuditAction =
  | "shared_workspace.fs_read"
  | "shared_workspace.fs_write"
  | "shared_workspace.git_read"
  | "shared_workspace.git_write"
  | "shared_workspace.terminal_read"
  | "shared_workspace.terminal_action"
  | "shared_workspace.context_create"
  | "shared_workspace.context_acl_sync"
  | "shared_workspace.context_thread_group_read"
  | "shared_workspace.context_thread_group_write"
  | "shared_workspace.context_rename"
  | "shared_workspace.context_archive"
  | "shared_workspace.context_pin"
  | "shared_workspace.context_update_prefs"
  | "shared_workspace.context_prefs_read"
  | "shared_workspace.context_latest_prefs"
  | "shared_workspace.context_input_actions_read"
  | "shared_workspace.context_draft_read"
  | "shared_workspace.context_draft_write"
  | "shared_workspace.context_rollback_preview"
  | "shared_workspace.context_rollback"
  | "shared_workspace.context_delete"
  | "shared_workspace.context_message_delete"
  | "shared_workspace.context_clear"
  | "shared_workspace.context_interrupt"
  | "shared_workspace.context_compact"
  | "shared_workspace.context_approval_respond"
  | "shared_workspace.context_user_input_respond"
  | "shared_workspace.context_file_changes_read"
  | "shared_workspace.context_file_changes_write"
  | "shared_workspace.context_managed_services_read"
  | "shared_workspace.context_managed_services_stop"
  | "shared_workspace.context_queue_append"
  | "shared_workspace.context_queue_list"
  | "shared_workspace.context_queue_move"
  | "shared_workspace.context_queue_remove"
  | "shared_workspace.context_queue_clear"
  | "shared_workspace.context_queue_resume"
  | "shared_workspace.context_queue_pause"
  | "shared_workspace.ai_send_personal"
  | "shared_workspace.ai_send"
  | "shared_workspace.ai_tool_denied"
  | "shared_workspace.context_detail_read"
  | "shared_workspace.context_list"
  | "shared_workspace.orch_read"
  | "shared_workspace.orch_write"
  | "shared_workspace.orch_use"
  | "shared_workspace.skills_read"
  | "shared_workspace.skills_write"
  | "shared_workspace.toolset_read"
  | "shared_workspace.toolset_write"
  | "shared_workspace.team_publish"
  | "shared_workspace.asset_maintenance_denied"
  | "shared_workspace.asset_private_clone_denied";

export type SharedWorkspaceHostHandlerId =
  | "fs.tree"
  | "fs.read"
  | "fs.write"
  | "git.status"
  | "git.write"
  | "terminal.read"
  | "terminal.action"
  | "thread.create"
  | "thread.acl.sync"
  | "thread_groups.list"
  | "thread_groups.create"
  | "thread_groups.rename"
  | "thread_groups.delete"
  | "thread.group.assign"
  | "thread.rename"
  | "thread.archive"
  | "thread.pin"
  | "thread.update_prefs"
  | "thread.prefs"
  | "thread.latest_prefs"
  | "thread.input_actions.list"
  | "thread.draft.get"
  | "thread.draft.save"
  | "thread.draft.clear"
  | "thread.rollback.preview"
  | "thread.rollback"
  | "thread.delete"
  | "thread.message.delete"
  | "thread.clear"
  | "thread.interrupt"
  | "thread.compact"
  | "thread.approval.respond"
  | "thread.user_input.respond"
  | "thread.file_changes.list"
  | "thread.file_changes.diff"
  | "thread.file_changes.accept"
  | "thread.file_changes.undo"
  | "thread.managed_services.list"
  | "thread.managed_services.stop"
  | "thread.queue.append"
  | "thread.queue.list"
  | "thread.queue.move"
  | "thread.queue.remove"
  | "thread.queue.clear"
  | "thread.queue.resume"
  | "thread.queue.pause"
  | "thread.send"
  | "context.detail.read"
  | "context.list"
  | "orch.read"
  | "orch.write"
  | "orch.use"
  | "skills.read"
  | "skills.manage"
  | "toolset.read"
  | "toolset.manage"
  | "team.publish"
  | "asset.clone_to_private";

export type SharedWorkspaceOperationPolicy<K extends SharedWorkspaceOperationKey = SharedWorkspaceOperationKey> = {
  operationKey: K;
  operationType: SharedWorkspaceOperationType;
  lockRequired: boolean;
  effectiveLockRequired: boolean;
  usageRequired: boolean;
  auditAction: SharedWorkspaceAuditAction;
  handlerId: SharedWorkspaceHostHandlerId;
  toolPolicyKey: SharedWorkspaceToolPolicyKey | null;
  assetEffect: SharedWorkspaceAssetEffect;
  maintenanceDefinitionRequired: boolean;
  cloneToPrivateDisabled: boolean;
};

export const SHARED_WORKSPACE_OPERATION_POLICIES = {
  "workspace.fs.tree": {
    operationKey: "workspace.fs.tree",
    operationType: "fs.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.fs_read",
    handlerId: "fs.tree",
    toolPolicyKey: null,
    assetEffect: "none",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "workspace.fs.read": {
    operationKey: "workspace.fs.read",
    operationType: "fs.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.fs_read",
    handlerId: "fs.read",
    toolPolicyKey: null,
    assetEffect: "none",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "workspace.fs.write": {
    operationKey: "workspace.fs.write",
    operationType: "fs.write",
    lockRequired: true,
    effectiveLockRequired: true,
    usageRequired: false,
    auditAction: "shared_workspace.fs_write",
    handlerId: "fs.write",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "workspace.git.status": {
    operationKey: "workspace.git.status",
    operationType: "git.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.git_read",
    handlerId: "git.status",
    toolPolicyKey: null,
    assetEffect: "none",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "workspace.git.write": {
    operationKey: "workspace.git.write",
    operationType: "git.write",
    lockRequired: true,
    effectiveLockRequired: true,
    usageRequired: false,
    auditAction: "shared_workspace.git_write",
    handlerId: "git.write",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "terminal.session.read": {
    operationKey: "terminal.session.read",
    operationType: "terminal.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.terminal_read",
    handlerId: "terminal.read",
    toolPolicyKey: null,
    assetEffect: "none",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "terminal.action": {
    operationKey: "terminal.action",
    operationType: "terminal.write",
    lockRequired: true,
    effectiveLockRequired: true,
    usageRequired: false,
    auditAction: "shared_workspace.terminal_action",
    handlerId: "terminal.action",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.create": {
    operationKey: "context.thread.create",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_create",
    handlerId: "thread.create",
    toolPolicyKey: null,
    assetEffect: "use",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.acl.sync": {
    operationKey: "context.thread.acl.sync",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_acl_sync",
    handlerId: "thread.acl.sync",
    toolPolicyKey: null,
    assetEffect: "none",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread_groups.list": {
    operationKey: "context.thread_groups.list",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_thread_group_read",
    handlerId: "thread_groups.list",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread_groups.create": {
    operationKey: "context.thread_groups.create",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_thread_group_write",
    handlerId: "thread_groups.create",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread_groups.rename": {
    operationKey: "context.thread_groups.rename",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_thread_group_write",
    handlerId: "thread_groups.rename",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread_groups.delete": {
    operationKey: "context.thread_groups.delete",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_thread_group_write",
    handlerId: "thread_groups.delete",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.group.assign": {
    operationKey: "context.thread.group.assign",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_thread_group_write",
    handlerId: "thread.group.assign",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.rename": {
    operationKey: "context.thread.rename",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_rename",
    handlerId: "thread.rename",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.archive": {
    operationKey: "context.thread.archive",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_archive",
    handlerId: "thread.archive",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.pin": {
    operationKey: "context.thread.pin",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_pin",
    handlerId: "thread.pin",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.update_prefs": {
    operationKey: "context.thread.update_prefs",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_update_prefs",
    handlerId: "thread.update_prefs",
    toolPolicyKey: null,
    assetEffect: "use",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.prefs": {
    operationKey: "context.thread.prefs",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_prefs_read",
    handlerId: "thread.prefs",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.latest_prefs": {
    operationKey: "context.thread.latest_prefs",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_latest_prefs",
    handlerId: "thread.latest_prefs",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.input_actions.list": {
    operationKey: "context.thread.input_actions.list",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_input_actions_read",
    handlerId: "thread.input_actions.list",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.draft.get": {
    operationKey: "context.thread.draft.get",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_draft_read",
    handlerId: "thread.draft.get",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.draft.save": {
    operationKey: "context.thread.draft.save",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_draft_write",
    handlerId: "thread.draft.save",
    toolPolicyKey: null,
    assetEffect: "use",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.draft.clear": {
    operationKey: "context.thread.draft.clear",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_draft_write",
    handlerId: "thread.draft.clear",
    toolPolicyKey: null,
    assetEffect: "use",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.rollback.preview": {
    operationKey: "context.thread.rollback.preview",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_rollback_preview",
    handlerId: "thread.rollback.preview",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.rollback": {
    operationKey: "context.thread.rollback",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_rollback",
    handlerId: "thread.rollback",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.message.delete": {
    operationKey: "context.thread.message.delete",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_message_delete",
    handlerId: "thread.message.delete",
    toolPolicyKey: null,
    assetEffect: "use",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.delete": {
    operationKey: "context.thread.delete",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_delete",
    handlerId: "thread.delete",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.clear": {
    operationKey: "context.thread.clear",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_clear",
    handlerId: "thread.clear",
    toolPolicyKey: null,
    assetEffect: "use",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.interrupt": {
    operationKey: "context.thread.interrupt",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_interrupt",
    handlerId: "thread.interrupt",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.compact": {
    operationKey: "context.thread.compact",
    operationType: "ai.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: true,
    auditAction: "shared_workspace.context_compact",
    handlerId: "thread.compact",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.approval.respond": {
    operationKey: "context.thread.approval.respond",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_approval_respond",
    handlerId: "thread.approval.respond",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.user_input.respond": {
    operationKey: "context.thread.user_input.respond",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_user_input_respond",
    handlerId: "thread.user_input.respond",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.file_changes.list": {
    operationKey: "context.thread.file_changes.list",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_file_changes_read",
    handlerId: "thread.file_changes.list",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.file_changes.diff": {
    operationKey: "context.thread.file_changes.diff",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_file_changes_read",
    handlerId: "thread.file_changes.diff",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.file_changes.accept": {
    operationKey: "context.thread.file_changes.accept",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_file_changes_write",
    handlerId: "thread.file_changes.accept",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.file_changes.undo": {
    operationKey: "context.thread.file_changes.undo",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_file_changes_write",
    handlerId: "thread.file_changes.undo",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.managed_services.list": {
    operationKey: "context.thread.managed_services.list",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_managed_services_read",
    handlerId: "thread.managed_services.list",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.managed_services.stop": {
    operationKey: "context.thread.managed_services.stop",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_managed_services_stop",
    handlerId: "thread.managed_services.stop",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.queue.append": {
    operationKey: "context.thread.queue.append",
    operationType: "ai.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: true,
    auditAction: "shared_workspace.context_queue_append",
    handlerId: "thread.queue.append",
    toolPolicyKey: "ai.shared.write",
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.queue.list": {
    operationKey: "context.thread.queue.list",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_queue_list",
    handlerId: "thread.queue.list",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.queue.move": {
    operationKey: "context.thread.queue.move",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_queue_move",
    handlerId: "thread.queue.move",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.queue.remove": {
    operationKey: "context.thread.queue.remove",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_queue_remove",
    handlerId: "thread.queue.remove",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.queue.clear": {
    operationKey: "context.thread.queue.clear",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_queue_clear",
    handlerId: "thread.queue.clear",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.queue.resume": {
    operationKey: "context.thread.queue.resume",
    operationType: "ai.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: true,
    auditAction: "shared_workspace.context_queue_resume",
    handlerId: "thread.queue.resume",
    toolPolicyKey: "ai.shared.write",
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.thread.queue.pause": {
    operationKey: "context.thread.queue.pause",
    operationType: "context.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_queue_pause",
    handlerId: "thread.queue.pause",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "ai.thread.send.personal": {
    operationKey: "ai.thread.send.personal",
    operationType: "ai.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: true,
    auditAction: "shared_workspace.ai_send_personal",
    handlerId: "thread.send",
    toolPolicyKey: "ai.personal.readonly",
    assetEffect: "use",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "ai.thread.send.shared": {
    operationKey: "ai.thread.send.shared",
    operationType: "ai.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: true,
    auditAction: "shared_workspace.ai_send",
    handlerId: "thread.send",
    toolPolicyKey: "ai.shared.write",
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.detail.read": {
    operationKey: "context.detail.read",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_detail_read",
    handlerId: "context.detail.read",
    toolPolicyKey: null,
    assetEffect: "none",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "context.list": {
    operationKey: "context.list",
    operationType: "context.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.context_list",
    handlerId: "context.list",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "orch.asset.read": {
    operationKey: "orch.asset.read",
    operationType: "orch.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.orch_read",
    handlerId: "orch.read",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "orch.asset.write": {
    operationKey: "orch.asset.write",
    operationType: "orch.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: true,
    auditAction: "shared_workspace.orch_write",
    handlerId: "orch.write",
    toolPolicyKey: null,
    assetEffect: "maintain_definition",
    maintenanceDefinitionRequired: true,
    cloneToPrivateDisabled: false,
  },
  "orch.workflow.use": {
    operationKey: "orch.workflow.use",
    operationType: "orch.use",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: true,
    auditAction: "shared_workspace.orch_use",
    handlerId: "orch.use",
    toolPolicyKey: null,
    assetEffect: "use",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "skills.read": {
    operationKey: "skills.read",
    operationType: "skills.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.skills_read",
    handlerId: "skills.read",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "skills.manage": {
    operationKey: "skills.manage",
    operationType: "skills.write",
    lockRequired: true,
    effectiveLockRequired: true,
    usageRequired: true,
    auditAction: "shared_workspace.skills_write",
    handlerId: "skills.manage",
    toolPolicyKey: null,
    assetEffect: "maintain_definition",
    maintenanceDefinitionRequired: true,
    cloneToPrivateDisabled: false,
  },
  "toolset.read": {
    operationKey: "toolset.read",
    operationType: "toolset.read",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.toolset_read",
    handlerId: "toolset.read",
    toolPolicyKey: null,
    assetEffect: "read",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "toolset.manage": {
    operationKey: "toolset.manage",
    operationType: "toolset.write",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: true,
    auditAction: "shared_workspace.toolset_write",
    handlerId: "toolset.manage",
    toolPolicyKey: null,
    assetEffect: "maintain_definition",
    maintenanceDefinitionRequired: true,
    cloneToPrivateDisabled: false,
  },
  "team.publish": {
    operationKey: "team.publish",
    operationType: "team.write",
    lockRequired: true,
    effectiveLockRequired: true,
    usageRequired: true,
    auditAction: "shared_workspace.team_publish",
    handlerId: "team.publish",
    toolPolicyKey: null,
    assetEffect: "shared_write_side_effect",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: false,
  },
  "asset.clone_to_private": {
    operationKey: "asset.clone_to_private",
    operationType: "asset.clone",
    lockRequired: false,
    effectiveLockRequired: false,
    usageRequired: false,
    auditAction: "shared_workspace.asset_private_clone_denied",
    handlerId: "asset.clone_to_private",
    toolPolicyKey: null,
    assetEffect: "private_clone",
    maintenanceDefinitionRequired: false,
    cloneToPrivateDisabled: true,
  },
} as const satisfies { readonly [K in SharedWorkspaceOperationKey]: SharedWorkspaceOperationPolicy<K> };

export const SHARED_WORKSPACE_OPERATION_POLICY_LIST = Object.values(SHARED_WORKSPACE_OPERATION_POLICIES);

export const SHARED_WORKSPACE_COMMAND_SERVER_RESOLVED_POLICY_FIELDS = [
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
] as const;

export type SharedWorkspaceCommandServerResolvedPolicyField =
  (typeof SHARED_WORKSPACE_COMMAND_SERVER_RESOLVED_POLICY_FIELDS)[number];

export function isSharedWorkspaceOperationKey(value: string): value is SharedWorkspaceOperationKey {
  return Object.prototype.hasOwnProperty.call(SHARED_WORKSPACE_OPERATION_POLICIES, value);
}

export function getSharedWorkspaceOperationPolicy(operationKey: string): SharedWorkspaceOperationPolicy | null {
  return isSharedWorkspaceOperationKey(operationKey) ? SHARED_WORKSPACE_OPERATION_POLICIES[operationKey] : null;
}

const TRANSIENT_SHARED_WORKSPACE_WORKFLOW_USE_METHODS = new Set([
  "orch.chat.get",
  "orch.intakes.list",
  "orch.pendingMine.list",
  "orch.requirementAnalysis.sessions.list",
  "orch.requirementAnalysis.sessions.get",
  "orch.proposals.list",
  "orch.proposals.get",
  "orch.instances.list",
  "orch.instances.get",
  "orch.instances.runtimePatch",
  "orch.artifacts.list",
  "orch.artifacts.get",
  "orch.artifactFiles.list",
  "orch.events.list",
  "orch.nodeWorkItems.list",
  "orch.nodeWorkItemEvents.list",
  "orch.runtimeEvidence.get",
  "orch.promptSnapshots.list",
  "orch.promptSnapshots.get",
  "orch.metrics.collect",
]);

const TRANSIENT_SHARED_WORKSPACE_WORKFLOW_USE_ACTIONS = new Set([
  "list",
  "get",
  "read",
  "requirement_analysis_sessions_list",
  "requirement_analysis_session_get",
  "runtime_patch",
]);

// Asset bundle import may create the workspace codeflowai config while resolving placeholders.
const LOCKED_SHARED_WORKSPACE_ASSET_WRITE_METHODS = new Set([
  "orch.assetBundles.import",
]);

const UNLOCKED_SHARED_WORKSPACE_SKILL_DEFINITION_METHODS = new Set([
  "orch.skills.upsert",
  "orch.skills.delete",
]);

/** Detects workflow-use payloads that are read/runtime polling and must not consume usage quota. */
export function isTransientSharedWorkspaceWorkflowUsePayload(payload: unknown): boolean {
  const record = asSharedWorkspaceRecord(payload);
  const method = String(record.method ?? "").trim();
  if (TRANSIENT_SHARED_WORKSPACE_WORKFLOW_USE_METHODS.has(method)) return true;
  const action = String(record.action ?? "").trim();
  return TRANSIENT_SHARED_WORKSPACE_WORKFLOW_USE_ACTIONS.has(action);
}

/** Derives the effective operation policy for one command payload without changing the static contract. */
export function resolveSharedWorkspaceEffectiveOperationPolicy(
  operationKey: string,
  payload: unknown,
): SharedWorkspaceOperationPolicy | null {
  const policy = getSharedWorkspaceOperationPolicy(operationKey);
  if (!policy) return null;
  if (policy.operationKey === "orch.workflow.use" && isTransientSharedWorkspaceWorkflowUsePayload(payload)) {
    return { ...policy, usageRequired: false };
  }
  const workflowPayload = asSharedWorkspaceRecord(payload);
  if (policy.operationKey === "orch.workflow.use" && workflowPayload.method === "orch.chat.action"
    && asSharedWorkspaceRecord(workflowPayload.body).action === "dismiss") {
    // 拒绝工作流会把任务交回普通会话，执行策略与已鉴权的队列追加保持一致。
    const queuePolicy = SHARED_WORKSPACE_OPERATION_POLICIES["context.thread.queue.append"];
    return { ...policy, operationType: queuePolicy.operationType, toolPolicyKey: queuePolicy.toolPolicyKey, assetEffect: queuePolicy.assetEffect };
  }
  if (policy.operationKey === "orch.asset.write") {
    const method = String(asSharedWorkspaceRecord(payload).method ?? "").trim();
    return {
      ...policy,
      effectiveLockRequired: LOCKED_SHARED_WORKSPACE_ASSET_WRITE_METHODS.has(method),
    };
  }
  if (policy.operationKey === "skills.manage") {
    const method = String(asSharedWorkspaceRecord(payload).method ?? "").trim();
    if (UNLOCKED_SHARED_WORKSPACE_SKILL_DEFINITION_METHODS.has(method)) {
      return { ...policy, effectiveLockRequired: false };
    }
  }
  return policy;
}

export function resolveSharedWorkspaceAssetMetadata(
  operationKey: SharedWorkspaceOperationKey,
  payload: unknown,
): Pick<SharedWorkspaceAssetAuthorizationContext, "assetType" | "assetId" | "assetAction"> {
  const record = asSharedWorkspaceRecord(payload);
  const action = normalizeSharedWorkspaceAssetAction(record.action ?? record.method ?? record.operation);
  if (operationKey === "orch.asset.read") {
    return { assetType: normalizeSharedWorkspaceAssetType(record.assetType ?? record.resourceType ?? record.kind), assetId: readAssetId(record), assetAction: "read" };
  }
  if (operationKey === "orch.asset.write") {
    return { assetType: normalizeSharedWorkspaceAssetType(record.assetType ?? record.resourceType ?? record.kind ?? readNested(record, "asset", "type")), assetId: readAssetId(record), assetAction: action };
  }
  if (operationKey === "orch.workflow.use") {
    return { assetType: "workflow", assetId: readAssetId(record), assetAction: "use" };
  }
  if (operationKey === "skills.read") {
    return { assetType: "skill", assetId: readAssetId(record), assetAction: "read" };
  }
  if (operationKey === "skills.manage") {
    return { assetType: "skill", assetId: readAssetId(record), assetAction: normalizeSharedWorkspaceAssetAction(record.action ?? "install") };
  }
  if (operationKey === "toolset.read") {
    return { assetType: "toolset", assetId: readAssetId(record), assetAction: "read" };
  }
  if (operationKey === "toolset.manage") {
    return { assetType: "toolset", assetId: readAssetId(record), assetAction: normalizeSharedWorkspaceAssetAction(record.action ?? "update") };
  }
  if (operationKey === "team.publish") {
    return { assetType: normalizeSharedWorkspaceAssetType(record.resourceType ?? record.assetType ?? "team_view"), assetId: readAssetId(record), assetAction: "publish" };
  }
  if (operationKey === "asset.clone_to_private") {
    return { assetType: normalizeSharedWorkspaceAssetType(record.assetType ?? record.resourceType ?? record.kind), assetId: readAssetId(record), assetAction: "clone_to_private" };
  }
  if (operationKey === "context.list") {
    return { assetType: "team_view", assetId: readAssetId(record), assetAction: "read" };
  }
  if (operationKey === "context.thread.create") {
    return { assetType: "team_view", assetId: readAssetId(record), assetAction: "create" };
  }
  if (operationKey === "context.thread.delete") {
    return { assetType: "team_view", assetId: readOptionalString(record.threadId) ?? "", assetAction: "delete" };
  }
  if (operationKey.startsWith("context.thread.queue.")) {
    return { assetType: "team_view", assetId: readAssetId(record), assetAction: action === "read" ? "read" : "use" };
  }
  if (operationKey === "ai.thread.send.personal" || operationKey === "ai.thread.send.shared") {
    return { assetType: "unknown", assetId: readAssetId(record), assetAction: "use" };
  }
  return { assetType: "unknown", assetId: readAssetId(record), assetAction: action === "read" ? "read" : "use" };
}

export function normalizeSharedWorkspaceAssetType(value: unknown): SharedWorkspaceAssetType {
  const raw = String(value ?? "").trim();
  const normalized = raw.replace(/[-\s]/g, "_").toLowerCase();
  if (normalized === "workflow" || normalized === "workflows") return "workflow";
  if (normalized === "role" || normalized === "roles" || normalized === "agent" || normalized === "agents") return "agent";
  if (
    normalized === "knowledgebundle"
    || normalized === "knowledgebundles"
    || normalized === "knowledge_bundle"
    || normalized === "knowledge_bundles"
    || normalized === "knowledge"
    || normalized === "knowledge_base"
  ) return "knowledge_bundle";
  if (normalized === "skill" || normalized === "skills" || normalized === "suite" || normalized === "suites") return "skill";
  if (normalized === "toolset" || normalized === "toolsets" || normalized === "tool_set") return "toolset";
  if (normalized === "document" || normalized === "thread" || normalized === "artifact" || normalized === "team_view") return "team_view";
  return "unknown";
}

export function normalizeSharedWorkspaceAssetAction(value: unknown): SharedWorkspaceAssetAction {
  const normalized = String(value ?? "").trim().replace(/[-\s]/g, "_").toLowerCase();
  if (normalized === "read" || normalized === "list" || normalized === "get") return "read";
  if (normalized === "use" || normalized === "run" || normalized === "execute" || normalized === "start" || normalized === "confirm" || normalized === "feedback" || normalized === "pause" || normalized === "resume" || normalized === "cancel" || normalized === "rerun") return "use";
  if (normalized === "create" || normalized === "add" || normalized === "new") return "create";
  if (normalized === "delete" || normalized === "remove" || normalized === "unpublish" || normalized === "disable" || normalized === "down") return "delete";
  if (normalized === "import") return "import";
  if (normalized === "install" || normalized === "mcp_install") return "install";
  if (normalized === "uninstall" || normalized === "mcp_uninstall") return "uninstall";
  if (normalized === "test" || normalized === "check" || normalized === "verify") return "use";
  if (normalized === "mcp_test") return "use";
  if (normalized === "mcp_import") return "import";
  if (normalized === "mcp_enable" || normalized === "mcp_update" || normalized === "mcp_configure" || normalized === "mcp_unconfigure") return "update";
  if (normalized === "publish" || normalized === "release") return "publish";
  if (normalized === "clone_to_private" || normalized === "clone" || normalized === "copy_to_private") return "clone_to_private";
  return "update";
}

function asSharedWorkspaceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Reads an optional string metadata field from the RPC body. */
function readOptionalString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** Reads an optional non-negative integer metadata field from the RPC body. */
function readOptionalNonNegativeInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

function readNested(record: Record<string, unknown>, key: string, childKey: string): unknown {
  const child = record[key];
  if (!child || typeof child !== "object" || Array.isArray(child)) return undefined;
  return (child as Record<string, unknown>)[childKey];
}

function readAssetId(record: Record<string, unknown>): string {
  for (const key of [
    "workflowId",
    "proposalId",
    "instanceId",
    "roleId",
    "agentId",
    "bundleId",
    "knowledgeBundleId",
    "knowledgeId",
    "skillId",
    "suiteId",
    "packageName",
    "toolsetId",
    "resourceId",
    "assetId",
    "id",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of ["asset", "workflow", "role", "agent", "bundle", "toolset"]) {
    const value = readNested(record, key, "id");
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export type SharedWorkspaceDetail = {
  id: SharedWorkspaceId;
  enterpriseId: string;
  name: string;
  description: string;
  createdByUserId: string;
  workspaceAdminUserId: string;
  lifecycleStatus: SharedWorkspaceLifecycleStatus;
  hostStatus: SharedWorkspaceHostStatus;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  fileTransferPolicy?: SharedWorkspaceFileTransferPolicy | null;
  assetMaintenancePolicy?: SharedWorkspaceAssetMaintenancePolicy | null;
  hostMaintenance?: WorkspaceDirectoryMigrationHostMaintenance | null;
};

export type SharedWorkspaceListItem = SharedWorkspaceDetail & {
  workspaceAdminName?: string | null;
  workspaceAdminEmail?: string | null;
  host?: SharedWorkspaceHostBindingPublicView | null;
  currentUserRole?: SharedWorkspaceMemberRole | "enterprise_admin" | "creator" | null;
  assetPermissions?: SharedWorkspaceAssetPermissions | null;
  workspaceDirectEntryId?: string;
};

export type SharedWorkspaceMemberItem = {
  id: SharedWorkspaceMemberId;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  userId: string;
  displayName: string;
  email: string;
  role: SharedWorkspaceMemberRole;
  status: SharedWorkspaceMemberStatus;
  joinedByUserId: string;
  joinedAt: number;
  leftAt?: number | null;
  createdAt: number;
  updatedAt: number;
  /** 仅用于展示当前企业用量资格，不改变共享成员关系状态。 */
  usageEligibility?: SharedWorkspaceUsageEligibilitySnapshot | null;
};

export type SharedWorkspaceInviteItem = {
  id: SharedWorkspaceInviteId;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  inviteeUserId: string;
  inviterUserId: string;
  status: SharedWorkspaceInviteStatus;
  usageFilterResult?: SharedWorkspaceUsageEligibilitySnapshot | null;
  memberId?: SharedWorkspaceMemberId | null;
  createdAt: number;
  effectiveAt: number;
  revokedAt?: number | null;
};

export type SharedWorkspaceUsageEligibilityReason =
  | "already_member"
  | "not_enterprise_member"
  | "enterprise_member_inactive"
  | "account_disabled"
  | "api_key_missing"
  | "enterprise_unavailable"
  | "usage_unknown";

export type SharedWorkspaceUsageEligibilitySnapshot = {
  eligible: boolean;
  reasons: SharedWorkspaceUsageEligibilityReason[];
  checkedAt: number;
};

export type SharedWorkspaceInviteCandidate = {
  userId: string;
  displayName: string;
  email: string;
  eligible: boolean;
  disabledReason?: SharedWorkspaceUsageEligibilityReason | null;
  usageEligibility: SharedWorkspaceUsageEligibilitySnapshot;
};

export type SharedWorkspaceHostCapabilitySnapshot = {
  fs?: boolean;
  git?: boolean;
  terminal?: boolean;
  ai?: boolean;
  orchestration?: boolean;
  skills?: boolean;
  toolsets?: boolean;
  sharedThreadAclLocal?: boolean;
  sharedOrchestrationResourceAclLocal?: boolean;
  capturedAt: number;
};

export type SharedWorkspaceHostBindingInternalView = {
  id: SharedWorkspaceHostBindingId;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  hostUserId: string;
  hostClientId: ClientId;
  hostKeyHash: KeyHash;
  localWorkspaceId: WorkspaceId;
  localWorkspaceLabel: string;
  localWorkspacePathHint: string;
  capabilitySnapshot?: SharedWorkspaceHostCapabilitySnapshot | null;
  status: Exclude<SharedWorkspaceHostStatus, "unbound">;
  lastSeenAt: number | null;
  heartbeatExpiresAt: number | null;
  boundAt: number;
  updatedAt: number;
};

export type SharedWorkspaceHostBindingPublicView = Omit<
  SharedWorkspaceHostBindingInternalView,
  "hostKeyHash" | "localWorkspacePathHint"
> & {
  hostKeyHash?: never;
  localWorkspacePathHint?: never;
};

export function toSharedWorkspacePublicHostView(
  binding: SharedWorkspaceHostBindingInternalView,
): SharedWorkspaceHostBindingPublicView {
  const { hostKeyHash: _hostKeyHash, localWorkspacePathHint: _localWorkspacePathHint, ...publicView } = binding;
  return publicView;
}

export type SharedWorkspaceRemoteSessionView = {
  id: SharedWorkspaceRemoteSessionId;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  userId: string;
  webSessionId: WebSessionId;
  status: "active" | "closed";
  enteredAt: number;
  lastActiveAt: number;
  closedAt?: number | null;
};

export type SharedWorkspaceContextResourceType = "thread" | "requirement" | "artifact" | "team_view" | "document" | "workflow_run";
export type SharedWorkspaceContextVisibility = "private" | "participants" | "team";
export type SharedWorkspaceContextRelatedReason = "owner" | "participant" | "todo" | "mention" | "trigger";

export type SharedWorkspaceMemberContext = {
  id: SharedWorkspaceContextId;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  hostWorkspaceId: WorkspaceId;
  resourceType: SharedWorkspaceContextResourceType;
  resourceId: string;
  ownerUserId: string;
  visibility: SharedWorkspaceContextVisibility;
  participantUserIds: string[];
  titleSummary: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number | null;
};

export type SharedWorkspaceWriteLockView = {
  id: SharedWorkspaceWriteLockId;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  holderUserId: string | null;
  holderRemoteSessionId: SharedWorkspaceRemoteSessionId | null;
  holderLabel?: string | null;
  status: SharedWorkspaceLockStatus;
  version: number;
  acquiredAt: number | null;
  expiresAt: number | null;
  updatedAt: number;
};

export type SharedWorkspaceTakeoverRequestView = {
  id: SharedWorkspaceTakeoverRequestId;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  requesterUserId: string;
  requesterRemoteSessionId: SharedWorkspaceRemoteSessionId;
  currentHolderUserId: string | null;
  status: SharedWorkspaceTakeoverStatus;
  requestedAt: number;
  deadlineAt: number;
  respondedAt: number | null;
  responseReason: string;
};

export type SharedWorkspaceRouteEventView = {
  id: SharedWorkspaceRouteEventId;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  actorUserId: string;
  actorRemoteSessionId: SharedWorkspaceRemoteSessionId | null;
  hostBindingId: SharedWorkspaceHostBindingId | null;
  operationId: SharedWorkspaceOperationId;
  policyKey: SharedWorkspaceOperationKey;
  toolPolicyKey: SharedWorkspaceToolPolicyKey | null;
  operationType: SharedWorkspaceOperationType;
  lockRequired: boolean;
  effectiveLockRequired: boolean;
  usageRequired: boolean;
  auditAction: SharedWorkspaceAuditAction;
  handlerId: SharedWorkspaceHostHandlerId;
  upgradedFromOperationId: SharedWorkspaceOperationId | null;
  lockVersion: number | null;
  assetType: SharedWorkspaceAssetType;
  assetId: string;
  assetAction: SharedWorkspaceAssetAction;
  actorAssetRole: SharedWorkspaceEffectiveAssetRole;
  authorizationResult: SharedWorkspaceAssetAuthorizationResult;
  authorizationReason: string;
  status: SharedWorkspaceRouteStatus;
  payloadSummary?: Record<string, unknown> | null;
  errorCode?: SharedWorkspaceErrorCode | string | null;
  errorMessage?: string | null;
  createdAt: number;
  routedAt?: number | null;
  completedAt?: number | null;
  updatedAt: number;
};

export type CreateSharedWorkspaceRequestBody = {
  enterpriseId?: string;
  name: string;
  description?: string;
  workspaceAdminUserId: string;
};

export type CreateSharedWorkspaceResponseBody = {
  sharedWorkspace: SharedWorkspaceDetail;
};

export type UpdateSharedWorkspaceRequestBody = {
  name: string;
};

export type UpdateSharedWorkspaceResponseBody = {
  sharedWorkspace: SharedWorkspaceDetail;
};

export type ListSharedWorkspacesRequestQuery = {
  keyword?: string;
  hostStatus?: SharedWorkspaceHostStatus;
  workspaceAdminUserId?: string;
  view?: "admin" | "my" | "member";
  offset?: number;
  limit?: number;
};

export type SharedWorkspaceListResponseBody = {
  items: SharedWorkspaceListItem[];
  total: number;
};

export type DeleteSharedWorkspaceResponseBody = {
  ok: true;
  message: string;
};

export type BindSharedWorkspaceHostRequestBody = {
  hostClientId: ClientId;
  localWorkspaceId: WorkspaceId;
  localWorkspaceLabel?: string;
};

export type BindSharedWorkspaceHostResponseBody = {
  bindingId: SharedWorkspaceHostBindingId;
  status: Exclude<SharedWorkspaceHostStatus, "unbound">;
  expiresAt: number;
};

export type UnbindSharedWorkspaceHostResponseBody = {
  ok: true;
  message: string;
  sharedWorkspace: SharedWorkspaceDetail;
};

export type SharedWorkspaceMembersResponseBody = {
  members: SharedWorkspaceMemberItem[];
  currentUserRole: SharedWorkspaceMemberRole | "enterprise_admin" | "creator" | null;
};

export type SharedWorkspaceInviteCandidatesResponseBody = {
  available: SharedWorkspaceInviteCandidate[];
  unavailable: SharedWorkspaceInviteCandidate[];
};

export type InviteSharedWorkspaceMembersRequestBody = {
  userIds: string[];
};

export type InviteSharedWorkspaceMembersResponseBody = {
  invited: SharedWorkspaceMemberItem[];
  skipped: SharedWorkspaceInviteCandidate[];
};

export type LeaveSharedWorkspaceResponseBody = {
  ok: true;
};

export type RemoveSharedWorkspaceMemberResponseBody = {
  ok: true;
  member: SharedWorkspaceMemberItem;
};

export type SharedWorkspaceRemoteBootstrap = {
  sharedWorkspace: SharedWorkspaceDetail;
  membership: SharedWorkspaceMemberItem | null;
  host: SharedWorkspaceHostBindingPublicView | null;
  assetPermissions: SharedWorkspaceAssetPermissions;
  accessMode: "member_remote_use" | "asset_admin";
  writeLock: SharedWorkspaceWriteLockView | null;
  visibilityPolicy: {
    defaultVisibility: SharedWorkspaceContextVisibility;
    canPublishToTeam: boolean;
  };
  adminReadScope: {
    canReadAllContexts: boolean;
    reason: "enterprise_admin" | "workspace_admin" | "creator" | null;
  };
  subscriptionTopic: SharedWorkspaceSubscriptionTopic;
};

export type SharedWorkspaceContextDetailResponseBody = {
  context: SharedWorkspaceMemberContext;
  detail: unknown;
  readOnly: true;
};

export type SharedWorkspaceContextListQuery = {
  resourceType?: SharedWorkspaceContextResourceType;
  onlyRelatedToMe?: boolean;
  visibility?: SharedWorkspaceContextVisibility;
  offset?: number;
  limit?: number;
};

export type SharedWorkspaceContextListItem = SharedWorkspaceMemberContext & {
  relatedToMe: boolean;
  relatedReasons: SharedWorkspaceContextRelatedReason[];
  readOnly: boolean;
};

export type SharedThreadAclSyncItem = {
  sharedWorkspaceId: SharedWorkspaceId;
  threadId: ThreadId;
  ownerUserId: string;
  visibility: SharedWorkspaceContextVisibility;
  participantUserIds: string[];
  updatedAt: number;
};

export type SharedWorkspaceContextListResponseBody = {
  items: SharedWorkspaceContextListItem[];
  total: number;
};

export type SharedWorkspaceCommandRequest = {
  operationId: SharedWorkspaceOperationId;
  operationKey: SharedWorkspaceOperationKey;
  lockToken?: string | null;
  lockVersion?: number | null;
  allowSharedUpgrade?: boolean;
  payload: unknown;
};

export type SharedWorkspaceCloneToPrivateRequestBody = {
  assetType: SharedWorkspaceAssetType | string;
  assetId: string;
};

export type SharedWorkspaceResolvedOperationPolicy = SharedWorkspaceOperationPolicy & {
  effectiveLockRequired: boolean;
  upgradedFromOperationId?: SharedWorkspaceOperationId | null;
};

export type SharedWorkspaceCommandEnvelope = {
  sharedWorkspaceId: SharedWorkspaceId;
  actorUserId: string;
  /** Server 从可信 Host binding 派生；缺失时 Host 不授予所有者文件访问权限。 */
  hostUserId?: string;
  actorRemoteSessionId: SharedWorkspaceRemoteSessionId | null;
  hostBindingId: SharedWorkspaceHostBindingId;
  routeEventId?: SharedWorkspaceRouteEventId | null;
  localWorkspaceId: WorkspaceId;
  operationId: SharedWorkspaceOperationId;
  operationKey: SharedWorkspaceOperationKey;
  policy: SharedWorkspaceResolvedOperationPolicy;
  authorization: SharedWorkspaceAssetAuthorizationContext;
  lockToken?: string | null;
  lockVersion?: number | null;
  allowSharedUpgrade?: boolean;
  payload: unknown;
  createdAt: number;
};

export type SharedWorkspaceCommandResponse = {
  operationId: SharedWorkspaceOperationId;
  routeEventId?: SharedWorkspaceRouteEventId | null;
  status: Extract<SharedWorkspaceRouteStatus, "succeeded" | "failed" | "cancelled">;
  result?: unknown;
  error?: SharedWorkspaceErrorView | null;
};

export type SharedWorkspaceHostRegisterMessage = {
  sharedWorkspaceId: SharedWorkspaceId;
  bindingId: SharedWorkspaceHostBindingId;
  localWorkspaceId: WorkspaceId;
  capabilitySnapshot?: SharedWorkspaceHostCapabilitySnapshot | null;
  registeredAt?: number;
};

export type SharedWorkspaceHostHeartbeatMessage = {
  sharedWorkspaceId: SharedWorkspaceId;
  bindingId: SharedWorkspaceHostBindingId;
  localWorkspaceId: WorkspaceId;
  capabilitySnapshot?: SharedWorkspaceHostCapabilitySnapshot | null;
  sentAt?: number;
};

export type SharedWorkspaceHostRegisterAck = {
  sharedWorkspaceId: SharedWorkspaceId;
  bindingId: SharedWorkspaceHostBindingId;
  status: Exclude<SharedWorkspaceHostStatus, "unbound">;
  heartbeatExpiresAt: number;
  serverNow: number;
};

export type SharedWorkspaceHostRouteAckMessage = {
  routeEventId: SharedWorkspaceRouteEventId;
  operationId: SharedWorkspaceOperationId;
  ackAt: number;
  progressSummary?: Record<string, unknown> | null;
};

export type SharedWorkspaceHostRouteResultMessage = {
  routeEventId: SharedWorkspaceRouteEventId;
  operationId: SharedWorkspaceOperationId;
  /** 仅用于 Server 侧流量归因，不参与授权和业务结果解析。 */
  operationKey?: SharedWorkspaceOperationKey | null;
  /** Host RPC 方法名；用于把 sharedWorkspace.route.result 拆到具体接口维度。 */
  method?: SharedWorkspaceHostRpcMethod | string | null;
  status: Extract<SharedWorkspaceRouteStatus, "succeeded" | "failed" | "cancelled">;
  completedAt: number;
  result?: unknown;
  error?: SharedWorkspaceErrorView | null;
};

export type SharedWorkspaceSubscriptionTopic = `sharedWorkspace:${SharedWorkspaceId}`;

export function makeSharedWorkspaceSubscriptionTopic(sharedWorkspaceId: SharedWorkspaceId): SharedWorkspaceSubscriptionTopic {
  return `sharedWorkspace:${sharedWorkspaceId}`;
}

export type SharedWorkspaceSubscribeMessage = {
  requestId: string;
  sharedWorkspaceId: SharedWorkspaceId;
  sinceSeq?: number;
};

export type SharedWorkspaceUnsubscribeMessage = {
  requestId?: string;
  sharedWorkspaceId: SharedWorkspaceId;
};

export type SharedWorkspaceSubscribeAck = {
  requestId: string;
  sharedWorkspaceId: SharedWorkspaceId;
  topic: SharedWorkspaceSubscriptionTopic;
  sinceSeq: number;
  bufferedCount: number;
  serverSeq: number;
  demandId?: string;
  readyThroughSeq?: number;
  bootstrap?: SharedWorkspaceRemoteBootstrap | null;
};

export type SharedWorkspaceTopicEventBase<T extends string, P> = {
  type: T;
  sharedWorkspaceId: SharedWorkspaceId;
  enterpriseId: string;
  seq: number;
  ts: number;
  payload: P;
};

export type SharedWorkspaceHostStatusChangedEvent = SharedWorkspaceTopicEventBase<
  "sharedWorkspace.host.status.changed",
  {
    hostStatus: SharedWorkspaceHostStatus;
    host: SharedWorkspaceHostBindingPublicView | null;
    reason?: "registered" | "heartbeat" | "disconnect" | "ttl_expired" | "deleted";
  }
>;

export type SharedWorkspaceHostMaintenanceChangedEvent = SharedWorkspaceTopicEventBase<
  "sharedWorkspace.host.maintenance.changed",
  WorkspaceDirectoryMigrationHostMaintenance
>;

export type SharedWorkspaceLockChangedEvent = SharedWorkspaceTopicEventBase<
  "sharedWorkspace.lock.changed",
  {
    writeLock: SharedWorkspaceWriteLockView | null;
    reason?: "acquired" | "released" | "takeover" | "offline" | "deleted";
  }
>;

export type SharedWorkspaceTakeoverChangedEvent = SharedWorkspaceTopicEventBase<
  "sharedWorkspace.takeover.changed",
  {
    request: SharedWorkspaceTakeoverRequestView;
  }
>;

export type SharedWorkspaceMemberChangedEvent = SharedWorkspaceTopicEventBase<
  "sharedWorkspace.member.changed",
  {
    member: SharedWorkspaceMemberItem;
    kind: "joined" | "left" | "role_changed";
  }
>;

export type SharedWorkspaceAssetMaintenancePolicyChangedEvent = SharedWorkspaceTopicEventBase<
  "sharedWorkspace.assetMaintenancePolicy.changed",
  {
    policy: SharedWorkspaceAssetMaintenancePolicy;
  }
>;

export type SharedWorkspaceRouteEventChangedEvent = SharedWorkspaceTopicEventBase<
  "sharedWorkspace.route.event.changed",
  {
    routeEvent: SharedWorkspaceRouteEventView;
  }
>;

export type SharedWorkspaceTopicEvent =
  | SharedWorkspaceHostStatusChangedEvent
  | SharedWorkspaceHostMaintenanceChangedEvent
  | SharedWorkspaceLockChangedEvent
  | SharedWorkspaceTakeoverChangedEvent
  | SharedWorkspaceMemberChangedEvent
  | SharedWorkspaceAssetMaintenancePolicyChangedEvent
  | SharedWorkspaceRouteEventChangedEvent;
