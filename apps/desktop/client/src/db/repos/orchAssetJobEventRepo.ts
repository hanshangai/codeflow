import crypto from "node:crypto";

import type { AssetGenerationJobId, AssetJobEventRecord, AssetJobEventType } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 资产草案任务事件仓储。 */
export class OrchAssetJobEventRepo {
  constructor(private readonly db: SqliteDb) {}

  append(input: Omit<AssetJobEventRecord, "id" | "createdAt"> & { createdAt?: number }): AssetJobEventRecord {
    const id = crypto.randomUUID();
    const createdAt = Number(input.createdAt ?? Date.now());
    this.db
      .prepare(
        `INSERT INTO orch_asset_job_events (id, job_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, String(input.jobId), String(input.type), String(input.payloadJson), createdAt);
    return {
      id,
      jobId: String(input.jobId) as AssetGenerationJobId,
      type: String(input.type) as AssetJobEventType,
      payloadJson: String(input.payloadJson),
      createdAt,
    };
  }

  listByJob(jobId: AssetGenerationJobId, opts?: { limit?: number }): AssetJobEventRecord[] {
    const limit = Math.max(1, Number(opts?.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT id, job_id, type, payload_json, created_at
         FROM orch_asset_job_events
         WHERE job_id = ?
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(String(jobId), limit) as any[];
    return rows.map(rowToEvent);
  }

  listRecentByJob(jobId: AssetGenerationJobId, limit = 20): AssetJobEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, type, payload_json, created_at
         FROM orch_asset_job_events
         WHERE job_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(String(jobId), Math.max(1, limit)) as any[];
    return rows.map(rowToEvent).reverse();
  }
}

function rowToEvent(row: any): AssetJobEventRecord {
  return {
    id: String(row.id),
    jobId: String(row.job_id) as AssetGenerationJobId,
    type: String(row.type) as AssetJobEventType,
    payloadJson: String(row.payload_json ?? "{}"),
    createdAt: Number(row.created_at ?? 0),
  };
}

