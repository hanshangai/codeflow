import type { WorkspaceDirectoryMigrationErrorCode } from "@codeflowai/shared";
import type { WorkspaceDbSnapshotEvidence } from "../db/repos/workspaceDirectoryMigrationRepo.js";

export type WorkspaceMigrationManifestMode = { operationId: string } | null;
type ManagedDbContext = { sourceRoot: string; targetRoot: string; operationId: string; workspaceId: string; requestId: string };
export type WorkspaceMigrationSnapshotCommand = ManagedDbContext & { type: "workspace-db.snapshot" };
export type WorkspaceMigrationDbVerifyCommand = ManagedDbContext & {
  type: "workspace-db.verify";
  purpose: "precommit" | "committed" | "cleanup";
  evidence: WorkspaceDbSnapshotEvidence;
};
export type WorkspaceMigrationSnapshotResult = { evidence: Exclude<WorkspaceDbSnapshotEvidence, { state: "pending" }> };

/** 本 operation 唯一临时副本名，拒绝路径分隔符或任意调用方排除规则。 */
export function workspaceDbSnapshotTemporaryName(operationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId)) throw new Error("WORKSPACE_DB_OPERATION_ID_INVALID");
  return `workspace.db-${operationId}.snapshot`;
}

/** 仅新模式豁免工作区根受管 DB 工件，未知文件仍参加原完整清单。 */
export function isManagedWorkspaceDbPath(relativePath: string | null, mode: WorkspaceMigrationManifestMode | undefined, caseSensitive: boolean): boolean {
  if (!mode || relativePath === null) return false;
  const normalize = (text: string): string => caseSensitive ? text : text.toLowerCase();
  const value = normalize(relativePath.replace(/\\/g, "/"));
  return ["workspace.db", "workspace.db-wal", "workspace.db-shm", "workspace.db-journal", workspaceDbSnapshotTemporaryName(mode.operationId)]
    .some(name => value === normalize(`.codeflowai/${name}`));
}

export type WorkspaceMigrationManifestSummary = {
  manifestHash: string | null;
  fileCount: number;
  directoryCount: number;
  linkCount: number;
  totalBytes: number;
  excludedDependencyDirectoryCount: number;
  excludedDependencyDirectories: string[];
  hardLinkCount: number;
  sparseFileCount: number;
  metadataLimitations: Array<"acl" | "extended_attributes" | "alternate_data_streams" | "hard_links" | "sparse_layout">;
};

export type WorkspaceMigrationScanCommand = {
  manifestMode?: WorkspaceMigrationManifestMode;
  type: "scan";
  sourceRoot: string;
  targetRoot: string;
  targetFileSystemType: string;
  includeContentHashes: boolean;
  excludeDependencyDirectories?: boolean;
  targetCaseSensitive: boolean;
};

export type WorkspaceMigrationCopyCommand = {
  manifestMode?: WorkspaceMigrationManifestMode;
  type: "copy";
  sourceRoot: string;
  stagingRoot: string;
  finalTargetRoot: string;
  targetFileSystemType: string;
  expectedSourceManifestHash: string;
  targetCaseSensitive: boolean;
};

export type WorkspaceMigrationVerifyCommand = {
  manifestMode?: WorkspaceMigrationManifestMode;
  type: "verify";
  sourceRoot: string;
  targetRoot: string;
  targetFileSystemType: string;
  expectedSourceManifestHash: string;
  expectedTargetManifestHash?: string | null;
  targetCaseSensitive: boolean;
};

export type WorkspaceMigrationProbeCommand = {
  type: "probe";
  targetParent: string;
  operationToken: string;
  requiresSymlink: boolean;
};

export type WorkspaceMigrationWatchCommand = {
  type: "watch";
  watchRoot: string;
  recursive: boolean;
  caseSensitive: boolean;
  filterRelativePath?: string | null;
};

export type WorkspaceMigrationFileCommand =
  | WorkspaceMigrationScanCommand
  | WorkspaceMigrationCopyCommand
  | WorkspaceMigrationVerifyCommand
  | WorkspaceMigrationProbeCommand
  | WorkspaceMigrationWatchCommand
  | WorkspaceMigrationSnapshotCommand
  | WorkspaceMigrationDbVerifyCommand;

export type WorkspaceMigrationScanResult = {
  summary: WorkspaceMigrationManifestSummary;
};

export type WorkspaceMigrationCopyResult = {
  sourceSummary: WorkspaceMigrationManifestSummary;
  metadataWarningCount: number;
  metadataWarnings: WorkspaceMigrationMetadataWarning[];
};

export type WorkspaceMigrationMetadataWarning = {
  relativePath: string;
  operation: "chmod" | "utimes";
  errorCode: string;
};

export type WorkspaceMigrationVerifyResult = {
  sourceSummary: WorkspaceMigrationManifestSummary;
  targetSummary: WorkspaceMigrationManifestSummary;
  targetManifestHash: string;
};

export type WorkspaceMigrationProbeResult = {
  realTargetParent: string;
  availableBytes: number;
  caseSensitive: boolean;
  symlinkSupported: boolean;
};

export type WorkspaceMigrationFileResult =
  | WorkspaceMigrationScanResult
  | WorkspaceMigrationCopyResult
  | WorkspaceMigrationVerifyResult
  | WorkspaceMigrationProbeResult;
export type WorkspaceMigrationDbResult = WorkspaceMigrationSnapshotResult | { verified: true };

export type WorkspaceMigrationFileProgress = {
  phase: "scanning" | "copying" | "verifying";
  processedFiles: number;
  processedDirectories: number;
  processedBytes: number;
};

export type WorkspaceMigrationFileErrorCode = Extract<
  WorkspaceDirectoryMigrationErrorCode,
  | "WORKSPACE_MIGRATION_TARGET_INVALID"
  | "WORKSPACE_MIGRATION_LINK_UNSUPPORTED"
  | "WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED"
  | "WORKSPACE_MIGRATION_SOURCE_CHANGED"
  | "WORKSPACE_MIGRATION_COPY_FAILED"
  | "WORKSPACE_MIGRATION_VERIFY_FAILED"
> | "WORKSPACE_MIGRATION_FILE_CANCELLED";

export type WorkspaceMigrationFileErrorData = {
  code: WorkspaceMigrationFileErrorCode;
  message: string;
  details: Record<string, unknown>;
};

export type WorkspaceMigrationFileWorkerData = {
  taskId: string;
  command: WorkspaceMigrationFileCommand;
  cancelBuffer: SharedArrayBuffer;
};

export type WorkspaceMigrationFileWorkerMessage =
  | { type: "progress"; taskId: string; progress: WorkspaceMigrationFileProgress }
  | { type: "result"; taskId: string; result: WorkspaceMigrationFileResult | WorkspaceMigrationDbResult }
  | { type: "failed"; taskId: string; error: WorkspaceMigrationFileErrorData }
  | { type: "watch.ready"; taskId: string }
  | { type: "watch.changed"; taskId: string; eventType: "rename" | "change"; relativePath: string | null }
  | { type: "watch.error"; taskId: string; error: WorkspaceMigrationFileErrorData }
  | { type: "watch.stopped"; taskId: string };

export type WorkspaceMigrationFileWorkerControl = { type: "watch.stop"; taskId: string };
