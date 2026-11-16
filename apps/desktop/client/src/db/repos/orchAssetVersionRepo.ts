import crypto from "node:crypto";

import type { AssetDraftId, AssetKind, AssetVersion, AssetVersionId, WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 资产正式版本仓储。 */
export class OrchAssetVersionRepo {
  constructor(private readonly db: SqliteDb) {}

  create(input: Omit<AssetVersion, "id" | "createdAt">): AssetVersion {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO orch_asset_versions (
          id, workspace_id, asset_kind, asset_id, version, source_draft_id, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(input.workspaceId),
        String(input.assetKind),
        String(input.assetId),
        Number(input.version),
        nullableString(input.sourceDraftId),
        String(input.snapshotJson ?? ""),
        createdAt,
      );
    return { ...input, id: id as AssetVersionId, createdAt };
  }

  listByAsset(workspaceId: WorkspaceId, assetKind: AssetKind, assetId: string): AssetVersion[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, asset_id, version, source_draft_id, snapshot_json, created_at
         FROM orch_asset_versions
         WHERE workspace_id = ? AND asset_kind = ? AND asset_id = ?
         ORDER BY version DESC`,
      )
      .all(String(workspaceId), String(assetKind), String(assetId)) as any[];
    return rows.map(rowToVersion);
  }

  latestVersion(workspaceId: WorkspaceId, assetKind: AssetKind, assetId: string): AssetVersion | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, asset_id, version, source_draft_id, snapshot_json, created_at
         FROM orch_asset_versions
         WHERE workspace_id = ? AND asset_kind = ? AND asset_id = ?
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get(String(workspaceId), String(assetKind), String(assetId)) as any | undefined;
    return row ? rowToVersion(row) : null;
  }

  findBySourceDraftId(draftId: AssetDraftId): AssetVersion | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, asset_kind, asset_id, version, source_draft_id, snapshot_json, created_at
         FROM orch_asset_versions
         WHERE source_draft_id = ?
         LIMIT 1`,
      )
      .get(String(draftId)) as any | undefined;
    return row ? rowToVersion(row) : null;
  }
}

function rowToVersion(row: any): AssetVersion {
  return {
    id: String(row.id) as AssetVersionId,
    workspaceId: row.workspace_id as WorkspaceId,
    assetKind: String(row.asset_kind) as AssetKind,
    assetId: String(row.asset_id),
    version: Number(row.version ?? 0),
    sourceDraftId: row.source_draft_id ? (String(row.source_draft_id) as AssetDraftId) : null,
    snapshotJson: String(row.snapshot_json ?? "{}"),
    createdAt: Number(row.created_at ?? 0),
  };
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

