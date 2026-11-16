import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openSqliteDb, type SqliteDb } from "../db/sqliteDb.js";
import { assertWorkspaceDbReadOnlySchema } from "../db/migrateClientDb.js";
import type { WorkspaceDbFileIdentity, WorkspaceDbSnapshotEvidence, WorkspaceDbSnapshotFile } from "../db/repos/workspaceDirectoryMigrationRepo.js";
import { isManagedWorkspaceDbPath, workspaceDbSnapshotTemporaryName } from "./workspaceMigrationFileProtocol.js";

import type {
  WorkspaceMigrationCopyCommand,
  WorkspaceMigrationCopyResult,
  WorkspaceMigrationFileErrorCode,
  WorkspaceMigrationFileProgress,
  WorkspaceMigrationManifestSummary,
  WorkspaceMigrationMetadataWarning,
  WorkspaceMigrationProbeCommand,
  WorkspaceMigrationProbeResult,
  WorkspaceMigrationScanCommand,
  WorkspaceMigrationScanResult,
  WorkspaceMigrationVerifyCommand,
  WorkspaceMigrationVerifyResult,
  WorkspaceMigrationManifestMode,
  WorkspaceMigrationSnapshotCommand,
  WorkspaceMigrationSnapshotResult,
  WorkspaceMigrationDbVerifyCommand,
} from "./workspaceMigrationFileProtocol.js";
import {
  classifyWorkspaceMigrationRegenerableDirectory,
  UNCONDITIONAL_REGENERABLE_DIRECTORY_NAMES,
} from "./workspaceMigrationRegenerableDirectories.js";
import {
  isWorkspacePathIndexStorageRelPath,
  WORKSPACE_PATH_INDEX_DIRECTORY,
} from "../fs/workspacePathIndexConfig.js";

const COPY_BUFFER_BYTES = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 200;
const MAX_METADATA_WARNING_DETAILS = 100;
const MAX_EXCLUDED_DEPENDENCY_DIRECTORY_DETAILS = 100;
const MAX_GIT_POINTER_BYTES = 64 * 1024;
const WINDOWS_REPARSE_PROBE_TIMEOUT_MS = 10 * 60_000;
const WINDOWS_REPARSE_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;
const WINDOWS_REPARSE_PROBE_STDERR_BYTES = 1024 * 1024;
const WINDOWS_REPARSE_PROBE_STDERR_SUMMARY_CHARS = 2_000;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_NAMING_FILESYSTEMS = new Set(["exfat", "fat", "fat32", "msdos", "ntfs", "ntfs3", "vfat"]);
const DARWIN_NORMALIZING_FILESYSTEMS = new Set(["apfs", "hfs", "hfs+"]);
const MAX_MANIFEST_DIFF_PATHS = 50;
const METADATA_LIMITATIONS: WorkspaceMigrationManifestSummary["metadataLimitations"] = [
  "acl",
  "extended_attributes",
  "alternate_data_streams",
  "hard_links",
  "sparse_layout",
];

type ManifestEntry = {
  relativePath: string;
  kind: "file" | "directory" | "link";
  size: number;
  contentHash: string | null;
  linkTarget: string | null;
};

type FileOperationHooks = {
  isCancelled: () => boolean;
  onProgress?: (progress: WorkspaceMigrationFileProgress) => void;
};

type CollectOptions = {
  manifestMode?: WorkspaceMigrationManifestMode;
  sourceRoot: string;
  compatibilityRoot: string;
  includeContentHashes: boolean;
  excludeDependencyDirectories: boolean;
  sourceCaseSensitive: boolean;
  targetCaseSensitive: boolean;
  targetFileSystemType: string;
  destinationRoot?: string;
  phase: WorkspaceMigrationFileProgress["phase"];
  hooks: FileOperationHooks;
};

type CollectResult = {
  summary: WorkspaceMigrationManifestSummary;
  entries: ManifestEntry[];
  metadataWarningCount: number;
  metadataWarnings: WorkspaceMigrationMetadataWarning[];
};

/** 文件 Worker 的稳定业务错误；details 只允许相对路径和非敏感摘要。 */
export class WorkspaceMigrationFileError extends Error {
  constructor(
    public readonly code: WorkspaceMigrationFileErrorCode,
    message: string,
    public readonly details: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceMigrationFileError";
  }
}

/** 扫描工作区并生成计数或带内容摘要的权威清单。 */
export async function scanWorkspaceMigrationTree(
  command: WorkspaceMigrationScanCommand,
  hooks: FileOperationHooks,
): Promise<WorkspaceMigrationScanResult> {
  try {
    const result = await collectTree({
      sourceRoot: command.sourceRoot,
      manifestMode: command.manifestMode,
      compatibilityRoot: command.targetRoot,
      includeContentHashes: command.includeContentHashes,
      excludeDependencyDirectories: command.excludeDependencyDirectories !== false,
      sourceCaseSensitive: sameResolvedPath(command.sourceRoot, command.targetRoot)
        ? command.targetCaseSensitive
        : defaultWorkspaceCaseSensitive(),
      targetCaseSensitive: command.targetCaseSensitive,
      targetFileSystemType: command.targetFileSystemType,
      phase: "scanning",
      hooks,
    });
    return { summary: result.summary };
  } catch (error) {
    throw normalizeFileError(error, "WORKSPACE_MIGRATION_VERIFY_FAILED", "扫描工作区失败", "scan_failed");
  }
}

/** 流式复制到全新 staging，并返回复制期间实际读取到的源清单。 */
export async function copyWorkspaceMigrationTree(
  command: WorkspaceMigrationCopyCommand,
  hooks: FileOperationHooks,
): Promise<WorkspaceMigrationCopyResult> {
  try {
    assertNonEmptyHash(command.expectedSourceManifestHash, "expectedSourceManifestHash");
    await assertCopyRoots(command.sourceRoot, command.stagingRoot, command.finalTargetRoot);
    const result = await collectTree({
      sourceRoot: command.sourceRoot,
      manifestMode: command.manifestMode,
      compatibilityRoot: command.finalTargetRoot,
      includeContentHashes: true,
      excludeDependencyDirectories: true,
      sourceCaseSensitive: defaultWorkspaceCaseSensitive(),
      targetCaseSensitive: command.targetCaseSensitive,
      targetFileSystemType: command.targetFileSystemType,
      destinationRoot: command.stagingRoot,
      phase: "copying",
      hooks,
    });
    if (result.summary.manifestHash !== command.expectedSourceManifestHash) {
      throw fileError(
        "WORKSPACE_MIGRATION_SOURCE_CHANGED",
        "源工作区在复制前后发生变化",
        "source_manifest_changed_during_copy",
        { expectedManifestHash: command.expectedSourceManifestHash, actualManifestHash: result.summary.manifestHash },
      );
    }
    return {
      sourceSummary: result.summary,
      metadataWarningCount: result.metadataWarningCount,
      metadataWarnings: result.metadataWarnings,
    };
  } catch (error) {
    throw normalizeFileError(error, "WORKSPACE_MIGRATION_COPY_FAILED", "复制工作区失败", "copy_failed");
  }
}

/** 重新计算源和目标完整清单，任何不一致都显式失败。 */
export async function verifyWorkspaceMigrationTrees(
  command: WorkspaceMigrationVerifyCommand,
  hooks: FileOperationHooks,
): Promise<WorkspaceMigrationVerifyResult> {
  try {
    assertNonEmptyHash(command.expectedSourceManifestHash, "expectedSourceManifestHash");
    let sourceProgress: WorkspaceMigrationFileProgress = {
      phase: "verifying",
      processedFiles: 0,
      processedDirectories: 0,
      processedBytes: 0,
    };
    const source = await collectTree({
      sourceRoot: command.sourceRoot,
      manifestMode: command.manifestMode,
      compatibilityRoot: command.targetRoot,
      includeContentHashes: true,
      excludeDependencyDirectories: true,
      sourceCaseSensitive: defaultWorkspaceCaseSensitive(),
      targetCaseSensitive: command.targetCaseSensitive,
      targetFileSystemType: command.targetFileSystemType,
      phase: "verifying",
      hooks: {
        isCancelled: hooks.isCancelled,
        onProgress: (progress) => {
          sourceProgress = progress;
          hooks.onProgress?.(progress);
        },
      },
    });
    const target = await collectTree({
      sourceRoot: command.targetRoot,
      manifestMode: command.manifestMode,
      compatibilityRoot: command.targetRoot,
      includeContentHashes: true,
      excludeDependencyDirectories: true,
      sourceCaseSensitive: command.targetCaseSensitive,
      targetCaseSensitive: command.targetCaseSensitive,
      targetFileSystemType: command.targetFileSystemType,
      phase: "verifying",
      hooks: {
        isCancelled: hooks.isCancelled,
        onProgress: (progress) => hooks.onProgress?.({
          phase: "verifying",
          processedFiles: sourceProgress.processedFiles + progress.processedFiles,
          processedDirectories: sourceProgress.processedDirectories + progress.processedDirectories,
          processedBytes: sourceProgress.processedBytes + progress.processedBytes,
        }),
      },
    });
    const sourceManifestChanged = source.summary.manifestHash !== command.expectedSourceManifestHash;
    if (sourceManifestChanged) {
      throw fileError(
        "WORKSPACE_MIGRATION_SOURCE_CHANGED",
        "源工作区内容已变化",
        "source_manifest_changed",
        {
          expectedManifestHash: command.expectedSourceManifestHash,
          actualManifestHash: source.summary.manifestHash,
          sourceChangedPaths: findManifestDifferencePaths(source.entries, target.entries),
        },
      );
    }
    if (target.summary.manifestHash !== source.summary.manifestHash) {
      throw fileError(
        "WORKSPACE_MIGRATION_VERIFY_FAILED",
        "目标工作区清单与源工作区不一致",
        "target_manifest_mismatch",
        {
          sourceManifestHash: source.summary.manifestHash,
          targetManifestHash: target.summary.manifestHash,
          targetChangedPaths: findManifestDifferencePaths(source.entries, target.entries),
        },
      );
    }
    if (
      command.expectedTargetManifestHash
      && target.summary.manifestHash !== command.expectedTargetManifestHash
    ) {
      throw fileError(
        "WORKSPACE_MIGRATION_VERIFY_FAILED",
        "目标工作区清单与已验证摘要不一致",
        "target_expected_manifest_mismatch",
        { expectedManifestHash: command.expectedTargetManifestHash, actualManifestHash: target.summary.manifestHash },
      );
    }
    return {
      sourceSummary: source.summary,
      targetSummary: target.summary,
      targetManifestHash: target.summary.manifestHash!,
    };
  } catch (error) {
    throw normalizeFileError(error, "WORKSPACE_MIGRATION_VERIFY_FAILED", "校验工作区失败", "verify_failed");
  }
}

/** 在 Worker 内持稳定只读事务复制固定工作区库，关闭全部句柄后返回可提交证据。 */
export async function snapshotWorkspaceDatabase(command: WorkspaceMigrationSnapshotCommand, hooks: FileOperationHooks): Promise<WorkspaceMigrationSnapshotResult> {
  try { return await snapshotWorkspaceDatabaseFiles(command, hooks); }
  catch (error) {
    if (error instanceof WorkspaceMigrationFileError) throw error;
    throw databaseFileFailure(command, [error]);
  }
}

/** 固定路径检查、稳定只读复制和安全发布均在原 Worker 内执行。 */
async function snapshotWorkspaceDatabaseFiles(command: WorkspaceMigrationSnapshotCommand, hooks: FileOperationHooks): Promise<WorkspaceMigrationSnapshotResult> {
  const roots = inspectDatabaseRoots(command.sourceRoot, command.targetRoot);
  const sourcePath = path.join(command.sourceRoot, ".codeflowai", "workspace.db");
  const targetPath = path.join(command.targetRoot, ".codeflowai", "workspace.db");
  const temporaryPath = path.join(command.targetRoot, ".codeflowai", workspaceDbSnapshotTemporaryName(command.operationId));
  assertDbArtifactsAbsent(command.targetRoot, true, command.operationId);
  const source = inspectDatabaseFile(sourcePath);
  if (!source) {
    assertDbArtifactsAbsent(command.sourceRoot, true, command.operationId);
    return { evidence: { formatVersion: 1, state: "absent", ...roots } };
  }
  assertNoDatabaseSidecars(command.sourceRoot);
  let database: SqliteDb | undefined, unclosed: (() => void) | undefined;
  let targetDatabase: SqliteDb | undefined, unclosedTarget: (() => void) | undefined;
  const temporaryOwnership: SnapshotTemporaryOwnership = { created: false, closed: false };
  let transaction = false, published = false;
  let failure: unknown;
  let stage = "snapshot.source.open";
  let evidence: WorkspaceMigrationSnapshotResult["evidence"] | undefined;
  try {
    database = openSqliteDb(sourcePath, { readonly: true, fileMustExist: true, busyTimeoutMs: 0,
      onInitializationCleanupFailure: close => { unclosed = close; } });
    database.exec("BEGIN"); transaction = true;
    database.prepare("SELECT count(*) FROM sqlite_master").get();
    const schema = validateDatabaseReadOnly(database);
    assertSameDatabaseMetadata(source, inspectDatabaseFile(sourcePath));
    stage = "snapshot.copy";
    const copied = await copyStableDatabaseFile(sourcePath, temporaryPath, source, hooks, temporaryOwnership);
    assertNotCancelled(hooks);
    assertSameDatabaseMetadata(source, inspectDatabaseFile(sourcePath));
    assertNoDatabaseSidecars(command.sourceRoot);
    const temporaryMetadata = inspectDatabaseFile(temporaryPath);
    if (!temporaryMetadata || temporaryMetadata.dev !== temporaryOwnership.identity?.dev || temporaryMetadata.ino !== temporaryOwnership.identity.ino) throw new Error("WORKSPACE_DB_TEMPORARY_REPLACED");
    stage = "snapshot.target.open";
    targetDatabase = openSqliteDb(temporaryPath, { readonly: true, fileMustExist: true, busyTimeoutMs: 0,
      onInitializationCleanupFailure: close => { unclosedTarget = close; } });
    let targetFailure: unknown;
    try { stage = "snapshot.target.validate"; validateDatabaseReadOnly(targetDatabase); }
    catch (error) { targetFailure = error; throw error; }
    finally {
      try { targetDatabase.close(); targetDatabase = undefined; }
      catch (error) { const closeError = databaseIoFailure("snapshot.target.close", error); throw targetFailure ? new AggregateError([targetFailure, closeError], "WORKSPACE_DB_COPY_CLOSE_FAILED", { cause: targetFailure }) : closeError; }
    }
    stage = "snapshot.source.rollback"; database.exec("ROLLBACK"); transaction = false;
    stage = "snapshot.source.close"; database.close(); database = undefined;
    assertNotCancelled(hooks);
    assertSameDatabaseMetadata(source, inspectDatabaseFile(sourcePath));
    assertSameDatabaseMetadata(temporaryMetadata, inspectDatabaseFile(temporaryPath));
    assertDatabaseRoots(command.sourceRoot, command.targetRoot, roots);
    if (inspectDatabaseFile(targetPath)) throw new Error("WORKSPACE_DB_TARGET_ALREADY_EXISTS");
    stage = "snapshot.publish"; await fs.promises.rename(temporaryPath, targetPath); published = true;
    stage = "snapshot.directory.sync"; await fsyncDirectory(path.dirname(targetPath));
    const target = inspectDatabaseFile(targetPath)!;
    evidence = { formatVersion: 1, state: "ready", ...roots, source: { ...source, hash: copied.hash }, target: { ...target, hash: copied.hash }, ...schema };
  } catch (error) { failure = databaseIoFailure(stage, error); }
  const errors: unknown[] = failure === undefined ? [] : [failure];
  if (database) {
    if (transaction) { try { database.exec("ROLLBACK"); } catch (error) { errors.push(databaseIoFailure("snapshot.source.rollback", error)); } }
    try { database.close(); } catch (error) { errors.push(databaseIoFailure("snapshot.source.close", error)); }
  }
  if (unclosed) { try { unclosed(); } catch (error) { errors.push(databaseIoFailure("snapshot.source.close", error)); } }
  if (targetDatabase) { try { targetDatabase.close(); targetDatabase = undefined; } catch (error) { errors.push(databaseIoFailure("snapshot.target.close", error)); } }
  if (unclosedTarget) { try { unclosedTarget(); unclosedTarget = undefined; } catch (error) { errors.push(databaseIoFailure("snapshot.target.close", error)); } }
  if (errors.length && !published) {
    try { await cleanupOwnedSnapshotTemporary(temporaryPath, !targetDatabase && !unclosedTarget && temporaryOwnership.closed ? temporaryOwnership.identity ?? null : null); }
    catch (error) { errors.push(databaseIoFailure("snapshot.cleanup", error)); }
  }
  if (errors.length) throw databaseFileFailure(command, errors);
  if (!evidence) throw new Error("WORKSPACE_DB_SNAPSHOT_MISSING_RESULT");
  return { evidence };
}

/** 固定只读恢复校验：precommit 比字节，committed 容许原位事务，cleanup 只证明待删副本。 */
export async function verifyWorkspaceDatabase(command: WorkspaceMigrationDbVerifyCommand, hooks: FileOperationHooks): Promise<{ verified: true }> {
  try {
  const evidence = command.evidence;
  assertNotCancelled(hooks);
  if (evidence.state === "pending") {
    if (command.purpose !== "cleanup") throw new Error("WORKSPACE_DB_SNAPSHOT_PENDING");
    inspectDatabaseRoots(command.sourceRoot, command.targetRoot);
    assertDbArtifactsAbsent(command.targetRoot, true, command.operationId);
    return { verified: true };
  }
  assertDbArtifactsAbsent(command.targetRoot, false, command.operationId);
  assertDatabaseRoot(command.targetRoot, evidence.targetRoot);
  if (command.purpose === "precommit") assertDatabaseRoot(command.sourceRoot, evidence.sourceRoot);
  if (evidence.state === "absent") {
    assertDbArtifactsAbsent(command.targetRoot, true, command.operationId);
    if (command.purpose === "precommit") assertDbArtifactsAbsent(command.sourceRoot, true, command.operationId);
    return { verified: true };
  }
  await verifyDatabaseFile(command.targetRoot, evidence.target, evidence, command.purpose !== "committed", hooks);
  if (command.purpose === "precommit") {
    try { await verifyDatabaseFile(command.sourceRoot, evidence.source, evidence, true, hooks); }
    catch (error) { throw new WorkspaceMigrationFileError("WORKSPACE_MIGRATION_SOURCE_CHANGED", "源工作区数据库快照已过期", { reason: "workspace_db_snapshot_stale", operationId: command.operationId, workspaceId: command.workspaceId, requestId: command.requestId, failures: summarizeDatabaseFailures([error]) }, { cause: error }); }
  }
  assertDatabaseRoot(command.targetRoot, evidence.targetRoot);
  if (command.purpose === "precommit") assertDatabaseRoot(command.sourceRoot, evidence.sourceRoot);
  return { verified: true };
  } catch (error) {
    if (error instanceof WorkspaceMigrationFileError) throw error;
    throw new WorkspaceMigrationFileError("WORKSPACE_MIGRATION_VERIFY_FAILED", "工作区数据库只读校验失败", {
      reason: "workspace_db_verification_failed", operationId: command.operationId, workspaceId: command.workspaceId,
      requestId: command.requestId, purpose: command.purpose, failures: summarizeDatabaseFailures([error]),
    }, { cause: error });
  }
}

/** 检查真实普通根与受管容器，返回可持久化 BigInt 身份；不存在容器仅允许源无库。 */
function inspectDatabaseRoots(sourceRoot: string, targetRoot: string): { sourceRoot: WorkspaceDbFileIdentity; targetRoot: WorkspaceDbFileIdentity } {
  return { sourceRoot: inspectDatabaseRoot(sourceRoot), targetRoot: inspectDatabaseRoot(targetRoot) };
}

/** 固定根和可选 .codeflowai 必须为原位普通目录，不接受符号链接。 */
function inspectDatabaseRoot(root: string): WorkspaceDbFileIdentity {
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino <= 0n) throw new Error("WORKSPACE_DB_ROOT_INVALID");
  const container = path.join(root, ".codeflowai");
  try { const child = fs.lstatSync(container, { bigint: true }); if (!child.isDirectory() || child.isSymbolicLink()) throw new Error("WORKSPACE_DB_CONTAINER_INVALID"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

/** 同步固定元数据复核只作 O(1) 身份检查，整库校验只在 Worker。 */
export function assertDatabaseRoot(root: string, expected: WorkspaceDbFileIdentity): void {
  const actual = inspectDatabaseRoot(root);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("WORKSPACE_DB_ROOT_REPLACED");
}

/** 复核源目标固定根身份，不在主线程读取数据库内容。 */
export function assertDatabaseRoots(sourceRoot: string, targetRoot: string, expected: { sourceRoot: WorkspaceDbFileIdentity; targetRoot: WorkspaceDbFileIdentity }): void {
  assertDatabaseRoot(sourceRoot, expected.sourceRoot); assertDatabaseRoot(targetRoot, expected.targetRoot);
}

/** 普通独占文件才能形成证据；dev 0 仍按精确原平台值比较，ino 不得缺失。 */
export function inspectDatabaseFile(filename: string): Omit<WorkspaceDbSnapshotFile, "hash"> | null {
  let stat: fs.BigIntStats;
  try { stat = fs.lstatSync(filename, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WORKSPACE_DB_FILE_IDENTITY_INVALID");
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}

/** 比较稳定复制前后的固定文件元数据，绝不把尺寸相等当作身份相等。 */
export function assertSameDatabaseMetadata(expected: Omit<WorkspaceDbSnapshotFile, "hash">, actual: Omit<WorkspaceDbSnapshotFile, "hash"> | null): void {
  if (!actual || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => expected[key as keyof typeof expected] !== actual[key as keyof typeof actual])) throw new Error("WORKSPACE_DB_FILE_CHANGED");
}

/** 只认受管主库及固定三个 sidecar，任何 sidecar 都禁止直接复制普通 DELETE 库。 */
export function assertDbArtifactsAbsent(root: string, includeMain: boolean, operationId: string): void {
  const names = [...(includeMain ? ["workspace.db"] : []), "workspace.db-wal", "workspace.db-shm", "workspace.db-journal", workspaceDbSnapshotTemporaryName(operationId)];
  for (const name of names) if (inspectDatabaseFile(path.join(root, ".codeflowai", name))) throw new Error("WORKSPACE_DB_ARTIFACT_UNEXPECTED");
}

/** snapshot 与恢复均拒绝 WAL、SHM 或待恢复 journal，不修改源现场。 */
function assertNoDatabaseSidecars(root: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) if (inspectDatabaseFile(path.join(root, ".codeflowai", `workspace.db${suffix}`))) throw new Error("WORKSPACE_DB_SIDECAR_UNSUPPORTED");
}

/** 只读结构及 SQLite 完整性检查，不执行迁移、repair 或写 PRAGMA。 */
function validateDatabaseReadOnly(database: SqliteDb): { applicationId: number; schemaVersion: number } {
  const schema = assertWorkspaceDbReadOnlySchema(database);
  if (String(database.pragma("journal_mode", { simple: true })).toLowerCase() !== "delete") throw new Error("WORKSPACE_DB_JOURNAL_MODE_INVALID");
  const integrity = database.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || Object.values(integrity[0] as object)[0] !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("WORKSPACE_DB_INTEGRITY_INVALID");
  return schema;
}

type SnapshotTemporaryOwnership = { created: boolean; closed: boolean; identity?: { dev: string; ino: string } };

/** 复制时保留本次 wx 的句柄身份及真实 close 事实，失败也可安全判断清理边界。 */
async function copyStableDatabaseFile(sourcePath: string, destinationPath: string | null, expected: Omit<WorkspaceDbSnapshotFile, "hash">, hooks: FileOperationHooks, ownership?: SnapshotTemporaryOwnership): Promise<{ hash: string }> {
  let source: fs.promises.FileHandle | undefined, target: fs.promises.FileHandle | undefined;
  const errors: unknown[] = []; const hash = crypto.createHash("sha256");
  let stage = "copy.source.open";
  try {
    source = await fs.promises.open(sourcePath, "r");
    stage = "copy.source.identity";
    const stat = await source.stat({ bigint: true });
    if (String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino || stat.nlink !== 1n) throw new Error("WORKSPACE_DB_FILE_REPLACED");
    if (destinationPath) {
      stage = "copy.target.open";
      target = await fs.promises.open(destinationPath, "wx", 0o600);
      if (ownership) ownership.created = true;
      const targetStat = await target.stat({ bigint: true });
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1n || targetStat.ino <= 0n) throw new Error("WORKSPACE_DB_TEMPORARY_IDENTITY_INVALID");
      if (ownership) ownership.identity = { dev: String(targetStat.dev), ino: String(targetStat.ino) };
    }
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES); let size = 0;
    while (true) {
      stage = "copy.read";
      assertNotCancelled(hooks);
      const read = await source.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      const chunk = buffer.subarray(0, read.bytesRead); hash.update(chunk); size += chunk.length;
      if (target) { stage = "copy.write"; await writeAll(target, chunk); }
    }
    if (target) { stage = "copy.sync"; await target.sync(); }
    stage = "copy.source.verify";
    if (size !== expected.size) throw new Error("WORKSPACE_DB_FILE_SIZE_CHANGED");
    assertSameDatabaseMetadata(expected, inspectDatabaseFile(sourcePath));
  } catch (error) { errors.push(databaseIoFailure(stage, error)); }
  if (target) {
    try { await target.close(); if (ownership) ownership.closed = true; } catch (error) { errors.push(databaseIoFailure("copy.target.close", error)); }
  }
  if (source) { try { await source.close(); } catch (error) { errors.push(databaseIoFailure("copy.source.close", error)); } }
  if (errors.length) throw new AggregateError(errors, "WORKSPACE_DB_FILE_COPY_FAILED", { cause: errors[0] });
  return { hash: hash.digest("hex") };
}

/** 只清理由本次 wx 创建且已成功 close、身份仍未被替换的临时文件。 */
async function cleanupOwnedSnapshotTemporary(filename: string, ownership: { dev: string; ino: string } | null): Promise<void> {
  if (!inspectDatabaseFile(filename)) return;
  if (!ownership) throw new Error("WORKSPACE_DB_TEMPORARY_OWNERSHIP_UNPROVEN");
  const current = inspectDatabaseFile(filename);
  if (!current || current.dev !== ownership.dev || current.ino !== ownership.ino) throw new Error("WORKSPACE_DB_TEMPORARY_REPLACED");
  await fs.promises.unlink(filename);
}

/** 在稳定只读事务内验证受管副本；提交后允许同一文件的合法 DELETE 事务。 */
async function verifyDatabaseFile(root: string, expected: WorkspaceDbSnapshotFile, evidence: Extract<WorkspaceDbSnapshotEvidence, { state: "ready" }>, exact: boolean, hooks: FileOperationHooks): Promise<void> {
  assertNoDatabaseSidecars(root);
  const filename = path.join(root, ".codeflowai", "workspace.db"); const before = inspectDatabaseFile(filename);
  if (!before || before.dev !== expected.dev || before.ino !== expected.ino) throw new Error("WORKSPACE_DB_FILE_REPLACED");
  let database: SqliteDb | undefined, unclosed: (() => void) | undefined;
  let transaction = false;
  const errors: unknown[] = [];
  try {
    database = openSqliteDb(filename, { readonly: true, fileMustExist: true, busyTimeoutMs: 0,
      onInitializationCleanupFailure: close => { unclosed = close; } });
    database.exec("BEGIN"); transaction = true; database.prepare("SELECT count(*) FROM sqlite_master").get();
    const schema = validateDatabaseReadOnly(database);
    if (schema.applicationId !== evidence.applicationId || (exact ? schema.schemaVersion !== evidence.schemaVersion : schema.schemaVersion < evidence.schemaVersion)) throw new Error("WORKSPACE_DB_SCHEMA_CHANGED");
    if (exact) {
      assertSameDatabaseMetadata(expected, before);
      const actual = await copyStableDatabaseFile(filename, null, before, hooks);
      if (actual.hash !== expected.hash) throw new Error("WORKSPACE_DB_SNAPSHOT_STALE");
    }
    assertSameDatabaseMetadata(before, inspectDatabaseFile(filename));
  } catch (error) { errors.push(error); }
  if (database) {
    if (transaction) { try { database.exec("ROLLBACK"); } catch (error) { errors.push(databaseIoFailure("verify.rollback", error)); } }
    try { database.close(); } catch (error) { errors.push(databaseIoFailure("verify.close", error)); }
  }
  if (unclosed) { try { unclosed(); } catch (error) { errors.push(databaseIoFailure("verify.close", error)); } }
  if (errors.length) throw new AggregateError(errors, "WORKSPACE_DB_VERIFICATION_FAILED", { cause: errors[0] });
}

/** Worker 脱敏错误保留每一失败原因标识，关联原 operation/workspace/request。 */
function databaseFileFailure(command: WorkspaceMigrationSnapshotCommand, errors: unknown[]): WorkspaceMigrationFileError {
  return new WorkspaceMigrationFileError("WORKSPACE_MIGRATION_VERIFY_FAILED", "工作区数据库交接失败", {
    reason: "workspace_db_snapshot_failed", operationId: command.operationId, workspaceId: command.workspaceId, requestId: command.requestId,
    failures: summarizeDatabaseFailures(errors),
  }, { cause: new AggregateError(errors, "WORKSPACE_DB_SNAPSHOT_FAILED", { cause: errors[0] }) });
}

/** 为本地原始异常保留固定阶段，跨线程只提取白名单诊断。 */
function databaseIoFailure(stage: string, cause: unknown): Error {
  return Object.assign(new Error("WORKSPACE_DB_IO_FAILED", { cause }), { workspaceDbStage: stage });
}

/** 展开业务、close、cleanup 双因；不跨线程发送原始 message 或路径。 */
function summarizeDatabaseFailures(errors: unknown[]): Record<string, string>[] {
  const failures: Record<string, string>[] = [];
  const visited = new Set<unknown>();
  /** 沿 Aggregate 和 cause 保留每个原因一次，阶段仅来自本文件固定值。 */
  const visit = (error: unknown, inheritedStage: string): void => {
    if (visited.has(error)) return;
    visited.add(error);
    const stage = error instanceof Error && "workspaceDbStage" in error ? String(error.workspaceDbStage) : inheritedStage;
    const rawType = error instanceof Error ? error.name : typeof error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    failures.push({ stage, rootCauseType: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawType) ? rawType : "Error",
      reason: error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "WORKSPACE_DB_IO_FAILED",
      ...(/^[A-Z0-9_]{1,64}$/.test(code) ? { osErrorCode: code } : {}) });
    if (error instanceof AggregateError) for (const child of error.errors) visit(child, stage);
    if (error instanceof Error && error.cause !== undefined) visit(error.cause, stage);
  };
  for (const error of errors) visit(error, "snapshot");
  return failures;
}

/** 在目标父目录验证写入、fsync、rename、大小写和按需符号链接能力，并清理探测项。 */
export async function probeWorkspaceMigrationTarget(
  command: WorkspaceMigrationProbeCommand,
  hooks: FileOperationHooks,
): Promise<WorkspaceMigrationProbeResult> {
  assertNotCancelled(hooks);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(command.operationToken)) {
    throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标探测标识非法", "probe_token_invalid");
  }
  let realTargetParent: string;
  try {
    realTargetParent = await fs.promises.realpath(command.targetParent);
    const parentStat = await fs.promises.stat(realTargetParent);
    if (!parentStat.isDirectory()) throw new Error("target parent is not a directory");
  } catch (error) {
    throw normalizeFileError(error, "WORKSPACE_MIGRATION_TARGET_INVALID", "目标父目录不可用", "probe_parent_unavailable");
  }

  const suffix = crypto.randomUUID();
  const baseName = `.codeflowai-migration-probe-${command.operationToken}-${suffix}`;
  const stagingPath = path.join(realTargetParent, `${baseName}-staging`);
  const publishedPath = path.join(realTargetParent, `${baseName}-published`);
  let cleanupPath: string | null = null;
  let primaryError: unknown = null;
  let caseSensitive = true;
  let symlinkSupported = false;
  try {
    await fs.promises.mkdir(stagingPath, { recursive: false });
    cleanupPath = stagingPath;
    const probeFile = path.join(stagingPath, "case-probe");
    const handle = await fs.promises.open(probeFile, "wx");
    try {
      await handle.writeFile("codeflowai-workspace-migration", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    caseSensitive = !(await pathExists(path.join(stagingPath, "CASE-PROBE")));
    if (command.requiresSymlink) {
      const linkPath = path.join(stagingPath, "probe-link");
      await fs.promises.symlink("case-probe", linkPath, "file");
      symlinkSupported = (await fs.promises.lstat(linkPath)).isSymbolicLink();
      if (!symlinkSupported) throw new Error("created probe link is not a symbolic link");
    }
    await fsyncDirectory(stagingPath);
    await fs.promises.rename(stagingPath, publishedPath);
    cleanupPath = publishedPath;
    await fsyncDirectory(realTargetParent);
  } catch (error) {
    primaryError = error;
  }

  if (cleanupPath) {
    try {
      await safeRemoveProbe(realTargetParent, cleanupPath, baseName);
      await fsyncDirectory(realTargetParent);
    } catch (cleanupError) {
      throw normalizeFileError(
        cleanupError,
        "WORKSPACE_MIGRATION_TARGET_INVALID",
        "目标能力探测项清理失败",
        "probe_cleanup_failed",
      );
    }
  }
  if (primaryError) {
    throw normalizeFileError(primaryError, "WORKSPACE_MIGRATION_TARGET_INVALID", "目标文件系统能力探测失败", "probe_failed");
  }

  let availableBytes: number;
  try {
    const stat = await fs.promises.statfs(realTargetParent, { bigint: true });
    const available = stat.bavail * stat.bsize;
    if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("available bytes exceed safe integer range");
    availableBytes = Number(available);
  } catch (error) {
    throw normalizeFileError(error, "WORKSPACE_MIGRATION_TARGET_INVALID", "无法读取目标可用空间", "probe_statfs_failed");
  }
  return { realTargetParent, availableBytes, caseSensitive, symlinkSupported };
}

/** 遍历源树、按需复制并生成稳定清单；调用方负责状态持久化和 staging 清理。 */
async function collectTree(options: CollectOptions): Promise<CollectResult> {
  assertNotCancelled(options.hooks);
  const sourceRoot = path.resolve(options.sourceRoot);
  const compatibilityRoot = path.resolve(options.compatibilityRoot);
  const targetFileSystemType = normalizeFileSystemType(options.targetFileSystemType);
  const rootStat = await fs.promises.lstat(sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "工作区根目录不能是链接", "source_root_not_plain_directory");
  }
  const sourceRealRoot = await fs.promises.realpath(sourceRoot);
  const windowsExcludedDirectories = process.platform === "win32" && options.excludeDependencyDirectories
    ? await discoverRegenerableDirectories(sourceRealRoot, options.hooks)
    : [];
  const windowsExcludedDirectorySet = new Set(windowsExcludedDirectories.map((entry) => entry.toLowerCase()));
  const windowsReparsePoints = process.platform === "win32"
    ? await listWindowsReparsePoints(
      sourceRealRoot,
      options.phase,
      options.excludeDependencyDirectories,
      windowsExcludedDirectories,
      options.hooks,
    )
    : new Map<string, string>();
  if (windowsReparsePoints.has(".")) {
    throw fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "工作区根目录是未知重解析点", "workspace_root_reparse_unsupported");
  }
  const destinationRoot = options.destinationRoot ? path.resolve(options.destinationRoot) : null;
  if (destinationRoot) await fs.promises.mkdir(destinationRoot, { recursive: false });
  let snapshotContainerCreated = false;

  const entries: ManifestEntry[] = [];
  const seenCompatibilityPaths = new Map<string, string>();
  const metadataWarnings: CollectResult["metadataWarnings"] = [];
  let metadataWarningCount = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let linkCount = 0;
  let totalBytes = 0;
  let excludedDependencyDirectoryCount = 0;
  const excludedDependencyDirectories: string[] = [];
  let hardLinkCount = 0;
  let sparseFileCount = 0;
  const progress = new ProgressReporter(options.phase, options.hooks);

  /** 递归处理单个目录；目录元数据在子项完成后应用。 */
  const walkDirectory = async (sourceDirectory: string, relativeDirectory: string): Promise<void> => {
    assertNotCancelled(options.hooks);
    await assertDirectoryInsideRoot(sourceRealRoot, sourceDirectory, relativeDirectory);
    const dirents = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
    dirents.sort((left, right) => compareBinary(left.name, right.name));
    const siblingFileNames = dirents.filter((dirent) => dirent.isFile()).map((dirent) => dirent.name);
    for (const dirent of dirents) {
      assertNotCancelled(options.hooks);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      if (isWorkspacePathIndexStorageRelPath(relativePath, { caseSensitive: options.sourceCaseSensitive })) continue;
      if (isManagedWorkspaceDbPath(relativePath, options.manifestMode, options.sourceCaseSensitive)) continue;
      const sourcePath = path.join(sourceDirectory, dirent.name);
      const sourceStat = await fs.promises.lstat(sourcePath);
      if (
        sourceStat.isDirectory()
        && !sourceStat.isSymbolicLink()
        && await isWorkspacePathIndexOnlyDirectory(sourcePath, relativePath, options.sourceCaseSensitive, options.manifestMode)
      ) continue;
      const isRegenerableDirectory = windowsExcludedDirectorySet.has(relativePath.toLowerCase())
        || Boolean(classifyWorkspaceMigrationRegenerableDirectory({
          name: dirent.name,
          isDirectory: sourceStat.isDirectory(),
          isSymbolicLink: sourceStat.isSymbolicLink(),
          siblingFileNames,
        }));
      if (options.excludeDependencyDirectories && isRegenerableDirectory) {
        excludedDependencyDirectoryCount += 1;
        if (excludedDependencyDirectories.length < MAX_EXCLUDED_DEPENDENCY_DIRECTORY_DETAILS) {
          excludedDependencyDirectories.push(relativePath);
        }
        continue;
      }
      assertSupportedWindowsReparsePoint(relativePath, sourceStat, windowsReparsePoints);
      assertCompatibleTargetPath(
        relativePath,
        compatibilityRoot,
        options.targetCaseSensitive,
        targetFileSystemType,
        seenCompatibilityPaths,
      );
      const destinationPath = destinationRoot ? resolveRelativePath(destinationRoot, relativePath) : null;

      if (sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) {
        directoryCount += 1;
        entries.push({ relativePath, kind: "directory", size: 0, contentHash: null, linkTarget: null });
        if (destinationPath) {
          await fs.promises.mkdir(destinationPath, { recursive: false, mode: (sourceStat.mode & 0o777) | 0o700 });
          if (isManagedWorkspaceDbPath(`${relativePath}/workspace.db`, options.manifestMode, options.targetCaseSensitive)) snapshotContainerCreated = true;
        }
        progress.update(fileCount, directoryCount, totalBytes);
        await walkDirectory(sourcePath, relativePath);
        if (destinationPath) {
          await fsyncDirectory(destinationPath);
          const warnings = await applyBestEffortMetadata(destinationPath, sourceStat, relativePath);
          metadataWarningCount += warnings.length;
          for (const warning of warnings) {
            if (metadataWarnings.length < MAX_METADATA_WARNING_DETAILS) metadataWarnings.push(warning);
          }
        }
        continue;
      }

      if (sourceStat.isSymbolicLink()) {
        const linkTarget = await fs.promises.readlink(sourcePath);
        const linkType = await assertSupportedLink(
          sourceRoot,
          sourceRealRoot,
          compatibilityRoot,
          sourcePath,
          relativePath,
          linkTarget,
        );
        linkCount += 1;
        entries.push({ relativePath, kind: "link", size: 0, contentHash: null, linkTarget });
        if (destinationPath) {
          await fs.promises.symlink(linkTarget, destinationPath, linkType);
        }
        progress.update(fileCount, directoryCount, totalBytes);
        continue;
      }

      if (!sourceStat.isFile()) {
        throw fileError(
          "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
          "工作区包含不支持的特殊文件",
          "special_file_unsupported",
          { relativePath },
        );
      }
      if (relativePath.toLowerCase() === ".git") {
        throw fileError(
          "WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED",
          "顶层 Git linked worktree 不支持迁移",
          "top_level_git_file",
          { relativePath },
        );
      }
      if (path.posix.basename(relativePath).toLowerCase() === ".git") {
        await assertSupportedNestedGitPointer(sourceRoot, compatibilityRoot, sourcePath, relativePath, sourceStat.size);
      }

      const fileResult = await hashOrCopyFile(
        sourcePath,
        destinationPath,
        sourceStat,
        relativePath,
        options.includeContentHashes,
        options.hooks,
        progress,
      );
      fileCount += 1;
      totalBytes = addSafeBytes(totalBytes, fileResult.size, relativePath);
      if (sourceStat.nlink > 1) hardLinkCount += 1;
      if (isSparseFile(sourceStat)) sparseFileCount += 1;
      entries.push({
        relativePath,
        kind: "file",
        size: fileResult.size,
        contentHash: fileResult.contentHash,
        linkTarget: null,
      });
      if (destinationPath) {
        const warnings = await applyBestEffortMetadata(destinationPath, sourceStat, relativePath);
        metadataWarningCount += warnings.length;
        for (const warning of warnings) {
          if (metadataWarnings.length < MAX_METADATA_WARNING_DETAILS) metadataWarnings.push(warning);
        }
      }
      progress.update(fileCount, directoryCount, totalBytes);
    }
  };

  await walkDirectory(sourceRoot, "");
  // 静态容器保留源拼写；无容器或仅受管工件时才补建快照容器。
  if (destinationRoot && options.manifestMode && !snapshotContainerCreated) await fs.promises.mkdir(path.join(destinationRoot, ".codeflowai"));
  if (destinationRoot) await fsyncDirectory(destinationRoot);
  if (destinationRoot) {
    const warnings = await applyBestEffortMetadata(destinationRoot, rootStat, ".");
    metadataWarningCount += warnings.length;
    for (const warning of warnings) {
      if (metadataWarnings.length < MAX_METADATA_WARNING_DETAILS) metadataWarnings.push(warning);
    }
  }
  progress.complete(fileCount, directoryCount, totalBytes);
  entries.sort((left, right) => compareBinary(left.relativePath, right.relativePath));
  const manifestHash = options.includeContentHashes ? hashManifest(entries) : null;
  return {
    summary: {
      manifestHash,
      fileCount,
      directoryCount,
      linkCount,
      totalBytes,
      excludedDependencyDirectoryCount,
      excludedDependencyDirectories,
      hardLinkCount,
      sparseFileCount,
      metadataLimitations: [...METADATA_LIMITATIONS],
    },
    entries,
    metadataWarningCount,
    metadataWarnings,
  };
}

/** 两个固定容器仅含索引工件时省略目录，其余静态数据仍完整迁移。 */
async function isWorkspacePathIndexOnlyDirectory(
  directoryPath: string,
  relativePath: string,
  caseSensitive: boolean,
  manifestMode?: WorkspaceMigrationManifestMode,
): Promise<boolean> {
  const comparedPath = caseSensitive ? relativePath : relativePath.toLowerCase();
  const directories = [WORKSPACE_PATH_INDEX_DIRECTORY, ".codeflowai", ".codeflow", "codeflowai", ...(manifestMode ? [".codeflowai", ".codeflow"] : [])].map(value => caseSensitive ? value : value.toLowerCase());
  if (!directories.includes(comparedPath)) return false;
  const children = await fs.promises.readdir(directoryPath);
  return children.every((name) => isWorkspacePathIndexStorageRelPath(`${relativePath}/${name}`, { caseSensitive })
    || isManagedWorkspaceDbPath(`${relativePath}/${name}`, manifestMode, caseSensitive));
}

/** 当前 Client 本地源工作区的默认大小写语义。 */
function defaultWorkspaceCaseSensitive(): boolean {
  return process.platform !== "win32" && process.platform !== "darwin";
}

function sameResolvedPath(left: string, right: string): boolean {
  const leftPath = path.resolve(left).replace(/[\\/]+$/g, "");
  const rightPath = path.resolve(right).replace(/[\\/]+$/g, "");
  return defaultWorkspaceCaseSensitive() ? leftPath === rightPath : leftPath.toLowerCase() === rightPath.toLowerCase();
}

/** 比较源和目标清单，返回有限的相对路径差异供错误原因定位。 */
function findManifestDifferencePaths(left: ManifestEntry[], right: ManifestEntry[]): string[] {
  const leftByPath = new Map(left.map((entry) => [entry.relativePath, entry]));
  const rightByPath = new Map(right.map((entry) => [entry.relativePath, entry]));
  const paths = new Set([...leftByPath.keys(), ...rightByPath.keys()]);
  return [...paths]
    .sort(compareBinary)
    .filter((relativePath) => !sameManifestEntry(leftByPath.get(relativePath), rightByPath.get(relativePath)))
    .slice(0, MAX_MANIFEST_DIFF_PATHS);
}

/** 判断两个清单项的类型、大小、链接目标和内容摘要是否一致。 */
function sameManifestEntry(left: ManifestEntry | undefined, right: ManifestEntry | undefined): boolean {
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.size === right.size
    && left.contentHash === right.contentHash
    && left.linkTarget === right.linkTarget;
}

/** 预发现 Windows 探针应跳过的可重新生成目录，不进入链接或已排除目录。 */
async function discoverRegenerableDirectories(sourceRoot: string, hooks: FileOperationHooks): Promise<string[]> {
  const result: string[] = [];

  /** 遍历普通目录并按同级项目标识收集排除路径。 */
  const walk = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
    assertNotCancelled(hooks);
    await assertDirectoryInsideRoot(sourceRoot, directoryPath, relativeDirectory);
    const dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    dirents.sort((left, right) => compareBinary(left.name, right.name));
    const siblingFileNames = dirents.filter((dirent) => dirent.isFile()).map((dirent) => dirent.name);
    for (const dirent of dirents) {
      assertNotCancelled(hooks);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      const candidatePath = path.join(directoryPath, dirent.name);
      const candidateStat = await fs.promises.lstat(candidatePath);
      if (classifyWorkspaceMigrationRegenerableDirectory({
        name: dirent.name,
        isDirectory: candidateStat.isDirectory(),
        isSymbolicLink: candidateStat.isSymbolicLink(),
        siblingFileNames,
      })) {
        result.push(relativePath);
        continue;
      }
      if (candidateStat.isDirectory() && !candidateStat.isSymbolicLink()) {
        await walk(candidatePath, relativePath);
      }
    }
  };

  await walk(sourceRoot, "");
  return result;
}

/** 以固定缓冲区读取源文件，按需写入并 fsync 目标文件。 */
async function hashOrCopyFile(
  sourcePath: string,
  destinationPath: string | null,
  lstat: fs.Stats,
  relativePath: string,
  includeContentHash: boolean,
  hooks: FileOperationHooks,
  progress: ProgressReporter,
): Promise<{ size: number; contentHash: string | null }> {
  if (!includeContentHash && !destinationPath) {
    return { size: lstat.size, contentHash: null };
  }
  const sourceHandle = await fs.promises.open(sourcePath, "r");
  let destinationHandle: fs.promises.FileHandle | null = null;
  const hash = includeContentHash ? crypto.createHash("sha256") : null;
  let bytesRead = 0;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.dev !== lstat.dev || before.ino !== lstat.ino) {
      throw fileError(
        "WORKSPACE_MIGRATION_SOURCE_CHANGED",
        "源文件在扫描期间被替换",
        "source_file_replaced",
        { relativePath },
      );
    }
    if (destinationPath) destinationHandle = await fs.promises.open(destinationPath, "wx", lstat.mode & 0o777);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    while (true) {
      assertNotCancelled(hooks);
      const read = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash?.update(chunk);
      if (destinationHandle) await writeAll(destinationHandle, chunk);
      bytesRead += read.bytesRead;
      progress.addBytes(read.bytesRead);
    }
    if (destinationHandle) await destinationHandle.sync();
    const after = await sourceHandle.stat();
    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytesRead !== after.size
    ) {
      throw fileError(
        "WORKSPACE_MIGRATION_SOURCE_CHANGED",
        "源文件在读取期间发生变化",
        "source_file_changed_while_reading",
        { relativePath },
      );
    }
    return { size: bytesRead, contentHash: hash?.digest("hex") ?? null };
  } finally {
    try {
      await destinationHandle?.close();
    } finally {
      await sourceHandle.close();
    }
  }
}

/** 完整写入一个缓冲区，处理底层短写。 */
async function writeAll(handle: fs.promises.FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const written = await handle.write(buffer, offset, buffer.length - offset, null);
    if (written.bytesWritten <= 0) throw new Error("destination file write made no progress");
    offset += written.bytesWritten;
  }
}

/** 校验相对符号链接可真实解析，且在源和最终目标中都不会逃逸。 */
async function assertSupportedLink(
  sourceRoot: string,
  sourceRealRoot: string,
  targetRoot: string,
  sourcePath: string,
  relativePath: string,
  linkTarget: string,
): Promise<"file" | "dir"> {
  if (path.isAbsolute(linkTarget) || path.win32.isAbsolute(linkTarget) || path.posix.isAbsolute(linkTarget)) {
    throw fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "绝对符号链接不支持迁移", "absolute_link", { relativePath });
  }
  const sourceResolved = path.resolve(path.dirname(resolveRelativePath(sourceRoot, relativePath)), linkTarget);
  const targetResolved = path.resolve(path.dirname(resolveRelativePath(targetRoot, relativePath)), linkTarget);
  if (!isPathWithin(sourceResolved, sourceRoot) || !isPathWithin(targetResolved, targetRoot)) {
    throw fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "符号链接指向工作区外部", "external_link", { relativePath });
  }
  let resolvedTarget: string;
  let targetStat: fs.Stats;
  try {
    resolvedTarget = await fs.promises.realpath(sourcePath);
    targetStat = await fs.promises.stat(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw fileError(
      "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
      "符号链接无法解析",
      code === "ELOOP" ? "link_cycle" : "dangling_link",
      { relativePath, osErrorCode: extractErrorCode(error) },
    );
  }
  if (!isPathWithin(resolvedTarget, sourceRealRoot)) {
    throw fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "符号链接实际指向工作区外部", "external_link", { relativePath });
  }
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "符号链接目标类型不受支持", "link_target_unsupported", { relativePath });
  }
  return targetStat.isDirectory() ? "dir" : "file";
}

/** 校验嵌套 .git 文件只引用源和目标工作区内部 gitdir。 */
async function assertSupportedNestedGitPointer(
  sourceRoot: string,
  targetRoot: string,
  sourcePath: string,
  relativePath: string,
  size: number,
): Promise<void> {
  if (size > MAX_GIT_POINTER_BYTES) {
    throw fileError("WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED", "嵌套 .git 指针文件过大", "nested_git_pointer_invalid", { relativePath });
  }
  const text = await fs.promises.readFile(sourcePath, "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/i.exec(text.trim());
  const gitDir = match?.[1] ?? "";
  if (!gitDir || path.isAbsolute(gitDir) || path.win32.isAbsolute(gitDir) || path.posix.isAbsolute(gitDir)) {
    throw fileError("WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED", "嵌套 .git 指针不受支持", "nested_git_pointer_invalid", { relativePath });
  }
  const sourceResolved = path.resolve(path.dirname(sourcePath), gitDir);
  const targetResolved = path.resolve(path.dirname(resolveRelativePath(targetRoot, relativePath)), gitDir);
  if (!isPathWithin(sourceResolved, sourceRoot) || !isPathWithin(targetResolved, targetRoot)) {
    throw fileError("WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED", "嵌套 .git 指向工作区外部", "nested_git_pointer_external", { relativePath });
  }
}

/** 校验目标路径可表达性和大小写冲突。 */
function assertCompatibleTargetPath(
  relativePath: string,
  targetRoot: string,
  targetCaseSensitive: boolean,
  targetFileSystemType: string,
  seenPaths: Map<string, string>,
): void {
  const fileSystemType = targetFileSystemType;
  const usesWindowsNaming = process.platform === "win32" || WINDOWS_NAMING_FILESYSTEMS.has(fileSystemType);
  const parts = relativePath.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("\0")) {
      throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标相对路径非法", "target_relative_path_invalid", { relativePath });
    }
    if (usesWindowsNaming) {
      if (/[<>:"/\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED_NAMES.test(part)) {
        throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标文件名在 Windows 上不可用", "target_name_invalid", { relativePath });
      }
      if (part.length > 255) {
        throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标文件名超过平台限制", "target_name_too_long", { relativePath });
      }
    } else if (Buffer.byteLength(part, "utf8") > 255) {
      throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标文件名超过平台限制", "target_name_too_long", { relativePath });
    }
  }
  const targetPath = resolveRelativePath(targetRoot, relativePath);
  const posixPathLimit = process.platform === "darwin" ? 1_024 : 4_096;
  if ((process.platform === "win32" && targetPath.length > 32_767) || (process.platform !== "win32" && Buffer.byteLength(targetPath, "utf8") > posixPathLimit)) {
    throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标路径超过平台限制", "target_path_too_long", { relativePath });
  }
  const normalizedRelativePath = DARWIN_NORMALIZING_FILESYSTEMS.has(fileSystemType)
    ? relativePath.normalize("NFD")
    : relativePath;
  const comparisonKey = targetCaseSensitive ? normalizedRelativePath : normalizedRelativePath.toUpperCase();
  const existing = seenPaths.get(comparisonKey);
  if (existing && existing !== relativePath) {
    throw fileError(
      "WORKSPACE_MIGRATION_TARGET_INVALID",
      "目标文件系统存在大小写路径冲突",
      "target_case_collision",
      { relativePaths: [existing, relativePath] },
    );
  }
  seenPaths.set(comparisonKey, relativePath);
}

/** 规范化并校验由 StorageClassifier 提供的目标文件系统类型。 */
function normalizeFileSystemType(value: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9+._-]{1,32}$/.test(normalized)) {
    throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标文件系统类型无效", "target_filesystem_invalid");
  }
  return normalized;
}

/** Windows 预检所有 reparse point；PowerShell 只返回路径和 LinkType，不把绝对路径带出 Worker。 */
async function listWindowsReparsePoints(
  sourceRoot: string,
  phase: WorkspaceMigrationFileProgress["phase"],
  excludeDependencyDirectories: boolean,
  excludedDirectories: readonly string[],
  hooks: FileOperationHooks,
): Promise<Map<string, string>> {
  assertNotCancelled(hooks);
  const executable = process.env.SystemRoot
    ? path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const output = await runWindowsReparseProbe(
    executable,
    sourceRoot,
    phase,
    excludeDependencyDirectories,
    excludedDirectories,
    hooks,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output || "[]");
  } catch (error) {
    throw fileError(
      "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
      "Windows 重解析点探测结果无效",
      "windows_reparse_probe_invalid",
      { invalidStage: "json_parse", osErrorCode: extractErrorCode(error) },
    );
  }
  const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!records) {
    throw fileError(
      "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
      "Windows 重解析点探测结果无效",
      "windows_reparse_probe_invalid",
      { invalidStage: "result_shape" },
    );
  }
  const result = new Map<string, string>();
  for (const item of records) {
    const record = item as { fullName?: unknown; linkType?: unknown } | null;
    const fullName = String(record?.fullName ?? "").trim();
    if (!fullName) {
      throw fileError(
        "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
        "Windows 重解析点探测结果无效",
        "windows_reparse_probe_invalid",
        { invalidStage: "full_name" },
      );
    }
    const relative = path.win32.relative(sourceRoot, fullName);
    if (relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
      throw fileError(
        "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
        "Windows 重解析点探测路径越界",
        "windows_reparse_probe_invalid",
        { invalidStage: "path_boundary" },
      );
    }
    const relativePath = relative ? relative.replace(/\\/g, "/").toLowerCase() : ".";
    const linkType = String(record?.linkType ?? "unknown").trim() || "unknown";
    result.set(relativePath, linkType);
  }
  return result;
}

/** 执行有超时、输出上限和取消边界的 Windows reparse point 探针。 */
async function runWindowsReparseProbe(
  executable: string,
  sourceRoot: string,
  phase: WorkspaceMigrationFileProgress["phase"],
  excludeDependencyDirectories: boolean,
  excludedDirectories: readonly string[],
  hooks: FileOperationHooks,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_REPARSE_PROBE_SCRIPT,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let pendingError: WorkspaceMigrationFileError | null = null;
    let closed = false;
    let timeout: ReturnType<typeof setTimeout>;
    let cancellation: ReturnType<typeof setInterval>;

    /** 记录首个失败并终止探针；Promise 仅在 close 后结算。 */
    const requestFailure = (error: WorkspaceMigrationFileError) => {
      if (pendingError || closed) return;
      pendingError = error;
      clearTimeout(timeout);
      clearInterval(cancellation);
      try {
        const terminated = child.kill();
        if (!terminated && child.exitCode === null && child.signalCode === null) {
          pendingError = new WorkspaceMigrationFileError(
            error.code,
            error.message,
            { ...error.details, terminationFailed: true },
          );
          child.kill("SIGKILL");
        }
      } catch (killError) {
        pendingError = new WorkspaceMigrationFileError(
          error.code,
          error.message,
          { ...error.details, terminationFailed: true, terminationOsErrorCode: extractErrorCode(killError) },
        );
      }
    };
    timeout = setTimeout(() => {
      requestFailure(fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "Windows 重解析点探测超时", "windows_reparse_probe_timeout"));
    }, WINDOWS_REPARSE_PROBE_TIMEOUT_MS);
    cancellation = setInterval(() => {
      if (hooks.isCancelled()) {
        requestFailure(fileError("WORKSPACE_MIGRATION_FILE_CANCELLED", "文件操作已取消", "operation_cancelled"));
      }
    }, 100);

    child.stdout.on("data", (chunk: Buffer) => {
      if (pendingError) return;
      outputBytes += chunk.length;
      if (outputBytes > WINDOWS_REPARSE_PROBE_OUTPUT_BYTES) {
        requestFailure(fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "Windows 重解析点探测输出过大", "windows_reparse_probe_output_limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remainingBytes = WINDOWS_REPARSE_PROBE_STDERR_BYTES - stderrBytes;
      if (remainingBytes > 0) stderrChunks.push(chunk.subarray(0, remainingBytes));
      stderrBytes += chunk.length;
      if (stderrBytes > WINDOWS_REPARSE_PROBE_STDERR_BYTES) {
        requestFailure(fileError(
          "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
          "Windows 重解析点探测错误输出过大",
          "windows_reparse_probe_stderr_limit",
          stderrDetails(stderrChunks, sourceRoot),
        ));
      }
    });
    child.stdin.once("error", (error) => {
      requestFailure(fileError(
        "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
        "Windows 重解析点探测输入失败",
        "windows_reparse_probe_stdin_failed",
        { osErrorCode: extractErrorCode(error) },
      ));
    });
    child.once("error", (error) => {
      requestFailure(fileError(
        "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
        "Windows 重解析点探测启动失败",
        "windows_reparse_probe_start_failed",
        { osErrorCode: extractErrorCode(error) },
      ));
    });
    child.once("spawn", () => {
      hooks.onProgress?.({ phase, processedFiles: 0, processedDirectories: 0, processedBytes: 0 });
    });
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      clearInterval(cancellation);
      if (pendingError) {
        reject(pendingError);
        return;
      }
      if (code !== 0) {
        reject(fileError(
          "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
          "Windows 重解析点探测失败",
          "windows_reparse_probe_failed",
          { exitCode: code, ...stderrDetails(stderrChunks, sourceRoot) },
        ));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
    child.stdin.end(JSON.stringify({
      sourceRoot,
      excludeDependencyDirectories,
      excludedDirectories,
      unconditionalDirectoryNames: UNCONDITIONAL_REGENERABLE_DIRECTORY_NAMES,
    }), "utf8");
  });
}

/** 压缩并脱敏 PowerShell stderr，供本地结构化日志定位探针失败。 */
function stderrDetails(chunks: Buffer[], sourceRoot: string): { stderrSummary?: string } {
  const stderr = Buffer.concat(chunks).toString("utf8").trim();
  if (!stderr) return {};
  const escapedRoot = sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const summary = stderr
    .replace(new RegExp(escapedRoot, "gi"), "<workspace>")
    .replace(/(?:\\\\\?\\)?[a-z]:[\\/][^\r\n]*/gi, "<path>")
    .replace(/\\\\[^\\/\r\n]+[\\/][^\r\n]*/g, "<path>")
    .replace(/\s+/g, " ")
    .slice(0, WINDOWS_REPARSE_PROBE_STDERR_SUMMARY_CHARS);
  return summary ? { stderrSummary: summary } : {};
}

/** 只允许 PowerShell 与 Node 都明确识别为 SymbolicLink 的 Windows reparse point。 */
function assertSupportedWindowsReparsePoint(
  relativePath: string,
  sourceStat: fs.Stats,
  reparsePoints: Map<string, string>,
): void {
  if (process.platform !== "win32") return;
  const linkType = reparsePoints.get(relativePath.toLowerCase());
  if (!linkType) {
    if (!sourceStat.isSymbolicLink()) return;
    throw fileError(
      "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
      "Windows 重解析点探测结果与文件状态不一致",
      "windows_reparse_probe_mismatch",
      { relativePath },
    );
  }
  if (linkType.toLowerCase() === "symboliclink" && sourceStat.isSymbolicLink()) return;
  throw fileError(
    "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
    "工作区包含不支持的 Windows 重解析点",
    "windows_reparse_unsupported",
    { relativePath, reparseType: linkType.slice(0, 64) },
  );
}

/** 应用非承诺元数据；失败转为可见 warning，不影响内容一致性。 */
async function applyBestEffortMetadata(
  destinationPath: string,
  sourceStat: fs.Stats,
  relativePath: string,
): Promise<WorkspaceMigrationMetadataWarning[]> {
  const warnings: WorkspaceMigrationMetadataWarning[] = [];
  try {
    await fs.promises.chmod(destinationPath, sourceStat.mode & 0o777);
  } catch (error) {
    warnings.push({ relativePath, operation: "chmod", errorCode: extractErrorCode(error) });
  }
  try {
    await fs.promises.utimes(destinationPath, sourceStat.atime, sourceStat.mtime);
  } catch (error) {
    warnings.push({ relativePath, operation: "utimes", errorCode: extractErrorCode(error) });
  }
  return warnings;
}

/** 校验 staging 与最终目标都在源目录外、同属一个已存在的真实父目录且尚未被占用。 */
async function assertCopyRoots(sourceRoot: string, stagingRoot: string, finalTargetRoot: string): Promise<void> {
  const sourceRealRoot = await fs.promises.realpath(sourceRoot);
  const stagingPath = path.resolve(stagingRoot);
  const finalTargetPath = path.resolve(finalTargetRoot);
  const stagingParent = await fs.promises.realpath(path.dirname(stagingPath));
  const finalTargetParent = await fs.promises.realpath(path.dirname(finalTargetPath));
  if (normalizeComparablePath(stagingParent) !== normalizeComparablePath(finalTargetParent)) {
    throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "临时目录与最终目录必须位于同一父目录", "staging_parent_mismatch");
  }
  const realStagingPath = path.join(stagingParent, path.basename(stagingPath));
  const realFinalTargetPath = path.join(finalTargetParent, path.basename(finalTargetPath));
  if (normalizeComparablePath(realStagingPath) === normalizeComparablePath(realFinalTargetPath)) {
    throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "临时目录不能与最终目录相同", "staging_target_conflict");
  }
  if (isPathWithin(realStagingPath, sourceRealRoot) || isPathWithin(realFinalTargetPath, sourceRealRoot)) {
    throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "迁移目标不能位于源工作区内", "target_inside_source");
  }
  if (await pathExists(realStagingPath)) {
    throw fileError("WORKSPACE_MIGRATION_COPY_FAILED", "迁移临时目录已存在", "staging_already_exists");
  }
  if (await pathExists(realFinalTargetPath)) {
    throw fileError("WORKSPACE_MIGRATION_TARGET_INVALID", "最终目标目录已存在", "target_already_exists");
  }
}

/** 提取可检索且不含本地路径的文件系统错误码。 */
function extractErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code ? code : "UNKNOWN";
}

/** POSIX 同步目录项；Windows 依赖文件 fsync 和重启后清单复核。 */
async function fsyncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 安全清理唯一探测目录，递归删除前验证真实父目录和名称前缀。 */
async function safeRemoveProbe(realParent: string, candidatePath: string, expectedBaseName: string): Promise<void> {
  const resolvedCandidate = path.resolve(candidatePath);
  if (path.dirname(resolvedCandidate) !== path.resolve(realParent) || !path.basename(resolvedCandidate).startsWith(expectedBaseName)) {
    throw new Error("probe cleanup path escaped target parent");
  }
  const realCandidate = await fs.promises.realpath(resolvedCandidate);
  if (path.dirname(realCandidate) !== path.resolve(realParent)) throw new Error("probe cleanup realpath escaped target parent");
  await fs.promises.rm(realCandidate, { recursive: true, force: false });
}

/** 验证目录真实路径仍位于源根内，阻止扫描期间目录被替换为外部链接。 */
async function assertDirectoryInsideRoot(realRoot: string, directoryPath: string, relativePath: string): Promise<void> {
  const realDirectory = await fs.promises.realpath(directoryPath);
  if (!isPathWithin(realDirectory, realRoot)) {
    throw fileError("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", "目录在扫描期间逃逸工作区", "directory_realpath_external", { relativePath });
  }
}

/** 计算与平台大小写语义一致的路径包含关系。 */
function isPathWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(normalizeComparablePath(rootPath), normalizeComparablePath(candidatePath));
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 归一化路径比较键，Windows 使用不区分大小写语义。 */
function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 从可信根解析 POSIX 相对清单路径，并再次验证不逃逸。 */
function resolveRelativePath(rootPath: string, relativePath: string): string {
  const resolved = path.resolve(rootPath, ...relativePath.split("/"));
  if (!isPathWithin(resolved, rootPath)) throw new Error("relative path escaped root");
  return resolved;
}

/** 按清单字段顺序计算稳定 SHA-256。 */
function hashManifest(entries: ManifestEntry[]): string {
  const hash = crypto.createHash("sha256");
  for (const entry of entries) {
    hash.update(JSON.stringify([
      entry.relativePath,
      entry.kind,
      entry.size,
      entry.contentHash,
      entry.linkTarget,
    ]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** 检查目标是否存在；仅 ENOENT 表示不存在。 */
async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
    throw error;
  }
}

/** 判断普通文件是否使用稀疏布局。 */
function isSparseFile(stat: fs.Stats): boolean {
  return stat.size > 0 && Number.isFinite(stat.blocks) && stat.blocks > 0 && stat.blocks * 512 < stat.size;
}

/** 安全累加文件总字节，超出 JSON/SQLite 精确整数范围时失败。 */
function addSafeBytes(total: number, value: number, relativePath: string): number {
  const next = total + value;
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(next)) {
    throw fileError("WORKSPACE_MIGRATION_VERIFY_FAILED", "工作区文件大小超出支持范围", "file_size_unsupported", { relativePath });
  }
  return next;
}

/** 检查调用方取消标记。 */
function assertNotCancelled(hooks: FileOperationHooks): void {
  if (hooks.isCancelled()) {
    throw fileError("WORKSPACE_MIGRATION_FILE_CANCELLED", "文件操作已取消", "operation_cancelled");
  }
}

/** 校验必填 SHA-256 摘要。 */
function assertNonEmptyHash(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/i.test(String(value ?? ""))) {
    throw fileError("WORKSPACE_MIGRATION_VERIFY_FAILED", "清单摘要非法", "manifest_hash_invalid", { field });
  }
}

/** 构造不含本地绝对路径的文件业务错误。 */
function fileError(
  code: WorkspaceMigrationFileErrorCode,
  message: string,
  reason: string,
  details: Record<string, unknown> = {},
): WorkspaceMigrationFileError {
  return new WorkspaceMigrationFileError(code, message, { reason, ...details });
}

/** 保留已分类错误；未知异常转换为阶段默认错误且通过 cause 留给 Client 本地日志。 */
function normalizeFileError(
  error: unknown,
  code: WorkspaceMigrationFileErrorCode,
  message: string,
  reason: string,
): WorkspaceMigrationFileError {
  if (error instanceof WorkspaceMigrationFileError) return error;
  return new WorkspaceMigrationFileError(code, message, { reason }, error === undefined ? undefined : { cause: error });
}

/** 二进制字符串排序，避免 locale 差异改变清单哈希。 */
function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const WINDOWS_REPARSE_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $ProbeInput = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  $Root = [string]$ProbeInput.sourceRoot
  $ExcludeDependencyDirectories = [bool]$ProbeInput.excludeDependencyDirectories
  if ([string]::IsNullOrWhiteSpace($Root)) { throw 'Root path is required' }
  $RootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  $ExcludedDirectoryPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($RelativePath in @($ProbeInput.excludedDirectories)) {
    $NormalizedRelativePath = ([string]$RelativePath).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    if (-not [string]::IsNullOrWhiteSpace($NormalizedRelativePath)) {
      $null = $ExcludedDirectoryPaths.Add([System.IO.Path]::GetFullPath([System.IO.Path]::Combine($RootItem.FullName, $NormalizedRelativePath)))
    }
  }
  $UnconditionalDirectoryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($DirectoryName in @($ProbeInput.unconditionalDirectoryNames)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$DirectoryName)) { $null = $UnconditionalDirectoryNames.Add([string]$DirectoryName) }
  }
  function Test-ExcludedDirectory([System.IO.FileSystemInfo]$Item) {
    if (-not $ExcludeDependencyDirectories -or $Item.FullName -ieq $RootItem.FullName) { return $false }
    return $UnconditionalDirectoryNames.Contains($Item.Name) -or $ExcludedDirectoryPaths.Contains([System.IO.Path]::GetFullPath($Item.FullName))
  }
  $Result = [System.Collections.Generic.List[object]]::new()
  $RootIsReparse = ($RootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  if ($RootIsReparse) {
    $Result.Add([pscustomobject]@{
      fullName = [string]$RootItem.FullName
      linkType = [string]$RootItem.LinkType
    })
  } else {
    $Pending = [System.Collections.Generic.Stack[string]]::new()
    $Pending.Push([string]$RootItem.FullName)
    while ($Pending.Count -gt 0) {
      $Current = $Pending.Pop()
      $Children = $null
      for ($Attempt = 0; $Attempt -lt 3; $Attempt++) {
        try {
          $CurrentItem = Get-Item -LiteralPath $Current -Force -ErrorAction Stop
          if (Test-ExcludedDirectory $CurrentItem) { break }
          $CurrentIsReparse = ($CurrentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
          if ($CurrentIsReparse) {
            $Result.Add([pscustomobject]@{
              fullName = [string]$CurrentItem.FullName
              linkType = [string]$CurrentItem.LinkType
            })
            break
          }
          if (-not $CurrentItem.PSIsContainer) { break }
          $EnumeratedChildren = @(Get-ChildItem -LiteralPath $Current -Force -ErrorAction Stop)
          $CurrentAfterEnumeration = Get-Item -LiteralPath $Current -Force -ErrorAction Stop
          if (Test-ExcludedDirectory $CurrentAfterEnumeration) { break }
          $CurrentBecameReparse = ($CurrentAfterEnumeration.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
          if ($CurrentBecameReparse) {
            $Result.Add([pscustomobject]@{
              fullName = [string]$CurrentAfterEnumeration.FullName
              linkType = [string]$CurrentAfterEnumeration.LinkType
            })
          } elseif ($CurrentAfterEnumeration.PSIsContainer) {
            $Children = $EnumeratedChildren
          }
          break
        } catch [System.IO.DirectoryNotFoundException], [System.Management.Automation.ItemNotFoundException] {
          try {
            $null = Get-Item -LiteralPath $Current -Force -ErrorAction Stop
          } catch [System.IO.DirectoryNotFoundException], [System.Management.Automation.ItemNotFoundException] {
            break
          }
          if ($Attempt -eq 2) { throw }
        }
      }
      if ($null -eq $Children) { continue }
      foreach ($Child in $Children) {
        if (Test-ExcludedDirectory $Child) { continue }
        $IsReparse = ($Child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        if ($IsReparse) {
          $Result.Add([pscustomobject]@{
            fullName = [string]$Child.FullName
            linkType = [string]$Child.LinkType
          })
          continue
        }
        if ($Child.PSIsContainer) {
          $Pending.Push([string]$Child.FullName)
        }
      }
    }
  }
  ConvertTo-Json -InputObject $Result -Compress -Depth 3
} catch {
  $ExceptionType = 'unknown'
  if ($null -ne $_.Exception) { $ExceptionType = [string]$_.Exception.GetType().FullName }
  $ErrorId = [string]$_.FullyQualifiedErrorId
  $Category = [string]$_.CategoryInfo.Category
  [Console]::Error.WriteLine(('probeErrorType={0}; errorId={1}; category={2}' -f $ExceptionType, $ErrorId, $Category))
  exit 1
}
`;

/** 节流发送进度；字节增量在大文件块读取时仍可触发取消反馈。 */
class ProgressReporter {
  private lastEmittedAt = 0;
  private fileCount = 0;
  private directoryCount = 0;
  private processedBytes = 0;

  constructor(
    private readonly phase: WorkspaceMigrationFileProgress["phase"],
    private readonly hooks: FileOperationHooks,
  ) {}

  /** 累加块读取字节并按节流窗口发送。 */
  addBytes(bytes: number): void {
    this.processedBytes += bytes;
    this.emit(false);
  }

  /** 更新文件和目录计数并按节流窗口发送。 */
  update(fileCount: number, directoryCount: number, processedBytes: number): void {
    this.fileCount = fileCount;
    this.directoryCount = directoryCount;
    this.processedBytes = Math.max(this.processedBytes, processedBytes);
    this.emit(false);
  }

  /** 强制发送最终进度。 */
  complete(fileCount: number, directoryCount: number, processedBytes: number): void {
    this.fileCount = fileCount;
    this.directoryCount = directoryCount;
    this.processedBytes = Math.max(this.processedBytes, processedBytes);
    this.emit(true);
  }

  /** 构造并发送当前进度。 */
  private emit(force: boolean): void {
    if (!this.hooks.onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastEmittedAt < PROGRESS_INTERVAL_MS) return;
    this.lastEmittedAt = now;
    this.hooks.onProgress({
      phase: this.phase,
      processedFiles: this.fileCount,
      processedDirectories: this.directoryCount,
      processedBytes: this.processedBytes,
    });
  }
}
