import type { OrchestrationId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type OrchGateEvaluationRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type OrchGateEvaluationRun = {
  id: string;
  instanceId: OrchestrationId;
  nodeId: string;
  nodeAttemptId: string;
  artifactId: string;
  criteriaHash: string | null;
  artifactHash: string | null;
  status: OrchGateEvaluationRunStatus;
  statusVersion: number;
  activeCallId: string | null;
  activeThreadId: string | null;
  activeTurnId: string | null;
  retryOrdinal: number;
  promptSnapshotId: string | null;
  resultsJson: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type RunRow = {
  id: string; instance_id: string; node_id: string; node_attempt_id: string; artifact_id: string; criteria_hash: string | null; artifact_hash: string | null;
  status: string; status_version: number; active_call_id: string | null; active_thread_id: string | null;
  active_turn_id: string | null; retry_ordinal: number; prompt_snapshot_id: string | null; results_json: string | null; last_error_code: string | null; last_error: string | null; started_at: number | null; finished_at: number | null;
  created_at: number; updated_at: number;
};

/** 保存 AI 门禁逻辑运行状态，并以版本号约束迟到调用更新。 */
export class OrchGateEvaluationRunRepo {
  constructor(private readonly db: SqliteDb) {}

  get(id: string): OrchGateEvaluationRun | null {
    const row = this.db.prepare(`${selectRunSql()} WHERE id = ?`).get(String(id)) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  create(input: Pick<OrchGateEvaluationRun, "id" | "instanceId" | "nodeId" | "nodeAttemptId" | "artifactId" | "criteriaHash" | "artifactHash">): OrchGateEvaluationRun {
    const now = Date.now();
    this.db.prepare(`INSERT INTO orch_gate_evaluation_runs
      (id, instance_id, node_id, node_attempt_id, artifact_id, criteria_hash, artifact_hash, status, status_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
      ON CONFLICT(node_attempt_id, artifact_id, criteria_hash, artifact_hash) DO NOTHING`).run(
      input.id, String(input.instanceId), input.nodeId, input.nodeAttemptId, input.artifactId, input.criteriaHash, input.artifactHash, now, now,
    );
    const row = this.db.prepare(`${selectRunSql()} WHERE node_attempt_id = ? AND artifact_id = ? AND criteria_hash IS ? AND artifact_hash IS ?`).get(input.nodeAttemptId, input.artifactId, input.criteriaHash, input.artifactHash) as RunRow | undefined;
    if (!row) throw new Error(`无法读取 AI 门禁逻辑运行：${input.id}`);
    return toRun(row);
  }

  /** 仅在 expectedVersion 匹配时推进状态，返回是否成功。 */
  updateCas(id: string, expectedVersion: number, patch: Partial<Pick<OrchGateEvaluationRun, "status" | "activeCallId" | "activeThreadId" | "activeTurnId" | "retryOrdinal" | "promptSnapshotId" | "resultsJson" | "lastErrorCode" | "lastError" | "startedAt" | "finishedAt">>): boolean {
    const columnMap = { status: "status", activeCallId: "active_call_id", activeThreadId: "active_thread_id", activeTurnId: "active_turn_id", retryOrdinal: "retry_ordinal", promptSnapshotId: "prompt_snapshot_id", resultsJson: "results_json", lastErrorCode: "last_error_code", lastError: "last_error", startedAt: "started_at", finishedAt: "finished_at" } as const;
    const fields = Object.entries(patch).filter(([key, value]) => value !== undefined && key in columnMap);
    if (!fields.length) return false;
    const columns = fields.map(([key]) => `${columnMap[key as keyof typeof columnMap]} = ?`).join(", ");
    const values = fields.map(([, value]) => value ?? null);
    const result = this.db.prepare(`UPDATE orch_gate_evaluation_runs SET ${columns}, status_version = status_version + 1, updated_at = ? WHERE id = ? AND status_version = ?`).run(...values, Date.now(), String(id), expectedVersion);
    return Number(result.changes ?? 0) === 1;
  }

  listRecoverable(instanceId: OrchestrationId): OrchGateEvaluationRun[] {
    const rows = this.db.prepare(`${selectRunSql()} WHERE instance_id = ? AND status IN ('pending', 'running') ORDER BY updated_at ASC`).all(String(instanceId)) as RunRow[];
    return rows.map(toRun);
  }
}

function selectRunSql(): string {
  return `SELECT id, instance_id, node_id, node_attempt_id, artifact_id, criteria_hash, artifact_hash, status, status_version,
    active_call_id, active_thread_id, active_turn_id, retry_ordinal, prompt_snapshot_id, results_json, last_error_code, last_error, started_at, finished_at, created_at, updated_at
    FROM orch_gate_evaluation_runs`;
}

function toRun(row: RunRow): OrchGateEvaluationRun {
  return {
    id: row.id, instanceId: row.instance_id as OrchestrationId, nodeId: row.node_id, nodeAttemptId: row.node_attempt_id,
    artifactId: row.artifact_id, criteriaHash: row.criteria_hash, artifactHash: row.artifact_hash, status: row.status as OrchGateEvaluationRunStatus, statusVersion: Number(row.status_version),
    activeCallId: row.active_call_id, activeThreadId: row.active_thread_id, activeTurnId: row.active_turn_id, retryOrdinal: Number(row.retry_ordinal ?? 0), promptSnapshotId: row.prompt_snapshot_id, resultsJson: row.results_json,
    lastErrorCode: row.last_error_code, lastError: row.last_error, startedAt: row.started_at, finishedAt: row.finished_at, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
