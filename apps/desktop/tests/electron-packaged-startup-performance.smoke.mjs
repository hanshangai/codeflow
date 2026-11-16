import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const [input, output, playwrightModule, ...extra] = process.argv.slice(2);
if (!input || !output || !playwrightModule || extra.length) {
  throw new Error("用法：electron-packaged-startup-performance.smoke.mjs <exe> <不存在的报告目录> <playwright-core模块路径>");
}
assert.equal(process.platform, "win32", "STARTUP_PERF_WINDOWS_REQUIRED");
const executablePath = await fs.realpath(path.resolve(input)), root = path.resolve(output);
const relative = path.relative(path.dirname(executablePath), root);
assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "STARTUP_PERF_OUTPUT_OVERLAPS_INSTALLATION");
await fs.mkdir(root);
const { chromium } = createRequire(import.meta.url)(path.resolve(playwrightModule));
const report = { requestId: crypto.randomUUID(), status: "running", executablePath, runs: [],
  timing: "controller_monotonic_clock; native_MainWindowHandle_polled_every_20ms; no_main_debugger; OS_file_cache_not_cleared",
  scope: "isolated_profile; updates_disabled; no_server; same_profile_reused_after_first_run" };
let browser, child, monitor;
const observedPids = new Set();

/** 测量、退出与进程探测均限时，失败保留到最终报告。 */
async function bounded(flight, timeoutMs, code) {
  let timer;
  try { return await Promise.race([flight, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

/** 仅 ESRCH 表示退出，其余探测错误明确失败。 */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** 仅检查本次 launch 及运行时已报告的进程，不查询或停止原安装。 */
async function waitStopped() {
  const deadline = performance.now() + 5_000;
  while ([...observedPids].some(alive) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([...observedPids].filter(alive), [], "STARTUP_PERF_PROCESSES_REMAINED");
}

/** 保留错误链供重现；不把采样失败折算为耗时结果。 */
function failure(error) {
  return { message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

/** 先启动原生可见窗口观察器，再启动应用，避免 PowerShell 初始化计入首窗耗时。 */
async function visibilityMonitor() {
  const script = `$ErrorActionPreference='Stop'
[Console]::WriteLine('ready')
$targetPid=[int][Console]::ReadLine()
$target=[Diagnostics.Process]::GetProcessById($targetPid)
$watch=[Diagnostics.Stopwatch]::StartNew()
while($watch.ElapsedMilliseconds -lt 60000){
  $target.Refresh()
  if($target.HasExited){throw 'STARTUP_PERF_EARLY_EXIT'}
  if($target.MainWindowHandle -ne [IntPtr]::Zero){[Console]::WriteLine('visible');exit 0}
  Start-Sleep -Milliseconds 20
}
throw 'STARTUP_PERF_VISIBLE_TIMEOUT'`;
  monitor = spawn(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let errorOutput = "";
  monitor.stderr.setEncoding("utf8").on("data", chunk => { errorOutput += chunk; });
  const lines = createInterface({ input: monitor.stdout });
  const [ready] = await bounded(once(lines, "line"), 15_000, "STARTUP_PERF_MONITOR_READY_TIMEOUT");
  assert.equal(ready, "ready", errorOutput);
  const visible = bounded(once(lines, "line"), 65_000, "STARTUP_PERF_MONITOR_TIMEOUT");
  return { visible, lines, errors: () => errorOutput };
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:path|pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i.test(key)));
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    env[key] = path.join(root, key.toLowerCase());
    await fs.mkdir(env[key]);
  }
  env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  env.CODEFLOWAI_DESKTOP_DISABLE_UPDATES = "1";
  const profile = path.join(root, "profile");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const run = { attempt, profile: attempt === 1 ? "fresh" : "reused", stderr: "" };
    report.runs.push(run);
    const observer = await visibilityMonitor();
    const started = performance.now();
    child = spawn(executablePath, [`--user-data-dir=${profile}`, "--remote-debugging-port=0"], { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    observedPids.add(child.pid);
    child.stdout.setEncoding("utf8").on("data", chunk => { run.stdout = ((run.stdout ?? "") + chunk).slice(-32_768); });
    child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-32_768); });
    monitor.stdin.end(String(child.pid) + "\n");
    const [visible] = await observer.visible;
    assert.equal(visible, "visible", observer.errors()); observer.lines.close();
    run.nativeVisibleMs = performance.now() - started;
    const portFile = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${portFile.split(/\r?\n/u)[0]}`);
    const page = browser.contexts()[0].pages()[0];
    assert.ok(page, "STARTUP_PERF_WINDOW_MISSING");
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    let state;
    const readyDeadline = performance.now() + 60_000;
    do {
      const facts = await page.evaluate(async () => ({ mounted: document.documentElement.dataset.codeflowReady === "1",
        state: await window.codeflowDesktop.getState() }));
      state = facts.state;
      if (facts.mounted && state.status === "ready") break;
      if (performance.now() >= readyDeadline) throw new Error("STARTUP_PERF_READY_TIMEOUT");
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
    run.bridgeReadyMs = performance.now() - started;
    run.runtime = { status: state.status, pid: state.pid, errorCode: state.errorCode };
    assert.ok(Number.isSafeInteger(state.pid) && state.pid > 0, "STARTUP_PERF_CLIENT_PID_REQUIRED");
    observedPids.add(state.pid);
    const response = await page.evaluate(() => window.codeflowDesktop.request({ method: "runtime.info" }));
    assert.equal(response.status, 200); assert.equal(response.body?.ok, true);
    run.businessReadyMs = performance.now() - started;
    assert.equal(browser.contexts()[0].pages().length, 1);
    run.pids = [...observedPids];
    await Promise.all([bounded(once(child, "exit"), 40_000, "STARTUP_PERF_EXIT_TIMEOUT"),
      page.evaluate(() => { void window.codeflowDesktop.exit(); })]);
    await browser.close(); browser = undefined;
    await waitStopped();
    assert.equal(child.exitCode, 0, "STARTUP_PERF_EXIT_FAILED");
    run.exitCode = child.exitCode;
    child.stdout.destroy(); child.stderr.destroy();
    child = undefined; monitor = undefined; observedPids.clear();
  }
  report.status = "measured";
} catch (error) {
  if (child?.exitCode === null) {
    try {
      const cleanup = spawn(path.join(process.env.SystemRoot, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      const [code] = await bounded(once(cleanup, "close"), 10_000, "STARTUP_PERF_CLEANUP_TIMEOUT");
      assert.equal(code, 0, "STARTUP_PERF_CLEANUP_FAILED"); await waitStopped();
    }
    catch (cleanup) { error = new AggregateError([error, cleanup], "STARTUP_PERF_CLEANUP_FAILED"); }
  }
  report.status = "failed"; report.failure = failure(error); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (monitor?.exitCode === null) monitor.kill();
  child?.stdout?.destroy(); child?.stderr?.destroy();
}
await fs.writeFile(path.join(root, "verification.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ requestId: report.requestId, status: report.status,
  runs: report.runs.map(({ stderr, stdout, ...run }) => run), ...(report.failure ? { failure: report.failure } : {}) }));
