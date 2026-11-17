import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP_CRASH_STACK_MAX_FRAMES, DESKTOP_CRASH_STACK_MAX_LENGTH,
  type DesktopCrashEvent, type DesktopCrashProcessType, type DesktopCrashReason, type DesktopCrashRecentError, type DesktopCrashReport,
  type DesktopCrashSessionMarker, type DesktopCrashVersions } from "@codeflowai/shared/desktop-crash-report";
import { createCrashReportJournal, readCrashCleanMarker, readCrashRetryMarker, readCrashSessionMarker, removeCrashCleanMarker,
  removeCrashRetryMarker, removeCrashSessionMarker, writeCrashCleanMarker, writeCrashRetryMarker, writeCrashSessionMarker,
  type CrashReportJournal } from "./crashReportJournal.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PHASE = /^[a-z][a-z0-9-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;
const METHOD = /^[A-Za-z][A-Za-z0-9._:+-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/;
const RECENT_ERROR_WINDOW_BYTES = 64 * 1024;

type CrashAppEvents = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
};
type RendererGoneDetails = { reason: string; exitCode: number };
type ChildGoneDetails = { type: string; reason: string; exitCode: number };

export type DesktopCrashRuntimeFacts = {
  deviceId?: string | null;
  versions?: Partial<DesktopCrashVersions>;
};

export type DesktopCrashCapture = ReturnType<typeof createDesktopCrashCapture>;

/** 主进程拥有崩溃捕获上下文；持久化和补报失败交给原主进程错误边界记录。 */
export function createDesktopCrashCapture(input: {
  dataDir: string;
  app: CrashAppEvents;
  shellVersion: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  recordError?: (error: unknown, context: { errorCode: string; requestId: string }) => void;
}) {
  const dataDir = path.resolve(input.dataDir);
  const now = input.now ?? Date.now;
  const journal: CrashReportJournal = createCrashReportJournal(dataDir);
  const detectedPlatform = readPlatform(input.platform ?? process.platform), detectedArch = readArch(input.arch ?? process.arch);
  // 平台与架构必须成对；任一不可识别时整体保持未知，避免生成必然被合同拒绝的报告。
  const platform = detectedPlatform && detectedArch ? detectedPlatform : null;
  const arch = platform ? detectedArch : null;
  const versions: DesktopCrashVersions = { shellVersion: safeVersion(input.shellVersion), webVersion: null, clientVersion: null, releaseId: null, shellId: null };
  const identity = readDeviceId(dataDir);
  let deviceId = identity.deviceId;
  let session: DesktopCrashSessionMarker | null = null;
  let initialized = false, fatal = false, expectedExit = false;
  let lastEvent = { key: "", at: 0 };
  let hooks: { uncaught: (error: unknown) => void; rejection: (reason: unknown) => void;
    renderer: (...args: unknown[]) => void; child: (...args: unknown[]) => void; exit: () => void } | null = null;

  /** 内部失败只记录一次结构化上下文，不把任意异常正文写入崩溃报告。 */
  const reportInternal = (errorCode: string, error: unknown, requestId: string): void => {
    try { input.recordError?.(Object.assign(error instanceof Error ? error : new Error(errorCode), { code: errorCode }), { errorCode, requestId }); }
    catch { try { process.stderr.write(`[desktop-crash] ${errorCode}\n`); } catch { /* 退出阶段已无法继续输出 */ } }
  };
  if (identity.invalid) reportInternal("DESKTOP_CRASH_IDENTITY_UNAVAILABLE", identity.invalid, crypto.randomUUID());

  /** 用上次会话事实补一条异常退出报告；旧证据归属上次设备。 */
  const reportAbnormalExit = (marker: DesktopCrashSessionMarker, detectedAt: string): DesktopCrashReport | null => {
    const recent = readRecentErrors(dataDir);
    try {
      return journal.record({
        reportId: crypto.randomUUID(), deviceId: marker.deviceId ?? deviceId, sessionId: marker.sessionId, sessionStartedAt: marker.startedAt,
        event: "abnormal_exit", processType: "main", reason: "abnormal-exit", exitCode: null,
        occurredAt: detectedAt, detectedAt, phase: null, errorCode: "DESKTOP_CRASH_ABNORMAL_EXIT", requestId: marker.sessionId,
        causeCodes: recent.failed ? ["DESKTOP_CRASH_RECENT_ERRORS_UNAVAILABLE"] : [], recentErrors: recent.errors,
        versions: marker.versions, platform: marker.platform, arch: marker.arch,
      });
    } catch (error) {
      reportInternal("DESKTOP_CRASH_ABNORMAL_REPORT_FAILED", error, marker.sessionId);
      return null;
    }
  };

  /** 组装并落盘一条脱敏报告；同进程同维度两秒内去重。 */
  const report = (facts: {
    event: DesktopCrashEvent; processType: DesktopCrashProcessType; reason: DesktopCrashReason; exitCode: number | null;
    errorCode: string | null; requestId: string | null; phase: string | null; causeCodes: string[]; occurredAt?: string;
    stack?: string | null;
  }): DesktopCrashReport | null => {
    const at = now();
    const key = `${facts.processType}|${facts.errorCode ?? "none"}|${facts.exitCode ?? "none"}`;
    if (lastEvent.key === key && at - lastEvent.at < 2_000) return null;
    lastEvent = { key, at };
    const detectedAt = new Date(at).toISOString(), sessionId = session?.sessionId ?? crypto.randomUUID();
    const recent = readRecentErrors(dataDir);
    const causeCodes = [...new Set([...facts.causeCodes, ...(recent.failed ? ["DESKTOP_CRASH_RECENT_ERRORS_UNAVAILABLE"] : [])])].slice(0, 16);
    try {
      return journal.record({
        reportId: crypto.randomUUID(), deviceId, sessionId, sessionStartedAt: session?.startedAt ?? detectedAt,
        event: facts.event, processType: facts.processType, reason: facts.reason, exitCode: facts.exitCode,
        occurredAt: facts.occurredAt && facts.occurredAt <= detectedAt ? facts.occurredAt : detectedAt, detectedAt,
        phase: facts.phase, errorCode: facts.errorCode, requestId: facts.requestId, causeCodes, recentErrors: recent.errors,
        versions: { ...versions }, platform, arch,
        ...(facts.stack ? { stack: facts.stack } : {}),
      });
    } catch (error) {
      reportInternal("DESKTOP_CRASH_REPORT_PERSIST_FAILED", Object.assign(error instanceof Error ? error : new Error("DESKTOP_CRASH_REPORT_PERSIST_FAILED"), {
        requestId: facts.requestId ?? undefined,
      }), facts.requestId ?? sessionId);
      return null;
    }
  };

  /** 正常退出写清洁标记；捕获到未处理异常时保留会话标记供下次补报。 */
  const markClean = (): void => {
    if (fatal || !session) return;
    try { writeCrashCleanMarker(dataDir, session.sessionId); }
    catch (error) { reportInternal("DESKTOP_CRASH_CLEAN_MARKER_WRITE_FAILED", error, session.sessionId); }
  };

  return {
    journal,
    /** 读取上次会话、补报异常退出并建立本次会话标记；失败只影响崩溃捕获，不阻断壳启动。 */
    initialize(): { sessionId: string; abnormal: DesktopCrashReport | null } {
      if (initialized) throw new Error("DESKTOP_CRASH_CAPTURE_ALREADY_INITIALIZED");
      initialized = true;
      const detectedAt = new Date(now()).toISOString();
      let previous: DesktopCrashSessionMarker | null = null, clean: { sessionId: string } | null = null;
      let retry: DesktopCrashSessionMarker | null = null, retryPending = false;
      try { retry = readCrashRetryMarker(dataDir); }
      catch (error) { reportInternal("DESKTOP_CRASH_RETRY_MARKER_INVALID", error, crypto.randomUUID()); }
      if (retry) {
        retryPending = reportAbnormalExit(retry, detectedAt) === null;
        if (!retryPending) {
          try { removeCrashRetryMarker(dataDir); }
          catch (error) { reportInternal("DESKTOP_CRASH_RETRY_MARKER_REMOVE_FAILED", error, retry.sessionId); }
        }
      }
      try { previous = readCrashSessionMarker(dataDir); }
      catch (error) { reportInternal("DESKTOP_CRASH_SESSION_MARKER_INVALID", error, crypto.randomUUID()); }
      try { clean = readCrashCleanMarker(dataDir); }
      catch (error) { reportInternal("DESKTOP_CRASH_CLEAN_MARKER_INVALID", error, previous?.sessionId ?? crypto.randomUUID()); }
      const unclean = previous && clean?.sessionId !== previous.sessionId ? previous : null;
      // 同一会话已被重试标记接管时不再重复补报。
      const abnormal = unclean && unclean.sessionId !== retry?.sessionId ? reportAbnormalExit(unclean, detectedAt) : null;
      if (unclean && unclean.sessionId !== retry?.sessionId && !abnormal) {
        if (!retryPending) {
          try { writeCrashRetryMarker(dataDir, unclean); }
          catch (error) { reportInternal("DESKTOP_CRASH_RETRY_MARKER_WRITE_FAILED", error, unclean.sessionId); }
        } else {
          reportInternal("DESKTOP_CRASH_RETRY_CONFLICT", new Error("DESKTOP_CRASH_RETRY_CONFLICT"), unclean.sessionId);
        }
      }
      try { removeCrashSessionMarker(dataDir); removeCrashCleanMarker(dataDir); }
      catch (error) { reportInternal("DESKTOP_CRASH_MARKER_REMOVE_FAILED", error, previous?.sessionId ?? crypto.randomUUID()); }
      session = { schemaVersion: 1, sessionId: crypto.randomUUID(), startedAt: detectedAt, deviceId, versions: { ...versions }, platform, arch };
      try { writeCrashSessionMarker(dataDir, session); }
      catch (error) { reportInternal("DESKTOP_CRASH_SESSION_MARKER_WRITE_FAILED", error, session.sessionId); }

      const registered = {
        uncaught: (error: unknown) => {
          fatal = true;
          const facts = safeErrorFacts(error);
          report({ event: "main_uncaught_exception", processType: "main", reason: "exception", exitCode: null, ...facts });
        },
        rejection: (reason: unknown) => {
          const facts = safeErrorFacts(reason);
          report({ event: "main_unhandled_rejection", processType: "main", reason: "rejection", exitCode: null, ...facts });
          // 监听器会抑制 Node 默认终止；下一拍重新抛出以保持原未处理拒绝语义。
          process.nextTick(() => { throw reason; });
        },
        renderer: (...args: unknown[]) => {
          if (expectedExit) return;
          const details = args[2] as RendererGoneDetails | undefined;
          const reason = mapReason(details?.reason);
          if (!reason) return;
          report({ event: "renderer_process_gone", processType: "renderer", reason, exitCode: readExitCode(details?.exitCode),
            errorCode: null, requestId: null, phase: null, causeCodes: [] });
        },
        child: (...args: unknown[]) => {
          if (expectedExit) return;
          const details = args[1] as ChildGoneDetails | undefined;
          const reason = mapReason(details?.reason);
          if (!reason) return;
          report({ event: "child_process_gone", processType: /^GPU$/i.test(details?.type ?? "") ? "gpu" : "utility", reason,
            exitCode: readExitCode(details?.exitCode), errorCode: null, requestId: null, phase: null, causeCodes: [] });
        },
        exit: markClean,
      };
      hooks = registered;
      process.on("uncaughtExceptionMonitor", registered.uncaught);
      process.on("unhandledRejection", registered.rejection);
      input.app.on("render-process-gone", registered.renderer);
      input.app.on("child-process-gone", registered.child);
      process.on("exit", registered.exit);
      return { sessionId: session.sessionId, abnormal };
    },

    /** 运行时版本或安装身份就绪后更新后续报告与本次会话标记。 */
    updateRuntimeFacts(facts: DesktopCrashRuntimeFacts): void {
      if (facts.deviceId !== undefined) deviceId = facts.deviceId && UUID.test(facts.deviceId) ? facts.deviceId : null;
      if (facts.versions) {
        for (const key of ["shellVersion", "webVersion", "clientVersion", "releaseId", "shellId"] as const) {
          const value = facts.versions[key];
          if (value !== undefined) versions[key] = safeVersion(value);
        }
      }
      if (!session) return;
      session = { ...session, deviceId, versions: { ...versions } };
      try { writeCrashSessionMarker(dataDir, session); }
      catch (error) { reportInternal("DESKTOP_CRASH_SESSION_MARKER_WRITE_FAILED", error, session.sessionId); }
    },

    /** Client 子进程非预期退出单独上报；主动停止不进入崩溃证据。 */
    reportClientExit(facts: { exitCode: number | null; signal: string | null; expected: boolean }): DesktopCrashReport | null {
      if (facts.expected || facts.exitCode === 0 || (facts.exitCode === null && facts.signal === null)) return null;
      return report({ event: "client_process_exit", processType: "client", reason: facts.signal !== null ? "killed" : "crashed",
        exitCode: facts.exitCode, errorCode: facts.exitCode === null ? "DESKTOP_CLIENT_EXIT_UNKNOWN" : "DESKTOP_CLIENT_EXIT_ABNORMAL",
        requestId: null, phase: null, causeCodes: [] });
    },

    /** 主动销毁窗口和子进程前调用；其后的进程退出不再记为崩溃。 */
    expectExit(): void { expectedExit = true; },
    /** 供主进程退出前显式落清洁标记；进程 exit 钩子仍会兜底。 */
    markClean,
    /** 仅测试与宿主销毁使用，避免重复注册全局钩子。 */
    dispose(): void {
      if (!hooks) return;
      process.off("uncaughtExceptionMonitor", hooks.uncaught);
      process.off("unhandledRejection", hooks.rejection);
      input.app.removeListener("render-process-gone", hooks.renderer);
      input.app.removeListener("child-process-gone", hooks.child);
      process.off("exit", hooks.exit);
      hooks = null;
    },
  };
}

/** 平台和架构必须成对且属于已支持集合；其他平台不伪造。 */
function readPlatform(value: NodeJS.Platform): "win32" | "darwin" | null {
  return value === "win32" || value === "darwin" ? value : null;
}

function readArch(value: string): "x64" | "arm64" | null {
  return value === "x64" || value === "arm64" ? value : null;
}

function safeVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value) ? value : null;
}

/** 同步读取已有身份文件；缺失是首装常态，损坏显式交给宿主记录。 */
function readDeviceId(dataDir: string): { deviceId: string | null; invalid: Error | null } {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.join(dataDir, "device-identity.json")))) as { deviceId?: unknown };
    return typeof parsed.deviceId === "string" && UUID.test(parsed.deviceId)
      ? { deviceId: parsed.deviceId, invalid: null }
      : { deviceId: null, invalid: new Error("DESKTOP_CRASH_IDENTITY_INVALID") };
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
      ? { deviceId: null, invalid: null } : { deviceId: null, invalid: error instanceof Error ? error : new Error("DESKTOP_CRASH_IDENTITY_INVALID") };
  }
}

/** 只保留公开错误码、请求 ID、阶段和脱敏调用帧；异常消息与扩展属性不进入证据。 */
function safeErrorFacts(value: unknown): { errorCode: string | null; requestId: string | null; phase: string | null; causeCodes: string[];
  stack: string | null } {
  const chain = collectErrors(value);
  const codes = chain.map(errorCodeOf).filter((code): code is string => code !== null);
  const first = chain[0], requestId = first && typeof first === "object" ? (first as { requestId?: unknown }).requestId : undefined;
  const phase = first && typeof first === "object" ? (first as { phase?: unknown }).phase : undefined;
  return {
    errorCode: codes[0] ?? null,
    requestId: typeof requestId === "string" && REQUEST_ID.test(requestId) ? requestId : null,
    phase: typeof phase === "string" && PHASE.test(phase) ? phase : null,
    causeCodes: [...new Set(codes.slice(1))].slice(0, 16),
    stack: safeStack(first),
  };
}

/** 只保留调用帧并把用户目录替换为 ~；异常消息本身不上传。 */
function safeStack(value: unknown): string | null {
  if (!(value instanceof Error) || typeof value.stack !== "string") return null;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const frames = value.stack.split("\n")
    .map(line => line.trimStart())
    .filter(line => line.startsWith("at "))
    .slice(0, DESKTOP_CRASH_STACK_MAX_FRAMES)
    .map(line => home ? line.split(home).join("~") : line);
  const stack = frames.join("\n").slice(0, DESKTOP_CRASH_STACK_MAX_LENGTH);
  return stack || null;
}

function collectErrors(value: unknown, depth = 0): unknown[] {
  if (!value || typeof value !== "object" || depth > 3) return [value];
  const error = value as { cause?: unknown; errors?: unknown };
  const nested = Array.isArray(error.errors) ? error.errors : error.cause !== undefined ? [error.cause] : [];
  return [value, ...nested.flatMap(cause => collectErrors(cause, depth + 1))];
}

function errorCodeOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" && ERROR_CODE.test(code)) return code;
  const match = /^([A-Z][A-Z0-9_]{0,63})(?::|$|\s)/u.exec(value instanceof Error ? value.message : "");
  return match?.[1] ?? null;
}

/** 读取最近的结构化错误摘要；失败不阻断崩溃证据，但以固定原因码显式标记。 */
function readRecentErrors(dataDir: string): { errors: DesktopCrashRecentError[]; failed: boolean } {
  const filePath = path.join(dataDir, "logs", "desktop-errors.jsonl");
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { errors: [], failed: true };
    const start = Math.max(0, stat.size - RECENT_ERROR_WINDOW_BYTES);
    const fd = fs.openSync(filePath, "r"), buffer = Buffer.alloc(stat.size - start), previous = Buffer.alloc(1);
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
      // 窗口从行中间开始时按字节丢弃半行，避免 fatal 解码在多字节字符中间失败。
      if (start > 0) fs.readSync(fd, previous, 0, 1, start - 1);
    } finally { fs.closeSync(fd); }
    let offset = 0;
    if (start > 0 && previous[0] !== 0x0a) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return { errors: [], failed: false };
      offset = newline + 1;
    }
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(offset)).split("\n");
    const errors: DesktopCrashRecentError[] = [];
    let corrupt = false;
    for (const line of lines) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const at = typeof value.at === "string" && new Date(value.at).toISOString() === value.at ? value.at : null;
        const errorCode = typeof value.errorCode === "string" && ERROR_CODE.test(value.errorCode) ? value.errorCode : null;
        if (!at || !errorCode) { corrupt = true; continue; }
        errors.push({ at, errorCode,
          requestId: typeof value.requestId === "string" && REQUEST_ID.test(value.requestId) ? value.requestId : null,
          channel: typeof value.channel === "string" && CHANNEL.test(value.channel) ? value.channel : null,
          method: typeof value.method === "string" && METHOD.test(value.method) ? value.method : null });
      } catch { corrupt = true; }
    }
    return { errors: errors.slice(-12), failed: corrupt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { errors: [], failed: false };
    return { errors: [], failed: true };
  }
}

/** Electron 退出原因映射；clean-exit 不产生崩溃证据。 */
function mapReason(reason: unknown): DesktopCrashReason | null {
  return reason === "crashed" ? "crashed" : reason === "oom" ? "oom" : reason === "killed" ? "killed"
    : reason === "launch-failed" ? "launch-failed" : reason === "integrity-failure" || reason === "integrity-failed" ? "integrity-failed"
      : reason === "abnormal-exit" ? "abnormal-exit" : reason === "clean-exit" ? null : "unknown";
}

function readExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647 ? value : null;
}
