import type {
  AssetGenerationJobStatus,
  NodeExecutionStatus,
  OrchestrationInstance,
  ThreadId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import type { ClientDbCleanupService } from "../db/clientDbCleanupService.js";
import type { OrchestrationEngine } from "../orchestration/orchestrationEngine.js";
import type { ScheduledTaskScheduler } from "../scheduled-tasks/scheduledTaskScheduler.js";
import type { TerminalManager } from "../terminal/terminalManager.js";
import type { WorkspaceOperationGate } from "./workspaceOperationGate.js";

const ACTIVE_ORCHESTRATION_NODE_STATUSES = new Set<NodeExecutionStatus>([
  "queued",
  "running",
  "result-submitted",
  "finalizing",
  "artifact-writing",
  "gate-checking",
]);
const ACTIVE_ASSET_JOB_STATUSES: AssetGenerationJobStatus[] = [
  "queued",
  "planning",
  "collecting_context",
  "generating",
  "validating",
  "awaiting_input",
  "awaiting_review",
];

export type WorkspaceMigrationActivityBlocker = {
  type: string;
  count: number;
  resourceIds: string[];
};

export type WorkspaceMigrationQueueRuntime = {
  listInFlightByWorkspace: (workspaceId: WorkspaceId) => Array<{ threadId: ThreadId; resourceId: string }>;
};

/** 汇总现有持久化与运行时事实，不维护第二套活动状态。 */
export class WorkspaceMigrationActivityInspector {
  /** 运行时owner保持不变，持久事实在inspect时按可信W固定。 */
  constructor(private readonly input: {
    db: ClientDb;
    gate: WorkspaceOperationGate;
    terminalManager?: TerminalManager | null;
    orchEngine?: OrchestrationEngine | null;
    queueRuntime?: WorkspaceMigrationQueueRuntime | null;
    scheduledTaskScheduler?: ScheduledTaskScheduler | null;
    dbCleanup?: ClientDbCleanupService | null;
    listActiveRollbackThreadIds?: () => ThreadId[];
  }) {}

  /** 返回阻止指定工作区开始迁移的全部本地活动，按类型和 ID 稳定排序。 */
  inspect(workspaceId: WorkspaceId): WorkspaceMigrationActivityBlocker[] {
    const operationId = this.input.gate.getMigrationOperationId(workspaceId);
    const orchEngine = this.input.orchEngine?.existingWorkspace
      ? this.input.orchEngine.existingWorkspace(workspaceId) : this.input.orchEngine;
    const idsByType = new Map<string, Set<string>>();
    const add = (type: string, resourceId: unknown) => {
      const normalizedId = String(resourceId ?? "").trim();
      if (!normalizedId) throw new Error(`工作区活动缺少可定位 ID：workspaceId=${workspaceId}, type=${type}`);
      const ids = idsByType.get(type) ?? new Set<string>();
      ids.add(normalizedId);
      idsByType.set(type, ids);
    };

    /** 迁移owner使用同连接只读快照，未初始化核心库时仍继续检查运行时活动。 */
    const inspectPersistent = (db: ClientDb | null): ThreadId[] => {
      if (!db) return [];
      for (const [threadId, turn] of Object.entries(db.turns.listRunningByWorkspace(workspaceId))) {
        add("turn", `${threadId}:${turn.runningTurnId}`);
      }

      for (const instance of db.orchInstances.listByWorkspace(workspaceId)) {
        if (isActiveOrchestrationInstance(instance)) add("orchestration_instance", instance.id);
      }

      const threadIds = this.listWorkspaceThreadIds(db, workspaceId);
      for (const threadId of threadIds) {
        for (const item of db.threadMessageQueue.listActiveByThread(threadId)) {
          if (item.status === "sending") add("queue_dispatch", item.id);
        }
      }
      for (const run of db.controlledExperiments.listRunningForSessionGate()) {
        if (String(run.workspaceId) === String(workspaceId)) add("controlled_experiment", run.turnId);
      }
      for (const job of db.orchAssetGenerationJobs.listByStatuses(ACTIVE_ASSET_JOB_STATUSES)) {
        if (String(job.workspaceId) === String(workspaceId)) add("asset_generation_job", job.id);
      }
      return threadIds;
    };
    const threadIds = this.input.db.withWorkspaceCoreSnapshot
      ? this.input.db.withWorkspaceCoreSnapshot(workspaceId, operationId, inspectPersistent)
      : inspectPersistent(this.input.db);
    for (const inFlight of this.input.queueRuntime?.listInFlightByWorkspace(workspaceId) ?? []) {
      add("queue_dispatch", inFlight.resourceId);
    }

    for (const terminal of this.input.terminalManager?.list(workspaceId) ?? []) {
      if (terminal.status === "running") add("terminal", terminal.id);
    }

    if (orchEngine) {
      for (const threadId of threadIds) {
        for (const service of orchEngine.listManagedServicesForThread(threadId, { visible: true, threadId })) {
          if (service.status === "starting" || service.status === "ready") add("managed_service", service.serviceId);
        }
      }
    }

    const threadIdSet = new Set(threadIds.map(String));
    for (const threadId of this.input.listActiveRollbackThreadIds?.() ?? []) {
      if (threadIdSet.has(String(threadId))) add("rollback", threadId);
    }

    if (this.input.dbCleanup?.isRunning()) add("history_cleanup", "client_db_cleanup");

    for (const task of this.input.scheduledTaskScheduler?.listRunningByWorkspace(workspaceId, operationId) ?? []) {
      add("scheduled_task", task.runId);
    }

    for (const activity of this.input.gate.listActivities(workspaceId)) add(activity.type, activity.resourceId);

    return [...idsByType.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, ids]) => {
        const resourceIds = [...ids].sort();
        return { type, count: resourceIds.length, resourceIds };
      });
  }

  /** 分页读取工作区全部 thread ID，避免活动门禁受列表页上限影响。 */
  private listWorkspaceThreadIds(db: ClientDb, workspaceId: WorkspaceId): ThreadId[] {
    const result: ThreadId[] = [];
    let cursor: string | null = null;
    do {
      const page = db.threads.listByWorkspace(workspaceId, {
        includeArchived: true,
        limit: 2_000,
        cursor,
      });
      result.push(...page.threads.map((thread) => thread.id));
      cursor = page.hasMore ? page.nextCursor : null;
      if (page.hasMore && !cursor) {
        throw new Error(`工作区 thread 分页缺少游标：workspaceId=${workspaceId}`);
      }
    } while (cursor);
    return result;
  }
}

/** 仅把真实运行中的实例或节点视为迁移阻断项，人工等待和暂停状态可随工作区迁移。 */
function isActiveOrchestrationInstance(instance: OrchestrationInstance): boolean {
  const hasActiveNode = Object.values(instance.nodeStates)
    .some((state) => ACTIVE_ORCHESTRATION_NODE_STATUSES.has(state.status));
  return hasActiveNode || instance.status === "running";
}
