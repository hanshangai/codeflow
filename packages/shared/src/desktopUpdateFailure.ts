import crypto from "node:crypto";

export type UpdateFailureContext = {
  deviceId: string;
  shellVersion: string;
  currentReleaseId: string;
  webVersion: string;
  clientVersion: string;
};
type Recovery = "not_needed" | "restored" | "failed";
type DiagnosticCause = { name: string; code: string; causes?: DiagnosticCause[] };
export type UpdateFailureRecord = UpdateFailureContext & {
  schemaVersion: 1;
  kind: "failure";
  errorId: string;
  at: string;
  errorCode: "DESKTOP_RELEASE_FAILED";
  requestId: string;
  releaseId: string;
  phase: string;
  recovery: Recovery;
  rootCause: DiagnosticCause;
  rollbackError: DiagnosticCause | null;
  payloadSha256: string;
};
export type ShellUpdateFailureRecord = Omit<UpdateFailureRecord, "errorCode" | "releaseId" | "phase"> & {
  errorCode: "DESKTOP_SHELL_UPDATE_FAILED";
  shellId: string | null;
  phase: "prepare" | "download" | "install" | "health" | "handoff" | "admission-intent" | "recovery";
};
export type DesktopUpdateFailureRecord = UpdateFailureRecord | ShellUpdateFailureRecord;
export type UpdateFailureAck = { errorId: string; deviceId: string; payloadSha256: string };

const errorNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError", "AbortError"]);
// 上传方与 Server 的操作系统可能不同，诊断码采用相同的公开名单。
const systemCodes = new Set((
  "E2BIG EACCES EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EAGAIN EALREADY EAUTH EBADARCH EBADEXEC EBADF EBADMACHO EBADMSG EBADRPC EBUSY ECANCELED ECHILD ECONNABORTED ECONNREFUSED ECONNRESET EDEADLK EDESTADDRREQ EDEVERR EDOM EDQUOT EEXIST EFAULT EFBIG EFTYPE EHOSTDOWN EHOSTUNREACH EIDRM EILSEQ EINPROGRESS EINTR EINVAL EIO EISCONN EISDIR ELOOP EMFILE EMLINK EMSGSIZE EMULTIHOP ENAMETOOLONG ENEEDAUTH ENETDOWN ENETRESET ENETUNREACH ENFILE ENOATTR ENOBUFS ENODATA ENODEV ENOENT ENOEXEC ENOLCK ENOLINK ENOMEM ENOMSG ENOPOLICY ENOPROTOOPT ENOSPC ENOSR ENOSTR ENOSYS ENOTBLK ENOTCONN ENOTDIR ENOTEMPTY ENOTRECOVERABLE ENOTSOCK ENOTSUP ENOTTY ENXIO EOPNOTSUPP EOVERFLOW EOWNERDEAD EPERM EPFNOSUPPORT EPIPE EPROCLIM EPROCUNAVAIL EPROGMISMATCH EPROGUNAVAIL EPROTO EPROTONOSUPPORT EPROTOTYPE EPWROFF ERANGE EREMOTE EROFS ERPCMISMATCH ESHLIBVERS ESHUTDOWN ESOCKTNOSUPPORT ESPIPE ESRCH ESTALE ETIME ETIMEDOUT ETOOMANYREFS ETXTBSY EUSERS EWOULDBLOCK EXDEV "
  + "WSAEACCES WSAEADDRINUSE WSAEADDRNOTAVAIL WSAEAFNOSUPPORT WSAEALREADY WSAEBADF WSAECANCELLED WSAECONNABORTED WSAECONNREFUSED WSAECONNRESET WSAEDESTADDRREQ WSAEDISCON WSAEDQUOT WSAEFAULT WSAEHOSTDOWN WSAEHOSTUNREACH WSAEINPROGRESS WSAEINTR WSAEINVAL WSAEINVALIDPROCTABLE WSAEINVALIDPROVIDER WSAEISCONN WSAELOOP WSAEMFILE WSAEMSGSIZE WSAENAMETOOLONG WSAENETDOWN WSAENETRESET WSAENETUNREACH WSAENOBUFS WSAENOMORE WSAENOPROTOOPT WSAENOTCONN WSAENOTEMPTY WSAENOTSOCK WSAEOPNOTSUPP WSAEPFNOSUPPORT WSAEPROCLIM WSAEPROTONOSUPPORT WSAEPROTOTYPE WSAEPROVIDERFAILEDINIT WSAEREFUSED WSAEREMOTE WSAESHUTDOWN WSAESOCKTNOSUPPORT WSAESTALE WSAETIMEDOUT WSAETOOMANYREFS WSAEUSERS WSAEWOULDBLOCK WSANOTINITIALISED WSASERVICE_NOT_FOUND WSASYSCALLFAILURE WSASYSNOTREADY WSATYPE_NOT_FOUND WSAVERNOTSUPPORTED WSA_E_CANCELLED WSA_E_NO_MORE"
).split(" "));
// 固定网络原因可公开描述，保留分类而不记录远端正文或证书内容。
const networkCodes = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]);
const desktopCodes = [
  "DESKTOP_DB_SCHEMA_UPDATE_UNSUPPORTED", "DESKTOP_CURRENT_RUNTIME_NOT_HEALTHY", "DESKTOP_WINDOW_NOT_READY",
  "DESKTOP_CLIENT_NOT_READY", "DESKTOP_CLIENT_START_FAILED", "DESKTOP_CLIENT_DRAIN_TIMEOUT",
  "CLIENT_HEALTH_INVALID", "CLIENT_HEALTH_PROTOCOL_MISMATCH", "CLIENT_HEALTH_VERSION_REQUIRED", "CLIENT_HEALTH_DATABASE_NOT_READY",
  "CLIENT_HEALTH_VERSION_MISMATCH", "CLIENT_HEALTH_DB_SCHEMA_MISMATCH", "CLIENT_HEALTH_FAILED", "CLIENT_NOT_RUNNING", "CLIENT_NOT_READY",
  "CLIENT_EXIT_BEFORE_READY", "CLIENT_EXIT_BEFORE_SPAWN", "CLIENT_READY_TIMEOUT", "CLIENT_DRAIN_TIMEOUT", "CLIENT_RUNTIME_ALREADY_RUNNING",
  "DESKTOP_RELEASE_PRIVATE_KEY_INVALID", "DESKTOP_RELEASE_PUBLIC_KEY_INVALID", "DESKTOP_RELEASE_UNTRUSTED_KEY", "DESKTOP_RELEASE_SIGNATURE_INVALID",
  "DESKTOP_RELEASE_TRUST_INVALID", "DESKTOP_RELEASE_FILE_TYPE_INVALID", "DESKTOP_RELEASE_DIRECTORY_INVALID", "DESKTOP_RELEASE_ROOT_INVALID",
  "DESKTOP_RELEASE_MANIFEST_INVALID", "DESKTOP_RELEASE_PLATFORM_MISMATCH", "DESKTOP_RELEASE_EXPIRED", "DESKTOP_RELEASE_ARCHIVE_INVALID",
  "DESKTOP_RELEASE_ARCHIVE_MISMATCH", "DESKTOP_RELEASE_FILES_MISMATCH",
  "DESKTOP_RELEASE_DISCOVERY_FAILED", "DESKTOP_RELEASE_DOWNLOAD_FAILED", "DESKTOP_RELEASE_DOWNLOAD_CANCELLED",
  "DESKTOP_RELEASE_ETAG_MISMATCH", "DESKTOP_RELEASE_RESPONSE_INVALID", "DESKTOP_RELEASE_CACHE_CONFLICT", "DESKTOP_RELEASE_CACHE_UNSAFE",
  "DESKTOP_RELEASE_DOWNLOAD_BUSY", "DESKTOP_RELEASE_DOWNLOAD_CLEANUP_FAILED", "DESKTOP_RELEASE_DOWNLOAD_DISCARD_FAILED", "DESKTOP_RELEASE_MANIFEST_CLEANUP_FAILED",
  "DESKTOP_UPDATE_TRANSPORT_FAILED", "DESKTOP_UPDATE_HTTP_FAILED", "DESKTOP_UPDATE_UNAVAILABLE",
  "DESKTOP_UPDATE_RESPONSE_INVALID", "DESKTOP_DEVICE_REGISTRATION_ACK_INVALID",
  "DESKTOP_UPDATE_CHECK_FAILED", "DESKTOP_UPDATE_CHECK_SNAPSHOT_FAILED", "DESKTOP_UPDATE_CHECK_TAKE_FAILED",
  "DESKTOP_UPDATE_RESTART_FAILED", "DESKTOP_UPDATE_PROGRESS_INVALID",
  "DESKTOP_UPDATE_NOTICE_FAILED", "DESKTOP_UPDATE_NOTICE_DISMISS_FAILED",
  "DESKTOP_PENDING_RELEASE_INVALID", "DESKTOP_DB_BACKUP_INVALID", "DESKTOP_DB_BACKUP_FILE_INVALID",
  "DESKTOP_DB_BACKUP_ALREADY_EXISTS", "DESKTOP_DB_BACKUP_HASH_MISMATCH", "DESKTOP_DB_WORKSPACE_PATH_INVALID",
  "DESKTOP_DB_SCHEMA_DOWNGRADE_FORBIDDEN", "DESKTOP_DB_BACKUP_RECOVERY_FAILED", "DESKTOP_WEB_READY_TIMEOUT",
  "DESKTOP_WEB_READY_UNAVAILABLE", "CLIENT_RUNTIME_INCOMPATIBLE", "DESKTOP_CLI_RUNTIME_MISSING",
  "DESKTOP_STARTUP_CONTINUATION_FAILED", "DESKTOP_STARTUP_READY_INVALID", "DESKTOP_UPDATE_NOT_PREPARED",
  "DESKTOP_RESTART_UNAVAILABLE", "DESKTOP_STATE_WRITE_CLEANUP_FAILED", "DESKTOP_FILE_CLOSE_FAILED",
  "DESKTOP_DB_RESTORE_CLEANUP_FAILED", "DESKTOP_DIRECTORY_CLOSE_FAILED",
];
const releaseCauses = new Map([
  ["Web payload SHA-256 不匹配", "WEB_PAYLOAD_DIGEST_MISMATCH"],
  ["Client payload SHA-256 不匹配", "CLIENT_PAYLOAD_DIGEST_MISMATCH"],
  ["绑定包 SHA-256 不匹配", "RELEASE_DIGEST_MISMATCH"],
  ["待切换绑定包清单已变更", "STAGED_MANIFEST_CHANGED"],
  ["绑定包健康检查失败", "RELEASE_HEALTH_FAILED"],
  ["回退绑定包健康检查失败", "ROLLBACK_HEALTH_FAILED"],
  ["回退绑定包版本标识不匹配", "ROLLBACK_ID_MISMATCH"],
]);
const phases = new Set(["discovery", "download", "prepare", "read-active", "verify", "compatibility", "prepare-directory", "drain", "restart-client", "reload-web", "health", "activate"]);
const allowedCodes = new Set([...systemCodes, ...networkCodes, ...desktopCodes, ...releaseCauses.values(), "INVALID_JSON", "UNCLASSIFIED_ERROR"]);
const shellPhases = new Set(["prepare", "download", "install", "health", "handoff", "admission-intent", "recovery"]);
const shellCodes = new Set([
  "DESKTOP_SHELL_OPERATION_FAILED", "DESKTOP_SHELL_HANDOFF_HELPER_FAILED", "DESKTOP_SHELL_RECOVERY_HELPER_FAILED",
  "DESKTOP_SHELL_NETWORK_FAILED", "DESKTOP_SHELL_INSTALL_FAILED", "DESKTOP_SHELL_HEALTH_FAILED", "DESKTOP_SHELL_HANDOFF_PREPARATION_STARTUP_FAILED",
]);

/** 固定字段白名单同时约束写入和重读，摘要一致也不能把任意正文带入上传。 */
export function assertUpdateFailureRecord(value: unknown): asserts value is UpdateFailureRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid record");
  const record = value as UpdateFailureRecord;
  const keys = ["deviceId", "shellVersion", "currentReleaseId", "webVersion", "clientVersion", "requestId", "releaseId", "phase", "recovery",
    "schemaVersion", "kind", "errorId", "at", "errorCode", "rootCause", "rollbackError", "payloadSha256"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || record.schemaVersion !== 1 || record.kind !== "failure" || record.errorCode !== "DESKTOP_RELEASE_FAILED"
    || !phases.has(record.phase) || !["not_needed", "restored", "failed"].includes(record.recovery)) throw new Error("invalid record shape");
  for (const key of ["shellVersion", "currentReleaseId", "webVersion", "clientVersion", "requestId", "releaseId"] as const) {
    if (typeof record[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/.test(record[key])) throw new Error(`invalid ${key}`);
  }
  for (const key of ["deviceId", "errorId"] as const) {
    if (typeof record[key] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record[key])) throw new Error(`invalid ${key}`);
  }
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) || new Date(record.at).toISOString() !== record.at) throw new Error("invalid timestamp");
  assertDiagnostic(record.rootCause);
  if (record.rollbackError !== null) assertDiagnostic(record.rollbackError);
  const { payloadSha256, ...payload } = record;
  if (typeof payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(payloadSha256) || digestUpdateFailureRecord(payload) !== payloadSha256) throw new Error("invalid evidence digest");
}

/** 总入口显式区分绑定包与独立壳；读取前拒绝访问器，不改变旧绑定包 reader。 */
export function assertDesktopUpdateFailureRecord(value: unknown): asserts value is DesktopUpdateFailureRecord {
  assertFailureData(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid record");
  const record = value as DesktopUpdateFailureRecord;
  if (record.errorCode === "DESKTOP_RELEASE_FAILED") { assertUpdateFailureRecord(value); return; }
  const keys = ["deviceId", "shellVersion", "currentReleaseId", "webVersion", "clientVersion", "requestId", "shellId", "phase", "recovery",
    "schemaVersion", "kind", "errorId", "at", "errorCode", "rootCause", "rollbackError", "payloadSha256"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || record.schemaVersion !== 1 || record.kind !== "failure" || record.errorCode !== "DESKTOP_SHELL_UPDATE_FAILED"
    || !shellPhases.has(record.phase) || !["not_needed", "restored", "failed"].includes(record.recovery)) throw new Error("invalid record shape");
  for (const key of ["shellVersion", "currentReleaseId", "webVersion", "clientVersion", "requestId", "shellId"] as const) {
    if (key === "shellId" && record.shellId === null) continue;
    if (typeof record[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/.test(record[key])) throw new Error(`invalid ${key}`);
  }
  for (const key of ["deviceId", "errorId"] as const) {
    if (typeof record[key] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record[key])) throw new Error(`invalid ${key}`);
  }
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) || new Date(record.at).toISOString() !== record.at) throw new Error("invalid timestamp");
  assertDiagnostic(record.rootCause, 0, true);
  if (record.rollbackError !== null) assertDiagnostic(record.rollbackError, 0, true);
  const { payloadSha256, ...payload } = record;
  if (typeof payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(payloadSha256) || digestUpdateFailureRecord(payload) !== payloadSha256) throw new Error("invalid evidence digest");
}

/** 只检查数据描述符；隐藏字段、符号、稀疏数组和循环不能触发用户代码。 */
function assertFailureData(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object") return;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (depth > 8 || (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))) throw new Error("invalid record data");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array && Reflect.ownKeys(value).length !== value.length + 1) throw new Error("invalid record data");
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable && !(array && key === "length")) throw new Error("invalid record data");
    assertFailureData(descriptor.value, depth + 1);
  }
}

/** 诊断只接受明确错误类别和公开错误码，递归原因同样禁止任意字段。 */
function assertDiagnostic(value: unknown, depth = 0, shell = false): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid diagnostic");
  const cause = value as DiagnosticCause;
  if (Object.keys(value).some(key => !["name", "code", "causes"].includes(key)) || !errorNames.has(cause.name)
    || !allowedCodes.has(cause.code) && !(shell && shellCodes.has(cause.code))) throw new Error("invalid diagnostic shape");
  if (cause.causes !== undefined) {
    if (depth >= 3 || !Array.isArray(cause.causes) || !cause.causes.length) throw new Error("invalid diagnostic causes");
    for (const child of cause.causes) assertDiagnostic(child, depth + 1, shell);
  }
}

/** 不采集任意异常正文、stack 或扩展属性；原异常继续向调用方抛出，日志只保留可公开诊断码。 */
export function toUpdateDiagnosticCause(value: unknown, depth = 0): DiagnosticCause {
  return diagnosticCause(value, depth, false);
}

/** 壳失败额外保留精确公开边界码；不接纳其正文后缀，不放宽旧绑定包映射。 */
export function toShellUpdateDiagnosticCause(value: unknown, depth = 0): DiagnosticCause {
  return diagnosticCause(value, depth, true);
}

/** 共用诊断深度与公开系统/网络码，仅壳入口增加维护边界码。 */
function diagnosticCause(value: unknown, depth: number, shell: boolean): DiagnosticCause {
  const error = value instanceof Error ? value : undefined;
  const systemCode = error && "code" in error && typeof error.code === "string"
    && (systemCodes.has(error.code) || networkCodes.has(error.code)) ? error.code : undefined;
  const code = systemCode ?? releaseCauses.get(error?.message ?? "")
    ?? desktopCodes.find(candidate => error?.message === candidate || error?.message.startsWith(`${candidate}:`))
    ?? (shell && shellCodes.has(error?.message ?? "") ? error!.message : undefined)
    ?? (error instanceof SyntaxError ? "INVALID_JSON" : "UNCLASSIFIED_ERROR");
  const causes = depth < 3 && error ? error instanceof AggregateError ? error.errors : error.cause !== undefined ? [error.cause] : [] : [];
  return { name: errorNames.has(error?.name ?? "") ? error!.name : "Error", code,
    ...(causes.length ? { causes: causes.map(cause => diagnosticCause(cause, depth + 1, shell)) } : {}) };
}

/** 摘要覆盖整条脱敏证据，确认不能只匹配错误 ID。 */
export function digestUpdateFailureRecord(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 服务器确认必须绑定同一设备、错误和完整脱敏内容，拒绝空或部分确认。 */
export function matchesUpdateFailureAck(record: Pick<UpdateFailureRecord, "errorId" | "deviceId" | "payloadSha256">, ack: unknown): ack is UpdateFailureAck {
  if (!ack || typeof ack !== "object") return false;
  const value = ack as UpdateFailureAck;
  return value.errorId === record.errorId && value.deviceId === record.deviceId && value.payloadSha256 === record.payloadSha256;
}
