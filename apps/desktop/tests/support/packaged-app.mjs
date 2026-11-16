import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const webRequire = createRequire(new URL("../../../web/package.json", import.meta.url));
const { _electron: electron } = webRequire("@playwright/test");

/** 判断进程是否仍存在；ESRCH 表示已退出，其他错误向上抛出。 */
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

/** 每个外部操作独立限时，避免未完成 Promise 拖住验收。 */
export async function bounded(operation, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** 按真实状态轮询等待，不用固定延迟猜测启动或退出完成。 */
export async function waitUntil(predicate, milliseconds, code) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

/**
 * 只为打包应用保留系统启动变量，并把用户目录、临时目录全部隔离到 root。
 * 不继承 CODEFLOWAI_*、NODE_OPTIONS、NODE_PATH 或引擎配置，避免测试污染本机环境。
 */
export async function isolatedEnvironment(root, overrides = {}) {
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/iu;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const directories = {
    HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "local-appdata",
    CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
    TMP: "tmp", TEMP: "tmp", TMPDIR: "tmp",
  };
  for (const [key, directory] of Object.entries(directories)) {
    env[key] = path.join(root, directory);
    await fs.mkdir(env[key], { recursive: true });
  }
  env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return { ...env, ...overrides };
}

/** 打包态验收只接受 Windows 上仓库外的 .exe，避免误跑源码入口或覆盖工作区。 */
export async function assertPackagedExecutable(executablePath, repositoryRoot) {
  if (process.platform !== "win32") throw new Error("DESKTOP_PACKAGED_WINDOWS_REQUIRED");
  const resolved = await fs.realpath(path.resolve(executablePath));
  if (path.extname(resolved).toLowerCase() !== ".exe") throw new Error("DESKTOP_PACKAGED_EXE_REQUIRED");
  const relative = path.relative(await fs.realpath(repositoryRoot), resolved);
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    throw new Error("DESKTOP_PACKAGED_EXE_INSIDE_REPOSITORY");
  }
  return resolved;
}

/** 记录子进程输出与 PID，保留有限诊断且不阻塞管道。 */
export function observeProcess(child, observedPids) {
  if (child.pid) observedPids.add(child.pid);
  const run = { pid: child.pid, stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8").on("data", chunk => { run.stdout = (run.stdout + chunk).slice(-65_536); });
  child.stderr?.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-65_536); });
  return run;
}

/** 启动打包应用；返回 Playwright application、子进程与输出记录。 */
export async function launchPackagedApp({ executablePath, userDataDir, env, cwd, timeoutMs = 60_000, observedPids = new Set() }) {
  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env,
    cwd,
    timeout: timeoutMs,
  });
  const child = application.process();
  const run = observeProcess(child, observedPids);
  if (child.pid) observedPids.add(child.pid);
  return { application, child, run };
}

/** 仅终止本测试观测到的进程树；命令失败保留原始根因。 */
export async function killProcessTree(pid) {
  if (!alive(pid)) return;
  const result = spawnSync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`DESKTOP_PACKAGED_KILL_FAILED: pid=${pid}, status=${result.status}, ${result.stderr ?? ""}`);
  }
}

/** 关闭应用并确认所有已观测 PID 退出；任一残留或清理失败都显式抛出。 */
export async function closePackagedApp({ application, observedPids, children = [] }) {
  const failures = [];
  for (const pid of observedPids) {
    try {
      await killProcessTree(pid);
    } catch (error) {
      failures.push(error);
    }
  }
  if (application) {
    try {
      await bounded(application.close(), 5_000, "DESKTOP_PACKAGED_CONNECTION_CLOSE_TIMEOUT");
    } catch (error) {
      failures.push(error);
    }
  }
  for (const child of children) {
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    child?.unref?.();
  }
  const remaining = [...observedPids].filter(alive);
  if (remaining.length) failures.push(new Error(`DESKTOP_PACKAGED_PROCESSES_REMAIN: ${remaining.join(",")}`));
  if (failures.length) throw new AggregateError(failures, "DESKTOP_PACKAGED_CLEANUP_FAILED");
}
