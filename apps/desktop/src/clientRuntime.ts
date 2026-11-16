import crypto from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { snapshotDesktopStartupMode, snapshotDesktopStartupReady, type DesktopStartupMode, type DesktopClientReadyMessage, type DesktopRuntimeRequest, type DesktopApiResponse, type DesktopApiResponseMessage, type DesktopClientHealth, type DesktopEvent } from "@codeflowai/shared";
import type { DesktopRuntimeState, ReleaseBundleManifest } from "./contracts.js";
import { augmentMacOSGuiPath } from "./macosPath.js";

export type ClientRuntimeSnapshot = DesktopRuntimeState & {
  pid: number | null;
  health: DesktopClientHealth | null;
  startup?: DesktopClientReadyMessage["startup"];
};

export type ClientRuntimeExpectation = Pick<ReleaseBundleManifest, "releaseId" | "clientVersion" | "protocolVersion" | "dbSchemaVersion">;

type ClientChild = {
  pid?: number;
  stderr?: NodeJS.ReadableStream | null;
  send(message: unknown, callback: (error: Error | null) => void): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  setMaxListeners?: (count: number) => unknown;
};

type SpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "inherit", "pipe", "ipc"];
  windowsHide: boolean;
};

/** 单次启动的 Client 原生 stderr 上限；超限后停止写入，下次启动重新截断。 */
const CLIENT_STDERR_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** 桌面私有 CLI 运行时的三个绝对路径，仅由宿主按实际资源布局提供。 */
export type ClientCliRuntime = { root: string; npmCliPath: string; manifestPath: string };

/** npm 与推荐清单跟随所选 Client；仅开发态完全缺失时沿既有系统 CLI 入口。 */
export function resolveClientCliRuntime(input: { releaseDir: string; dataDir: string; required?: boolean }): ClientCliRuntime | undefined {
  const npmCliPath = path.resolve(input.releaseDir, "client/npm/bin/npm-cli.js");
  const manifestPath = path.resolve(input.releaseDir, "client/cli-runtime.json");
  const present = [npmCliPath, manifestPath].map(file => {
    try { return fs.statSync(file).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
  if (present.every(Boolean)) return { root: path.resolve(input.dataDir, "cli-runtime"), npmCliPath, manifestPath };
  if (!input.required && present.every(value => !value)) return undefined;
  throw Object.assign(new Error("DESKTOP_CLI_RUNTIME_MISSING"), { code: "DESKTOP_CLI_RUNTIME_MISSING" });
}

type ClientRuntimeDeps = {
  entry: string;
  dataDir: string;
  expectedRelease?: ClientRuntimeExpectation;
  startup?: DesktopStartupMode;
  /** 未提供时保持系统安装 CLI 的既有行为。 */
  cliRuntime?: ClientCliRuntime;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ClientChild;
  /** 子进程退出观察；主动停止以 expected 标记，不进入崩溃证据。 */
  onExit?: (facts: { exitCode: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void;
};

export type ClientRuntime = {
  start(): Promise<void>;
  waitReady(timeoutMs?: number): Promise<void>;
  stop(reason?: "exit" | "update"): Promise<void>;
  drain(timeoutMs?: number): Promise<void>;
  snapshot(): ClientRuntimeSnapshot;
  request(request: DesktopRuntimeRequest, timeoutMs?: number): Promise<DesktopApiResponse>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
};

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** 管理现有 Client 入口的进程生命周期，并将数据目录映射到既有环境契约。 */
export function createClientRuntime(deps: ClientRuntimeDeps): ClientRuntime {
  const startup = snapshotDesktopStartupMode(deps.startup);
  const dataDir = path.resolve(deps.dataDir);
  const errorLogPath = path.join(dataDir, "logs", "desktop-runtime-errors.jsonl");
  const stderrLogPath = path.join(dataDir, "logs", "client-stderr.log");
  const spawnClient = deps.spawn ?? defaultSpawn;
  let child: ClientChild | null = null;
  let childExited = false;
  let stopping = false;
  let childClosed: Promise<void> = Promise.resolve();
  let lastFailure: Error | null = null;
  const startupStopReason = Object.assign(new Error("CLIENT_STARTUP_STOPPED"), { code: "CLIENT_STARTUP_STOPPED" });
  let detachMessages: (() => void) | null = null;
  const eventListeners = new Set<(event: DesktopEvent) => void>();
  let state: ClientRuntimeSnapshot = {
    status: "stopped",
    requestId: null,
    releaseId: deps.expectedRelease?.releaseId ?? null,
    errorCode: null,
    pid: null,
    health: null,
  };

  /**
   * 保留 Client 原生 stderr（未捕获异常源码行、V8 警告与 trace）。
   * 每次启动截断旧文件并限制单次大小；写入失败只报告，不改变运行时状态。
   */
  const captureClientStderr = (target: ClientChild): void => {
    const stderr = target.stderr;
    if (!stderr) return;
    let stream: fs.WriteStream;
    try {
      fs.mkdirSync(path.dirname(stderrLogPath), { recursive: true });
      if (fs.existsSync(stderrLogPath) && fs.statSync(stderrLogPath).size >= CLIENT_STDERR_LOG_MAX_BYTES) {
        fs.truncateSync(stderrLogPath, 0);
      }
      stream = fs.createWriteStream(stderrLogPath, { flags: "a" });
    } catch (error) {
      console.error("[DESKTOP_CLIENT_STDERR_LOG_FAILED]", {
        errorCode: "DESKTOP_CLIENT_STDERR_LOG_FAILED", pid: target.pid ?? null,
        rootCause: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let written = 0;
    try { written = fs.statSync(stderrLogPath).size; } catch { written = 0; }
    let reported = false;
    const report = (error: unknown): void => {
      if (reported) return;
      reported = true;
      console.error("[DESKTOP_CLIENT_STDERR_LOG_FAILED]", {
        errorCode: "DESKTOP_CLIENT_STDERR_LOG_FAILED", pid: target.pid ?? null,
        rootCause: error instanceof Error ? error.message : String(error),
      });
    };
    stream.on("error", report);
    stderr.on("data", (chunk: Buffer) => {
      if (written >= CLIENT_STDERR_LOG_MAX_BYTES) return;
      const slice = chunk.subarray(0, CLIENT_STDERR_LOG_MAX_BYTES - written);
      written += slice.length;
      if (!stream.destroyed) stream.write(slice);
    });
    stderr.on("close", () => { if (!stream.destroyed) stream.end(); });
  };

  /** 在拥有进程上下文的边界记录一次错误，并保留日志写入失败。 */
  const fail = (errorCode: string, error: unknown, pid: number | null, event?: DesktopEvent): Error => {
    const cause = error instanceof Error ? error : new Error(String(error), { cause: error });
    state = { ...state, status: "failed", errorCode };
    try {
      recordRuntimeError(errorLogPath, {
        errorCode,
        requestId: state.requestId,
        releaseId: state.releaseId,
        pid,
        rootCause: cause.message,
        ...eventDiagnosticContext(event),
      });
      lastFailure = cause;
    } catch (logError) {
      lastFailure = new AggregateError([cause, logError], "CLIENT_RUNTIME_ERROR_LOG_FAILED");
    }
    return lastFailure;
  };

  /** 已交给调用方的失败不再阻碍清理重试，状态快照仍保留失败事实。 */
  const raise = (error: unknown): never => {
    lastFailure = null;
    throw error;
  };

  /** exit立即撤销业务资格，但保留同child直到close确认资源收口。 */
  const handleExit = (currentChild: ClientChild, code: number | null, signal: NodeJS.Signals | null): void => {
    if (child !== currentChild) return;
    childExited = true;
    detachMessages?.();
    detachMessages = null;
    const processFailure = lastFailure;
    if (code === 0) state = processFailure || state.status === "failed" ? { ...state, status: "failed" }
      : { ...state, status: "draining", errorCode: null };
    else {
      const errorCode = `CLIENT_EXIT_${code ?? signal ?? "UNKNOWN"}`;
      fail(errorCode, new Error(errorCode), currentChild.pid ?? null);
      if (processFailure) lastFailure = new AggregateError([processFailure, lastFailure], errorCode);
    }
    deps.onExit?.({ exitCode: code, signal, expected: stopping });
  };

  return {
    /** 创建进程并等待 spawn；主动关闭沿停止结果返回，真实启动错误继续失败。 */
    async start(): Promise<void> {
      if (child) throw new Error("CLIENT_RUNTIME_ALREADY_RUNNING");
      const requestId = crypto.randomUUID();
      lastFailure = null; stopping = false;
      state = { ...state, status: "starting", requestId, errorCode: null, health: null, startup: undefined };
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        assertClientRuntimeCompatibility(deps.entry);
        // 首次启动且未显式配置工作区时，落一个默认工作区，保证开箱即有可用工作区。
        const hasConfiguredWorkspace = ["CODEFLOWAI_WORKSPACES_JSON", "CODEFLOWAI_WORKSPACES_FILE", "CODEFLOWAI_WORKSPACE_PATH"]
          .some(key => String(process.env[key] ?? "").trim());
        const defaultWorkspacePath = path.join(dataDir, "workspace");
        const seedDefaultWorkspace = !hasConfiguredWorkspace && !fs.existsSync(path.join(dataDir, "codeflowai.db"));
        if (seedDefaultWorkspace) {
          try { fs.mkdirSync(defaultWorkspacePath, { recursive: true }); }
          catch (error) { throw fail("DESKTOP_DEFAULT_WORKSPACE_PREPARE_FAILED", error, null); }
        }
        const env = { ...process.env };
        // Finder 启动不会继承用户 shell PATH，补齐后 CLI、Git 与 npm 才能被 Client 找到。
        if (process.platform === "darwin") env.PATH = augmentMacOSGuiPath(env);
        delete env.CODEFLOWAI_VERSION;
        delete env.CODEFLOWAI_DESKTOP_DB_SCHEMA_VERSION;
        delete env.CODEFLOWAI_DESKTOP_STARTUP_MODE;
        delete env.CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID;
        // 桌面稳定身份与凭据只取本机配置，不继承外部普通 Client 认证覆盖。
        delete env.CODEFLOWAI_API_KEY;
        delete env.CODEFLOWAI_CLIENT_ID;
        // 宿主未提供私有运行时配置时，不能让外部终端继承的 CODEFLOWAI_CLI_* 透传给 Client。
        if (!deps.cliRuntime) {
          delete env.CODEFLOWAI_CLI_RUNTIME_ROOT;
          delete env.CODEFLOWAI_CLI_NPM_CLI;
          delete env.CODEFLOWAI_CLI_RUNTIME_MANIFEST;
        }
        if (seedDefaultWorkspace) env.CODEFLOWAI_WORKSPACES_JSON = JSON.stringify([{ path: defaultWorkspacePath, label: "默认工作区" }]);
        env.CODEFLOWAI_DESKTOP_STARTUP_MODE = startup.mode;
        if (startup.mode === "held") env.CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID = startup.continuationId;
        if (deps.expectedRelease) env.CODEFLOWAI_DESKTOP_DB_SCHEMA_VERSION = String(deps.expectedRelease.dbSchemaVersion);
        child = spawnClient(process.execPath, ["--trace-uncaught", deps.entry, "--foreground"], {
          cwd: dataDir,
          env: {
            ...env,
            ELECTRON_RUN_AS_NODE: "1",
            CODEFLOWAI_DESKTOP_REQUEST_ID: requestId,
            CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(dataDir, "config.json"),
            CODEFLOWAI_CLIENT_DB_PATH: path.join(dataDir, "codeflowai.db"),
            CODEFLOWAI_CLIENT_LOG_DIR: path.join(dataDir, "logs"),
            ...(deps.cliRuntime ? {
              CODEFLOWAI_CLI_RUNTIME_ROOT: deps.cliRuntime.root,
              CODEFLOWAI_CLI_NPM_CLI: deps.cliRuntime.npmCliPath,
              CODEFLOWAI_CLI_RUNTIME_MANIFEST: deps.cliRuntime.manifestPath,
            } : {}),
          },
          stdio: ["ignore", "inherit", "pipe", "ipc"],
          windowsHide: true,
        });
        const currentChild = child;
        captureClientStderr(currentChild);
        childExited = false;
        // 每个在途 request 会临时挂 message/exit/error 监听；桌面首屏可能并发十余个请求。
        currentChild.setMaxListeners?.(100);
        let resolveClosed!: () => void;
        childClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
        /** close才释放同代资源owner；退出或spawn错误不能替代此事实。 */
        currentChild.once("close", () => {
          if (child === currentChild) {
            childExited = true;
            detachMessages?.(); detachMessages = null;
            child = null;
            state = { ...state, status: state.status === "failed" ? "failed" : "stopped", pid: null };
          }
          resolveClosed();
        });
        /** 单一监听同时处理就绪与事件，旧 child 或旧父关联不能污染当前状态。 */
        const onMessage = (message: unknown): void => {
          const value = message as { t?: unknown; requestId?: unknown; health?: unknown; startup?: unknown; event?: unknown } | null;
          if (child !== currentChild || childExited || state.requestId !== requestId || value?.requestId !== requestId) return;
          if (value.t === "desktop.event") {
            let committed: DesktopEvent | undefined;
            try {
              if (state.status !== "ready" && state.status !== "draining") throw new Error("DESKTOP_EVENT_NOT_READY");
              if (Object.keys(value).some(key => !["t", "requestId", "event"].includes(key))) throw new Error("DESKTOP_EVENT_ENVELOPE_INVALID");
              committed = assertDesktopEvent(value.event);
              for (const listener of [...eventListeners]) listener(committed);
            } catch (error) {
              fail("DESKTOP_EVENT_FAILED", error, currentChild.pid ?? null, committed);
            }
            return;
          }
          if (value?.t === "desktop.ready" && value.requestId === requestId && state.status === "running") {
            try {
              const health = assertClientHealth(value.health, deps.expectedRelease);
              const startupFact = startup.mode === "held" ? snapshotDesktopStartupReady(value.startup, startup.continuationId) : undefined;
              state = { ...state, status: "ready", health, startup: startupFact };
            } catch (error) {
              fail("CLIENT_HEALTH_FAILED", error, currentChild.pid ?? null);
            }
          }
        };
        currentChild.on("message", onMessage);
        detachMessages = () => { currentChild.removeListener("message", onMessage); };
        await new Promise<void>((resolve, reject) => {
          let pending = true;
          currentChild.once("spawn", () => {
            pending = false;
            state = { ...state, status: "running", pid: currentChild.pid ?? null };
            resolve();
          });
          currentChild.on("error", (error: Error) => {
            if (child !== currentChild) return;
            if (pending) { childExited = true; detachMessages?.(); detachMessages = null; }
            const previousFailure = lastFailure;
            const failure = fail("CLIENT_PROCESS_ERROR", error, currentChild.pid ?? null);
            if (previousFailure && previousFailure !== failure) lastFailure = new AggregateError([previousFailure, failure], "CLIENT_PROCESS_ERROR");
            if (pending) reject(failure);
          });
          currentChild.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
            handleExit(currentChild, code, signal);
            if (pending) reject(stopping && code === 0 && !lastFailure ? startupStopReason
              : new Error(`CLIENT_EXIT_BEFORE_SPAWN: ${code ?? signal ?? "unknown"}`));
          });
        });
      } catch (error) {
        if (error === startupStopReason && !lastFailure) throw error;
        raise(lastFailure ?? fail("CLIENT_SPAWN_FAILED", error, null));
      }
    },

    /** 有界等待初始化；主动停止与失败分开，不能把正常退出写成启动故障。 */
    async waitReady(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
      if (stopping && !lastFailure && state.status !== "failed") throw startupStopReason;
      if (state.status === "ready") return;
      if (!child || state.status !== "running") return raise(lastFailure ?? new Error(state.errorCode ?? "CLIENT_NOT_RUNNING"));
      const currentChild = child;
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error): void => {
            clearTimeout(timer);
            currentChild.removeListener("message", onMessage);
            currentChild.removeListener("exit", onExit);
            currentChild.removeListener("error", onError);
            error ? reject(error) : resolve();
          };
          const onMessage = (): void => {
            if (state.status === "ready") finish();
            else if (state.status === "failed") finish(lastFailure ?? new Error("CLIENT_HEALTH_FAILED"));
          };
          const onExit = (): void => finish(lastFailure ?? (stopping ? startupStopReason : new Error("CLIENT_EXIT_BEFORE_READY")));
          const onError = (error: Error): void => finish(error);
          const timer = setTimeout(() => finish(new Error("CLIENT_READY_TIMEOUT")), timeoutMs);
          currentChild.on("message", onMessage);
          currentChild.once("exit", onExit);
          currentChild.once("error", onError);
        });
      } catch (error) {
        if (error === startupStopReason && !lastFailure) throw error;
        raise(lastFailure ?? fail("CLIENT_READY_FAILED", error, currentChild.pid ?? null));
      }
    },

    /** 兼容现有调用入口，统一交给 IPC 清理。 */
    async stop(): Promise<void> {
      await this.drain();
    },

    /** 有界等待原 Client 关闭；退出与清理失败均显式交还调用方。 */
    async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
      stopping = true;
      const currentChild = child;
      const closed = childClosed;
      const pendingFailure = lastFailure;
      if (currentChild && state.status !== "failed") state = { ...state, status: "draining" };
      try {
        if (!currentChild) { if (pendingFailure) raise(pendingFailure); return; }
        await requestClientStop(currentChild, state.requestId!, timeoutMs, closed, () => child !== currentChild || childExited);
        if (lastFailure || pendingFailure) raise(lastFailure ?? pendingFailure!);
      } catch (error) {
        // drain 失败后 runtime 仍可能继续运行，后续真实退出不能继续按预期停止处理。
        stopping = false;
        const original = lastFailure ?? pendingFailure;
        const failure = original && !containsRuntimeFailure(error, original) ? new AggregateError([original, error], "CLIENT_DRAIN_FAILED") : error;
        if (!currentChild) return raise(failure);
        raise(fail(error instanceof Error ? error.message : "CLIENT_DRAIN_FAILED", failure, currentChild.pid ?? null));
      }
    },

    /** 返回状态和健康信息副本，避免界面改变进程事实。 */
    snapshot(): ClientRuntimeSnapshot {
      return { ...state, health: state.health ? { ...state.health } : null, ...(state.startup ? { startup: { ...state.startup } } : {}) };
    },
    /** 订阅可信 Client 的业务事件；正文规则由随资源更新的生产者与消费者拥有。 */
    onEvent(listener: (event: DesktopEvent) => void): () => void {
      eventListeners.add(listener);
      return () => { eventListeners.delete(listener); };
    },
    /** 更新停止与本机任务等待原业务预算；普通请求有超时，通道失联立即失败。 */
    async request(request: DesktopRuntimeRequest, timeoutMs?: number): Promise<DesktopApiResponse> {
      // npm 全局安装引擎可能持续数分钟，不能沿用普通业务的 30 秒超时。
      const effectiveTimeoutMs = timeoutMs ?? (request.method === "software.npm.install" ? 15 * 60_000 : 30_000);
      if (!child || state.status !== "ready") throw new Error("CLIENT_NOT_READY");
      const currentChild = child;
      const parentRequestId = state.requestId!;
      const id = crypto.randomUUID();
      try {
        return await new Promise<DesktopApiResponse>((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (error?: Error, response?: DesktopApiResponse): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            currentChild.removeListener("message", onMessage);
            currentChild.removeListener("exit", onExit);
            currentChild.removeListener("error", onError);
            currentChild.removeListener("disconnect", onDisconnect);
            error ? reject(error) : resolve(response!);
          };
          const onMessage = (input: unknown): void => {
            const message = input as Partial<DesktopApiResponseMessage> | null;
            if (message?.t !== "desktop.api.res" || message.requestId !== parentRequestId || message.id !== id) return;
            const response = message.response;
            if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || !("body" in response)) {
              finish(new Error("DESKTOP_API_RESPONSE_INVALID"));
              return;
            }
            finish(undefined, response);
          };
          const onExit = (): void => finish(new Error("DESKTOP_API_CLIENT_EXIT"));
          const onError = (error: Error): void => finish(error);
          const onDisconnect = (): void => finish(new Error("DESKTOP_API_CLIENT_DISCONNECTED"));
          if (request.method !== "runtime.update.interrupt" && request.method !== "runtime.update.cancel" && request.method !== "scheduledTasks.local.runNow") {
            timer = setTimeout(() => finish(new Error("DESKTOP_API_TIMEOUT")), effectiveTimeoutMs);
          }
          currentChild.on("message", onMessage);
          currentChild.once("exit", onExit);
          currentChild.once("error", onError);
          currentChild.once("disconnect", onDisconnect);
          try {
            currentChild.send({ t: "desktop.api.req", requestId: parentRequestId, id, request }, (error) => { if (error) finish(error); });
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
      } catch (error) {
        try {
          recordRuntimeError(errorLogPath, {
            errorCode: "DESKTOP_API_FAILED", requestId: id, releaseId: state.releaseId,
            pid: currentChild.pid ?? null, method: request?.method, rootCause: error instanceof Error ? error.message : String(error),
          });
        } catch (logError) {
          throw new AggregateError([error, logError], "DESKTOP_API_ERROR_LOG_FAILED");
        }
        throw error;
      }
    },
  };
}

/** 按异常身份检查既有聚合，合并清理主副因时不重复包入同一失败。 */
function containsRuntimeFailure(error: unknown, expected: Error, seen = new Set<unknown>()): boolean {
  if (error === expected) return true;
  if (seen.has(error)) return false;
  seen.add(error);
  return error instanceof AggregateError && error.errors.some(cause => containsRuntimeFailure(cause, expected, seen));
}

/** 仅校验稳定业务信封；宿主生命周期及父进程专用控制不能伪装成业务事件。 */
function assertDesktopEvent(input: unknown): DesktopEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("DESKTOP_EVENT_INVALID");
  const { t } = input as { t?: unknown };
  if (typeof t !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(t) || /^(?:desktop|runtime)[.:]/u.test(t)) {
    throw new Error("DESKTOP_EVENT_INVALID");
  }
  return input as DesktopEvent;
}

/** 只采集可检索的标识，不记录未知业务正文或凭据。 */
function eventDiagnosticContext(event?: DesktopEvent): Record<string, string | number> {
  if (!event) return {};
  const outer = event as unknown as Record<string, unknown>;
  const nested = outer.event && typeof outer.event === "object" && !Array.isArray(outer.event) ? outer.event as Record<string, unknown> : {};
  const result: Record<string, string | number> = { eventType: event.t };
  for (const key of ["workspaceId", "threadId", "instanceId", "terminalId"]) {
    const value = outer[key] ?? nested[key];
    if (typeof value === "string") result[key] = value;
  }
  if (Number.isSafeInteger(nested.seq)) result.eventSeq = nested.seq as number;
  return result;
}

/** 新资源的签名事实须匹配内置 Node；旧资源继续由原启动与真实健康门禁判断。 */
function assertClientRuntimeCompatibility(entry: string): void {
  const marker = path.resolve(path.dirname(entry), "..", "desktop-runtime.json");
  let bytes: Buffer;
  try { bytes = fs.readFileSync(marker); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || value.schemaVersion !== 1 || value.platform !== process.platform || value.arch !== process.arch
    || value.nodeMajor !== Number(process.versions.node.split(".")[0]) || value.modules !== process.versions.modules) {
    throw Object.assign(new Error("CLIENT_RUNTIME_INCOMPATIBLE"), { code: "CLIENT_RUNTIME_INCOMPATIBLE" });
  }
}

/** 严格核协议、版本和数据库；结构化短码供主进程脱敏后仍能追踪根因。 */
function assertClientHealth(input: unknown, expected?: ClientRuntimeExpectation): DesktopClientHealth {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("CLIENT_HEALTH_INVALID"), { code: "CLIENT_HEALTH_INVALID" });
  const health = input as Record<string, unknown>;
  if (health.protocolVersion !== 1) throw Object.assign(new Error("CLIENT_HEALTH_PROTOCOL_MISMATCH"), { code: "CLIENT_HEALTH_PROTOCOL_MISMATCH" });
  if (typeof health.clientVersion !== "string" || !health.clientVersion.trim()) throw Object.assign(new Error("CLIENT_HEALTH_VERSION_REQUIRED"), { code: "CLIENT_HEALTH_VERSION_REQUIRED" });
  if (health.database !== "ready" || !Number.isSafeInteger(health.dbSchemaVersion) || (health.dbSchemaVersion as number) <= 0) {
    throw Object.assign(new Error("CLIENT_HEALTH_DATABASE_NOT_READY"), { code: "CLIENT_HEALTH_DATABASE_NOT_READY" });
  }
  if (expected && health.clientVersion !== expected.clientVersion) {
    throw Object.assign(new Error(`CLIENT_HEALTH_VERSION_MISMATCH: expected=${expected.clientVersion}, actual=${health.clientVersion}`), { code: "CLIENT_HEALTH_VERSION_MISMATCH" });
  }
  if (expected && health.dbSchemaVersion !== expected.dbSchemaVersion) {
    throw Object.assign(new Error(`CLIENT_HEALTH_DB_SCHEMA_MISMATCH: expected=${expected.dbSchemaVersion}, actual=${health.dbSchemaVersion}`), { code: "CLIENT_HEALTH_DB_SCHEMA_MISMATCH" });
  }
  return { protocolVersion: 1, clientVersion: health.clientVersion, dbSchemaVersion: health.dbSchemaVersion as number, database: "ready" };
}

/** 已退出只等同owner的close；发送失败或有界等待失败仍保留资源归属。 */
function requestClientStop(child: ClientChild, requestId: string, timeoutMs: number, closed: Promise<void>, hasExited: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("CLIENT_DRAIN_TIMEOUT")), timeoutMs);
    void closed.then(() => finish());
    if (hasExited()) return;
    try {
      child.send({ t: "desktop.shutdown", requestId }, (error) => { if (error) finish(error); });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error), { cause: error }));
    }
  });
}

/** 使用当前可执行文件的 Node 模式拉起内置 Client。 */
function defaultSpawn(file: string, args: string[], options: SpawnOptions): ClientChild {
  return spawnProcess(file, args, options) as ClientChild;
}

/** 在子进程错误边界同步落结构化记录，日志失败直接抛出组合错误。 */
function recordRuntimeError(filePath: string, record: {
  errorCode: string;
  requestId: string | null;
  releaseId: string | null;
  pid: number | null;
  rootCause: string | Record<string, unknown>;
  method?: string;
  eventSeq?: number;
  workspaceId?: string;
  threadId?: string;
  terminalId?: string | null;
}): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch (error) {
    throw new AggregateError([error], "CLIENT_RUNTIME_ERROR_LOG_FAILED");
  }
}
