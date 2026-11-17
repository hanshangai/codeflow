import crypto from "node:crypto";
import {
  DESKTOP_CRASH_EVENTS, DESKTOP_CRASH_PROCESS_TYPES, DESKTOP_CRASH_REASONS, DESKTOP_CRASH_STACK_MAX_FRAMES,
  DESKTOP_CRASH_STACK_MAX_LENGTH,
  type DesktopCrashCleanMarker, type DesktopCrashEvent, type DesktopCrashProcessType, type DesktopCrashReason,
  type DesktopCrashRecentError, type DesktopCrashReport, type DesktopCrashReportAck, type DesktopCrashSessionMarker,
  type DesktopCrashVersions,
} from "./types/desktopCrashReport.js";

export type {
  DesktopCrashCleanMarker, DesktopCrashEvent, DesktopCrashProcessType, DesktopCrashReason, DesktopCrashRecentError,
  DesktopCrashReport, DesktopCrashReportAck, DesktopCrashSessionMarker, DesktopCrashVersions,
} from "./types/desktopCrashReport.js";
export { DESKTOP_CRASH_STACK_MAX_FRAMES, DESKTOP_CRASH_STACK_MAX_LENGTH };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PHASE = /^[a-z][a-z0-9-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;
const METHOD = /^[A-Za-z][A-Za-z0-9._:+-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/;
const REPORT_KEYS = ["schemaVersion", "kind", "reportId", "deviceId", "sessionId", "sessionStartedAt", "event", "processType",
  "reason", "exitCode", "occurredAt", "detectedAt", "phase", "errorCode", "requestId", "causeCodes", "recentErrors", "versions",
  "platform", "arch", "payloadSha256"];
const REPORT_KEYS_WITH_STACK = [...REPORT_KEYS, "stack"];
const VERSION_KEYS = ["shellVersion", "webVersion", "clientVersion", "releaseId", "shellId"];
const RECENT_ERROR_KEYS = ["at", "errorCode", "requestId", "channel", "method"];
const SESSION_KEYS = ["schemaVersion", "sessionId", "startedAt", "deviceId", "versions", "platform", "arch"];
const CLEAN_KEYS = ["schemaVersion", "sessionId", "cleanAt"];
const events = new Set<string>(DESKTOP_CRASH_EVENTS);
const reasons = new Set<string>(DESKTOP_CRASH_REASONS);
const processTypes = new Set<string>(DESKTOP_CRASH_PROCESS_TYPES);

/** 写入与重读共用同一严格合同，拒绝未知字段、访问器和任意正文。 */
export function assertDesktopCrashReport(value: unknown): asserts value is DesktopCrashReport {
  assertPlainData(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid crash report");
  const record = value as DesktopCrashReport;
  assertExactKeys(value, Object.keys(value).includes("stack") ? REPORT_KEYS_WITH_STACK : REPORT_KEYS);
  if (record.schemaVersion !== 1 || record.kind !== "crash") throw new Error("invalid crash report shape");
  assertUuid(record.reportId, "reportId");
  assertUuid(record.sessionId, "sessionId");
  if (record.deviceId !== null) assertUuid(record.deviceId, "deviceId");
  assertTime(record.sessionStartedAt, "sessionStartedAt");
  assertTime(record.occurredAt, "occurredAt");
  assertTime(record.detectedAt, "detectedAt");
  if (Date.parse(record.sessionStartedAt) > Date.parse(record.occurredAt) || Date.parse(record.occurredAt) > Date.parse(record.detectedAt)) {
    throw new Error("invalid crash report chronology");
  }
  if (!events.has(record.event)) throw new Error("invalid crash event");
  if (!processTypes.has(record.processType)) throw new Error("invalid crash process type");
  if (!reasons.has(record.reason)) throw new Error("invalid crash reason");
  assertEventShape(record.event, record.processType, record.reason);
  if (record.exitCode !== null && (!Number.isSafeInteger(record.exitCode) || record.exitCode < -2_147_483_648 || record.exitCode > 2_147_483_647)) {
    throw new Error("invalid exit code");
  }
  if (record.phase !== null && (typeof record.phase !== "string" || !PHASE.test(record.phase))) throw new Error("invalid phase");
  if (record.errorCode !== null && (typeof record.errorCode !== "string" || !ERROR_CODE.test(record.errorCode))) throw new Error("invalid error code");
  if (record.requestId !== null && (typeof record.requestId !== "string" || !REQUEST_ID.test(record.requestId))) throw new Error("invalid request id");
  if (record.stack !== undefined) assertStack(record.stack);
  assertCodeList(record.causeCodes);
  assertRecentErrors(record.recentErrors);
  assertVersions(record.versions);
  assertPlatform(record.platform, record.arch);
  const { payloadSha256, ...payload } = record;
  if (typeof payloadSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(payloadSha256) || digestDesktopCrashReport(payload) !== payloadSha256) {
    throw new Error("invalid crash report digest");
  }
}

/** 摘要覆盖整条脱敏报告；确认必须绑定同一报告、设备与完整内容。 */
export function digestDesktopCrashReport(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function matchesDesktopCrashReportAck(record: Pick<DesktopCrashReport, "reportId" | "deviceId" | "payloadSha256">, ack: unknown): ack is DesktopCrashReportAck {
  if (!ack || typeof ack !== "object") return false;
  const value = ack as DesktopCrashReportAck;
  return value.reportId === record.reportId && value.deviceId === record.deviceId && value.payloadSha256 === record.payloadSha256;
}

/** 会话标记只保存判定异常退出所需的最小事实。 */
export function assertDesktopCrashSessionMarker(value: unknown): asserts value is DesktopCrashSessionMarker {
  assertPlainData(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid crash session marker");
  const marker = value as DesktopCrashSessionMarker;
  assertExactKeys(value, SESSION_KEYS);
  if (marker.schemaVersion !== 1) throw new Error("invalid crash session marker shape");
  assertUuid(marker.sessionId, "sessionId");
  assertTime(marker.startedAt, "startedAt");
  if (marker.deviceId !== null) assertUuid(marker.deviceId, "deviceId");
  assertVersions(marker.versions);
  assertPlatform(marker.platform, marker.arch);
}

export function assertDesktopCrashCleanMarker(value: unknown): asserts value is DesktopCrashCleanMarker {
  assertPlainData(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid crash clean marker");
  const marker = value as DesktopCrashCleanMarker;
  assertExactKeys(value, CLEAN_KEYS);
  if (marker.schemaVersion !== 1) throw new Error("invalid crash clean marker shape");
  assertUuid(marker.sessionId, "sessionId");
  assertTime(marker.cleanAt, "cleanAt");
}

/** 事件、进程和原因必须相互吻合，避免服务端按错误维度统计。 */
function assertEventShape(event: DesktopCrashEvent, processType: DesktopCrashProcessType, reason: DesktopCrashReason): void {
  const allowed = event === "main_uncaught_exception" ? processType === "main" && reason === "exception"
    : event === "main_unhandled_rejection" ? processType === "main" && reason === "rejection"
      : event === "renderer_process_gone" ? processType === "renderer" && reason !== "exception" && reason !== "rejection"
        : event === "child_process_gone" ? (processType === "gpu" || processType === "utility") && reason !== "exception" && reason !== "rejection"
          : event === "client_process_exit" ? processType === "client" && reason !== "exception" && reason !== "rejection"
            : event === "abnormal_exit" ? processType === "main" && reason === "abnormal-exit" : false;
  if (!allowed) throw new Error("invalid crash event shape");
}

function assertCodeList(value: unknown): void {
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length) throw new Error("invalid cause codes");
  for (const code of value) if (typeof code !== "string" || !ERROR_CODE.test(code)) throw new Error("invalid cause code");
}

/** 堆栈只接受脱敏调用帧；拒绝异常消息、空行、超长内容和 NUL。 */
function assertStack(value: unknown): void {
  if (value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.length > DESKTOP_CRASH_STACK_MAX_LENGTH || value.includes("\0")) {
    throw new Error("invalid crash stack");
  }
  const lines = value.split("\n");
  if (lines.length > DESKTOP_CRASH_STACK_MAX_FRAMES || lines.some(line => !line.startsWith("at "))) {
    throw new Error("invalid crash stack frame");
  }
}

function assertRecentErrors(value: unknown): void {
  if (!Array.isArray(value) || value.length > 20) throw new Error("invalid recent errors");
  for (const item of value as DesktopCrashRecentError[]) {
    assertPlainData(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid recent error");
    assertExactKeys(item, RECENT_ERROR_KEYS);
    assertTime(item.at, "recent error timestamp");
    if (typeof item.errorCode !== "string" || !ERROR_CODE.test(item.errorCode)) throw new Error("invalid recent error code");
    assertOptional(item.requestId, REQUEST_ID, "recent error request id");
    assertOptional(item.channel, CHANNEL, "recent error channel");
    assertOptional(item.method, METHOD, "recent error method");
  }
}

function assertVersions(value: unknown): void {
  assertPlainData(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid versions");
  assertExactKeys(value, VERSION_KEYS);
  for (const key of VERSION_KEYS) assertOptional((value as Record<string, unknown>)[key], VERSION, `invalid ${key}`);
}

function assertPlatform(platform: unknown, arch: unknown): void {
  const platforms = ["win32", "darwin"], arches = ["x64", "arm64"];
  if (platform === null && arch === null) return;
  if (typeof platform !== "string" || !platforms.includes(platform) || typeof arch !== "string" || !arches.includes(arch)) {
    throw new Error("invalid platform facts");
  }
}

function assertOptional(value: unknown, pattern: RegExp, label: string): void {
  if (value === null) return;
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(label);
}

function assertUuid(value: unknown, label: string): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`invalid ${label}`);
}

function assertTime(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`invalid ${label}`);
}

function assertExactKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error("invalid record keys");
}

/** 只检查数据描述符；隐藏字段、符号、稀疏数组和循环不能触发用户代码。 */
function assertPlainData(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object") return;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (depth > 8 || (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))) throw new Error("invalid record data");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array && Reflect.ownKeys(value).length !== value.length + 1) throw new Error("invalid record data");
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (typeof key !== "string" || !("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length"))) throw new Error("invalid record data");
    assertPlainData(descriptor.value, depth + 1);
  }
}
