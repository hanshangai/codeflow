import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";

import type { CodeFlowNodeLogger, CodeFlowNodeRotateFrequency } from "@codeflowai/shared/node-logger";
import { createCodeFlowModuleLogger, createCodeFlowNodeLogger, resolveCodeFlowNodeLogPolicy } from "@codeflowai/shared/node-logger";
import { ensureWorkspaceCodeflowaiDirectory, assertWorkspaceCodeflowaiDirectory, inspectWorkspaceCodeflowaiFile,
  isWorkspaceCodeflowaiFileDeviceMatch, type WorkspaceCodeflowaiDirectoryIdentity } from "./codeflowai/workspaceCodeflowaiDirectory.js";
import { ensureWorkspacePrivateRuntimeGitExclude } from "./git/workspacePrivateRuntimeGitExclude.js";

type ClientLogLevel = "debug" | "info" | "warn" | "error";
export type WorkspaceLogEntry = { level: ClientLogLevel; tag: string; message: string; data?: unknown };
type WorkspaceLogFile = { name: string; date: number; segment: number; path: string; dev: number; ino: number; size: number; mtimeMs: number };
type ClientLogCleanupResult = {
  logDir: string;
  retentionDays: number;
  scanned: number;
  deleted: number;
  errors: string[];
};

export const CLIENT_LOG_DEFAULT_DIR = path.join(os.homedir(), ".codeflowai", "logs");
export const CLIENT_LOG_DEFAULT_FILE = "client.log";
export const CLIENT_LOG_DEFAULT_RETENTION_DAYS = 7;

const MANAGED_CLIENT_LOG_FILE_PATTERN = /^(client|client-daemon)(?:[-.][\w.-]+)?\.log(?:\.\d+)?$/i;

const CLIENT_LOG_ENV = {
  levelKeys: ["CODEFLOWAI_CLIENT_LOG_LEVEL", "CODEFLOWAI_LOG_LEVEL"],
  logDirKeys: ["CODEFLOWAI_CLIENT_LOG_DIR"],
  logFileKeys: ["CODEFLOWAI_CLIENT_LOG_FILE"],
  rotateFrequencyKeys: ["CODEFLOWAI_CLIENT_LOG_ROTATE_FREQUENCY", "CODEFLOWAI_LOG_ROTATE_FREQUENCY"],
  rotateSizeKeys: ["CODEFLOWAI_CLIENT_LOG_ROTATE_SIZE", "CODEFLOWAI_LOG_ROTATE_SIZE"],
  retentionCountKeys: ["CODEFLOWAI_CLIENT_LOG_RETENTION_COUNT", "CODEFLOWAI_LOG_RETENTION_COUNT"],
  retentionDaysKeys: ["CODEFLOWAI_CLIENT_LOG_RETENTION_DAYS", "CODEFLOWAI_LOG_RETENTION_DAYS"],
};

const clientLoggerOptions = {
  defaultLogDir: CLIENT_LOG_DEFAULT_DIR,
  defaultLogFile: CLIENT_LOG_DEFAULT_FILE,
  defaultRetentionCount: CLIENT_LOG_DEFAULT_RETENTION_DAYS,
  defaultRetentionDays: CLIENT_LOG_DEFAULT_RETENTION_DAYS,
  bufferUntilReady: Boolean(process.env.CODEFLOWAI_DESKTOP_REQUEST_ID),
  env: {
    ...CLIENT_LOG_ENV,
  },
};
const clientRootLogger = createCodeFlowNodeLogger(clientLoggerOptions);
const moduleLoggers = new Map<string, CodeFlowNodeLogger>();

/** Resolves a stable module logger while keeping the legacy tag-based API. */
function resolveModuleLogger(tag: string): CodeFlowNodeLogger {
  const moduleName = String(tag ?? "").trim() || "client";
  const existing = moduleLoggers.get(moduleName);
  if (existing) return existing;
  const created = createCodeFlowModuleLogger(clientRootLogger, moduleName);
  moduleLoggers.set(moduleName, created);
  return created;
}

/** Converts legacy client log payloads to pino object payloads. */
function normalizeLogData(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  if (data instanceof Error) return { error: data };
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return { data };
}

/** Writes a client log entry through the shared Node logger implementation. */
function write(level: ClientLogLevel, tag: string, message: string, data?: unknown): void {
  const moduleLogger = resolveModuleLogger(tag);
  const payload = normalizeLogData(data);
  if (payload) {
    moduleLogger[level](payload, message);
    return;
  }
  moduleLogger[level](message);
}

/** Legacy client logger facade used by existing tag/message/data call sites. */
export const logger = {
  debug: (tag: string, message: string, data?: unknown) => write("debug", tag, message, data),
  info: (tag: string, message: string, data?: unknown) => write("info", tag, message, data),
  warn: (tag: string, message: string, data?: unknown) => write("warn", tag, message, data),
  error: (tag: string, message: string, data?: unknown) => write("error", tag, message, data),
};

/** 先由原 pino 脱敏并生成唯一整行；合法过滤不触碰工作区文件。 */
export function formatWorkspaceLogEntry(entry: WorkspaceLogEntry): string | undefined {
  const lines: string[] = [];
  const root = createCodeFlowNodeLogger({ ...clientLoggerOptions, destination: { write: line => { lines.push(line); } } });
  const child = createCodeFlowModuleLogger(root, String(entry.tag ?? "").trim() || "client");
  if (!child.isLevelEnabled(entry.level)) return undefined;
  const payload = normalizeLogData(entry.data);
  if (payload) child[entry.level](payload, entry.message);
  else child[entry.level](entry.message);
  if (lines.length !== 1 || typeof lines[0] !== "string" || !lines[0].endsWith("\n") || lines[0].slice(0, -1).includes("\n")) {
    throw new Error("WORKSPACE_LOG_FORMAT_INVALID");
  }
  return lines[0];
}

/** 固定工作区落点同步追加整行；close 未确认只通知原 owner，不重试数字 fd。 */
export function writeWorkspaceLogFile(workspacePath: string, line: string, onCloseUnconfirmed: (phase: string, error: unknown) => void): void {
  const policy = resolveCodeFlowNodeLogPolicy(clientLoggerOptions), now = new Date();
  const directory = ensureWorkspaceCodeflowaiDirectory(workspacePath);
  const files = scanWorkspaceLogFiles(directory), suffix = formatDateSuffix(now), bytes = Buffer.from(line, "utf8");
  const today = files.filter(file => file.name.startsWith(`client-${suffix}.`)).sort((a, b) => b.segment - a.segment);
  const latest = today[0];
  const reuse = latest && workspaceLogPeriod(latest.mtimeMs, policy.frequency) === workspaceLogPeriod(now.getTime(), policy.frequency)
    && (!policy.sizeBytes || latest.size === 0 || latest.size + bytes.length <= policy.sizeBytes);
  const segment = reuse ? latest.segment : (latest?.segment ?? 0) + 1;
  if (!Number.isSafeInteger(segment)) throw new Error("WORKSPACE_LOG_SEGMENT_EXHAUSTED");
  const name = `client-${suffix}.${segment}.log`;
  ensureWorkspacePrivateRuntimeGitExclude(workspacePath, [...files.map(file => file.name), name], error => onCloseUnconfirmed("git-exclude-close", error));
  const expected = inspectWorkspaceCodeflowaiFile(directory, name);
  if (reuse && (!expected || expected.ino !== latest.ino || !isWorkspaceCodeflowaiFileDeviceMatch(latest.dev, expected.dev))) {
    throw new Error("WORKSPACE_LOG_FILE_REPLACED");
  }
  if (!reuse && expected) throw new Error("WORKSPACE_LOG_CREATE_CONFLICT");
  const fd = fs.openSync(path.join(directory.directoryPath, name), expected ? "a" : "ax");
  let failure: unknown, hasFailure = false;
  let openedIdentity: fs.Stats | undefined;
  try {
    const opened = fs.fstatSync(fd);
    openedIdentity = opened;
    verifyWorkspaceLogFile(directory, name, opened, expected ?? opened);
    for (let offset = 0; offset < bytes.length;) {
      verifyWorkspaceLogFile(directory, name, fs.fstatSync(fd), opened);
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error("WORKSPACE_LOG_WRITE_NO_PROGRESS");
      offset += written;
      verifyWorkspaceLogFile(directory, name, fs.fstatSync(fd), opened);
    }
    verifyWorkspaceLogFile(directory, name, fs.fstatSync(fd), opened);
    fs.fsyncSync(fd);
    verifyWorkspaceLogFile(directory, name, fs.fstatSync(fd), opened);
  } catch (error) { hasFailure = true; failure = error; throw error; }
  finally {
    try { fs.closeSync(fd); }
    catch (closeError) {
      const causes = hasFailure ? [failure, closeError] : [closeError];
      const combined = hasFailure ? new AggregateError(causes, "WORKSPACE_LOG_CLEANUP_FAILED", { cause: failure }) : closeError;
      try { onCloseUnconfirmed("workspace-log-close", combined); }
      catch (notificationError) { causes.push(notificationError); }
      if (causes.length > 1) throw new AggregateError(causes, "WORKSPACE_LOG_CLEANUP_FAILED", { cause: hasFailure ? failure : closeError });
      throw closeError;
    }
  }
  const current = inspectWorkspaceCodeflowaiFile(directory, name);
  if (!current || current.ino !== openedIdentity!.ino || !isWorkspaceCodeflowaiFileDeviceMatch(current.dev, openedIdentity!.dev)) throw new Error("WORKSPACE_LOG_FILE_REPLACED");
  const cutoff = policy.days == null ? -Infinity : resolveRetentionCutoffStartMs(policy.days, now);
  const ordered = files.filter(file => file.name !== name).sort((a, b) => b.date - a.date || b.segment - a.segment);
  const expired = ordered.filter(file => file.date < cutoff);
  const excess = ordered.filter(file => file.date >= cutoff).slice(policy.count);
  for (const file of [...expired, ...excess]) {
    const identity = inspectWorkspaceCodeflowaiFile(directory, file.name);
    if (!identity || identity.ino !== file.ino || !isWorkspaceCodeflowaiFileDeviceMatch(file.dev, identity.dev)) throw new Error("WORKSPACE_LOG_FILE_REPLACED");
    fs.unlinkSync(identity.path);
    assertWorkspaceCodeflowaiDirectory(directory);
  }
}

/** 扫描固定命名空间并在轮转或删除前确认普通独占文件及有限元数据。 */
function scanWorkspaceLogFiles(directory: WorkspaceCodeflowaiDirectoryIdentity): WorkspaceLogFile[] {
  assertWorkspaceCodeflowaiDirectory(directory);
  const files: WorkspaceLogFile[] = [];
  for (const name of fs.readdirSync(directory.directoryPath)) {
    const match = /^client-(\d{8})\.([1-9]\d*)\.log$/.exec(name);
    if (!match) continue;
    const date = parseDateSuffixStartMs(match[1]!), segment = Number(match[2]);
    if (date == null || !Number.isSafeInteger(segment)) continue;
    const identity = inspectWorkspaceCodeflowaiFile(directory, name);
    if (!identity) throw new Error("WORKSPACE_LOG_FILE_REPLACED");
    const stat = fs.lstatSync(identity.path);
    verifyWorkspaceLogFile(directory, name, stat, identity);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtimeMs)) throw new Error("WORKSPACE_LOG_METADATA_INVALID");
    files.push({ name, date, segment, ...identity, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

/** 同时复核根、目录、路径与已打开文件身份，沿用 Windows dev=0 规则。 */
function verifyWorkspaceLogFile(directory: WorkspaceCodeflowaiDirectoryIdentity, name: string, opened: fs.Stats, expected: { dev: number; ino: number }): void {
  const current = inspectWorkspaceCodeflowaiFile(directory, name);
  if (!opened.isFile() || opened.nlink !== 1 || !current || !isWorkspaceCodeflowaiFileDeviceMatch(opened.dev, expected.dev)
    || opened.ino !== expected.ino || !isWorkspaceCodeflowaiFileDeviceMatch(current.dev, opened.dev) || current.ino !== opened.ino) {
    throw new Error("WORKSPACE_LOG_FILE_REPLACED");
  }
}

/** 每次按可观察 mtime 判定本地周期，不保存跨迁移的桶身份。 */
function workspaceLogPeriod(time: number, frequency: CodeFlowNodeRotateFrequency): number {
  if (typeof frequency === "number") return Math.floor(time / frequency);
  const date = new Date(time);
  if (frequency === "daily") date.setHours(0, 0, 0, 0);
  else date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** 仅供进程退出前同步刷写，避免异步 flush 的目标位置被后续日志越过；错误原样拒绝。 */
export async function flushClientLogger(): Promise<void> {
  const transport = (clientRootLogger as unknown as Record<symbol, {
    destroyed: boolean; writableErrored?: Error; flushSync(): void;
  }>)[pino.symbols.streamSym];
  if (transport.writableErrored) throw transport.writableErrored;
  if (transport.destroyed) throw new Error("CLIENT_LOG_TRANSPORT_DESTROYED");
  transport.flushSync();
}

/** Resolves the client log directory from the same env contract as the pino logger. */
export function resolveClientLogDir(): string {
  return readFirstEnv(CLIENT_LOG_ENV.logDirKeys, CLIENT_LOG_DEFAULT_DIR);
}

/** Resolves the configured client log retention days, defaulting to the product 7-day policy. */
export function resolveClientLogRetentionDays(): number {
  const raw = readFirstEnv(CLIENT_LOG_ENV.retentionDaysKeys, String(CLIENT_LOG_DEFAULT_RETENTION_DAYS));
  const days = Number(raw);
  if (!Number.isFinite(days)) return CLIENT_LOG_DEFAULT_RETENTION_DAYS;
  return Math.min(3650, Math.max(1, Math.floor(days)));
}

/** Builds the daemon stdout/stderr file path for the current local day. */
export function resolveDatedClientDaemonLogPath(kind: "out" | "err", date = new Date()): string {
  return path.join(resolveClientLogDir(), `client-daemon-${formatDateSuffix(date)}.${kind}.log`);
}

/** Removes client and daemon log files outside the configured retention window. */
export function cleanupClientLogRetention(now = new Date()): ClientLogCleanupResult {
  const logDir = resolveClientLogDir();
  const retentionDays = resolveClientLogRetentionDays();
  const result: ClientLogCleanupResult = { logDir, retentionDays, scanned: 0, deleted: 0, errors: [] };
  if (!fs.existsSync(logDir)) return result;

  const cutoffStartMs = resolveRetentionCutoffStartMs(retentionDays, now);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch (error) {
    result.errors.push(`read ${logDir}: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isManagedClientLogFileName(entry.name)) continue;
    result.scanned += 1;
    const filePath = path.join(logDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      const fileStartMs = resolveLogFileStartMs(entry.name, stat.mtimeMs);
      if (fileStartMs >= cutoffStartMs) continue;
      fs.unlinkSync(filePath);
      result.deleted += 1;
    } catch (error) {
      result.errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** Reads the first non-empty environment value. */
function readFirstEnv(keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = String(process.env[key] ?? "").trim();
    if (value) return value;
  }
  return fallback;
}

/** Formats the yyyyMMdd suffix used by client and daemon logs. */
function formatDateSuffix(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/** Calculates the earliest local day retained by the retention policy. */
function resolveRetentionCutoffStartMs(retentionDays: number, now = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (retentionDays - 1));
  return start.getTime();
}

/** Limits cleanup to known client-managed log files. */
function isManagedClientLogFileName(fileName: string): boolean {
  return MANAGED_CLIENT_LOG_FILE_PATTERN.test(fileName);
}

/** Uses dated suffixes when present; legacy daemon logs fall back to mtime. */
function resolveLogFileStartMs(fileName: string, mtimeMs: number): number {
  const match = /(?:^|[-.])(\d{8})(?:[-.]|$)/.exec(fileName);
  if (!match) return mtimeMs;
  const parsed = parseDateSuffixStartMs(match[1]);
  return parsed ?? mtimeMs;
}

/** Converts yyyyMMdd to local midnight timestamp. */
function parseDateSuffixStartMs(value: string): number | null {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}
