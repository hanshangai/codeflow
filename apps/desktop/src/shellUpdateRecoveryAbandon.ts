import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { processSnapshot, type ProcessIdentity } from "./windowsProcessIdentity.js";
import { readShellLaunchState, type ShellLaunchState } from "./shellLaunchState.js";
import { createShellUpdateAttemptStore, isShellUpdateHandoffAttempt } from "./shellUpdateAttempt.js";

/** 只有连续恢复失败达到该次数才允许降级；此前保持原有失败语义。 */
export const SHELL_RECOVERY_ABANDON_THRESHOLD = 3;
const COUNTER_FILE = "shell-update-recovery-failures.json";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

export type ShellRecoveryAbandonInput = {
  dataDir: string;
  executablePath: string;
  pid: number;
  parentPid: number;
  /** 失败控制器必须已释放 helper，未释放时不得归档唯一更新事实。 */
  ownerReleased: boolean;
  snapshot?: () => Promise<readonly ProcessIdentity[]>;
};
export type ShellRecoveryAbandonResult = { abandoned: boolean; failures: number; requestId?: string; archive?: string; reason?: string };

/** 降级只发生在从未提交准入、仍选择原壳且旧执行者全部退出时；其余情况继续失败。 */
export function shouldAbandonShellUpdateRecovery(input: { failures: number; admission: unknown; ownerReleased: boolean;
  launchState: ShellLaunchState; originalState: ShellLaunchState; aliveRecordedProcess: boolean }): boolean {
  return input.failures >= SHELL_RECOVERY_ABANDON_THRESHOLD && input.admission === null && input.ownerReleased
    && !input.aliveRecordedProcess
    && input.launchState.activeShellId === input.originalState.activeShellId
    && input.launchState.previousShellId === input.originalState.previousShellId
    && input.launchState.baselineShellId === input.originalState.baselineShellId;
}

/** 记录一次恢复失败；达到阈值且安全条件成立时归档尝试，让下次启动回到普通启动。 */
export async function abandonStalledShellUpdateRecovery(input: ShellRecoveryAbandonInput): Promise<ShellRecoveryAbandonResult> {
  const store = createShellUpdateAttemptStore(input.dataDir);
  const attempt = await store.read();
  if (!attempt || !isShellUpdateHandoffAttempt(attempt)) {
    await clearFailures(input.dataDir);
    return { abandoned: true, failures: 0, reason: "no-attempt" };
  }
  if (!REQUEST_ID.test(attempt.requestId)) throw failure("DESKTOP_SHELL_RECOVERY_ABANDON_REQUEST_INVALID");
  const failures = await recordFailure(input.dataDir, attempt.requestId);
  if (failures < SHELL_RECOVERY_ABANDON_THRESHOLD) {
    return { abandoned: false, failures, requestId: attempt.requestId, reason: "threshold-not-reached" };
  }
  const launch = await readShellLaunchState(attempt.installationDir);
  const processes = await (input.snapshot ?? processSnapshot)();
  const caller = processes.find(item => item.pid === input.pid);
  if (!caller || caller.parentPid !== input.parentPid || caller.executable !== input.executablePath) {
    throw failure("DESKTOP_SHELL_RECOVERY_ABANDON_PROCESS_INVALID");
  }
  const recorded = [attempt.helper, attempt.oldMain, ...(attempt.selectedMain ? [attempt.selectedMain] : []),
    ...(attempt.recovery ? [attempt.recovery.controller, attempt.recovery.helper, ...(attempt.recovery.main ? [attempt.recovery.main] : [])] : [])];
  const aliveRecordedProcess = recorded.some(identity => processes.some(item => item.pid === identity.pid));
  if (!shouldAbandonShellUpdateRecovery({ failures, admission: attempt.admission, ownerReleased: input.ownerReleased,
    launchState: launch.state, originalState: attempt.originalState, aliveRecordedProcess })) {
    return { abandoned: false, failures, requestId: attempt.requestId, reason: "safety-condition-failed" };
  }
  const archive = await archiveAttempt(input.dataDir, attempt.requestId);
  await clearFailures(input.dataDir);
  return { abandoned: true, failures, requestId: attempt.requestId, archive };
}

/** 计数器与尝试同目录；读取失败视为首次失败，不因坏文件放宽阈值。 */
async function recordFailure(dataDir: string, requestId: string): Promise<number> {
  const file = path.join(dataDir, "logs", COUNTER_FILE);
  let failures = 0;
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as { schemaVersion?: unknown; requestId?: unknown; failures?: unknown };
    if (value.schemaVersion === 1 && value.requestId === requestId && Number.isSafeInteger(value.failures) && (value.failures as number) >= 0) {
      failures = value.failures as number;
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw Object.assign(new Error("DESKTOP_SHELL_RECOVERY_COUNTER_INVALID", { cause }),
        { code: "DESKTOP_SHELL_RECOVERY_COUNTER_INVALID" });
    }
  }
  const next = failures + 1;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, requestId, failures: next })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
  return next;
}

async function clearFailures(dataDir: string): Promise<void> {
  try { await fs.rm(path.join(dataDir, "logs", COUNTER_FILE)); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
}

/** 原始字节归档到日志目录；归档路径先证明不存在，避免覆盖历史证据。 */
async function archiveAttempt(dataDir: string, requestId: string): Promise<string> {
  const target = path.join(dataDir, "shell-update-attempt.json");
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure("DESKTOP_SHELL_RECOVERY_ABANDON_ATTEMPT_INVALID");
  const logs = path.join(dataDir, "logs");
  await fs.mkdir(logs, { recursive: true });
  const archive = path.join(logs, `shell-update-retired-recovery-${requestId}-${crypto.randomUUID()}.json`);
  try { await fs.lstat(archive); throw failure("DESKTOP_SHELL_RECOVERY_ABANDON_ARCHIVE_EXISTS"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  await fs.rename(target, archive);
  return archive;
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}
