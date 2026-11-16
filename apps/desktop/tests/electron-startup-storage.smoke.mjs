import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bounded, isolatedEnvironment, launchPackagedApp, waitUntil } from "./support/packaged-app.mjs";
import { failure } from "./electron-packaged-protocol.smoke.mjs";
import { queryProcesses, stopOwned } from "./electron-packaged-storage-failure.smoke.mjs";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const allowedRoot = path.resolve("D:/cf-temp/cf-d16-reinstall-continuation-20261031-root");
const frozenResources = path.join(allowedRoot, "resources-01");
const prefix = "DESKTOP_STARTUP_STORAGE";
const locatorName = "desktop-data-location.json";
const appId = "ai.codeflow.codeflowai";
const oldDeviceId = "d50fcfbe-f82a-43b9-ab7e-656af07a9a45";
const nextDeviceId = "16e38f2a-0640-49b0-a871-a897e5fcae81";

/** 相同路径和任一方向包含均拒绝，保护输入及工作区。 */
function separate(left, right) {
  assert.ok(outside(left, right) && outside(right, left), prefix + "_PATH_OVERLAP");
}

/** 只承认 parent 外的真实相对路径，相等不算外部。 */
function outside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
}

/** 逐级拒绝符号链接和 junction；缺失只能由调用方在叶节点处理。 */
async function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    assert.equal((await fs.lstat(current)).isSymbolicLink(), false, prefix + "_REPARSE_PATH");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** 仅 ENOENT 表示不存在，权限及其他 I/O 故障原样失败。 */
async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** 流式 SHA256 不把完整工件载入内存。 */
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 普通文件完整库存同时拒绝链接，供只读输入和工程 marker 前后核对。 */
async function inventory(roots) {
  const result = {};
  for (const [label, root] of Object.entries(roots)) {
    await noLinks(root);
    const pending = [root];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false, prefix + "_INVENTORY_LINK");
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else {
          const stat = await fs.lstat(file);
          assert.ok(stat.isFile() && stat.nlink === 1, prefix + "_ORDINARY_FILE_REQUIRED");
          result[label + "/" + path.relative(root, file).replaceAll("\\", "/")] = await digest(file);
        }
      }
    }
  }
  return result;
}

/** JSON 必须为真实 UTF-8；可选性由 exists 显式决定。 */
async function readJson(file) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file)));
}

/** 日志只有缺失可为空；坏编码和坏 JSON 均阻断验收。 */
async function jsonLines(file) {
  if (!(await exists(file))) return [];
  return new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file)).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

/** 独占证据文件禁止覆盖，所有诊断保留真实换行。 */
async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}

/** 断点来自已核 SHA 的当前构建，匹配歧义直接失败。 */
function sourceLine(source, fragment) {
  const lines = source.split(/\r?\n/u), matches = lines.flatMap((line, index) => line.includes(fragment) ? [index] : []);
  assert.equal(matches.length, 1, prefix + "_BREAKPOINT_SOURCE_AMBIGUOUS: " + fragment);
  return matches[0];
}

/** 首次写入前核本片完整资源及 asar 当前构建，拒绝前片旧 Client/壳冒充。 */
export async function preflight(args) {
  assert.equal(process.platform, "win32", prefix + "_WINDOWS_REQUIRED");
  assert.ok(args.length === 2 && args.every(value => typeof value === "string" && value.trim()),
    "用法：electron-startup-storage.smoke.mjs <exe> <全新独占输出root>");
  const requestedExe = path.resolve(args[0]), requestedRoot = path.resolve(args[1]);
  assert.ok(!outside(allowedRoot, requestedRoot) && requestedRoot !== allowedRoot, prefix + "_OUTPUT_SCOPE_INVALID");
  await noLinks(requestedExe); await noLinks(path.dirname(requestedRoot)); await noLinks(frozenResources);
  const executable = await fs.realpath(requestedExe), artifact = path.dirname(executable);
  const root = path.join(await fs.realpath(path.dirname(requestedRoot)), path.basename(requestedRoot));
  const actualAllowed = await fs.realpath(allowedRoot);
  assert.ok(!outside(actualAllowed, root) && root !== actualAllowed, prefix + "_OUTPUT_SCOPE_INVALID");
  assert.equal(path.basename(executable).toLowerCase(), "codeflowai.exe", prefix + "_EXE_REQUIRED");
  for (const source of [artifact, frozenResources, await fs.realpath(repository)]) {
    separate(source, root); separate(source, requestedRoot);
  }
  separate(await fs.realpath(repository), artifact);
  assert.equal(await exists(root), false, prefix + "_OUTPUT_EXISTS");
  const resources = path.join(artifact, "resources"), asarFile = path.join(resources, "app.asar");
  for (const file of [executable, asarFile, path.join(resources, "client/dist/index.cjs"), path.join(resources, "web/index.html"),
    path.join(resources, "client/dist/desktopUninstallWorker.cjs"),
    path.join(resources, "client/node_modules/node-pty/prebuilds/win32-x64/pty.node"),
    path.join(resources, "client/node_modules/@napi-rs/keyring/keyring.win32-x64-msvc.node")]) {
    await noLinks(file);
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && stat.nlink === 1, prefix + "_COMPLETE_PACKAGE_REQUIRED");
  }
  const require = createRequire(new URL("../package.json", import.meta.url));
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
  const sources = {}, buildHashes = {};
  for (const name of ["main.js", "desktopStorageLocation.js", "desktopMaintenanceRecord.js", "deviceIdentity.js"]) {
    const localFile = path.join(repository, "apps/desktop/dist", name);
    await noLinks(localFile);
    const local = await fs.readFile(localFile), packaged = asar.extractFile(asarFile, "dist/" + name);
    const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha(packaged), sha(local), prefix + "_STALE_ASAR: " + name);
    sources[name] = new TextDecoder("utf-8", { fatal: true }).decode(local);
    buildHashes[name] = sha(local);
  }
  const frozen = await inventory({ resources: frozenResources });
  const packagedResources = await inventory({ resources }); delete packagedResources["resources/app.asar"];
  for (const key of Object.keys(packagedResources).filter(key => key.startsWith("resources/app.asar.unpacked/"))) delete packagedResources[key];
  assert.deepEqual(packagedResources, frozen,
    prefix + "_FROZEN_RESOURCES_MISMATCH");
  for (const name of ["index.cjs", "desktopUninstallWorker.cjs"]) {
    const local = path.join(repository, "apps/desktop/client/dist", name), packaged = path.join(resources, "client/dist", name);
    assert.equal(await digest(packaged), await digest(local), prefix + "_STALE_CLIENT: " + name);
    buildHashes["client/" + name] = await digest(local);
  }
  return { executable, artifact, resources, root, sources, buildHashes };
}

/** 所有场景共享最小真实工程标记，逐字节摘要必须保持。 */
async function fixture(paths, name) {
  const root = path.join(paths.root, name); await fs.mkdir(root);
  const profile = path.join(root, "profile"), data = path.join(root, "custom"), project = path.join(root, "project");
  await fs.mkdir(profile); await fs.mkdir(path.join(project, ".codeflow"), { recursive: true });
  await fs.writeFile(path.join(project, "project.marker"), Buffer.from("D16 project marker\r\n"), { flag: "wx" });
  await fs.writeFile(path.join(project, ".codeflow/knowledge.marker"), Buffer.from("D16 knowledge marker\n"), { flag: "wx" });
  const markerBefore = await inventory({ project });
  const env = await isolatedEnvironment(path.join(root, "environment"), { CODEFLOWAI_DESKTOP_DATA_DIR: data });
  return { root, profile, data, project, markerBefore, env };
}

/** 只登记本次主进程父链，PID 重用和未知身份不得进入清理。 */
function processOwner(paths, context, child) {
  const records = new Map(), started = Date.now();
  return {
    records,
    /** 兼容 Playwright 启动未返回时的精确 profile 发现，并核对完整进程身份。 */
    async discover() {
      const all = await queryProcesses(), ids = new Set(records.keys());
      const main = child();
      if (main?.pid) ids.add(main.pid);
      else for (const item of all) {
        if (!item.commandLine?.includes(context.profile) || !item.commandLine.toLowerCase().includes(paths.executable.toLowerCase())) continue;
        const parent = all.find(candidate => candidate.pid === item.parentPid);
        assert.ok(Date.parse(item.created) >= started && (item.parentPid === process.pid || parent?.parentPid === process.pid), prefix + "_OWNERSHIP_UNKNOWN");
        ids.add(item.pid); if (parent?.parentPid === process.pid) ids.add(parent.pid);
      }
      let added;
      do {
        added = false;
        for (const item of all) if (ids.has(item.parentPid) && !ids.has(item.pid)) { ids.add(item.pid); added = true; }
      } while (added);
      for (const item of all.filter(item => ids.has(item.pid))) {
        assert.ok(item.created && item.executable && item.commandLine, prefix + "_PROCESS_IDENTITY_REQUIRED");
        if (records.has(item.pid)) assert.deepEqual(item, records.get(item.pid), prefix + "_PID_CHANGED");
        else records.set(item.pid, item);
      }
    },
  };
}

/** Inspector 支持多次真实断点；传输、协议及远端求值异常全部显式失败。 */
async function inspectorAt(url) {
  const socket = new WebSocket(url), pending = new Map(), pauses = [], waiters = [];
  let sequence = 0, failed, closing = false;
  const fail = error => {
    failed = error;
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true });
  });
  const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
  socket.addEventListener("message", event => {
    try {
      const response = JSON.parse(event.data);
      if (response.id) {
        const operation = pending.get(response.id);
        assert.ok(operation, prefix + "_INSPECTOR_RESPONSE_UNKNOWN"); pending.delete(response.id);
        if (response.error) operation.reject(new Error(JSON.stringify(response.error))); else operation.resolve(response.result);
      } else if (response.method === "Debugger.paused") {
        if (waiters.length) waiters.shift().resolve(response.params); else pauses.push(response.params);
      }
    } catch (error) { fail(error); }
  });
  socket.addEventListener("error", event => fail(event.error ?? new Error(prefix + "_INSPECTOR_ERROR")));
  socket.addEventListener("close", () => { if (!closing) fail(new Error(prefix + "_INSPECTOR_CLOSED")); });
  await bounded(opened, 10_000, prefix + "_INSPECTOR_OPEN_TIMEOUT");
  return {
    /** 每次 RPC 独立限时，不把 exceptionDetails 当成成功。 */
    async call(method, params = {}) {
      if (failed) throw failed;
      const id = ++sequence, result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      try {
        socket.send(JSON.stringify({ id, method, params }));
        const response = await bounded(result, 10_000, prefix + "_INSPECTOR_CALL_TIMEOUT");
        assert.equal(response.exceptionDetails, undefined, prefix + "_INSPECTOR_EVALUATION_FAILED: " + JSON.stringify(response.exceptionDetails));
        return response;
      } finally { pending.delete(id); }
    },
    /** 断点事件排队，避免恢复响应与下次暂停竞态。 */
    async pause() {
      if (failed) throw failed;
      if (pauses.length) return pauses.shift();
      return await bounded(new Promise((resolve, reject) => waiters.push({ resolve, reject })), 90_000, prefix + "_PAUSE_TIMEOUT");
    },
    /** 恢复后主动断开，避免 inspector 阻止实际进程退出。 */
    async close() {
      assert.equal(pending.size, 0); closing = true; socket.close();
      await bounded(closed, 5_000, prefix + "_INSPECTOR_CLOSE_TIMEOUT");
    },
  };
}

/** 入口只安装观测和错误框显示适配，不覆写产品准入。 */
function observationExpression(directory) {
  return `(() => {
    const fs = require('node:fs'), promises = require('node:fs/promises'), { app, dialog, BrowserWindow } = require('electron');
    const value = { pid: process.pid, packaged: app.isPackaged, order: 0, children: [], windows: 0, windowsClosed: 0, trays: 0, applicationExitCalls: 0, dialogs: [] };
    let sequence = 0;
    const save = () => { const file = ${JSON.stringify(directory)} + '/' + String(++sequence).padStart(8, '0') + '.json';
      fs.writeFileSync(file + '.tmp', JSON.stringify(value), { encoding: 'utf8', flag: 'wx' }); fs.renameSync(file + '.tmp', file); };
    globalThis.__d16 = { value, save, promises };
    require('node:diagnostics_channel').channel('child_process').subscribe(({ process: child }) => {
      const record = { executable: child.spawnfile }; value.children.push(record); save();
      child.on('spawn', () => { record.pid = child.pid; record.executable = child.spawnfile; record.args = child.spawnargs;
        record.spawnOrder = ++value.order; save(); });
      child.on('message', message => {
        if (message?.t === 'desktop.ready') record.ready = { requestId: message.requestId, health: message.health };
        else if (message?.schemaVersion === 1 && typeof message.ok === 'boolean') record.response = {
          schemaVersion: message.schemaVersion, requestId: message.requestId, ok: message.ok, result: message.result, errorCode: message.error?.code };
        else return; save();
      });
      child.on('exit', (code, signal) => { record.exit = { code, signal }; save(); });
      child.on('close', (code, signal) => { record.close = { code, signal }; record.closeOrder = ++value.order; save(); });
    });
    app.on('browser-window-created', (_, window) => { value.windows++; save(); window.on('closed', () => { value.windowsClosed++; save(); }); });
    dialog.showErrorBox = (title, message) => { value.dialogs.push({ title, message, windows: BrowserWindow.getAllWindows().length,
      openChildren: value.children.filter(child => !child.close).length }); save(); };
    process.on('exit', code => { value.nodeExitCode = code; save(); }); save();
    return { pid: process.pid, packaged: app.isPackaged };
  })()`;
}

/** 只读已原子发布的最新观测，不读取仍在写入的临时文件。 */
async function latestObservation(directory) {
  const entries = (await fs.readdir(directory)).filter(name => /^\d{8}\.json$/u.test(name)).sort();
  assert.ok(entries.length, prefix + "_OBSERVATION_MISSING");
  return await readJson(path.join(directory, entries.at(-1)));
}

/** 所有拒绝场景通过真实 main 启动；注入只在已核定 I/O 边界发生。 */
async function inspectedScenario(paths, context, mode, expectedCode, maintenance) {
  const root = path.join(context.root, mode); await fs.mkdir(root);
  const observationDir = path.join(root, "observations"); await fs.mkdir(observationDir);
  const report = { mode, status: "running", stderr: "" };
  const child = spawn(paths.executable, ["--inspect-brk=127.0.0.1:0", `--user-data-dir=${context.profile}`],
    { env: context.env, cwd: context.project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let didClose = false;
  const closed = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("close", (code, signal) => { didClose = true; resolve({ code, signal }); });
  });
  child.stdout.resume(); child.stderr.setEncoding("utf8").on("data", chunk => { report.stderr = (report.stderr + chunk).slice(-65_536); });
  const owner = processOwner(paths, context, () => child);
  let inspector, knownError;
  try {
    await owner.discover(); assert.ok(owner.records.has(child.pid), prefix + "_MAIN_NOT_OBSERVED");
    await waitUntil(() => {
      if (didClose) throw new Error(prefix + "_EARLY_EXIT");
      return /Debugger listening on (ws:\/\/[^\s]+)/u.test(report.stderr);
    }, 15_000, prefix + "_INSPECTOR_ADDRESS_TIMEOUT");
    inspector = await inspectorAt(report.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/u)[1]);
    await inspector.call("Runtime.enable"); await inspector.call("Debugger.enable"); await inspector.call("Runtime.runIfWaitingForDebugger");
    assert.equal((await inspector.pause()).reason, "Break on start");
    const observation = await inspector.call("Runtime.evaluate", { expression: observationExpression(observationDir), includeCommandLineAPI: true, returnByValue: true });
    assert.deepEqual(observation.result.value, { pid: child.pid, packaged: true });
    await inspector.call("Debugger.setBreakpointByUrl", { urlRegex: "[\\\\/]dist[\\\\/]main\\.js$",
      lineNumber: sourceLine(paths.sources["main.js"], "const iconPath = app.isPackaged"),
      condition: "(globalThis.__d16.value.trays++, globalThis.__d16.save(), false)" });
    let breakpoint, exitBreakpoint;
    if (mode === "interrupt") breakpoint = await inspector.call("Debugger.setBreakpointByUrl", {
      urlRegex: "[\\\\/]dist[\\\\/]main\\.js$", lineNumber: sourceLine(paths.sources["main.js"], "application = createDesktopApplication({"),
    });
    if (mode === "backfill-failure") {
      breakpoint = await inspector.call("Debugger.setBreakpointByUrl", {
        urlRegex: "[\\\\/]dist[\\\\/]desktopStorageLocation\\.js$", lineNumber: sourceLine(paths.sources["desktopStorageLocation.js"], "await fs.rename(temporaryPath,"),
        condition: "expected.clientId === null && next.clientId !== null",
      });
      exitBreakpoint = await inspector.call("Debugger.setBreakpointByUrl", { urlRegex: "[\\\\/]dist[\\\\/]main\\.js$",
        lineNumber: sourceLine(paths.sources["main.js"], "await application.exit();"),
        condition: "(globalThis.__d16.value.applicationExitCalls++, globalThis.__d16.save(), true)" });
    }
    await inspector.call("Debugger.resume");
    if (breakpoint) {
      const paused = await inspector.pause(); assert.ok(paused.hitBreakpoints.includes(breakpoint.breakpointId), prefix + "_WRONG_BREAKPOINT");
      report.locatorBeforeInjection = await readJson(path.join(context.profile, locatorName));
      report.locatorBeforeSha256 = await digest(path.join(context.profile, locatorName));
      assert.deepEqual(report.locatorBeforeInjection, locator(paths, context));
      if (mode === "interrupt") {
        assert.equal(await exists(context.data), false, prefix + "_BUSINESS_DATA_BEFORE_INTERRUPT");
        const expression = `(() => { const state = globalThis.__d16, original = state.promises.mkdir;
          state.promises.mkdir = async (...args) => {
            if (args[0] === ${JSON.stringify(context.data)}) { state.promises.mkdir = original; state.value.interruptInjected = true; state.save();
              throw Object.assign(new Error(${JSON.stringify(expectedCode)}), { code: ${JSON.stringify(expectedCode)} }); }
            return await original(...args);
          }; return dataDir; })()`;
        const result = await inspector.call("Debugger.evaluateOnCallFrame", { callFrameId: paused.callFrames[0].callFrameId, expression, returnByValue: true });
        assert.equal(result.result.value, context.data);
      } else {
        const expression = `(() => { const state = globalThis.__d16, original = state.promises.rename, source = temporaryPath,
          target = ${JSON.stringify(path.join(context.profile, locatorName))};
          if (expected.clientId !== null || !next.clientId || !next.deviceId) throw new Error('D16_INVALID_BACKFILL_FRAME');
          state.promises.rename = async (...args) => {
            if (args[0] === source && args[1] === target) { state.promises.rename = original; state.value.backfillInjected = true; state.save();
              throw Object.assign(new Error(${JSON.stringify(expectedCode)}), { code: ${JSON.stringify(expectedCode)} }); }
            return await original(...args);
          }; return { clientId: next.clientId, deviceId: next.deviceId }; })()`;
        const result = await inspector.call("Debugger.evaluateOnCallFrame", { callFrameId: paused.callFrames[0].callFrameId, expression, returnByValue: true });
        report.rejectedCompletion = result.result.value;
        await owner.discover();
      }
      await inspector.call("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId });
      await inspector.call("Debugger.resume");
    }
    if (exitBreakpoint) {
      const paused = await inspector.pause();
      assert.ok(paused.hitBreakpoints.includes(exitBreakpoint.breakpointId), prefix + "_APPLICATION_EXIT_BREAKPOINT_MISSING");
      await inspector.call("Debugger.removeBreakpoint", { breakpointId: exitBreakpoint.breakpointId });
      await inspector.call("Debugger.resume");
    }
    await inspector.close(); inspector = undefined;
    await waitUntil(async () => { await owner.discover(); return didClose; }, 60_000, prefix + "_FAILURE_CLOSE_TIMEOUT");
    report.exit = await bounded(closed, 1_000, prefix + "_CLOSE_RESULT_TIMEOUT");
    if (report.exit.error) throw report.exit.error;
    assert.deepEqual(report.exit, { code: 1, signal: null });
    report.observation = await latestObservation(observationDir);
    // Electron 的正常 quit 清理先发 Node exit；最终退出码以上面的 child close 为准。
    assert.equal(report.observation.nodeExitCode, mode === "backfill-failure" ? 0 : 1);
    assert.equal(report.observation.dialogs.length, 1);
    assert.equal(report.observation.dialogs[0].message, expectedCode);
    assert.equal(report.observation.dialogs[0].openChildren, 0, prefix + "_CLIENT_OPEN_AT_FAILURE");
    assert.equal(report.observation.dialogs[0].windows, 0, prefix + "_WINDOW_OPEN_AT_FAILURE");
    if (mode === "backfill-failure") {
      assert.equal(report.observation.backfillInjected, true);
      assert.equal(report.observation.applicationExitCalls, 1, prefix + "_APPLICATION_EXIT_NOT_USED");
      const client = report.observation.children.find(item => item.ready);
      assert.ok(client?.executable && client.ready.health.database === "ready", prefix + "_REAL_CLIENT_READY_MISSING");
      assert.ok(owner.records.get(client.pid)?.commandLine.includes(path.join(paths.resources, "client/dist/index.cjs")),
        prefix + "_REAL_CLIENT_PATH_MISMATCH");
      assert.deepEqual(client.close, { code: 0, signal: null }, prefix + "_CLIENT_CLOSE_MISSING");
      assert.equal(report.observation.windows, 1); assert.equal(report.observation.windowsClosed, 1);
      assert.equal(report.observation.trays, 1);
    } else {
      assert.deepEqual(report.observation.children, []); assert.equal(report.observation.windows, 0); assert.equal(report.observation.trays, 0);
      assert.equal(await exists(context.data), false, prefix + "_BUSINESS_DATA_CREATED");
      if (mode === "interrupt") assert.equal(report.observation.interruptInjected, true);
    }
    assert.equal(await exists(path.join(context.profile, "runtime")), false, prefix + "_DEFAULT_RUNTIME_CREATED");
    assert.deepEqual((await fs.readdir(context.profile)).filter(name => name.startsWith(locatorName + ".")), [], prefix + "_LOCATOR_TEMP_REMAINED");
    if (!maintenance) {
      assert.deepEqual(await readJson(path.join(context.profile, locatorName)), locator(paths, context));
      assert.equal(await digest(path.join(context.profile, locatorName)), report.locatorBeforeSha256, prefix + "_LOCATOR_BYTES_CHANGED");
    }
    else {
      assert.equal(await exists(path.join(context.profile, locatorName)), false, prefix + "_MAINTENANCE_LOCATOR_CREATED");
      assert.deepEqual(await fs.readFile(path.join(context.profile, "desktop-uninstall-result.json")), maintenance.bytes);
    }
    report.errors = await jsonLines(path.join(context.profile, "logs/desktop-errors.jsonl"));
    assert.equal(report.errors.length, 1); assert.equal(report.errors[0].errorCode, expectedCode);
    assert.ok(report.errors[0].causeCodes.includes(expectedCode)); assert.match(report.errors[0].requestId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(await jsonLines(path.join(context.data, "logs/desktop-errors.jsonl")), [], prefix + "_STARTUP_ERROR_OUTSIDE_PROFILE");
    if (maintenance) {
      const error = report.errors[0], record = maintenance.record;
      assert.equal(error.maintenanceRequestId, record.requestId); assert.equal(error.clientId, record.clientId);
      assert.equal(error.oldDeviceId, record.oldDeviceId); assert.equal(error.mode, record.mode); assert.equal(error.maintenancePhase, record.phase);
      assert.notEqual(error.requestId, record.requestId);
    }
    await waitUntil(async () => (await queryProcesses([...owner.records.keys()])).length === 0, 10_000, prefix + "_OWNED_PROCESSES_REMAIN");
    assert.deepEqual(await inventory({ project: context.project }), context.markerBefore, prefix + "_PROJECT_CHANGED");
  } catch (error) { knownError = error; }
  const cleanupErrors = [];
  if (inspector) { try { await inspector.close(); } catch (error) { cleanupErrors.push(error); } }
  if (knownError) {
    try { await owner.discover(); } catch (error) { cleanupErrors.push(error); }
    try { await stopOwned([...owner.records.values()]); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) knownError = new AggregateError([...(knownError ? [knownError] : []), ...cleanupErrors], prefix + "_CLEANUP_FAILED");
  child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
  report.processes = [...owner.records.values()]; report.status = knownError ? "failed" : "passed";
  if (knownError) report.failure = failure(knownError);
  await writeJson(path.join(root, "verification.json"), report);
  if (knownError) throw knownError;
  return report;
}

/** 首次定位预期只包含固定安装、custom 目录与双 null 身份。 */
function locator(paths, context) {
  return { schemaVersion: 1, appId, installRoot: paths.artifact, dataDir: context.data, clientId: null, deviceId: null };
}

/** 停机后复制 DB/WAL 再查询，不让验收连接向业务源创建 sidecar。 */
async function databaseClientId(data, root) {
  const snapshot = path.join(root, "database-inspection"); await fs.mkdir(snapshot);
  const database = path.join(data, "codeflowai.db"), copy = path.join(snapshot, "codeflowai.db");
  await fs.copyFile(database, copy);
  if (await exists(database + "-wal")) await fs.copyFile(database + "-wal", copy + "-wal");
  const db = new DatabaseSync(copy, { readOnly: true });
  let result, queryError;
  try { result = db.prepare("SELECT value FROM meta WHERE key = ?").get("client_id")?.value; }
  catch (error) { queryError = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError([...(queryError ? [queryError] : []), error], prefix + "_DB_CLOSE_FAILED"); }
  if (queryError) throw queryError;
  return result;
}

/** 同一 profile 移除 env 后必须沿固化 custom 真正 ready，并通过原 renderer bridge 干净退出。 */
async function restartScenario(paths, context, initial = false) {
  const root = path.join(context.root, initial ? "initial" : "restart"); await fs.mkdir(root);
  const env = { ...context.env };
  if (!initial) { delete env.CODEFLOWAI_DESKTOP_DATA_DIR; assert.equal(Object.hasOwn(env, "CODEFLOWAI_DESKTOP_DATA_DIR"), false); }
  const report = { mode: initial ? "initial-ready" : "restart-without-env", status: "running" };
  let session, knownError;
  const owner = processOwner(paths, context, () => session?.child);
  try {
    session = await launchPackagedApp({ executablePath: paths.executable, userDataDir: context.profile, env, cwd: context.project });
    report.output = session.run; await owner.discover();
    const page = await session.application.firstWindow({ timeout: 60_000 });
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    await waitUntil(async () => {
      const location = await readJson(path.join(context.profile, locatorName));
      return typeof location.clientId === "string" && typeof location.deviceId === "string";
    }, 60_000, prefix + "_LOCATOR_COMPLETION_TIMEOUT");
    report.state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, prefix + "_GET_STATE_TIMEOUT");
    assert.equal(report.state.status, "ready"); assert.equal(report.state.health.database, "ready");
    await owner.discover(); report.client = owner.records.get(report.state.pid);
    assert.ok(report.client?.commandLine.includes(path.join(paths.resources, "client/dist/index.cjs")), prefix + "_REAL_CLIENT_PATH_MISMATCH");
    report.shell = await session.application.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath("userData"), executable: process.execPath }));
    assert.deepEqual(report.shell, { packaged: true, userData: context.profile, executable: paths.executable });
    report.locator = await readJson(path.join(context.profile, locatorName));
    const config = await readJson(path.join(context.data, "config.json")), identity = await readJson(path.join(context.data, "device-identity.json"));
    assert.deepEqual(report.locator, { ...locator(paths, context), clientId: config.clientId, deviceId: identity.deviceId });
    const web = await page.evaluate(async () => {
      const response = await fetch("codeflow://desktop/index.html");
      if (!response.ok) throw new Error("D16_WEB_READ_FAILED: " + response.status);
      return await response.text();
    });
    assert.equal(crypto.createHash("sha256").update(web).digest("hex"), await digest(path.join(paths.resources, "web/index.html")));
    const clientCloseFile = path.join(root, "client-close.json");
    await session.application.evaluate((_, input) => {
      const child = process._getActiveHandles().find(handle => handle.pid === input.pid && typeof handle.send === "function");
      if (!child) throw new Error("D16_CLIENT_CLOSE_OBSERVER_UNAVAILABLE");
      child.once("close", (code, signal) => process.getBuiltinModule("node:fs").writeFileSync(input.file,
        JSON.stringify({ pid: input.pid, code, signal }), { encoding: "utf8", flag: "wx" }));
    }, { pid: report.state.pid, file: clientCloseFile });
    await bounded(Promise.all([session.application.waitForEvent("close", { timeout: 40_000 }),
      page.evaluate(() => { void window.codeflowDesktop.exit(); })]), 42_000, prefix + "_BRIDGE_EXIT_TIMEOUT");
    assert.equal(session.child.exitCode, 0); report.exitCode = session.child.exitCode;
    report.clientClose = await readJson(clientCloseFile);
    assert.deepEqual(report.clientClose, { pid: report.state.pid, code: 0, signal: null });
    await waitUntil(async () => (await queryProcesses([...owner.records.keys()])).length === 0, 10_000, prefix + "_RESTART_PROCESSES_REMAIN");
    assert.equal(await databaseClientId(context.data, root), report.locator.clientId);
    assert.equal(await exists(path.join(context.profile, "runtime")), false, prefix + "_DEFAULT_RUNTIME_CREATED");
    assert.deepEqual(await jsonLines(path.join(context.data, "logs/desktop-errors.jsonl")), []);
    assert.deepEqual(await jsonLines(path.join(context.data, "logs/desktop-runtime-errors.jsonl")), []);
    assert.deepEqual(await inventory({ project: context.project }), context.markerBefore, prefix + "_PROJECT_CHANGED");
  } catch (error) { knownError = error; }
  if (knownError) {
    const errors = [];
    try { await owner.discover(); } catch (error) { errors.push(error); }
    try { await stopOwned([...owner.records.values()]); } catch (error) { errors.push(error); }
    if (session) {
      try { await bounded(session.application.close(), 5_000, prefix + "_CONNECTION_CLOSE_TIMEOUT"); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) knownError = new AggregateError([knownError, ...errors], prefix + "_RESTART_CLEANUP_FAILED");
  }
  if (session) { session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref(); }
  report.processes = [...owner.records.values()]; report.status = knownError ? "failed" : "passed";
  if (knownError) report.failure = failure(knownError);
  await writeJson(path.join(root, "verification.json"), report);
  if (knownError) throw knownError;
  return report;
}

/** 准备进程先隔离环境再 import 原 ClientDb；只造禁用本机任务，不启动普通 Client。 */
function taskProgram() {
  return `import assert from 'node:assert/strict';
    import fs from 'node:fs'; import path from 'node:path';
    const input = JSON.parse(process.argv[2]);
    const { openClientDb } = await import(${JSON.stringify(pathToFileURL(path.join(repository, "apps/desktop/client/src/db/clientDb.ts")).href)});
    const { openSqliteDb } = await import(${JSON.stringify(pathToFileURL(path.join(repository, "apps/desktop/client/src/db/sqliteDb.ts")).href)});
    const { scheduledTaskRuntimeKey } = await import(${JSON.stringify(pathToFileURL(path.join(repository, "apps/desktop/client/src/db/repos/scheduledTaskRuntimeStateRepo.ts")).href)});
    /** 本地观察连接必须关闭，双错原样保留。 */
    function using(db, operation) { let failed=false, primary; try { return operation(db); } catch(error) { failed=true; primary=error; throw error; }
      finally { try { db.close(); } catch(error) { throw failed ? new AggregateError([primary,error],'D16_FIXTURE_CLOSE_FAILED') : error; } } }
    const files = [path.join(input.data, 'codeflowai.db'), ...input.workspaces.map(item => path.join(item.path,'.codeflow/workspace.db'))];
    if (input.action === 'seed') using(openClientDb({ dbPath: files[0], existingOnly: true }), db => {
      assert.equal(db.db.prepare("SELECT value FROM meta WHERE key='client_id'").get().value,input.clientId);
      for (const workspace of input.workspaces) db.workspaces.upsert({ id: workspace.id, title: 'D16保留工作区', path: workspace.path });
      for (const [index, scope] of [null, ...input.workspaces.map(item=>item.id)].entries()) {
        db.withLocalScheduledTasks(scope, repos => {
          for (const tombstone of [false,true]) {
            const id='d16-'+index+(tombstone?'-deleted':'-disabled'), at=1000+index*100;
            repos.configs.create({ config: { id,source:'local',clientId:input.clientId,deviceId:input.oldDeviceId,
              workspaceScope:scope?{scopeType:'local_workspace',scopeId:scope}:null,name:'保留任务',description:'D16 only owner changes',
              taskType:'script',cronExpr:'0 0 1 1 *',timezone:'UTC',enabled:true,payload:{shell:'sh',command:'echo forbidden-smoke-execution',...(scope?{contextWorkspaceId:scope}:{})},
              concurrencyPolicy:'queue_one',missedPolicy:'skip_missed',timeoutMs:1000 },at });
            repos.runs.create({expectedConfigRevision:1,run:{ id:'history-'+id,taskId:id,clientId:input.clientId,deviceId:input.oldDeviceId,
              workspaceId:scope,workflowInstanceId:null,workflowNameSnapshot:null,workflowVersion:null,scheduledAt:at,startedAt:null,
              finishedAt:at,status:'skipped',triggerSource:'schedule',attempt:1,durationMs:null,summary:'old immutable run',errorMessage:null,
              outputExcerpt:null,createdAt:at }});
            if(tombstone) repos.configs.delete({taskId:id,expectedRevision:1,at:at+1});
            else repos.configs.setEnabled({taskId:id,expectedRevision:1,enabled:false,at:at+1});
            repos.runtime.markStarted({taskId:scheduledTaskRuntimeKey(id,'local'),clientId:input.clientId,deviceId:input.oldDeviceId,
              scheduledAt:at+2,runId:'old-running-'+id,startedAt:at+3});
            repos.runtime.queueLocalConcurrency({taskId:id,clientId:input.clientId,deviceId:input.oldDeviceId,
              runId:'old-running-'+id,scheduledAt:at+4,at:at+5});
          }
        });
      }
      db.workspaces.delete(input.workspaces[1].id);
      const registeredAt=Date.now();
      db.db.prepare('UPDATE workspaces SET updated_at=? WHERE id=?').run(registeredAt+2,input.workspaces[0].id);
      db.db.prepare('UPDATE workspaces SET updated_at=? WHERE id=?').run(registeredAt+1,input.workspaces[1].id);
    });
    if (input.action === 'trigger-on' || input.action === 'trigger-off') using(openSqliteDb(files[2],{fileMustExist:true}),db=>{
      db.exec(input.action==='trigger-on' ? "CREATE TRIGGER d16_reinstall_failure BEFORE UPDATE OF device_id ON scheduled_task_configs BEGIN SELECT RAISE(ABORT,'D16_WORKSPACE_REBIND_INJECTED'); END"
        : 'DROP TRIGGER d16_reinstall_failure');
      db.pragma('wal_checkpoint(TRUNCATE)');
    });
    const snapshots=files.map((file,index)=>using(openSqliteDb(file,{readonly:true,fileMustExist:true}),db=>({
      file,configs:db.prepare('SELECT * FROM scheduled_task_configs ORDER BY id').all(),
      runtime:db.prepare('SELECT * FROM scheduled_task_runtime_states ORDER BY task_id').all(),
      runs:db.prepare('SELECT * FROM scheduled_task_runs ORDER BY id').all(),
      ...(index===0?{workspaces:db.prepare('SELECT * FROM workspaces ORDER BY id').all()}: {})
    })));
    fs.writeFileSync(input.output,JSON.stringify(snapshots,null,2)+'\\n',{encoding:'utf8',flag:'wx'});
    console.log(JSON.stringify({status:'passed',sources:snapshots.length,tasks:snapshots.reduce((n,item)=>n+item.configs.length,0)}));`;
}

/** Node 准备和观察同样持有精确进程 owner，失败保留输出及清理副因。 */
async function taskOperation(paths, context, action, name) {
  const output = path.join(context.root, name + ".json"), input = { action, output, data: context.data,
    clientId: context.retained.clientId, oldDeviceId: context.retained.oldDeviceId, workspaces: context.workspaces };
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-", JSON.stringify(input)], {
    cwd: path.join(repository, "apps/desktop/client"), env: { ...context.env, CODEFLOWAI_CLIENT_LOG_DIR: path.join(context.root, "fixture-logs") },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const record = { action, stdout: "", stderr: "" }, owner = processOwner(paths, context, () => child);
  const closed = new Promise(resolve => { child.once("error", error => resolve({ error })); child.once("close", (code, signal) => resolve({ code, signal })); });
  child.stdout.setEncoding("utf8").on("data", chunk => { record.stdout = (record.stdout + chunk).slice(-65_536); });
  child.stderr.setEncoding("utf8").on("data", chunk => { record.stderr = (record.stderr + chunk).slice(-65_536); });
  let knownError;
  try {
    await owner.discover(); child.stdin.end(taskProgram());
    record.exit = await bounded(closed, 60_000, prefix + "_TASK_FIXTURE_TIMEOUT");
    if (record.exit.error) throw record.exit.error;
    assert.deepEqual(record.exit, { code: 0, signal: null }, prefix + "_TASK_FIXTURE_FAILED: " + record.stderr);
  } catch (error) { knownError = error; }
  if (knownError) {
    try { await stopOwned([...owner.records.values()]); }
    catch (cleanup) { knownError = new AggregateError([knownError, cleanup], prefix + "_TASK_FIXTURE_CLEANUP_FAILED"); }
  }
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
  if (knownError) record.failure = failure(knownError);
  await writeJson(path.join(context.root, name + "-process.json"), record);
  if (knownError) throw knownError;
  return await readJson(output);
}

/** 新 profile 先经过真实 ready/退出，再造已卸载保留的任务与精确摘要。 */
async function retainedFixture(paths, name) {
  const context = await fixture(paths, name);
  context.initial = await restartScenario(paths, context, true);
  const current = await readJson(path.join(context.profile, locatorName));
  context.retained = { clientId: current.clientId, oldDeviceId: current.deviceId, nextDeviceId: crypto.randomUUID(), createdAt: "2026-10-31T00:00:00.000Z" };
  context.workspaces = [1, 2].map(index => ({ id: `${current.clientId}:d16-w${index}`, path: path.join(context.root, "workspace-" + index) }));
  for (const item of context.workspaces) {
    await fs.mkdir(path.join(item.path, ".codeflow"), { recursive: true });
    await fs.writeFile(path.join(item.path, "project.marker"), "D16 workspace\n", { encoding: "utf8", flag: "wx" });
    await fs.writeFile(path.join(item.path, ".codeflow/knowledge.marker"), "D16 knowledge\n", { encoding: "utf8", flag: "wx" });
  }
  context.workspaceMarkers = await Promise.all(context.workspaces.flatMap(item => ["project.marker", ".codeflow/knowledge.marker"].map(async name =>
    [path.join(item.path, name), await digest(path.join(item.path, name))])));
  context.taskBefore = await taskOperation(paths, context, "seed", "tasks-before");
  assert.equal(context.taskBefore.reduce((count, item) => count + item.configs.length, 0), 6);
  assert.ok(context.taskBefore.every(item => item.runs.length === 2 && item.configs.every(row => row.enabled === 0)));
  await fs.unlink(path.join(context.data, "device-identity.json"));
  return context;
}

/** 只在全部业务连接关闭后签发 completed 摘要，触发器也先于该授权准备。 */
async function authorizeRetained(paths, context) {
  const retainedFiles = {};
  for (const [key, file] of Object.entries({ configSha256: "config.json", databaseSha256: "codeflowai.db", metadataSha256: "codeflowai.db.meta.json" })) {
    retainedFiles[key] = await digest(path.join(context.data, file));
  }
  context.maintenance = { schemaVersion: 1, appId, requestId: "reinstall:" + crypto.randomUUID(), mode: "keep", phase: "completed",
    installRoot: paths.artifact, dataDir: context.data, ...context.retained, retainedFiles };
  context.recordBytes = Buffer.from(JSON.stringify(context.maintenance) + "\n");
  await fs.writeFile(path.join(context.profile, "desktop-uninstall-result.json"), context.recordBytes, { flag: "wx" });
  context.configBefore = await digest(path.join(context.data, "config.json"));
  context.metadataBefore = await digest(path.join(context.data, "codeflowai.db.meta.json"));
}

/** 原行除本机 config/runtime device_id 外必须逐字段相同，旧 runs 原身份保持。 */
function assertTasks(context, actual, devices) {
  const expected = context.taskBefore.map((item, index) => ({ ...item,
    configs: item.configs.map(row => ({ ...row, device_id: devices[index] })),
    runtime: item.runtime.map(row => ({ ...row, device_id: devices[index] })),
  }));
  assert.deepEqual(actual, expected, prefix + "_TASK_FIELDS_CHANGED");
}

/** 真实 main 的应用创建断点之前必须已经关闭 worker、完成 locator 和 consumed。 */
async function reinstallLaunch(paths, context, name, options) {
  const root = path.join(context.root, name); await fs.mkdir(root);
  const observationDir = path.join(root, "observations"); await fs.mkdir(observationDir);
  const env = { ...context.env }; delete env.CODEFLOWAI_DESKTOP_DATA_DIR;
  const report = { mode: name, status: "running", stderr: "" };
  const child = spawn(paths.executable, ["--inspect-brk=127.0.0.1:0", `--user-data-dir=${context.profile}`],
    { env, cwd: context.project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let didClose = false;
  const closed = new Promise(resolve => {
    child.once("error", error => resolve({ error })); child.once("close", (code, signal) => { didClose = true; resolve({ code, signal }); });
  });
  child.stdout.resume(); child.stderr.setEncoding("utf8").on("data", chunk => { report.stderr = (report.stderr + chunk).slice(-65_536); });
  const owner = processOwner(paths, context, () => child);
  let inspector, knownError;
  try {
    await owner.discover();
    await waitUntil(() => {
      if (didClose) throw new Error(prefix + "_REINSTALL_EARLY_EXIT");
      return /Debugger listening on (ws:\/\/[^\s]+)/u.test(report.stderr);
    }, 15_000, prefix + "_INSPECTOR_ADDRESS_TIMEOUT");
    inspector = await inspectorAt(report.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/u)[1]);
    await inspector.call("Runtime.enable"); await inspector.call("Debugger.enable"); await inspector.call("Runtime.runIfWaitingForDebugger");
    assert.equal((await inspector.pause()).reason, "Break on start");
    await inspector.call("Runtime.evaluate", { expression: observationExpression(observationDir), includeCommandLineAPI: true, returnByValue: true });
    let breakpoint;
    if (options.ready) breakpoint = await inspector.call("Debugger.setBreakpointByUrl", {
      urlRegex: "[\\\\/]dist[\\\\/]main\\.js$", lineNumber: sourceLine(paths.sources["main.js"], "application = createDesktopApplication({"),
    });
    else if (options.fault) {
      const locatorFault = options.fault === "locator";
      breakpoint = await inspector.call("Debugger.setBreakpointByUrl", {
        urlRegex: locatorFault ? "[\\\\/]dist[\\\\/]desktopStorageLocation\\.js$" : "[\\\\/]dist[\\\\/]desktopMaintenanceRecord\\.js$",
        lineNumber: sourceLine(paths.sources[locatorFault ? "desktopStorageLocation.js" : "desktopMaintenanceRecord.js"],
          locatorFault ? "await fs.rename(temporaryPath," : "await fs.rename(temporary, target)"),
        condition: locatorFault ? `expected.deviceId === ${JSON.stringify(context.retained.oldDeviceId)} && next.deviceId === ${JSON.stringify(context.retained.nextDeviceId)}`
          : "next.phase === 'consumed'",
      });
    }
    await inspector.call("Debugger.resume");
    if (breakpoint) {
      const paused = await inspector.pause(); assert.ok(paused.hitBreakpoints.includes(breakpoint.breakpointId), prefix + "_REINSTALL_BREAKPOINT_MISSING");
      await owner.discover();
      const before = await latestObservation(observationDir), workers = before.children.filter(item => item.args?.some(arg => arg.endsWith("desktopUninstallWorker.cjs")));
      assert.equal(workers.length, options.worker ? 1 : 0, prefix + "_WORKER_COUNT");
      if (options.worker) {
        assert.deepEqual(workers[0].close, { code: 0, signal: null }, prefix + "_WORKER_NOT_CLOSED_BEFORE_APPLICATION");
        assert.deepEqual(workers[0].response, { schemaVersion: 1, requestId: context.maintenance.requestId, ok: true, result: options.counts });
      }
      assert.equal(before.windows, 0); assert.equal(before.children.filter(item => item.ready).length, 0);
      report.recordBeforeOrdinary = await readJson(path.join(context.profile, "desktop-uninstall-result.json"));
      report.locatorBeforeOrdinary = await readJson(path.join(context.profile, locatorName));
      report.tasksBeforeOrdinary = await taskOperation(paths, context, "snapshot", name + "-tasks-before-ordinary");
      assertTasks(context, report.tasksBeforeOrdinary, [context.retained.nextDeviceId, context.retained.nextDeviceId, context.retained.nextDeviceId]);
      if (options.ready) {
        assert.equal(report.recordBeforeOrdinary.phase, "consumed");
        assert.equal(Object.hasOwn(report.recordBeforeOrdinary, "retainedFiles"), false);
        assert.equal(report.locatorBeforeOrdinary.deviceId, context.retained.nextDeviceId);
      } else {
        assert.equal(report.recordBeforeOrdinary.phase, "reinstalling");
        const locatorFault = options.fault === "locator", code = locatorFault ? "D16_REINSTALL_LOCATOR_FAILED" : "D16_REINSTALL_CONSUMED_FAILED";
        const expression = `(() => { const original = globalThis.__d16.promises.rename,
          source = ${locatorFault ? "temporaryPath" : "temporary"}, destination = ${locatorFault ? JSON.stringify(path.join(context.profile, locatorName)) : "target"};
          globalThis.__d16.promises.rename = async (...args) => {
            if(args[0] === source && args[1] === destination) { globalThis.__d16.promises.rename = original;
              globalThis.__d16.value.renameInjected = ${JSON.stringify(options.fault)}; globalThis.__d16.save();
              throw Object.assign(new Error(${JSON.stringify(code)}),{code:${JSON.stringify(code)}}); }
            return await original(...args);
          }; return true; })()`;
        await inspector.call("Debugger.evaluateOnCallFrame", { callFrameId: paused.callFrames[0].callFrameId, expression, returnByValue: true });
      }
      await inspector.call("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId });
      await inspector.call("Debugger.resume");
    }
    if (options.ready) {
      await waitUntil(async () => {
        await owner.discover();
        const evaluated = await inspector.call("Runtime.evaluate", { expression: `(() => {
          const window = require('electron').BrowserWindow.getAllWindows()[0];
          return window && window.webContents.getURL().startsWith('codeflow://desktop/')
            ? window.webContents.executeJavaScript('window.codeflowDesktop?.getState()') : null;
          })()`, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
        report.state = evaluated.result.value;
        return report.state?.status === "ready";
      }, 60_000, prefix + "_REINSTALL_READY_TIMEOUT");
      assert.equal(report.state.health.database, "ready");
      await inspector.call("Runtime.evaluate", { expression: `require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('void window.codeflowDesktop.exit()')`,
        includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
    }
    await inspector.close(); inspector = undefined;
    await waitUntil(async () => { await owner.discover(); return didClose; }, 60_000, prefix + "_REINSTALL_CLOSE_TIMEOUT");
    report.exit = await bounded(closed, 1_000, prefix + "_REINSTALL_CLOSE_RESULT_TIMEOUT");
    if (report.exit.error) throw report.exit.error;
    assert.deepEqual(report.exit, { code: options.ready ? 0 : 1, signal: null });
    report.observation = await latestObservation(observationDir);
    const workers = report.observation.children.filter(item => item.args?.some(arg => arg.endsWith("desktopUninstallWorker.cjs")));
    const ordinary = report.observation.children.filter(item => item.ready);
    assert.equal(workers.length, options.worker ? 1 : 0, prefix + "_WORKER_COUNT");
    for (const worker of workers) {
      assert.equal(worker.response.requestId, context.maintenance.requestId); assert.ok(worker.close && worker.closeOrder);
      assert.ok(worker.args.includes(path.join(paths.resources, "client/dist/desktopUninstallWorker.cjs")), prefix + "_WORKER_ENTRY_MISMATCH");
    }
    if (options.ready) {
      assert.equal(ordinary.length, 1); assert.equal(ordinary[0].pid, report.state.pid);
      assert.ok(ordinary[0].args.includes(path.join(paths.resources, "client/dist/index.cjs")), prefix + "_ORDINARY_CLIENT_ENTRY_MISMATCH");
      assert.deepEqual(ordinary[0].close, { code: 0, signal: null });
      assert.equal(report.observation.windows, 1); assert.equal(report.observation.windowsClosed, 1);
      assert.deepEqual(report.observation.dialogs, []);
      if (options.worker) assert.ok(workers[0].closeOrder < ordinary[0].spawnOrder, prefix + "_CLIENT_STARTED_BEFORE_WORKER_CLOSE");
    } else {
      assert.deepEqual(ordinary, []); assert.equal(report.observation.windows, 0);
      assert.equal(report.observation.dialogs.length, 1); assert.equal(report.observation.dialogs[0].openChildren, 0);
      report.errors = await jsonLines(path.join(context.profile, "logs/desktop-errors.jsonl"));
      const error = report.errors.at(-1);
      assert.equal(error.maintenanceRequestId, context.maintenance.requestId);
      assert.equal(error.clientId, context.retained.clientId); assert.equal(error.oldDeviceId, context.retained.oldDeviceId);
      if (options.errorCode) assert.ok(error.errorCode === options.errorCode || error.causeCodes.includes(options.errorCode), prefix + "_REINSTALL_ERROR_MISMATCH");
      if (options.fault) assert.equal(report.observation.renameInjected, options.fault);
      if (options.worker && !options.fault) {
        assert.equal(workers[0].response.ok, false); assert.deepEqual(workers[0].close, { code: 1, signal: null });
      }
    }
    await waitUntil(async () => (await queryProcesses([...owner.records.keys()])).length === 0, 10_000, prefix + "_REINSTALL_PROCESSES_REMAIN");
    assert.equal(await digest(path.join(context.data, "config.json")), context.configBefore);
    assert.equal(await digest(path.join(context.data, "codeflowai.db.meta.json")), context.metadataBefore);
    assert.deepEqual(await inventory({ project: context.project }), context.markerBefore);
    for (const [file, before] of context.workspaceMarkers) assert.equal(await digest(file), before, prefix + "_WORKSPACE_MARKER_CHANGED");
    if (options.ready || options.worker) {
      const identity = await readJson(path.join(context.data, "device-identity.json"));
      assert.equal(identity.deviceId, context.retained.nextDeviceId); assert.equal(identity.createdAt, context.retained.createdAt);
    }
    if (options.ready) {
      report.tasksAfterClose = await taskOperation(paths, context, "snapshot", name + "-tasks-after-close");
      assertTasks(context, report.tasksAfterClose, [context.retained.nextDeviceId, context.retained.nextDeviceId, context.retained.nextDeviceId]);
    }
  } catch (error) { knownError = error; }
  const secondary = [];
  if (inspector) { try { await inspector.close(); } catch (error) { secondary.push(error); } }
  if (knownError) {
    try { await owner.discover(); } catch (error) { secondary.push(error); }
    try { await stopOwned([...owner.records.values()]); } catch (error) { secondary.push(error); }
  }
  if (secondary.length) knownError = new AggregateError([...(knownError ? [knownError] : []), ...secondary], prefix + "_REINSTALL_CLEANUP_FAILED");
  child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
  report.processes = [...owner.records.values()]; report.status = knownError ? "failed" : "passed";
  if (knownError) report.failure = failure(knownError);
  await writeJson(path.join(root, "verification.json"), report);
  if (knownError) throw knownError;
  return report;
}

/** 成功、摘要拒绝、跨库部分提交以及定位/consumed写故障均由真实新包消费。 */
async function reinstallScenarios(paths, report) {
  const success = await retainedFixture(paths, "f4-success"); await authorizeRetained(paths, success);
  report.scenarios.push(success.initial);
  report.scenarios.push(await reinstallLaunch(paths, success, "completed-consumer", { ready: true, worker: true, counts: { rebound: 6, unchanged: 0 } }));
  const consumedIdentity = await digest(path.join(success.data, "device-identity.json"));
  const consumedRecord = await fs.readFile(path.join(success.profile, "desktop-uninstall-result.json"));
  report.scenarios.push(await reinstallLaunch(paths, success, "consumed-restart", { ready: true, worker: false }));
  assert.equal(await digest(path.join(success.data, "device-identity.json")), consumedIdentity);
  assert.deepEqual(await fs.readFile(path.join(success.profile, "desktop-uninstall-result.json")), consumedRecord);
  assertTasks(success, await taskOperation(paths, success, "snapshot", "tasks-after-consumed"), [success.retained.nextDeviceId, success.retained.nextDeviceId, success.retained.nextDeviceId]);

  const invalid = await retainedFixture(paths, "f4-digest-invalid"); await authorizeRetained(paths, invalid);
  report.scenarios.push(invalid.initial);
  const config = path.join(invalid.data, "config.json"); await fs.appendFile(config, "\n", "utf8"); invalid.configBefore = await digest(config);
  report.scenarios.push(await reinstallLaunch(paths, invalid, "digest-rejected", { ready: false, worker: false, errorCode: "DESKTOP_MAINTENANCE_DIGEST_MISMATCH" }));
  assert.equal(await exists(path.join(invalid.data, "device-identity.json")), false);
  assert.deepEqual(await fs.readFile(path.join(invalid.profile, "desktop-uninstall-result.json")), invalid.recordBytes);
  assert.equal(await digest(path.join(invalid.data, "codeflowai.db")), invalid.maintenance.retainedFiles.databaseSha256);
  assertTasks(invalid, await taskOperation(paths, invalid, "snapshot", "tasks-after-digest-rejected"), [invalid.retained.oldDeviceId, invalid.retained.oldDeviceId, invalid.retained.oldDeviceId]);

  const partial = await retainedFixture(paths, "f4-partial-commit");
  report.scenarios.push(partial.initial);
  await taskOperation(paths, partial, "trigger-on", "tasks-trigger-on"); await authorizeRetained(paths, partial);
  report.scenarios.push(await reinstallLaunch(paths, partial, "worker-business-failed", { ready: false, worker: true }));
  assert.equal((await readJson(path.join(partial.profile, "desktop-uninstall-result.json"))).phase, "reinstalling");
  const failedIdentity = await digest(path.join(partial.data, "device-identity.json"));
  assertTasks(partial, await taskOperation(paths, partial, "snapshot", "tasks-partial"), [partial.retained.nextDeviceId, partial.retained.nextDeviceId, partial.retained.oldDeviceId]);
  await taskOperation(paths, partial, "trigger-off", "tasks-trigger-off");
  report.scenarios.push(await reinstallLaunch(paths, partial, "worker-business-retry", { ready: true, worker: true, counts: { rebound: 2, unchanged: 4 } }));
  assert.equal(await digest(path.join(partial.data, "device-identity.json")), failedIdentity);

  for (const fault of ["locator", "consumed"]) {
    const context = await retainedFixture(paths, "f4-" + fault); await authorizeRetained(paths, context);
    report.scenarios.push(context.initial);
    report.scenarios.push(await reinstallLaunch(paths, context, fault + "-failed", { ready: false, worker: true, fault, counts: { rebound: 6, unchanged: 0 },
      errorCode: fault === "locator" ? "D16_REINSTALL_LOCATOR_FAILED" : "D16_REINSTALL_CONSUMED_FAILED" }));
    assert.equal((await readJson(path.join(context.profile, "desktop-uninstall-result.json"))).phase, "reinstalling");
    const identityBefore = await digest(path.join(context.data, "device-identity.json"));
    report.scenarios.push(await reinstallLaunch(paths, context, fault + "-retry", { ready: true, worker: true, counts: { rebound: 0, unchanged: 6 } }));
    assert.equal(await digest(path.join(context.data, "device-identity.json")), identityBefore);
  }
}

/** 保留前片回归并真实验证 F4 单一维护接续、资源关闭顺序和失败重入。 */
export async function run(args) {
  const paths = await preflight(args);
  const inputs = { artifact: paths.artifact, frozen: frozenResources };
  const before = await inventory(inputs);
  await fs.mkdir(paths.root);
  const report = { requestId: crypto.randomUUID(), status: "running", executable: paths.executable,
    buildHashes: paths.buildHashes, sourceBefore: before, scenarios: [],
    scope: "real F4 packaged main/current Client/worker and signed resource baseline; isolated profiles; no installation, real account or Server" };
  let knownError;
  try {
    const custom = await fixture(paths, "custom-restart");
    report.scenarios.push(await inspectedScenario(paths, custom, "interrupt", "D16_IDENTITY_INTERRUPTED"));
    report.scenarios.push(await restartScenario(paths, custom));
    for (const [mode, phase] of [["remove", "started"], ["remove", "data_action_authorized"], ["keep", "completed"], ["keep", "reinstalling"]]) {
      const context = await fixture(paths, `${mode}-${phase}`);
      const record = { schemaVersion: 1, appId, requestId: `maintenance:${mode}:${phase}`, mode, phase,
        installRoot: paths.artifact, dataDir: context.data, clientId: "client-original", oldDeviceId,
        ...(mode === "keep" ? { nextDeviceId, createdAt: "2026-10-31T00:00:00.000Z" } : {}),
        ...(phase === "data_action_authorized" ? { authorizedPaths: ["config.json", "codeflowai.db", "codeflowai.db.meta.json"] } : {}) };
      const bytes = Buffer.from(JSON.stringify(record) + "\n");
      await fs.writeFile(path.join(context.profile, "desktop-uninstall-result.json"), bytes, { flag: "wx" });
      report.scenarios.push(await inspectedScenario(paths, context, "maintenance", mode === "keep"
        ? "DESKTOP_MAINTENANCE_REINSTALL_NOT_READY" : "DESKTOP_MAINTENANCE_PENDING", { record, bytes }));
    }
    report.scenarios.push(await inspectedScenario(paths, await fixture(paths, "ready-backfill"), "backfill-failure", "D16_LOCATOR_RENAME_FAILED"));
    await reinstallScenarios(paths, report);
  } catch (error) { knownError = error; }
  try {
    report.sourceAfter = await inventory(inputs);
    assert.deepEqual(report.sourceAfter, before, prefix + "_INPUT_CHANGED"); report.inputsUnchanged = true;
  } catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_INPUT_CHECK_FAILED"); }
  report.status = knownError ? "failed" : "passed";
  if (knownError) report.failure = failure(knownError);
  await writeJson(path.join(paths.root, "verification.json"), report);
  console.log(JSON.stringify({ code: prefix, status: report.status, report: path.join(paths.root, "verification.json") }));
  if (knownError) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ code: prefix, status: "failed", failure: failure(error) })); process.exitCode = 1; }
}
