import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const prefix = "DESKTOP_PROTOCOL";

/** 外部操作有界，任一路径均释放超时器。 */
export async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 父目录本身也算重叠，避免只读工件被证据目录覆盖。 */
function outside(parent, target) {
  const relative = path.relative(parent, target);
  return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** 工件与证据路径双向互斥。 */
function disjoint(artifact, evidence) {
  assert.ok(outside(artifact, evidence) && outside(evidence, artifact), `${prefix}_ARTIFACT_OUTPUT_OVERLAP`);
}

/** 所有真实路径和 junction 校验在 mkdir 前完成，坏输入零写。 */
export async function preflight(args) {
  const [input, output, ...extra] = args;
  assert.ok(input && output && !extra.length, "用法：electron-packaged-protocol.smoke.mjs <exe> <不存在的仓库外报告目录>");
  assert.equal(process.platform, "win32", `${prefix}_WINDOWS_REQUIRED`);
  const root = path.resolve(output), requested = path.resolve(input);
  const repo = await bounded(fs.realpath(repository), 5_000, `${prefix}_REPOSITORY_PATH_TIMEOUT`);
  const actualRoot = path.join(await bounded(fs.realpath(path.dirname(root)), 5_000, `${prefix}_OUTPUT_PARENT_TIMEOUT`), path.basename(root));
  const executable = await bounded(fs.realpath(requested), 5_000, `${prefix}_EXECUTABLE_PATH_TIMEOUT`);
  const artifact = path.dirname(executable), resources = path.join(artifact, "resources");
  for (const target of [root, actualRoot, requested, executable]) {
    assert.ok(outside(repository, target) && outside(repo, target), `${prefix}_OUTSIDE_REPOSITORY_REQUIRED`);
  }
  assert.equal(path.extname(executable).toLowerCase(), ".exe", `${prefix}_EXE_REQUIRED`);
  for (const artifactPath of [path.dirname(requested), artifact]) {
    for (const evidencePath of [root, actualRoot]) disjoint(artifactPath, evidencePath);
  }
  let exists = true;
  try { await bounded(fs.lstat(root), 5_000, `${prefix}_OUTPUT_STAT_TIMEOUT`); }
  catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
  assert.equal(exists, false, `${prefix}_OUTPUT_ALREADY_EXISTS`);
  const files = { exe: executable, asar: path.join(resources, "app.asar"), client: path.join(resources, "client/dist/index.cjs"), web: path.join(resources, "web/index.html") };
  for (const filename of Object.values(files)) {
    const actual = await bounded(fs.realpath(filename), 5_000, `${prefix}_ARTIFACT_PATH_TIMEOUT`);
    assert.ok(!outside(artifact, actual), `${prefix}_ARTIFACT_FILE_OUTSIDE_ROOT`);
    assert.ok(outside(repo, actual), `${prefix}_OUTSIDE_REPOSITORY_REQUIRED`);
    disjoint(path.dirname(actual), actualRoot);
    assert.equal((await bounded(fs.stat(actual), 5_000, `${prefix}_ARTIFACT_STAT_TIMEOUT`)).isFile(), true, `${prefix}_ARTIFACT_FILE_REQUIRED`);
  }
  return { root, actualRoot, executable, artifact, resources, files };
}

/** 完整四项 SHA256 是只读边界，不等价于全目录校验。 */
async function hashes(files) {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, filename]) =>
    [name, crypto.createHash("sha256").update(await bounded(fs.readFile(filename), 30_000, `${prefix}_HASH_TIMEOUT`)).digest("hex")])));
}

/** 保留 errno、cause 和聚合错误，清理故障不覆盖业务根因。 */
export function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.code ? { code: error.code } : {}), ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

/** 编码 PowerShell 输入，命令失败与超时均显式抛出。 */
function powershell(script) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot, `${prefix}_SYSTEM_ROOT_REQUIRED`);
  const command = "$ErrorActionPreference='Stop'\n" + script;
  const result = spawnSync(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${prefix}_PROCESS_COMMAND_FAILED: ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
}

/** 查询创建时间、父 PID、路径和命令行，权限错误不视为退出。 */
export function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `${prefix}_PID_REQUIRED`);
  return powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'
if ($null -eq $p) { 'null'; exit 0 }
if (-not $p.ExecutablePath -or -not $p.CommandLine) { throw 'DESKTOP_PROTOCOL_PROCESS_IDENTITY_UNAVAILABLE' }
@{pid=[int]$p.ProcessId; parentPid=[int]$p.ParentProcessId; created=$p.CreationDate.ToUniversalTime().ToString('o'); executable=$p.ExecutablePath; commandLine=$p.CommandLine} | ConvertTo-Json -Compress`);
}

/** 一次快照返回指定根的真实父链，身份缺失留给调用方显式拒绝。 */
function processTree(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `${prefix}_PID_REQUIRED`);
  return powershell(`$all=@(Get-CimInstance Win32_Process)
$ids=[Collections.Generic.HashSet[int]]::new()
[void]$ids.Add(${pid})
do { $added=$false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added=$true } } } while ($added)
@($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;commandLine=$_.CommandLine} }) | ConvertTo-Json -Compress`);
}

/** 终止现场核完整 CIM 身份与共同微秒精度，只停止本次单个进程。 */
export function terminateObserved(record) {
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0, `${prefix}_PID_REQUIRED`);
  const encoded = Buffer.from(JSON.stringify(record), "utf8").toString("base64");
  return powershell(`$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${record.pid}'
if ($null -eq $p) { @{state='absent';pid=$r.pid} | ConvertTo-Json -Compress; exit 0 }
if ($p.CreationDate.ToUniversalTime().ToString('o') -cne $r.created -or $p.ExecutablePath -ine $r.executable -or $p.CommandLine -cne $r.commandLine -or [int]$p.ParentProcessId -ne $r.parentPid) { throw 'DESKTOP_PROTOCOL_PID_IDENTITY_CHANGED' }
$process=Get-Process -Id $r.pid
if ($process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -cne $r.created.Substring(0,26)+'Z') { throw 'DESKTOP_PROTOCOL_PID_IDENTITY_CHANGED' }
$process.Kill()
if (-not $process.WaitForExit(5000)) { throw 'DESKTOP_PROTOCOL_PROCESS_STOP_TIMEOUT' }
@{state='stopped';pid=$r.pid} | ConvertTo-Json -Compress`);
}

/** 缺产品日志或原因不符时，网络层失败不算 handler 拒绝。 */
export function assertRejection(result, errors, expectedCause) {
  assert.equal(result.ok, false, `${prefix}_REJECTION_REQUIRED`);
  assert.equal(result.bodyBytes, 0, `${prefix}_REJECTED_BODY_PRESENT`);
  assert.equal(result.error?.message, "net::ERR_UNEXPECTED", `${prefix}_NETWORK_FAILURE_MISMATCH`);
  assert.equal(errors.length, 1, `${prefix}_PRODUCT_ERROR_DELTA_REQUIRED`);
  assert.equal(errors[0].errorCode, "DESKTOP_OPERATION_FAILED");
  assert.match(errors[0].requestId, /^[a-f0-9-]{36}$/u);
  assert.equal(errors[0].rootCause, expectedCause, `${prefix}_PRODUCT_CAUSE_MISMATCH`);
}

/** 真实 smoke 仅走原注册协议和产品桥，失败仍核工件并有界清理。 */
export async function run(args) {
  const paths = await preflight(args);
  const artifactBefore = await hashes(paths.files);
  const { _electron: electron } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
  await bounded(fs.mkdir(paths.root), 5_000, `${prefix}_OUTPUT_MKDIR_TIMEOUT`);
  const report = { requestId: crypto.randomUUID(), status: "running", scope: "windows_frozen_packaged_registered_protocol",
    executable: paths.executable, root: paths.actualRoot, artifactBefore, requests: [], recoveries: [], processes: [],
    logLimits: { stdout: "drained, not retained", stderrTailCharacters: 65_536, stderrTotalCharacters: 0 }, stderr: "" };
  const observed = new Map();
  let application, child, mainPid, page, initial, clientId, originalView, knownError;

  /** 观测绑定进程身份；未知进程保留上下文并使验收失败。 */
  function observe(pid, role, expectedParent) {
    let record;
    try {
      record = processIdentity(pid);
      assert.ok(record, `${prefix}_OBSERVED_PROCESS_ABSENT: ${pid}`);
      const executable = role === "launcher" ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/cmd.exe") : paths.executable;
      assert.equal(path.resolve(record.executable).toLowerCase(), executable.toLowerCase(), `${prefix}_UNEXPECTED_EXECUTABLE`);
      const parentPid = expectedParent ?? (role === "launcher" || (role === "main" && pid === child.pid) ? process.pid : role === "main" ? child.pid : mainPid);
      assert.equal(record.parentPid, parentPid, `${prefix}_UNEXPECTED_PARENT`);
      if (observed.has(parentPid)) assert.ok(record.created >= observed.get(parentPid).identity.created, `${prefix}_PROCESS_CREATION_ORDER_INVALID`);
      if (role === "launcher" || role === "main") {
        assert.ok(record.commandLine.includes(path.join(paths.root, "profile")), `${prefix}_PROFILE_IDENTITY_REQUIRED`);
        assert.ok(record.commandLine.toLowerCase().includes(paths.executable.toLowerCase()), `${prefix}_ARTIFACT_COMMAND_REQUIRED`);
      }
      if (observed.has(pid)) assert.deepEqual(record, observed.get(pid).identity, `${prefix}_PID_IDENTITY_CHANGED`);
      else { observed.set(pid, { role, identity: record }); report.processes.push({ role, identity: record }); }
    } catch (error) { report.unknownProcesses ??= []; report.unknownProcesses.push({ pid, role, ...(record ? { identity: record } : {}), error: failure(error) }); throw error; }
  }

  /** 主查询失败时按已登记根、profile、创建时间与父链恢复可信进程集合。 */
  function discoverOwnedTree() {
    report.processDiscovery = { state: "unknown", rootPid: child?.pid };
    const anchor = observed.get(child?.pid);
    assert.ok(anchor, `${prefix}_PROCESS_ROOT_UNCONFIRMED`);
    const records = processTree(child.pid), tree = Array.isArray(records) ? records : [records];
    assert.deepEqual(tree.find(item => item.pid === child.pid), anchor.identity, `${prefix}_PROCESS_ROOT_IDENTITY_CHANGED`);
    const pending = tree.filter(item => item.pid !== child.pid);
    while (pending.length) {
      const index = pending.findIndex(item => observed.has(item.parentPid));
      assert.notEqual(index, -1, `${prefix}_PROCESS_PARENT_CHAIN_UNCONFIRMED`);
      const record = pending.splice(index, 1)[0];
      try {
        assert.equal(path.resolve(record.executable ?? "").toLowerCase(), paths.executable.toLowerCase(), `${prefix}_UNEXPECTED_EXECUTABLE`);
        const profile = path.join(paths.root, "profile").toLowerCase();
        const command = record.commandLine?.toLowerCase() ?? "";
        assert.ok(command.includes(profile) || (command.includes(paths.files.client.toLowerCase()) && command.includes("--foreground")), `${prefix}_PROCESS_COMMAND_UNCONFIRMED`);
        const role = anchor.role === "launcher" && record.parentPid === child.pid ? "main" : "recovered-child";
        if (role === "main") { assert.ok(!mainPid || mainPid === record.pid, `${prefix}_MULTIPLE_MAIN_PROCESSES`); mainPid = record.pid; }
        observe(record.pid, role, record.parentPid);
        assert.deepEqual(observed.get(record.pid).identity, record, `${prefix}_PROCESS_SNAPSHOT_CHANGED`);
      } catch (error) {
        report.unknownProcesses ??= []; report.unknownProcesses.push({ pid: record.pid, role: "discovered", identity: record, error: failure(error) });
        throw error;
      }
    }
    assert.ok(mainPid && observed.has(mainPid), `${prefix}_MAIN_PROCESS_UNCONFIRMED`);
    report.processDiscovery = { state: "confirmed", rootPid: child.pid, mainPid, pids: tree.map(item => item.pid) };
  }

  /** 首次日志尚未创建可为空，其他读取或 JSON 错误继续失败。 */
  async function errorLog() {
    let text;
    try { text = await bounded(fs.readFile(path.join(paths.root, "runtime/logs/desktop-errors.jsonl"), "utf8"), 5_000, `${prefix}_ERROR_LOG_TIMEOUT`); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return text.trim() ? text.trim().split(/\r?\n/u).map(line => JSON.parse(line)) : [];
  }

  /** 主进程 net.fetch 调用原 handler，只留正文指纹和长度。 */
  async function fetchProtocol(url, accept = "*/*") {
    const result = await bounded(application.evaluate(async ({ net }, input) => {
      const request = new Request(input.url, { headers: { accept: input.accept } });
      let response;
      try {
        response = await net.fetch(request.url, { headers: { accept: input.accept } });
      } catch (error) { return { url: input.url, entryUrl: request.url, accept: input.accept, ok: false, bodyBytes: 0, error: { name: error.name, message: error.message } }; }
      const body = Buffer.from(await response.arrayBuffer());
      return { url: input.url, entryUrl: request.url, accept: input.accept, ok: response.ok, status: response.status, bodyBytes: body.length,
        sha256: process.getBuiltinModule("crypto").createHash("sha256").update(body).digest("hex"), contentType: response.headers.get("content-type") };
    }, { url, accept }), 15_000, `${prefix}_NET_FETCH_TIMEOUT`);
    report.requests.push(result);
    assert.equal(result.entryUrl, url, `${prefix}_URL_NORMALIZED_BEFORE_ENTRY`);
    return result;
  }

  /** 每次拒绝后核原页面、静态正文、runtime 身份和同一健康 Client。 */
  async function recovered(asset) {
    const response = await bounded(page.evaluate(() => window.codeflowDesktop.request({ method: "runtime.info" })), 35_000, `${prefix}_RUNTIME_TIMEOUT`);
    assert.equal(response.status, 200); assert.equal(response.body?.ok, true);
    assert.equal(response.body.client.clientId, clientId);
    const view = await bounded(page.evaluate(async () => ({ url: location.href, title: document.title, bodyLength: document.body.innerHTML.length,
      state: await window.codeflowDesktop.getState() })), 15_000, `${prefix}_RECOVERY_TIMEOUT`);
    assert.equal(view.url, originalView.url); assert.equal(view.title, originalView.title); assert.ok(view.bodyLength > 0);
    assert.equal(view.state.status, "ready"); assert.equal(view.state.health.database, "ready"); assert.equal(view.state.pid, initial.pid);
    assert.deepEqual(processIdentity(initial.pid), observed.get(initial.pid).identity, `${prefix}_CLIENT_IDENTITY_CHANGED`);
    const resource = await fetchProtocol(asset.url);
    assert.equal(resource.status, 200); assert.equal(resource.sha256, asset.sha256); assert.equal(resource.bodyBytes, asset.bodyBytes);
    report.recoveries.push({ state: view.state, originalPage: { url: view.url, title: view.title, bodyPresent: true }, clientId, resource });
  }

  /** 退出核验保留未知状态和 PID 复用，不把查不到身份当作退出。 */
  async function remaining() {
    const result = [];
    for (const [pid, record] of observed) {
      try {
        const current = processIdentity(pid);
        if (current) result.push({ pid, state: isDeepStrictEqual(current, record.identity) ? "alive" : "identity-changed", current });
      } catch (error) { result.push({ pid, state: "unknown", error: failure(error) }); }
    }
    if (report.processDiscovery?.state === "unknown") result.push({ state: "unknown-scope", rootPid: child?.pid, error: report.processDiscovery.error });
    return result;
  }

  /** 先走应用退出，再核身份单进程终止；清理双错和未知存活不隐藏。 */
  async function cleanup() {
    const errors = [];
    if (application) {
      try { discoverOwnedTree(); }
      catch (error) { report.processDiscovery.error = failure(error); errors.push(error); }
      try {
        assert.deepEqual(processIdentity(mainPid), observed.get(mainPid)?.identity, `${prefix}_CLOSE_IDENTITY_UNCONFIRMED`);
        page ??= application.windows().find(window => window.url().startsWith("codeflow://desktop/"));
        await bounded(Promise.all([application.waitForEvent("close", { timeout: 8_000 }),
          page ? page.evaluate(() => { void window.codeflowDesktop.exit(); }) : application.evaluate(({ app }) => app.quit())]), 8_000, `${prefix}_CLOSE_TIMEOUT`);
      }
      catch (error) { errors.push(error); }
    }
    for (const entry of (await remaining()).reverse()) {
      try {
        assert.equal(entry.state, "alive", `${prefix}_CLEANUP_IDENTITY_UNCONFIRMED: ${entry.pid}`);
        terminateObserved(observed.get(entry.pid).identity);
      } catch (error) { errors.push(error); }
    }
    report.remainingProcesses = await remaining();
    if (report.remainingProcesses.length) errors.push(new Error(`${prefix}_PROCESSES_REMAINED`));
    report.unconfirmedSurvivors = [];
    for (const entry of report.unknownProcesses ?? []) {
      try {
        const current = processIdentity(entry.pid);
        if (current) report.unconfirmedSurvivors.push({ pid: entry.pid, state: "unconfirmed-alive", identity: current });
      } catch (error) { report.unconfirmedSurvivors.push({ pid: entry.pid, state: "unknown", error: failure(error) }); }
    }
    if (report.unconfirmedSurvivors.length) errors.push(new Error(`${prefix}_UNCONFIRMED_PROCESSES_PRESERVED`));
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    if (errors.length) throw new AggregateError(errors, `${prefix}_CLEANUP_FAILED`);
  }

  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/iu.test(key)));
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
    assert.ok(systemRoot, `${prefix}_SYSTEM_ROOT_REQUIRED`);
    env.PATH = [path.join(systemRoot, "System32"), systemRoot].join(path.delimiter);
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
      "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMP", "TEMP", "TMPDIR"]) {
      env[key] = path.join(paths.root, key.toLowerCase());
      await bounded(fs.mkdir(env[key]), 5_000, `${prefix}_ISOLATION_TIMEOUT`);
    }
    env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(paths.root, "runtime");
    const profile = path.join(paths.root, "profile");
    report.processDiscovery = { state: "unknown", phase: "launch" };
    application = await electron.launch({ executablePath: paths.executable, args: [`--user-data-dir=${profile}`], env, cwd: paths.root, timeout: 60_000 });
    child = application.process(); child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", chunk => { report.logLimits.stderrTotalCharacters += chunk.length; report.stderr = (report.stderr + chunk).slice(-65_536); });
    const launcherIdentity = processIdentity(child.pid);
    assert.ok(launcherIdentity, `${prefix}_LAUNCHER_IDENTITY_REQUIRED`);
    if (path.resolve(launcherIdentity.executable).toLowerCase() === paths.executable.toLowerCase()) { mainPid = child.pid; observe(child.pid, "main"); }
    else observe(child.pid, "launcher");
    report.processDiscovery = { state: "registered-root", rootPid: child.pid };
    mainPid = await bounded(application.evaluate(() => process.pid), 15_000, `${prefix}_MAIN_PID_TIMEOUT`);
    observe(mainPid, "main");
    page = await application.firstWindow({ timeout: 60_000 });
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    await page.waitForFunction(async () => (await window.codeflowDesktop?.getState())?.status === "ready", undefined, { timeout: 60_000 });
    initial = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 15_000, `${prefix}_INITIAL_STATE_TIMEOUT`);
    assert.equal(initial.health.database, "ready"); observe(initial.pid, "client"); report.initial = initial;
    report.facts = await bounded(application.evaluate(async ({ app, protocol }) => ({
      isPackaged: app.isPackaged, appPath: app.getAppPath(), resources: process.resourcesPath, userData: app.getPath("userData"),
      protocolRegistered: await protocol.isProtocolHandled("codeflow"), metrics: app.getAppMetrics().map(({ pid, type }) => ({ pid, type })),
    })), 15_000, `${prefix}_MAIN_FACTS_TIMEOUT`);
    assert.equal(report.facts.isPackaged, true); assert.equal(report.facts.protocolRegistered, true);
    assert.equal(path.resolve(report.facts.appPath), paths.files.asar); assert.equal(path.resolve(report.facts.resources), paths.resources);
    assert.equal(path.resolve(report.facts.userData), profile);
    for (const metric of report.facts.metrics) if (metric.pid !== mainPid) observe(metric.pid, metric.type);
    const runtime = await bounded(page.evaluate(() => window.codeflowDesktop.request({ method: "runtime.info" })), 35_000, `${prefix}_RUNTIME_TIMEOUT`);
    assert.equal(runtime.status, 200); assert.equal(runtime.body?.ok, true); clientId = runtime.body.client.clientId;
    assert.ok(typeof clientId === "string" && clientId.trim());
    originalView = await page.evaluate(() => ({ url: location.href, title: document.title }));
    const assetUrl = await page.evaluate(() => document.querySelector('script[src]')?.src);
    assert.ok(assetUrl?.startsWith("codeflow://desktop/assets/"), `${prefix}_STATIC_ASSET_REQUIRED`);
    const asset = await fetchProtocol(assetUrl);
    assert.equal(asset.status, 200); assert.ok(asset.bodyBytes > 0);
    const assetFile = path.join(paths.resources, "web", decodeURIComponent(new URL(assetUrl).pathname));
    assert.equal(asset.sha256, crypto.createHash("sha256").update(await bounded(fs.readFile(assetFile), 15_000, `${prefix}_STATIC_READ_TIMEOUT`)).digest("hex"));
    const logsBefore = await errorLog(); assert.deepEqual(logsBefore, [], `${prefix}_UNEXPECTED_STARTUP_ERRORS`);
    const navigation = await fetchProtocol("codeflow://desktop/__protocol_acceptance__/workspace/chat", "text/html,application/xhtml+xml,*/*;q=0.8");
    assert.equal(navigation.status, 200); assert.equal(navigation.sha256, artifactBefore.web);
    await recovered(asset);
    const missing = "__protocol_acceptance_missing__.js";
    const expectedMissing = `ENOENT: no such file or directory, stat '${path.join(paths.resources, "web/assets", missing)}'`;
    for (const scenario of [
      { name: "missing-static", url: `codeflow://desktop/assets/${missing}`, cause: expectedMissing },
      { name: "encoded-traversal", url: "codeflow://desktop/%2e%2e%2fapp.asar", cause: "DESKTOP_WEB_PATH_INVALID" },
      { name: "non-desktop-origin", url: "codeflow://other/index.html", cause: "DESKTOP_WEB_ORIGIN_INVALID" },
    ]) {
      const before = await errorLog();
      const result = await fetchProtocol(scenario.url);
      const after = await errorLog();
      assert.deepEqual(after.slice(0, before.length), before, `${prefix}_ERROR_LOG_CHANGED`);
      const delta = after.slice(before.length);
      report.requests.at(-1).scenario = scenario.name; report.requests.at(-1).productErrors = delta;
      assertRejection(result, delta, scenario.cause);
      await recovered(asset);
      assert.deepEqual(await errorLog(), after, `${prefix}_RECOVERY_ADDED_ERROR`);
    }
    for (const metric of await application.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type }) => ({ pid, type })))) {
      if (metric.pid !== mainPid) observe(metric.pid, metric.type);
    }
    await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
      bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, `${prefix}_EXIT_REQUEST_TIMEOUT`)]);
    assert.equal(child.exitCode, 0, `${prefix}_NORMAL_EXIT_FAILED`); report.exitCode = child.exitCode; application = undefined;
    report.remainingProcesses = await remaining(); assert.deepEqual(report.remainingProcesses, [], `${prefix}_PROCESSES_REMAINED`);
    const db = new DatabaseSync(path.join(paths.root, "runtime/codeflowai.db"), { readOnly: true, timeout: 5_000 });
    let databaseError;
    try {
      report.businessCounts = Object.fromEntries(["threads", "thread_turns", "orch_instances"].map(table => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
      assert.deepEqual(report.businessCounts, { threads: 0, thread_turns: 0, orch_instances: 0 });
    } catch (error) { databaseError = error; }
    try { db.close(); }
    catch (error) { throw new AggregateError([...(databaseError ? [databaseError] : []), error], `${prefix}_DATABASE_CLOSE_FAILED`); }
    if (databaseError) throw databaseError;
  } catch (error) {
    knownError = error;
    try { await cleanup(); }
    catch (cleanupError) { knownError = new AggregateError([knownError, cleanupError], `${prefix}_VERIFICATION_AND_CLEANUP_FAILED`); }
  }
  try { report.artifactAfter = await hashes(paths.files); assert.deepEqual(report.artifactAfter, artifactBefore, `${prefix}_ARTIFACT_CHANGED`); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], `${prefix}_ARTIFACT_VERIFICATION_FAILED`); }
  report.logLimits.stderrTruncatedCharacters = Math.max(0, report.logLimits.stderrTotalCharacters - report.stderr.length);
  report.status = knownError ? "failed" : "passed";
  if (knownError) report.failure = failure(knownError);
  const reportPath = path.join(paths.root, "verification.json");
  try { await bounded(fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" }), 5_000, `${prefix}_REPORT_WRITE_TIMEOUT`); }
  catch (error) { throw new AggregateError([...(knownError ? [knownError] : []), error], `${prefix}_REPORT_WRITE_FAILED`); }
  console[knownError ? "error" : "log"](JSON.stringify({ code: `${prefix}_${report.status.toUpperCase()}`, requestId: report.requestId, reportPath, ...(knownError ? { failure: report.failure } : {}) }));
  if (knownError) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv.slice(2));
