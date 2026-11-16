import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw new Error("用法：electron-packaged-startup-failure.smoke.mjs <exe> <不存在的仓库外报告目录>");
const repository = await fs.realpath(fileURLToPath(new URL("../../..", import.meta.url)));
const executablePath = await fs.realpath(path.resolve(input));
assert.equal(process.platform, "win32", "DESKTOP_STARTUP_FAILURE_WINDOWS_REQUIRED");
assert.equal(path.extname(executablePath).toLowerCase(), ".exe", "DESKTOP_STARTUP_FAILURE_EXE_REQUIRED");
const artifactRoot = path.dirname(executablePath);
const requestedRoot = path.resolve(output);
const root = path.join(await fs.realpath(path.dirname(requestedRoot)), path.basename(requestedRoot));

/** 工件、源码和报告互不包含；在任何写入前核对解析后的路径。 */
function assertSeparate(left, right) {
  const contains = (parent, target) => {
    const relative = path.relative(parent, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  assert.ok(!contains(left, right) && !contains(right, left), "DESKTOP_STARTUP_FAILURE_PATH_OVERLAP");
}
assertSeparate(repository, root);
assertSeparate(repository, artifactRoot);
assertSeparate(artifactRoot, root);
await fs.mkdir(root);
const reportPath = path.join(root, "verification.json");
const report = { requestId: crypto.randomUUID(), status: "running", root, executablePath, runs: [],
  scope: "windows_packaged_identity_startup_failure", instrumentation: "入口前只替换错误对话框显示，并只读订阅 child_process 诊断；不修改启动、身份、Client 或退出行为。" };
const activePids = new Set();
const observedPids = new Set();
let application, child, inspector;

/** 每个外部操作独立限时，所有结果均释放计时器。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 仅 ESRCH 代表进程已退出，其余查询错误继续失败。 */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** 等待真实条件，超时保留检查所属错误码。 */
async function waitUntil(check, milliseconds, code) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await bounded(Promise.resolve().then(check), Math.max(1, end - Date.now()), code)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(code);
}

/** 仅观测本次确定的进程，完成退出后不再以旧 PID 操作新进程。 */
function observe(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "DESKTOP_STARTUP_FAILURE_PID_INVALID");
  activePids.add(pid); observedPids.add(pid);
}

/** 所有用户、引擎与临时目录均归本次报告根，清除继承注入和云端配置。 */
async function isolatedEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i.test(key)));
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    env[key] = path.join(root, key.toLowerCase());
    await fs.mkdir(env[key]);
  }
  env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return env;
}

/** 内容只以摘要进入报告，身份私钥与配置正文始终不输出。 */
async function hashFile(filename) {
  return crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex");
}

/** 核对输入完整工件的四个实际组件，不在输入目录生成任何文件。 */
async function artifactHashes() {
  const files = { exe: executablePath, asar: path.join(artifactRoot, "resources/app.asar"),
    client: path.join(artifactRoot, "resources/client/dist/index.cjs"), web: path.join(artifactRoot, "resources/web/index.html") };
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, filename]) => [key, await hashFile(filename)])));
}

/** 故障期间数据库、配置和元数据字节必须保持，SQLite 不得新开 sidecar。 */
async function storageHashes(dataDir) {
  const names = ["codeflowai.db", "codeflowai.db.meta.json", "config.json"];
  const entries = await fs.readdir(dataDir);
  for (const name of ["codeflowai.db-wal", "codeflowai.db-shm"]) assert.equal(entries.includes(name), false, `DESKTOP_STARTUP_FAILURE_SIDECAR: ${name}`);
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await hashFile(path.join(dataDir, name))])));
}

/** 成功路径只通过产品受限桥，HTTP 状态和成功正文同时校验。 */
async function request(page, method, body) {
  const response = await bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, ...(body ? { body } : {}) }),
    35_000, "DESKTOP_STARTUP_FAILURE_REQUEST_TIMEOUT");
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body?.ok, true, JSON.stringify(response));
  return response;
}

/** 真实启动、创建或回读工作区后经原 IPC 正常退出，不以强制终止代替成功。 */
async function normalRun(env, project, expected) {
  const { _electron: electron } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
  application = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(root, "profile")}`], env, cwd: root, timeout: 60_000 });
  child = application.process(); observe(child.pid);
  const run = { kind: expected ? "restored" : "initialize", stderr: "" };
  report.runs.push(run);
  child.stdout.resume();
  child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-65_536); });
  const page = await application.firstWindow({ timeout: 60_000 });
  await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
  const state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, "DESKTOP_STARTUP_FAILURE_STATE_TIMEOUT");
  assert.equal(state.status, "ready"); assert.equal(state.health.database, "ready"); observe(state.pid);
  const facts = await bounded(application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, appPath: app.getAppPath(), pids: app.getAppMetrics().map(item => item.pid) })),
    10_000, "DESKTOP_STARTUP_FAILURE_MAIN_TIMEOUT");
  for (const pid of facts.pids) observe(pid);
  assert.equal(facts.isPackaged, true);
  assert.equal(path.resolve(facts.appPath), path.join(artifactRoot, "resources/app.asar"));
  run.facts = facts;
  const clientId = (await request(page, "runtime.info")).body.client.clientId;
  assert.ok(typeof clientId === "string" && clientId.trim());
  let workspaceId;
  if (!expected) {
    assert.deepEqual((await request(page, "workspaces.list")).body.workspaces, []);
    workspaceId = (await request(page, "workspaces.upsert", { workspaceId: "identity-failure", title: "身份故障验收", path: project })).body.workspace.id;
  } else {
    assert.equal(clientId, expected.clientId);
    const workspaces = (await request(page, "workspaces.list")).body.workspaces;
    assert.equal(workspaces.length, 1); assert.equal(workspaces[0].id, expected.workspaceId); assert.equal(workspaces[0].path, project);
    workspaceId = workspaces[0].id;
  }
  await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
    bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_STARTUP_FAILURE_EXIT_REQUEST_TIMEOUT")]);
  await waitUntil(() => [...activePids].every(pid => !alive(pid)), 5_000, "DESKTOP_STARTUP_FAILURE_NORMAL_PROCESSES_REMAINED");
  assert.equal(child.exitCode, 0);
  run.exitCode = child.exitCode; run.clientId = clientId; run.workspaceId = workspaceId; run.observedPids = [...activePids];
  activePids.clear(); application = undefined; child = undefined;
  return { clientId, workspaceId };
}

/** Inspector 只在入口暂停时安装显示捕获与只读子进程观测，协议错误立即失败。 */
async function attachInspector(url) {
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0, onPaused, transportError;
  const paused = new Promise(resolve => { onPaused = resolve; });
  const failTransport = error => {
    transportError = error;
    for (const operation of pending.values()) operation.reject(error);
    pending.clear(); onPaused({ error });
  };
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    try {
      const response = JSON.parse(event.data);
      if (response.id) {
        const operation = pending.get(response.id);
        if (!operation) throw new Error("DESKTOP_STARTUP_FAILURE_INSPECTOR_RESPONSE_UNKNOWN");
        pending.delete(response.id);
        if (response.error) operation.reject(new Error(JSON.stringify(response.error)));
        else operation.resolve(response.result);
      } else if (response.method === "Debugger.paused") onPaused({ event: response.params });
    } catch (error) { failTransport(error); }
  });
  socket.addEventListener("close", () => failTransport(new Error("DESKTOP_STARTUP_FAILURE_INSPECTOR_CLOSED")));
  socket.addEventListener("error", event => failTransport(event.error ?? new Error("DESKTOP_STARTUP_FAILURE_INSPECTOR_ERROR")));
  try { await bounded(opened, 10_000, "DESKTOP_STARTUP_FAILURE_INSPECTOR_OPEN_TIMEOUT"); }
  catch (error) {
    try { socket.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], "DESKTOP_STARTUP_FAILURE_INSPECTOR_OPEN_AND_CLOSE_FAILED"); }
    throw error;
  }
  return {
    socket, paused,
    async call(method, params = {}) {
      if (transportError) throw transportError;
      const id = ++sequence;
      const result = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
      try {
        socket.send(JSON.stringify({ id, method, params }));
        return await bounded(result, 10_000, "DESKTOP_STARTUP_FAILURE_INSPECTOR_CALL_TIMEOUT");
      }
      finally { pending.delete(id); }
    },
  };
}

/** 故障启动必须由真实 main 退出 1；观测文件不得替代产品日志或退出结果。 */
async function faultRun(env, kind, dataDir, originalIdentity, baseline) {
  const identityFile = path.join(dataDir, "device-identity.json");
  const observationPath = path.join(root, `${kind}-observation.json`);
  const invalidBytes = Buffer.from("{invalid-d17j-identity\n", "utf8");
  if (kind === "missing") await fs.unlink(identityFile);
  else await fs.writeFile(identityFile, invalidBytes);
  const run = { kind, stderr: "" }; report.runs.push(run);
  const beforeLogs = await fs.readdir(path.join(dataDir, "logs"));
  const beforeClientLogs = Object.fromEntries(await Promise.all(beforeLogs.filter(name => name.startsWith("client-")).map(async name => [name, await hashFile(path.join(dataDir, "logs", name))])));
  child = spawn(executablePath, ["--inspect-brk=127.0.0.1:0", `--user-data-dir=${path.join(root, "profile")}`],
    { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let launchError;
  const closed = new Promise(resolve => {
    child.once("error", error => { launchError = error; resolve({ error }); });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  observe(child.pid); child.stdout.resume();
  child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-65_536); });
  await waitUntil(() => {
    if (launchError) throw launchError;
    if (child.exitCode != null || child.signalCode != null) throw new Error(`DESKTOP_STARTUP_FAILURE_EXIT_BEFORE_INSPECTOR: ${child.exitCode}, ${child.signalCode}`);
    return /Debugger listening on (ws:\/\/[^\s]+)/u.test(run.stderr);
  }, 15_000, "DESKTOP_STARTUP_FAILURE_INSPECTOR_ADDRESS_TIMEOUT");
  const url = run.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/u)[1];
  inspector = await attachInspector(url);
  await inspector.call("Runtime.enable"); await inspector.call("Debugger.enable"); await inspector.call("Runtime.runIfWaitingForDebugger");
  const pause = await bounded(inspector.paused, 10_000, "DESKTOP_STARTUP_FAILURE_ENTRY_PAUSE_TIMEOUT");
  if (pause.error) throw pause.error;
  assert.equal(pause.event.reason, "Break on start");
  const expression = `(() => {
    const { app, dialog } = require('electron'), fs = require('node:fs');
    const observation = { pid: process.pid, isPackaged: app.isPackaged, childSpawns: [], dialogs: [] };
    const spawnedChildren = [];
    require('node:diagnostics_channel').channel('child_process').subscribe(({ process: spawned }) => spawnedChildren.push(spawned));
    dialog.showErrorBox = (title, message) => { observation.dialogs.push({ title, message }); };
    process.on('exit', code => {
      observation.exitCode = code;
      observation.childSpawns = spawnedChildren.map(spawned => ({ pid: spawned.pid, executable: spawned.spawnfile }));
      observation.pids = app.getAppMetrics().map(item => item.pid);
      fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify(observation), 'utf8');
    });
    return { pid: process.pid, isPackaged: app.isPackaged };
  })()`;
  const evaluated = await inspector.call("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true });
  assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails));
  assert.equal(evaluated.result.value.pid, child.pid); assert.equal(evaluated.result.value.isPackaged, true);
  await inspector.call("Debugger.resume"); inspector.socket.close(); inspector = undefined;
  const exit = await bounded(closed, 20_000, "DESKTOP_STARTUP_FAILURE_PRODUCT_EXIT_TIMEOUT");
  if (exit.error) throw exit.error;
  assert.deepEqual(exit, { code: 1, signal: null });
  run.exit = exit;
  run.observation = JSON.parse(await fs.readFile(observationPath, "utf8"));
  for (const spawned of run.observation.childSpawns) observe(spawned.pid);
  for (const pid of run.observation.pids) observe(pid);
  assert.equal(run.observation.pid, child.pid); assert.equal(run.observation.isPackaged, true); assert.equal(run.observation.exitCode, 1);
  assert.deepEqual(run.observation.childSpawns, []);
  assert.equal(run.observation.dialogs.length, 1); assert.equal(run.observation.dialogs[0].title, "CodeFlow 启动失败");
  assert.equal(run.observation.dialogs[0].message, kind === "missing" ? "DESKTOP_DEVICE_IDENTITY_MISSING" : `设备身份文件无效：${identityFile}`);
  await waitUntil(() => [...activePids].every(pid => !alive(pid)), 5_000, "DESKTOP_STARTUP_FAILURE_FAULT_PROCESSES_REMAINED");
  const entries = await fs.readdir(dataDir);
  assert.deepEqual(entries.filter(name => name.startsWith("device-identity.json.")), []);
  if (kind === "missing") assert.equal(entries.includes("device-identity.json"), false);
  else assert.deepEqual(await fs.readFile(identityFile), invalidBytes);
  assert.deepEqual(await storageHashes(dataDir), baseline);
  const afterLogs = await fs.readdir(path.join(dataDir, "logs"));
  const afterClientLogs = Object.fromEntries(await Promise.all(afterLogs.filter(name => name.startsWith("client-")).map(async name => [name, await hashFile(path.join(dataDir, "logs", name))])));
  assert.deepEqual(afterClientLogs, beforeClientLogs);
  const errors = (await fs.readFile(path.join(dataDir, "logs/desktop-errors.jsonl"), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(errors.length, report.runs.filter(item => item.kind === "missing" || item.kind === "invalid").length);
  const error = errors.at(-1);
  assert.equal(error.errorCode, "DESKTOP_OPERATION_FAILED"); assert.ok(typeof error.requestId === "string" && error.requestId.trim());
  assert.equal(error.rootCause, run.observation.dialogs[0].message);
  assert.equal(JSON.stringify(errors).includes(invalidBytes.toString("utf8").trim()), false);
  run.error = error; run.storageUnchanged = true; run.clientNotStarted = true; run.observedPids = [...activePids];
  activePids.clear(); child = undefined;
  await fs.writeFile(identityFile, originalIdentity, { mode: 0o600 });
}

/** 保留原错和清理错误，只终止当前尚未确认退出的本次进程。 */
async function cleanup() {
  const errors = [];
  try { inspector?.socket.close(); }
  catch (error) { errors.push(error); }
  inspector = undefined;
  for (const pid of activePids) {
    try {
      if (!alive(pid)) continue;
      const killed = spawnSync(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"), ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000, encoding: "utf8" });
      if (killed.error || killed.status !== 0) throw killed.error ?? new Error(`DESKTOP_STARTUP_FAILURE_KILL_FAILED: ${pid}, ${killed.status}, ${killed.stderr}`);
    } catch (error) { errors.push(error); }
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_STARTUP_FAILURE_CLOSE_TIMEOUT"); }
    catch (error) { errors.push(error); }
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  report.remainingPids = [];
  for (const pid of activePids) {
    try { if (alive(pid)) report.remainingPids.push(pid); }
    catch (error) { errors.push(error); }
  }
  if (report.remainingPids.length) errors.push(new Error(`DESKTOP_STARTUP_FAILURE_PROCESSES_REMAINED: ${report.remainingPids.join(",")}`));
  if (errors.length) throw new AggregateError(errors, "DESKTOP_STARTUP_FAILURE_CLEANUP_FAILED");
}

/** 报告保留完整失败链，清理失败不能覆盖故障根因。 */
function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

try {
  report.artifactBefore = await artifactHashes();
  const env = await isolatedEnvironment();
  const project = path.join(root, "project"), dataDir = env.CODEFLOWAI_DESKTOP_DATA_DIR;
  await fs.mkdir(project); await fs.mkdir(path.join(root, "profile"));
  const expected = await normalRun(env, project);
  const identityFile = path.join(dataDir, "device-identity.json"), originalIdentity = await fs.readFile(identityFile);
  report.identitySha256 = await hashFile(identityFile);
  report.storageBefore = await storageHashes(dataDir);
  for (const kind of ["missing", "invalid"]) await faultRun(env, kind, dataDir, originalIdentity, report.storageBefore);
  const errorsBeforeRestart = await hashFile(path.join(dataDir, "logs/desktop-errors.jsonl"));
  await normalRun(env, project, expected);
  assert.equal(await hashFile(identityFile), report.identitySha256);
  assert.equal(await hashFile(path.join(dataDir, "logs/desktop-errors.jsonl")), errorsBeforeRestart);
  report.errorEvidenceUnchangedAfterRestart = true;
  report.artifactAfter = await artifactHashes(); assert.deepEqual(report.artifactAfter, report.artifactBefore);
  report.observedPids = [...observedPids]; report.remainingPids = []; report.status = "passed";
} catch (error) {
  try { await cleanup(); }
  catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_STARTUP_FAILURE_VERIFICATION_AND_CLEANUP_FAILED"); }
  report.status = "failed"; report.failure = failure(error); process.exitCode = 1;
}
try { await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
catch (error) { throw new AggregateError([...(report.failure ? [new Error(JSON.stringify(report.failure))] : []), error], "DESKTOP_STARTUP_FAILURE_REPORT_WRITE_FAILED"); }
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_STARTUP_FAILURE_${report.status.toUpperCase()}`,
  requestId: report.requestId, reportPath, ...(report.failure ? { failure: report.failure } : {}) }));
