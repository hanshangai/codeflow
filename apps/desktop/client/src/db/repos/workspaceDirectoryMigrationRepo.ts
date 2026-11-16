import crypto from "node:crypto";

import {
  WORKSPACE_DIRECTORY_MIGRATION_ERROR_CODES,
  WORKSPACE_DIRECTORY_MIGRATION_STATES,
  canTransitionWorkspaceDirectoryMigrationState,
  isWorkspaceDirectoryMigrationTerminalState,
  type WorkspaceDirectoryMigrationErrorCode,
  type WorkspaceDirectoryMigrationIndexRebuildPhase,
  type WorkspaceDirectoryMigrationIndexRebuildStatus,
  type WorkspaceDirectoryMigrationStartDisposition,
  type WorkspaceDirectoryMigrationState,
  type WorkspaceDirectoryMigrationWarningCode,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import { isSupportedRegenerableDirectoryRelativePath } from "../../workspace-migration/workspaceMigrationRegenerableDirectories.js";

export type WorkspaceDbFileIdentity = { dev: string; ino: string };
export type WorkspaceDbSnapshotFile = WorkspaceDbFileIdentity & { size: number; hash: string; mtimeNs: string; ctimeNs: string };
export type WorkspaceDbSnapshotEvidence =
  | { formatVersion: 1; state: "pending" }
  | { formatVersion: 1; state: "absent"; sourceRoot: WorkspaceDbFileIdentity; targetRoot: WorkspaceDbFileIdentity }
  | { formatVersion: 1; state: "ready"; sourceRoot: WorkspaceDbFileIdentity; targetRoot: WorkspaceDbFileIdentity;
      source: WorkspaceDbSnapshotFile; target: WorkspaceDbSnapshotFile; applicationId: number; schemaVersion: number };

export type WorkspaceDirectoryMigrationRecord = {
  operationId: string;
  idempotencyKey: string;
  workspaceId: WorkspaceId;
  sourcePath: string;
  targetParentPath: string;
  targetPath: string;
  stagingPath: string | null;
  state: WorkspaceDirectoryMigrationState;
  sourceFileCount: number;
  sourceDirectoryCount: number;
  sourceTotalBytes: number;
  excludedDependencyDirectoryCount: number;
  excludedDependencyDirectories: string[];
  copiedFiles: number;
  copiedBytes: number;
  sourceManifestHash: string | null;
  verifiedTargetManifestHash: string | null;
  workspaceDbSnapshot: WorkspaceDbSnapshotEvidence | null;
  terminalCwdSnapshot: Record<string, string | null> | null;
  externalWritesConfirmedAt: number | null;
  targetStorageConfirmedAt: number | null;
  startAttemptId: string | null;
  startDisposition: WorkspaceDirectoryMigrationStartDisposition | null;
  startDecidedAt: number | null;
  startFenceAckPending: boolean;
  indexRebuildGeneration: number | null;
  indexRebuildStatus: WorkspaceDirectoryMigrationIndexRebuildStatus;
  indexRebuildPhase: WorkspaceDirectoryMigrationIndexRebuildPhase | null;
  indexRebuildLastProgressAt: number | null;
  stateVersion: number;
  notificationPending: boolean;
  notificationStateVersion: number | null;
  errorCode: WorkspaceDirectoryMigrationErrorCode | null;
  errorMessage: string | null;
  errorDetails: unknown | null;
  warningCode: WorkspaceDirectoryMigrationWarningCode | null;
  warningDetails: unknown | null;
  cancellationReason: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type CreateWorkspaceDirectoryMigrationInput = {
  operationId?: string;
  idempotencyKey: string;
  workspaceId: WorkspaceId;
  sourcePath: string;
  targetParentPath: string;
  targetPath: string;
  now: number;
  workspaceDbSnapshot?: Extract<WorkspaceDbSnapshotEvidence, { state: "pending" }>;
};

export type WorkspaceDirectoryMigrationStatePatch = Partial<Pick<
  WorkspaceDirectoryMigrationRecord,
  | "stagingPath"
  | "sourceFileCount"
  | "sourceDirectoryCount"
  | "sourceTotalBytes"
  | "excludedDependencyDirectoryCount"
  | "excludedDependencyDirectories"
  | "copiedFiles"
  | "copiedBytes"
  | "sourceManifestHash"
  | "verifiedTargetManifestHash"
  | "workspaceDbSnapshot"
  | "terminalCwdSnapshot"
  | "errorCode"
  | "errorMessage"
  | "errorDetails"
  | "warningCode"
  | "warningDetails"
  | "cancellationReason"
>>;

type MigrationRow = Record<string, unknown>;

/** 携带稳定业务错误码的本地迁移仓储异常。 */
export class WorkspaceDirectoryMigrationRepoError extends Error {
  constructor(
    public readonly code: WorkspaceDirectoryMigrationErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkspaceDirectoryMigrationRepoError";
  }
}

/** 工作区目录迁移本地事实源：负责幂等创建、状态 CAS 和 start attempt fencing。 */
export class WorkspaceDirectoryMigrationRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 幂等创建 scanning 操作；同键不同身份、索引阻断和全 Client 忙均显式失败。 */
  create(input: CreateWorkspaceDirectoryMigrationInput): {
    operation: WorkspaceDirectoryMigrationRecord;
    idempotent: boolean;
  } {
    const normalized = normalizeCreateInput(input);
    return this.db.transaction(() => {
      const existing = this.getByIdempotencyKey(normalized.idempotencyKey);
      if (existing) {
        assertSameCreateIdentity(existing, normalized);
        return { operation: existing, idempotent: true };
      }

      const blockingIndex = this.getLatestCompletedWithBlockingIndex(normalized.workspaceId);
      if (blockingIndex) {
        throw new WorkspaceDirectoryMigrationRepoError(
          "WORKSPACE_MIGRATION_INDEX_NOT_READY",
          `上次目录迁移的索引尚未就绪：operationId=${blockingIndex.operationId}`,
          {
            operationId: blockingIndex.operationId,
            generation: blockingIndex.indexRebuildGeneration,
            status: blockingIndex.indexRebuildStatus,
            warningCode: blockingIndex.warningCode,
          },
        );
      }

      const active = this.listActive()[0];
      if (active) {
        throw new WorkspaceDirectoryMigrationRepoError(
          "WORKSPACE_MIGRATION_BUSY",
          `Client 已有未终态目录迁移：operationId=${active.operationId}`,
          { operationId: active.operationId, workspaceId: active.workspaceId, state: active.state },
        );
      }

      const operationId = normalized.operationId || `wdm_${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO workspace_directory_migrations (
          operation_id, idempotency_key, workspace_id, source_path, target_parent_path,
          target_path, workspace_db_snapshot_json, state, state_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scanning', 1, ?, ?)
      `).run(
        operationId,
        normalized.idempotencyKey,
        String(normalized.workspaceId),
        normalized.sourcePath,
        normalized.targetParentPath,
        normalized.targetPath,
        encodeJson(normalized.workspaceDbSnapshot ?? null, "workspaceDbSnapshot"),
        normalized.now,
        normalized.now,
      );
      return { operation: this.require(operationId), idempotent: false };
    })();
  }

  /** 按 operationId 读取迁移事实。 */
  get(operationId: string): WorkspaceDirectoryMigrationRecord | null {
    const row = this.db.prepare("SELECT * FROM workspace_directory_migrations WHERE operation_id = ?")
      .get(normalizeRequiredText(operationId, "operationId")) as MigrationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** 按幂等键读取既有操作。 */
  getByIdempotencyKey(idempotencyKey: string): WorkspaceDirectoryMigrationRecord | null {
    const row = this.db.prepare("SELECT * FROM workspace_directory_migrations WHERE idempotency_key = ?")
      .get(normalizeRequiredText(idempotencyKey, "idempotencyKey")) as MigrationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** 读取操作；不存在时返回稳定的业务错误。 */
  require(operationId: string): WorkspaceDirectoryMigrationRecord {
    const operation = this.get(operationId);
    if (operation) return operation;
    throw new WorkspaceDirectoryMigrationRepoError(
      "WORKSPACE_MIGRATION_NOT_FOUND",
      `目录迁移操作不存在：operationId=${operationId}`,
      { operationId },
    );
  }

  /** 列出 Client 启动恢复和激活快照所需的全部未终态操作。 */
  listActive(): WorkspaceDirectoryMigrationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_directory_migrations
       WHERE state NOT IN ('completed', 'cancelled', 'failed')
       ORDER BY created_at ASC
    `).all() as MigrationRow[];
    return rows.map(rowToRecord);
  }

  /** 列出 Server 尚未确认的 fenced 终态 tombstone。 */
  listStartFenceTombstones(): WorkspaceDirectoryMigrationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_directory_migrations
       WHERE start_disposition = 'fenced'
         AND start_fence_ack_pending = 1
         AND state IN ('cancelled', 'failed')
       ORDER BY updated_at ASC
    `).all() as MigrationRow[];
    return rows.map(rowToRecord);
  }

  /** 列出 completed 后仍需投影的索引 pending/failed 状态。 */
  listDirectoryMigrationIndexStates(): WorkspaceDirectoryMigrationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_directory_migrations
       WHERE state = 'completed' AND index_rebuild_status IN ('pending', 'failed')
       ORDER BY updated_at ASC
    `).all() as MigrationRow[];
    return rows.map(rowToRecord);
  }

  /** 列出 completed 后仍等待 Server ACK 的通知版本，供重连补发。 */
  listNotificationPending(): WorkspaceDirectoryMigrationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_directory_migrations
       WHERE notification_pending = 1
       ORDER BY updated_at ASC
    `).all() as MigrationRow[];
    return rows.map(rowToRecord);
  }

  /** 以 expected state/version 执行唯一状态机转换，并原子递增 stateVersion。 */
  transitionState(input: {
    operationId: string;
    expectedState: WorkspaceDirectoryMigrationState;
    expectedStateVersion: number;
    nextState: WorkspaceDirectoryMigrationState;
    patch?: WorkspaceDirectoryMigrationStatePatch;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    const current = this.require(input.operationId);
    if (current.state !== input.expectedState || current.stateVersion !== input.expectedStateVersion) {
      throw stateConflict(input.operationId, current.state, input.nextState);
    }
    if (!canTransitionWorkspaceDirectoryMigrationState(input.expectedState, input.nextState)) {
      throw stateConflict(input.operationId, input.expectedState, input.nextState);
    }
    if (input.expectedState === "awaiting_confirmation" && input.nextState === "preparing") {
      throw new WorkspaceDirectoryMigrationRepoError(
        "WORKSPACE_MIGRATION_STATE_CONFLICT",
        `目录迁移必须通过 accepted start attempt 进入 preparing：operationId=${input.operationId}`,
        { operationId: input.operationId },
      );
    }
    if (input.nextState === "path_committed") {
      throw new WorkspaceDirectoryMigrationRepoError(
        "WORKSPACE_MIGRATION_STATE_CONFLICT",
        `目录迁移必须通过路径提交事务进入 path_committed：operationId=${input.operationId}`,
        { operationId: input.operationId },
      );
    }
    if (
      input.expectedState === "awaiting_confirmation"
      && input.nextState === "cancelled"
      && current.startDisposition === "prepared"
    ) {
      throw new WorkspaceDirectoryMigrationRepoError(
        "WORKSPACE_MIGRATION_STATE_CONFLICT",
        `prepared start attempt 必须先 fence 再取消：operationId=${input.operationId}`,
        { operationId: input.operationId, startAttemptId: current.startAttemptId },
      );
    }
    if (input.nextState === "completed") {
      assertCompletionIndexReady(current);
    }
    if (input.patch && Object.prototype.hasOwnProperty.call(input.patch, "workspaceDbSnapshot")) {
      throw stateConflict(input.operationId, current.state, input.nextState);
    }
    const nextVersion = input.expectedStateVersion + 1;
    const updates = compilePatch(input.patch ?? {});
    updates.columns.push("state = ?", "state_version = ?", "updated_at = ?");
    updates.values.push(input.nextState, nextVersion, input.now);
    if (isWorkspaceDirectoryMigrationTerminalState(input.nextState)) {
      updates.columns.push("completed_at = ?");
      updates.values.push(input.now);
    }
    if (input.nextState === "completed") {
      updates.columns.push("notification_pending = 1", "notification_state_version = ?");
      updates.values.push(nextVersion);
    }
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET ${updates.columns.join(", ")}
       WHERE operation_id = ? AND state = ? AND state_version = ?
    `).run(...updates.values, input.operationId, input.expectedState, input.expectedStateVersion);
    assertSingleChange(changed.changes, input.operationId, "迁移状态转换");
    return this.require(input.operationId);
  }

  /** 在同一 SQLite 事务提交 workspace path、终端 cwd 和 path_committed 状态。 */
  commitPath(input: {
    operationId: string;
    expectedState: Extract<WorkspaceDirectoryMigrationState, "target_ready" | "recovery_required">;
    expectedStateVersion: number;
    terminalCwdTargets: Record<string, string | null>;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    const current = this.require(input.operationId);
    if (
      current.state !== input.expectedState
      || current.stateVersion !== input.expectedStateVersion
      || !canTransitionWorkspaceDirectoryMigrationState(current.state, "path_committed")
      || current.startDisposition !== "accepted"
    ) {
      throw stateConflict(input.operationId, current.state, "path_committed");
    }
    const terminalCwdSnapshot = current.terminalCwdSnapshot;
    if (current.workspaceDbSnapshot?.state === "pending") throw stateConflict(input.operationId, current.state, "path_committed");
    if (terminalCwdSnapshot === null) {
      throw new WorkspaceDirectoryMigrationRepoError(
        "WORKSPACE_MIGRATION_STATE_CONFLICT",
        `路径提交缺少终端 cwd 快照：operationId=${input.operationId}`,
        { operationId: input.operationId },
      );
    }
    assertTerminalTargetKeys(terminalCwdSnapshot, input.terminalCwdTargets, input.operationId);

    return this.db.transaction(() => {
      const workspaceChanged = this.db.prepare(`
        UPDATE workspaces SET path = ?, updated_at = ?
         WHERE id = ? AND path = ? AND is_deleted = 0
      `).run(current.targetPath, input.now, String(current.workspaceId), current.sourcePath);
      assertSingleChange(workspaceChanged.changes, input.operationId, "提交 workspace path");

      const persistedTerminals = this.db.prepare(`
        SELECT id, cwd FROM terminal_configs WHERE workspace_id = ? ORDER BY id
      `).all(String(current.workspaceId)) as Array<{ id?: string | null; cwd?: string | null }>;
      assertTerminalSnapshotMatches(terminalCwdSnapshot, persistedTerminals, input.operationId);
      const updateTerminal = this.db.prepare(`
        UPDATE terminal_configs SET cwd = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND cwd IS ?
      `);
      for (const [terminalId, originalCwd] of Object.entries(terminalCwdSnapshot)) {
        const changed = updateTerminal.run(
          input.terminalCwdTargets[terminalId] ?? null,
          input.now,
          terminalId,
          String(current.workspaceId),
          originalCwd,
        );
        assertSingleChange(changed.changes, input.operationId, `提交终端 cwd:${terminalId}`);
      }

      const operationChanged = this.db.prepare(`
        UPDATE workspace_directory_migrations
           SET state = 'path_committed', state_version = state_version + 1, updated_at = ?
         WHERE operation_id = ? AND state = ? AND state_version = ? AND start_disposition = 'accepted'
      `).run(input.now, input.operationId, input.expectedState, input.expectedStateVersion);
      assertSingleChange(operationChanged.changes, input.operationId, "提交 path_committed 状态");
      return this.require(input.operationId);
    })();
  }

  /** 更新当前状态的进度或证据投影；状态不变但 stateVersion 仍单调递增。 */
  updateCurrentState(input: {
    operationId: string;
    expectedState: WorkspaceDirectoryMigrationState;
    expectedStateVersion: number;
    patch: WorkspaceDirectoryMigrationStatePatch;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    if (Object.prototype.hasOwnProperty.call(input.patch, "workspaceDbSnapshot")) {
      const current = this.require(input.operationId);
      const next = validateWorkspaceDbSnapshot(input.patch.workspaceDbSnapshot);
      if (current.workspaceDbSnapshot?.state !== "pending" || !next || next.state === "pending") {
        throw stateConflict(input.operationId, current.state, input.expectedState);
      }
      if (current.state !== "target_ready" || current.startDisposition !== "accepted") {
        throw stateConflict(input.operationId, current.state, input.expectedState);
      }
    }
    const updates = compilePatch(input.patch);
    if (updates.columns.length === 0) return this.require(input.operationId);
    updates.columns.push("state_version = state_version + 1", "updated_at = ?");
    updates.values.push(input.now);
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET ${updates.columns.join(", ")}
       WHERE operation_id = ? AND state = ? AND state_version = ?
    `).run(...updates.values, input.operationId, input.expectedState, input.expectedStateVersion);
    assertSingleChange(changed.changes, input.operationId, "迁移状态内更新");
    return this.require(input.operationId);
  }

  /** 登记 prepared start attempt；accepted 幂等返回，fenced 后才允许新 attempt。 */
  prepareStartAttempt(input: {
    operationId: string;
    startAttemptId: string;
    externalWritesPausedConfirmed: boolean;
    targetNotSyncManagedConfirmed: boolean;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    if (!input.externalWritesPausedConfirmed) {
      throw new WorkspaceDirectoryMigrationRepoError(
        "WORKSPACE_MIGRATION_EXTERNAL_WRITES_UNCONFIRMED",
        `用户尚未确认暂停外部写入：operationId=${input.operationId}`,
        { operationId: input.operationId },
      );
    }
    if (!input.targetNotSyncManagedConfirmed) {
      throw new WorkspaceDirectoryMigrationRepoError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNCONFIRMED",
        `用户尚未确认目标不受同步软件托管：operationId=${input.operationId}`,
        { operationId: input.operationId },
      );
    }
    const attemptId = normalizeRequiredText(input.startAttemptId, "startAttemptId");
    const current = this.require(input.operationId);
    if (current.state === "completed") return current;
    if (current.state === "cancelled" || current.state === "failed") {
      throw stateConflict(input.operationId, current.state, "awaiting_confirmation");
    }
    if (current.startDisposition === "accepted") return current;
    if (current.state !== "awaiting_confirmation") {
      throw stateConflict(input.operationId, current.state, "awaiting_confirmation");
    }
    if (current.startDisposition === "prepared") {
      if (current.startAttemptId === attemptId) return current;
      throw new WorkspaceDirectoryMigrationRepoError(
        "WORKSPACE_MIGRATION_STATE_CONFLICT",
        `目录迁移已有未决 start attempt：operationId=${input.operationId}`,
        { operationId: input.operationId, currentStartAttemptId: current.startAttemptId },
      );
    }
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET start_attempt_id = ?, start_disposition = 'prepared', start_decided_at = ?,
             external_writes_confirmed_at = ?, target_storage_confirmed_at = ?,
             start_fence_ack_pending = 0,
             state_version = state_version + 1, updated_at = ?
       WHERE operation_id = ? AND state = 'awaiting_confirmation' AND state_version = ?
         AND (start_disposition IS NULL OR start_disposition = 'fenced')
    `).run(attemptId, input.now, input.now, input.now, input.now, input.operationId, current.stateVersion);
    assertSingleChange(changed.changes, input.operationId, "登记 start attempt");
    return this.require(input.operationId);
  }

  /** 接受指定 prepared attempt，并在同一事务把状态推进到 preparing。 */
  acceptStartAttempt(input: {
    operationId: string;
    startAttemptId: string;
    expectedStateVersion: number;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET start_disposition = 'accepted', start_decided_at = ?, state = 'preparing',
             state_version = state_version + 1, updated_at = ?
       WHERE operation_id = ? AND state = 'awaiting_confirmation' AND state_version = ?
         AND start_attempt_id = ? AND start_disposition = 'prepared'
    `).run(input.now, input.now, input.operationId, input.expectedStateVersion, input.startAttemptId);
    assertSingleChange(changed.changes, input.operationId, "接受 start attempt");
    return this.require(input.operationId);
  }

  /** fence 指定 prepared attempt；成功后任何迟到 execute 都会因 disposition 不匹配失败。 */
  fenceStartAttempt(input: {
    operationId: string;
    startAttemptId: string;
    expectedStateVersion: number;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET start_disposition = 'fenced', start_decided_at = ?,
             state_version = state_version + 1, updated_at = ?
       WHERE operation_id = ? AND state = 'awaiting_confirmation' AND state_version = ?
         AND start_attempt_id = ? AND start_disposition = 'prepared'
    `).run(input.now, input.now, input.operationId, input.expectedStateVersion, input.startAttemptId);
    assertSingleChange(changed.changes, input.operationId, "fence start attempt");
    return this.require(input.operationId);
  }

  /** 原子 fence prepared attempt、取消操作并保留待 ACK tombstone。 */
  fencePreparedAttemptAndCancel(input: {
    operationId: string;
    startAttemptId: string;
    expectedStateVersion: number;
    cancellationReason: string;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET start_disposition = 'fenced', start_decided_at = ?, start_fence_ack_pending = 1,
             state = 'cancelled', cancellation_reason = ?,
             state_version = state_version + 1, updated_at = ?, completed_at = ?
       WHERE operation_id = ? AND state = 'awaiting_confirmation' AND state_version = ?
         AND start_attempt_id = ? AND start_disposition = 'prepared'
    `).run(
      input.now,
      normalizeRequiredText(input.cancellationReason, "cancellationReason"),
      input.now,
      input.now,
      input.operationId,
      input.expectedStateVersion,
      input.startAttemptId,
    );
    assertSingleChange(changed.changes, input.operationId, "重启 fence start attempt");
    return this.require(input.operationId);
  }

  /** 仅清除三字段完全匹配的 fence ACK；旧 ACK 和重复 ACK 幂等返回当前事实。 */
  acknowledgeStartFence(
    operationId: string,
    startAttemptId: string,
    stateVersion: number,
    acknowledgedAt: number,
  ): WorkspaceDirectoryMigrationRecord {
    const current = this.require(operationId);
    if (
      !current.startFenceAckPending
      || current.startAttemptId !== startAttemptId
      || current.stateVersion !== stateVersion
    ) return current;
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET start_fence_ack_pending = 0, updated_at = ?
       WHERE operation_id = ? AND start_attempt_id = ? AND start_disposition = 'fenced'
         AND start_fence_ack_pending = 1 AND state_version = ? AND state IN ('cancelled', 'failed')
    `).run(acknowledgedAt, operationId, startAttemptId, stateVersion);
    assertSingleChange(changed.changes, operationId, "确认 start fence ACK");
    return this.require(operationId);
  }

  /** 仅清除匹配待通知版本的 ACK；旧 ACK 和重复 ACK 幂等返回当前事实。 */
  acknowledgeNotification(operationId: string, stateVersion: number, acknowledgedAt: number): WorkspaceDirectoryMigrationRecord {
    const current = this.require(operationId);
    if (!current.notificationPending || current.notificationStateVersion !== stateVersion) return current;
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET notification_pending = 0, notification_state_version = NULL, updated_at = ?
       WHERE operation_id = ? AND notification_pending = 1 AND notification_state_version = ?
    `).run(acknowledgedAt, operationId, stateVersion);
    assertSingleChange(changed.changes, operationId, "确认迁移通知 ACK");
    return this.require(operationId);
  }

  /** 持久化新的索引 pending generation；completed 后替换代次时建立通知 ACK 屏障。 */
  setIndexRebuildPending(input: {
    operationId: string;
    expectedState: Extract<WorkspaceDirectoryMigrationState, "finalizing" | "recovery_required" | "completed">;
    expectedStateVersion: number;
    generation: number;
    phase: WorkspaceDirectoryMigrationIndexRebuildPhase;
    lastProgressAt: number;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    const generation = normalizePositiveInteger(input.generation, "generation");
    const current = this.require(input.operationId);
    if (current.state !== input.expectedState || current.stateVersion !== input.expectedStateVersion) {
      throw stateConflict(input.operationId, current.state, input.expectedState);
    }
    const nextVersion = input.expectedStateVersion + 1;
    const notificationSql = input.expectedState === "completed"
      ? ", notification_pending = 1, notification_state_version = ?"
      : "";
    const values: unknown[] = [
      generation,
      input.phase,
      input.lastProgressAt,
      nextVersion,
    ];
    if (input.expectedState === "completed") values.push(nextVersion);
    values.push(input.now, input.operationId, input.expectedState, input.expectedStateVersion);
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET index_rebuild_generation = ?, index_rebuild_status = 'pending', index_rebuild_phase = ?,
             index_rebuild_last_progress_at = ?, warning_code = NULL, warning_details_json = NULL,
             state_version = ?${notificationSql}, updated_at = ?
       WHERE operation_id = ? AND state = ? AND state_version = ?
    `).run(...values);
    assertSingleChange(changed.changes, input.operationId, "登记迁移索引 generation");
    return this.require(input.operationId);
  }

  /** 索引明确禁用时持久化 not_applicable，不允许残留 generation 或 warning。 */
  setIndexRebuildNotApplicable(input: {
    operationId: string;
    expectedState: Extract<WorkspaceDirectoryMigrationState, "finalizing" | "recovery_required" | "completed">;
    expectedStateVersion: number;
    now: number;
  }): WorkspaceDirectoryMigrationRecord {
    const current = this.require(input.operationId);
    if (current.state !== input.expectedState || current.stateVersion !== input.expectedStateVersion) {
      throw stateConflict(input.operationId, current.state, input.expectedState);
    }
    const nextVersion = input.expectedStateVersion + 1;
    const notificationSql = input.expectedState === "completed"
      ? ", notification_pending = 1, notification_state_version = ?"
      : "";
    const values: unknown[] = [nextVersion];
    if (input.expectedState === "completed") values.push(nextVersion);
    values.push(input.now, input.operationId, input.expectedState, input.expectedStateVersion);
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET index_rebuild_generation = NULL, index_rebuild_status = 'not_applicable',
             index_rebuild_phase = NULL, index_rebuild_last_progress_at = NULL,
             warning_code = NULL, warning_details_json = NULL,
             state_version = ?${notificationSql}, updated_at = ?
       WHERE operation_id = ? AND state = ? AND state_version = ?
    `).run(...values);
    assertSingleChange(changed.changes, input.operationId, "标记迁移索引不适用");
    return this.require(input.operationId);
  }

  /** 更新匹配 pending generation 的索引阶段与心跳；不推进迁移 stateVersion。 */
  touchIndexRebuildProgress(input: {
    operationId: string;
    expectedGeneration: number;
    phase: WorkspaceDirectoryMigrationIndexRebuildPhase;
    lastProgressAt: number;
    now: number;
  }): { operation: WorkspaceDirectoryMigrationRecord; applied: boolean } {
    const generation = normalizePositiveInteger(input.expectedGeneration, "expectedGeneration");
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET index_rebuild_phase = ?, index_rebuild_last_progress_at = ?, updated_at = ?
       WHERE operation_id = ? AND state IN ('finalizing', 'completed')
         AND index_rebuild_generation = ? AND index_rebuild_status = 'pending'
    `).run(
      input.phase,
      input.lastProgressAt,
      input.now,
      input.operationId,
      generation,
    );
    return { operation: this.require(input.operationId), applied: changed.changes === 1 };
  }

  /** 只收敛当前 pending generation；旧 generation 迟到结果幂等返回 applied=false。 */
  completeIndexRebuild(input: {
    operationId: string;
    expectedStateVersion: number;
    expectedGeneration: number;
    status: Extract<WorkspaceDirectoryMigrationIndexRebuildStatus, "ready" | "failed">;
    warningDetails?: unknown | null;
    now: number;
  }): { operation: WorkspaceDirectoryMigrationRecord; applied: boolean } {
    const current = this.require(input.operationId);
    const generation = normalizePositiveInteger(input.expectedGeneration, "expectedGeneration");
    if (current.indexRebuildGeneration !== generation || current.indexRebuildStatus !== "pending") {
      return { operation: current, applied: false };
    }
    if (current.state !== "completed" || current.stateVersion !== input.expectedStateVersion) {
      throw stateConflict(input.operationId, current.state, "completed");
    }
    const nextVersion = input.expectedStateVersion + 1;
    const warningCode: WorkspaceDirectoryMigrationWarningCode | null = input.status === "failed"
      ? "WORKSPACE_INDEX_REBUILD_FAILED"
      : null;
    const warningDetails = input.status === "failed" ? input.warningDetails ?? null : null;
    const changed = this.db.prepare(`
      UPDATE workspace_directory_migrations
         SET index_rebuild_status = ?, index_rebuild_phase = NULL,
             index_rebuild_last_progress_at = ?, warning_code = ?, warning_details_json = ?,
             state_version = ?, notification_pending = 1, notification_state_version = ?, updated_at = ?
       WHERE operation_id = ? AND state = 'completed' AND state_version = ?
         AND index_rebuild_generation = ? AND index_rebuild_status = 'pending'
    `).run(
      input.status,
      input.now,
      warningCode,
      encodeJson(warningDetails, "warningDetails"),
      nextVersion,
      nextVersion,
      input.now,
      input.operationId,
      input.expectedStateVersion,
      generation,
    );
    assertSingleChange(changed.changes, input.operationId, "完成迁移索引 generation");
    return { operation: this.require(input.operationId), applied: true };
  }

  /** 读取最近一次会阻断新迁移的 completed 索引状态。 */
  getLatestCompletedWithBlockingIndex(workspaceId: WorkspaceId): WorkspaceDirectoryMigrationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_directory_migrations
       WHERE workspace_id = ? AND state = 'completed'
       ORDER BY completed_at DESC, updated_at DESC LIMIT 1
    `).get(String(workspaceId)) as MigrationRow | undefined;
    if (!row) return null;
    const operation = rowToRecord(row);
    return operation.indexRebuildStatus === "pending" || operation.indexRebuildStatus === "failed"
      ? operation
      : null;
  }
}

/** completed 前必须已持久化索引排队代次，或明确标记索引不适用。 */
function assertCompletionIndexReady(operation: WorkspaceDirectoryMigrationRecord): void {
  if (operation.indexRebuildStatus === "not_applicable") {
    if (operation.indexRebuildGeneration === null && operation.indexRebuildPhase === null) return;
  } else if (
    operation.indexRebuildStatus === "pending"
    && operation.indexRebuildGeneration !== null
    && operation.indexRebuildPhase !== null
  ) return;
  throw new WorkspaceDirectoryMigrationRepoError(
    "WORKSPACE_MIGRATION_STATE_CONFLICT",
    `目录迁移完成前未持久化有效索引排队状态：operationId=${operation.operationId}`,
    {
      operationId: operation.operationId,
      indexRebuildGeneration: operation.indexRebuildGeneration,
      indexRebuildStatus: operation.indexRebuildStatus,
      indexRebuildPhase: operation.indexRebuildPhase,
    },
  );
}

/** 新 operation 只能登记 pending；旧调用保留 null 的完整树兼容口径。 */
function normalizeCreateInput(input: CreateWorkspaceDirectoryMigrationInput): Omit<Required<CreateWorkspaceDirectoryMigrationInput>, "workspaceDbSnapshot"> & Pick<CreateWorkspaceDirectoryMigrationInput, "workspaceDbSnapshot"> {
  const now = normalizeNonNegativeInteger(input.now, "now");
  if (input.workspaceDbSnapshot !== undefined && validateWorkspaceDbSnapshot(input.workspaceDbSnapshot)?.state !== "pending") throw new Error("WORKSPACE_DB_SNAPSHOT_CREATE_INVALID");
  return {
    operationId: input.operationId ? normalizeRequiredText(input.operationId, "operationId") : "",
    idempotencyKey: normalizeRequiredText(input.idempotencyKey, "idempotencyKey"),
    workspaceId: normalizeRequiredText(input.workspaceId, "workspaceId") as WorkspaceId,
    sourcePath: normalizeRequiredText(input.sourcePath, "sourcePath"),
    targetParentPath: normalizeRequiredText(input.targetParentPath, "targetParentPath"),
    targetPath: normalizeRequiredText(input.targetPath, "targetPath"),
    now,
    workspaceDbSnapshot: input.workspaceDbSnapshot,
  };
}

/** 同一幂等键只允许绑定完全相同的工作区与规范化路径身份。 */
function assertSameCreateIdentity(
  existing: WorkspaceDirectoryMigrationRecord,
  input: CreateWorkspaceDirectoryMigrationInput,
): void {
  if (
    existing.workspaceId === input.workspaceId
    && existing.sourcePath === input.sourcePath
    && existing.targetParentPath === input.targetParentPath
    && existing.targetPath === input.targetPath
  ) return;
  throw new WorkspaceDirectoryMigrationRepoError(
    "WORKSPACE_MIGRATION_IDEMPOTENCY_CONFLICT",
    `目录迁移幂等键已绑定不同参数：idempotencyKey=${input.idempotencyKey}`,
    { operationId: existing.operationId, workspaceId: existing.workspaceId },
  );
}

/** 严格解析唯一数据库交接证据，拒绝缺项、未知字段和精度丢失的文件身份。 */
export function validateWorkspaceDbSnapshot(value: unknown): WorkspaceDbSnapshotEvidence | null {
  if (value === null) return null;
  /** 证据对象字段精确匹配，拒绝未知字段和缺项。 */
  const object = (input: unknown, keys: string[]): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).sort().join(",") !== [...keys].sort().join(",")) throw new Error("WORKSPACE_DB_SNAPSHOT_INVALID");
    return input as Record<string, unknown>;
  };
  /** 文件身份只接十进制 BigInt 文本，完整副本还需尺寸和摘要。 */
  const identity = (input: unknown, file = false): void => {
    const row = object(input, file ? ["dev", "ino", "size", "hash", "mtimeNs", "ctimeNs"] : ["dev", "ino"]);
    for (const key of ["dev", "ino", ...(file ? ["mtimeNs", "ctimeNs"] : [])]) {
      if (typeof row[key] !== "string" || !/^(0|[1-9][0-9]*)$/.test(row[key] as string)) throw new Error("WORKSPACE_DB_SNAPSHOT_INVALID");
    }
    if (row.ino === "0") throw new Error("WORKSPACE_DB_SNAPSHOT_IDENTITY_UNAVAILABLE");
    if (file && (!Number.isSafeInteger(row.size) || Number(row.size) < 0 || typeof row.hash !== "string" || !/^[a-f0-9]{64}$/.test(row.hash))) throw new Error("WORKSPACE_DB_SNAPSHOT_INVALID");
  };
  const state = (value as { state?: unknown }).state;
  const row = object(value, state === "pending" ? ["formatVersion", "state"]
    : state === "absent" ? ["formatVersion", "state", "sourceRoot", "targetRoot"]
      : ["formatVersion", "state", "sourceRoot", "targetRoot", "source", "target", "applicationId", "schemaVersion"]);
  if (row.formatVersion !== 1 || !["pending", "absent", "ready"].includes(String(state))) throw new Error("WORKSPACE_DB_SNAPSHOT_INVALID");
  if (state !== "pending") { identity(row.sourceRoot); identity(row.targetRoot); }
  if (state === "ready") {
    identity(row.source, true); identity(row.target, true);
    if (row.applicationId !== 0x43465753 || !Number.isSafeInteger(row.schemaVersion) || Number(row.schemaVersion) < 93) throw new Error("WORKSPACE_DB_SNAPSHOT_INVALID");
  }
  return value as WorkspaceDbSnapshotEvidence;
}

/** 编译有限白名单的状态投影；数据库证据写入前必须先通过严格结构校验。 */
function compilePatch(patch: WorkspaceDirectoryMigrationStatePatch): { columns: string[]; values: unknown[] } {
  assertDependencyExclusionPatch(patch);
  const columns: string[] = [];
  const values: unknown[] = [];
  const add = (property: keyof WorkspaceDirectoryMigrationStatePatch, column: string, map?: (value: unknown) => unknown) => {
    if (!Object.prototype.hasOwnProperty.call(patch, property)) return;
    const value = patch[property];
    if (value === undefined) throw new Error(`目录迁移 patch 不允许 undefined：${String(property)}`);
    columns.push(`${column} = ?`);
    values.push(map ? map(value) : value);
  };
  add("stagingPath", "staging_path");
  add("sourceFileCount", "source_file_count", (value) => normalizeNonNegativeInteger(value, "sourceFileCount"));
  add("sourceDirectoryCount", "source_dir_count", (value) => normalizeNonNegativeInteger(value, "sourceDirectoryCount"));
  add("sourceTotalBytes", "source_total_bytes", (value) => normalizeNonNegativeInteger(value, "sourceTotalBytes"));
  add("excludedDependencyDirectoryCount", "excluded_dependency_dir_count", (value) => normalizeNonNegativeInteger(value, "excludedDependencyDirectoryCount"));
  add("excludedDependencyDirectories", "excluded_dependency_dirs_json", (value) => encodeJson(
    validateExcludedDependencyDirectories(value, "excludedDependencyDirectories"),
    "excludedDependencyDirectories",
  ));
  add("copiedFiles", "copied_files", (value) => normalizeNonNegativeInteger(value, "copiedFiles"));
  add("copiedBytes", "copied_bytes", (value) => normalizeNonNegativeInteger(value, "copiedBytes"));
  add("sourceManifestHash", "source_manifest_hash");
  add("verifiedTargetManifestHash", "verified_target_manifest_hash");
  add("workspaceDbSnapshot", "workspace_db_snapshot_json", value => encodeJson(validateWorkspaceDbSnapshot(value), "workspaceDbSnapshot"));
  add("terminalCwdSnapshot", "terminal_cwd_snapshot_json", (value) => encodeJson(value, "terminalCwdSnapshot"));
  add("errorCode", "error_code");
  add("errorMessage", "error_message");
  add("errorDetails", "error_details_json", (value) => encodeJson(value, "errorDetails"));
  add("warningCode", "warning_code");
  add("warningDetails", "warning_details_json", (value) => encodeJson(value, "warningDetails"));
  add("cancellationReason", "cancellation_reason");
  return { columns, values };
}

/** 排除数量和限长明细必须成对更新，并在写入前满足同一清单事实。 */
function assertDependencyExclusionPatch(patch: WorkspaceDirectoryMigrationStatePatch): void {
  const hasCount = Object.prototype.hasOwnProperty.call(patch, "excludedDependencyDirectoryCount");
  const hasDirectories = Object.prototype.hasOwnProperty.call(patch, "excludedDependencyDirectories");
  const directories = hasDirectories
    ? validateExcludedDependencyDirectories(patch.excludedDependencyDirectories, "excludedDependencyDirectories")
    : [];
  const count = hasCount
    ? normalizeNonNegativeInteger(patch.excludedDependencyDirectoryCount, "excludedDependencyDirectoryCount")
    : 0;
  if (hasCount !== hasDirectories) {
    throw new Error("目录迁移排除数量和路径列表必须成对更新");
  }
  if (hasCount && directories.length !== Math.min(count, 100)) {
    throw new Error("目录迁移排除数量和路径列表不一致");
  }
}

function rowToRecord(row: MigrationRow): WorkspaceDirectoryMigrationRecord {
  const operationId = normalizeRequiredText(row.operation_id, "operation_id");
  const excludedDependencyDirectoryCount = normalizeNonNegativeInteger(
    row.excluded_dependency_dir_count,
    "excluded_dependency_dir_count",
  );
  const excludedDependencyDirectories = parseExcludedDependencyDirectories(
    row.excluded_dependency_dirs_json,
    operationId,
  );
  if (excludedDependencyDirectories.length !== Math.min(excludedDependencyDirectoryCount, 100)) {
    throw corruptRow(operationId, "excluded_dependency_dir_count", row.excluded_dependency_dir_count);
  }
  return {
    operationId,
    idempotencyKey: normalizeRequiredText(row.idempotency_key, "idempotency_key"),
    workspaceId: normalizeRequiredText(row.workspace_id, "workspace_id") as WorkspaceId,
    sourcePath: normalizeRequiredText(row.source_path, "source_path"),
    targetParentPath: normalizeRequiredText(row.target_parent_path, "target_parent_path"),
    targetPath: normalizeRequiredText(row.target_path, "target_path"),
    stagingPath: nullableText(row.staging_path),
    state: parseState(row.state, operationId),
    sourceFileCount: normalizeNonNegativeInteger(row.source_file_count, "source_file_count"),
    sourceDirectoryCount: normalizeNonNegativeInteger(row.source_dir_count, "source_dir_count"),
    sourceTotalBytes: normalizeNonNegativeInteger(row.source_total_bytes, "source_total_bytes"),
    excludedDependencyDirectoryCount,
    excludedDependencyDirectories,
    copiedFiles: normalizeNonNegativeInteger(row.copied_files, "copied_files"),
    copiedBytes: normalizeNonNegativeInteger(row.copied_bytes, "copied_bytes"),
    sourceManifestHash: nullableText(row.source_manifest_hash),
    verifiedTargetManifestHash: nullableText(row.verified_target_manifest_hash),
    workspaceDbSnapshot: validateWorkspaceDbSnapshot(parseJson(row.workspace_db_snapshot_json, "workspace_db_snapshot_json", operationId)),
    terminalCwdSnapshot: parseTerminalCwdSnapshot(row.terminal_cwd_snapshot_json, operationId),
    externalWritesConfirmedAt: nullableNumber(row.external_writes_confirmed_at),
    targetStorageConfirmedAt: nullableNumber(row.target_storage_confirmed_at),
    startAttemptId: nullableText(row.start_attempt_id),
    startDisposition: parseStartDisposition(row.start_disposition, operationId),
    startDecidedAt: nullableNumber(row.start_decided_at),
    startFenceAckPending: Number(row.start_fence_ack_pending) === 1,
    indexRebuildGeneration: nullableNumber(row.index_rebuild_generation),
    indexRebuildStatus: parseIndexStatus(row.index_rebuild_status, operationId),
    indexRebuildPhase: parseIndexPhase(row.index_rebuild_phase, operationId),
    indexRebuildLastProgressAt: nullableNumber(row.index_rebuild_last_progress_at),
    stateVersion: normalizePositiveInteger(row.state_version, "state_version"),
    notificationPending: Number(row.notification_pending) === 1,
    notificationStateVersion: nullableNumber(row.notification_state_version),
    errorCode: parseErrorCode(row.error_code, operationId),
    errorMessage: nullableText(row.error_message),
    errorDetails: parseJson(row.error_details_json, "error_details_json", operationId),
    warningCode: parseWarningCode(row.warning_code, operationId),
    warningDetails: parseJson(row.warning_details_json, "warning_details_json", operationId),
    cancellationReason: nullableText(row.cancellation_reason),
    createdAt: normalizeNonNegativeInteger(row.created_at, "created_at"),
    updatedAt: normalizeNonNegativeInteger(row.updated_at, "updated_at"),
    completedAt: nullableNumber(row.completed_at),
  };
}

function parseState(value: unknown, operationId: string): WorkspaceDirectoryMigrationState {
  const text = String(value ?? "");
  if ((WORKSPACE_DIRECTORY_MIGRATION_STATES as readonly string[]).includes(text)) {
    return text as WorkspaceDirectoryMigrationState;
  }
  throw corruptRow(operationId, "state", value);
}

function parseStartDisposition(value: unknown, operationId: string): WorkspaceDirectoryMigrationStartDisposition | null {
  const text = nullableText(value);
  if (text === null || text === "prepared" || text === "accepted" || text === "fenced") return text;
  throw corruptRow(operationId, "start_disposition", value);
}

function parseIndexStatus(value: unknown, operationId: string): WorkspaceDirectoryMigrationIndexRebuildStatus {
  const text = String(value ?? "");
  if (["not_started", "pending", "ready", "failed", "not_applicable"].includes(text)) {
    return text as WorkspaceDirectoryMigrationIndexRebuildStatus;
  }
  throw corruptRow(operationId, "index_rebuild_status", value);
}

function parseIndexPhase(value: unknown, operationId: string): WorkspaceDirectoryMigrationIndexRebuildPhase | null {
  const text = nullableText(value);
  if (text === null || text === "queued" || text === "building") return text;
  throw corruptRow(operationId, "index_rebuild_phase", value);
}

function parseErrorCode(value: unknown, operationId: string): WorkspaceDirectoryMigrationErrorCode | null {
  const text = nullableText(value);
  if (text === null || (WORKSPACE_DIRECTORY_MIGRATION_ERROR_CODES as readonly string[]).includes(text)) {
    return text as WorkspaceDirectoryMigrationErrorCode | null;
  }
  throw corruptRow(operationId, "error_code", value);
}

function parseWarningCode(value: unknown, operationId: string): WorkspaceDirectoryMigrationWarningCode | null {
  const text = nullableText(value);
  if (text === null || text === "WORKSPACE_INDEX_REBUILD_FAILED") return text;
  throw corruptRow(operationId, "warning_code", value);
}

function parseTerminalCwdSnapshot(value: unknown, operationId: string): Record<string, string | null> | null {
  const parsed = parseJson(value, "terminal_cwd_snapshot_json", operationId);
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw corruptRow(operationId, "terminal_cwd_snapshot_json", value);
  }
  const result: Record<string, string | null> = {};
  for (const [terminalId, cwd] of Object.entries(parsed as Record<string, unknown>)) {
    if (!terminalId || (cwd !== null && typeof cwd !== "string")) {
      throw corruptRow(operationId, "terminal_cwd_snapshot_json", value);
    }
    result[terminalId] = cwd;
  }
  return result;
}

/** 读取限长的工作区相对可重新生成目录列表，损坏时阻止继续迁移。 */
function parseExcludedDependencyDirectories(value: unknown, operationId: string): string[] {
  const parsed = parseJson(value, "excluded_dependency_dirs_json", operationId);
  try {
    return validateExcludedDependencyDirectories(parsed, "excluded_dependency_dirs_json");
  } catch {
    throw corruptRow(operationId, "excluded_dependency_dirs_json", value);
  }
}

/** 校验最多 100 条规范相对可重新生成目录路径，返回可持久化原值。 */
function validateExcludedDependencyDirectories(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`目录迁移排除路径列表无效：${field}`);
  }
  const paths = value.map((entry) => {
    if (typeof entry !== "string" || entry !== entry.trim() || entry.length === 0 || entry.length > 1_000) {
      throw new Error(`目录迁移排除路径无效：${field}`);
    }
    const parts = entry.split("/");
    if (
      entry.includes("\\")
      || entry.startsWith("/")
      || /^[a-zA-Z]:/.test(entry)
      || parts.some((part) => part === "" || part === "." || part === "..")
      || !isSupportedRegenerableDirectoryRelativePath(entry)
    ) {
      throw new Error(`目录迁移排除路径无效：${field}`);
    }
    return entry;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error(`目录迁移排除路径不允许重复：${field}`);
  }
  return paths;
}

/** 目标 cwd 必须逐项覆盖快照，避免提交时遗漏终端。 */
function assertTerminalTargetKeys(
  snapshot: Record<string, string | null>,
  targets: Record<string, string | null>,
  operationId: string,
): void {
  const snapshotKeys = Object.keys(snapshot).sort();
  const targetKeys = Object.keys(targets).sort();
  if (snapshotKeys.length === targetKeys.length && snapshotKeys.every((key, index) => key === targetKeys[index])) return;
  throw new WorkspaceDirectoryMigrationRepoError(
    "WORKSPACE_MIGRATION_STATE_CONFLICT",
    `终端 cwd 目标与快照不一致：operationId=${operationId}`,
    { operationId, snapshotTerminalIds: snapshotKeys, targetTerminalIds: targetKeys },
  );
}

/** 提交前确认终端 cwd 未在快照后被其他流程改写。 */
function assertTerminalSnapshotMatches(
  snapshot: Record<string, string | null>,
  persisted: Array<{ id?: string | null; cwd?: string | null }>,
  operationId: string,
): void {
  const actual = Object.fromEntries(persisted.map((row) => [String(row.id ?? ""), row.cwd ?? null]));
  const expectedKeys = Object.keys(snapshot).sort();
  const actualKeys = Object.keys(actual).sort();
  const matches = expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index] && snapshot[key] === actual[key]);
  if (matches) return;
  throw new WorkspaceDirectoryMigrationRepoError(
    "WORKSPACE_MIGRATION_STATE_CONFLICT",
    `终端 cwd 在路径提交前发生变化：operationId=${operationId}`,
    { operationId, expectedTerminalIds: expectedKeys, actualTerminalIds: actualKeys },
  );
}

function parseJson(value: unknown, field: string, operationId: string): unknown | null {
  const text = nullableText(value);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WorkspaceDirectoryMigrationRepoError(
      "WORKSPACE_MIGRATION_STATE_CONFLICT",
      `目录迁移持久化 JSON 损坏：operationId=${operationId}, field=${field}`,
      { operationId, field, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function encodeJson(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (value === undefined) throw new Error(`目录迁移 JSON 字段不允许 undefined：${field}`);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`目录迁移 JSON 字段不可序列化：${field}`);
  return encoded;
}

function stateConflict(
  operationId: string,
  current: WorkspaceDirectoryMigrationState,
  next: WorkspaceDirectoryMigrationState,
): WorkspaceDirectoryMigrationRepoError {
  return new WorkspaceDirectoryMigrationRepoError(
    "WORKSPACE_MIGRATION_STATE_CONFLICT",
    `目录迁移状态转换冲突：operationId=${operationId}, current=${current}, next=${next}`,
    { operationId, current, next },
  );
}

function corruptRow(operationId: string, field: string, value: unknown): WorkspaceDirectoryMigrationRepoError {
  return new WorkspaceDirectoryMigrationRepoError(
    "WORKSPACE_MIGRATION_STATE_CONFLICT",
    `目录迁移持久化记录损坏：operationId=${operationId}, field=${field}`,
    { operationId, field, value },
  );
}

function assertSingleChange(changes: number | bigint | undefined, operationId: string, action: string): void {
  if (Number(changes ?? 0) === 1) return;
  throw new WorkspaceDirectoryMigrationRepoError(
    "WORKSPACE_MIGRATION_STATE_CONFLICT",
    `${action}发生并发冲突：operationId=${operationId}`,
    { operationId, action },
  );
}

function normalizeRequiredText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`目录迁移字段不能为空：${field}`);
  return text;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return normalizeNonNegativeInteger(value, "nullableNumber");
}

function normalizePositiveInteger(value: unknown, field: string): number {
  const numeric = normalizeNonNegativeInteger(value, field);
  if (numeric < 1) throw new Error(`目录迁移字段必须为正整数：${field}`);
  return numeric;
}

function normalizeNonNegativeInteger(value: unknown, field: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`目录迁移字段必须为非负安全整数：${field}`);
  }
  return numeric;
}
