import type {
  ControlledExperimentRunStatus,
  ControlledExperimentUsageAccountingStatus,
  ControlledExperimentVariantKey,
  EngineType,
  NodeArtifactInput,
  NodePromptEnvelope,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type ControlledExperimentLocalSnapshot = {
  id: string;
  experimentId: string;
  freezeRevision: number;
  freezeDigest: string;
  workspaceId: string;
  sampleId: string;
  evaluationItemId: string;
  sourceInstanceId: string;
  nodeId: string;
  promptSnapshotId: string;
  ordinal: number;
  variantKey: ControlledExperimentVariantKey;
  engine: EngineType;
  model: string;
  effort: string | null;
  catalogVersion: number;
  promptEnvelope: NodePromptEnvelope;
  systemMessage: string;
  developerMessage: string | null;
  userMessage: string;
  artifactInput: NodeArtifactInput;
  inputSha256: string;
  configSha256: string;
  promptDefinitionSha256: string;
  priceSnapshot: null;
  priceSnapshotSha256: string;
  perRunTimeoutMs: number;
  createdAt: number;
};

export type ControlledExperimentLocalRun = {
  id: string;
  experimentId: string;
  assignmentId: string;
  sampleId: string;
  variantKey: ControlledExperimentVariantKey;
  attemptNo: number;
  snapshotId: string;
  dispatchTokenSha256: string;
  status: Exclude<ControlledExperimentRunStatus, "queued">;
  statusVersion: number;
  clientTurnId: string;
  engine: EngineType;
  engineSessionId: string | null;
  engineTurnId: string | null;
  deadlineAt: number;
  startedAt: number | null;
  completedAt: number | null;
  outputText: string | null;
  outputSha256: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalTokens: number | null;
  estimatedCostMicros: number | null;
  usageAccountingStatus: ControlledExperimentUsageAccountingStatus;
  eventLog: unknown[];
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ControlledExperimentRunUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
};

type SnapshotRow = Record<string, unknown>;
type RunRow = Record<string, unknown>;

const ACTIVE_STATUSES = ["dispatched", "running", "cancel_requested"] as const;
const TERMINAL_STATUSES = new Set<ControlledExperimentLocalRun["status"]>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
const MAX_EVENT_COUNT = 10_000;

/** 标识可安全映射为 409 的确定性本地 Run 身份冲突。 */
export class ControlledExperimentRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlledExperimentRunConflictError";
  }
}

/** 受控实验本地仓储：持有冻结事务、dispatch 幂等与 Run 终态 CAS。 */
export class ControlledExperimentRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 原子提交一批冻结快照；同 revision 同 digest 重放返回既有证据。 */
  commitFreeze(input: {
    experimentId: string;
    freezeRevision: number;
    freezeDigest: string;
    snapshots: ControlledExperimentLocalSnapshot[];
  }): { snapshots: ControlledExperimentLocalSnapshot[]; idempotent: boolean } {
    const tx = this.db.transaction(() => {
      const existing = this.listSnapshotsByFreeze(input.experimentId, input.freezeRevision);
      if (existing.length > 0) {
        if (existing.some((item) => item.freezeDigest !== input.freezeDigest) || existing.length !== input.snapshots.length) {
          throw new Error(`受控实验冻结 revision 已存在不同证据：experimentId=${input.experimentId}, revision=${input.freezeRevision}`);
        }
        return { snapshots: existing, idempotent: true };
      }
      if (input.snapshots.length === 0) throw new Error("受控实验冻结快照不能为空");
      const insert = this.db.prepare(`
        INSERT INTO controlled_experiment_snapshots (
          id, experiment_id, freeze_revision, workspace_id, sample_id, evaluation_item_id,
          source_instance_id, node_id, prompt_snapshot_id, ordinal, variant_key, engine, model, effort, catalog_version,
          prompt_envelope_json, system_message, developer_message, user_message, artifact_input_json,
          input_sha256, config_sha256, prompt_definition_sha256, price_snapshot_json,
          price_snapshot_sha256, freeze_digest, per_run_timeout_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of input.snapshots) {
        if (item.experimentId !== input.experimentId || item.freezeRevision !== input.freezeRevision
          || item.freezeDigest !== input.freezeDigest) {
          throw new Error(`受控实验冻结快照批次身份不一致：snapshotId=${item.id}`);
        }
        insert.run(
          item.id, item.experimentId, item.freezeRevision, item.workspaceId, item.sampleId,
          item.evaluationItemId, item.sourceInstanceId, item.nodeId, item.promptSnapshotId, item.ordinal,
          item.variantKey, item.engine, item.model, item.effort, item.catalogVersion, JSON.stringify(item.promptEnvelope),
          item.systemMessage, item.developerMessage, item.userMessage, JSON.stringify(item.artifactInput),
          item.inputSha256, item.configSha256, item.promptDefinitionSha256,
          JSON.stringify(item.priceSnapshot), item.priceSnapshotSha256, item.freezeDigest,
          item.perRunTimeoutMs, item.createdAt,
        );
      }
      return { snapshots: this.listSnapshotsByFreeze(input.experimentId, input.freezeRevision), idempotent: false };
    });
    return tx();
  }

  /** 读取指定冻结 revision 的全部 Variant 快照。 */
  listSnapshotsByFreeze(experimentId: string, freezeRevision: number): ControlledExperimentLocalSnapshot[] {
    const rows = this.db.prepare(`${selectSnapshotSql()} WHERE experiment_id = ? AND freeze_revision = ? ORDER BY ordinal, variant_key`)
      .all(experimentId, freezeRevision) as SnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  /** 按 Server 样本和 Variant 读取最新冻结快照。 */
  getLatestSnapshot(experimentId: string, sampleId: string, variantKey: ControlledExperimentVariantKey): ControlledExperimentLocalSnapshot | null {
    const row = this.db.prepare(`${selectSnapshotSql()} WHERE experiment_id = ? AND sample_id = ? AND variant_key = ? ORDER BY freeze_revision DESC LIMIT 1`)
      .get(experimentId, sampleId, variantKey) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  /** 按本地主键读取冻结快照。 */
  getSnapshot(id: string): ControlledExperimentLocalSnapshot | null {
    const row = this.db.prepare(`${selectSnapshotSql()} WHERE id = ?`).get(id) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  /** 先持久化 dispatch 身份；重复同载荷返回原 Run，不同载荷显式冲突。 */
  createDispatchedRun(input: Omit<ControlledExperimentLocalRun,
    "status" | "statusVersion" | "engineSessionId" | "engineTurnId" | "startedAt" | "completedAt"
    | "outputText" | "outputSha256" | "inputTokens" | "outputTokens" | "cachedInputTokens"
    | "cacheCreationInputTokens" | "totalTokens" | "estimatedCostMicros" | "usageAccountingStatus"
    | "eventLog" | "errorCode" | "createdAt" | "updatedAt"> & { now: number }): { run: ControlledExperimentLocalRun; idempotent: boolean } {
    const tx = this.db.transaction(() => {
      const existing = this.getRun(input.id);
      if (existing) {
        assertRunIdentity(existing, input);
        return { run: existing, idempotent: true };
      }
      const identityConflict = this.db.prepare(`${selectRunSql()}
        WHERE experiment_id = ? AND assignment_id = ? AND variant_key = ? AND attempt_no = ? LIMIT 1`)
        .get(input.experimentId, input.assignmentId, input.variantKey, input.attemptNo) as RunRow | undefined;
      if (identityConflict) {
        throw new ControlledExperimentRunConflictError(
          `受控实验 Assignment/Variant/Attempt 已绑定其他 Run：runId=${String(identityConflict.id)}`,
        );
      }
      if (!this.getSnapshot(input.snapshotId)) throw new Error(`受控实验本地快照不存在：snapshotId=${input.snapshotId}`);
      this.db.prepare(`
        INSERT INTO controlled_experiment_runs (
          id, experiment_id, assignment_id, sample_id, variant_key, attempt_no, snapshot_id,
          dispatch_token_sha256, status, status_version, client_turn_id, engine,
          engine_session_id, engine_turn_id, deadline_at, started_at, completed_at,
          output_text, output_sha256, input_tokens, output_tokens, cached_input_tokens,
          cache_creation_input_tokens, total_tokens, estimated_cost_micros,
          usage_accounting_status, event_log_json, error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', 0, ?, ?, NULL, NULL, ?, NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pending', '[]', NULL, ?, ?)
      `).run(
        input.id, input.experimentId, input.assignmentId, input.sampleId, input.variantKey,
        input.attemptNo, input.snapshotId, input.dispatchTokenSha256, input.clientTurnId,
        input.engine, input.deadlineAt, input.now, input.now,
      );
      return { run: this.requireRun(input.id), idempotent: false };
    });
    return tx();
  }

  /** 按 Run ID 读取本地执行证据。 */
  getRun(id: string): ControlledExperimentLocalRun | null {
    const row = this.db.prepare(`${selectRunSql()} WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  /** 列出 Client 重启时必须对账、不得重新发起的 Run。 */
  listRecoverableRuns(): ControlledExperimentLocalRun[] {
    const rows = this.db.prepare(`${selectRunSql()} WHERE status IN ('dispatched', 'running', 'cancel_requested') ORDER BY updated_at ASC`)
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  /** 将 provider 调用开始时间写入持久 Run；取消竞争获胜时保持 cancel_requested。 */
  markRunning(id: string, startedAt: number): ControlledExperimentLocalRun {
    const current = this.requireRun(id);
    if (current.status !== "dispatched") return current;
    const changed = this.db.prepare(`
      UPDATE controlled_experiment_runs
         SET status = 'running', started_at = ?, status_version = status_version + 1, updated_at = ?
       WHERE id = ? AND status = 'dispatched' AND status_version = ?
    `).run(startedAt, startedAt, id, current.statusVersion);
    assertSingleChange(changed.changes, id, "开始 Run");
    return this.requireRun(id);
  }

  /** 幂等绑定 provider session/turn；已经绑定不同值时拒绝覆盖。 */
  bindProviderIds(id: string, input: { engineSessionId?: string | null; engineTurnId?: string | null }): ControlledExperimentLocalRun {
    const current = this.requireRun(id);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const sessionId = normalizeOptionalText(input.engineSessionId);
    const turnId = normalizeOptionalText(input.engineTurnId);
    if (sessionId && current.engineSessionId && current.engineSessionId !== sessionId) {
      throw new Error(`受控实验 provider session 冲突：runId=${id}`);
    }
    if (turnId && current.engineTurnId && current.engineTurnId !== turnId) {
      throw new Error(`受控实验 provider turn 冲突：runId=${id}`);
    }
    if ((!sessionId || current.engineSessionId === sessionId) && (!turnId || current.engineTurnId === turnId)) return current;
    const now = Date.now();
    const changed = this.db.prepare(`
      UPDATE controlled_experiment_runs
         SET engine_session_id = COALESCE(engine_session_id, ?),
             engine_turn_id = COALESCE(engine_turn_id, ?),
             status_version = status_version + 1, updated_at = ?
       WHERE id = ? AND status_version = ? AND status IN ('dispatched', 'running', 'cancel_requested')
    `).run(sessionId, turnId, now, id, current.statusVersion);
    assertSingleChange(changed.changes, id, "绑定 provider 身份");
    return this.requireRun(id);
  }

  /** 以 expected-old CAS 修正已证伪的 provider turn 映射；并发冲突显式失败。 */
  rebindProviderTurnId(id: string, input: {
    expectedEngineTurnId: string;
    actualEngineTurnId: string;
  }): ControlledExperimentLocalRun {
    const expectedTurnId = normalizeOptionalText(input.expectedEngineTurnId);
    const actualTurnId = normalizeOptionalText(input.actualEngineTurnId);
    if (!expectedTurnId || !actualTurnId) throw new Error(`受控实验 provider turn 修正参数无效：runId=${id}`);
    const current = this.requireRun(id);
    if (current.engineTurnId === actualTurnId) return current;
    if (current.engineTurnId !== expectedTurnId) {
      throw new Error(
        `受控实验 provider turn 修正冲突：runId=${id}, expected=${expectedTurnId}, current=${current.engineTurnId ?? "missing"}, actual=${actualTurnId}`,
      );
    }
    const now = Date.now();
    const changed = this.db.prepare(`
      UPDATE controlled_experiment_runs
         SET engine_turn_id = ?, status_version = status_version + 1, updated_at = ?
       WHERE id = ? AND status_version = ? AND engine_turn_id = ?
    `).run(actualTurnId, now, id, current.statusVersion, expectedTurnId);
    assertSingleChange(changed.changes, id, "修正 provider turn 身份");
    return this.requireRun(id);
  }

  /** 将一条隔离引擎事件追加到 Run；达到上限时显式失败。 */
  appendEvent(id: string, event: unknown): ControlledExperimentLocalRun {
    const current = this.requireRun(id);
    if (TERMINAL_STATUSES.has(current.status)) throw new Error(`受控实验 Run 已终态，拒绝迟到事件：runId=${id}`);
    if (current.eventLog.length >= MAX_EVENT_COUNT) throw new Error(`受控实验事件超过上限：runId=${id}`);
    const nextEvents = [...current.eventLog, event];
    const now = Date.now();
    const changed = this.db.prepare(`
      UPDATE controlled_experiment_runs
         SET event_log_json = ?, status_version = status_version + 1, updated_at = ?
       WHERE id = ? AND status_version = ? AND status IN ('dispatched', 'running', 'cancel_requested')
    `).run(JSON.stringify(nextEvents), now, id, current.statusVersion);
    assertSingleChange(changed.changes, id, "追加实验事件");
    return this.requireRun(id);
  }

  /** 请求取消非终态 Run；终态保持不可变。 */
  requestCancel(id: string): ControlledExperimentLocalRun {
    const current = this.requireRun(id);
    if (TERMINAL_STATUSES.has(current.status) || current.status === "cancel_requested") return current;
    const now = Date.now();
    const changed = this.db.prepare(`
      UPDATE controlled_experiment_runs
         SET status = 'cancel_requested', status_version = status_version + 1, updated_at = ?
       WHERE id = ? AND status_version = ? AND status IN ('dispatched', 'running')
    `).run(now, id, current.statusVersion);
    assertSingleChange(changed.changes, id, "请求取消 Run");
    return this.requireRun(id);
  }

  /** 以 CAS 写入唯一终态；已终态时保留首次事实，禁止迟到覆盖。 */
  finishRun(id: string, input: {
    status: Extract<ControlledExperimentLocalRun["status"], "succeeded" | "failed" | "timed_out" | "cancelled">;
    completedAt: number;
    outputText: string | null;
    outputSha256: string | null;
    usage: ControlledExperimentRunUsage | null;
    errorCode: string | null;
  }): ControlledExperimentLocalRun {
    const current = this.requireRun(id);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const changed = this.db.prepare(`
      UPDATE controlled_experiment_runs
         SET status = ?, completed_at = ?, output_text = ?, output_sha256 = ?,
             input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
             cache_creation_input_tokens = ?, total_tokens = ?, estimated_cost_micros = ?,
             usage_accounting_status = ?, error_code = ?,
             status_version = status_version + 1, updated_at = ?
       WHERE id = ? AND status_version = ? AND status IN ('dispatched', 'running', 'cancel_requested')
    `).run(
      input.status, input.completedAt, input.outputText, input.outputSha256,
      input.usage?.inputTokens ?? null, input.usage?.outputTokens ?? null,
      input.usage?.cachedInputTokens ?? null, input.usage?.cacheCreationInputTokens ?? null,
      input.usage?.totalTokens ?? null, null,
      input.usage ? "complete" : "pending", input.errorCode, input.completedAt,
      id, current.statusVersion,
    );
    assertSingleChange(changed.changes, id, "写入 Run 终态");
    return this.requireRun(id);
  }

  /** 返回普通 Codex 重启门禁需要感知的实验运行态。 */
  listRunningForSessionGate(): Array<{ workspaceId: string; threadId: string; turnId: string; engine: string; startedAt: number | null }> {
    return this.listRecoverableRuns().map((run) => ({
      workspaceId: this.getSnapshot(run.snapshotId)?.workspaceId ?? "",
      threadId: run.id,
      turnId: run.clientTurnId,
      engine: run.engine,
      startedAt: run.startedAt,
    }));
  }

  /** 读取 Run，不存在时抛出可关联主键的错误。 */
  private requireRun(id: string): ControlledExperimentLocalRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`受控实验本地 Run 不存在：runId=${id}`);
    return run;
  }
}

/** 构造冻结快照的统一 SELECT，避免字段映射漂移。 */
function selectSnapshotSql(): string {
  return `SELECT id, experiment_id, freeze_revision, freeze_digest, workspace_id, sample_id,
    evaluation_item_id, source_instance_id, node_id, prompt_snapshot_id, ordinal, variant_key,
    engine, model, effort, catalog_version, prompt_envelope_json, system_message, developer_message, user_message,
    artifact_input_json, input_sha256, config_sha256, prompt_definition_sha256, price_snapshot_json,
    price_snapshot_sha256, per_run_timeout_ms, created_at FROM controlled_experiment_snapshots`;
}

/** 构造本地 Run 的统一 SELECT，避免状态接口漏字段。 */
function selectRunSql(): string {
  return `SELECT id, experiment_id, assignment_id, sample_id, variant_key, attempt_no, snapshot_id,
    dispatch_token_sha256, status, status_version, client_turn_id, engine, engine_session_id,
    engine_turn_id, deadline_at, started_at, completed_at, output_text, output_sha256,
    input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, total_tokens,
    estimated_cost_micros, usage_accounting_status, event_log_json, error_code, created_at, updated_at
    FROM controlled_experiment_runs`;
}

/** 将 SQLite 快照行还原为强类型本地证据。 */
function rowToSnapshot(row: SnapshotRow): ControlledExperimentLocalSnapshot {
  return {
    id: String(row.id), experimentId: String(row.experiment_id), freezeRevision: Number(row.freeze_revision),
    freezeDigest: String(row.freeze_digest), workspaceId: String(row.workspace_id), sampleId: String(row.sample_id),
    evaluationItemId: String(row.evaluation_item_id), sourceInstanceId: String(row.source_instance_id),
    nodeId: String(row.node_id), promptSnapshotId: String(row.prompt_snapshot_id), ordinal: Number(row.ordinal),
    variantKey: String(row.variant_key) as ControlledExperimentVariantKey,
    engine: String(row.engine) as EngineType, model: String(row.model), effort: normalizeOptionalText(row.effort),
    catalogVersion: Number(row.catalog_version),
    promptEnvelope: parseJson<NodePromptEnvelope>(row.prompt_envelope_json, "promptEnvelope"),
    systemMessage: String(row.system_message), developerMessage: normalizeOptionalText(row.developer_message),
    userMessage: String(row.user_message), artifactInput: parseJson<NodeArtifactInput>(row.artifact_input_json, "artifactInput"),
    inputSha256: String(row.input_sha256), configSha256: String(row.config_sha256),
    promptDefinitionSha256: String(row.prompt_definition_sha256),
    priceSnapshot: null,
    priceSnapshotSha256: String(row.price_snapshot_sha256), perRunTimeoutMs: Number(row.per_run_timeout_ms),
    createdAt: Number(row.created_at),
  };
}

/** 将 SQLite Run 行还原为强类型本地证据。 */
function rowToRun(row: RunRow): ControlledExperimentLocalRun {
  return {
    id: String(row.id), experimentId: String(row.experiment_id), assignmentId: String(row.assignment_id),
    sampleId: String(row.sample_id), variantKey: String(row.variant_key) as ControlledExperimentVariantKey,
    attemptNo: Number(row.attempt_no), snapshotId: String(row.snapshot_id),
    dispatchTokenSha256: String(row.dispatch_token_sha256), status: String(row.status) as ControlledExperimentLocalRun["status"],
    statusVersion: Number(row.status_version), clientTurnId: String(row.client_turn_id), engine: String(row.engine) as EngineType,
    engineSessionId: normalizeOptionalText(row.engine_session_id), engineTurnId: normalizeOptionalText(row.engine_turn_id),
    deadlineAt: Number(row.deadline_at), startedAt: nullableNumber(row.started_at), completedAt: nullableNumber(row.completed_at),
    outputText: row.output_text == null ? null : String(row.output_text), outputSha256: normalizeOptionalText(row.output_sha256),
    inputTokens: nullableNumber(row.input_tokens), outputTokens: nullableNumber(row.output_tokens),
    cachedInputTokens: nullableNumber(row.cached_input_tokens), cacheCreationInputTokens: nullableNumber(row.cache_creation_input_tokens),
    totalTokens: nullableNumber(row.total_tokens), estimatedCostMicros: nullableNumber(row.estimated_cost_micros),
    usageAccountingStatus: String(row.usage_accounting_status) as ControlledExperimentUsageAccountingStatus,
    eventLog: parseJson<unknown[]>(row.event_log_json, "eventLog"), errorCode: normalizeOptionalText(row.error_code),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** 校验重复 dispatch 的全部稳定身份，避免同 Run ID 复用为另一调用。 */
function assertRunIdentity(existing: ControlledExperimentLocalRun, input: {
  experimentId: string; assignmentId: string; sampleId: string; variantKey: ControlledExperimentVariantKey;
  attemptNo: number; snapshotId: string; dispatchTokenSha256: string; clientTurnId: string; engine: EngineType; deadlineAt: number;
}): void {
  const fields = ["experimentId", "assignmentId", "sampleId", "variantKey", "attemptNo", "snapshotId",
    "dispatchTokenSha256", "clientTurnId", "engine", "deadlineAt"] as const;
  const mismatch = fields.find((field) => existing[field] !== input[field]);
  if (mismatch) {
    throw new ControlledExperimentRunConflictError(
      `受控实验重复 dispatch 身份冲突：runId=${existing.id}, field=${mismatch}`,
    );
  }
}

/** 解析受控实验 JSON；损坏证据必须显式失败。 */
function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new Error(`受控实验 ${label} 不是 JSON 文本`);
  const parsed = JSON.parse(value) as unknown;
  if (parsed == null || typeof parsed !== "object") throw new Error(`受控实验 ${label} JSON 结构无效`);
  return parsed as T;
}

/** 将可空 SQLite 数字字段恢复为 number/null。 */
function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

/** 归一化可空文本，不把空串当作有效 provider 身份。 */
function normalizeOptionalText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** 要求 CAS 正好修改一行。 */
function assertSingleChange(changes: number | bigint | undefined, id: string, action: string): void {
  if (Number(changes ?? 0) !== 1) throw new Error(`${action}发生并发冲突：runId=${id}`);
}

export { ACTIVE_STATUSES };
