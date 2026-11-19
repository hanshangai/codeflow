import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { assertDesktopStoragePath } from "./desktopStorageLocation.js";

/** 候选使用独立临时 profile，只启动 Electron 沙箱窗口，不读取业务资源或 SQLite。 */
export async function testShellProcess(input: { executablePath: string; temporaryParentDir?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
  await assertDesktopStoragePath(input.executablePath);
  const parent = await fs.realpath(input.temporaryParentDir ?? os.tmpdir());
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(parent, "cf-shell-selftest-")));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(input.executablePath, ["--codeflow-shell-self-test", temporary], {
        env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], timeout: input.timeoutMs ?? 30_000, signal: input.signal,
      });
      let primary: Error | undefined;
      child.stderr?.on("data", () => {});
      child.once("error", error => { primary = error; });
      child.once("close", (code, signal) => {
        if (primary) reject(primary);
        else if (code === 0 && signal === null) resolve();
        else reject(Object.assign(new Error("DESKTOP_SHELL_SELF_TEST_FAILED"), { code: "DESKTOP_SHELL_SELF_TEST_FAILED", exitCode: code, signal }));
      });
    });
  } catch (error) { failure = error; throw error; }
  finally {
    try { await fs.rm(temporary, { recursive: true }); }
    catch (cleanup) { throw failure === undefined ? cleanup : new AggregateError([failure, cleanup], "DESKTOP_SHELL_SELF_TEST_CLEANUP_FAILED"); }
  }
}

/** 仅在 Client 已退出后启动本安装携带的独立执行器；旧主进程退出前仍持有本次进程管理权。 */
export async function startAfterExitShellSwitch(input: {
  executablePath: string; installationDir: string; previous: string; target: string; pid: number; requestId: string;
  userDataDir: string; sessionDataDir: string;
}): Promise<{ check(): void; release(): void; cancel(): Promise<void> }> {
  const updater = path.join(path.dirname(input.executablePath), "resources", "shell-switch.exe");
  await assertDesktopStoragePath(updater);
  const stat = await fs.lstat(updater);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("DESKTOP_SHELL_SWITCH_EXECUTOR_INVALID");
  if (![input.previous, input.target].every(value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId)
    || !Number.isSafeInteger(input.pid) || input.pid < 1) throw new Error("DESKTOP_SHELL_SWITCH_ARGUMENT_INVALID");
  let child!: ChildProcess, failure: Error | undefined, closed = false;
  const closure = new Promise<void>(resolve => {
    child = spawn(updater, ["--root", input.installationDir, "--previous", input.previous, "--target", input.target,
      "--pid", String(input.pid), "--request-id", input.requestId, "--user-data-dir", input.userDataDir, "--session-data-dir", input.sessionDataDir], {
      cwd: input.installationDir, detached: true, windowsHide: true, stdio: "ignore",
    });
    child.on("error", error => { failure = error; });
    child.once("close", code => { closed = true; failure ??= Object.assign(new Error("DESKTOP_SHELL_SWITCH_EXITED_BEFORE_MAIN"), { exitCode: code }); resolve(); });
  });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return {
    /** 主进程退出前执行器不能提前结束。 */
    check() { if (failure) throw failure; if (closed) throw new Error("DESKTOP_SHELL_SWITCH_OWNER_RELEASED"); },
    /** 旧主进程明确退出时放弃句柄，执行器独立完成同一文件事务。 */
    release() { child.unref(); },
    /** 旧主进程尚未退出时可取消等待；失败仍保留当前应用的控制权。 */
    async cancel() {
      if (!closed && !child.kill()) throw new Error("DESKTOP_SHELL_SWITCH_CANCEL_FAILED");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closure, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DESKTOP_SHELL_SWITCH_CANCEL_TIMEOUT")), 10_000); })]);
      } finally { clearTimeout(timer); }
    },
  };
}
