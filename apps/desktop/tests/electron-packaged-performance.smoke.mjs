import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PERFORMANCE_LIMITS, assessPerformance, probeWorkspaceUi, summarizePerformanceSamples as summarize } from "./support/desktop-performance-acceptance.mjs";
import { closeInitialSettings } from "./support/desktop-ui-smoke.mjs";

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw new Error("用法：electron-packaged-performance.smoke.mjs <exe> <不存在的仓库外报告目录>");
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const root = path.resolve(output);
const observedPids = new Set();
const report = { requestId: crypto.randomUUID(), status: "running", root, runs: [],
  scope: "windows_unsigned_packaged_performance", acceptance: { status: "pending", limits: PERFORMANCE_LIMITS },
  timing: "controller_monotonic_clock_including_playwright_and_bridge_round_trip",
  uiReadiness: "workspace_create_dialog_editable_create_action_trial_then_cancel",
  percentile: "nearest_rank", samplesPerMethodPerRun: 5 };
let application, child;

/** 输入与输出必须离开源码树，报告目录必须独占且不可复用。 */
function outsideRepository(target) {
  const relative = path.relative(repository, target);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_PERF_PATH_MUST_BE_OUTSIDE_REPOSITORY");
}
outsideRepository(root);
const realOutput = path.join(await fs.realpath(path.dirname(root)), path.basename(root));
outsideRepository(realOutput);
const artifactDirectory = path.dirname(await fs.realpath(path.resolve(input)));
assertSeparateDirectories(artifactDirectory, realOutput);
await fs.mkdir(root);
const reportPath = path.join(root, "verification.json");

/** 输入工件与输出互不包含；必须在创建报告目录前拒绝误写输入。 */
function assertSeparateDirectories(artifact, outputDirectory) {
  const separate = (left, right) => {
    const relative = path.relative(left, right);
    return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  assert.ok(separate(artifact, outputDirectory) && separate(outputDirectory, artifact), "DESKTOP_PERF_INPUT_OUTPUT_OVERLAP");
}

/** PID 查询只把 ESRCH 视为已退出，权限和查询异常保持失败。 */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** 外部操作独立限时；定时器无论成功失败均释放。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 仅继承系统启动条件，其余用户配置和数据固定在独占目录。 */
async function isolatedEnvironment() {
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    env[key] = path.join(root, key.toLowerCase());
    await fs.mkdir(env[key]);
  }
  env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return env;
}

/** 为精确测量对象留指纹，测试前后核对同一输入工件。 */
async function artifactHashes(executablePath) {
  const resources = path.join(path.dirname(executablePath), "resources");
  const entries = { exe: executablePath, asar: path.join(resources, "app.asar"),
    client: path.join(resources, "client/dist/index.cjs"), web: path.join(resources, "web/index.html") };
  return Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([key, filename]) =>
    [key, crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex")])));
}

/** 每次调用核验真实失败码及正文，耗时包含控制器到页面和原受限桥的往返。 */
async function request(page, method, body) {
  const started = performance.now();
  const response = await bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, ...(body ? { body } : {}) }),
    35_000, "DESKTOP_PERF_REQUEST_TIMEOUT");
  const milliseconds = performance.now() - started;
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body?.ok, true, JSON.stringify(response));
  return { milliseconds, response };
}

/** 正常退出后只核对本脚本已观测的 PID，不冒称全系统无瞬时子进程。 */
async function waitStopped() {
  const deadline = performance.now() + 5_000;
  while ([...observedPids].some(alive) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual([...observedPids].filter(alive), [], "DESKTOP_PERF_PROCESSES_REMAINED");
}

/** 失败只清理本次已观测进程；终止错误与查询错误保留并返回失败。 */
async function cleanup() {
  const errors = [];
  for (const pid of observedPids) {
    try {
      if (!alive(pid)) continue;
      const killed = spawnSync(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
      if (killed.error || killed.status !== 0) throw killed.error ?? new Error(`DESKTOP_PERF_KILL_FAILED: pid=${pid}, status=${killed.status}, ${killed.stderr}`);
    } catch (error) { errors.push(error); }
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_PERF_CLOSE_TIMEOUT"); }
    catch (error) { errors.push(error); }
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  report.remainingPids = [];
  report.unknownPids = [];
  for (const pid of observedPids) {
    try { if (alive(pid)) report.remainingPids.push(pid); }
    catch (error) { report.unknownPids.push(pid); errors.push(error); }
  }
  if (report.remainingPids.length) errors.push(new Error(`DESKTOP_PERF_PROCESSES_REMAINED: ${report.remainingPids.join(",")}`));
  if (errors.length) throw new AggregateError(errors, "DESKTOP_PERF_CLEANUP_FAILED");
}

/** 报告保留原错误链和清理错误，不将采样失败转为成功基线。 */
function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

try {
  const executablePath = await fs.realpath(path.resolve(input));
  outsideRepository(executablePath);
  assert.equal(process.platform, "win32", "DESKTOP_PERF_WINDOWS_REQUIRED");
  assert.equal(path.extname(executablePath).toLowerCase(), ".exe", "DESKTOP_PERF_EXE_REQUIRED");
  report.executablePath = executablePath;
  report.artifactBefore = await artifactHashes(executablePath);
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const { _electron: electron } = webRequire("@playwright/test");
  const env = await isolatedEnvironment();
  const userData = path.join(root, "profile"), project = path.join(root, "project");
  await fs.mkdir(userData); await fs.mkdir(project);
  let clientId, workspaceId;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const run = { attempt, profile: attempt === 1 ? "fresh" : "reused", samples: { "runtime.info": [], "workspaces.list": [] }, stderr: "" };
    report.runs.push(run);
    const started = performance.now();
    application = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env, cwd: root, timeout: 60_000 });
    child = application.process();
    observedPids.add(child.pid);
    child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-65_536); });
    const page = await application.firstWindow({ timeout: 60_000 });
    page.setDefaultTimeout(30_000);
    run.firstWindowMs = performance.now() - started;
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    await page.waitForFunction(async () => (await window.codeflowDesktop?.getState())?.status === "ready", undefined, { timeout: 60_000 });
    run.bridgeReadyMs = performance.now() - started;
    const runtime = await request(page, "runtime.info");
    run.firstRuntimeInfoMs = performance.now() - started;
    // 首装引导计入原启动耗时；复用profile的后续轮次不再等待设置。
    if (attempt === 1) await closeInitialSettings(page);
    await probeWorkspaceUi(page, project);
    run.uiActionableMs = performance.now() - started;
    const currentId = runtime.response.body.client.clientId;
    assert.ok(typeof currentId === "string" && currentId.trim(), "DESKTOP_PERF_CLIENT_ID_REQUIRED");
    if (attempt === 1) clientId = currentId;
    else assert.equal(currentId, clientId, "DESKTOP_PERF_CLIENT_ID_CHANGED");
    run.clientId = currentId;
    const facts = await bounded(application.evaluate(({ app, BrowserWindow }) => ({
      isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath,
      metrics: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type })),
      preferences: (({ sandbox, contextIsolation, nodeIntegration }) => ({ sandbox, contextIsolation, nodeIntegration }))
        (BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()),
    })), 15_000, "DESKTOP_PERF_MAIN_PROBE_TIMEOUT");
    run.facts = facts;
    assert.equal(facts.isPackaged, true);
    assert.equal(path.resolve(facts.appPath), path.join(path.dirname(executablePath), "resources/app.asar"));
    assert.deepEqual(facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    for (const metric of facts.metrics) observedPids.add(metric.pid);
    const state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, "DESKTOP_PERF_STATE_TIMEOUT");
    run.health = state.health;
    observedPids.add(state.pid);
    assert.equal(state.health.database, "ready");
    const initial = await request(page, "workspaces.list");
    if (attempt === 1) {
      assert.deepEqual(initial.response.body.workspaces, []);
      const created = await request(page, "workspaces.upsert", { workspaceId: "performance-baseline", title: "性能基线", path: project });
      workspaceId = created.response.body.workspace.id;
    }
    for (let sample = 0; sample < 5; sample++) {
      const runtimeSample = await request(page, "runtime.info");
      assert.equal(runtimeSample.response.body.client.clientId, clientId);
      run.samples["runtime.info"].push(runtimeSample.milliseconds);
      const listSample = await request(page, "workspaces.list");
      assert.equal(listSample.response.body.workspaces.length, 1);
      assert.equal(listSample.response.body.workspaces[0].id, workspaceId);
      assert.equal(listSample.response.body.workspaces[0].path, project);
      run.samples["workspaces.list"].push(listSample.milliseconds);
    }
    run.summary = Object.fromEntries(Object.entries(run.samples).map(([method, samples]) => [method, summarize(samples)]));
    const exitStarted = performance.now();
    await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
      bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_PERF_EXIT_REQUEST_TIMEOUT")]);
    await waitStopped();
    assert.equal(child.exitCode, 0, "DESKTOP_PERF_EXIT_FAILED");
    run.exitMs = performance.now() - exitStarted;
    run.exitCode = child.exitCode;
    run.observedPids = [...observedPids];
    application = undefined;
    observedPids.clear();
  }
  report.summary = Object.fromEntries(["runtime.info", "workspaces.list"].map(method =>
    [method, summarize(report.runs.flatMap(run => run.samples[method]))]));
  report.artifactAfter = await artifactHashes(executablePath);
  assert.deepEqual(report.artifactAfter, report.artifactBefore, "DESKTOP_PERF_ARTIFACT_CHANGED");
  report.remainingPids = [];
  report.acceptance = assessPerformance(report.runs);
  assert.equal(report.acceptance.status, "passed", "DESKTOP_PERF_BUDGET_EXCEEDED");
  report.status = "measured";
} catch (error) {
  try { await cleanup(); }
  catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_PERF_MEASUREMENT_AND_CLEANUP_FAILED"); }
  report.status = "failed";
  report.failure = failure(error);
  process.exitCode = 1;
}
try { await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
catch (error) { throw new AggregateError([...(report.failure ? [new Error(JSON.stringify(report.failure))] : []), error], "DESKTOP_PERF_REPORT_WRITE_FAILED"); }
console[report.status === "measured" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_PERF_${report.status.toUpperCase()}`,
  requestId: report.requestId, reportPath, acceptance: report.acceptance, ...(report.failure ? { failure: report.failure } : {}) }));
