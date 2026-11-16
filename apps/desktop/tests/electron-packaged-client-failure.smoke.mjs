import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw new Error("用法：electron-packaged-client-failure.smoke.mjs <exe> <不存在的仓库外报告目录>");
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const root = path.resolve(output);
const report = { requestId: crypto.randomUUID(), status: "running", root, runs: [], scope: "windows_packaged_idle_client_exit" };
const observedPids = new Set();
let application, child;

/** 输入与实际输出目录必须在仓库外，禁止复用已有报告。 */
function outsideRepository(target) {
  const relative = path.relative(repository, target);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_CLIENT_FAILURE_OUTSIDE_REPOSITORY_REQUIRED");
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
  assert.ok(separate(artifact, outputDirectory) && separate(outputDirectory, artifact), "DESKTOP_CLIENT_FAILURE_INPUT_OUTPUT_OVERLAP");
}

/** 只有 ESRCH 表示已退出，权限或其他查询错误继续失败。 */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** 操作独立限时，成功或失败均释放定时器。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 等待真实条件；超时保留所属检查的错误码。 */
async function waitUntil(predicate, milliseconds, code) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await bounded(Promise.resolve().then(predicate), Math.max(1, deadline - Date.now()), code)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

/** 系统启动条件以外的配置、凭据目录和数据均隔离。 */
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

/** 指纹固定本次真实壳、Client 和 Web，不覆盖输入工件。 */
async function artifactHashes(executablePath) {
  const resources = path.join(path.dirname(executablePath), "resources");
  const entries = { exe: executablePath, asar: path.join(resources, "app.asar"),
    client: path.join(resources, "client/dist/index.cjs"), web: path.join(resources, "web/index.html") };
  return Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([key, filename]) =>
    [key, crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex")])));
}

/** 成功请求必须同时具有原 HTTP 状态及成功正文。 */
async function request(page, method, body) {
  const response = await bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, ...(body ? { body } : {}) }),
    35_000, "DESKTOP_CLIENT_FAILURE_REQUEST_TIMEOUT");
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body?.ok, true, JSON.stringify(response));
  return response;
}

/** 保留失败链和清理诊断，不将预期断言之外的错误降级忽略。 */
function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

/** 错误日志是原事实源，缺失或损坏均显式失败。 */
async function runtimeErrors() {
  const text = await fs.readFile(path.join(root, "runtime/logs/desktop-runtime-errors.jsonl"), "utf8");
  return text.trim().split(/\r?\n/u).map(line => JSON.parse(line));
}

/** 失败只终止本次已观测的进程，查询未知、终止失败和残留全部保留。 */
async function cleanup() {
  const errors = [];
  for (const pid of observedPids) {
    try {
      if (!alive(pid)) continue;
      const killed = spawnSync(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
      if (killed.error || killed.status !== 0) throw killed.error ?? new Error(`DESKTOP_CLIENT_FAILURE_KILL_FAILED: pid=${pid}, status=${killed.status}, ${killed.stderr}`);
    } catch (error) { errors.push(error); }
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_CLIENT_FAILURE_CLOSE_TIMEOUT"); }
    catch (error) { errors.push(error); }
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  report.remainingPids = [];
  report.unknownPids = [];
  for (const pid of observedPids) {
    try { if (alive(pid)) report.remainingPids.push(pid); }
    catch (error) { report.unknownPids.push(pid); errors.push(error); }
  }
  if (report.remainingPids.length) errors.push(new Error(`DESKTOP_CLIENT_FAILURE_PROCESSES_REMAINED: ${report.remainingPids.join(",")}`));
  if (errors.length) throw new AggregateError(errors, "DESKTOP_CLIENT_FAILURE_CLEANUP_FAILED");
}

try {
  const executablePath = await fs.realpath(path.resolve(input));
  outsideRepository(executablePath);
  assert.equal(process.platform, "win32", "DESKTOP_CLIENT_FAILURE_WINDOWS_REQUIRED");
  assert.equal(path.extname(executablePath).toLowerCase(), ".exe", "DESKTOP_CLIENT_FAILURE_EXE_REQUIRED");
  report.executablePath = executablePath;
  report.artifactBefore = await artifactHashes(executablePath);
  const { _electron: electron } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
  const env = await isolatedEnvironment();
  const userData = path.join(root, "profile"), project = path.join(root, "project");
  await fs.mkdir(userData); await fs.mkdir(project);
  let clientId, workspaceId, errorEvidence;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const run = { attempt, stderr: "" };
    report.runs.push(run);
    application = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env, cwd: root, timeout: 60_000 });
    child = application.process();
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
    observedPids.add(child.pid);
    child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-65_536); });
    const page = await application.firstWindow({ timeout: 60_000 });
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    const initial = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, "DESKTOP_CLIENT_FAILURE_STATE_TIMEOUT");
    assert.equal(initial.status, "ready");
    assert.equal(initial.health.database, "ready");
    assert.ok(Number.isSafeInteger(initial.pid) && initial.pid > 0 && initial.pid !== child.pid);
    observedPids.add(initial.pid);
    run.initial = initial;
    const facts = await bounded(application.evaluate(({ app, BrowserWindow }) => ({
      isPackaged: app.isPackaged, appPath: app.getAppPath(), pids: app.getAppMetrics().map(metric => metric.pid),
      windows: BrowserWindow.getAllWindows().length,
      preferences: (({ sandbox, contextIsolation, nodeIntegration }) => ({ sandbox, contextIsolation, nodeIntegration }))
        (BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()),
    })), 15_000, "DESKTOP_CLIENT_FAILURE_MAIN_TIMEOUT");
    for (const pid of facts.pids) observedPids.add(pid);
    assert.equal(facts.isPackaged, true);
    assert.equal(path.resolve(facts.appPath), path.join(path.dirname(executablePath), "resources/app.asar"));
    assert.equal(facts.windows, 1);
    assert.equal(facts.pids.includes(initial.pid), false);
    assert.deepEqual(facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    run.facts = facts;
    const runtime = await request(page, "runtime.info");
    if (attempt === 1) {
      clientId = runtime.body.client.clientId;
      assert.ok(typeof clientId === "string" && clientId.trim());
      assert.deepEqual((await request(page, "workspaces.list")).body.workspaces, []);
      const created = await request(page, "workspaces.upsert", { workspaceId: "client-failure", title: "故障验收", path: project });
      workspaceId = created.body.workspace.id;
      // 新隔离目录只创建工作区，未创建会话或任务；只杀受限桥声明的本次 Client。
      assert.equal(process.kill(initial.pid, "SIGKILL"), true);
      await waitUntil(async () => (await page.evaluate(() => window.codeflowDesktop.getState())).status === "failed",
        10_000, "DESKTOP_CLIENT_FAILURE_FAILED_STATE_TIMEOUT");
      run.failed = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 5_000, "DESKTOP_CLIENT_FAILURE_STATE_TIMEOUT");
      assert.equal(run.failed.pid, null);
      assert.equal(run.failed.requestId, initial.requestId);
      assert.match(run.failed.errorCode, /^CLIENT_EXIT_/u);
      assert.equal(alive(initial.pid), false);
      assert.equal(alive(child.pid), true);
      await assert.rejects(() => request(page, "runtime.info"), /CLIENT_NOT_READY/u);
      run.requestRejected = true;
      errorEvidence = await runtimeErrors();
      const exits = errorEvidence.filter(entry => entry.errorCode === run.failed.errorCode);
      assert.equal(exits.length, 1);
      assert.equal(exits[0].requestId, initial.requestId);
      assert.equal(exits[0].pid, initial.pid);
      assert.equal(exits[0].rootCause, run.failed.errorCode);
      // UI 后台只读请求也可能在退出时失败；逐项验真并原样留存，禁止忽略其他错误。
      for (const entry of errorEvidence.filter(entry => entry !== exits[0])) {
        assert.equal(entry.errorCode, "DESKTOP_API_FAILED");
        assert.equal(entry.rootCause, "DESKTOP_API_CLIENT_EXIT");
        assert.equal(entry.pid, initial.pid);
        assert.ok(typeof entry.requestId === "string" && entry.requestId.trim());
        assert.ok(typeof entry.method === "string" && entry.method.trim());
      }
      run.errorEvidence = errorEvidence;
      await assert.rejects(() => bounded(page.evaluate(() => window.codeflowDesktop.exit()), 5_000, "DESKTOP_CLIENT_FAILURE_EXIT_TIMEOUT"), error => {
        run.firstExitError = failure(error);
        // Electron 包装保留，原失败码必须完整匹配，不能被另一退出错误冒充。
        return error.message.split(/\r?\n/u)[0].endsWith(`Error invoking remote method 'desktop:exit': Error: ${run.failed.errorCode}`);
      });
      run.firstExitRejected = true;
      assert.equal(alive(child.pid), true);
      assert.equal(await bounded(application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        5_000, "DESKTOP_CLIENT_FAILURE_WINDOW_TIMEOUT"), 1);
    } else {
      assert.equal(runtime.body.client.clientId, clientId);
      const workspaces = (await request(page, "workspaces.list")).body.workspaces;
      assert.equal(workspaces.length, 1);
      assert.equal(workspaces[0].id, workspaceId);
      assert.equal(workspaces[0].path, project);
      assert.deepEqual(await runtimeErrors(), errorEvidence);
      run.restored = { clientId, workspaceId, errorEvidenceUnchanged: true };
    }
    await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
      bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_CLIENT_FAILURE_EXIT_REQUEST_TIMEOUT")]);
    await waitUntil(() => [...observedPids].every(pid => !alive(pid)), 5_000, "DESKTOP_CLIENT_FAILURE_PROCESSES_REMAINED");
    assert.equal(child.exitCode, 0);
    run.exitCode = child.exitCode;
    run.observedPids = [...observedPids];
    application = undefined;
    observedPids.clear();
  }
  report.artifactAfter = await artifactHashes(executablePath);
  assert.deepEqual(report.artifactAfter, report.artifactBefore);
  report.remainingPids = [];
  report.status = "passed";
} catch (error) {
  try { await cleanup(); }
  catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_CLIENT_FAILURE_VERIFICATION_AND_CLEANUP_FAILED"); }
  report.status = "failed";
  report.failure = failure(error);
  process.exitCode = 1;
}
try { await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
catch (error) { throw new AggregateError([...(report.failure ? [new Error(JSON.stringify(report.failure))] : []), error], "DESKTOP_CLIENT_FAILURE_REPORT_WRITE_FAILED"); }
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_CLIENT_FAILURE_${report.status.toUpperCase()}`,
  requestId: report.requestId, reportPath, ...(report.failure ? { failure: report.failure } : {}) }));
