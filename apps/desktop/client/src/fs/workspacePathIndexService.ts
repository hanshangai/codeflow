import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";

import type { FsReindexResponseBody, FsSearchIndexStatus, FsSearchResponseBody, FsSearchResult, WorkspaceId } from "@codeflowai/shared";
import { resolveWorkspacePath } from "./fsHelpers.js";
import {
  resolveWorkspaceFileIndexMaxEntries,
  ensureCodeflowaiConfig,
} from "../codeflowai/codeflowaiConfig.js";
import {
  assertWorkspaceCodeflowaiDirectory,
  cleanupLegacyWorkspaceCodeflowaiDirectory,
  ensureWorkspaceCodeflowaiDirectory,
  inspectExistingWorkspaceCodeflowaiDirectory,
  inspectWorkspaceCodeflowaiFile,
  LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY,
  readWorkspaceCodeflowaiFile,
  type WorkspaceCodeflowaiDirectoryIdentity,
  WORKSPACE_RUNTIME_DIRECTORY,
  WorkspaceCodeflowaiDirectoryError,
  writeWorkspaceCodeflowaiFile,
} from "../codeflowai/workspaceCodeflowaiDirectory.js";
import {
  DEFAULT_WORKSPACE_PATH_INDEX_MAX_ENTRIES,
  normalizeWorkspacePathIndexMaxEntries,
  WORKSPACE_PATH_INDEX_POLICY_STAMP,
  isWorkspacePathIndexStorageRelPath,
  isWorkspacePathIndexPathExcluded,
  isWorkspacePathIndexPrivatePath,
  readWorkspacePathIndexPathScope,
  WorkspacePathIndexPathError,
  workspacePathIndexPathFailure,
  workspacePathIndexFsPath,
  workspacePathIndexDatabasePath,
  type WorkspacePathIndexPathScope,
} from "./workspacePathIndexConfig.js";
import {
  emptySearchPage,
  normalizeSearchCursor,
  normalizeSearchLimit,
  normalizeSearchQuery,
  parseDirectorySearchQuery,
  searchPaths,
} from "./fsService.js";
import { logger, type WorkspaceLogEntry } from "../logger.js";
import type { ClientDb } from "../db/clientDb.js";
import { findWorkspaceRootConflicts } from "./workspaceRootOwnership.js";
import {
  openWorkspacePathIndexDb,
  recoverWorkspacePathIndexDbFiles,
  WorkspacePathIndexDbError,
  assertWorkspacePathIndexStorage,
  workspacePathIndexStorageErrorCode,
  isWorkspacePathIndexStorageErrorCode,
  type WorkspacePathIndexDb,
  type WorkspacePathIndexDbMeta,
  type WorkspacePathIndexDbMutation,
  type WorkspacePathIndexEntry,
  type WorkspacePathIndexStoredEntry,
} from "./workspacePathIndexDb.js";

type WorkspaceIndexState = {
  workspaceId: WorkspaceId;
  migrationSuspended: boolean;
  workspacePath: string;
  status: FsSearchIndexStatus;
  generation: number;
  db: WorkspacePathIndexDb | null;
  hasActiveGeneration: boolean;
  activeCompatible: boolean;
  rootConflict: boolean;
  indexedCount: number;
  partial: boolean;
  message: string | null;
  worker: Worker | null;
  warmupTimer: ReturnType<typeof setTimeout> | null;
  watcher: fs.FSWatcher | null;
  watchTimer: ReturnType<typeof setTimeout> | null;
  pendingWatchPaths: Set<string>;
  maxEntries: number;
  configStamp: string;
  excludeRulesStamp: string;
  buildRequestGeneration: number | null;
  buildRequestId: string | null;
  work: (Promise<void> & { result?: PromiseSettledResult<void>; primaryFailure?: boolean }) | null;
  removed: boolean;
  failure: { reason: unknown } | null;
};

type IndexWorkerOwner = Worker & { indexGeneration?: number; termination?: Promise<void>; terminationResult?: PromiseSettledResult<void>; stopping?: boolean };

/** 固定码只识别本 owner 的诊断故障，禁止凭 message 猜测可恢复。 */
function isIndexDiagnosticFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "WORKSPACE_FILE_INDEX_LOG_FAILED" || code === "WORKSPACE_FILE_INDEX_LIFECYCLE_FAILED"
    || code === "WORKSPACE_MIGRATION_INDEX_PERSIST_FAILED" || code === "WORKSPACE_MIGRATION_INDEX_LOG_FAILED";
}

type WorkerMessage =
  | { type: "heartbeat"; workspaceId: WorkspaceId; generation: number; indexedCount: number }
  | { type: "done"; workspaceId: WorkspaceId; generation: number; indexedCount: number; skippedDirCount: number; partial: boolean }
  | { type: "failed"; workspaceId: WorkspaceId; generation: number; message: string; diagnosticCode?: string; logicalPath?: string; systemCode?: string; storageCode?: string };

type WorkspacePathIndexOptions = {
  writeWorkspaceLog: ClientDb["writeWorkspaceLog"];
  enabled?: boolean;
  warmupDelayMs?: number;
  maxEntries?: number;
  excludeDirNames?: string[];
  excludePathPrefixes?: string[];
  workerFactory?: WorkspacePathIndexWorkerFactory;
};

type WorkspacePathIndexWorkerData = {
  workspaceId: WorkspaceId;
  workspacePath: string;
  generation: number;
  includeHidden: boolean;
  maxEntries: number;
  configStamp: string;
  excludeRulesStamp: string;
  policyStamp: string;
  excludeDirNames: string[];
  excludePathPrefixes: string[];
};

type WorkspacePathIndexWorkerFactory = (workerPath: string, workerData: WorkspacePathIndexWorkerData) => Worker;

export type WorkspacePathIndexLifecycleEvent =
  | { type: "building"; workspaceId: WorkspaceId; generation: number; at: number }
  | { type: "heartbeat"; workspaceId: WorkspaceId; generation: number; indexedCount: number; at: number }
  | { type: "done"; workspaceId: WorkspaceId; generation: number; indexedCount: number; partial: boolean; at: number }
  | { type: "failed"; workspaceId: WorkspaceId; generation: number; error: string; at: number };

export type WorkspacePathIndexRebuildReservation =
  | { kind: "not_applicable" }
  | { kind: "reserved"; generation: number };

const DEFAULT_WARMUP_DELAY_MS = 3000;
const WORKSPACE_INDEX_IGNORE_DIR = ".codeflowai";
const WORKSPACE_INDEX_IGNORE_FILE = "file-index-ignore.txt";
const WORKSPACE_INDEX_IGNORE_REL_PATH = `${WORKSPACE_INDEX_IGNORE_DIR}/${WORKSPACE_INDEX_IGNORE_FILE}`;
const UNINITIALIZED_WORKSPACE_CONFIG_STAMP = "uninitialized";
const UNINITIALIZED_WORKSPACE_INDEX_IGNORE_STAMP = "uninitialized";
const DEFAULT_WORKSPACE_INDEX_IGNORE_CONTENT = [
  "# CodeFlow 文件索引排除规则（本地工作区个性化规则）",
  "# 仅支持两类简单规则：目录名、workspace 相对路径前缀。",
  "# 示例：取消注释后可排除任意 generated 目录。",
  "# generated",
  "# 示例：取消注释后可排除 workspace 下 data/raw 目录。",
  "# data/raw",
  "",
].join("\n");

export type WorkspacePathIndexSearchOptions = {
  limit?: number | null;
  cursor?: string | null;
  includeHidden?: boolean | null;
  kind?: "file" | "directory" | "all" | null;
};

export type WorkspacePathIndexOperationContext = {
  requestId?: string | null;
};

export type WorkspacePathIndexUpsertOptions = WorkspacePathIndexOperationContext & { prepareOnly?: boolean };

export type WorkspacePathIndexChange =
  | { type: "upsert"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; fromPath: string; toPath: string };

export interface WorkspacePathIndex {
  suspendWorkspace?(workspaceId: WorkspaceId): Promise<() => void>;
  search(workspaceId: WorkspaceId, workspacePath: string, query: string, opts?: WorkspacePathIndexSearchOptions, context?: WorkspacePathIndexOperationContext): FsSearchResponseBody;
  rebuildWorkspace(workspaceId: WorkspaceId, workspacePath: string, context?: WorkspacePathIndexOperationContext): FsReindexResponseBody;
  reserveWorkspaceRebuild(workspaceId: WorkspaceId, workspacePath: string, context?: WorkspacePathIndexOperationContext): WorkspacePathIndexRebuildReservation;
  startReservedWorkspaceRebuild(workspaceId: WorkspaceId, generation: number): void;
  cancelReservedWorkspaceRebuild(workspaceId: WorkspaceId, generation: number): void;
  terminateWorkspaceRebuild(workspaceId: WorkspaceId, generation: number, reason: string, context?: WorkspacePathIndexOperationContext): Promise<void>;
  subscribeLifecycle(listener: (event: WorkspacePathIndexLifecycleEvent) => void): () => void;
  applyChanges(workspaceId: WorkspaceId, workspacePath: string, changes: WorkspacePathIndexChange[], context?: WorkspacePathIndexOperationContext): FsReindexResponseBody;
  scheduleWarmup(workspaces: Map<WorkspaceId, string>): void;
  syncWorkspaces(workspaces: Map<WorkspaceId, string>): void;
  upsertWorkspace(workspaceId: WorkspaceId, workspacePath: string, context?: WorkspacePathIndexUpsertOptions): void;
  deleteWorkspace(workspaceId: WorkspaceId): void;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export class WorkspacePathIndexService implements WorkspacePathIndex {
  private readonly enabled: boolean;
  private readonly warmupDelayMs: number;
  private readonly defaultMaxEntries: number;
  private readonly excludeDirNames: string[];
  private readonly excludePathPrefixes: string[];
  private readonly workerFactory: WorkspacePathIndexWorkerFactory;
  private readonly writeWorkspaceLog: ClientDb["writeWorkspaceLog"];
  private readonly states = new Map<WorkspaceId, WorkspaceIndexState>();
  private readonly lifecycleListeners = new Set<(event: WorkspacePathIndexLifecycleEvent) => void>();
  private activeWorker: Worker | null = null;
  private disposed = false;

  constructor(options: WorkspacePathIndexOptions) {
    this.writeWorkspaceLog = options.writeWorkspaceLog;
    this.enabled = options.enabled !== false;
    this.warmupDelayMs = normalizeDelay(options.warmupDelayMs, DEFAULT_WARMUP_DELAY_MS);
    this.defaultMaxEntries = normalizeWorkspacePathIndexMaxEntries(options.maxEntries, DEFAULT_WORKSPACE_PATH_INDEX_MAX_ENTRIES);
    this.excludeDirNames = normalizeExcludeDirNames(options.excludeDirNames ?? []);
    this.excludePathPrefixes = normalizeExcludePathPrefixes(options.excludePathPrefixes ?? []);
    this.workerFactory = options.workerFactory ?? createWorkspacePathIndexWorker;
  }

  /** 后台预热当前所有工作区索引；只排队，不阻塞 Client 启动。 */
  scheduleWarmup(workspaces: Map<WorkspaceId, string>): void {
    this.syncWorkspaces(workspaces);
    for (const [workspaceId, workspacePath] of workspaces.entries()) {
      const state = this.states.get(workspaceId);
      if (!state) continue;
      if (state.migrationSuspended) continue;
      if (state.status === "building" || state.status === "ready" || state.status === "failed" || state.status === "disabled") continue;
      if (state.status !== "queued") this.reserveStateRebuild(state, "索引等待后台构建");
      this.queueBuild(state, this.warmupDelayMs);
    }
  }

  /** 同步运行态 workspace 集合，删除已不存在的索引并标记路径变化。 */
  syncWorkspaces(workspaces: Map<WorkspaceId, string>): void {
    const activeIds = new Set(workspaces.keys());
    for (const workspaceId of this.states.keys()) {
      if (!activeIds.has(workspaceId)) this.deleteWorkspace(workspaceId);
    }
    const conflictsByWorkspace = new Map<WorkspaceId, ReturnType<typeof findWorkspaceRootConflicts>[number]>();
    for (const conflict of findWorkspaceRootConflicts(workspaces)) {
      for (const workspaceId of conflict.workspaceIds) conflictsByWorkspace.set(workspaceId, conflict);
    }
    for (const [workspaceId, workspacePath] of workspaces.entries()) {
      const conflict = conflictsByWorkspace.get(workspaceId);
      if (conflict) {
        const state = this.states.get(workspaceId) ?? this.createState(workspaceId, workspacePath);
        this.states.set(workspaceId, state);
        this.stopWorker(state);
        this.stopWatcher(state);
        this.clearWarmupTimer(state);
        state.db?.close();
        state.db = null;
        state.workspacePath = workspacePath;
        state.rootConflict = true;
        state.buildRequestGeneration = null;
        state.buildRequestId = null;
        state.status = "failed";
        state.partial = true;
        state.message = "该物理工作区目录同时属于多个工作区，文件索引已停用";
        logger.error("workspace-index", "workspace path index root conflict", {
          code: "workspace_file_index_root_conflict",
          requestId: null,
          workspaceId,
          conflictingWorkspaceIds: conflict.workspaceIds,
          workspaceRootKey: conflict.workspaceRootKey,
          generation: state.generation || null,
          indexPath: path.normalize(workspacePathIndexDatabasePath(conflict.workspaceRoot)),
          rootCause: state.message,
        });
        continue;
      }
      const conflictedState = this.states.get(workspaceId);
      if (conflictedState?.rootConflict && isSamePath(conflictedState.workspacePath, workspacePath)) {
        conflictedState.rootConflict = false;
        this.startWatcher(conflictedState);
        try {
          this.reserveStateRebuild(conflictedState, "工作区物理根冲突已解除，索引等待重建");
          this.queueBuild(conflictedState, this.warmupDelayMs);
        } catch (error) {
          if (isIndexDiagnosticFailure(error)) throw error;
          // 存储失败已由预留边界置 failed、停止资源并记录，预热保持该失败态。
          if (workspacePathIndexStorageErrorCode(error)) continue;
          conflictedState.status = "failed";
          conflictedState.partial = true;
          conflictedState.message = error instanceof Error ? error.message : String(error);
          conflictedState.failure = { reason: error };
          this.writeLog(conflictedState, "error", "workspace path index root conflict recovery failed", {
            code: "workspace_file_index_root_conflict_recovery_failed",
            requestId: null,
            workspaceId,
            generation: conflictedState.generation || null,
            indexPath: conflictedState.db?.indexPath
              ?? path.normalize(workspacePathIndexDatabasePath(path.resolve(conflictedState.workspacePath))),
            rootCause: conflictedState.message,
          }, { reason: error });
        }
        continue;
      }
      try {
        this.upsertWorkspace(workspaceId, workspacePath);
      } catch (error) {
        if (isIndexDiagnosticFailure(error)) throw error;
        // 预留入口已收口的存储/控制目录失败不再重复记录，其他准备错误仍由此边界处理。
        if (workspacePathIndexStorageErrorCode(error) || error instanceof WorkspaceCodeflowaiDirectoryError) continue;
        const state = this.states.get(workspaceId) ?? this.createState(workspaceId, workspacePath);
        this.states.set(workspaceId, state);
        state.status = "failed";
        state.partial = true;
        state.message = error instanceof Error ? error.message : String(error);
        state.failure = { reason: error };
        this.writeLog(state, "error", "workspace path index warmup preparation failed", {
          code: "workspace_file_index_warmup_prepare_failed",
          requestId: null,
          workspaceId,
          generation: state.generation || null,
          indexPath: path.normalize(workspacePathIndexDatabasePath(path.resolve(workspacePath))),
          rootCause: state.message,
        }, { reason: error });
      }
    }
  }

  /** prepareOnly 只更新内存根；迁移持门禁时不得打开或提前排队目标索引。 */
  upsertWorkspace(workspaceId: WorkspaceId, workspacePath: string, context?: WorkspacePathIndexUpsertOptions): void {
    const state = this.states.get(workspaceId);
    if (!state) {
      const created = this.createState(workspaceId, workspacePath);
      this.states.set(workspaceId, created);
      if (this.enabled && !context?.prepareOnly) {
        this.startWatcher(created);
        this.reserveStateRebuild(created, "索引等待构建", context);
      }
      return;
    }
    if (isSamePath(state.workspacePath, workspacePath) && !context?.prepareOnly && !state.removed) {
      this.startWatcher(state);
      return;
    }
    this.stopWorker(state);
    this.stopWatcher(state);
    this.clearWarmupTimer(state);
    state.db?.close();
    state.db = null;
    state.workspacePath = workspacePath;
    state.rootConflict = false;
    state.removed = false;
    if (context?.prepareOnly) {
      state.status = this.enabled ? "stale" : "disabled";
      state.failure = null;
      return;
    }
    this.startWatcher(state);
    this.reserveStateRebuild(state, "工作区路径已变化，索引等待重建", context);
    this.queueBuild(state, this.warmupDelayMs);
  }

  /** 删除 workspace 时释放对应 worker、计时器和数据库连接。 */
  deleteWorkspace(workspaceId: WorkspaceId): void {
    const state = this.states.get(workspaceId);
    if (!state) return;
    this.stopWorker(state);
    this.stopWatcher(state);
    this.clearWarmupTimer(state);
    state.db?.close();
    state.db = null;
    state.removed = true;
    state.status = "disabled";
    if (!state.work && !state.worker) this.states.delete(workspaceId);
  }

  /** 手工触发指定 workspace 全量重建；排队后立即返回当前索引状态。 */
  rebuildWorkspace(workspaceId: WorkspaceId, workspacePath: string, context?: WorkspacePathIndexOperationContext): FsReindexResponseBody {
    const reservation = this.reserveWorkspaceRebuild(workspaceId, workspacePath, context);
    const state = this.ensureState(workspaceId, workspacePath, context);
    if (reservation.kind === "reserved") this.startReservedWorkspaceRebuild(workspaceId, reservation.generation);
    return this.toIndexStatus(state);
  }

  /** 作废旧索引并预留唯一 generation；调用方持久化成功前不启动 Worker。 */
  reserveWorkspaceRebuild(workspaceId: WorkspaceId, workspacePath: string, context?: WorkspacePathIndexOperationContext): WorkspacePathIndexRebuildReservation {
    let state = this.states.get(workspaceId);
    if (!state) {
      state = this.createState(workspaceId, workspacePath);
      this.states.set(workspaceId, state);
    } else if (!isSamePath(state.workspacePath, workspacePath)) {
      this.stopWorker(state);
      this.clearWarmupTimer(state);
      state.db?.close();
      state.db = null;
      state.workspacePath = workspacePath;
    }
    if (state.rootConflict) {
      const message = "该物理工作区目录同时属于多个工作区，冲突解除前不能重建文件索引";
      logger.error("workspace-index", "workspace path index rebuild rejected by root conflict", {
        code: "workspace_file_index_root_conflict_rebuild_rejected",
        requestId: normalizeOperationRequestId(context),
        workspaceId,
        generation: state.generation || null,
        indexPath: path.normalize(workspacePathIndexDatabasePath(path.resolve(state.workspacePath))),
        rootCause: message,
      });
      throw new Error(message);
    }
    if (!this.enabled || state.status === "disabled") return { kind: "not_applicable" };
    this.stopWorker(state);
    this.clearWarmupTimer(state);
    return {
      kind: "reserved",
      generation: this.reserveStateRebuild(state, "索引 generation 已预留，等待启动", context),
    };
  }

  /** 启动已经持久化的 generation；过期预留不会影响当前构建。 */
  startReservedWorkspaceRebuild(workspaceId: WorkspaceId, generation: number): void {
    const state = this.states.get(workspaceId);
    if (!state || state.generation !== generation) {
      this.logStaleGeneration(workspaceId, generation, state?.generation ?? null, "start_reserved");
      return;
    }
    if (state.rootConflict) {
      const message = "工作区物理根冲突，已拒绝启动预留的文件索引 generation";
      logger.error("workspace-index", "workspace path index reserved build rejected by root conflict", {
        code: "workspace_file_index_root_conflict_start_rejected",
        requestId: this.requestIdForGeneration(state, generation),
        workspaceId,
        generation,
        indexPath: path.normalize(workspacePathIndexDatabasePath(path.resolve(state.workspacePath))),
        rootCause: message,
      });
      throw new Error(message);
    }
    if (state.status === "disabled") return;
    this.queueBuild(state, 0);
  }

  /** 取消尚未形成持久事实的预留，并递增 generation 阻断迟到事件。 */
  cancelReservedWorkspaceRebuild(workspaceId: WorkspaceId, generation: number): void {
    const state = this.states.get(workspaceId);
    if (!state || state.generation !== generation) {
      this.logStaleGeneration(workspaceId, generation, state?.generation ?? null, "cancel_reserved");
      return;
    }
    this.stopWorker(state);
    this.clearWarmupTimer(state);
    try {
      state.db?.cancelBuild(generation, "stale", "索引预留已取消，等待重新构建");
      this.syncStateFromDb(state);
    } catch (error) {
      throw this.failState(state, error, this.requestIdForGeneration(state, generation), generation, "workspace_file_index_cancel_failed", true);
    }
  }

  /** 终止匹配 generation 的构建；终止失败向调用方抛出并保留全局并发名额。 */
  async terminateWorkspaceRebuild(workspaceId: WorkspaceId, generation: number, reason: string, context?: WorkspacePathIndexOperationContext): Promise<void> {
    const state = this.states.get(workspaceId);
    if (!state || (state.generation !== generation && (state.worker as IndexWorkerOwner | null)?.indexGeneration !== generation)) {
      this.logStaleGeneration(workspaceId, generation, state?.generation ?? null, "terminate");
      return;
    }
    const requestId = this.resolveOperationRequestId(state, generation, context);
    this.clearWarmupTimer(state);
    state.status = "failed";
    state.partial = true;
    state.message = reason;
    let failure: { reason: unknown } | null = null;
    try {
      state.db?.cancelBuild(generation, "failed", reason);
      this.syncStateFromDb(state);
    } catch (error) {
      try { failure = { reason: this.failState(state, error, requestId, generation, "workspace_file_index_terminate_storage_failed", true) }; }
      catch (diagnosticError) { failure = { reason: diagnosticError }; }
    }
    const termination = this.stopWorker(state);
    try {
      if (termination) await termination;
    } catch (error) {
      failure = { reason: failure ? this.combineFailure(failure.reason, error) : error };
    }
    if (!termination) this.scheduleNextQueuedBuild();
    if (failure) throw failure.reason;
  }

  /** 独占迁移前关闭本state的监听、定时器和真实Worker，释放后复用原generation。 */
  async suspendWorkspace(workspaceId: WorkspaceId): Promise<() => void> {
    const state = this.states.get(workspaceId);
    if (!state) return () => {};
    if (state.migrationSuspended) throw new Error("WORKSPACE_FILE_INDEX_MIGRATION_ALREADY_SUSPENDED");
    state.migrationSuspended = true;
    this.clearWarmupTimer(state);
    const failures: unknown[] = [];
    try { this.stopWatcher(state); } catch (error) { failures.push(error); }
    try { const termination = this.stopWorker(state); if (termination) await termination; }
    catch (error) { failures.push(error); }
    try { if (state.work) await state.work; }
    catch (error) { if (!failures.some(previous => Object.is(previous, error))) failures.push(error); }
    if (!state.worker) {
      try { state.db?.close(); state.db = null; } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const failure = failures.length === 1 ? failures[0] : new AggregateError(failures, "WORKSPACE_FILE_INDEX_MIGRATION_DRAIN_FAILED", { cause: failures[0] });
      state.failure = { reason: failure };
      throw failure;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.migrationSuspended = false;
      if (this.disposed || state.removed) return;
      this.startWatcher(state);
      if (state.generation > 0 && state.status !== "ready" && state.status !== "disabled" && !state.failure) this.queueBuild(state, 0);
    };
  }

  /** 订阅 generation 生命周期；返回的函数只移除当前订阅。 */
  subscribeLifecycle(listener: (event: WorkspacePathIndexLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  /** 把已知文件写操作同步到持久索引；目录变更只更新目录本身，不递归扫描。 */
  applyChanges(workspaceId: WorkspaceId, workspacePath: string, changes: WorkspacePathIndexChange[], context?: WorkspacePathIndexOperationContext): FsReindexResponseBody {
    const state = this.ensureState(workspaceId, workspacePath, context);
    if (state.failure) throw state.failure.reason;
    if (!changes.length) return this.toIndexStatus(state);
    const requestId = normalizeOperationRequestId(context);
    try {
      this.refreshWorkspaceSettingsIfChanged(state, context);
      if (state.status === "disabled") return this.toIndexStatus(state);
      if (state.status === "failed") throw new Error(state.message ?? "workspace 文件索引不可用");
      if (!state.db) throw new Error(`workspace 文件索引数据库未打开：${workspaceId}`);
      const mutationBatch = this.buildPersistentMutations(state, changes);
      if (mutationBatch.mutations.length > 0) {
        this.applyMetaToState(state, state.db.applyMutations(mutationBatch.mutations, {
          staleIfDirectoryPaths: mutationBatch.staleIfDirectoryPaths,
        }));
      }
      return this.toIndexStatus(state);
    } catch (error) {
      if (workspacePathIndexStorageErrorCode(error)) throw this.failState(state, error, requestId, state.generation || null, "workspace_file_index_incremental_update_failed", true);
      const rootCause = error instanceof Error ? error.message : String(error);
      const indexPath = state.db?.indexPath ?? path.normalize(workspacePathIndexDatabasePath(path.resolve(state.workspacePath)));
      try {
        state.db?.updateStatus("failed", true, rootCause);
      } catch (statusError) {
        throw this.failState(state, this.combineFailure(error, statusError), requestId, state.generation || null, "workspace_file_index_incremental_update_failed", true);
      }
      try {
        state.db?.close();
      } catch (closeError) {
        state.db = null;
        throw this.failState(state, this.combineFailure(error, closeError), requestId, state.generation || null, "workspace_file_index_incremental_update_failed", true);
      }
      state.db = null;
      state.status = "failed";
      state.partial = true;
      state.message = rootCause;
      state.failure = { reason: error };
      this.writeLog(state, "error", "workspace path index incremental update failed", {
        code: "workspace_file_index_incremental_update_failed",
        requestId,
        workspaceId: state.workspaceId,
        generation: state.generation || null,
        indexPath,
        rootCause,
        ...(error instanceof WorkspacePathIndexPathError ? { diagnosticCode: error.diagnosticCode, path: error.logicalPath, systemCode: error.systemCode } : {}),
      }, { reason: error });
      throw error;
    }
  }

  /** 等真实终止与原后台诊断；已交付结果只在此入口消费一次。 */
  async waitForIdle(): Promise<void> {
    const failures: unknown[] = [];
    for (;;) {
      const owners = [...this.states.values()].flatMap(state => state.work ? [{ state, work: state.work }] : []);
      const results = await Promise.allSettled(owners.map(owner => owner.work));
      for (let index = 0; index < owners.length; index++) {
        const { state, work } = owners[index]!;
        const result = results[index]!;
        if (state.work !== work) continue;
        state.work = null;
        if (result.status === "rejected") failures.push(result.reason);
        if (state.removed && !state.worker && !state.work) this.states.delete(state.workspaceId);
      }
      if (failures.length) {
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(failures, "WORKSPACE_FILE_INDEX_DRAIN_FAILED", { cause: failures[0] });
      }
      const unclosed = [...this.states.values()].find(state => !state.work && state.worker && (state.worker as IndexWorkerOwner).terminationResult?.status === "rejected");
      if (unclosed) throw ((unclosed.worker as IndexWorkerOwner).terminationResult as PromiseRejectedResult).reason;
      if (![...this.states.values()].some(state => state.work || state.worker || state.warmupTimer) && !this.activeWorker) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  /** 停止接新构建，收齐真实 Worker 后再关闭库；清理失败仍显式交付。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const failures: unknown[] = [];
    for (const state of this.states.values()) {
      this.stopWorker(state);
      try { this.stopWatcher(state); }
      catch (error) { failures.push(error); }
      this.clearWarmupTimer(state);
    }
    try { await this.waitForIdle(); }
    catch (error) { failures.push(error); }
    for (const state of this.states.values()) {
      if (state.worker) continue;
      try { state.db?.close(); state.db = null; }
      catch (error) {
        try { this.writeLog(state, "error", "workspace path index close failed", {
          code: "workspace_file_index_close_failed", rootCause: error instanceof Error ? error.message : String(error),
        }, { reason: error }); failures.push(error); }
        catch (failure) { failures.push(failure); }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "WORKSPACE_FILE_INDEX_CLOSE_FAILED", { cause: failures[0] });
    this.states.clear(); this.lifecycleListeners.clear();
  }

  /** 查询持久索引；私有路径或身份检查失败直接上抛，不能被实时回退隐藏。 */
  search(workspaceId: WorkspaceId, workspacePath: string, query: string, opts: WorkspacePathIndexSearchOptions = {}, context?: WorkspacePathIndexOperationContext): FsSearchResponseBody {
    let state: WorkspaceIndexState;
    try {
      state = this.ensureState(workspaceId, workspacePath, context);
    } catch (error) {
      state = this.states.get(workspaceId) ?? this.createState(workspaceId, workspacePath);
      this.states.set(workspaceId, state);
      if (state.status !== "failed") {
        state.status = "failed";
        state.partial = true;
        state.message = error instanceof Error ? error.message : String(error);
      }
      state.failure = { reason: error };
      throw error;
    }
    const requestId = normalizeOperationRequestId(context);
    this.assertStateAvailable(state);
    this.refreshWorkspaceSettingsIfChanged(state, context);
    this.assertStateAvailable(state);
    if (state.status === "queued") this.startBuild(state);
    this.assertStateAvailable(state);

    if (state.status === "failed" || state.status === "disabled" || !state.db) {
      return this.searchFallback(state, workspacePath, query, opts);
    }
    if (state.hasActiveGeneration && !state.activeCompatible) {
      return this.searchFallback(state, workspacePath, query, opts, "文件索引配置已变化，后台校准完成前使用实时搜索");
    }

    let page: FsSearchResponseBody;
    try {
      state.db.assertStorage();
      page = this.searchIndexedEntries(state, query, opts);
    } catch (error) {
      if (workspacePathIndexStorageErrorCode(error)) throw this.failState(state, error, requestId, state.generation || null, "workspace_file_index_query_failed", true);
      if (error instanceof WorkspacePathIndexPathError) {
        error.generation = state.generation || null;
        throw error;
      }
      const rootCause = error instanceof Error ? error.message : String(error);
      try {
        state.db.updateStatus("failed", true, rootCause);
      } catch (statusError) {
        throw this.failState(state, this.combineFailure(error, statusError), requestId, state.generation || null, "workspace_file_index_query_failed", true);
      }
      try {
        state.db.close();
      } catch (closeError) {
        state.db = null;
        throw this.failState(state, this.combineFailure(error, closeError), requestId, state.generation || null, "workspace_file_index_query_failed", true);
      }
      const indexPath = state.db.indexPath;
      state.db = null;
      state.status = "failed";
      state.partial = true;
      state.message = rootCause;
      state.failure = { reason: error };
      this.writeLog(state, "error", "workspace path index query failed", {
        code: "workspace_file_index_query_failed",
        requestId,
        workspaceId: state.workspaceId,
        generation: state.generation || null,
        indexPath,
        rootCause,
      }, { reason: error });
      throw error;
    }
    const isPartial = state.status !== "ready" || state.partial || page.partial === true;
    return {
      ...page,
      indexStatus: state.status,
      indexedCount: state.indexedCount,
      partial: isPartial,
      message: page.message ?? this.buildSearchMessage(state, isPartial),
    };
  }

  /** 实时搜索前复核启用索引的真实存储；路径失败交原边界记录。 */
  private searchFallback(
    state: WorkspaceIndexState,
    workspacePath: string,
    query: string,
    opts: WorkspacePathIndexSearchOptions,
    message?: string,
  ): FsSearchResponseBody {
    if (this.enabled && state.status !== "disabled") {
      try { assertWorkspacePathIndexStorage(workspacePath); }
      catch (error) { throw this.failState(state, error, this.requestIdForGeneration(state, state.generation), state.generation || null, "workspace_file_index_fallback_storage_failed", false); }
    }
    let excludeRules = { excludeDirNames: this.excludeDirNames, excludePathPrefixes: this.excludePathPrefixes };
    try {
      const directory = ensureWorkspaceCodeflowaiDirectory(workspacePath);
      excludeRules = readWorkspaceExcludeRules(directory, excludeRules);
    } catch (error) { throw this.markSettingsAccessFailed(state, error, undefined, "workspace_file_index_fallback_settings_failed", "workspace path index fallback settings failed"); }
    let fallback: FsSearchResponseBody;
    try { fallback = searchPaths(workspacePath, query, { ...opts, ...excludeRules }); }
    catch (error) {
      if (error instanceof WorkspacePathIndexPathError) error.generation = state.generation || null;
      throw error;
    }
    return {
      ...fallback,
      indexStatus: state.status,
      indexedCount: state.indexedCount,
      partial: true,
      message: message ?? state.message ?? "索引不可用，已降级为实时搜索",
    };
  }

  /** 确保状态存在；路径变化时复用 upsert 逻辑触发重建。 */
  private ensureState(workspaceId: WorkspaceId, workspacePath: string, context?: WorkspacePathIndexOperationContext): WorkspaceIndexState {
    this.upsertWorkspace(workspaceId, workspacePath, context);
    const state = this.states.get(workspaceId);
    if (!state) throw new Error(`无法创建 workspace 文件索引状态：${workspaceId}`);
    return state;
  }

  /** 原 state 持有异常时保持原对象，业务 partial 状态本身不阻断查询。 */
  private assertStateAvailable(state: WorkspaceIndexState): void {
    if (state.failure) throw state.failure.reason;
  }

  /** 创建有界内存初始状态；完整路径集合始终只存在于独立 SQLite。 */
  private createState(workspaceId: WorkspaceId, workspacePath: string): WorkspaceIndexState {
    return {
      workspaceId,
      migrationSuspended: false,
      workspacePath,
      status: this.enabled ? "stale" : "disabled",
      generation: 0,
      db: null,
      hasActiveGeneration: false,
      activeCompatible: false,
      rootConflict: false,
      indexedCount: 0,
      partial: true,
      message: this.enabled ? "索引尚未构建" : "工作区路径索引已禁用",
      worker: null,
      warmupTimer: null,
      watcher: null,
      watchTimer: null,
      pendingWatchPaths: new Set(),
      maxEntries: this.defaultMaxEntries,
      configStamp: UNINITIALIZED_WORKSPACE_CONFIG_STAMP,
      excludeRulesStamp: UNINITIALIZED_WORKSPACE_INDEX_IGNORE_STAMP,
      buildRequestGeneration: null,
      buildRequestId: null,
      work: null,
      removed: false,
      failure: null,
    };
  }

  /** 仅当事件仍属于当前 generation 时返回其发起请求，避免后续请求污染异步日志。 */
  private requestIdForGeneration(state: WorkspaceIndexState, generation: number): string | null {
    return state.buildRequestGeneration === generation ? state.buildRequestId : null;
  }

  /** 显式操作上下文优先；未提供时才关联当前 generation 的发起请求。 */
  private resolveOperationRequestId(
    state: WorkspaceIndexState,
    generation: number,
    context?: WorkspacePathIndexOperationContext,
  ): string | null {
    if (context && Object.prototype.hasOwnProperty.call(context, "requestId")) {
      return normalizeOperationRequestId(context);
    }
    return this.requestIdForGeneration(state, generation);
  }

  /** 检测 workspace 索引配置变化；失败在本边界记录后交由调用路径降级或向上返回。 */
  private refreshWorkspaceSettingsIfChanged(state: WorkspaceIndexState, context?: WorkspacePathIndexOperationContext): void {
    if (!this.enabled || state.status === "disabled" || state.rootConflict) return;
    let nextSettings: WorkspaceIndexSettings;
    try {
      nextSettings = this.readWorkspaceIndexSettings(state);
    } catch (error) {
      throw this.markSettingsAccessFailed(
        state,
        error,
        context,
        "workspace_file_index_settings_refresh_failed",
        "workspace path index settings refresh failed",
      );
    }
    if (
      nextSettings.configStamp === state.configStamp
      && nextSettings.excludeRulesStamp === state.excludeRulesStamp
      && nextSettings.maxEntries === state.maxEntries
    ) return;
    this.stopWorker(state);
    this.clearWarmupTimer(state);
    state.maxEntries = nextSettings.maxEntries;
    state.configStamp = nextSettings.configStamp;
    state.excludeRulesStamp = nextSettings.excludeRulesStamp;
    this.reserveStateRebuild(state, "文件索引配置已变化，索引等待重建", context);
    this.queueBuild(state, 0);
  }

  /** 在数据库中预留下一代构建；active generation 和条目保持可查询。 */
  private reserveStateRebuild(
    state: WorkspaceIndexState,
    message: string,
    context?: WorkspacePathIndexOperationContext,
  ): number {
    let settings: WorkspaceIndexSettings;
    try {
      settings = this.readWorkspaceIndexSettings(state);
    } catch (error) {
      throw this.markSettingsAccessFailed(
        state,
        error,
        context,
        "workspace_file_index_settings_read_failed",
        "workspace path index settings read failed",
      );
    }
    state.maxEntries = settings.maxEntries;
    state.configStamp = settings.configStamp;
    state.excludeRulesStamp = settings.excludeRulesStamp;
    const requestId = normalizeOperationRequestId(context);
    let reservedGeneration: number | null = null;
    try {
      const db = this.ensureStateDatabase(state, settings, requestId);
      const generation = db.reserveBuild({
        configStamp: settings.configStamp,
        excludeRulesStamp: settings.excludeRulesStamp,
        policyStamp: WORKSPACE_PATH_INDEX_POLICY_STAMP,
        maxEntries: settings.maxEntries,
      }, message);
      reservedGeneration = generation;
      state.generation = generation;
      state.buildRequestGeneration = generation;
      state.buildRequestId = requestId;
      this.syncStateFromDb(state);
      state.failure = null;
      return generation;
    } catch (error) {
      throw this.failState(state, error, requestId, reservedGeneration, "workspace_file_index_reserve_failed", reservedGeneration !== null);
    }
  }

  /** 延迟启动索引构建，避免和启动关键路径抢资源。 */
  private queueBuild(state: WorkspaceIndexState, delayMs: number): void {
    if (this.disposed || state.migrationSuspended || !this.enabled || state.status === "disabled" || state.rootConflict) return;
    if (state.worker || state.warmupTimer) return;
    state.status = "queued";
    state.partial = true;
    state.message = delayMs > 0 ? "索引等待后台构建" : "索引准备构建";
    state.warmupTimer = setTimeout(() => {
      state.warmupTimer = null;
      this.startBuild(state);
    }, delayMs);
    state.warmupTimer.unref?.();
  }

  /** 在全局单并发名额内启动索引；规则读取失败只收敛为当前 workspace 失败。 */
  private startBuild(state: WorkspaceIndexState): void {
    this.clearWarmupTimer(state);
    if (this.disposed || state.migrationSuspended || !this.enabled || state.status === "disabled" || state.rootConflict || state.worker) return;
    if (this.activeWorker) {
      state.status = "queued";
      state.partial = true;
      state.message = "索引等待其他工作区构建完成";
      return;
    }
    const generation = state.generation;
    if (generation <= 0) throw new Error(`workspace 索引缺少有效 generation：${state.workspaceId}`);

    try {
      const workerPath = resolveWorkspacePathIndexWorkerPath();
      const settings = this.readWorkspaceIndexSettings(state);
      state.maxEntries = settings.maxEntries;
      state.configStamp = settings.configStamp;
      state.excludeRulesStamp = settings.excludeRulesStamp;
      const db = this.ensureStateDatabase(state, settings, this.requestIdForGeneration(state, generation));
      const meta = db.getMeta();
      if (!this.isReservedBuildCompatible(meta, generation, settings)) {
        if (meta.buildGeneration !== generation) {
          this.logStaleGeneration(state.workspaceId, generation, meta.buildGeneration, "start_build");
          return;
        }
        db.cancelBuild(generation, "stale", "构建启动前文件索引配置已变化，等待按最新配置重建");
        const buildRequestId = this.requestIdForGeneration(state, generation);
        const nextGeneration = this.reserveStateRebuild(
          state,
          "文件索引配置已变化，索引等待重建",
          { requestId: buildRequestId },
        );
        this.writeLog(state, "info", "workspace path index build reservation replaced before start", {
          code: "workspace_index_build_stamp_changed",
          requestId: buildRequestId,
          workspaceId: state.workspaceId,
          generation,
          nextGeneration,
          indexPath: db.indexPath,
          rootCause: "reserved build settings no longer match current workspace settings",
        });
        this.queueBuild(state, 0);
        return;
      }
      if (!db.markBuilding(generation)) {
        this.logStaleGeneration(state.workspaceId, generation, db.getMeta().buildGeneration, "mark_building");
        return;
      }
      this.syncStateFromDb(state);
      const worker = this.workerFactory(workerPath, {
        workspaceId: state.workspaceId,
        workspacePath: state.workspacePath,
        generation,
        includeHidden: true,
        maxEntries: state.maxEntries,
        configStamp: state.configStamp,
        excludeRulesStamp: state.excludeRulesStamp,
        policyStamp: WORKSPACE_PATH_INDEX_POLICY_STAMP,
        excludeDirNames: settings.excludeDirNames,
        excludePathPrefixes: settings.excludePathPrefixes,
      });
      (worker as IndexWorkerOwner).indexGeneration = generation;
      state.worker = worker;
      this.activeWorker = worker;
      worker.on("message", (message) => {
        this.runWorkerCallback(state, generation, () => {
          if (state.worker !== worker || state.generation !== generation || (worker as IndexWorkerOwner).stopping) {
            this.logStaleGeneration(state.workspaceId, generation, state.generation, "message_worker"); return;
          }
          this.handleWorkerMessage(message as WorkerMessage);
        });
      });
      worker.on("error", (error) => {
        this.runWorkerCallback(state, generation, () => {
          if (state.worker !== worker || state.generation !== generation || (worker as IndexWorkerOwner).stopping) {
            this.logStaleGeneration(state.workspaceId, generation, state.generation, "error_worker"); return;
          }
          this.handleWorkerFailure(state.workspaceId, generation, error);
        });
      });
      worker.on("exit", (code) => {
        this.runWorkerCallback(state, generation, () => {
          const current = this.states.get(state.workspaceId);
          if (current && current.generation === generation && current.worker === worker && !(worker as IndexWorkerOwner).stopping) {
            current.worker = null;
            if (current.status === "building") this.finishFailedBuild(current, generation, new Error(`索引 worker 未完成即退出：${code}`), "workspace_file_index_worker_early_exit", { exitCode: code });
          } else if (current && current.generation !== generation) {
            this.logStaleGeneration(state.workspaceId, generation, current.generation, "exit");
          }
        });
        const owner = worker as IndexWorkerOwner;
        if (owner.stopping && owner.terminationResult?.status === "rejected" && state.worker === worker) state.worker = null;
        if (!owner.stopping || owner.terminationResult?.status === "rejected") this.releaseActiveWorker(worker);
      });
      this.writeLog(state, "info", "workspace path index build started", {
        code: "workspace_file_index_build_started",
        workspaceId: state.workspaceId,
        generation,
        workerPath,
        maxEntries: state.maxEntries,
        excludeDirNameCount: settings.excludeDirNames.length,
        excludePathPrefixCount: settings.excludePathPrefixes.length,
      });
      this.emitLifecycle({ type: "building", workspaceId: state.workspaceId, generation, at: Date.now() });
    } catch (error) {
      if (isIndexDiagnosticFailure(error)) {
        this.stopWorker(state); state.status = "failed"; state.partial = true;
        state.message = "文件索引诊断失败"; state.failure = { reason: error }; this.retainBackgroundFailure(state, error);
      } else this.runWorkerCallback(state, generation, () => this.finishFailedBuild(state, generation, error, "workspace_file_index_worker_start_failed"));
      this.scheduleNextQueuedBuild();
    }
  }

  /** 处理 worker 批量消息，过期 generation 直接丢弃。 */
  private handleWorkerMessage(message: WorkerMessage): void {
    const state = this.states.get(message.workspaceId);
    if (!state || state.generation !== message.generation) {
      this.logStaleGeneration(message.workspaceId, message.generation, state?.generation ?? null, message.type);
      return;
    }

    if (message.type === "heartbeat") {
      const meta = state.db?.getMeta();
      state.indexedCount = meta?.activeGeneration === null
        ? message.indexedCount
        : (meta?.activeIndexedCount ?? state.indexedCount);
      this.emitLifecycle({
        type: "heartbeat",
        workspaceId: state.workspaceId,
        generation: state.generation,
        indexedCount: message.indexedCount,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "done") {
      try {
        if (!state.db) throw new Error("workspace 文件索引数据库未打开");
        const settings = this.readWorkspaceIndexSettings(state);
        const metaBeforePublish = state.db.getMeta();
        if (!this.isReservedBuildCompatible(metaBeforePublish, message.generation, settings)) {
          if (metaBeforePublish.buildGeneration !== message.generation) {
            this.logStaleGeneration(state.workspaceId, message.generation, metaBeforePublish.buildGeneration, "publish_build");
            return;
          }
          state.db.cancelBuild(message.generation, "stale", "构建期间文件索引配置已变化，等待按最新配置重建");
          this.stopWorker(state);
          const buildRequestId = this.requestIdForGeneration(state, message.generation);
          const nextGeneration = this.reserveStateRebuild(
            state,
            "文件索引配置已变化，索引等待重建",
            { requestId: buildRequestId },
          );
          this.writeLog(state, "info", "workspace path index build replaced before publish", {
            code: "workspace_index_build_stamp_changed",
            requestId: buildRequestId,
            workspaceId: state.workspaceId,
            generation: message.generation,
            nextGeneration,
            indexPath: state.db.indexPath,
            rootCause: "completed build settings no longer match current workspace settings",
          });
          this.queueBuild(state, 0);
          return;
        }
        try {
          const meta = state.db.publishBuild(message.generation, message.partial);
          this.applyMetaToState(state, meta);
        } catch (error) {
          let failure = error;
          let activeGeneration: number | null = null;
          let metaVerified = false;
          try { const meta = state.db.getMeta(); this.applyMetaToState(state, meta); activeGeneration = meta.activeGeneration; metaVerified = true; }
          catch (metaError) { failure = this.combineFailure(error, metaError); }
          this.stopWorker(state);
          if (metaVerified && activeGeneration !== message.generation) {
            try { this.finishFailedBuild(state, message.generation, failure, "workspace_file_index_publish_failed"); }
            catch (diagnosticError) { failure = diagnosticError; }
            this.retainBackgroundFailure(state, failure);
            return;
          }
          if (!metaVerified) { state.status = "failed"; state.partial = true; state.message = "无法确认文件索引发布结果"; }
          try { this.writeLog(state, "error", "workspace path index publish finalization failed", {
            code: "workspace_file_index_publish_finalize_failed", requestId: this.requestIdForGeneration(state, message.generation),
            generation: message.generation, rootCause: failure instanceof Error ? failure.message : String(failure),
          }, { reason: failure }); }
          catch (logError) { failure = logError; }
          this.retainBackgroundFailure(state, failure);
          return;
        }
      } catch (error) {
        if (isIndexDiagnosticFailure(error)) throw error;
        this.handleWorkerFailure(state.workspaceId, message.generation, error);
        return;
      }
      this.stopWorker(state);
      this.writeLog(state, "info", "workspace path index build finished", {
        code: "workspace_file_index_build_finished",
        workspaceId: state.workspaceId,
        generation: state.generation,
        indexedCount: state.indexedCount,
        skippedDirCount: message.skippedDirCount,
        partial: state.partial,
      });
      this.emitLifecycle({
        type: "done",
        workspaceId: state.workspaceId,
        generation: state.generation,
        indexedCount: state.indexedCount,
        partial: state.partial,
        at: Date.now(),
      });
      return;
    }
    const error = isWorkspacePathIndexStorageErrorCode(message.storageCode)
      ? new WorkspacePathIndexDbError(message.storageCode, message.message)
      : new Error(message.message);
    this.finishFailedBuild(state, message.generation, error, "workspace_file_index_build_failed", {
      diagnosticCode: message.diagnosticCode,
      path: message.logicalPath,
      systemCode: message.systemCode,
    });
  }

  /** 处理 worker runtime error，保留 partial 状态供前端识别。 */
  private handleWorkerFailure(workspaceId: WorkspaceId, generation: number, error: unknown): void {
    const state = this.states.get(workspaceId);
    if (!state || state.generation !== generation) {
      this.logStaleGeneration(workspaceId, generation, state?.generation ?? null, "error");
      return;
    }
    this.finishFailedBuild(state, generation, error, "workspace_file_index_worker_error");
  }

  /** Worker 回调不逃逸进程；诊断失败只隔离所属 W，保已发布状态和原错误。 */
  private runWorkerCallback(state: WorkspaceIndexState, generation: number, action: () => void): void {
    try { action(); }
    catch (error) {
      if (isIndexDiagnosticFailure(error) || state.status === "ready") {
        this.stopWorker(state);
        if (state.status !== "ready") { state.status = "failed"; state.partial = true; state.message = "文件索引诊断失败"; state.failure = { reason: error }; }
        this.retainBackgroundFailure(state, error);
        return;
      }
      try { this.handleWorkerFailure(state.workspaceId, generation, error); }
      catch (failure) { this.retainBackgroundFailure(state, failure); }
    }
  }

  /** 普通构建失败沿原 cancel 入口；保护失败及补写次因都转入无 SQL 清理。 */
  private finishFailedBuild(state: WorkspaceIndexState, generation: number, error: unknown, code: string, detail: Record<string, unknown> = {}): void {
    let failure = error;
    if (!workspacePathIndexStorageErrorCode(error)) {
      try {
        state.db?.cancelBuild(generation, "failed", error instanceof Error ? error.message : String(error));
        this.syncStateFromDb(state);
      } catch (statusError) { failure = this.combineFailure(error, statusError); }
    }
    this.failState(state, failure, this.requestIdForGeneration(state, generation), generation, code, true, detail);
  }

  /** 失败后只清理资源和内存，绝不补写 SQL；关闭次因保留在同一错误链。 */
  private failState(state: WorkspaceIndexState, error: unknown, requestId: string | null, generation: number | null, code: string, emit: boolean, detail: Record<string, unknown> = {}): unknown {
    this.clearWarmupTimer(state);
    this.stopWorker(state);
    const db = state.db;
    state.db = null;
    let failure = error;
    try { db?.close(); }
    catch (closeError) { failure = this.combineFailure(error, closeError); }
    state.status = "failed";
    state.partial = true;
    state.message = failure instanceof Error ? failure.message : String(failure);
    state.failure = { reason: failure };
    const causes = this.failureCauses(failure);
    const pathError = causes.find(cause => cause instanceof WorkspacePathIndexPathError) as WorkspacePathIndexPathError | undefined;
    const level = code === "workspace_file_index_build_failed" || code === "workspace_file_index_worker_error" || code === "workspace_file_index_worker_early_exit" ? "warn" : "error";
    if (isIndexDiagnosticFailure(error)) return failure;
    this.writeLog(state, level, "workspace path index operation failed", {
      code, requestId, workspaceId: state.workspaceId, generation,
      indexPath: db?.indexPath ?? workspacePathIndexDatabasePath(path.resolve(state.workspacePath)),
      rootCause: state.message, storageCode: workspacePathIndexStorageErrorCode(failure),
      ...(causes.length > 1 ? { causes: [...new Set(causes.map(cause => pathError ? workspacePathIndexStorageErrorCode(cause) ?? (cause instanceof WorkspacePathIndexPathError ? cause.diagnosticCode : "INDEX_OPERATION_FAILED") : cause instanceof Error ? cause.message : String(cause)))] } : {}),
      ...(pathError ? { diagnosticCode: pathError.diagnosticCode, path: pathError.logicalPath, systemCode: pathError.systemCode } : {}),
      ...detail,
    }, { reason: failure });
    if (emit && generation !== null && generation > 0) this.emitLifecycle({ type: "failed", workspaceId: state.workspaceId, generation, error: state.message, at: Date.now() });
    return failure;
  }

  /** 保留最初故障和清理次因，任一保护码保持可判定而不被通用错误替换。 */
  private combineFailure(original: unknown, secondary: unknown): Error {
    const causes = [...this.failureCauses(original), ...this.failureCauses(secondary)];
    const storageCode = causes.map(cause => workspacePathIndexStorageErrorCode(cause)).find(code => code !== null);
    const pathError = causes.find(cause => cause instanceof WorkspacePathIndexPathError);
    const message = pathError instanceof WorkspacePathIndexPathError ? pathError.message : [original, secondary].map(error => error instanceof Error ? error.message : String(error)).join("；");
    const cause = new AggregateError([original, secondary], message);
    return storageCode ? new WorkspacePathIndexDbError(storageCode, message, { cause }) : new Error(message, { cause });
  }

  /** 只在本错误边界展开 cause/聚合次因；去环并限制64项，保留嵌套安全诊断。 */
  private failureCauses(error: unknown): unknown[] {
    const pending = [error];
    const seen = new Set<unknown>();
    const causes: unknown[] = [];
    while (pending.length && causes.length < 64) {
      const current = pending.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      causes.push(current);
      if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
      if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 64));
    }
    return causes;
  }

  /** 订阅者拥有同步投影边界；失败停止后续订阅并交给原 Worker owner。 */
  private emitLifecycle(event: WorkspacePathIndexLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch (error) {
        if (isIndexDiagnosticFailure(error)) throw error;
        const state = this.states.get(event.workspaceId);
        if (!state) throw error;
        this.writeLog(state, "error", "workspace path index lifecycle listener failed", {
          code: "workspace_index_lifecycle_listener_failed",
          requestId: state ? this.requestIdForGeneration(state, event.generation) : null,
          workspaceId: event.workspaceId,
          generation: event.generation,
          indexPath: state?.db?.indexPath
            ?? (state ? path.normalize(workspacePathIndexDatabasePath(path.resolve(state.workspacePath))) : null),
          eventType: event.type,
          rootCause: error instanceof Error ? error.message : String(error),
        }, { reason: error });
        throw Object.assign(new AggregateError([error], "WORKSPACE_FILE_INDEX_LIFECYCLE_FAILED", { cause: error }), { code: "WORKSPACE_FILE_INDEX_LIFECYCLE_FAILED" });
      }
    }
  }

  /** 记录被 generation fence 拒绝的迟到事件，便于恢复链路排障。 */
  private logStaleGeneration(
    workspaceId: WorkspaceId,
    eventGeneration: number,
    currentGeneration: number | null,
    eventType: string,
  ): void {
    const state = this.states.get(workspaceId);
    if (!state) {
      logger.info("workspace-index", "workspace path index stale generation ignored", { code: "workspace_index_stale_generation_ignored", requestId: null, workspaceId, eventGeneration, currentGeneration, eventType });
      return;
    }
    this.writeLog(state, "info", "workspace path index stale generation ignored", {
      code: "workspace_index_stale_generation_ignored",
      requestId: state ? this.requestIdForGeneration(state, eventGeneration) : null,
      workspaceId,
      generation: eventGeneration,
      indexPath: state?.db?.indexPath
        ?? (state ? path.normalize(workspacePathIndexDatabasePath(path.resolve(state.workspacePath))) : null),
      eventGeneration,
      currentGeneration,
      eventType,
      rootCause: "event generation does not match current workspace generation",
    });
  }

  /** SQL 分页前核查询目录，当前页返回前复核真实目标；不在分页后删项。 */
  private searchIndexedEntries(state: WorkspaceIndexState, query: string, opts: WorkspacePathIndexSearchOptions): FsSearchResponseBody {
    if (!state.db) throw new Error("workspace 文件索引数据库未打开");
    const limit = normalizeSearchLimit(opts.limit);
    const offset = normalizeSearchCursor(opts.cursor);
    const includeHidden = opts.includeHidden === true;
    const kind = opts.kind === "file" || opts.kind === "directory" ? opts.kind : "all";
    const directoryQuery = parseDirectorySearchQuery(query);
    if (directoryQuery && !isValidDirectorySearchQuery(state.workspacePath, query, directoryQuery.dirRelPath)) {
      return emptySearchPage();
    }
    const pathScope = readWorkspacePathIndexPathScope(state.workspacePath);
    if (directoryQuery?.dirRelPath) {
      if (isWorkspacePathIndexPathExcluded(directoryQuery.dirRelPath, true)) return emptySearchPage();
      if (isWorkspacePathIndexPrivatePath(pathScope, directoryQuery.dirRelPath)) {
        const staleAlias = [...collectParentRelPaths(directoryQuery.dirRelPath), directoryQuery.dirRelPath]
          .find(candidate => state.db!.getEntry(candidate) && isWorkspacePathIndexPrivatePath(pathScope, candidate));
        if (staleAlias) throw new WorkspacePathIndexPathError("WORKSPACE_FILE_INDEX_PRIVATE_TARGET", staleAlias, "PRIVATE_RUNTIME_TARGET");
        return emptySearchPage();
      }
    }
    const page = directoryQuery
      ? state.db.searchDirectory(directoryQuery.dirRelPath, directoryQuery.filter, { limit, offset, includeHidden, kind })
      : state.db.search(normalizeSearchQuery(query), { limit, offset, includeHidden, kind });
    const missingStats: string[] = [];
    return {
      results: page.entries.map((entry) => this.toSearchResult(state.workspacePath, entry, missingStats, pathScope)),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      partial: missingStats.length > 0 ? true : undefined,
      message: missingStats.length > 0 ? `部分文件已变化，${missingStats.length} 个结果缺少最新元信息` : undefined,
    };
  }

  /** 当前页真实目标变化为私有时整体失败，普通已删除文件沿原 partial 语义。 */
  private toSearchResult(workspacePath: string, entry: WorkspacePathIndexStoredEntry, missingStats: string[], pathScope: WorkspacePathIndexPathScope): FsSearchResult {
    if (isWorkspacePathIndexPrivatePath(pathScope, entry.path)) {
      throw new WorkspacePathIndexPathError("WORKSPACE_FILE_INDEX_PRIVATE_TARGET", entry.path, "PRIVATE_RUNTIME_TARGET");
    }
    if (entry.isDir) return { path: entry.path, name: entry.name, isDir: true };
    const stat = this.tryReadFileStat(workspacePath, entry.path);
    if (!stat) missingStats.push(entry.path);
    return {
      path: entry.path,
      name: entry.name,
      isDir: false,
      size: stat?.size,
      mtime: stat?.mtime.toISOString(),
    };
  }

  /** 真实删除沿原 partial 返回；其余读取失败保留安全原因并显式失败。 */
  private tryReadFileStat(workspacePath: string, relPath: string): fs.Stats | null {
    try {
      return fs.statSync(workspacePathIndexFsPath(path.resolve(workspacePath, relPath)));
    } catch (error) {
      if (!isNotFoundError(error)) throw workspacePathIndexPathFailure(relPath, error);
      return null;
    }
  }

  /** 先核私有祖先，再将已知变更写入同一 active/journal 事务，缺失叶也不漏清祖先。 */
  private buildPersistentMutations(
    state: WorkspaceIndexState,
    changes: readonly WorkspacePathIndexChange[],
  ): { mutations: WorkspacePathIndexDbMutation[]; staleIfDirectoryPaths: string[] } {
    if (!state.db) throw new Error(`workspace 文件索引数据库未打开：${state.workspaceId}`);
    const mutations: WorkspacePathIndexDbMutation[] = [];
    const staleIfDirectoryPaths: string[] = [];
    const directory = ensureWorkspaceCodeflowaiDirectory(state.workspacePath);
    const excludeRules = readWorkspaceExcludeRules(directory, {
      excludeDirNames: this.excludeDirNames,
      excludePathPrefixes: this.excludePathPrefixes,
    });
    const nextOrders = new Map<string, number>();
    const plannedEntries = new Map<string, WorkspacePathIndexEntry>();
    const pathScope = readWorkspacePathIndexPathScope(state.workspacePath);
    /** 缺失叶事件也先定位私有祖先，清理整棵旧 alias。 */
    const privateAncestor = (relPath: string): string | null => {
      for (const candidate of [...collectParentRelPaths(relPath), relPath]) {
        if (isWorkspacePathIndexPrivatePath(pathScope, candidate)) return candidate;
      }
      return null;
    };
    const allocateOrder = (relPath: string): number => {
      const parentPath = path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath);
      const current = nextOrders.get(parentPath) ?? state.db!.nextParentEntryOrder(parentPath);
      nextOrders.set(parentPath, current + 1);
      return current;
    };
    const toPersistentEntry = (relPath: string, isDirectory: boolean): WorkspacePathIndexEntry => {
      const existing = plannedEntries.get(relPath) ?? state.db!.getEntry(relPath);
      const entry = toIndexedEntry(relPath, isDirectory, existing?.parentEntryOrder ?? allocateOrder(relPath));
      plannedEntries.set(relPath, entry);
      return entry;
    };
    /** 私有祖先先于 stat 缺失短路处理，普通路径仍复用原增量顺序。 */
    const buildUpsert = (rawRelPath: string): { mutations: WorkspacePathIndexDbMutation[]; isDirectory: boolean } => {
      const relPath = normalizeIndexRelPath(state.workspacePath, rawRelPath);
      if (isWorkspacePathIndexStorageRelPath(relPath)) return { mutations: [], isDirectory: false };
      const privatePath = privateAncestor(relPath);
      if (privatePath) return { mutations: [{ type: "delete", path: privatePath, recursive: true }], isDirectory: true };
      const stat = this.readIndexPathStat(state.workspacePath, relPath);
      if (!stat || (!stat.isFile() && !stat.isDirectory())) {
        return { mutations: [{ type: "delete", path: relPath, recursive: true }], isDirectory: false };
      }
      const isDirectory = stat.isDirectory();
      const hiddenDirectoryRoot = findHiddenDirectoryRoot(relPath, isDirectory);
      if (hiddenDirectoryRoot) {
        return { mutations: [{ type: "delete", path: hiddenDirectoryRoot, recursive: true }], isDirectory };
      }
      if (isWorkspacePathIndexPathExcluded(relPath, isDirectory, excludeRules)) {
        return { mutations: [{ type: "delete", path: relPath, recursive: true }], isDirectory };
      }
      const out: WorkspacePathIndexDbMutation[] = [];
      for (const parentPath of collectParentRelPaths(relPath)) {
        const parentStat = this.readIndexPathStat(state.workspacePath, parentPath);
        if (parentStat?.isDirectory()) {
          out.push({ type: "upsert", entry: toPersistentEntry(parentPath, true) });
        }
      }
      out.push({ type: "upsert", entry: toPersistentEntry(relPath, isDirectory) });
      return { mutations: out, isDirectory };
    };

    for (const change of changes) {
      if (change.type === "upsert") {
        mutations.push(...buildUpsert(change.path).mutations);
        continue;
      }
      if (change.type === "delete") {
        const relPath = normalizeIndexRelPath(state.workspacePath, change.path);
        if (!isWorkspacePathIndexStorageRelPath(relPath)) mutations.push({ type: "delete", path: privateAncestor(relPath) ?? relPath, recursive: true });
        continue;
      }
      const fromPath = normalizeIndexRelPath(state.workspacePath, change.fromPath);
      const target = buildUpsert(change.toPath);
      const forcesStale = target.isDirectory;
      if (!isWorkspacePathIndexStorageRelPath(fromPath)) {
        staleIfDirectoryPaths.push(fromPath);
        mutations.push({ type: "delete", path: fromPath, recursive: true, forcesStale });
      }
      mutations.push(...target.mutations.map((mutation) => ({ ...mutation, forcesStale })));
    }
    return { mutations, staleIfDirectoryPaths };
  }

  /** 读取增量路径 stat；路径不存在按删除处理，其余异常向上暴露。 */
  private readIndexPathStat(workspacePath: string, relPath: string): fs.Stats | null {
    try {
      return fs.statSync(workspacePathIndexFsPath(path.resolve(workspacePath, relPath)));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw new Error(`读取索引路径失败：${relPath}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  /** 生成对外返回的索引状态快照。 */
  private toIndexStatus(state: WorkspaceIndexState): FsReindexResponseBody {
    return {
      indexStatus: state.status,
      indexedCount: state.indexedCount,
      partial: state.partial,
      message: state.message,
    };
  }

  /** 生成给调用方展示的索引状态说明。 */
  private buildSearchMessage(state: WorkspaceIndexState, partial: boolean): string | null {
    if (state.message) return state.message;
    if (!partial) return null;
    if (state.status === "building") return "索引正在后台构建，当前结果可能不完整";
    if (state.status === "queued") return "索引等待后台构建，当前结果可能不完整";
    if (state.status === "stale") return "索引不完整，当前结果可能不完整";
    return null;
  }

  /** 原 Worker 保存真实终止 Promise；失败保名额，公开等待负责最终消费。 */
  private stopWorker(state: WorkspaceIndexState): Promise<void> | null {
    const worker = state.worker as IndexWorkerOwner | null;
    if (!worker) return null;
    if (worker.termination && worker.terminationResult?.status !== "rejected") return worker.termination;
    const generation = worker.indexGeneration ?? state.generation;
    const requestId = this.requestIdForGeneration(state, generation);
    const indexPath = state.db?.indexPath ?? path.normalize(workspacePathIndexDatabasePath(path.resolve(state.workspacePath)));
    worker.stopping = true;
    const operation = new Promise<number>(resolve => { resolve(worker.terminate()); })
      .then(() => {
        if (state.worker === worker) state.worker = null;
        this.releaseActiveWorker(worker);
      })
      .catch((error) => {
        this.writeLog(state, "error", "workspace path index worker terminate failed", {
          code: "workspace_file_index_worker_terminate_failed",
          requestId,
          workspaceId: state.workspaceId,
          generation,
          indexPath,
          rootCause: error instanceof Error ? error.message : String(error),
        }, { reason: error });
        throw error;
      });
    worker.termination = operation;
    void operation.then(value => { worker.terminationResult = { status: "fulfilled", value }; }, reason => { worker.terminationResult = { status: "rejected", reason }; });
    this.trackWork(state, operation);
    return operation;
  }

  /** 只扩原 state 的真实任务尾链，后续成功不能抹掉尚未消费的失败。 */
  private trackWork(state: WorkspaceIndexState, operation: Promise<void>, primaryFailure = false): void {
    const previous = state.work;
    const operations = primaryFailure && !previous?.primaryFailure ? [operation, previous!] : [previous!, operation];
    const work = (previous ? Promise.allSettled(operations).then(results => {
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "WORKSPACE_FILE_INDEX_WORK_FAILED", { cause: failures[0] });
    }) : operation) as NonNullable<WorkspaceIndexState["work"]>;
    work.primaryFailure = primaryFailure || previous?.primaryFailure;
    state.work = work;
    void work.then(value => {
      work.result = { status: "fulfilled", value };
      if (state.work === work) state.work = null;
      if (state.removed && !state.work && !state.worker) this.states.delete(state.workspaceId);
    }, reason => { work.result = { status: "rejected", reason }; });
  }

  /** 异步边界仅结算原 owner，固定诊断失败不得改写已提交索引事实。 */
  private retainBackgroundFailure(state: WorkspaceIndexState, error: unknown): void {
    this.trackWork(state, Promise.reject(error), true);
  }

  /** 单 W 日志只经可信 writer；拒写保原业务错和所有假值，不回退应用日志。 */
  private writeLog(state: WorkspaceIndexState, level: WorkspaceLogEntry["level"], message: string, data: Record<string, unknown>, business?: { reason: unknown }): void {
    try {
      this.writeWorkspaceLog(state.workspaceId, { level, tag: "workspace-index", message, data: {
        requestId: this.requestIdForGeneration(state, state.generation), workspaceId: state.workspaceId,
        generation: state.generation || null, ...data,
      } });
    } catch (error) {
      const failure = Object.assign(new AggregateError(business ? [business.reason, error] : [error], "WORKSPACE_FILE_INDEX_LOG_FAILED", {
        cause: business ? business.reason : error,
      }), { code: "WORKSPACE_FILE_INDEX_LOG_FAILED", workspaceId: state.workspaceId });
      if (state.status === "failed") state.failure = { reason: failure };
      throw failure;
    }
  }

  /** 释放全局单并发名额，并在下一事件循环启动最早排队的 workspace。 */
  private releaseActiveWorker(worker: Worker): void {
    if (this.activeWorker !== worker) return;
    this.activeWorker = null;
    this.scheduleNextQueuedBuild();
  }

  /** 错峰启动下一项索引任务，避免多个 workspace worker 同时争抢磁盘和 CPU。 */
  private scheduleNextQueuedBuild(): void {
    if (this.disposed || this.activeWorker) return;
    const immediate = setImmediate(() => {
      if (this.disposed || this.activeWorker) return;
      const next = Array.from(this.states.values()).find((state) => state.status === "queued" && !state.worker && !state.warmupTimer);
      if (next) this.startBuild(next);
    });
    immediate.unref?.();
  }

  /** 清理延迟预热计时器。 */
  private clearWarmupTimer(state: WorkspaceIndexState): void {
    if (!state.warmupTimer) return;
    clearTimeout(state.warmupTimer);
    state.warmupTimer = null;
  }

  /** 监听工作区真实文件变化，增量刷新持久索引；索引未就绪时由全量构建覆盖当前文件。 */
  private startWatcher(state: WorkspaceIndexState): void {
    if (!this.enabled || state.migrationSuspended || state.watcher || state.rootConflict) return;
    try {
      state.watcher = fs.watch(state.workspacePath, { recursive: true }, (_eventType, filename) => {
        if (state.removed || !state.watcher || filename === null) return;
        const relPath = String(filename).split(path.sep).join("/");
        if (relPath === WORKSPACE_INDEX_IGNORE_DIR || relPath.startsWith(WORKSPACE_INDEX_IGNORE_DIR + "/")
          || relPath === WORKSPACE_RUNTIME_DIRECTORY || relPath.startsWith(WORKSPACE_RUNTIME_DIRECTORY + "/")
          || relPath === ".git" || relPath.startsWith(".git/")) return;
        state.pendingWatchPaths.add(relPath);
        this.scheduleWatchFlush(state);
      });
      // 监听器是增量更新加速器，不能单独阻止进程退出；真实业务仍由 Client 其他句柄保活。
      state.watcher.unref();
      state.watcher.on("error", (error) => {
        try {
          this.writeLog(state, "warn", "workspace path index watcher failed", {
            code: "workspace_file_index_watch_failed",
            workspaceId: state.workspaceId,
            rootCause: error instanceof Error ? error.message : String(error),
          }, { reason: error });
        } catch (logError) {
          logger.error("workspace-index", "workspace path index watcher log failed", {
            code: "workspace_file_index_watch_log_failed",
            workspaceId: state.workspaceId,
            rootCause: logError instanceof Error ? logError.message : String(logError),
          });
        } finally {
          try { this.stopWatcher(state); }
          catch (closeError) {
            logger.error("workspace-index", "workspace path index watcher close failed", {
              code: "workspace_file_index_watch_close_failed",
              workspaceId: state.workspaceId,
              rootCause: closeError instanceof Error ? closeError.message : String(closeError),
            });
          }
        }
      });
    } catch (error) {
      try {
        this.writeLog(state, "warn", "workspace path index watcher unavailable", {
          code: "workspace_file_index_watch_unavailable",
          workspaceId: state.workspaceId,
          rootCause: error instanceof Error ? error.message : String(error),
        }, { reason: error });
      } catch (logError) {
        logger.error("workspace-index", "workspace path index watcher unavailable log failed", {
          code: "workspace_file_index_watch_unavailable_log_failed",
          workspaceId: state.workspaceId,
          rootCause: logError instanceof Error ? logError.message : String(logError),
        });
      }
    }
  }

  /** 合并短时间内的文件事件；只在索引 ready 时增量落库，构建期间保留到完成后再提交。 */
  private scheduleWatchFlush(state: WorkspaceIndexState): void {
    if (state.watchTimer) return;
    state.watchTimer = setTimeout(() => {
      state.watchTimer = null;
      if (state.removed) { state.pendingWatchPaths.clear(); return; }
      if (state.status === "queued" || state.status === "building") {
        // 构建期间保留事件，构建完成后补交，避免扫描与写入之间的竞态漏文件。
        state.watchTimer = setTimeout(() => { state.watchTimer = null; this.scheduleWatchFlush(state); }, 500);
        state.watchTimer.unref?.();
        return;
      }
      if (state.status !== "ready" || !state.db) { state.pendingWatchPaths.clear(); return; }
      const changes: WorkspacePathIndexChange[] = [...state.pendingWatchPaths].map(item => ({ type: "upsert", path: item }));
      state.pendingWatchPaths.clear();
      if (!changes.length) return;
      try {
        this.applyChanges(state.workspaceId, state.workspacePath, changes, { requestId: `workspace-index-watch:${state.workspaceId}` });
      } catch (error) {
        // 定时器不能向调用方抛出；applyChanges 已收口状态，这里补充监听边界日志。
        try {
          this.writeLog(state, "error", "workspace path index watcher apply failed", {
            code: "workspace_file_index_watch_apply_failed",
            workspaceId: state.workspaceId,
            rootCause: error instanceof Error ? error.message : String(error),
          }, { reason: error });
        } catch (logError) {
          logger.error("workspace-index", "workspace path index watcher apply log failed", {
            code: "workspace_file_index_watch_apply_log_failed",
            workspaceId: state.workspaceId,
            rootCause: logError instanceof Error ? logError.message : String(logError),
          });
        }
      }
    }, 300);
    state.watchTimer.unref?.();
  }

  /** 停止文件监听并清空未提交事件；关闭失败只记录，不阻断索引状态收口。 */
  private stopWatcher(state: WorkspaceIndexState): void {
    if (state.watchTimer) {
      clearTimeout(state.watchTimer);
      state.watchTimer = null;
    }
    state.pendingWatchPaths.clear();
    const watcher = state.watcher;
    state.watcher = null;
    if (!watcher) return;
    try { watcher.close(); }
    catch (error) {
      try {
        this.writeLog(state, "warn", "workspace path index watcher close failed", {
          code: "workspace_file_index_watch_close_failed",
          workspaceId: state.workspaceId,
          rootCause: error instanceof Error ? error.message : String(error),
        }, { reason: error });
      } catch (logError) {
        throw new AggregateError([error, logError], "WORKSPACE_FILE_INDEX_WATCH_CLOSE_FAILED", { cause: error });
      }
    }
  }

  /** 延迟打开当前 workspace 的独立索引库，并把持久标量同步到 state。 */
  private ensureStateDatabase(
    state: WorkspaceIndexState,
    settings: WorkspaceIndexSettings,
    requestId: string | null,
  ): WorkspacePathIndexDb {
    if (state.db) return state.db;
    const open = (): WorkspacePathIndexDb => openWorkspacePathIndexDb({
      workspaceId: state.workspaceId,
      workspacePath: state.workspacePath,
      settings: {
        configStamp: settings.configStamp,
        excludeRulesStamp: settings.excludeRulesStamp,
        policyStamp: WORKSPACE_PATH_INDEX_POLICY_STAMP,
        maxEntries: settings.maxEntries,
      },
    });
    try {
      state.db = open();
    } catch (error) {
      if (!(error instanceof WorkspacePathIndexDbError) || ![
        "WORKSPACE_FILE_INDEX_SCHEMA_INCOMPATIBLE",
        "WORKSPACE_FILE_INDEX_METADATA_MISMATCH",
        "WORKSPACE_FILE_INDEX_CORRUPT",
      ].includes(error.code)) {
        // reserve/start 均拥有完整失败清理与上下文，此处只负责识别可恢复数据库。
        throw error;
      }
      let recovery: ReturnType<typeof recoverWorkspacePathIndexDbFiles>;
      try {
        recovery = recoverWorkspacePathIndexDbFiles(state.workspacePath);
      } catch (recoveryError) {
        const failure = this.combineFailure(error, recoveryError);
        this.writeLog(state, "error", "workspace path index recovery isolation failed", {
          code: "workspace_file_index_recovery_failed",
          requestId,
          workspaceId: state.workspaceId,
          generation: state.generation || null,
          indexPath: path.normalize(workspacePathIndexDatabasePath(path.resolve(state.workspacePath))),
          originalErrorCode: error.code,
          rootCause: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
        }, { reason: failure });
        throw failure;
      }
      this.writeLog(state, "error", "workspace path index isolated for rebuild", {
        code: error.code.toLowerCase(),
        requestId,
        workspaceId: state.workspaceId,
        generation: state.generation || null,
        indexPath: recovery.indexPath,
        recoveredFileCount: recovery.recoveredPaths.length,
        rootCause: error.message,
      }, { reason: error });
      try {
        state.db = open();
      } catch (reopenError) {
        const failure = this.combineFailure(error, reopenError);
        this.writeLog(state, "error", "workspace path index reopen after recovery failed", {
          code: "workspace_file_index_reopen_failed",
          requestId,
          workspaceId: state.workspaceId,
          generation: state.generation || null,
          indexPath: recovery.indexPath,
          rootCause: reopenError instanceof Error ? reopenError.message : String(reopenError),
        }, { reason: failure });
        throw failure;
      }
    }
    this.syncStateFromDb(state);
    return state.db;
  }

  /** 读取数据库最新 meta 并更新内存中的有界标量快照。 */
  private syncStateFromDb(state: WorkspaceIndexState): void {
    if (!state.db) return;
    this.applyMetaToState(state, state.db.getMeta());
  }

  /** 应用 meta 快照；不把任何路径条目复制到主线程 state。 */
  private applyMetaToState(state: WorkspaceIndexState, meta: WorkspacePathIndexDbMeta): void {
    state.generation = meta.buildGeneration ?? meta.activeGeneration ?? 0;
    state.hasActiveGeneration = meta.activeGeneration !== null;
    state.activeCompatible = meta.activeGeneration !== null
      && meta.activeConfigStamp === state.configStamp
      && meta.activeExcludeRulesStamp === state.excludeRulesStamp
      && meta.activePolicyStamp === WORKSPACE_PATH_INDEX_POLICY_STAMP
      && meta.maxEntries === state.maxEntries;
    state.status = meta.status;
    state.indexedCount = meta.activeIndexedCount;
    state.partial = meta.partial;
    state.message = meta.message;
    state.maxEntries = meta.maxEntries;
  }

  /** 预留 generation 的持久配置戳必须与当前规则完全一致，才允许启动或发布。 */
  private isReservedBuildCompatible(
    meta: WorkspacePathIndexDbMeta,
    generation: number,
    settings: WorkspaceIndexSettings,
  ): boolean {
    return meta.buildGeneration === generation
      && meta.buildConfigStamp === settings.configStamp
      && meta.buildExcludeRulesStamp === settings.excludeRulesStamp
      && meta.buildPolicyStamp === WORKSPACE_PATH_INDEX_POLICY_STAMP
      && meta.maxEntries === settings.maxEntries;
  }

  /** 读取当前 workspace 的索引上限和配置变更戳。 */
  private readWorkspaceIndexSettings(state: WorkspaceIndexState): WorkspaceIndexSettings {
    const directory = ensureWorkspaceCodeflowaiDirectory(state.workspacePath);
    let maxEntries = this.defaultMaxEntries;
    if (inspectWorkspaceCodeflowaiFile(directory, "codeflowai.json")) {
      const rep = ensureCodeflowaiConfig(state.workspacePath);
      assertWorkspaceCodeflowaiDirectory(directory);
      maxEntries = resolveWorkspaceFileIndexMaxEntries(rep.config, this.defaultMaxEntries);
    }
    const excludeRules = readWorkspaceExcludeRules(directory, {
      excludeDirNames: this.excludeDirNames,
      excludePathPrefixes: this.excludePathPrefixes,
    });
    return {
      maxEntries,
      configStamp: createWorkspaceIndexSettingsStamp("config", { maxEntries }),
      excludeRulesStamp: createWorkspaceIndexSettingsStamp("ignore", {
        excludeDirNames: [...excludeRules.excludeDirNames].sort(),
        excludePathPrefixes: [...excludeRules.excludePathPrefixes].sort(),
      }),
      ...excludeRules,
    };
  }

  /** 设置访问失败只隔离当前 workspace，并在重新抛出前记录完整物理边界上下文。 */
  private markSettingsAccessFailed(
    state: WorkspaceIndexState,
    error: unknown,
    context: WorkspacePathIndexOperationContext | undefined,
    code: string,
    message: string,
  ): unknown {
    const indexPath = state.db?.indexPath ?? path.normalize(workspacePathIndexDatabasePath(path.resolve(state.workspacePath)));
    this.stopWorker(state);
    this.clearWarmupTimer(state);
    let failure = error;
    try {
      state.db?.close();
    } catch (closeError) { failure = this.combineFailure(error, closeError); }
    state.db = null;
    state.status = "failed";
    state.partial = true;
    state.message = failure instanceof Error ? failure.message : String(failure);
    state.failure = { reason: failure };
    this.writeLog(state, "error", message, {
      code,
      requestId: normalizeOperationRequestId(context),
      workspaceId: state.workspaceId,
      generation: state.generation || null,
      indexPath,
      rootCause: state.message,
    }, { reason: failure });
    return failure;
  }
}

type WorkspaceIndexSettings = {
  maxEntries: number;
  configStamp: string;
  excludeRulesStamp: string;
  excludeDirNames: string[];
  excludePathPrefixes: string[];
};

/** 增量分隔符归一化保留文件名空格，原 workspace 边界校验继续生效。 */
function normalizeIndexRelPath(workspacePath: string, rawRelPath: string): string {
  const relPath = String(rawRelPath ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!relPath) throw new Error("索引路径不能为空");
  const parts = relPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`索引路径非法：${rawRelPath}`);
  resolveWorkspacePath(workspacePath, relPath);
  return parts.join("/");
}

/** 目录查询保留真实空格，仅校验绝对路径、父级及 workspace 越界。 */
function isValidDirectorySearchQuery(workspacePath: string, rawQuery: string, rawDirRelPath: string): boolean {
  const queryPath = String(rawQuery ?? "").replace(/\\/g, "/");
  if (path.posix.isAbsolute(queryPath) || path.win32.isAbsolute(queryPath)) return false;

  const dirRelPath = String(rawDirRelPath ?? "").replace(/\\/g, "/");
  if (!dirRelPath) return true;
  if (path.posix.isAbsolute(dirRelPath) || path.win32.isAbsolute(dirRelPath)) return false;
  const parts = dirRelPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  try {
    resolveWorkspacePath(workspacePath, parts.join("/"));
    return true;
  } catch {
    return false;
  }
}

/** 收集文件路径的父目录相对路径，用于新文件进入新目录时补齐目录项。 */
function collectParentRelPaths(relPath: string): string[] {
  const parts = relPath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

/** 把 workspace 相对路径转换为持久索引项。 */
function toIndexedEntry(relPath: string, isDir: boolean, parentEntryOrder: number): WorkspacePathIndexEntry {
  const parts = relPath.split("/").filter(Boolean);
  return {
    path: relPath,
    name: parts.at(-1) ?? relPath,
    isDir,
    hidden: isHiddenPath(relPath),
    parentEntryOrder,
  };
}

/** 判断路径任一段是否为隐藏名称。 */
function isHiddenPath(relPath: string): boolean {
  return relPath.split("/").some((part) => part.startsWith("."));
}

/** 查找命中的隐藏目录根；点开头文件本身不按隐藏目录处理。 */
function findHiddenDirectoryRoot(relPath: string, isDir: boolean): string | null {
  const parts = relPath.split("/").filter(Boolean);
  const directoryPartCount = isDir ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < directoryPartCount; index += 1) {
    if (parts[index]?.startsWith(".")) return parts.slice(0, index + 1).join("/");
  }
  return null;
}

/** 识别文件不存在类错误，增量更新时等价为删除索引项。 */
function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

/** 解析 worker 文件位置，开发态使用 TS 源码，发布包使用 dist CJS。 */
function resolveWorkspacePathIndexWorkerPath(): string {
  const bundledFile = typeof __filename === "string" ? __filename : "";
  if (bundledFile) {
    const bundledWorker = path.resolve(path.dirname(bundledFile), "workspacePathIndexWorker.cjs");
    if (fs.existsSync(bundledWorker)) return bundledWorker;
  }
  const mainFile = path.resolve(String(process.argv[1] ?? ""));
  const distWorker = path.resolve(path.dirname(mainFile), "workspacePathIndexWorker.cjs");
  if (fs.existsSync(distWorker)) return distWorker;
  const sourceWorker = path.resolve(process.cwd(), "apps/desktop/client/src/fs/workspacePathIndexWorker.ts");
  if (fs.existsSync(sourceWorker)) return sourceWorker;
  const localSourceWorker = path.resolve(process.cwd(), "src/fs/workspacePathIndexWorker.ts");
  if (fs.existsSync(localSourceWorker)) return localSourceWorker;
  throw new Error(`找不到 workspace 文件索引 worker：${distWorker}`);
}

/** 创建索引 worker；开发态用 tsx bootstrap 加载 TS，发布态直接运行构建后的 CJS。 */
function createWorkspacePathIndexWorker(workerPath: string, workerData: WorkspacePathIndexWorkerData): Worker {
  if (path.extname(workerPath).toLowerCase() !== ".ts") {
    return new Worker(pathToFileURL(workerPath), { workerData });
  }
  const requireBase = path.resolve(String(process.argv[1] ?? path.join(process.cwd(), "package.json")));
  const require = createRequire(requireBase);
  const tsxApiUrl = pathToFileURL(require.resolve("tsx/esm/api")).href;
  const workerUrl = pathToFileURL(workerPath).href;
  const bootstrapSource = [
    `import { tsImport } from ${JSON.stringify(tsxApiUrl)};`,
    `await tsImport(${JSON.stringify(workerUrl)}, import.meta.url);`,
  ].join("\n");
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrapSource)}`), {
    execArgv: ["--conditions", "development"],
    workerData,
  });
}

/** 归一化延迟配置，避免负值或非数字进入计时器。 */
function normalizeDelay(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** 把可选请求上下文收敛为有界标量；后台操作和空值统一记为 null。 */
function normalizeOperationRequestId(context?: WorkspacePathIndexOperationContext): string | null {
  const requestId = String(context?.requestId ?? "").trim();
  return requestId || null;
}

/** 对已解析的有效设置生成带域前缀的稳定内容摘要。 */
function createWorkspaceIndexSettingsStamp(scope: "config" | "ignore", value: unknown): string {
  const digest = createHash("sha256")
    .update(`workspace-file-index-${scope}-v1\0`, "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/** 读取 workspace 级文件索引排除规则，并合并全局配置。 */
function readWorkspaceExcludeRules(directory: WorkspaceCodeflowaiDirectoryIdentity, base: { excludeDirNames: string[]; excludePathPrefixes: string[] }): { excludeDirNames: string[]; excludePathPrefixes: string[] } {
  ensureWorkspaceIgnoreFile(directory);
  cleanupLegacyWorkspaceCodeflowaiDirectory(directory.workspaceRoot, error => logger.warn("workspace-index", "legacy control directory cleanup deferred", {
    code: "workspace_legacy_control_directory_cleanup_deferred",
    workspacePath: directory.workspaceRoot,
    rootCause: (error as NodeJS.ErrnoException | null)?.code ?? "unknown",
  }));
  const fileRules = parseWorkspaceIndexIgnoreFile(directory);
  return {
    excludeDirNames: normalizeExcludeDirNames([...base.excludeDirNames, ...fileRules.excludeDirNames]),
    excludePathPrefixes: normalizeExcludePathPrefixes([...base.excludePathPrefixes, ...fileRules.excludePathPrefixes]),
  };
}

/** 确保 workspace 的文件索引排除文件存在，首次创建时写入注释示例。 */
function ensureWorkspaceIgnoreFile(directory: WorkspaceCodeflowaiDirectoryIdentity): string {
  const existing = inspectWorkspaceCodeflowaiFile(directory, WORKSPACE_INDEX_IGNORE_FILE);
  if (existing) return existing.path;
  // 历史 `codeflowai/file-index-ignore.txt` 只复制到新目录，旧文件保留。
  const legacy = inspectExistingWorkspaceCodeflowaiDirectory(directory.workspaceRoot, LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY);
  const legacyFile = legacy && inspectWorkspaceCodeflowaiFile(legacy, WORKSPACE_INDEX_IGNORE_FILE);
  const content = legacyFile
    ? readWorkspaceCodeflowaiFile(legacy!, WORKSPACE_INDEX_IGNORE_FILE)
    : DEFAULT_WORKSPACE_INDEX_IGNORE_CONTENT;
  return writeWorkspaceCodeflowaiFile(directory, WORKSPACE_INDEX_IGNORE_FILE, content, { onlyIfMissing: true }).path;
}

/** 解析 codeflowai/file-index-ignore.txt；仅支持目录名和 workspace 相对路径前缀。 */
function parseWorkspaceIndexIgnoreFile(directory: WorkspaceCodeflowaiDirectoryIdentity): { excludeDirNames: string[]; excludePathPrefixes: string[] } {
  const raw = readWorkspaceCodeflowaiFile(directory, WORKSPACE_INDEX_IGNORE_FILE).toString("utf8");
  const excludeDirNames: string[] = [];
  const excludePathPrefixes: string[] = [];
  raw.split(/\r?\n/g).forEach((line, index) => {
    const rule = normalizeIgnoreRuleLine(line);
    if (!rule) return;
    if (rule.startsWith("!")) throw new Error(`${WORKSPACE_INDEX_IGNORE_REL_PATH}:${index + 1} 不支持否定规则：${rule}`);
    if (rule.includes("*")) throw new Error(`${WORKSPACE_INDEX_IGNORE_REL_PATH}:${index + 1} 不支持 glob 规则：${rule}`);
    if (rule.includes("/")) excludePathPrefixes.push(rule);
    else excludeDirNames.push(rule);
  });
  return { excludeDirNames, excludePathPrefixes };
}

/** 归一化单行排除规则，保留简单目录名或相对路径前缀。 */
function normalizeIgnoreRuleLine(line: string): string {
  const trimmed = String(line ?? "").trim();
  if (!trimmed || trimmed.startsWith("#")) return "";
  const slashNormalized = trimmed.replace(/\\/g, "/");
  if (slashNormalized.startsWith("/") || path.isAbsolute(slashNormalized) || /^[a-zA-Z]:/.test(slashNormalized)) {
    throw new Error(`${WORKSPACE_INDEX_IGNORE_REL_PATH} 不允许绝对路径规则：${trimmed}`);
  }
  const normalized = slashNormalized.replace(/\/+$/g, "").replace(/^\.\//, "");
  if (!normalized) return "";
  if (normalized.split("/").some((part) => part === "..")) throw new Error(`${WORKSPACE_INDEX_IGNORE_REL_PATH} 不允许包含 ..：${trimmed}`);
  return normalized.toLowerCase();
}

/** 归一化目录名排除规则；规则必须是不含路径分隔符的单段名称。 */
function normalizeExcludeDirNames(values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const name = String(value ?? "").trim().toLowerCase();
    if (!name) continue;
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new Error(`文件索引目录名排除规则无效：${value}`);
    }
    out.add(name);
  }
  return Array.from(out);
}

/** 归一化 workspace 相对路径前缀排除规则。 */
function normalizeExcludePathPrefixes(values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const prefix = normalizeIgnoreRuleLine(String(value ?? ""));
    if (!prefix) continue;
    if (!prefix.includes("/")) {
      throw new Error(`文件索引路径前缀排除规则必须包含目录分隔符：${value}`);
    }
    out.add(prefix);
  }
  return Array.from(out);
}

/** 比较两个本地路径是否指向同一字符串路径，Windows 下忽略大小写。 */
function isSamePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.normalize(value.trim());
  const l = normalize(left);
  const r = normalize(right);
  return process.platform === "win32" ? l.toLowerCase() === r.toLowerCase() : l === r;
}
