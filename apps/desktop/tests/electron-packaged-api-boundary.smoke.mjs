import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw new Error("用法：electron-packaged-api-boundary.smoke.mjs <exe> <不存在的仓库外报告目录>");
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const root = path.resolve(output);
const report = { requestId: crypto.randomUUID(), status: "running", root, requests: [], scope: "windows_packaged_local_read_boundary" };
const observedPids = new Set();
const sentinel = `OUTSIDE_${crypto.randomUUID()}`;
const content = "API boundary UTF-8 text: 本机隔离读取。\n";
let application, child;

/** 报告和输入必须离开源码树，真实父路径也不能经 junction 回到仓库。 */
function outsideRepository(target) {
  const relative = path.relative(repository, target);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_API_BOUNDARY_OUTSIDE_REPOSITORY_REQUIRED");
}
/** 输出与工件目录不能互相包含，防止验收数据污染只读工件。 */
function assertSeparateArtifactPaths(artifactDirectory, outputDirectory) {
  for (const [parent, target] of [[artifactDirectory, outputDirectory], [outputDirectory, artifactDirectory]]) {
    const relative = path.relative(parent, target);
    assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_API_BOUNDARY_ARTIFACT_OUTPUT_OVERLAP");
  }
}
const actualRoot = path.join(await fs.realpath(path.dirname(root)), path.basename(root));
const executablePath = await fs.realpath(path.resolve(input));
outsideRepository(root);
outsideRepository(actualRoot);
assertSeparateArtifactPaths(path.dirname(executablePath), actualRoot);
await fs.mkdir(root);
const reportPath = path.join(root, "verification.json");

/** 仅 ESRCH 表示进程退出，权限及其他查询错误必须显式失败。 */
function alive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "DESKTOP_API_BOUNDARY_INVALID_PID");
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** 外部操作有界，定时器在成功、失败及超时后均释放。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 仅继承系统启动条件，用户配置与凭据目录全部位于本次独占根。 */
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

/** 核对壳、ASAR、Client 和 Web 四项输入工件，验收不能改写它们。 */
async function artifactHashes(executablePath) {
  const resources = path.join(path.dirname(executablePath), "resources");
  const entries = { exe: executablePath, asar: path.join(resources, "app.asar"),
    client: path.join(resources, "client/dist/index.cjs"), web: path.join(resources, "web/index.html") };
  return Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([key, filename]) =>
    [key, crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex")])));
}

/** 同时锁定状态、成功标志与失败码，不能把其他失败当成预期拒绝。 */
function assertResponse(response, status, code) {
  assert.equal(response.status, status, "DESKTOP_API_BOUNDARY_STATUS_MISMATCH");
  assert.equal(response.body?.ok, status === 200, "DESKTOP_API_BOUNDARY_RESULT_MISMATCH");
  if (code) assert.equal(response.body?.code, code, "DESKTOP_API_BOUNDARY_CODE_MISMATCH");
}

/** 每个真实桥响应先查正文泄露，再保留失败或成功的完整证据。 */
async function request(page, method, body, status = 200, code) {
  const response = await bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, ...(body ? { body } : {}) }),
    35_000, "DESKTOP_API_BOUNDARY_REQUEST_TIMEOUT");
  const serialized = JSON.stringify(response);
  if (serialized.includes(sentinel)) {
    report.leak = { method, status: response.status, responseSha256: crypto.createHash("sha256").update(serialized).digest("hex") };
    throw new Error("DESKTOP_API_BOUNDARY_OUTSIDE_CONTENT_LEAKED");
  }
  report.requests.push({ method, body, expected: { status, ...(code ? { code } : {}) }, response });
  assertResponse(response, status, code);
  return response;
}

/** 每次拒绝后均回读健康和正常文件，Client PID 与本机身份不得改变。 */
async function assertRecovered(page, workspaceId, clientId, clientPid) {
  const runtime = await request(page, "runtime.info");
  assert.equal(runtime.body.client.clientId, clientId);
  const read = await request(page, "fs.readFile", { workspaceId, path: "normal.txt" });
  assert.equal(read.body.content, content);
  assert.equal(read.body.isBinary, false);
  const state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, "DESKTOP_API_BOUNDARY_STATE_TIMEOUT");
  assert.equal(state.status, "ready");
  assert.equal(state.pid, clientPid);
  assert.equal(state.health.database, "ready");
  assert.equal(alive(clientPid), true);
  report.recoveries.push({ clientId, clientPid, state });
}

/** 业务表只读核验；业务失败与关闭失败必须同时保留。 */
function assertIdle() {
  const db = new DatabaseSync(path.join(root, "runtime/codeflowai.db"), { readOnly: true, timeout: 5_000 });
  let operationError;
  try {
    report.businessCounts = Object.fromEntries(["threads", "thread_turns", "orch_instances"].map(table =>
      [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
    assert.deepEqual(report.businessCounts, { threads: 0, thread_turns: 0, orch_instances: 0 });
  } catch (error) { operationError = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError([...(operationError ? [operationError] : []), error], "DESKTOP_API_BOUNDARY_SQLITE_CLOSE_FAILED"); }
  if (operationError) throw operationError;
}

/** 只查询本次已观测 PID，所有查询必须证实退出后才允许成功。 */
async function waitStopped() {
  const deadline = Date.now() + 5_000;
  while ([...observedPids].some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual([...observedPids].filter(alive), [], "DESKTOP_API_BOUNDARY_PROCESSES_REMAINED");
}

/** 失败只清理本次已观测进程；未知 PID、终止失败和残留全部进入失败报告。 */
async function cleanup() {
  const errors = [];
  for (const pid of observedPids) {
    try {
      if (!alive(pid)) continue;
      const killed = spawnSync(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
      if (killed.error || killed.status !== 0) throw killed.error ?? new Error(`DESKTOP_API_BOUNDARY_KILL_FAILED: pid=${pid}, status=${killed.status}, ${killed.stderr}`);
    } catch (error) { errors.push(error); }
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_API_BOUNDARY_CLOSE_TIMEOUT"); }
    catch (error) { errors.push(error); }
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  report.remainingPids = [];
  report.unknownPids = [];
  for (const pid of observedPids) {
    try { if (alive(pid)) report.remainingPids.push(pid); }
    catch (error) { report.unknownPids.push(pid); errors.push(error); }
  }
  if (report.remainingPids.length) errors.push(new Error(`DESKTOP_API_BOUNDARY_PROCESSES_REMAINED: ${report.remainingPids.join(",")}`));
  if (errors.length) throw new AggregateError(errors, "DESKTOP_API_BOUNDARY_CLEANUP_FAILED");
}

/** 原错、cause 和清理聚合链完整保留，禁止将失败转成通过。 */
function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

try {
  outsideRepository(executablePath);
  assert.equal(process.platform, "win32", "DESKTOP_API_BOUNDARY_WINDOWS_REQUIRED");
  assert.equal(path.extname(executablePath).toLowerCase(), ".exe", "DESKTOP_API_BOUNDARY_EXE_REQUIRED");
  report.executablePath = executablePath;
  report.artifactBefore = await artifactHashes(executablePath);
  const { _electron: electron } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
  const env = await isolatedEnvironment();
  const profile = path.join(root, "profile"), project = path.join(root, "project"), outside = path.join(root, "outside");
  for (const directory of [profile, project, outside, path.join(project, "inside")]) await fs.mkdir(directory);
  await fs.writeFile(path.join(project, "normal.txt"), content, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(path.join(project, "inside/internal.txt"), content, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(path.join(outside, "sentinel.txt"), sentinel, { encoding: "utf8", flag: "wx" });
  await fs.symlink(path.join(project, "inside"), path.join(project, "internal-link"), "junction");
  await fs.symlink(outside, path.join(project, "external-link"), "junction");
  application = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, cwd: root, timeout: 60_000 });
  child = application.process();
  assert.equal(alive(child.pid), true);
  observedPids.add(child.pid);
  child.stdout.resume();
  report.stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { report.stderr = (report.stderr + chunk).slice(-65_536); });
  const page = await application.firstWindow({ timeout: 60_000 });
  await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
  await page.waitForFunction(async () => (await window.codeflowDesktop?.getState())?.status === "ready", undefined, { timeout: 60_000 });
  const initial = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, "DESKTOP_API_BOUNDARY_STATE_TIMEOUT");
  assert.equal(initial.status, "ready");
  assert.equal(initial.health.database, "ready");
  assert.notEqual(initial.pid, child.pid);
  assert.equal(alive(initial.pid), true);
  observedPids.add(initial.pid);
  report.initial = initial;
  const facts = await bounded(application.evaluate(({ app, BrowserWindow }) => ({
    isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath,
    pids: app.getAppMetrics().map(metric => metric.pid), windows: BrowserWindow.getAllWindows().length,
    preferences: (({ sandbox, contextIsolation, nodeIntegration }) => ({ sandbox, contextIsolation, nodeIntegration }))
      (BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()),
  })), 15_000, "DESKTOP_API_BOUNDARY_MAIN_TIMEOUT");
  for (const pid of facts.pids) { assert.equal(alive(pid), true); observedPids.add(pid); }
  report.facts = facts;
  assert.equal(facts.isPackaged, true);
  assert.equal(path.resolve(facts.appPath), path.join(path.dirname(executablePath), "resources/app.asar"));
  assert.equal(path.resolve(facts.resourcesPath), path.join(path.dirname(executablePath), "resources"));
  assert.equal(facts.windows, 1);
  assert.deepEqual(facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  const clientId = (await request(page, "runtime.info")).body.client.clientId;
  assert.ok(typeof clientId === "string" && clientId.trim());
  assert.deepEqual((await request(page, "workspaces.list")).body.workspaces, []);
  const workspaceId = (await request(page, "workspaces.upsert", { workspaceId: "api-boundary", title: "API 边界验收", path: project })).body.workspace.id;
  assert.equal(workspaceId, `${clientId}:api-boundary`);
  report.workspaceId = workspaceId;
  report.recoveries = [];
  await assertRecovered(page, workspaceId, clientId, initial.pid);
  const internal = await request(page, "fs.readFile", { workspaceId, path: "internal-link/internal.txt" });
  assert.equal(internal.body.content, content);
  assert.equal(internal.body.isBinary, false);
  for (const rejected of [
    { method: "fs.readFile", body: { workspaceId, path: "../outside/sentinel.txt" }, status: 400, code: "FILE_TRANSFER_PATH_INVALID" },
    { method: "fs.readFile", body: { workspaceId, path: "external-link/sentinel.txt" }, status: 400, code: "FILE_TRANSFER_PATH_INVALID" },
    { method: "fs.readFile", body: { workspaceId, path: "missing.txt" }, status: 404, code: "NOT_FOUND" },
    { method: "fs.readFile", body: { workspaceId: "api-boundary", path: "normal.txt" }, status: 400, code: "BAD_REQUEST" },
    { method: "fs.readFile", body: { workspaceId, path: "normal.txt", actorUserId: "forged-actor" }, status: 400, code: "BAD_REQUEST" },
    { method: "client.upgrade", body: {}, status: 404, code: "NOT_FOUND" },
  ]) {
    await request(page, rejected.method, rejected.body, rejected.status, rejected.code);
    await assertRecovered(page, workspaceId, clientId, initial.pid);
  }
  for (const pid of await bounded(application.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid)), 15_000, "DESKTOP_API_BOUNDARY_METRICS_TIMEOUT")) observedPids.add(pid);
  await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
    bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_API_BOUNDARY_EXIT_TIMEOUT")]);
  await waitStopped();
  assert.equal(child.exitCode, 0, "DESKTOP_API_BOUNDARY_EXIT_FAILED");
  report.exitCode = child.exitCode;
  application = undefined;
  assertIdle();
  report.artifactAfter = await artifactHashes(executablePath);
  assert.deepEqual(report.artifactAfter, report.artifactBefore, "DESKTOP_API_BOUNDARY_ARTIFACT_CHANGED");
  report.remainingPids = [];
  report.unknownPids = [];
  report.status = "passed";
} catch (error) {
  try { await cleanup(); }
  catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_API_BOUNDARY_VERIFICATION_AND_CLEANUP_FAILED"); }
  report.status = "failed";
  report.failure = failure(error);
  process.exitCode = 1;
}
report.observedPids = [...observedPids];
try { await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
catch (error) { throw new AggregateError([...(report.failure ? [new Error(JSON.stringify(report.failure))] : []), error], "DESKTOP_API_BOUNDARY_REPORT_WRITE_FAILED"); }
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_API_BOUNDARY_${report.status.toUpperCase()}`,
  requestId: report.requestId, reportPath, ...(report.failure ? { failure: report.failure } : {}) }));
