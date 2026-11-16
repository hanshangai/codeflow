import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  ENGINE_MODEL_PROVIDERS,
  toEngineModelInfoFromCustomModel,
  getEngineProviderLabel,
  type EngineCredentialSource,
  type EngineCredentialStatus,
  type EngineCliDetectionStatus,
  type EngineModelInfo,
  type EngineModelProviderId,
  type EngineProviderCredentialStatus,
  type EngineStatus,
  type EngineType,
} from "@codeflowai/shared";

import { readClaudeNativeAuthState, readCodexNativeAuthState, type NativeEngineAuthState } from "../../enginesConfig.js";
import { resolveClaudeCli } from "../../engines/claude/claudeCli.js";
import { resolveCliDisplayPath } from "../../engines/cliDisplayPath.js";
import { resolveCodexCli } from "../../engines/codex-app-server/codexAppServerCli.js";
import { getRuntimeEngineModels } from "../../engines/engineModelCatalogRuntime.js";
import { logger } from "../../logger.js";
import { buildClientChildProcessEnv } from "../../runtime/clientProcessEnv.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";

const WINDOWS_NATIVE_TEXT_DECODER = new TextDecoder("gb18030");
const CLI_DETECT_TIMEOUT_MS = 8_000;
const CLI_DETECT_CACHE_TTL_MS = 20_000;
const CLI_TERMINATION_TIMEOUT_MS = 2_000;

type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export type CliDetectionResult = {
  installed: boolean;
  version: string | null;
  binPath: string | null;
  error: string | null;
  detectionStatus: EngineCliDetectionStatus;
  durationMs: number;
};

export type EngineCliDetections = {
  claude: CliDetectionResult;
  codex: CliDetectionResult;
};

/** 控制 CLI 探测缓存复用策略。 */
export type EngineCliDetectionLoadOptions = {
  forceRefresh?: boolean;
};

const loadEngineCliDetections = createEngineCliDetectionLoader(detectEngineClis, {
  ttlMs: CLI_DETECT_CACHE_TTL_MS,
});

/** 创建进程级 CLI 探测 singleflight，并短暂复用正常结算值（含显式失败状态）。 */
export function createEngineCliDetectionLoader<T>(
  detect: () => Promise<T>,
  opts: { ttlMs: number; now?: () => number },
): (options?: EngineCliDetectionLoadOptions) => Promise<T> {
  const parsedTtlMs = Math.floor(Number(opts.ttlMs));
  const ttlMs = Number.isFinite(parsedTtlMs) ? Math.max(0, parsedTtlMs) : 0;
  const now = opts.now ?? Date.now;
  let cached: { value: T; expiresAt: number } | null = null;
  let inFlight: Promise<T> | null = null;
  let generation = 0;

  return (options?: EngineCliDetectionLoadOptions): Promise<T> => {
    const forceRefresh = Boolean(options?.forceRefresh);
    const currentTime = now();
    if (!forceRefresh && cached && currentTime < cached.expiresAt) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;

    const requestGeneration = ++generation;
    const pending = Promise.resolve()
      .then(detect)
      .then((value) => {
        if (requestGeneration === generation) {
          cached = { value, expiresAt: now() + ttlMs };
        }
        return value;
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  };
}

/** 探测执行端安装与凭据状态；仅可信本机上下文直接返回本地有效模型目录。 */
export async function handleEnginesStatus(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  /** 探测进程期间释放数据库许可，只为目录与凭据快照持短段。 */
  const database = async <T>(run: () => T): Promise<T> => ctx.withDatabase ? ctx.withDatabase(req.id, run) : run();
  const [customClaudeModels, customCodexModels] = await database(() => [ctx.localWorkspaceOnly ? getRuntimeEngineModels("claude")
    : ctx.db.engineCustomModels.listEnabledByEngine("claude").map(toEngineModelInfoFromCustomModel),
    ctx.localWorkspaceOnly ? getRuntimeEngineModels("codex")
    : ctx.db.engineCustomModels.listEnabledByEngine("codex").map(toEngineModelInfoFromCustomModel)]);
  const [claude, codex] = await Promise.all([
    buildClaudeStatus(customClaudeModels),
    buildCodexStatus(customCodexModels),
  ]);
  await database(() => { for (const [status, engine] of [[claude, 'claude'], [codex, 'codex']] as const) {
    const native = mergeNativeAuthWithProcessEnv(engine, engine === 'claude' ? readClaudeNativeAuthState() : readCodexNativeAuthState());
    const keys = ctx.db.engineKeys.list().filter(key => key.engine === engine);
    const blocked = Object.values(ENGINE_MODEL_PROVIDERS).filter(provider => {
      if (!provider.engines.includes(engine)) return false;
      if (ctx.builtInRelayCredentials) return ctx.builtInRelayCredentials.isScopeBlocked(engine, provider.providerId);
      const active = keys.find(key => key.providerId === provider.providerId && key.isActive);
      return active ? active.source !== 'user_configured' : ctx.db.engineKeys.isNativeFallbackBlocked(engine, provider.providerId) || keys.some(key => key.providerId === provider.providerId && key.source !== 'user_configured');
    }).map(provider => provider.providerId);
    status.providerCredentialStatus = resolveProviderCredentialStatuses(engine, listActiveProviderIds(ctx, engine), engine === 'codex' ? 'openai' : 'anthropic', native, blocked);
    status.credentialStatus = resolveEngineCredentialStatus(engine, status.providerCredentialStatus);
  } });
  logEngineDetectionFailure(req.id, claude);
  logEngineDetectionFailure(req.id, codex);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, engines: [claude, codex] } });
}

export async function buildClaudeStatus(
  models: EngineModelInfo[] = [],
  providerCredentialStatus?: EngineProviderCredentialStatus[],
  options?: EngineCliDetectionLoadOptions,
): Promise<EngineStatus> {
  const detected = (await loadEngineCliDetections(options)).claude;
  const supported = detected.installed;

  return {
    engineType: "claude",
    installed: detected.installed,
    version: detected.version,
    binPath: detected.binPath,
    features: {
      streaming: supported,
      reasoning: supported,
      toolUse: supported,
      imageInput: supported,
      sessionContinuation: supported,
    },
    // 目录由调用边界选择：可信本机使用有效目录，远程仍由 Server 补充。
    models,
    detectionStatus: detected.detectionStatus,
    detectionDurationMs: detected.durationMs,
    credentialStatus: providerCredentialStatus ? resolveEngineCredentialStatus("claude", providerCredentialStatus) : undefined,
    providerCredentialStatus,
    error: detected.error,
  };
}

export async function buildCodexStatus(
  models: EngineModelInfo[] = [],
  providerCredentialStatus?: EngineProviderCredentialStatus[],
  options?: EngineCliDetectionLoadOptions,
): Promise<EngineStatus> {
  const detected = (await loadEngineCliDetections(options)).codex;
  const supported = detected.installed;

  return {
    engineType: "codex",
    installed: detected.installed,
    version: detected.version,
    binPath: detected.binPath,
    features: {
      streaming: supported,
      reasoning: supported,
      toolUse: supported,
      imageInput: supported,
      sessionContinuation: supported,
    },
    // 目录由调用边界选择：可信本机使用有效目录，远程仍由 Server 补充。
    models,
    detectionStatus: detected.detectionStatus,
    detectionDurationMs: detected.durationMs,
    credentialStatus: providerCredentialStatus ? resolveEngineCredentialStatus("codex", providerCredentialStatus) : undefined,
    providerCredentialStatus,
    error: detected.error,
  };
}

/** 读取指定引擎已启用 Key 覆盖的 provider，供模型过滤使用。 */
function listActiveProviderIds(ctx: ApiHandlerContext, engine: EngineType): EngineModelProviderId[] {
  const ids = new Set<EngineModelProviderId>();
  for (const key of ctx.db.engineKeys.list()) {
    if (key.engine !== engine || !key.isActive) continue;
    if (key.source === 'unknown') continue;
    if (key.source === 'builtin' && !ctx.builtInRelayCredentials?.isAvailable(key)) continue;
    ids.add(key.providerId);
  }
  return [...ids];
}

/** 文件原生凭据优先；文件不可用时把 Client 进程环境变量作为本地 API Key 来源。 */
export function mergeNativeAuthWithProcessEnv(
  engine: EngineType,
  native: NativeEngineAuthState,
  env: NodeJS.ProcessEnv = process.env,
): NativeEngineAuthState {
  if (native.available) return native;
  const keyNames = engine === "claude" ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] : ["OPENAI_API_KEY"];
  const available = keyNames.some((name) => Boolean(String(env[name] ?? "").trim()));
  return available ? { available: true, source: "local_api_key", issue: null } : native;
}

/** 汇总每个 provider 的可执行凭据来源：CodeFlow active Key + 本机原生凭据。 */
function resolveProviderCredentialStatuses(
  engine: EngineType,
  activeProviderIds: EngineModelProviderId[],
  nativeProviderId: EngineModelProviderId,
  nativeAuth: NativeEngineAuthState,
  blockedProviderIds: EngineModelProviderId[] = [],
): EngineProviderCredentialStatus[] {
  return Object.values(ENGINE_MODEL_PROVIDERS)
    .filter((provider) => provider.engines.includes(engine))
    .map((provider) => {
      if (blockedProviderIds.includes(provider.providerId)) return { providerId: provider.providerId, available: false, sources: [], message: '内置中转凭据不可用，请重新关联账号并重验' };
      const sources: EngineCredentialSource[] = [];
      if (activeProviderIds.includes(provider.providerId)) sources.push("codeflow_key");
      if (provider.providerId === nativeProviderId && nativeAuth.available) sources.push(nativeAuth.source);
      return {
        providerId: provider.providerId,
        available: sources.length > 0,
        sources,
        message: sources.length > 0 ? null : resolveProviderCredentialIssue(engine, provider.providerId, nativeProviderId, nativeAuth),
      };
    });
}

/** 汇总兼容旧 Web 的引擎级凭据状态；新 Web 使用 providerCredentialStatus。 */
function resolveEngineCredentialStatus(engine: EngineType, statuses: EngineProviderCredentialStatus[]): EngineCredentialStatus {
  const available = statuses.find((status) => status.available);
  if (available) {
    return { available: true, source: available.sources[0] ?? "codeflow_key", message: null };
  }
  const nativeProviderId = engine === "codex" ? "openai" : "anthropic";
  const nativeIssue = statuses.find((status) => status.providerId === nativeProviderId)?.message ?? null;
  return {
    available: false,
    source: "none",
    message: nativeIssue ?? `${engine === "codex" ? "Codex" : "Claude"} 未启用：未检测到已启用的 provider Key 或本机原生登录`,
  };
}

/** 生成 provider 不可用提示，优先保留本机凭据读取失败原因。 */
function resolveProviderCredentialIssue(
  engine: EngineType,
  providerId: EngineModelProviderId,
  nativeProviderId: EngineModelProviderId,
  nativeAuth: NativeEngineAuthState,
): string {
  const providerLabel = getEngineProviderLabel(providerId);
  if (providerId !== nativeProviderId) return `未检测到已启用的 ${providerLabel} Key`;
  if (nativeAuth.issue) return `本机 ${engine === "codex" ? "Codex" : "Claude"} 原生登录不可用：${nativeAuth.issue}`;
  return `未检测到已启用的 ${providerLabel} Key 或本机 ${engine === "codex" ? "Codex" : "Claude"} 原生登录`;
}

/** 探测 CLI 是否可运行；慢启动时给足超时，避免把已安装误判为缺失。 */
async function detectCli(opts: {
  command: string;
  argsPrefix: string[];
  versionArgs: string[];
}): Promise<CliDetectionResult> {
  const binPath = resolveCliDisplayPath(opts);
  const startedAt = Date.now();
  const { ok, stdout, error, failureKind } = await runCli({
    command: opts.command,
    args: [...opts.argsPrefix, ...opts.versionArgs],
    timeoutMs: CLI_DETECT_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;
  if (!ok) {
    return {
      installed: false,
      version: null,
      binPath,
      error,
      detectionStatus: failureKind === "timeout" ? "timeout" : "unavailable",
      durationMs,
    };
  }
  return {
    installed: true,
    version: stdout || null,
    binPath,
    error: null,
    detectionStatus: "available",
    durationMs,
  };
}

/** 把解析/探测异常收敛为含稳定错误码的文本，未知异常保留原文。 */
function describeDetectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code && !message.includes(code)) return `${code}: ${message}`;
  return message;
}

/**
 * 单引擎探测：resolver 与进程探测都限制在各自 try/catch 内。
 * 某个引擎的私有 runtime.json 非法时只标记该引擎 unavailable，
 * 不能连带拒绝另一个引擎或其他检测请求。
 */
async function detectSingleEngineCli(engine: EngineType): Promise<CliDetectionResult> {
  const startedAt = Date.now();
  try {
    const resolved = engine === "claude" ? resolveClaudeCli() : resolveCodexCli();
    return await detectCli({
      command: resolved.command,
      argsPrefix: resolved.argsPrefix,
      versionArgs: ["--version"],
    });
  } catch (error) {
    return {
      installed: false,
      version: null,
      binPath: null,
      error: describeDetectionError(error),
      detectionStatus: "unavailable",
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

/** 并行探测 Claude/Codex；每个引擎独立结算，失败只影响自身。 */
export async function detectEngineClis(): Promise<EngineCliDetections> {
  const [claude, codex] = await Promise.all([
    detectSingleEngineCli("claude"),
    detectSingleEngineCli("codex"),
  ]);
  return { claude, codex };
}

export type CliRunFailureKind = "timeout" | "spawn_error" | "nonzero_exit";

export type CliRunResult = {
  ok: boolean;
  stdout: string;
  error: string | null;
  failureKind: CliRunFailureKind | null;
};

/** 按实际命令隔离进程环境；CLI 失败返回结构化类别和 error 文本。 */
export async function runCli(opts: {
  command: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shell?: boolean;
  spawnProcess?: typeof spawn;
  killProcess?: KillProcess;
}): Promise<CliRunResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timeoutStarted = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: CliRunResult) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    let child;
    try {
      // 裸命令名（npm、claude 等）走 shell 以解析 .cmd shim 和 nvm shim；
      // 已解析为完整路径的（如 D:\Program Files\nodejs\node.exe）不走 shell，避免空格截断。
      // Node.js 22+ (DEP0190) 禁止 shell=true 时传 args 数组，因此走 shell 时将命令拼为单字符串。
      // env 仅作用于本次子进程，避免污染用户全局 npm 配置。
      const platform = opts.platform ?? process.platform;
      const spawnProcess = opts.spawnProcess ?? spawn;
      const isBareCommand = !opts.command.includes(path.sep) && !opts.command.includes("/");
      const spawnEnv = buildClientChildProcessEnv(opts.env ? { ...process.env, ...opts.env } : process.env, opts.command);
       if (isBareCommand && opts.shell !== false) {
        const shellCmd = [opts.command, ...opts.args].join(" ");
        child = spawnProcess(shellCmd, [], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: true,
          detached: platform !== "win32",
          env: spawnEnv,
        });
      } else {
        child = spawnProcess(opts.command, opts.args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: platform !== "win32",
          env: spawnEnv,
        });
      }
    } catch (e) {
      finish({ ok: false, stdout: "", error: e instanceof Error ? e.message : String(e), failureKind: "spawn_error" });
      return;
    }

    timeout = setTimeout(() => {
      if (done) return;
      timeoutStarted = true;
      const timeoutError = formatCliFailure("timeout", stdout, stderr);
      void terminateCliProcessTree(child, {
        platform: opts.platform,
        killProcess: opts.killProcess,
      }).then((terminationError) => {
        finish({
          ok: false,
          stdout: stdout.trim(),
          error: terminationError
            ? `${timeoutError}; process tree termination failure: ${terminationError}`
            : timeoutError,
          failureKind: "timeout",
        });
      }, (error) => {
        finish({
          ok: false,
          stdout: stdout.trim(),
          error: `${timeoutError}; process tree termination failure: ${error instanceof Error ? error.message : String(error)}`,
          failureKind: "timeout",
        });
      });
    }, Math.max(200, opts.timeoutMs));
    timeout.unref?.();

    child.stdout.on("data", (buf) => (stdout += decodeCliOutput(buf)));
    child.stderr.on("data", (buf) => (stderr += decodeCliOutput(buf)));

    child.on("error", (e) => {
      if (timeoutStarted) return;
      finish({
        ok: false,
        stdout: stdout.trim(),
        error: e instanceof Error ? e.message : String(e),
        failureKind: "spawn_error",
      });
    });

    child.on("close", (code) => {
      if (timeoutStarted) return;
      if (code === 0) finish({ ok: true, stdout: stdout.trim(), error: null, failureKind: null });
      else {
        finish({
          ok: false,
          stdout: stdout.trim(),
          error: formatCliFailure(`exit code=${code}`, stdout, stderr),
          failureKind: "nonzero_exit",
        });
      }
    });
  });
}

export type CliProcessTerminationOptions = {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  killProcess?: KillProcess;
  timeoutMs?: number;
  /** 更新要求进程树终止成功且观察到目标 close；不沿用 CLI 探测的退出竞态宽容。 */
  strictTreeConfirmation?: boolean;
  /** 严格停止失败时将原异常交资源 owner 保存；不改变失败结果或默认 CLI 合同。 */
  onFailure?: (cause: unknown) => void;
};

/** 有界终止 CLI 探测进程；目标已退出时按成功处理，避免探测结果被回收竞态误判。 */
export async function terminateCliProcessTree(
  child: ChildProcess,
  options: CliProcessTerminationOptions = {},
): Promise<string | null> {
  const timeoutMs = normalizeCliTerminationTimeout(options.timeoutMs);
  const platform = options.platform ?? process.platform;
  if (options.strictTreeConfirmation) return await terminateConfirmedProcessTree(child, options, timeoutMs, platform);
  if (platform !== "win32") {
    if (childHasExited(child)) return null;
    const pid = Number(child.pid ?? 0);
    if (!Number.isSafeInteger(pid) || pid <= 0) return "child PID is unavailable";
    const killProcess = options.killProcess ?? process.kill;
    try {
      const killed = killProcess(-pid, "SIGKILL");
      if (killed === false && !childHasExited(child)) {
        return await waitForChildExit(child, timeoutMs)
          ? null
          : "process.kill(-pid, SIGKILL) returned false";
      }
      return await waitForChildExit(child, timeoutMs)
        ? null
        : `process group termination did not confirm process exit within ${timeoutMs}ms: pid=${pid}`;
    } catch (error) {
      if (childHasExited(child) || await waitForChildExit(child, timeoutMs)) return null;
      return error instanceof Error ? error.message : String(error);
    }
  }

  if (childHasExited(child)) return null;
  const pid = Number(child.pid ?? 0);
  if (!Number.isSafeInteger(pid) || pid <= 0) return "child PID is unavailable";
  const spawnProcess = options.spawnProcess ?? spawn;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandling = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settle = (error: string | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(error);
    };

    let taskkill;
    try {
      taskkill = spawnProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle(`taskkill spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    timeout = setTimeout(() => {
      timeoutHandling = true;
      let stopError = "";
      try {
        if (!taskkill.kill()) stopError = "; taskkill stop returned false";
      } catch (error) {
        stopError = `; taskkill stop failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      void Promise.all([
        waitForProcessLifecycle(taskkill, 250),
        waitForChildExit(child, 250),
      ]).then(([taskkillExited, childExited]) => {
        if (taskkillExited && childExited) {
          settle(null);
          return;
        }
        const helperLifecycle = taskkillExited ? "confirmed" : "unconfirmed";
        settle(
          `taskkill timed out after ${timeoutMs}ms; process tree termination is unconfirmed: pid=${pid}; `
          + `taskkillHelperLifecycle=${helperLifecycle}${stopError}`,
        );
      });
    }, timeoutMs);
    timeout.unref?.();
    taskkill.stdout?.on("data", (buf) => (stdout += decodeCliOutput(buf)));
    taskkill.stderr?.on("data", (buf) => (stderr += decodeCliOutput(buf)));
    taskkill.on("error", (error) => {
      if (timeoutHandling) return;
      settle(childHasExited(child)
        ? null
        : `taskkill spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    taskkill.on("close", (code) => {
      if (timeoutHandling) return;
      void (async () => {
        if (code === 0) {
          settle(null);
          return;
        }
        const childExited = await waitForChildExit(child, 250);
        if (childExited) {
          settle(null);
          return;
        }
        const detail = stderr.trim() || stdout.trim() || `taskkill exit code=${code}`;
        settle(detail);
      })();
    });
  });
}

/** 严格回收独立进程树；任何辅助进程失败都不能被根进程退出覆盖。 */
function terminateConfirmedProcessTree(child: ChildProcess, options: CliProcessTerminationOptions, timeoutMs: number, platform: NodeJS.Platform): Promise<string | null> {
  if (childHasExited(child)) return Promise.resolve("process tree termination is unconfirmed: root already exited");
  const pid = Number(child.pid ?? 0);
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve("child PID is unavailable");
  return new Promise(resolve => {
    let settled = false, closed = false, treeConfirmed = false, timeoutHandling = false;
    let helper: ChildProcess | undefined;
    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(error);
    };
    const onClose = (): void => { closed = true; if (treeConfirmed && !timeoutHandling) finish(null); };
    child.once("close", onClose);
    const timer = setTimeout(() => {
      timeoutHandling = true;
      if (!helper) { finish("process group termination close timed out"); return; }
      let stopError = "";
      try { if (!helper.kill()) stopError = "; helper stop returned false"; }
      catch (error) { options.onFailure?.(error); stopError = "; helper stop failed"; }
      void waitForProcessLifecycle(helper, 250).then(exited => finish(
        `taskkill timed out after ${timeoutMs}ms; taskkillHelperLifecycle=${exited ? "confirmed" : "unconfirmed"}${stopError}`,
      ));
    }, timeoutMs);
    timer.unref?.();
    if (platform !== "win32") {
      try {
        if ((options.killProcess ?? process.kill)(-pid, "SIGKILL") === false) { finish("process group stop returned false"); return; }
        treeConfirmed = true;
        if (closed) finish(null);
      } catch (error) { options.onFailure?.(error); finish("process group stop failed"); }
      return;
    }
    try {
      helper = (options.spawnProcess ?? spawn)("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) { options.onFailure?.(error); finish("taskkill spawn failed"); return; }
    helper.stdout?.resume();
    helper.stderr?.resume();
    helper.once("error", error => { options.onFailure?.(error); if (!timeoutHandling) finish("taskkill spawn failed"); });
    helper.once("close", code => {
      if (timeoutHandling) return;
      if (code !== 0) { finish(`taskkill exit code=${code ?? "unknown"}`); return; }
      treeConfirmed = true;
      if (closed) finish(null);
    });
  });
}

/** 等待辅助进程退出或产生启动错误，防止超时回收留下无法确认的 taskkill。 */
function waitForProcessLifecycle(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve(exited || childHasExited(child));
    };
    const onExit = (): void => finish(true);
    const onClose = (): void => finish(true);
    const onError = (): void => finish(true);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

/** 等待 Node 观察到目标进程退出；超时返回 false，避免终止流程无限等待。 */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    timeout.unref?.();
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      resolve(exited || childHasExited(child));
    };
    const onExit = (): void => finish(true);
    const onClose = (): void => finish(true);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/** 将 CLI 探测回收超时限制在 100ms~10s，避免辅助进程无限等待。 */
function normalizeCliTerminationTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return CLI_TERMINATION_TIMEOUT_MS;
  return Math.max(100, Math.min(10_000, Math.floor(value)));
}

/** 判断 CLI 根进程是否已由操作系统结算，避免超时与自然退出重复处理。 */
function childHasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/** 记录失败探测的关联标识和耗时，不写入命令参数或凭据。 */
function logEngineDetectionFailure(requestId: string, status: EngineStatus): void {
  if (status.detectionStatus === "available") return;
  logger.warn("engine-status", "CLI status probe failed", {
    requestId,
    engineType: status.engineType,
    detectionStatus: status.detectionStatus ?? "unavailable",
    durationMs: status.detectionDurationMs ?? null,
    error: normalizeCliFailureForLog(status.error),
  });
}

/** 压缩 CLI 失败摘要，避免原始 stderr 形成无界日志。 */
function normalizeCliFailureForLog(error: string | null): string | null {
  const normalized = String(error ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

/** 失败时优先返回 stderr，其次 stdout，最后返回退出原因。 */
function formatCliFailure(fallback: string, stdout: string, stderr: string): string {
  return stderr.trim() || stdout.trim() || fallback;
}

/** 解码子进程输出；Windows 936/GBK 代码页输出在 UTF-8 下会乱码，需兜底 GB18030。 */
function decodeCliOutput(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (process.platform !== "win32" || !utf8.includes("\uFFFD")) return utf8;
  return WINDOWS_NATIVE_TEXT_DECODER.decode(buf);
}

