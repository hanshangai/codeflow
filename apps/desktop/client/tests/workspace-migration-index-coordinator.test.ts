import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import type {
  FsReindexResponseBody,
  FsSearchResponseBody,
  WorkspaceId,
} from "@codeflowai/shared";

import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";
import type { WorkspaceDirectoryMigrationRecord } from "../src/db/repos/workspaceDirectoryMigrationRepo.ts";
import type {
  WorkspacePathIndex,
  WorkspacePathIndexChange,
  WorkspacePathIndexLifecycleEvent,
  WorkspacePathIndexOperationContext,
  WorkspacePathIndexSearchOptions,
} from "../src/fs/workspacePathIndexService.ts";
import { logger } from "../src/logger.ts";
import { WorkspacePathIndexService } from "../src/fs/workspacePathIndexService.ts";
import { WorkspaceMigrationIndexCoordinatorService } from "../src/workspace-migration/workspaceMigrationIndexCoordinator.ts";

type TestContext = {
  root: string;
  db: ClientDb;
  workspaceId: WorkspaceId;
  sourcePath: string;
  targetPath: string;
  close: () => void;
};

/** 旧日志断言显式提供固定 writer 替身，真实落点由独立集成文件覆盖。 */
function observeWorkspaceLogs(t: test.TestContext, db: ClientDb): void {
  t.mock.method(db, "writeWorkspaceLog", (_workspaceId: WorkspaceId, entry: Parameters<ClientDb["writeWorkspaceLog"]>[1]) => logger[entry.level](entry.tag, entry.message, entry.data));
}

class FakePathIndex implements WorkspacePathIndex {
  private generation = 20;
  private readonly listeners = new Set<(event: WorkspacePathIndexLifecycleEvent) => void>();
  readonly started: Array<{ workspaceId: WorkspaceId; generation: number }> = [];
  readonly cancelled: Array<{ workspaceId: WorkspaceId; generation: number }> = [];
  readonly terminated: Array<{ workspaceId: WorkspaceId; generation: number; reason: string }> = [];
  readonly requestIds: Array<string | null> = [];
  failTerminate = false;
  failCancel = false;
  onStart: ((workspaceId: WorkspaceId, generation: number) => void) | null = null;

  /** 返回稳定空搜索结果；协调器测试不覆盖搜索实现。 */
  search(
    _workspaceId: WorkspaceId,
    _workspacePath: string,
    _query: string,
    _opts?: WorkspacePathIndexSearchOptions,
  ): FsSearchResponseBody {
    return { results: [], hasMore: false, nextCursor: null };
  }

  /** 普通手工重建返回 queued；迁移阻断场景由协调器改走两阶段接口。 */
  rebuildWorkspace(_workspaceId: WorkspaceId, _workspacePath: string): FsReindexResponseBody {
    return { indexStatus: "queued", indexedCount: 0, partial: true, message: "queued" };
  }

  /** 分配单调 generation，但不启动构建。 */
  reserveWorkspaceRebuild(_workspaceId: WorkspaceId, _workspacePath: string, context?: WorkspacePathIndexOperationContext) {
    this.requestIds.push(context?.requestId ?? null);
    this.generation += 1;
    return { kind: "reserved" as const, generation: this.generation };
  }

  /** 记录启动，并允许测试在启动边界核对 SQLite 已先持久化。 */
  startReservedWorkspaceRebuild(workspaceId: WorkspaceId, generation: number): void {
    this.onStart?.(workspaceId, generation);
    this.started.push({ workspaceId, generation });
  }

  /** 记录持久化失败后的 reservation 取消。 */
  cancelReservedWorkspaceRebuild(workspaceId: WorkspaceId, generation: number): void {
    this.cancelled.push({ workspaceId, generation });
    if (this.failCancel) throw new Error("cancel reservation failed");
  }

  /** 记录超时或手工换代前的旧 Worker 终止。 */
  async terminateWorkspaceRebuild(
    workspaceId: WorkspaceId,
    generation: number,
    reason: string,
    context?: WorkspacePathIndexOperationContext,
  ): Promise<void> {
    this.requestIds.push(context?.requestId ?? null);
    this.terminated.push({ workspaceId, generation, reason });
    if (this.failTerminate) throw new Error("terminate failed");
  }

  /** 注册生命周期监听器。 */
  subscribeLifecycle(listener: (event: WorkspacePathIndexLifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 协调器测试不依赖增量索引，返回 queued 快照。 */
  applyChanges(
    _workspaceId: WorkspaceId,
    _workspacePath: string,
    _changes: WorkspacePathIndexChange[],
  ): FsReindexResponseBody {
    return { indexStatus: "queued", indexedCount: 0, partial: true, message: "queued" };
  }

  /** 协调器测试不触发全局预热。 */
  scheduleWarmup(_workspaces: Map<WorkspaceId, string>): void {}

  /** 协调器测试不触发工作区同步。 */
  syncWorkspaces(_workspaces: Map<WorkspaceId, string>): void {}

  /** 协调器测试不维护真实索引状态。 */
  upsertWorkspace(_workspaceId: WorkspaceId, _workspacePath: string): void {}

  /** 协调器测试不维护真实索引状态。 */
  deleteWorkspace(_workspaceId: WorkspaceId): void {}

  /** 清空测试监听器。 */
  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  /** 测试替身没有 Worker；真实排空由 service 集成用例验证。 */
  async waitForIdle(): Promise<void> {}

  /** 向协调器发布指定 generation 的测试生命周期。 */
  emit(event: WorkspacePathIndexLifecycleEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** 创建带真实 SQLite 的迁移索引测试上下文。 */
function setup(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-migration-index-"));
  const sourcePath = path.join(root, "source");
  const targetPath = path.join(root, "target");
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.mkdirSync(targetPath, { recursive: true });
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = "client:index-coordinator" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "workspace", path: sourcePath });
  return {
    root,
    db,
    workspaceId,
    sourcePath,
    targetPath,
    close: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 通过 Repo 合法状态边构造 completed + pending 索引操作。 */
function seedPending(
  ctx: TestContext,
  generation = 7,
  now = 100,
  completed = true,
): WorkspaceDirectoryMigrationRecord {
  const repo = ctx.db.workspaceDirectoryMigrations;
  let operation = repo.create({
    operationId: "migration-index-operation",
    idempotencyKey: "migration-index-key",
    workspaceId: ctx.workspaceId,
    sourcePath: ctx.sourcePath,
    targetParentPath: ctx.root,
    targetPath: ctx.targetPath,
    now: 1,
  }).operation;
  operation = repo.transitionState({
    operationId: operation.operationId,
    expectedState: "scanning",
    expectedStateVersion: operation.stateVersion,
    nextState: "awaiting_confirmation",
    now: 2,
  });
  operation = repo.prepareStartAttempt({
    operationId: operation.operationId,
    startAttemptId: "attempt",
    externalWritesPausedConfirmed: true,
    targetNotSyncManagedConfirmed: true,
    now: 3,
  });
  operation = repo.acceptStartAttempt({
    operationId: operation.operationId,
    startAttemptId: "attempt",
    expectedStateVersion: operation.stateVersion,
    now: 4,
  });
  operation = repo.transitionState({
    operationId: operation.operationId,
    expectedState: "preparing",
    expectedStateVersion: operation.stateVersion,
    nextState: "copying",
    patch: { terminalCwdSnapshot: {} },
    now: operation.updatedAt + 1,
  });
  for (const nextState of ["verifying", "publish_intent", "target_ready"] as const) {
    operation = repo.transitionState({
      operationId: operation.operationId,
      expectedState: operation.state,
      expectedStateVersion: operation.stateVersion,
      nextState,
      now: operation.updatedAt + 1,
    });
  }
  operation = repo.commitPath({
    operationId: operation.operationId,
    expectedState: "target_ready",
    expectedStateVersion: operation.stateVersion,
    terminalCwdTargets: {},
    now: operation.updatedAt + 1,
  });
  operation = repo.transitionState({
    operationId: operation.operationId,
    expectedState: "path_committed",
    expectedStateVersion: operation.stateVersion,
    nextState: "finalizing",
    now: operation.updatedAt + 1,
  });
  operation = repo.setIndexRebuildPending({
    operationId: operation.operationId,
    expectedState: "finalizing",
    expectedStateVersion: operation.stateVersion,
    generation,
    phase: "queued",
    lastProgressAt: now,
    now,
  });
  if (!completed) return operation;
  return repo.transitionState({
    operationId: operation.operationId,
    expectedState: "finalizing",
    expectedStateVersion: operation.stateVersion,
    nextState: "completed",
    now: now + 1,
  });
}

test("real index storage protection immediately settles the migration pending generation", async () => {
  const ctx = setup();
  let worker: EventEmitter | null = null;
  const pathIndex = new WorkspacePathIndexService({ writeWorkspaceLog: ctx.db.writeWorkspaceLog, workerFactory: () => {
    const emitter = new EventEmitter();
    worker = emitter;
    /** 保留真实 service 的 exit 释放语义，扫描过程由 done 消息固定。 */
    return Object.assign(emitter, { terminate: async () => { emitter.emit("exit", 0); return 0; } }) as unknown as Worker;
  } });
  const coordinator = new WorkspaceMigrationIndexCoordinatorService({ db: ctx.db, pathIndex, now: () => 200, timeoutCheckIntervalMs: 0 });
  try {
    const initial = seedPending(ctx);
    await coordinator.recoverPendingOnStartup();
    const deadline = Date.now() + 5_000;
    while (!worker && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(worker);
    const pending = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
    const peer = path.join(ctx.root, "sentinel");
    const sidecar = path.join(ctx.targetPath, ".codeflowai", "file-index.db-journal");
    fs.writeFileSync(peer, "untouched");
    fs.linkSync(peer, sidecar);
    (worker as EventEmitter).emit("message", { type: "done", workspaceId: ctx.workspaceId, generation: pending.indexRebuildGeneration, indexedCount: 0, skippedDirCount: 0, partial: false });
    const failed = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
    assert.equal(failed.indexRebuildStatus, "failed");
    assert.equal(failed.indexRebuildGeneration, pending.indexRebuildGeneration);
    assert.equal(fs.readFileSync(peer, "utf8"), "untouched");
    assert.equal(failed.state, "completed");
    await assert.rejects(pathIndex.waitForIdle(), error => error instanceof Error && (error as { code?: string }).code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE");
    fs.unlinkSync(sidecar);
  } finally {
    await coordinator.dispose();
    await pathIndex.dispose();
    ctx.close();
  }
});

test("真实Writer下索引协调器换代和生命周期短段准入，关闭等待已接收事件", async () => {
  const ctx = setup(), pathIndex = new FakePathIndex();
  const initial = seedPending(ctx);
  const writer = new ClientDbWriterService({ dbPath: path.join(ctx.root, "client.db"), db: ctx.db, onFatalError(error) { assert.fail(String(error)); } });
  const coordinator = new WorkspaceMigrationIndexCoordinatorService({ db: ctx.db, pathIndex, timeoutCheckIntervalMs: 0,
    withLegacyDatabase: <T>(requestId: string, operation: () => T) => writer.withLegacyDatabase(requestId, operation),
    onOperationChanged(operation) { ctx.db.workspaceDirectoryMigrations.require(operation.operationId); },
  });
  try {
    await writer.ready();
    await coordinator.recoverPendingOnStartup();
    const generation = pathIndex.started[0]!.generation;
    pathIndex.emit({ type: "building", workspaceId: ctx.workspaceId, generation, at: Date.now() });
    pathIndex.emit({ type: "done", workspaceId: ctx.workspaceId, generation, at: Date.now(), indexedCount: 1, partial: false } as any);
    await coordinator.dispose();
    assert.equal(await writer.withLegacyDatabase("verify-index", () => ctx.db.workspaceDirectoryMigrations.require(initial.operationId).indexRebuildStatus), "ready");
  } finally { await coordinator.dispose(); await writer.close(); ctx.close(); }
});

test("startup recovery persists a new generation before worker start and maps lifecycle", async () => {
  const ctx = setup();
  const pathIndex = new FakePathIndex();
  const changed: WorkspaceDirectoryMigrationRecord[] = [];
  try {
    const initial = seedPending(ctx, 7, 100);
    pathIndex.onStart = (_workspaceId, generation) => {
      const persisted = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      assert.equal(persisted.indexRebuildGeneration, generation);
      assert.equal(persisted.indexRebuildStatus, "pending");
    };
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({
      db: ctx.db,
      pathIndex,
      now: () => 200,
      timeoutCheckIntervalMs: 0,
      onOperationChanged: (operation) => changed.push(operation),
    });
    try {
      await coordinator.recoverPendingOnStartup();
      const generation = pathIndex.started[0]?.generation;
      assert.equal(typeof generation, "number");
      assert.notEqual(generation, 7);
      if (generation == null) return;

      const pending = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      const pendingVersion = pending.stateVersion;
      pathIndex.emit({ type: "building", workspaceId: ctx.workspaceId, generation, at: 210 });
      pathIndex.emit({ type: "heartbeat", workspaceId: ctx.workspaceId, generation, indexedCount: 12, at: 220 });
      const building = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      assert.equal(building.indexRebuildPhase, "building");
      assert.equal(building.indexRebuildLastProgressAt, 220);
      assert.equal(building.stateVersion, pendingVersion);

      pathIndex.emit({ type: "done", workspaceId: ctx.workspaceId, generation: 7, indexedCount: 1, partial: false, at: 225 });
      assert.equal(ctx.db.workspaceDirectoryMigrations.require(initial.operationId).indexRebuildStatus, "pending");
      pathIndex.emit({ type: "done", workspaceId: ctx.workspaceId, generation, indexedCount: 12, partial: true, at: 230 });
      const ready = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      assert.equal(ready.indexRebuildStatus, "ready");
      assert.equal(ready.warningCode, null);
      assert.ok(changed.length >= 2);
    } finally {
      await coordinator.dispose();
    }
  } finally {
    ctx.close();
  }
});

test("timeout persists failed even when worker termination fails, then manual rebuild replaces generation", async (t) => {
  const ctx = setup();
  observeWorkspaceLogs(t, ctx.db);
  const pathIndex = new FakePathIndex();
  const errorLogs: Array<Record<string, unknown>> = [];
  const warningLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") errorLogs.push(data as Record<string, unknown>);
  });
  t.mock.method(logger, "warn", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") warningLogs.push(data as Record<string, unknown>);
  });
  try {
    const initial = seedPending(ctx, 9, 100);
    pathIndex.failTerminate = true;
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({
      db: ctx.db,
      pathIndex,
      now: () => 500,
      queuedTimeoutMs: 100,
      buildingTimeoutMs: 100,
      timeoutCheckIntervalMs: 0,
    });
    try {
      let original: unknown;
      await assert.rejects(coordinator.checkTimeouts(), error => { original = error; return error instanceof Error && error.message === "terminate failed"; });
      await assert.rejects(coordinator.waitForIdle(), error => error === original);
      const failed = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      assert.equal(failed.indexRebuildStatus, "failed");
      assert.equal(failed.warningCode, "WORKSPACE_INDEX_REBUILD_FAILED");
      assert.match(JSON.stringify(failed.warningDetails), /terminate failed/);
      assert.equal(pathIndex.terminated[0]?.generation, 9);
      assert.equal(pathIndex.requestIds[0], null);
      const terminationLog = errorLogs.find((entry) => entry.code === "workspace_migration_index_timeout_termination_failed");
      assert.equal(terminationLog?.requestId, null);
      assert.equal(terminationLog?.workspaceId, ctx.workspaceId);
      assert.equal(terminationLog?.generation, 9);
      assert.equal(terminationLog?.indexPath, path.join(ctx.targetPath, ".codeflowai", "file-index.db"));
      assert.equal(terminationLog?.rootCause, "terminate failed");
      const timeoutLog = warningLogs.find((entry) => entry.code === "workspace_migration_index_rebuild_timeout");
      assert.equal(timeoutLog?.requestId, null);
      assert.equal(timeoutLog?.indexPath, path.join(ctx.targetPath, ".codeflowai", "file-index.db"));
      assert.equal(timeoutLog?.rootCause, "terminate failed");

      pathIndex.failTerminate = false;
      const response = await coordinator.rebuildWorkspace(ctx.workspaceId, ctx.targetPath);
      const pending = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      assert.equal(response.indexStatus, "queued");
      assert.equal(pending.indexRebuildStatus, "pending");
      assert.equal(pending.warningCode, null);
      assert.equal(pathIndex.started.at(-1)?.generation, pending.indexRebuildGeneration);
    } finally {
      await coordinator.dispose();
    }
  } finally {
    ctx.close();
  }
});

test("startup recovery fails a completed pending generation before opening a duplicate physical root", async (t) => {
  const ctx = setup();
  const pathIndex = new FakePathIndex();
  const errorLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") errorLogs.push(data as Record<string, unknown>);
  });
  try {
    const initial = seedPending(ctx, 17, 100);
    const otherWorkspaceId = "client:index-coordinator:duplicate-owner" as WorkspaceId;
    ctx.db.workspaces.upsert({ id: otherWorkspaceId, title: "duplicate owner", path: ctx.targetPath });
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({
      db: ctx.db,
      pathIndex,
      now: () => 200,
      timeoutCheckIntervalMs: 0,
    });
    try {
      await coordinator.recoverPendingOnStartup();
      assert.deepEqual(pathIndex.started, []);
      assert.deepEqual(pathIndex.requestIds, []);
      const failed = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      assert.equal(failed.state, "completed");
      assert.equal(failed.indexRebuildStatus, "failed");
      assert.equal(failed.warningCode, "WORKSPACE_INDEX_REBUILD_FAILED");
      assert.equal((failed.warningDetails as any)?.reason, "workspace_root_already_registered");
      const logged = errorLogs.find((entry) => entry.code === "workspace_migration_index_startup_root_conflict");
      assert.equal(logged?.workspaceId, ctx.workspaceId);
      assert.equal(logged?.operationId, initial.operationId);
      assert.equal(logged?.generation, 17);
      assert.equal(logged?.indexPath, path.join(ctx.targetPath, ".codeflowai", "file-index.db"));
      await assert.rejects(
        coordinator.rebuildWorkspace(ctx.workspaceId, ctx.targetPath, { requestId: "manual-root-conflict" }),
        (error: any) => error?.code === "WORKSPACE_PATH_ALREADY_REGISTERED",
      );
      assert.deepEqual(pathIndex.started, []);
      assert.deepEqual(pathIndex.requestIds, []);
      const manualLog = errorLogs.find((entry) => entry.code === "workspace_migration_index_manual_root_conflict");
      assert.equal(manualLog?.requestId, "manual-root-conflict");
      assert.equal(manualLog?.operationId, initial.operationId);
    } finally {
      await coordinator.dispose();
    }
  } finally {
    ctx.close();
  }
});

test("coordinator error boundaries log complete workspace index context", async (t) => {
  const ctx = setup();
  observeWorkspaceLogs(t, ctx.db);
  const pathIndex = new FakePathIndex();
  const errorLogs: Array<Record<string, unknown>> = [];
  const fatalErrors: Error[] = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") errorLogs.push(data as Record<string, unknown>);
  });
  try {
    seedPending(ctx, 23, 100);
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({
      db: ctx.db,
      pathIndex,
      now: () => 200,
      timeoutCheckIntervalMs: 0,
      onOperationChanged: () => {
        throw new Error("notification failed");
      },
      onFatalError: (error) => fatalErrors.push(error),
    });
    try {
      await assert.rejects(coordinator.recoverPendingOnStartup(), /notification failed/);
      assert.equal(pathIndex.started.length, 0);
      const notificationLog = errorLogs.find((entry) => entry.code === "workspace_migration_index_notification_failed");
      assert.equal(notificationLog?.requestId, null);
      assert.equal(notificationLog?.workspaceId, ctx.workspaceId);
      assert.equal(notificationLog?.indexPath, path.join(ctx.targetPath, ".codeflowai", "file-index.db"));
      assert.equal(notificationLog?.rootCause, "notification failed");

      t.mock.method(ctx.db.workspaceDirectoryMigrations, "touchIndexRebuildProgress", () => {
        throw new Error("progress persistence failed");
      });
      const generation = ctx.db.workspaceDirectoryMigrations.listDirectoryMigrationIndexStates()[0]?.indexRebuildGeneration;
      assert.equal(typeof generation, "number");
      if (generation == null) return;
      assert.throws(() => pathIndex.emit({ type: "building", workspaceId: ctx.workspaceId, generation, at: 210 }), /WORKSPACE_MIGRATION_INDEX_PERSIST_FAILED/);

      const fatalLog = errorLogs.find((entry) => entry.code === "workspace_migration_index_lifecycle_persist_failed");
      assert.equal(fatalLog?.requestId, null);
      assert.equal(fatalLog?.workspaceId, ctx.workspaceId);
      assert.equal(fatalLog?.generation, generation);
      assert.equal(fatalLog?.indexPath, path.join(ctx.targetPath, ".codeflowai", "file-index.db"));
      assert.equal(fatalLog?.rootCause, "progress persistence failed");
      assert.equal(fatalErrors.length, 0);
    } finally {
      await coordinator.dispose();
    }
  } finally {
    ctx.close();
  }
});

test("generation persistence keeps the primary error when reservation cancellation also fails", async (t) => {
  const ctx = setup();
  observeWorkspaceLogs(t, ctx.db);
  const pathIndex = new FakePathIndex();
  const errorLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") errorLogs.push(data as Record<string, unknown>);
  });
  try {
    seedPending(ctx, 29, 100);
    pathIndex.failCancel = true;
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({
      db: ctx.db,
      pathIndex,
      now: () => 500,
      timeoutCheckIntervalMs: 0,
    });
    try {
      t.mock.method(ctx.db.workspaceDirectoryMigrations, "setIndexRebuildPending", () => {
        throw new Error("generation persistence failed");
      });
      await assert.rejects(
        () => coordinator.rebuildWorkspace(
          ctx.workspaceId,
          ctx.targetPath,
          { requestId: "request-generation-persist" },
        ),
        error => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, error.errors[0]);
          assert.equal(error.errors[0].message, "generation persistence failed");
          assert.equal(error.errors[1].message, "cancel reservation failed");
          return true;
        },
      );
      assert.equal(pathIndex.cancelled.length, 1);

      const persistLog = errorLogs.find((entry) => entry.code === "workspace_migration_index_generation_persist_failed");
      assert.equal(persistLog?.requestId, "request-generation-persist");
      assert.equal(persistLog?.workspaceId, ctx.workspaceId);
      assert.equal(persistLog?.indexPath, path.join(ctx.targetPath, ".codeflowai", "file-index.db"));
      assert.equal(persistLog?.rootCause, "generation persistence failed");

      const cancelLog = errorLogs.find((entry) => entry.code === "workspace_migration_index_reservation_cancel_failed");
      assert.equal(cancelLog?.requestId, "request-generation-persist");
      assert.equal(cancelLog?.primaryRootCause, "generation persistence failed");
      assert.equal(cancelLog?.rootCause, "cancel reservation failed");
    } finally {
      await coordinator.dispose();
    }
  } finally {
    ctx.close();
  }
});

test("manual reindex keeps requestId when synchronous operation notification fails", async (t) => {
  const ctx = setup();
  observeWorkspaceLogs(t, ctx.db);
  const pathIndex = new FakePathIndex();
  const errorLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") errorLogs.push(data as Record<string, unknown>);
  });
  try {
    seedPending(ctx, 31, 100);
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({
      db: ctx.db,
      pathIndex,
      now: () => 500,
      timeoutCheckIntervalMs: 0,
      onOperationChanged: () => {
        throw new Error("manual notification failed");
      },
    });
    try {
      await assert.rejects(coordinator.rebuildWorkspace(
        ctx.workspaceId,
        ctx.targetPath,
        { requestId: "request-manual-notification" },
      ), /manual notification failed/);
      assert.equal(pathIndex.started.length, 0);
      const notificationLog = errorLogs.find((entry) => entry.code === "workspace_migration_index_notification_failed");
      assert.equal(notificationLog?.requestId, "request-manual-notification");
      assert.equal(notificationLog?.workspaceId, ctx.workspaceId);
      assert.equal(notificationLog?.indexPath, path.join(ctx.targetPath, ".codeflowai", "file-index.db"));
      assert.equal(notificationLog?.rootCause, "manual notification failed");
    } finally {
      await coordinator.dispose();
    }
  } finally {
    ctx.close();
  }
});

test("manual reindex termination failure immediately settles the old pending generation", async () => {
  const ctx = setup();
  const pathIndex = new FakePathIndex();
  try {
    const initial = seedPending(ctx, 17, 100);
    pathIndex.failTerminate = true;
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({
      db: ctx.db,
      pathIndex,
      now: () => 500,
      timeoutCheckIntervalMs: 0,
    });
    try {
      await assert.rejects(
        () => coordinator.rebuildWorkspace(ctx.workspaceId, ctx.targetPath, { requestId: "request-manual-reindex" }),
        /terminate failed/,
      );
      const failed = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      assert.equal(failed.indexRebuildStatus, "failed");
      assert.equal(failed.warningCode, "WORKSPACE_INDEX_REBUILD_FAILED");
      assert.match(JSON.stringify(failed.warningDetails), /manual_reindex_termination_failed/);
      assert.deepEqual(pathIndex.requestIds, ["request-manual-reindex"]);
    } finally {
      await coordinator.dispose();
    }
  } finally {
    ctx.close();
  }
});

test("startup recovery waits finalizing completion before replacing its pending generation", async () => {
  const ctx = setup();
  const pathIndex = new FakePathIndex();
  try {
    const initial = seedPending(ctx, 13, 100, false);
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({
      db: ctx.db,
      pathIndex,
      now: () => 200,
      timeoutCheckIntervalMs: 0,
    });
    try {
      await coordinator.recoverPendingOnStartup();
      const recovered = ctx.db.workspaceDirectoryMigrations.require(initial.operationId);
      assert.equal(recovered.state, "finalizing");
      assert.equal(recovered.indexRebuildStatus, "pending");
      assert.equal(recovered.indexRebuildGeneration, 13);
      assert.equal(pathIndex.started.length, 0);

      const completed = ctx.db.workspaceDirectoryMigrations.transitionState({
        operationId: recovered.operationId,
        expectedState: "finalizing",
        expectedStateVersion: recovered.stateVersion,
        nextState: "completed",
        now: 201,
      });
      await coordinator.recoverPendingOnStartup();
      const generation = ctx.db.workspaceDirectoryMigrations.require(completed.operationId).indexRebuildGeneration;
      assert.notEqual(generation, 13);
      assert.equal(pathIndex.started[0]?.generation, generation);
      assert.notEqual(generation, null);
      if (generation == null) return;
      pathIndex.emit({ type: "done", workspaceId: ctx.workspaceId, generation, indexedCount: 5, partial: false, at: 210 });
      assert.equal(ctx.db.workspaceDirectoryMigrations.require(initial.operationId).indexRebuildStatus, "ready");
    } finally {
      await coordinator.dispose();
    }
  } finally {
    ctx.close();
  }
});

for (const rejected of [undefined, null, false, 0, "", NaN, new Error("INDEX_TIMEOUT_LOG_FAILED")]) {
  test(`D18 索引超时诊断拒写 ${String(rejected)} 保双因并停止后续结算`, async t => {
    const ctx = setup(), pathIndex = new FakePathIndex(), original = new Error("INDEX_TERMINATION_BUSINESS_FAILED");
    const initial = seedPending(ctx, 51, 100);
    t.mock.method(pathIndex, "terminateWorkspaceRebuild", async () => { throw original; });
    t.mock.method(ctx.db, "writeWorkspaceLog", () => { throw rejected; });
    const coordinator = new WorkspaceMigrationIndexCoordinatorService({ db: ctx.db, pathIndex, now: () => 500,
      queuedTimeoutMs: 100, timeoutCheckIntervalMs: 0 });
    try {
      let failure: unknown;
      await assert.rejects(coordinator.checkTimeouts(), error => {
        failure = error; assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], original); assert.ok(Object.is(error.errors[1], rejected)); assert.equal(error.cause, original); return true;
      });
      assert.equal(ctx.db.workspaceDirectoryMigrations.require(initial.operationId).indexRebuildStatus, "pending");
      assert.equal(pathIndex.started.length, 0);
      await assert.rejects(coordinator.waitForIdle(), error => error === failure);
    } finally { await coordinator.dispose(); ctx.close(); }
  });
}

test("D18 索引 timer 诊断失败保原 timeoutCheck，dispose 显式消费且不退出宿主", async t => {
  const ctx = setup(), pathIndex = new FakePathIndex(), original = new Error("INDEX_TIMER_LOG_FAILED");
  const initial = seedPending(ctx, 61, 100);
  pathIndex.failTerminate = true;
  let logged!: () => void;
  const reached = new Promise<void>(resolve => { logged = resolve; });
  t.mock.method(ctx.db, "writeWorkspaceLog", () => { logged(); throw original; });
  const fatal: Error[] = [];
  const coordinator = new WorkspaceMigrationIndexCoordinatorService({ db: ctx.db, pathIndex, now: () => 500,
    queuedTimeoutMs: 100, timeoutCheckIntervalMs: 5, onFatalError: error => { fatal.push(error); } });
  try {
    await Promise.race([reached, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timer did not run")), 2_000))]);
    await assert.rejects(coordinator.dispose(), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], original); return true;
    });
    assert.equal(fatal.length, 0);
    assert.equal(ctx.db.workspaceDirectoryMigrations.require(initial.operationId).indexRebuildStatus, "pending");
  } finally { await coordinator.dispose(); ctx.close(); }
});

test("D18 索引超时登记故障记录原W且由timeoutCheck消费原错误", async t => {
  const ctx = setup(), pathIndex = new FakePathIndex(), original = new Error("INDEX_TIMEOUT_CAS_FAILED"), logs: Array<{ id: WorkspaceId; data: unknown }> = [];
  seedPending(ctx, 71, 100);
  t.mock.method(ctx.db.workspaceDirectoryMigrations, "completeIndexRebuild", () => { throw original; });
  t.mock.method(ctx.db, "writeWorkspaceLog", (id: WorkspaceId, entry: Parameters<ClientDb["writeWorkspaceLog"]>[1]) => { logs.push({ id, data: entry.data }); });
  const coordinator = new WorkspaceMigrationIndexCoordinatorService({ db: ctx.db, pathIndex, now: () => 500, queuedTimeoutMs: 100, timeoutCheckIntervalMs: 0 });
  try {
    await assert.rejects(coordinator.checkTimeouts(), error => error === original);
    await assert.rejects(coordinator.waitForIdle(), error => error === original);
    assert.equal(logs.length, 1); assert.equal(logs[0]!.id, ctx.workspaceId);
    assert.equal((logs[0]!.data as { code: string }).code, "workspace_migration_index_timeout_persist_failed");
  } finally { await coordinator.dispose(); ctx.close(); }
});
