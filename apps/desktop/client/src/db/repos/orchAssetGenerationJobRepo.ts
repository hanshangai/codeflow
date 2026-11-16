import crypto from "node:crypto";

import type {
  AssetDraftId,
  AssetGenerationJob,
  AssetGenerationFailure,
  AssetGenerationInteractionRequest,
  AssetGenerationJobStatus,
  AssetGenerationProgress,
  AssetVersionId,
  AssetKind,
  ThreadId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

const ACTIVE_JOB_STATUSES: AssetGenerationJobStatus[] = [
  "queued",
  "planning",
  "collecting_context",
  "generating",
  "validating",
  "awaiting_input",
  "awaiting_review",
];

export type AssetGenerationJobPatch = {
  status?: AssetGenerationJobStatus;
  progress?: AssetGenerationProgress | null;
  failure?: AssetGenerationFailure | null;
  draftId?: AssetDraftId | null;
  threadId?: ThreadId | null;
  requestJson?: string | null;
  interactionRequest?: AssetGenerationInteractionRequest | null;
};

export type AssetGenerationJobTransition = {
  previous: AssetGenerationJob;
  current: AssetGenerationJob;
};

/** 资产草案生成任务仓储。 */
export class OrchAssetGenerationJobRepo {
  constructor(private readonly db: SqliteDb) {}

  create(input: Omit<AssetGenerationJob, "id" | "createdAt" | "updatedAt">): AssetGenerationJob {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO orch_asset_generation_jobs (
          id, workspace_id, asset_kind, mode, status, target_asset_id,
          client_request_id, base_version_id, draft_id, thread_id,
          prompt, request_json, interaction_json, progress_json, failure_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(input.workspaceId),
        String(input.assetKind),
        String(input.mode),
        String(input.status),
        input.targetAssetId ? String(input.targetAssetId) : null,
        nullableString(input.clientRequestId),
        nullableString(input.baseVersionId),
        nullableString(input.draftId),
        nullableString(input.threadId),
        String(input.prompt ?? ""),
        nullableString(input.requestJson),
        input.interactionRequest ? JSON.stringify(input.interactionRequest) : null,
        input.progress ? JSON.stringify(input.progress) : null,
        input.failure ? JSON.stringify(input.failure) : null,
        now,
        now,
      );
    return {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    };
  }

  get(id: string): AssetGenerationJob | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                client_request_id, base_version_id, draft_id, thread_id,
                prompt, request_json, interaction_json, progress_json, failure_json, created_at, updated_at
         FROM orch_asset_generation_jobs
         WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    return row ? rowToJob(row) : null;
  }

  findByClientRequestId(workspaceId: WorkspaceId, clientRequestId: string): AssetGenerationJob | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                client_request_id, base_version_id, draft_id, thread_id,
                prompt, request_json, interaction_json, progress_json, failure_json, created_at, updated_at
         FROM orch_asset_generation_jobs
         WHERE workspace_id = ? AND client_request_id = ?
         LIMIT 1`,
      )
      .get(String(workspaceId), String(clientRequestId)) as any | undefined;
    return row ? rowToJob(row) : null;
  }

  /** 按执行 thread 反查最近的草案任务，用于助手会话续写。 */
  findLatestByThreadId(workspaceId: WorkspaceId, threadId: ThreadId): AssetGenerationJob | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                client_request_id, base_version_id, draft_id, thread_id,
                prompt, request_json, interaction_json, progress_json, failure_json, created_at, updated_at
         FROM orch_asset_generation_jobs
         WHERE workspace_id = ? AND thread_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(String(workspaceId), String(threadId)) as any | undefined;
    return row ? rowToJob(row) : null;
  }

  findActiveConflict(workspaceId: WorkspaceId, assetKind: Extract<AssetKind, "role" | "skill">, mode: "create" | "revise", targetAssetId?: string | null): AssetGenerationJob | null {
    const placeholders = ACTIVE_JOB_STATUSES.map(() => "?").join(", ");
    const params: unknown[] = [String(workspaceId), ...ACTIVE_JOB_STATUSES];
    let where = `workspace_id = ? AND status IN (${placeholders}) AND asset_kind = ? AND mode = ?`;
    params.push(assetKind, mode);
    if (mode === "revise") {
      where += " AND target_asset_id = ?";
      params.push(String(targetAssetId ?? ""));
    }
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                client_request_id, base_version_id, draft_id, thread_id,
                prompt, request_json, interaction_json, progress_json, failure_json, created_at, updated_at
         FROM orch_asset_generation_jobs
         WHERE ${where}
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(...params) as any | undefined;
    return row ? rowToJob(row) : null;
  }

  listByWorkspace(workspaceId: WorkspaceId, opts?: { limit?: number }): AssetGenerationJob[] {
    const limit = Number(opts?.limit ?? 50);
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                client_request_id, base_version_id, draft_id, thread_id,
                prompt, request_json, interaction_json, progress_json, failure_json, created_at, updated_at
         FROM orch_asset_generation_jobs
         WHERE workspace_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(String(workspaceId), limit > 0 ? limit : 50) as any[];
    return rows.map(rowToJob);
  }

  /** 列出指定状态的任务，供启动恢复扫描非耐久执行态。 */
  listByStatuses(statuses: readonly AssetGenerationJobStatus[]): AssetGenerationJob[] {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                client_request_id, base_version_id, draft_id, thread_id,
                prompt, request_json, interaction_json, progress_json, failure_json, created_at, updated_at
         FROM orch_asset_generation_jobs
         WHERE status IN (${placeholders})
         ORDER BY updated_at ASC, id ASC`,
      )
      .all(...statuses) as any[];
    return rows.map(rowToJob);
  }

  /** 删除草案任务；关联草案和事件依赖外键级联清理。 */
  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM orch_asset_generation_jobs WHERE id = ?")
      .run(String(id));
    return (result.changes ?? 0) > 0;
  }

  updateStatus(id: string, status: AssetGenerationJobStatus, progress?: AssetGenerationProgress | null): AssetGenerationJob | null {
    return this.patch(id, {
      status,
      progress,
    });
  }

  updateProgress(id: string, progress: AssetGenerationProgress | null): AssetGenerationJob | null {
    return this.patch(id, { progress });
  }

  attachDraft(id: string, draftId: AssetDraftId): AssetGenerationJob | null {
    return this.patch(id, { draftId: String(draftId) });
  }

  clearDraft(id: string): AssetGenerationJob | null {
    return this.patch(id, { draftId: null });
  }

  attachThread(id: string, threadId: ThreadId | null): AssetGenerationJob | null {
    return this.patch(id, { threadId: nullableString(threadId) });
  }

  updateFailure(id: string, failure: AssetGenerationFailure | null): AssetGenerationJob | null {
    return this.patch(id, { failure });
  }

  updateInteraction(id: string, interaction: AssetGenerationInteractionRequest | null): AssetGenerationJob | null {
    return this.patch(id, { interactionRequest: interaction });
  }

  updateRequestJson(id: string, requestJson: string | null): AssetGenerationJob | null {
    return this.patch(id, { requestJson });
  }

  /** 仅当任务仍处于预期状态时原子写入补丁，防止取消后的迟到回调覆盖终态。 */
  patchIfStatus(
    id: string,
    expectedStatuses: readonly AssetGenerationJobStatus[],
    patch: AssetGenerationJobPatch,
  ): AssetGenerationJobTransition | null {
    const current = this.get(id);
    if (!current || !expectedStatuses.includes(current.status)) return null;
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
    const result = this.db
      .prepare(
        `UPDATE orch_asset_generation_jobs
         SET status = ?,
             progress_json = ?,
             failure_json = ?,
             draft_id = ?,
             thread_id = ?,
             request_json = ?,
             interaction_json = ?,
             updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        String(patch.status ?? current.status),
        patch.progress === undefined ? serializeJson(current.progress) : serializeJson(patch.progress),
        patch.failure === undefined ? serializeJson(current.failure) : serializeJson(patch.failure),
        patch.draftId === undefined ? nullableString(current.draftId) : nullableString(patch.draftId),
        patch.threadId === undefined ? nullableString(current.threadId) : nullableString(patch.threadId),
        patch.requestJson === undefined ? nullableString(current.requestJson) : nullableString(patch.requestJson),
        patch.interactionRequest === undefined
          ? serializeJson(current.interactionRequest)
          : serializeJson(patch.interactionRequest),
        updatedAt,
        String(id),
        String(current.status),
      );
    if ((result.changes ?? 0) === 0) return null;
    const next = this.get(id);
    if (!next) throw new Error(`资产草案任务状态更新后丢失：${id}`);
    return { previous: current, current: next };
  }

  /** 兼容旧调用的无条件补丁；内部仍按读取到的当前状态执行 CAS。 */
  private patch(
    id: string,
    patch: AssetGenerationJobPatch,
  ): AssetGenerationJob | null {
    const current = this.get(id);
    if (!current) return null;
    return this.patchIfStatus(id, [current.status], patch)?.current ?? null;
  }
}

function rowToJob(row: any): AssetGenerationJob {
  const assetKind = String(row.asset_kind ?? "role") === "skill" ? "skill" : "role";
  return {
    id: String(row.id),
    workspaceId: row.workspace_id as WorkspaceId,
    assetKind,
    mode: row.mode === "revise" ? "revise" : "create",
    status: row.status as AssetGenerationJobStatus,
    targetAssetId: row.target_asset_id ? String(row.target_asset_id) : null,
    clientRequestId: nullableString(row.client_request_id),
    baseVersionId: row.base_version_id ? (String(row.base_version_id) as AssetVersionId) : null,
    draftId: row.draft_id ? (String(row.draft_id) as AssetDraftId) : null,
    threadId: row.thread_id ? (String(row.thread_id) as ThreadId) : null,
    prompt: String(row.prompt ?? ""),
    requestJson: nullableString(row.request_json),
    interactionRequest: safeParseJson<AssetGenerationInteractionRequest | null>(row.interaction_json, null),
    progress: safeParseJson<AssetGenerationProgress | null>(row.progress_json, null),
    failure: safeParseJson<AssetGenerationFailure | null>(row.failure_json, null),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

