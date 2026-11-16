import crypto from "node:crypto";
import type { OrchestrationMetricCodeAttributionRetentionWindowDays, OrchestrationMetricCodeAttributionRetentionIngestInput } from "@codeflowai/shared";
import { normalizeOrchestrationCodeAttributionLine } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RETENTION_TASK_ID_PATTERN = /^code-attribution-retention:[a-f0-9]{64}$/u;
const TERMINAL_AVAILABLE_AT = Number.MAX_SAFE_INTEGER;

type FrozenRetentionObservation = {
  head: string | null;
  observation: OrchestrationMetricCodeAttributionRetentionIngestInput;
  digest: string;
};

export type CodeAttributionRetentionTask = {
  id: string;
  workspaceId: string;
  instanceId: string;
  repositoryPath: string;
  repository: string;
  commitSha: string;
  filePath: string;
  fileIdentitySha256: string;
  retainedLines: string[];
  retainedAiAddedLines: number;
  windowDays: OrchestrationMetricCodeAttributionRetentionWindowDays;
  dueAt: number;
  status: "pending" | "leased" | "failed";
  attemptCount: number;
  availableAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  frozenObservation: FrozenRetentionObservation | null;
};

/** Owns Client-local retention tasks and their compare-and-swap leases. */
export class CodeAttributionRetentionTaskRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 只确认本轮截止前到期任务；未到期观察不阻止当前查询完成。 */
  assertDrained(input: { dueThrough: number }): void {
    const row = this.db.prepare(`SELECT * FROM code_attribution_retention_tasks
      WHERE due_at <= ? ORDER BY due_at ASC, created_at ASC, id ASC LIMIT 1`)
      .get(requireInteger(input.dueThrough, "dueThrough")) as Record<string, unknown> | undefined;
    if (!row) return;
    const task = rowToTask(row);
    throw Object.assign(taskError("CODE_ATTRIBUTION_RETENTION_TASK_NOT_DRAINED", "代码留存仍有未确认的到期观察"), {
      recordId: task.id, workspaceId: task.workspaceId, instanceId: task.instanceId,
      status: task.status, availableAt: task.availableAt, leaseExpiresAt: task.leaseExpiresAt,
      lastErrorCode: task.lastErrorCode,
    });
  }

  /** Inserts one immutable file/window task or verifies an exact replay. */
  enqueue(input: Omit<CodeAttributionRetentionTask, "status" | "attemptCount" | "availableAt" | "leaseOwner" | "leaseExpiresAt" | "lastErrorCode" | "createdAt" | "updatedAt" | "frozenObservation"> & { now: number }): { task: CodeAttributionRetentionTask; replayed: boolean } {
    const task = validateNewTask(input);
    return this.db.transaction(() => {
      const existing = this.findByIdentity(task);
      if (existing) {
        if (!sameImmutableTask(existing, task)) {
          throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_CONFLICT", "相同留存观察身份的本地任务内容发生漂移");
        }
        return { task: existing, replayed: true };
      }
      this.db.prepare(`INSERT INTO code_attribution_retention_tasks (
        id, workspace_id, instance_id, repository_path, repository, commit_sha, file_path,
        file_identity_sha256, retained_lines_json, retained_ai_added_lines, window_days, due_at,
        status, attempt_count, available_at, lease_owner, lease_expires_at, last_error_code,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)`)
        .run(
          task.id, task.workspaceId, task.instanceId, task.repositoryPath, task.repository,
          task.commitSha, task.filePath, task.fileIdentitySha256, JSON.stringify(task.retainedLines),
          task.retainedAiAddedLines, task.windowDays, task.dueAt, task.dueAt, task.now, task.now,
        );
      return { task: this.getRequired(task.id), replayed: false };
    })();
  }

  /** Claims the oldest due observation and recovers only expired leases. */
  claimNext(input: { leaseOwner: string; now: number; leaseMs: number }): CodeAttributionRetentionTask | null {
    const leaseOwner = requireText(input.leaseOwner, "leaseOwner", 200);
    const now = requireInteger(input.now, "now");
    const leaseMs = requirePositiveInteger(input.leaseMs, "leaseMs");
    const leaseExpiresAt = now + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", "留存观察租约越界");
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM code_attribution_retention_tasks
        WHERE due_at <= ? AND available_at <= ?
          AND (status IN ('pending', 'failed') OR (status = 'leased' AND lease_expires_at <= ?))
        ORDER BY due_at ASC, created_at ASC, id ASC LIMIT 1`).get(now, now, now) as Record<string, unknown> | undefined;
      if (!row) return null;
      const current = rowToTask(row);
      const result = this.db.prepare(`UPDATE code_attribution_retention_tasks
        SET status='leased', attempt_count=attempt_count+1, lease_owner=?, lease_expires_at=?,
            last_error_code=NULL, updated_at=?
        WHERE id=? AND available_at <= ?
          AND (status IN ('pending', 'failed') OR (status='leased' AND lease_expires_at <= ?))`)
        .run(leaseOwner, leaseExpiresAt, now, current.id, now, now);
      if ((result.changes ?? 0) !== 1) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_LEASE_CONFLICT", "留存观察任务租约已被其他任务取得");
      return this.getRequired(current.id);
    })();
  }

  /** 上传前耐久冻结首次 HEAD 和完整观测；重试只允许读取同一内容。 */
  freezeObservation(input: { id: string; leaseOwner: string; head: string | null; observation: OrchestrationMetricCodeAttributionRetentionIngestInput; now: number }): FrozenRetentionObservation {
    return this.db.transaction(() => {
      const task = this.getRequired(input.id);
      if (task.status !== "leased" || task.leaseOwner !== input.leaseOwner || task.leaseExpiresAt! <= input.now) {
        throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_LEASE_CONFLICT", "冻结留存观察缺少匹配租约");
      }
      const content = { head: input.head, observation: input.observation };
      const frozen = validateFrozenObservation({ ...content, digest: observationDigest(content) }, task);
      if (task.frozenObservation) {
        if (task.frozenObservation.digest !== frozen.digest) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_CONFLICT", "留存观察已经冻结，禁止改写同一身份");
        return task.frozenObservation;
      }
      this.db.prepare("UPDATE code_attribution_retention_tasks SET retained_lines_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify({ retainedLines: task.retainedLines, frozenObservation: frozen }), requireInteger(input.now, "now"), task.id);
      return frozen;
    })();
  }

  /** Releases an owned lease for a bounded retry. */
  markFailed(input: { id: string; leaseOwner: string; errorCode: string; retryAt: number; now: number }): void {
    const now = requireInteger(input.now, "now");
    const retryAt = requireInteger(input.retryAt, "retryAt");
    if (retryAt <= now) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", "retryAt 必须晚于 now");
    const result = this.db.prepare(`UPDATE code_attribution_retention_tasks
      SET status='failed', available_at=?, lease_owner=NULL, lease_expires_at=NULL,
          last_error_code=?, updated_at=?
      WHERE id=? AND status='leased' AND lease_owner=? AND lease_expires_at > ?`)
      .run(
        retryAt,
        requireText(input.errorCode, "errorCode", 120),
        now,
        requireText(input.id, "id", 200),
        requireText(input.leaseOwner, "leaseOwner", 200),
        now,
      );
    if ((result.changes ?? 0) !== 1) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_LEASE_CONFLICT", "留存观察失败回写缺少匹配租约");
  }

  /** Marks a contract failure terminal without deleting its diagnostic task. */
  markTerminalFailure(input: { id: string; leaseOwner: string; errorCode: string; now: number }): void {
    const now = requireInteger(input.now, "now");
    const result = this.db.prepare(`UPDATE code_attribution_retention_tasks
      SET status='failed', available_at=?, lease_owner=NULL, lease_expires_at=NULL,
          last_error_code=?, updated_at=?
      WHERE id=? AND status='leased' AND lease_owner=? AND lease_expires_at > ?`)
      .run(
        TERMINAL_AVAILABLE_AT,
        requireText(input.errorCode, "errorCode", 120),
        now,
        requireText(input.id, "id", 200),
        requireText(input.leaseOwner, "leaseOwner", 200),
        now,
      );
    if ((result.changes ?? 0) !== 1) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_LEASE_CONFLICT", "留存观察终态回写缺少匹配租约");
  }

  /** Deletes exactly one observation after an identity-checked Server receipt. */
  deleteSucceeded(input: { id: string; leaseOwner: string; now: number }): void {
    const now = requireInteger(input.now, "now");
    const result = this.db.prepare(`DELETE FROM code_attribution_retention_tasks
      WHERE id=? AND status='leased' AND lease_owner=? AND lease_expires_at > ?`)
      .run(requireText(input.id, "id", 200), requireText(input.leaseOwner, "leaseOwner", 200), now);
    if ((result.changes ?? 0) !== 1) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_LEASE_CONFLICT", "留存观察成功清理缺少匹配租约");
  }

  /** Reads one task and validates all persisted local observation inputs. */
  get(id: string): CodeAttributionRetentionTask | null {
    const row = this.db.prepare("SELECT * FROM code_attribution_retention_tasks WHERE id=?")
      .get(requireText(id, "id", 200)) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : null;
  }

  /** Finds the unique natural observation identity. */
  private findByIdentity(input: Pick<CodeAttributionRetentionTask, "workspaceId" | "instanceId" | "repository" | "commitSha" | "fileIdentitySha256" | "windowDays">): CodeAttributionRetentionTask | null {
    const row = this.db.prepare(`SELECT * FROM code_attribution_retention_tasks
      WHERE workspace_id=? AND instance_id=? AND repository=? AND commit_sha=?
        AND file_identity_sha256=? AND window_days=?`)
      .get(input.workspaceId, input.instanceId, input.repository, input.commitSha, input.fileIdentitySha256, input.windowDays) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : null;
  }

  /** Requires a task written in the same transaction. */
  private getRequired(id: string): CodeAttributionRetentionTask {
    const task = this.get(id);
    if (!task) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", `留存观察任务丢失：id=${id}`);
    return task;
  }
}

/** Validates one new local task without normalizing away identity differences. */
function validateNewTask(input: Parameters<CodeAttributionRetentionTaskRepo["enqueue"]>[0]) {
  const retainedLines = validateRetainedLines(input.retainedLines);
  const retainedAiAddedLines = requireInteger(input.retainedAiAddedLines, "retainedAiAddedLines");
  if (retainedAiAddedLines !== retainedLines.length) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", "留存行集合与采纳行计数不一致");
  const windowDays = requireWindow(input.windowDays);
  return {
    ...input,
    id: requirePattern(input.id, RETENTION_TASK_ID_PATTERN, "id"),
    workspaceId: requireText(input.workspaceId, "workspaceId", 200),
    instanceId: requireText(input.instanceId, "instanceId", 200),
    repositoryPath: requireRepositoryPath(input.repositoryPath, true),
    repository: requireText(input.repository, "repository", 500),
    commitSha: requirePattern(input.commitSha, COMMIT_SHA_PATTERN, "commitSha"),
    filePath: requireRepositoryPath(input.filePath, false),
    fileIdentitySha256: requirePattern(input.fileIdentitySha256, SHA256_PATTERN, "fileIdentitySha256"),
    retainedLines,
    retainedAiAddedLines,
    windowDays,
    dueAt: requireInteger(input.dueAt, "dueAt"),
    now: requireInteger(input.now, "now"),
  };
}

/** Converts one row and rejects corrupted local source evidence before Git access. */
function rowToTask(row: Record<string, unknown>): CodeAttributionRetentionTask {
  try {
    return parseStoredTask(row);
  } catch (error) {
    if (error instanceof CodeAttributionRetentionTaskRepoError
      && error.code === "CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID") {
      throw new CodeAttributionRetentionTaskRepoError(
        "CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID",
        "留存观察任务持久化字段损坏",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Parses a persisted task through the same strict field validators as new input. */
function parseStoredTask(row: Record<string, unknown>): CodeAttributionRetentionTask {
  let parsedLines: unknown;
  try {
    parsedLines = JSON.parse(requireText(row.retained_lines_json, "retained_lines_json", 16 * 1024 * 1024));
  } catch (cause) {
    throw new CodeAttributionRetentionTaskRepoError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", "留存观察任务行证据损坏", { cause });
  }
  const envelope = !Array.isArray(parsedLines) && parsedLines !== null && typeof parsedLines === "object"
    ? parsedLines as Record<string, unknown> : null;
  const retainedLines = validateRetainedLines(envelope ? envelope.retainedLines : parsedLines);
  const retainedAiAddedLines = requireInteger(row.retained_ai_added_lines, "retained_ai_added_lines");
  if (retainedLines.length !== retainedAiAddedLines) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", "留存观察任务计数损坏");
  const status = row.status === "pending" || row.status === "leased" || row.status === "failed"
    ? row.status
    : (() => { throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", "留存观察任务状态损坏"); })();
  const leaseOwner = row.lease_owner === null ? null : requireText(row.lease_owner, "lease_owner", 200);
  const leaseExpiresAt = row.lease_expires_at === null ? null : requireInteger(row.lease_expires_at, "lease_expires_at");
  if ((status === "leased") !== (leaseOwner !== null && leaseExpiresAt !== null)) {
    throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", "留存观察任务租约字段不一致");
  }
  const task: CodeAttributionRetentionTask = {
    id: requirePattern(row.id, RETENTION_TASK_ID_PATTERN, "id"),
    workspaceId: requireText(row.workspace_id, "workspace_id", 200),
    instanceId: requireText(row.instance_id, "instance_id", 200),
    repositoryPath: requireRepositoryPath(row.repository_path, true),
    repository: requireText(row.repository, "repository", 500),
    commitSha: requirePattern(row.commit_sha, COMMIT_SHA_PATTERN, "commit_sha"),
    filePath: requireRepositoryPath(row.file_path, false),
    fileIdentitySha256: requirePattern(row.file_identity_sha256, SHA256_PATTERN, "file_identity_sha256"),
    retainedLines,
    retainedAiAddedLines,
    windowDays: requireWindow(row.window_days),
    dueAt: requireInteger(row.due_at, "due_at"),
    status,
    attemptCount: requireInteger(row.attempt_count, "attempt_count"),
    availableAt: requireInteger(row.available_at, "available_at"),
    leaseOwner,
    leaseExpiresAt,
    lastErrorCode: row.last_error_code === null ? null : requireText(row.last_error_code, "last_error_code", 120),
    createdAt: requireInteger(row.created_at, "created_at"),
    updatedAt: requireInteger(row.updated_at, "updated_at"),
    frozenObservation: null,
  };
  if (envelope) task.frozenObservation = validateFrozenObservation(envelope.frozenObservation, task);
  return task;
}

/** 校验冻结身份及摘要，损坏时禁止重新读取 Git 伪造重试内容。 */
function validateFrozenObservation(value: unknown, task: Pick<CodeAttributionRetentionTask, "id" | "workspaceId" | "instanceId" | "repository" | "commitSha" | "fileIdentitySha256" | "windowDays" | "retainedAiAddedLines">): FrozenRetentionObservation {
  if (!value || typeof value !== "object") throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", "冻结留存观察缺失");
  const frozen = value as FrozenRetentionObservation;
  if (frozen.head !== null) requirePattern(frozen.head, COMMIT_SHA_PATTERN, "observationHead");
  const observation = frozen.observation;
  if (!observation || observation.observationId !== task.id || observation.sourceWorkspaceId !== task.workspaceId
    || observation.sourceInstanceId !== task.instanceId || observation.repository !== task.repository
    || observation.commitSha !== task.commitSha || observation.fileIdentitySha256 !== task.fileIdentitySha256
    || observation.windowDays !== task.windowDays
    || frozen.digest !== observationDigest({ head: frozen.head, observation })) {
    throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", "冻结留存观察身份或摘要损坏");
  }
  if (observation.qualityStatus === "complete") {
    if (frozen.head === null || requireInteger(observation.stillPresentAiAddedLines, "stillPresentAiAddedLines") > task.retainedAiAddedLines
      || !Array.isArray(observation.qualityReasons) || observation.qualityReasons.length !== 0) {
      throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", "冻结留存计数损坏");
    }
    requirePattern(observation.retentionEvidenceSha256, SHA256_PATTERN, "retentionEvidenceSha256");
    requireText(observation.evidenceRef, "evidenceRef", 200);
    requireInteger(observation.observedAt, "observedAt");
  } else if (observation.qualityStatus !== "unavailable" || observation.stillPresentAiAddedLines !== null
    || observation.retentionEvidenceSha256 !== null || observation.evidenceRef !== null || observation.observedAt !== null
    || !Array.isArray(observation.qualityReasons) || observation.qualityReasons.length === 0
    || observation.qualityReasons.some(reason => reason !== "history_rewritten" && reason !== "retention_observation_missing")) {
    throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID", "冻结留存质量状态损坏");
  }
  return frozen;
}

/** 摘要覆盖本地 HEAD 和完整上传内容，不包含源码行。 */
function observationDigest(content: Pick<FrozenRetentionObservation, "head" | "observation">): string {
  return crypto.createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex");
}

/** Compares all immutable task fields for idempotent recollection. */
function sameImmutableTask(existing: CodeAttributionRetentionTask, input: ReturnType<typeof validateNewTask>): boolean {
  return existing.id === input.id
    && existing.repositoryPath === input.repositoryPath
    && existing.filePath === input.filePath
    && existing.retainedAiAddedLines === input.retainedAiAddedLines
    && existing.dueAt === input.dueAt
    && JSON.stringify(existing.retainedLines) === JSON.stringify(input.retainedLines);
}

/** Accepts only already-normalized non-empty lines to make persisted counts deterministic. */
function validateRetainedLines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000_000) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", "留存行集合无效");
  return value.map((line) => {
    const normalized = typeof line === "string" ? normalizeOrchestrationCodeAttributionLine(line) : null;
    if (normalized === null || normalized !== line) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", "留存行必须是规范化非空文本");
    return line;
  });
}

/** Validates a workspace-relative repository or repository-relative file path. */
function requireRepositoryPath(value: unknown, allowEmpty: boolean): string {
  if (typeof value !== "string") throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", "本地仓库路径无效");
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const segments = normalized ? normalized.split("/") : [];
  if ((!allowEmpty && !normalized) || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)
    || /[\u0000-\u001f\u007f]/u.test(normalized) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", "本地仓库路径无效");
  }
  return normalized;
}

/** Requires one finite retention window. */
function requireWindow(value: unknown): OrchestrationMetricCodeAttributionRetentionWindowDays {
  if (value !== 7 && value !== 30) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", "留存观察窗口无效");
  return value;
}

/** Requires one canonical bounded string. */
function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", `${field} 无效`);
  }
  return value;
}

/** Requires a non-negative safe integer. */
function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", `${field} 无效`);
  return value;
}

/** Requires a positive bounded worker duration. */
function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = requireInteger(value, field);
  if (parsed <= 0 || parsed > 24 * 60 * 60 * 1_000) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", `${field} 无效`);
  return parsed;
}

/** Requires one canonical hash or commit identity. */
function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw taskError("CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID", `${field} 无效`);
  return value;
}

export class CodeAttributionRetentionTaskRepoError extends Error {
  /** Creates one explicit task input, lease, conflict, or corruption failure. */
  constructor(
    readonly code:
      | "CODE_ATTRIBUTION_RETENTION_TASK_INPUT_INVALID"
      | "CODE_ATTRIBUTION_RETENTION_TASK_CONFLICT"
      | "CODE_ATTRIBUTION_RETENTION_TASK_LEASE_CONFLICT"
      | "CODE_ATTRIBUTION_RETENTION_TASK_NOT_DRAINED"
      | "CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeAttributionRetentionTaskRepoError";
  }
}

/** Creates one searchable retention task failure without source content. */
function taskError(code: CodeAttributionRetentionTaskRepoError["code"], message: string): CodeAttributionRetentionTaskRepoError {
  return new CodeAttributionRetentionTaskRepoError(code, message);
}
