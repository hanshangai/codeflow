import crypto from "node:crypto";

import type {
  AssetDraft,
  AssetDraftEngineInfo,
  AssetDraftStatus,
  AssetValidationIssue,
  WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 资产草案仓储。 */
export class OrchAssetDraftRepo {
  constructor(private readonly db: SqliteDb) {}

  create(input: Omit<AssetDraft, "id" | "createdAt" | "updatedAt">): AssetDraft {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO orch_asset_drafts (
          id, workspace_id, asset_kind, mode, status, target_asset_id,
          base_version_id, source_job_id, prompt, payload_json,
          validation_issues_json, rationale, engine_info_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(input.workspaceId),
        String(input.assetKind),
        String(input.mode),
        String(input.status),
        nullableString(input.targetAssetId),
        nullableString(input.baseVersionId),
        String(input.sourceJobId),
        String(input.prompt ?? ""),
        String(input.payloadJson ?? ""),
        input.validationIssues ? JSON.stringify(input.validationIssues) : null,
        nullableString(input.rationale),
        input.engineInfo ? JSON.stringify(input.engineInfo) : null,
        now,
        now,
      );
    return { ...input, id, createdAt: now, updatedAt: now };
  }

  get(id: string): AssetDraft | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                base_version_id, source_job_id, prompt, payload_json,
                validation_issues_json, rationale, engine_info_json, created_at, updated_at
         FROM orch_asset_drafts
         WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    return row ? rowToDraft(row) : null;
  }

  listByWorkspace(workspaceId: WorkspaceId, opts?: { limit?: number }): AssetDraft[] {
    const limit = Math.max(1, Number(opts?.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                base_version_id, source_job_id, prompt, payload_json,
                validation_issues_json, rationale, engine_info_json, created_at, updated_at
         FROM orch_asset_drafts
         WHERE workspace_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(String(workspaceId), limit) as any[];
    return rows.map(rowToDraft);
  }

  listByTarget(workspaceId: WorkspaceId, assetKind: AssetDraft["assetKind"], targetAssetId: string): AssetDraft[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, mode, status, target_asset_id,
                base_version_id, source_job_id, prompt, payload_json,
                validation_issues_json, rationale, engine_info_json, created_at, updated_at
         FROM orch_asset_drafts
         WHERE workspace_id = ? AND asset_kind = ? AND target_asset_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(String(workspaceId), String(assetKind), String(targetAssetId)) as any[];
    return rows.map(rowToDraft);
  }

  updateStatus(id: string, status: AssetDraftStatus): AssetDraft | null {
    return this.patch(id, { status });
  }

  updateValidationIssues(id: string, issues: AssetValidationIssue[] | null): AssetDraft | null {
    return this.patch(id, { validationIssuesJson: issues ? JSON.stringify(issues) : null });
  }

  private patch(id: string, patch: { status?: AssetDraftStatus; validationIssuesJson?: string | null }): AssetDraft | null {
    const current = this.get(id);
    if (!current) return null;
    const updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE orch_asset_drafts
         SET status = ?, validation_issues_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        String(patch.status ?? current.status),
        patch.validationIssuesJson === undefined
          ? current.validationIssues
            ? JSON.stringify(current.validationIssues)
            : null
          : patch.validationIssuesJson,
        updatedAt,
        String(id),
      );
    return this.get(id);
  }
}

function rowToDraft(row: any): AssetDraft {
  return {
    id: String(row.id),
    workspaceId: row.workspace_id as WorkspaceId,
    assetKind: String(row.asset_kind) as AssetDraft["assetKind"],
    mode: row.mode === "revise" ? "revise" : "create",
    status: String(row.status) as AssetDraftStatus,
    targetAssetId: nullableString(row.target_asset_id),
    baseVersionId: nullableString(row.base_version_id),
    sourceJobId: String(row.source_job_id),
    prompt: String(row.prompt ?? ""),
    payloadJson: String(row.payload_json ?? ""),
    validationIssues: safeParseJson<AssetValidationIssue[] | null>(row.validation_issues_json, null),
    rationale: nullableString(row.rationale),
    engineInfo: safeParseJson<AssetDraftEngineInfo | null>(row.engine_info_json, null),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

