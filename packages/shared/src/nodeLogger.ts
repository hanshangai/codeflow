import fs from "node:fs";
import path from "node:path";

import pino from "pino";

export type CodeFlowNodeLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type CodeFlowNodeRotateFrequency = "daily" | "hourly" | number;
export type CodeFlowNodeLogger = pino.Logger;

export type CodeFlowNodeLoggerEnv = {
  levelKeys: string[];
  logDirKeys: string[];
  logFileKeys: string[];
  rotateFrequencyKeys: string[];
  rotateSizeKeys: string[];
  retentionCountKeys: string[];
  retentionDaysKeys?: string[];
};

export type CreateCodeFlowNodeLoggerOptions = {
  defaultLogDir: string;
  defaultLogFile: string;
  defaultRetentionCount?: number;
  defaultRetentionDays?: number;
  env: CodeFlowNodeLoggerEnv;
  destination?: pino.DestinationStream;
  /** 启动日志保留完整格式化行，待线程 ready 后写出；显式刷写和退出仍同步排空。 */
  bufferUntilReady?: boolean;
};

/** 复用原键优先级；同步工作区分支只额外解释容量，不解析应用路径。 */
export function resolveCodeFlowNodeLogPolicy(options: CreateCodeFlowNodeLoggerOptions): {
  level: CodeFlowNodeLogLevel; frequency: CodeFlowNodeRotateFrequency; sizeBytes: number; count: number; days: number | null;
} {
  const raw = readFirstEnv(options.env.rotateSizeKeys, "50m");
  const match = /^((?:\d+(?:\.\d*)?|\.\d+))(\w?)$/i.exec(raw);
  if (!match) throw new Error(`Invalid log rotate size: ${raw}`);
  const unit = match[2]!.toLowerCase();
  const sizeBytes = Number(match[1]) * (unit === "b" ? 1 : unit === "k" ? 1024 : unit === "g" ? 1024 ** 3 : 1024 ** 2);
  if (!Number.isFinite(sizeBytes)) throw new Error(`Invalid log rotate size: ${raw}`);
  return { level: resolveLogLevel(options.env), frequency: resolveRotateFrequency(options.env), sizeBytes,
    count: resolveRetentionCount(options.env, options.defaultRetentionCount), days: resolveRetentionDays(options) };
}

const NODE_LOG_LEVELS: CodeFlowNodeLogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const DEFAULT_REDACT_PATHS = [
  "apiKey",
  "api_key",
  "password",
  "secret",
  "secretKey",
  "secret_key",
  "clientSecret",
  "client_secret",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "leaseToken",
  "lease_token",
  "databaseUrl",
  "database_url",
  "connectionString",
  "connection_string",
  "opts.databaseUrl",
  "opts.database_url",
  "opts.connectionString",
  "opts.connection_string",
  "authorization",
  "headers.authorization",
  "headers.cookie",
  "cookie",
];

/** Reads the first non-empty environment value from the configured keys. */
function readFirstEnv(keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = String(process.env[key] ?? "").trim();
    if (value) return value;
  }
  return fallback;
}

/** Resolves the logger level with info as the invalid-value fallback. */
function resolveLogLevel(env: CodeFlowNodeLoggerEnv): CodeFlowNodeLogLevel {
  const raw = readFirstEnv(env.levelKeys, "info").toLowerCase();
  return NODE_LOG_LEVELS.includes(raw as CodeFlowNodeLogLevel) ? (raw as CodeFlowNodeLogLevel) : "info";
}

/** Resolves pino-roll frequency from daily/hourly or millisecond input. */
function resolveRotateFrequency(env: CodeFlowNodeLoggerEnv): CodeFlowNodeRotateFrequency {
  const raw = readFirstEnv(env.rotateFrequencyKeys, "daily").toLowerCase();
  if (raw === "daily" || raw === "hourly") return raw;
  const millis = Number(raw);
  if (Number.isFinite(millis) && millis >= 1_000) return Math.floor(millis);
  return "daily";
}

/** Resolves retained rolled file count with a bounded default. */
function resolveRetentionCount(env: CodeFlowNodeLoggerEnv, defaultCount = 30): number {
  const raw = readFirstEnv(env.retentionCountKeys, String(defaultCount));
  const count = Number(raw);
  if (!Number.isFinite(count)) return defaultCount;
  return Math.min(3650, Math.max(1, Math.floor(count)));
}

/** Resolves optional date-based log retention in calendar days. */
function resolveRetentionDays(options: CreateCodeFlowNodeLoggerOptions): number | null {
  const fallback = options.defaultRetentionDays == null ? "" : String(options.defaultRetentionDays);
  const raw = readFirstEnv(options.env.retentionDaysKeys ?? [], fallback);
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isFinite(days)) throw new Error(`Invalid log retention days: ${raw}`);
  return Math.min(3650, Math.max(1, Math.floor(days)));
}

/** Formats a local timestamp matching the existing server log format. */
function formatLocalDateTime(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

/** Formats the date suffix used by rolled log file names. */
function formatDateSuffix(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/** Appends a date suffix before the log file extension. */
function appendDateSuffixToFileName(fileName: string, dateSuffix: string): string {
  const parsed = path.parse(fileName);
  const ext = parsed.ext || ".log";
  const name = parsed.name || "codeflow";
  return `${name}-${dateSuffix}${ext}`;
}

/** Resolves the log directory, base file name, and dated file path. */
function resolveLogFileTarget(options: CreateCodeFlowNodeLoggerOptions): {
  logDir: string;
  fileName: string;
  logFile: string;
} {
  const logDir = readFirstEnv(options.env.logDirKeys, options.defaultLogDir);
  const fileName = readFirstEnv(options.env.logFileKeys, options.defaultLogFile);
  const datedFileName = appendDateSuffixToFileName(fileName, formatDateSuffix());
  return { logDir, fileName, logFile: path.join(logDir, datedFileName) };
}

/** Escapes a literal string for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Converts yyyyMMdd log suffixes to local midnight timestamps. */
function parseDateSuffixStartMs(value: string): number | null {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

/** Calculates the first local-day timestamp retained by a calendar-day policy. */
function resolveRetentionCutoffStartMs(retentionDays: number, now = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (retentionDays - 1));
  return start.getTime();
}

/** Deletes dated log files older than the configured calendar-day retention. */
function cleanupExpiredDatedLogFiles(logDir: string, fileName: string, retentionDays: number): void {
  if (!fs.existsSync(logDir)) return;
  const parsed = path.parse(fileName);
  const ext = parsed.ext || ".log";
  const name = parsed.name || "codeflow";
  const pattern = new RegExp(`^${escapeRegExp(name)}-(\\d{8})(?:\\.\\d+)?${escapeRegExp(ext)}$`);
  const cutoffStartMs = resolveRetentionCutoffStartMs(retentionDays);
  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = pattern.exec(entry.name);
    if (!match) continue;
    const fileStartMs = parseDateSuffixStartMs(match[1]);
    if (fileStartMs == null || fileStartMs >= cutoffStartMs) continue;
    fs.unlinkSync(path.join(logDir, entry.name));
  }
}

/** Builds shared pino options for CodeFlow Node processes. */
function buildLoggerOptions(level: CodeFlowNodeLogLevel): pino.LoggerOptions {
  return {
    level,
    messageKey: "message",
    errorKey: "error",
    base: null,
    timestamp: () => `,"time":"${formatLocalDateTime()}"`,
    formatters: {
      level: (label: string) => ({ level: label.toUpperCase() }),
    },
    redact: { paths: DEFAULT_REDACT_PATHS, censor: "[REDACTED]" },
  };
}

/** Uses one rolling-file target so string levels do not enter numeric multi-target routing. */
function buildTransportOptions(
  logFile: string,
  options: CreateCodeFlowNodeLoggerOptions,
): pino.TransportSingleOptions & { sync: true } {
  return {
    target: "pino-roll",
    sync: true,
    options: {
      file: logFile,
      mkdir: true,
      frequency: resolveRotateFrequency(options.env),
      size: readFirstEnv(options.env.rotateSizeKeys, "50m"),
      limit: { count: resolveRetentionCount(options.env, options.defaultRetentionCount) },
    },
  };
}

/** 创建统一日志；可选启动缓冲避免首次调用同步等待日志线程。 */
export function createCodeFlowNodeLogger(options: CreateCodeFlowNodeLoggerOptions): CodeFlowNodeLogger {
  const level = resolveLogLevel(options.env);
  if (options.destination) return pino(buildLoggerOptions(level), options.destination);
  const target = resolveLogFileTarget(options);
  const retentionDays = resolveRetentionDays(options);
  if (retentionDays != null) cleanupExpiredDatedLogFiles(target.logDir, target.fileName, retentionDays);
  const transport = pino.transport(buildTransportOptions(target.logFile, options)) as ReturnType<typeof pino.transport> & {
    readonly ready: boolean; readonly destroyed: boolean; readonly closed: boolean;
    readonly writable: boolean; readonly writableErrored: unknown;
    ref(): void; unref(): void;
  };
  /** Rejects known destination failures before pino can write to a failed stream. */
  function assertTransportWritable(): void {
    if (transport.writableErrored !== null && transport.writableErrored !== undefined) throw transport.writableErrored;
    if (transport.destroyed) throw new Error("NODE_LOG_TRANSPORT_DESTROYED");
    if (transport.closed) throw new Error("NODE_LOG_TRANSPORT_CLOSED");
    if (!transport.writable) throw new Error("NODE_LOG_TRANSPORT_NOT_WRITABLE");
  }
  const loggerOptions = buildLoggerOptions(level);
  if (options.bufferUntilReady) {
    const pending: string[] = [];
    let consumed = 0;
    let startupComplete = false;
    let pendingFlushes = 0;
    /** 多个初始化/显式刷写共用保活，最后一个确认后才释放线程。 */
    function confirmDestination(callback: (error?: Error) => void): void {
      pendingFlushes += 1;
      transport.ref();
      transport.flush(error => {
        pendingFlushes -= 1;
        if (pendingFlushes === 0) transport.unref();
        callback(error);
      });
    }
    /** ready 前不写入线程，避免其就绪检查等待已被后续日志越过的位置。 */
    function flushBufferedStartup(): void {
      assertTransportWritable();
      while (consumed < pending.length) {
        transport.write(pending[consumed]!);
        assertTransportWritable();
        consumed += 1;
      }
      pending.length = 0;
      consumed = 0;
      transport.flushSync();
      assertTransportWritable();
    }
    // 提前退出时必须先排空应用缓冲，再让 pino 自身的退出监听关闭线程。
    process.prependOnceListener("exit", flushBufferedStartup);
    transport.once("ready", () => {
      // ready 早于文件目标的异步 open 完成；先确认目标，避免写入掩盖其原始错误。
      confirmDestination(error => {
        if (error != null) throw error;
        process.removeListener("exit", flushBufferedStartup);
        flushBufferedStartup();
        startupComplete = true;
      });
    });
    const destination = {
      /** 启动时只暂存已脱敏的完整行，就绪后复用原线程写入。 */
      write(line: string): boolean {
        assertTransportWritable();
        if (!startupComplete) { pending.push(line); return true; }
        const writable = transport.write(line);
        assertTransportWritable();
        return writable;
      },
      get destroyed() { return transport.destroyed; },
      get writableErrored() { return transport.writableErrored; },
      flushSync: flushBufferedStartup,
      /** 显式 flush 同样包含启动缓冲，保留原 transport 的完成和失败通知。 */
      flush(callback: (error?: Error) => void): void {
        flushBufferedStartup();
        confirmDestination(callback);
      },
    };
    return pino(loggerOptions, destination);
  }
  loggerOptions.hooks = {
    /** Preserves pino dispatch while draining each startup write before READY can capture its target. */
    logMethod(args, method) {
      assertTransportWritable();
      if (transport.ready) { method.apply(this, args); return; }
      method.apply(this, args);
      assertTransportWritable();
      transport.flushSync();
      assertTransportWritable();
    },
  };
  return pino(loggerOptions, transport);
}

/** Creates a module-level child logger with a stable module field. */
export function createCodeFlowModuleLogger(rootLogger: CodeFlowNodeLogger, moduleName: string): CodeFlowNodeLogger {
  return rootLogger.child({ module: moduleName });
}
