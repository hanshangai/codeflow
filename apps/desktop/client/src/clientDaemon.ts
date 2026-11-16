import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { formatClientCommonCommands, parseClientCliArgs, toDaemonChildArgs, type ClientCliCommand } from "./cliArgs.js";
import { cleanupClientLogRetention, logger, resolveClientLogDir, resolveDatedClientDaemonLogPath } from "./logger.js";
import { CLIENT_PROCESS_EXIT_CODE_BLOCKED } from "./processExitCodes.js";
import {
  buildClientChildProcessEnv,
  DAEMON_CHILD_ENV,
  DAEMON_SUPERVISOR_ENV,
  DAEMON_SUPERVISOR_PID_ENV,
  DAEMON_SUPERVISOR_TOKEN_ENV,
  DAEMON_WORKER_ENTRY_ENV,
  RESTART_PARENT_PID_ENV,
} from "./runtime/clientProcessEnv.js";
import { readSelfVersion } from "./version.js";
import {
  CLIENT_STARTUP_MESSAGES, formatClientStartupProgress, isClientServerConnected,
  parseClientStartupSnapshot, redactClientStartupText, safeClientServerUrl,
  type ClientStartupSnapshot, type ClientStartupStage,
} from "./startup/clientStartupStatus.js";

const STARTUP_EXIT_WINDOW_MS = 1500;
const SUPERVISOR_STARTUP_EXIT_WINDOW_MS = STARTUP_EXIT_WINDOW_MS + 250;
const STOP_TIMEOUT_MS = 5000;
const WORKER_STATUS_RESPONSE_TIMEOUT_MS = 5_000;
const DAEMON_STOP_RESPONSE_TIMEOUT_MS = 1_500;
const SUPERVISOR_READY_TIMEOUT_MS = DAEMON_STOP_RESPONSE_TIMEOUT_MS + STOP_TIMEOUT_MS + 2000;
const RESTART_PARENT_WAIT_TIMEOUT_MS = 10_000;
const STABLE_CLIENT_UPTIME_MS = 60_000;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_CRASHES_PER_WINDOW = 5;
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
const BLOCKED_RESTART_DELAY_MS = 60_000;
const STARTUP_FAILURE_COOLDOWN_MS = 30_000;
const CRASH_LOOP_COOLDOWN_MS = 5 * 60_000;
const INITIAL_CONNECTION_WAIT_DEFAULT_MS = 90_000;
const DAEMON_JSON_RENAME_RETRY_DELAYS_MS = [5, 15, 50, 100, 250] as const;
export const CLIENT_DAEMON_SUPERVISOR_ALREADY_RUNNING_EXIT_CODE = 21;

type ClientDaemonCommand = Extract<ClientCliCommand, { kind: "daemon" }>;

type DaemonStateCommon = {
  pid: number;
  startedAt: string;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
};

type LegacyDaemonState = DaemonStateCommon & {
  schemaVersion: 1;
  supervisorPid: null;
  clientPid: number;
};

type SupervisedDaemonState = DaemonStateCommon & {
  schemaVersion: 2;
  supervisorPid: number;
  supervisorToken: string | null;
  clientPid: number | null;
  clientStartedAt: string | null;
  restartCount: number;
  status: "starting" | "running" | "restarting" | "blocked" | "cooldown" | "failed";
  nextRetryAt: string | null;
  initialConnection: "pending" | "succeeded" | "failed" | null;
  startup?: ClientStartupSnapshot | null;
  lastExit: DaemonExitSnapshot | null;
};

type DaemonState = LegacyDaemonState | SupervisedDaemonState;

type DaemonExitSnapshot = {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
  uptimeMs: number;
  error: string | null;
};

type DaemonControl = {
  action: "stop" | "restart";
  supervisorPid: number;
  supervisorToken: string | null;
  clientPid: number | null;
  requestedAt: string;
};

type DaemonSupervisorLockPayload = {
  token: string;
  pid: number;
  startedAt: string;
};

type DaemonSupervisorStopMode = "graceful" | "force";

type DaemonSupervisorLock = {
  token: string;
  setStopHandler: (handler: ((mode: DaemonSupervisorStopMode) => void) | null) => void;
  release: () => Promise<void>;
};

type DaemonLifecycleEndpoint =
  | { kind: "ipc"; path: string }
  | { kind: "tcp"; host: string; port: number };

let currentDaemonWorkerEndpointServer: net.Server | null = null;
let currentClientStartup: ClientStartupSnapshot | null = null;
const currentClientStartupBeganAt = Date.now();

/** 同一 worker 发布安全的阶段快照；后台父命令读取它，前台模式直接展示。 */
export function markCurrentClientDaemonStartup(stage: ClientStartupStage, context: { clientId?: string; serverUrl?: string } = {}): void {
  currentClientStartup = {
    stage, updatedAt: new Date().toISOString(),
    clientId: context.clientId ? redactClientStartupText(context.clientId).slice(0, 200) : currentClientStartup?.clientId ?? null,
    serverUrl: context.serverUrl ? safeClientServerUrl(context.serverUrl) : currentClientStartup?.serverUrl ?? null,
  };
  const supervisorPid = readDaemonSupervisorPidFromEnv();
  const supervisorToken = readDaemonSupervisorTokenFromEnv();
  if (supervisorPid && supervisorToken) {
    const paths = resolveDaemonPaths();
    const state = readDaemonState(paths.statePath);
    if (state?.schemaVersion === 2 && state.supervisorPid === supervisorPid
      && state.supervisorToken === supervisorToken && state.clientPid === process.pid) {
      writeOwnedSupervisedDaemonState(paths.statePath, { ...state, startup: currentClientStartup });
    }
  }
  if (stage !== "ready") console.log(formatClientStartupProgress(stage, Date.now() - currentClientStartupBeganAt));
}

export type ClientDaemonExitAction =
  | { kind: "stop"; reason: "requested" | "clean_exit" }
  | { kind: "restart"; reason: "requested" | "crash" | "blocked" | "startup_exit" | "crash_loop"; delayMs: number };

/** 判断当前进程是否是 daemon 父进程拉起的真实 client。 */
export function isClientDaemonChild(): boolean {
  return String(process.env[DAEMON_CHILD_ENV] ?? "").trim() === "1";
}

/** 判断当前入口是否承担 daemon supervisor 角色。 */
export function isClientDaemonSupervisor(): boolean {
  return String(process.env[DAEMON_SUPERVISOR_ENV] ?? "").trim() === "1";
}

/** 重启复用当前可执行文件的 Node 模式，并等待旧进程退出后再获取 DB lock。 */
export function buildClientRestartEnv(baseEnv: NodeJS.ProcessEnv = process.env, parentPid = process.pid): NodeJS.ProcessEnv {
  const normalizedParentPid = Number.isFinite(parentPid) ? Math.max(0, Math.trunc(parentPid)) : 0;
  const env = buildClientChildProcessEnv(baseEnv, process.execPath);
  env[RESTART_PARENT_PID_ENV] = String(normalizedParentPid);
  return env;
}

/** 若当前进程由重启器拉起，先等待旧进程退出。 */
export async function waitForClientRestartParentExit(timeoutMs = RESTART_PARENT_WAIT_TIMEOUT_MS): Promise<void> {
  const rawPid = String(process.env[RESTART_PARENT_PID_ENV] ?? "").trim();
  delete process.env[RESTART_PARENT_PID_ENV];
  const parentPid = Number(rawPid);
  if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid === process.pid) return;

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessRunning(parentPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** daemon 子进程启动后刷新状态文件，修复升级/替换进程绕过 daemon 父进程写状态的问题。 */
export async function refreshCurrentClientDaemonState(): Promise<DaemonState> {
  const paths = resolveDaemonPaths();
  fs.mkdirSync(paths.logDir, { recursive: true });
  const supervisorPid = readDaemonSupervisorPidFromEnv();
  if (supervisorPid) {
    const supervisorToken = readDaemonSupervisorTokenFromEnv();
    const current = readDaemonState(paths.statePath);
    if (
      !current
      || current.schemaVersion !== 2
      || current.supervisorPid !== supervisorPid
      || current.supervisorToken !== supervisorToken
    ) {
      throw new Error(`CodeFlow client supervisor 状态不一致：supervisorPid=${supervisorPid}, clientPid=${process.pid}`);
    }
    if (supervisorToken) {
      await holdCurrentDaemonWorkerEndpoint(paths.supervisorLockPath, supervisorToken, process.pid);
    }
    const state: SupervisedDaemonState = {
      ...current,
      clientPid: process.pid,
      clientStartedAt: new Date().toISOString(),
      status: "running",
      nextRetryAt: null,
      startup: currentClientStartup,
    };
    writeOwnedSupervisedDaemonState(paths.statePath, state);
    return state;
  }

  const state = buildLegacyDaemonState(process.pid, paths);
  writeDaemonState(paths.statePath, state);
  return state;
}

/** 由当前 worker 在首次握手结果确定后更新 supervisor 状态，且只允许同一 owner/client 写入。 */
export function markCurrentClientDaemonInitialConnection(outcome: "succeeded" | "failed"): void {
  const supervisorPid = readDaemonSupervisorPidFromEnv();
  const supervisorToken = readDaemonSupervisorTokenFromEnv();
  if (!supervisorPid || !supervisorToken) return;
  const paths = resolveDaemonPaths();
  const state = readDaemonState(paths.statePath);
  if (
    !state
    || state.schemaVersion !== 2
    || state.supervisorPid !== supervisorPid
    || state.supervisorToken !== supervisorToken
    || state.clientPid !== process.pid
  ) return;
  writeOwnedSupervisedDaemonState(paths.statePath, {
    ...state,
    initialConnection: outcome,
  });
}

/** 请求 daemon-managed Client 替换；supervisor 模式下只记录重启意图。 */
export function spawnClientDaemonReplacementFromCurrentProcess(): DaemonState {
  const paths = resolveDaemonPaths();
  fs.mkdirSync(paths.logDir, { recursive: true });

  const supervisorPid = readDaemonSupervisorPidFromEnv();
  if (supervisorPid) {
    const supervisorToken = readDaemonSupervisorTokenFromEnv();
    const state = readDaemonState(paths.statePath);
    if (
      !state
      || state.schemaVersion !== 2
      || state.supervisorPid !== supervisorPid
      || state.supervisorToken !== supervisorToken
      || state.clientPid !== process.pid
    ) {
      throw new Error(`CodeFlow client supervisor 无法确认升级重启归属：supervisorPid=${supervisorPid}, clientPid=${process.pid}`);
    }
    writeDaemonControl(resolveDaemonControlPath(paths.restartControlPath, supervisorToken), {
      action: "restart",
      supervisorPid,
      supervisorToken,
      clientPid: process.pid,
      requestedAt: new Date().toISOString(),
    });
    return state;
  }

  const childArgs = buildDaemonChildProcessArgs({
    entryPath: resolveCurrentEntryPath(),
    execArgv: process.execArgv,
    argv: process.argv.slice(2),
  });
  const stdoutFd = fs.openSync(paths.stdoutPath, "a");
  const stderrFd = fs.openSync(paths.stderrPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, childArgs, {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...buildClientRestartEnv(process.env),
        [DAEMON_CHILD_ENV]: "1",
      },
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }

  if (!child.pid) {
    throw new Error("后台 client 替换进程启动失败：子进程 pid 为空");
  }

  const state = buildLegacyDaemonState(child.pid, paths);
  writeDaemonState(paths.statePath, state);
  child.unref();
  return state;
}

/** 生成 daemon 子进程参数；保留 execArgv，并确保真实 client 以 --foreground 进入主循环。 */
export function buildDaemonChildProcessArgs(input: { entryPath: string; execArgv?: string[]; argv: string[] }): string[] {
  return [
    ...(input.execArgv ?? []),
    path.resolve(input.entryPath),
    ...toDaemonChildArgs(input.argv),
  ];
}

/** 按退出原因决定 supervisor 是停止、退避重启还是进入冷却重试。 */
export function resolveClientDaemonExitAction(input: {
  exitCode: number | null;
  stopRequested: boolean;
  restartRequested: boolean;
  initialStart: boolean;
  uptimeMs: number;
  crashCount: number;
}): ClientDaemonExitAction {
  if (input.stopRequested) return { kind: "stop", reason: "requested" };
  if (input.restartRequested) return { kind: "restart", reason: "requested", delayMs: 0 };
  if (input.exitCode === 0) return { kind: "stop", reason: "clean_exit" };
  if (input.exitCode === CLIENT_PROCESS_EXIT_CODE_BLOCKED) {
    return { kind: "restart", reason: "blocked", delayMs: BLOCKED_RESTART_DELAY_MS };
  }
  if (input.initialStart && input.uptimeMs < STARTUP_EXIT_WINDOW_MS) {
    return { kind: "restart", reason: "startup_exit", delayMs: STARTUP_FAILURE_COOLDOWN_MS };
  }
  if (input.crashCount > MAX_CRASHES_PER_WINDOW) {
    return { kind: "restart", reason: "crash_loop", delayMs: CRASH_LOOP_COOLDOWN_MS };
  }
  const delayIndex = Math.min(Math.max(0, input.crashCount - 1), RESTART_DELAYS_MS.length - 1);
  return { kind: "restart", reason: "crash", delayMs: RESTART_DELAYS_MS[delayIndex]! };
}

/** 运行轻量 supervisor 入口并返回进程退出码。 */
export async function runClientDaemonSupervisor(): Promise<number> {
  if (!isClientDaemonSupervisor()) throw new Error("缺少 CodeFlow client supervisor 启动标记");
  const workerEntryPath = String(process.env[DAEMON_WORKER_ENTRY_ENV] ?? "").trim();
  if (!workerEntryPath) throw new Error("缺少 CodeFlow client worker 入口路径");
  if (!fs.existsSync(workerEntryPath)) throw new Error(`CodeFlow client worker 入口不存在：${workerEntryPath}`);
  delete process.env[DAEMON_SUPERVISOR_ENV];
  delete process.env[DAEMON_WORKER_ENTRY_ENV];
  return await runClientDaemonSupervisorLoop(path.resolve(workerEntryPath));
}

/** 常驻持有真实 Client，并在异常退出时按退避策略重启。 */
async function runClientDaemonSupervisorLoop(workerEntryPath: string): Promise<number> {
  const paths = resolveDaemonPaths();
  fs.mkdirSync(paths.logDir, { recursive: true });
  const lockResult = await acquireDaemonSupervisorLock(paths.supervisorLockPath);
  if (!lockResult.acquired) {
    console.error(`[codeflowai] supervisor 已运行 ownerPid=${lockResult.ownerPid ?? "unknown"}`);
    return CLIENT_DAEMON_SUPERVISOR_ALREADY_RUNNING_EXIT_CODE;
  }

  try {
    return await runOwnedClientDaemonSupervisorLoop(workerEntryPath, paths, lockResult.lock);
  } finally {
    await lockResult.lock.release();
  }
}

/** 在已持有 supervisor 单实例锁的前提下运行 worker 状态机。 */
async function runOwnedClientDaemonSupervisorLoop(
  workerEntryPath: string,
  paths: DaemonPaths,
  supervisorLock: DaemonSupervisorLock,
): Promise<number> {
  const supervisorToken = supervisorLock.token;
  await stopVerifiedOrphanWorker(paths, supervisorToken);
  removeDaemonControlFiles(paths, supervisorToken);

  const supervisorStartedAt = new Date().toISOString();
  const childArgs = buildDaemonChildProcessArgs({
    entryPath: workerEntryPath,
    execArgv: process.execArgv,
    argv: process.argv.slice(2),
  });
  let activeChild: ChildProcess | null = null;
  let signalStopRequested = false;
  let initialStart = true;
  let restartCount = 0;
  let crashTimestamps: number[] = [];
  let lastExit: DaemonExitSnapshot | null = null;
  let signalStopError: Error | null = null;
  let daemonStateClaimed = false;
  const initialConnectionRequired = hasExplicitApiKeyArg(process.argv.slice(2));
  let initialConnection: SupervisedDaemonState["initialConnection"] = initialConnectionRequired ? "pending" : null;

  /** 进程信号保持优雅停止，由 Client 自己完成资源释放。 */
  const requestSignalStop = () => {
    signalStopRequested = true;
    const clientPid = activeChild?.pid ?? null;
    if (!clientPid) return;
    try {
      signalProcess(clientPid);
    } catch (error) {
      signalStopError = error instanceof Error ? error : new Error(String(error));
      console.error(`[codeflowai] supervisor 停止 Client 失败 supervisorPid=${process.pid} clientPid=${clientPid}: ${signalStopError.message}`);
    }
  };
  /** owner endpoint 经 token 核验后，直接强制结束 supervisor 持有的 Client。 */
  const requestEscalatedStop = () => {
    signalStopRequested = true;
    const clientPid = activeChild?.pid ?? null;
    if (!clientPid) return;
    try {
      forceKillProcess(clientPid);
    } catch (error) {
      signalStopError = error instanceof Error ? error : new Error(String(error));
      logger.error("client-daemon", "supervisor hard stop failed", {
        errorCode: "CLIENT_DAEMON_SUPERVISOR_HARD_STOP_FAILED",
        requestId: null,
        supervisorPid: process.pid,
        clientPid,
        rootCause: signalStopError.message,
      });
      console.error(`[codeflowai] supervisor 强制停止 Client 失败 supervisorPid=${process.pid} clientPid=${clientPid}: ${signalStopError.message}`);
    }
  };
  supervisorLock.setStopHandler((mode) => {
    if (mode === "force") requestEscalatedStop();
    else requestSignalStop();
  });
  process.once("SIGINT", requestSignalStop);
  process.once("SIGTERM", requestSignalStop);

  try {
    while (true) {
      if (signalStopRequested) {
        clearDaemonStateForPid(paths.statePath, process.pid);
        removeDaemonControlFiles(paths, supervisorToken);
        return signalStopError ? 1 : 0;
      }
      const childStartedAt = Date.now();
      // 每个新 worker 都必须重新握手，不能继承上一个进程的成功记录。
      initialConnection = "pending";
      activeChild = spawnSupervisedClient(childArgs, supervisorToken);
      if (!activeChild.pid) throw new Error("supervisor 启动 Client 失败：子进程 pid 为空");
      const clientPid = activeChild.pid;
      writeOwnedSupervisedDaemonState(paths.statePath, {
        schemaVersion: 2,
        pid: process.pid,
        supervisorPid: process.pid,
        supervisorToken,
        clientPid,
        startedAt: supervisorStartedAt,
        clientStartedAt: new Date(childStartedAt).toISOString(),
        cwd: process.cwd(),
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        restartCount,
        status: "starting",
        nextRetryAt: null,
        initialConnection,
        startup: null,
        lastExit,
      }, daemonStateClaimed ? {} : { allowClaim: true });
      daemonStateClaimed = true;

      const exit = await waitForChildExit(activeChild);
      activeChild = null;
      const exitedAt = Date.now();
      const uptimeMs = Math.max(0, exitedAt - childStartedAt);
      lastExit = {
        code: exit.code,
        signal: exit.signal,
        at: new Date(exitedAt).toISOString(),
        uptimeMs,
        error: exit.error,
      };

      const control = consumeDaemonControl(paths, process.pid, supervisorToken, clientPid);
      if (uptimeMs >= STABLE_CLIENT_UPTIME_MS) crashTimestamps = [];
      const effectiveExitCode = exit.error ? 1 : exit.code;
      const observedState = readDaemonState(paths.statePath);
      const observedInitialConnection = observedState?.schemaVersion === 2 ? observedState.initialConnection : null;
      if (observedInitialConnection === "succeeded") initialConnection = "succeeded";
      if (initialConnectionRequired && initialStart && observedInitialConnection !== "succeeded") {
        initialConnection = "failed";
        const current = readDaemonState(paths.statePath);
        if (current?.schemaVersion === 2 && current.supervisorPid === process.pid) {
          writeOwnedSupervisedDaemonState(paths.statePath, {
            ...current,
            clientPid: null,
            clientStartedAt: null,
            status: "failed",
            nextRetryAt: null,
            initialConnection,
            lastExit,
          });
        }
        removeDaemonControlFiles(paths, supervisorToken);
        return 1;
      }
      const abnormalExit = effectiveExitCode !== 0
        && effectiveExitCode !== CLIENT_PROCESS_EXIT_CODE_BLOCKED
        && control?.action !== "stop"
        && control?.action !== "restart"
        && !signalStopRequested;
      if (abnormalExit) {
        crashTimestamps = crashTimestamps.filter((timestamp) => exitedAt - timestamp <= CRASH_WINDOW_MS);
        crashTimestamps.push(exitedAt);
      }
      const action = resolveClientDaemonExitAction({
        exitCode: effectiveExitCode,
        stopRequested: signalStopRequested || control?.action === "stop",
        restartRequested: control?.action === "restart",
        initialStart,
        uptimeMs,
        crashCount: crashTimestamps.length,
      });

      if (action.kind === "stop") {
        clearDaemonStateForPid(paths.statePath, process.pid);
        removeDaemonControlFiles(paths, supervisorToken);
        return 0;
      }
      restartCount = action.reason === "requested" ? 0 : restartCount + 1;
      if (action.reason === "requested") crashTimestamps = [];
      const nextRetryAt = action.delayMs > 0 ? new Date(exitedAt + action.delayMs).toISOString() : null;
      const restartStatus: SupervisedDaemonState["status"] = action.reason === "blocked"
        ? "blocked"
        : action.reason === "startup_exit" || action.reason === "crash_loop"
          ? "cooldown"
          : "restarting";
      writeOwnedSupervisedDaemonState(paths.statePath, {
        schemaVersion: 2,
        pid: process.pid,
        supervisorPid: process.pid,
        supervisorToken,
        clientPid: null,
        startedAt: supervisorStartedAt,
        clientStartedAt: null,
        cwd: process.cwd(),
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        restartCount,
        status: restartStatus,
        nextRetryAt,
        initialConnection,
        lastExit,
      });
      console.error(`[codeflowai] supervisor 将重试 Client reason=${action.reason} supervisorPid=${process.pid} clientPid=${clientPid} code=${exit.code ?? "null"} signal=${exit.signal ?? "null"} error=${exit.error ?? "null"} delayMs=${action.delayMs} restartCount=${restartCount}`);
      if (action.delayMs > 0) {
        await waitForDelayOrStop(action.delayMs, () => {
          if (signalStopRequested) return true;
          if (!consumePendingDaemonStop(paths, process.pid, supervisorToken, clientPid)) return false;
          signalStopRequested = true;
          return true;
        });
      }
      if (action.reason === "crash_loop") crashTimestamps = [];
      initialStart = false;
    }
  } catch (error) {
    const failures: Error[] = [error instanceof Error ? error : new Error(String(error))];
    const clientPid = activeChild?.pid ?? null;
    if (clientPid && isProcessRunning(clientPid)) {
      try {
        signalProcess(clientPid);
        const stopped = await waitForProcessExit(clientPid, STOP_TIMEOUT_MS);
        if (!stopped) {
          forceKillProcess(clientPid);
          const forceStopped = await waitForProcessExit(clientPid, 1000);
          if (!forceStopped) throw new Error(`supervisor fatal 后无法停止 Client：clientPid=${clientPid}`);
        }
      } catch (stopError) {
        failures.push(stopError instanceof Error ? stopError : new Error(String(stopError)));
      }
    }
    try {
      const current = readDaemonState(paths.statePath);
      if (current?.schemaVersion === 2 && current.supervisorPid === process.pid) {
        writeOwnedSupervisedDaemonState(paths.statePath, {
          ...current,
          clientPid: null,
          clientStartedAt: null,
          status: "failed",
          nextRetryAt: null,
          initialConnection: initialConnectionRequired && current.initialConnection !== "succeeded" ? "failed" : current.initialConnection,
          lastExit: lastExit ?? {
            code: 1,
            signal: null,
            at: new Date().toISOString(),
            uptimeMs: 0,
            error: failures[0]!.message,
          },
        });
      }
    } catch (stateError) {
      failures.push(stateError instanceof Error ? stateError : new Error(String(stateError)));
    }
    console.error("[codeflowai] supervisor fatal:", failures.map((failure) => failure.message).join("; "));
    return 1;
  } finally {
    supervisorLock.setStopHandler(null);
    process.removeListener("SIGINT", requestSignalStop);
    process.removeListener("SIGTERM", requestSignalStop);
  }
}

/** 新 owner 只接管由旧 lock token 可核验的孤儿 worker，避免 PID 复用时误杀无关进程。 */
async function stopVerifiedOrphanWorker(
  paths: DaemonPaths,
  supervisorToken: string,
): Promise<void> {
  const current = readDaemonState(paths.statePath);
  if (!current || current.schemaVersion !== 2 || !current.clientPid || !isProcessRunning(current.clientPid)) return;
  if (current.supervisorToken === supervisorToken) return;
  if (!current.supervisorToken) {
    throw new Error(
      `Client 仍在运行但无法核验旧 supervisor owner：supervisorPid=${current.supervisorPid}, clientPid=${current.clientPid}`,
    );
  }
  console.error(`[codeflowai] 检测到失去 supervisor 的 Client，先停止旧 worker 再恢复守护 clientPid=${current.clientPid}`);
  const endpointGraceMs = current.status === "starting" && current.clientStartedAt
    ? Math.max(0, SUPERVISOR_READY_TIMEOUT_MS - Math.max(0, Date.now() - Date.parse(current.clientStartedAt)))
    : 0;
  let verified: boolean;
  try {
    verified = await requestVerifiedDaemonWorkerStopWhenReachable(
      paths.supervisorLockPath,
      current.supervisorToken,
      current.clientPid,
      endpointGraceMs,
    );
  } catch (error) {
    if (!isProcessRunning(current.clientPid)) return;
    throw error;
  }
  if (!verified) {
    console.error(`[codeflowai] 旧 Client token endpoint 不存在，按 stale state 接管且不向 PID 发信号 clientPid=${current.clientPid}`);
    return;
  }
  const stopped = await waitForProcessExit(current.clientPid, STOP_TIMEOUT_MS);
  if (!stopped) throw new Error(`无法停止失去守护的 Client clientPid=${current.clientPid}`);
}

/** 以 supervisor 子进程方式启动真实 Client，日志继承到 daemon 日志文件。 */
function spawnSupervisedClient(childArgs: string[], supervisorToken: string): ChildProcess {
  const env = buildClientChildProcessEnv(process.env, process.execPath);
  env[DAEMON_CHILD_ENV] = "1";
  env[DAEMON_SUPERVISOR_PID_ENV] = String(process.pid);
  env[DAEMON_SUPERVISOR_TOKEN_ENV] = supervisorToken;
  return spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    detached: false,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
}

/** 执行 client 后台进程子命令，并返回 CLI 退出码。 */
export async function handleClientDaemonCommand(command: ClientDaemonCommand): Promise<number> {
  if (isClientDaemonChild()) {
    throw new Error("后台子进程不允许再次执行 daemon 命令");
  }
  if (command.action === "start") return await startClientDaemon(command);
  if (command.action === "stop") return await stopClientDaemon();
  return await statusClientDaemon(command.action === "ready" || command.action === "connected", command.action === "connected");
}

/** 后台启动 client，并把控制台输出写入用户级日志目录。 */
async function startClientDaemon(command: ClientDaemonCommand): Promise<number> {
  console.log(formatClientStartupProgress("starting", 0));
  const paths = resolveDaemonPaths();
  fs.mkdirSync(paths.logDir, { recursive: true });

  const existing = readDaemonState(paths.statePath);
  const verifiedExisting = existing?.schemaVersion === 2
    && existing.supervisorToken
    && await isMatchingDaemonSupervisorOwner(paths, existing)
    ? existing
    : null;
  if (verifiedExisting) {
    const existingClientRunning = isProcessRunning(verifiedExisting.clientPid ?? 0);
    if (!command.apiKeyProvided && existingClientRunning) {
      console.log("[codeflowai] 检测到已有 Client，正在确认当前服务器连接状态...");
      return await finishClientDaemonStartup(paths, verifiedExisting, command);
    }

    console.log(
      `[codeflowai] 检测到已有后台 client ${existingClientRunning ? "需要应用本次启动参数" : "未正常运行"}，正在安全重启 supervisorPid=${verifiedExisting.supervisorPid} clientPid=${verifiedExisting.clientPid ?? "null"}`,
    );
    try {
      await requestVerifiedDaemonShutdownForState(paths, verifiedExisting);
    } catch (error) {
      logger.error("client-daemon", "verified daemon restart before start failed", {
        errorCode: "CLIENT_DAEMON_RESTART_BEFORE_START_FAILED",
        supervisorPid: verifiedExisting.supervisorPid,
        clientPid: verifiedExisting.clientPid,
        error,
      });
      console.error(
        `[codeflowai] 已有后台 client 停止失败，未启动第二实例 supervisorPid=${verifiedExisting.supervisorPid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  const legacyOwnerRunning = existing?.schemaVersion === 1
    ? isProcessRunning(existing.clientPid)
    : existing?.supervisorToken == null && isProcessRunning(existing?.supervisorPid ?? 0);
  if (existing && legacyOwnerRunning) {
    if (command.apiKeyProvided) {
      console.error("[codeflowai] 已有运行中的 client，显式 --key 启动未复用现有实例");
      return 1;
    }
    printDaemonState(existing);
    console.log(`[codeflowai] stdout: ${existing.stdoutPath}`);
    console.log(`[codeflowai] stderr: ${existing.stderrPath}`);
    console.error("[codeflowai] 旧版 Client 无法确认服务器连接就绪，请先执行 codeflow --stop 再重新启动。");
    return 1;
  }

  const workerEntryPath = resolveCurrentEntryPath();
  const supervisorEntryPath = resolveClientDaemonSupervisorEntryPath(workerEntryPath);
  if (!fs.existsSync(supervisorEntryPath)) {
    throw new Error(`CodeFlow client supervisor 入口不存在：${supervisorEntryPath}`);
  }
  const supervisorArgs = buildDaemonChildProcessArgs({
    entryPath: supervisorEntryPath,
    execArgv: process.execArgv,
    argv: buildClientDaemonStartupArgv(command),
  });
  const stdoutStartOffset = getFileSize(paths.stdoutPath);
  const stderrStartOffset = getFileSize(paths.stderrPath);
  const stdoutFd = fs.openSync(paths.stdoutPath, "a");
  const stderrFd = fs.openSync(paths.stderrPath, "a");
  let child: ChildProcess;
  try {
    const env = buildClientChildProcessEnv(process.env, process.execPath);
    env[DAEMON_SUPERVISOR_ENV] = "1";
    env[DAEMON_WORKER_ENTRY_ENV] = workerEntryPath;
    child = spawn(process.execPath, supervisorArgs, {
      cwd: process.cwd(),
      detached: true,
      env,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }

  const earlyExit = await waitForEarlyExit(child, SUPERVISOR_STARTUP_EXIT_WINDOW_MS);
  if (earlyExit) {
    if (earlyExit.code === CLIENT_DAEMON_SUPERVISOR_ALREADY_RUNNING_EXIT_CODE) {
      const active = await waitForActiveDaemonState(paths, SUPERVISOR_READY_TIMEOUT_MS);
      if (active && !command.apiKeyProvided) {
        return active.schemaVersion === 2 ? await finishClientDaemonStartup(paths, active, command) : 1;
      }
      console.error("[codeflowai] 已有 supervisor 持有单实例锁，但 daemon 状态尚未就绪");
      return 1;
    }
    console.error(`[codeflowai] 后台 supervisor 启动失败 code=${earlyExit.code ?? "null"} signal=${earlyExit.signal ?? "null"}`);
    printStartupLogDelta("stdout", paths.stdoutPath, stdoutStartOffset);
    printStartupLogDelta("stderr", paths.stderrPath, stderrStartOffset);
    console.error(`[codeflowai] stderr: ${paths.stderrPath}`);
    return 1;
  }

  if (!child.pid) {
    throw new Error("后台 supervisor 启动失败：子进程 pid 为空");
  }

  const state = await waitForSpawnedSupervisorState(paths.statePath, child, SUPERVISOR_READY_TIMEOUT_MS);
  const ownerVerified = state?.schemaVersion === 2
    && state.supervisorPid === child.pid
    && state.status !== "failed"
    && await isMatchingDaemonSupervisorOwner(paths, state);
  if (!ownerVerified) {
    if (child.exitCode === CLIENT_DAEMON_SUPERVISOR_ALREADY_RUNNING_EXIT_CODE) {
      const active = await waitForActiveDaemonState(paths, SUPERVISOR_READY_TIMEOUT_MS);
      if (active && !command.apiKeyProvided) {
        return active.schemaVersion === 2 ? await finishClientDaemonStartup(paths, active, command) : 1;
      }
    }
    if (child.exitCode == null && child.pid) {
      signalProcess(child.pid);
      const stopped = await waitForProcessExit(child.pid, STOP_TIMEOUT_MS);
      if (!stopped) forceKillProcess(child.pid);
    }
    console.error(`[codeflowai] 后台 supervisor 未建立有效 Client 状态 pid=${child.pid}`);
    printStartupLogDelta("stdout", paths.stdoutPath, stdoutStartOffset);
    printStartupLogDelta("stderr", paths.stderrPath, stderrStartOffset);
    return 1;
  }
  child.unref();
  return await finishClientDaemonStartup(paths, state, command, { stdout: stdoutStartOffset, stderr: stderrStartOffset });
}

/** 所有启动入口（含复用和并发启动）共享同一个成功分界点。 */
async function finishClientDaemonStartup(paths: DaemonPaths, state: SupervisedDaemonState,
  command: ClientDaemonCommand, offsets?: { stdout: number; stderr: number }): Promise<number> {
  const result = await waitForInitialConnectionOutcome(paths, state, resolveInitialConnectionWaitTimeoutMs());
  if (result.outcome === "succeeded") {
    // 使用重试循环刚刚核验的同一 worker 状态，避免额外探测超时推翻已确认的成功。
    const { readiness } = result;
    console.log(readiness.ready ? "\n[codeflowai] ===== 启动成功：已连接服务器，Client 已就绪 ====="
      : "\n[codeflowai] ===== 启动完成（功能受限）：已连接服务器，部分模块异常 =====");
    if (readiness.serverUrl) console.log(`[codeflowai] 服务器：${readiness.serverUrl}`);
    if (readiness.clientId) console.log(`[codeflowai] Client：${readiness.clientId}`);
    console.log(`[codeflowai] 后台进程：${readiness.clientPid}；日志：${paths.logDir}`);
    if (!readiness.ready && offsets) printStartupLogDelta("stderr", paths.stderrPath, offsets.stderr);
    printClientCommonCommands();
    return 0;
  }
  const { outcome } = result;
  const current = readDaemonState(paths.statePath);
  // 已失败或耗尽启动期限，仅生成诊断信息，不在期限外追加一次网络探测。
  const readiness = await readClientDaemonReadiness(paths, current, 0);
  logger.error("client-daemon", "Client startup did not reach server readiness", {
    errorCode: outcome === "timeout" ? "CLIENT_STARTUP_TIMEOUT" : "CLIENT_DAEMON_STARTUP_STATE_FAILED",
    requestId: crypto.randomUUID(), supervisorPid: state.supervisorPid, clientPid: current?.clientPid ?? null,
    clientId: readiness.clientId, serverUrl: readiness.serverUrl, stage: readiness.stage,
    rootCause: `${outcome}:${readiness.status}`,
  });
  if (command.apiKeyProvided && current?.schemaVersion === 2 && current.supervisorToken === state.supervisorToken
    && await isMatchingDaemonSupervisorOwner(paths, current)) await requestVerifiedDaemonShutdownForState(paths, current);
  console.error(`[codeflowai] 后台 Client 启动失败 status=${readiness.status}；${outcome === "timeout" ? "等待连接就绪超时" : readiness.message}。未确认服务器连接成功。`);
  if (offsets) {
    printStartupLogDelta("stdout", paths.stdoutPath, offsets.stdout);
    printStartupLogDelta("stderr", paths.stderrPath, offsets.stderr);
  }
  console.error(`[codeflowai] 日志：${paths.logDir}；执行 codeflow --status 查看当前进程和连接状态。`);
  if (!command.apiKeyProvided) console.error("[codeflowai] 后台守护可能继续重试；如需停止，请执行 codeflow --stop。");
  return 1;
}

/** 确保直接调用 daemon API 时也能把结构化 CLI key 透传给 supervisor。 */
function buildClientDaemonStartupArgv(command: ClientDaemonCommand): string[] {
  const argv = process.argv.slice(2);
  if (!command.apiKeyProvided) return argv;
  const parsed = parseClientCliArgs(argv);
  if ((parsed.kind === "run" || parsed.kind === "daemon") && parsed.apiKeyProvided) return argv;
  return [...argv, "--key", String(command.apiKeyOverride ?? "")];
}

/** 启动成功后输出常用命令，版本号沿用当前运行时解析结果。 */
function printClientCommonCommands(): void {
  console.log("");
  console.log(formatClientCommonCommands(readSelfVersion()));
}

/** 获取日志文件当前大小，不存在时按空文件处理。 */
function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return 0;
    throw error;
  }
}

/** 打印本次启动窗口内新增的日志片段，用于把启动异常暴露给前台。 */
function printStartupLogDelta(label: "stdout" | "stderr", filePath: string, offset: number): void {
  const text = redactClientStartupText(readLogDelta(filePath, offset, 16_000).trim());
  if (!text) return;
  const output = [`[codeflowai] ${label} 启动日志:`, text].join("\n");
  if (label === "stderr") {
    console.error(output);
  } else {
    console.log(output);
  }
}

/** 读取日志新增片段，最多保留尾部 maxBytes 字节。 */
function readLogDelta(filePath: string, offset: number, maxBytes: number): string {
  const size = getFileSize(filePath);
  if (size <= offset) return "";
  const length = Math.min(size - offset, maxBytes);
  const start = Math.max(offset, size - length);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** 停止由 daemon state 记录的后台 client。 */
async function stopClientDaemon(): Promise<number> {
  const paths = resolveDaemonPaths();
  const state = readDaemonState(paths.statePath);
  if (!state) {
    console.log("[codeflowai] 后台 client 未运行");
    return 0;
  }
  if (state.schemaVersion === 1) {
    if (!isProcessRunning(state.clientPid)) {
      clearDaemonStateForPid(paths.statePath, state.clientPid);
      removeDaemonControlFiles(paths, null);
      console.log(`[codeflowai] 后台 client 未运行，已清理 stale state pid=${state.pid}`);
      return 0;
    }
    console.error(`[codeflowai] 旧版后台 client 缺少 owner token，无法核验进程身份，未向 PID 发送停止信号 pid=${state.clientPid}`);
    return 1;
  }

  if (!state.supervisorToken) {
    if (!isProcessRunning(state.clientPid ?? 0) && !isProcessRunning(state.supervisorPid)) {
      clearDaemonStateForPid(paths.statePath, state.supervisorPid);
      removeDaemonControlFiles(paths, null);
      console.log(`[codeflowai] 后台 client 未运行，已清理 stale state pid=${state.pid}`);
      return 0;
    }
    console.error(
      `[codeflowai] 旧版后台 supervisor 缺少 owner token，无法核验进程身份，未向 PID 发送停止信号 supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}`,
    );
    return 1;
  }

  let supervisorVerified: boolean;
  try {
    supervisorVerified = await isMatchingDaemonSupervisorOwner(paths, state);
  } catch (error) {
    if (process.platform !== "win32" || !(isNodeErrorCode(error, "EPERM") || isNodeErrorCode(error, "EACCES"))) throw error;
    return await stopClientDaemonAfterSupervisorPipeAccessFailure(paths, state, error);
  }
  if (!supervisorVerified) {
    const supervisorRunning = isProcessRunning(state.supervisorPid);
    const clientRunning = isProcessRunning(state.clientPid ?? 0);
    if (!supervisorRunning && !clientRunning) {
      clearDaemonStateForSupervisorToken(paths.statePath, state.supervisorToken);
      removeDaemonControlFiles(paths, state.supervisorToken);
      console.log(`[codeflowai] 后台 client 未运行，已清理 stale state supervisorPid=${state.supervisorPid}`);
      return 0;
    }
    if (supervisorRunning) {
      try {
        await requestVerifiedDaemonSupervisorStop(paths.supervisorLockPath, state.supervisorToken, state.supervisorPid);
      } catch (error) {
        if (!isProcessRunning(state.supervisorPid) && !isProcessRunning(state.clientPid ?? 0)) {
          clearDaemonStateForSupervisorToken(paths.statePath, state.supervisorToken);
          removeDaemonControlFiles(paths, state.supervisorToken);
          console.log(`[codeflowai] 后台 client 已退出，已清理 stale state supervisorPid=${state.supervisorPid}`);
          return 0;
        }
        logger.error("client-daemon", "unmatched supervisor stop verification failed", {
          errorCode: "CLIENT_DAEMON_SUPERVISOR_STOP_VERIFICATION_FAILED",
          supervisorPid: state.supervisorPid,
          clientPid: state.clientPid,
          error,
        });
        console.error(
          `[codeflowai] 无法核验 daemon state 对应的 supervisor，未向 PID 发送停止信号 supervisorPid=${state.supervisorPid}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
      }
      const supervisorStopped = await waitForProcessExit(state.supervisorPid, STOP_TIMEOUT_MS);
      const clientStopped = !state.clientPid || await waitForProcessExit(state.clientPid, STOP_TIMEOUT_MS);
      if (!supervisorStopped || !clientStopped) {
        logger.error("client-daemon", "token-verified unmatched daemon stop timed out", {
          errorCode: "CLIENT_DAEMON_UNMATCHED_STOP_TIMEOUT",
          supervisorPid: state.supervisorPid,
          clientPid: state.clientPid,
          supervisorStopped,
          clientStopped,
        });
        console.error(
          `[codeflowai] 已核验的后台 client 停止超时 supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}`,
        );
        return 1;
      }
      clearDaemonStateForSupervisorToken(paths.statePath, state.supervisorToken);
      removeDaemonControlFiles(paths, state.supervisorToken);
      console.log(`[codeflowai] 后台 client 已停止 supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}`);
      return 0;
    }
    if (!state.clientPid) {
      clearDaemonStateForSupervisorToken(paths.statePath, state.supervisorToken);
      removeDaemonControlFiles(paths, state.supervisorToken);
      console.log(`[codeflowai] 后台 client 未运行，已清理 stale state supervisorPid=${state.supervisorPid}`);
      return 0;
    }
    try {
      await requestVerifiedDaemonWorkerStop(paths.supervisorLockPath, state.supervisorToken, state.clientPid);
    } catch (error) {
      if (!isProcessRunning(state.clientPid)) {
        clearDaemonStateForSupervisorToken(paths.statePath, state.supervisorToken);
        removeDaemonControlFiles(paths, state.supervisorToken);
        console.log(`[codeflowai] 后台 client 已退出，已清理 stale state clientPid=${state.clientPid}`);
        return 0;
      }
      logger.error("client-daemon", "orphan client stop verification failed", {
        errorCode: "CLIENT_DAEMON_ORPHAN_STOP_VERIFICATION_FAILED",
        supervisorPid: state.supervisorPid,
        clientPid: state.clientPid,
        error,
      });
      console.error(
        `[codeflowai] 无法核验 daemon state 对应的 supervisor 或 Client，未向 PID 发送停止信号 supervisorPid=${state.supervisorPid} clientPid=${state.clientPid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    const workerStopped = await waitForProcessExit(state.clientPid, STOP_TIMEOUT_MS);
    if (!workerStopped) {
      logger.error("client-daemon", "verified orphan client stop timed out", {
        errorCode: "CLIENT_DAEMON_ORPHAN_STOP_TIMEOUT",
        supervisorPid: state.supervisorPid,
        clientPid: state.clientPid,
      });
      console.error(`[codeflowai] 已核验的孤儿 Client 停止超时 clientPid=${state.clientPid}`);
      return 1;
    }
    clearDaemonStateForSupervisorToken(paths.statePath, state.supervisorToken);
    console.log(`[codeflowai] 失去 supervisor 的后台 client 已停止 clientPid=${state.clientPid}`);
    return 0;
  }

  try {
    await requestVerifiedDaemonShutdownForState(paths, state);
  } catch (error) {
    logger.error("client-daemon", "verified daemon stop failed", {
      errorCode: "CLIENT_DAEMON_STOP_FAILED",
      supervisorPid: state.supervisorPid,
      clientPid: state.clientPid,
      error,
    });
    console.error(
      `[codeflowai] 后台 client 停止失败 supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  console.log(`[codeflowai] 后台 client 已停止 supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}`);
  return 0;
}

/** 管道权限失败时，由持有 token 的 worker/控制文件确认停止；不能根据状态文件中的 PID 直接杀进程。 */
async function stopClientDaemonAfterSupervisorPipeAccessFailure(
  paths: DaemonPaths,
  state: SupervisedDaemonState,
  pipeError: unknown,
): Promise<number> {
  const requestId = crypto.randomUUID();
  const token = state.supervisorToken!;
  const errorContext = (error: unknown) => ({
    causeCode: error && typeof error === "object" && "code" in error ? String(error.code) : null,
    message: redactClientStartupText(error instanceof Error ? error.message : String(error)).replaceAll(token, "[REDACTED]"),
  });
  const context = {
    requestId, supervisorPid: state.supervisorPid, clientPid: state.clientPid,
    causeCode: errorContext(pipeError).causeCode,
  };
  let workerStopError: unknown = null;
  try {
    if (isProcessRunning(state.supervisorPid) || isProcessRunning(state.clientPid ?? 0)) {
      const lock = readDaemonSupervisorLockIfValid(paths.supervisorLockPath);
      if (lock?.pid !== state.supervisorPid || lock.token !== token) {
        throw new Error("daemon state 与 supervisor lock 不匹配，无法确认停止请求归属");
      }
      writeDaemonControl(resolveDaemonControlPath(paths.stopControlPath, token), {
        action: "stop", supervisorPid: state.supervisorPid, supervisorToken: token,
        clientPid: state.clientPid, requestedAt: new Date().toISOString(),
      });
      if (state.clientPid) {
        try {
          await requestVerifiedDaemonWorkerStop(paths.supervisorLockPath, token, state.clientPid);
        } catch (error) {
          // Worker 可能已经退出；冷却中的 supervisor 仍可消费属于它的停止文件。
          workerStopError = error;
        }
      }
      const [supervisorStopped, clientStopped] = await Promise.all([
        waitForProcessExit(state.supervisorPid, STOP_TIMEOUT_MS),
        state.clientPid ? waitForProcessExit(state.clientPid, STOP_TIMEOUT_MS) : Promise.resolve(true),
      ]);
      if (!supervisorStopped || !clientStopped) {
        throw new Error(`等待后台进程停止超时 supervisorStopped=${supervisorStopped} clientStopped=${clientStopped}`);
      }
    }
    clearDaemonStateForSupervisorToken(paths.statePath, token);
    removeDaemonControlFiles(paths, token);
    logger.warn("client-daemon", "daemon stopped after supervisor pipe access failure", {
      ...context, errorCode: "CLIENT_DAEMON_PIPE_STOP_FALLBACK",
      rootCause: errorContext(pipeError),
    });
    console.log(`[codeflowai] supervisor 控制管道不可访问（${context.causeCode}），已通过 worker/停止控制文件确认后台 client 已停止 supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}`);
    return 0;
  } catch (error) {
    logger.error("client-daemon", "daemon stop after supervisor pipe access failure failed", {
      ...context, errorCode: "CLIENT_DAEMON_PIPE_STOP_FAILED",
      rootCause: errorContext(pipeError), workerStopError: workerStopError ? errorContext(workerStopError) : null,
      recoveryError: errorContext(error),
    });
    console.error(`[codeflowai] CodeFlowAI 自动停止未完成（supervisor 控制管道 ${context.causeCode}）：${errorContext(error).message}。请使用启动 Client 的同一 Windows 账户和权限级别执行 codeflow --stop；仍失败时需核对进程身份后手动结束 supervisor 和 Client。requestId=${requestId} supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}`);
    return 1;
  }
}

export type ClientDaemonProcessSnapshot = {
  running: boolean;
  supervisorPid: number | null;
  clientPid: number | null;
};

/** 仅供升级决定是否需要停止进程，不代表就绪或授权发送信号；停止仍须通过 owner token 校验。 */
export function readClientDaemonProcessSnapshot(
  statePath = path.join(os.homedir(), ".codeflowai", "client-daemon.json"),
): ClientDaemonProcessSnapshot {
  const state = readDaemonState(statePath);
  const supervisorPid = state?.schemaVersion === 2 && isProcessRunning(state.supervisorPid) ? state.supervisorPid : null;
  const clientPid = state?.clientPid && isProcessRunning(state.clientPid) ? state.clientPid : null;
  return { running: supervisorPid !== null || clientPid !== null, supervisorPid, clientPid };
}

/** 输出后台 client 状态；仅完全就绪返回 0，不供升级器判断进程是否存在。 */
async function statusClientDaemon(json = false, connectionOnly = false): Promise<number> {
  const paths = resolveDaemonPaths();
  const state = readDaemonState(paths.statePath);
  const readiness = await readClientDaemonReadiness(paths, state);
  if (json) {
    console.log(JSON.stringify(readiness));
    return (connectionOnly ? readiness.connected : readiness.ready) ? 0 : 1;
  }
  if (!state) {
    console.log("[codeflowai] 后台 client 未运行");
    return 1;
  }
  const supervisorRunning = state.schemaVersion === 2 && state.supervisorToken
    ? await isMatchingDaemonSupervisorOwner(paths, state)
    : state.schemaVersion === 2 && isProcessRunning(state.supervisorPid);
  const clientRunning = isProcessRunning(state.clientPid ?? 0);
  if (!supervisorRunning && !clientRunning) {
    if (state.schemaVersion === 2 && state.status === "failed") {
      console.error(`[codeflowai] 后台 client 守护已熔断 restartCount=${state.restartCount} lastExitCode=${state.lastExit?.code ?? "null"}`);
      console.error(`[codeflowai] stderr: ${state.stderrPath}`);
      return 1;
    }
    console.log(`[codeflowai] 后台 client 未运行，检测到 stale state pid=${state.pid}`);
    return 1;
  }
  printDaemonState(state, supervisorRunning);
  console.log(`[codeflowai] 服务器连接：${readiness.ready ? "已连接，就绪" : readiness.connected ? "已连接，功能受限" : "未就绪"}；${readiness.message}`);
  if (readiness.serverUrl) console.log(`[codeflowai] server: ${readiness.serverUrl}`);
  console.log(`[codeflowai] startedAt: ${state.startedAt}`);
  console.log(`[codeflowai] cwd: ${state.cwd}`);
  console.log(`[codeflowai] stdout: ${state.stdoutPath}`);
  console.log(`[codeflowai] stderr: ${state.stderrPath}`);
  return readiness.ready ? 0 : 1;
}

/** 就绪是本次存活 worker 的实时握手状态，不是 supervisor 或历史文件的存活状态。 */
async function readClientDaemonReadiness(paths: DaemonPaths, state: DaemonState | null, deadline = Number.POSITIVE_INFINITY) {
  const managed = state?.schemaVersion === 2 ? state : null;
  const supervisorRunning = managed && Date.now() < deadline
    ? await isMatchingDaemonSupervisorOwner(paths, managed, deadline) : false;
  const clientRunning = Boolean(state?.clientPid && isProcessRunning(state.clientPid));
  let snapshot = managed?.startup ?? null;
  let ready = false;
  let connected = false;
  if (managed && isClientServerConnected({ supervisorRunning, clientRunning,
    status: managed.status, initialConnection: managed.initialConnection, snapshot })) {
    const timeoutMs = Math.min(WORKER_STATUS_RESPONSE_TIMEOUT_MS, deadline - Date.now());
    snapshot = timeoutMs > 0
      ? await probeDaemonWorkerStartup(paths.supervisorLockPath, managed.supervisorToken!, managed.clientPid!, timeoutMs)
      : null;
    const latest = readDaemonState(paths.statePath);
    connected = Date.now() < deadline && latest?.schemaVersion === 2 && latest.supervisorToken === managed.supervisorToken
      && latest.supervisorPid === managed.supervisorPid && latest.clientPid === managed.clientPid
      && isClientServerConnected({ supervisorRunning: supervisorRunning && isProcessRunning(managed.supervisorPid), clientRunning: isProcessRunning(managed.clientPid!),
        status: latest.status, initialConnection: latest.initialConnection, snapshot });
    ready = connected && snapshot?.stage === "ready";
  }
  const stage = snapshot?.stage ?? (managed?.status === "failed" || managed?.status === "blocked" ? "failed" : "starting");
  return {
    schemaVersion: 1, ready, connected, degraded: connected && !ready, status: state ? managed?.status ?? "legacy" : "stopped", stage,
    message: ready ? CLIENT_STARTUP_MESSAGES.ready : stage === "ready" ? "工作进程未响应，连接未确认" : CLIENT_STARTUP_MESSAGES[stage],
    supervisorRunning, clientRunning, supervisorPid: managed?.supervisorPid ?? null, clientPid: state?.clientPid ?? null,
    clientStartedAt: managed?.clientStartedAt ?? null,
    clientId: snapshot?.clientId ?? null, serverUrl: snapshot?.serverUrl ?? null,
    errorCode: ready ? null : connected ? "CLIENT_MODULES_NOT_READY" : "CLIENT_NOT_READY",
  };
}

/** daemon 持久化路径集合。 */
type DaemonPaths = {
  statePath: string;
  supervisorLockPath: string;
  stopControlPath: string;
  restartControlPath: string;
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
};

/** 解析用户级 daemon 状态、控制文件与日志路径。 */
function resolveDaemonPaths(): DaemonPaths {
  const homeDir = path.join(os.homedir(), ".codeflowai");
  const cleanup = cleanupClientLogRetention();
  if (cleanup.errors.length) {
    logger.warn("client-daemon", "client log retention cleanup had errors before resolving daemon paths", {
      logDir: cleanup.logDir,
      retentionDays: cleanup.retentionDays,
      scanned: cleanup.scanned,
      deleted: cleanup.deleted,
      errors: cleanup.errors,
    });
  }
  const logDir = resolveClientLogDir();
  return {
    statePath: path.join(homeDir, "client-daemon.json"),
    supervisorLockPath: path.join(homeDir, "client-daemon-supervisor.lock"),
    stopControlPath: path.join(homeDir, "client-daemon-stop.json"),
    restartControlPath: path.join(homeDir, "client-daemon-restart.json"),
    logDir,
    stdoutPath: resolveDatedClientDaemonLogPath("out"),
    stderrPath: resolveDatedClientDaemonLogPath("err"),
  };
}

/** 读取 daemon 状态文件，不存在时返回 null。 */
function readDaemonState(statePath: string): DaemonState | null {
  if (!fs.existsSync(statePath)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return null;
    throw new Error(`CodeFlow client daemon 状态文件无法解析，请人工检查：${statePath}`, { cause: error });
  }
  const pid = Number(parsed.pid ?? 0);
  const startedAt = String(parsed.startedAt ?? "").trim();
  const cwd = String(parsed.cwd ?? "").trim();
  const stdoutPath = String(parsed.stdoutPath ?? "").trim();
  const stderrPath = String(parsed.stderrPath ?? "").trim();
  if (!Number.isInteger(pid) || pid <= 0 || !startedAt || !Number.isFinite(Date.parse(startedAt)) || !cwd || !stdoutPath || !stderrPath) {
    throw new Error(`CodeFlow client daemon 状态文件无效，请人工检查：${statePath}`);
  }
  if (Number(parsed.schemaVersion ?? 1) === 1) {
    return { schemaVersion: 1, pid, supervisorPid: null, clientPid: pid, startedAt, cwd, stdoutPath, stderrPath };
  }

  const supervisorPid = Number(parsed.supervisorPid ?? pid);
  const supervisorToken = parsed.supervisorToken == null ? null : String(parsed.supervisorToken).trim() || null;
  const clientPid = parsed.clientPid == null ? null : Number(parsed.clientPid);
  const clientStartedAt = parsed.clientStartedAt == null ? null : String(parsed.clientStartedAt).trim() || null;
  const restartCount = Number(parsed.restartCount ?? 0);
  const status = String(parsed.status ?? "running");
  const nextRetryAt = parsed.nextRetryAt == null ? null : String(parsed.nextRetryAt).trim() || null;
  const initialConnectionRaw = parsed.initialConnection == null ? null : String(parsed.initialConnection).trim() || null;
  const initialConnection = initialConnectionRaw === "pending" || initialConnectionRaw === "succeeded" || initialConnectionRaw === "failed"
    ? initialConnectionRaw
    : initialConnectionRaw == null ? null : "invalid";
  if (
    Number(parsed.schemaVersion) !== 2
    || !Number.isInteger(supervisorPid)
    || supervisorPid <= 0
    || (supervisorToken != null && !isCanonicalUuid(supervisorToken))
    || (clientPid != null && (!Number.isInteger(clientPid) || clientPid <= 0))
    || (clientStartedAt != null && !Number.isFinite(Date.parse(clientStartedAt)))
    || !Number.isInteger(restartCount)
    || restartCount < 0
    || !isDaemonStatus(status)
    || (nextRetryAt != null && !Number.isFinite(Date.parse(nextRetryAt)))
    || initialConnection === "invalid"
  ) {
    throw new Error(`CodeFlow client daemon supervisor 状态文件无效，请人工检查：${statePath}`);
  }
  return {
    schemaVersion: 2,
    pid,
    supervisorPid,
    supervisorToken,
    clientPid,
    startedAt,
    clientStartedAt,
    cwd,
    stdoutPath,
    stderrPath,
    restartCount,
    status,
    nextRetryAt,
    initialConnection,
    startup: parseClientStartupSnapshot(parsed.startup),
    lastExit: parseDaemonExitSnapshot(parsed.lastExit, statePath),
  };
}

/** 写入 daemon 状态，供 stop/status 精确定位后台进程。 */
function writeDaemonState(statePath: string, state: DaemonState): void {
  writeJsonFileAtomic(statePath, state);
}

/** Supervisor 状态只能由当前 owner 更新；首次 claim 允许接管已失活的旧状态。 */
function writeOwnedSupervisedDaemonState(
  statePath: string,
  state: SupervisedDaemonState,
  options: { allowClaim?: boolean } = {},
): void {
  const current = readDaemonState(statePath);
  const sameOwner = current?.schemaVersion === 2
    && current.supervisorPid === state.supervisorPid
    && current.supervisorToken === state.supervisorToken;
  if (options.allowClaim) {
    if (
      current
      && !sameOwner
      && (current.schemaVersion === 1 || current.supervisorToken == null)
      && isDaemonSupervisorRunning(current)
    ) {
      throw new Error(
        `CodeFlow client supervisor 状态所有权冲突：expectedSupervisorPid=${state.supervisorPid}, actualPid=${current.pid}`,
      );
    }
  } else if (!sameOwner) {
    throw new Error(
      `CodeFlow client supervisor 已失去状态所有权：expectedSupervisorPid=${state.supervisorPid}, actualSupervisorPid=${current?.schemaVersion === 2 ? current.supervisorPid : "null"}`,
    );
  }
  writeDaemonState(statePath, state);
}

/** 由 OS 监听端点提供生命周期互斥；JSON 文件只保存可诊断的 owner 元数据。 */
async function acquireDaemonSupervisorLock(
  lockPath: string,
): Promise<{ acquired: true; lock: DaemonSupervisorLock } | { acquired: false; ownerPid: number | null }> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const endpointKey = crypto.createHash("sha256")
    .update(normalizeDaemonLockIdentity(lockPath))
    .digest("hex");
  const payload: DaemonSupervisorLockPayload = {
    token: crypto.randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  let stopHandler: ((mode: DaemonSupervisorStopMode) => void) | null = null;
  let pendingStopMode: DaemonSupervisorStopMode | null = null;
  let acceptedStopMode: DaemonSupervisorStopMode | null = null;
  const server = net.createServer((socket) => {
    handleDaemonSupervisorStopSocket(socket, payload.token, (mode) => {
      if (acceptedStopMode === "force" || acceptedStopMode === mode) return;
      acceptedStopMode = mode;
      const handler = stopHandler;
      if (handler) setImmediate(() => handler(mode));
      else pendingStopMode = mode;
    });
  });
  const endpoint = resolveDaemonLifecycleEndpoint(endpointKey, "supervisor");
  const endpointAcquired = await listenDaemonLifecycleEndpoint(server, endpoint);
  if (!endpointAcquired) {
    const existing = readDaemonSupervisorLockIfValid(lockPath);
    return {
      acquired: false,
      ownerPid: existing && isProcessRunning(existing.pid) ? existing.pid : null,
    };
  }
  server.unref();

  try {
    writeJsonFileAtomic(lockPath, payload);
  } catch (error) {
    await closeDaemonSupervisorEndpoint(server);
    throw error;
  }
  return {
    acquired: true,
    lock: createDaemonSupervisorLock(lockPath, payload, server, (handler) => {
      stopHandler = handler;
      if (!handler || !pendingStopMode) return;
      const mode = pendingStopMode;
      pendingStopMode = null;
      setImmediate(() => handler(mode));
    }),
  };
}

/** lifecycle 端点只服务本机探测与停止指令，请求方随时可能先断开；记录结构化诊断后关闭本次连接。 */
function attachDaemonLifecycleSocketErrorHandler(socket: net.Socket): void {
  let reported = false;
  socket.on("error", (error: NodeJS.ErrnoException) => {
    socket.destroy();
    if (reported) return;
    reported = true;
    logger.warn("client-daemon", "daemon lifecycle endpoint socket error ignored", {
      errorCode: "CLIENT_DAEMON_SOCKET_ERROR",
      requestId: crypto.randomUUID(),
      causeCode: error.code ?? error.name,
      rootCause: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  });
}

/** 只接受持有 owner token 的本机 supervisor 停止指令，并保留优雅与强制语义。 */
function handleDaemonSupervisorStopSocket(
  socket: net.Socket,
  supervisorToken: string,
  onStop: (mode: DaemonSupervisorStopMode) => void,
): void {
  attachDaemonLifecycleSocketErrorHandler(socket);
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (chunk) => {
    input += String(chunk);
    if (input.length > 512) {
      socket.destroy();
      return;
    }
    if (!input.includes("\n")) return;
    const command = input.trim();
    const mode = command === `stop:${supervisorToken}`
      ? "graceful"
      : command === `force-stop:${supervisorToken}`
        ? "force"
        : null;
    if (!mode) {
      socket.destroy();
      return;
    }
    socket.end("accepted\n");
    onStop(mode);
  });
}

async function isDaemonSupervisorEndpointHeld(lockPath: string, deadline = Number.POSITIVE_INFINITY): Promise<boolean> {
  const endpointKey = crypto.createHash("sha256")
    .update(normalizeDaemonLockIdentity(lockPath))
    .digest("hex");
  return await isDaemonLifecycleEndpointReachable(resolveDaemonLifecycleEndpoint(endpointKey, "supervisor"), deadline);
}

/** 释放 OS 端点后按 token/PID 清理自己的元数据，不能删除新 owner 的锁。 */
function createDaemonSupervisorLock(
  lockPath: string,
  payload: DaemonSupervisorLockPayload,
  server: net.Server,
  setStopHandler: (handler: ((mode: DaemonSupervisorStopMode) => void) | null) => void,
): DaemonSupervisorLock {
  let released = false;
  return {
    token: payload.token,
    setStopHandler,
    async release() {
      if (released) return;
      released = true;
      await closeDaemonSupervisorEndpoint(server);
      const current = readDaemonSupervisorLockIfValid(lockPath);
      if (current?.token === payload.token && current.pid === payload.pid) removeFileIfExists(lockPath);
    },
  };
}

/** 仅连接现有生命周期端点，绝不通过临时 listen 干扰并发启动。 */
function isDaemonLifecycleEndpointReachable(endpoint: DaemonLifecycleEndpoint, deadline = Number.POSITIVE_INFINITY): Promise<boolean> {
  if (Date.now() >= deadline) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = endpoint.kind === "ipc"
      ? net.createConnection({ path: endpoint.path })
      : net.createConnection({ host: endpoint.host, port: endpoint.port });
    const finish = (reachable: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), Math.min(500, Math.max(0, deadline - Date.now())));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ECONNREFUSED")) {
        finish(false);
        return;
      }
      finish(false, error);
    });
  });
}

/** 监听一个进程退出后由 OS 自动回收的本机端点。 */
function listenDaemonLifecycleEndpoint(server: net.Server, endpoint: DaemonLifecycleEndpoint): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error & { code?: string }) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (endpoint.kind === "ipc") server.listen(endpoint.path);
    else server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true });
  });
}

function resolveDaemonLifecycleEndpoint(endpointKey: string, role: "supervisor" | "worker"): DaemonLifecycleEndpoint {
  if (process.platform === "win32") {
    return { kind: "ipc", path: `\\\\.\\pipe\\codeflowai-client-${role}-${endpointKey.slice(0, 24)}` };
  }
  if (process.platform === "linux") {
    return { kind: "ipc", path: `\0codeflowai-client-${role}-${endpointKey}` };
  }
  const port = 20_000 + (Number.parseInt(endpointKey.slice(0, 8), 16) % 20_000);
  return { kind: "tcp", host: "127.0.0.1", port };
}

/** 关闭 endpoint；未建立监听按幂等成功处理。 */
function closeDaemonSupervisorEndpoint(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function normalizeDaemonLockIdentity(lockPath: string): string {
  const resolved = path.resolve(lockPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveDaemonWorkerEndpoint(lockPath: string, supervisorToken: string, clientPid: number): DaemonLifecycleEndpoint {
  const endpointKey = crypto.createHash("sha256")
    .update(`${normalizeDaemonLockIdentity(lockPath)}\0${supervisorToken}\0${clientPid}`)
    .digest("hex");
  return resolveDaemonLifecycleEndpoint(endpointKey, "worker");
}

/** Worker 自持 endpoint，供新 supervisor 在不向 PID 发信号的前提下核验并请求退出。 */
async function holdCurrentDaemonWorkerEndpoint(
  lockPath: string,
  supervisorToken: string,
  clientPid: number,
): Promise<void> {
  if (currentDaemonWorkerEndpointServer?.listening) return;
  let stopAccepted = false;
  const server = net.createServer((socket) => {
    attachDaemonLifecycleSocketErrorHandler(socket);
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += String(chunk);
      if (input.length > 512) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      if (input.trim() === `status:${supervisorToken}`) {
        socket.end(JSON.stringify({ schemaVersion: 1, clientPid: process.pid, startup: currentClientStartup }) + "\n");
        return;
      }
      if (input.trim() !== `stop:${supervisorToken}`) {
        socket.destroy();
        return;
      }
      socket.end("accepted\n");
      if (stopAccepted) return;
      stopAccepted = true;
      setImmediate(() => {
        if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM");
        else process.exit(0);
      });
    });
  });
  const endpoint = resolveDaemonWorkerEndpoint(lockPath, supervisorToken, clientPid);
  const acquired = await listenDaemonLifecycleEndpoint(server, endpoint);
  if (!acquired) throw new Error(`CodeFlow client worker endpoint 已被占用 clientPid=${clientPid}`);
  server.unref();
  currentDaemonWorkerEndpointServer = server;
}

/** 有界实时探测；旧版 worker、超时、无效响应一律按未就绪处理。 */
function probeDaemonWorkerStartup(lockPath: string, token: string, clientPid: number, timeoutMs: number): Promise<ClientStartupSnapshot | null> {
  const endpoint = resolveDaemonWorkerEndpoint(lockPath, token, clientPid);
  return new Promise(resolve => {
    let settled = false;
    let output = "";
    const socket = endpoint.kind === "ipc" ? net.createConnection({ path: endpoint.path })
      : net.createConnection({ host: endpoint.host, port: endpoint.port });
    const finish = (snapshot: ClientStartupSnapshot | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolve(snapshot);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`status:${token}\n`));
    socket.on("data", chunk => {
      output += String(chunk);
      if (output.length > 4096) return finish(null);
      if (!output.includes("\n")) return;
      try {
        const value = JSON.parse(output.trim());
        finish(value.schemaVersion === 1 && value.clientPid === clientPid ? parseClientStartupSnapshot(value.startup) : null);
      } catch { finish(null); }
    });
    socket.once("error", () => finish(null));
    socket.once("close", () => finish(null));
  });
}

/** 通过 worker 自持 endpoint 请求退出；连接失败时拒绝按 PID 猜测身份。 */
function requestVerifiedDaemonWorkerStop(
  lockPath: string,
  supervisorToken: string,
  clientPid: number,
): Promise<void> {
  const endpoint = resolveDaemonWorkerEndpoint(lockPath, supervisorToken, clientPid);
  return requestDaemonStopEndpoint(endpoint, `stop:${supervisorToken}\n`, `worker clientPid=${clientPid}`);
}

/** 通过 supervisor owner endpoint 请求优雅停止其持有的 Client。 */
export function requestVerifiedDaemonSupervisorStop(lockPath: string, supervisorToken: string, supervisorPid: number): Promise<void> {
  const endpointKey = crypto.createHash("sha256")
    .update(normalizeDaemonLockIdentity(lockPath))
    .digest("hex");
  const endpoint = resolveDaemonLifecycleEndpoint(endpointKey, "supervisor");
  return requestDaemonStopEndpoint(endpoint, `stop:${supervisorToken}\n`, `supervisor supervisorPid=${supervisorPid}`);
}

/** 通过 supervisor owner endpoint 请求强制停止其持有的 Client。 */
function requestVerifiedDaemonSupervisorForceStop(lockPath: string, supervisorToken: string, supervisorPid: number): Promise<void> {
  const endpointKey = crypto.createHash("sha256")
    .update(normalizeDaemonLockIdentity(lockPath))
    .digest("hex");
  const endpoint = resolveDaemonLifecycleEndpoint(endpointKey, "supervisor");
  return requestDaemonStopEndpoint(endpoint, `force-stop:${supervisorToken}\n`, `supervisor supervisorPid=${supervisorPid}`);
}

/** 向已定位的本机 daemon endpoint 发送停止指令并等待明确接受。 */
function requestDaemonStopEndpoint(
  endpoint: DaemonLifecycleEndpoint,
  command: string,
  target: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const socket = endpoint.kind === "ipc"
      ? net.createConnection({ path: endpoint.path })
      : net.createConnection({ host: endpoint.host, port: endpoint.port });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`等待 daemon endpoint 响应超时 ${target}`));
    }, DAEMON_STOP_RESPONSE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(command));
    socket.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("accepted\n")) finish();
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error(`daemon endpoint 未确认退出请求 ${target}`));
    });
  });
}

/** 仅对“端点尚不存在”做有限重试；超时或协议错误仍拒绝接管。 */
async function requestVerifiedDaemonWorkerStopWhenReachable(
  lockPath: string,
  supervisorToken: string,
  clientPid: number,
  graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (true) {
    try {
      await requestVerifiedDaemonWorkerStop(lockPath, supervisorToken, clientPid);
      return true;
    } catch (error) {
      if (!isMissingDaemonEndpointError(error)) throw error;
      if (Date.now() >= deadline) return false;
      await waitForDelay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }
}

function isMissingDaemonEndpointError(error: unknown): boolean {
  return isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ECONNREFUSED");
}

/** 读取 supervisor 锁；损坏文件不自动删除，避免不确定所有权下启动第二实例。 */
function readDaemonSupervisorLock(lockPath: string): DaemonSupervisorLockPayload {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`CodeFlow client supervisor lock 无法解析，请人工检查：${lockPath}`, { cause: error });
  }
  const token = String(parsed.token ?? "").trim();
  const pid = Number(parsed.pid ?? 0);
  const startedAt = String(parsed.startedAt ?? "").trim();
  if (!isCanonicalUuid(token) || !Number.isInteger(pid) || pid <= 0 || !startedAt || !Number.isFinite(Date.parse(startedAt))) {
    throw new Error(`CodeFlow client supervisor lock 内容无效，请人工检查：${lockPath}`);
  }
  return { token, pid, startedAt };
}

/** 元数据损坏不影响 OS 端点的真实互斥；当前 owner 会在获得端点后覆盖它。 */
function readDaemonSupervisorLockIfValid(lockPath: string): DaemonSupervisorLockPayload | null {
  try {
    return readDaemonSupervisorLock(lockPath);
  } catch {
    return null;
  }
}

/** 仅清理指定 PID 对应的 daemon 状态，避免启动早退留下 stale pid。 */
export function clearDaemonStateForPid(statePath: string, pid: number): boolean {
  const state = readDaemonState(statePath);
  if (!state || (state.pid !== pid && state.clientPid !== pid)) return false;
  removeFileIfExists(statePath);
  return true;
}

/** 仅清理仍属于指定 token 的 v2 状态，避免孤儿退出时删除新 owner 状态。 */
function clearDaemonStateForSupervisorToken(statePath: string, supervisorToken: string): boolean {
  const state = readDaemonState(statePath);
  if (state?.schemaVersion !== 2 || state.supervisorToken !== supervisorToken) return false;
  removeFileIfExists(statePath);
  return true;
}

function buildLegacyDaemonState(
  pid: number,
  paths: { stdoutPath: string; stderrPath: string },
): LegacyDaemonState {
  return {
    schemaVersion: 1,
    pid,
    supervisorPid: null,
    clientPid: pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  };
}

/** 解析 supervisor 状态枚举，拒绝未知状态继续运行。 */
function isDaemonStatus(value: string): value is SupervisedDaemonState["status"] {
  return value === "starting"
    || value === "running"
    || value === "restarting"
    || value === "blocked"
    || value === "cooldown"
    || value === "failed";
}

/** 解析最近一次退出快照，损坏数据必须显式报错。 */
function parseDaemonExitSnapshot(value: unknown, statePath: string): DaemonExitSnapshot | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`CodeFlow client daemon lastExit 无效，请人工检查：${statePath}`);
  }
  const raw = value as Record<string, unknown>;
  const code = raw.code == null ? null : Number(raw.code);
  const signal = raw.signal == null ? null : String(raw.signal) as NodeJS.Signals;
  const at = String(raw.at ?? "").trim();
  const uptimeMs = Number(raw.uptimeMs ?? -1);
  const error = raw.error == null ? null : String(raw.error);
  if ((code != null && !Number.isInteger(code)) || !at || !Number.isFinite(uptimeMs) || uptimeMs < 0) {
    throw new Error(`CodeFlow client daemon lastExit 无效，请人工检查：${statePath}`);
  }
  return { code, signal, at, uptimeMs, error };
}

/** v2 只有 supervisor 存活才代表 Client 仍受守护；v1 沿用单进程语义。 */
function isDaemonSupervisorRunning(state: DaemonState): boolean {
  return state.schemaVersion === 1
    ? isProcessRunning(state.clientPid)
    : isProcessRunning(state.supervisorPid);
}

/** 输出 daemon 的真实 supervisor/Client 进程状态。 */
function printDaemonState(state: DaemonState, supervisorRunningOverride?: boolean): void {
  if (state.schemaVersion === 1) {
    console.log(`[codeflowai] 后台 client 运行中 pid=${state.clientPid}（旧版启动模式，无异常守护）`);
    return;
  }
  const supervisorRunning = supervisorRunningOverride ?? isProcessRunning(state.supervisorPid);
  const clientRunning = isProcessRunning(state.clientPid ?? 0);
  console.log(`[codeflowai] 后台 client 状态=${state.status} supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"} supervisorRunning=${supervisorRunning} clientRunning=${clientRunning} restartCount=${state.restartCount}`);
  if (state.nextRetryAt) console.log(`[codeflowai] nextRetryAt: ${state.nextRetryAt}`);
}

/** 写入一次性 supervisor 控制意图，供子进程退出时完成明确对账。 */
function writeDaemonControl(controlPath: string, control: DaemonControl): void {
  writeJsonFileAtomic(controlPath, control);
}

/** 优先消费 stop，再消费 restart，避免并发升级覆盖人工停止。 */
function consumeDaemonControl(
  paths: DaemonPaths,
  supervisorPid: number,
  supervisorToken: string | null,
  clientPid: number,
): DaemonControl | null {
  const stopControlPath = resolveDaemonControlPath(paths.stopControlPath, supervisorToken);
  const restartControlPath = resolveDaemonControlPath(paths.restartControlPath, supervisorToken);
  if (fs.existsSync(stopControlPath)) {
    const stop = consumeDaemonControlFile(
      stopControlPath,
      "stop",
      supervisorPid,
      supervisorToken,
      clientPid,
    );
    if (stop) return stop;
  }
  if (fs.existsSync(restartControlPath)) {
    return consumeDaemonControlFile(
      restartControlPath,
      "restart",
      supervisorPid,
      supervisorToken,
      clientPid,
    );
  }
  return null;
}

/** 消费属于当前 supervisor/Client 的单个控制文件，冲突时显式失败。 */
function consumeDaemonControlFile(
  controlPath: string,
  expectedAction: DaemonControl["action"],
  supervisorPid: number,
  supervisorToken: string | null,
  clientPid: number,
): DaemonControl | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(controlPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`CodeFlow client daemon 控制文件无法解析，请人工检查：${controlPath}`, { cause: error });
  }
  const action = String(parsed.action ?? "");
  const targetSupervisorPid = Number(parsed.supervisorPid ?? 0);
  const targetSupervisorToken = parsed.supervisorToken == null
    ? null
    : String(parsed.supervisorToken).trim() || null;
  const targetClientPid = parsed.clientPid == null ? null : Number(parsed.clientPid);
  const requestedAt = String(parsed.requestedAt ?? "").trim();
  if (
    (action !== "stop" && action !== "restart")
    || !Number.isInteger(targetSupervisorPid)
    || targetSupervisorPid <= 0
    || (targetSupervisorToken != null && !isCanonicalUuid(targetSupervisorToken))
    || (targetClientPid != null && (!Number.isInteger(targetClientPid) || targetClientPid <= 0))
    || !requestedAt
  ) {
    throw new Error(`CodeFlow client daemon 控制文件无效，请人工检查：${controlPath}`);
  }
  if (
    targetSupervisorPid !== supervisorPid
    || targetSupervisorToken !== supervisorToken
    || (action === "restart" && targetClientPid !== clientPid)
  ) {
    return null;
  }
  if (action !== expectedAction) return null;
  fs.unlinkSync(controlPath);
  return {
    action,
    supervisorPid: targetSupervisorPid,
    supervisorToken: targetSupervisorToken,
    clientPid: targetClientPid,
    requestedAt,
  };
}

/** 冷却期间消费 stop；Windows 不能依赖 SIGTERM 触发 supervisor 的 finally。 */
function consumePendingDaemonStop(
  paths: DaemonPaths,
  supervisorPid: number,
  supervisorToken: string | null,
  clientPid: number,
): boolean {
  const stopControlPath = resolveDaemonControlPath(paths.stopControlPath, supervisorToken);
  if (!fs.existsSync(stopControlPath)) return false;
  return consumeDaemonControlFile(
    stopControlPath,
    "stop",
    supervisorPid,
    supervisorToken,
    clientPid,
  ) != null;
}

function resolveDaemonControlPath(basePath: string, supervisorToken: string | null): string {
  if (supervisorToken != null && !isCanonicalUuid(supervisorToken)) {
    throw new Error("CodeFlow client supervisor token 无效，拒绝解析控制文件路径");
  }
  return supervisorToken ? `${basePath}.${supervisorToken}` : basePath;
}

/** 只清理当前 owner 的控制文件；固定旧路径仅在持有 endpoint 时兼容清理。 */
function removeDaemonControlFiles(
  paths: Pick<DaemonPaths, "stopControlPath" | "restartControlPath">,
  supervisorToken: string | null,
): void {
  removeFileIfExists(resolveDaemonControlPath(paths.stopControlPath, supervisorToken));
  removeFileIfExists(resolveDaemonControlPath(paths.restartControlPath, supervisorToken));
  if (supervisorToken) {
    removeFileIfExists(paths.stopControlPath);
    removeFileIfExists(paths.restartControlPath);
  }
}

/** 等待子进程终态，同时保留 spawn error 作为退出证据。 */
function waitForChildExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string | null }> {
  return new Promise((resolve) => {
    let spawnError: string | null = null;
    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.once("close", (code, signal) => resolve({ code, signal, error: spawnError }));
  });
}

/** 停止指定进程；进程已退出按幂等成功处理。 */
function signalProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return false;
    throw error;
  }
}

/** 由 supervisor 强制结束自己持有的受管子进程。 */
function forceKillProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return false;
    throw error;
  }
}

/** 删除可选状态文件；不存在按幂等成功处理。 */
function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

/** 以同目录原子替换写入 JSON，避免跨进程读取半截状态。 */
function writeJsonFileAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameDaemonJsonWithRetry(tempPath, filePath);
  } catch (error) {
    try {
      removeFileIfExists(tempPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `写入 daemon JSON 失败且临时文件清理失败：${filePath}`);
    }
    throw error;
  }
}

/** 读取可选 supervisor PID；已配置但非法时显式失败。 */
function readDaemonSupervisorPidFromEnv(): number | null {
  const raw = String(process.env[DAEMON_SUPERVISOR_PID_ENV] ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`无效的 CodeFlow client supervisor PID：${raw}`);
  }
  return parsed;
}

/** 新 supervisor 会携带随机 owner token；null 仅用于兼容升级前的旧 supervisor。 */
function readDaemonSupervisorTokenFromEnv(): string | null {
  const token = String(process.env[DAEMON_SUPERVISOR_TOKEN_ENV] ?? "").trim();
  if (!token) return null;
  if (!isCanonicalUuid(token)) throw new Error("无效的 CodeFlow client supervisor token");
  return token;
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** 使用短定时器等待退避或轮询周期。 */
function waitForDelay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)));
}

/** 退避期间短轮询停止信号，避免 `codeflow --stop` 被长延迟阻塞。 */
async function waitForDelayOrStop(timeoutMs: number, shouldStop: () => boolean): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!shouldStop() && Date.now() < deadline) {
    await waitForDelay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
}

/** 由 Worker 入口定位轻量 supervisor 源码或发布 bundle。 */
export function resolveClientDaemonSupervisorEntryPath(workerEntryPath: string): string {
  const entryPath = path.resolve(workerEntryPath);
  const parentName = path.basename(path.dirname(entryPath)).toLowerCase();
  const extension = path.extname(entryPath).toLowerCase();
  if (parentName === "bin") {
    return path.resolve(path.dirname(entryPath), "..", "dist", "clientDaemonSupervisor.cjs");
  }
  if (extension === ".ts" || extension === ".tsx") {
    return path.join(path.dirname(entryPath), "clientDaemonSupervisor.ts");
  }
  if (extension === ".cjs" || extension === ".js" || extension === ".mjs") {
    return path.join(path.dirname(entryPath), "clientDaemonSupervisor.cjs");
  }
  throw new Error(`无法由 Client 入口定位 supervisor：${entryPath}`);
}

/** 获取当前 CLI 入口，保证 npm bin 与 dev tsx 场景都能复用同一路径。 */
function resolveCurrentEntryPath(): string {
  const entry = String(process.argv[1] ?? "").trim();
  if (!entry) {
    throw new Error("无法定位当前 codeflow 启动入口");
  }
  return path.resolve(entry);
}

/** 判断 PID 是否仍存活；权限不足说明进程存在但当前用户不可探测。 */
function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return false;
    if (isNodeErrorCode(error, "EPERM")) return true;
    throw error;
  }
}

/** 并发启动的 loser 等待 owner 发布状态，随后按“已运行”正常返回。 */
async function waitForActiveDaemonState(paths: DaemonPaths, timeoutMs: number): Promise<DaemonState | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const state = readDaemonState(paths.statePath);
    const lock = readDaemonSupervisorLockIfValid(paths.supervisorLockPath);
    if (
      state?.schemaVersion === 2
      && lock?.pid === state.supervisorPid
      && lock.token === state.supervisorToken
      && await isDaemonSupervisorEndpointHeld(paths.supervisorLockPath)
    ) {
      return state;
    }
    await waitForDelay(50);
  }
  return null;
}

type InitialConnectionOutcome =
  | { outcome: "succeeded"; readiness: Awaited<ReturnType<typeof readClientDaemonReadiness>> }
  | { outcome: "failed" | "timeout" };

/** 普通/显式启动在同一截止时间内探测，返回最后一次实时核验成功的结果。 */
async function waitForInitialConnectionOutcome(
  paths: DaemonPaths,
  initialState: SupervisedDaemonState,
  timeoutMs: number,
): Promise<InitialConnectionOutcome> {
  const supervisorPid = initialState.supervisorPid;
  const startedAt = Date.now();
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastProgressPrintAt = 0;
  let previousStage: ClientStartupStage | null = null;
  let printedServer: string | null = null;
  while (true) {
    let now = Date.now();
    const state = readDaemonState(paths.statePath);
    if (state?.schemaVersion === 2 && state.supervisorPid === supervisorPid) {
      if (state.supervisorToken !== initialState.supervisorToken) return { outcome: "failed" };
      if (state.initialConnection === "failed" || isDaemonStartupFailureStatus(state.status) || state.startup?.stage === "failed") return { outcome: "failed" };
      if (!isProcessRunning(supervisorPid)) return { outcome: "failed" };
      if (now >= deadline) return { outcome: "timeout" };
      if (state.startup?.stage === "ready" || state.startup?.stage === "degraded") {
        const readiness = await readClientDaemonReadiness(paths, state, deadline);
        if (readiness.connected) return { outcome: "succeeded", readiness };
        now = Date.now();
      }
      const stage = state.startup?.stage === "ready" ? "synchronizing" : state.startup?.stage ?? "starting";
      if (stage !== previousStage || now - lastProgressPrintAt >= 5000) {
        console.log(formatClientStartupProgress(stage, now - startedAt));
        previousStage = stage; lastProgressPrintAt = now;
      }
      if (state.startup?.serverUrl && printedServer !== state.startup.serverUrl) {
        printedServer = state.startup.serverUrl;
        console.log(`[codeflowai] 服务器：${printedServer}`);
      }
    } else if (state || !isProcessRunning(supervisorPid)) {
      return { outcome: "failed" };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { outcome: "timeout" };
    await waitForDelay(Math.min(100, remainingMs));
  }
}

/** Windows 读取者短暂占用目标文件时重试原子替换，其他错误立即失败。 */
function renameDaemonJsonWithRetry(tempPath: string, targetPath: string): void {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= DAEMON_JSON_RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const retryable = process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES");
      if (!retryable || attempt >= DAEMON_JSON_RENAME_RETRY_DELAYS_MS.length) throw error;
      const delayMs = DAEMON_JSON_RENAME_RETRY_DELAYS_MS[attempt] ?? 0;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 将 supervisor 已明确进入不可用状态判为普通启动失败。 */
function isDaemonStartupFailureStatus(status: SupervisedDaemonState["status"] | null | undefined): boolean {
  return status === "restarting"
    || status === "blocked"
    || status === "cooldown"
    || status === "failed";
}

/** 请求已核验 daemon 完整退出；未在时限内释放 owner 时显式失败。 */
async function requestVerifiedDaemonShutdownForState(paths: DaemonPaths, state: SupervisedDaemonState): Promise<void> {
  if (!state.supervisorToken) {
    throw new Error(`后台 supervisor 缺少 owner token supervisorPid=${state.supervisorPid}`);
  }
  writeDaemonControl(resolveDaemonControlPath(paths.stopControlPath, state.supervisorToken), {
    action: "stop",
    supervisorPid: state.supervisorPid,
    supervisorToken: state.supervisorToken,
    clientPid: state.clientPid,
    requestedAt: new Date().toISOString(),
  });
  let workerStopError: Error | null = null;
  if (state.clientPid) {
    try {
      await requestVerifiedDaemonWorkerStop(paths.supervisorLockPath, state.supervisorToken, state.clientPid);
    } catch (error) {
      workerStopError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const stopped = await waitForVerifiedDaemonShutdown(paths, state.supervisorToken, STOP_TIMEOUT_MS);
  if (stopped) return;

  const current = readDaemonState(paths.statePath);
  if (
    !current
    || current.schemaVersion !== 2
    || current.supervisorToken !== state.supervisorToken
  ) return;
  if (!await isMatchingDaemonSupervisorOwner(paths, current)) {
    throw new Error(
      `后台 supervisor 优雅停止超时后已无法核验 owner supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}`,
    );
  }

  logger.warn("client-daemon", "graceful daemon stop timed out; escalating to verified supervisor hard stop", {
    errorCode: "CLIENT_DAEMON_STOP_ESCALATED",
    supervisorPid: current.supervisorPid,
    clientPid: current.clientPid,
  });
  let supervisorStopError: Error | null = null;
  try {
    await requestVerifiedDaemonSupervisorForceStop(paths.supervisorLockPath, current.supervisorToken!, current.supervisorPid);
  } catch (error) {
    supervisorStopError = error instanceof Error ? error : new Error(String(error));
  }
  const forceStopped = await waitForVerifiedDaemonShutdown(paths, state.supervisorToken, STOP_TIMEOUT_MS);
  if (forceStopped) return;

  const timeoutError = new Error(
    `后台 supervisor 强制停止超时 supervisorPid=${state.supervisorPid} clientPid=${state.clientPid ?? "null"}`,
  );
  const failures = [workerStopError, supervisorStopError, timeoutError].filter((error): error is Error => error != null);
  if (failures.length > 1) {
    throw new AggregateError(failures, timeoutError.message);
  }
  throw failures[0] ?? timeoutError;
}

function resolveInitialConnectionWaitTimeoutMs(): number {
  const value = String(process.env.CODEFLOWAI_STARTUP_TIMEOUT_MS ?? "").trim();
  if (!value) return INITIAL_CONNECTION_WAIT_DEFAULT_MS;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return INITIAL_CONNECTION_WAIT_DEFAULT_MS;
  return Math.min(Math.max(Math.trunc(raw), 5_000), 24 * 60 * 60_000);
}

function hasExplicitApiKeyArg(argv: string[]): boolean {
  const command = parseClientCliArgs(argv);
  return (command.kind === "run" || command.kind === "daemon") && Boolean(command.apiKeyProvided);
}

/** 等待本次 spawn 的 supervisor 发布状态；孤儿清理可能显著长于早退观察窗口。 */
async function waitForSpawnedSupervisorState(
  statePath: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<SupervisedDaemonState | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const state = readDaemonState(statePath);
    if (state?.schemaVersion === 2 && state.supervisorPid === child.pid) return state;
    if (child.exitCode != null || child.signalCode != null) return null;
    await waitForDelay(50);
  }
  return null;
}

/** state、lock token 与 OS endpoint 必须同时一致，PID 仅作为元数据参与比对。 */
async function isMatchingDaemonSupervisorOwner(paths: DaemonPaths, state: SupervisedDaemonState, deadline = Number.POSITIVE_INFINITY): Promise<boolean> {
  if (!state.supervisorToken) return false;
  const before = readDaemonSupervisorLockIfValid(paths.supervisorLockPath);
  if (before?.pid !== state.supervisorPid || before.token !== state.supervisorToken) return false;
  if (!await isDaemonSupervisorEndpointHeld(paths.supervisorLockPath, deadline)) return false;
  const after = readDaemonSupervisorLockIfValid(paths.supervisorLockPath);
  return after?.pid === state.supervisorPid && after.token === state.supervisorToken;
}

/** 等待已核验 owner 退出；期间只通过 token 专属 worker endpoint 重试停止请求。 */
async function waitForVerifiedDaemonShutdown(
  paths: DaemonPaths,
  supervisorToken: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let nextWorkerRequestAt = 0;
  while (Date.now() < deadline) {
    const state = readDaemonState(paths.statePath);
    if (state?.schemaVersion === 2 && state.supervisorToken !== supervisorToken) return true;
    if (state?.schemaVersion === 1) return true;
    if (state?.schemaVersion === 2 && state.clientPid && Date.now() >= nextWorkerRequestAt) {
      nextWorkerRequestAt = Date.now() + 250;
      try {
        await requestVerifiedDaemonWorkerStop(paths.supervisorLockPath, supervisorToken, state.clientPid);
      } catch {
        // Worker 可能正处于 spawn 到 endpoint 建立之间，保持控制文件并继续轮询。
      }
    }
    const endpointHeld = await isDaemonSupervisorEndpointHeld(paths.supervisorLockPath);
    if (!endpointHeld) return true;
    const lock = readDaemonSupervisorLockIfValid(paths.supervisorLockPath);
    if (lock?.token !== supervisorToken) return true;
    await waitForDelay(100);
  }
  return false;
}

/** 等待后台子进程早退，用于避免明显配置错误被误报为启动成功。 */
function waitForEarlyExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value: { code: number | null; signal: NodeJS.Signals | null } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
}

/** 轮询等待指定 PID 退出。 */
function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (!isProcessRunning(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

/** 判断 Node 系统异常的 code，避免按 message 文本分支。 */
function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error != null && (error as NodeJS.ErrnoException).code === code;
}
