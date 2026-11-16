import crypto from "node:crypto";

import type { NodeFinalAnswerPayload, OrchestrationId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type OrchNodeAttemptStatus =
  | "running"
  | "result-submitted"
  | "finalizing"
  | "completed"
  | "waiting-approval"
  | "waiting-feedback"
  | "rework"
  | "failed"
  | "skipped"
  | "cancelled"
  | "invalidated";

export type OrchNodeAttempt = {
  id: string;
  instanceId: OrchestrationId;
  nodeId: string;
  attemptNo: number;
  status: OrchNodeAttemptStatus;
  threadId: string | null;
  turnId: string | null;
  submission: NodeFinalAnswerPayload | null;
  submissionHash: string | null;
  responseText: string | null;
  artifactId: string | null;
  lastError: string | null;
  submittedAt: number | null;
  finalizedAt: number | null;
  invalidatedAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};

type AttemptRow = {
  id: string;
  instance_id: string;
  node_id: string;
  attempt_no: number;
  status: string;
  thread_id: string | null;
  turn_id: string | null;
  submission_json: string | null;
  submission_hash: string | null;
  response_text: string | null;
  artifact_id: string | null;
  last_error: string | null;
  submitted_at: number | null;
  finalized_at: number | null;
  invalidated_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};

const ACTIVE_STATUSES = ["running", "result-submitted", "finalizing"] as const;
const FINAL_STATUSES = new Set<OrchNodeAttemptStatus>([
  "completed",
  "waiting-approval",
  "waiting-feedback",
  "rework",
  "failed",
  "skipped",
  "cancelled",
]);

/** 节点 Attempt 仓储：保存提交真相，并以 CAS 约束同节点并发收尾。 */
export class OrchNodeAttemptRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 按 Attempt ID 读取完整记录。 */
  get(id: string): OrchNodeAttempt | null {
    const row = this.db.prepare(`${selectAttemptSql()} WHERE id = ?`).get(String(id)) as AttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  /** 读取节点最近一次 Attempt。 */
  getLatestByNode(instanceId: OrchestrationId, nodeId: string): OrchNodeAttempt | null {
    const row = this.db
      .prepare(`${selectAttemptSql()} WHERE instance_id = ? AND node_id = ? ORDER BY attempt_no DESC LIMIT 1`)
      .get(String(instanceId), String(nodeId)) as AttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  /** 列出实例中已提交但尚未收敛的 Attempt，供 Client 重启恢复。 */
  listRecoverableByInstance(instanceId: OrchestrationId): OrchNodeAttempt[] {
    const rows = this.db
      .prepare(`${selectAttemptSql()} WHERE instance_id = ? AND status IN ('result-submitted', 'finalizing') ORDER BY updated_at ASC`)
      .all(String(instanceId)) as AttemptRow[];
    return rows.map(rowToAttempt);
  }

  /** 开始同节点的新 Attempt；可在滚动升级时原位收编尚未持久化的旧执行身份。 */
  begin(input: {
    instanceId: OrchestrationId;
    nodeId: string;
    invalidationReason?: string | null;
    id?: string | null;
    attemptNo?: number | null;
  }): OrchNodeAttempt {
    const tx = this.db.transaction(() => {
      const now = Date.now();
      this.invalidateActiveByNodeInternal(input.instanceId, input.nodeId, input.invalidationReason ?? "同节点开始新 Attempt", now);
      const latest = this.getLatestByNode(input.instanceId, input.nodeId);
      const requestedAttemptNo = Number(input.attemptNo ?? 0);
      const attemptNo = Math.max(
        (latest?.attemptNo ?? 0) + 1,
        Number.isFinite(requestedAttemptNo) ? Math.max(1, Math.floor(requestedAttemptNo)) : 1,
      );
      const id = String(input.id ?? "").trim() || crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO orch_node_attempts (
          id, instance_id, node_id, attempt_no, status, thread_id, turn_id,
          submission_json, submission_hash, response_text, artifact_id, last_error,
          submitted_at, finalized_at, invalidated_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)
      `).run(id, String(input.instanceId), String(input.nodeId), attemptNo, now, now);
      const created = this.get(id);
      if (!created) throw new Error(`节点 Attempt 创建后无法读取: ${id}`);
      return created;
    });
    return tx();
  }

  /** 绑定本 Attempt 当前真实会话和 turn，后续恢复不依赖文件名或时间猜测。 */
  bindExecution(id: string, threadId: string, turnId: string): OrchNodeAttempt {
    const current = this.requireAttempt(id);
    this.assertMutable(current, "绑定执行上下文");
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE orch_node_attempts
      SET thread_id = ?, turn_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('running', 'result-submitted', 'finalizing')
    `).run(nullableText(threadId), nullableText(turnId), now, id, current.version);
    this.assertCasUpdated(result.changes, id, "绑定执行上下文");
    return this.requireAttempt(id);
  }

  /** 原子持久化节点提交；同一 Attempt 的同内容重放返回稳定 submissionId。 */
  submit(id: string, submission: NodeFinalAnswerPayload): { attempt: OrchNodeAttempt; idempotent: boolean } {
    const { submissionJson, submissionHash } = hashOrchNodeAttemptSubmission(submission);
    const tx = this.db.transaction(() => {
      const current = this.requireAttempt(id);
      if (current.submissionHash) {
        if (current.submissionHash !== submissionHash) {
          throw new Error(`节点 Attempt ${id} 已提交不同结果，拒绝覆盖`);
        }
        if (current.status === "invalidated" || current.status === "cancelled" || current.status === "failed") {
          const statusLabel = current.status === "cancelled" ? "取消" : current.status === "failed" ? "失败" : "失效";
          throw new Error(`节点 Attempt ${id} 已${statusLabel}，拒绝迟到提交`);
        }
        return { attempt: current, idempotent: true };
      }
      if (current.status !== "running") {
        throw new Error(`节点 Attempt ${id} 当前状态 ${current.status} 不允许提交结果`);
      }
      const now = Date.now();
      const result = this.db.prepare(`
        UPDATE orch_node_attempts
        SET status = 'result-submitted', submission_json = ?, submission_hash = ?, submitted_at = ?,
            last_error = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'running' AND submission_json IS NULL
      `).run(submissionJson, submissionHash, now, now, id, current.version);
      this.assertCasUpdated(result.changes, id, "持久化节点提交");
      return { attempt: this.requireAttempt(id), idempotent: false };
    });
    return tx();
  }

  /** 将同一 provider turn 已确认的提交原地写回 waiting-feedback Attempt，不创建新执行身份。 */
  submitRecoveredWaitingFeedback(input: {
    id: string;
    instanceId: OrchestrationId;
    nodeId: string;
    threadId: string;
    turnId: string;
    submission: NodeFinalAnswerPayload;
    responseText: string;
  }): { attempt: OrchNodeAttempt; idempotent: boolean } {
    const { submissionJson, submissionHash } = hashOrchNodeAttemptSubmission(input.submission);
    const tx = this.db.transaction(() => {
      const current = this.requireAttempt(input.id);
      this.assertRecoveredExecutionScope(current, input);
      if (current.submissionHash) {
        if (current.submissionHash !== submissionHash) {
          throw new Error(`节点 Attempt ${input.id} 已提交不同恢复结果，拒绝覆盖`);
        }
        if (current.status === "invalidated" || current.status === "cancelled" || current.status === "failed") {
          throw new Error(`节点 Attempt ${input.id} 已收敛为 ${current.status}，拒绝恢复提交`);
        }
        return { attempt: current, idempotent: true };
      }
      if (current.status !== "waiting-feedback" || !current.finalizedAt || current.invalidatedAt) {
        throw new Error(`节点 Attempt ${input.id} 当前状态 ${current.status} 不允许原地恢复提交`);
      }
      const latest = this.getLatestByNode(input.instanceId, input.nodeId);
      if (!latest || latest.id !== current.id) {
        throw new Error(`节点 Attempt ${input.id} 已不是当前节点最新执行，拒绝恢复提交`);
      }
      const now = Date.now();
      const result = this.db.prepare(`
        UPDATE orch_node_attempts
        SET status = 'result-submitted', submission_json = ?, submission_hash = ?, response_text = ?,
            submitted_at = ?, finalized_at = NULL, last_error = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND instance_id = ? AND node_id = ?
          AND thread_id = ? AND turn_id = ? AND status = 'waiting-feedback'
          AND submission_json IS NULL AND submission_hash IS NULL
          AND finalized_at IS NOT NULL AND invalidated_at IS NULL
      `).run(
        submissionJson,
        submissionHash,
        String(input.responseText ?? ""),
        now,
        now,
        current.id,
        current.version,
        String(input.instanceId),
        String(input.nodeId),
        String(input.threadId),
        String(input.turnId),
      );
      this.assertCasUpdated(result.changes, current.id, "原地恢复节点提交");
      return { attempt: this.requireAttempt(current.id), idempotent: false };
    });
    return tx();
  }

  /** 把已提交 Attempt 切入收尾；重复调用保持幂等。 */
  markFinalizing(id: string): { attempt: OrchNodeAttempt; alreadyFinalized: boolean } {
    const current = this.requireAttempt(id);
    if (FINAL_STATUSES.has(current.status)) return { attempt: current, alreadyFinalized: true };
    if (current.status === "finalizing") return { attempt: current, alreadyFinalized: false };
    if (current.status !== "result-submitted" || !current.submission) {
      throw new Error(`节点 Attempt ${id} 尚无有效提交，不能进入收尾`);
    }
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE orch_node_attempts
      SET status = 'finalizing', last_error = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'result-submitted'
    `).run(now, id, current.version);
    this.assertCasUpdated(result.changes, id, "进入节点收尾");
    return { attempt: this.requireAttempt(id), alreadyFinalized: false };
  }

  /** 记录会话最终文本；提交本身已先独立持久化。 */
  saveResponseText(id: string, responseText: string): OrchNodeAttempt {
    const current = this.requireAttempt(id);
    if (current.status === "invalidated" || current.status === "cancelled") return current;
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE orch_node_attempts
      SET response_text = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(String(responseText ?? ""), now, id, current.version);
    this.assertCasUpdated(result.changes, id, "保存节点响应文本");
    return this.requireAttempt(id);
  }

  /** 绑定本 Attempt 生成的唯一 Artifact。 */
  attachArtifact(id: string, artifactId: string): OrchNodeAttempt {
    const current = this.requireAttempt(id);
    if (current.artifactId) {
      if (current.artifactId !== artifactId) throw new Error(`节点 Attempt ${id} 已绑定其他 Artifact`);
      return current;
    }
    this.assertMutable(current, "绑定 Artifact");
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE orch_node_attempts
      SET artifact_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND artifact_id IS NULL
    `).run(String(artifactId), now, id, current.version);
    this.assertCasUpdated(result.changes, id, "绑定 Artifact");
    return this.requireAttempt(id);
  }

  /** 将 Attempt 收敛到节点终态；同终态重放幂等，冲突终态显式失败。 */
  markTerminal(id: string, status: Extract<OrchNodeAttemptStatus, "completed" | "waiting-approval" | "waiting-feedback" | "rework" | "failed" | "skipped" | "cancelled">, error?: string | null): OrchNodeAttempt {
    const current = this.requireAttempt(id);
    if (current.status === status && current.finalizedAt) return current;
    if (FINAL_STATUSES.has(current.status) || current.status === "invalidated") {
      throw new Error(`节点 Attempt ${id} 已收敛为 ${current.status}，不能改写为 ${status}`);
    }
    if (current.status !== "finalizing" && current.status !== "result-submitted" && current.status !== "running") {
      throw new Error(`节点 Attempt ${id} 当前状态 ${current.status} 不能收敛为 ${status}`);
    }
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE orch_node_attempts
      SET status = ?, last_error = ?, finalized_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('running', 'result-submitted', 'finalizing')
    `).run(status, nullableText(error), now, now, id, current.version);
    this.assertCasUpdated(result.changes, id, `收敛节点 Attempt 为 ${status}`);
    return this.requireAttempt(id);
  }

  /** 显式失效同节点尚未收敛的 Attempt，供重跑、暂停中断和定向返工使用。 */
  invalidateActiveByNode(instanceId: OrchestrationId, nodeId: string, reason: string): number {
    return this.invalidateActiveByNodeInternal(instanceId, nodeId, reason, Date.now());
  }

  /** 取消实例内所有活动 Attempt，禁止取消后的迟到结果写回。 */
  cancelActiveByInstance(instanceId: OrchestrationId, reason: string): number {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE orch_node_attempts
      SET status = 'cancelled', last_error = ?, finalized_at = ?, version = version + 1, updated_at = ?
      WHERE instance_id = ? AND status IN ('running', 'result-submitted', 'finalizing')
    `).run(String(reason), now, now, String(instanceId));
    return Number(result.changes ?? 0);
  }

  /** 查询 Attempt 是否仍是该节点最新且可继续写回的执行。 */
  isCurrent(instanceId: OrchestrationId, nodeId: string, attemptId: string): boolean {
    const latest = this.getLatestByNode(instanceId, nodeId);
    return Boolean(latest && latest.id === attemptId && ACTIVE_STATUSES.includes(latest.status as typeof ACTIVE_STATUSES[number]));
  }

  private invalidateActiveByNodeInternal(instanceId: OrchestrationId, nodeId: string, reason: string, now: number): number {
    const result = this.db.prepare(`
      UPDATE orch_node_attempts
      SET status = 'invalidated', last_error = ?, invalidated_at = ?, version = version + 1, updated_at = ?
      WHERE instance_id = ? AND node_id = ? AND status IN ('running', 'result-submitted', 'finalizing')
    `).run(String(reason), now, now, String(instanceId), String(nodeId));
    return Number(result.changes ?? 0);
  }

  private requireAttempt(id: string): OrchNodeAttempt {
    const attempt = this.get(id);
    if (!attempt) throw new Error(`节点 Attempt 不存在: ${id}`);
    return attempt;
  }

  private assertMutable(attempt: OrchNodeAttempt, action: string): void {
    if (!ACTIVE_STATUSES.includes(attempt.status as typeof ACTIVE_STATUSES[number])) {
      throw new Error(`节点 Attempt ${attempt.id} 当前状态 ${attempt.status} 不允许${action}`);
    }
  }

  /** 核对恢复提交仍归属原 Attempt 的持久化执行边界。 */
  private assertRecoveredExecutionScope(
    attempt: OrchNodeAttempt,
    input: Pick<OrchNodeAttempt, "instanceId" | "nodeId" | "threadId" | "turnId">,
  ): void {
    if (attempt.instanceId !== input.instanceId
      || attempt.nodeId !== input.nodeId
      || String(attempt.threadId ?? "") !== String(input.threadId ?? "")
      || String(attempt.turnId ?? "") !== String(input.turnId ?? "")) {
      throw new Error(`节点 Attempt ${attempt.id} 的恢复执行边界不匹配`);
    }
  }

  private assertCasUpdated(changes: number | bigint | undefined, id: string, action: string): void {
    if (Number(changes ?? 0) === 1) return;
    const latest = this.get(id);
    throw new Error(`${action}发生并发冲突: attemptId=${id}, latestStatus=${latest?.status ?? "missing"}, latestVersion=${latest?.version ?? "missing"}`);
  }
}

function selectAttemptSql(): string {
  return `SELECT id, instance_id, node_id, attempt_no, status, thread_id, turn_id,
                 submission_json, submission_hash, response_text, artifact_id, last_error,
                 submitted_at, finalized_at, invalidated_at, version, created_at, updated_at
          FROM orch_node_attempts`;
}

function rowToAttempt(row: AttemptRow): OrchNodeAttempt {
  return {
    id: String(row.id),
    instanceId: String(row.instance_id) as OrchestrationId,
    nodeId: String(row.node_id),
    attemptNo: Number(row.attempt_no),
    status: normalizeAttemptStatus(row.status),
    threadId: nullableText(row.thread_id),
    turnId: nullableText(row.turn_id),
    submission: parseSubmission(row.submission_json),
    submissionHash: nullableText(row.submission_hash),
    responseText: row.response_text == null ? null : String(row.response_text),
    artifactId: nullableText(row.artifact_id),
    lastError: nullableText(row.last_error),
    submittedAt: nullableNumber(row.submitted_at),
    finalizedAt: nullableNumber(row.finalized_at),
    invalidatedAt: nullableNumber(row.invalidated_at),
    version: Number(row.version ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** 使用 Attempt 仓储唯一稳定 JSON 规则计算提交正文与 SHA256。 */
export function hashOrchNodeAttemptSubmission(submission: NodeFinalAnswerPayload): {
  submissionJson: string;
  submissionHash: string;
} {
  const submissionJson = stableJson(submission);
  return {
    submissionJson,
    submissionHash: crypto.createHash("sha256").update(submissionJson, "utf8").digest("hex"),
  };
}

function parseSubmission(value: unknown): NodeFinalAnswerPayload | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return JSON.parse(raw) as NodeFinalAnswerPayload;
}

function normalizeAttemptStatus(value: unknown): OrchNodeAttemptStatus {
  const status = String(value ?? "");
  if (status === "running"
    || status === "result-submitted"
    || status === "finalizing"
    || status === "completed"
    || status === "waiting-approval"
    || status === "waiting-feedback"
    || status === "rework"
    || status === "failed"
    || status === "skipped"
    || status === "cancelled"
    || status === "invalidated") {
    return status;
  }
  throw new Error(`未知节点 Attempt 状态: ${status}`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(JSON.parse(JSON.stringify(value))));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

function nullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}
