import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertDesktopCrashCleanMarker, assertDesktopCrashReport, assertDesktopCrashSessionMarker, digestDesktopCrashReport, matchesDesktopCrashReportAck,
  type DesktopCrashCleanMarker, type DesktopCrashReport, type DesktopCrashReportAck, type DesktopCrashSessionMarker } from "@codeflowai/shared/desktop-crash-report";

const MAX_PENDING_REPORTS = 20;
// 确认行仅用于判定待报，超过该行数后重写为仅保留待报报告，避免日志无限增长。
const MAX_JOURNAL_LINES = 400;
const REPORT_FILE = "crash-reports.jsonl";
const SESSION_FILE = "crash-session.json";
const CLEAN_FILE = "crash-session.clean.json";
const RETRY_FILE = "crash-session.retry.json";

export type CrashReportJournal = ReturnType<typeof createCrashReportJournal>;
type StoredAck = DesktopCrashReportAck & { schemaVersion: 1; kind: "ack" };

/** 崩溃证据与确认共用一条耐久日志；待报上限只丢最旧证据并保留确认历史。 */
export function createCrashReportJournal(rootDir: string) {
  const directory = path.resolve(rootDir), filePath = path.join(directory, REPORT_FILE);
  let unusable: Error | null = null;
  let flushing = false;
  // 正在投递的证据不能被并发崩溃触发的上限清理淘汰，否则确认会变成孤儿行。
  const inFlight = new Set<string>();

  /** 同步追加并 fsync；失败时恢复原长度，回滚失败保留双因并标记不可用。 */
  const appendLine = (value: unknown): void => {
    if (unusable) throw new Error("DESKTOP_CRASH_JOURNAL_UNAVAILABLE", { cause: unusable });
    fs.mkdirSync(directory, { recursive: true });
    const fd = fs.openSync(filePath, "a", 0o600);
    let failure: { cause: unknown } | undefined;
    try {
      const beforeSize = fs.fstatSync(fd).size;
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
        fs.fsyncSync(fd);
      } catch (error) {
        try {
          fs.truncateSync(filePath, beforeSize);
          const rollbackFd = fs.openSync(filePath, "r+");
          try { fs.fsyncSync(rollbackFd); } finally { fs.closeSync(rollbackFd); }
        } catch (rollbackError) {
          unusable = new AggregateError([error, rollbackError], "DESKTOP_CRASH_JOURNAL_APPEND_ROLLBACK_FAILED");
          throw unusable;
        }
        throw error;
      }
    } catch (cause) { failure = { cause }; throw cause; }
    finally {
      try { fs.closeSync(fd); }
      catch (error) {
        if (failure) throw new AggregateError([failure.cause, error], "DESKTOP_CRASH_JOURNAL_CLOSE_FAILED");
        throw error;
      }
    }
  };

  /** 逐行验证报告与确认；损坏行显式失败，不能跳过后续证据。 */
  const readRecords = (): { reports: DesktopCrashReport[]; pending: DesktopCrashReport[]; raw: string[] } => {
    if (unusable) throw new Error("DESKTOP_CRASH_JOURNAL_UNAVAILABLE", { cause: unusable });
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath)); }
    catch (error) { if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { reports: [], pending: [], raw: [] }; throw error; }
    const reports = new Map<string, DesktopCrashReport>(), pending = new Map<string, DesktopCrashReport>(), raw: string[] = [];
    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line && index === lines.length - 1) continue;
      raw.push(line);
      try {
        const value = JSON.parse(line) as DesktopCrashReport | StoredAck;
        if (value.schemaVersion !== 1 || typeof value.reportId !== "string") throw new Error("invalid identity");
        if ((value as DesktopCrashReport).kind === "crash") {
          assertDesktopCrashReport(value);
          if (reports.has(value.reportId)) throw new Error("duplicate crash report");
          reports.set(value.reportId, value);
          pending.set(value.reportId, value);
        } else if ((value as StoredAck).kind === "ack") {
          const keys = ["schemaVersion", "kind", "reportId", "deviceId", "payloadSha256"];
          if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("invalid acknowledgement shape");
          const report = reports.get(value.reportId);
          if (!report || !matchesDesktopCrashReportAck(report, value)) throw new Error("invalid acknowledgement");
          pending.delete(value.reportId);
        } else throw new Error("unknown crash journal record");
      } catch (cause) {
        throw Object.assign(new Error(`DESKTOP_CRASH_JOURNAL_INVALID: line=${index + 1}`, { cause }), { code: "DESKTOP_CRASH_JOURNAL_INVALID" });
      }
    }
    return { reports: [...reports.values()], pending: [...pending.values()], raw };
  };

  /** 原子重写为仅含待报证据；dropId 用于待报超限时淘汰最旧的非投递报告。 */
  const writeJournalSnapshot = (pending: DesktopCrashReport[], incoming: DesktopCrashReport, dropId?: string): void => {
    const lines = pending.filter(report => report.reportId !== dropId).map(report => JSON.stringify(report));
    lines.push(JSON.stringify(incoming));
    writeTempAtomically(filePath, `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`, `${lines.join("\n")}\n`);
  };

  /** 待报超限时淘汰最旧的非投递证据；确认行达到上限时整体压实。 */
  const appendWithLimit = (incoming: DesktopCrashReport): void => {
    const { pending, raw } = readRecords();
    if (pending.length < MAX_PENDING_REPORTS) {
      if (raw.length + 1 < MAX_JOURNAL_LINES) appendLine(incoming);
      else writeJournalSnapshot(pending, incoming);
      return;
    }
    const oldest = pending.find(report => !inFlight.has(report.reportId));
    // 全部待报都在投递中时短暂超限，避免丢弃正在确认的证据。
    if (!oldest) appendLine(incoming);
    else writeJournalSnapshot(pending, incoming, oldest.reportId);
  };

  return {
    /** 补全固定 ID、摘要和时间后落盘；超限先丢最旧证据。 */
    record(input: Omit<DesktopCrashReport, "schemaVersion" | "kind" | "reportId" | "payloadSha256"> & { reportId?: string }): DesktopCrashReport {
      const payload = { ...input, schemaVersion: 1 as const, kind: "crash" as const,
        reportId: input.reportId ?? crypto.randomUUID(),
        detectedAt: new Date(input.detectedAt).toISOString() };
      const report = { ...payload, payloadSha256: digestDesktopCrashReport(payload) };
      assertDesktopCrashReport(report);
      appendWithLimit(report);
      return report;
    },
    /** 只取当前设备待报；未绑定设备的证据留在本地，不冒用其他身份上传。 */
    pending(deviceId: string): DesktopCrashReport[] {
      return readRecords().pending.filter(report => report.deviceId === deviceId);
    },
    /** 本机全部待报计数用于诊断，不向页面暴露正文。 */
    pendingCount(): number { return readRecords().pending.length; },
    /** 串行补报并精确确认；任一失败立即停止且保留其余待报。 */
    async flush(deviceId: string, send: (report: DesktopCrashReport) => Promise<DesktopCrashReportAck>): Promise<void> {
      if (flushing) throw new Error("DESKTOP_CRASH_DELIVERY_IN_PROGRESS");
      // 读取失败必须发生在占用投递锁之前，否则同进程后续补报会被永久拒绝。
      const batch = this.pending(deviceId);
      flushing = true;
      // 整批发送期间都禁止淘汰，避免后续确认落空。
      for (const report of batch) inFlight.add(report.reportId);
      try {
        for (const report of batch) {
          const ack = await send(report);
          if (!matchesDesktopCrashReportAck(report, ack)) throw new Error(`DESKTOP_CRASH_ACK_MISMATCH: reportId=${report.reportId}`);
          appendLine({ schemaVersion: 1, kind: "ack", reportId: report.reportId, deviceId: report.deviceId, payloadSha256: report.payloadSha256 });
        }
      } finally {
        for (const report of batch) inFlight.delete(report.reportId);
        flushing = false;
      }
    },
    filePath,
  };
}

/** 会话标记原子写入；同一会话更新只替换固定文件。 */
export function writeCrashSessionMarker(rootDir: string, marker: DesktopCrashSessionMarker): void {
  assertDesktopCrashSessionMarker(marker);
  writeAtomic(path.join(path.resolve(rootDir), SESSION_FILE), marker);
}

/** 读取上次会话标记；不存在返回 null，损坏显式抛出。 */
export function readCrashSessionMarker(rootDir: string): DesktopCrashSessionMarker | null {
  const value = readJson(path.join(path.resolve(rootDir), SESSION_FILE));
  if (value === null) return null;
  assertDesktopCrashSessionMarker(value);
  return value;
}

export function removeCrashSessionMarker(rootDir: string): void {
  fs.rmSync(path.join(path.resolve(rootDir), SESSION_FILE), { force: true });
}

/** 正常退出只写会话 ID；下次启动据此区分崩溃与干净退出。 */
export function writeCrashCleanMarker(rootDir: string, sessionId: string, cleanAt = new Date().toISOString()): void {
  const marker: DesktopCrashCleanMarker = { schemaVersion: 1, sessionId, cleanAt };
  assertDesktopCrashCleanMarker(marker);
  writeAtomic(path.join(path.resolve(rootDir), CLEAN_FILE), marker);
}

export function readCrashCleanMarker(rootDir: string): DesktopCrashCleanMarker | null {
  const value = readJson(path.join(path.resolve(rootDir), CLEAN_FILE));
  if (value === null) return null;
  assertDesktopCrashCleanMarker(value);
  return value;
}

export function removeCrashCleanMarker(rootDir: string): void {
  fs.rmSync(path.join(path.resolve(rootDir), CLEAN_FILE), { force: true });
}

/** 异常退出报告落盘失败时保留原会话事实，供下次启动重试。 */
export function writeCrashRetryMarker(rootDir: string, marker: DesktopCrashSessionMarker): void {
  assertDesktopCrashSessionMarker(marker);
  writeAtomic(path.join(path.resolve(rootDir), RETRY_FILE), marker);
}

export function readCrashRetryMarker(rootDir: string): DesktopCrashSessionMarker | null {
  const value = readJson(path.join(path.resolve(rootDir), RETRY_FILE));
  if (value === null) return null;
  assertDesktopCrashSessionMarker(value);
  return value;
}

export function removeCrashRetryMarker(rootDir: string): void {
  fs.rmSync(path.join(path.resolve(rootDir), RETRY_FILE), { force: true });
}

/** 路径固定且目录已由调用方保证；同步 fsync 后原子替换。 */
function writeAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeTempAtomically(filePath, `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`, `${JSON.stringify(value)}\n`);
}

/** 临时文件写入、关闭、替换任一阶段失败都清理残留，避免长期累积。 */
function writeTempAtomically(filePath: string, tempPath: string, content: string): void {
  let failure: unknown, fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } catch (error) { failure = error; }
  if (fd !== undefined) {
    try { fs.closeSync(fd); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "DESKTOP_CRASH_JOURNAL_CLOSE_FAILED") : error; }
  }
  if (!failure) {
    try { fs.renameSync(tempPath, filePath); }
    catch (error) { failure = error; }
  }
  if (!failure) return;
  try { fs.rmSync(tempPath, { force: true }); }
  catch (cleanupError) { throw new AggregateError([failure, cleanupError], "DESKTOP_CRASH_JOURNAL_TEMP_CLEANUP_FAILED"); }
  throw failure;
}

/** 读取小型标记；缺失返回 null，其余读取或解析错误保持原始原因。 */
function readJson(filePath: string): unknown | null {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null; throw error; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw Object.assign(new Error("DESKTOP_CRASH_MARKER_INVALID", { cause: error }), { code: "DESKTOP_CRASH_MARKER_INVALID" }); }
}
