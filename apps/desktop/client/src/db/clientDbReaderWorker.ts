import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import fs from "node:fs";

import {
  readOrchIntakeListSnapshot,
  validateOrchIntakeListProjectionIntegrity,
} from "./orchIntakeListSnapshot.js";
import {
  CLIENT_DB_READER_SCHEMA_VERSION,
  sanitizeClientDbReaderRootCauseMessage,
  type ClientDbReaderCloseCommand,
  type ClientDbReaderCommand,
  type ClientDbReaderErrorCode,
  type ClientDbReaderErrorData,
  type ClientDbReaderListIntakesCommand,
  type ClientDbReaderTimings,
  type ClientDbReaderWorkerData,
  type ClientDbReaderWorkerMessage,
  type ClientDbWorkspaceReaderSource,
} from "./clientDbReaderProtocol.js";
import { openSqliteDb, type SqliteDb } from "./sqliteDb.js";

const SUMMARY_TABLE = "orch_instance_summaries";
const SUMMARY_INDEXES = [
  "idx_orch_instance_summaries_workspace_display",
  "idx_orch_instance_summaries_workspace_intake_display",
] as const;
const SUMMARY_INDEX_SQL: Record<(typeof SUMMARY_INDEXES)[number], string> = {
  idx_orch_instance_summaries_workspace_display: `
    CREATE INDEX idx_orch_instance_summaries_workspace_display
    ON orch_instance_summaries(
      workspace_id,
      CASE
        WHEN status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0
        ELSE 1
      END,
      source_updated_at DESC,
      instance_id DESC
    )
  `,
  idx_orch_instance_summaries_workspace_intake_display: `
    CREATE INDEX idx_orch_instance_summaries_workspace_intake_display
    ON orch_instance_summaries(
      workspace_id,
      intake_id,
      CASE
        WHEN status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0
        ELSE 1
      END,
      source_updated_at DESC,
      instance_id DESC,
      status
    )
  `,
};
const READER_TABLE_COLUMNS: Record<string, readonly string[]> = {
  orch_instance_summaries: [
    "instance_id",
    "workspace_id",
    "intake_id",
    "status",
    "source_updated_at",
    "summary_json",
    "projection_version",
  ],
  orch_intake_list_states: [
    "workspace_id",
    "intake_id",
    "source_kind",
    "list_status",
    "latest_instance_id",
    "latest_instance_status",
    "instance_count",
    "workflow_name",
    "progress_text",
    "updated_at",
  ],
  orch_intakes: ["id", "workspace_id", "intake_json", "created_at", "updated_at"],
  orch_intake_search_fts: ["intake_id", "workspace_id", "source_kind", "title", "summary"],
  orch_artifacts: ["instance_id"],
  reminder_receipts: ["entity_type", "workspace_id", "entity_id", "marker"],
};
const READER_INDEX_TABLES: Record<string, string> = {
  idx_orch_instance_summaries_workspace_display: SUMMARY_TABLE,
  idx_orch_instance_summaries_workspace_intake_display: SUMMARY_TABLE,
  idx_orch_intake_list_states_workspace_source_status_updated: "orch_intake_list_states",
  idx_orch_intake_list_states_workspace_source_updated: "orch_intake_list_states",
  idx_orch_artifacts_instance_node: "orch_artifacts",
};
const PROJECTION_ERROR_CODES = new Set([
  "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID",
  "ORCH_INSTANCE_SUMMARY_PROJECTION_MISMATCH",
  "ORCH_INSTANCE_SUMMARY_PROJECTION_MISSING",
]);
const SNAPSHOT_ERROR_CODES = new Set([
  "ORCH_INTAKE_LIST_PROJECTION_INCOMPLETE",
  "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID",
  "ORCH_INTAKE_LIST_SNAPSHOT_STATE_INVALID",
]);
const SAFE_DETAIL_KEYS = new Set([
  "actual",
  "actualSchemaVersion",
  "actualProjectionVersion",
  "actualSourceUpdatedAt",
  "expected",
  "expectedSchemaVersion",
  "expectedProjectionVersion",
  "expectedSourceUpdatedAt",
  "field",
  "instanceId",
  "intakeId",
  "intakeWorkspaceId",
  "invalidIndexes",
  "jsonId",
  "jsonWorkspaceId",
  "missingColumns",
  "missingObjects",
  "projectionVersion",
  "projectionRole",
  "reason",
  "rootCauseMessage",
  "rootCauseType",
  "sourceUpdatedAt",
  "osErrorCode",
  "sqliteCode",
  "workspaceId",
]);

const port = requireParentPort(parentPort);

let database: SqliteDb | null = null;
let closing = false;
let workspaceMode = false;
let busyTimeoutMs: number | undefined;
let initializationCleanup: (() => void) | null = null;

/** 打开并校验独立只读连接，成功后才开始接收查询命令。 */
function startWorker(): void {
  try {
    const input = normalizeWorkerData(workerData);
    workspaceMode = input.workspaceMode === true;
    busyTimeoutMs = input.busyTimeoutMs;
    if (!workspaceMode) {
      database = openReaderDatabase(input.dbPath);
      enableAndValidateReadOnlyMode(database);
      validateReaderSchema(database);
    }
    port.on("message", handleCommand);
    port.once("messageerror", handleCommandMessageError);
    post({ type: "ready", schemaVersion: CLIENT_DB_READER_SCHEMA_VERSION });
  } catch (error) {
    const closeError = closeDatabase();
    post({
      type: "init.failed",
      error: appendCloseFailure(toErrorData(error, "CLIENT_DB_READER_INIT_FAILED", "init"), closeError),
    });
    port.close();
  }
}

/** 处理串行到达的查询或关闭命令。 */
function handleCommand(value: unknown): void {
  if (closing) return;
  if (isListIntakesCommand(value)) {
    runListIntakes(value);
    return;
  }
  if (isCloseCommand(value)) {
    closeWorker(value);
    return;
  }
  failProtocolAndClose("invalid_command");
}

/** 反序列化命令失败时拒绝协议并关闭连接，避免主线程 pending 永久悬挂。 */
function handleCommandMessageError(error: Error): void {
  if (closing) return;
  failProtocolAndClose("worker_command_deserialize_failed", error);
}

/** 在一个同步读阶段内生成需求列表快照并回传耗时。 */
function runListIntakes(command: ClientDbReaderListIntakesCommand): void {
  const startedAtNs = process.hrtime.bigint();
  const queueMs = elapsedMs(command.queuedAtNs, startedAtNs);
  let result: ReturnType<typeof readOrchIntakeListSnapshot> | undefined;
  let failure: unknown;
  let failed = false;
  try {
    if (workspaceMode) {
      const source = requireWorkspaceSource(command);
      verifyWorkspaceSource(source);
      database = openReaderDatabase(source.dbPath);
      verifyWorkspaceSource(source);
      enableAndValidateReadOnlyMode(database);
      const db = database;
      result = db.transaction(() => {
        validateReaderSchema(db, true);
        return readOrchIntakeListSnapshot(db, command.input);
      })();
      verifyWorkspaceSource(source);
    } else result = readOrchIntakeListSnapshot(requireDatabase(), command.input);
  } catch (error) {
    failure = error; failed = true;
  }
  const closeError = workspaceMode ? closeDatabase() : null;
  if (closeError) {
    closing = true;
    post({ type: "fatal", error: appendCloseFailure(toErrorData(failed ? failure : closeError.error,
      "CLIENT_DB_READER_CLOSE_FAILED", "close"), closeError) });
    port.close();
    return;
  }
  const timings = { queueMs, dbMs: elapsedMs(startedAtNs) } satisfies ClientDbReaderTimings;
  if (failed) post({ type: "failed", commandId: command.commandId, requestId: command.requestId,
    error: toErrorData(failure, "CLIENT_DB_READER_QUERY_FAILED", "query"), timings });
  else post({ type: "result", commandId: command.commandId, requestId: command.requestId, result: result!, timings });
}

/** 排空由主线程保证；收到关闭命令后立即关闭连接并退出。 */
function closeWorker(command: ClientDbReaderCloseCommand): void {
  closing = true;
  const closeError = closeDatabase();
  if (closeError) {
    post({
      type: "close.failed",
      commandId: command.commandId,
      error: toErrorData(closeError.error, "CLIENT_DB_READER_CLOSE_FAILED", "close"),
    });
  } else {
    post({ type: "closed", commandId: command.commandId });
  }
  port.close();
}

/** 对不可关联的畸形消息显式失败并释放只读连接。 */
function failProtocolAndClose(reason: string, cause?: unknown): void {
  closing = true;
  const protocolError = new ReaderWorkerError(
    "CLIENT_DB_READER_PROTOCOL_INVALID",
    { reason, ...safeRuntimeDetails(cause) },
  );
  const closeError = closeDatabase();
  post({
    type: "fatal",
    error: appendCloseFailure(toErrorData(protocolError, protocolError.code, "protocol"), closeError),
  });
  port.close();
}

/** 打开 query_only 并回读确认，禁止只读连接意外执行写操作。 */
function enableAndValidateReadOnlyMode(db: SqliteDb): void {
  db.pragma("query_only = ON");
  const enabled = Number(db.pragma("query_only", { simple: true }) ?? 0);
  if (enabled === 1) return;
  throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", {
    reason: "query_only_not_enabled",
  });
}

/** 校验当前 Client DB schema、摘要窄表、列和索引，Reader 不执行任何修复。 */
function validateReaderSchema(db: SqliteDb, workspace = false): void {
  const actualSchemaVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  if (actualSchemaVersion !== CLIENT_DB_READER_SCHEMA_VERSION) {
    throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH", {
      expectedSchemaVersion: CLIENT_DB_READER_SCHEMA_VERSION,
      actualSchemaVersion: Number.isFinite(actualSchemaVersion) ? actualSchemaVersion : null,
    });
  }
  if (workspace) {
    const kind = Number(db.pragma("application_id", { simple: true }));
    if (kind !== 0x43465753) throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", { reason: "workspace_kind_invalid" });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) {
      throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", { reason: "workspace_core_schema_missing" });
    }
    const core = db.prepare("SELECT value FROM meta WHERE key = 'workspace_core_schema_version'").get() as { value?: unknown } | undefined;
    if (core?.value !== "1") throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", { reason: "workspace_core_schema_invalid" });
  }
  const journalMode = String(db.pragma("journal_mode", { simple: true }) ?? "").trim().toLowerCase();
  const expectedJournal = workspace ? "delete" : "wal";
  if (journalMode !== expectedJournal) {
    throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", {
      reason: "journal_mode_invalid",
      expected: expectedJournal,
      actual: journalMode || "unknown",
    });
  }

  const requiredTables = Object.keys(READER_TABLE_COLUMNS);
  const requiredIndexes = Object.keys(READER_INDEX_TABLES);
  const requiredNames = [...requiredTables, ...requiredIndexes];
  const objects = db.prepare(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE name IN (${requiredNames.map(() => "?").join(", ")})`,
  ).all(...requiredNames) as Array<{
    type?: unknown;
    name?: unknown;
    tbl_name?: unknown;
    sql?: unknown;
  }>;
  const missingObjects = [
    ...requiredTables.filter((name) => !objects.some((row) => row.type === "table" && row.name === name)),
    ...requiredIndexes.filter((name) => !objects.some(
      (row) => row.type === "index" && row.name === name && row.tbl_name === READER_INDEX_TABLES[name],
    )),
  ];
  if (missingObjects.length > 0) {
    throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", {
      reason: "reader_schema_missing",
      missingObjects,
    });
  }
  const invalidIndexes = SUMMARY_INDEXES.filter((name) => {
    const row = objects.find((item) => item.type === "index" && item.name === name);
    return normalizeSchemaSql(row?.sql) !== normalizeSchemaSql(SUMMARY_INDEX_SQL[name]);
  });
  if (invalidIndexes.length > 0) {
    throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", {
      reason: "summary_indexes_invalid",
      invalidIndexes,
    });
  }

  const missingColumns = requiredTables.flatMap((table) => {
    const columns = new Set(
      (db.pragma(`table_info(${table})`) as Array<{ name?: unknown }> | undefined ?? [])
        .map((row) => String(row.name ?? "")),
    );
    return READER_TABLE_COLUMNS[table]!.filter((column) => !columns.has(column))
      .map((column) => `${table}.${column}`);
  });
  if (missingColumns.length > 0) {
    throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", {
      reason: "reader_columns_missing",
      missingColumns,
    });
  }
  validateOrchIntakeListProjectionIntegrity(db);
}

/** 规范化 sqlite_master SQL，忽略空白、分号和 IF NOT EXISTS 的存储差异。 */
function normalizeSchemaSql(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bif\s+not\s+exists\b/g, "")
    .replace(/\s+/g, "")
    .replace(/;+$/g, "");
}

/** 校验普通 SQLite Worker 启动参数。 */
function normalizeWorkerData(value: unknown): ClientDbReaderWorkerData {
  if (!isRecord(value)) {
    throw new ReaderWorkerError("CLIENT_DB_READER_PROTOCOL_INVALID", { reason: "invalid_worker_data" });
  }
  const dbPath = typeof value.dbPath === "string" ? value.dbPath.trim() : "";
  if (!dbPath) {
    throw new ReaderWorkerError("CLIENT_DB_READER_PROTOCOL_INVALID", { reason: "missing_db_path" });
  }
  if (value.busyTimeoutMs !== undefined
    && (typeof value.busyTimeoutMs !== "number" || !Number.isFinite(value.busyTimeoutMs))) {
    throw new ReaderWorkerError("CLIENT_DB_READER_PROTOCOL_INVALID", { reason: "invalid_busy_timeout" });
  }
  if (value.workspaceMode !== undefined && typeof value.workspaceMode !== "boolean") {
    throw new ReaderWorkerError("CLIENT_DB_READER_PROTOCOL_INVALID", { reason: "invalid_workspace_mode" });
  }
  return {
    dbPath,
    busyTimeoutMs: typeof value.busyTimeoutMs === "number" ? value.busyTimeoutMs : undefined,
    workspaceMode: value.workspaceMode === true,
  };
}

/** 消息中的来源必须来自主线程可信租约，且与本次查询 W 严格一致。 */
function requireWorkspaceSource(command: ClientDbReaderListIntakesCommand): ClientDbWorkspaceReaderSource {
  const source = command.source;
  if (!source || typeof source.dbPath !== "string" || !source.dbPath || source.workspaceId !== command.input.workspaceId
    || typeof source.dev !== "string" || typeof source.ino !== "string") {
    throw new ReaderWorkerError("CLIENT_DB_READER_PROTOCOL_INVALID", { reason: "workspace_source_invalid" });
  }
  return source;
}

/** 开库前后核对真实文件身份，拒绝链接、文件替换和目录来源。 */
function verifyWorkspaceSource(source: ClientDbWorkspaceReaderSource): void {
  const stat = fs.lstatSync(source.dbPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || String(stat.dev) !== source.dev || String(stat.ino) !== source.ino) {
    throw new ReaderWorkerError("CLIENT_DB_READER_SCHEMA_INVALID", { reason: "workspace_source_replaced", workspaceId: source.workspaceId });
  }
}

/** 校验列表命令的关联 ID、单调时钟和 requestId 一致性。 */
function isListIntakesCommand(value: unknown): value is ClientDbReaderListIntakesCommand {
  if (!isRecord(value) || value.type !== "listIntakes") return false;
  if (!isProtocolId(value.commandId) || !isProtocolId(value.requestId)) return false;
  if (typeof value.queuedAtNs !== "bigint" || !isRecord(value.input)) return false;
  return value.input.requestId === value.requestId;
}

/** 校验关闭命令，只接受一个可关联的 commandId。 */
function isCloseCommand(value: unknown): value is ClientDbReaderCloseCommand {
  return isRecord(value) && value.type === "close" && isProtocolId(value.commandId);
}

/** 限定协议关联 ID 长度，避免畸形消息进入错误详情。 */
function isProtocolId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** 返回已打开连接；生命周期异常时显式失败。 */
function requireDatabase(): SqliteDb {
  if (database) return database;
  throw new ReaderWorkerError("CLIENT_DB_READER_CLOSED", { reason: "database_not_open" });
}

/** 关闭连接并返回关闭异常，供原始失败附加诊断。 */
function closeDatabase(): { error: unknown } | null {
  const current = database;
  if (!current && !initializationCleanup) return null;
  try {
    if (current) current.close();
    else initializationCleanup!();
    database = null;
    initializationCleanup = null;
    return null;
  } catch (error) {
    return { error };
  }
}

/** 初始化失败的未关闭原生句柄也交本 Worker 生命周期重试，绝不遗失关闭 owner。 */
function openReaderDatabase(dbPath: string): SqliteDb {
  return openSqliteDb(dbPath, { readonly: true, fileMustExist: true, busyTimeoutMs,
    onInitializationCleanupFailure: close => { initializationCleanup = close; } });
}

/** 把关闭失败合入原错误，避免初始化异常处理阶段静默丢失。 */
function appendCloseFailure(error: ClientDbReaderErrorData, closeError: { error: unknown } | null): ClientDbReaderErrorData {
  if (!closeError) return error;
  return {
    ...error,
    details: {
      ...error.details,
      closeFailure: safeRuntimeDetails(closeError.error),
    },
  };
}

/** 将 Worker 内异常转换为不含路径、SQL 和明文消息的稳定协议错误。 */
function toErrorData(
  error: unknown,
  fallbackCode: ClientDbReaderErrorCode,
  phase: "init" | "query" | "protocol" | "close",
): ClientDbReaderErrorData {
  if (error instanceof ReaderWorkerError) {
    return {
      code: error.code,
      message: errorMessage(error.code),
      details: { phase, ...sanitizeDetails(error.details) },
    };
  }
  const sourceCode = readErrorCode(error);
  if (PROJECTION_ERROR_CODES.has(sourceCode)) {
    return {
      code: "ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID",
      message: errorMessage("ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID"),
      details: {
        phase,
        causeCode: sourceCode,
        ...sanitizeDetails(readErrorDetails(error)),
      },
    };
  }
  if (SNAPSHOT_ERROR_CODES.has(sourceCode)) {
    return {
      code: "ORCH_INTAKE_LIST_SNAPSHOT_INVALID",
      message: errorMessage("ORCH_INTAKE_LIST_SNAPSHOT_INVALID"),
      details: {
        phase,
        causeCode: sourceCode,
        ...sanitizeDetails(readErrorDetails(error)),
      },
    };
  }
  return {
    code: fallbackCode,
    message: errorMessage(fallbackCode),
    details: {
      phase,
      ...safeRuntimeDetails(error),
    },
  };
}

/** 提取允许跨线程传输的异常类型、短根因和 SQLite/系统错误码。 */
function safeRuntimeDetails(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const code = readErrorCode(error);
  const sqliteError = /^SQLITE_[A-Z0-9_]{1,48}$/.test(code);
  if (isRecord(error)) {
    const type = String(error.name ?? error.constructor?.name ?? "Error");
    if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(type)) details.rootCauseType = type;
  }
  if (sqliteError) details.sqliteCode = code;
  else if (/^[A-Z][A-Z0-9_]{1,31}$/.test(code)) details.osErrorCode = code;
  const rootCauseMessage = sanitizeClientDbReaderRootCauseMessage(isRecord(error) ? error.message : error);
  if (!sqliteError && rootCauseMessage) details.rootCauseMessage = rootCauseMessage;
  return details;
}

/** 仅保留投影错误中可检索且不含敏感内容的字段。 */
function sanitizeDetails(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, detail] of Object.entries(value)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (key === "rootCauseMessage") {
      const rootCauseMessage = sanitizeClientDbReaderRootCauseMessage(detail);
      if (rootCauseMessage) result[key] = rootCauseMessage;
      continue;
    }
    if (typeof detail === "number" && Number.isFinite(detail)) result[key] = detail;
    else if (typeof detail === "string" && detail.length <= 256) result[key] = detail;
    else if (detail === null || typeof detail === "boolean") result[key] = detail;
    else if (Array.isArray(detail)
      && detail.length <= 32
      && detail.every((item) => typeof item === "string" && item.length <= 128)) {
      result[key] = [...detail];
    }
  }
  return result;
}

/** 读取异常 code；非字符串或过长值不跨线程传播。 */
function readErrorCode(error: unknown): string {
  if (!isRecord(error) || typeof error.code !== "string" || error.code.length > 64) return "";
  return error.code;
}

/** 读取异常 details；具体字段仍由白名单二次过滤。 */
function readErrorDetails(error: unknown): unknown {
  return isRecord(error) ? error.details : undefined;
}

/** 返回各错误码对应的固定消息，禁止透传驱动原始文本。 */
function errorMessage(code: ClientDbReaderErrorCode): string {
  switch (code) {
    case "CLIENT_DB_READER_CLOSED": return "数据库只读 Worker 已关闭";
    case "CLIENT_DB_READER_CLOSING": return "数据库只读 Worker 正在关闭";
    case "CLIENT_DB_READER_CLOSE_FAILED": return "数据库只读 Worker 关闭失败";
    case "CLIENT_DB_READER_DIAGNOSTIC_FAILED": return "数据库只读诊断回调失败";
    case "CLIENT_DB_READER_INIT_FAILED": return "数据库只读 Worker 初始化失败";
    case "CLIENT_DB_READER_INVALID_INPUT": return "数据库只读查询参数无效";
    case "CLIENT_DB_READER_PROTOCOL_INVALID": return "数据库只读 Worker 协议无效";
    case "CLIENT_DB_READER_QUERY_FAILED": return "数据库只读查询失败";
    case "CLIENT_DB_READER_SCHEMA_INVALID": return "数据库只读 Worker 所需结构无效";
    case "CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH": return "数据库版本与只读 Worker 不匹配";
    case "CLIENT_DB_READER_WORKER_FAILED": return "数据库只读 Worker 异常退出";
    case "ORCH_INTAKE_LIST_SNAPSHOT_INVALID": return "需求列表只读快照无效";
    case "ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID": return "实例摘要投影无效";
  }
}

/** 计算单调时钟毫秒差并保留两位小数。 */
function elapsedMs(startedAtNs: bigint, endedAtNs = process.hrtime.bigint()): number {
  const elapsed = endedAtNs > startedAtNs ? endedAtNs - startedAtNs : 0n;
  return Math.round(Number(elapsed) / 10_000) / 100;
}

/** 判断普通对象，供跨线程协议与错误字段校验。 */
function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 取得父线程端口；脱离 Worker 直接加载时立即失败。 */
function requireParentPort(value: MessagePort | null): MessagePort {
  if (value) return value;
  throw new Error("Client DB reader worker requires parentPort");
}

/** 发送已收敛为 structured-clone 数据的 Worker 消息。 */
function post(message: ClientDbReaderWorkerMessage): void {
  port.postMessage(message);
}

class ReaderWorkerError extends Error {
  /** 保存稳定错误码和已脱敏详情，不承载底层异常消息。 */
  constructor(
    readonly code: ClientDbReaderErrorCode,
    readonly details: Record<string, unknown>,
  ) {
    super(errorMessage(code));
    this.name = "ReaderWorkerError";
  }
}

startWorker();
