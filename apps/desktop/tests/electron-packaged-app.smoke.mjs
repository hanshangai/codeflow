import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { _electron: electron } = webRequire("@playwright/test");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-d17b-"));
const reportPath = path.join(root, "verification.json");
const report = { requestId: crypto.randomUUID(), status: "running", root, runs: [],
  updates: { exercised: false, status: "unavailable_without_configured_server" } };
let application;
let child;
const observedPids = new Set();

/** 查询仅把 ESRCH 视为已退出，权限及查询故障继续显式失败。 */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** 每个调试/关闭操作独立限时，不让未完成 Promise 拖住验收。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 清空继承配置与注入；操作系统及引擎用户目录全部位于本次独占根。 */
async function isolatedEnvironment() {
  const allowed = /^(path|systemroot|windir|comspec|pathext|systemdrive|number_of_processors|processor_architecture)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const directories = { HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "local-appdata",
    CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", TMP: "tmp", TEMP: "tmp", TMPDIR: "tmp" };
  for (const [key, directory] of Object.entries(directories)) {
    env[key] = path.join(root, directory);
    await fs.mkdir(env[key], { recursive: true });
  }
  env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return env;
}

/** SQLite 读写与关闭都必须成功，失败同时保留原操作和关闭错误。 */
function withDatabase(operation) {
  const db = new DatabaseSync(path.join(root, "runtime", "codeflowai.db"));
  try { operation(db); }
  catch (error) {
    try { db.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], "DESKTOP_PACKAGED_SQLITE_CLOSE_FAILED"); }
    throw error;
  }
  db.close();
}

/** 业务验证只走已有受限桥，并为失联页面保留独立的请求预算。 */
async function request(page, input) {
  return await bounded(page.evaluate(input => window.codeflowDesktop.request(input), input), 35_000, "DESKTOP_PACKAGED_REQUEST_TIMEOUT");
}

/** 显式 IPC 退出后核查所有已观测 PID，短暂退出收尾也只有五秒预算。 */
async function waitStopped() {
  const deadline = Date.now() + 5_000;
  while ([...observedPids].some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const remaining = [...observedPids].filter(alive);
  assert.deepEqual(remaining, [], `DESKTOP_PACKAGED_PROCESSES_REMAIN: ${remaining.join(",")}`);
}

/** 仅清理本脚本启动并观测的进程树，命令和等待均有界且失败不覆盖根因。 */
async function cleanup() {
  const failures = [];
  for (const pid of observedPids) {
    if (!alive(pid)) continue;
    const result = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", encoding: "utf8" });
    if (result.error || result.status !== 0) failures.push(result.error ?? new Error(`DESKTOP_PACKAGED_KILL_FAILED: pid=${pid}, status=${result.status}, ${result.stderr}`));
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_PACKAGED_CONNECTION_CLOSE_TIMEOUT"); }
    catch (error) { failures.push(error); }
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  report.remainingPids = [...observedPids].filter(alive);
  if (report.remainingPids.length) failures.push(new Error(`DESKTOP_PACKAGED_PROCESSES_REMAIN: ${report.remainingPids.join(",")}`));
  if (failures.length) throw new AggregateError(failures, "DESKTOP_PACKAGED_CLEANUP_FAILED");
}

/** 错误链写入报告，不把启动、业务或清理失败降级为成功。 */
function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

try {
  const [input, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error("用法：electron-packaged-app.smoke.mjs <工件 exe>");
  const executablePath = await fs.realpath(path.resolve(input));
  if (process.platform !== "win32" || path.extname(executablePath).toLowerCase() !== ".exe") throw new Error("DESKTOP_PACKAGED_WINDOWS_EXE_REQUIRED");
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const relative = path.relative(repository, executablePath);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_PACKAGED_EXE_MUST_BE_OUTSIDE_REPOSITORY");
  report.executablePath = executablePath;
  const resources = path.join(path.dirname(executablePath), "resources");
  const userData = path.join(root, "profile");
  const env = await isolatedEnvironment();
  const project = path.join(root, "project");
  await fs.mkdir(project);
  await fs.mkdir(userData);
  for (const entry of ["app.asar", "client/dist/index.cjs", "client/node_modules", "web/index.html", "release-trust.json"]) await fs.access(path.join(resources, entry));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(resources, "release-trust.json"), "utf8")), {});
  let clientId, workspaceId;
  for (let attempt = 1; attempt <= 2; attempt++) {
    application = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env, cwd: root, timeout: 60_000 });
    child = application.process();
    observedPids.add(child.pid);
    const run = { attempt, pid: child.pid, stdout: "", stderr: "" };
    child.stdout.setEncoding("utf8").on("data", chunk => { run.stdout = (run.stdout + chunk).slice(-65_536); });
    child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-65_536); });
    report.runs.push(run);
    const facts = await bounded(application.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid, isPackaged: app.isPackaged, shellVersion: app.getVersion(), userData: app.getPath("userData"), resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(), electron: process.versions.electron, node: process.versions.node,
      metrics: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type })),
      windows: BrowserWindow.getAllWindows().length,
      env: { codeflow: Object.keys(process.env).filter(key => key.startsWith("CODEFLOWAI_")), nodeOptions: process.env.NODE_OPTIONS,
        nodePath: process.env.NODE_PATH, home: process.env.HOME, appData: process.env.APPDATA, codexHome: process.env.CODEX_HOME },
    })), 15_000, "DESKTOP_PACKAGED_MAIN_PROBE_TIMEOUT");
    run.facts = facts;
    observedPids.add(facts.pid);
    assert.equal(facts.isPackaged, true);
    assert.match(facts.shellVersion, /^1\.0\.\d{4}-dev$/u);
    assert.equal(path.resolve(facts.userData), userData);
    assert.equal(path.resolve(facts.resourcesPath), resources);
    assert.equal(path.resolve(facts.appPath), path.join(resources, "app.asar"));
    assert.equal(facts.env.nodeOptions, undefined);
    assert.equal(facts.env.nodePath, undefined);
    assert.deepEqual(facts.env.codeflow, ["CODEFLOWAI_DESKTOP_DATA_DIR"]);
    assert.equal(facts.env.home, env.HOME);
    assert.equal(facts.env.appData, env.APPDATA);
    assert.equal(facts.env.codexHome, env.CODEX_HOME);
    if (attempt === 1) {
      report.shellDependencies = await bounded(application.evaluate(({ app }) => {
        const fs = process.getBuiltinModule("fs"), path = process.getBuiltinModule("path");
        const { createRequire } = process.getBuiltinModule("module");
        const archive = app.getAppPath(), checked = new Map();
        for (const file of ["dist/main.js", "dist/preload.cjs"]) fs.accessSync(path.join(archive, file));
        /** 从实际 ASAR 清单遍历生产依赖，任何包外解析或缺项直接失败。 */
        function visit(manifestFile) {
          const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
          const requirePackage = createRequire(manifestFile);
          for (const dependency of Object.keys(manifest.dependencies ?? {})) {
            const entry = requirePackage.resolve(dependency);
            const relative = path.relative(archive, entry);
            if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`DESKTOP_PACKAGED_DEPENDENCY_OUTSIDE_ASAR: ${dependency}: ${entry}`);
            if (checked.has(entry)) continue;
            let directory = path.dirname(entry), packageFile;
            while (directory.startsWith(archive)) {
              const candidate = path.join(directory, "package.json");
              if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, "utf8")).name === dependency) { packageFile = candidate; break; }
              directory = path.dirname(directory);
            }
            if (!packageFile) throw new Error(`DESKTOP_PACKAGED_DEPENDENCY_MANIFEST_MISSING: ${dependency}`);
            checked.set(entry, { dependency, entry });
            visit(packageFile);
          }
        }
        const requireApp = createRequire(path.join(archive, "package.json"));
        requireApp("@codeflowai/shared");
        requireApp("tar");
        visit(path.join(archive, "package.json"));
        return [...checked.values()];
      }), 15_000, "DESKTOP_PACKAGED_DEPENDENCY_PROBE_TIMEOUT");
    }
    for (const metric of facts.metrics) observedPids.add(metric.pid);
    const page = await application.firstWindow({ timeout: 60_000 });
    const preferences = await bounded(application.evaluate(({ BrowserWindow }) => {
      const { sandbox, contextIsolation, nodeIntegration } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox, contextIsolation, nodeIntegration };
    }), 15_000, "DESKTOP_PACKAGED_PREFERENCES_TIMEOUT");
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    run.preferences = preferences;
    page.setDefaultTimeout(15_000);
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    const view = await bounded(page.evaluate(async () => ({ url: location.href, require: typeof require,
      bridge: typeof window.codeflowDesktop?.request, state: await window.codeflowDesktop.getState(),
      assets: [...document.querySelectorAll("script[src],link[rel=stylesheet]")].map(element => element.src || element.href),
    })), 15_000, "DESKTOP_PACKAGED_RENDERER_PROBE_TIMEOUT");
    assert.equal(view.require, "undefined");
    assert.equal(view.bridge, "function");
    assert.equal(view.state.status, "ready");
    assert.equal(view.state.health.database, "ready");
    observedPids.add(view.state.pid);
    assert.ok(view.assets.length > 0);
    assert.ok(view.assets.every(asset => asset.startsWith("codeflow://desktop/")));
    run.renderer = view;
    const runtime = await request(page, { method: "runtime.info" });
    assert.equal(runtime.status, 200);
    if (attempt === 1) {
      clientId = runtime.body.client.clientId;
      const created = await request(page, { method: "workspaces.upsert", body: {
        workspaceId: "packaged-smoke", title: "工件验收", path: project,
      } });
      assert.equal(created.status, 200, JSON.stringify(created));
      workspaceId = created.body.workspace.id;
      const saved = await request(page, { method: "workspaceExecutionProfile.update", body: { workspaceId, profileText: report.requestId } });
      assert.equal(saved.status, 200, JSON.stringify(saved));
    } else {
      assert.equal(runtime.body.client.clientId, clientId);
      const listed = await request(page, { method: "workspaces.list" });
      assert.equal(listed.status, 200);
      assert.ok(listed.body.workspaces.some(workspace => workspace.id === workspaceId && workspace.path === project));
      const retained = await request(page, { method: "workspaceExecutionProfile.get", body: { workspaceId } });
      assert.equal(retained.status, 200);
      assert.equal(retained.body.profile.profileText, report.requestId);
    }
    run.clientId = clientId;
    run.workspaceId = workspaceId;
    await Promise.all([
      application.waitForEvent("close", { timeout: 40_000 }),
      bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_PACKAGED_EXIT_REQUEST_TIMEOUT"),
    ]);
    await waitStopped();
    assert.equal(child.exitCode, 0);
    run.exitCode = child.exitCode;
    run.remainingPids = [];
    application = undefined;
    withDatabase(db => {
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'client_id'").get().value, clientId);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, view.state.health.dbSchemaVersion);
      if (attempt === 1) db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("d17b_packaged_marker", report.requestId);
      else assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get("d17b_packaged_marker").value, report.requestId);
    });
    observedPids.clear();
  }
  report.status = "passed";
  report.remainingPids = [...observedPids].filter(alive);
} catch (error) {
  try { await cleanup(); }
  catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_PACKAGED_VERIFICATION_AND_CLEANUP_FAILED"); }
  report.status = "failed";
  report.failure = failure(error);
  process.exitCode = 1;
}
try { await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
catch (error) { throw new AggregateError([...(report.failure ? [new Error(JSON.stringify(report.failure))] : []), error], "DESKTOP_PACKAGED_REPORT_WRITE_FAILED"); }
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_PACKAGED_${report.status.toUpperCase()}`,
  requestId: report.requestId, reportPath, ...(report.failure ? { failure: report.failure } : {}) }));
