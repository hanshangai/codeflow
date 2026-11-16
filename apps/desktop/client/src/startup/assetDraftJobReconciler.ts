import type {
  AssetDraft,
  AssetGenerationFailure,
  AssetGenerationJob,
  AssetGenerationJobStatus,
  AssetGenerationProgress,
  AssetJobFailedPayload,
  AssetJobStatusChangedPayload,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import { logger } from "../logger.js";

const NON_DURABLE_JOB_STATUSES: readonly AssetGenerationJobStatus[] = [
  "queued",
  "planning",
  "collecting_context",
  "generating",
  "validating",
];

export type StartupAssetDraftJobReconcileResult = {
  scanned: number;
  restoredFromDraft: number;
  failed: number;
  pending: number;
};

/** 启动按工作区独立原子对账，首错停止后续工作区；已提交工作区保留。 */
export function reconcileAssetDraftJobsOnStartup(db: ClientDb): StartupAssetDraftJobReconcileResult {
  if (db.workspaceId === null) {
    const result = { scanned: 0, restoredFromDraft: 0, failed: 0, pending: 0 };
    for (const workspace of db.workspaces.list()) {
      const current = reconcileAssetDraftJobsOnStartup(db.forWorkspace(workspace.id));
      result.scanned += current.scanned;
      result.restoredFromDraft += current.restoredFromDraft;
      result.failed += current.failed;
      result.pending += current.pending;
    }
    return result;
  }
  return db.db.transaction(() => reconcileWorkspaceAssetDraftJobs(db), { mode: "immediate", requireOutermost: true })();
}

/** 同一工作区的任务状态与状态事件复用外层连接与事务。 */
function reconcileWorkspaceAssetDraftJobs(db: ClientDb): StartupAssetDraftJobReconcileResult {
  const jobs = db.orchAssetGenerationJobs.listByStatuses(NON_DURABLE_JOB_STATUSES);
  let restoredFromDraft = 0;
  let failed = 0;
  let pending = 0;

  for (const job of jobs) {
    const draft = job.draftId ? db.orchAssetDrafts.get(job.draftId) : null;
    if (draft && draft.sourceJobId === job.id && draft.workspaceId === job.workspaceId) {
      if (restoreJobFromDraft(db, job, draft)) restoredFromDraft += 1;
      continue;
    }

    const runningTurn = job.threadId
      ? db.turns.listByThread(job.threadId).find((turn) => turn.status === "started") ?? null
      : null;
    if (runningTurn) {
      pending += 1;
      logger.warn("startup-reconcile", "asset draft job still has provider-confirmed running turn", {
        jobId: job.id,
        workspaceId: job.workspaceId,
        threadId: job.threadId,
        turnId: runningTurn.turnId,
        jobStatus: job.status,
      });
      continue;
    }

    const failure = buildRestartFailure(job, Boolean(job.draftId));
    if (failInterruptedJob(db, job, failure)) failed += 1;
  }

  logger.info("startup-reconcile", "asset draft jobs reconciled", {
    scanned: jobs.length,
    restoredFromDraft,
    failed,
    pending,
  });
  return { scanned: jobs.length, restoredFromDraft, failed, pending };
}

/** 按草案耐久状态恢复任务，避免草案已落库但 job 仍显示生成中。 */
function restoreJobFromDraft(db: ClientDb, job: AssetGenerationJob, draft: AssetDraft): boolean {
  const nextStatus = draft.status;
  const progress = restoredProgress(nextStatus);
  return db.db.transaction(() => {
    const transition = db.orchAssetGenerationJobs.patchIfStatus(job.id, NON_DURABLE_JOB_STATUSES, {
      status: nextStatus,
      progress,
      failure: null,
      interactionRequest: null,
      draftId: draft.id,
    });
    if (!transition) return false;
    appendStatusChanged(db, job.id, transition.previous.status, nextStatus, progress);
    return true;
  })();
}

/** 把已失去执行回调的任务标为可重试失败，并与事件原子提交。 */
function failInterruptedJob(db: ClientDb, job: AssetGenerationJob, failure: AssetGenerationFailure): boolean {
  const progress: AssetGenerationProgress = {
    stage: "failed",
    headline: "生成任务因 Client 重启中断",
    detail: failure.message,
    percent: 100,
  };
  return db.db.transaction(() => {
    const transition = db.orchAssetGenerationJobs.patchIfStatus(job.id, NON_DURABLE_JOB_STATUSES, {
      status: "failed",
      progress,
      failure,
      interactionRequest: null,
    });
    if (!transition) return false;
    appendStatusChanged(db, job.id, transition.previous.status, "failed", progress);
    db.orchAssetJobEvents.append({
      jobId: job.id,
      type: "orch.assetDraft.failed",
      payloadJson: JSON.stringify({
        code: failure.code,
        stage: failure.stage,
        retryable: failure.retryable,
        message: failure.message,
      } satisfies AssetJobFailedPayload),
    });
    return true;
  })();
}

/** 构造重启中断失败，保留 job/thread 上下文供日志和页面重试。 */
function buildRestartFailure(job: AssetGenerationJob, missingDraft: boolean): AssetGenerationFailure {
  return {
    code: missingDraft ? "client_restarted_draft_missing" : "client_restarted",
    stage: failureStage(job.status),
    message: missingDraft
      ? "Client 重启后未找到已经记录的候选草案，本轮生成已停止。可在原会话补充说明后重试，或删除会话重新创建。"
      : "Client 在草案生成完成前重启，本轮生成已停止。可在原会话补充说明后重试，或删除会话重新创建。",
    userHint: "请补充说明后重试，或删除当前助手会话重新创建。",
    retryable: true,
    details: {
      jobId: job.id,
      threadId: job.threadId ?? null,
      previousStatus: job.status,
    },
  };
}

/** 将执行状态映射到失败阶段枚举。 */
function failureStage(status: AssetGenerationJobStatus): AssetGenerationFailure["stage"] {
  if (status === "collecting_context") return "collecting_context";
  if (status === "generating") return "generating";
  if (status === "validating") return "validating";
  return "planning";
}

/** 返回已有草案对应的稳定进度文案。 */
function restoredProgress(status: AssetDraft["status"]): AssetGenerationProgress {
  if (status === "applied") {
    return { stage: "applied", headline: "草案已应用", detail: "已从本地草案记录恢复任务状态", percent: 100 };
  }
  if (status === "rejected") {
    return { stage: "rejected", headline: "草案已拒绝", detail: "已从本地草案记录恢复任务状态", percent: 100 };
  }
  return { stage: "awaiting_review", headline: "候选草案已生成", detail: "请检查候选草案并确认是否应用", percent: 100 };
}

/** 追加标准状态事件；调用方负责事务边界。 */
function appendStatusChanged(
  db: ClientDb,
  jobId: AssetGenerationJob["id"],
  from: AssetGenerationJobStatus,
  to: AssetGenerationJobStatus,
  progress: AssetGenerationProgress,
): void {
  db.orchAssetJobEvents.append({
    jobId,
    type: "orch.assetDraft.statusChanged",
    payloadJson: JSON.stringify({
      from,
      to,
      headline: progress.headline,
      detail: progress.detail ?? null,
      percent: progress.percent ?? null,
    } satisfies AssetJobStatusChangedPayload),
  });
}
