import path from "node:path";
import { workspacePathIndexDatabasePath } from "../fs/workspacePathIndexConfig.js";

import type { FsReindexResponseBody, WorkspaceId } from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import type { WorkspaceDirectoryMigrationRecord } from "../db/repos/workspaceDirectoryMigrationRepo.js";
import {
  type WorkspacePathIndex,
  type WorkspacePathIndexLifecycleEvent,
  type WorkspacePathIndexOperationContext,
} from "../fs/workspacePathIndexService.js";
import {
  assertWorkspaceRootAvailable,
  WorkspaceRootConflictError,
} from "../fs/workspaceRootOwnership.js";
import { logger, type WorkspaceLogEntry } from "../logger.js";
import type {
  WorkspaceMigrationIndexCoordinator,
  WorkspaceMigrationIndexReservation,
} from "./workspaceMigrationService.js";

const DEFAULT_BUILDING_TIMEOUT_MS = 120_000;
const DEFAULT_QUEUED_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_CHECK_INTERVAL_MS = 30_000;

export type WorkspaceMigrationIndexCoordinatorOptions = {
  db: ClientDb;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  pathIndex: WorkspacePathIndex;
  onOperationChanged?: (operation: WorkspaceDirectoryMigrationRecord) => void;
  onFatalError?: (error: Error) => void;
  now?: () => number;
  buildingTimeoutMs?: number;
  queuedTimeoutMs?: number;
  timeoutCheckIntervalMs?: number;
};

/** 把 PathIndex generation 生命周期投影到目录迁移事实表，并负责超时和重启恢复。 */
export class WorkspaceMigrationIndexCoordinatorService implements WorkspaceMigrationIndexCoordinator {
  private readonly now: () => number;
  private readonly buildingTimeoutMs: number;
  private readonly queuedTimeoutMs: number;
  private readonly unsubscribeLifecycle: () => void;
  private readonly timeoutTimer: ReturnType<typeof setInterval> | null;
  private timeoutCheck: (Promise<void> & { result?: PromiseSettledResult<void> }) | null = null;
  private disposed = false;
  private lifecycleWork: (Promise<void> & { failure?: { error: unknown } }) | null = null;

  constructor(private readonly options: WorkspaceMigrationIndexCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.buildingTimeoutMs = normalizePositiveDelay(options.buildingTimeoutMs, DEFAULT_BUILDING_TIMEOUT_MS);
    this.queuedTimeoutMs = normalizePositiveDelay(options.queuedTimeoutMs, DEFAULT_QUEUED_TIMEOUT_MS);
    this.unsubscribeLifecycle = options.pathIndex.subscribeLifecycle((event) => this.acceptLifecycleEvent(event));
    const intervalMs = normalizePositiveDelay(options.timeoutCheckIntervalMs, DEFAULT_TIMEOUT_CHECK_INTERVAL_MS);
    this.timeoutTimer = intervalMs > 0
      ? setInterval(() => {
        this.checkTimeouts();
      }, intervalMs)
      : null;
    this.timeoutTimer?.unref?.();
  }

  /** 迁移索引持久事实与回调投影使用短许可，Worker终止在许可外等待。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.options.withLegacyDatabase ? this.options.withLegacyDatabase("workspace-migration-index", operation) : operation();
  }

  /** 已接收事件保序进入当前协调器尾链，失败由wait/dispose交付且阻断后续事件。 */
  private acceptLifecycleEvent(event: WorkspacePathIndexLifecycleEvent): void {
    if (this.disposed) return;
    if (!this.options.withLegacyDatabase) { this.handleLifecycleEvent(event); return; }
    const run = () => this.withDatabase(() => this.handleLifecycleEvent(event));
    const pending: NonNullable<typeof this.lifecycleWork> = this.lifecycleWork ? this.lifecycleWork.then(run) : run();
    this.lifecycleWork = pending;
    void pending.then(() => { if (this.lifecycleWork === pending) this.lifecycleWork = null; }, error => { pending.failure = { error }; });
  }

  /** 为已提交路径预留索引 generation；数据库持久化成功后才允许调用 start。 */
  async reserveForMigration(operation: WorkspaceDirectoryMigrationRecord): Promise<WorkspaceMigrationIndexReservation> {
    if (this.lifecycleWork) await this.lifecycleWork;
    const reservation = this.options.pathIndex.reserveWorkspaceRebuild(operation.workspaceId, operation.targetPath);
    if (reservation.kind === "not_applicable") return { kind: "not_applicable" };
    return {
      kind: "pending",
      generation: reservation.generation,
      start: () => this.options.pathIndex.startReservedWorkspaceRebuild(operation.workspaceId, reservation.generation),
      cancel: () => this.options.pathIndex.cancelReservedWorkspaceRebuild(operation.workspaceId, reservation.generation),
    };
  }

  /** Client 启动时为每个 pending 操作换发新 generation，再启动 Worker。 */
  async recoverPendingOnStartup(): Promise<void> {
    if (this.lifecycleWork) await this.lifecycleWork;
    const completedPending = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.listDirectoryMigrationIndexStates()));
    for (const operation of completedPending) {
      if (operation.indexRebuildStatus !== "pending") continue;
      if ((await this.withDatabase(() => this.rejectStartupRootConflict(operation)))) continue;
      await this.replaceGeneration(operation, "startup_recovery");
    }
  }

  /** 启动换代前复核持久 owner，避免 completed pending 早于全局冲突扫描打开共享物理库。 */
  private rejectStartupRootConflict(operation: WorkspaceDirectoryMigrationRecord): boolean {
    const workspaces = new Map<WorkspaceId, string>(
      this.options.db.workspaces.list().map((workspace) => [workspace.id, workspace.path]),
    );
    try {
      assertWorkspaceRootAvailable(workspaces, operation.workspaceId, operation.targetPath);
      return false;
    } catch (error) {
      if (!(error instanceof WorkspaceRootConflictError)) throw error;
      let current = this.options.db.workspaceDirectoryMigrations.require(operation.operationId);
      if (
        current.state === "completed"
        && current.indexRebuildStatus === "pending"
        && current.indexRebuildGeneration !== null
      ) {
        const failed = this.options.db.workspaceDirectoryMigrations.completeIndexRebuild({
          operationId: current.operationId,
          expectedStateVersion: current.stateVersion,
          expectedGeneration: current.indexRebuildGeneration,
          status: "failed",
          warningDetails: {
            reason: "workspace_root_already_registered",
            conflictingWorkspaceIds: error.conflictingWorkspaceIds,
            workspaceRootKey: error.workspaceRootKey,
          },
          now: this.now(),
        });
        current = failed.operation;
        if (failed.applied) this.emitChanged(current);
      }
      logger.error("workspace-migration-index", "workspace migration index startup root conflict", {
        code: "workspace_migration_index_startup_root_conflict",
        requestId: null,
        operationId: current.operationId,
        workspaceId: current.workspaceId,
        generation: current.indexRebuildGeneration,
        indexPath: resolveIndexPath(current.targetPath),
        conflictingWorkspaceIds: error.conflictingWorkspaceIds,
        workspaceRootKey: error.workspaceRootKey,
        rootCause: error.message,
      });
      return true;
    }
  }

  /** 手工重建时接管迁移遗留的 pending/failed 状态，否则走普通 PathIndex 重建。 */
  async rebuildWorkspace(
    workspaceId: WorkspaceId,
    workspacePath: string,
    context?: WorkspacePathIndexOperationContext,
  ): Promise<FsReindexResponseBody> {
    if (this.lifecycleWork) await this.lifecycleWork;
    const blocking = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.getLatestCompletedWithBlockingIndex(workspaceId)));
    (await this.withDatabase(() => this.assertManualRebuildRootAvailable(workspaceId, workspacePath, blocking, context)));
    if (!blocking) return this.options.pathIndex.rebuildWorkspace(workspaceId, workspacePath, context);
    if (blocking.indexRebuildStatus === "pending" && blocking.indexRebuildGeneration !== null) {
      try {
        await this.options.pathIndex.terminateWorkspaceRebuild(
          workspaceId,
          blocking.indexRebuildGeneration,
          "手工重建已替换旧 generation",
          context,
        );
      } catch (error) {
        const latest = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(blocking.operationId)));
        const failed = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.completeIndexRebuild({
          operationId: latest.operationId,
          expectedStateVersion: latest.stateVersion,
          expectedGeneration: blocking.indexRebuildGeneration!,
          status: "failed",
          warningDetails: {
            reason: "manual_reindex_termination_failed",
            rootCause: summarizeError(error),
          },
          now: this.now(),
        })));
        if (failed.applied) (await this.withDatabase(() => this.emitChanged(failed.operation, context)));
        (await this.withDatabase(() => this.writeLog(blocking, "error", "workspace migration index manual replacement termination failed", {
          code: "workspace_migration_index_manual_replacement_termination_failed",
          requestId: String(context?.requestId ?? "").trim() || null,
          operationId: blocking.operationId,
          workspaceId,
          generation: blocking.indexRebuildGeneration,
          indexPath: path.normalize(workspacePathIndexDatabasePath(path.resolve(workspacePath))),
          rootCause: summarizeError(error),
        }, { reason: error })));
        throw error;
      }
    }
    const replaced = await this.replaceGeneration(blocking, "manual_reindex", context);
    return replaced.kind === "not_applicable"
      ? { indexStatus: "disabled", indexedCount: 0, partial: true, message: "工作区路径索引已禁用" }
      : { indexStatus: "queued", indexedCount: 0, partial: true, message: "索引等待手工重建" };
  }

  /** 手工重建也必须复核持久 owner，不能绕过启动或 warmup 已发现的物理根冲突。 */
  private assertManualRebuildRootAvailable(
    workspaceId: WorkspaceId,
    workspacePath: string,
    operation: WorkspaceDirectoryMigrationRecord | null,
    context?: WorkspacePathIndexOperationContext,
  ): void {
    const workspaces = new Map<WorkspaceId, string>(
      this.options.db.workspaces.list().map((workspace) => [workspace.id, workspace.path]),
    );
    try {
      assertWorkspaceRootAvailable(workspaces, workspaceId, workspacePath);
    } catch (error) {
      if (!(error instanceof WorkspaceRootConflictError)) throw error;
      logger.error("workspace-migration-index", "workspace migration index manual rebuild root conflict", {
        code: "workspace_migration_index_manual_root_conflict",
        requestId: normalizeOperationRequestId(context),
        operationId: operation?.operationId ?? null,
        workspaceId,
        generation: operation?.indexRebuildGeneration ?? null,
        indexPath: path.normalize(workspacePathIndexDatabasePath(error.workspaceRoot)),
        conflictingWorkspaceIds: error.conflictingWorkspaceIds,
        workspaceRootKey: error.workspaceRootKey,
        rootCause: error.message,
      });
      throw error;
    }
  }

  /** 检查 queued/building 心跳超时；终止失败也必须把迁移索引显式落为 failed。 */
  checkTimeouts(): Promise<void> {
    if (this.timeoutCheck && this.timeoutCheck.result?.status !== "fulfilled") return this.timeoutCheck;
    const execution = this.checkTimeoutsOnce() as NonNullable<typeof this.timeoutCheck>;
    this.timeoutCheck = execution;
    void execution.then(value => { execution.result = { status: "fulfilled", value }; }, reason => { execution.result = { status: "rejected", reason }; });
    return execution;
  }

  /** 收齐超时与已接收生命周期尾链；任一失败保持显式失败。 */
  async waitForIdle(): Promise<void> {
    const work = this.timeoutCheck;
    try {
      const results = await Promise.allSettled([...(work ? [work] : []), ...(this.lifecycleWork ? [this.lifecycleWork] : [])]);
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "WORKSPACE_MIGRATION_INDEX_DRAIN_FAILED", { cause: failures[0] });
      while (this.lifecycleWork) await this.lifecycleWork;
    }
    finally { if (this.timeoutCheck === work) this.timeoutCheck = null; }
  }

  /** 停止新超时检查并等待已在途检查，不终止 PathIndex 自身。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribeLifecycle();
    if (this.timeoutTimer) clearInterval(this.timeoutTimer);
    await this.waitForIdle();
  }

  /** 用新的内存 generation CAS 替换 completed 操作中的旧索引代次。 */
  private async replaceGeneration(
    initial: WorkspaceDirectoryMigrationRecord,
    reason: "startup_recovery" | "manual_reindex",
    context?: WorkspacePathIndexOperationContext,
  ): Promise<{ kind: "not_applicable" } | { kind: "pending"; generation: number }> {
    const current = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(initial.operationId)));
    if (current.state !== "finalizing" && current.state !== "completed") {
      throw new Error(`索引 generation 换代状态非法：operationId=${current.operationId}, state=${current.state}`);
    }
    const expectedState = current.state;
    const reservation = this.options.pathIndex.reserveWorkspaceRebuild(current.workspaceId, current.targetPath, context);
    if (reservation.kind === "not_applicable") {
      const updated = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.setIndexRebuildNotApplicable({
        operationId: current.operationId,
        expectedState,
        expectedStateVersion: current.stateVersion,
        now: this.now(),
      })));
      (await this.withDatabase(() => this.emitChanged(updated, context)));
      return { kind: "not_applicable" };
    }
    let updated: WorkspaceDirectoryMigrationRecord;
    try {
      const now = this.now();
      updated = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.setIndexRebuildPending({
        operationId: current.operationId,
        expectedState,
        expectedStateVersion: current.stateVersion,
        generation: reservation.generation,
        phase: "queued",
        lastProgressAt: now,
        now,
      })));
    } catch (error) {
      let failure = error;
      try { (await this.withDatabase(() => this.writeLog(current, "error", "workspace migration index generation persistence failed", {
        code: "workspace_migration_index_generation_persist_failed",
        requestId: normalizeOperationRequestId(context),
        operationId: current.operationId,
        workspaceId: current.workspaceId,
        generation: reservation.generation,
        indexPath: resolveIndexPath(current.targetPath),
        rootCause: summarizeError(error),
      }, { reason: error }))); }
      catch (logError) { failure = logError; }
      try {
        this.options.pathIndex.cancelReservedWorkspaceRebuild(current.workspaceId, reservation.generation);
      } catch (cancelError) {
        failure = new AggregateError([failure, cancelError], "WORKSPACE_MIGRATION_INDEX_RESERVATION_CANCEL_FAILED", { cause: failure });
        try { (await this.withDatabase(() => this.writeLog(current, "error", "workspace migration index reservation compensation failed", {
          code: "workspace_migration_index_reservation_cancel_failed",
          requestId: normalizeOperationRequestId(context),
          operationId: current.operationId,
          workspaceId: current.workspaceId,
          generation: reservation.generation,
          indexPath: resolveIndexPath(current.targetPath),
          primaryRootCause: summarizeError(error),
          rootCause: summarizeError(cancelError),
        }, { reason: failure }))); }
        catch (logError) { failure = logError; }
      }
      throw failure;
    }
    (await this.withDatabase(() => this.emitChanged(updated, context)));
    (await this.withDatabase(() => this.writeLog(updated, "info", "workspace migration index generation replaced", {
      code: "workspace_migration_index_generation_replaced",
      requestId: normalizeOperationRequestId(context),
      operationId: updated.operationId,
      workspaceId: updated.workspaceId,
      generation: reservation.generation,
      indexPath: resolveIndexPath(updated.targetPath),
      reason,
      rootCause: "migration index generation replaced after durable reservation",
    })));
    this.options.pathIndex.startReservedWorkspaceRebuild(current.workspaceId, reservation.generation);
    return { kind: "pending", generation: reservation.generation };
  }

  /** 同步处理 Worker 生命周期；generation 不匹配时只记录 fence 日志。 */
  private handleLifecycleEvent(event: WorkspacePathIndexLifecycleEvent): void {
    let operation: WorkspaceDirectoryMigrationRecord | null = null;
    try {
      operation = this.findPendingOperation(event.workspaceId, event.generation);
      if (!operation) {
        this.writeLog(event.workspaceId, "info", "workspace migration index stale generation ignored", {
          code: "workspace_migration_index_stale_generation_ignored",
          requestId: null,
          workspaceId: event.workspaceId,
          generation: event.generation,
          indexPath: this.resolveWorkspaceIndexPath(event.workspaceId),
          eventType: event.type,
          rootCause: "no pending migration operation matches the workspace generation",
        });
        return;
      }
      if (event.type === "building" || event.type === "heartbeat") {
        const touched = this.options.db.workspaceDirectoryMigrations.touchIndexRebuildProgress({
          operationId: operation.operationId,
          expectedGeneration: event.generation,
          phase: "building",
          lastProgressAt: event.at,
          now: event.at,
        });
        if (!touched.applied) this.logStaleOperationEvent(operation, event);
        return;
      }
      if (operation.state !== "completed") throw new Error("WORKSPACE_MIGRATION_INDEX_STARTED_BEFORE_RELEASE");
      const completed = this.options.db.workspaceDirectoryMigrations.completeIndexRebuild({
        operationId: operation.operationId,
        expectedStateVersion: operation.stateVersion,
        expectedGeneration: event.generation,
        status: event.type === "done" ? "ready" : "failed",
        warningDetails: event.type === "failed"
          ? { reason: "worker_failed", error: event.error }
          : null,
        now: event.at,
      });
      if (!completed.applied) {
        this.logStaleOperationEvent(operation, event);
        return;
      }
      this.emitChanged(completed.operation);
    } catch (error) {
      const data = { code: "workspace_migration_index_lifecycle_persist_failed", requestId: null,
        operationId: operation?.operationId ?? null, workspaceId: event.workspaceId, generation: event.generation,
        eventType: event.type, rootCause: summarizeError(error) };
      if (operation) this.writeLog(operation, "error", "workspace migration index persistence failed", data, { reason: error });
      else this.writeLog(event.workspaceId, "error", "workspace migration index persistence failed", data, { reason: error });
      throw Object.assign(new AggregateError([error], "WORKSPACE_MIGRATION_INDEX_PERSIST_FAILED", { cause: error }), { code: "WORKSPACE_MIGRATION_INDEX_PERSIST_FAILED" });
    }
  }

  /** 逐条终止超时 generation，并以 warning 详情持久化失败原因。 */
  private async checkTimeoutsOnce(): Promise<void> {
    if (this.lifecycleWork) await this.lifecycleWork;
    const now = this.now();
    let operations: WorkspaceDirectoryMigrationRecord[];
    try { operations = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.listDirectoryMigrationIndexStates())); }
    catch (error) {
      try { logger.error("workspace-migration-index", "workspace migration index timeout enumeration failed", {
        code: "workspace_migration_index_timeout_enumeration_failed", requestId: null, workspaceId: null, rootCause: summarizeError(error),
      }); }
      catch (logError) { throw new AggregateError([error, logError], "WORKSPACE_MIGRATION_INDEX_ENUMERATION_LOG_FAILED", { cause: error }); }
      throw error;
    }
    for (const operation of operations) {
      if (operation.indexRebuildStatus !== "pending" || operation.indexRebuildGeneration === null) continue;
      const phase = operation.indexRebuildPhase ?? "queued";
      const lastProgressAt = operation.indexRebuildLastProgressAt ?? operation.updatedAt;
      const timeoutMs = phase === "building" ? this.buildingTimeoutMs : this.queuedTimeoutMs;
      if (now - lastProgressAt <= timeoutMs) continue;
      let termination: { error: unknown } | null = null;
      try {
        await this.options.pathIndex.terminateWorkspaceRebuild(
          operation.workspaceId,
          operation.indexRebuildGeneration,
          `索引 ${phase} 超时`,
          { requestId: null },
        );
      } catch (error) {
        termination = { error };
        (await this.withDatabase(() => this.writeLog(operation, "error", "workspace migration index timeout termination failed", {
          code: "workspace_migration_index_timeout_termination_failed",
          requestId: null,
          operationId: operation.operationId,
          workspaceId: operation.workspaceId,
          generation: operation.indexRebuildGeneration,
          indexPath: resolveIndexPath(operation.targetPath),
          phase,
          rootCause: summarizeError(error),
        }, { reason: error })));
      }
      let completed: ReturnType<ClientDb["workspaceDirectoryMigrations"]["completeIndexRebuild"]>;
      try {
        const latest = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.require(operation.operationId)));
        completed = (await this.withDatabase(() => this.options.db.workspaceDirectoryMigrations.completeIndexRebuild({
          operationId: latest.operationId,
          expectedStateVersion: latest.stateVersion,
          expectedGeneration: operation.indexRebuildGeneration!,
          status: "failed",
          warningDetails: {
            reason: "timeout",
            phase,
            timeoutMs,
            lastProgressAt,
            terminationError: termination ? summarizeError(termination.error) : null,
          },
          now,
        })));
      } catch (error) {
        const failure = termination ? new AggregateError([termination.error, error], "WORKSPACE_MIGRATION_INDEX_TIMEOUT_SETTLEMENT_FAILED", { cause: termination.error }) : error;
        (await this.withDatabase(() => this.writeLog(operation, "error", "workspace migration index timeout persistence failed", {
          code: "workspace_migration_index_timeout_persist_failed", requestId: null, rootCause: summarizeError(error),
        }, { reason: failure })));
        throw failure;
      }
      if (!completed.applied) { if (termination) throw termination.error; continue; }
      (await this.withDatabase(() => this.emitChanged(completed.operation)));
      (await this.withDatabase(() => this.writeLog(completed.operation, "warn", "workspace migration index rebuild timed out", {
        code: "workspace_migration_index_rebuild_timeout",
        requestId: null,
        operationId: completed.operation.operationId,
        workspaceId: completed.operation.workspaceId,
        generation: operation.indexRebuildGeneration,
        indexPath: resolveIndexPath(completed.operation.targetPath),
        phase,
        timeoutMs,
        terminationError: termination ? summarizeError(termination.error) : null,
        rootCause: termination
          ? summarizeError(termination.error)
          : `index rebuild ${phase} exceeded ${timeoutMs}ms`,
      }, termination ? { reason: termination.error } : undefined)));
      if (termination) throw termination.error;
    }
  }

  /** 查找与 Worker 事件完全匹配的 pending 迁移索引事实。 */
  private findPendingOperation(workspaceId: WorkspaceId, generation: number): WorkspaceDirectoryMigrationRecord | null {
    return this.options.db.workspaceDirectoryMigrations.listDirectoryMigrationIndexStates().find((operation) => (
      operation.workspaceId === workspaceId
      && operation.indexRebuildStatus === "pending"
      && operation.indexRebuildGeneration === generation
    )) ?? null;
  }

  /** 通知失败保原 pending ACK，同时明确拒绝当前调用并停止后续启动。 */
  private emitChanged(
    operation: WorkspaceDirectoryMigrationRecord,
    context?: WorkspacePathIndexOperationContext,
  ): void {
    try {
      this.options.onOperationChanged?.(operation);
    } catch (error) {
      this.writeLog(operation, "error", "workspace migration index notification failed", {
        code: "workspace_migration_index_notification_failed",
        requestId: normalizeOperationRequestId(context),
        operationId: operation.operationId,
        workspaceId: operation.workspaceId,
        generation: operation.indexRebuildGeneration,
        indexPath: resolveIndexPath(operation.targetPath),
        stateVersion: operation.stateVersion,
        notificationPending: operation.notificationPending,
        rootCause: summarizeError(error),
      }, { reason: error });
      throw error;
    }
  }

  /** 记录已由持久化 generation fence 拒绝的事件。 */
  private logStaleOperationEvent(
    operation: WorkspaceDirectoryMigrationRecord,
    event: WorkspacePathIndexLifecycleEvent,
  ): void {
    this.writeLog(operation, "info", "workspace migration index event fenced", {
      code: "workspace_migration_index_event_fenced",
      requestId: null,
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      generation: event.generation,
      indexPath: resolveIndexPath(operation.targetPath),
      eventType: event.type,
      rootCause: "persistent generation or state-version fence rejected the lifecycle event",
    });
  }

  /** 匹配 operation 的诊断沿可信固定 writer，拒写保原原因且不驱动进程退出。 */
  private writeLog(operation: WorkspaceDirectoryMigrationRecord | WorkspaceId, level: WorkspaceLogEntry["level"], message: string,
    data: Record<string, unknown>, business?: { reason: unknown }): void {
    const workspaceId = typeof operation === "string" ? operation : operation.workspaceId;
    const record = typeof operation === "string" ? null : operation;
    try {
      this.options.db.writeWorkspaceLog(workspaceId, { level, tag: "workspace-migration-index", message, data: {
        operationId: record?.operationId ?? null, workspaceId, generation: record?.indexRebuildGeneration ?? null,
        requestId: null, indexPath: record ? resolveIndexPath(record.targetPath) : this.resolveWorkspaceIndexPath(workspaceId), ...data,
      } });
    } catch (error) {
      throw Object.assign(new AggregateError(business ? [business.reason, error] : [error], "WORKSPACE_MIGRATION_INDEX_LOG_FAILED", {
        cause: business ? business.reason : error,
      }), { code: "WORKSPACE_MIGRATION_INDEX_LOG_FAILED", workspaceId, operationId: record?.operationId ?? null });
    }
  }

  /** 仅由可信注册事实补充索引路径，数据库读取失败由调用边界显式报告。 */
  private resolveWorkspaceIndexPath(workspaceId: WorkspaceId | null): string | null {
    if (!workspaceId) return null;
    const workspace = this.options.db.workspaces.getIncludingDeleted(workspaceId);
    return workspace ? resolveIndexPath(workspace.path) : null;
  }
}

/** 规范化正数延迟；显式 0 用于测试关闭周期计时器。 */
function normalizePositiveDelay(value: number | undefined, fallback: number): number {
  if (value === 0) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** 把未知异常收敛为可结构化记录的错误文本。 */
function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 将工作区根转换为固定的本地文件索引路径。 */
function resolveIndexPath(workspacePath: string): string {
  return path.normalize(workspacePathIndexDatabasePath(path.resolve(workspacePath)));
}

/** 后台操作返回 null；只有真实 RPC 上下文才记录 requestId。 */
function normalizeOperationRequestId(context?: WorkspacePathIndexOperationContext): string | null {
  const requestId = String(context?.requestId ?? "").trim();
  return requestId || null;
}
