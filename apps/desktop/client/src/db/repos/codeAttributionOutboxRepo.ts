import crypto from "node:crypto";

import type {
  OrchestrationMetricCodeAttributionCommitObservation,
  OrchestrationMetricCodeAttributionIngestBatchInput,
  OrchestrationMetricCodeAttributionIngestFact,
  OrchestrationMetricCodeAttributionQualityReason,
  OrchestrationMetricCodeAttributionQualityStatus,
} from "@codeflowai/shared";
import {
  ORCHESTRATION_METRIC_CODE_ATTRIBUTION_QUALITY_REASONS,
  calculateOrchestrationCodeAttributionRates,
  serializeOrchestrationCodeAttributionPayload,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CODE_ATTRIBUTION_EVIDENCE_REF_PATTERN = /^client-code-attribution:[a-f0-9]{64}$/u;
const CODE_ATTRIBUTION_LANGUAGE_PATTERN = /^[a-z][a-z0-9_+.#-]{0,31}$/u;
const MAX_EXECUTION_REFS_PER_FACT = 200;
const MAX_EXECUTION_REFS_PER_BATCH = 5_000;
const EXPIRED_BATCH_AVAILABLE_AT = Number.MAX_SAFE_INTEGER;
const PUBLIC_SYNC_FAILURE_MESSAGE = "代码归因批次同步失败，请稍后重试。";
const PUBLIC_ASSOCIATION_EXPIRED_MESSAGE = "实例关联凭证已过期或剩余有效期不足，请重新签发后重试。";

export type CodeAttributionOutboxPayload = {
  commit: OrchestrationMetricCodeAttributionCommitObservation;
  facts: OrchestrationMetricCodeAttributionIngestFact[];
};

export type CodeAttributionOutboxRecord = {
  id: string;
  sourceBatchId: string;
  workspaceId: string;
  instanceId: string;
  repository: string;
  commitSha: string;
  contentSha256: string;
  payload: CodeAttributionOutboxPayload;
  associationId: string;
  associationExpiresAt: number;
  status: "pending" | "leased" | "failed";
  attemptCount: number;
  availableAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedCodeAttributionBatch = {
  record: CodeAttributionOutboxRecord;
  batch: OrchestrationMetricCodeAttributionIngestBatchInput;
};

/** Persists source-code-free commit attribution batches with CAS leases. */
export class CodeAttributionOutboxRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 查询轮次结束时确认截止时间内事实均已收到回执，延迟重试或租约不能视为完成。 */
  assertDrained(input: { throughCreatedAt: number }): void {
    const row = this.db.prepare(`SELECT * FROM code_attribution_outbox
      WHERE created_at <= ? ORDER BY created_at ASC, id ASC LIMIT 1`)
      .get(requireTimestamp(input.throughCreatedAt, "throughCreatedAt")) as Record<string, unknown> | undefined;
    if (!row) return;
    const record = rowToRecord(row);
    throw Object.assign(outboxError("CODE_ATTRIBUTION_OUTBOX_NOT_DRAINED", "代码归因仍有未确认的同步批次"), {
      recordId: record.id, workspaceId: record.workspaceId, instanceId: record.instanceId,
      status: record.status, availableAt: record.availableAt, leaseExpiresAt: record.leaseExpiresAt,
      lastErrorCode: record.lastErrorCode,
    });
  }

  /** Inserts one immutable content identity or renews only its association proof. */
  enqueue(input: {
    id: string;
    sourceBatchId: string;
    workspaceId: string;
    instanceId: string;
    repository: string;
    commitSha: string;
    payload: CodeAttributionOutboxPayload;
    contentSha256: string;
    associationId: string;
    associationExpiresAt: number;
    now: number;
  }): { record: CodeAttributionOutboxRecord; replayed: boolean } {
    const normalized = validateEnqueueInput(input);
    return this.db.transaction(() => {
      const existing = this.findByIdentity(
        normalized.workspaceId,
        normalized.instanceId,
        normalized.repository,
        normalized.commitSha,
      );
      if (existing) {
        if (
          existing.id !== normalized.id
          || existing.sourceBatchId !== normalized.sourceBatchId
          || existing.contentSha256 !== normalized.contentSha256
          || serializePayload(existing.payload) !== normalized.payloadJson
        ) {
          throw outboxError("CODE_ATTRIBUTION_OUTBOX_CONTENT_CONFLICT", "相同 commit 归因身份的内容发生漂移");
        }
        const renewed = renewStoredAssociation(existing, normalized.associationId, normalized.associationExpiresAt, normalized.now);
        if (renewed) {
          const result = this.db.prepare(`
            UPDATE code_attribution_outbox
            SET association_id = ?, association_expires_at = ?,
                status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
                available_at = CASE WHEN status = 'failed' THEN ? ELSE available_at END,
                last_error_code = CASE WHEN status = 'failed' THEN NULL ELSE last_error_code END,
                last_error_message = CASE WHEN status = 'failed' THEN NULL ELSE last_error_message END,
                updated_at = ?
            WHERE id = ? AND content_sha256 = ?
              AND (status <> 'leased' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          `).run(
            normalized.associationId,
            normalized.associationExpiresAt,
            normalized.now,
            normalized.now,
            existing.id,
            existing.contentSha256,
            normalized.now,
          );
          if ((result.changes ?? 0) !== 1) {
            throw outboxError("CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT", "归因批次正在同步，暂不能续签关联凭证");
          }
        }
        const record = this.getRequired(existing.id);
        return { record, replayed: true };
      }

      this.db.prepare(`
        INSERT INTO code_attribution_outbox (
          id, source_batch_id, workspace_id, instance_id, repository, commit_sha,
          content_sha256, payload_json, association_id, association_expires_at,
          status, attempt_count, available_at, lease_owner, lease_expires_at,
          last_error_code, last_error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        normalized.id,
        normalized.sourceBatchId,
        normalized.workspaceId,
        normalized.instanceId,
        normalized.repository,
        normalized.commitSha,
        normalized.contentSha256,
        normalized.payloadJson,
        normalized.associationId,
        normalized.associationExpiresAt,
        normalized.now,
        normalized.now,
        normalized.now,
      );
      return { record: this.getRequired(normalized.id), replayed: false };
    })();
  }

  /** 按需求选取将过期或已过期的原批次，保留事实与原实例身份。 */
  getNextAssociationToRenew(input: { now: number; leaseMs: number }): CodeAttributionOutboxRecord | null {
    const now = requireTimestamp(input.now, "now");
    const row = this.db.prepare(`SELECT * FROM code_attribution_outbox
      WHERE association_expires_at <= ?
        AND (status <> 'leased' OR lease_expires_at <= ?)
        AND (available_at <= ? OR last_error_code IN ('CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED', 'ORCH_METRICS_DELIVERY_ASSOCIATION_EXPIRED'))
      ORDER BY created_at ASC, id ASC LIMIT 1`)
      .get(now + requirePositiveInteger(input.leaseMs, "leaseMs", 24 * 60 * 60 * 1_000), now, now) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Claims the oldest ready batch; expired association proofs fail explicitly. */
  claimNext(input: { leaseOwner: string; now: number; leaseMs: number }): ClaimedCodeAttributionBatch | null {
    const leaseOwner = requireText(input.leaseOwner, "leaseOwner", 200);
    const now = requireTimestamp(input.now, "now");
    const leaseMs = requirePositiveInteger(input.leaseMs, "leaseMs", 24 * 60 * 60 * 1_000);
    const leaseExpiresAt = now + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "租约截止时间越界");
    return this.db.transaction(() => {
      const expired = this.db.prepare(`
        UPDATE code_attribution_outbox
        SET status = 'failed', available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = 'CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED',
            last_error_message = ?, updated_at = ?
        WHERE association_expires_at <= ?
          AND available_at <= ?
          AND (status IN ('pending', 'failed') OR (status = 'leased' AND lease_expires_at <= ?))
      `).run(EXPIRED_BATCH_AVAILABLE_AT, PUBLIC_ASSOCIATION_EXPIRED_MESSAGE, now, leaseExpiresAt, now, now);
      const row = this.db.prepare(`
        SELECT *
        FROM code_attribution_outbox
        WHERE available_at <= ?
          AND association_expires_at > ?
          AND (status IN ('pending', 'failed') OR (status = 'leased' AND lease_expires_at <= ?))
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get(now, leaseExpiresAt, now) as Record<string, unknown> | undefined;
      if (!row) {
        if ((expired.changes ?? 0) > 0) {
          throw outboxError("CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED", PUBLIC_ASSOCIATION_EXPIRED_MESSAGE);
        }
        return null;
      }
      const existing = rowToRecord(row);
      const result = this.db.prepare(`
        UPDATE code_attribution_outbox
        SET status = 'leased', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at = ?, last_error_code = NULL,
            last_error_message = NULL, updated_at = ?
        WHERE id = ? AND content_sha256 = ? AND available_at <= ?
          AND (status IN ('pending', 'failed') OR (status = 'leased' AND lease_expires_at <= ?))
      `).run(leaseOwner, leaseExpiresAt, now, existing.id, existing.contentSha256, now, now);
      if ((result.changes ?? 0) !== 1) {
        throw outboxError("CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT", "代码归因批次租约已被其他同步任务取得");
      }
      const record = this.getRequired(existing.id);
      return {
        record,
        batch: {
          associationId: record.associationId,
          sourceSystem: "codeflow_client",
          sourceBatchId: record.sourceBatchId,
          sourceRecordCount: record.payload.facts.length,
          sourceContentSha256: record.contentSha256,
          commit: record.payload.commit,
          facts: record.payload.facts,
        },
      };
    })();
  }

  /** Releases one owned lease into a retryable failed state. */
  markFailed(input: {
    id: string;
    leaseOwner: string;
    contentSha256: string;
    errorCode: string;
    retryAt: number;
    now: number;
  }): CodeAttributionOutboxRecord {
    const id = requireText(input.id, "id", 200);
    const leaseOwner = requireText(input.leaseOwner, "leaseOwner", 200);
    const contentSha256 = requireSha256(input.contentSha256, "contentSha256");
    const errorCode = requireText(input.errorCode, "errorCode", 120);
    const retryAt = requireTimestamp(input.retryAt, "retryAt");
    const now = requireTimestamp(input.now, "now");
    if (retryAt <= now) throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "retryAt 必须晚于 now");
    const current = this.get(id);
    if (
      current?.status === "leased"
      && current.leaseOwner === leaseOwner
      && current.contentSha256 === contentSha256
      && current.leaseExpiresAt !== null
      && current.leaseExpiresAt > now
      && retryAt > current.associationExpiresAt
    ) {
      throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "retryAt 不能晚于关联凭证有效期");
    }
    const result = this.db.prepare(`
      UPDATE code_attribution_outbox
      SET status = 'failed', available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ? AND content_sha256 = ?
        AND lease_expires_at > ? AND association_expires_at > ? AND association_expires_at >= ?
    `).run(retryAt, errorCode, PUBLIC_SYNC_FAILURE_MESSAGE, now, id, leaseOwner, contentSha256, now, now, retryAt);
    if ((result.changes ?? 0) !== 1) {
      throw outboxError("CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT", "代码归因失败状态写入缺少匹配租约");
    }
    return this.getRequired(id);
  }

  /** Releases one owned lease into a terminal failure that requires recollection or credential renewal. */
  markTerminalFailure(input: {
    id: string;
    leaseOwner: string;
    contentSha256: string;
    errorCode: string;
    associationExpired: boolean;
    now: number;
  }): CodeAttributionOutboxRecord {
    const id = requireText(input.id, "id", 200);
    const leaseOwner = requireText(input.leaseOwner, "leaseOwner", 200);
    const contentSha256 = requireSha256(input.contentSha256, "contentSha256");
    const errorCode = requireText(input.errorCode, "errorCode", 120);
    const now = requireTimestamp(input.now, "now");
    const result = this.db.prepare(`
      UPDATE code_attribution_outbox
      SET status = 'failed', available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ? AND content_sha256 = ?
        AND lease_expires_at > ?
    `).run(
      EXPIRED_BATCH_AVAILABLE_AT,
      errorCode,
      input.associationExpired ? PUBLIC_ASSOCIATION_EXPIRED_MESSAGE : PUBLIC_SYNC_FAILURE_MESSAGE,
      now,
      id,
      leaseOwner,
      contentSha256,
      now,
    );
    if ((result.changes ?? 0) !== 1) {
      throw outboxError("CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT", "代码归因终态写入缺少匹配租约");
    }
    return this.getRequired(id);
  }

  /** Deletes exactly one successfully uploaded batch under its owned lease. */
  deleteSucceeded(input: { id: string; leaseOwner: string; contentSha256: string; now: number }): void {
    const id = requireText(input.id, "id", 200);
    const leaseOwner = requireText(input.leaseOwner, "leaseOwner", 200);
    const contentSha256 = requireSha256(input.contentSha256, "contentSha256");
    const now = requireTimestamp(input.now, "now");
    const result = this.db.prepare(`
      DELETE FROM code_attribution_outbox
      WHERE id = ? AND status = 'leased' AND lease_owner = ? AND content_sha256 = ?
        AND lease_expires_at > ?
    `).run(id, leaseOwner, contentSha256, now);
    if ((result.changes ?? 0) !== 1) {
      throw outboxError("CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT", "代码归因成功清理缺少匹配租约或内容摘要");
    }
  }

  /** Returns one validated outbox row without exposing persisted JSON text. */
  get(id: string): CodeAttributionOutboxRecord | null {
    const row = this.db.prepare("SELECT * FROM code_attribution_outbox WHERE id = ?").get(requireText(id, "id", 200)) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Resolves one immutable business identity for idempotent replay. */
  private findByIdentity(workspaceId: string, instanceId: string, repository: string, commitSha: string): CodeAttributionOutboxRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM code_attribution_outbox
      WHERE workspace_id = ? AND instance_id = ? AND repository = ? AND commit_sha = ?
    `).get(workspaceId, instanceId, repository, commitSha) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Requires a row that was just inserted or updated in the same operation. */
  private getRequired(id: string): CodeAttributionOutboxRecord {
    const record = this.get(id);
    if (!record) throw outboxError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", `代码归因 outbox 记录丢失：id=${id}`);
    return record;
  }
}

/** Validates and canonicalizes a new immutable outbox row. */
function validateEnqueueInput(input: {
  id: string;
  sourceBatchId: string;
  workspaceId: string;
  instanceId: string;
  repository: string;
  commitSha: string;
  payload: CodeAttributionOutboxPayload;
  contentSha256: string;
  associationId: string;
  associationExpiresAt: number;
  now: number;
}): typeof input & { payloadJson: string } {
  const normalized = {
    ...input,
    id: requireText(input.id, "id", 200),
    sourceBatchId: requireText(input.sourceBatchId, "sourceBatchId", 200),
    workspaceId: requireText(input.workspaceId, "workspaceId", 200),
    instanceId: requireText(input.instanceId, "instanceId", 200),
    repository: requireText(input.repository, "repository", 500),
    commitSha: requireCommitSha(input.commitSha),
    contentSha256: requireSha256(input.contentSha256, "contentSha256"),
    associationId: requireText(input.associationId, "associationId", 2_048),
    associationExpiresAt: requireTimestamp(input.associationExpiresAt, "associationExpiresAt"),
    now: requireTimestamp(input.now, "now"),
  };
  if (normalized.associationExpiresAt <= normalized.now) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED", "代码归因关联凭证已过期");
  }
  validatePayloadIdentity(input.payload, normalized);
  const payloadJson = serializePayload(input.payload);
  if (sha256(payloadJson) !== normalized.contentSha256) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "代码归因 payload 与内容摘要不一致");
  }
  return { ...normalized, payloadJson };
}

/** Binds the payload envelope and every fact to the outbox business identity. */
function validatePayloadIdentity(
  payload: CodeAttributionOutboxPayload,
  identity: { workspaceId: string; instanceId: string; repository: string; commitSha: string },
): void {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.facts)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "代码归因 payload 非法");
  }
  const commit = payload.commit;
  if (
    !commit
    || commit.sourceWorkspaceId !== identity.workspaceId
    || commit.sourceInstanceId !== identity.instanceId
    || commit.repository !== identity.repository
    || commit.commitSha !== identity.commitSha
  ) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "代码归因 commit 信封与 outbox 身份不一致");
  }
  for (const fact of payload.facts) {
    if (
      fact.sourceWorkspaceId !== identity.workspaceId
      || fact.sourceInstanceId !== identity.instanceId
      || fact.repository !== identity.repository
      || fact.commitSha !== identity.commitSha
    ) {
      throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "代码归因文件事实与 outbox 身份不一致");
    }
  }
}

/** Determines whether an idempotent replay carries a newer authorization proof. */
function renewStoredAssociation(
  record: CodeAttributionOutboxRecord,
  associationId: string,
  associationExpiresAt: number,
  now: number,
): boolean {
  if (record.associationId === associationId && record.associationExpiresAt === associationExpiresAt) return false;
  if (associationExpiresAt <= now || associationExpiresAt <= record.associationExpiresAt) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_CONFLICT", "新的关联凭证有效期必须晚于现有凭证");
  }
  return true;
}

/** Converts and verifies one persisted row before returning it to synchronization code. */
function rowToRecord(row: Record<string, unknown>): CodeAttributionOutboxRecord {
  const payloadJson = storedText(row.payload_json, "payload_json", 16 * 1024 * 1024);
  const contentSha256 = storedSha256(row.content_sha256, "content_sha256");
  if (sha256(payloadJson) !== contentSha256) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", "代码归因 outbox payload 摘要损坏");
  }
  let payload: CodeAttributionOutboxPayload;
  try {
    payload = JSON.parse(payloadJson) as CodeAttributionOutboxPayload;
  } catch (cause) {
    throw new CodeAttributionOutboxRepoError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", "代码归因 outbox payload JSON 损坏", { cause });
  }
  try {
    serializeCodeAttributionOutboxPayload(payload);
  } catch (cause) {
    throw new CodeAttributionOutboxRepoError(
      "CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID",
      "代码归因 outbox payload 业务合同损坏",
      { cause },
    );
  }
  const record: CodeAttributionOutboxRecord = {
    id: storedText(row.id, "id", 200),
    sourceBatchId: storedText(row.source_batch_id, "source_batch_id", 200),
    workspaceId: storedText(row.workspace_id, "workspace_id", 200),
    instanceId: storedText(row.instance_id, "instance_id", 200),
    repository: storedText(row.repository, "repository", 500),
    commitSha: storedCommitSha(row.commit_sha),
    contentSha256,
    payload,
    associationId: storedText(row.association_id, "association_id", 2_048),
    associationExpiresAt: storedInteger(row.association_expires_at, "association_expires_at"),
    status: storedStatus(row.status),
    attemptCount: storedInteger(row.attempt_count, "attempt_count"),
    availableAt: storedInteger(row.available_at, "available_at"),
    leaseOwner: storedOptionalText(row.lease_owner, "lease_owner", 200),
    leaseExpiresAt: storedOptionalInteger(row.lease_expires_at, "lease_expires_at"),
    lastErrorCode: storedOptionalText(row.last_error_code, "last_error_code", 120),
    lastErrorMessage: storedOptionalText(row.last_error_message, "last_error_message", 1_000),
    createdAt: storedInteger(row.created_at, "created_at"),
    updatedAt: storedInteger(row.updated_at, "updated_at"),
  };
  try {
    validatePayloadIdentity(payload, record);
  } catch (cause) {
    throw new CodeAttributionOutboxRepoError(
      "CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID",
      "代码归因 outbox payload 身份损坏",
      { cause },
    );
  }
  if (record.status === "leased" && (!record.leaseOwner || record.leaseExpiresAt === null)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", "代码归因 outbox 租约字段不完整");
  }
  if (record.status !== "leased" && (record.leaseOwner !== null || record.leaseExpiresAt !== null)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", "代码归因 outbox 非租约状态残留租约字段");
  }
  return record;
}

/** Serializes the source-code-free payload in stable field order. */
export function serializeCodeAttributionOutboxPayload(payload: CodeAttributionOutboxPayload): string {
  validateCommitObservation(payload.commit);
  for (const fact of payload.facts) validateFact(fact);
  if (payload.facts.reduce((sum, fact) => sum + fact.executionRefs.length, 0) > MAX_EXECUTION_REFS_PER_BATCH) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "代码归因批次执行引用超过 5000 项");
  }
  return serializePayload(payload);
}

/** Computes the immutable digest used by local and Server idempotency checks. */
export function hashCodeAttributionOutboxPayload(payload: CodeAttributionOutboxPayload): string {
  return sha256(serializeCodeAttributionOutboxPayload(payload));
}

/** Validates commit-level status without accepting false complete exclusions. */
function validateCommitObservation(commit: OrchestrationMetricCodeAttributionCommitObservation): void {
  requireText(commit.sourceWorkspaceId, "commit.sourceWorkspaceId", 200);
  requireText(commit.sourceInstanceId, "commit.sourceInstanceId", 200);
  requireText(commit.repository, "commit.repository", 500);
  requireCommitSha(commit.commitSha);
  requireSha256(commit.commitEvidenceSha256, "commit.commitEvidenceSha256");
  requireTimestamp(commit.observedAt, "commit.observedAt");
  validateQuality(commit.qualityStatus, commit.qualityReasons);
  if (!(["matched", "partial", "excluded"] as const).includes(commit.disposition)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "commit.disposition 非法");
  }
  if (commit.disposition === "excluded" && commit.qualityStatus === "complete") {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "排除 commit 不能标记为完整");
  }
  if (commit.disposition === "matched" && commit.qualityStatus !== "complete") {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "已匹配 commit 必须具有完整质量状态");
  }
  if (commit.disposition === "partial" && commit.qualityStatus === "complete") {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "部分 commit 不能标记为完整");
  }
}

/** Validates one fact's public counts and source-code-free identities. */
function validateFact(fact: OrchestrationMetricCodeAttributionIngestFact): void {
  requireText(fact.sourceWorkspaceId, "fact.sourceWorkspaceId", 200);
  requireText(fact.sourceInstanceId, "fact.sourceInstanceId", 200);
  requireText(fact.repository, "fact.repository", 500);
  requireCommitSha(fact.commitSha);
  requireSha256(fact.fileIdentitySha256, "fact.fileIdentitySha256");
  if (fact.language !== null && !CODE_ATTRIBUTION_LANGUAGE_PATTERN.test(fact.language)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "fact.language 非法");
  }
  if (fact.aiEvidenceSha256 !== null) requireSha256(fact.aiEvidenceSha256, "fact.aiEvidenceSha256");
  if (fact.commitEvidenceSha256 !== null) requireSha256(fact.commitEvidenceSha256, "fact.commitEvidenceSha256");
  if (fact.evidenceRef !== null && !CODE_ATTRIBUTION_EVIDENCE_REF_PATTERN.test(fact.evidenceRef)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "fact.evidenceRef 非法");
  }
  requireTimestamp(fact.observedAt, "fact.observedAt");
  validateQuality(fact.qualityStatus, fact.qualityReasons);
  validateExecutionRefs(fact.executionRefs);
  if (fact.qualityStatus === "complete" && fact.executionRefs.length === 0) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "完整代码归因文件缺少执行引用");
  }
  for (const field of [
    "aiGeneratedAddedLines",
    "aiCandidateAddedLines",
    "retainedAiAddedLines",
    "committedAddedLines",
    "eligibleCommittedAddedLines",
    "coveredCommittedAddedLines",
  ] as const) {
    requireNonNegativeInteger(fact[field], `fact.${field}`);
  }
  calculateOrchestrationCodeAttributionRates({
    aiGeneratedAddedLines: fact.aiGeneratedAddedLines,
    aiCandidateAddedLines: fact.aiCandidateAddedLines,
    retainedAiAddedLines: fact.retainedAiAddedLines,
    committedAddedLines: fact.committedAddedLines,
    eligibleCommittedAddedLines: fact.eligibleCommittedAddedLines,
    coveredCommittedAddedLines: fact.coveredCommittedAddedLines,
    stillPresentAiAddedLines: null,
  });
}

/** Validates bounded, unique, canonically sorted execution references without accepting trace text. */
function validateExecutionRefs(refs: OrchestrationMetricCodeAttributionIngestFact["executionRefs"]): void {
  if (!Array.isArray(refs) || refs.length > MAX_EXECUTION_REFS_PER_FACT) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "fact.executionRefs 非法");
  }
  const keys: string[] = [];
  for (const reference of refs) {
    requireText(reference.nodeId, "executionRef.nodeId", 200);
    requireText(reference.attemptId, "executionRef.attemptId", 200);
    requireNonNegativeInteger(reference.attemptNo, "executionRef.attemptNo");
    if (reference.attemptNo < 1) {
      throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "executionRef.attemptNo 非法");
    }
    requireText(reference.promptSnapshotId, "executionRef.promptSnapshotId", 200);
    requireText(reference.threadId, "executionRef.threadId", 200);
    requireText(reference.turnId, "executionRef.turnId", 200);
    requireSha256(reference.evidenceSha256, "executionRef.evidenceSha256");
    keys.push(JSON.stringify([
      reference.nodeId,
      reference.attemptId,
      reference.attemptNo,
      reference.promptSnapshotId,
      reference.threadId,
      reference.turnId,
    ]));
  }
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= keys[index - 1]!)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "fact.executionRefs 必须唯一且按执行身份排序");
  }
}

/** Enforces complete/partial/unavailable reason invariants. */
function validateQuality(
  status: OrchestrationMetricCodeAttributionQualityStatus,
  reasons: OrchestrationMetricCodeAttributionQualityReason[],
): void {
  if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== "string")) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "代码归因质量原因非法");
  }
  const allowed = new Set<string>(ORCHESTRATION_METRIC_CODE_ATTRIBUTION_QUALITY_REASONS);
  if (reasons.some((reason) => !allowed.has(reason)) || new Set(reasons).size !== reasons.length) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "代码归因质量原因包含未知项或重复项");
  }
  const sortedReasons = [...reasons].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (reasons.some((reason, index) => reason !== sortedReasons[index])) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "代码归因质量原因顺序不规范");
  }
  if (status === "complete" && reasons.length !== 0) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "完整代码归因不能携带质量原因");
  }
  if (status !== "complete" && reasons.length === 0) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "非完整代码归因必须携带质量原因");
  }
}

/** Rebuilds the payload from an explicit source-code-free field whitelist. */
function serializePayload(payload: CodeAttributionOutboxPayload): string {
  return serializeOrchestrationCodeAttributionPayload(payload);
}

/** Produces a lowercase SHA-256 digest for one exact UTF-8 payload. */
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Requires one canonical non-empty text field. */
function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", `${field} 非法`);
  }
  return value;
}

/** Requires one canonical Git object identity. */
function requireCommitSha(value: unknown): string {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", "commitSha 非法");
  }
  return value;
}

/** Requires one canonical SHA-256 digest. */
function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", `${field} 非法`);
  }
  return value;
}

/** Requires one non-negative safe integer timestamp. */
function requireTimestamp(value: unknown, field: string): number {
  return requireNonNegativeInteger(value, field);
}

/** Requires one bounded positive integer. */
function requirePositiveInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", `${field} 非法`);
  }
  return value;
}

/** Requires one non-negative safe integer. */
function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID", `${field} 非法`);
  }
  return value;
}

/** Reads a bounded non-empty text value from SQLite. */
function storedText(value: unknown, field: string, maxLength: number): string {
  try {
    return requireText(value, field, maxLength);
  } catch (cause) {
    throw new CodeAttributionOutboxRepoError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", `${field} 损坏`, { cause });
  }
}

/** Reads a nullable bounded text value from SQLite. */
function storedOptionalText(value: unknown, field: string, maxLength: number): string | null {
  return value === null ? null : storedText(value, field, maxLength);
}

/** Reads one canonical commit identity from SQLite. */
function storedCommitSha(value: unknown): string {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", "commit_sha 损坏");
  }
  return value;
}

/** Reads one canonical SHA-256 digest from SQLite. */
function storedSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", `${field} 损坏`);
  }
  return value;
}

/** Reads one non-negative safe integer from SQLite. */
function storedInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", `${field} 损坏`);
  }
  return value;
}

/** Reads one nullable non-negative safe integer from SQLite. */
function storedOptionalInteger(value: unknown, field: string): number | null {
  return value === null ? null : storedInteger(value, field);
}

/** Reads the finite outbox state machine value from SQLite. */
function storedStatus(value: unknown): CodeAttributionOutboxRecord["status"] {
  if (value !== "pending" && value !== "leased" && value !== "failed") {
    throw outboxError("CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID", "status 损坏");
  }
  return value;
}

export class CodeAttributionOutboxRepoError extends Error {
  /** Creates one explicit outbox input, conflict, expiry, or corruption failure. */
  constructor(
    readonly code:
      | "CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID"
      | "CODE_ATTRIBUTION_OUTBOX_CONTENT_CONFLICT"
      | "CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_CONFLICT"
      | "CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED"
      | "CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT"
      | "CODE_ATTRIBUTION_OUTBOX_NOT_DRAINED"
      | "CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeAttributionOutboxRepoError";
  }
}

/** Creates one searchable outbox failure without exposing source payloads. */
function outboxError(code: CodeAttributionOutboxRepoError["code"], message: string): CodeAttributionOutboxRepoError {
  return new CodeAttributionOutboxRepoError(code, message);
}
