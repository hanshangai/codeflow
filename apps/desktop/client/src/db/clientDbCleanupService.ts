import crypto from "node:crypto";
import fs from "node:fs";

import type {
  ClientDbCleanupPhase,
  ClientDbCleanupSnapshot,
  ClientDbStorageSummary,
  SharedWorkspaceId,
  ThreadId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "./clientDb.js";
import { openSqliteDb, type SqliteDb } from "./sqliteDb.js";
import type { ThreadHistoryCleanupCursor, ThreadHistoryCleanupTarget } from "./repos/threadRepo.js";
import { logger } from "../logger.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_DELAY_MS = 25;
const DEFAULT_PRESSURE_RETRY_DELAY_MS = 250;

export type ClientDbCleanupPressureSnapshot = {
  shouldDefer: boolean;
  reasons: string[];
  inboundMessages: number;
  inboundBytes: number;
  activeHandlers: number;
  eventLoopLagMaxMs: number;
  eventLoopLagP99Ms: number;
};

export type ClientDbCleanupThreadTarget = Pick<
  ThreadHistoryCleanupTarget,
  "threadId" | "workspaceId" | "sharedWorkspaceId"
>;

export type ClientDbCleanupServiceInput = {
  db: ClientDb;
  dbPath: string;
  flushEventPersistence: () => void | Promise<void>;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  beginThreadCleanup: (
    target: ClientDbCleanupThreadTarget,
    inactiveBefore: number,
  ) => Promise<(() => void) | null>;
  onThreadHistoryCleaned: (input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    sharedWorkspaceId: SharedWorkspaceId | null;
    throughSeq: number;
  }) => void;
  /** 返回统一运行时压力；高压时当前任务保持 running 并延后下一批。 */
  getRuntimePressure?: () => ClientDbCleanupPressureSnapshot;
  /** 仅供测试缩短批次；生产调用不得覆盖。 */
  batchSize?: number;
  /** 仅供测试缩短调度间隔；生产调用不得覆盖。 */
  batchDelayMs?: number;
  /** 仅供测试缩短压力重试间隔；生产调用不得覆盖。 */
  pressureRetryDelayMs?: number;
};

type CleanupRunState = {
  workspaceIds: Array<WorkspaceId | null>;
  workspaceIndex: number;
  sourceStarted: boolean;
  targets: ThreadHistoryCleanupTarget[];
  targetIndex: number;
  nextThreadCursor: ThreadHistoryCleanupCursor | null;
  threadSelectionDone: boolean;
  processedThreadIds: Set<string>;
  currentRelease: (() => void) | null;
  promptHighWaterRowId: number;
  promptCursorRowId: number;
  blobHighWaterRowId: number;
  blobCursorRowId: number;
};

/** 清理任务冲突，调用边界应保留 409 语义。 */
export class ClientDbCleanupError extends Error {
  readonly status = 409;
  readonly code = "DB_CLEANUP_BUSY";

  constructor(message: string) {
    super(message);
    this.name = "ClientDbCleanupError";
  }
}

/** 以有界批次清理 Client 大表，不暂停其它数据库请求。 */
export class ClientDbCleanupService {
  private snapshot = emptyCleanupSnapshot();
  private readonly batchSize: number;
  private readonly batchDelayMs: number;
  private readonly pressureRetryDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private run: CleanupRunState | null = null;
  private disposed = false;
  private requestId: string | null = null;
  private deferredForPressure = false;

  constructor(private readonly input: ClientDbCleanupServiceInput) {
    this.batchSize = normalizeBatchSize(input.batchSize);
    this.batchDelayMs = normalizeBatchDelay(input.batchDelayMs);
    this.pressureRetryDelayMs = normalizePressureRetryDelay(input.pressureRetryDelayMs);
  }

  /** 返回实时页统计和清理任务快照。 */
  getStorageSummary(): ClientDbStorageSummary {
    const metrics = this.readStorageMetrics();
    return { ...metrics, cleanup: { ...this.snapshot } };
  }

  /** Worker 模式通过统一许可读取页统计；旧同步入口仍供已持许可的调用方使用。 */
  getStorageSummaryAsync(): Promise<ClientDbStorageSummary> {
    return this.withDatabase(() => this.getStorageSummary());
  }

  /** 排空事件提交后才取得短许可建立清理快照，许可不跨排空等待。 */
  async startAsync(input: { inactiveBefore: number; requestId?: string | null }): Promise<ClientDbStorageSummary> {
    if (!this.validateStart(input.inactiveBefore)) return this.getStorageSummaryAsync();
    await this.input.flushEventPersistence();
    return this.withDatabase(() => this.startPrepared(input));
  }

  /** 启动清理；相同截止时间的重复请求返回当前任务，不重复执行。 */
  start(input: { inactiveBefore: number; requestId?: string | null }): ClientDbStorageSummary {
    if (!this.validateStart(input.inactiveBefore)) return this.getStorageSummary();
    const flush = this.input.flushEventPersistence();
    if (flush && typeof flush.then === "function") throw new Error("CLIENT_DB_CLEANUP_ASYNC_START_REQUIRED");
    return this.startPrepared(input);
  }

  /** 同步建立本轮状态；后台阶段各自重新申请许可，避免锁住整个清理任务。 */
  private startPrepared(input: { inactiveBefore: number; requestId?: string | null }): ClientDbStorageSummary {
    const inactiveBefore = normalizeInactiveBefore(input.inactiveBefore);
    if (!this.validateStart(inactiveBefore)) return this.getStorageSummary();

    const metrics = this.readStorageMetrics();
    const jobId = `dbclean_${crypto.randomUUID()}`;
    this.requestId = String(input.requestId ?? "").trim() || null;
    this.run = {
      workspaceIds: this.cleanupWorkspaceIds(),
      workspaceIndex: 0,
      sourceStarted: false,
      targets: [],
      targetIndex: 0,
      nextThreadCursor: null,
      threadSelectionDone: false,
      processedThreadIds: new Set(),
      currentRelease: null,
      promptHighWaterRowId: 0,
      promptCursorRowId: 0,
      blobHighWaterRowId: 0,
      blobCursorRowId: 0,
    };
    this.snapshot = {
      ...emptyCleanupSnapshot(),
      jobId,
      status: "queued",
      phase: "selecting_threads",
      inactiveBefore,
      startedAt: Date.now(),
      reusableBytesBefore: metrics.reusableBytes,
    };
    logger.info("client-db", "database cleanup queued", {
      event: "client_db.cleanup_queued",
      requestId: this.requestId,
      jobId,
      inactiveBefore,
      batchSize: this.batchSize,
      batchDelayMs: this.batchDelayMs,
      pressureRetryDelayMs: this.pressureRetryDelayMs,
    });
    this.schedule(0);
    return { ...metrics, cleanup: { ...this.snapshot } };
  }

  /** 参数与幂等冲突先于任何事件排空或数据库副作用。 */
  private validateStart(value: number): boolean {
    const inactiveBefore = normalizeInactiveBefore(value);
    if (this.disposed) throw new Error("Client DB cleanup service is disposed");
    if (!this.isRunning()) return true;
    if (this.snapshot.inactiveBefore !== inactiveBefore) throw new ClientDbCleanupError("已有不同截止时间的 Client 数据清理任务正在运行");
    return false;
  }

  /** 返回任务是否仍会继续执行批次。 */
  isRunning(): boolean {
    return this.snapshot.status === "queued" || this.snapshot.status === "running";
  }

  /** 停止待执行批次并释放当前会话租约。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    let releaseError: unknown = null;
    try {
      this.releaseCurrentThread();
    } catch (error) {
      releaseError = error;
    }
    if (this.isRunning()) {
      this.snapshot = {
        ...this.snapshot,
        status: releaseError ? "failed" : "cancelled",
        phase: null,
        currentThreadId: null,
        finishedAt: Date.now(),
        error: releaseError ? errorMessage(releaseError) : null,
      };
      logger.info("client-db", "database cleanup cancelled", {
        event: "client_db.cleanup_cancelled",
        requestId: this.requestId,
        jobId: this.snapshot.jobId,
        inactiveBefore: this.snapshot.inactiveBefore,
        processedThreadCount: this.snapshot.processedThreadCount,
        skippedThreadCount: this.snapshot.skippedThreadCount,
      });
    }
    this.run = null;
    this.deferredForPressure = false;
    if (releaseError) throw releaseError;
  }

  /** 调度下一小批，确保同步 SQLite 操作之间让出事件循环。 */
  private schedule(delayMs = this.batchDelayMs): void {
    if (this.disposed || !this.run || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNextBatch();
    }, delayMs);
    this.timer.unref?.();
  }

  /** 执行当前阶段的一小批；任一异常都结束任务。 */
  private async runNextBatch(): Promise<void> {
    if (this.disposed || !this.run || !this.isRunning()) return;
    if (this.snapshot.status === "queued") this.snapshot = { ...this.snapshot, status: "running" };
    try {
      const pressure = this.input.getRuntimePressure?.() ?? null;
      if (pressure?.shouldDefer) {
        if (!this.deferredForPressure) {
          this.deferredForPressure = true;
          logger.info("client-db", "database cleanup deferred for runtime pressure", {
            event: "cleanup_deferred_for_runtime_pressure",
            cleanupType: "client_db",
            requestId: this.requestId,
            jobId: this.snapshot.jobId,
            phase: this.snapshot.phase,
            currentThreadId: this.snapshot.currentThreadId,
            pressure,
          });
        }
        this.schedule(this.pressureRetryDelayMs);
        return;
      }
      if (this.deferredForPressure) {
        this.deferredForPressure = false;
        logger.info("client-db", "database cleanup resumed after runtime pressure", {
          event: "cleanup_resumed_after_runtime_pressure",
          cleanupType: "client_db",
          requestId: this.requestId,
          jobId: this.snapshot.jobId,
          phase: this.snapshot.phase,
          currentThreadId: this.snapshot.currentThreadId,
          pressure,
        });
      }
      switch (this.snapshot.phase) {
        case "selecting_threads":
          await this.withDatabase(() => this.selectTargets());
          break;
        case "conversation_events":
          await this.cleanupConversationEvents();
          break;
        case "raw_engine_events":
          await this.cleanupRawEvents();
          break;
        case "prompt_snapshots":
          await this.withDatabase(() => this.cleanupPromptSnapshots());
          break;
        case "file_blobs":
          await this.withDatabase(() => this.cleanupFileBlobs());
          break;
        default:
          throw new Error(`Invalid Client DB cleanup phase: ${String(this.snapshot.phase)}`);
      }
    } catch (error) {
      if (this.disposed || !this.run) {
        logger.error("client-db", "database cleanup batch failed after cancellation", {
          event: "client_db.cleanup_cancelled_batch_failed",
          requestId: this.requestId,
          jobId: this.snapshot.jobId,
          error: describeError(error),
        });
        return;
      }
      this.fail(error);
    }
  }

  /** 数据库短段复用已注入协调器，旧模式保持原同步 SQL 行为。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.input.withLegacyDatabase
      ? await this.input.withLegacyDatabase(this.requestId ?? "client-db:cleanup", operation)
      : operation();
  }

  /** 按最多 50 条的游标页快照旧会话；首个页面同时冻结非事件表高水位。 */
  private selectTargets(): void {
    if (!this.run || this.snapshot.inactiveBefore == null) throw new Error("Client DB cleanup run is unavailable");
    if (!this.run.sourceStarted) {
      this.run.promptHighWaterRowId = this.currentDb().orchPromptSnapshots.getCleanupHighWaterRowId();
      this.run.blobHighWaterRowId = this.currentDb().blobs.getCleanupHighWaterRowId();
      this.run.sourceStarted = true;
    }
    const page = this.currentDb().threads.listHistoryCleanupTargetPage({
      inactiveBefore: this.snapshot.inactiveBefore,
      cursor: this.run.nextThreadCursor,
      limit: 50,
    });
    this.run.targets = page.items;
    this.run.targetIndex = 0;
    this.run.nextThreadCursor = page.nextCursor;
    this.run.threadSelectionDone = !page.hasMore;
    this.snapshot = {
      ...this.snapshot,
      phase: page.items.length
        ? "conversation_events"
        : page.hasMore
          ? "selecting_threads"
          : "prompt_snapshots",
      selectedThreadCount: this.snapshot.selectedThreadCount + page.items.length,
    };
    this.schedule();
  }

  /** 删除当前会话高水位内的一批 canonical 事件。 */
  private async cleanupConversationEvents(): Promise<void> {
    const target = this.currentTargetOrAdvance();
    if (!target) return;
    if (!await this.ensureCurrentThreadLease(target)) return;
    if (target.conversationHighWaterSeq <= 0) {
      this.snapshot = { ...this.snapshot, phase: "raw_engine_events" };
      this.schedule();
      return;
    }
    const deleted = await this.withDatabase(() => this.currentDb().conversationEvents.deleteByThreadThroughSeq(
      target.threadId,
      target.conversationHighWaterSeq,
      this.batchSize,
    ));
    this.snapshot = {
      ...this.snapshot,
      batchCount: this.snapshot.batchCount + 1,
      deletedConversationEventCount: this.snapshot.deletedConversationEventCount + deleted,
      ...(deleted < this.batchSize ? { phase: "raw_engine_events" as const } : {}),
    };
    this.schedule();
  }

  /** 删除当前会话高水位内的一批 raw 事件。 */
  private async cleanupRawEvents(): Promise<void> {
    const target = this.currentTargetOrAdvance();
    if (!target) return;
    if (!await this.ensureCurrentThreadLease(target)) return;
    if (target.rawHighWaterSeq > 0) {
      const deleted = await this.withDatabase(() => this.currentDb().rawEvents.deleteByThreadThroughSeq(
        target.threadId,
        target.rawHighWaterSeq,
        this.batchSize,
      ));
      this.snapshot = {
        ...this.snapshot,
        batchCount: this.snapshot.batchCount + 1,
        deletedRawEngineEventCount: this.snapshot.deletedRawEngineEventCount + deleted,
      };
      if (deleted >= this.batchSize) {
        this.schedule();
        return;
      }
    }
    await this.withDatabase(() => this.finishCurrentThread(target));
    this.schedule();
  }

  /** 获取当前目标；会话阶段结束后切换到 Prompt 清理。 */
  private currentTargetOrAdvance(): ThreadHistoryCleanupTarget | null {
    if (!this.run) throw new Error("Client DB cleanup run is unavailable");
    const target = this.run.targets[this.run.targetIndex] ?? null;
    if (target) {
      if (this.snapshot.currentThreadId !== target.threadId) {
        this.snapshot = { ...this.snapshot, currentThreadId: target.threadId };
      }
      return target;
    }
    this.releaseCurrentThread();
    const nextPhase: ClientDbCleanupPhase = this.run.threadSelectionDone ? "prompt_snapshots" : "selecting_threads";
    this.run.targets = [];
    this.run.targetIndex = 0;
    this.snapshot = { ...this.snapshot, phase: nextPhase, currentThreadId: null };
    this.schedule();
    return null;
  }

  /** 首批前取得会话级排他租约；冲突目标明确计为跳过。 */
  private async ensureCurrentThreadLease(target: ThreadHistoryCleanupTarget): Promise<boolean> {
    if (!this.run) throw new Error("Client DB cleanup run is unavailable");
    if (this.run.currentRelease) return true;
    const activeRun = this.run;
    const inactiveBefore = this.snapshot.inactiveBefore;
    if (inactiveBefore == null) throw new Error("Client DB cleanup cutoff is unavailable");
    const release = await this.input.beginThreadCleanup(target, inactiveBefore);
    if (this.disposed || this.run !== activeRun) {
      release?.();
      return false;
    }
    if (release) {
      this.run.currentRelease = once(release);
      return true;
    }
    this.snapshot = {
      ...this.snapshot,
      skippedThreadCount: this.snapshot.skippedThreadCount + 1,
      currentThreadId: null,
      phase: "conversation_events",
    };
    this.run.targetIndex += 1;
    this.schedule();
    return false;
  }

  /** 完成一个会话的两张事件表并发送历史失效通知。 */
  private finishCurrentThread(target: ThreadHistoryCleanupTarget): void {
    if (!this.run) throw new Error("Client DB cleanup run is unavailable");
    let completionError: Error | null = null;
    try {
      this.input.onThreadHistoryCleaned({
        workspaceId: target.workspaceId,
        threadId: target.threadId,
        sharedWorkspaceId: target.sharedWorkspaceId,
        throughSeq: target.conversationHighWaterSeq,
      });
    } catch (error) {
      completionError = toError(error);
    }
    try {
      this.releaseCurrentThread();
    } catch (error) {
      const releaseError = toError(error);
      completionError = completionError
        ? new AggregateError(
          [completionError, releaseError],
          "Client DB thread history callback failed and cleanup lease release also failed",
        )
        : releaseError;
    }
    if (completionError) throw completionError;
    this.run.processedThreadIds.add(String(target.threadId));
    this.run.targetIndex += 1;
    this.snapshot = {
      ...this.snapshot,
      processedThreadCount: this.snapshot.processedThreadCount + 1,
      currentThreadId: null,
      phase: "conversation_events",
    };
  }

  /** 扫描一批 Prompt rowid，只删除终态编排快照。 */
  private cleanupPromptSnapshots(): void {
    if (!this.run) throw new Error("Client DB cleanup run is unavailable");
    if (this.run.processedThreadIds.size === 0) {
      this.snapshot = { ...this.snapshot, phase: "file_blobs" };
      this.schedule();
      return;
    }
    const result = this.currentDb().orchPromptSnapshots.cleanupTerminalBatch(
      this.run.promptCursorRowId,
      this.run.promptHighWaterRowId,
      this.batchSize,
      this.run.processedThreadIds,
    );
    this.run.promptCursorRowId = result.lastScannedRowId;
    this.snapshot = {
      ...this.snapshot,
      batchCount: this.snapshot.batchCount + 1,
      deletedPromptSnapshotCount: this.snapshot.deletedPromptSnapshotCount + result.deletedRows,
    };
    if (result.scannedRows < this.batchSize) {
      this.snapshot = { ...this.snapshot, phase: "file_blobs" };
    }
    this.schedule();
  }

  /** 扫描一批 Blob rowid，只删除五个引用源均为空的记录。 */
  private cleanupFileBlobs(): void {
    if (!this.run) throw new Error("Client DB cleanup run is unavailable");
    const result = this.currentDb().blobs.cleanupUnreferencedBatch(
      this.run.blobCursorRowId,
      this.run.blobHighWaterRowId,
      this.batchSize,
    );
    this.run.blobCursorRowId = result.lastScannedRowId;
    this.snapshot = {
      ...this.snapshot,
      batchCount: this.snapshot.batchCount + 1,
      deletedFileBlobCount: this.snapshot.deletedFileBlobCount + result.deletedRows,
      deletedFileBlobBytes: this.snapshot.deletedFileBlobBytes + result.deletedBytes,
    };
    if (result.scannedRows >= this.batchSize) {
      this.schedule();
      return;
    }
    this.advanceWorkspaceOrComplete();
  }

  /** 原全局任务固定注册集合逐 W 推进；本库失败时不会进入后续工作区。 */
  private advanceWorkspaceOrComplete(): void {
    if (!this.run) throw new Error("Client DB cleanup run is unavailable");
    if (this.run.workspaceIndex + 1 >= this.run.workspaceIds.length) { this.complete(); return; }
    this.releaseCurrentThread();
    this.run.workspaceIndex++;
    this.run.sourceStarted = false;
    this.run.targets = [];
    this.run.targetIndex = 0;
    this.run.nextThreadCursor = null;
    this.run.threadSelectionDone = false;
    this.run.processedThreadIds.clear();
    this.run.promptHighWaterRowId = 0;
    this.run.promptCursorRowId = 0;
    this.run.blobHighWaterRowId = 0;
    this.run.blobCursorRowId = 0;
    this.snapshot = { ...this.snapshot, phase: "selecting_threads", currentThreadId: null };
    this.schedule();
  }

  /** 当前同步组使用固定 W 视图；不按 thread 主键反查其他库。 */
  private currentDb(): ClientDb {
    if (!this.run) throw new Error("Client DB cleanup run is unavailable");
    const workspaceId = this.run.workspaceIds[this.run.workspaceIndex];
    if (workspaceId === undefined) throw new Error("Client DB cleanup workspace is unavailable");
    return workspaceId === null ? this.input.db : this.input.db.forWorkspace(workspaceId);
  }

  /** 应用兼容历史仍清理；从未创建工作区库时无 W 数据，不因清理创建文件。 */
  private cleanupWorkspaceIds(): Array<WorkspaceId | null> {
    if (this.input.db.workspaceId) return [this.input.db.workspaceId];
    const ids: Array<WorkspaceId | null> = [null];
    for (const workspace of this.input.db.workspaces.list()) {
      const lease = this.input.db.acquireWorkspaceReaderSource(workspace.id);
      if (!lease) continue;
      let failure: unknown;
      let failed = false;
      try { lease.verify(); ids.push(workspace.id); }
      catch (error) { failure = error; failed = true; }
      try { lease.release(); }
      catch (error) { failure = failed ? new AggregateError([failure, error], "CLIENT_DB_CLEANUP_SOURCE_RELEASE_FAILED") : error; failed = true; }
      if (failed) throw failure;
    }
    return ids;
  }

  /** 记录成功终态和最终可复用页。 */
  private complete(): void {
    const reusableBytesAfter = this.readStorageMetrics().reusableBytes;
    const finishedAt = Date.now();
    this.snapshot = {
      ...this.snapshot,
      status: "completed",
      phase: null,
      currentThreadId: null,
      finishedAt,
      reusableBytesAfter,
      error: null,
    };
    this.run = null;
    this.deferredForPressure = false;
    logger.info("client-db", "database cleanup completed", {
      event: "client_db.cleanup_completed",
      requestId: this.requestId,
      jobId: this.snapshot.jobId,
      inactiveBefore: this.snapshot.inactiveBefore,
      durationMs: finishedAt - Number(this.snapshot.startedAt ?? finishedAt),
      selectedThreadCount: this.snapshot.selectedThreadCount,
      processedThreadCount: this.snapshot.processedThreadCount,
      skippedThreadCount: this.snapshot.skippedThreadCount,
      batchCount: this.snapshot.batchCount,
      deletedConversationEventCount: this.snapshot.deletedConversationEventCount,
      deletedRawEngineEventCount: this.snapshot.deletedRawEngineEventCount,
      deletedPromptSnapshotCount: this.snapshot.deletedPromptSnapshotCount,
      deletedFileBlobCount: this.snapshot.deletedFileBlobCount,
      deletedFileBlobBytes: this.snapshot.deletedFileBlobBytes,
    });
  }

  /** 失败即停止，不自动重试或伪造回滚。 */
  private fail(cause: unknown): void {
    this.clearTimer();
    const failedThreadId = this.snapshot.currentThreadId;
    const failedRun = this.run;
    let error = toError(cause);
    try {
      this.releaseCurrentThread();
    } catch (releaseError) {
      error = new AggregateError([error, toError(releaseError)], "Client DB cleanup failed and thread lease release also failed");
    }
    const finishedAt = Date.now();
    this.snapshot = {
      ...this.snapshot,
      status: "failed",
      currentThreadId: failedThreadId,
      finishedAt,
      error: error.message,
    };
    this.run = null;
    this.deferredForPressure = false;
    logger.error("client-db", "database cleanup failed", {
      code: "CLIENT_DB_CLEANUP_FAILED",
      event: "client_db.cleanup_failed",
      requestId: this.requestId,
      jobId: this.snapshot.jobId,
      inactiveBefore: this.snapshot.inactiveBefore,
      phase: this.snapshot.phase,
      currentThreadId: failedThreadId,
      workspaceId: failedRun?.workspaceIds[failedRun.workspaceIndex] ?? null,
      selectedThreadCount: this.snapshot.selectedThreadCount,
      processedThreadCount: this.snapshot.processedThreadCount,
      skippedThreadCount: this.snapshot.skippedThreadCount,
      batchCount: this.snapshot.batchCount,
      promptCursorRowId: failedRun?.promptCursorRowId ?? null,
      promptHighWaterRowId: failedRun?.promptHighWaterRowId ?? null,
      blobCursorRowId: failedRun?.blobCursorRowId ?? null,
      blobHighWaterRowId: failedRun?.blobHighWaterRowId ?? null,
      deletedConversationEventCount: this.snapshot.deletedConversationEventCount,
      deletedRawEngineEventCount: this.snapshot.deletedRawEngineEventCount,
      deletedPromptSnapshotCount: this.snapshot.deletedPromptSnapshotCount,
      deletedFileBlobCount: this.snapshot.deletedFileBlobCount,
      deletedFileBlobBytes: this.snapshot.deletedFileBlobBytes,
      error: describeError(error),
    });
  }

  /** 释放当前会话租约，重复调用无副作用。 */
  private releaseCurrentThread(): void {
    const release = this.run?.currentRelease ?? null;
    if (this.run) this.run.currentRelease = null;
    release?.();
  }

  /** 清除待执行 timer。 */
  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** 汇总应用及现存 W 的页与文件大小，短只读句柄在来源租约内关闭。 */
  private readStorageMetrics(): Omit<ClientDbStorageSummary, "cleanup"> {
    const total = this.input.db.workspaceId ? { databaseBytes: 0, reusableBytes: 0, liveBytes: 0 }
      : this.input.db.applicationDb.transaction(() => storageMetrics(this.input.db.applicationDb, this.input.dbPath))();
    const workspaceIds = this.input.db.workspaceId ? [this.input.db.workspaceId] : this.input.db.workspaces.list().map(item => item.id);
    for (const workspaceId of workspaceIds) {
      const lease = this.input.db.acquireWorkspaceReaderSource(workspaceId);
      if (!lease) continue;
      let db: SqliteDb | null = null;
      let initializationCleanup: (() => void) | undefined;
      let failure: unknown;
      let failed = false;
      try {
        lease.verify();
        db = openSqliteDb(lease.source.dbPath, { readonly: true, fileMustExist: true,
          busyTimeoutMs: this.input.withLegacyDatabase ? 0 : undefined,
          onInitializationCleanupFailure: close => { initializationCleanup = close; } });
        const metrics = db.transaction(() => storageMetrics(db!, lease.source.dbPath))();
        total.databaseBytes += metrics.databaseBytes;
        total.reusableBytes += metrics.reusableBytes;
        total.liveBytes += metrics.liveBytes;
        lease.verify();
      } catch (error) { failure = error; failed = true; }
      const close = db ? () => db!.close() : initializationCleanup;
      try { close?.(); }
      catch (error) {
        failure = failed ? new AggregateError([failure, error], "CLIENT_DB_STORAGE_CLOSE_FAILED") : error;
        failed = true;
        if (!close) throw new AggregateError([failure, new Error("CLIENT_DB_STORAGE_CLOSE_OWNER_MISSING")], "CLIENT_DB_STORAGE_CLOSE_FAILED");
        lease.retainFailedResource(close, failure);
        throw failure;
      }
      try { lease.verify(); }
      catch (error) { failure = failed ? new AggregateError([failure, error], "CLIENT_DB_STORAGE_VERIFY_FAILED") : error; failed = true; }
      try { lease.release(); }
      catch (error) { failure = failed ? new AggregateError([failure, error], "CLIENT_DB_STORAGE_RELEASE_FAILED") : error; failed = true; }
      if (failed) throw failure;
    }
    return total;
  }
}

/** 同一物理库的可复用页只计主库页，sidecar 和 rollback journal 计真实占用。 */
function storageMetrics(db: SqliteDb, dbPath: string): Omit<ClientDbStorageSummary, "cleanup"> {
  const pageSize = requireNonNegativeInteger(db.pragma("page_size", { simple: true }), "page_size");
  const pageCount = requireNonNegativeInteger(db.pragma("page_count", { simple: true }), "page_count");
  const freelistCount = requireNonNegativeInteger(db.pragma("freelist_count", { simple: true }), "freelist_count");
  const mainDatabaseBytes = readFileSize(dbPath);
  const databaseBytes = mainDatabaseBytes + readFileSize(`${dbPath}-wal`) + readFileSize(`${dbPath}-shm`) + readFileSize(`${dbPath}-journal`);
  const reusableBytes = Math.min(mainDatabaseBytes, pageSize * Math.min(pageCount, freelistCount));
  return { databaseBytes, reusableBytes, liveBytes: Math.max(0, databaseBytes - reusableBytes) };
}

/** 构造未运行过清理的初始快照。 */
function emptyCleanupSnapshot(): ClientDbCleanupSnapshot {
  return {
    jobId: null,
    status: "idle",
    phase: null,
    inactiveBefore: null,
    startedAt: null,
    finishedAt: null,
    currentThreadId: null,
    selectedThreadCount: 0,
    processedThreadCount: 0,
    skippedThreadCount: 0,
    batchCount: 0,
    deletedConversationEventCount: 0,
    deletedRawEngineEventCount: 0,
    deletedPromptSnapshotCount: 0,
    deletedFileBlobCount: 0,
    deletedFileBlobBytes: 0,
    reusableBytesBefore: null,
    reusableBytesAfter: null,
    error: null,
  };
}

/** 规范业务截止时间。 */
function normalizeInactiveBefore(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0 || raw >= Date.now()) {
    throw new Error(`Invalid Client DB cleanup inactiveBefore: ${String(raw)}`);
  }
  return raw;
}

/** 规范单批行数；生产默认固定为 100。 */
function normalizeBatchSize(raw: unknown): number {
  if (raw == null) return DEFAULT_BATCH_SIZE;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value <= 0 || value > 1_000) {
    throw new Error(`Invalid Client DB cleanup batch size: ${String(raw)}`);
  }
  return value;
}

/** 规范批间延迟；生产默认固定为 25ms。 */
function normalizeBatchDelay(raw: unknown): number {
  if (raw == null) return DEFAULT_BATCH_DELAY_MS;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 0 || value > 60_000) {
    throw new Error(`Invalid Client DB cleanup batch delay: ${String(raw)}`);
  }
  return value;
}

/** 规范高压重试延迟；生产默认 250ms。 */
function normalizePressureRetryDelay(raw: unknown): number {
  if (raw == null) return DEFAULT_PRESSURE_RETRY_DELAY_MS;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 1 || value > 60_000) {
    throw new Error(`Invalid Client DB cleanup pressure retry delay: ${String(raw)}`);
  }
  return value;
}

/** 包装释放函数，保证最多调用一次。 */
function once(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/** 读取可选 SQLite 文件大小，不存在按零计算。 */
function readFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return 0;
    throw error;
  }
}

/** 要求 PRAGMA 返回非负安全整数。 */
function requireNonNegativeInteger(raw: unknown, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid SQLite ${name}: ${String(raw)}`);
  return value;
}

/** 规整未知异常并保留 cause。 */
function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

/** 返回用于状态快照的异常文案。 */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 保留有限异常链供日志检索。 */
function describeError(error: unknown, depth = 0): unknown {
  if (depth >= 3) return String(error);
  if (error instanceof AggregateError) {
    return { name: error.name, message: error.message, errors: error.errors.map((item) => describeError(item, depth + 1)) };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause == null ? {} : { cause: describeError(error.cause, depth + 1) }),
    };
  }
  return String(error);
}
