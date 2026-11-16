import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  isWorkspaceDirectoryMigrationTerminalState,
  type WorkspaceDirectoryMigrationErrorCode,
  type WorkspaceDirectoryMigrationState,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import {
  WorkspaceDirectoryMigrationRepoError,
  type WorkspaceDirectoryMigrationRecord,
} from "../db/repos/workspaceDirectoryMigrationRepo.js";
import { isWorkspacePathIndexStorageRelPath, workspacePathIndexDatabasePath } from "../fs/workspacePathIndexConfig.js";
import {
  assertWorkspaceRootAvailable,
  WorkspaceRootConflictError,
} from "../fs/workspaceRootOwnership.js";
import { logger } from "../logger.js";
import type { ThreadQueueDispatcher } from "../queue/threadQueueDispatcher.js";
import type { ScheduledTaskScheduler } from "../scheduled-tasks/scheduledTaskScheduler.js";
import { StorageClassifier, StorageClassifierError, type StorageClassification } from "./storageClassifier.js";
import {
  WorkspaceMigrationFileClientError,
  WorkspaceMigrationFileWorkerClient,
  type WorkspaceMigrationFileTask,
  type WorkspaceMigrationFileWatcher,
} from "./workspaceMigrationFileWorkerClient.js";
import type { WorkspaceMigrationManifestSummary, WorkspaceMigrationProbeResult, WorkspaceMigrationSnapshotResult } from "./workspaceMigrationFileProtocol.js";
import {
  WorkspaceMigrationActivityInspector,
  type WorkspaceMigrationActivityBlocker,
} from "./workspaceMigrationActivityInspector.js";
import { WorkspaceOperationGate, WorkspaceOperationGateError } from "./workspaceOperationGate.js";
import { isPathInsideRegenerableDirectory } from "./workspaceMigrationRegenerableDirectories.js";
import { isManagedWorkspaceDbPath, type WorkspaceMigrationManifestMode } from "./workspaceMigrationFileProtocol.js";
import { assertDatabaseRoots, assertDbArtifactsAbsent, assertSameDatabaseMetadata, inspectDatabaseFile } from "./workspaceMigrationFileOps.js";

const MINIMUM_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;
const SPACE_MARGIN_RATIO = 0.05;
const AWAITING_CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_PERSIST_INTERVAL_MS = 250;
const WINDOWS_RESERVED_TARGET_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_NAMING_FILESYSTEMS = new Set(["exfat", "fat", "fat32", "msdos", "ntfs", "ntfs3", "vfat"]);
const MAX_SOURCE_CHANGE_PATHS = 50;

type FileTask = WorkspaceMigrationFileTask<unknown>;
type MigrationDatabaseAccess = <T>(operation: () => T) => Promise<T>;

type SourceChangeEvidence = {
  count: number;
  paths: string[];
};

type OperationRuntime = {
  finalHandoff: { complete: () => void; fail: (error: unknown) => void } | null;
  handoffDeadline: number | null;
  requestId: string;
  cancelRequested: boolean;
  sourceDirty: boolean;
  targetDirty: boolean;
  targetChangeCount: number;
  targetBaselineReady: boolean;
  watcherError: WorkspaceMigrationFileClientError | null;
  sourceChangeEvidence: SourceChangeEvidence;
  sourceWatcher: WorkspaceMigrationFileWatcher | null;
  targetWatcher: WorkspaceMigrationFileWatcher | null;
  confirmedRegenerableDirectories: string[];
  regenerableDirectoriesConfirmed: boolean;
  sourceDirtyBeforeRegenerableConfirmation: boolean;
};

type RuntimeTreeScan = (
  root: string,
  excludeDependencyDirectories: boolean,
) => Promise<{ summary: WorkspaceMigrationManifestSummary }>;

export type WorkspaceMigrationIndexReservation =
  | { kind: "not_applicable" }
  | {
    kind: "pending";
    generation: number;
    start: () => void;
    cancel: () => void;
  };

export type WorkspaceMigrationIndexCoordinator = {
  /** 作废旧索引并预留最终 generation；尚不启动 Worker。 */
  reserveForMigration: (operation: WorkspaceDirectoryMigrationRecord) => Promise<WorkspaceMigrationIndexReservation>;
  waitForIdle?: () => Promise<void>;
};

export type WorkspaceMigrationServiceOptions = {
  db: ClientDb;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  gate: WorkspaceOperationGate;
  activityInspector: WorkspaceMigrationActivityInspector;
  fileWorker?: WorkspaceMigrationFileWorkerClient;
  storageClassifier?: StorageClassifier;
  indexCoordinator: WorkspaceMigrationIndexCoordinator;
  workspaces: Map<WorkspaceId, string>;
  queueDispatcher?: Pick<ThreadQueueDispatcher, "resumeWorkspace"> | null;
  scheduledTaskScheduler?: Pick<ScheduledTaskScheduler, "resumeWorkspace"> | null;
  disposeWorkspaceSessions?: (workspaceId: WorkspaceId) => Promise<void>;
  prepareWorkspaceIndex?: (workspaceId: WorkspaceId) => Promise<() => void>;
  onCommittedPath?: (operation: WorkspaceDirectoryMigrationRecord) => void | Promise<void>;
  onOperationChanged?: (operation: WorkspaceDirectoryMigrationRecord) => void;
  onFatalError?: (error: Error) => void;
  now?: () => number;
  platform?: NodeJS.Platform;
};

/** 服务层业务错误；未知异常必须先落为明确迁移状态再由调用边界处理。 */
export class WorkspaceMigrationServiceError extends Error {
  constructor(
    public readonly code: WorkspaceDirectoryMigrationErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceMigrationServiceError";
  }
}

/** 目录迁移主线程状态机；Worker 只做文件重任务，本类独占 SQLite 与 Map 提交。 */
export class WorkspaceMigrationService {
  private readonly fileWorker: WorkspaceMigrationFileWorkerClient;
  private readonly storageClassifier: StorageClassifier;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly running = new Map<string, Promise<void>>();
  private readonly activeTasks = new Map<string, FileTask>();
  private readonly runtimes = new Map<string, OperationRuntime>();
  private readonly exclusiveReleases = new Map<string, () => void>();
  private readonly confirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  /** 统一关闭开始即同步封住新迁移，取消自有任务并拒绝交接等待者。 */
  stop(): void {
    this.stopped = true;
    for (const timer of this.confirmationTimers.values()) clearTimeout(timer);
    this.confirmationTimers.clear();
    for (const [operationId, runtime] of this.runtimes) {
      runtime.cancelRequested = true;
      for (const workspaceId of this.options.workspaces.keys()) {
        if (this.options.gate.getMigrationOperationId(workspaceId) === operationId) {
          this.options.gate.failFinalHandoff(workspaceId, operationId, new Error("WORKSPACE_MIGRATION_STOPPED"));
        }
      }
    }
    for (const task of this.activeTasks.values()) task.cancel();
  }

  /** 沿原任务集合严格排空；未关闭资源或失败不得被 index 当作已可关库。 */
  async stopAndDrain(): Promise<void> {
    this.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let results: PromiseSettledResult<void>[];
    try {
      results = await Promise.race([(async () => {
        const settled: PromiseSettledResult<void>[] = [];
        while (this.running.size) settled.push(...await Promise.allSettled([...this.running.values()]));
        return settled;
      })(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_RECOVERY_REQUIRED", "目录迁移资源未在关闭预算内排空", {
          reason: "workspace_migration_drain_timeout", operationIds: [...this.running.keys()], activeTaskOperationIds: [...this.activeTasks.keys()],
        })), 30_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    for (const runtime of this.runtimes.values()) {
      try { await stopWatchers(runtime); } catch (error) { failures.push(error); }
    }
    if (this.activeTasks.size || [...this.runtimes.values()].some(runtime => runtime.sourceWatcher || runtime.targetWatcher)) failures.push(new Error("WORKSPACE_MIGRATION_RESOURCES_NOT_DRAINED"));
    if (failures.length) throw new AggregateError(failures, "WORKSPACE_MIGRATION_DRAIN_FAILED", { cause: failures[0] });
  }

  /** 停止后所有会启动或改变迁移的入口显式失败。 */
  private assertAccepting(): void {
    if (this.stopped) throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_BUSY", "目录迁移已停止受理", { reason: "workspace_migration_stopped" });
  }

  constructor(private readonly options: WorkspaceMigrationServiceOptions) {
    this.fileWorker = options.fileWorker ?? new WorkspaceMigrationFileWorkerClient();
    this.storageClassifier = options.storageClassifier ?? new StorageClassifier();
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
  }

  /** 迁移持久状态和同步业务校验独立准入，文件任务与网络等待不持许可。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.options.withLegacyDatabase ? this.options.withLegacyDatabase("workspace-migration", operation) : operation();
  }

  /** 幂等创建预检；准入等待也先登记，关闭能收齐其派生的扫描owner。 */
  async prepare(input: {
    requestId: string;
    workspaceId: WorkspaceId;
    idempotencyKey: string;
    targetParentPath: string;
    targetDirectoryName: string;
  }): Promise<WorkspaceDirectoryMigrationRecord> {
    this.assertAccepting();
    const execution = this.prepareOnce(input);
    this.trackExecution(`prepare:${randomUUID()}`, execution.then(() => undefined));
    return await execution;
  }

  /** 写入前复核关闭闸门，许可等待期间停止不能创建迟到operation。 */
  private async prepareOnce(input: Parameters<WorkspaceMigrationService["prepare"]>[0]): Promise<WorkspaceDirectoryMigrationRecord> {
    const workspace = (await this.withDatabase(() => this.options.db.workspaces.get(input.workspaceId)));
    if (!workspace) {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_NOT_FOUND",
        `工作区不存在：workspaceId=${input.workspaceId}`,
        { workspaceId: input.workspaceId },
      );
    }
    const target = resolveTargetPaths({
      sourcePath: workspace.path,
      targetParentPath: input.targetParentPath,
      targetDirectoryName: input.targetDirectoryName,
      platform: this.platform,
    });
    (await this.withDatabase(() => this.assertTargetWorkspaceRootAvailable({
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      operationId: null,
      targetPath: target.targetPath,
      phase: "prepare",
      allowMissingLeaf: true,
    })));
    const created = await this.withDatabase(() => {
      this.assertAccepting();
      return this.options.db.workspaceDirectoryMigrations.create({
      idempotencyKey: input.idempotencyKey,
      workspaceId: input.workspaceId,
      sourcePath: workspace.path,
      targetParentPath: target.targetParentPath,
      targetPath: target.targetPath,
      now: this.now(),
      workspaceDbSnapshot: { formatVersion: 1, state: "pending" },
      });
    });
    if (created.idempotent) {
      return (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(created.operation.operationId)));
    }

    const operationId = created.operation.operationId;
    const execution = this.runPreflight(input.requestId, created.operation).catch((error) => (
      this.handleFatalExecutionFailure(input.requestId, operationId, error)
    ));
    this.trackExecution(operationId, execution);
    return created.operation;
  }

  /** 原子登记 Server 生成的 prepared start attempt。 */
  prepareStartAttempt(input: {
    operationId: string;
    startAttemptId: string;
    externalWritesPausedConfirmed: boolean;
    targetNotSyncManagedConfirmed: boolean;
  }): WorkspaceDirectoryMigrationRecord {
    this.assertAccepting();
    return this.emitChanged(this.options.db.workspaceDirectoryMigrations.prepareStartAttempt({
      ...input,
      now: this.now(),
    }));
  }

  /** 接受 prepared attempt 后后台推进迁移；返回时已持久化 preparing。 */
  executeStart(input: {
    requestId: string;
    operationId: string;
    startAttemptId: string;
    expectedStateVersion: number;
  }): WorkspaceDirectoryMigrationRecord {
    this.assertAccepting();
    const accepted = this.emitChanged(this.options.db.workspaceDirectoryMigrations.acceptStartAttempt({
      operationId: input.operationId,
      startAttemptId: input.startAttemptId,
      expectedStateVersion: input.expectedStateVersion,
      now: this.now(),
    }));
    const execution = this.runAcceptedOperation(input.requestId, accepted).catch((error) => (
      this.handleFatalExecutionFailure(input.requestId, input.operationId, error)
    ));
    this.trackExecution(input.operationId, execution);
    return accepted;
  }

  /** fence 尚未接受的 start attempt；迟到 execute 将因 disposition 不匹配失败。 */
  fenceStartAttempt(input: {
    operationId: string;
    startAttemptId: string;
    expectedStateVersion: number;
  }): WorkspaceDirectoryMigrationRecord {
    return this.emitChanged(this.options.db.workspaceDirectoryMigrations.fenceStartAttempt({
      ...input,
      now: this.now(),
    }));
  }

  /** 取消尚未越过提交点的操作；运行中 Worker 通过共享取消位收敛。 */
  async cancel(input: { requestId: string; operationId: string; reason?: string }): Promise<WorkspaceDirectoryMigrationRecord> {
    const current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(input.operationId)));
    if (isWorkspaceDirectoryMigrationTerminalState(current.state)) return current;
    const reason = String(input.reason ?? "user_cancelled").trim() || "user_cancelled";
    if (current.state === "awaiting_confirmation") {
      this.clearConfirmationTimer(current.operationId);
      const cancelled = current.startDisposition === "prepared" && current.startAttemptId
        ? (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.fencePreparedAttemptAndCancel({
          operationId: current.operationId,
          startAttemptId: current.startAttemptId!,
          expectedStateVersion: current.stateVersion,
          cancellationReason: reason,
          now: this.now(),
        })))
        : (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.transitionState({
          operationId: current.operationId,
          expectedState: current.state,
          expectedStateVersion: current.stateVersion,
          nextState: "cancelled",
          patch: { cancellationReason: reason },
          now: this.now(),
        })));
      return (await this.withDatabase(() => this.emitChanged(cancelled)));
    }
    if (current.state !== "scanning" && current.state !== "copying" && current.state !== "verifying") {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_CANCEL_NOT_ALLOWED",
        `当前迁移阶段不可取消：state=${current.state}`,
        { operationId: current.operationId, state: current.state },
      );
    }
    const runtime = this.runtimes.get(current.operationId);
    if (runtime) runtime.cancelRequested = true;
    this.activeTasks.get(current.operationId)?.cancel();
    const pending = this.running.get(current.operationId);
    if (pending) await pending;
    return (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(current.operationId)));
  }

  /** 重新复核 recovery_required；只有能证明目标一致时才继续前滚或提交路径。 */
  async recover(input: { requestId: string; operationId: string }): Promise<WorkspaceDirectoryMigrationRecord> {
    this.assertAccepting();
    if (this.running.has(input.operationId)) throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_BUSY", "目录迁移已有后台执行", { operationId: input.operationId });
    const execution = this.recoverOperation(input);
    this.trackExecution(input.operationId, execution.then(() => undefined));
    return await execution;
  }

  /** 人工恢复沿同一任务 owner，关闭流程可以完整等待其只读校验和提交。 */
  private async recoverOperation(input: { requestId: string; operationId: string }): Promise<WorkspaceDirectoryMigrationRecord> {
    const initial = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(input.operationId)));
    if (initial.state !== "recovery_required") {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_STATE_CONFLICT",
        `当前迁移状态不可恢复：operationId=${input.operationId}, state=${initial.state}`,
        { operationId: input.operationId, state: initial.state },
      );
    }

    const runtime = createRuntime(input.requestId);
    this.runtimes.set(initial.operationId, runtime);
    try {
      const workspace = (await this.withDatabase(() => this.options.db.workspaces.get(initial.workspaceId)));
      if (!workspace) {
        throw new WorkspaceMigrationServiceError(
          "WORKSPACE_MIGRATION_NOT_FOUND",
          `恢复时工作区不存在：workspaceId=${initial.workspaceId}`,
          { operationId: initial.operationId, workspaceId: initial.workspaceId },
        );
      }

      (await this.withDatabase(() => this.assertTargetWorkspaceRootAvailable({
        requestId: input.requestId,
        workspaceId: initial.workspaceId,
        operationId: initial.operationId,
        targetPath: initial.targetPath,
        phase: "commit",
        allowMissingLeaf: false,
        recoveryMode: "manual",
      })));

      if (pathsEqual(workspace.path, initial.targetPath, this.platform)) {
        await assertCommittedTargetValid({
          withDatabase: operation => this.withDatabase(operation),
          db: this.options.db,
          worker: this.fileWorker,
          classifier: this.storageClassifier,
          operation: initial,
          platform: this.platform,
          runTask: task => this.runTask(initial.operationId, task),
        });
        (await this.withDatabase(() => this.assertTargetWorkspaceRootAvailable({
          requestId: input.requestId,
          workspaceId: initial.workspaceId,
          operationId: initial.operationId,
          targetPath: initial.targetPath,
          phase: "commit",
          allowMissingLeaf: false,
          recoveryMode: "manual",
        })));
        const finalizing = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.transitionState({
          operationId: initial.operationId,
          expectedState: "recovery_required",
          expectedStateVersion: initial.stateVersion,
          nextState: "finalizing",
          now: this.now(),
        })));
        this.options.workspaces.set(finalizing.workspaceId, finalizing.targetPath);
        (await this.withDatabase(() => this.emitChanged(finalizing)));
        await this.finalizeCommittedOperation(input.requestId, finalizing);
        return (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(initial.operationId)));
      }

      const stagingPath = initial.stagingPath ?? buildStagingPath(initial, this.platform);
      if (pathExists(stagingPath)) {
        throw new WorkspaceMigrationServiceError(
          "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
          "恢复时发现未处理的 staging 目录，禁止在证据不足时提交路径",
          { operationId: initial.operationId, stagingExists: true },
        );
      }
      if (initial.workspaceDbSnapshot?.state === "pending") {
        const failed = await failPendingDatabaseTarget(this.options.db, this.fileWorker, this.storageClassifier, initial, input.requestId, this.now, this.platform,
          task => this.runTask(initial.operationId, task), operation => this.withDatabase(operation));
        (await this.withDatabase(() => this.emitChanged(failed))); this.releaseExclusive(failed);
        return failed;
      }
      const context = await resolveStorageContext(
        this.storageClassifier,
        this.fileWorker,
        initial,
        this.platform,
        task => this.runTask(initial.operationId, task),
      );
      runtime.sourceWatcher = this.createSourceWatcher(initial, runtime);
      runtime.targetWatcher = this.createPublishedTargetWatcher(initial, context.probe.caseSensitive, runtime);
      await Promise.all([runtime.sourceWatcher.ready, runtime.targetWatcher.ready]);
      const verification = await verifyPersistedOperation(this.fileWorker, context, initial, task => this.runTask(initial.operationId, task));
      runtime.confirmedRegenerableDirectories = [...verification.sourceSummary.excludedDependencyDirectories];
      runtime.regenerableDirectoriesConfirmed = true;
      await this.assertRuntimeClean(
        initial,
        runtime,
        context,
        requireManifestHash(verification.sourceSummary.manifestHash, initial.operationId, "source"),
        requireManifestHash(verification.targetSummary.manifestHash, initial.operationId, "target"),
      );
      const terminalPlan = (await this.withDatabase(() => buildTerminalCwdPlan(this.options.db, initial, this.platform, initial.operationId)));
      (await this.withDatabase(() => this.assertTargetWorkspaceRootAvailable({
        requestId: input.requestId,
        workspaceId: initial.workspaceId,
        operationId: initial.operationId,
        targetPath: initial.targetPath,
        phase: "commit",
        allowMissingLeaf: false,
        recoveryMode: "manual",
      })));
      this.assertCommitRuntime(initial, runtime);
      if (initial.workspaceDbSnapshot) assertSnapshotMetadata(initial, initial.workspaceDbSnapshot);
      const committed = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.commitPath({
        operationId: initial.operationId,
        expectedState: "recovery_required",
        expectedStateVersion: initial.stateVersion,
        terminalCwdTargets: terminalPlan.targets,
        now: this.now(),
      })));
      this.options.workspaces.set(committed.workspaceId, committed.targetPath);
      (await this.withDatabase(() => this.emitChanged(committed)));
      await stopWatchersAfterCommit(runtime, input.requestId, committed);
      await this.finalizeCommittedOperation(input.requestId, committed);
      return (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(initial.operationId)));
    } catch (error) {
      const failure = toServiceError(error, "WORKSPACE_MIGRATION_RECOVERY_REQUIRED");
      const current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(initial.operationId)));
      if (current.state === "recovery_required") {
        const updated = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.updateCurrentState({
          operationId: current.operationId,
          expectedState: "recovery_required",
          expectedStateVersion: current.stateVersion,
          patch: {
            errorCode: failure.code,
            errorMessage: failure.message,
            errorDetails: failure.details,
          },
          now: this.now(),
        })));
        (await this.withDatabase(() => this.emitChanged(updated)));
        this.logFailure(input.requestId, updated, failure);
      } else if (current.state === "finalizing") {
        const isolated = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
          operationId: current.operationId,
          expectedState: "finalizing",
          expectedStateVersion: current.stateVersion,
          nextState: "recovery_required",
          patch: {
            errorCode: "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
            errorMessage: failure.message,
            errorDetails: failure.details,
          },
          now: this.now(),
        }))));
        this.logFailure(input.requestId, isolated, failure);
      }
      throw failure;
    } finally {
      try {
        await stopWatchers(runtime);
      } finally {
        if (!this.activeTasks.has(initial.operationId) && !runtime.sourceWatcher && !runtime.targetWatcher) this.runtimes.delete(initial.operationId);
      }
    }
  }

  /** 等待指定 operation 的当前后台执行结束，供关闭和测试使用。 */
  async waitForIdle(operationId: string): Promise<void> {
    await this.running.get(operationId);
  }

  /** 启动完成前恢复仍需隔离的迁移门禁。 */
  restoreExclusiveLocks(): void {
    for (const operation of this.options.db.workspaceDirectoryMigrations.listActive()) {
      if (!requiresExclusiveGate(operation.state)) continue;
      if (this.exclusiveReleases.has(operation.operationId)) continue;
      const release = this.options.gate.restoreMigration(operation.workspaceId, operation.operationId);
      this.exclusiveReleases.set(operation.operationId, release);
    }
  }

  /** 对 path_committed/finalizing 执行纯前滚收尾；recovery_required 需由后续恢复 API 先定向。 */
  resumeFinalization(requestId: string): void {
    this.assertAccepting();
    for (const operation of this.options.db.workspaceDirectoryMigrations.listActive()) {
      if (operation.state !== "path_committed" && operation.state !== "finalizing") continue;
      const execution = this.finalizeCommittedOperation(requestId, operation).catch((error) => {
        return this.handleFatalExecutionFailure(requestId, operation.operationId, error);
      });
      this.trackExecution(operation.operationId, execution);
    }
  }

  /** 预检扫描：目标分类、路径能力、空间和源清单任一失败均显式落为 failed。 */
  private async runPreflight(requestId: string, initial: WorkspaceDirectoryMigrationRecord): Promise<void> {
    const runtime = createRuntime(requestId);
    this.runtimes.set(initial.operationId, runtime);
    try {
      assertPathAbsent(initial.targetPath, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
      (await this.withDatabase(() => assertWorkspaceTerminalCwds(this.options.db, initial, this.platform, null)));
      const storage = await this.storageClassifier.assertSupportedTarget(initial.targetParentPath);
      assertTargetDirectoryNameCompatible(initial, storage.fileSystemType, this.platform);
      let probe = await this.runProbe(initial, false);
      const scanTask = this.fileWorker.scan({
        manifestMode: manifestMode(initial),
        sourceRoot: initial.sourcePath,
        targetRoot: initial.targetPath,
        targetFileSystemType: storage.fileSystemType,
        includeContentHashes: false,
        targetCaseSensitive: probe.caseSensitive,
      });
      const scan = await this.runTask(initial.operationId, scanTask);
      this.logDependencyExclusions(requestId, initial, scan.summary, "preflight");
      if (scan.summary.linkCount > 0) probe = await this.runProbe(initial, true);
      assertSpaceAvailable(initial.operationId, scan.summary.totalBytes, probe.availableBytes);
      let current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(initial.operationId)));
      if (runtime.cancelRequested) {
        current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.transitionState({
          operationId: current.operationId,
          expectedState: "scanning",
          expectedStateVersion: current.stateVersion,
          nextState: "cancelled",
          patch: { cancellationReason: "user_cancelled" },
          now: this.now(),
        })));
      } else {
        current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.transitionState({
          operationId: current.operationId,
          expectedState: "scanning",
          expectedStateVersion: current.stateVersion,
          nextState: "awaiting_confirmation",
          patch: {
            sourceFileCount: scan.summary.fileCount,
            sourceDirectoryCount: scan.summary.directoryCount,
            sourceTotalBytes: scan.summary.totalBytes,
            excludedDependencyDirectoryCount: scan.summary.excludedDependencyDirectoryCount,
            excludedDependencyDirectories: scan.summary.excludedDependencyDirectories,
          },
          now: this.now(),
        })));
        (await this.withDatabase(() => this.scheduleConfirmationExpiry(current)));
      }
      (await this.withDatabase(() => this.emitChanged(current)));
    } catch (error) {
      await this.settlePreflightFailure(requestId, initial.operationId, runtime, error);
    } finally {
      if (!this.activeTasks.has(initial.operationId)) this.runtimes.delete(initial.operationId);
    }
  }

  /** accepted 后执行唯一状态机，提交点前失败回源，提交点后只前滚或隔离。 */
  private async runAcceptedOperation(requestId: string, initial: WorkspaceDirectoryMigrationRecord): Promise<void> {
    const runtime = createRuntime(requestId);
    this.runtimes.set(initial.operationId, runtime);
    try {
      this.clearConfirmationTimer(initial.operationId);
      await this.acquireExclusive(initial);
      const blockers = (await this.withDatabase(() => this.options.activityInspector.inspect(initial.workspaceId)));
      if (blockers.length > 0) throw activeResourcesError(initial, blockers);

      const storage = await this.storageClassifier.assertSupportedTarget(initial.targetParentPath);
      assertTargetDirectoryNameCompatible(initial, storage.fileSystemType, this.platform);
      assertPathAbsent(initial.targetPath, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
      const stagingPath = buildStagingPath(initial, this.platform);
      assertPathAbsent(stagingPath, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
      runtime.sourceWatcher = this.createSourceWatcher(initial, runtime);
      await runtime.sourceWatcher.ready;
      let probe = await this.runProbe(initial, false);

      const sourceScan = await this.runTask(initial.operationId, this.fileWorker.scan({
        manifestMode: manifestMode(initial),
        sourceRoot: initial.sourcePath,
        targetRoot: initial.targetPath,
        targetFileSystemType: storage.fileSystemType,
        includeContentHashes: true,
        targetCaseSensitive: probe.caseSensitive,
      }));
      runtime.confirmedRegenerableDirectories = [...sourceScan.summary.excludedDependencyDirectories];
      runtime.regenerableDirectoriesConfirmed = true;
      this.logDependencyExclusions(requestId, initial, sourceScan.summary, "execution");
      if (sourceScan.summary.linkCount > 0) probe = await this.runProbe(initial, true);
      assertSpaceAvailable(initial.operationId, sourceScan.summary.totalBytes, probe.availableBytes);
      await this.assertRuntimeClean(
        initial,
        runtime,
        { storage, probe },
        requireManifestHash(sourceScan.summary.manifestHash, initial.operationId, "source"),
      );
      const terminalPlan = (await this.withDatabase(() => buildTerminalCwdPlan(this.options.db, initial, this.platform, initial.operationId)));

      let current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.updateCurrentState({
        operationId: initial.operationId,
        expectedState: "preparing",
        expectedStateVersion: initial.stateVersion,
        patch: {
          stagingPath,
          sourceFileCount: sourceScan.summary.fileCount,
          sourceDirectoryCount: sourceScan.summary.directoryCount,
          sourceTotalBytes: sourceScan.summary.totalBytes,
          excludedDependencyDirectoryCount: sourceScan.summary.excludedDependencyDirectoryCount,
          excludedDependencyDirectories: sourceScan.summary.excludedDependencyDirectories,
          sourceManifestHash: requireManifestHash(sourceScan.summary.manifestHash, initial.operationId, "source"),
          terminalCwdSnapshot: terminalPlan.snapshot,
        },
        now: this.now(),
      })));
      current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
        operationId: current.operationId,
        expectedState: "preparing",
        expectedStateVersion: current.stateVersion,
        nextState: "copying",
        now: this.now(),
      }))));

      current = await this.copyWithProgress(requestId, current, storage, probe);
      current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
        operationId: current.operationId,
        expectedState: "copying",
        expectedStateVersion: current.stateVersion,
        nextState: "verifying",
        now: this.now(),
      }))));
      const verified = await this.runTask(current.operationId, this.fileWorker.verify({
        manifestMode: manifestMode(current),
        sourceRoot: current.sourcePath,
        targetRoot: stagingPath,
        targetFileSystemType: storage.fileSystemType,
        expectedSourceManifestHash: requireManifestHash(current.sourceManifestHash, current.operationId, "source"),
        targetCaseSensitive: probe.caseSensitive,
      }));
      await this.assertRuntimeClean(
        current,
        runtime,
        { storage, probe },
        requireManifestHash(verified.sourceSummary.manifestHash, current.operationId, "source"),
        requireManifestHash(verified.targetSummary.manifestHash, current.operationId, "target"),
      );
      current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
        operationId: current.operationId,
        expectedState: "verifying",
        expectedStateVersion: current.stateVersion,
        nextState: "publish_intent",
        patch: { verifiedTargetManifestHash: verified.targetManifestHash },
        now: this.now(),
      }))));

      runtime.targetWatcher = this.createTargetWatcher(current, probe.caseSensitive, runtime);
      await runtime.targetWatcher.ready;
      (await this.withDatabase(() => this.assertTargetWorkspaceRootAvailable({
        requestId,
        workspaceId: current.workspaceId,
        operationId: current.operationId,
        targetPath: current.targetPath,
        phase: "publish",
        allowMissingLeaf: true,
      })));
      await renamePublishedTarget(current, this.platform);
      await runtime.targetWatcher.stop();
      runtime.targetWatcher = this.createPublishedTargetWatcher(current, probe.caseSensitive, runtime);
      await runtime.targetWatcher.ready;
      const published = await this.verifyOperationTrees(current, storage, probe);
      runtime.targetBaselineReady = true;
      await this.assertRuntimeClean(
        current,
        runtime,
        { storage, probe },
        requireManifestHash(published.sourceSummary.manifestHash, current.operationId, "source"),
        requireManifestHash(published.targetSummary.manifestHash, current.operationId, "target"),
      );
      current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
        operationId: current.operationId,
        expectedState: "publish_intent",
        expectedStateVersion: current.stateVersion,
        nextState: "target_ready",
        patch: { verifiedTargetManifestHash: published.targetManifestHash },
        now: this.now(),
      }))));

      await this.options.disposeWorkspaceSessions?.(current.workspaceId);
      const finalVerification = await this.verifyOperationTrees(current, storage, probe);
      await this.assertRuntimeClean(
        current,
        runtime,
        { storage, probe },
        requireManifestHash(finalVerification.sourceSummary.manifestHash, current.operationId, "source"),
        requireManifestHash(finalVerification.targetSummary.manifestHash, current.operationId, "target"),
      );
      (await this.withDatabase(() => this.assertTargetWorkspaceRootAvailable({
        requestId,
        workspaceId: current.workspaceId,
        operationId: current.operationId,
        targetPath: current.targetPath,
        phase: "commit",
        allowMissingLeaf: false,
      })));
      const snapshotEvidence = current.workspaceDbSnapshot ? await this.snapshotFinalDatabase(current, runtime) : null;
      if (snapshotEvidence) await this.assertRuntimeClean(current, runtime, { storage, probe },
        requireManifestHash(finalVerification.sourceSummary.manifestHash, current.operationId, "source"),
        requireManifestHash(finalVerification.targetSummary.manifestHash, current.operationId, "target"));
      (await this.withDatabase(() => assertWorkspaceTerminalCwds(this.options.db, current, this.platform, current.operationId)));
      this.assertCommitRuntime(current, runtime);
      if (snapshotEvidence) {
        assertSnapshotMetadata(current, snapshotEvidence);
        current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.updateCurrentState({ operationId: current.operationId,
          expectedState: current.state, expectedStateVersion: current.stateVersion, patch: { workspaceDbSnapshot: snapshotEvidence }, now: this.now() })));
      }
      current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.commitPath({
        operationId: current.operationId,
        expectedState: "target_ready",
        expectedStateVersion: current.stateVersion,
        terminalCwdTargets: terminalPlan.targets,
        now: this.now(),
      })));
      this.options.workspaces.set(current.workspaceId, current.targetPath);
      runtime.finalHandoff?.complete(); runtime.finalHandoff = null;
      (await this.withDatabase(() => this.emitChanged(current)));
      await stopWatchersAfterCommit(runtime, requestId, current);
      current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
        operationId: current.operationId,
        expectedState: "path_committed",
        expectedStateVersion: current.stateVersion,
        nextState: "finalizing",
        now: this.now(),
      }))));
      await this.finalizeCommittedOperation(requestId, current);
    } catch (error) {
      runtime.finalHandoff?.fail(error);
      await this.settleExecutionFailure(requestId, initial.operationId, runtime, error);
    } finally {
      try {
        await stopWatchers(runtime);
      } catch (error) {
        const current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(initial.operationId)));
        if (current.state !== "recovery_required" && !isWorkspaceDirectoryMigrationTerminalState(current.state)) {
          await this.settleExecutionFailure(requestId, initial.operationId, runtime, error);
        }
      }
      if (!this.activeTasks.has(initial.operationId) && !runtime.sourceWatcher && !runtime.targetWatcher) this.runtimes.delete(initial.operationId);
    }
  }

  /** 最终 30 秒预算覆盖 DB Worker；失败等待真实 exit，未收口保留原 activeTask/owner。 */
  private async snapshotFinalDatabase(operation: WorkspaceDirectoryMigrationRecord, runtime: OperationRuntime): Promise<WorkspaceMigrationSnapshotResult["evidence"]> {
    runtime.handoffDeadline = Date.now() + 30_000;
    runtime.finalHandoff = await this.options.gate.beginFinalHandoff(operation.workspaceId, operation.operationId);
    this.assertAccepting();
    if (runtime.cancelRequested) throw new Error("WORKSPACE_DB_HANDOFF_CANCELLED");
    const task = this.fileWorker.snapshotWorkspaceDb({ sourceRoot: operation.sourcePath, targetRoot: operation.targetPath,
      operationId: operation.operationId, workspaceId: operation.workspaceId, requestId: runtime.requestId });
    const result = await this.runTask(operation.operationId, task);
    if (this.stopped || runtime.cancelRequested || Date.now() >= runtime.handoffDeadline!) throw new Error("WORKSPACE_DB_HANDOFF_STOPPED_OR_TIMED_OUT");
    assertDatabaseRoots(operation.sourcePath, operation.targetPath, result.evidence);
    if (result.evidence.state === "ready") {
      assertSameDatabaseMetadata(result.evidence.source, inspectDatabaseFile(path.join(operation.sourcePath, ".codeflowai", "workspace.db")));
      assertSameDatabaseMetadata(result.evidence.target, inspectDatabaseFile(path.join(operation.targetPath, ".codeflowai", "workspace.db")));
    } else assertDbArtifactsAbsent(operation.sourcePath, true, operation.operationId);
    assertDbArtifactsAbsent(operation.targetPath, result.evidence.state === "absent", operation.operationId);
    return result.evidence;
  }

  /** snapshot await 后到 CAS/commit/Map 之间只做同步状态和固定 owner 检查。 */
  private assertCommitRuntime(operation: WorkspaceDirectoryMigrationRecord, runtime: OperationRuntime): void {
    if (this.stopped || runtime.cancelRequested || runtime.watcherError || runtime.sourceDirty || runtime.targetDirty
      || runtime.handoffDeadline !== null && Date.now() >= runtime.handoffDeadline
      || this.options.gate.getMigrationOperationId(operation.workspaceId) !== operation.operationId) {
      throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_RECOVERY_REQUIRED", "数据库交接后迁移状态无法安全提交", {
        operationId: operation.operationId, workspaceId: operation.workspaceId, requestId: runtime.requestId,
        stopped: this.stopped, cancelled: runtime.cancelRequested, sourceDirty: runtime.sourceDirty, targetDirty: runtime.targetDirty,
        watcherError: runtime.watcherError?.details ?? null,
      }, runtime.watcherError ? { cause: runtime.watcherError } : undefined);
    }
  }

  /** 迁移 prepare/publish/commit 共用的物理根 owner 门禁。 */
  private assertTargetWorkspaceRootAvailable(input: {
    requestId: string;
    workspaceId: WorkspaceId;
    operationId: string | null;
    targetPath: string;
    phase: "prepare" | "publish" | "commit";
    allowMissingLeaf: boolean;
    recoveryMode?: "manual";
  }): void {
    assertMigrationTargetWorkspaceRootAvailable({
      workspaces: buildWorkspaceRootOwnerView(this.options.db, this.options.workspaces),
      ...input,
      recoveryMode: input.recoveryMode ?? "none",
    });
  }

  /** 复制进度按时间节流持久化，最终值在 Worker 完成后强制刷新。 */
  private async copyWithProgress(
    requestId: string,
    initial: WorkspaceDirectoryMigrationRecord,
    storage: StorageClassification,
    probe: WorkspaceMigrationProbeResult,
  ): Promise<WorkspaceDirectoryMigrationRecord> {
    let current = initial;
    let lastPersistedAt = 0;
    let latest = { processedFiles: 0, processedBytes: 0 };
    let progressError: { error: unknown } | undefined;
    let progressWrite: Promise<void> | undefined;
    /** 只保存最新进度，一个在途许可足够；复制owner在离开前收齐结果。 */
    const persist = (force: boolean, summary?: WorkspaceMigrationManifestSummary) => {
      const now = this.now();
      if (!force && now - lastPersistedAt < PROGRESS_PERSIST_INTERVAL_MS) return;
      current = this.options.db.workspaceDirectoryMigrations.updateCurrentState({
        operationId: current.operationId,
        expectedState: "copying",
        expectedStateVersion: current.stateVersion,
        patch: {
          copiedFiles: latest.processedFiles,
          copiedBytes: latest.processedBytes,
          ...(summary ? {
            excludedDependencyDirectoryCount: summary.excludedDependencyDirectoryCount,
            excludedDependencyDirectories: summary.excludedDependencyDirectories,
          } : {}),
        },
        now,
      });
      lastPersistedAt = now;
      this.emitChanged(current);
    };
    let task!: WorkspaceMigrationFileTask<Awaited<ReturnType<WorkspaceMigrationFileWorkerClient["copy"]>["promise"]>>;
    task = this.fileWorker.copy({
      manifestMode: manifestMode(current),
      sourceRoot: current.sourcePath,
      stagingRoot: requireStagingPath(current),
      finalTargetRoot: current.targetPath,
      targetFileSystemType: storage.fileSystemType,
      expectedSourceManifestHash: requireManifestHash(current.sourceManifestHash, current.operationId, "source"),
      targetCaseSensitive: probe.caseSensitive,
    }, {
      onProgress: (progress) => {
        latest = { processedFiles: progress.processedFiles, processedBytes: progress.processedBytes };
        if (this.options.withLegacyDatabase) {
          if (progressWrite || progressError) return;
          progressWrite = this.withDatabase(() => persist(false)).then(() => { progressWrite = undefined; }, error => {
            progressError = { error };
            task.cancel();
          });
          return;
        }
        try {
          persist(false);
        } catch (error) {
          progressError = { error };
          task.cancel();
        }
      },
    });
    let result;
    try {
      result = await this.runTask(current.operationId, task);
    } catch (error) {
      await progressWrite;
      if (progressError) throw progressError.error;
      throw error;
    }
    await progressWrite;
    if (progressError) throw progressError.error;
    latest = {
      processedFiles: result.sourceSummary.fileCount,
      processedBytes: result.sourceSummary.totalBytes,
    };
    this.logDependencyExclusions(requestId, current, result.sourceSummary, "copy");
    await this.withDatabase(() => persist(true, result.sourceSummary));
    return current;
  }

  /** path 已提交后的 Map、索引和调度只允许前滚。 */
  private async finalizeCommittedOperation(
    requestId: string,
    initial: WorkspaceDirectoryMigrationRecord,
  ): Promise<void> {
    let current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(initial.operationId)));
    if (current.state === "path_committed") {
      current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
        operationId: current.operationId,
        expectedState: "path_committed",
        expectedStateVersion: current.stateVersion,
        nextState: "finalizing",
        now: this.now(),
      }))));
    }
    if (current.state !== "finalizing") return;
    this.options.workspaces.set(current.workspaceId, current.targetPath);
    await this.options.onCommittedPath?.(current);

    let reserved: Extract<WorkspaceMigrationIndexReservation, { kind: "pending" }> | null = null;
    if (current.indexRebuildStatus === "not_started" || current.indexRebuildStatus === "pending") {
      const reservation = await this.options.indexCoordinator.reserveForMigration(current);
      if (reservation.kind === "not_applicable") {
        current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.setIndexRebuildNotApplicable({
          operationId: current.operationId,
          expectedState: "finalizing",
          expectedStateVersion: current.stateVersion,
          now: this.now(),
        }))));
      } else {
        try {
          const queuedAt = this.now();
          current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.setIndexRebuildPending({
            operationId: current.operationId,
            expectedState: "finalizing",
            expectedStateVersion: current.stateVersion,
            generation: reservation.generation,
            phase: "queued",
            lastProgressAt: queuedAt,
            now: queuedAt,
          }))));
        } catch (error) {
          try { reservation.cancel(); }
          catch (cancelError) { throw new AggregateError([error, cancelError], "WORKSPACE_MIGRATION_INDEX_RESERVATION_CANCEL_FAILED", { cause: error }); }
          throw error;
        }
        reserved = reservation;
      }
    }

    current = (await this.withDatabase(() => this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
      operationId: current.operationId,
      expectedState: "finalizing",
      expectedStateVersion: current.stateVersion,
      nextState: "completed",
      now: this.now(),
    }))));
    this.releaseExclusive(current);
    reserved?.start();
    (await this.withDatabase(() => this.options.queueDispatcher?.resumeWorkspace(current.workspaceId)));
    (await this.withDatabase(() => this.options.scheduledTaskScheduler?.resumeWorkspace(current.workspaceId, current.operationId)));
    logger.info("workspace-migration", "workspace directory migration completed", {
      requestId,
      operationId: current.operationId,
      workspaceId: current.workspaceId,
      stateVersion: current.stateVersion,
      excludedDependencyDirectoryCount: current.excludedDependencyDirectoryCount,
      excludedDependencyDirectories: current.excludedDependencyDirectories,
    });
  }

  /** 原 owner 登记到真实 exit；交接预算同时覆盖结果与退出等待。 */
  private async runTask<T>(operationId: string, task: WorkspaceMigrationFileTask<T>): Promise<T> {
    this.activeTasks.set(operationId, task as FileTask);
    const runtime = this.runtimes.get(operationId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.stopped) throw new Error("WORKSPACE_MIGRATION_STOPPED");
      const completed = runRecoveryTask(task);
      if (runtime?.handoffDeadline !== null && runtime?.handoffDeadline !== undefined) {
        return await Promise.race([completed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const failure = new Error("WORKSPACE_DB_HANDOFF_TIMEOUT");
            runtime.finalHandoff?.fail(failure); task.cancel(); reject(failure);
          }, Math.max(1, runtime.handoffDeadline! - Date.now()));
        })]);
      }
      const result = await completed;
      if (this.stopped) throw new Error("WORKSPACE_MIGRATION_STOPPED");
      return result;
    } catch (error) {
      task.cancel();
      try { await task.terminate(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "WORKSPACE_MIGRATION_TASK_DRAIN_FAILED", { cause: error }); }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      await task.closed;
      if (this.activeTasks.get(operationId) === task) this.activeTasks.delete(operationId);
    }
  }

  /** 目标能力探测使用 operationId 作为探测目录 token。 */
  private async runProbe(
    operation: WorkspaceDirectoryMigrationRecord,
    requiresSymlink: boolean,
  ): Promise<WorkspaceMigrationProbeResult> {
    return await this.runTask(operation.operationId, this.fileWorker.probe({
      targetParent: operation.targetParentPath,
      operationToken: operation.operationId,
      requiresSymlink,
    }));
  }

  /** 用完整清单复核 watcher 事件；内容未变化时清除 Windows 访问时间噪声。 */
  private async assertRuntimeClean(
    operation: WorkspaceDirectoryMigrationRecord,
    runtime: OperationRuntime,
    context: { storage: StorageClassification; probe: WorkspaceMigrationProbeResult },
    expectedSourceManifestHash: string,
    expectedTargetManifestHash?: string,
  ): Promise<void> {
    await reconcileRuntimeWatchChanges({
      operation,
      runtime,
      expectedSourceManifestHash,
      expectedTargetManifestHash,
      scan: async (root, excludeDependencyDirectories) => await this.runTask(operation.operationId, this.fileWorker.scan({
        manifestMode: manifestMode(operation),
        sourceRoot: root,
        targetRoot: operation.targetPath,
        targetFileSystemType: context.storage.fileSystemType,
        includeContentHashes: true,
        excludeDependencyDirectories,
        targetCaseSensitive: context.probe.caseSensitive,
      }, { waitForExit: runtime.handoffDeadline !== null })),
    });
  }

  /** 创建源递归监听；条件排除目录仅在本次权威扫描确认后豁免。 */
  private createSourceWatcher(
    operation: WorkspaceDirectoryMigrationRecord,
    runtime: OperationRuntime,
  ): WorkspaceMigrationFileWatcher {
    runtime.confirmedRegenerableDirectories = [];
    runtime.regenerableDirectoriesConfirmed = false;
    return this.fileWorker.watch({
      watchRoot: operation.sourcePath,
      recursive: true,
      caseSensitive: defaultCaseSensitive(this.platform),
    }, {
      onChanged: (event) => {
        if (isManagedWorkspaceDbPath(event.relativePath, manifestMode(operation), defaultCaseSensitive(this.platform))) return;
        if (isWorkspacePathIndexWatchEvent(event.relativePath, defaultCaseSensitive(this.platform))) return;
        if (!runtime.regenerableDirectoriesConfirmed && event.eventType === "rename") {
          runtime.sourceDirty = true;
          runtime.sourceDirtyBeforeRegenerableConfirmation = true;
          recordSourceChange(runtime.sourceChangeEvidence, event.relativePath);
          return;
        }
        if (!isPathInsideRegenerableDirectory(
          event.relativePath,
          runtime.confirmedRegenerableDirectories,
          defaultCaseSensitive(this.platform),
        )) {
          runtime.sourceDirty = true;
          recordSourceChange(runtime.sourceChangeEvidence, event.relativePath);
        }
      },
      onError: (error) => {
        runtime.watcherError = error;
      },
    });
  }

  /** 创建目标父目录过滤监听；发布基线完成后的任何事件均视为目标变更。 */
  private createTargetWatcher(
    operation: WorkspaceDirectoryMigrationRecord,
    caseSensitive: boolean,
    runtime: OperationRuntime,
  ): WorkspaceMigrationFileWatcher {
    return this.fileWorker.watch({
      watchRoot: operation.targetParentPath,
      recursive: true,
      caseSensitive,
      filterRelativePath: pathFor(this.platform).basename(operation.targetPath),
    }, {
      onChanged: (event) => {
        const workspaceRelativePath = removeWatchPathPrefix(
          event.relativePath,
          pathFor(this.platform).basename(operation.targetPath),
          caseSensitive,
        );
        if (isManagedWorkspaceDbPath(workspaceRelativePath, manifestMode(operation), caseSensitive)) return;
        if (isWorkspacePathIndexWatchEvent(workspaceRelativePath, caseSensitive)) return;
        if (runtime.targetBaselineReady) {
          runtime.targetDirty = true;
          runtime.targetChangeCount += 1;
        }
      },
      onError: (error) => {
        runtime.watcherError = error;
      },
    });
  }

  /** 发布后直接监听目标目录；rename 已完成，因此任何事件均属于目标变化。 */
  private createPublishedTargetWatcher(
    operation: WorkspaceDirectoryMigrationRecord,
    caseSensitive: boolean,
    runtime: OperationRuntime,
  ): WorkspaceMigrationFileWatcher {
    return this.fileWorker.watch({
      watchRoot: operation.targetPath,
      recursive: true,
      caseSensitive,
    }, {
      onChanged: (event) => {
        if (isManagedWorkspaceDbPath(event.relativePath, manifestMode(operation), caseSensitive)) return;
        if (isWorkspacePathIndexWatchEvent(event.relativePath, caseSensitive)) return;
        runtime.targetDirty = true;
        runtime.targetChangeCount += 1;
      },
      onError: (error) => {
        runtime.watcherError = error;
      },
    });
  }

  /** 重新计算源与目标完整清单并验证持久化摘要。 */
  private async verifyOperationTrees(
    operation: WorkspaceDirectoryMigrationRecord,
    storage: StorageClassification,
    probe: WorkspaceMigrationProbeResult,
  ) {
    return await this.runTask(operation.operationId, this.fileWorker.verify({
      manifestMode: manifestMode(operation),
      sourceRoot: operation.sourcePath,
      targetRoot: operation.targetPath,
      targetFileSystemType: storage.fileSystemType,
      expectedSourceManifestHash: requireManifestHash(operation.sourceManifestHash, operation.operationId, "source"),
      expectedTargetManifestHash: requireManifestHash(
        operation.verifiedTargetManifestHash,
        operation.operationId,
        "target",
      ),
      targetCaseSensitive: probe.caseSensitive,
    }));
  }

  /** 先封新写再排空短事务，并保存 operation 级 release。 */
  private async acquireExclusive(operation: WorkspaceDirectoryMigrationRecord): Promise<void> {
    if (this.exclusiveReleases.has(operation.operationId)) return;
    const resumeIndex = this.options.prepareWorkspaceIndex ? await this.options.prepareWorkspaceIndex(operation.workspaceId) : undefined;
    try {
      if (this.options.prepareWorkspaceIndex) await this.options.indexCoordinator.waitForIdle?.();
      this.assertAccepting();
      const release = await this.options.gate.acquireMigration(operation.workspaceId, operation.operationId);
      this.exclusiveReleases.set(operation.operationId, () => { release(); resumeIndex?.(); });
    } catch (error) {
      try { resumeIndex?.(); }
      catch (releaseError) { throw new AggregateError([error, releaseError], "WORKSPACE_MIGRATION_INDEX_RESUME_FAILED", { cause: error }); }
      throw error;
    }
  }

  /** 终态释放独占 owner；recovery_required 明确保留。 */
  private releaseExclusive(operation: WorkspaceDirectoryMigrationRecord): void {
    const release = this.exclusiveReleases.get(operation.operationId);
    if (!release) return;
    release();
    this.exclusiveReleases.delete(operation.operationId);
  }

  /** 预检失败只可能落为 failed/cancelled，不存在文件发布副作用。 */
  private async settlePreflightFailure(
    requestId: string,
    operationId: string,
    runtime: OperationRuntime,
    error: unknown,
  ): Promise<void> {
    const current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(operationId)));
    if (current.state !== "scanning") return;
    const cancelled = runtime.cancelRequested || isWorkerCancelled(error);
    const failure = toServiceError(error, cancelled ? "WORKSPACE_MIGRATION_INTERRUPTED" : "WORKSPACE_MIGRATION_VERIFY_FAILED");
    const settled = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.transitionState({
      operationId,
      expectedState: "scanning",
      expectedStateVersion: current.stateVersion,
      nextState: cancelled ? "cancelled" : "failed",
      patch: cancelled
        ? { cancellationReason: "user_cancelled" }
        : { errorCode: failure.code, errorMessage: failure.message, errorDetails: failure.details },
      now: this.now(),
    })));
    (await this.withDatabase(() => this.emitChanged(settled)));
    this.logFailure(requestId, settled, failure);
  }

  /** 根据提交点方向清理副作用并落 failed/cancelled/recovery_required。 */
  private async settleExecutionFailure(
    requestId: string,
    operationId: string,
    runtime: OperationRuntime,
    error: unknown,
  ): Promise<void> {
    let current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(operationId)));
    if (isWorkspaceDirectoryMigrationTerminalState(current.state) || current.state === "recovery_required") return;
    const cancelled = runtime.cancelRequested || isWorkerCancelled(error);
    let failure = addSourceChangeEvidence(
      toServiceError(error, "WORKSPACE_MIGRATION_VERIFY_FAILED"),
      runtime.sourceChangeEvidence,
    );
    let publishedTargetSafelyRemoved = false;
    try {
      await stopWatchers(runtime);
      if (isBeforePublish(current.state) && current.stagingPath) {
        await removeStagingIfSafe(current, this.platform, this.fileWorker, task => this.runTask(current.operationId, task));
      } else if (
        current.state === "target_ready"
        && failure.code === "WORKSPACE_MIGRATION_SOURCE_CHANGED"
        && !runtime.targetDirty
      ) {
        await this.removeVerifiedPublishedTarget(current);
        publishedTargetSafelyRemoved = true;
      }
    } catch (cleanupError) {
      failure = new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
        "迁移失败后的文件副作用无法安全清理",
        { originalCode: failure.code, cleanup: summarizeError(cleanupError) },
        { cause: cleanupError },
      );
    }

    current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(operationId)));
    const mayCancel = cancelled && (current.state === "copying" || current.state === "verifying");
    const mustRecover = failure.code === "WORKSPACE_MIGRATION_RECOVERY_REQUIRED"
      || current.state === "publish_intent"
      || (current.state === "target_ready" && !publishedTargetSafelyRemoved)
      || current.state === "path_committed"
      || current.state === "finalizing";
    const nextState: WorkspaceDirectoryMigrationState = mustRecover ? "recovery_required" : mayCancel ? "cancelled" : "failed";
    const settled = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.transitionState({
      operationId,
      expectedState: current.state,
      expectedStateVersion: current.stateVersion,
      nextState,
      patch: nextState === "cancelled"
        ? { cancellationReason: "user_cancelled" }
        : { errorCode: failure.code, errorMessage: failure.message, errorDetails: failure.details },
      now: this.now(),
    })));
    (await this.withDatabase(() => this.emitChanged(settled)));
    if (isWorkspaceDirectoryMigrationTerminalState(settled.state)) {
      this.releaseExclusive(settled);
      (await this.withDatabase(() => this.options.queueDispatcher?.resumeWorkspace(settled.workspaceId)));
      (await this.withDatabase(() => this.options.scheduledTaskScheduler?.resumeWorkspace(settled.workspaceId, settled.operationId)));
    }
    this.logFailure(requestId, settled, failure);
  }

  /** 源变化时仅在目标仍匹配持久摘要后删除已发布目标。 */
  private async removeVerifiedPublishedTarget(operation: WorkspaceDirectoryMigrationRecord): Promise<void> {
    const storage = await this.storageClassifier.assertSupportedTarget(operation.targetParentPath);
    const probe = await this.runProbe(operation, false);
    const expected = requireManifestHash(operation.verifiedTargetManifestHash, operation.operationId, "target");
    await quarantineAndRemoveVerifiedTarget({
      operation,
      platform: this.platform,
      expectedManifestHash: expected,
      mismatchReason: "target_manifest_changed_after_source_change",
      verifyDatabase: cleanupPath => verifyOperationDatabase(this.fileWorker, operation, "cleanup", cleanupPath, requestIdForOperation(operation), task => this.runTask(operation.operationId, task)),
      scan: async (cleanupPath) => await this.runTask(operation.operationId, this.fileWorker.scan({
        manifestMode: manifestMode(operation),
        sourceRoot: cleanupPath,
        targetRoot: cleanupPath,
        targetFileSystemType: storage.fileSystemType,
        includeContentHashes: true,
        excludeDependencyDirectories: false,
        targetCaseSensitive: probe.caseSensitive,
      })),
    });
  }

  /** 后台执行无法落为状态时视为 Client 事实源故障，交给进程 owner。 */
  private async handleFatalExecutionFailure(requestId: string, operationId: string, error: unknown): Promise<void> {
    const fatal = error instanceof Error ? error : new Error(String(error));
    logger.error("workspace-migration", "workspace migration background execution failed", {
      requestId,
      operationId,
      error: fatal.message,
    });
    this.options.onFatalError?.(fatal);
    if (!this.options.onFatalError) throw fatal;
  }

  /** 跟踪后台 Promise，拒绝同 operation 并行执行。 */
  private trackExecution(operationId: string, execution: Promise<void>): void {
    if (this.running.has(operationId)) {
      throw new Error(`目录迁移已有后台执行：operationId=${operationId}`);
    }
    this.running.set(operationId, execution);
    void execution.then(
      () => {
        if (this.running.get(operationId) === execution) this.running.delete(operationId);
      },
      () => {
        if (this.running.get(operationId) === execution) this.running.delete(operationId);
      },
    );
  }

  /** 广播持久化后的最新 operation；失败由查询或 notification_pending 补偿。 */
  private emitChanged(operation: WorkspaceDirectoryMigrationRecord): WorkspaceDirectoryMigrationRecord {
    try {
      this.options.onOperationChanged?.(operation);
    } catch (error) {
      logger.error("workspace-migration", "workspace migration change notification failed", {
        code: "workspace_migration_operation_changed_callback_failed",
        operationId: operation.operationId,
        workspaceId: operation.workspaceId,
        state: operation.state,
        stateVersion: operation.stateVersion,
        notificationPending: operation.notificationPending,
        rootCause: error instanceof Error ? error.message : String(error),
      });
    }
    return operation;
  }

  /** awaiting_confirmation 最多保留 30 分钟；超时只取消无 prepared attempt 的预检。 */
  private scheduleConfirmationExpiry(operation: WorkspaceDirectoryMigrationRecord): void {
    this.clearConfirmationTimer(operation.operationId);
    const delay = Math.max(1, operation.updatedAt + AWAITING_CONFIRMATION_TIMEOUT_MS - this.now());
    const timer = setTimeout(() => {
      this.confirmationTimers.delete(operation.operationId);
      if (this.stopped || this.running.has(operation.operationId)) return;
      const execution = this.withDatabase(() => {
        const current = this.options.db.workspaceDirectoryMigrations.require(operation.operationId);
        if (current.state !== "awaiting_confirmation" || current.startDisposition === "prepared") return;
        this.emitChanged(this.options.db.workspaceDirectoryMigrations.transitionState({
          operationId: current.operationId,
          expectedState: current.state,
          expectedStateVersion: current.stateVersion,
          nextState: "cancelled",
          patch: { cancellationReason: "confirmation_timeout" },
          now: this.now(),
        }));
      }).catch(error => this.handleFatalExecutionFailure("confirmation-timeout", operation.operationId, error));
      this.trackExecution(operation.operationId, execution);
    }, delay);
    timer.unref?.();
    this.confirmationTimers.set(operation.operationId, timer);
  }

  /** 清除指定确认超时 timer。 */
  private clearConfirmationTimer(operationId: string): void {
    const timer = this.confirmationTimers.get(operationId);
    if (!timer) return;
    clearTimeout(timer);
    this.confirmationTimers.delete(operationId);
  }

  /** 记录一次拥有处理边界的结构化失败。 */
  private logFailure(
    requestId: string,
    operation: WorkspaceDirectoryMigrationRecord,
    failure: WorkspaceMigrationServiceError,
  ): void {
    logger.error("workspace-migration", "workspace directory migration failed", {
      requestId,
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      state: operation.state,
      stateVersion: operation.stateVersion,
      errorCode: failure.code,
      error: failure.message,
      details: failure.details,
    });
  }

  /** 记录每次权威扫描排除的可重新生成目录，路径保持为限长相对路径。 */
  private logDependencyExclusions(
    requestId: string,
    operation: WorkspaceDirectoryMigrationRecord,
    summary: WorkspaceMigrationManifestSummary,
    stage: "preflight" | "execution" | "copy",
  ): void {
    if (summary.excludedDependencyDirectoryCount === 0) return;
    logger.info("workspace-migration", "workspace regenerable directories excluded", {
      requestId,
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      stage,
      excludedDependencyDirectoryCount: summary.excludedDependencyDirectoryCount,
      excludedDependencyDirectories: summary.excludedDependencyDirectories,
    });
  }
}

/** 合并运行态与持久态 owner；持久态覆盖同 ID 的旧路径，供恢复期和并发窗口复核。 */
function buildWorkspaceRootOwnerView(
  db: ClientDb,
  runtimeWorkspaces?: ReadonlyMap<WorkspaceId, string>,
): Map<WorkspaceId, string> {
  const workspaces = new Map<WorkspaceId, string>(runtimeWorkspaces ?? []);
  for (const workspace of db.workspaces.list()) workspaces.set(workspace.id, workspace.path);
  return workspaces;
}

/** 所有迁移发布/提交路径共用的 canonical root owner 门禁。 */
function assertMigrationTargetWorkspaceRootAvailable(input: {
  workspaces: ReadonlyMap<WorkspaceId, string>;
  requestId: string;
  workspaceId: WorkspaceId;
  operationId: string | null;
  targetPath: string;
  phase: "prepare" | "publish" | "commit";
  allowMissingLeaf: boolean;
  recoveryMode: "none" | "manual" | "startup";
}): void {
  try {
    assertWorkspaceRootAvailable(
      input.workspaces,
      input.workspaceId,
      input.targetPath,
      { allowMissingLeaf: input.allowMissingLeaf },
    );
  } catch (error) {
    if (!(error instanceof WorkspaceRootConflictError)) throw error;
    logger.warn("workspace-migration", "workspace migration target root is already registered", {
      code: "workspace_migration_target_root_conflict",
      requestId: input.requestId,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      conflictingWorkspaceIds: error.conflictingWorkspaceIds,
      workspaceRootKey: error.workspaceRootKey,
      generation: null,
      indexPath: path.normalize(workspacePathIndexDatabasePath(error.workspaceRoot)),
      phase: input.phase,
      recoveryMode: input.recoveryMode,
      rootCause: error.message,
    });
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_TARGET_CONFLICT",
      "迁移目标物理目录已被另一个工作区使用",
      {
        reason: "workspace_root_already_registered",
        phase: input.phase,
        recoveryMode: input.recoveryMode,
        conflictingWorkspaceIds: error.conflictingWorkspaceIds,
        workspaceRootKey: error.workspaceRootKey,
      },
      { cause: error },
    );
  }
}

export type WorkspaceMigrationStartupRecoveryResult = {
  blockedWorkspaceIds: WorkspaceId[];
  recoveredOperationIds: string[];
};

/** 在构建 workspaces Map 前按持久状态和文件现场收敛未终态迁移。 */
export async function recoverWorkspaceMigrationsBeforeMap(input: {
  db: ClientDb;
  requestId: string;
  fileWorker?: WorkspaceMigrationFileWorkerClient;
  storageClassifier?: StorageClassifier;
  now?: () => number;
  platform?: NodeJS.Platform;
}): Promise<WorkspaceMigrationStartupRecoveryResult> {
  const worker = input.fileWorker ?? new WorkspaceMigrationFileWorkerClient();
  const classifier = input.storageClassifier ?? new StorageClassifier();
  const now = input.now ?? Date.now;
  const platform = input.platform ?? process.platform;
  const blocked = new Set<WorkspaceId>();
  const recoveredOperationIds: string[] = [];
  for (const initial of input.db.workspaceDirectoryMigrations.listActive()) {
    let current = initial;
    try {
      if (current.state === "scanning" || (current.state === "awaiting_confirmation" && current.startDisposition !== "prepared")) {
        current = input.db.workspaceDirectoryMigrations.transitionState({
          operationId: current.operationId,
          expectedState: current.state,
          expectedStateVersion: current.stateVersion,
          nextState: "cancelled",
          patch: { cancellationReason: "client_restarted_before_start" },
          now: now(),
        });
      } else if (current.state === "awaiting_confirmation" && current.startDisposition === "prepared" && current.startAttemptId) {
        current = input.db.workspaceDirectoryMigrations.fencePreparedAttemptAndCancel({
          operationId: current.operationId,
          startAttemptId: current.startAttemptId,
          expectedStateVersion: current.stateVersion,
          cancellationReason: "client_restarted_before_start",
          now: now(),
        });
      } else if (current.state === "preparing" || current.state === "copying" || current.state === "verifying") {
        const stagingExists = Boolean(current.stagingPath && pathExists(current.stagingPath));
        const targetExists = pathExists(current.targetPath);
        const evidenceMatchesPreCommit = current.state === "preparing"
          ? !targetExists
          : stagingExists && !targetExists;
        if (!evidenceMatchesPreCommit) {
          throw new WorkspaceMigrationServiceError(
            "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
            "提交点前持久状态与 staging/目标现场不一致",
            { state: current.state, stagingExists, targetExists },
          );
        }
        if (stagingExists) await removeStagingIfSafe(current, platform);
        current = input.db.workspaceDirectoryMigrations.transitionState({
          operationId: current.operationId,
          expectedState: current.state,
          expectedStateVersion: current.stateVersion,
          nextState: "failed",
          patch: {
            errorCode: "WORKSPACE_MIGRATION_INTERRUPTED",
            errorMessage: "Client 重启中断了提交点前的目录迁移",
            errorDetails: { recovery: "source_restored" },
          },
          now: now(),
        });
      } else if (current.state === "publish_intent") {
        current = await recoverPublishIntent({
          db: input.db,
          requestId: input.requestId,
          worker,
          classifier,
          operation: current,
          now,
          platform,
        });
      }
      if (current.state === "target_ready") {
        current = await recoverTargetReady({
          db: input.db,
          requestId: input.requestId,
          worker,
          classifier,
          operation: current,
          now,
          platform,
        });
      }
      if (current.state === "path_committed" || current.state === "finalizing") {
        assertMigrationTargetWorkspaceRootAvailable({
          workspaces: buildWorkspaceRootOwnerView(input.db),
          requestId: input.requestId,
          workspaceId: current.workspaceId,
          operationId: current.operationId,
          targetPath: current.targetPath,
          phase: "commit",
          allowMissingLeaf: false,
          recoveryMode: "startup",
        });
        await assertCommittedTargetValid({ db: input.db, worker, classifier, operation: current });
        assertMigrationTargetWorkspaceRootAvailable({
          workspaces: buildWorkspaceRootOwnerView(input.db),
          requestId: input.requestId,
          workspaceId: current.workspaceId,
          operationId: current.operationId,
          targetPath: current.targetPath,
          phase: "commit",
          allowMissingLeaf: false,
          recoveryMode: "startup",
        });
      }
      if (current.state === "recovery_required") blocked.add(current.workspaceId);
      recoveredOperationIds.push(current.operationId);
      logger.info("workspace-migration", "workspace migration startup recovery settled", {
        requestId: input.requestId,
        operationId: current.operationId,
        workspaceId: current.workspaceId,
        persistedState: initial.state,
        recoveredState: current.state,
        stateVersion: current.stateVersion,
      });
    } catch (error) {
      const failure = toServiceError(error, "WORKSPACE_MIGRATION_RECOVERY_REQUIRED");
      current = input.db.workspaceDirectoryMigrations.require(initial.operationId);
      if (!isWorkspaceDirectoryMigrationTerminalState(current.state) && current.state !== "recovery_required") {
        current = input.db.workspaceDirectoryMigrations.transitionState({
          operationId: current.operationId,
          expectedState: current.state,
          expectedStateVersion: current.stateVersion,
          nextState: "recovery_required",
          patch: {
            errorCode: failure.code,
            errorMessage: failure.message,
            errorDetails: failure.details,
          },
          now: now(),
        });
      }
      if (!isWorkspaceDirectoryMigrationTerminalState(current.state)) blocked.add(current.workspaceId);
      recoveredOperationIds.push(current.operationId);
      logger.error("workspace-migration", "workspace migration startup recovery requires isolation", {
        requestId: input.requestId,
        operationId: current.operationId,
        workspaceId: current.workspaceId,
        persistedState: initial.state,
        recoveredState: current.state,
        errorCode: current.errorCode,
        error: failure.message,
      });
    }
  }
  return { blockedWorkspaceIds: [...blocked].sort(), recoveredOperationIds };
}

async function recoverPublishIntent(input: {
  db: ClientDb;
  requestId: string;
  worker: WorkspaceMigrationFileWorkerClient;
  classifier: StorageClassifier;
  operation: WorkspaceDirectoryMigrationRecord;
  now: () => number;
  platform: NodeJS.Platform;
}): Promise<WorkspaceDirectoryMigrationRecord> {
  const stagingPath = requireStagingPath(input.operation);
  const stagingExists = pathExists(stagingPath);
  const targetExists = pathExists(input.operation.targetPath);
  if (stagingExists === targetExists) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
      "发布意图与文件现场不一致",
      { stagingExists, targetExists },
    );
  }
  const context = await resolveStorageContext(input.classifier, input.worker, input.operation, input.platform);
  if (stagingExists) {
    try {
      await runRecoveryTask(input.worker.verify({
        manifestMode: manifestMode(input.operation),
        sourceRoot: input.operation.sourcePath,
        targetRoot: stagingPath,
        targetFileSystemType: context.storage.fileSystemType,
        expectedSourceManifestHash: requireManifestHash(input.operation.sourceManifestHash, input.operation.operationId, "source"),
        expectedTargetManifestHash: requireManifestHash(input.operation.verifiedTargetManifestHash, input.operation.operationId, "target"),
        targetCaseSensitive: context.probe.caseSensitive,
      }));
    } catch (error) {
      await removeStagingIfSafe(input.operation, input.platform);
      const failure = toServiceError(error, "WORKSPACE_MIGRATION_VERIFY_FAILED");
      return input.db.workspaceDirectoryMigrations.transitionState({
        operationId: input.operation.operationId,
        expectedState: "publish_intent",
        expectedStateVersion: input.operation.stateVersion,
        nextState: "failed",
        patch: {
          errorCode: failure.code,
          errorMessage: "Client 重启恢复时 staging 校验失败，已安全清理",
          errorDetails: failure.details,
        },
        now: input.now(),
      });
    }
    assertMigrationTargetWorkspaceRootAvailable({
      workspaces: buildWorkspaceRootOwnerView(input.db),
      requestId: input.requestId,
      workspaceId: input.operation.workspaceId,
      operationId: input.operation.operationId,
      targetPath: input.operation.targetPath,
      phase: "publish",
      allowMissingLeaf: true,
      recoveryMode: "startup",
    });
    await renamePublishedTarget(input.operation, input.platform);
  }
  const verifiedTargetManifestHash = await scanPersistedTarget(input.worker, context, input.operation);
  return input.db.workspaceDirectoryMigrations.transitionState({
    operationId: input.operation.operationId,
    expectedState: "publish_intent",
    expectedStateVersion: input.operation.stateVersion,
    nextState: "target_ready",
    patch: { verifiedTargetManifestHash },
    now: input.now(),
  });
}

/** 恢复 target_ready 时监听故障必须进入恢复态，不能按真实源变化清理目标。 */
async function recoverTargetReady(input: {
  db: ClientDb;
  requestId: string;
  worker: WorkspaceMigrationFileWorkerClient;
  classifier: StorageClassifier;
  operation: WorkspaceDirectoryMigrationRecord;
  now: () => number;
  platform: NodeJS.Platform;
}): Promise<WorkspaceDirectoryMigrationRecord> {
  const operation = input.db.workspaceDirectoryMigrations.require(input.operation.operationId);
  if (operation.workspaceDbSnapshot?.state === "pending") {
    return await failPendingDatabaseTarget(input.db, input.worker, input.classifier, operation, input.requestId, input.now, input.platform);
  }
  const context = await resolveStorageContext(input.classifier, input.worker, operation, input.platform);
  const runtime = createRuntime(input.requestId);
  const sourceWatcher = input.worker.watch({
    watchRoot: operation.sourcePath,
    recursive: true,
    caseSensitive: defaultCaseSensitive(input.platform),
  }, {
    onChanged: (event) => {
      if (isManagedWorkspaceDbPath(event.relativePath, manifestMode(operation), defaultCaseSensitive(input.platform))) return;
      if (isWorkspacePathIndexWatchEvent(event.relativePath, defaultCaseSensitive(input.platform))) return;
      if (!runtime.regenerableDirectoriesConfirmed && event.eventType === "rename") {
        runtime.sourceDirty = true;
        runtime.sourceDirtyBeforeRegenerableConfirmation = true;
        recordSourceChange(runtime.sourceChangeEvidence, event.relativePath);
        return;
      }
      if (!isPathInsideRegenerableDirectory(
        event.relativePath,
        runtime.confirmedRegenerableDirectories,
        defaultCaseSensitive(input.platform),
      )) {
          runtime.sourceDirty = true;
          recordSourceChange(runtime.sourceChangeEvidence, event.relativePath);
      }
    },
    onError: (error) => { runtime.watcherError ??= error; },
  });
  const targetWatcher = input.worker.watch({
    watchRoot: operation.targetPath,
    recursive: true,
    caseSensitive: context.probe.caseSensitive,
  }, {
    onChanged: (event) => {
      if (isManagedWorkspaceDbPath(event.relativePath, manifestMode(operation), context.probe.caseSensitive)) return;
      if (isWorkspacePathIndexWatchEvent(event.relativePath, context.probe.caseSensitive)) return;
      runtime.targetDirty = true;
      runtime.targetChangeCount += 1;
    },
    onError: (error) => { runtime.watcherError ??= error; },
  });
  try {
    await Promise.all([sourceWatcher.ready, targetWatcher.ready]);
    const verification = await verifyPersistedOperation(input.worker, context, operation);
    runtime.confirmedRegenerableDirectories = [...verification.sourceSummary.excludedDependencyDirectories];
    runtime.regenerableDirectoriesConfirmed = true;
    await reconcileRuntimeWatchChanges({
      operation,
      runtime,
      expectedSourceManifestHash: requireManifestHash(verification.sourceSummary.manifestHash, operation.operationId, "source"),
      expectedTargetManifestHash: requireManifestHash(verification.targetSummary.manifestHash, operation.operationId, "target"),
      scan: async (root, excludeDependencyDirectories) => await runRecoveryTask(input.worker.scan({
        manifestMode: manifestMode(operation),
        sourceRoot: root,
        targetRoot: operation.targetPath,
        targetFileSystemType: context.storage.fileSystemType,
        includeContentHashes: true,
        excludeDependencyDirectories,
        targetCaseSensitive: context.probe.caseSensitive,
      })),
    });
    const terminalPlan = buildTerminalCwdPlan(input.db, operation, input.platform);
    assertMigrationTargetWorkspaceRootAvailable({
      workspaces: buildWorkspaceRootOwnerView(input.db),
      requestId: input.requestId,
      workspaceId: operation.workspaceId,
      operationId: operation.operationId,
      targetPath: operation.targetPath,
      phase: "commit",
      allowMissingLeaf: false,
      recoveryMode: "startup",
    });
    if (runtime.sourceDirty || runtime.targetDirty || runtime.watcherError) throw new Error("WORKSPACE_DB_RECOVERY_RUNTIME_CHANGED");
    if (operation.workspaceDbSnapshot) assertSnapshotMetadata(operation, operation.workspaceDbSnapshot);
    return input.db.workspaceDirectoryMigrations.commitPath({
      operationId: operation.operationId,
      expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion,
      terminalCwdTargets: terminalPlan.targets,
      now: input.now(),
    });
  } catch (error) {
    const failure = toServiceError(error, "WORKSPACE_MIGRATION_RECOVERY_REQUIRED");
    if (failure.code !== "WORKSPACE_MIGRATION_SOURCE_CHANGED" || runtime.targetDirty) throw error;
    await removeVerifiedTargetForRecovery(input.worker, context, operation, input.platform);
    return input.db.workspaceDirectoryMigrations.transitionState({
      operationId: operation.operationId,
      expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion,
      nextState: "failed",
      patch: {
        errorCode: "WORKSPACE_MIGRATION_SOURCE_CHANGED",
        errorMessage: "Client 重启恢复时检测到源工作区变化，已安全清理目标",
        errorDetails: failure.details,
      },
      now: input.now(),
    });
  } finally {
    await Promise.all([sourceWatcher.stop(), targetWatcher.stop()]);
  }
}

/** 恢复清副本沿原隔离入口；数据库与静态树均须在隔离前后证明归属。 */
async function removeVerifiedTargetForRecovery(
  worker: WorkspaceMigrationFileWorkerClient,
  context: { storage: StorageClassification; probe: WorkspaceMigrationProbeResult },
  operation: WorkspaceDirectoryMigrationRecord,
  platform: NodeJS.Platform,
  runTask?: RecoveryTaskRunner,
): Promise<void> {
  const expected = requireManifestHash(operation.verifiedTargetManifestHash, operation.operationId, "target");
  await quarantineAndRemoveVerifiedTarget({
    operation,
    platform,
    expectedManifestHash: expected,
    mismatchReason: "recovery_target_manifest_changed",
    verifyDatabase: cleanupPath => verifyOperationDatabase(worker, operation, "cleanup", cleanupPath, requestIdForOperation(operation), runTask),
    scan: async (cleanupPath) => await runRecoveryTask(worker.scan({
      manifestMode: manifestMode(operation),
      sourceRoot: cleanupPath,
      targetRoot: cleanupPath,
      targetFileSystemType: context.storage.fileSystemType,
      includeContentHashes: true,
      excludeDependencyDirectories: false,
      targetCaseSensitive: context.probe.caseSensitive,
    }), runTask),
  });
}

/** 原子隔离已发布目标，隔离后复核摘要，只删除已证明属于本次迁移的目录。 */
async function quarantineAndRemoveVerifiedTarget(input: {
  operation: WorkspaceDirectoryMigrationRecord;
  platform: NodeJS.Platform;
  expectedManifestHash: string;
  mismatchReason: string;
  scan: (cleanupPath: string) => Promise<{ summary: { manifestHash: string | null } }>;
  verifyDatabase?: (cleanupPath: string) => Promise<void>;
}): Promise<void> {
  const cleanupPath = buildPublishedTargetCleanupPath(input.operation, input.platform);
  if (pathExists(cleanupPath)) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
      "迁移目标隔离目录已存在，禁止自动清理",
      { reason: "target_cleanup_path_exists" },
    );
  }

  let quarantined = false;
  let removalStarted = false;
  try {
    await input.verifyDatabase?.(input.operation.targetPath);
    await fs.promises.rename(input.operation.targetPath, cleanupPath);
    quarantined = true;
    await syncDirectory(input.operation.targetParentPath, input.platform);
    const scan = await input.scan(cleanupPath);
    if (scan.summary.manifestHash !== input.expectedManifestHash) {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
        "源变化后隔离目标的摘要不一致，禁止自动清理",
        { reason: input.mismatchReason },
      );
    }
    await input.verifyDatabase?.(cleanupPath);
    removalStarted = true;
    await fs.promises.rm(cleanupPath, { recursive: true, force: false });
    quarantined = false;
    await syncDirectory(input.operation.targetParentPath, input.platform);
  } catch (error) {
    let restoreError: unknown = null;
    if (quarantined && !removalStarted) {
      try {
        if (pathExists(input.operation.targetPath)) {
          throw new Error("目标路径已被重新创建");
        }
        await fs.promises.rename(cleanupPath, input.operation.targetPath);
        quarantined = false;
        await syncDirectory(input.operation.targetParentPath, input.platform);
      } catch (caught) {
        restoreError = caught;
      }
    }
    const reason = error instanceof WorkspaceMigrationServiceError
      ? String(error.details.reason ?? input.mismatchReason)
      : removalStarted
        ? "target_cleanup_remove_failed"
        : "target_cleanup_quarantine_failed";
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
      "迁移目标无法安全隔离并清理",
      {
        reason,
        rootCause: summarizeError(error),
        restoreFailed: restoreError ? summarizeError(restoreError) : null,
      },
      { cause: restoreError ?? error },
    );
  }
}

/** 已提交恢复只认注册目标、静态清单和受管库物理连续性。 */
async function assertCommittedTargetValid(input: {
  db: ClientDb;
  withDatabase?: MigrationDatabaseAccess;
  worker: WorkspaceMigrationFileWorkerClient;
  classifier: StorageClassifier;
  operation: WorkspaceDirectoryMigrationRecord;
  platform?: NodeJS.Platform;
  runTask?: RecoveryTaskRunner;
}): Promise<void> {
  const readWorkspace = () => input.db.workspaces.get(input.operation.workspaceId);
  const workspace = input.withDatabase ? await input.withDatabase(readWorkspace) : readWorkspace();
  if (!workspace || workspace.path !== input.operation.targetPath || !pathExists(input.operation.targetPath)) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
      "已提交迁移的 SQLite 路径或目标目录不一致",
      { workspacePath: workspace?.path ?? null, targetExists: pathExists(input.operation.targetPath) },
    );
  }
  const context = await resolveStorageContext(
    input.classifier,
    input.worker,
    input.operation,
    input.platform ?? process.platform,
    input.runTask,
  );
  const scan = await runRecoveryTask(input.worker.scan({
    manifestMode: manifestMode(input.operation),
    sourceRoot: input.operation.targetPath,
    targetRoot: input.operation.targetPath,
    targetFileSystemType: context.storage.fileSystemType,
    includeContentHashes: true,
    targetCaseSensitive: context.probe.caseSensitive,
  }), input.runTask);
  const expectedTargetHash = requireManifestHash(
    input.operation.verifiedTargetManifestHash,
    input.operation.operationId,
    "target",
  );
  if (scan.summary.manifestHash !== expectedTargetHash) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
      "已提交迁移的目标目录清单不一致",
      { reason: "committed_target_manifest_mismatch" },
    );
  }
  await verifyOperationDatabase(input.worker, input.operation, "committed", input.operation.targetPath, requestIdForOperation(input.operation), input.runTask);
}

/** 复用原分类与探测，Service 调用方把 Worker 交回原任务 owner。 */
async function resolveStorageContext(
  classifier: StorageClassifier,
  worker: WorkspaceMigrationFileWorkerClient,
  operation: WorkspaceDirectoryMigrationRecord,
  platform: NodeJS.Platform,
  runTask?: RecoveryTaskRunner,
): Promise<{ storage: StorageClassification; probe: WorkspaceMigrationProbeResult }> {
  const storage = await classifier.assertSupportedTarget(operation.targetParentPath);
  assertTargetDirectoryNameCompatible(operation, storage.fileSystemType, platform);
  const probe = await runRecoveryTask(worker.probe({
    targetParent: operation.targetParentPath,
    operationToken: operation.operationId,
    requiresSymlink: false,
  }), runTask);
  return { storage, probe };
}

/** 提交前恢复同时复核持久静态摘要及源/目标数据库字节。 */
async function verifyPersistedOperation(
  worker: WorkspaceMigrationFileWorkerClient,
  context: { storage: StorageClassification; probe: WorkspaceMigrationProbeResult },
  operation: WorkspaceDirectoryMigrationRecord,
  runTask?: RecoveryTaskRunner,
) {
  const result = await runRecoveryTask(worker.verify({
    manifestMode: manifestMode(operation),
    sourceRoot: operation.sourcePath,
    targetRoot: operation.targetPath,
    targetFileSystemType: context.storage.fileSystemType,
    expectedSourceManifestHash: requireManifestHash(operation.sourceManifestHash, operation.operationId, "source"),
    expectedTargetManifestHash: requireManifestHash(operation.verifiedTargetManifestHash, operation.operationId, "target"),
    targetCaseSensitive: context.probe.caseSensitive,
  }), runTask);
  await verifyOperationDatabase(worker, operation, "precommit", operation.targetPath, requestIdForOperation(operation), runTask);
  return result;
}

/** pending 不授权提交；仅静态树和本 operation 无 DB 现场均可证明时清副本回源。 */
async function failPendingDatabaseTarget(db: ClientDb, worker: WorkspaceMigrationFileWorkerClient, classifier: StorageClassifier,
  operation: WorkspaceDirectoryMigrationRecord, requestId: string, now: () => number, platform: NodeJS.Platform, runTask?: RecoveryTaskRunner,
  withDatabase: MigrationDatabaseAccess = async operation => operation()): Promise<WorkspaceDirectoryMigrationRecord> {
  const workspace = await withDatabase(() => db.workspaces.get(operation.workspaceId));
  if (!workspace || !pathsEqual(workspace.path, operation.sourcePath, platform)) throw new Error("WORKSPACE_DB_PENDING_AUTHORITY_INVALID");
  await withDatabase(() => assertMigrationTargetWorkspaceRootAvailable({ workspaces: buildWorkspaceRootOwnerView(db), requestId,
    workspaceId: operation.workspaceId, operationId: operation.operationId, targetPath: operation.targetPath,
    phase: "commit", allowMissingLeaf: false, recoveryMode: "startup" }));
  await verifyOperationDatabase(worker, operation, "cleanup", operation.targetPath, requestId, runTask);
  const context = await resolveStorageContext(classifier, worker, operation, platform, runTask);
  await runRecoveryTask(worker.verify({ manifestMode: manifestMode(operation), sourceRoot: operation.sourcePath, targetRoot: operation.targetPath,
    targetFileSystemType: context.storage.fileSystemType, targetCaseSensitive: context.probe.caseSensitive,
    expectedSourceManifestHash: requireManifestHash(operation.sourceManifestHash, operation.operationId, "source"),
    expectedTargetManifestHash: requireManifestHash(operation.verifiedTargetManifestHash, operation.operationId, "target") }), runTask);
  await withDatabase(() => assertMigrationTargetWorkspaceRootAvailable({ workspaces: buildWorkspaceRootOwnerView(db), requestId,
    workspaceId: operation.workspaceId, operationId: operation.operationId, targetPath: operation.targetPath,
    phase: "commit", allowMissingLeaf: false, recoveryMode: "startup" }));
  await removeVerifiedTargetForRecovery(worker, context, operation, platform, runTask);
  return withDatabase(() => db.workspaceDirectoryMigrations.transitionState({ operationId: operation.operationId, expectedState: operation.state,
    expectedStateVersion: operation.stateVersion, nextState: "failed", patch: { errorCode: "WORKSPACE_MIGRATION_INTERRUPTED",
      errorMessage: "数据库交接尚未完成，已安全清理无数据库副本并保持源路径", errorDetails: { requestId, recovery: "source_restored" } }, now: now() }));
}

/** publish_intent 已出现最终目标时只验证目标，源变化交给 target_ready 双端恢复处理。 */
async function scanPersistedTarget(
  worker: WorkspaceMigrationFileWorkerClient,
  context: { storage: StorageClassification; probe: WorkspaceMigrationProbeResult },
  operation: WorkspaceDirectoryMigrationRecord,
): Promise<string> {
  const scan = await runRecoveryTask(worker.scan({
    manifestMode: manifestMode(operation),
    sourceRoot: operation.targetPath,
    targetRoot: operation.targetPath,
    targetFileSystemType: context.storage.fileSystemType,
    includeContentHashes: true,
    targetCaseSensitive: context.probe.caseSensitive,
  }));
  const actual = requireManifestHash(scan.summary.manifestHash, operation.operationId, "target");
  const expected = requireManifestHash(operation.verifiedTargetManifestHash, operation.operationId, "target");
  if (actual !== expected) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
      "发布后的目标目录清单与持久化摘要不一致",
      { reason: "publish_target_manifest_mismatch" },
    );
  }
  return actual;
}

function resolveTargetPaths(input: {
  sourcePath: string;
  targetParentPath: string;
  targetDirectoryName: string;
  platform: NodeJS.Platform;
}): { targetParentPath: string; targetPath: string } {
  const pathApi = pathFor(input.platform);
  const rawTargetParentPath = String(input.targetParentPath ?? "").trim();
  const directoryName = String(input.targetDirectoryName ?? "").trim();
  if (!rawTargetParentPath || !pathApi.isAbsolute(rawTargetParentPath)) {
    throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标父目录必须是绝对路径");
  }
  const targetParentPath = pathApi.resolve(rawTargetParentPath);
  if (!directoryName || directoryName === "." || directoryName === ".." || pathApi.basename(directoryName) !== directoryName) {
    throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标目录名称必须是单个目录名");
  }
  assertTargetPathComponent(directoryName, "unknown", input.platform);
  const sourcePath = pathApi.resolve(input.sourcePath);
  const targetPath = pathApi.join(targetParentPath, directoryName);
  if (isSameOrDescendant(targetParentPath, sourcePath, input.platform)) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_TARGET_INVALID",
      "目标父目录不能位于源工作区内部",
      { reason: "target_inside_source" },
    );
  }
  if (pathsEqual(sourcePath, targetPath, input.platform)) {
    throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标目录不能与源目录相同");
  }
  return { targetParentPath, targetPath };
}

function buildStagingPath(operation: WorkspaceDirectoryMigrationRecord, platform: NodeJS.Platform): string {
  const pathApi = pathFor(platform);
  return pathApi.join(
    operation.targetParentPath,
    `.${pathApi.basename(operation.targetPath)}.codeflow-migration-${operation.operationId}`,
  );
}

/** 为已发布目标生成同父目录隔离路径，避免校验后直接递归删除原路径。 */
function buildPublishedTargetCleanupPath(operation: WorkspaceDirectoryMigrationRecord, platform: NodeJS.Platform): string {
  const pathApi = pathFor(platform);
  const token = operation.operationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
  return pathApi.join(
    operation.targetParentPath,
    `.${pathApi.basename(operation.targetPath)}.codeflow-cleanup-${token}`,
  );
}

/** 按 Client 平台与目标文件系统校验最终目标目录根名称。 */
function assertTargetDirectoryNameCompatible(
  operation: WorkspaceDirectoryMigrationRecord,
  targetFileSystemType: string,
  platform: NodeJS.Platform,
): void {
  assertTargetPathComponent(pathFor(platform).basename(operation.targetPath), targetFileSystemType, platform);
}

/** 校验单个目标路径组件；unknown 阶段只应用当前平台可确定的限制。 */
function assertTargetPathComponent(name: string, targetFileSystemType: string, platform: NodeJS.Platform): void {
  const fileSystemType = String(targetFileSystemType ?? "").trim().toLowerCase();
  const usesWindowsNaming = platform === "win32" || WINDOWS_NAMING_FILESYSTEMS.has(fileSystemType);
  if (!name || name === "." || name === ".." || name.includes("\0")) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_TARGET_INVALID",
      "目标目录名称不可用",
      { reason: "target_root_name_invalid" },
    );
  }
  if (usesWindowsNaming) {
    if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || WINDOWS_RESERVED_TARGET_NAMES.test(name)) {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_TARGET_INVALID",
        "目标目录名称在目标文件系统上不可用",
        { reason: "target_root_name_invalid" },
      );
    }
    if (name.length > 255) {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_TARGET_INVALID",
        "目标目录名称超过平台限制",
        { reason: "target_root_name_too_long" },
      );
    }
  } else if (Buffer.byteLength(name, "utf8") > 255) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_TARGET_INVALID",
      "目标目录名称超过平台限制",
      { reason: "target_root_name_too_long" },
    );
  }
}

/** 只读核验 W 终端可搬运性；绝对路径必须显式拒绝，禁止快照后补写 W。 */
function assertWorkspaceTerminalCwds(
  db: ClientDb,
  operation: WorkspaceDirectoryMigrationRecord,
  platform: NodeJS.Platform,
  operationId: string | null,
): void {
  const pathApi = pathFor(platform);
  db.withWorkspaceCoreSnapshot(operation.workspaceId, operationId, view => {
    for (const config of view?.terminalConfigs.listByWorkspace(operation.workspaceId) ?? []) {
      if (config.cwd === null) continue;
      const relative = pathApi.relative(operation.sourcePath, pathApi.resolve(operation.sourcePath, config.cwd));
      if (pathApi.isAbsolute(config.cwd) || path.win32.isAbsolute(config.cwd) || path.posix.isAbsolute(config.cwd)
        || relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
        throw new WorkspaceMigrationServiceError("WORKSPACE_MIGRATION_TARGET_INVALID",
          `工作区终端 cwd 必须使用工作区内相对路径：terminalId=${config.id}`,
          { reason: "workspace_terminal_cwd_not_relative", terminalId: config.id, workspaceId: operation.workspaceId, operationId: operation.operationId });
      }
    }
  });
}

/** app legacy 终端快照仍由原 app 事务 CAS 改写，W 配置只读校验。 */
function buildTerminalCwdPlan(
  db: ClientDb,
  operation: WorkspaceDirectoryMigrationRecord,
  platform: NodeJS.Platform,
  operationId: string | null = null,
): { snapshot: Record<string, string | null>; targets: Record<string, string | null> } {
  assertWorkspaceTerminalCwds(db, operation, platform, operationId);
  const pathApi = pathFor(platform);
  const snapshot: Record<string, string | null> = {};
  const targets: Record<string, string | null> = {};
  for (const config of db.terminalConfigs.listByWorkspace(operation.workspaceId)) {
    snapshot[config.id] = config.cwd;
    if (config.cwd === null || !pathApi.isAbsolute(config.cwd)) {
      targets[config.id] = config.cwd;
      continue;
    }
    const relative = pathApi.relative(operation.sourcePath, config.cwd);
    if (relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative))) {
      targets[config.id] = relative || ".";
      continue;
    }
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_TARGET_INVALID",
      `终端配置 cwd 位于源工作区之外：terminalId=${config.id}`,
      { reason: "legacy_terminal_cwd_external", terminalId: config.id },
    );
  }
  return { snapshot, targets };
}

async function renamePublishedTarget(
  operation: WorkspaceDirectoryMigrationRecord,
  platform: NodeJS.Platform,
): Promise<void> {
  const stagingPath = requireStagingPath(operation);
  assertPathAbsent(operation.targetPath, "WORKSPACE_MIGRATION_TARGET_CONFLICT");
  try {
    await fs.promises.rename(stagingPath, operation.targetPath);
    await syncDirectory(operation.targetParentPath, platform);
  } catch (error) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_SWITCH_FAILED",
      "发布迁移目标目录失败",
      summarizeError(error),
      { cause: error },
    );
  }
}

/** POSIX 上同步目录项变更；Windows 不支持稳定的目录 fsync，按现有边界跳过。 */
async function syncDirectory(directoryPath: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await fs.promises.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** staging 必须满足原命名边界，新模式还须证明没有未知受管数据库工件。 */
async function removeStagingIfSafe(
  operation: WorkspaceDirectoryMigrationRecord,
  platform: NodeJS.Platform,
  worker = new WorkspaceMigrationFileWorkerClient(),
  runTask?: RecoveryTaskRunner,
): Promise<void> {
  if (!operation.stagingPath || !pathExists(operation.stagingPath)) return;
  const expected = buildStagingPath(operation, platform);
  if (!pathsEqual(expected, operation.stagingPath, platform)) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
      "staging 路径不满足操作级安全边界",
      { reason: "staging_path_mismatch" },
    );
  }
  if (operation.workspaceDbSnapshot) {
    await verifyOperationDatabase(worker, operation, "cleanup", operation.stagingPath, requestIdForOperation(operation), runTask);
  }
  await fs.promises.rm(operation.stagingPath, { recursive: true, force: false });
}

/** operation 固定清单模式；null 精确保持旧完整静态 hash，禁止按现场猜测。 */
function manifestMode(operation: WorkspaceDirectoryMigrationRecord): WorkspaceMigrationManifestMode {
  return operation.workspaceDbSnapshot ? { operationId: operation.operationId } : null;
}

/** 恢复阶段没有原请求时保持 operation 关联，不使用路径或秘密构造日志 ID。 */
function requestIdForOperation(operation: WorkspaceDirectoryMigrationRecord): string { return `workspace-recovery:${operation.operationId}`; }

/** 原 Worker 执行固定目的只读校验；旧 null 模式不引入数据库旁路。 */
async function verifyOperationDatabase(worker: WorkspaceMigrationFileWorkerClient, operation: WorkspaceDirectoryMigrationRecord,
  purpose: "precommit" | "committed" | "cleanup", targetRoot: string, requestId: string, runTask?: RecoveryTaskRunner): Promise<void> {
  if (!operation.workspaceDbSnapshot) return;
  await runRecoveryTask(worker.verifyWorkspaceDb({ sourceRoot: operation.sourcePath, targetRoot, operationId: operation.operationId,
    workspaceId: operation.workspaceId, requestId, purpose, evidence: operation.workspaceDbSnapshot }), runTask);
}

type RecoveryTaskRunner = <T>(task: WorkspaceMigrationFileTask<T>) => Promise<T>;

/** Service 恢复复用原 owner；启动恢复也必须等待一次性 Worker 真实退出。 */
async function runRecoveryTask<T>(task: WorkspaceMigrationFileTask<T>, runTask?: RecoveryTaskRunner): Promise<T> {
  if (runTask) return await runTask(task);
  try { return await task.promise; }
  finally { await task.closed; }
}

/** 交接结果 await 后仅复核固定元数据，CAS→commit→Map 之间无异步窗口。 */
function assertSnapshotMetadata(operation: WorkspaceDirectoryMigrationRecord, evidence: WorkspaceMigrationSnapshotResult["evidence"]): void {
  assertDatabaseRoots(operation.sourcePath, operation.targetPath, evidence);
  if (evidence.state === "ready") {
    assertSameDatabaseMetadata(evidence.source, inspectDatabaseFile(path.join(operation.sourcePath, ".codeflowai", "workspace.db")));
    assertSameDatabaseMetadata(evidence.target, inspectDatabaseFile(path.join(operation.targetPath, ".codeflowai", "workspace.db")));
  } else assertDbArtifactsAbsent(operation.sourcePath, true, operation.operationId);
  assertDbArtifactsAbsent(operation.targetPath, evidence.state === "absent", operation.operationId);
}

function assertPathAbsent(
  targetPath: string,
  code: Extract<WorkspaceDirectoryMigrationErrorCode, "WORKSPACE_MIGRATION_TARGET_CONFLICT">,
): void {
  if (!pathExists(targetPath)) return;
  throw new WorkspaceMigrationServiceError(code, "目标目录或 staging 已存在", { reason: "path_exists" });
}

function pathExists(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSpaceAvailable(operationId: string, totalBytes: number, availableBytes: number): void {
  const margin = Math.max(MINIMUM_SPACE_MARGIN_BYTES, Math.ceil(totalBytes * SPACE_MARGIN_RATIO));
  const requiredBytes = totalBytes + margin;
  if (availableBytes >= requiredBytes) return;
  throw new WorkspaceMigrationServiceError(
    "WORKSPACE_MIGRATION_SPACE_INSUFFICIENT",
    "目标磁盘可用空间不足",
    { operationId, totalBytes, marginBytes: margin, requiredBytes, availableBytes },
  );
}

function activeResourcesError(
  operation: WorkspaceDirectoryMigrationRecord,
  blockers: WorkspaceMigrationActivityBlocker[],
): WorkspaceMigrationServiceError {
  return new WorkspaceMigrationServiceError(
    "WORKSPACE_MIGRATION_ACTIVE_RESOURCES",
    "工作区仍有活动资源，无法开始目录迁移",
    { operationId: operation.operationId, blockers },
  );
}

/** 用权威清单复核结构监听事件；只要内容和结构摘要不变，就清除事件噪声。 */
async function reconcileRuntimeWatchChanges(input: {
  operation: WorkspaceDirectoryMigrationRecord;
  runtime: OperationRuntime;
  expectedSourceManifestHash: string;
  expectedTargetManifestHash?: string;
  scan: RuntimeTreeScan;
}): Promise<void> {
  const { operation, runtime } = input;
  if (!runtime.sourceDirty && !runtime.targetDirty && !runtime.watcherError) return;
  if (runtime.watcherError) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
      "迁移目录监听失败，无法安全确认源目录或目标目录是否发生变化",
      {
        operationId: operation.operationId,
        sourceDirty: runtime.sourceDirty,
        targetDirty: runtime.targetDirty,
        watcherErrorCode: runtime.watcherError.code,
        watcherErrorDetails: sanitizeSourceChangeDetails(runtime.watcherError.details),
        ...sourceChangeDetails(runtime.sourceChangeEvidence),
      },
      { cause: runtime.watcherError },
    );
  }

  if (runtime.sourceDirtyBeforeRegenerableConfirmation) {
    throw new WorkspaceMigrationServiceError(
      "WORKSPACE_MIGRATION_SOURCE_CHANGED",
      "权威确认可重新生成目录前检测到源目录结构变化",
      {
        operationId: operation.operationId,
        reason: "source_structure_changed_before_regenerable_directories_confirmed",
        ...sourceChangeDetails(runtime.sourceChangeEvidence),
      },
    );
  }

  const sourceDirty = runtime.sourceDirty;
  const targetDirty = runtime.targetDirty;
  const sourceEventCount = runtime.sourceChangeEvidence.count;
  const targetEventCount = runtime.targetChangeCount;
  const sourceEvidence = sourceChangeDetails(runtime.sourceChangeEvidence);
  if (sourceDirty) {
    const source = await input.scan(operation.sourcePath, true);
    const actualSourceManifestHash = requireManifestHash(source.summary.manifestHash, operation.operationId, "source");
    if (actualSourceManifestHash !== input.expectedSourceManifestHash) {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_SOURCE_CHANGED",
        "源工作区内容已变化",
        {
          operationId: operation.operationId,
          reason: "source_manifest_changed_after_rename_event",
          sourceDirty: true,
          expectedManifestHash: input.expectedSourceManifestHash,
          actualManifestHash: actualSourceManifestHash,
          ...sourceEvidence,
        },
      );
    }
  }
  if (targetDirty) {
    const expectedTargetManifestHash = String(input.expectedTargetManifestHash ?? "").trim();
    if (!/^[a-f0-9]{64}$/i.test(expectedTargetManifestHash)) {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
        "目标目录发生变化但缺少可复核的目标清单摘要",
        { operationId: operation.operationId, reason: "target_manifest_missing_after_rename_event" },
      );
    }
    const target = await input.scan(operation.targetPath, false);
    const actualTargetManifestHash = requireManifestHash(target.summary.manifestHash, operation.operationId, "target");
    if (actualTargetManifestHash !== expectedTargetManifestHash) {
      throw new WorkspaceMigrationServiceError(
        "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
        "目标目录内容已变化",
        {
          operationId: operation.operationId,
          reason: "target_manifest_changed_after_rename_event",
          targetDirty: true,
          expectedManifestHash: expectedTargetManifestHash,
          actualManifestHash: actualTargetManifestHash,
          targetWatchEventCount: runtime.targetChangeCount,
          ...sourceEvidence,
        },
      );
    }
  }

  logger.info("workspace-migration", "workspace watcher events reconciled by manifest", {
    requestId: runtime.requestId,
    operationId: operation.operationId,
    workspaceId: operation.workspaceId,
    reason: "manifest_unchanged",
    sourceWatchEventCount: runtime.sourceChangeEvidence.count,
    sourceChangedPaths: runtime.sourceChangeEvidence.paths,
    targetWatchEventCount: runtime.targetChangeCount,
    sourceManifestHash: input.expectedSourceManifestHash,
    targetManifestHash: input.expectedTargetManifestHash ?? null,
  });
  if (runtime.sourceChangeEvidence.count === sourceEventCount) {
    runtime.sourceDirty = false;
    runtime.sourceChangeEvidence = createSourceChangeEvidence();
  }
  if (runtime.targetChangeCount === targetEventCount) {
    runtime.targetDirty = false;
    runtime.targetChangeCount = 0;
  }
}

/** 创建有界的源目录变化证据；路径最多保留 50 个工作区相对路径。 */
function createSourceChangeEvidence(): SourceChangeEvidence {
  return { count: 0, paths: [] };
}

/** 记录源监听事件，拒绝绝对路径和路径穿越，避免日志泄露本机路径。 */
function recordSourceChange(evidence: SourceChangeEvidence, relativePath: string | null): void {
  evidence.count += 1;
  const normalized = normalizeSourceChangePath(relativePath);
  if (!normalized || evidence.paths.includes(normalized) || evidence.paths.length >= MAX_SOURCE_CHANGE_PATHS) return;
  evidence.paths.push(normalized);
}

/** 将源监听证据转换为可持久化、可传输的错误详情。 */
function sourceChangeDetails(evidence: SourceChangeEvidence): Record<string, unknown> {
  if (evidence.count <= 0) return {};
  return { sourceChangeCount: evidence.count, sourceChangedPaths: [...evidence.paths] };
}

/** 将 Worker 的源变化错误与监听到的相对路径合并，避免只剩 manifest 摘要。 */
function addSourceChangeEvidence(
  failure: WorkspaceMigrationServiceError,
  evidence: SourceChangeEvidence,
): WorkspaceMigrationServiceError {
  if (failure.code !== "WORKSPACE_MIGRATION_SOURCE_CHANGED") return failure;
  const details = sanitizeSourceChangeDetails(asDetails(failure.details));
  const existingPaths = Array.isArray(details.sourceChangedPaths)
    ? details.sourceChangedPaths
      .map((value) => normalizeSourceChangePath(value))
      .filter((value): value is string => Boolean(value))
    : [];
  const paths: string[] = [];
  const pathKeys = new Set<string>();
  for (const value of [...existingPaths, ...evidence.paths]) {
    const key = value.toLowerCase();
    if (pathKeys.has(key)) continue;
    pathKeys.add(key);
    paths.push(value);
    if (paths.length >= MAX_SOURCE_CHANGE_PATHS) break;
  }
  const currentCount = Number(details.sourceChangeCount);
  if (evidence.count <= 0 && !paths.length && !Number.isSafeInteger(currentCount)) {
    return new WorkspaceMigrationServiceError(failure.code, failure.message, details, { cause: failure });
  }
  return new WorkspaceMigrationServiceError(
    failure.code,
    failure.message,
    {
      ...details,
      sourceChangeCount: Math.max(Number.isSafeInteger(currentCount) ? currentCount : 0, evidence.count, paths.length),
      sourceChangedPaths: paths,
    },
    { cause: failure },
  );
}

/** 在 Service 边界清洗源变化详情，避免异常路径进入日志和持久化错误。 */
function sanitizeSourceChangeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...details };
  if ("relativePath" in sanitized) {
    const relativePath = normalizeSourceChangePath(sanitized.relativePath);
    if (relativePath) sanitized.relativePath = relativePath;
    else delete sanitized.relativePath;
  }
  if ("sourceChangedPaths" in sanitized) {
    const paths = Array.isArray(sanitized.sourceChangedPaths)
      ? sanitized.sourceChangedPaths
        .map((value) => normalizeSourceChangePath(value))
        .filter((value): value is string => Boolean(value))
        .slice(0, MAX_SOURCE_CHANGE_PATHS)
      : [];
    sanitized.sourceChangedPaths = paths;
  }
  delete sanitized.absolutePath;
  delete sanitized.sourcePath;
  delete sanitized.targetPath;
  delete sanitized.stderrSummary;
  return sanitized;
}

/** 标准化 Worker 传来的相对路径，仅允许工作区内路径。 */
function normalizeSourceChangePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1_000) return null;
  const normalized = value.trim().replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (!normalized
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.startsWith("/")
    || /^[a-z]:/iu.test(normalized)
    || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return normalized.slice(0, 1_000);
}

async function stopWatchers(runtime: OperationRuntime): Promise<void> {
  const watchers = [runtime.sourceWatcher, runtime.targetWatcher].filter(
    (watcher): watcher is WorkspaceMigrationFileWatcher => Boolean(watcher),
  );
  if (!watchers.length) return;
  const results = await Promise.allSettled(watchers.map(watcher => watcher.stop()));
  for (let index = 0; index < watchers.length; index++) {
    if (results[index]!.status !== "fulfilled") continue;
    if (runtime.sourceWatcher === watchers[index]) runtime.sourceWatcher = null;
    if (runtime.targetWatcher === watchers[index]) runtime.targetWatcher = null;
  }
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "WORKSPACE_MIGRATION_WATCHER_CLOSE_FAILED", { cause: errors[0] });
}

/** 提交点后 watcher 仅负责释放资源；关闭失败需记录，但不能逆转唯一目标事实。 */
async function stopWatchersAfterCommit(
  runtime: OperationRuntime,
  requestId: string,
  operation: WorkspaceDirectoryMigrationRecord,
): Promise<void> {
  try {
    await stopWatchers(runtime);
  } catch (error) {
    logger.error("workspace-migration", "workspace watcher cleanup failed after path commit", {
      code: "workspace_migration_post_commit_watcher_cleanup_failed",
      requestId,
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      state: operation.state,
      stateVersion: operation.stateVersion,
      rootCause: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function createRuntime(requestId: string): OperationRuntime {
  return {
    finalHandoff: null,
    handoffDeadline: null,
    requestId,
    cancelRequested: false,
    sourceDirty: false,
    targetDirty: false,
    targetChangeCount: 0,
    targetBaselineReady: false,
    watcherError: null,
    sourceChangeEvidence: createSourceChangeEvidence(),
    sourceWatcher: null,
    targetWatcher: null,
    confirmedRegenerableDirectories: [],
    regenerableDirectoriesConfirmed: false,
    sourceDirtyBeforeRegenerableConfirmation: false,
  };
}

function requireManifestHash(value: string | null, operationId: string, kind: "source" | "target"): string {
  const hash = String(value ?? "").trim();
  if (/^[a-f0-9]{64}$/i.test(hash)) return hash;
  throw new WorkspaceMigrationServiceError(
    "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
    `迁移缺少有效的 ${kind} 清单摘要`,
    { operationId, kind },
  );
}

function requireStagingPath(operation: WorkspaceDirectoryMigrationRecord): string {
  const stagingPath = String(operation.stagingPath ?? "").trim();
  if (stagingPath) return stagingPath;
  throw new WorkspaceMigrationServiceError(
    "WORKSPACE_MIGRATION_RECOVERY_REQUIRED",
    "迁移缺少 staging 路径",
    { operationId: operation.operationId },
  );
}

function toServiceError(error: unknown, fallbackCode: WorkspaceDirectoryMigrationErrorCode): WorkspaceMigrationServiceError {
  if (error instanceof WorkspaceMigrationServiceError) return error;
  if (error instanceof WorkspaceMigrationFileClientError) {
    const code = error.code === "WORKSPACE_MIGRATION_FILE_CANCELLED" ? "WORKSPACE_MIGRATION_INTERRUPTED" : error.code;
    return new WorkspaceMigrationServiceError(code, error.message, error.details, { cause: error });
  }
  if (error instanceof StorageClassifierError || error instanceof WorkspaceDirectoryMigrationRepoError) {
    return new WorkspaceMigrationServiceError(error.code, error.message, asDetails(error.details), { cause: error });
  }
  if (error instanceof WorkspaceOperationGateError) {
    return new WorkspaceMigrationServiceError(error.code, error.message, error.details, { cause: error });
  }
  return new WorkspaceMigrationServiceError(
    fallbackCode,
    error instanceof Error ? error.message : String(error),
    summarizeError(error),
    error === undefined ? undefined : { cause: error },
  );
}

function isWorkerCancelled(error: unknown): boolean {
  return error instanceof WorkspaceMigrationFileClientError && error.code === "WORKSPACE_MIGRATION_FILE_CANCELLED";
}

function isBeforePublish(state: WorkspaceDirectoryMigrationState): boolean {
  return state === "preparing" || state === "copying" || state === "verifying";
}

function requiresExclusiveGate(state: WorkspaceDirectoryMigrationState): boolean {
  return state === "preparing"
    || state === "copying"
    || state === "verifying"
    || state === "publish_intent"
    || state === "target_ready"
    || state === "path_committed"
    || state === "finalizing"
    || state === "recovery_required";
}

function defaultCaseSensitive(platform: NodeJS.Platform): boolean {
  return platform !== "win32" && platform !== "darwin";
}

/** 只忽略可明确定位到本地索引库的 watcher 事件；缺失路径继续 fail closed。 */
function isWorkspacePathIndexWatchEvent(relativePath: string | null, caseSensitive: boolean): boolean {
  return relativePath !== null && isWorkspacePathIndexStorageRelPath(relativePath, { caseSensitive });
}

/** 把目标父目录 watcher 的过滤前缀剥离成工作区相对路径。 */
function removeWatchPathPrefix(
  relativePath: string | null,
  prefix: string,
  caseSensitive: boolean,
): string | null {
  if (relativePath === null) return null;
  const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\/+|\/+$/g, "");
  const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/^\.\/+|\/+$/g, "");
  const comparedPath = caseSensitive ? normalizedPath : normalizedPath.toLowerCase();
  const comparedPrefix = caseSensitive ? normalizedPrefix : normalizedPrefix.toLowerCase();
  if (comparedPath === comparedPrefix) return "";
  if (!comparedPath.startsWith(`${comparedPrefix}/`)) return null;
  return normalizedPath.slice(normalizedPrefix.length + 1);
}

function pathFor(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathsEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
  const pathApi = pathFor(platform);
  const normalizedLeft = pathApi.resolve(left).replace(/[\\/]+$/, "");
  const normalizedRight = pathApi.resolve(right).replace(/[\\/]+$/, "");
  return defaultCaseSensitive(platform)
    ? normalizedLeft === normalizedRight
    : normalizedLeft.toUpperCase() === normalizedRight.toUpperCase();
}

function isSameOrDescendant(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const pathApi = pathFor(platform);
  const relative = pathApi.relative(root, candidate);
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { rootCauseType: typeof error };
  const rootCauseType = String((error as { name?: unknown }).name ?? error.constructor?.name ?? "Error");
  const osErrorCode = String((error as NodeJS.ErrnoException).code ?? "").trim();
  return {
    rootCauseType,
    ...(osErrorCode ? { osErrorCode } : {}),
  };
}

function asDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
