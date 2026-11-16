import type { OrchIntakesListResponseBody, WorkspaceId } from "@codeflowai/shared";

import type { OrchIntakeListSnapshotInput } from "./orchIntakeListSnapshot.js";

export { CLIENT_DB_SCHEMA_VERSION as CLIENT_DB_READER_SCHEMA_VERSION } from "./clientDbSchemaVersion.js";
export const CLIENT_DB_READER_ROOT_CAUSE_MESSAGE_MAX_LENGTH = 256;

/** 脱敏并限制 Reader 根因短消息；不允许路径、凭据或长密钥跨线程传播。 */
export function sanitizeClientDbReaderRootCauseMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replace(/\bauthorization\s*[:=]\s*[^\s,;]+(?:\s+[^\s,;]+)?/giu, "authorization=<redacted>")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/giu, "bearer <redacted>")
    .replace(
      /\b(token|password|secret|api[_-]?key|data[_-]?key|raw[_-]?key|custom[_-]?key|key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1=<redacted>",
    )
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+/giu, "<url>")
    .replace(/\\\\[^\\\s]+\\[^\r\n]*/gu, "<path>")
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*/gu, "<path>")
    .replace(/(^|[^A-Za-z0-9])\/(?!\/)(?:[^\s\r\n"'`<>]+\/?)+/gu, "$1<path>")
    .replace(/\b[0-9a-f]{64,}\b/giu, "<redacted>")
    .replace(/\b[A-Za-z0-9+/_-]{96,}={0,2}\b/gu, "<redacted>")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized ? sanitized.slice(0, CLIENT_DB_READER_ROOT_CAUSE_MESSAGE_MAX_LENGTH) : null;
}

export type ClientDbReaderErrorCode =
  | "CLIENT_DB_READER_CLOSED"
  | "CLIENT_DB_READER_CLOSING"
  | "CLIENT_DB_READER_CLOSE_FAILED"
  | "CLIENT_DB_READER_DIAGNOSTIC_FAILED"
  | "CLIENT_DB_READER_INIT_FAILED"
  | "CLIENT_DB_READER_INVALID_INPUT"
  | "CLIENT_DB_READER_PROTOCOL_INVALID"
  | "CLIENT_DB_READER_QUERY_FAILED"
  | "CLIENT_DB_READER_SCHEMA_INVALID"
  | "CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH"
  | "CLIENT_DB_READER_WORKER_FAILED"
  | "ORCH_INTAKE_LIST_SNAPSHOT_INVALID"
  | "ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID";

export type ClientDbReaderErrorData = {
  code: ClientDbReaderErrorCode;
  message: string;
  details: Record<string, unknown>;
};

export type ClientDbReaderTimings = {
  queueMs: number;
  dbMs: number;
};

export type ClientDbReaderDiagnostic = ClientDbReaderTimings & {
  operation: "listIntakes";
  outcome: "success" | "failed";
  commandId: string;
  requestId: string;
  /** 只由主线程已取得的工作区租约确定；legacy 应用查询为 null。 */
  workspaceId?: WorkspaceId | null;
  errorCode?: ClientDbReaderErrorCode;
  /** 仅失败诊断携带既有脱敏详情；原始异常仍只保存在主线程 cause。 */
  rootCause?: Record<string, unknown>;
};

export type ClientDbReaderWorkerData = {
  dbPath: string;
  busyTimeoutMs?: number;
  workspaceMode?: boolean;
};

export type ClientDbWorkspaceReaderSource = { dbPath: string; workspaceId: string; dev: string; ino: string };
export type ClientDbWorkspaceReaderLease = {
  source: ClientDbWorkspaceReaderSource;
  verify: () => void;
  release: () => void;
};

export type ClientDbReaderListIntakesCommand = {
  type: "listIntakes";
  commandId: string;
  requestId: string;
  queuedAtNs: bigint;
  input: OrchIntakeListSnapshotInput;
  source?: ClientDbWorkspaceReaderSource;
};

export type ClientDbReaderCloseCommand = {
  type: "close";
  commandId: string;
};

export type ClientDbReaderCommand = ClientDbReaderListIntakesCommand | ClientDbReaderCloseCommand;

export type ClientDbReaderWorkerMessage =
  | { type: "ready"; schemaVersion: number }
  | {
      type: "result";
      commandId: string;
      requestId: string;
      result: OrchIntakesListResponseBody;
      timings: ClientDbReaderTimings;
    }
  | {
      type: "failed";
      commandId: string;
      requestId: string;
      error: ClientDbReaderErrorData;
      timings: ClientDbReaderTimings;
    }
  | { type: "init.failed"; error: ClientDbReaderErrorData }
  | { type: "fatal"; error: ClientDbReaderErrorData }
  | { type: "closed"; commandId: string }
  | { type: "close.failed"; commandId: string; error: ClientDbReaderErrorData };

export type ClientDbReaderListIntakesResult = OrchIntakesListResponseBody;
export type { OrchIntakeListSnapshotInput };
