import type { WorkspaceId } from "./ids.js";
import type { WorkspaceSummary } from "./http.js";

export const WORKSPACE_DIRECTORY_MIGRATION_STATES = [
  "scanning",
  "awaiting_confirmation",
  "preparing",
  "copying",
  "verifying",
  "publish_intent",
  "target_ready",
  "path_committed",
  "finalizing",
  "recovery_required",
  "completed",
  "cancelled",
  "failed",
] as const;

export type WorkspaceDirectoryMigrationState = (typeof WORKSPACE_DIRECTORY_MIGRATION_STATES)[number];

export const WORKSPACE_DIRECTORY_MIGRATION_TERMINAL_STATES = ["completed", "cancelled", "failed"] as const;

export type WorkspaceDirectoryMigrationTerminalState =
  (typeof WORKSPACE_DIRECTORY_MIGRATION_TERMINAL_STATES)[number];

export type WorkspaceDirectoryMigrationStartDisposition = "prepared" | "accepted" | "fenced";
export type WorkspaceDirectoryMigrationIndexRebuildStatus =
  | "not_started"
  | "pending"
  | "ready"
  | "failed"
  | "not_applicable";
export type WorkspaceDirectoryMigrationIndexRebuildPhase = "queued" | "building";
export type WorkspaceDirectoryMigrationPhase =
  | "checking"
  | "preparing"
  | "copying"
  | "verifying"
  | "committing"
  | "finalizing"
  | "recovery"
  | "completed"
  | "cancelled"
  | "failed";

export const WORKSPACE_DIRECTORY_MIGRATION_ERROR_CODES = [
  "WORKSPACE_MIGRATION_UNSUPPORTED",
  "WORKSPACE_MIGRATION_NOT_FOUND",
  "WORKSPACE_MIGRATION_BUSY",
  "WORKSPACE_MIGRATION_INDEX_NOT_READY",
  "WORKSPACE_MIGRATION_IDEMPOTENCY_CONFLICT",
  "WORKSPACE_MIGRATION_STATE_CONFLICT",
  "WORKSPACE_MIGRATION_ACTIVE_RESOURCES",
  "WORKSPACE_MIGRATION_IN_PROGRESS",
  "WORKSPACE_MIGRATION_TARGET_INVALID",
  "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
  "WORKSPACE_MIGRATION_TARGET_STORAGE_UNCONFIRMED",
  "WORKSPACE_MIGRATION_TARGET_CONFLICT",
  "WORKSPACE_MIGRATION_SPACE_INSUFFICIENT",
  "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
  "WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED",
  "WORKSPACE_MIGRATION_SOURCE_CHANGED",
  "WORKSPACE_MIGRATION_EXTERNAL_WRITES_UNCONFIRMED",
  "WORKSPACE_MIGRATION_SHARED_ACTIVITY",
  "WORKSPACE_MIGRATION_INTERRUPTED",
  "WORKSPACE_MIGRATION_COPY_FAILED",
  "WORKSPACE_MIGRATION_VERIFY_FAILED",
  "WORKSPACE_MIGRATION_SWITCH_FAILED",
  "WORKSPACE_MIGRATION_CANCEL_NOT_ALLOWED",
  "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
] as const;

export type WorkspaceDirectoryMigrationErrorCode =
  (typeof WORKSPACE_DIRECTORY_MIGRATION_ERROR_CODES)[number];
export type WorkspaceDirectoryMigrationWarningCode = "WORKSPACE_INDEX_REBUILD_FAILED";

export const WORKSPACE_DIRECTORY_MIGRATION_ERROR_HTTP_STATUS: Readonly<
  Record<WorkspaceDirectoryMigrationErrorCode, number>
> = {
  WORKSPACE_MIGRATION_UNSUPPORTED: 409,
  WORKSPACE_MIGRATION_NOT_FOUND: 404,
  WORKSPACE_MIGRATION_BUSY: 409,
  WORKSPACE_MIGRATION_INDEX_NOT_READY: 409,
  WORKSPACE_MIGRATION_IDEMPOTENCY_CONFLICT: 409,
  WORKSPACE_MIGRATION_STATE_CONFLICT: 409,
  WORKSPACE_MIGRATION_ACTIVE_RESOURCES: 409,
  WORKSPACE_MIGRATION_IN_PROGRESS: 409,
  WORKSPACE_MIGRATION_TARGET_INVALID: 400,
  WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED: 422,
  WORKSPACE_MIGRATION_TARGET_STORAGE_UNCONFIRMED: 409,
  WORKSPACE_MIGRATION_TARGET_CONFLICT: 409,
  WORKSPACE_MIGRATION_SPACE_INSUFFICIENT: 507,
  WORKSPACE_MIGRATION_LINK_UNSUPPORTED: 422,
  WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED: 422,
  WORKSPACE_MIGRATION_SOURCE_CHANGED: 409,
  WORKSPACE_MIGRATION_EXTERNAL_WRITES_UNCONFIRMED: 409,
  WORKSPACE_MIGRATION_SHARED_ACTIVITY: 409,
  WORKSPACE_MIGRATION_INTERRUPTED: 500,
  WORKSPACE_MIGRATION_COPY_FAILED: 500,
  WORKSPACE_MIGRATION_VERIFY_FAILED: 500,
  WORKSPACE_MIGRATION_SWITCH_FAILED: 500,
  WORKSPACE_MIGRATION_CANCEL_NOT_ALLOWED: 409,
  WORKSPACE_MIGRATION_RECOVERY_REQUIRED: 409,
};

const LEGAL_STATE_TRANSITIONS: Readonly<
  Record<WorkspaceDirectoryMigrationState, readonly WorkspaceDirectoryMigrationState[]>
> = {
  scanning: ["awaiting_confirmation", "cancelled", "failed"],
  awaiting_confirmation: ["preparing", "cancelled"],
  preparing: ["copying", "failed", "recovery_required"],
  copying: ["verifying", "cancelled", "failed", "recovery_required"],
  verifying: ["publish_intent", "cancelled", "failed", "recovery_required"],
  publish_intent: ["target_ready", "failed", "recovery_required"],
  target_ready: ["path_committed", "failed", "recovery_required"],
  path_committed: ["finalizing", "recovery_required"],
  finalizing: ["completed", "recovery_required"],
  recovery_required: ["failed", "target_ready", "path_committed", "finalizing", "completed"],
  completed: [],
  cancelled: [],
  failed: [],
};

/** 判断迁移状态是否为不可继续推进的固定终态。 */
export function isWorkspaceDirectoryMigrationTerminalState(
  state: WorkspaceDirectoryMigrationState,
): state is WorkspaceDirectoryMigrationTerminalState {
  return (WORKSPACE_DIRECTORY_MIGRATION_TERMINAL_STATES as readonly string[]).includes(state);
}

/** 校验唯一状态机中的相邻转换；同状态投影更新由专用接口处理。 */
export function canTransitionWorkspaceDirectoryMigrationState(
  current: WorkspaceDirectoryMigrationState,
  next: WorkspaceDirectoryMigrationState,
): boolean {
  return LEGAL_STATE_TRANSITIONS[current].includes(next);
}

/** 把持久状态映射为 UI 阶段，phase 不参与并发和恢复决策。 */
export function resolveWorkspaceDirectoryMigrationPhase(
  state: WorkspaceDirectoryMigrationState,
): WorkspaceDirectoryMigrationPhase {
  switch (state) {
    case "scanning":
    case "awaiting_confirmation":
      return "checking";
    case "preparing":
      return "preparing";
    case "copying":
      return "copying";
    case "verifying":
      return "verifying";
    case "publish_intent":
    case "target_ready":
    case "path_committed":
      return "committing";
    case "finalizing":
      return "finalizing";
    case "recovery_required":
      return "recovery";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

export type WorkspaceDirectoryMigrationBlocker = {
  code: WorkspaceDirectoryMigrationErrorCode | "SHARED_WORKSPACE_FORBIDDEN";
  message: string;
  details?: unknown;
};

export type WorkspaceDirectoryMigrationOperation = {
  operationId: string;
  workspaceId: WorkspaceId;
  state: WorkspaceDirectoryMigrationState;
  stateVersion: number;
  phase: WorkspaceDirectoryMigrationPhase;
  sourcePath: string;
  targetPath: string;
  sourceFileCount: number;
  sourceDirectoryCount: number;
  sourceTotalBytes: number;
  excludedDependencyDirectoryCount: number;
  excludedDependencyDirectories: string[];
  copiedFiles: number;
  copiedBytes: number;
  progressPct: number;
  canStart: boolean;
  canCancel: boolean;
  currentPath: string | null;
  blockers: WorkspaceDirectoryMigrationBlocker[];
  sharedBlockers: WorkspaceDirectoryMigrationBlocker[];
  errorCode: WorkspaceDirectoryMigrationErrorCode | null;
  errorMessage: string | null;
  errorDetails: unknown | null;
  warningCode: WorkspaceDirectoryMigrationWarningCode | null;
  warningDetails: unknown | null;
  startAttemptId: string | null;
  startDisposition: WorkspaceDirectoryMigrationStartDisposition | null;
  indexRebuildGeneration: number | null;
  indexRebuildStatus: WorkspaceDirectoryMigrationIndexRebuildStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type WorkspaceDirectoryMigrationSummary = Pick<
  WorkspaceDirectoryMigrationOperation,
  | "operationId"
  | "workspaceId"
  | "state"
  | "stateVersion"
  | "phase"
  | "progressPct"
  | "startAttemptId"
  | "startDisposition"
  | "updatedAt"
>;

export type WorkspaceDirectoryMigrationIndexState = Pick<
  WorkspaceDirectoryMigrationOperation,
  | "operationId"
  | "workspaceId"
  | "stateVersion"
  | "indexRebuildGeneration"
  | "indexRebuildStatus"
  | "warningCode"
  | "updatedAt"
>;

export type WorkspaceDirectoryMigrationStartFenceTombstone = {
  operationId: string;
  workspaceId: WorkspaceId;
  state: Extract<WorkspaceDirectoryMigrationTerminalState, "cancelled" | "failed">;
  stateVersion: number;
  startAttemptId: string;
  startDisposition: "fenced";
  updatedAt: number;
};

export type WorkspaceDirectoryMigrationActivationSnapshot = {
  activeDirectoryMigrations: WorkspaceDirectoryMigrationSummary[];
  startFenceTombstones: WorkspaceDirectoryMigrationStartFenceTombstone[];
  directoryMigrationIndexStates: WorkspaceDirectoryMigrationIndexState[];
};

export type WorkspaceDirectoryMigrationChangedEvent = {
  operationId: string;
  workspaceId: WorkspaceId;
  state: WorkspaceDirectoryMigrationState;
  stateVersion: number;
  phase: WorkspaceDirectoryMigrationPhase;
  progressPct: number;
  copiedBytes: number;
  totalBytes: number;
  updatedAt: number;
  errorCode?: WorkspaceDirectoryMigrationErrorCode | null;
  errorMessage?: string | null;
  warningCode?: WorkspaceDirectoryMigrationWarningCode | null;
  warningDetails?: unknown | null;
  workspace?: WorkspaceSummary;
};

export type WorkspaceDirectoryMigrationHostMaintenance = {
  active: boolean;
  maintenanceEpoch: string;
  maintenanceVersion: number;
  phase: WorkspaceDirectoryMigrationPhase;
  progressPct: number;
  updatedAt: number;
};

export type PrepareWorkspaceDirectoryMigrationRequest = {
  idempotencyKey: string;
  targetParentPath: string;
  targetDirectoryName: string;
};

export type StartWorkspaceDirectoryMigrationRequest = {
  externalWritesPausedConfirmed: true;
  targetNotSyncManagedConfirmed: true;
};

export type CancelWorkspaceDirectoryMigrationRequest = {
  reason?: string;
};

export type WorkspaceDirectoryMigrationOperationResponse = {
  operation: WorkspaceDirectoryMigrationOperation;
};
