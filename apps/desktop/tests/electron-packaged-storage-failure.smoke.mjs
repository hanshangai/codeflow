import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const prefix = "STORAGE_FAILURE_";

/** 外部操作独立限时，原拒绝和超时均显式失败。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(prefix + code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 等待真实条件，检查本身也受剩余预算约束。 */
async function waitUntil(check, milliseconds, code) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await bounded(Promise.resolve().then(check), Math.max(1, end - Date.now()), code)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(prefix + code);
}

/** 保留原错误、cause 和聚合清理链，不输出存储正文。 */
function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.code ? { code: error.code } : {}), ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

/** 工件、源码和证据必须双向不包含。 */
function separate(left, right) {
  const contains = (parent, target) => { const relative = path.relative(parent, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
  assert.ok(!contains(left, right) && !contains(right, left), prefix + "PATH_OVERLAP");
}

/** 拒绝路径任一现存组成部分的符号链接或 junction。 */
async function noReparse(target) {
  let current = path.resolve(target);
  for (;;) {
    const stat = await fs.lstat(current);
    assert.equal(stat.isSymbolicLink(), false, prefix + "REPARSE_PATH");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** 所有输入和实际路径在首次写入前验证；已有报告从不覆盖。 */
export async function preflight(args) {
  assert.equal(process.platform, "win32", prefix + "WINDOWS_REQUIRED");
  assert.ok(args.length === 2 && args.every(value => typeof value === "string" && value.trim()),
    "用法：electron-packaged-storage-failure.smoke.mjs <exe> <不存在的仓库外报告目录>");
  const [input, output] = args, requestedExe = path.resolve(input), requestedRoot = path.resolve(output);
  assert.equal(path.extname(requestedExe).toLowerCase(), ".exe", prefix + "EXE_REQUIRED");
  separate(repository, requestedRoot); separate(path.dirname(requestedExe), requestedRoot);
  await noReparse(requestedExe); await noReparse(path.dirname(requestedRoot));
  const executable = await fs.realpath(requestedExe), artifact = path.dirname(executable);
  const root = path.join(await fs.realpath(path.dirname(requestedRoot)), path.basename(requestedRoot));
  separate(await fs.realpath(repository), root); separate(await fs.realpath(repository), artifact); separate(artifact, root);
  let exists = true;
  try { await fs.lstat(root); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
  assert.equal(exists, false, prefix + "OUTPUT_EXISTS");
  const files = { exe: executable, asar: path.join(artifact, "resources/app.asar"),
    client: path.join(artifact, "resources/client/dist/index.cjs"), web: path.join(artifact, "resources/web/index.html") };
  for (const filename of Object.values(files)) { await noReparse(filename); assert.equal((await fs.stat(filename)).isFile(), true); }
  return { executable, artifact, root, files };
}

/** CIM 保存创建时刻、路径、命令与父链；省略 PID 时只读完整发现快照。 */
export async function queryProcesses(pids) {
  const unique = pids === undefined ? undefined : [...new Set(pids)];
  assert.ok(unique === undefined || unique.every(pid => Number.isSafeInteger(pid) && pid > 0), prefix + "PID_INVALID");
  if (unique?.length === 0) return [];
  const filter = unique ? ` -Filter '${unique.map(pid => `ProcessId = ${pid}`).join(" OR ")}'` : "";
  const script = `$ErrorActionPreference = 'Stop'; $items = @(Get-CimInstance Win32_Process${filter} | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o'); executable = $_.ExecutablePath; parentPid = [int]$_.ParentProcessId; commandLine = $_.CommandLine } }); ConvertTo-Json -InputObject $items -Compress`;
  const result = spawnSync(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${prefix}PROCESS_QUERY_FAILED: ${result.status}, ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

/** 终止操作只接受已登记且创建时刻匹配的 PID，不按映像名或未知树杀进程。 */
async function terminate(record) {
  const script = `$ErrorActionPreference = 'Stop'; $ownedProcess = [System.Diagnostics.Process]::GetProcessById(${record.pid}); $actual = $ownedProcess.StartTime.ToUniversalTime(); $expected = [DateTime]::Parse('${record.created}').ToUniversalTime(); if ([Math]::Abs(($actual - $expected).Ticks) -ge 10) { throw '${prefix}PID_REUSED' }; $ownedProcess.Kill(); if (-not $ownedProcess.WaitForExit(5000)) { throw '${prefix}TERMINATE_TIMEOUT' }`;
  const result = spawnSync(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 8_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${prefix}TERMINATE_FAILED: ${record.pid}, ${result.status}, ${result.stderr}`);
}

/** 清理失败全部向上保留；测试可注入终止失败而不引入产品后门。 */
export async function stopOwned(records, kill = terminate) {
  const errors = [];
  for (const record of [...records].reverse()) {
    const [live] = await queryProcesses([record.pid]);
    if (!live) continue;
    if (live.created !== record.created || live.executable !== record.executable || live.parentPid !== record.parentPid || live.commandLine !== record.commandLine) {
      errors.push(new Error(`${prefix}PID_REUSED: ${record.pid}`)); continue;
    }
    try { await kill(record); } catch (error) { errors.push(error); }
  }
  if (!errors.length) {
    try { await waitUntil(async () => (await queryProcesses(records.map(record => record.pid))).length === 0, 8_000, "CLEANUP_PROCESSES_REMAINED"); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, prefix + "CLEANUP_FAILED");
}

/** 只存 SHA256，不把私钥或配置正文加入结果。 */
async function hashes(files) {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) =>
    [name, crypto.createHash("sha256").update(await bounded(fs.readFile(file), 30_000, "HASH_TIMEOUT")).digest("hex")])));
}

/** 清除继承配置与 Node 注入，所有用户/引擎/临时目录均隔离。 */
async function isolatedEnvironment(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i.test(key)));
  const system = env.SystemRoot ?? env.SYSTEMROOT;
  assert.ok(system, prefix + "SYSTEM_ROOT_REQUIRED");
  env.PATH = [path.join(system, "System32"), system].join(path.delimiter);
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    env[key] = path.join(root, key.toLowerCase()); await fs.mkdir(env[key]);
  }
  env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return env;
}

/** Inspector 仅处理原生协议；传输错误拒绝所有在途调用。 */
async function attachInspector(url) {
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0, onPaused, transportError, intentionalClose = false;
  const paused = new Promise(resolve => { onPaused = resolve; });
  const fail = error => { transportError = error; for (const operation of pending.values()) operation.reject(error); pending.clear(); onPaused({ error }); };
  const opened = new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", event => {
    try {
      const response = JSON.parse(event.data);
      if (response.id) {
        const operation = pending.get(response.id);
        if (!operation) throw new Error(prefix + "INSPECTOR_RESPONSE_UNKNOWN");
        pending.delete(response.id); response.error ? operation.reject(new Error(JSON.stringify(response.error))) : operation.resolve(response.result);
      } else if (response.method === "Debugger.paused") onPaused({ event: response.params });
    } catch (error) { fail(error); }
  });
  socket.addEventListener("close", () => { if (!intentionalClose) fail(new Error(prefix + "INSPECTOR_CLOSED")); });
  socket.addEventListener("error", event => fail(event.error ?? new Error(prefix + "INSPECTOR_ERROR")));
  await bounded(opened, 10_000, "INSPECTOR_OPEN_TIMEOUT");
  return { paused,
    /** 显式关闭观测连接，不改变产品退出。 */
    close() { intentionalClose = true; socket.close(); },
    /** 协议错误或调用超时立即失败。 */
    async call(method, params = {}) {
      if (transportError) throw transportError;
      const id = ++sequence, result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      try { socket.send(JSON.stringify({ id, method, params })); return await bounded(result, 10_000, "INSPECTOR_CALL_TIMEOUT"); }
      finally { pending.delete(id); }
    },
  };
}

/** 解析追加日志；只有尚不存在的日志可作为空前缀，其余读取错误失败。 */
async function logBytes(directory) {
  let entries;
  try { entries = await fs.readdir(directory); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  return Object.fromEntries(await Promise.all(entries.map(async name => [name, await fs.readFile(path.join(directory, name))])));
}

/** 只读本次严格前缀的最新完成快照；无快照继续等，损坏或 IO 错误仍失败。 */
async function latestObservation(filename) {
  const directory = path.dirname(filename), basename = path.basename(filename);
  const completed = (await fs.readdir(directory)).filter(name => name.startsWith(`${basename}.`)
    && /^[1-9][0-9]*\.json$/u.test(name.slice(basename.length + 1))).sort((left, right) =>
    Number(left.slice(basename.length + 1, -5)) - Number(right.slice(basename.length + 1, -5)));
  return completed.length ? JSON.parse(await fs.readFile(path.join(directory, completed.at(-1)), "utf8")) : undefined;
}

/** 故障期间所有非日志持久文件保留字节，禁止 SQLite sidecar 和认领中间物出现。 */
async function persistentSnapshot(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }), files = {};
  const lockName = processLockName(directory);
  for (const entry of entries) {
    if (entry.name === "logs" || entry.name === lockName) continue;
    assert.equal(entry.isFile(), true, `${prefix}UNEXPECTED_STORAGE_ENTRY: ${entry.name}`);
    assert.ok(!/codeflowai\.db-(?:wal|shm)|\.tmp$|\.migration\.json$/u.test(entry.name), `${prefix}STORAGE_SIDECAR: ${entry.name}`);
    files[entry.name] = path.join(directory, entry.name);
  }
  return await hashes(files);
}

/** 沿既有路径规范独立计算唯一瞬态锁，不把未知锁当作可忽略文件。 */
function processLockName(directory) {
  const digest = crypto.createHash("sha1").update(path.join(directory, "codeflowai.db").toLowerCase()).digest("hex").slice(0, 12);
  return `client.${digest}.lock`;
}

/** 真实产品请求必须同时返回成功状态与成功正文。 */
async function request(page, method, body) {
  const response = await bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, ...(body ? { body } : {}) }), 35_000, "REQUEST_TIMEOUT");
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(response)}`); assert.equal(response.body?.ok, true, `${method}: ${JSON.stringify(response)}`);
  return response.body;
}

/** 六种离线故障只改本次数据目录；合法 DER 错配不属于坏 JSON。 */
function faultCases(original) {
  const identity = JSON.parse(original["device-identity.json"].toString("utf8"));
  const pair = crypto.generateKeyPairSync("ed25519");
  const wrongPublic = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.notEqual(wrongPublic, identity.publicKeyBase64);
  crypto.createPublicKey({ key: Buffer.from(wrongPublic, "base64"), format: "der", type: "spki" });
  return [
    { kind: "database-missing", file: "codeflowai.db", bytes: null, cause: "CLIENT_DB_STORAGE_FILE_MISSING" },
    { kind: "metadata-missing", file: "codeflowai.db.meta.json", bytes: null, cause: "CLIENT_DB_STORAGE_OWNERSHIP_UNKNOWN" },
    { kind: "metadata-invalid-json", file: "codeflowai.db.meta.json", bytes: Buffer.from("{storage-failure-invalid-json\n"), cause: "SyntaxError" },
    { kind: "metadata-account-conflict", file: "codeflowai.db.meta.json", bytes: Buffer.from(JSON.stringify({ schemaVersion: 2, storageMode: "plain_sqlite", accountNamespace: "acct_storage_failure_other_owner", migrationState: "ready" })), cause: "CLIENT_DB_STORAGE_OWNERSHIP_MISMATCH" },
    { kind: "sqlite-invalid", file: "codeflowai.db", bytes: Buffer.from("storage-failure-invalid-sqlite\n"), cause: "CLIENT_DB_STORAGE_FORMAT_MISMATCH" },
    { kind: "identity-key-mismatch", file: "device-identity.json", bytes: Buffer.from(`${JSON.stringify({ ...identity, publicKeyBase64: wrongPublic })}\n`), cause: "设备身份文件无效" },
  ];
}

/** 独占证据根运行真实工件；所有副作用发生在路径校验之后。 */
export async function run(args) {
  const context = await preflight(args), { root, executable, artifact, files } = context;
  const artifactBefore = await hashes(files);
  await fs.mkdir(root);
  const reportPath = path.join(root, "verification.json"), dataDir = path.join(root, "runtime"), project = path.join(root, "project"), profile = path.join(root, "profile");
  const report = { requestId: crypto.randomUUID(), status: "running", root, executable, artifactBefore, runs: [], processHistory: [],
    scope: "frozen_windows_packaged_storage_startup_failure", latestD09: false,
    instrumentation: "错误对话框只捕获显示；只读订阅原子进程/IPC 和窗口事实，不修改产品启动、清理、ready 或错误结果。" };
  const owned = new Map();
  let application, child, inspector, launchRoot, mainPid, page;

  /** 只登记实际查询到且属于本次 exe 的新进程，不追认已消失 PID。 */
  async function observe(pids, launcher = false) {
    for (const record of await queryProcesses(pids)) {
      const actual = path.resolve(record.executable).toLowerCase();
      assert.ok(actual === executable.toLowerCase() || (launcher && record.parentPid === process.pid
        && actual === path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/cmd.exe").toLowerCase()), prefix + "FOREIGN_PROCESS");
      const prior = owned.get(record.pid);
      if (prior) assert.deepEqual(record, prior, prefix + "PID_REUSED");
      else { owned.set(record.pid, record); report.processHistory.push(record); }
    }
  }

  /** 早期查询失败时从精确根身份与父链恢复本次树，未知范围保持失败态。 */
  async function discoverOwnedTree() {
    report.processDiscovery = { state: "unknown", rootPid: child?.pid };
    assert.ok(launchRoot, prefix + "PROCESS_ROOT_UNCONFIRMED");
    const snapshot = await queryProcesses(), records = new Map(snapshot.map(record => [record.pid, record]));
    assert.deepEqual(records.get(launchRoot.pid), launchRoot, prefix + "PROCESS_ROOT_IDENTITY_CHANGED");
    const tree = [launchRoot];
    for (const parent of tree) {
      for (const record of snapshot.filter(record => record.parentPid === parent.pid)) {
        assert.equal(path.resolve(record.executable ?? "").toLowerCase(), executable.toLowerCase(), prefix + "FOREIGN_PROCESS");
        const command = record.commandLine?.toLowerCase() ?? "";
        assert.ok(command.includes(profile.toLowerCase()) || (command.includes(files.client.toLowerCase()) && command.includes("--foreground")), prefix + "PROCESS_COMMAND_UNCONFIRMED");
        assert.ok(record.created >= parent.created, prefix + "PROCESS_CREATION_ORDER_INVALID");
        const prior = owned.get(record.pid);
        if (prior) assert.deepEqual(record, prior, prefix + "PID_REUSED");
        else { owned.set(record.pid, record); report.processHistory.push(record); }
        tree.push(record);
      }
    }
    const rootIsMain = path.resolve(launchRoot.executable).toLowerCase() === executable.toLowerCase();
    const mains = rootIsMain ? [launchRoot] : tree.filter(record => record.parentPid === launchRoot.pid);
    assert.equal(mains.length, 1, prefix + "MAIN_PROCESS_UNCONFIRMED");
    assert.ok(!mainPid || mainPid === mains[0].pid, prefix + "MAIN_PROCESS_IDENTITY_CHANGED"); mainPid = mains[0].pid;
    report.processDiscovery = { state: "confirmed", rootPid: launchRoot.pid, mainPid, pids: tree.map(record => record.pid) };
  }

  /** 退出核查保留未知范围，查询故障不能变成空进程结果。 */
  async function remaining() {
    const result = [];
    try { result.push(...await queryProcesses([...owned.keys()])); }
    catch (error) { result.push({ state: "unknown", pids: [...owned.keys()], error: failure(error) }); }
    if (report.processDiscovery?.state === "unknown") result.push({ state: "unknown-scope", rootPid: child?.pid, error: report.processDiscovery.error });
    return result;
  }

  /** 先发现完整本次树，再尝试原退出入口，最后仅清理确认身份的 PID。 */
  async function cleanup() {
    const errors = [];
    if (child) {
      try { await discoverOwnedTree(); }
      catch (error) { report.processDiscovery.error = failure(error); errors.push(error); }
    }
    if (application && report.processDiscovery?.state === "confirmed") {
      try {
        const [actual] = await queryProcesses([mainPid]); assert.deepEqual(actual, owned.get(mainPid), prefix + "CLOSE_IDENTITY_UNCONFIRMED");
        page ??= application.windows().find(window => window.url().startsWith("codeflow://desktop/"));
        await bounded(Promise.all([application.waitForEvent("close", { timeout: 8_000 }),
          page ? page.evaluate(() => { void window.codeflowDesktop.exit(); }) : application.evaluate(({ app }) => app.quit())]), 8_000, "CLEANUP_CLOSE_TIMEOUT");
      } catch (error) { errors.push(error); }
    }
    try { await stopOwned([...owned.values()]); } catch (error) { errors.push(error); }
    report.remainingPids = await remaining();
    if (report.remainingPids.length) errors.push(new Error(prefix + "CLEANUP_UNCONFIRMED"));
    if (errors.length) throw new AggregateError(errors, prefix + "CLEANUP_FAILED");
  }

  /** 原进程消失或 PID 已复用都不终止新进程，正常路径要求原进程全退出。 */
  async function stopped(run) {
    await waitUntil(async () => {
      const current = await queryProcesses([...owned.keys()]);
      return current.every(record => owned.get(record.pid).created !== record.created);
    }, 8_000, "PROCESSES_REMAINED");
    run.processes = [...owned.values()].map(record => ({ ...record, state: "exited" }));
    report.processDiscovery = { state: "stopped", rootPid: launchRoot?.pid, pids: [...owned.keys()] };
    owned.clear(); launchRoot = undefined; mainPid = undefined; page = undefined;
  }

  /** 正常初始化和恢复只走真实桥，回读工作区、会话标题和 Profile 标记。 */
  async function normalRun(env, expected, kind) {
    const { _electron: electron } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
    report.processDiscovery = { state: "unknown", phase: "launch" };
    application = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env, cwd: root, timeout: 60_000 });
    child = application.process(); await observe([child.pid], true);
    launchRoot = owned.get(child.pid); assert.ok(launchRoot, prefix + "PROCESS_ROOT_UNCONFIRMED");
    assert.ok(launchRoot.commandLine?.toLowerCase().includes(profile.toLowerCase()) && launchRoot.commandLine.toLowerCase().includes(executable.toLowerCase()), prefix + "PROCESS_ROOT_COMMAND_UNCONFIRMED");
    report.processDiscovery = { state: "registered-root", rootPid: child.pid };
    mainPid = await bounded(application.evaluate(() => process.pid), 10_000, "MAIN_PID_TIMEOUT"); await observe([mainPid]);
    const item = { kind, launcherPid: child.pid, mainPid, stderr: "" }; report.runs.push(item);
    child.stdout.resume(); child.stderr.setEncoding("utf8").on("data", chunk => { item.stderr = (item.stderr + chunk).slice(-65_536); });
    page = await application.firstWindow({ timeout: 60_000 });
    await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    const state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, "STATE_TIMEOUT");
    assert.equal(state.status, "ready"); assert.equal(state.health.database, "ready"); await observe([state.pid]);
    const facts = await bounded(application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), execPath: process.execPath, userData: app.getPath("userData"),
      pids: app.getAppMetrics().map(metric => metric.pid), nodeOptions: process.env.NODE_OPTIONS, nodePath: process.env.NODE_PATH,
      codeflowEnv: Object.keys(process.env).filter(key => key.startsWith("CODEFLOWAI_")) })), 10_000, "MAIN_FACTS_TIMEOUT");
    assert.equal(facts.packaged, true); assert.equal(facts.execPath, executable); assert.equal(facts.appPath, path.join(artifact, "resources/app.asar"));
    assert.equal(facts.userData, profile); assert.equal(facts.nodeOptions, undefined); assert.equal(facts.nodePath, undefined);
    assert.deepEqual(facts.codeflowEnv, ["CODEFLOWAI_DESKTOP_DATA_DIR"]); await observe(facts.pids); item.facts = facts;
    const clientId = (await request(page, "runtime.info")).client.clientId;
    assert.ok(typeof clientId === "string" && clientId.trim());
    const marker = report.requestId;
    let workspaceId, threadId;
    if (!expected) {
      assert.deepEqual((await request(page, "workspaces.list")).workspaces, []);
      workspaceId = (await request(page, "workspaces.upsert", { workspaceId: "storage-failure", title: "启动数据保护验收", path: project })).workspace.id;
      await request(page, "workspaceExecutionProfile.update", { workspaceId, profileText: marker });
      threadId = (await request(page, "threads.create", { workspaceId, engine: "codex", title: `持久历史标记 ${marker}` })).threadId;
      assert.ok(typeof threadId === "string" && threadId.trim());
    } else {
      assert.equal(clientId, expected.clientId); workspaceId = expected.workspaceId; threadId = expected.threadId;
      const workspaces = (await request(page, "workspaces.list")).workspaces;
      assert.equal(workspaces.length, 1); assert.equal(workspaces[0].id, workspaceId); assert.equal(workspaces[0].path, project);
    }
    assert.equal((await request(page, "workspaceExecutionProfile.get", { workspaceId })).profile.profileText, marker);
    const threads = (await request(page, "threads.list", { workspaceId, scope: "all" })).threads;
    assert.equal(threads.length, 1); assert.equal(threads[0].id, threadId); assert.equal(threads[0].title, `持久历史标记 ${marker}`);
    await Promise.all([application.waitForEvent("close", { timeout: 40_000 }), bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "EXIT_REQUEST_TIMEOUT")]);
    await stopped(item); assert.equal(child.exitCode, 0); item.exitCode = child.exitCode; item.clientId = clientId; item.workspaceId = workspaceId; item.threadId = threadId;
    assert.equal((await fs.readdir(dataDir)).includes(processLockName(dataDir)), false, prefix + "NORMAL_PROCESS_LOCK_REMAINED");
    application = undefined; child = undefined;
    return { clientId, workspaceId, threadId };
  }

  /** 故障时只观测真实子进程、ready IPC、窗口和原错误显示。 */
  async function faultRun(env, fault) {
    const target = path.join(dataDir, fault.file), evidenceDir = path.join(root, fault.kind); await fs.mkdir(evidenceDir);
    if (fault.bytes === null) await fs.unlink(target); else await fs.writeFile(target, fault.bytes);
    if (fault.bytes !== null) await fs.writeFile(path.join(evidenceDir, "fault.bytes"), fault.bytes, { mode: 0o600 });
    const before = await persistentSnapshot(dataDir), logsBefore = await logBytes(path.join(dataDir, "logs"));
    const observationPath = path.join(evidenceDir, "observation.json"), item = { kind: fault.kind, stderr: "", storageBefore: before }; report.runs.push(item);
    report.processDiscovery = { state: "unknown", phase: "spawn" };
    child = spawn(executable, ["--inspect-brk=127.0.0.1:0", `--user-data-dir=${profile}`], { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const current = child; let launchError;
    const closed = new Promise(resolve => { current.once("error", error => { launchError = error; resolve({ error }); }); current.once("exit", (code, signal) => resolve({ code, signal })); });
    await observe([child.pid]); launchRoot = owned.get(child.pid); assert.ok(launchRoot, prefix + "PROCESS_ROOT_UNCONFIRMED"); mainPid = child.pid;
    assert.ok(launchRoot.commandLine?.toLowerCase().includes(profile.toLowerCase()) && launchRoot.commandLine.toLowerCase().includes(executable.toLowerCase()), prefix + "PROCESS_ROOT_COMMAND_UNCONFIRMED");
    report.processDiscovery = { state: "registered-root", rootPid: child.pid };
    current.stdout.resume(); current.stderr.setEncoding("utf8").on("data", chunk => { item.stderr = (item.stderr + chunk).slice(-65_536); });
    await waitUntil(() => { if (launchError) throw launchError; return /Debugger listening on (ws:\/\/[^\s]+)/u.test(item.stderr); }, 15_000, "INSPECTOR_ADDRESS_TIMEOUT");
    inspector = await attachInspector(item.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/u)[1]);
    await inspector.call("Runtime.enable"); await inspector.call("Debugger.enable"); await inspector.call("Runtime.runIfWaitingForDebugger");
    const paused = await bounded(inspector.paused, 10_000, "ENTRY_PAUSE_TIMEOUT"); if (paused.error) throw paused.error; assert.equal(paused.event.reason, "Break on start");
    const expression = `(() => {
      const { app, dialog, BrowserWindow } = require('electron'), fs = require('node:fs');
      const observation = { pid: process.pid, packaged: app.isPackaged, appPath: app.getAppPath(), execPath: process.execPath, dialogs: [], children: [], readyMessages: [], windows: [] };
      const observationFile = ${JSON.stringify(observationPath)}, temporaryFile = observationFile + '.' + process.pid + '.tmp';
      let sequence = 0;
      // 发布到从不覆盖的完成文件；读者不读临时文件，写入与替换错误继续抛出。
      const save = () => { const completedFile = observationFile + '.' + (++sequence) + '.json'; fs.writeFileSync(temporaryFile, JSON.stringify(observation), 'utf8'); fs.renameSync(temporaryFile, completedFile); };
      require('node:diagnostics_channel').channel('child_process').subscribe(({ process: spawned }) => {
        const record = { executable: spawned.spawnfile }; observation.children.push(record);
        spawned.on('spawn', () => { record.pid = spawned.pid; save(); });
        spawned.on('message', message => { if (message?.t === 'desktop.ready') { observation.readyMessages.push(message); save(); } });
        spawned.on('exit', (code, signal) => { record.exit = { code, signal }; save(); });
      });
      app.on('browser-window-created', () => { observation.windows.push('created'); save(); });
      dialog.showErrorBox = (title, message) => { observation.dialogs.push({ title, message, windowCount: BrowserWindow.getAllWindows().length }); observation.metricPids = app.getAppMetrics().map(metric => metric.pid); save(); };
      process.on('exit', code => { observation.exitCode = code; save(); }); save();
      return { pid: process.pid, packaged: app.isPackaged };
    })()`;
    const evaluated = await inspector.call("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true });
    assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails)); assert.equal(evaluated.result.value.pid, child.pid); assert.equal(evaluated.result.value.packaged, true);
    await inspector.call("Debugger.resume"); inspector.close(); inspector = undefined;
    await waitUntil(async () => {
      if (launchError) throw launchError;
      item.observation = await latestObservation(observationPath);
      if (!item.observation) return false;
      await observe(item.observation.children.filter(record => record.pid && !record.exit).map(record => record.pid));
      await observe(item.observation.metricPids ?? []);
      return item.observation.dialogs.length === 1 && item.observation.children.every(record => record.exit);
    }, 20_000, "PRODUCT_FAILURE_TIMEOUT");
    const observation = item.observation, dialog = observation.dialogs[0];
    assert.equal(observation.execPath, executable); assert.equal(observation.appPath, path.join(artifact, "resources/app.asar"));
    assert.equal(dialog.title, "CodeFlow 启动失败"); assert.equal(dialog.windowCount, 0); assert.deepEqual(observation.windows, []); assert.deepEqual(observation.readyMessages, []);
    for (const record of observation.children) assert.deepEqual(record.exit, { code: 1, signal: null });
    if (observation.children.length) {
      assert.equal(observation.children.length, 1);
      assert.ok(dialog.message.includes("CLIENT_EXIT_1"));
    } else assert.match(dialog.message, new RegExp(fault.cause));
    if (dialog.message.includes("DESKTOP_STARTUP_CLEANUP_FAILED")) {
      item.mainOutcome = "explicit_startup_cleanup_failure_retained_shell"; await stopOwned([...owned.values()]);
    } else {
      assert.deepEqual(await bounded(closed, 5_000, "PRODUCT_EXIT_TIMEOUT"), { code: 1, signal: null }); item.mainOutcome = "exit_1";
    }
    await stopped(item);
    const lockNames = (await fs.readdir(dataDir)).filter(name => /^client\..*\.lock$/u.test(name));
    assert.ok(lockNames.length <= 1 && lockNames.every(name => name === processLockName(dataDir)), prefix + "UNKNOWN_PROCESS_LOCK");
    item.transientLocks = [];
    for (const name of lockNames) {
      const lock = JSON.parse(await fs.readFile(path.join(dataDir, name), "utf8"));
      assert.ok(observation.children.some(record => record.pid === lock.pid), prefix + "FOREIGN_PROCESS_LOCK");
      assert.equal(lock.clientId, report.expected.clientId);
      assert.equal(path.resolve(lock.dbPath).toLowerCase(), path.join(dataDir, "codeflowai.db").toLowerCase());
      assert.deepEqual(await queryProcesses([lock.pid]), []);
      item.transientLocks.push({ file: name, pid: lock.pid, state: "owner_exited" });
      await fs.copyFile(path.join(dataDir, name), path.join(evidenceDir, name));
    }
    item.storageAfter = await persistentSnapshot(dataDir); assert.deepEqual(item.storageAfter, before);
    const logsAfter = await logBytes(path.join(dataDir, "logs")), added = {};
    for (const [name, bytes] of Object.entries(logsAfter)) {
      const original = logsBefore[name] ?? Buffer.alloc(0); assert.deepEqual(bytes.subarray(0, original.length), original, `${prefix}LOG_REWRITTEN: ${name}`);
      const appended = bytes.subarray(original.length); if (appended.length) { added[name] = appended.toString("utf8"); await fs.writeFile(path.join(evidenceDir, name), appended); }
    }
    const shellErrors = added["desktop-errors.jsonl"].trim().split(/\r?\n/u).map(line => JSON.parse(line));
    assert.equal(shellErrors.length, 1); assert.ok(shellErrors[0].requestId); assert.ok(shellErrors[0].errorCode); assert.equal(shellErrors[0].rootCause, dialog.message.split("\n")[0]);
    if (observation.children.length) {
      const clientText = Object.entries(added).filter(([name]) => name.endsWith(".log")).map(([, content]) => content).join("\n");
      const clientRows = clientText.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
      const fatal = clientRows.find(row => row.errorCode === "CLIENT_STARTUP_FATAL"); assert.ok(fatal, prefix + "CLIENT_FATAL_LOG_MISSING");
      assert.ok(fatal.requestId); assert.ok(JSON.stringify(fatal).includes(fault.cause), `${prefix}CAUSE_MISSING: ${fault.cause}`);
      const runtimeErrors = added["desktop-runtime-errors.jsonl"].trim().split(/\r?\n/u).map(line => JSON.parse(line));
      assert.ok(runtimeErrors.some(row => row.requestId === fatal.requestId && row.pid === observation.children[0].pid && row.errorCode === "CLIENT_EXIT_1"));
      item.clientFailure = fatal;
    }
    const secret = JSON.parse(await fs.readFile(path.join(dataDir, "device-identity.json"), "utf8")).privateKeyBase64;
    assert.equal(JSON.stringify(added).includes(secret), false, prefix + "PRIVATE_KEY_LEAKED");
    item.error = shellErrors[0]; item.storageUnchanged = true; item.noReady = true; child = undefined;
  }

  try {
    const env = await isolatedEnvironment(root); await fs.mkdir(project); await fs.mkdir(profile);
    const expected = await normalRun(env, undefined, "initialize"); report.expected = expected;
    const original = Object.fromEntries(await Promise.all(["codeflowai.db", "codeflowai.db.meta.json", "config.json", "device-identity.json"].map(async name => [name, await fs.readFile(path.join(dataDir, name))])));
    const backup = path.join(root, "original"); await fs.mkdir(backup);
    for (const [name, bytes] of Object.entries(original)) await fs.writeFile(path.join(backup, name), bytes, { mode: 0o600 });
    report.originalHashes = await hashes(Object.fromEntries(Object.keys(original).map(name => [name, path.join(backup, name)])));
    assert.equal(JSON.parse(original["codeflowai.db.meta.json"].toString("utf8")).initializationState, "ready");
    for (const fault of faultCases(original)) {
      await faultRun(env, fault);
      await fs.writeFile(path.join(dataDir, fault.file), original[fault.file], { mode: 0o600 });
      const beforeRecoveryLogs = await hashes(Object.fromEntries(Object.keys(await logBytes(path.join(dataDir, "logs"))).filter(name => name.endsWith(".jsonl")).map(name => [name, path.join(dataDir, "logs", name)])));
      await normalRun(env, expected, `restore-${fault.kind}`);
      assert.deepEqual(await hashes(Object.fromEntries(Object.keys(beforeRecoveryLogs).map(name => [name, path.join(dataDir, "logs", name)]))), beforeRecoveryLogs);
      assert.deepEqual(await fs.readFile(path.join(dataDir, "device-identity.json")), original["device-identity.json"]);
    }
    report.remainingPids = []; report.status = "passed";
  } catch (error) {
    try { inspector?.close(); await cleanup(); }
    catch (cleanupError) { error = new AggregateError([error, cleanupError], prefix + "VERIFICATION_AND_CLEANUP_FAILED"); }
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    report.remainingPids = await remaining(); report.status = "failed"; report.failure = failure(error); process.exitCode = 1;
  }
  try { report.artifactAfter = await hashes(files); assert.deepEqual(report.artifactAfter, artifactBefore); }
  catch (error) { report.status = "failed"; report.failure = failure(new AggregateError([...(report.failure ? [new Error(JSON.stringify(report.failure))] : []), error], prefix + "ARTIFACT_CHANGED")); process.exitCode = 1; }
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: prefix + report.status.toUpperCase(), reportPath, requestId: report.requestId, ...(report.failure ? { failure: report.failure } : {}) }));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await run(process.argv.slice(2));
