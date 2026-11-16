import {
  resolveWorkspaceDirectoryMigrationPhase,
  type WorkspaceDirectoryMigrationActivationSnapshot,
  type WorkspaceDirectoryMigrationChangedEvent,
  type WorkspaceDirectoryMigrationIndexState,
  type WorkspaceDirectoryMigrationOperation,
  type WorkspaceDirectoryMigrationSummary,
  type WorkspaceDirectoryMigrationStartFenceTombstone,
  type WorkspaceId,
  type WorkspaceSummary,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import type { WorkspaceDirectoryMigrationRecord } from "../db/repos/workspaceDirectoryMigrationRepo.js";
import type { WorkspaceMigrationActivityInspector } from "./workspaceMigrationActivityInspector.js";

export type WorkspaceMigrationViewContext = {
  db: ClientDb;
  workspaces: Map<WorkspaceId, string>;
  activityInspector?: WorkspaceMigrationActivityInspector | null;
};

/** 将 Client SQLite 迁移事实转换为不含底层堆栈的共享 operation DTO。 */
export function toWorkspaceDirectoryMigrationOperation(
  record: WorkspaceDirectoryMigrationRecord,
  context: WorkspaceMigrationViewContext,
): WorkspaceDirectoryMigrationOperation {
  const blockers = record.state === "awaiting_confirmation"
    ? context.activityInspector?.inspect(record.workspaceId) ?? []
    : [];
  return {
    operationId: record.operationId,
    workspaceId: record.workspaceId,
    state: record.state,
    stateVersion: record.stateVersion,
    phase: resolveWorkspaceDirectoryMigrationPhase(record.state),
    sourcePath: record.sourcePath,
    targetPath: record.targetPath,
    sourceFileCount: record.sourceFileCount,
    sourceDirectoryCount: record.sourceDirectoryCount,
    sourceTotalBytes: record.sourceTotalBytes,
    excludedDependencyDirectoryCount: record.excludedDependencyDirectoryCount,
    excludedDependencyDirectories: record.excludedDependencyDirectories,
    copiedFiles: record.copiedFiles,
    copiedBytes: record.copiedBytes,
    progressPct: resolveProgressPct(record),
    canStart: record.state === "awaiting_confirmation" && blockers.length === 0 && record.startDisposition !== "prepared",
    canCancel: record.state === "scanning"
      || record.state === "awaiting_confirmation"
      || record.state === "copying"
      || record.state === "verifying",
    currentPath: context.workspaces.get(record.workspaceId) ?? context.db.workspaces.get(record.workspaceId)?.path ?? null,
    blockers: blockers.map((blocker) => ({
      code: "WORKSPACE_MIGRATION_ACTIVE_RESOURCES",
      message: describeActivityBlocker(blocker),
      details: blocker,
    })),
    sharedBlockers: [],
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    errorDetails: record.errorDetails,
    warningCode: record.warningCode,
    warningDetails: record.warningDetails,
    startAttemptId: record.startAttemptId,
    startDisposition: record.startDisposition,
    indexRebuildGeneration: record.indexRebuildGeneration,
    indexRebuildStatus: record.indexRebuildStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

/** 构造激活快照中的活动迁移摘要。 */
export function toWorkspaceDirectoryMigrationSummary(
  record: WorkspaceDirectoryMigrationRecord,
): WorkspaceDirectoryMigrationSummary {
  return {
    operationId: record.operationId,
    workspaceId: record.workspaceId,
    state: record.state,
    stateVersion: record.stateVersion,
    phase: resolveWorkspaceDirectoryMigrationPhase(record.state),
    progressPct: resolveProgressPct(record),
    startAttemptId: record.startAttemptId,
    startDisposition: record.startDisposition,
    updatedAt: record.updatedAt,
  };
}

/** 构造 Server 需要的 fenced 终态对账条目。 */
export function toWorkspaceDirectoryMigrationStartFenceTombstone(
  record: WorkspaceDirectoryMigrationRecord,
): WorkspaceDirectoryMigrationStartFenceTombstone {
  if (!record.startAttemptId || record.startDisposition !== "fenced") {
    throw new Error(`迁移 fence tombstone 证据不完整：operationId=${record.operationId}`);
  }
  return {
    operationId: record.operationId,
    workspaceId: record.workspaceId,
    state: record.state === "cancelled" ? "cancelled" : "failed",
    stateVersion: record.stateVersion,
    startAttemptId: record.startAttemptId,
    startDisposition: "fenced",
    updatedAt: record.updatedAt,
  };
}

/** 构造 completed 后 pending/failed 索引状态投影。 */
export function toWorkspaceDirectoryMigrationIndexState(
  record: WorkspaceDirectoryMigrationRecord,
): WorkspaceDirectoryMigrationIndexState {
  return {
    operationId: record.operationId,
    workspaceId: record.workspaceId,
    stateVersion: record.stateVersion,
    indexRebuildGeneration: record.indexRebuildGeneration,
    indexRebuildStatus: record.indexRebuildStatus,
    warningCode: record.warningCode,
    updatedAt: record.updatedAt,
  };
}

/** 构造 Client hello 后的完整迁移事实快照。 */
export function buildWorkspaceDirectoryMigrationActivationSnapshot(db: ClientDb): WorkspaceDirectoryMigrationActivationSnapshot {
  return {
    activeDirectoryMigrations: db.workspaceDirectoryMigrations.listActive().map(toWorkspaceDirectoryMigrationSummary),
    startFenceTombstones: db.workspaceDirectoryMigrations.listStartFenceTombstones().map(toWorkspaceDirectoryMigrationStartFenceTombstone),
    directoryMigrationIndexStates: db.workspaceDirectoryMigrations.listDirectoryMigrationIndexStates().map(toWorkspaceDirectoryMigrationIndexState),
  };
}

/** 构造实时迁移事件；完整 workspace 摘要只在 completed 时附带。 */
export function toWorkspaceDirectoryMigrationChangedEvent(
  record: WorkspaceDirectoryMigrationRecord,
  context: WorkspaceMigrationViewContext,
): WorkspaceDirectoryMigrationChangedEvent {
  const event: WorkspaceDirectoryMigrationChangedEvent = {
    operationId: record.operationId,
    workspaceId: record.workspaceId,
    state: record.state,
    stateVersion: record.stateVersion,
    phase: resolveWorkspaceDirectoryMigrationPhase(record.state),
    progressPct: resolveProgressPct(record),
    copiedBytes: record.copiedBytes,
    totalBytes: record.sourceTotalBytes,
    updatedAt: record.updatedAt,
  };
  if (record.errorCode || record.errorMessage) {
    event.errorCode = record.errorCode;
    event.errorMessage = record.errorMessage;
  }
  if (record.warningCode || record.warningDetails) {
    event.warningCode = record.warningCode;
    event.warningDetails = record.warningDetails;
  }
  if (record.state === "completed") event.workspace = toWorkspaceSummary(context.db, record.workspaceId);
  return event;
}

/** 将 Client workspace 主表行转换为迁移事件中的最小新目录摘要。 */
export function toWorkspaceSummary(db: ClientDb, workspaceId: WorkspaceId): WorkspaceSummary {
  const workspace = db.workspaces.get(workspaceId);
  if (!workspace) throw new Error(`迁移事件 workspace 不存在：workspaceId=${workspaceId}`);
  return {
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

/** 按阶段权重计算整体进度，避免复制完成后在耗时校验阶段提前显示 99%。 */
function resolveProgressPct(record: WorkspaceDirectoryMigrationRecord): number {
  switch (record.state) {
    case "scanning":
    case "awaiting_confirmation":
      return 0;
    case "preparing":
      return 5;
    case "copying": {
      const copiedRatio = record.sourceTotalBytes > 0
        ? Math.min(1, Math.max(0, record.copiedBytes / record.sourceTotalBytes))
        : 0;
      return 10 + Math.round(copiedRatio * 55);
    }
    case "verifying":
      return 70;
    case "publish_intent":
      return 82;
    case "target_ready":
    case "recovery_required":
      return 90;
    case "path_committed":
      return 95;
    case "finalizing":
      return 98;
    case "completed":
      return 100;
    case "cancelled":
    case "failed":
      return 0;
  }
}

/** 将活动资源技术类型转换为包含数量的用户可读阻断原因。 */
function describeActivityBlocker(blocker: { type: string; count: number }): string {
  const labels: Record<string, string> = {
    turn: "会话",
    orchestration_instance: "流程",
    queue_dispatch: "消息队列任务",
    terminal: "终端",
    managed_service: "后台服务",
    controlled_experiment: "受控实验",
    asset_generation_job: "资产生成任务",
    rollback: "回滚任务",
    history_cleanup: "历史清理任务",
    scheduled_task: "定时任务",
    skill_install: "Skill 安装任务",
  };
  const label = labels[blocker.type] ?? `后台活动（${blocker.type}）`;
  return `${blocker.count} 个${label}正在执行，请先停止后再迁移。`;
}
