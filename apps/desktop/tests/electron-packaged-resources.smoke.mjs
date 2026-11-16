import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-d17a-"));
const reportPath = path.join(root, "verification.json");
const report = { requestId: crypto.randomUUID(), status: "running", root, resourceOnly: true };
console.log(JSON.stringify({ code: "DESKTOP_RESOURCE_SMOKE_STARTED", ...report, reportPath }));

/** 只保留操作系统启动条件，将用户目录、引擎配置和 Node 注入隔离在本次目录。 */
async function isolatedEnvironment() {
  const env = {};
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|number_of_processors|processor_architecture)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  const directories = {
    HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "local-appdata",
    CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
    TMP: "tmp", TEMP: "tmp", TMPDIR: "tmp",
  };
  for (const [key, name] of Object.entries(directories)) {
    env[key] = path.join(root, "runtime", name);
    await fs.mkdir(env[key], { recursive: true });
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/** 运行、进程树清理和关闭等待各自有界；失败释放父进程引用并报告残留事实。 */
async function runElectron(executable, args, env) {
  const child = spawn(executable, args, { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    let settled = false, closed = false, cleaned = false, timeoutError, killer;
    /** 不等待尚未关闭的管道；残留子进程仍作为失败留在报告中。 */
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timeoutError) {
        Object.assign(error, { pid: child.pid, closeObserved: closed,
          processRemaining: !closed && child.exitCode == null && child.signalCode == null,
          cleanupPid: killer?.pid, cleanupProcessRemaining: !!killer && killer.exitCode == null && killer.signalCode == null });
        for (const process of [child, killer]) {
          process?.stdout?.destroy();
          process?.stderr?.destroy();
          process?.unref();
        }
      }
      error ? reject(error) : resolve({ ...result, stdout, stderr });
    };
    /** 清理失败立即返回；成功后也只等待有限时间的 close。 */
    const afterCleanup = (error) => {
      if (settled) return;
      clearTimeout(timer);
      if (error) return finish(new AggregateError([timeoutError, error], "DESKTOP_RESOURCE_SMOKE_CLEANUP_FAILED"));
      cleaned = true;
      if (closed) return finish(timeoutError);
      timer = setTimeout(() => finish(new AggregateError([timeoutError, new Error("DESKTOP_RESOURCE_SMOKE_CLOSE_TIMEOUT")],
        "DESKTOP_RESOURCE_SMOKE_CLEANUP_FAILED")), 5_000);
    };
    let timer = setTimeout(() => {
      timeoutError = new Error("DESKTOP_RESOURCE_SMOKE_TIMEOUT");
      if (process.platform === "win32") {
        timer = setTimeout(() => afterCleanup(new Error("DESKTOP_RESOURCE_SMOKE_KILL_TIMEOUT")), 5_500);
        killer = execFile(path.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL" }, afterCleanup);
      } else {
        try {
          if (!child.kill("SIGKILL")) throw new Error("DESKTOP_RESOURCE_SMOKE_KILL_FAILED");
          afterCleanup();
        } catch (error) { afterCleanup(error); }
      }
    }, 120_000);
    child.once("error", error => finish(timeoutError ? new AggregateError([timeoutError, error], "DESKTOP_RESOURCE_SMOKE_PROCESS_FAILED") : error));
    child.once("close", (code, signal) => {
      closed = true;
      if (timeoutError) { if (cleaned) finish(timeoutError); return; }
      finish(code === 0 ? undefined : new Error(`DESKTOP_RESOURCE_SMOKE_ELECTRON_FAILED: code=${code}, signal=${signal}\n${stderr}\n${stdout}`), { code, signal });
    });
  });
}

/** 保留根因链和清理错误，报告不把失败转换成成功。 */
function failure(error) {
  if (Array.isArray(error)) return error.map(failure);
  return { name: error?.name ?? "Error", message: error?.message ?? String(error),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.pid ? { pid: error.pid, processRemaining: error.processRemaining, closeObserved: error.closeObserved,
      cleanupPid: error.cleanupPid, cleanupProcessRemaining: error.cleanupProcessRemaining } : {}),
    ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

try {
  const [input, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error("用法：electron-packaged-resources.smoke.mjs <完整资源目录>");
  report.input = await fs.realpath(path.resolve(input));
  const resources = path.join(root, "resources");
  await fs.cp(report.input, resources, { recursive: true, force: false, errorOnExist: true, dereference: false });
  const desktopDir = fileURLToPath(new URL("..", import.meta.url));
  report.hostRuntime = path.join(desktopDir, "dist", "clientRuntime.js");
  const probe = path.join(root, "native-probe.cjs");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(probe, `(${electronProbe.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`, "utf8");
  const electron = createRequire(import.meta.url)("electron");
  const result = await runElectron(electron, [probe, root, report.hostRuntime, path.join(desktopDir, "dist", "deviceIdentity.js")], await isolatedEnvironment());
  const verified = JSON.parse(await fs.readFile(reportPath, "utf8"));
  if (verified.status !== "passed") throw new Error("DESKTOP_RESOURCE_SMOKE_REPORT_INCOMPLETE");
  verified.process = { code: result.code, signal: result.signal };
  await fs.writeFile(reportPath, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ code: "DESKTOP_RESOURCE_SMOKE_PASSED", requestId: report.requestId, reportPath, runtime: verified.runtime }));
} catch (error) {
  let current;
  try { current = JSON.parse(await fs.readFile(reportPath, "utf8")); }
  catch (readError) {
    if (readError.code !== "ENOENT") error = new AggregateError([error, readError], "DESKTOP_RESOURCE_SMOKE_REPORT_READ_FAILED");
  }
  const failed = { ...(current ?? report), status: "failed", failure: failure(error) };
  try { await fs.writeFile(reportPath, `${JSON.stringify(failed, null, 2)}\n`, "utf8"); }
  catch (writeError) { throw new AggregateError([error, writeError], "DESKTOP_RESOURCE_SMOKE_REPORT_WRITE_FAILED"); }
  console.error(JSON.stringify({ code: "DESKTOP_RESOURCE_SMOKE_FAILED", requestId: report.requestId, reportPath, failure: failed.failure }));
  process.exitCode = 1;
}

/** 此函数写入独占目录后由实际 Electron Node 执行，仓库仅提供现有生命周期入口。 */
async function electronProbe() {
  const assert = require("node:assert/strict");
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const { createRequire } = require("node:module");
  const { pathToFileURL } = require("node:url");
  const { spawn, spawnSync, execFileSync } = require("node:child_process");
  const { DatabaseSync } = require("node:sqlite");
  const [root, runtimeModule, identityModule] = process.argv.slice(2);
  const reportPath = path.join(root, "verification.json");
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  let runtime;
  let probeError;
  const children = [];
  /** 进程存在性只把 ESRCH 视为已退出，其余查询错误显式失败。 */
  function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  }
  /** 错误链同步写入报告，避免 Electron stderr 截断丢失最初失败。 */
  function failure(error) {
    if (Array.isArray(error)) return error.map(failure);
    return { name: error?.name ?? "Error", message: error?.message ?? String(error),
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.cause ? { cause: failure(error.cause) } : {}),
      ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
  }
  /** SQLite 操作与关闭均必须成功，同时保留查询和关闭失败。 */
  function withDatabase(file, operation) {
    const db = new DatabaseSync(file);
    try { operation(db); }
    catch (error) {
      try { db.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], "DESKTOP_RESOURCE_SQLITE_CLOSE_FAILED"); }
      throw error;
    }
    db.close();
  }
  try {
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
    assert.ok(process.versions.electron, "DESKTOP_ELECTRON_RUNTIME_REQUIRED");
    assert.equal(process.env.NODE_PATH, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.equal(Object.keys(process.env).some(key => key.startsWith("CODEFLOWAI_")), false);
    report.runtime = { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules,
      napi: process.versions.napi, platform: process.platform, arch: process.arch, execPath: process.execPath };
    const resources = path.join(root, "resources");
    const clientDir = path.join(resources, "client");
    const manifestPath = path.join(clientDir, "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.name, "@codeflowai/client");
    assert.ok(manifest.dependencies?.["node-pty"] && manifest.dependencies?.["@napi-rs/keyring"], "DESKTOP_NATIVE_DEPENDENCIES_REQUIRED");
    await fs.access(path.join(resources, "web", "index.html"));
    await fs.access(path.join(clientDir, "dist", "index.cjs"));
    const trust = JSON.parse(await fs.readFile(path.join(resources, "release-trust.json"), "utf8"));
    report.updates = { configuredServerOrigin: false, trustKeyCount: Object.keys(trust).length,
      status: "unavailable_without_configured_server", exercised: false };
    const requireClient = createRequire(manifestPath);
    const modulesDir = await fs.realpath(path.join(clientDir, "node_modules"));
    assert.equal(modulesDir, path.join(clientDir, "node_modules"), "DESKTOP_CLIENT_NODE_MODULES_OUTSIDE_PACKAGE");
    report.dependencies = [];
    for (const dependency of Object.keys(manifest.dependencies)) {
      const resolved = await fs.realpath(requireClient.resolve(dependency));
      const relative = path.relative(modulesDir, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`DESKTOP_CLIENT_DEPENDENCY_OUTSIDE_PACKAGE: ${dependency}: ${resolved}`);
      }
      await import(pathToFileURL(resolved).href);
      report.dependencies.push({ dependency, resolved });
    }
    const native = spawnSync(process.execPath, [path.join(clientDir, "scripts", "verify-bundled-native.mjs"), "node-pty", "@napi-rs/keyring"],
      { cwd: clientDir, env: process.env, encoding: "utf8", windowsHide: true, timeout: 25_000, maxBuffer: 1024 * 1024 });
    report.native = { code: native.status, signal: native.signal, stdout: native.stdout, stderr: native.stderr,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE, verifier: "package/scripts/verify-bundled-native.mjs", credentialContentsAccessed: false };
    if (native.error) throw native.error;
    assert.equal(native.status, 0, `DESKTOP_BUNDLED_NATIVE_FAILED: ${native.stderr}`);
    report.native.ptyCreated = true;
    report.native.keyringLoaded = true;
    const probeDb = path.join(root, "sqlite-probe.db");
    withDatabase(probeDb, db => {
      db.exec("CREATE VIRTUAL TABLE probe USING fts5(body)");
      db.prepare("INSERT INTO probe(body) VALUES (?)").run("codeflow resource isolation");
      assert.equal(db.prepare("SELECT body FROM probe WHERE probe MATCH ?").get("isolation").body, "codeflow resource isolation");
      report.sqlite = { version: db.prepare("SELECT sqlite_version() AS version").get().version, fts5: true, persistedAfterReopen: false };
    });
    withDatabase(probeDb, db => {
      assert.equal(db.prepare("SELECT body FROM probe WHERE probe MATCH ?").get("isolation").body, "codeflow resource isolation");
      report.sqlite.persistedAfterReopen = true;
    });
    const { createClientRuntime } = await import(pathToFileURL(runtimeModule).href);
    const { loadOrCreateDeviceIdentity } = await import(pathToFileURL(identityModule).href);
    const dataDir = path.join(root, "runtime", "client");
    const identity = await loadOrCreateDeviceIdentity(dataDir);
    report.deviceId = identity.deviceId;
    report.clientRuns = [];
    let clientId;
    for (let attempt = 1; attempt <= 2; attempt++) {
      assert.deepEqual(await loadOrCreateDeviceIdentity(dataDir), identity);
      runtime = createClientRuntime({ entry: path.join(clientDir, "dist", "index.cjs"), dataDir,
        /** 保留原启动参数和 IPC，仅观测实际进程及退出码。 */
        spawn(file, args, options) {
          assert.equal(file, process.execPath);
          const child = spawn(file, args, options);
          children.push(child);
          return child;
        } });
      await runtime.start();
      await runtime.waitReady();
      const ready = runtime.snapshot();
      assert.equal(ready.status, "ready");
      assert.equal(ready.health.database, "ready");
      const config = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8"));
      assert.ok(config.clientId);
      if (attempt === 1) clientId = config.clientId;
      else assert.equal(config.clientId, clientId, "DESKTOP_CLIENT_ID_CHANGED");
      await runtime.stop();
      assert.equal(runtime.snapshot().status, "stopped");
      const child = children.at(-1);
      assert.equal(child.exitCode, 0);
      assert.equal(alive(child.pid), false, "DESKTOP_CLIENT_PROCESS_REMAINED");
      withDatabase(path.join(dataDir, "codeflowai.db"), db => {
        assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'client_id'").get().value, clientId);
        assert.equal(db.prepare("PRAGMA user_version").get().user_version, ready.health.dbSchemaVersion);
        if (attempt === 1) db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("d17a_resource_smoke_marker", report.requestId);
        else assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get("d17a_resource_smoke_marker").value, report.requestId);
      });
      report.clientRuns.push({ attempt, pid: child.pid, requestId: ready.requestId, health: ready.health, clientId, exitCode: child.exitCode, processRemaining: false });
    }
    report.status = "passed";
  } catch (error) {
    if (runtime) {
      try { await runtime.drain(10_000); }
      catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_RESOURCE_CLIENT_DRAIN_FAILED"); }
    }
    for (const child of children) {
      if (!child.pid || !alive(child.pid)) continue;
      try {
        if (process.platform === "win32") execFileSync(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(child.pid, "SIGKILL");
      } catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_RESOURCE_CLIENT_KILL_FAILED"); }
    }
    report.status = "failed";
    report.probeFailure = failure(error);
    probeError = error;
  }
  try { await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
  catch (writeError) {
    if (probeError) throw new AggregateError([probeError, writeError], "DESKTOP_RESOURCE_PROBE_REPORT_WRITE_FAILED");
    throw writeError;
  }
  if (probeError) throw probeError;
}
