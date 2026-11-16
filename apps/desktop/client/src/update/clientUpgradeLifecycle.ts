import type { ClientDaemonProcessSnapshot } from "../clientDaemon.js";

export type ClientUpgradeCommandResult = { status: number | null; error?: Error; stdout?: string };
export type ClientUpgradeCommand = (args: string[]) => ClientUpgradeCommandResult;
export type ClientUpgradeResult = { restarted: boolean; degraded: boolean };

export class ClientUpgradeLifecycleError extends Error {
  readonly code = "CLIENT_UPGRADE_LIFECYCLE_FAILED";
  constructor(readonly stage: string, cause: unknown, readonly recoveryError?: unknown) {
    super(`Client 升级阶段 ${stage} 失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

function checked(run: ClientUpgradeCommand, args: string[]): ClientUpgradeCommandResult {
  const result = run(args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codeflow ${args.join(" ")} 退出码：${result.status}`);
  return result;
}

/** 检查磁盘新入口的版本，不读取升级器内存中的旧版 bundle 常量。 */
export function verifyClientUpgradeVersion(run: ClientUpgradeCommand, expected: string): void {
  const version = checked(run, ["--version"]).stdout?.trim();
  if (!version || version !== expected) throw new Error(`升级后版本不符，期望 ${expected}，实际 ${version || "unknown"}`);
}

/** 必须是新工作进程的实时连接；资产受限保留告警，不再次阻断已连接 Client 的升级。 */
export function verifyClientUpgradeConnection(run: ClientUpgradeCommand, previous: ClientDaemonProcessSnapshot): boolean {
  const result = checked(run, ["--connected"]);
  const value = JSON.parse(result.stdout || "{}");
  if (value.schemaVersion !== 1 || value.connected !== true || value.clientRunning !== true
    || value.supervisorRunning !== true || !Number.isInteger(value.clientPid) || value.clientPid <= 0
    || !["ready", "degraded"].includes(value.stage)) throw new Error("升级后工作进程未确认连接服务器");
  if (value.clientPid === previous.clientPid) throw new Error("升级后仍是原 Client 工作进程");
  return value.stage === "degraded";
}

/** 使用安装前快照。停进程失败不安装；安装失败尝试恢复，但绝不因此把升级失败改成成功。 */
export function runPosixClientUpgrade(input: {
  previous: ClientDaemonProcessSnapshot;
  expectedVersion: string;
  verifyPackage: () => void;
  run: ClientUpgradeCommand;
  install: () => void;
}): ClientUpgradeResult {
  let stage = "prepare";
  let stopped = false;
  try {
    input.verifyPackage();
    stage = "stop";
    if (input.previous.running) {
      checked(input.run, ["--stop"]);
      stopped = true;
    }
    stage = "install";
    input.install();
    stage = "version";
    verifyClientUpgradeVersion(input.run, input.expectedVersion);
    if (!input.previous.running) return { restarted: false, degraded: false };
    stage = "restart";
    checked(input.run, ["--daemon"]);
    stage = "connection";
    return { restarted: true, degraded: verifyClientUpgradeConnection(input.run, input.previous) };
  } catch (cause) {
    let recoveryError: unknown;
    if (stopped && (stage === "install" || stage === "version")) {
      try { checked(input.run, ["--daemon"]); } catch (error) { recoveryError = error; }
    }
    throw new ClientUpgradeLifecycleError(stage, cause, recoveryError);
  }
}
