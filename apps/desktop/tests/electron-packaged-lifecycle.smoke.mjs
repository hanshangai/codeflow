import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-d17d-"));
const reportPath = path.join(root, "verification.json");
const report = { requestId: crypto.randomUUID(), status: "running", root, runs: [],
  scope: "windows_packaged_idle_lifecycle", trayMenuClickExercised: false };
const observedPids = new Set();
const children = [];
let application, env, verificationError;

/** PID 查询仅将 ESRCH 视为已退出，权限和其他查询错误继续失败。 */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** 每个外部操作独立限时；失败由拥有本次进程的顶层统一清理。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 按实际窗口/进程状态等待，不用固定延迟猜测启动或唤回完成。 */
async function waitUntil(predicate, milliseconds, code) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

/** 仅保留系统启动条件，用户目录及临时文件全部隔离在本次根。 */
async function isolatedEnvironment() {
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i;
  const result = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR"]) {
    result[key] = path.join(root, key.toLowerCase());
    await fs.mkdir(result[key]);
  }
  result.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return result;
}

/** 为本片创建的子进程保留退出状态与有限诊断，避免未读管道阻塞。 */
function observe(child, phase) {
  children.push(child);
  if (child.pid) observedPids.add(child.pid);
  const result = { phase, pid: child.pid, stderr: "" };
  child.stdout?.resume();
  child.stderr?.setEncoding("utf8").on("data", chunk => { result.stderr = (result.stderr + chunk).slice(-4000); });
  return result;
}

/** 第二实例必须在预算内关闭；启动错误和非零退出保持明确失败。 */
async function waitChildExit(child) {
  await bounded(new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }), 20_000, "DESKTOP_LIFECYCLE_SECOND_INSTANCE_TIMEOUT");
  assert.equal(child.exitCode, 0, "DESKTOP_LIFECYCLE_SECOND_INSTANCE_EXIT_FAILED");
  assert.equal(alive(child.pid), false, "DESKTOP_LIFECYCLE_SECOND_INSTANCE_REMAINED");
}

/** 显式退出后检查全部观测 PID，清理宽限只有五秒。 */
async function waitStopped() {
  await waitUntil(() => [...observedPids].every(pid => !alive(pid)), 5_000, "DESKTOP_LIFECYCLE_PROCESSES_REMAINED");
}

/** 只清理本片已观测进程，失败保留原错、终止错误与残留 PID。 */
async function cleanup() {
  const errors = [];
  for (const pid of observedPids) {
    try {
      if (!alive(pid)) continue;
      const killed = spawnSync(path.join(env.SystemRoot ?? env.SYSTEMROOT, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", encoding: "utf8" });
      if (killed.error) throw killed.error;
      if (killed.status !== 0) throw new Error(`DESKTOP_LIFECYCLE_KILL_FAILED: pid=${pid}, status=${killed.status}, ${killed.stderr}`);
    } catch (error) { errors.push(error); }
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_LIFECYCLE_CONNECTION_CLOSE_TIMEOUT"); }
    catch (error) { errors.push(error); }
  }
  for (const child of children) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
  const remainingPids = [];
  for (const pid of observedPids) {
    try { if (alive(pid)) remainingPids.push(pid); }
    catch (error) { remainingPids.push(pid); errors.push(error); }
  }
  report.cleanup = { status: errors.length || remainingPids.length ? "failed" : "stopped", remainingPids };
  if (remainingPids.length) errors.push(new Error(`DESKTOP_LIFECYCLE_PROCESSES_REMAINED: ${remainingPids.join(",")}`));
  if (errors.length) throw new AggregateError(errors, "DESKTOP_LIFECYCLE_CLEANUP_FAILED");
}

/** 报告保留有界错误链，不将启动、业务或清理失败转换为成功。 */
function failure(error, depth = 0) {
  return { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 4000),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.cause && depth < 5 ? { cause: failure(error.cause, depth + 1) } : {}),
    ...(error instanceof AggregateError && depth < 5 ? { errors: [...error.errors].map(item => failure(item, depth + 1)) } : {}) };
}

try {
  const [input, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error("用法：electron-packaged-lifecycle.smoke.mjs <工件 exe>");
  const executable = await fs.realpath(path.resolve(input));
  if (process.platform !== "win32" || path.extname(executable).toLowerCase() !== ".exe") throw new Error("DESKTOP_LIFECYCLE_WINDOWS_EXE_REQUIRED");
  const relative = path.relative(fileURLToPath(new URL("../../..", import.meta.url)), executable);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error("DESKTOP_LIFECYCLE_EXE_MUST_BE_OUTSIDE_REPOSITORY");
  await fs.access(path.join(path.dirname(executable), "resources", "app.asar"));
  report.executable = executable;
  report.exeSha256 = crypto.createHash("sha256").update(await fs.readFile(executable)).digest("hex");
  env = await isolatedEnvironment();
  const args = [`--user-data-dir=${path.join(root, "profile")}`];
  const { _electron: electron } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
  let clientId;
  for (let attempt = 1; attempt <= 2; attempt++) {
    report.phase = `launch-${attempt}`;
    application = await electron.launch({ executablePath: executable, args, env, cwd: root, timeout: 60_000 });
    const child = application.process();
    const run = { attempt, primary: observe(child, "primary"), rendererErrors: [] };
    report.runs.push(run);
    const page = await application.firstWindow({ timeout: 60_000 });
    page.on("pageerror", error => run.rendererErrors.push(failure(error)));
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    const initial = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, "DESKTOP_LIFECYCLE_STATE_TIMEOUT");
    assert.equal(initial.status, "ready");
    assert.equal(initial.health.database, "ready");
    assert.ok(Number.isInteger(initial.pid) && initial.pid > 0);
    observedPids.add(initial.pid);
    const runtimeInfo = await bounded(page.evaluate(() => window.codeflowDesktop.request({ method: "runtime.info" })), 15_000, "DESKTOP_LIFECYCLE_API_TIMEOUT");
    assert.equal(runtimeInfo.status, 200);
    assert.ok(typeof runtimeInfo.body.client.clientId === "string" && runtimeInfo.body.client.clientId.trim().length > 0,
      "DESKTOP_LIFECYCLE_CLIENT_ID_INVALID");
    if (attempt === 1) clientId = runtimeInfo.body.client.clientId;
    else assert.equal(runtimeInfo.body.client.clientId, clientId, "DESKTOP_LIFECYCLE_CLIENT_ID_CHANGED");
    run.clientId = clientId;
    run.clientPid = initial.pid;
    const shell = await bounded(application.evaluate(({ app, BrowserWindow }) => ({
      isPackaged: app.isPackaged, lock: app.hasSingleInstanceLock(), windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, visible: window.isVisible() })),
      pids: app.getAppMetrics().map(metric => metric.pid),
    })), 15_000, "DESKTOP_LIFECYCLE_SHELL_TIMEOUT");
    run.shellPids = shell.pids;
    for (const pid of shell.pids) observedPids.add(pid);
    assert.equal(shell.isPackaged, true);
    assert.equal(shell.lock, true);
    assert.equal(shell.windows.length, 1);
    assert.equal(shell.windows[0].visible, true);
    run.windowId = shell.windows[0].id;
    if (attempt === 1) {
      report.phase = "close-to-tray";
      const hidden = await bounded(application.evaluate(({ app, BrowserWindow }) => {
        globalThis.__codeflowD17dSecondInstances = 0;
        app.on("second-instance", () => { globalThis.__codeflowD17dSecondInstances++; });
        const window = BrowserWindow.getAllWindows()[0];
        window.close();
        return { id: window.id, destroyed: window.isDestroyed(), visible: window.isVisible() };
      }), 15_000, "DESKTOP_LIFECYCLE_HIDE_TIMEOUT");
      assert.deepEqual(hidden, { id: run.windowId, destroyed: false, visible: false });
      const hiddenState = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, "DESKTOP_LIFECYCLE_HIDDEN_STATE_TIMEOUT");
      assert.equal(hiddenState.status, "ready");
      assert.equal(hiddenState.pid, initial.pid);
      const hiddenApi = await bounded(page.evaluate(() => window.codeflowDesktop.request({ method: "workspaces.list" })), 15_000, "DESKTOP_LIFECYCLE_HIDDEN_API_TIMEOUT");
      assert.equal(hiddenApi.status, 200);
      assert.ok(alive(initial.pid));
      run.closedWindow = { ...hidden, clientStatus: hiddenState.status, apiStatus: hiddenApi.status };
      report.phase = "second-instance";
      const secondary = spawn(executable, args, { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      run.secondary = observe(secondary, "secondary");
      await waitChildExit(secondary);
      run.secondary.exitCode = secondary.exitCode;
      await waitUntil(() => bounded(application.evaluate(({ BrowserWindow }) =>
        globalThis.__codeflowD17dSecondInstances === 1 && BrowserWindow.getAllWindows().length === 1 && BrowserWindow.getAllWindows()[0].isVisible()),
      5_000, "DESKTOP_LIFECYCLE_REOPEN_PROBE_TIMEOUT"), 15_000, "DESKTOP_LIFECYCLE_REOPEN_TIMEOUT");
      const reopened = await bounded(application.evaluate(({ app, BrowserWindow }) => ({ id: BrowserWindow.getAllWindows()[0].id,
        windows: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0].isVisible(), lock: app.hasSingleInstanceLock(),
        secondInstanceEvents: globalThis.__codeflowD17dSecondInstances })), 15_000, "DESKTOP_LIFECYCLE_REOPEN_FACTS_TIMEOUT");
      assert.deepEqual(reopened, { id: run.windowId, windows: 1, visible: true, lock: true, secondInstanceEvents: 1 });
      const reopenedState = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, "DESKTOP_LIFECYCLE_REOPEN_STATE_TIMEOUT");
      assert.equal(reopenedState.status, "ready");
      assert.equal(reopenedState.pid, initial.pid);
      run.reopenedWindow = { ...reopened, clientPid: reopenedState.pid };
    }
    report.phase = `explicit-exit-${attempt}`;
    // IPC 退出会销毁页面；成功依据是 close、退出码和全部 PID 退出，页面拒绝会由 pageerror 记为失败。
    await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
      bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_LIFECYCLE_EXIT_REQUEST_TIMEOUT")]);
    await waitStopped();
    assert.equal(child.exitCode, 0);
    assert.deepEqual(run.rendererErrors, []);
    run.exitCode = child.exitCode;
    run.remainingPids = [];
    application = undefined;
    observedPids.clear();
  }
  report.cleanup = { status: "stopped", remainingPids: [] };
  report.status = "passed";
} catch (error) {
  report.failedPhase = report.phase ?? "preflight";
  try { await cleanup(); }
  catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_LIFECYCLE_VERIFICATION_AND_CLEANUP_FAILED"); }
  verificationError = error;
  report.status = "failed";
  report.failure = failure(error);
  process.exitCode = 1;
}
try { await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
catch (error) {
  report.status = "failed";
  report.failure = failure(new AggregateError([...(verificationError ? [verificationError] : []), error], "DESKTOP_LIFECYCLE_REPORT_WRITE_FAILED"));
  process.exitCode = 1;
}
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_LIFECYCLE_${report.status.toUpperCase()}`,
  requestId: report.requestId, reportPath, ...(report.failure ? { failedPhase: report.failedPhase, failure: report.failure, cleanup: report.cleanup } : {}) }));
