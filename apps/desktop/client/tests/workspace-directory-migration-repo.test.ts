import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceId } from "@codeflowai/shared";

import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import {
  WorkspaceDirectoryMigrationRepo,
  WorkspaceDirectoryMigrationRepoError,
  validateWorkspaceDbSnapshot,
  type WorkspaceDirectoryMigrationRecord,
} from "../src/db/repos/workspaceDirectoryMigrationRepo.ts";
import { openSqliteDb } from "../src/db/sqliteDb.ts";
import type { SqliteDb } from "../src/db/sqliteTypes.ts";
import { WorkspaceRepo } from "../src/db/repos/workspaceRepo.ts";
import { ScheduledTaskRuntimeStateRepo } from "../src/db/repos/scheduledTaskRuntimeStateRepo.ts";

type TestContext = {
  db: SqliteDb;
  repo: WorkspaceDirectoryMigrationRepo;
  workspaceIds: [WorkspaceId, WorkspaceId];
  close: () => void;
};

test("D18 证据严格拒绝未知字段、缺失身份和 Number 截断，null 仍为旧模式", () => {
  assert.equal(validateWorkspaceDbSnapshot(null), null);
  assert.deepEqual(validateWorkspaceDbSnapshot({ formatVersion: 1, state: "pending" }), { formatVersion: 1, state: "pending" });
  const identity = { dev: "0", ino: "90071992547409931" };
  assert.deepEqual(validateWorkspaceDbSnapshot({ formatVersion: 1, state: "absent", sourceRoot: identity, targetRoot: identity }),
    { formatVersion: 1, state: "absent", sourceRoot: identity, targetRoot: identity });
  for (const invalid of [undefined, {}, { formatVersion: 1, state: "pending", other: true },
    { formatVersion: 1, state: "absent", sourceRoot: { dev: 0, ino: 90071992547409931 }, targetRoot: identity },
    { formatVersion: 1, state: "absent", sourceRoot: { dev: "0", ino: "0" }, targetRoot: identity }]) {
    assert.throws(() => validateWorkspaceDbSnapshot(invalid));
  }
});

test("D18 原 operation pending 证据不授权路径提交且旧 null 仍可提交", () => {
  const ctx = setup();
  try {
    let operation = advanceToTargetReady(ctx, {});
    assert.equal(operation.workspaceDbSnapshot, null);
    ctx.db.prepare("UPDATE workspace_directory_migrations SET workspace_db_snapshot_json = ? WHERE operation_id = ?").run(
      JSON.stringify({ formatVersion: 1, state: "pending" }), operation.operationId);
    operation = ctx.repo.require(operation.operationId);
    assert.throws(() => ctx.repo.commitPath({ operationId: operation.operationId, expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion, terminalCwdTargets: {}, now: 10_000 }), { code: "WORKSPACE_MIGRATION_STATE_CONFLICT" });
    assert.equal(new WorkspaceRepo(ctx.db).get(ctx.workspaceIds[0])?.path, "C:\\work\\ws-1");
  } finally { ctx.close(); }
});

test("D18 交接证据只允许 target_ready pending 同 owner CAS 一次，不能被状态 patch 改写", () => {
  const ctx = setup();
  try {
    let operation = advanceToTargetReady(ctx, {});
    ctx.db.prepare("UPDATE workspace_directory_migrations SET workspace_db_snapshot_json = ? WHERE operation_id = ?").run(JSON.stringify({ formatVersion: 1, state: "pending" }), operation.operationId);
    const absent = { formatVersion: 1 as const, state: "absent" as const, sourceRoot: { dev: "0", ino: "90071992547409931" }, targetRoot: { dev: "0", ino: "90071992547409932" } };
    assert.throws(() => ctx.repo.updateCurrentState({ operationId: operation.operationId, expectedState: "target_ready", expectedStateVersion: operation.stateVersion - 1, patch: { workspaceDbSnapshot: absent }, now: 10_000 }));
    assert.equal(ctx.repo.require(operation.operationId).workspaceDbSnapshot?.state, "pending");
    assert.throws(() => ctx.repo.transitionState({ operationId: operation.operationId, expectedState: "target_ready", expectedStateVersion: operation.stateVersion, nextState: "recovery_required", patch: { workspaceDbSnapshot: absent }, now: 10_000 }));
    operation = ctx.repo.updateCurrentState({ operationId: operation.operationId, expectedState: "target_ready", expectedStateVersion: operation.stateVersion, patch: { workspaceDbSnapshot: absent }, now: 10_000 });
    assert.deepEqual(operation.workspaceDbSnapshot, absent);
    assert.throws(() => ctx.repo.updateCurrentState({ operationId: operation.operationId, expectedState: "target_ready", expectedStateVersion: operation.stateVersion, patch: { workspaceDbSnapshot: { formatVersion: 1, state: "pending" } }, now: 10_001 }));
    const committed = ctx.repo.commitPath({ operationId: operation.operationId, expectedState: "target_ready", expectedStateVersion: operation.stateVersion, terminalCwdTargets: {}, now: 10_002 });
    assert.equal(committed.state, "path_committed");
    assert.deepEqual(committed.workspaceDbSnapshot, absent);
  } finally { ctx.close(); }
});

/** 创建带两个本地工作区的临时 Client DB。 */
function setup(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-workspace-migration-repo-"));
  const db = openSqliteDb(path.join(root, "client.db"));
  migrateClientDb(db);
  const workspaces = new WorkspaceRepo(db);
  const workspaceIds: [WorkspaceId, WorkspaceId] = ["client:ws-1", "client:ws-2"];
  workspaces.upsert({ id: workspaceIds[0], title: "ws-1", path: "C:\\work\\ws-1" });
  workspaces.upsert({ id: workspaceIds[1], title: "ws-2", path: "C:\\work\\ws-2" });
  return {
    db,
    repo: new WorkspaceDirectoryMigrationRepo(db),
    workspaceIds,
    close: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 按 accepted 主路径推进到 target_ready，并在 preparing 阶段固化终端快照。 */
function advanceToTargetReady(
  ctx: TestContext,
  terminalCwdSnapshot: Record<string, string | null>,
  key = "idem-1",
): WorkspaceDirectoryMigrationRecord {
  let operation = createOperation(ctx, { key });
  operation = ctx.repo.transitionState({
    operationId: operation.operationId,
    expectedState: "scanning",
    expectedStateVersion: operation.stateVersion,
    nextState: "awaiting_confirmation",
    now: 2_000,
  });
  operation = ctx.repo.prepareStartAttempt({
    operationId: operation.operationId,
    startAttemptId: "attempt",
    externalWritesPausedConfirmed: true,
    targetNotSyncManagedConfirmed: true,
    now: 3_000,
  });
  operation = ctx.repo.acceptStartAttempt({
    operationId: operation.operationId,
    startAttemptId: "attempt",
    expectedStateVersion: operation.stateVersion,
    now: 4_000,
  });
  operation = ctx.repo.transitionState({
    operationId: operation.operationId,
    expectedState: "preparing",
    expectedStateVersion: operation.stateVersion,
    nextState: "copying",
    patch: { terminalCwdSnapshot },
    now: 5_000,
  });
  for (const nextState of ["verifying", "publish_intent", "target_ready"] as const) {
    operation = ctx.repo.transitionState({
      operationId: operation.operationId,
      expectedState: operation.state,
      expectedStateVersion: operation.stateVersion,
      nextState,
      now: operation.updatedAt + 1,
    });
  }
  return operation;
}

/** 创建固定路径参数的迁移操作，便于测试状态机。 */
function createOperation(
  ctx: TestContext,
  input?: { workspaceId?: WorkspaceId; key?: string; operationId?: string; now?: number },
): WorkspaceDirectoryMigrationRecord {
  return ctx.repo.create({
    operationId: input?.operationId,
    idempotencyKey: input?.key ?? "idem-1",
    workspaceId: input?.workspaceId ?? ctx.workspaceIds[0],
    sourcePath: input?.workspaceId === ctx.workspaceIds[1] ? "C:\\work\\ws-2" : "C:\\work\\ws-1",
    targetParentPath: "D:\\projects",
    targetPath: input?.workspaceId === ctx.workspaceIds[1] ? "D:\\projects\\ws-2" : "D:\\projects\\ws-1",
    now: input?.now ?? 1_000,
  }).operation;
}

/** 断言仓储抛出指定稳定业务错误码。 */
function hasCode(code: WorkspaceDirectoryMigrationRepoError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof WorkspaceDirectoryMigrationRepoError && error.code === code;
}

test("目录迁移创建按参数幂等，并在全 Client 未终态时拒绝第二个操作", () => {
  const ctx = setup();
  try {
    const first = createOperation(ctx);
    const replay = ctx.repo.create({
      idempotencyKey: "idem-1",
      workspaceId: ctx.workspaceIds[0],
      sourcePath: "C:\\work\\ws-1",
      targetParentPath: "D:\\projects",
      targetPath: "D:\\projects\\ws-1",
      now: 2_000,
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.operation.operationId, first.operationId);
    assert.throws(
      () => ctx.repo.create({
        idempotencyKey: "idem-1",
        workspaceId: ctx.workspaceIds[0],
        sourcePath: "C:\\work\\ws-1",
        targetParentPath: "E:\\other",
        targetPath: "E:\\other\\ws-1",
        now: 2_001,
      }),
      hasCode("WORKSPACE_MIGRATION_IDEMPOTENCY_CONFLICT"),
    );
    assert.throws(
      () => createOperation(ctx, { workspaceId: ctx.workspaceIds[1], key: "idem-2", now: 2_002 }),
      hasCode("WORKSPACE_MIGRATION_BUSY"),
    );

    ctx.repo.transitionState({
      operationId: first.operationId,
      expectedState: "scanning",
      expectedStateVersion: first.stateVersion,
      nextState: "failed",
      patch: { errorCode: "WORKSPACE_MIGRATION_TARGET_INVALID", errorMessage: "invalid target" },
      now: 3_000,
    });
    const second = createOperation(ctx, { workspaceId: ctx.workspaceIds[1], key: "idem-2", now: 3_001 });
    assert.equal(second.workspaceId, ctx.workspaceIds[1]);
  } finally {
    ctx.close();
  }
});

test("目录迁移状态转换使用合法边和 stateVersion CAS", () => {
  const ctx = setup();
  try {
    const scanning = createOperation(ctx);
    const awaiting = ctx.repo.transitionState({
      operationId: scanning.operationId,
      expectedState: "scanning",
      expectedStateVersion: scanning.stateVersion,
      nextState: "awaiting_confirmation",
      patch: {
        sourceFileCount: 3,
        sourceDirectoryCount: 2,
        sourceTotalBytes: 1_024,
        excludedDependencyDirectoryCount: 6,
        excludedDependencyDirectories: [
          "node_modules",
          "service/target",
          "desktop/build",
          "dotnet/bin",
          "dotnet/obj",
          "native/cmake-build-debug",
        ],
        sourceManifestHash: "a".repeat(64),
      },
      now: 2_000,
    });
    assert.equal(awaiting.stateVersion, 2);
    assert.equal(awaiting.sourceFileCount, 3);
    assert.equal(awaiting.excludedDependencyDirectoryCount, 6);
    assert.deepEqual(awaiting.excludedDependencyDirectories, [
      "node_modules",
      "service/target",
      "desktop/build",
      "dotnet/bin",
      "dotnet/obj",
      "native/cmake-build-debug",
    ]);
    assert.throws(
      () => ctx.repo.updateCurrentState({
        operationId: awaiting.operationId,
        expectedState: "awaiting_confirmation",
        expectedStateVersion: awaiting.stateVersion,
        patch: { excludedDependencyDirectories: ["apps/docs/../node_modules"] },
        now: 2_001,
      }),
      /目录迁移排除路径无效/u,
    );
    assert.throws(
      () => ctx.repo.updateCurrentState({
        operationId: awaiting.operationId,
        expectedState: "awaiting_confirmation",
        expectedStateVersion: awaiting.stateVersion,
        patch: {
          excludedDependencyDirectoryCount: 1,
          excludedDependencyDirectories: ["apps/docs/cache"],
        },
        now: 2_001,
      }),
      /目录迁移排除路径无效/u,
    );
    assert.throws(
      () => ctx.repo.updateCurrentState({
        operationId: awaiting.operationId,
        expectedState: "awaiting_confirmation",
        expectedStateVersion: awaiting.stateVersion,
        patch: {
          excludedDependencyDirectoryCount: 2,
          excludedDependencyDirectories: ["node_modules"],
        },
        now: 2_001,
      }),
      /目录迁移排除数量和路径列表不一致/u,
    );
    assert.equal(ctx.repo.require(awaiting.operationId).stateVersion, awaiting.stateVersion);
    assert.throws(
      () => ctx.repo.transitionState({
        operationId: awaiting.operationId,
        expectedState: "awaiting_confirmation",
        expectedStateVersion: awaiting.stateVersion,
        nextState: "copying",
        now: 2_001,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );
    assert.throws(
      () => ctx.repo.transitionState({
        operationId: awaiting.operationId,
        expectedState: "awaiting_confirmation",
        expectedStateVersion: awaiting.stateVersion,
        nextState: "preparing",
        now: 2_001,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );
    assert.throws(
      () => ctx.repo.updateCurrentState({
        operationId: awaiting.operationId,
        expectedState: "awaiting_confirmation",
        expectedStateVersion: 1,
        patch: { copiedFiles: 1 },
        now: 2_002,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );
  } finally {
    ctx.close();
  }
});

test("start attempt 只有 prepared 可 accepted 或 fenced，迟到 execute 被拒绝", () => {
  const ctx = setup();
  try {
    const scanning = createOperation(ctx);
    const awaiting = ctx.repo.transitionState({
      operationId: scanning.operationId,
      expectedState: "scanning",
      expectedStateVersion: scanning.stateVersion,
      nextState: "awaiting_confirmation",
      now: 2_000,
    });
    assert.throws(
      () => ctx.repo.prepareStartAttempt({
        operationId: awaiting.operationId,
        startAttemptId: "attempt-unconfirmed",
        externalWritesPausedConfirmed: false,
        targetNotSyncManagedConfirmed: true,
        now: 2_500,
      }),
      hasCode("WORKSPACE_MIGRATION_EXTERNAL_WRITES_UNCONFIRMED"),
    );
    const prepared = ctx.repo.prepareStartAttempt({
      operationId: awaiting.operationId,
      startAttemptId: "attempt-1",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 3_000,
    });
    assert.equal(prepared.startDisposition, "prepared");
    assert.equal(prepared.externalWritesConfirmedAt, 3_000);
    assert.equal(ctx.repo.prepareStartAttempt({
      operationId: awaiting.operationId,
      startAttemptId: "attempt-1",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 3_001,
    }).stateVersion, prepared.stateVersion);
    assert.throws(
      () => ctx.repo.prepareStartAttempt({
        operationId: awaiting.operationId,
        startAttemptId: "attempt-2",
        externalWritesPausedConfirmed: true,
        targetNotSyncManagedConfirmed: true,
        now: 3_002,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );

    const fenced = ctx.repo.fenceStartAttempt({
      operationId: prepared.operationId,
      startAttemptId: "attempt-1",
      expectedStateVersion: prepared.stateVersion,
      now: 4_000,
    });
    assert.equal(fenced.startDisposition, "fenced");
    assert.throws(
      () => ctx.repo.acceptStartAttempt({
        operationId: fenced.operationId,
        startAttemptId: "attempt-1",
        expectedStateVersion: fenced.stateVersion,
        now: 4_001,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );

    const preparedAgain = ctx.repo.prepareStartAttempt({
      operationId: fenced.operationId,
      startAttemptId: "attempt-2",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 5_000,
    });
    const accepted = ctx.repo.acceptStartAttempt({
      operationId: preparedAgain.operationId,
      startAttemptId: "attempt-2",
      expectedStateVersion: preparedAgain.stateVersion,
      now: 6_000,
    });
    assert.equal(accepted.state, "preparing");
    assert.equal(accepted.startDisposition, "accepted");
    assert.equal(ctx.repo.prepareStartAttempt({
      operationId: accepted.operationId,
      startAttemptId: "attempt-3",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 6_001,
    }).startAttemptId, "attempt-2");
    const failed = ctx.repo.transitionState({
      operationId: accepted.operationId,
      expectedState: "preparing",
      expectedStateVersion: accepted.stateVersion,
      nextState: "failed",
      patch: { errorCode: "WORKSPACE_MIGRATION_INTERRUPTED", errorMessage: "interrupted" },
      now: 7_000,
    });
    assert.throws(
      () => ctx.repo.prepareStartAttempt({
        operationId: failed.operationId,
        startAttemptId: "attempt-late",
        externalWritesPausedConfirmed: true,
        targetNotSyncManagedConfirmed: true,
        now: 7_001,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );
  } finally {
    ctx.close();
  }
});

test("Client 重启会原子生成 fenced cancelled tombstone，ACK 后清除", () => {
  const ctx = setup();
  try {
    const scanning = createOperation(ctx);
    const awaiting = ctx.repo.transitionState({
      operationId: scanning.operationId,
      expectedState: "scanning",
      expectedStateVersion: scanning.stateVersion,
      nextState: "awaiting_confirmation",
      now: 2_000,
    });
    const prepared = ctx.repo.prepareStartAttempt({
      operationId: awaiting.operationId,
      startAttemptId: "attempt-restart",
      externalWritesPausedConfirmed: true,
      targetNotSyncManagedConfirmed: true,
      now: 3_000,
    });
    assert.throws(
      () => ctx.repo.transitionState({
        operationId: prepared.operationId,
        expectedState: "awaiting_confirmation",
        expectedStateVersion: prepared.stateVersion,
        nextState: "cancelled",
        now: 3_500,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );
    const cancelled = ctx.repo.fencePreparedAttemptAndCancel({
      operationId: prepared.operationId,
      startAttemptId: "attempt-restart",
      expectedStateVersion: prepared.stateVersion,
      cancellationReason: "client_restarted_before_start",
      now: 4_000,
    });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.startFenceAckPending, true);
    assert.equal(cancelled.cancellationReason, "client_restarted_before_start");
    assert.deepEqual(ctx.repo.listStartFenceTombstones().map((item) => item.operationId), [cancelled.operationId]);
    const oldAck = ctx.repo.acknowledgeStartFence(
      cancelled.operationId,
      "attempt-restart",
      cancelled.stateVersion - 1,
      4_500,
    );
    assert.equal(oldAck.startFenceAckPending, true);
    const acknowledged = ctx.repo.acknowledgeStartFence(
      cancelled.operationId,
      "attempt-restart",
      cancelled.stateVersion,
      5_000,
    );
    assert.equal(acknowledged.startFenceAckPending, false);
    assert.equal(ctx.repo.acknowledgeStartFence(
      cancelled.operationId,
      "attempt-restart",
      cancelled.stateVersion,
      5_001,
    ).startFenceAckPending, false);
    assert.deepEqual(ctx.repo.listStartFenceTombstones(), []);
  } finally {
    ctx.close();
  }
});

test("completed 索引 pending/failed 阻断下一次迁移，ready 后解除", () => {
  const ctx = setup();
  try {
    ctx.db.prepare(`
      INSERT INTO terminal_configs (id, workspace_id, label, shell, cwd, sort_order, created_at, updated_at)
      VALUES ('terminal-1', ?, 'Terminal', NULL, 'C:\\work\\ws-1\\src', 0, 1, 1)
    `).run(String(ctx.workspaceIds[0]));
    let operation = advanceToTargetReady(ctx, { "terminal-1": "C:\\work\\ws-1\\src" });
    assert.throws(
      () => ctx.repo.transitionState({
        operationId: operation.operationId,
        expectedState: "target_ready",
        expectedStateVersion: operation.stateVersion,
        nextState: "path_committed",
        now: operation.updatedAt + 1,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );
    operation = ctx.repo.commitPath({
      operationId: operation.operationId,
      expectedState: "target_ready",
      expectedStateVersion: operation.stateVersion,
      terminalCwdTargets: { "terminal-1": "D:\\projects\\ws-1\\src" },
      now: operation.updatedAt + 1,
    });
    assert.equal((ctx.db.prepare("SELECT path FROM workspaces WHERE id = ?").get(String(ctx.workspaceIds[0])) as { path: string }).path, "D:\\projects\\ws-1");
    assert.equal((ctx.db.prepare("SELECT cwd FROM terminal_configs WHERE id = 'terminal-1'").get() as { cwd: string }).cwd, "D:\\projects\\ws-1\\src");
    operation = ctx.repo.transitionState({
      operationId: operation.operationId,
      expectedState: "path_committed",
      expectedStateVersion: operation.stateVersion,
      nextState: "finalizing",
      now: operation.updatedAt + 1,
    });
    assert.throws(
      () => ctx.repo.transitionState({
        operationId: operation.operationId,
        expectedState: "finalizing",
        expectedStateVersion: operation.stateVersion,
        nextState: "completed",
        now: operation.updatedAt + 1,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );
    operation = ctx.repo.setIndexRebuildPending({
      operationId: operation.operationId,
      expectedState: "finalizing",
      expectedStateVersion: operation.stateVersion,
      generation: 7,
      phase: "queued",
      lastProgressAt: operation.updatedAt + 1,
      now: operation.updatedAt + 1,
    });
    operation = ctx.repo.transitionState({
      operationId: operation.operationId,
      expectedState: "finalizing",
      expectedStateVersion: operation.stateVersion,
      nextState: "completed",
      now: operation.updatedAt + 1,
    });
    assert.equal(operation.notificationPending, true);
    assert.equal(ctx.repo.acknowledgeNotification(
      operation.operationId,
      operation.stateVersion - 1,
      operation.updatedAt + 1,
    ).notificationPending, true);
    operation = ctx.repo.acknowledgeNotification(operation.operationId, operation.stateVersion, operation.updatedAt + 2);
    assert.equal(ctx.repo.acknowledgeNotification(
      operation.operationId,
      operation.stateVersion,
      operation.updatedAt + 3,
    ).notificationPending, false);
    assert.throws(
      () => createOperation(ctx, { key: "idem-next", now: operation.updatedAt + 3 }),
      hasCode("WORKSPACE_MIGRATION_INDEX_NOT_READY"),
    );
    operation = ctx.repo.setIndexRebuildPending({
      operationId: operation.operationId,
      expectedState: "completed",
      expectedStateVersion: operation.stateVersion,
      generation: 8,
      phase: "queued",
      lastProgressAt: operation.updatedAt + 5,
      now: operation.updatedAt + 5,
    });
    const pendingVersion = operation.stateVersion;
    const touched = ctx.repo.touchIndexRebuildProgress({
      operationId: operation.operationId,
      expectedGeneration: 8,
      phase: "building",
      lastProgressAt: operation.updatedAt + 6,
      now: operation.updatedAt + 6,
    });
    assert.equal(touched.applied, true);
    assert.equal(touched.operation.stateVersion, pendingVersion);
    assert.equal(touched.operation.indexRebuildPhase, "building");
    assert.equal(touched.operation.indexRebuildLastProgressAt, operation.updatedAt + 6);
    const staleTouch = ctx.repo.touchIndexRebuildProgress({
      operationId: operation.operationId,
      expectedGeneration: 7,
      phase: "building",
      lastProgressAt: operation.updatedAt + 7,
      now: operation.updatedAt + 7,
    });
    assert.equal(staleTouch.applied, false);
    operation = staleTouch.operation;
    const stale = ctx.repo.completeIndexRebuild({
      operationId: operation.operationId,
      expectedStateVersion: operation.stateVersion,
      expectedGeneration: 7,
      status: "ready",
      now: operation.updatedAt + 6,
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.operation.indexRebuildGeneration, 8);
    const completedIndex = ctx.repo.completeIndexRebuild({
      operationId: operation.operationId,
      expectedStateVersion: operation.stateVersion,
      expectedGeneration: 8,
      status: "ready",
      now: operation.updatedAt + 7,
    });
    assert.equal(completedIndex.applied, true);
    operation = completedIndex.operation;
    assert.equal(operation.indexRebuildStatus, "ready");
    assert.equal(createOperation(ctx, { key: "idem-next", now: operation.updatedAt + 5 }).state, "scanning");
  } finally {
    ctx.close();
  }
});

test("path_committed 事务在终端快照冲突时回滚 workspace path 和状态", () => {
  const ctx = setup();
  try {
    ctx.db.prepare(`
      INSERT INTO terminal_configs (id, workspace_id, label, shell, cwd, sort_order, created_at, updated_at)
      VALUES ('terminal-conflict', ?, 'Terminal', NULL, 'C:\\work\\ws-1\\actual', 0, 1, 1)
    `).run(String(ctx.workspaceIds[0]));
    const targetReady = advanceToTargetReady(ctx, { "terminal-conflict": "C:\\work\\ws-1\\stale" });
    assert.throws(
      () => ctx.repo.commitPath({
        operationId: targetReady.operationId,
        expectedState: "target_ready",
        expectedStateVersion: targetReady.stateVersion,
        terminalCwdTargets: { "terminal-conflict": "D:\\projects\\ws-1\\stale" },
        now: targetReady.updatedAt + 1,
      }),
      hasCode("WORKSPACE_MIGRATION_STATE_CONFLICT"),
    );
    assert.equal((ctx.db.prepare("SELECT path FROM workspaces WHERE id = ?").get(String(ctx.workspaceIds[0])) as { path: string }).path, "C:\\work\\ws-1");
    assert.equal(ctx.repo.require(targetReady.operationId).state, "target_ready");
    assert.equal((ctx.db.prepare("SELECT cwd FROM terminal_configs WHERE id = 'terminal-conflict'").get() as { cwd: string }).cwd, "C:\\work\\ws-1\\actual");
  } finally {
    ctx.close();
  }
});

test("定时任务迁移延期时间损坏时显式失败", () => {
  const ctx = setup();
  try {
    ctx.db.prepare(`
      INSERT INTO scheduled_task_runtime_states (
        task_id, client_id, device_id, queued_scheduled_at, updated_at
      ) VALUES ('task-bad', 'client-1', 'device-1', 'invalid', 1)
    `).run();
    const scheduledTasks = new ScheduledTaskRuntimeStateRepo(ctx.db);
    assert.throws(() => scheduledTasks.get("task-bad"), /时间字段损坏/);
  } finally {
    ctx.close();
  }
});
