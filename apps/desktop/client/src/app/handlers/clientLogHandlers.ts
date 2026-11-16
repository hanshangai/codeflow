import fs from "node:fs";
import path from "node:path";

import type {
  ClientLogDownloadRequestBody,
  ClientLogDownloadResponseBody,
  ClientLogFileItem,
  ClientLogFileListRequestBody,
  ClientLogFileListResponseBody,
  ClientLogTailEntry,
  ClientLogTailRequestBody,
  ClientLogTailResponseBody,
} from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { cleanupClientLogRetention, CLIENT_LOG_DEFAULT_FILE, logger, resolveClientLogDir } from "../../logger.js";

type LogFileCandidate = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
};

const CLIENT_LOG_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/** 列出当前 Client 日志并附带内存资产诊断，不依赖日志文件存在。 */
export function handleClientLogsFiles(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<ClientLogFileListRequestBody>;
  if (!isRequestForCurrentClient(ctx, body.clientId)) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "参数错误：clientId 与当前 Client 不匹配" } });
    return;
  }

  try {
    const result = readClientLogFileList(ctx.clientId);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (error) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: error instanceof Error ? error.message : String(error) } });
  }
}

/** 读取 Client 自己的日志尾部。 */
export function handleClientLogsTail(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<ClientLogTailRequestBody>;
  if (!isRequestForCurrentClient(ctx, body.clientId)) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "参数错误：clientId 与当前 Client 不匹配" } });
    return;
  }

  try {
    const result = readCurrentClientLogTail({
      clientId: ctx.clientId,
      fileName: body.fileName,
      lines: normalizeTailLines(body.lines),
      maxBytes: normalizeTailBytes(body.maxBytes),
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (error) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: error instanceof Error ? error.message : String(error) } });
  }
}

/** 处理 `client.logs.download`：返回指定日志文件内容，供管理端下载。 */
export function handleClientLogsDownload(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const body = (req.body ?? {}) as Partial<ClientLogDownloadRequestBody>;
  if (!isRequestForCurrentClient(ctx, body.clientId)) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "参数错误：clientId 与当前 Client 不匹配" } });
    return;
  }

  try {
    const result = readClientLogDownload({
      clientId: ctx.clientId,
      fileName: String(body.fileName ?? ""),
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("不存在或不允许下载") || message.includes("超过下载上限") ? 400 : 500;
    ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, message } });
  }
}

/** 读取最新 client 日志文件尾部并转换为前端可展示结构。 */
function readCurrentClientLogTail(input: {
  clientId: string;
  fileName?: string | null;
  lines: number;
  maxBytes: number;
}): ClientLogTailResponseBody {
  const latest = input.fileName ? resolveClientLogFile(input.fileName) : findLatestClientLogFile();
  if (!latest) {
    return {
      clientId: input.clientId,
      logFileName: null,
      lines: [],
      lineCount: 0,
      truncated: false,
      readAt: Date.now(),
    };
  }

  const tail = readTailLines(latest.filePath, input.lines, input.maxBytes);
  return {
    clientId: input.clientId,
    logFileName: latest.fileName,
    lines: tail.lines.map(parseLogTailEntry),
    lineCount: tail.lines.length,
    truncated: tail.truncated,
    readAt: Date.now(),
  };
}

/** 读取日志文件清单，限定为 client 与 daemon 日志。 */
function readClientLogFileList(clientId: string): ClientLogFileListResponseBody {
  return {
    clientId,
    files: listClientLogFiles().map(toClientLogFileItem),
    readAt: Date.now(),
  };
}

/** 读取指定日志文件完整内容，限制最大下载体积避免占用过多内存。 */
function readClientLogDownload(input: {
  clientId: string;
  fileName: string;
}): ClientLogDownloadResponseBody {
  const file = resolveClientLogFile(input.fileName);
  if (!file) throw new Error("日志文件不存在或不允许下载");
  if (file.sizeBytes > CLIENT_LOG_DOWNLOAD_LIMIT_BYTES) {
    throw new Error(`日志文件超过下载上限：${Math.ceil(CLIENT_LOG_DOWNLOAD_LIMIT_BYTES / 1024 / 1024)}MB`);
  }
  return {
    clientId: input.clientId,
    fileName: file.fileName,
    contentBase64: fs.readFileSync(file.filePath).toString("base64"),
    sizeBytes: file.sizeBytes,
    contentType: "text/plain; charset=utf-8",
  };
}

/** 查找当前日志目录内最新的 client 滚动日志文件。 */
function findLatestClientLogFile(): LogFileCandidate | null {
  const logFile = readFirstEnv(["CODEFLOWAI_CLIENT_LOG_FILE"], CLIENT_LOG_DEFAULT_FILE);
  const parsed = path.parse(logFile);
  const ext = parsed.ext || ".log";
  const name = parsed.name || "client";
  const prefix = `${name}-`;
  const candidates = listClientLogFiles().filter((item) =>
    item.fileName === appendDateSuffixToFileName(logFile, formatDateSuffix())
    || (item.fileName.startsWith(prefix) && item.fileName.endsWith(ext)),
  );
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

/** 枚举允许管理端读取的 Client 日志文件。 */
function listClientLogFiles(): LogFileCandidate[] {
  const cleanup = cleanupClientLogRetention();
  if (cleanup.errors.length) {
    logger.warn("client-logs", "client log retention cleanup had errors before listing", {
      logDir: cleanup.logDir,
      retentionDays: cleanup.retentionDays,
      scanned: cleanup.scanned,
      deleted: cleanup.deleted,
      errors: cleanup.errors,
    });
  }
  const logDir = resolveClientLogDir();
  const logFile = readFirstEnv(["CODEFLOWAI_CLIENT_LOG_FILE"], CLIENT_LOG_DEFAULT_FILE);
  const candidates: LogFileCandidate[] = [];

  try {
    if (!fs.existsSync(logDir)) return [];
    const logDirStat = fs.statSync(logDir);
    if (!logDirStat.isDirectory()) return [];

    const todayFileName = appendDateSuffixToFileName(logFile, formatDateSuffix());
    const todayPath = path.join(logDir, todayFileName);
    const todayStat = fs.existsSync(todayPath) ? fs.statSync(todayPath) : null;
    if (todayStat?.isFile() && isAllowedClientLogFileName(todayFileName)) {
      candidates.push({
        fileName: todayFileName,
        filePath: todayPath,
        sizeBytes: todayStat.size,
        mtimeMs: todayStat.mtimeMs,
      });
    }

    const entries = fs.readdirSync(logDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isAllowedClientLogFileName(entry.name)) continue;
      const filePath = path.join(logDir, entry.name);
      const stat = fs.statSync(filePath);
      candidates.push({ fileName: entry.name, filePath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  } catch (error) {
    throw new Error(`读取 Client 日志目录失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const deduped = new Map<string, LogFileCandidate>();
  for (const item of candidates) deduped.set(item.fileName, item);
  return Array.from(deduped.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 解析日志文件名到当前日志目录内的真实文件，禁止路径穿越。 */
function resolveClientLogFile(fileName: string): LogFileCandidate | null {
  const normalized = path.basename(String(fileName ?? "").trim());
  if (!normalized || normalized !== String(fileName ?? "").trim() || !isAllowedClientLogFileName(normalized)) return null;
  return listClientLogFiles().find((item) => item.fileName === normalized) ?? null;
}

/** 仅允许读取 client 主日志和 daemon stdout/stderr 日志。 */
function isAllowedClientLogFileName(fileName: string): boolean {
  return /^(client|client-daemon)(?:[-.][\w.-]+)?\.log$/i.test(fileName);
}

/** 将内部文件候选映射为跨端日志文件 DTO。 */
function toClientLogFileItem(item: LogFileCandidate): ClientLogFileItem {
  return {
    fileName: item.fileName,
    sizeBytes: item.sizeBytes,
    mtimeMs: item.mtimeMs,
  };
}

/** 从文件尾部读取有限字节并返回最后 N 行。 */
function readTailLines(filePath: string, lines: number, maxBytes: number): { lines: string[]; truncated: boolean } {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { lines: [], truncated: false };
  const bytesToRead = Math.min(stat.size, maxBytes);
  if (bytesToRead <= 0) return { lines: [], truncated: false };

  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const start = stat.size - bytesToRead;
    fs.readSync(fd, buffer, 0, bytesToRead, start);
    const allLines = buffer.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
    if (start > 0 && allLines.length) allLines.shift();
    const selected = allLines.slice(-lines);
    return {
      lines: selected,
      truncated: start > 0 || selected.length < allLines.length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 将 JSON 行日志解析为展示字段，解析失败时保留原始行。 */
function parseLogTailEntry(raw: string): ClientLogTailEntry {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      time: toNullableString(parsed.time ?? parsed.timestamp),
      level: toNullableString(parsed.level),
      module: toNullableString(parsed.module),
      message: String(parsed.message ?? parsed.msg ?? raw),
      raw,
    };
  } catch {
    return {
      time: null,
      level: null,
      module: null,
      message: raw,
      raw,
    };
  }
}

/** 读取第一个非空环境变量。 */
function readFirstEnv(keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = String(process.env[key] ?? "").trim();
    if (value) return value;
  }
  return fallback;
}

/** 生成与共享 pino logger 相同的日期后缀。 */
function formatDateSuffix(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/** 在文件扩展名前追加日期后缀。 */
function appendDateSuffixToFileName(fileName: string, dateSuffix: string): string {
  const parsed = path.parse(fileName);
  const ext = parsed.ext || ".log";
  const name = parsed.name || "client";
  return `${name}-${dateSuffix}${ext}`;
}

/** 限制 tail 行数，避免响应过大。 */
function normalizeTailLines(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 200;
  return Math.min(500, Math.max(20, Math.floor(numeric)));
}

/** 限制 tail 读取字节数，避免一次读取大日志文件。 */
function normalizeTailBytes(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 512 * 1024;
  return Math.min(1024 * 1024, Math.max(32 * 1024, Math.floor(numeric)));
}

/** 将空字符串归一为空值。 */
function toNullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** 校验请求是否明确指向当前 Client，避免跨 Client 读取日志。 */
function isRequestForCurrentClient(ctx: ApiHandlerContext, clientId: unknown): boolean {
  return String(clientId ?? "").trim() === ctx.clientId;
}
