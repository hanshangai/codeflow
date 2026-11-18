import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import syncFs from "node:fs";
import { processSnapshot } from "./windowsProcessIdentity.js";
import { readShellLaunchState, type ShellLaunchState } from "./shellLaunchState.js";
import { createShellUpdateAttemptStore, isShellUpdateHandoffAttempt } from "./shellUpdateAttempt.js";
import { retireShellUpdateAttempt } from "./shellHandoff.js";
import { assertDesktopStoragePath, readDesktopJsonFile } from "./desktopStorageLocation.js";

/** 只有连续恢复失败达到该次数才允许降级；此前保持原有失败语义。 */
export const SHELL_RECOVERY_ABANDON_THRESHOLD = 3;
const COUNTER_FILE = "shell-update-recovery-failures.json";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;

export type ShellRecoveryAbandonInput = {
  dataDir: string;
  executablePath: string;
  pid: number;
  parentPid: number;
  userDataDir: string;
  sessionDataDir: string;
  argv: string[];
  /** 失败控制器必须已释放 helper，未释放时不得归档唯一更新事实。 */
  ownerReleased: boolean;
  snapshot?: typeof processSnapshot;
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
  if (!attempt || !isShellUpdateHandoffAttempt(attempt)) return { abandoned: false, failures: 0, reason: "handoff-required" };
  if (!input.ownerReleased) return { abandoned: false, failures: 0, requestId: attempt.requestId, reason: "owner-not-released" };
  if (!REQUEST_ID.test(attempt.requestId)) throw failure("DESKTOP_SHELL_RECOVERY_ABANDON_REQUEST_INVALID");
  const failures = await recordFailure(input.dataDir, attempt.requestId);
  if (failures < SHELL_RECOVERY_ABANDON_THRESHOLD) {
    return { abandoned: false, failures, requestId: attempt.requestId, reason: "threshold-not-reached" };
  }
  const launch = await readShellLaunchState(attempt.installationDir);
  if (!shouldAbandonShellUpdateRecovery({ failures, admission: attempt.admission, ownerReleased: input.ownerReleased,
    launchState: launch.state, originalState: attempt.originalState, aliveRecordedProcess: false })) {
    return { abandoned: false, failures, requestId: attempt.requestId, reason: "safety-condition-failed" };
  }
  // 完整库存、签名 binding 与归档 expected 均由既有 owner 复验，不能旁路重命名。
  await retireShellUpdateAttempt({ ...input, installationDir: attempt.installationDir, recoveryFailures: failures, expectedAttempt: attempt });
  await clearFailures(input.dataDir);
  return { abandoned: true, failures, requestId: attempt.requestId };
}

/** 仅不存在表示首次失败；坏记录显式失败，切换到另一有效尝试才重置计数。 */
async function recordFailure(dataDir: string, requestId: string): Promise<number> {
  const file = path.join(dataDir, "logs", COUNTER_FILE);
  const guard = await counterBoundary(dataDir);
  let failures = 0;
  const value = await readDesktopJsonFile(file) as { schemaVersion?: unknown; requestId?: unknown; failures?: unknown } | null;
  guard();
  if (value !== null) {
    if (value.schemaVersion !== 1 || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)
      || !Number.isSafeInteger(value.failures) || (value.failures as number) < 1 || (value.failures as number) > SHELL_RECOVERY_ABANDON_THRESHOLD) {
      throw failure("DESKTOP_SHELL_RECOVERY_COUNTER_INVALID");
    }
    if (value.requestId === requestId) failures = value.failures as number;
  }
  const next = Math.min(failures + 1, SHELL_RECOVERY_ABANDON_THRESHOLD);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  guard();
  syncFs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, requestId, failures: next })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
  guard(); syncFs.renameSync(temporary, file); guard();
  return next;
}

/** 成功归档后清除本次计数；路径或 I/O 异常继续上抛。 */
async function clearFailures(dataDir: string): Promise<void> {
  const guard = await counterBoundary(dataDir);
  guard();
  try { syncFs.unlinkSync(path.join(dataDir, "logs", COUNTER_FILE)); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  guard();
}

/** 沿既有存储路径校验绑定数据与日志实体；同步写入前后拒绝目录替换或链接。 */
async function counterBoundary(dataDir: string): Promise<() => void> {
  await assertDesktopStoragePath(dataDir);
  const data = syncFs.lstatSync(dataDir, { bigint: true }), logs = path.join(dataDir, "logs");
  try { await fs.mkdir(logs); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  await assertDesktopStoragePath(logs);
  const directory = syncFs.lstatSync(logs, { bigint: true });
  const guard = (): void => {
    for (let current = logs; ; current = path.dirname(current)) {
      const entry = syncFs.lstatSync(current, { bigint: true }), real = syncFs.lstatSync(syncFs.realpathSync.native(current), { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== real.dev || entry.ino !== real.ino) throw failure("DESKTOP_SHELL_RECOVERY_COUNTER_PATH_CHANGED");
      const expected = current === logs ? directory : current === dataDir ? data : undefined;
      if (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino || entry.birthtimeNs !== expected.birthtimeNs)) throw failure("DESKTOP_SHELL_RECOVERY_COUNTER_PATH_CHANGED");
      if (path.dirname(current) === current) return;
    }
  };
  guard(); return guard;
}

/** 只返回可检索错误码，不把路径或进程正文放入异常消息。 */
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}
