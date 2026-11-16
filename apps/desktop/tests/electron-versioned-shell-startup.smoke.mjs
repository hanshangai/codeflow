import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { bounded, isolatedEnvironment, launchPackagedApp, waitUntil } from "./support/packaged-app.mjs";
import { failure } from "./electron-packaged-protocol.smoke.mjs";
import { queryProcesses, stopOwned } from "./electron-packaged-storage-failure.smoke.mjs";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const prefix = "DESKTOP_VERSIONED_SHELL";

/** 相等及任一方向包含均拒绝，保护只读输入。 */
function separate(left, right) {
  const outside = (parent, target) => {
    const relative = path.relative(parent, target);
    return relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative);
  };
  assert.ok(outside(left, right) && outside(right, left), prefix + "_PATH_OVERLAP");
}

/** 写前解析所有输入与输出父目录，已有输出不覆盖。 */
export async function preflight(args) {
  assert.equal(process.platform, "win32", prefix + "_WINDOWS_REQUIRED");
  assert.ok(args.length === 4 && args.every(value => typeof value === "string" && value.trim()),
    "用法：electron-versioned-shell-startup.smoke.mjs <新壳exe> <基线resources> <签名业务包目录> <新输出目录>");
  const [input, baselineInput, bundleInput, output] = args;
  const executable = await fs.realpath(path.resolve(input));
  assert.equal(path.basename(executable).toLowerCase(), "codeflowai.exe");
  const artifact = path.dirname(executable), baseline = await fs.realpath(path.resolve(baselineInput));
  const bundle = await fs.realpath(path.resolve(bundleInput)), requested = path.resolve(output);
  const root = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  for (const source of [artifact, baseline, bundle]) {
    separate(source, root); separate(source, requested); separate(await fs.realpath(repository), source);
  }
  separate(await fs.realpath(repository), root); separate(repository, requested);
  let exists = true;
  try { await fs.lstat(root); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
  assert.equal(exists, false, prefix + "_OUTPUT_EXISTS");
  for (const file of [path.join(artifact, "resources/app.asar"), path.join(artifact, "resources/web/favicon-32x32.png"),
    ...["client/dist/index.cjs", "web/index.html", "release-trust.json"].map(name => path.join(baseline, name)),
    ...["manifest.json", "bundle.tar.gz"].map(name => path.join(bundle, name))]) {
    assert.equal((await fs.lstat(file)).isFile(), true, prefix + "_INPUT_FILE_REQUIRED");
  }
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(path.join(bundle, "manifest.json"))));
  assert.match(manifest.releaseId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  assert.equal(manifest.platform, "win32"); assert.equal(manifest.arch, "x64");
  assert.equal((await fs.stat(path.join(bundle, "bundle.tar.gz"))).size, manifest.archiveSize);
  assert.equal(await digest(path.join(bundle, "bundle.tar.gz")), manifest.archiveSha256);
  return { executable, artifact, baseline, bundle, root, manifest };
}

/** 流式摘要避免整包或大型 exe 同时进入内存。 */
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 完整普通文件库存拒绝链接，验证输入及运行载荷不被改写。 */
async function inventory(roots) {
  const entries = {};
  for (const [label, root] of Object.entries(roots)) {
    const pending = [root];
    while (pending.length) {
      const current = pending.pop();
      for (const item of await fs.readdir(current, { withFileTypes: true })) {
        assert.equal(item.isSymbolicLink(), false, prefix + "_INPUT_REPARSE");
        const file = path.join(current, item.name);
        if (item.isDirectory()) pending.push(file);
        else { assert.equal(item.isFile(), true); entries[label + "/" + path.relative(root, file).replaceAll("\\", "/")] = await digest(file); }
      }
    }
  }
  return entries;
}

/** 可选日志只允许不存在，权限或编码错误继续失败。 */
async function jsonLines(file) {
  let bytes;
  try { bytes = await fs.readFile(file); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

/** 仅诊断协议调用与显示适配；关闭、超时和协议错误均显式失败。 */
async function inspectorAt(url) {
  const socket = new WebSocket(url), pending = new Map();
  let next = 0, failed, closing = false, resolvePaused;
  const paused = new Promise(resolve => { resolvePaused = resolve; });
  const fail = error => { failed = error; resolvePaused({ error }); for (const call of pending.values()) call.reject(error); pending.clear(); };
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    try {
      const value = JSON.parse(event.data);
      if (value.id) {
        const call = pending.get(value.id); assert.ok(call, prefix + "_INSPECTOR_UNKNOWN_RESPONSE"); pending.delete(value.id);
        if (value.error) call.reject(new Error(JSON.stringify(value.error))); else call.resolve(value.result);
      } else if (value.method === "Debugger.paused") resolvePaused({ event: value.params });
    } catch (error) { fail(error); }
  });
  socket.addEventListener("error", event => fail(event.error ?? new Error(prefix + "_INSPECTOR_ERROR")));
  socket.addEventListener("close", () => { if (!closing) fail(new Error(prefix + "_INSPECTOR_CLOSED")); });
  await bounded(opened, 10_000, prefix + "_INSPECTOR_OPEN_TIMEOUT");
  return {
    paused,
    /** 保留协议拒绝，不把远端异常当成功返回。 */
    async call(method, params = {}) {
      if (failed) throw failed;
      const id = ++next, result = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
      try { socket.send(JSON.stringify({ id, method, params })); return await bounded(result, 10_000, prefix + "_INSPECTOR_TIMEOUT"); }
      finally { pending.delete(id); }
    },
    /** 仅在调用全部完成后主动断开。 */
    close() { assert.equal(pending.size, 0); closing = true; socket.close(); },
  };
}

/** 全部场景使用新安装副本与临时账号/数据库，产品入口保持原代码。 */
export async function run(args) {
  const paths = await preflight(args), sourceRoots = { artifact: paths.artifact, baseline: paths.baseline, bundle: paths.bundle };
  const before = await inventory(sourceRoots);
  await fs.mkdir(paths.root);
  const report = { requestId: crypto.randomUUID(), status: "running", root: paths.root, executable: paths.executable,
    sourceBefore: before, scenarios: [], scope: "unsigned Windows x64 packaged main; frozen real Client/Web/native; independent user data; no installation or candidate health" };
  let knownError;
  try {
    const installation = path.join(paths.root, "installation"), newShell = path.join(installation, "shells/new");
    const baselineShell = path.join(installation, "shells/baseline");
    await fs.mkdir(path.dirname(newShell), { recursive: true });
    await fs.cp(paths.artifact, newShell, { recursive: true, force: false, errorOnExist: true });
    await fs.mkdir(baselineShell);
    await fs.copyFile(paths.executable, path.join(baselineShell, "CodeFlowAI.exe"));
    await fs.cp(paths.baseline, path.join(baselineShell, "resources"), { recursive: true, force: false, errorOnExist: true });
    await fs.writeFile(path.join(newShell, "resources/web/d13-source.html"), "candidate", { encoding: "utf8", flag: "wx" });
    await fs.writeFile(path.join(baselineShell, "resources/web/d13-source.html"), "baseline", { encoding: "utf8", flag: "wx" });
    const statePath = path.join(installation, "shell-launch.ini");
    const state = "[shell]\r\nschema=1\r\nactive=new\r\nprevious=\r\nbaseline=baseline\r\n";
    await fs.writeFile(statePath, state, { encoding: "ascii", flag: "wx" });
    const fixtureRoots = { newShell, baselineShell }, fixtureBefore = await inventory(fixtureRoots);
    const context = { ...paths, installation, newShell, baselineShell, executable: path.join(newShell, "CodeFlowAI.exe") };
    report.scenarios.push(await normalScenario(context, "baseline"));
    report.scenarios.push(await normalScenario(context, "active"));
    await fs.writeFile(statePath, "invalid-state\r\n", "ascii");
    report.scenarios.push(await rejectedScenario(context, "invalid", "DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
    await fs.unlink(statePath);
    report.scenarios.push(await rejectedScenario(context, "missing", "DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
    await fs.writeFile(statePath, "[shell]\r\nschema=1\r\nactive=baseline\r\nprevious=\r\nbaseline=baseline\r\n", "ascii");
    report.scenarios.push(await rejectedScenario(context, "inactive", "DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
    await fs.writeFile(statePath, state, "ascii");
    report.scenarios.push(await rejectedScenario(context, "early-quit", null));
    assert.deepEqual(await inventory(fixtureRoots), fixtureBefore, prefix + "_FIXTURE_PAYLOAD_CHANGED");
    report.fixtureUnchanged = true;
  } catch (error) { knownError = error; }
  try { report.sourceAfter = await inventory(sourceRoots); assert.deepEqual(report.sourceAfter, before, prefix + "_INPUT_CHANGED"); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_INPUT_CHECK_FAILED"); }
  report.status = knownError ? "failed" : "passed"; if (knownError) report.failure = failure(knownError);
  await fs.writeFile(path.join(paths.root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ code: prefix, status: report.status, report: path.join(paths.root, "verification.json") }));
  if (knownError) process.exitCode = 1;
  return report;
}

/** 成功必须由真实 Client 就绪、资源读取与原 IPC 正常退出共同证明。 */
async function normalScenario(paths, mode) {
  const root = path.join(paths.root, mode); await fs.mkdir(root);
  const shellState = await fs.readFile(path.join(paths.installation, "shell-launch.ini"));
  const env = await isolatedEnvironment(root);
  if (mode === "active") env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(paths.root, "baseline/runtime");
  const data = env.CODEFLOWAI_DESKTOP_DATA_DIR;
  const identityBefore = mode === "active" ? await digest(path.join(data, "device-identity.json")) : undefined;
  const expectedRelease = mode === "active" ? paths.manifest.releaseId : null;
  const expectedDirectory = mode === "active" ? path.join(data, "releases", expectedRelease) : path.join(paths.baselineShell, "resources");
  const pointers = {};
  if (mode === "active") {
    await fs.mkdir(expectedDirectory, { recursive: true });
    await tar.x({ cwd: expectedDirectory, file: path.join(paths.bundle, "bundle.tar.gz"), strict: true });
    await fs.copyFile(path.join(paths.bundle, "manifest.json"), path.join(expectedDirectory, "manifest.json"));
    for (const [name, releaseId] of [["active-release.json", expectedRelease], ["previous-release.json", expectedRelease]]) {
      const bytes = Buffer.from(JSON.stringify({ releaseId }) + "\n"); pointers[name] = bytes;
      await fs.writeFile(path.join(data, name), bytes, { flag: "wx" });
    }
  }
  const report = { mode, status: "running", processes: [] }, observed = new Map();
  const profile = path.join(root, "profile"), launchAfter = new Date().toISOString();
  let session, knownError, launched = false;
  /** 只登记实际父链属于本次主进程的身份，未知身份不进入清理。 */
  async function discover() {
    const all = await queryProcesses(), ids = new Set(session ? [session.child.pid] : []);
    if (!session) {
      for (const item of all) {
        if (!item.commandLine?.includes(profile) || !item.commandLine.toLowerCase().includes(paths.executable.toLowerCase())) continue;
        const parent = all.find(candidate => candidate.pid === item.parentPid);
        assert.ok(Date.parse(item.created) >= Date.parse(launchAfter) && (item.parentPid === process.pid || parent?.parentPid === process.pid), prefix + "_LAUNCH_OWNERSHIP_UNKNOWN");
        ids.add(item.pid);
        if (parent?.parentPid === process.pid) ids.add(parent.pid);
      }
    }
    let added;
    do { added = false; for (const item of all) if (ids.has(item.parentPid) && !ids.has(item.pid)) { ids.add(item.pid); added = true; } } while (added);
    for (const item of all.filter(item => ids.has(item.pid))) {
      assert.ok(item.executable && item.commandLine && item.created, prefix + "_PROCESS_IDENTITY_REQUIRED");
      if (observed.has(item.pid)) assert.deepEqual(item, observed.get(item.pid), prefix + "_PID_CHANGED");
      else observed.set(item.pid, item);
    }
  }
  try {
    launched = true;
    session = await launchPackagedApp({ executablePath: paths.executable, userDataDir: profile, env, cwd: root });
    report.output = session.run;
    await discover();
    const page = await session.application.firstWindow({ timeout: 60_000 });
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    const state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, prefix + "_STATE_TIMEOUT");
    report.state = state;
    assert.equal(state.status, "ready"); assert.equal(state.health.database, "ready"); assert.equal(state.releaseId, expectedRelease);
    await discover();
    const client = observed.get(state.pid); assert.ok(client, prefix + "_CLIENT_NOT_OBSERVED");
    assert.ok(client.commandLine.includes(path.join(expectedDirectory, "client/dist/index.cjs")), prefix + "_CLIENT_BASELINE_MISMATCH");
    const web = await bounded(page.evaluate(async () => {
      const response = await fetch("codeflow://desktop/index.html");
      if (!response.ok) throw new Error("WEB_READ_FAILED: " + response.status);
      return await response.text();
    }), 15_000, prefix + "_WEB_TIMEOUT");
    assert.equal(crypto.createHash("sha256").update(web).digest("hex"), await digest(path.join(expectedDirectory, "web/index.html")));
    if (mode === "baseline") assert.equal(await page.evaluate(async () => (await fetch("codeflow://desktop/d13-source.html")).text()), "baseline");
    report.state = state; report.client = client; report.webDirectory = expectedDirectory;
    report.shell = await session.application.evaluate(({ app }) => ({ exe: process.execPath, resources: process.resourcesPath, packaged: app.isPackaged, userData: app.getPath("userData") }));
    assert.equal(path.resolve(report.shell.resources), path.join(paths.newShell, "resources"));
    assert.equal(path.resolve(report.shell.userData), path.join(root, "profile")); assert.equal(report.shell.packaged, true);
    await discover();
    await bounded(Promise.all([session.application.waitForEvent("close", { timeout: 40_000 }), page.evaluate(() => { void window.codeflowDesktop.exit(); })]), 42_000, prefix + "_EXIT_TIMEOUT");
    assert.equal(session.child.exitCode, 0); report.exitCode = session.child.exitCode;
    await waitUntil(async () => (await queryProcesses([...observed.keys()])).length === 0, 10_000, prefix + "_PROCESSES_REMAIN");
    for (const [name, bytes] of Object.entries(pointers)) assert.deepEqual(await fs.readFile(path.join(data, name)), bytes, prefix + "_POINTER_CHANGED");
    if (mode === "baseline") for (const name of ["active-release.json", "previous-release.json"]) await assert.rejects(fs.access(path.join(data, name)), { code: "ENOENT" });
    assert.deepEqual(await jsonLines(path.join(data, "logs/desktop-errors.jsonl")), []);
    assert.deepEqual(await jsonLines(path.join(data, "logs/desktop-runtime-errors.jsonl")), []);
    const db = new DatabaseSync(path.join(data, "codeflowai.db"), { readOnly: true });
    let dbError;
    try { report.schemaVersion = db.prepare("PRAGMA user_version").get().user_version; assert.equal(report.schemaVersion, 92); }
    catch (error) { dbError = error; }
    try { db.close(); } catch (error) { throw new AggregateError([...(dbError ? [dbError] : []), error], prefix + "_DB_CLOSE_FAILED"); }
    if (dbError) throw dbError;
    report.pointersUnchanged = true;
    if (identityBefore) assert.equal(await digest(path.join(data, "device-identity.json")), identityBefore, prefix + "_IDENTITY_CHANGED");
    assert.deepEqual(await fs.readFile(path.join(paths.installation, "shell-launch.ini")), shellState, prefix + "_SHELL_POINTER_CHANGED");
  } catch (error) { knownError = error; }
  if (knownError && launched) {
    const cleanupErrors = [];
    try { await discover(); } catch (error) { cleanupErrors.push(error); }
    try { await stopOwned([...observed.values()]); } catch (error) { cleanupErrors.push(error); }
    if (session) {
      try { await bounded(session.application.close(), 5_000, prefix + "_CONNECTION_CLOSE_TIMEOUT"); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) knownError = new AggregateError([knownError, ...cleanupErrors], prefix + "_CLEANUP_FAILED");
  }
  if (session) { session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref(); }
  report.processes = [...observed.values()]; report.status = knownError ? "failed" : "passed"; if (knownError) report.failure = failure(knownError);
  await fs.writeFile(path.join(root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  if (knownError) throw knownError;
  return report;
}

/** 入口暂停只适配显示或注入提前退出，零 Client、日志及退出码由真实 main 证明。 */
async function rejectedScenario(paths, mode, expectedCode) {
  const root = path.join(paths.root, mode); await fs.mkdir(root);
  const env = await isolatedEnvironment(root), observationFile = path.join(root, "observation.json");
  const report = { mode, status: "running", stderr: "", processes: [] };
  const child = spawn(paths.executable, ["--inspect-brk=127.0.0.1:0", `--user-data-dir=${path.join(root, "profile")}`],
    { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => { child.once("error", error => resolve({ error })); child.once("exit", (code, signal) => resolve({ code, signal })); });
  child.stdout.resume(); child.stderr.setEncoding("utf8").on("data", text => { report.stderr = (report.stderr + text).slice(-65_536); });
  let inspector, knownError;
  try {
    report.processes = await queryProcesses([child.pid]); assert.equal(report.processes.length, 1);
    await waitUntil(() => { if (child.exitCode !== null) throw new Error(prefix + "_EARLY_EXIT"); return /Debugger listening on (ws:\/\/[^\s]+)/u.test(report.stderr); }, 15_000, prefix + "_INSPECTOR_ADDRESS_TIMEOUT");
    inspector = await inspectorAt(report.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/u)[1]);
    await inspector.call("Runtime.enable"); await inspector.call("Debugger.enable"); await inspector.call("Runtime.runIfWaitingForDebugger");
    const paused = await bounded(inspector.paused, 10_000, prefix + "_ENTRY_PAUSE_TIMEOUT");
    if (paused.error) throw paused.error; assert.equal(paused.event.reason, "Break on start");
    const expression = `(() => { const { app, dialog } = require('electron'), fs = require('node:fs');
      const observation = { pid: process.pid, packaged: app.isPackaged, spawns: [], dialogs: [], beforeQuit: 0 };
      require('node:diagnostics_channel').channel('child_process').subscribe(({ process: child }) => observation.spawns.push({ pid: child.pid, file: child.spawnfile }));
      dialog.showErrorBox = (title, message) => observation.dialogs.push({ title, message });
      app.on('before-quit', () => observation.beforeQuit++);
      ${mode === "early-quit" ? `const promises = require('node:fs/promises'), open = promises.open;
      promises.open = async (...args) => {
        if (args[0] === ${JSON.stringify(path.join(paths.installation, "shell-launch.ini"))}) {
          promises.open = open; observation.quitDuringStateOpen = true; app.quit();
        }
        return await open(...args);
      };` : ""}
      process.on('exit', code => fs.writeFileSync(${JSON.stringify(observationFile)}, JSON.stringify({ ...observation, exitCode: code }), 'utf8'));
      return { pid: process.pid, packaged: app.isPackaged }; })()`;
    const evaluated = await inspector.call("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true });
    assert.equal(evaluated.exceptionDetails, undefined); assert.deepEqual(evaluated.result.value, { pid: child.pid, packaged: true });
    await inspector.call("Debugger.resume"); inspector.close(); inspector = undefined;
    report.exit = await bounded(closed, 25_000, prefix + "_FAILURE_EXIT_TIMEOUT");
    if (report.exit.error) throw report.exit.error;
    assert.deepEqual(report.exit, { code: mode === "early-quit" ? 0 : 1, signal: null });
    report.observation = JSON.parse(await fs.readFile(observationFile, "utf8"));
    assert.deepEqual(report.observation.spawns, []); assert.equal(report.observation.exitCode, report.exit.code);
    const data = env.CODEFLOWAI_DESKTOP_DATA_DIR;
    if (mode === "early-quit") {
      assert.equal(report.observation.quitDuringStateOpen, true); assert.equal(report.observation.beforeQuit, 1);
      assert.deepEqual(report.observation.dialogs, []); await assert.rejects(fs.access(data), { code: "ENOENT" });
    } else {
      assert.equal(report.observation.dialogs.length, 1); assert.equal(report.observation.dialogs[0].message, expectedCode);
      const entries = await fs.readdir(data); assert.deepEqual(entries, ["logs"]);
      report.errors = await jsonLines(path.join(data, "logs/desktop-errors.jsonl"));
      assert.equal(report.errors.length, 1); assert.equal(report.errors[0].rootCause, expectedCode);
      assert.equal(report.errors[0].errorCode, expectedCode); assert.match(report.errors[0].requestId, /^[0-9a-f-]{36}$/u);
      if (mode === "missing") assert.ok(report.errors[0].causeCodes.includes("ENOENT"), prefix + "_SYSTEM_CAUSE_MISSING");
    }
    assert.equal((await queryProcesses([child.pid])).length, 0);
  } catch (error) { knownError = error; }
  try { inspector?.close(); if (knownError) await stopOwned(report.processes); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_FAILURE_CLEANUP_FAILED"); }
  child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
  report.status = knownError ? "failed" : "passed"; if (knownError) report.failure = failure(knownError);
  await fs.writeFile(path.join(root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  if (knownError) throw knownError;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv.slice(2));
